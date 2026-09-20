"""Instagram adapter for Zeeschuimer NDJSON.

Zeeschuimer wraps each captured item in an envelope; the real post lives under
``record["data"]``. Media-type integers follow Instagram's own convention
(1 = photo, 2 = video/reel, 8 = carousel). Image URLs for colour analysis come
from ``image_versions2.candidates`` (and, for carousels, from each child item).
"""

from __future__ import annotations

import re
from typing import Optional

from .base import Adapter, PostRecord

_HASHTAG_RE = re.compile(r"#\w+")
_MENTION_RE = re.compile(r"@\w+")

_MEDIA_TYPE = {1: "photo", 2: "video", 8: "carousel"}


class InstagramAdapter(Adapter):
    platform = "instagram"

    def parse_record(self, record: dict) -> Optional[PostRecord]:
        data = record.get("data") or record  # tolerate already-unwrapped records
        if not isinstance(data, dict):
            return None

        post_id = data.get("id") or data.get("pk") or record.get("item_id")
        if not post_id:
            return None

        caption = data.get("caption") or {}
        caption_text = (caption.get("text") if isinstance(caption, dict) else "") or ""

        user = data.get("user") or {}
        code = data.get("code")

        return PostRecord(
            platform=self.platform,
            post_id=str(post_id),
            url=f"https://www.instagram.com/p/{code}/" if code else "",
            author_handle=user.get("username", "") or "",
            author_name=user.get("full_name", "") or "",
            author_verified=bool(user.get("is_verified", False)),
            caption_text=caption_text,
            like_count=int(data.get("like_count") or 0),
            comment_count=int(data.get("comment_count") or 0),
            share_count=0,  # Instagram does not expose shares in this feed
            view_count=int(data.get("play_count") or data.get("view_count") or 0),
            timestamp=self._ts_from_unix(data.get("taken_at")),
            media_type=_MEDIA_TYPE.get(data.get("media_type"), "unknown"),
            is_paid_partnership=bool(data.get("is_paid_partnership", False)),
            hashtags=[h.lower() for h in _HASHTAG_RE.findall(caption_text)],
            mentions=[m.lower() for m in _MENTION_RE.findall(caption_text)],
            media_urls=self._media_urls(data),
            raw=record,
        )

    # -- media -----------------------------------------------------------

    @staticmethod
    def _best_candidate(image_versions2: dict) -> Optional[str]:
        """Pick the largest available image candidate (first is usually biggest)."""
        if not isinstance(image_versions2, dict):
            return None
        cands = image_versions2.get("candidates") or []
        if not cands:
            return None
        best = max(
            cands,
            key=lambda c: (c.get("width", 0) or 0) * (c.get("height", 0) or 0),
        )
        return best.get("url")

    def _media_urls(self, data: dict) -> list[str]:
        urls: list[str] = []
        # Carousel: one image per child.
        for child in data.get("carousel_media") or []:
            u = self._best_candidate(child.get("image_versions2") or {})
            if u:
                urls.append(u)
        # Single photo / video thumbnail.
        if not urls:
            u = self._best_candidate(data.get("image_versions2") or {})
            if u:
                urls.append(u)
        return urls
