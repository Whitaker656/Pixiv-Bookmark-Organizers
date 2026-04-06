from __future__ import annotations

import json
from pathlib import Path

from .models import PixivConfig


DEFAULT_CONFIG_PATH = Path("pixiv_config.json")


def load_config(path: str | Path | None = None) -> PixivConfig:
    config_path = Path(path or DEFAULT_CONFIG_PATH)
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    return PixivConfig(**raw)


def ensure_config_exists(path: str | Path | None = None) -> Path:
    config_path = Path(path or DEFAULT_CONFIG_PATH)
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found: {config_path}. Copy pixiv_config.example.json first."
        )
    return config_path
