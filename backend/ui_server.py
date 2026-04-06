from __future__ import annotations

import json
import threading
import time
from datetime import UTC, datetime
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .bookmark_service import BookmarkService
from .storage import save_sync_plan

SYNC_PLAN_PATH = "data/tag_sync_plan.json"
SYNC_SNAPSHOT_PATH = "data/bookmarks_snapshot.json"
SYNC_APPLY_LOG_PATH = "data/sync_apply_log.json"


def build_auth_config_summary(service: BookmarkService) -> dict[str, str]:
    config = service.client.config
    auth_source = "none"
    auth_value = ""

    if str(config.cookie_file or "").strip():
        auth_source = "cookie_file"
        auth_value = str(config.cookie_file).strip()
    elif str(config.raw_cookie or "").strip():
        auth_source = "raw_cookie"
        auth_value = "configured"
    elif str(config.php_sessid or "").strip():
        auth_source = "php_sessid"
        auth_value = "configured"

    return {
        "auth_mode": str(config.auth_mode or ""),
        "auth_source": auth_source,
        "auth_value": auth_value,
        "configured_user_id": str(config.user_id or ""),
    }


def build_session_status_payload(service: BookmarkService) -> dict[str, Any]:
    summary = build_auth_config_summary(service)

    try:
        profile = service.client.validate_session()
    except Exception as exc:
        return {
            "ok": False,
            "authenticated": False,
            "profile": None,
            "error": str(exc),
            **summary,
        }

    return {
        "ok": True,
        "authenticated": True,
        "profile": {
            "user_id": str(profile.get("user_id", "")),
            "name": str(profile.get("name", "")),
            "is_followed": bool(profile.get("is_followed", False)),
        },
        "error": "",
        **summary,
    }


