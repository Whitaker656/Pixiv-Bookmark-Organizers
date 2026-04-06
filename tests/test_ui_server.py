from __future__ import annotations

import json
import time
import unittest
from pathlib import Path

from backend.ui_server import (
    PixivUiRequestHandler,
    SyncApplyWorker,
    ThumbnailCacheWorker,
    build_auth_config_summary,
    build_session_status_payload,
)


class FakeService:
    def __init__(self, thumbnail_results: list[dict] | None = None, sync_results: list[dict] | None = None) -> None:
        self.thumbnail_results = thumbnail_results or []
        self.sync_results = sync_results or []
        self.calls: list[dict] = []
        self.preview_calls: list[dict] = []
        self.execute_calls: list[dict] = []
        self.refresh_calls: list[dict] = []
        self.session_profile = {"user_id": "2623574", "name": "Tester", "is_followed": False}
        self.session_error = ""
        self.client = type("Client", (), {
            "config": type("Config", (), {
                "auth_mode": "cookie",
                "cookie_file": "pixiv.net_cookies.txt",
                "raw_cookie": "",
                "php_sessid": "",
                "user_id": "2623574",
            })()
        })()
        self.client.validate_session = self.validate_session

    def cache_thumbnails(self, snapshot_path: str, limit: int, data_dir: str, priority_artwork_ids: list[str] | None = None) -> dict:
        self.calls.append(
            {
                "snapshot_path": snapshot_path,
                "limit": limit,
                "data_dir": data_dir,
                "priority_artwork_ids": priority_artwork_ids or [],
            }
        )
        if self.thumbnail_results:
            return self.thumbnail_results.pop(0)
        return {"downloaded": 0, "skipped": 0, "generated_at": "", "cached_total": 0}

    def preview_sync_actions(self, snapshot_path: str, mapping_path: str) -> list[dict]:
        self.preview_calls.append({"snapshot_path": snapshot_path, "mapping_path": mapping_path})
        return [
            {
                "artwork_id": "100",
                "bookmark_id": "900",
                "title": "Alpha",
                "visibility": "public",
                "merged_tags": ["tag-a"],
            },
            {
                "artwork_id": "200",
                "bookmark_id": "901",
                "title": "Beta",
                "visibility": "public",
                "merged_tags": ["tag-b"],
            },
        ]

    def filter_sync_actions(self, actions: list[dict], artwork_ids: list[str] | None = None, limit: int | None = None) -> list[dict]:
        filtered = actions
        if artwork_ids:
            artwork_id_set = set(artwork_ids)
            filtered = [action for action in filtered if action["artwork_id"] in artwork_id_set]
        if limit is not None:
            filtered = filtered[:limit]
        return filtered

    def execute_sync_action(self, action: dict, dry_run: bool = False) -> dict:
        self.execute_calls.append({"action": action, "dry_run": dry_run})
        if self.sync_results:
            result = self.sync_results.pop(0)
            return {
                "artwork_id": action["artwork_id"],
                "bookmark_id": action["bookmark_id"],
                "title": action["title"],
                "tags_to_apply": action["merged_tags"],
                "dry_run": dry_run,
                **result,
            }
        return {
            "artwork_id": action["artwork_id"],
            "bookmark_id": action["bookmark_id"],
            "title": action["title"],
            "tags_to_apply": action["merged_tags"],
            "dry_run": dry_run,
            "status": "updated",
        }


    def fetch_all_save_and_cache(
        self,
        page_size: int,
        thumbnail_limit: int = 5,
        snapshot_path: str = "data/bookmarks_snapshot.json",
        thumbnail_snapshot_path: str = "data/bookmarks_ui_snapshot.json",
        data_dir: str = "data",
    ) -> dict:
        self.refresh_calls.append(
            {
                "page_size": page_size,
                "thumbnail_limit": thumbnail_limit,
                "snapshot_path": snapshot_path,
                "thumbnail_snapshot_path": thumbnail_snapshot_path,
                "data_dir": data_dir,
            }
        )
        return {"saved_to": snapshot_path, "thumbnail_cache": None}

    def remove_bookmarks(self, bookmark_ids: list[str]) -> dict:
        self.calls.append({"removed_bookmark_ids": bookmark_ids})
        return {"ok": True, "removed_bookmark_ids": bookmark_ids}

    def remove_bookmark(self, bookmark_id: str) -> dict:
        return self.remove_bookmarks([bookmark_id])

    def load_snapshot(self, path: str) -> object:
        return type("Snapshot", (), {"items": [1, 2, 3], "fetched_at": "2026-03-20T00:00:00+00:00"})()

    def validate_session(self) -> dict:
        if self.session_error:
            raise RuntimeError(self.session_error)
        return dict(self.session_profile)


