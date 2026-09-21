"""Corpus construction: PostRecords -> a ranked, tiered pandas DataFrame.

Steps mirror the thesis method and are platform-agnostic:
  1. flatten PostRecords into a table
  2. drop duplicate posts (same post_id)
  3. optionally keep only posts published inside a date window
  4. optionally keep only one detected language
  5. score by engagement (likes + comments), rank, and split into equal tiers
The resulting DataFrame is what every analysis function consumes.
"""

from __future__ import annotations

import re
from typing import Iterable, Optional, Sequence

import pandas as pd
from langdetect import DetectorFactory, LangDetectException, detect

from .ingest.base import PostRecord

DetectorFactory.seed = 0  # deterministic language detection

_RE_HASHTAG = re.compile(r"#\w+")
_RE_MENTION = re.compile(r"@\w+")


def detect_language(caption_text: str) -> str:
    """ISO language code of a caption's prose (hashtags/mentions removed first)."""
    prose = _RE_MENTION.sub("", _RE_HASHTAG.sub("", caption_text or "")).strip()
    if len(prose) < 10:
        return "unknown"
    try:
        return detect(prose)
    except LangDetectException:
        return "unknown"


def assign_tiers(n_rows: int, labels: Sequence[str]) -> list[str]:
    """Assign each rank position (0-based, already sorted best-first) a tier label.

    The corpus is split into ``len(labels)`` equal bands by rank: the first band
    gets ``labels[0]``, and so on. Works for any number of tiers.
    """
    k = len(labels)
    band = n_rows / k if n_rows else 1
    out = []
    for i in range(n_rows):
        idx = min(int(i // band), k - 1)
        out.append(labels[idx])
    return out


def language_counts(df: pd.DataFrame) -> pd.DataFrame:
    """Which languages the corpus actually contains, commonest first.

    Interfaces should offer these, so nobody has to guess a code. The
    counts also expose detection failures: a large ``unknown`` share usually means
    short captions, and a language nobody expected usually means a lookalike.
    """
    if df.empty or "language" not in df.columns:
        return pd.DataFrame(columns=["Language", "Posts"])
    counts = df["language"].value_counts()
    return pd.DataFrame({"Language": counts.index, "Posts": counts.values})


def filter_languages(df: pd.DataFrame, language) -> pd.DataFrame:
    """Keep posts in one language or several, without re-running detection.

    Detection is by far the slowest step in the pipeline, so an interface that
    rebuilt the corpus on every checkbox change would be unusable. Detect once
    into the ``language`` column, then filter with this as often as needed.
    """
    if language is None or df.empty or "language" not in df.columns:
        return df.reset_index(drop=True) if not df.empty else df
    wanted = {language} if isinstance(language, str) else set(language)
    wanted = {str(w).lower() for w in wanted}
    return df[df["language"].str.lower().isin(wanted)].reset_index(drop=True)


def retier(df: pd.DataFrame, tier_labels: Sequence[str]) -> pd.DataFrame:
    """Re-rank and re-tier a corpus that has been filtered since it was built.

    Tiers are positions in a ranking, so any filter invalidates them: drop the
    top third of a corpus and the remaining posts still carry their old labels,
    which would put "High" on posts that are now the weakest in the set. An
    interface that filters interactively has to call this after every change.

    Kept separate from :func:`build_corpus` because language detection is the
    expensive step and must not be repeated. Detect once, then filter and retier
    as often as the controls demand.
    """
    if df.empty:
        return df
    out = df.sort_values("engagement_score", ascending=False, kind="stable").reset_index(drop=True)
    out["engagement_rank"] = out.index + 1
    out["engagement_tier"] = assign_tiers(len(out), list(tier_labels))
    return out


def filter_dates(df: pd.DataFrame, since=None, until=None) -> pd.DataFrame:
    """Keep posts published inside a window, without rebuilding the corpus.

    Posts with no timestamp are dropped whenever a bound is set, because there is
    no honest way to place them inside it.
    """
    if (since is None and until is None) or df.empty or "timestamp" not in df.columns:
        return df
    ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    keep = ts.notna()
    if since is not None:
        keep &= ts >= pd.Timestamp(since, tz="UTC")
    if until is not None:
        keep &= ts <= pd.Timestamp(until, tz="UTC")
    return df[keep].reset_index(drop=True)


def build_corpus(
    posts: Iterable[PostRecord],
    language: Optional[str] = "en",
    tier_labels: Sequence[str] = ("High", "Medium", "Low"),
    detect_lang: bool = True,
    since=None,
    until=None,
) -> pd.DataFrame:
    """Build the analysis-ready corpus DataFrame from PostRecords.

    Parameters
    ----------
    posts : iterable of PostRecord
    language : str, list of str, or None
        Keep only posts detected as these languages. ``None`` keeps every post.
        A list is useful where one audience spans codes, for example Dutch and
        Flemish content that detection splits, or a market read in two languages.
    tier_labels : sequence of str
        Engagement tiers, best-first (default High/Medium/Low).
    detect_lang : bool
        Run language detection. Turned off internally when ``language`` is None
        and no ``language`` column is needed.
    since, until : date-like or None
        Keep only posts published in this window. Anything pandas can parse
        works, including ``"2025-08-01"``. Posts with no timestamp are dropped
        when a window is set, because there is no honest way to place them in
        it. The count of those is recorded on ``df.attrs["undated_removed"]``.
    """
    rows = [p.to_dict() for p in posts]
    df = pd.DataFrame(rows)
    if df.empty:
        return df

    # 1. dedup on post_id
    before = len(df)
    df = df.drop_duplicates(subset="post_id", keep="first").reset_index(drop=True)
    df.attrs["duplicates_removed"] = before - len(df)

    # 2. date window, before language detection so the slow step runs on fewer rows
    if since is not None or until is not None:
        ts = pd.to_datetime(df.get("timestamp"), utc=True, errors="coerce")
        keep = ts.notna()
        df.attrs["undated_removed"] = int((~keep).sum())
        if since is not None:
            keep &= ts >= pd.Timestamp(since, tz="UTC")
        if until is not None:
            keep &= ts <= pd.Timestamp(until, tz="UTC")
        before_date = len(df)
        df = df[keep].reset_index(drop=True)
        df.attrs["dated_out"] = before_date - len(df)
        if df.empty:
            return df

    # 3. language
    if detect_lang or language is not None:
        df["language"] = df["caption_text"].apply(detect_language)
    if language is not None:
        df = filter_languages(df, language)

    if df.empty:
        return df

    # 4. engagement score, rank, tier
    df["engagement_score"] = df["engagement_score"].fillna(0).astype(int)
    df = df.sort_values("engagement_score", ascending=False, kind="stable").reset_index(drop=True)
    df["engagement_rank"] = df.index + 1
    df["engagement_tier"] = assign_tiers(len(df), list(tier_labels))

    # 5. tidy hashtag/mention columns back into lists for convenience
    df["hashtag_list"] = df["hashtags"].apply(
        lambda s: [t.strip() for t in s.split(",") if t.strip()] if isinstance(s, str) else []
    )
    df["mention_list"] = df["mentions"].apply(
        lambda s: [t.strip() for t in s.split(",") if t.strip()] if isinstance(s, str) else []
    )
    df["hashtag_count"] = df["hashtag_list"].apply(len)
    return df
