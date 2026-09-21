"""Generated findings: the statements a corpus supports on its own.

Every sentence this module produces is derived from counts the pipeline already
computes. Nothing here interprets. "The high tier over-uses keto, blue and majik"
is a fact about frequencies; "the high tier sells a product" is a reading of that
fact, and readings belong to the person who can defend them. A study config may
carry one optional ``claim`` line for that purpose, and it prints above the
evidence, under a heading that marks it as authored.

The split matters for a tool whose credibility rests on being auditable: a reader
should never have to guess which statements came from the data and which came
from a person.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .config import Config
from . import lexical


@dataclass
class Finding:
    """One generated statement, with the numbers that produced it."""
    kind: str            # corpus | overlap | keyness | theme | hashtag
    text: str
    detail: dict = field(default_factory=dict)


# Enough of the ISO 639-1 set to cover what turns up in practice. A code with no
# name here still displays, as the code, so an unlisted language is never hidden.
_LANG_NAMES = {
    "en": "English", "pt": "Portuguese", "es": "Spanish", "fr": "French",
    "de": "German", "it": "Italian", "nl": "Dutch", "id": "Indonesian",
    "af": "Afrikaans", "da": "Danish", "no": "Norwegian", "sv": "Swedish",
    "fi": "Finnish", "pl": "Polish", "cs": "Czech", "sk": "Slovak",
    "ro": "Romanian", "hu": "Hungarian", "tr": "Turkish", "el": "Greek",
    "ru": "Russian", "uk": "Ukrainian", "ca": "Catalan", "et": "Estonian",
    "lt": "Lithuanian", "lv": "Latvian", "sl": "Slovenian", "hr": "Croatian",
    "cy": "Welsh", "ga": "Irish", "sw": "Swahili", "so": "Somali",
    "vi": "Vietnamese", "th": "Thai", "ja": "Japanese", "ko": "Korean",
    "zh-cn": "Chinese", "zh-tw": "Chinese", "ar": "Arabic", "he": "Hebrew",
    "hi": "Hindi", "bn": "Bengali", "ta": "Tamil", "ur": "Urdu",
    "tl": "Tagalog", "ms": "Malay", "kk": "Kazakh", "uz": "Uzbek",
    "tg": "Tajik", "sq": "Albanian", "eu": "Basque", "be": "Belarusian",
    "ne": "Nepali", "unknown": "undetected",
}


def _lang_name(code) -> str:
    return _LANG_NAMES.get((code or "").lower(), str(code))


def _fmt_list(words, n=5) -> str:
    words = list(words)[:n]
    if not words:
        return ""
    if len(words) == 1:
        return f"*{words[0]}*"
    return ", ".join(f"*{w}*" for w in words[:-1]) + f" and *{words[-1]}*"


def corpus_finding(corpus, raw_count: Optional[int], config: Config) -> Finding:
    kept = len(corpus)
    if raw_count and raw_count > kept:
        dropped = raw_count - kept
        pct = round(dropped / raw_count * 100)
        langs = [config.language] if isinstance(config.language, str) else list(config.language or [])
        lang = (f" The filter keeps {' and '.join(_lang_name(c) for c in langs)} only."
                if langs else "")
        text = (f"{kept} of {raw_count} captured posts enter the corpus. "
                f"{dropped} are removed by deduplication, language and date filtering, "
                f"which is {pct} percent of the capture.{lang}")
    else:
        text = f"{kept} posts in the corpus."
    return Finding("corpus", text, {"kept": kept, "raw": raw_count})


def overlap_finding(corpus, tiers, top_n: int = 15) -> Optional[Finding]:
    """How much the strongest and weakest tiers share by raw frequency.

    This is the finding that motivates keyness: if the two ends of the corpus
    return largely the same ranked words, frequency cannot separate them.
    """
    if len(tiers) < 2:
        return None
    by_tier = lexical.top_words_by_tier(corpus, tiers, n=top_n)
    hi, lo = tiers[0], tiers[-1]
    hi_words = list(by_tier[hi]["Word"])
    lo_words = list(by_tier[lo]["Word"])
    if not hi_words or not lo_words:
        return None
    shared = set(hi_words) & set(lo_words)
    lead = f" and both lead on *{hi_words[0]}*" if hi_words[0] == lo_words[0] else ""
    text = (f"The {hi.lower()} and {lo.lower()} tiers share {len(shared)} of their "
            f"top {top_n} words by raw frequency{lead}.")
    return Finding("overlap", text,
                   {"shared": sorted(shared), "n": top_n, "lead_shared": bool(lead)})


def keyness_finding(corpus, tiers, top_n: int = 5) -> Optional[Finding]:
    """What separates the ends of the corpus once frequency is controlled for."""
    if len(tiers) < 2:
        return None
    hi, lo = tiers[0], tiers[-1]
    k_hi = lexical.keyness(corpus, hi, lo, top_n=top_n)
    k_lo = lexical.keyness(corpus, lo, hi, top_n=top_n)
    if k_hi.empty and k_lo.empty:
        return None
    parts = []
    if not k_hi.empty:
        parts.append(f"the {hi.lower()} tier over-uses {_fmt_list(k_hi['Word'], top_n)}")
    if not k_lo.empty:
        parts.append(f"the {lo.lower()} tier over-uses {_fmt_list(k_lo['Word'], top_n)}")
    text = "Measured as keyness, " + "; ".join(parts) + "."
    return Finding("keyness", text,
                   {"high": list(k_hi["Word"]), "low": list(k_lo["Word"])})


def exclusive_finding(corpus, tiers, top_n: int = 20) -> Optional[Finding]:
    """Words present at one end of the corpus and wholly absent from the other."""
    if len(tiers) < 2:
        return None
    hi, lo = tiers[0], tiers[-1]
    k = lexical.keyness(corpus, hi, lo, top_n=top_n)
    if k.empty:
        return None
    excl = k[k["Reference freq"] == 0]
    if excl.empty:
        return None
    text = (f"{len(excl)} of the {hi.lower()} tier's distinctive words do not appear "
            f"in the {lo.lower()} tier at all, led by {_fmt_list(excl['Word'], 3)}.")
    return Finding("keyness", text, {"words": list(excl["Word"])})


def theme_findings(corpus, config: Config) -> list[Finding]:
    """Direction of travel for each framework layer, plus any that barely register."""
    if not config.themes:
        return []
    tiers = config.tier_labels
    if len(tiers) < 2:
        return []
    shares = lexical.theme_shares(corpus, config)
    counts = lexical.theme_counts(corpus, config)
    total_by_theme = dict(zip(counts["Theme"], counts["Total"]))
    out: list[Finding] = []
    rising, falling, flat = [], [], []
    for _, row in shares.iterrows():
        theme = row["Theme"]
        hi, lo = float(row[tiers[0]]), float(row[tiers[-1]])
        spread = hi - lo
        # A layer counts as flat when the two ends differ by under a tenth of a
        # point; below that the direction is noise at this corpus size.
        if abs(spread) < 0.1:
            flat.append((theme, hi, lo))
        elif spread > 0:
            rising.append((theme, hi, lo))
        else:
            falling.append((theme, hi, lo))

    for label, group in (("rises", rising), ("falls", falling)):
        if group:
            names = _fmt_list([g[0] for g in group], 4)
            out.append(Finding("theme",
                               f"Share {label} with engagement for {names}.",
                               {"themes": [g[0] for g in group]}))
    for theme, hi, lo in flat:
        total = total_by_theme.get(theme, 0)
        out.append(Finding("theme",
                           f"*{theme}* holds flat across tiers at {hi:.2f} against {lo:.2f} "
                           f"percent, on {total} token hits in the whole corpus.",
                           {"theme": theme, "total": total}))
    return out


def hashtag_finding(corpus, config: Config) -> Optional[Finding]:
    df = lexical.cooccurring_hashtags(corpus, config.query_hashtags, top_n=5)
    if df.empty:
        return None
    top = df.iloc[0]
    text = (f"The most common co-occurring hashtag is *{top['Hashtag']}* "
            f"at {int(top['Frequency'])} posts.")
    return Finding("hashtag", text, {"top": list(df["Hashtag"])})


def generate(corpus, config: Config, raw_count: Optional[int] = None) -> list[Finding]:
    """Every statement this corpus supports, in reading order.

    Safe on a corpus with no framework: theme findings are simply absent.
    """
    corpus = lexical.add_tokens(corpus, config)
    tiers = [t for t in config.tier_labels
             if (corpus["engagement_tier"] == t).any()]
    out: list[Finding] = [corpus_finding(corpus, raw_count, config)]
    for fn in (overlap_finding, keyness_finding, exclusive_finding):
        f = fn(corpus, tiers)
        if f:
            out.append(f)
    out.extend(theme_findings(corpus, config))
    h = hashtag_finding(corpus, config)
    if h:
        out.append(h)
    return out
