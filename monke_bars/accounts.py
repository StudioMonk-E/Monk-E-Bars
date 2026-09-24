"""Account-level analysis: which accounts are posting.

Every other analysis module aggregates *across* posts into corpus-level
statistics. This one groups *by author* and returns one row per account, because
it answers a different question. Where the vocabulary views ask how a subject is
discussed, this asks which accounts to approach.

The two share the whole pipeline up to :func:`monke_bars.corpus.build_corpus`.
The corpus already carries ``author_handle``, ``author_name``, ``author_verified``,
``timestamp`` and ``is_paid_partnership``; this module is the first thing to read
them.

Two config-driven mechanisms do the work, and both are deliberately the same
shape as the thematic lexicons in :mod:`monke_bars.lexical`:

``account_types``
    Word lists matched against the account's handle, display name and hashtags.
    The theme lexicons count words inside captions; these test identity. First
    match wins, in config order, so a vendor gets classified before anything can
    mistake it for a participant. One type
    may be marked ``default`` to catch everything else.

``signals``
    Named 0-to-N scores built from independent boolean tests on a post. They
    filter, and they stay in the frame as columns so a reader can see how any
    post arrived at its score.

Neither mechanism deletes anything. Accounts are labelled and then included or
excluded by the caller, so an account that was filtered out stays inspectable
with the reason attached.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import pandas as pd

from .config import Config

DEFAULT_MARKER = "default"

# Used when a study defines no types of its own, so a dropped file classifies
# without anyone writing word lists first. Deliberately about what an account
# *is*. Size belongs to a separate filter, because a hashtag scrape carries no
# follower count and no branded-content flag, which leaves nothing here able to
# separate a creator from a private individual.
DEFAULT_ACCOUNT_TYPES: dict = {
    "Brand or business": {
        "handle_words": [
            "shop", "store", "winkel", "boutique", "salon", "studio", "atelier",
            "official", "officieel", "company", "agency", "bureau", "brand",
            "collection", "label", "cafe", "koffie", "restaurant", "bakery",
            "bakkerij", "hotel", "venue", "locatie", "catering", "market",
            "markt", "design", "fotograf", "photograph", "florist", "bloemen",
            "juwel", "jewel", "clinic", "kliniek", "academy", "school",
        ],
        "name_words": [" bv", " b.v", " gmbh", " ltd", " inc", " nv"],
    },
    "News or media": {
        "handle_words": [
            "nieuws", "news", "magazine", "krant", "times", "daily", "journal",
            "journaal", "radio", "omroep", "televisie", "media", "podcast",
            "press", "redactie", "editorial", "showbizz", "showbiz", "tv",
        ],
    },
    "Person": DEFAULT_MARKER,
}


# --- signals ------------------------------------------------------------

def _caption_word_hits(caption: str, words) -> int:
    """Count how many of ``words`` appear in a caption, as substrings.

    Substring matching is deliberate: it catches a word still carrying its
    punctuation, and the same word inside a compound, with no tokeniser per
    language.
    """
    low = (caption or "").lower()
    return sum(1 for w in words if w and str(w).lower() in low)


def score_signals(corpus: pd.DataFrame, config: Config) -> pd.DataFrame:
    """Add one ``signal_<name>`` column per configured signal, plus its parts.

    A signal scores a post from 0 upward, one point per test that passes:

    ``detected_language``   the language filter already agreed with this
    ``caption_words``       at least ``min_caption_words`` of them appear
    ``hashtags``            at least ``min_hashtags`` of them appear

    ``exclude_words`` acts as a veto and carries no points: enough hits zero the
    score.
    That exists because closely related languages defeat detection, and a short
    caption in one can look exactly like the other. ``min_exclude_words`` sets how
    many hits are needed, and raising it above 1 is usually right, because a word
    list for a lookalike language will almost always contain something the target
    language also uses.
    """
    if not config.signals:
        return corpus
    df = corpus.copy()
    for name, spec in config.signals.items():
        spec = spec or {}
        col = f"signal_{name.lower()}"
        want_lang = spec.get("detected_language")
        words = [str(w).lower() for w in (spec.get("caption_words") or [])]
        min_words = int(spec.get("min_caption_words", 1) or 1)
        tags = [str(t).lower().lstrip("#") for t in (spec.get("hashtags") or [])]
        min_tags = int(spec.get("min_hashtags", 1) or 1)
        excl = [str(w).lower() for w in (spec.get("exclude_words") or [])]
        min_excl = int(spec.get("min_exclude_words", 1) or 1)

        def score(row) -> int:
            caption = row.get("caption_text") or ""
            if excl and _caption_word_hits(caption, excl) >= min_excl:
                return 0
            pts = 0
            if want_lang and str(row.get("language", "")).lower() == str(want_lang).lower():
                pts += 1
            if words and _caption_word_hits(caption, words) >= min_words:
                pts += 1
            if tags:
                have = {str(t).lower().lstrip("#") for t in (row.get("hashtag_list") or [])}
                if len(have & set(tags)) >= min_tags:
                    pts += 1
            return pts

        df[col] = df.apply(score, axis=1)
    return df


# --- classification -----------------------------------------------------

def resolve_account_types(config: Config) -> dict:
    """Study types layered over the generic ones, most specific first.

    A study adds topic vocabulary; it should not have to restate that a shop is a
    shop. So its types are checked first, and a type it names that also exists in
    the defaults takes the union of both word lists. Its ``default`` type replaces
    the generic one, since only one can catch what is left over.

    Order is the whole point: "Wedding business" must be tested before the broader
    "Brand or business", or every florist would come back as a generic shop.
    """
    if not config.account_types:
        return dict(DEFAULT_ACCOUNT_TYPES)

    merged: dict = {}
    study_default = any(v == DEFAULT_MARKER or v is None
                        for v in config.account_types.values())

    for name, spec in config.account_types.items():
        base = DEFAULT_ACCOUNT_TYPES.get(name)
        if spec in (DEFAULT_MARKER, None) or not isinstance(base, dict):
            merged[name] = spec
            continue
        combined = dict(base)
        for key in ("handle_words", "name_words", "hashtags"):
            combined[key] = list(dict.fromkeys(
                list(base.get(key) or []) + list((spec or {}).get(key) or [])))
        for key, val in (spec or {}).items():
            if key not in ("handle_words", "name_words", "hashtags"):
                combined[key] = val
        merged[name] = combined

    for name, spec in DEFAULT_ACCOUNT_TYPES.items():
        if name in merged:
            continue
        if spec == DEFAULT_MARKER and study_default:
            continue          # the study named its own catch-all
        merged[name] = spec
    return merged


def classify_account(handle: str, name: str, tag_share: dict, config: Config,
                     explain: bool = False):
    """Return the account type for one account, first match wins.

    The test is a plain substring match: handle and display name are joined and
    lowercased, and a type claims the account if any of its words appears anywhere
    inside that string. So ``stancefotografie`` matches on ``fotograf``, and
    ``hln_be`` matches on ``hln`` only if somebody put ``hln`` in the list.

    This is a crude heuristic and is meant to be. It cannot read a bio, and a
    garden centre called ``spek.vers.tuincentrum`` looks exactly like a person to
    it. What it offers instead is that every decision is inspectable and every
    word list is editable, which is why nothing here is ever deleted on the
    strength of a match.

    ``tag_share`` maps a type name to the share of that account's posts carrying
    enough of its hashtags, which is the second route in: it catches a vendor
    whose handle gives nothing away but whose posts are full of trade tags.

    With ``explain``, returns ``(type, reason)``.
    """
    text = f"{handle or ''} {name or ''}".lower()
    fallback, types = "Unclassified", resolve_account_types(config)
    for type_name, spec in types.items():
        if spec == DEFAULT_MARKER or spec is None:
            fallback = type_name
            continue
        spec = spec or {}
        words = [str(w).lower() for w in
                 (spec.get("handle_words") or []) + (spec.get("name_words") or [])]
        hit = next((w for w in words if w in text), None)
        if hit:
            return (type_name, f"name contains '{hit.strip()}'") if explain else type_name
        threshold = float(spec.get("min_post_share", 0.5) or 0.5)
        share = tag_share.get(type_name, 0.0)
        if share > threshold:
            reason = f"{share:.0%} of posts carry its hashtags"
            return (type_name, reason) if explain else type_name
    return (fallback, "no word matched") if explain else fallback


def _tag_shares(posts: pd.DataFrame, config: Config) -> dict:
    """Share of an account's posts carrying enough hashtags for each type."""
    out = {}
    n = len(posts)
    if not n:
        return out
    for type_name, spec in resolve_account_types(config).items():
        if spec == DEFAULT_MARKER or not spec:
            continue
        tags = {str(t).lower().lstrip("#") for t in (spec.get("hashtags") or [])}
        if not tags:
            continue
        need = int(spec.get("min_hashtag_hits", 2) or 2)
        hits = 0
        for lst in posts["hashtag_list"]:
            have = {str(t).lower().lstrip("#") for t in (lst or [])}
            if len(have & tags) >= need:
                hits += 1
        out[type_name] = hits / n
    return out


