"""X / Twitter adapter, SCAFFOLD.

Zeeschuimer can capture X timelines, but the payload shape is different again and
X actively fights scraping, so this adapter ships as a documented scaffold rather
than a tested path. The field map below is where to wire a real X capture: fill
in ``parse_record`` against a real NDJSON line and remove the raise.

Rough field map (X ``TweetResult`` / legacy object):
    text            -> record["data"]["legacy"]["full_text"]
    likes           -> ...["legacy"]["favorite_count"]
    replies         -> ...["legacy"]["reply_count"]
    retweets/quotes -> ...["legacy"]["retweet_count"], ["quote_count"]
    author handle   -> ...["core"]["user_results"]["result"]["legacy"]["screen_name"]
    timestamp       -> parse ...["legacy"]["created_at"] (e.g. "Wed Jun 04 12:00:00 +0000 2025")
    media           -> ...["legacy"]["extended_entities"]["media"][*]["media_url_https"]
"""

from __future__ import annotations

from typing import Optional

from .base import Adapter, PostRecord


class TwitterAdapter(Adapter):
    platform = "twitter"

    def parse_record(self, record: dict) -> Optional[PostRecord]:  # pragma: no cover
        raise NotImplementedError(
            "The X/Twitter adapter is a scaffold. Wire parse_record() to the "
            "own Zeeschuimer X capture using the field map in twitter.py, then "
            "remove this raise. See docs/ROADMAP.md."
        )
