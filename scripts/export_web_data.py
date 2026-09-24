#!/usr/bin/env python3
"""Export the Python package's reference data for the browser app.

The browser app reimplements the analysis in JavaScript, and two copies of a
stopword list drift apart within a month of anyone editing either. So nothing
the two tools must agree on is written twice. It lives in the Python package,
and this script writes it out as JSON for the browser to read:

    web/data/stopwords.json      33 languages, keyed by ISO code
    web/data/account_types.json  the generic account types
    web/data/contractions.json   the expansion table contractions.fix() applies
    web/data/languages.json      display names for language codes
    web/data/configs.json        every study in configs/, parsed

Run it after changing any of those, then commit the output:

    python scripts/export_web_data.py

``tests/test_web_data.py`` fails when the JSON is stale, since the browser
would then disagree with the package it claims to mirror.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monke_bars import stopwords, accounts, findings, text  # noqa: E402
from monke_bars.config import load_config  # noqa: E402

OUT = ROOT / "web" / "data"


def contraction_table() -> dict:
    """The mapping contractions.fix(leftovers=True, slang=True) applies.

    Rebuilt in the order the library adds its tables, so a key present in more
    than one resolves the way the library resolves it.
    """
    import contractions as c
    merged: dict = {}
    for table in (c.contractions_dict, c.leftovers_dict, c.slang_dict):
        for k, v in table.items():
            merged[k.lower()] = v
    return merged


def study(path: Path) -> dict:
    """A config as the browser needs it: the validated fields, nothing more."""
    cfg = load_config(path)
    return {
        "file": path.name,
        "name": cfg.name,
        "description": cfg.description,
        "claim": cfg.claim,
        "language": cfg.language,
        "since": str(cfg.since) if cfg.since else None,
        "until": str(cfg.until) if cfg.until else None,
        "tier_labels": cfg.tier_labels,
        "query_hashtags": cfg.query_hashtags,
        "stopwords_extra": cfg.stopwords_extra,
        "themes": cfg.themes,
        "account_types": cfg.account_types,
        "include_types": cfg.include_types,
        "signals": cfg.signals,
        "min_signals": cfg.min_signals,
        "min_engagement": cfg.min_engagement,
        "audiences": cfg.audiences,
        "account_overrides": cfg.account_overrides,
    }


def payloads() -> dict:
    """Every file the browser reads, keyed by name."""
    return {
        "stopwords.json": {
            "by_code": {code: sorted(words) for code, words in stopwords.BY_CODE.items()},
            # Used when a corpus carries no language column at all.
            "fallback_english": sorted(text.SNOWBALL_STOPWORDS),
        },
        "account_types.json": {
            "default_marker": accounts.DEFAULT_MARKER,
            "types": accounts.DEFAULT_ACCOUNT_TYPES,
        },
        "contractions.json": contraction_table(),
        "languages.json": findings._LANG_NAMES,
        "configs.json": [study(p) for p in sorted((ROOT / "configs").glob("*.yaml"))],
    }


def render(data) -> str:
    # Key order is data here. account_types resolves first
    # match wins in the order written, so alphabetising would test "Engaged
    # couple" before "Wedding business" and classify accounts differently
    # from the Python package. Themes also display in the order written.
    return json.dumps(data, ensure_ascii=False, indent=1)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, data in payloads().items():
        path = OUT / name
        path.write_text(render(data), encoding="utf-8")
        print(f"  {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.0f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
