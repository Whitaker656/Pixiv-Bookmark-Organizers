from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from http.cookiejar import Cookie, CookieJar
from urllib import error, parse, request

from .models import Artwork, BookmarkSnapshot, PixivConfig


class PixivClient:
    def __init__(self, config: PixivConfig) -> None:
        self.config = config
        self.cookie_jar = self._build_cookie_jar()
        self.opener = request.build_opener(request.HTTPCookieProcessor(self.cookie_jar))

    def validate_session(self) -> dict:
        user_id = self.resolve_user_id()
        payload = self._request_json(f"{self.config.base_url}/ajax/user/{user_id}")
        body = payload.get("body", {})
        return {
            "user_id": str(body.get("userId", user_id)),
            "name": body.get("name", ""),
            "is_followed": body.get("isFollowed", False),
        }

    def fetch_all_bookmarks(self, page_size: int = 48) -> BookmarkSnapshot:
        items: list[Artwork] = []
        seen_ids: set[str] = set()
        user_id = self.resolve_user_id()

        for rest in ("show", "hide"):
            offset = 0
            while True:
                page = self.fetch_bookmarks(user_id=user_id, rest=rest, limit=page_size, offset=offset)
                if not page.items:
                    break

                for item in page.items:
                    if item.id in seen_ids:
                        continue
                    seen_ids.add(item.id)
                    items.append(item)

                if len(page.items) < page_size:
                    break

                offset += page_size

        items.sort(key=self._artwork_bookmark_order_key, reverse=True)

        return BookmarkSnapshot(
            fetched_at=datetime.now(UTC).isoformat(),
            items=items,
        )

    def fetch_bookmark_tag_stats(self, user_id: str | None = None) -> dict:
        resolved_user_id = user_id or self.resolve_user_id()
        payload = self._request_json(
            f"{self.config.base_url}/ajax/user/{resolved_user_id}/illusts/bookmark/tags",
            referer=f"{self.config.base_url}/users/{resolved_user_id}/bookmarks/artworks",
        )
        body = payload.get("body", {})
        public_tags = body.get("public", [])
        private_tags = body.get("private", [])
        counts: dict[str, dict[str, int | str]] = {}

        for visibility, items in (("public_count", public_tags), ("private_count", private_tags)):
            for item in items:
                tag_name = str(item.get("tag") or "").strip()
                if not tag_name:
                    continue

                current = counts.get(
                    tag_name,
                    {"name": tag_name, "count": 0, "public_count": 0, "private_count": 0},
                )
                count = int(item.get("cnt") or 0)
                current[visibility] = count
                current["count"] = int(current["public_count"]) + int(current["private_count"])
                counts[tag_name] = current

        return {
            "fetched_at": datetime.now(UTC).isoformat(),
            "tags": sorted(
                counts.values(),
                key=lambda entry: (-int(entry["count"]), str(entry["name"])),
            ),
        }

    def fetch_bookmarks(
        self,
        user_id: str | None = None,
        rest: str = "show",
        limit: int = 48,
        offset: int = 0,
    ) -> BookmarkSnapshot:
        resolved_user_id = user_id or self.resolve_user_id()
        endpoint, query = self._build_bookmarks_request(
            user_id=resolved_user_id,
            rest=rest,
            limit=limit,
            offset=offset,
        )
        referer = f"{self.config.base_url}/users/{resolved_user_id}/bookmarks/artworks"
        try:
            payload = self._request_json(
                endpoint,
                query=query,
                referer=referer,
            )
        except RuntimeError as exc:
            fallback_endpoint = f"{self.config.base_url}/ajax/user/{resolved_user_id}/illusts/bookmarks"
            if endpoint == fallback_endpoint or "404" not in str(exc):
                raise
            payload = self._request_json(
                fallback_endpoint,
                query={
                    "tag": "",
                    "offset": str(offset),
                    "limit": str(limit),
                    "rest": rest,
                },
                referer=referer,
            )
        body = payload.get("body", {})
        works = body.get("works", [])
        bookmark_tags_by_id = body.get("bookmarkTags", {}) if isinstance(body.get("bookmarkTags"), dict) else {}
        items = [
            self._parse_artwork(
                item,
                associated_bookmark_tags=bookmark_tags_by_id.get(str((item.get("bookmarkData") or {}).get("id", ""))),
            )
            for item in works
        ]
        return BookmarkSnapshot(
            fetched_at=datetime.now(UTC).isoformat(),
            items=items,
        )

    def _build_bookmarks_request(
        self,
        user_id: str,
        rest: str,
        limit: int,
        offset: int,
    ) -> tuple[str, dict[str, str]]:
        endpoint = str(self.config.bookmarks_endpoint or "").strip()
        if not endpoint:
            endpoint = f"{self.config.base_url}/ajax/user/{user_id}/illusts/bookmarks"

        query = {
            "tag": "",
            "offset": str(offset),
            "limit": str(limit),
            "rest": rest,
        }

        if "{user_id}" in endpoint:
            endpoint = endpoint.format(user_id=user_id)
        elif re.search(r"/ajax/user/bookmarks/illust/?$", endpoint):
            query["user_id"] = user_id

        return endpoint, query

    def resolve_user_id(self) -> str:
        if self.config.user_id:
            return self.config.user_id

        req = request.Request(
            url=self.config.base_url,
            headers=self._build_headers(referer=self.config.base_url),
            method="GET",
        )
        try:
            with self.opener.open(req, timeout=self.config.request_timeout_seconds) as response:
                html = response.read().decode("utf-8", errors="ignore")
        except error.HTTPError as exc:
            raise RuntimeError(f"Pixiv user id resolve failed: {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Pixiv user id resolve failed: {exc.reason}") from exc

        patterns = [
            r'"userId":"(\d+)"',
            r'"id":"(\d+)","pixivId"',
            r'"user_id":"(\d+)"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                self.config.user_id = match.group(1)
                return self.config.user_id

        raise RuntimeError("Could not resolve Pixiv user_id from HTML. Fill user_id in pixiv_config.json.")

    def download_thumbnail(self, url: str, destination: str) -> str:
        req = request.Request(
            url=url,
            headers=self._build_headers(referer=f"{self.config.base_url}/"),
            method="GET",
        )
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)

        try:
            with self.opener.open(req, timeout=self.config.request_timeout_seconds) as response:
                target.write_bytes(response.read())
        except error.HTTPError as exc:
            raise RuntimeError(f"Pixiv thumbnail download failed: {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Pixiv thumbnail download failed: {exc.reason}") from exc

        return str(target)

    def update_bookmark_tags(
        self,
        bookmark_id: str,
        tags: list[str],
        visibility: str,
        current_tags: list[str] | None = None,
    ) -> dict:
        csrf_token = self._extract_csrf_token()
        desired_tags = sorted({str(tag).strip() for tag in tags if str(tag).strip()})
        existing_tags = sorted({str(tag).strip() for tag in (current_tags or []) if str(tag).strip()})
        tags_to_remove = sorted(set(existing_tags) - set(desired_tags))
        tags_to_add = sorted(set(desired_tags) - set(existing_tags))

        responses: dict[str, dict] = {}
        if tags_to_remove:
            responses["remove_tags"] = self._request_json(
                f"{self.config.base_url}/ajax/illusts/bookmarks/remove_tags",
                method="POST",
                body={
                    "removeTags": tags_to_remove,
                    "bookmarkIds": [bookmark_id],
                },
                referer=f"{self.config.base_url}/",
                extra_headers={"x-csrf-token": csrf_token},
            )

        if tags_to_add:
            responses["add_tags"] = self._request_json(
                f"{self.config.base_url}/ajax/illusts/bookmarks/add_tags",
                method="POST",
                body={
                    "tags": tags_to_add,
                    "bookmarkIds": [bookmark_id],
                },
                referer=f"{self.config.base_url}/",
                extra_headers={"x-csrf-token": csrf_token},
            )

        return {
            "ok": True,
            "bookmark_id": bookmark_id,
            "visibility": visibility,
            "current_tags": existing_tags,
            "target_tags": desired_tags,
            "added_tags": tags_to_add,
            "removed_tags": tags_to_remove,
            "responses": responses,
        }

    def remove_bookmarks(self, bookmark_ids: list[str]) -> dict:
        normalized_ids = [str(bookmark_id).strip() for bookmark_id in (bookmark_ids or []) if str(bookmark_id).strip()]
        if not normalized_ids:
            raise RuntimeError("bookmark_id_missing")

        csrf_token = self._extract_csrf_token()
        ajax_error: RuntimeError | None = None
        try:
            response = self._request_json(
                f"{self.config.base_url}/ajax/illusts/bookmarks/remove",
                method="POST",
                body={"bookmarkIds": normalized_ids},
                referer=f"{self.config.base_url}/",
                extra_headers={"x-csrf-token": csrf_token},
            )
            return {
                "ok": True,
                "removed_bookmark_ids": normalized_ids,
                "responses": {"ajax_remove": response},
                "transport": "ajax",
            }
        except RuntimeError as exc:
            ajax_error = exc

        responses: list[dict] = []
        for bookmark_id in normalized_ids:
            responses.append(self._remove_bookmark_rpc(bookmark_id, csrf_token))

        return {
            "ok": True,
            "removed_bookmark_ids": normalized_ids,
            "responses": {"rpc_remove": responses},
            "transport": "rpc",
            "ajax_error": str(ajax_error) if ajax_error else "",
        }

    def remove_bookmark(self, bookmark_id: str) -> dict:
        return self.remove_bookmarks([bookmark_id])

    def _remove_bookmark_rpc(self, bookmark_id: str, csrf_token: str) -> dict:
        req = request.Request(
            url=f"{self.config.base_url}/rpc/index.php",
            headers={
                **self._build_headers(referer=f"{self.config.base_url}/"),
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "x-csrf-token": csrf_token,
            },
            method="POST",
            data=parse.urlencode(
                {
                    "mode": "delete_illust_bookmark",
                    "bookmark_id": str(bookmark_id),
                    "tt": csrf_token,
                }
            ).encode("utf-8"),
        )
        try:
            with self.opener.open(req, timeout=self.config.request_timeout_seconds) as response:
                raw = response.read().decode("utf-8", errors="ignore").strip()
        except error.HTTPError as exc:
            raise RuntimeError(f"Pixiv bookmark remove failed: {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Pixiv bookmark remove failed: {exc.reason}") from exc

        if not raw:
            return {"ok": True, "bookmark_id": bookmark_id}

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return {"ok": True, "bookmark_id": bookmark_id, "raw": raw}

        if payload.get("error") is True:
            raise RuntimeError(f"Pixiv bookmark remove failed: {payload.get('message') or 'unknown error'}")
        return payload

    def _parse_artwork(self, item: dict, associated_bookmark_tags: object = None) -> Artwork:
        bookmark_data = item.get("bookmarkData") or {}
        tag_entries = item.get("tags") or []
        pixiv_tags = []
        for tag_entry in tag_entries:
            if isinstance(tag_entry, str):
                pixiv_tags.append(tag_entry)
            elif isinstance(tag_entry, dict) and tag_entry.get("tag"):
                pixiv_tags.append(tag_entry["tag"])

        thumbnail_url = item.get("url") or item.get("profileImageUrl") or ""
        if thumbnail_url.startswith("//"):
            thumbnail_url = f"https:{thumbnail_url}"

        is_masked = bool(item.get("isMasked", False))
        is_bookmark_private = bool(bookmark_data.get("private", False))
        bookmark_tags = self._extract_bookmark_tags(item, bookmark_data, associated_bookmark_tags)

        return Artwork(
            id=str(item.get("id", "")),
            bookmark_id=str(bookmark_data.get("id", "")),
            title=item.get("title", ""),
            author=item.get("userName", ""),
            author_id=str(item.get("userId", "")),
            thumbnail_url=thumbnail_url,
            pixiv_tags=pixiv_tags,
            bookmark_tags=bookmark_tags,
            visibility="private" if is_bookmark_private else "public",
            is_deleted=is_masked,
            like_count=int(item.get("bookmarkCount") or item.get("likeCount") or 0),
        )

    def _artwork_bookmark_order_key(self, artwork: Artwork) -> tuple[int, str]:
        bookmark_id = str(artwork.bookmark_id or "").strip()
        if bookmark_id.isdigit():
            return (1, bookmark_id.zfill(24))
        return (0, bookmark_id)

    def _extract_bookmark_tags(self, item: dict, bookmark_data: dict, associated_bookmark_tags: object = None) -> list[str]:
        candidates = [
            associated_bookmark_tags,
            bookmark_data.get("tags"),
            bookmark_data.get("tag"),
            bookmark_data.get("tagList"),
            item.get("bookmarkTags"),
            item.get("bookmark_tags"),
        ]

        for candidate in candidates:
            tags = self._normalize_tag_values(candidate)
            if tags:
                return tags

        return []

    def _normalize_tag_values(self, raw: object) -> list[str]:
        if isinstance(raw, str):
            normalized = raw.strip()
            return [normalized] if normalized else []

        values: list[object]
        if isinstance(raw, list):
            values = raw
        elif isinstance(raw, dict):
            values = list(raw.values())
        else:
            return []

        normalized_tags: list[str] = []
        seen: set[str] = set()
        for value in values:
            tag_name = ""
            if isinstance(value, str):
                tag_name = value
            elif isinstance(value, dict):
                for key in ("tag", "name", "label"):
                    if value.get(key):
                        tag_name = str(value[key])
                        break
            normalized = tag_name.strip()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            normalized_tags.append(normalized)

        return normalized_tags

    def _extract_csrf_token(self) -> str:
        req = request.Request(
            url=self.config.base_url,
            headers=self._build_headers(referer=self.config.base_url),
            method="GET",
        )
        try:
            with self.opener.open(req, timeout=self.config.request_timeout_seconds) as response:
                html = response.read().decode("utf-8", errors="ignore")
        except error.HTTPError as exc:
            raise RuntimeError(f"Pixiv csrf fetch failed: {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Pixiv csrf fetch failed: {exc.reason}") from exc

        return self._extract_csrf_token_from_html(html)

    def _extract_csrf_token_from_html(self, html: str) -> str:
        patterns = [
            r'"token":"([^"]+)"',
            r'"csrfToken":"([^"]+)"',
            r'\"api\":\{\"token\":\"([^\"]+)\"',
        ]
        for pattern in patterns:
            match = re.search(pattern, html)
            if match:
                return match.group(1)

        marker = 'serverSerializedPreloadedState":"'
        marker_index = html.find(marker)
        if marker_index != -1:
            content_start = marker_index + len(marker)
            escaped_chars: list[str] = []
            escaped = False

            for char in html[content_start:]:
                if escaped:
                    escaped_chars.append(char)
                    escaped = False
                    continue
                if char == "\\":
                    escaped_chars.append(char)
                    escaped = True
                    continue
                if char == '"':
                    break
                escaped_chars.append(char)

            if escaped_chars:
                escaped_json = "".join(escaped_chars)
                try:
                    serialized_state = json.loads(f'"{escaped_json}"')
                    preloaded_state = json.loads(serialized_state)
                except json.JSONDecodeError:
                    preloaded_state = None
                else:
                    token = (
                        preloaded_state.get("api", {}).get("token")
                        if isinstance(preloaded_state, dict)
                        else None
                    )
                    if token:
                        return str(token)

        raise RuntimeError("Could not find Pixiv csrf token in HTML.")

    def _request_json(
        self,
        endpoint: str,
        query: dict[str, str] | None = None,
        method: str = "GET",
        body: dict | None = None,
        referer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        url = endpoint
        if query:
            url = f"{endpoint}?{parse.urlencode(query)}"

        headers = self._build_headers(referer=referer, extra_headers=extra_headers)
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = request.Request(url=url, headers=headers, method=method, data=data)

        try:
            with self.opener.open(req, timeout=self.config.request_timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            raise RuntimeError(f"Pixiv request failed: {exc.code} {exc.reason}") from exc
        except error.URLError as exc:
            raise RuntimeError(f"Pixiv request failed: {exc.reason}") from exc

        if payload.get("error"):
            raise RuntimeError(f"Pixiv returned an error: {payload.get('message') or 'unknown error'}")
        return payload

    def _build_headers(
        self,
        referer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, str]:
        headers = {
            "User-Agent": self.config.user_agent,
            "Accept": "application/json",
            "Accept-Language": self.config.language,
        }

        if referer:
            headers["Referer"] = referer

        if extra_headers:
            headers.update(extra_headers)

        return headers

    def _build_cookie_jar(self) -> CookieJar:
        jar = CookieJar()

        if self.config.cookie_file:
            self._load_netscape_cookie_file(jar, self.config.cookie_file)
            return jar

        if self.config.raw_cookie:
            for part in self.config.raw_cookie.split(";"):
                if "=" not in part:
                    continue
                name, value = part.strip().split("=", 1)
                jar.set_cookie(self._create_cookie(name=name, value=value))
            return jar

        if self.config.php_sessid:
            jar.set_cookie(self._create_cookie(name="PHPSESSID", value=self.config.php_sessid))

        return jar

    def _load_netscape_cookie_file(self, jar: CookieJar, path: str) -> None:
        with open(path, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue

                parts = line.split("\t")
                if len(parts) != 7:
                    continue

                domain, include_subdomains, cookie_path, secure_flag, expires, name, value = parts
                jar.set_cookie(
                    Cookie(
                        version=0,
                        name=name,
                        value=value,
                        port=None,
                        port_specified=False,
                        domain=domain,
                        domain_specified=True,
                        domain_initial_dot=domain.startswith("."),
                        path=cookie_path,
                        path_specified=True,
                        secure=secure_flag.upper() == "TRUE",
                        expires=None if expires == "0" else int(expires),
                        discard=expires == "0",
                        comment=None,
                        comment_url=None,
                        rest={"HttpOnly": None},
                        rfc2109=False,
                    )
                )

    def _create_cookie(self, name: str, value: str) -> Cookie:
        return Cookie(
            version=0,
            name=name,
            value=value,
            port=None,
            port_specified=False,
            domain=".pixiv.net",
            domain_specified=True,
            domain_initial_dot=True,
            path="/",
            path_specified=True,
            secure=True,
            expires=None,
            discard=True,
            comment=None,
            comment_url=None,
            rest={"HttpOnly": None},
            rfc2109=False,
        )



