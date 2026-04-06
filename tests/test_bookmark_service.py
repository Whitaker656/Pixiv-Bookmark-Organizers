from __future__ import annotations

import json
import unittest
from pathlib import Path

from backend.bookmark_service import BookmarkService
from backend.models import Artwork, BookmarkSnapshot


class FakePixivClient:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.thumbnail_downloads: list[dict[str, str]] = []
        self.bookmark_tag_stats = {"fetched_at": "", "tags": []}
        self.snapshot = BookmarkSnapshot(fetched_at="", items=[])

    def fetch_all_bookmarks(self, page_size: int = 48) -> BookmarkSnapshot:
        return self.snapshot

    def fetch_bookmark_tag_stats(self) -> dict:
        return self.bookmark_tag_stats

    def update_bookmark_tags(self, bookmark_id: str, tags: list[str], visibility: str, current_tags: list[str] | None = None) -> dict:
        payload = {
            "bookmark_id": bookmark_id,
            "tags": tags,
            "visibility": visibility,
            "current_tags": current_tags or [],
        }
        self.calls.append(payload)
        return {"ok": True, **payload}

    def download_thumbnail(self, url: str, destination: str) -> str:
        target = Path(destination)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"fake-image")
        payload = {"url": url, "destination": destination}
        self.thumbnail_downloads.append(payload)
        return destination

    def remove_bookmarks(self, bookmark_ids: list[str]) -> dict:
        payload = {"bookmark_ids": bookmark_ids}
        self.calls.append(payload)
        return {"ok": True, "removed_bookmark_ids": bookmark_ids}


