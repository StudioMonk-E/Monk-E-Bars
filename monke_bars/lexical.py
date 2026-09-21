"""Lexical analysis: word rankings, n-grams, hashtag co-occurrence, theme shares.

Every function takes the corpus DataFrame produced by :func:`monke_bars.corpus.build_corpus`
and returns a tidy DataFrame, ready to export or chart. This is the grouping-and-
ranking logic from the thesis, generalised so the tiers, stopwords and thematic
lexicons all come from a study :class:`~monke_bars.config.Config`.
"""

from __future__ import annotations

from collections import Counter
from typing import Optional, Sequence

import pandas as pd

from .config import Config
from . import text as _text


def add_tokens(corpus: pd.DataFrame, config: Config) -> pd.DataFrame:
    """Attach a ``content_tokens`` column (cached on the frame) using the config's stopwords.

    The stopword list follows the languages the corpus actually holds, because a
    study may keep every language and still need each one's grammar words gone. Falling back to the declared language,
    then to English, keeps a corpus with no language column working.
    """
    if "content_tokens" in corpus.columns:
        return corpus
    if "language" in corpus.columns:
        langs = [c for c in corpus["language"].unique() if c and c != "unknown"]
    else:
        langs = config.language
    stop = _text.build_stopwords(config.stopwords_extra, languages=langs)
    corpus = corpus.copy()
    corpus["content_tokens"] = corpus["caption_text"].apply(
        lambda c: _text.content_tokens(c, stop)
    )
    return corpus


def _flatten(series) -> list[str]:
    out: list[str] = []
    for toks in series:
        out.extend(toks)
    return out


def top_words(corpus: pd.DataFrame, n: int = 30) -> pd.DataFrame:
    """Top-N content words across the whole corpus."""
    counts = Counter(_flatten(corpus["content_tokens"]))
    return pd.DataFrame(counts.most_common(n), columns=["Word", "Frequency"])


def top_words_by_tier(
    corpus: pd.DataFrame, tiers: Sequence[str], n: int = 20
) -> dict[str, pd.DataFrame]:
    """A ``{tier: DataFrame}`` mapping of the top-N words within each tier."""
    result = {}
    for tier in tiers:
        toks = _flatten(corpus[corpus["engagement_tier"] == tier]["content_tokens"])
        counts = Counter(toks)
        result[tier] = pd.DataFrame(counts.most_common(n), columns=["Word", "Frequency"])
    return result


_KEYNESS_COLUMNS = ["Word", "Target freq", "Reference freq",
                    "Log-likelihood", "Log ratio", "Reference"]


def keyness(
    corpus: pd.DataFrame,
    target_tier: str,
    reference_tier: Optional[str] = None,
    top_n: int = 25,
    min_freq: int = 3,
) -> pd.DataFrame:
    """Words over-represented in one tier relative to another (Dunning log-likelihood).

    Raw frequency answers "what is this corpus about"; every tier returns much the
    same words, because the topic dominates all of them. Keyness answers the
    comparative question instead, which words are *distinctive* of high-engagement
    posts when measured against low-engagement ones, and that is what turns the
    lexical layer from descriptive into argumentative.

    The statistic is Dunning's G² (log-likelihood), the corpus-linguistics standard
    for comparing word frequencies between two corpora of unequal size. It is paired
    with a log-ratio effect size, because G² alone rewards sheer frequency: a very
    common word can post a large G² on a small proportional difference. Read G² as
    "how confident are we this differs" and log-ratio as "by how much".

    ``reference_tier`` defaults to every other tier pooled together. Rows are the
    target's over-used words (positive log-ratio), strongest first.
    """
    import math

    tgt_tokens = _flatten(corpus[corpus["engagement_tier"] == target_tier]["content_tokens"])
    if reference_tier is None:
        ref_rows = corpus[corpus["engagement_tier"] != target_tier]
        ref_label = "rest of corpus"
    else:
        ref_rows = corpus[corpus["engagement_tier"] == reference_tier]
        ref_label = reference_tier
    ref_tokens = _flatten(ref_rows["content_tokens"])

    tgt_counts, ref_counts = Counter(tgt_tokens), Counter(ref_tokens)
    c, d = len(tgt_tokens), len(ref_tokens)
    if c == 0 or d == 0:
        return pd.DataFrame(columns=_KEYNESS_COLUMNS)

    rows = []
    for word, a in tgt_counts.items():
        if a < min_freq:
            continue
        b = ref_counts.get(word, 0)
        e1 = c * (a + b) / (c + d)
        e2 = d * (a + b) / (c + d)
        g2 = 2 * ((a * math.log(a / e1) if a else 0.0) + (b * math.log(b / e2) if b else 0.0))
        # Normalised rates per tier; +0.5 smoothing keeps words absent from the
        # reference, where log ratio would otherwise be infinite and drop the word.
        rate_t, rate_r = a / c, (b + 0.5) / d
        if rate_t <= rate_r:          # keep only the target's over-used words
            continue
        rows.append({
            "Word": word,
            "Target freq": a,
            "Reference freq": b,
            "Log-likelihood": round(g2, 2),
            "Log ratio": round(math.log2(rate_t / rate_r), 2),
            "Reference": ref_label,
        })

    # Named columns even with no rows, so a tier that over-uses nothing still
    # answers df["Word"] with an empty list and findings can read it.
    df = pd.DataFrame(rows, columns=_KEYNESS_COLUMNS)
    if df.empty:
        return df
    return df.sort_values("Log-likelihood", ascending=False, kind="stable").head(top_n).reset_index(drop=True)


