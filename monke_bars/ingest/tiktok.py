"""TikTok adapter for Zeeschuimer NDJSON.

TikTok's item structure differs from Instagram's: the caption is ``desc``, stats
live under ``stats`` (``diggCount`` = likes), the author is an ``author`` object,
and the thumbnail is the video ``cover`` image. Zeeschuimer stores the item under
``record["data"]`` just like Instagram.

Field paths are defensively resolved because TikTok's web payloads vary between
the ``itemStruct`` shape and older/newer variants. Where a field is missing the
adapter degrades gracefully and keeps the post. Verify the mapping
against a real TikTok scrape and adjust ``_FIELD NOTES`` where it differs.
"""

from __future__ import annotations

import re
from typing import Optional

from .base import Adapter, PostRecord

_HASHTAG_RE = re.compile(r"#\w+")
# Handles may contain dots but never begin or end with one. Instagram's old
# pattern stopped at the first dot, turning @newborn.fit.mama into @newborn;
# TikTok's took the dots and a sentence's full stop with them, so "thanks
# @anna." gave "@anna.". Across two Instagram captures the first alone cut 56
# credited handles short, which in an outreach list means naming the wrong
# account or none at all.
_MENTION_RE = re.compile(r"@\w(?:[\w.]*\w)?")


def _first(d: dict, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d.get(k)
    return default


class TikTokAdapter(Adapter):
    platform = "tiktok"

    def parse_record(self, record: dict) -> Optional[PostRecord]:
        data = record.get("data") or record
        if not isinstance(data, dict):
            return None

        post_id = _first(data, "id", "aweme_id", default=record.get("item_id"))
        if not post_id:
            return None

        desc = _first(data, "desc", "description", "text", default="") or ""

        author = data.get("author") or {}
        if isinstance(author, str):  # some payloads store handle as a bare string
            handle, name, verified = author, "", False
        else:
            handle = _first(author, "uniqueId", "unique_id", "nickname", default="") or ""
            name = _first(author, "nickname", "signature", default="") or ""
            verified = bool(author.get("verified", False))

        stats = data.get("stats") or data.get("statsV2") or {}
        # TikTok ships the author's follower count on every item, which Instagram
        # does not. It is what makes a true engagement rate possible here.
        author_stats = data.get("authorStats") or data.get("authorStatsV2") or {}
        hashtags = self._hashtags(data, desc)

        return PostRecord(
            platform=self.platform,
            post_id=str(post_id),
            url=f"https://www.tiktok.com/@{handle}/video/{post_id}" if handle else "",
            author_handle=handle,
            author_name=name,
            author_verified=verified,
            caption_text=desc,
            like_count=int(_first(stats, "diggCount", "likeCount", default=0) or 0),
            comment_count=int(_first(stats, "commentCount", default=0) or 0),
            share_count=int(_first(stats, "shareCount", default=0) or 0),
            view_count=int(_first(stats, "playCount", "viewCount", default=0) or 0),
            follower_count=int(_first(author_stats, "followerCount", "follower_count",
                                      default=0) or 0),
            timestamp=self._ts_from_unix(_first(data, "createTime", "create_time")),
            media_type="video",  # TikTok posts are videos
            is_paid_partnership=bool(
                data.get("isAd", False) or data.get("adAuthorization", False)
            ),
            hashtags=hashtags,
            mentions=[m.lower() for m in _MENTION_RE.findall(desc)],
            media_urls=self._media_urls(data),
            raw=record,
        )

    @staticmethod
    def _hashtags(data: dict, desc: str) -> list[str]:
        tags: list[str] = []
        # Structured hashtags (challenges / textExtra) are cleaner than regex.
        for ch in data.get("challenges") or []:
            title = ch.get("title") if isinstance(ch, dict) else None
            if title:
                tags.append("#" + str(title).lower())
        for te in data.get("textExtra") or []:
            name = te.get("hashtagName") if isinstance(te, dict) else None
            if name:
                tags.append("#" + str(name).lower())
        if not tags:  # fall back to parsing the caption
            tags = [h.lower() for h in _HASHTAG_RE.findall(desc)]
        # dedup, preserve order
        seen, out = set(), []
        for t in tags:
            if t not in seen:
                seen.add(t)
                out.append(t)
        return out

    @staticmethod
    def _media_urls(data: dict) -> list[str]:
        video = data.get("video") or {}
        for key in ("cover", "originCover", "dynamicCover", "reflowCover"):
            u = video.get(key) if isinstance(video, dict) else None
            if u:
                return [u]
        return []