# --- rollup -------------------------------------------------------------

def build_accounts(corpus: pd.DataFrame, config: Config,
                   now: Optional[datetime] = None) -> pd.DataFrame:
    """One row per account, ranked by the account's strongest single post.

    The best post decides the rank, which suits this kind of question: a one-off
    announcement is a single large post, and a sum would reward an account that
    posts constantly over the one that posted the thing being looked for.
    ``total_engagement`` sits alongside it for the other reading.
    """
    if corpus.empty:
        return pd.DataFrame()
    df = score_signals(corpus, config)
    now = now or datetime.now(timezone.utc)
    signal_cols = [c for c in df.columns if c.startswith("signal_")]

    rows = []
    for handle, posts in df.groupby("author_handle", dropna=False):
        if not handle:
            continue
        best = posts.loc[posts["engagement_score"].idxmax()]
        ts = pd.to_datetime(posts["timestamp"], utc=True, errors="coerce")
        best_ts = pd.to_datetime(best.get("timestamp"), utc=True, errors="coerce")
        months = None
        if pd.notna(best_ts):
            months = round((now - best_ts.to_pydatetime()).days / 30.44, 1)

        # Followers are the reach figure outreach actually needs, and TikTok
        # supplies them on every item. An Instagram hashtag scrape supplies none,
        # so this stays 0 there and every rate built on it is suppressed.
        followers = int(posts["follower_count"].max()) if "follower_count" in posts else 0
        views = int(best.get("view_count", 0) or 0)
        # Engagement against views, which is how TikTok is read: the For You page
        # sends a video to people who do not follow the account, so dividing by
        # followers returns figures in the thousands of percent and means little.
        rate = round(int(best["engagement_score"]) / views * 100, 2) if views else None

        override = (config.account_overrides or {}).get(str(handle).lower())
        typed = ((override, "set by hand") if override else classify_account(
            handle, best.get("author_name", ""), _tag_shares(posts, config),
            config, explain=True))
        # One handle can post on two platforms, and for an outreach list that is
        # one person. The row records which platforms it was found on, and which
        # one its strongest post came from, so a profile link still resolves.
        platforms = sorted({str(x) for x in posts["platform"].unique() if x}) \
            if "platform" in posts else []
        row = {
            "username": handle,
            "platforms": ", ".join(platforms),
            "platform": str(best.get("platform", "")) or (platforms[0] if platforms else ""),
            "full_name": best.get("author_name", ""),
            "verified": bool(posts["author_verified"].any())
            if "author_verified" in posts else False,
            **dict(zip(("account_type", "type_reason"), typed)),
            "posts": len(posts),
            "followers": followers,
            "best_engagement": int(best["engagement_score"]),
            "best_post_views": views,
            "engagement_rate_pct": rate,
            "total_engagement": int(posts["engagement_score"].sum()),
            "best_post_url": best.get("url", ""),
            "best_post_date": best_ts.date() if pd.notna(best_ts) else None,
            "months_since_best": months,
            "last_post_date": ts.max().date() if ts.notna().any() else None,
            "paid_partnership": bool(posts["is_paid_partnership"].any())
            if "is_paid_partnership" in posts else False,
            "best_caption": (best.get("caption_text") or "")[:300],
        }
        for col in signal_cols:
            row[col] = int(posts[col].max())
        rows.append(row)

    out = pd.DataFrame(rows)
    if out.empty:
        return out
    return out.sort_values("best_engagement", ascending=False, kind="stable").reset_index(drop=True)


