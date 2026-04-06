from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Artwork:
    id: str
    title: str
    author: str
    author_id: str
    thumbnail_url: str
    bookmark_id: str = ""
    pixiv_tags: list[str] = field(default_factory=list)
    bookmark_tags: list[str] = field(default_factory=list)
    visibility: str = "public"
    is_deleted: bool = False
    like_count: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class PixivConfig:
    base_url: str
    bookmarks_endpoint: str
    bookmark_detail_endpoint: str
    bookmark_update_endpoint: str
    auth_mode: str
    raw_cookie: str = ""
    cookie_file: str = ""
    refresh_token: str = ""
    php_sessid: str = ""
    user_id: str = ""
    user_agent: str = "Mozilla/5.0"
    language: str = "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
    request_timeout_seconds: int = 20


@dataclass
class BookmarkSnapshot:
    fetched_at: str
    items: list[Artwork] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "fetched_at": self.fetched_at,
            "items": [item.to_dict() for item in self.items],
        }