def keyness_all_tiers(
    corpus: pd.DataFrame, tiers: Sequence[str], top_n: int = 20, min_freq: int = 3
) -> dict[str, pd.DataFrame]:
    """Keyness for every tier against the rest of the corpus: ``{tier: DataFrame}``."""
    return {t: keyness(corpus, t, None, top_n=top_n, min_freq=min_freq) for t in tiers}


def top_ngrams(corpus: pd.DataFrame, n_size: int = 2, top_n: int = 20) -> pd.DataFrame:
    """Top-N bigrams (``n_size=2``) or trigrams (``n_size=3``)."""
    counts: Counter = Counter()
    for toks in corpus["content_tokens"]:
        grams = _text.bigrams(toks) if n_size == 2 else _text.trigrams(toks)
        counts.update(grams)
    rows = [{"Phrase": " ".join(g), "Frequency": f} for g, f in counts.most_common(top_n)]
    return pd.DataFrame(rows)


def cooccurring_hashtags(
    corpus: pd.DataFrame, query_hashtags: Sequence[str], top_n: int = 25
) -> pd.DataFrame:
    """Hashtags that co-occur with the seed tags, seeds themselves excluded."""
    excluded = {h.lower() for h in query_hashtags}
    counts: Counter = Counter()
    for tags in corpus["hashtag_list"]:
        for t in tags:
            tl = t.lower()
            if tl and tl not in excluded:
                counts[tl] += 1
    return pd.DataFrame(counts.most_common(top_n), columns=["Hashtag", "Frequency"])


def _theme_hits(tokens, lexicon_set) -> int:
    return sum(1 for t in tokens if t in lexicon_set)


def theme_counts(corpus: pd.DataFrame, config: Config, themes=None) -> pd.DataFrame:
    """Raw token hits per theme, per tier, with a Total column.

    ``themes`` defaults to the study's hand-built lexicons; pass a discovered
    ``{label: [words]}`` dict to score data-driven topics with the same logic.
    """
    tiers = config.tier_labels
    themes = config.themes if themes is None else themes
    rows = []
    for theme, words in themes.items():
        lex = set(words)
        row = {"Theme": theme}
        total = 0
        for tier in tiers:
            hits = corpus[corpus["engagement_tier"] == tier]["content_tokens"].apply(
                lambda toks: _theme_hits(toks, lex)
            ).sum()
            row[tier] = int(hits)
            total += int(hits)
        row["Total"] = total
        rows.append(row)
    return pd.DataFrame(rows)


def theme_shares(corpus: pd.DataFrame, config: Config, themes=None) -> pd.DataFrame:
    """Theme hits as a percentage of each tier's total content tokens.

    Sharing normalises for the fact that tiers can differ in total wordcount, so
    High against Low compares emphasis, with volume already accounted for. ``themes``
    defaults to the study lexicons; pass a discovered dict to chart topics.
    """
    tiers = config.tier_labels
    themes = config.themes if themes is None else themes
    totals = {
        tier: int(corpus[corpus["engagement_tier"] == tier]["content_tokens"].apply(len).sum())
        for tier in tiers
    }
    rows = []
    for theme, words in themes.items():
        lex = set(words)
        row = {"Theme": theme}
        for tier in tiers:
            hits = corpus[corpus["engagement_tier"] == tier]["content_tokens"].apply(
                lambda toks: _theme_hits(toks, lex)
            ).sum()
            denom = totals[tier]
            row[tier] = round((hits / denom) * 100, 2) if denom else 0.0
        rows.append(row)
    return pd.DataFrame(rows)


def analyze(corpus: pd.DataFrame, config: Config) -> dict[str, object]:
    """Run the full lexical suite and return every table in one dict.

    Keys: ``top_words``, ``top_words_by_tier``, ``keyness_by_tier``, ``bigrams``,
    ``trigrams``, ``cooccurring_hashtags``, ``theme_counts``, ``theme_shares``.
    """
    corpus = add_tokens(corpus, config)
    return {
        "corpus": corpus,
        "top_words": top_words(corpus, n=30),
        "top_words_by_tier": top_words_by_tier(corpus, config.tier_labels, n=20),
        "keyness_by_tier": keyness_all_tiers(corpus, config.tier_labels, top_n=20),
        "bigrams": top_ngrams(corpus, n_size=2, top_n=20),
        "trigrams": top_ngrams(corpus, n_size=3, top_n=15),
        "cooccurring_hashtags": cooccurring_hashtags(corpus, config.query_hashtags, top_n=25),
        "theme_counts": theme_counts(corpus, config),
        "theme_shares": theme_shares(corpus, config),
    }