class ThumbnailCacheWorkerTest(unittest.TestCase):
    def test_repeat_worker_stops_after_idle_round(self) -> None:
        service = FakeService(
            thumbnail_results=[
                {"downloaded": 2, "skipped": 0, "generated_at": "2026-03-17T00:00:00+00:00", "cached_total": 2},
                {"downloaded": 0, "skipped": 2, "generated_at": "2026-03-17T00:00:05+00:00", "cached_total": 2},
            ]
        )
        worker = ThumbnailCacheWorker(service, snapshot_path="snapshot.json", data_dir="data")  # type: ignore[arg-type]

        worker.start(limit=10, repeat=True, sleep_seconds=0.01, priority_artwork_ids=["200", "100"])
        for _ in range(100):
            status = worker.status()
            if not status["running"]:
                break
            time.sleep(0.01)

        status = worker.status()
        self.assertFalse(status["running"])
        self.assertEqual("repeat", status["mode"])
        self.assertEqual(2, status["rounds_completed"])
        self.assertEqual("2026-03-17T00:00:05+00:00", status["last_result"]["generated_at"])
        self.assertEqual(["200", "100"], service.calls[0]["priority_artwork_ids"])


class SyncApplyWorkerTest(unittest.TestCase):
    log_path = Path("tests/.tmp_sync/sync_apply_log.json")

    def tearDown(self) -> None:
        root = self.log_path.parent
        if root.exists():
            for item in sorted(root.rglob("*"), reverse=True):
                if item.is_file():
                    item.unlink()
                elif item.is_dir():
                    item.rmdir()

    def test_sync_apply_worker_runs_one_by_one_and_logs(self) -> None:
        service = FakeService(sync_results=[{"status": "updated"}, {"status": "skipped", "reason": "bookmark_id_missing"}])
        worker = SyncApplyWorker(service, snapshot_path="snapshot.json", plan_path="tests/.tmp_sync/tag_sync_plan.json", log_path=self.log_path)  # type: ignore[arg-type]

        worker.start(
            plan={"mappings": [], "replace_rules": [], "manual_overrides": []},
            batch_size=2,
            interval_seconds=0.01,
            selected_artwork_ids=["100", "200"],
        )
        for _ in range(100):
            status = worker.status()
            if not status["running"]:
                break
            time.sleep(0.01)

        status = worker.status()
        self.assertFalse(status["running"])
        self.assertEqual(2, status["total_actions"])
        self.assertEqual(2, status["completed_actions"])
        self.assertEqual(1, status["updated_count"])
        self.assertEqual(1, status["skipped_count"])
        self.assertTrue(self.log_path.exists())
        payload = json.loads(self.log_path.read_text(encoding="utf-8"))
        self.assertEqual(2, payload["completed_actions"])

    def test_sync_apply_worker_filters_selected_artworks(self) -> None:
        service = FakeService()
        worker = SyncApplyWorker(service, snapshot_path="snapshot.json", plan_path="tests/.tmp_sync/tag_sync_plan.json", log_path=self.log_path)  # type: ignore[arg-type]

        status = worker.start(
            plan={"mappings": [], "replace_rules": [], "manual_overrides": []},
            batch_size=10,
            interval_seconds=0.01,
            selected_artwork_ids=["200"],
        )

        self.assertEqual(1, status["total_actions"])


class SyncPlanUiHandlerTest(unittest.TestCase):
    def test_build_sync_plan_counts(self) -> None:
        handler = object.__new__(PixivUiRequestHandler)
        counts = handler._build_sync_plan_counts(
            {
                "mappings": [{"pixiv_tag": "a", "account_tag": "b"}],
                "replace_rules": [{"source_account_tag": "x", "target_account_tag": "y"}],
                "manual_overrides": [{"artwork_id": "1", "bookmark_tags": ["tag"]}],
            }
        )

        self.assertEqual({"mappings": 1, "replace_rules": 1, "manual_overrides": 1}, counts)


    def test_refresh_bookmarks_calls_service_with_default_paths(self) -> None:
        service = FakeService()
        results = service.fetch_all_save_and_cache(
            page_size=48,
            thumbnail_limit=0,
            snapshot_path="data/bookmarks_snapshot.json",
            thumbnail_snapshot_path="data/bookmarks_ui_snapshot.json",
            data_dir="data",
        )
        snapshot = service.load_snapshot("data/bookmarks_ui_snapshot.json")

        self.assertEqual(1, len(service.refresh_calls))
        self.assertEqual(48, service.refresh_calls[0]["page_size"])
        self.assertEqual(0, service.refresh_calls[0]["thumbnail_limit"])
        self.assertEqual(3, len(snapshot.items))
        self.assertEqual("data/bookmarks_snapshot.json", results["saved_to"])


if __name__ == "__main__":
    unittest.main()


class SessionStatusTest(unittest.TestCase):
    def test_build_auth_config_summary_prefers_cookie_file(self) -> None:
        service = FakeService()

        summary = build_auth_config_summary(service)

        self.assertEqual("cookie", summary["auth_mode"])
        self.assertEqual("cookie_file", summary["auth_source"])
        self.assertEqual("pixiv.net_cookies.txt", summary["auth_value"])
        self.assertEqual("2623574", summary["configured_user_id"])

    def test_build_session_status_payload_returns_profile_on_success(self) -> None:
        service = FakeService()

        payload = build_session_status_payload(service)

        self.assertTrue(payload["ok"])
        self.assertTrue(payload["authenticated"])
        self.assertEqual("Tester", payload["profile"]["name"])

    def test_build_session_status_payload_returns_error_on_failure(self) -> None:
        service = FakeService()
        service.session_error = "Pixiv request failed: 403 Forbidden"

        payload = build_session_status_payload(service)

        self.assertFalse(payload["ok"])
        self.assertFalse(payload["authenticated"])
        self.assertIn("403", payload["error"])
