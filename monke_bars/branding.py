"""Monk-E Bars palette: the warm axis of the Studio Monk-E system.

Gold on dark brown, which extends the studio system. Two measurements carry the
argument. The ground sits at 37 degrees hue and the accent at 48, putting them in
one hue family, and that family already runs through the studio in
``--mid-brown: #3D2B1F`` and ``--accent-orange: #C4582A``. Gold is also the complement of the studio's cobalt, so the cool
structural accent still opposes it cleanly wherever the two meet.

The printed character of the product is unchanged: blocks cut a fraction off
square, heavy rules in place of hairlines, nothing rounded, figures in a
typewriter face. The stock is what inverted. This is ink on a dark ground, so the
mark that does the writing is cream and the second colour is gold. The grain that once covered the surface is gone, because an
overlay blend was holding both anchor colours back from ever reaching the screen.

Ordered tiers still take one colour at three densities, which keeps High, Medium
and Low separable in greyscale and without colour vision.

Every ratio below is measured against the ground. One consequence is worth
stating: gold reaches 1.63 on the old paper ground and fails every threshold
there, so this palette required the stock to invert before an ink could change.

This module held the dashboard's stylesheet and its Altair charts until the
browser app replaced that surface. What remains is the palette itself, which
:mod:`monke_bars.viz` draws the command line's charts from. The browser app
carries the same values in ``web/css/app.css``, where they are the page's own
custom properties rather than a copy of these.
"""

from __future__ import annotations

# --- product palette ----------------------------------------------------
PAPER = "#362304"        # the ground, and one of the two anchor colours
PAPER_2 = "#472e05"      # panels sitting on the ground
INK = "#F5F0E8"          # 13.23 on the ground, all text, the high tier
INK_60 = "#C9BFAE"       #  8.25, medium tier, secondary text
INK_35 = "#9A8E7A"       #  4.66, low tier, still clears AA body
INK_TEXT_2 = "#E8E0D2"   # 11.45, body copy, a shade off the full cream
MUTED = "#C9BFAE"        #  8.25, small labels
RULE = "#654208"         # quiet divider between rows. Never behind text.
RULE_HARD = "#F5F0E8"    # the 2px rule that does the real dividing

ACCENT = "#e0b81f"       #  7.90, the second ink, and the other anchor
ON_ACCENT = "#251803"    #  9.12 against gold, text and icons sitting on a fill
ACCENT_ALT = {
    "gold": "#e0b81f",     # 7.90, shipped
    "amber": "#E8845A",    # 5.63, the studio orange lightened for this ground
    "sand": "#D9CBB0",     # 9.38
    # The studio's cool accent. Complementary to gold, so it is the right choice
    # wherever two things must read as opposed.
    "cobalt": "#4A9EFF",   # 5.45
}

# Tiers read High -> Medium -> Low as one ramp, brightest first.
TIER_COLORS = {"High": INK, "Medium": INK_60, "Low": INK_35}


def tier_range(tier_labels):
    """Ordered fill colours for the given tiers, extending the ramp if custom."""
    fallback = [INK, INK_60, INK_35, "#A89B8B", "#C0B6A8", "#D6CDBE"]
    return [TIER_COLORS.get(t, fallback[i % len(fallback)]) for i, t in enumerate(tier_labels)]


def accent(name: str = "violet") -> str:
    return ACCENT_ALT.get(name, ACCENT)
