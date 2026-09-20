"""Matplotlib chart helpers for the CLI and notebooks.

These draw the same charts the dashboard draws, on the same palette, so a PNG
committed to a study repo and a screenshot of the app are recognisably the same
instrument. Colours, tier order and the type stack all come from
:mod:`monke_bars.branding`, and none of it is restated here. A second palette
would drift from the first, which is worse than carrying no palette at all.

Each function returns a ``Figure`` so the caller decides whether to save it, show
it, or embed it.
"""

from __future__ import annotations

from typing import Optional, Sequence

import logging

import matplotlib
matplotlib.use("Agg")  # safe default for headless / CLI use
import matplotlib.pyplot as plt
from matplotlib import font_manager

from . import branding

# The studio faces are web fonts. The dashboard gets them from Google Fonts, but
# Matplotlib can only use what is installed on the machine, so a CLI run on a
# clean system falls back to DejaVu. That is fine and deliberate: the colours,
# ramp and layout still carry the identity. What is not fine is the wall of
# "findfont: Font family not found" warnings it printed for every label, so the
# fallback happens quietly.
logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)


def _installed(name: str) -> bool:
    try:
        return name in {f.name for f in font_manager.fontManager.ttflist}
    except Exception:
        return False


#: True when the studio faces are installed, so CLI charts match the app exactly.
#: Install Unbounded, Inter and IBM Plex Mono locally to turn this on.
HAVE_STUDIO_FONTS = all(_installed(n) for n in
                        ("Unbounded", "Inter", "IBM Plex Mono"))

# Ordered tiers reuse the one ramp at three densities, so they survive greyscale
# printing and colour vision deficiency. Same reasoning as the dashboard.
TIER_COLORS = dict(branding.TIER_COLORS)
_FALLBACK = [branding.ACCENT, branding.INK_60, branding.INK_35,
             branding.ACCENT_ALT["amber"], branding.ACCENT_ALT["sand"]]

# The display and mono faces, with fallbacks so a machine without them still
# still renders.
_DISPLAY = ["Unbounded", "DejaVu Sans", "sans-serif"]
_MONO = ["IBM Plex Mono", "DejaVu Sans Mono", "monospace"]
_BODY = ["Inter", "DejaVu Sans", "sans-serif"]


def _tier_color(tier: str, i: int) -> str:
    return TIER_COLORS.get(tier, _FALLBACK[i % len(_FALLBACK)])


def _style(fig, ax) -> None:
    """Put a figure on the studio ground with the right rules and type.

    Matplotlib defaults to a white canvas with a full box of grey spines, which
    on this identity reads as a different product. The ground is painted, the box
    is cut back to the two spines that carry meaning, and the grid sits behind
    the bars, underneath them.
    """
    fig.patch.set_facecolor(branding.PAPER)
    ax.set_facecolor(branding.PAPER)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(branding.INK)
        ax.spines[side].set_linewidth(1.6)
    ax.tick_params(colors=branding.MUTED, labelsize=9)
    for label in ax.get_xticklabels() + ax.get_yticklabels():
        label.set_fontfamily(_MONO)
    # `ax.title` is only the centred title. A title set with loc="left" or
    # loc="right" is a different Text object, so styling ax.title alone left
    # those two in Matplotlib's default near-black, invisible on this ground.
    for title in (ax.title, ax._left_title, ax._right_title):
        title.set_color(branding.INK)
        title.set_fontfamily(_DISPLAY)
        title.set_fontsize(20)
        title.set_fontweight("bold")
    ax.xaxis.label.set_color(branding.MUTED)
    ax.yaxis.label.set_color(branding.MUTED)
    ax.xaxis.label.set_fontfamily(_MONO)
    ax.yaxis.label.set_fontfamily(_MONO)
    ax.xaxis.label.set_fontsize(9)
    ax.yaxis.label.set_fontsize(9)
    ax.set_axisbelow(True)
    ax.grid(axis="x", color=branding.RULE, linewidth=0.8)


def bar_top_words(df, title: str, color: str = branding.ACCENT):
    """Horizontal bar chart of a Word/Frequency (or Hashtag/Phrase) table."""
    label_col = df.columns[0]
    value_col = df.columns[1]
    d = df.iloc[::-1].reset_index(drop=True)
    # Height follows the row count so labels never collide or get dropped.
    fig, ax = plt.subplots(figsize=(8, max(3.2, 0.32 * len(d))))
    ax.barh(d[label_col].astype(str), d[value_col], color=color)
    ax.set_title(title, loc="left", pad=14)
    ax.set_xlabel(str(value_col).lower())
    _style(fig, ax)
    ax.grid(axis="y", visible=False)
    fig.tight_layout()
    return fig