# --- filtering -----------------------------------------------------------
#
# Three filters, kept independent on purpose.
#
#   type       what the account is, from its handle and name
#   verified   a fact the platform states
#   reach      how much engagement its best post drew
#
# They stay separate because they answer different questions and because no
# combination of them can be collapsed into a single label honestly. A scrape
# carries no follower count, so "influencer" is not something this tool can
# detect; it is something a reader composes out of these three, and a preset that
# does so prints its own rule beside its name.

def apply_filters(accounts: pd.DataFrame, *, types=None, verified=None,
                  min_engagement: int = 0, max_engagement=None,
                  min_followers: int = 0, min_signals=None) -> pd.DataFrame:
    """Add an ``excluded_because`` column. Nothing is dropped.

    Every filter records its own reason, so an account that misses the list stays
    in the frame with the reason attached. That matters more here than in a
    corpus study: a name left out of an outreach list should be auditable.
    """
    if accounts.empty:
        return accounts
    df = accounts.copy()
    reasons = []
    for _, row in df.iterrows():
        why = []
        if types and row["account_type"] not in types:
            why.append(f"type is {row['account_type']}")
        if verified is not None and bool(row.get("verified", False)) != bool(verified):
            why.append("not verified" if verified else "verified")
        if min_engagement and row["best_engagement"] < min_engagement:
            why.append(f"under {min_engagement} engagement")
        if max_engagement is not None and row["best_engagement"] >= max_engagement:
            why.append(f"at or over {max_engagement} engagement")
        if min_followers:
            have = int(row.get("followers", 0) or 0)
            # A capture without follower counts cannot answer this, and excluding
            # every account on a missing figure would empty the list silently.
            if have and have < min_followers:
                why.append(f"under {min_followers} followers")
        for name, threshold in (min_signals or {}).items():
            col = f"signal_{name.lower()}"
            if col in df.columns and row[col] < int(threshold):
                why.append(f"{name} score {row[col]} under {threshold}")
        reasons.append("; ".join(why))
    df["excluded_because"] = reasons
    return df


