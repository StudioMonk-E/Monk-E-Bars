"""Reddit adapter, SCAFFOLD.

Reddit is the friendliest of the 'harder' platforms because its public JSON API
(append ``.json`` to any listing URL, or use PRAW) returns clean, documented
objects, which can make Zeeschuimer unnecessary. This scaffold accepts Reddit's
native listing JSON shape.

Rough field map (Reddit ``t3`` link object, ``child["data"]``):
    text     -> title + " " + selftext
    likes    -> score  (ups - downs)
    comments -> num_comments
    author   -> author
    time     -> created_utc  (unix)
    url      -> "https://reddit.com" + permalink
    media    -> preview.images[*].source.url  /  thumbnail
"""

from __future__ import annotations

from typing import Optional

from .base import Adapter, PostRecord


class RedditAdapter(Adapter):
    platform = "reddit"

    def parse_record(self, record: dict) -> Optional[PostRecord]:  # pragma: no cover
        raise NotImplementedError(
            "The Reddit adapter is a scaffold. Reddit exposes clean JSON "
            "(listing.json / PRAW), so wire parse_record() to that shape using "
            "the field map in reddit.py, then remove this raise. See docs/ROADMAP.md."
        )
