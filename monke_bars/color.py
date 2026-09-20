"""Colour analysis: dominant-colour palettes per post and per engagement tier.

The question this answers is a visual one: whether high-engagement content looks
different from low-engagement content. For each post the module downloads an image
or video thumbnail, clusters its pixels into a handful of dominant colours, then
aggregates those across a tier into a representative palette with average hue,
saturation and brightness.

Media URLs come straight from the Zeeschuimer scrape. Those CDN links expire, so
run colour analysis soon after scraping. Downloads are cached on disk so a second
run is fast, and every network or decoding failure is skipped gracefully, leaving
the batch to finish.
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import os
from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

from PIL import Image
from sklearn.cluster import KMeans

from .config import Config

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def rgb_to_hex(rgb) -> str:
    r, g, b = (int(max(0, min(255, round(v)))) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


# --- download -----------------------------------------------------------

def _cache_path(url: str, cache_dir: str) -> str:
    h = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    return os.path.join(cache_dir, f"{h}.img")


def download_image(url: str, cache_dir: Optional[str] = None, timeout: float = 10.0):
    """Return a PIL RGB image for a URL, or ``None`` on any failure. Cached on disk."""
    if not url:
        return None
    path = None
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        path = _cache_path(url, cache_dir)
        if os.path.exists(path):
            try:
                return Image.open(path).convert("RGB")
            except Exception:
                pass
    if requests is None:
        return None
    try:
        resp = requests.get(url, headers={"User-Agent": _UA}, timeout=timeout)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content)).convert("RGB")
        if path:
            try:
                img.save(path, format="PNG")
            except Exception:
                pass
        return img
    except Exception:
        return None


# --- per-image dominant colours ----------------------------------------

def dominant_colors(image, n_colors: int = 5, resize: int = 200):
    """Cluster an image's pixels into ``n_colors`` dominant colours.

    Returns a list of ``(hex, proportion, (r, g, b))`` sorted by proportion desc.
    """
    img = image.copy()
    img.thumbnail((resize, resize))
    pixels = np.asarray(img).reshape(-1, 3).astype(float)
    if len(pixels) == 0:
        return []
    k = int(min(n_colors, len(np.unique(pixels, axis=0))))
    if k < 1:
        return []
    km = KMeans(n_clusters=k, n_init=4, random_state=0).fit(pixels)
    labels = km.labels_
    counts = np.bincount(labels, minlength=k).astype(float)
    props = counts / counts.sum()
    out = []
    for centre, prop in zip(km.cluster_centers_, props):
        out.append((rgb_to_hex(centre), float(prop), tuple(centre)))
    out.sort(key=lambda t: t[1], reverse=True)
    return out


def _hsv_stats(rgb_weight_pairs):
    """Weighted average hue/saturation/value from (rgb, weight) pairs (rgb in 0-255)."""
    if not rgb_weight_pairs:
        return {"hue": None, "saturation": None, "brightness": None}
    hs, ss, vs, ws = 0.0, 0.0, 0.0, 0.0
    for (r, g, b), w in rgb_weight_pairs:
        h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
        hs += h * w; ss += s * w; vs += v * w; ws += w
    if ws == 0:
        return {"hue": None, "saturation": None, "brightness": None}
    return {
        "hue": round((hs / ws) * 360, 1),
        "saturation": round((ss / ws) * 100, 1),
        "brightness": round((vs / ws) * 100, 1),
    }


# --- corpus-level analysis ---------------------------------------------

@dataclass
class ColorResult:
    per_post: pd.DataFrame       # one row per (post, dominant colour)
    tier_palettes: dict          # tier -> list of {hex, weight}
    tier_stats: pd.DataFrame     # tier -> avg hue/saturation/brightness + n_posts
    n_downloaded: int
    n_attempted: int


def analyze_colors(
    corpus: pd.DataFrame,
    config: Config,
    cache_dir: str = "media_cache",
    progress=None,
) -> ColorResult:
    """Download post media and build per-post + per-tier colour palettes.

    ``progress`` is an optional callback ``(done, total)`` for UIs.
    """
    settings = config.color
    subset = corpus.head(settings.max_posts)
    rows = []
    n_downloaded = 0
    total = len(subset)

    for i, (_, post) in enumerate(subset.iterrows()):
        urls = post.get("media_urls", "")
        first = urls.split(" ")[0] if isinstance(urls, str) and urls else None
        if progress:
            progress(i + 1, total)
        if not first:
            continue
        img = download_image(first, cache_dir=cache_dir, timeout=settings.timeout)
        if img is None:
            continue
        n_downloaded += 1
        for hex_code, prop, rgb in dominant_colors(img, settings.n_colors, settings.resize):
            rows.append({
                "post_id": post["post_id"],
                "engagement_tier": post["engagement_tier"],
                "hex": hex_code,
                "proportion": round(prop, 4),
                "r": int(rgb[0]), "g": int(rgb[1]), "b": int(rgb[2]),
            })

    per_post = pd.DataFrame(rows)
    tier_palettes: dict = {}
    stats_rows = []

    for tier in config.tier_labels:
        tier_df = per_post[per_post["engagement_tier"] == tier] if not per_post.empty else per_post
        n_posts = subset[subset["engagement_tier"] == tier].shape[0]
        if per_post.empty or tier_df.empty:
            tier_palettes[tier] = []
            stats_rows.append({"Tier": tier, "n_posts": n_posts,
                               "hue": None, "saturation": None, "brightness": None})
            continue
        pairs = [((r["r"], r["g"], r["b"]), r["proportion"]) for _, r in tier_df.iterrows()]
        tier_palettes[tier] = _aggregate_palette(pairs, config.color.n_colors)
        stats = _hsv_stats(pairs)
        stats["Tier"] = tier
        stats["n_posts"] = n_posts
        stats_rows.append(stats)

    tier_stats = pd.DataFrame(stats_rows)[["Tier", "n_posts", "hue", "saturation", "brightness"]]
    return ColorResult(
        per_post=per_post,
        tier_palettes=tier_palettes,
        tier_stats=tier_stats,
        n_downloaded=n_downloaded,
        n_attempted=total,
    )


def _aggregate_palette(rgb_weight_pairs, n_colors: int):
    """Re-cluster a tier's weighted colour points into a representative palette.

    Returns a list of ``{"hex", "weight"}`` sorted by weight desc, where weight is
    the share of that colour cluster across the tier.
    """
    if not rgb_weight_pairs:
        return []
    pts = np.array([p for p, _ in rgb_weight_pairs], dtype=float)
    wts = np.array([w for _, w in rgb_weight_pairs], dtype=float)
    k = int(min(n_colors, len(np.unique(pts, axis=0))))
    if k < 1:
        return []
    km = KMeans(n_clusters=k, n_init=4, random_state=0).fit(pts, sample_weight=wts)
    labels = km.labels_
    cluster_w = np.zeros(k)
    for lbl, w in zip(labels, wts):
        cluster_w[lbl] += w
    cluster_w = cluster_w / cluster_w.sum()
    palette = [
        {"hex": rgb_to_hex(c), "weight": round(float(w), 4)}
        for c, w in zip(km.cluster_centers_, cluster_w)
    ]
    palette.sort(key=lambda d: d["weight"], reverse=True)
    return palette