def passing(accounts: pd.DataFrame, **filters) -> pd.DataFrame:
    """Just the accounts that pass, in rank order."""
    df = apply_filters(accounts, **filters)
    if df.empty:
        return df
    return (df[df["excluded_because"] == ""]
            .drop(columns=["excluded_because"]).reset_index(drop=True))


def audience_filters(config: Config, name: str) -> dict:
    """The filter set behind a named preset, ready to pass to :func:`passing`.

    Presets exist so an interface can offer "Influencers" as a checkbox while the
    rule underneath stays visible and editable. The name is only a shortcut, and
    it claims nothing the data cannot support.
    """
    spec = dict((config.audiences or {}).get(name) or {})
    out = {
        "types": list(spec.get("types") or []) or None,
        "min_engagement": int(spec.get("min_engagement", 0) or 0),
        "max_engagement": spec.get("max_engagement"),
        "min_followers": int(spec.get("min_followers", 0) or 0),
        "verified": spec.get("verified"),
        "min_signals": dict(spec.get("min_signals") or config.min_signals or {}),
    }
    return out


def describe_audience(config: Config, name: str) -> str:
    """One line stating what a preset actually selects, for display beside it."""
    f = audience_filters(config, name)
    bits = []
    if f["types"]:
        bits.append(" or ".join(f["types"]).lower())
    if f["verified"] is True:
        bits.append("verified")
    elif f["verified"] is False:
        bits.append("not verified")
    if f["min_engagement"]:
        bits.append(f"at least {f['min_engagement']} engagement")
    if f.get("min_followers"):
        bits.append(f"at least {f['min_followers']} followers where known")
    if f["max_engagement"] is not None:
        bits.append(f"under {f['max_engagement']} engagement")
    for sig, n in (f["min_signals"] or {}).items():
        bits.append(f"{sig} score {n} or more")
    return ", ".join(bits) if bits else "every account"


def config_filters(config: Config) -> dict:
    """The study's own default filters, for a non-interactive run."""
    return {
        "types": list(config.include_types) or None,
        "min_engagement": int(config.min_engagement or 0),
        "min_signals": dict(config.min_signals or {}),
    }
