"""Excel export: the account worklist, and the posts behind it.

An account list is where someone's afternoon starts. The sheet is built to be
worked in: the columns a person needs in order to decide come first, the caveats
travel inside the file so they survive being emailed onward, and every account
that was filtered out keeps a place on a second sheet with its reason attached,
since scanning what a keyword classifier threw away is how its mistakes surface.

Two sheets:

``Accounts``   one row per account that passed, ranked, with empty ``Checked``
              and ``Notes`` columns to work in.
``Left out``  every account that did not pass, with ``excluded_because``.

A third sheet carries the run's own parameters, so a file that gets emailed
onward still says what it was filtered on.
"""

from __future__ import annotations

import datetime as _dt
import io

import pandas as pd

# Column order for the worklist. Identity first, then the numbers a person ranks
# on, then the evidence for the label, then the blanks they fill in.
ACCOUNT_COLUMNS = [
    "username", "profile_url", "account_type", "type_reason",
    "followers", "best_engagement", "engagement_rate_pct", "best_post_views",
    "posts", "verified", "paid_partnership",
    "best_post_date", "months_since_best", "best_post_url",
    "total_engagement", "last_post_date", "full_name", "best_caption",
]


def _profile_url(handle: str, platform: str = "instagram") -> str:
    if not handle:
        return ""
    if platform == "tiktok":
        return f"https://www.tiktok.com/@{handle}"
    return f"https://www.instagram.com/{handle}/"


def prepare_accounts(accounts: pd.DataFrame, platform: str = "instagram") -> pd.DataFrame:
    """Order the columns, add the profile link, and append the blanks to fill in."""
    if accounts.empty:
        return accounts
    df = accounts.copy()
    df["profile_url"] = df["username"].apply(lambda h: _profile_url(h, platform))
    signal_cols = sorted(c for c in df.columns if c.startswith("signal_"))
    ordered = [c for c in ACCOUNT_COLUMNS if c in df.columns] + signal_cols
    ordered += [c for c in df.columns if c not in ordered and c != "excluded_because"]
    df = df[ordered]
    # Left empty on purpose: the tool cannot know either, and a column someone
    # fills in by hand is the honest place for a judgment it cannot make.
    df["Checked"] = ""
    df["Notes"] = ""
    return df


def run_parameters(config, filters: dict, corpus_rows: int, raw_rows: int,
                   platform: str = "") -> pd.DataFrame:
    """The run's own settings, so the file still explains itself later."""
    rows = [
        ("Study", getattr(config, "name", "")),
        ("Exported", _dt.datetime.now().strftime("%Y-%m-%d %H:%M")),
        ("Source", platform),
        ("Records read", raw_rows),
        ("Posts in corpus", corpus_rows),
        ("Languages kept", ", ".join(filters.get("languages") or []) or "every language"),
        ("Posted from", str(filters.get("since") or "no lower bound")),
        ("Posted until", str(filters.get("until") or "no upper bound")),
        ("Account types kept", ", ".join(filters.get("types") or []) or "every type"),
        ("Minimum engagement", filters.get("min_engagement", 0)),
    ]
    for name, threshold in (filters.get("min_signals") or {}).items():
        rows.append((f"Minimum {name} score", threshold))
    rows += [
        ("", ""),
        ("Ranking", "likes plus comments on the account's strongest single post"),
        # The limitation that most affects how this list should be used, stated
        # in the file, where it travels with the data.
        ("Caveat", "Follower counts arrive with TikTok captures and are absent from "
                   "Instagram hashtag captures. Where the followers column reads 0 "
                   "the figure is unknown, so reach is engagement alone and a small "
                   "account with one popular post can outrank a large one. Check "
                   "those by hand."),
        ("Caveat", "Engagement rate is measured against views, which is how TikTok "
                   "is read: the For You page serves a video to people who do not "
                   "follow the account, so a rate taken against followers returns "
                   "figures in the thousands of percent."),
        ("Caveat", "Account type is decided by matching words in the handle and "
                   "display name. It produces false positives and misses. The "
                   "type_reason column states what matched."),
        ("Caveat", "These rows describe real people. Handle them under the same "
                   "rules as any other personal data."),
    ]
    return pd.DataFrame(rows, columns=["Setting", "Value"])


def accounts_workbook(accounts_passing: pd.DataFrame, accounts_all: pd.DataFrame,
                      config, filters: dict, corpus_rows: int, raw_rows: int,
                      platform: str = "instagram") -> bytes:
    """Build the workbook and return it as bytes, ready for a download button."""
    passed = prepare_accounts(accounts_passing, platform)
    left_out = pd.DataFrame()
    if not accounts_all.empty and "excluded_because" in accounts_all.columns:
        left_out = accounts_all[accounts_all["excluded_because"] != ""].copy()
        if not left_out.empty:
            keep = [c for c in ("username", "account_type", "type_reason",
                                "best_engagement", "posts", "excluded_because")
                    if c in left_out.columns]
            left_out = left_out[keep]

    params = run_parameters(config, filters, corpus_rows, raw_rows, platform)

    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        (passed if not passed.empty else pd.DataFrame({"": ["No accounts passed."]})
         ).to_excel(writer, sheet_name="Accounts", index=False)
        (left_out if not left_out.empty else pd.DataFrame({"": ["Nothing was excluded."]})
         ).to_excel(writer, sheet_name="Left out", index=False)
        params.to_excel(writer, sheet_name="About this run", index=False)
        _widen(writer)
    return buf.getvalue()


def posts_workbook(corpus: pd.DataFrame, config, filters: dict) -> bytes:
    """The post-level corpus, for a study that wants the rows themselves."""
    df = corpus.drop(columns=["content_tokens"], errors="ignore")
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Posts", index=False)
        run_parameters(config, filters, len(corpus), len(corpus)).to_excel(
            writer, sheet_name="About this run", index=False)
        _widen(writer)
    return buf.getvalue()


def _widen(writer, max_width: int = 52) -> None:
    """Give every column a usable width, since the default truncates everything."""
    for sheet in writer.sheets.values():
        widths: dict = {}
        for row in sheet.iter_rows():
            for cell in row:
                if cell.value is None:
                    continue
                widths[cell.column_letter] = min(
                    max(widths.get(cell.column_letter, 10), len(str(cell.value)) + 2),
                    max_width)
        for col, width in widths.items():
            sheet.column_dimensions[col].width = width
        sheet.freeze_panes = "A2"
