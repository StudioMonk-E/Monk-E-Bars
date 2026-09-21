"""Spreadsheet ingestion: CSV, TSV and Excel into the same PostRecord.

Not every corpus arrives from Zeeschuimer. Exports from other capture tools,
hand-coded sheets, and archives shared between researchers are usually a table
with one row per post, and there is no reason those cannot run through the same
analysis.

The only hard requirement is a caption column. Everything else is optional and
degrades honestly: with no like or comment column every post scores zero, which
collapses the engagement tiers, so the interface says so and the tiers stop
claiming to mean anything.

Column names are guessed from a list of common spellings and can be overridden,
because guessing is a convenience and never a substitute for the user saying what
their columns are.
"""

from __future__ import annotations

import os
import re
from typing import Iterable, Optional

from .base import Adapter, PostRecord

# Candidate spellings, in priority order. Matching is case- and space-insensitive.
CANDIDATES = {
    "caption_text": ["caption", "text", "description", "desc", "body", "content",
                     "message", "post", "title"],
    "like_count": ["likes", "like_count", "likecount", "favorites", "favourites",
                   "reactions", "hearts", "diggcount", "score"],
    "comment_count": ["comments", "comment_count", "commentcount", "replies",
                      "num_comments"],
    "share_count": ["shares", "share_count", "sharecount", "retweets", "reposts"],
    "view_count": ["views", "view_count", "viewcount", "plays", "playcount",
                   "impressions"],
    "author_handle": ["username", "handle", "author", "user", "account",
                      "screen_name", "creator"],
    "timestamp": ["timestamp", "date", "created", "created_at", "taken_at",
                  "datetime", "published", "time", "post_date"],
    "url": ["url", "link", "permalink", "post_url"],
    "post_id": ["id", "post_id", "item_id", "pk", "shortcode"],
    "media_urls": ["image", "image_url", "media", "media_url", "thumbnail",
                   "display_url", "picture"],
}

_HASHTAG = re.compile(r"#\w+", re.UNICODE)
_MENTION = re.compile(r"@\w+", re.UNICODE)


def _norm(name) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name).strip().lower())


def guess_mapping(columns: Iterable[str]) -> dict[str, Optional[str]]:
    """Best guess of ``{field: column}`` for a table's headers.

    Exact normalised matches win over substring matches, so a sheet with both
    ``likes`` and ``likes_per_view`` maps ``like_count`` to the former.
    """
    cols = list(columns)
    normed = {c: _norm(c) for c in cols}
    used: set[str] = set()
    mapping: dict[str, Optional[str]] = {}
    for field, names in CANDIDATES.items():
        found = None
        for want in names:                       # exact match pass
            w = _norm(want)
            for col, n in normed.items():
                if col not in used and n == w:
                    found = col
                    break
            if found:
                break
        if not found:                            # substring pass
            for want in names:
                w = _norm(want)
                for col, n in normed.items():
                    if col not in used and w in n:
                        found = col
                        break
                if found:
                    break
        if found:
            used.add(found)
        mapping[field] = found
    return mapping


def read_table(path: str):
    """Load a CSV, TSV or Excel file into a DataFrame."""
    import pandas as pd
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path)
    if ext == ".tsv":
        return pd.read_csv(path, sep="\t")
    return pd.read_csv(path)


def _to_int(v) -> int:
    if v is None:
        return 0
    try:
        import pandas as pd
        if pd.isna(v):
            return 0
    except Exception:
        pass
    # Tolerate "1,234" and "1.2K" style counts found in exported sheets.
    s = str(v).strip().replace(",", "")
    m = re.match(r"^([\d.]+)\s*([kKmM])$", s)
    if m:
        mult = 1_000 if m.group(2).lower() == "k" else 1_000_000
        try:
            return int(float(m.group(1)) * mult)
        except ValueError:
            return 0
    try:
        return int(float(s))
    except ValueError:
        return 0


def _to_dt(v):
    if v is None or v == "":
        return None
    try:
        import pandas as pd
        if pd.isna(v):
            return None
        ts = pd.to_datetime(v, utc=True, errors="coerce")
        if ts is None or pd.isna(ts):
            return None
        return ts.to_pydatetime()
    except Exception:
        return None


class TabularAdapter(Adapter):
    """Adapter for spreadsheet exports. Requires a caption column."""

    platform = "table"

    def __init__(self, mapping: Optional[dict] = None, platform_label: str = "table"):
        self.mapping = mapping or {}
        self.platform_label = platform_label

    def parse_record(self, record: dict) -> Optional[PostRecord]:  # pragma: no cover
        raise NotImplementedError("TabularAdapter reads whole tables.")

    def load(self, paths) -> list[PostRecord]:
        if isinstance(paths, (str, os.PathLike)):
            paths = [paths]
        out: list[PostRecord] = []
        for path in paths:
            df = read_table(str(path))
            out.extend(self.from_frame(df, os.path.basename(str(path))))
        return out

    def from_frame(self, df, source: str = "table") -> list[PostRecord]:
        m = dict(guess_mapping(df.columns))
        m.update({k: v for k, v in self.mapping.items() if v})
        cap_col = m.get("caption_text")
        if not cap_col:
            raise ValueError(
                "No caption column found. Name the column holding post text, or "
                "map it explicitly."
            )

        def cell(row, field):
            col = m.get(field)
            if not col or col not in df.columns:
                return None
            return row[col]

        records: list[PostRecord] = []
        for i, row in df.iterrows():
            caption = cell(row, "caption_text")
            caption = "" if caption is None else str(caption)
            try:
                import pandas as pd
                if pd.isna(cell(row, "caption_text")):
                    caption = ""
            except Exception:
                pass

            pid = cell(row, "post_id")
            pid = str(pid) if pid not in (None, "") else f"{source}:{i}"
            media = cell(row, "media_urls")
            media_list = [str(media)] if media not in (None, "") else []
            try:
                import pandas as pd
                if media is not None and pd.isna(media):
                    media_list = []
            except Exception:
                pass

            handle = cell(row, "author_handle")
            url = cell(row, "url")
            records.append(PostRecord(
                platform=self.platform_label,
                post_id=pid,
                url="" if url in (None, "") else str(url),
                author_handle="" if handle in (None, "") else str(handle),
                caption_text=caption,
                like_count=_to_int(cell(row, "like_count")),
                comment_count=_to_int(cell(row, "comment_count")),
                share_count=_to_int(cell(row, "share_count")),
                view_count=_to_int(cell(row, "view_count")),
                timestamp=_to_dt(cell(row, "timestamp")),
                hashtags=[h.lower() for h in _HASHTAG.findall(caption)],
                mentions=[a.lower() for a in _MENTION.findall(caption)],
                media_urls=media_list,
                raw={},
            ))
        return records