class ThumbnailCacheWorker:
    def __init__(
        self,
        service: BookmarkService,
        snapshot_path: str | Path = "data/bookmarks_ui_snapshot.json",
        data_dir: str | Path = "data",
    ) -> None:
        self.service = service
        self.snapshot_path = str(snapshot_path)
        self.data_dir = str(data_dir)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._status: dict[str, Any] = {
            "running": False,
            "mode": "idle",
            "limit": 0,
            "sleep_seconds": 0.0,
            "priority_artwork_ids": [],
            "started_at": "",
            "finished_at": "",
            "last_result": None,
            "last_error": "",
            "rounds_completed": 0,
        }

    def start(
        self,
        *,
        limit: int,
        repeat: bool,
        sleep_seconds: float,
        priority_artwork_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status()

            requested_priority_ids = [
                str(artwork_id).strip()
                for artwork_id in (priority_artwork_ids or [])
                if str(artwork_id).strip()
            ]
            self._stop_event = threading.Event()
            self._status = {
                "running": True,
                "mode": "repeat" if repeat else "once",
                "limit": max(int(limit), 1),
                "sleep_seconds": max(float(sleep_seconds), 0.0),
                "priority_artwork_ids": requested_priority_ids,
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "finished_at": "",
                "last_result": None,
                "last_error": "",
                "rounds_completed": 0,
            }
            self._thread = threading.Thread(
                target=self._run,
                kwargs={
                    "repeat": repeat,
                    "limit": max(int(limit), 1),
                    "sleep_seconds": max(float(sleep_seconds), 0.0),
                    "priority_artwork_ids": requested_priority_ids,
                },
                daemon=True,
                name="thumbnail-cache-worker",
            )
            self._thread.start()
            return dict(self._status)

    def stop(self) -> dict[str, Any]:
        self._stop_event.set()
        with self._lock:
            return dict(self._status)

    def status(self) -> dict[str, Any]:
        with self._lock:
            status = dict(self._status)
            if self._thread and not self._thread.is_alive() and status.get("running"):
                status["running"] = False
                self._status["running"] = False
            return status

    def _run(
        self,
        *,
        repeat: bool,
        limit: int,
        sleep_seconds: float,
        priority_artwork_ids: list[str],
    ) -> None:
        session = None
        if hasattr(self.service, "_prepare_thumbnail_cache_session") and hasattr(self.service, "_cache_thumbnails_from_session"):
            session = self.service._prepare_thumbnail_cache_session(  # type: ignore[attr-defined]
                snapshot_path=self.snapshot_path,
                data_dir=self.data_dir,
                priority_artwork_ids=priority_artwork_ids,
            )

        try:
            while not self._stop_event.is_set():
                if session is not None:
                    result = self.service._cache_thumbnails_from_session(session, limit=limit)  # type: ignore[attr-defined]
                else:
                    result = self.service.cache_thumbnails(
                        snapshot_path=self.snapshot_path,
                        limit=limit,
                        data_dir=self.data_dir,
                        priority_artwork_ids=priority_artwork_ids,
                    )
                with self._lock:
                    self._status["last_result"] = result
                    self._status["rounds_completed"] = int(self._status.get("rounds_completed", 0)) + 1

                if not repeat or result.get("downloaded", 0) == 0 or result.get("exhausted", False):
                    break

                if self._stop_event.wait(sleep_seconds):
                    break
        except Exception as exc:
            with self._lock:
                self._status["last_error"] = str(exc)
        finally:
            with self._lock:
                self._status["running"] = False
                self._status["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")


class SyncApplyWorker:
    def __init__(
        self,
        service: BookmarkService,
        snapshot_path: str | Path = SYNC_SNAPSHOT_PATH,
        plan_path: str | Path = SYNC_PLAN_PATH,
        log_path: str | Path = SYNC_APPLY_LOG_PATH,
    ) -> None:
        self.service = service
        self.snapshot_path = str(snapshot_path)
        self.plan_path = str(plan_path)
        self.log_path = str(log_path)
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._status: dict[str, Any] = self._build_idle_status()

    def _build_idle_status(self) -> dict[str, Any]:
        return {
            "running": False,
            "batch_size": 10,
            "interval_seconds": 2.0,
            "selected_artwork_ids": [],
            "started_at": "",
            "finished_at": "",
            "total_actions": 0,
            "completed_actions": 0,
            "updated_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
            "current_action": None,
            "results": [],
            "last_error": "",
            "log_path": self.log_path.replace("\\", "/"),
        }

    def start(
        self,
        *,
        plan: dict[str, Any],
        batch_size: int,
        interval_seconds: float,
        selected_artwork_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return self.status()

            normalized_artwork_ids = [
                str(artwork_id).strip()
                for artwork_id in (selected_artwork_ids or [])
                if str(artwork_id).strip()
            ]
            plan_path = save_sync_plan(plan, path=self.plan_path)
            actions = self.service.preview_sync_actions(self.snapshot_path, plan_path)
            actions = self.service.filter_sync_actions(
                actions,
                artwork_ids=normalized_artwork_ids or None,
            )
            self._stop_event = threading.Event()
            self._status = {
                "running": True,
                "batch_size": max(int(batch_size), 1),
                "interval_seconds": max(float(interval_seconds), 0.0),
                "selected_artwork_ids": normalized_artwork_ids,
                "started_at": datetime.now(UTC).isoformat(),
                "finished_at": "",
                "total_actions": len(actions),
                "completed_actions": 0,
                "updated_count": 0,
                "skipped_count": 0,
                "failed_count": 0,
                "current_action": None,
                "results": [],
                "last_error": "",
                "log_path": self.log_path.replace("\\", "/"),
            }
            self._thread = threading.Thread(
                target=self._run,
                kwargs={
                    "actions": actions,
                    "interval_seconds": max(float(interval_seconds), 0.0),
                },
                daemon=True,
                name="sync-apply-worker",
            )
            self._thread.start()
            return dict(self._status)

    def stop(self) -> dict[str, Any]:
        self._stop_event.set()
        with self._lock:
            return dict(self._status)

    def status(self) -> dict[str, Any]:
        with self._lock:
            status = dict(self._status)
            if self._thread and not self._thread.is_alive() and status.get("running"):
                status["running"] = False
                self._status["running"] = False
            return status

    def _run(self, *, actions: list[dict[str, Any]], interval_seconds: float) -> None:
        try:
            for index, action in enumerate(actions, start=1):
                if self._stop_event.is_set():
                    break

                with self._lock:
                    self._status["current_action"] = {
                        "index": index,
                        "artwork_id": action.get("artwork_id", ""),
                        "title": action.get("title", ""),
                    }

                try:
                    result = self.service.execute_sync_action(action, dry_run=False)
                except Exception as exc:
                    result = {
                        "artwork_id": action.get("artwork_id", ""),
                        "bookmark_id": action.get("bookmark_id", ""),
                        "title": action.get("title", ""),
                        "dry_run": False,
                        "tags_to_apply": action.get("merged_tags", []),
                        "status": "failed",
                        "reason": str(exc),
                    }

                with self._lock:
                    self._status["results"].append(result)
                    self._status["completed_actions"] = int(self._status.get("completed_actions", 0)) + 1
                    if result.get("status") == "updated":
                        self._status["updated_count"] = int(self._status.get("updated_count", 0)) + 1
                    elif result.get("status") == "skipped":
                        self._status["skipped_count"] = int(self._status.get("skipped_count", 0)) + 1
                    else:
                        self._status["failed_count"] = int(self._status.get("failed_count", 0)) + 1
                        if result.get("reason"):
                            self._status["last_error"] = str(result.get("reason"))
                    self._write_log()

                if index < len(actions) and self._stop_event.wait(interval_seconds):
                    break
        finally:
            with self._lock:
                self._status["running"] = False
                self._status["current_action"] = None
                self._status["finished_at"] = datetime.now(UTC).isoformat()
                self._write_log()

    def _write_log(self) -> None:
        log_path = Path(self.log_path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "saved_at": datetime.now(UTC).isoformat(),
            **self._status,
        }
        log_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


class PixivUiRequestHandler(SimpleHTTPRequestHandler):
    server_version = "PixivBMHTTP/0.1"

    def __init__(self, *args: Any, directory: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, directory=directory, **kwargs)

    @property
    def worker(self) -> ThumbnailCacheWorker:
        return self.server.thumbnail_worker  # type: ignore[attr-defined]

    @property
    def sync_worker(self) -> SyncApplyWorker:
        return self.server.sync_apply_worker  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/status":
            self._send_json(
                {
                    "server": "ok",
                    "thumbnail_worker": self.worker.status(),
                    "sync_apply_worker": self.sync_worker.status(),
                    "sync_plan_path": SYNC_PLAN_PATH,
                }
            )
            return

        if parsed.path == "/api/session/status":
            self._send_json({"session": build_session_status_payload(self.server.service)})  # type: ignore[attr-defined]
            return

        if parsed.path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/thumbnail-cache/start":
            payload = self._read_json_body()
            repeat = bool(payload.get("repeat", False))
            status = self.worker.start(
                limit=max(int(payload.get("batch_size", payload.get("limit", 10)) or 10), 1),
                repeat=repeat,
                sleep_seconds=max(float(payload.get("sleep_seconds", 5.0) or 0.0), 0.0),
                priority_artwork_ids=payload.get("priority_artwork_ids") or [],
            )
            self._send_json({"ok": True, "thumbnail_worker": status}, status=HTTPStatus.ACCEPTED)
            return

        if parsed.path == "/api/thumbnail-cache/stop":
            status = self.worker.stop()
            self._send_json({"ok": True, "thumbnail_worker": status})
            return

        if parsed.path == "/api/sync-plan/save":
            payload = self._read_json_body()
            plan = payload.get("plan") or {}
            plan_path = save_sync_plan(plan, path=SYNC_PLAN_PATH)
            self._send_json(
                {
                    "ok": True,
                    "path": str(plan_path).replace("\\", "/"),
                    "counts": self._build_sync_plan_counts(plan),
                }
            )
            return

        if parsed.path == "/api/sync/preview":
            payload = self._read_json_body()
            plan = payload.get("plan") or {}
            limit = max(int(payload.get("limit", 20) or 20), 1)
            selected_artwork_ids = [
                str(artwork_id).strip()
                for artwork_id in (payload.get("selected_artwork_ids") or [])
                if str(artwork_id).strip()
            ]
            plan_path = save_sync_plan(plan, path=SYNC_PLAN_PATH)
            actions = self.server.service.preview_sync_actions(SYNC_SNAPSHOT_PATH, plan_path)  # type: ignore[attr-defined]
            actions = self.server.service.filter_sync_actions(  # type: ignore[attr-defined]
                actions,
                artwork_ids=selected_artwork_ids or None,
                limit=limit,
            )
            self._send_json(
                {
                    "ok": True,
                    "path": str(plan_path).replace("\\", "/"),
                    "counts": self._build_sync_plan_counts(plan),
                    "selected_artwork_ids": selected_artwork_ids,
                    "total_actions": len(actions),
                    "actions": actions,
                }
            )
            return

        if parsed.path == "/api/bookmarks/remove":
            payload = self._read_json_body()
            bookmark_ids = [str(bookmark_id).strip() for bookmark_id in (payload.get("bookmark_ids") or []) if str(bookmark_id).strip()]
            bookmark_id = str(payload.get("bookmark_id") or "").strip()
            if bookmark_id:
                bookmark_ids.append(bookmark_id)
            result = self.server.service.remove_bookmarks(bookmark_ids)  # type: ignore[attr-defined]
            self._send_json(
                {
                    "ok": True,
                    "bookmark_id": bookmark_id,
                    "bookmark_ids": bookmark_ids,
                    "removed_bookmark_ids": result.get("removed_bookmark_ids", bookmark_ids),
                    "result": result,
                }
            )
            return

        if parsed.path == "/api/bookmarks/refresh":
            payload = self._read_json_body()
            page_size = max(int(payload.get("page_size", 48) or 48), 1)
            cache_thumbnails_limit = max(int(payload.get("cache_thumbnails_limit", 0) or 0), 0)
            results = self.server.service.fetch_all_save_and_cache(  # type: ignore[attr-defined]
                page_size=page_size,
                thumbnail_limit=cache_thumbnails_limit,
                snapshot_path="data/bookmarks_snapshot.json",
                thumbnail_snapshot_path="data/bookmarks_ui_snapshot.json",
                data_dir="data",
            )
            snapshot = self.server.service.load_snapshot("data/bookmarks_ui_snapshot.json")  # type: ignore[attr-defined]
            self._send_json(
                {
                    "ok": True,
                    "page_size": page_size,
                    "cache_thumbnails_limit": cache_thumbnails_limit,
                    "snapshot_count": len(snapshot.items),
                    "fetched_at": snapshot.fetched_at,
                    "results": results,
                }
            )
            return

        if parsed.path == "/api/sync/apply/start":
            payload = self._read_json_body()
            plan = payload.get("plan") or {}
            status = self.sync_worker.start(
                plan=plan,
                batch_size=max(int(payload.get("batch_size", payload.get("limit", 10)) or 10), 1),
                interval_seconds=max(float(payload.get("interval_seconds", 2.0) or 0.0), 0.0),
                selected_artwork_ids=payload.get("selected_artwork_ids") or [],
            )
            self._send_json(
                {
                    "ok": True,
                    "sync_apply_worker": status,
                },
                status=HTTPStatus.ACCEPTED,
            )
            return

        if parsed.path == "/api/sync/apply/stop":
            status = self.sync_worker.stop()
            self._send_json({"ok": True, "sync_apply_worker": status})
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not Found")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _build_sync_plan_counts(self, plan: dict[str, Any]) -> dict[str, int]:
        return {
            "mappings": len(plan.get("mappings", [])) if isinstance(plan.get("mappings", []), list) else 0,
            "replace_rules": len(plan.get("replace_rules", [])) if isinstance(plan.get("replace_rules", []), list) else 0,
            "manual_overrides": len(plan.get("manual_overrides", [])) if isinstance(plan.get("manual_overrides", []), list) else 0,
        }

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        if content_length <= 0:
            return {}
        raw = self.rfile.read(content_length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class PixivUiServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[PixivUiRequestHandler],
        thumbnail_worker: ThumbnailCacheWorker,
        sync_apply_worker: SyncApplyWorker,
        service: BookmarkService,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.thumbnail_worker = thumbnail_worker
        self.sync_apply_worker = sync_apply_worker
        self.service = service


def run_ui_server(
    *,
    service: BookmarkService,
    host: str = "127.0.0.1",
    port: int = 8000,
    directory: str | Path = ".",
    snapshot_path: str | Path = "data/bookmarks_ui_snapshot.json",
    data_dir: str | Path = "data",
) -> None:
    thumbnail_worker = ThumbnailCacheWorker(service, snapshot_path=snapshot_path, data_dir=data_dir)
    sync_apply_worker = SyncApplyWorker(service)
    handler = partial(PixivUiRequestHandler, directory=str(Path(directory).resolve()))
    httpd = PixivUiServer((host, port), handler, thumbnail_worker, sync_apply_worker, service)
    print(f"PixivBM UI server running at http://{host}:{port}/index.html")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        thumbnail_worker.stop()
        sync_apply_worker.stop()
        httpd.server_close()
