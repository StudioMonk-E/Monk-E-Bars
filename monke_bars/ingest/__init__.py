"""Ingestion layer: raw platform NDJSON -> normalised PostRecords."""

from __future__ import annotations

from typing import Iterable

from .base import Adapter, PostRecord
from .instagram import InstagramAdapter
from .tiktok import TikTokAdapter
from .twitter import TwitterAdapter
from .reddit import RedditAdapter
from .tabular import TabularAdapter, guess_mapping, read_table

# Registry: platform name -> adapter class. Add a platform here and the CLI,
# the dashboard and load_posts() all pick it up automatically.
ADAPTERS: dict[str, type[Adapter]] = {
    "instagram": InstagramAdapter,
    "tiktok": TikTokAdapter,
    "twitter": TwitterAdapter,   # scaffold
    "reddit": RedditAdapter,     # scaffold
}

# Platforms that are fully supported (as opposed to documented scaffolds).
SUPPORTED = ("instagram", "tiktok")


def get_adapter(platform: str) -> Adapter:
    key = platform.strip().lower()
    if key == "table":
        return TabularAdapter()
    if key not in ADAPTERS:
        raise ValueError(
            f"Unknown platform '{platform}'. Known: {', '.join(ADAPTERS)}, table."
        )
    return ADAPTERS[key]()


def load_auto(paths, mapping=None) -> tuple[list[PostRecord], str]:
    """Load files without being told what they are.

    Returns ``(records, label)`` where the label names what was detected, so the
    interface can report it back, leaving nothing to ask up front. Mixed
    platforms in one drop are rejected: pooling an Instagram and a TikTok capture
    into a single engagement ranking would compare two different scales.
    """
    from ..detect import detect

    if isinstance(paths, str):
        paths = [paths]
    paths = list(paths)
    kinds = {}
    for p in paths:
        d = detect(p)
        if not d.ok:
            raise ValueError(f"{p}: {d.note}")
        kinds[p] = d

    platforms = {(d.platform or "table") for d in kinds.values()}
    if len(platforms) > 1:
        raise ValueError(
            "These files are from different sources: "
            + ", ".join(sorted(platforms))
            + ". Analyse one source at a time so engagement stays comparable."
        )

    label = platforms.pop()
    adapter = TabularAdapter(mapping=mapping) if label == "table" else get_adapter(label)
    return adapter.load(paths), label


def load_posts(platform: str, paths: "str | Iterable[str]") -> list[PostRecord]:
    """Load one or more Zeeschuimer NDJSON files for a platform into PostRecords.

    Parameters
    ----------
    platform : str
        One of the keys in :data:`ADAPTERS` (e.g. ``"instagram"``, ``"tiktok"``).
    paths : str | Iterable[str]
        A single NDJSON path or a list of them (e.g. two hashtag feeds).
    """
    return get_adapter(platform).load(paths)


__all__ = [
    "Adapter",
    "PostRecord",
    "ADAPTERS",
    "SUPPORTED",
    "TabularAdapter",
    "guess_mapping",
    "read_table",
    "get_adapter",
    "load_posts",
    "load_auto",
    "InstagramAdapter",
    "TikTokAdapter",
    "TwitterAdapter",
    "RedditAdapter",
]
