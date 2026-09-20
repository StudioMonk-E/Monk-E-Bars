"""Work out what a dropped file is, so the interface does not have to ask.

Zeeschuimer stamps every record with ``source_platform`` (``instagram.com``,
``tiktok.com``, and so on), which means asking a user to pick the platform from a
dropdown is asking them for something the file already states. This module reads
it, and recognises spreadsheet exports as a separate kind so the same dropzone can
accept both.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

# Zeeschuimer's source_platform values, mapped to adapter names.
_PLATFORM_HOSTS = {
    "instagram.com": "instagram",
    "instagram": "instagram",
    "tiktok.com": "tiktok",
    "tiktok": "tiktok",
    "twitter.com": "twitter",
    "x.com": "twitter",
    "reddit.com": "reddit",
}

NDJSON_EXT = {".ndjson", ".jsonl", ".json"}
TABLE_EXT = {".csv", ".tsv", ".xlsx", ".xls"}


@dataclass
class Detection:
    """What a file turned out to be."""
    kind: str                      # "zeeschuimer" | "table" | "unknown"
    platform: Optional[str] = None  # adapter name when kind == "zeeschuimer"
    note: str = ""                 # human-readable explanation for the interface

    @property
    def ok(self) -> bool:
        return self.kind != "unknown"


def _sniff_ndjson(path: str, max_lines: int = 25) -> Detection:
    """Read the first few records and look for Zeeschuimer's platform stamp."""
    try:
        with open(path, encoding="utf-8") as fh:
            for _ in range(max_lines):
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(rec, dict):
                    continue
                raw = str(rec.get("source_platform") or "").strip().lower()
                if raw:
                    platform = _PLATFORM_HOSTS.get(raw)
                    if platform:
                        return Detection("zeeschuimer", platform,
                                         f"Zeeschuimer capture, {platform}.")
                    return Detection("unknown", None,
                                     f"Capture reports an unsupported platform: {raw}.")
                # A JSON file without the stamp is not a Zeeschuimer export.
                return Detection("unknown", None,
                                 "JSON file with no source_platform field. "
                                 "Zeeschuimer captures carry one on every record.")
    except (OSError, UnicodeDecodeError) as exc:
        return Detection("unknown", None, f"File could not be read: {exc}")
    return Detection("unknown", None, "No readable records in the file.")


def detect(path: str) -> Detection:
    """Classify a dropped file by extension, then by content."""
    ext = os.path.splitext(path)[1].lower()
    if ext in TABLE_EXT:
        return Detection("table", None, f"Spreadsheet export ({ext.lstrip('.')}).")
    if ext in NDJSON_EXT:
        return _sniff_ndjson(path)
    shown = ext or "none"
    return Detection("unknown", None,
                     f"Unrecognised file type '{shown}'. "
                     "Accepted: .ndjson, .jsonl, .csv, .tsv, .xlsx.")
