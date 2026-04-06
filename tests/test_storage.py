from __future__ import annotations

import json
import unittest
from pathlib import Path

from backend.models import Artwork, BookmarkSnapshot
from backend.storage import save_sync_plan, save_ui_snapshot


class StorageTest(unittest.TestCase):
    test_dir = Path("tests/.tmp_storage")

    def tearDown(self) -> None:
        if self.test_dir.exists():
            for path in sorted(self.test_dir.rglob("*"), reverse=True):
                if path.is_file():
                    path.unlink()
                elif path.is_dir():
                    path.rmdir()

    def test_save_sync_plan_writes_json(self) -> None:
        plan_path = self.test_dir / "tag_sync_plan.json"
        saved_path = save_sync_plan({"mappings": [{"pixiv_tag": "a", "account_tag": "b"}]}, path=plan_path)

        self.assertEqual(plan_path, saved_path)
        payload = json.loads(plan_path.read_text(encoding="utf-8"))
        self.assertEqual("a", payload["mappings"][0]["pixiv_tag"])

    def test_save_ui_snapshot_writes_all_items_by_default(self) -> None:
        snapshot = BookmarkSnapshot(
            fetched_at="2026-03-20T00:00:00+00:00",
            items=[
                Artwork(id="1", bookmark_id="11", title="A", author="a", author_id="1", thumbnail_url="", pixiv_tags=[], bookmark_tags=[]),
                Artwork(id="2", bookmark_id="22", title="B", author="b", author_id="2", thumbnail_url="", pixiv_tags=[], bookmark_tags=[]),
            ],
        )

        json_path, _ = save_ui_snapshot(snapshot, data_dir=self.test_dir)

        payload = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(2, len(payload["items"]))


if __name__ == "__main__":
    unittest.main()
