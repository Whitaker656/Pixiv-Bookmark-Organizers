from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .models import Artwork, BookmarkSnapshot
from .pixiv_client import PixivClient
from .storage import (
    build_thumbnail_cache_path,
    load_thumbnail_cache_index,
    save_snapshot,
    save_thumbnail_cache_index,
)


class BookmarkService:
    def __init__(self, client: PixivClient) -> None:
        self.client = client

    def fetch_and_save(self, limit: int, offset: int) -> Path:
        snapshot = self.client.fetch_bookmarks(limit=limit, offset=offset)
        return save_snapshot(snapshot)

    def fetch_all_and_save(self, page_size: int) -> Path:
        snapshot = self.client.fetch_all_bookmarks(page_size=page_size)
        bookmark_tag_stats = self.client.fetch_bookmark_tag_stats()
        return save_snapshot(snapshot, bookmark_tag_stats=bookmark_tag_stats)

    def fetch_all_save_and_cache(
        self,
        page_size: int,
        thumbnail_limit: int = 5,
        snapshot_path: str | Path = "data/bookmarks_snapshot.json",
        thumbnail_snapshot_path: str | Path = "data/bookmarks_ui_snapshot.json",
        data_dir: str | Path = "data",
    ) -> dict[str, Any]:
        snapshot = self.client.fetch_all_bookmarks(page_size=page_size)
        bookmark_tag_stats = self.client.fetch_bookmark_tag_stats()
        output = save_snapshot(snapshot, path=snapshot_path, bookmark_tag_stats=bookmark_tag_stats)
        thumbnail_results = None
        if thumbnail_limit > 0:
            thumbnail_results = self.cache_thumbnails(
                snapshot_path=thumbnail_snapshot_path,
                limit=thumbnail_limit,
                data_dir=data_dir,
            )

        return {
            "snapshot": str(Path(snapshot_path)),
            "saved_to": str(output),
            "thumbnail_cache": thumbnail_results,
        }

    def cache_thumbnails(
        self,
        snapshot_path: str | Path,
        limit: int = 20,
        data_dir: str | Path = "data",
        priority_artwork_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        session = self._prepare_thumbnail_cache_session(
            snapshot_path=snapshot_path,
            data_dir=data_dir,
            priority_artwork_ids=priority_artwork_ids,
        )
        return self._cache_thumbnails_from_session(session, limit=limit)

    def _prepare_thumbnail_cache_session(
        self,
        snapshot_path: str | Path,
        data_dir: str | Path = "data",
        priority_artwork_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        snapshot = self.load_snapshot(snapshot_path)
        cache_index = load_thumbnail_cache_index(data_dir)
        cached_items = dict(cache_index.get("items", {}))
        requested_priority_ids = [str(artwork_id).strip() for artwork_id in (priority_artwork_ids or []) if str(artwork_id).strip()]
        priority_index = {artwork_id: index for index, artwork_id in enumerate(requested_priority_ids)}
        ordered_items = sorted(
            snapshot.items,
            key=lambda artwork: (0, priority_index[artwork.id]) if artwork.id in priority_index else (1, 0),
        )

        return {
            "snapshot_path": str(snapshot_path),
            "data_dir": str(data_dir),
            "priority_artwork_ids": requested_priority_ids,
            "ordered_items": ordered_items,
            "cached_items": cached_items,
            "cursor": 0,
        }

    def _cache_thumbnails_from_session(
        self,
        session: dict[str, Any],
        limit: int = 20,
    ) -> dict[str, Any]:
        ordered_items: list[Artwork] = session.get("ordered_items", [])
        cached_items = dict(session.get("cached_items", {}))
        cursor = max(int(session.get("cursor", 0) or 0), 0)
        data_dir = str(session.get("data_dir", "data"))
        snapshot_path = str(session.get("snapshot_path", ""))
        requested_priority_ids = list(session.get("priority_artwork_ids", []))
        processed = 0
        downloaded = 0
        skipped = 0
        failed: list[dict[str, str]] = []

        for artwork in ordered_items[cursor:]:
            if processed >= limit:
                break
            cursor += 1

            thumbnail_url = str(artwork.thumbnail_url or "").strip()
            if not thumbnail_url or artwork.is_deleted:
                continue

            if artwork.id in cached_items and Path(cached_items[artwork.id]).exists():
                skipped += 1
                continue

            processed += 1
            target_path = build_thumbnail_cache_path(artwork.id, thumbnail_url, Path(data_dir) / "thumbnail_cache")
            relative_path = target_path.as_posix()

            if target_path.exists():
                cached_items[artwork.id] = relative_path
                skipped += 1
                continue

            try:
                self.client.download_thumbnail(thumbnail_url, str(target_path))
                cached_items[artwork.id] = relative_path
                downloaded += 1
            except RuntimeError as exc:
                failed.append({"artwork_id": artwork.id, "thumbnail_url": thumbnail_url, "reason": str(exc)})

        session["cached_items"] = cached_items
        session["cursor"] = cursor
        save_thumbnail_cache_index(cached_items, data_dir=data_dir)
        refreshed_index = load_thumbnail_cache_index(data_dir)
        return {
            "snapshot": str(snapshot_path),
            "limit": limit,
            "priority_artwork_ids": requested_priority_ids,
            "downloaded": downloaded,
            "skipped": skipped,
            "failed": failed,
            "cached_total": len(cached_items),
            "generated_at": str(refreshed_index.get("generated_at", "")),
            "exhausted": cursor >= len(ordered_items),
        }

    def load_snapshot(self, path: str | Path) -> BookmarkSnapshot:
        raw = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        items = [Artwork(**item) for item in raw.get("items", [])]
        return BookmarkSnapshot(fetched_at=raw.get("fetched_at", ""), items=items)

    def preview_sync_actions(self, snapshot_path: str | Path, mapping_path: str | Path) -> list[dict]:
        snapshot = self.load_snapshot(snapshot_path)
        sync_plan = self.load_sync_plan(mapping_path)
        return self.build_sync_actions(
            snapshot,
            sync_plan.get("mappings", []),
            sync_plan.get("replace_rules", []),
            sync_plan.get("manual_overrides", []),
        )

    def filter_sync_actions(
        self,
        actions: list[dict[str, Any]],
        artwork_ids: list[str] | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        filtered = actions
        if artwork_ids:
            artwork_id_set = {str(artwork_id).strip() for artwork_id in artwork_ids if str(artwork_id).strip()}
            filtered = [action for action in filtered if str(action.get("artwork_id", "")) in artwork_id_set]
        if limit is not None:
            filtered = filtered[:limit]
        return filtered

    def load_sync_plan(self, path: str | Path) -> dict[str, list[dict[str, Any]]]:
        sync_plan = json.loads(Path(path).read_text(encoding="utf-8-sig"))
        return {
            "mappings": sync_plan.get("mappings", []),
            "replace_rules": sync_plan.get("replace_rules", []),
            "manual_overrides": sync_plan.get("manual_overrides", []),
        }

    def build_sync_actions(
        self,
        snapshot: BookmarkSnapshot,
        mapping_rules: list[dict[str, Any]],
        replace_rules: list[dict[str, Any]] | None = None,
        manual_overrides: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        override_index = self.build_override_index(manual_overrides or [])
        normalized_replace_rules = self.normalize_replace_rules(replace_rules or [])

        for artwork in snapshot.items:
            if artwork.is_deleted:
                continue

            current_tags = sorted(set(artwork.bookmark_tags))
            override_tags = self.resolve_override_tags(artwork, override_index)
            base_tags = sorted(set(override_tags if override_tags is not None else artwork.bookmark_tags))
            replaced_tags = self.apply_replace_rules(base_tags, normalized_replace_rules)

            recommended = []
            for rule in mapping_rules:
                source = rule.get("pixiv_tag")
                target = rule.get("account_tag")
                if source in artwork.pixiv_tags and target not in replaced_tags:
                    recommended.append(target)

            merged_tags = sorted(set(replaced_tags + recommended))
            if merged_tags != current_tags:
                actions.append(
                    {
                        "artwork_id": artwork.id,
                        "bookmark_id": artwork.bookmark_id,
                        "title": artwork.title,
                        "visibility": artwork.visibility,
                        "current_tags": current_tags,
                        "manual_override_tags": base_tags if override_tags is not None else None,
                        "has_manual_override": override_tags is not None,
                        "applied_replace_rules": normalized_replace_rules,
                        "recommended_tags": sorted(set(recommended)),
                        "merged_tags": merged_tags,
                    }
                )

        return actions

    def build_override_index(self, manual_overrides: list[dict[str, Any]]) -> dict[str, list[str]]:
        override_index: dict[str, list[str]] = {}

        for override in manual_overrides:
            tags = override.get("bookmark_tags")
            if not isinstance(tags, list):
                continue

            normalized_tags = sorted({str(tag) for tag in tags if str(tag).strip()})
            artwork_id = str(override.get("artwork_id") or "").strip()
            bookmark_id = str(override.get("bookmark_id") or "").strip()

            if artwork_id:
                override_index[f"artwork:{artwork_id}"] = normalized_tags
            if bookmark_id:
                override_index[f"bookmark:{bookmark_id}"] = normalized_tags

        return override_index

    def resolve_override_tags(self, artwork: Artwork, override_index: dict[str, list[str]]) -> list[str] | None:
        if artwork.id and f"artwork:{artwork.id}" in override_index:
            return override_index[f"artwork:{artwork.id}"]
        if artwork.bookmark_id and f"bookmark:{artwork.bookmark_id}" in override_index:
            return override_index[f"bookmark:{artwork.bookmark_id}"]
        return None

    def normalize_replace_rules(self, replace_rules: list[dict[str, Any]]) -> list[dict[str, str]]:
        normalized_rules: list[dict[str, str]] = []

        for rule in replace_rules:
            source = str(rule.get("source_account_tag") or "").strip()
            target = str(rule.get("target_account_tag") or "").strip()
            if not source or not target or source == target:
                continue
            normalized_rules.append(
                {
                    "source_account_tag": source,
                    "target_account_tag": target,
                }
            )

        return normalized_rules

    def apply_replace_rules(self, tags: list[str], replace_rules: list[dict[str, str]]) -> list[str]:
        replaced_tags = list(tags)

        for rule in replace_rules:
            source = rule["source_account_tag"]
            target = rule["target_account_tag"]
            replaced_tags = [target if tag == source else tag for tag in replaced_tags]

        return sorted(set(replaced_tags))

    def apply_sync_actions(
        self,
        snapshot_path: str | Path,
        mapping_path: str | Path,
        limit: int | None = None,
        dry_run: bool = True,
        artwork_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        snapshot = self.load_snapshot(snapshot_path)
        sync_plan = self.load_sync_plan(mapping_path)
        actions = self.build_sync_actions(
            snapshot,
            sync_plan.get("mappings", []),
            sync_plan.get("replace_rules", []),
            sync_plan.get("manual_overrides", []),
        )

        actions = self.filter_sync_actions(actions, artwork_ids=artwork_ids, limit=limit)

        results: list[dict[str, Any]] = []
        for action in actions:
            results.append(self.execute_sync_action(action, dry_run=dry_run))

        return results

    def execute_sync_action(
        self,
        action: dict[str, Any],
        dry_run: bool = False,
    ) -> dict[str, Any]:
        result = {
            "artwork_id": action["artwork_id"],
            "bookmark_id": action["bookmark_id"],
            "title": action["title"],
            "dry_run": dry_run,
            "tags_to_apply": action["merged_tags"],
        }

        if dry_run:
            result["status"] = "preview"
            return result

        if not action["bookmark_id"]:
            result["status"] = "skipped"
            result["reason"] = "bookmark_id_missing"
            return result

        response = self.client.update_bookmark_tags(
            bookmark_id=action["bookmark_id"],
            tags=action["merged_tags"],
            visibility=action["visibility"],
            current_tags=action.get("current_tags", []),
        )
        result["status"] = "updated"
        result["response"] = response
        return result
    def remove_bookmarks(self, bookmark_ids: list[str]) -> dict[str, Any]:
        normalized = [str(bookmark_id).strip() for bookmark_id in (bookmark_ids or []) if str(bookmark_id).strip()]
        if not normalized:
            raise RuntimeError("bookmark_id_missing")
        return self.client.remove_bookmarks(normalized)

    def remove_bookmark(self, bookmark_id: str) -> dict[str, Any]:
        return self.remove_bookmarks([bookmark_id])
