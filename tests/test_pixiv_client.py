from __future__ import annotations

import unittest

from backend.models import PixivConfig
from backend.pixiv_client import PixivClient


class PixivClientTokenTest(unittest.TestCase):
    def _make_client(self) -> PixivClient:
        return PixivClient(
            PixivConfig(
                base_url="https://www.pixiv.net",
                bookmarks_endpoint="",
                bookmark_detail_endpoint="",
                bookmark_update_endpoint="",
                auth_mode="cookie",
            )
        )

    def test_extract_csrf_token_from_serialized_preloaded_state(self) -> None:
        client = self._make_client()
        html = "...\"serverSerializedPreloadedState\":\"{\\\"api\\\":{\\\"token\\\":\\\"abc123token\\\"}}\"..."

        token = client._extract_csrf_token_from_html(html)

        self.assertEqual("abc123token", token)

    def test_extract_csrf_token_from_legacy_csrf_field(self) -> None:
        client = self._make_client()

        token = client._extract_csrf_token_from_html("...\"csrfToken\":\"legacy123\"...")

        self.assertEqual("legacy123", token)


class PixivClientBookmarkUpdateTest(unittest.TestCase):
    def _make_client(self) -> PixivClient:
        return PixivClient(
            PixivConfig(
                base_url="https://www.pixiv.net",
                bookmarks_endpoint="",
                bookmark_detail_endpoint="",
                bookmark_update_endpoint="",
                auth_mode="cookie",
            )
        )

    def test_update_bookmark_tags_uses_add_and_remove_endpoints(self) -> None:
        client = self._make_client()
        calls: list[dict] = []
        client._extract_csrf_token = lambda: "csrf-token"  # type: ignore[method-assign]

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            calls.append(
                {
                    "endpoint": endpoint,
                    "method": method,
                    "body": body,
                    "referer": referer,
                    "extra_headers": extra_headers,
                }
            )
            return {"ok": True, "endpoint": endpoint}

        client._request_json = fake_request_json  # type: ignore[method-assign]

        result = client.update_bookmark_tags(
            bookmark_id="900",
            tags=["keep", "add", "add"],
            visibility="public",
            current_tags=["keep", "remove-me"],
        )

        self.assertEqual(2, len(calls))
        self.assertEqual("https://www.pixiv.net/ajax/illusts/bookmarks/remove_tags", calls[0]["endpoint"])
        self.assertEqual({"removeTags": ["remove-me"], "bookmarkIds": ["900"]}, calls[0]["body"])
        self.assertEqual("https://www.pixiv.net/ajax/illusts/bookmarks/add_tags", calls[1]["endpoint"])
        self.assertEqual({"tags": ["add"], "bookmarkIds": ["900"]}, calls[1]["body"])
        self.assertEqual(["add"], result["added_tags"])
        self.assertEqual(["remove-me"], result["removed_tags"])

    def test_update_bookmark_tags_skips_requests_when_no_diff(self) -> None:
        client = self._make_client()
        calls: list[dict] = []
        client._extract_csrf_token = lambda: "csrf-token"  # type: ignore[method-assign]

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            calls.append({"endpoint": endpoint, "body": body})
            return {"ok": True}

        client._request_json = fake_request_json  # type: ignore[method-assign]

        result = client.update_bookmark_tags(
            bookmark_id="900",
            tags=["same", "stay"],
            visibility="private",
            current_tags=["stay", "same"],
        )

        self.assertEqual([], calls)
        self.assertEqual([], result["added_tags"])
        self.assertEqual([], result["removed_tags"])

    def test_remove_bookmarks_uses_ajax_endpoint_first(self) -> None:
        client = self._make_client()
        client._extract_csrf_token = lambda: "csrf-token"  # type: ignore[method-assign]
        calls: list[dict] = []

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            calls.append(
                {
                    "endpoint": endpoint,
                    "method": method,
                    "body": body,
                    "referer": referer,
                    "extra_headers": extra_headers,
                }
            )
            return {"body": {"success": True}}

        client._request_json = fake_request_json  # type: ignore[method-assign]

        result = client.remove_bookmarks(["900", "901"])

        self.assertEqual("ajax", result["transport"])
        self.assertEqual(["900", "901"], result["removed_bookmark_ids"])
        self.assertEqual(1, len(calls))
        self.assertEqual("https://www.pixiv.net/ajax/illusts/bookmarks/remove", calls[0]["endpoint"])
        self.assertEqual("POST", calls[0]["method"])
        self.assertEqual({"bookmarkIds": ["900", "901"]}, calls[0]["body"])

    def test_remove_bookmarks_falls_back_to_rpc(self) -> None:
        client = self._make_client()
        client._extract_csrf_token = lambda: "csrf-token"  # type: ignore[method-assign]

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            raise RuntimeError("Pixiv request failed: 404 Not Found")

        client._request_json = fake_request_json  # type: ignore[method-assign]

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self):
                return b'{"success":true}'

        requests = []

        def fake_open(req, timeout=0):
            requests.append({
                "url": req.full_url,
                "method": req.get_method(),
                "data": req.data.decode("utf-8"),
            })
            return FakeResponse()

        client.opener.open = fake_open  # type: ignore[method-assign]

        result = client.remove_bookmarks(["900", "901"])

        self.assertEqual("rpc", result["transport"])
        self.assertEqual(["900", "901"], result["removed_bookmark_ids"])
        self.assertEqual(2, len(requests))
        self.assertTrue(all(item["url"] == "https://www.pixiv.net/rpc/index.php" for item in requests))
        self.assertIn("mode=delete_illust_bookmark", requests[0]["data"])
        self.assertIn("bookmark_id=900", requests[0]["data"])
        self.assertIn("bookmark_id=901", requests[1]["data"])
        self.assertEqual("Pixiv request failed: 404 Not Found", result["ajax_error"])