def grouped_theme_shares(share_df, tiers: Sequence[str]):
    """Grouped bar chart of theme vocabulary share (%) by tier."""
    themes = share_df["Theme"].tolist()
    x = range(len(themes))
    n = len(tiers)
    width = 0.8 / max(n, 1)
    fig, ax = plt.subplots(figsize=(10, 5.6))
    for i, tier in enumerate(tiers):
        offsets = [xi + (i - (n - 1) / 2) * width for xi in x]
        ax.bar(offsets, share_df[tier].tolist(), width,
               label=tier, color=_tier_color(tier, i))
    ax.set_title("Thematic vocabulary share by engagement tier", loc="left", pad=14)
    ax.set_ylabel("share of tier tokens (%)")
    ax.set_xticks(list(x))
    ax.set_xticklabels(themes, rotation=20, ha="right")
    _style(fig, ax)
    ax.grid(axis="x", visible=False)
    ax.grid(axis="y", color=branding.RULE, linewidth=0.8)
    legend = ax.legend(frameon=False, loc="upper right")
    for text in legend.get_texts():
        text.set_color(branding.INK)
        text.set_fontfamily(_MONO)
        text.set_fontsize(9)
    fig.tight_layout()
    return fig


def opposed_keyness(df_left, df_right, left_label: str, right_label: str,
                    value_col: str = "Log-likelihood"):
    """Two tiers facing each other across a spine, on one shared scale.

    The argument is the opposition, so both sides must be read against the same
    axis: drawn on separate scales, a small difference on one side would look
    like a large one. Gold against cobalt because they are complements, and the
    message here is contrast.
    """
    label_col = df_left.columns[0] if len(df_left.columns) else "Word"
    top = max(
        float(df_left[value_col].max()) if len(df_left) else 0.0,
        float(df_right[value_col].max()) if len(df_right) else 0.0,
    ) or 1.0
    rows = max(len(df_left), len(df_right), 1)
    fig, (ax_l, ax_r) = plt.subplots(
        1, 2, figsize=(11, max(3.2, 0.34 * rows)), sharey=False)

    for ax, df, colour, label, invert in (
        (ax_l, df_left, branding.ACCENT, left_label, True),
        (ax_r, df_right, branding.ACCENT_ALT["cobalt"], right_label, False),
    ):
        d = df.iloc[::-1].reset_index(drop=True)
        ax.barh(d[label_col].astype(str), d[value_col], color=colour)
        ax.set_xlim(0, top)
        ax.set_title(label, loc="right" if invert else "left", pad=12)
        ax.set_xlabel(value_col.lower())
        _style(fig, ax)
        ax.grid(axis="y", visible=False)
        if invert:
            ax.invert_xaxis()
            ax.yaxis.tick_right()
            ax.tick_params(axis="y", colors=branding.INK)
    fig.tight_layout()
    return fig


def palette_strip(palette, title: str):
    """Render a tier palette (list of {hex, weight}) as a proportional strip."""
    fig, ax = plt.subplots(figsize=(8, 1.7))
    left = 0.0
    for swatch in palette:
        w = swatch["weight"]
        ax.barh(0, w, left=left, height=1, color=swatch["hex"])
        if w > 0.06:
            # Label in whichever of the two inks the swatch can actually carry.
            ax.text(left + w / 2, 0, swatch["hex"], ha="center", va="center",
                    fontsize=8, fontfamily=_MONO,
                    color=_readable_on(swatch["hex"]))
        left += w
    ax.set_xlim(0, left or 1)
    ax.set_yticks([])
    ax.set_xticks([])
    fig.patch.set_facecolor(branding.PAPER)
    ax.set_facecolor(branding.PAPER)
    for side in ax.spines.values():
        side.set_color(branding.INK)
        side.set_linewidth(1.6)
    ax.set_title(title, loc="left", pad=12, color=branding.INK,
                 fontfamily=_DISPLAY, fontsize=20, fontweight="bold")
    fig.tight_layout()
    return fig


def _readable_on(hex_color: str) -> str:
    """Pick the ink that stays legible on a given swatch.

    A palette strip prints whatever colours the corpus produced, so a fixed label
    colour is guaranteed to fail on some of them.
    """
    h = hex_color.lstrip("#")
    try:
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return branding.INK
    channels = [(c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4)
                for c in (r, g, b)]
    luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    return branding.ON_ACCENT if luminance > 0.35 else branding.INK
