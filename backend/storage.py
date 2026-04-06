from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .models import BookmarkSnapshot


DEFAULT_DATA_DIR = Path("data")
DEFAULT_UI_LIMIT = 0
BOOKMARK_TAG_STATS_GLOBAL_KEY = "__PIXIV_BOOKMARK_TAG_STATS__"
THUMBNAIL_CACHE_INDEX_GLOBAL_KEY = "__PIXIV_THUMBNAIL_CACHE_INDEX__"
DEFAULT_THUMBNAIL_CACHE_DIR = DEFAULT_DATA_DIR / "thumbnail_cache"


def ensure_data_dir(path: str | Path | None = None) -> Path:
    data_dir = Path(path or DEFAULT_DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


def save_snapshot(
    snapshot: BookmarkSnapshot,
    path: str | Path | None = None,
    bookmark_tag_stats: dict[str, Any] | None = None,
) -> Path:
    snapshot_path = Path(path or DEFAULT_DATA_DIR / "bookmarks_snapshot.json")
    data_dir = ensure_data_dir(snapshot_path.parent)
    serialized = json.dumps(snapshot.to_dict(), ensure_ascii=False, indent=2)
    snapshot_path.write_text(serialized, encoding="utf-8")
    js_path = snapshot_path.with_suffix(".js")
    js_path.write_text(
        f"window.__PIXIV_BOOKMARK_SNAPSHOT__ = {serialized};\n",
        encoding="utf-8",
    )
    if bookmark_tag_stats is None:
        bookmark_tag_stats = build_bookmark_tag_stats_from_snapshot(snapshot)
    save_bookmark_tag_stats(bookmark_tag_stats, data_dir=data_dir)
    save_ui_snapshot(snapshot, limit=DEFAULT_UI_LIMIT, data_dir=data_dir)
    return snapshot_path


def save_ui_snapshot(
    snapshot: BookmarkSnapshot,
    limit: int | None = DEFAULT_UI_LIMIT,
    data_dir: str | Path | None = None,
) -> tuple[Path, Path]:
    resolved_data_dir = ensure_data_dir(data_dir)
    ui_snapshot = BookmarkSnapshot(
        fetched_at=snapshot.fetched_at,
        items=snapshot.items[:] if not limit or limit < 0 else snapshot.items[:limit],
    )
    serialized = json.dumps(ui_snapshot.to_dict(), ensure_ascii=False, indent=2)
    json_path = resolved_data_dir / "bookmarks_ui_snapshot.json"
    js_path = resolved_data_dir / "bookmarks_ui_snapshot.js"
    json_path.write_text(serialized, encoding="utf-8")
    js_path.write_text(
        f"window.__PIXIV_BOOKMARK_SNAPSHOT__ = {serialized};\n",
        encoding="utf-8",
    )
    return json_path, js_path


def build_bookmark_tag_stats_from_snapshot(snapshot: BookmarkSnapshot) -> dict[str, Any]:
    counts: dict[str, int] = {}

    for item in snapshot.items:
        for tag_name in item.bookmark_tags:
            normalized_tag = str(tag_name).strip()
            if not normalized_tag:
                continue
            counts[normalized_tag] = counts.get(normalized_tag, 0) + 1

    return {
        "fetched_at": snapshot.fetched_at,
        "tags": [
            {"name": name, "count": count, "public_count": count, "private_count": 0}
            for name, count in sorted(
                counts.items(),
                key=lambda entry: (-entry[1], entry[0]),
            )
        ],
    }


def save_bookmark_tag_stats(
    bookmark_tag_stats: dict[str, Any],
    data_dir: str | Path | None = None,
) -> tuple[Path, Path]:
    resolved_data_dir = ensure_data_dir(data_dir)
    serialized = json.dumps(bookmark_tag_stats, ensure_ascii=False, indent=2)
    json_path = resolved_data_dir / "bookmark_tag_stats.json"
    js_path = resolved_data_dir / "bookmark_tag_stats.js"
    json_path.write_text(serialized, encoding="utf-8")
    js_path.write_text(
        f"window.{BOOKMARK_TAG_STATS_GLOBAL_KEY} = {serialized};\n",
        encoding="utf-8",
    )
    return json_path, js_path


def ensure_thumbnail_cache_dir(path: str | Path | None = None) -> Path:
    cache_dir = Path(path or DEFAULT_THUMBNAIL_CACHE_DIR)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def build_thumbnail_cache_path(artwork_id: str, source_url: str, cache_dir: str | Path | None = None) -> Path:
    resolved_cache_dir = ensure_thumbnail_cache_dir(cache_dir)
    suffix = Path(source_url).suffix or ".jpg"
    if len(suffix) > 8:
        suffix = ".jpg"
    return resolved_cache_dir / f"{artwork_id}{suffix}"


def save_thumbnail_cache_index(
    entries: dict[str, str],
    data_dir: str | Path | None = None,
) -> tuple[Path, Path]:
    resolved_data_dir = ensure_data_dir(data_dir)
    payload = {
        "generated_at": datetime.now(UTC).isoformat(),
        "items": entries,
    }
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    json_path = resolved_data_dir / "thumbnail_cache_index.json"
    js_path = resolved_data_dir / "thumbnail_cache_index.js"
    json_path.write_text(serialized, encoding="utf-8")
    js_path.write_text(
        f"window.{THUMBNAIL_CACHE_INDEX_GLOBAL_KEY} = {serialized};\n",
        encoding="utf-8",
    )
    return json_path, js_path


def load_thumbnail_cache_index(data_dir: str | Path | None = None) -> dict[str, Any]:
    resolved_data_dir = ensure_data_dir(data_dir)
    json_path = resolved_data_dir / "thumbnail_cache_index.json"
    if not json_path.exists():
        return {"generated_at": "", "items": {}}

    raw = json.loads(json_path.read_text(encoding="utf-8-sig"))
    items = raw.get("items", {})
    if not isinstance(items, dict):
        items = {}
    return {
        "generated_at": str(raw.get("generated_at", "")),
        "items": {str(key): str(value) for key, value in items.items()},
    }




def save_sync_plan(
    sync_plan: dict[str, Any],
    path: str | Path | None = None,
) -> Path:
    data_dir = ensure_data_dir()
    plan_path = Path(path or data_dir / "tag_sync_plan.json")
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(sync_plan, ensure_ascii=False, indent=2)
    plan_path.write_text(serialized, encoding="utf-8")
    return plan_path