class BookmarkServiceTest(unittest.TestCase):
    test_dir = Path("tests/.tmp")

    def setUp(self) -> None:
        self.client = FakePixivClient()
        self.service = BookmarkService(self.client)  # type: ignore[arg-type]
        self.test_dir.mkdir(parents=True, exist_ok=True)
        self.snapshot = BookmarkSnapshot(
            fetched_at="2026-03-14T00:00:00+00:00",
            items=[
                Artwork(
                    id="100",
                    bookmark_id="900",
                    title="Alpha",
                    author="Author A",
                    author_id="1",
                    thumbnail_url="https://example.com/100.jpg",
                    pixiv_tags=["태그A", "태그B"],
                    bookmark_tags=["기존", "태그A"],
                    visibility="public",
                ),
                Artwork(
                    id="200",
                    bookmark_id="",
                    title="Beta",
                    author="Author B",
                    author_id="2",
                    thumbnail_url="https://example.com/200.jpg",
                    pixiv_tags=["태그C"],
                    bookmark_tags=["태그A"],
                    visibility="private",
                ),
                Artwork(
                    id="300",
                    bookmark_id="901",
                    title="Deleted",
                    author="Author C",
                    author_id="3",
                    thumbnail_url="https://example.com/300.jpg",
                    pixiv_tags=["태그A"],
                    bookmark_tags=[],
                    visibility="public",
                    is_deleted=True,
                ),
            ],
        )
        self.client.snapshot = self.snapshot
        self.mapping_rules = [
            {"pixiv_tag": "태그A", "account_tag": "매핑A"},
            {"pixiv_tag": "태그B", "account_tag": "추천 태그"},
            {"pixiv_tag": "태그C", "account_tag": "비공개"},
        ]
        self.replace_rules = [
            {"source_account_tag": "태그A", "target_account_tag": "태그A-치환"}
        ]

    def tearDown(self) -> None:
        if self.test_dir.exists():
            for path in sorted(self.test_dir.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()

    def test_build_sync_actions_skips_deleted_and_merges_tags(self) -> None:
        actions = self.service.build_sync_actions(self.snapshot, self.mapping_rules)

        self.assertEqual(2, len(actions))
        self.assertEqual("100", actions[0]["artwork_id"])
        self.assertCountEqual(["기존", "태그A", "추천 태그", "매핑A"], actions[0]["merged_tags"])
        self.assertEqual("200", actions[1]["artwork_id"])
        self.assertCountEqual(["태그A", "비공개"], actions[1]["merged_tags"])

    def test_build_sync_actions_applies_replace_rules(self) -> None:
        actions = self.service.build_sync_actions(self.snapshot, self.mapping_rules, self.replace_rules)

        action = next(item for item in actions if item["artwork_id"] == "100")
        self.assertCountEqual(
            ["기존", "태그A-치환", "추천 태그", "매핑A"],
            action["merged_tags"],
        )

    def test_build_sync_actions_applies_manual_overrides(self) -> None:
        actions = self.service.build_sync_actions(
            self.snapshot,
            self.mapping_rules,
            self.replace_rules,
            [{"artwork_id": "100", "bookmark_tags": ["수동", "태그A"]}],
        )

        action = next(item for item in actions if item["artwork_id"] == "100")
        self.assertTrue(action["has_manual_override"])
        self.assertCountEqual(["수동", "태그A"], action["manual_override_tags"])
        self.assertCountEqual(
            ["수동", "태그A-치환", "추천 태그", "매핑A"],
            action["merged_tags"],
        )
        self.assertCountEqual(["매핑A", "추천 태그"], action["recommended_tags"])

    def test_apply_sync_actions_dry_run_does_not_call_client(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        mapping_path = self.test_dir / "mapping.json"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")
        mapping_path.write_text(
            json.dumps(
                {"mappings": self.mapping_rules, "replace_rules": self.replace_rules, "manual_overrides": []},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        results = self.service.apply_sync_actions(snapshot_path, mapping_path, dry_run=True)

        self.assertEqual(2, len(results))
        self.assertEqual([], self.client.calls)
        self.assertTrue(all(item["status"] == "preview" for item in results))

    def test_apply_sync_actions_skips_missing_bookmark_id(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        mapping_path = self.test_dir / "mapping.json"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")
        mapping_path.write_text(
            json.dumps(
                {
                    "mappings": self.mapping_rules,
                    "replace_rules": self.replace_rules,
                    "manual_overrides": [{"artwork_id": "100", "bookmark_tags": ["수동", "태그A"]}],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        results = self.service.apply_sync_actions(snapshot_path, mapping_path, dry_run=False)

        self.assertEqual(1, len(self.client.calls))
        self.assertEqual("900", self.client.calls[0]["bookmark_id"])
        self.assertCountEqual(["기존", "태그A"], self.client.calls[0]["current_tags"])
        self.assertCountEqual(
            ["수동", "태그A-치환", "추천 태그", "매핑A"],
            self.client.calls[0]["tags"],
        )
        self.assertEqual("updated", results[0]["status"])
        self.assertEqual("skipped", results[1]["status"])
        self.assertEqual("bookmark_id_missing", results[1]["reason"])

    def test_fetch_all_save_and_cache_runs_small_thumbnail_batch(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        results = self.service.fetch_all_save_and_cache(
            page_size=48,
            thumbnail_limit=1,
            snapshot_path=snapshot_path,
            thumbnail_snapshot_path=snapshot_path,
            data_dir=self.test_dir / "data",
        )

        self.assertEqual(str(snapshot_path), results["snapshot"])
        self.assertIsNotNone(results["thumbnail_cache"])
        self.assertEqual(1, results["thumbnail_cache"]["downloaded"])
        self.assertEqual(1, len(self.client.thumbnail_downloads))
        self.assertTrue((self.test_dir / "bookmark_tag_stats.json").exists())
        self.assertTrue((self.test_dir / "bookmarks_ui_snapshot.json").exists())

    def test_cache_thumbnails_downloads_missing_files_only(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        data_dir = self.test_dir / "data"
        cache_dir = data_dir / "thumbnail_cache"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / "100.jpg").write_bytes(b"cached")
        (data_dir / "thumbnail_cache_index.json").write_text(
            json.dumps({"generated_at": "", "items": {"100": "tests/.tmp/data/thumbnail_cache/100.jpg"}}, ensure_ascii=False),
            encoding="utf-8",
        )

        results = self.service.cache_thumbnails(snapshot_path=snapshot_path, limit=5, data_dir=data_dir)

        self.assertEqual(1, results["downloaded"])
        self.assertEqual(1, results["skipped"])
        self.assertEqual([], results["failed"])
        self.assertEqual(1, len(self.client.thumbnail_downloads))
        self.assertTrue((cache_dir / "200.jpg").exists())
        self.assertTrue((data_dir / "thumbnail_cache_index.json").exists())


    def test_cache_thumbnails_prioritizes_requested_artwork_ids(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        data_dir = self.test_dir / "data"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")

        results = self.service.cache_thumbnails(
            snapshot_path=snapshot_path,
            limit=1,
            data_dir=data_dir,
            priority_artwork_ids=["200", "100"],
        )

        self.assertEqual(1, results["downloaded"])
        self.assertEqual(["200", "100"], results["priority_artwork_ids"])
        self.assertEqual("https://example.com/200.jpg", self.client.thumbnail_downloads[0]["url"])

    def test_thumbnail_cache_session_advances_without_restart_scan(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        data_dir = self.test_dir / "data"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")

        session = self.service._prepare_thumbnail_cache_session(
            snapshot_path=snapshot_path,
            data_dir=data_dir,
        )

        first = self.service._cache_thumbnails_from_session(session, limit=1)
        second = self.service._cache_thumbnails_from_session(session, limit=1)

        self.assertEqual(1, first["downloaded"])
        self.assertEqual(1, second["downloaded"])
        self.assertEqual(2, len(self.client.thumbnail_downloads))
        self.assertEqual(2, session["cursor"])


    def test_apply_sync_actions_filters_requested_artwork_ids(self) -> None:
        snapshot_path = self.test_dir / "snapshot.json"
        mapping_path = self.test_dir / "mapping.json"
        snapshot_path.write_text(json.dumps(self.snapshot.to_dict(), ensure_ascii=False), encoding="utf-8")
        mapping_path.write_text(
            json.dumps(
                {"mappings": self.mapping_rules, "replace_rules": self.replace_rules, "manual_overrides": []},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        results = self.service.apply_sync_actions(
            snapshot_path,
            mapping_path,
            dry_run=True,
            artwork_ids=["200"],
        )

        self.assertEqual(1, len(results))
        self.assertEqual("200", results[0]["artwork_id"])


if __name__ == "__main__":
    unittest.main()


