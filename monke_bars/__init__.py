"""
Monk-E Bars
===========

A config-driven toolkit for the lexical, hashtag and colour analysis of
social-media posts scraped with Zeeschuimer.

Pipeline
--------
1. ``ingest``  : turn a platform's raw Zeeschuimer NDJSON into normalised PostRecords.
2. ``corpus``  : dedup, language-filter and rank posts into engagement tiers.
3. ``lexical`` : top words (overall + per tier), n-grams, hashtag co-occurrence,
                 and config-driven thematic lexicons.
4. ``color``   : download post media and extract dominant-colour palettes per tier.

Everything above the ingest adapters is platform-agnostic: a post is a post.
"""

from .config import Config, load_config
from .ingest import load_posts, ADAPTERS
from .corpus import build_corpus
from . import lexical, color, text

__version__ = "0.1.0"

__all__ = [
    "Config",
    "load_config",
    "load_posts",
    "ADAPTERS",
    "build_corpus",
    "lexical",
    "color",
    "text",
    "__version__",
]