class PixivClientBookmarkFetchTest(unittest.TestCase):
    def _make_client(self, bookmarks_endpoint: str = "") -> PixivClient:
        return PixivClient(
            PixivConfig(
                base_url="https://www.pixiv.net",
                bookmarks_endpoint=bookmarks_endpoint,
                bookmark_detail_endpoint="",
                bookmark_update_endpoint="",
                auth_mode="cookie",
            )
        )

    def test_fetch_bookmarks_uses_configured_legacy_endpoint(self) -> None:
        client = self._make_client("https://www.pixiv.net/ajax/user/bookmarks/illust")
        calls: list[dict] = []

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            calls.append({"endpoint": endpoint, "query": query, "referer": referer})
            return {"body": {"works": []}}

        client._request_json = fake_request_json  # type: ignore[method-assign]

        client.fetch_bookmarks(user_id="2623574", rest="show", limit=48, offset=96)

        self.assertEqual("https://www.pixiv.net/ajax/user/bookmarks/illust", calls[0]["endpoint"])
        self.assertEqual("2623574", calls[0]["query"]["user_id"])
        self.assertEqual("96", calls[0]["query"]["offset"])
        self.assertEqual("48", calls[0]["query"]["limit"])
        self.assertEqual("show", calls[0]["query"]["rest"])

    def test_parse_artwork_reads_bookmark_tags_from_multiple_shapes(self) -> None:
        client = self._make_client()

        artwork = client._parse_artwork(
            {
                "id": "100",
                "title": "Title",
                "userName": "Author",
                "userId": "1",
                "url": "//example.com/thumb.jpg",
                "tags": [{"tag": "pixiv-a"}],
                "bookmarkData": {
                    "id": "900",
                    "private": False,
                    "tags": [{"tag": "account-a"}, {"name": "account-b"}, {"tag": "account-a"}],
                },
            }
        )

        self.assertEqual(["account-a", "account-b"], artwork.bookmark_tags)
        self.assertEqual(["pixiv-a"], artwork.pixiv_tags)
        self.assertEqual("https://example.com/thumb.jpg", artwork.thumbnail_url)

    def test_parse_artwork_falls_back_to_top_level_bookmark_tags(self) -> None:
        client = self._make_client()

        artwork = client._parse_artwork(
            {
                "id": "101",
                "title": "Title",
                "userName": "Author",
                "userId": "1",
                "url": "https://example.com/thumb.jpg",
                "bookmarkTags": ["account-a", "account-b"],
                "bookmarkData": {"id": "901", "private": True},
            }
        )

        self.assertEqual(["account-a", "account-b"], artwork.bookmark_tags)
        self.assertEqual("private", artwork.visibility)

    def test_fetch_bookmarks_reads_body_level_bookmark_tags_map(self) -> None:
        client = self._make_client()

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            return {
                "body": {
                    "works": [
                        {
                            "id": "101",
                            "title": "Title",
                            "userName": "Author",
                            "userId": "1",
                            "url": "https://example.com/thumb.jpg",
                            "bookmarkData": {"id": "901", "private": False},
                        }
                    ],
                    "bookmarkTags": {
                        "901": ["account-a", "account-b"],
                    },
                }
            }

        client._request_json = fake_request_json  # type: ignore[method-assign]

        snapshot = client.fetch_bookmarks(user_id="2623574")

        self.assertEqual(["account-a", "account-b"], snapshot.items[0].bookmark_tags)

    def test_fetch_bookmarks_falls_back_to_modern_endpoint_on_legacy_404(self) -> None:
        client = self._make_client("https://www.pixiv.net/ajax/user/bookmarks/illust")
        calls: list[dict] = []

        def fake_request_json(endpoint: str, query=None, method: str = "GET", body=None, referer=None, extra_headers=None):
            calls.append({"endpoint": endpoint, "query": query})
            if endpoint.endswith('/ajax/user/bookmarks/illust'):
                raise RuntimeError('Pixiv request failed: 404 Not Found')
            return {"body": {"works": [], "bookmarkTags": {}}}

        client._request_json = fake_request_json  # type: ignore[method-assign]

        client.fetch_bookmarks(user_id="2623574")

        self.assertEqual('https://www.pixiv.net/ajax/user/bookmarks/illust', calls[0]['endpoint'])
        self.assertEqual('https://www.pixiv.net/ajax/user/2623574/illusts/bookmarks', calls[1]['endpoint'])

    def test_fetch_all_bookmarks_merges_public_and_private_by_bookmark_order(self) -> None:
        client = self._make_client()
        client.resolve_user_id = lambda: "2623574"  # type: ignore[method-assign]

        responses = {
            ("show", 0): [
                {
                    "id": "100",
                    "title": "Public older",
                    "userName": "Author",
                    "userId": "1",
                    "url": "https://example.com/public-old.jpg",
                    "bookmarkData": {"id": "900", "private": False},
                },
                {
                    "id": "101",
                    "title": "Public newest",
                    "userName": "Author",
                    "userId": "1",
                    "url": "https://example.com/public-new.jpg",
                    "bookmarkData": {"id": "1200", "private": False},
                },
            ],
            ("show", 2): [],
            ("hide", 0): [
                {
                    "id": "200",
                    "title": "Private middle",
                    "userName": "Author",
                    "userId": "1",
                    "url": "https://example.com/private-mid.jpg",
                    "bookmarkData": {"id": "1100", "private": True},
                },
                {
                    "id": "201",
                    "title": "Private oldest",
                    "userName": "Author",
                    "userId": "1",
                    "url": "https://example.com/private-old.jpg",
                    "bookmarkData": {"id": "800", "private": True},
                },
            ],
            ("hide", 2): [],
        }

        def fake_fetch_bookmarks(user_id=None, rest="show", limit=48, offset=0):
            works = responses.get((rest, offset), [])
            return type("Snapshot", (), {"items": [client._parse_artwork(item) for item in works]})()

        client.fetch_bookmarks = fake_fetch_bookmarks  # type: ignore[method-assign]

        snapshot = client.fetch_all_bookmarks(page_size=2)

        self.assertEqual(["1200", "1100", "900", "800"], [item.bookmark_id for item in snapshot.items])
        self.assertEqual(["public", "private", "public", "private"], [item.visibility for item in snapshot.items])


if __name__ == "__main__":
    unittest.main()
