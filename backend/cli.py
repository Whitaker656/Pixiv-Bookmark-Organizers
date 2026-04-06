from __future__ import annotations

import argparse
import json
import sys
import time

from .bookmark_service import BookmarkService
from .config import ensure_config_exists, load_config
from .pixiv_client import PixivClient
from .ui_server import run_ui_server


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Pixiv Bookmark Organizer backend CLI")
    parser.add_argument("--config", default="pixiv_config.json", help="Path to config JSON")

    subparsers = parser.add_subparsers(dest="command", required=True)

    fetch_parser = subparsers.add_parser("fetch-bookmarks", help="Fetch bookmarks from Pixiv")
    fetch_parser.add_argument("--limit", type=int, default=48)
    fetch_parser.add_argument("--offset", type=int, default=0)
    fetch_parser.add_argument("--rest", choices=["show", "hide"], default="show")

    fetch_all_parser = subparsers.add_parser("fetch-all-bookmarks", help="Fetch all public/private bookmarks")
    fetch_all_parser.add_argument("--page-size", type=int, default=48)
    fetch_all_parser.add_argument("--cache-thumbnails-limit", type=int, default=5)

    cache_parser = subparsers.add_parser("cache-thumbnails", help="Download a small batch of missing thumbnails")
    cache_parser.add_argument("--snapshot", default="data/bookmarks_ui_snapshot.json")
    cache_parser.add_argument("--limit", type=int, default=20)
    cache_parser.add_argument(
        "--priority-artwork-ids",
        default="",
        help="Comma-separated artwork ids to prioritize first",
    )
    cache_parser.add_argument("--repeat", action="store_true", help="Repeat small-batch thumbnail caching")
    cache_parser.add_argument("--sleep-seconds", type=float, default=5.0, help="Delay between repeat rounds")
    cache_parser.add_argument("--max-rounds", type=int, default=0, help="Stop after this many rounds, 0 means until no more downloads")

    preview_parser = subparsers.add_parser("preview-sync", help="Preview bookmark tag sync actions")
    preview_parser.add_argument("--snapshot", default="data/bookmarks_snapshot.json")
    preview_parser.add_argument("--mapping", default="data/tag_mappings.json")

    apply_parser = subparsers.add_parser("apply-sync", help="Apply bookmark tag sync actions to Pixiv")
    apply_parser.add_argument("--snapshot", default="data/bookmarks_snapshot.json")
    apply_parser.add_argument("--mapping", default="data/tag_mappings.json")
    apply_parser.add_argument("--limit", type=int)
    apply_parser.add_argument("--dry-run", action="store_true")

    serve_parser = subparsers.add_parser("serve-ui", help="Serve UI and local control API")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8000)

    subparsers.add_parser("show-config", help="Print config path and auth mode")
    subparsers.add_parser("validate-session", help="Validate cookie session against Pixiv")
    return parser


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = build_parser()
    args = parser.parse_args()

    ensure_config_exists(args.config)
    config = load_config(args.config)
    client = PixivClient(config)
    service = BookmarkService(client)

    if args.command == "serve-ui":
        run_ui_server(service=service, host=args.host, port=args.port, directory=".")
        return 0

    if args.command == "show-config":
        print(json.dumps({"config": args.config, "auth_mode": config.auth_mode}, ensure_ascii=False, indent=2))
        return 0

    if args.command == "validate-session":
        profile = client.validate_session()
        print(json.dumps(profile, ensure_ascii=False, indent=2))
        return 0

    if args.command == "fetch-bookmarks":
        snapshot = client.fetch_bookmarks(rest=args.rest, limit=args.limit, offset=args.offset)
        from .storage import save_snapshot

        output = save_snapshot(snapshot)
        print(f"Saved bookmark snapshot to {output}")
        return 0

    if args.command == "fetch-all-bookmarks":
        results = service.fetch_all_save_and_cache(
            page_size=args.page_size,
            thumbnail_limit=args.cache_thumbnails_limit,
        )
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    if args.command == "cache-thumbnails":
        priority_artwork_ids = [
            artwork_id.strip()
            for artwork_id in str(args.priority_artwork_ids or "").split(",")
            if artwork_id.strip()
        ]
        if not args.repeat:
            results = service.cache_thumbnails(
                snapshot_path=args.snapshot,
                limit=args.limit,
                priority_artwork_ids=priority_artwork_ids,
            )
            print(json.dumps(results, ensure_ascii=False, indent=2))
            return 0

        rounds: list[dict] = []
        current_round = 0
        while True:
            current_round += 1
            result = service.cache_thumbnails(
                snapshot_path=args.snapshot,
                limit=args.limit,
                priority_artwork_ids=priority_artwork_ids,
            )
            result["round"] = current_round
            rounds.append(result)

            should_stop_for_limit = args.max_rounds > 0 and current_round >= args.max_rounds
            should_stop_for_idle = result.get("downloaded", 0) == 0
            if should_stop_for_limit or should_stop_for_idle:
                break

            time.sleep(max(args.sleep_seconds, 0.0))

        print(json.dumps({"repeat": True, "rounds": rounds}, ensure_ascii=False, indent=2))
        return 0

    if args.command == "preview-sync":
        actions = service.preview_sync_actions(args.snapshot, args.mapping)
        print(json.dumps(actions, ensure_ascii=False, indent=2))
        return 0

    if args.command == "apply-sync":
        results = service.apply_sync_actions(
            snapshot_path=args.snapshot,
            mapping_path=args.mapping,
            limit=args.limit,
            dry_run=args.dry_run,
        )
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    parser.error("Unknown command")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
