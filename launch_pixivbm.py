from __future__ import annotations

import json
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib import error, request


HOST = "127.0.0.1"
DEFAULT_PORT = 8000
MAX_PORT = 8010
STARTUP_TIMEOUT_SECONDS = 15.0


def is_pixivbm_running(host: str, port: int) -> bool:
    try:
        with request.urlopen(f"http://{host}:{port}/api/status", timeout=1.5) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return False
    return payload.get("server") == "ok"


def is_port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def choose_port(host: str) -> int:
    for port in range(DEFAULT_PORT, MAX_PORT + 1):
        if is_port_free(host, port):
            return port
    raise RuntimeError(f"Could not find a free port in {DEFAULT_PORT}-{MAX_PORT}.")


def ensure_runtime_config(project_root: Path) -> Path:
    config_path = project_root / "pixiv_config.json"
    example_path = project_root / "pixiv_config.example.json"

    if config_path.exists():
        return config_path

    if not example_path.exists():
        raise FileNotFoundError("pixiv_config.example.json was not found.")

    shutil.copyfile(example_path, config_path)
    print("Created pixiv_config.json from pixiv_config.example.json. Fill in your Pixiv login settings if needed.")
    return config_path


def start_server(project_root: Path, host: str, port: int) -> subprocess.Popen[bytes]:
    creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
    command = [
        sys.executable,
        "-m",
        "backend.cli",
        "--config",
        "pixiv_config.json",
        "serve-ui",
        "--host",
        host,
        "--port",
        str(port),
    ]
    return subprocess.Popen(
        command,
        cwd=str(project_root),
        creationflags=creationflags,
    )


def wait_until_ready(host: str, port: int, timeout_seconds: float) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if is_pixivbm_running(host, port):
            return True
        time.sleep(0.5)
    return False


def main() -> int:
    project_root = Path(__file__).resolve().parent
    ensure_runtime_config(project_root)
    port = choose_port(HOST)
    index_url = f"http://{HOST}:{port}/index.html"

    process = start_server(project_root, HOST, port)
    if not wait_until_ready(HOST, port, STARTUP_TIMEOUT_SECONDS):
        process.poll()
        print("PixivBM server failed to start. Check the server console or pixiv_config.json.")
        return 1

    webbrowser.open(index_url)
    print(index_url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
