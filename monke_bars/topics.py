"""Data-driven theme discovery.

Hand-built theme lexicons (see :mod:`monke_bars.lexical`) encode a framework you
bring to a corpus. This module does the opposite: it reads the framework *out* of
the vocabulary, so a scrape on an untheorised topic still gets a first-pass set
of themes.

It fits a topic model (non-negative matrix factorisation over a TF-IDF matrix of
the cleaned captions) and returns each topic as a small word list, shaped exactly
like ``config.themes``. That means a discovered set drops straight into the same
``theme_shares`` / ``theme_counts`` machinery and the same tier chart, and can sit
beside a hand-built framework as a validity check.

scikit-learn only, no heavy embedding models, so it stays dependency-light and
deterministic (seeded).
"""

from __future__ import annotations

import pandas as pd


def _dominant_topic_counts(doc_topic, n_topics: int):
    import numpy as np
    if doc_topic.shape[0] == 0:
        return [0] * n_topics
    dominant = doc_topic.argmax(axis=1)
    return [int((dominant == k).sum()) for k in range(n_topics)]


def discover_themes(corpus, n_topics: int = 5, n_words: int = 10,
                    random_state: int = 0):
    """Discover ``n_topics`` themes from a corpus that already has ``content_tokens``.

    Returns ``(themes, table)`` where ``themes`` is a ``{label: [words]}`` dict in
    the same shape as ``config.themes`` (label is the topic's top three words), and
    ``table`` is a tidy DataFrame (Topic, Top words, Posts) for display. Returns
    ``({}, empty)`` when there is too little text to model.
    """
    from sklearn.decomposition import NMF
    from sklearn.feature_extraction.text import TfidfVectorizer

    docs = [" ".join(toks) for toks in corpus["content_tokens"] if toks]
    empty = pd.DataFrame(columns=["Topic", "Top words", "Posts"])
    if len(docs) < 3:
        return {}, empty

    # Suppress ubiquitous terms (max_df) so topics surface distinctive vocabulary
    # ahead of the corpus's dominant word; relax min_df on tiny corpora.
    min_df = 3 if len(docs) >= 25 else 1
    vec = TfidfVectorizer(min_df=min_df, max_df=0.4, token_pattern=r"(?u)\b\w\w+\b")
    try:
        dtm = vec.fit_transform(docs)
    except ValueError:
        return {}, empty
    vocab = vec.get_feature_names_out()
    if dtm.shape[1] < n_topics or len(vocab) == 0:
        return {}, empty

    k = int(min(n_topics, dtm.shape[0], dtm.shape[1]))
    model = NMF(n_components=k, init="nndsvda", random_state=random_state, max_iter=500)
    doc_topic = model.fit_transform(dtm)
    post_counts = _dominant_topic_counts(doc_topic, k)

    themes: dict[str, list[str]] = {}
    rows = []
    seen_labels: set[str] = set()
    for idx, comp in enumerate(model.components_):
        top_idx = comp.argsort()[::-1][:n_words]
        words = [vocab[i] for i in top_idx]
        label = " / ".join(words[:3])
        while label in seen_labels:      # keep labels unique for the chart axis
            label += " ·"
        seen_labels.add(label)
        themes[label] = words
        rows.append({"Topic": label, "Top words": ", ".join(words), "Posts": post_counts[idx]})

    table = pd.DataFrame(rows).sort_values("Posts", ascending=False).reset_index(drop=True)
    # Reorder the dict to match the table (most-loaded topic first)
    themes = {r["Topic"]: themes[r["Topic"]] for _, r in table.iterrows()}
    return themes, table
