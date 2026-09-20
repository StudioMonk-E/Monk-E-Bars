"""
Normalised post record and the adapter contract.

Every platform is different at the raw level (Instagram nests the post under
``data``, TikTok uses ``desc`` and a ``stats`` object, and so on). Adapters
exist to hide those differences: each one reads a platform's Zeeschuimer NDJSON
and yields the same :class:`PostRecord`, so every module downstream of ingestion
can be written once and reused across case studies and platforms.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator, Optional


@dataclass
class PostRecord:
    """One social-media post, normalised across platforms.

    Only the fields the analysis actually needs are kept. The original raw
    record is preserved under :attr:`raw` so nothing is lost and adapters can be
    debugged against real data.
    """

    platform: str                         # "instagram", "tiktok", ...
    post_id: str                          # unique per post, used for dedup
    url: str = ""                         # canonical link back to the post
    author_handle: str = ""               # @username / uniqueId
    author_name: str = ""                 # display name
    author_verified: bool = False
    caption_text: str = ""                # caption (IG) / description (TikTok)
    like_count: int = 0
    comment_count: int = 0
    share_count: int = 0                  # 0 when the platform doesn't expose it
    view_count: int = 0                   # 0 when not a video / not exposed
    # Followers of the posting account, where the platform exposes them. TikTok
    # carries this on every item; an Instagram hashtag scrape carries none, so 0
    # means "unknown here" and any rate computed from it has to be suppressed.
    follower_count: int = 0
    timestamp: Optional[datetime] = None  # when the post was published (UTC)
    media_type: str = "unknown"           # "photo" | "video" | "carousel"
    is_paid_partnership: bool = False
    hashtags: list[str] = field(default_factory=list)   # lowercased, with leading '#'
    mentions: list[str] = field(default_factory=list)   # lowercased, with leading '@'
    media_urls: list[str] = field(default_factory=list) # image/thumbnail URLs (colour analysis)
    raw: dict = field(default_factory=dict, repr=False)

    @property
    def engagement_score(self) -> int:
        """Likes + comments. A deliberately simple, cross-platform baseline.

        Views and shares are intentionally excluded so Instagram (no public view
        count on photos) and TikTok are ranked on the same footing. Override in
        analysis if a platform-specific score is wanted.
        """
        return int(self.like_count or 0) + int(self.comment_count or 0)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("raw", None)
        d["engagement_score"] = self.engagement_score
        if self.timestamp is not None:
            d["timestamp"] = self.timestamp.isoformat()
        d["hashtags"] = ", ".join(self.hashtags)
        d["mentions"] = ", ".join(self.mentions)
        d["media_urls"] = " ".join(self.media_urls)
        return d


class Adapter:
    """Base class for platform adapters.

    Subclasses set :attr:`platform` and implement :meth:`parse_record`, which
    turns one already-parsed NDJSON object into a :class:`PostRecord` (or
    ``None`` to skip it).
    """

    platform: str = "base"

    def parse_record(self, record: dict) -> Optional[PostRecord]:
        raise NotImplementedError

    # --- shared helpers -------------------------------------------------

    def iter_ndjson(self, path: str) -> Iterator[dict]:
        """Yield one parsed dict per non-blank line of an NDJSON file."""
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    # A truncated final line can happen if a scrape was interrupted.
                    continue

    def load(self, paths: Iterable[str]) -> list[PostRecord]:
        """Parse one or many NDJSON files into a list of PostRecords."""
        if isinstance(paths, str):
            paths = [paths]
        out: list[PostRecord] = []
        for p in paths:
            for rec in self.iter_ndjson(p):
                post = self.parse_record(rec)
                if post is not None:
                    out.append(post)
        return out

    @staticmethod
    def _ts_from_unix(value: Any) -> Optional[datetime]:
        try:
            return datetime.fromtimestamp(int(value), tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            return None
