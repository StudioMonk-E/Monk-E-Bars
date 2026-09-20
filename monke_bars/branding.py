"""Monk-E Bars visual identity: the warm axis of the Studio Monk-E palette.

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


# --- CSS ----------------------------------------------------------------

_FONTS = ("https://fonts.googleapis.com/css2?"
          "family=Unbounded:wght@600;700;800"
          "&family=IBM+Plex+Mono:wght@400;500"
          "&family=Inter:wght@400;500;600&display=swap")


def _css(acc: str) -> str:
    return f"""
<style>
@import url('{_FONTS}');

/* ---- ground ---- */
.stApp {{ background: {PAPER}; }}
/* The grain is gone. It came from the paper identity, where tooth belonged,
   but an overlay blend over a saturated ground lightens and desaturates
   everything under it: measured against true swatches, the ground read
   lighter than #362304 and the gold duller than #e0b81f. Two chosen
   colours that never reach the screen is a worse loss than a texture. */
.block-container {{ position: relative; z-index: 1; padding-top: 2.2rem; max-width: 1180px; }}
[data-testid="stHeader"] {{ background: transparent; }}

/* ---- type ---- */
html, body, [class*="css"], .stMarkdown, p, span, div, label, input, textarea, select, button {{
    font-family: 'Inter', system-ui, sans-serif;
    color: {INK};
}}
h1, h2, h3, h4, h5 {{
    font-family: 'Unbounded', sans-serif !important; color: {INK};
}}
h1 {{ font-size: 49px !important; font-weight: 800 !important;
      letter-spacing: -0.02em; line-height: 1.0; margin: 0 0 8px; }}
h2 {{ font-size: 31px !important; font-weight: 700 !important;
      letter-spacing: -0.015em; line-height: 1.15; }}
h3 {{ font-size: 20px !important; font-weight: 700 !important; letter-spacing: -0.01em; }}
h4, h5 {{ font-size: 16px !important; font-weight: 600 !important; }}
p, li {{ color: {INK_TEXT_2}; }}
code, .mono {{ font-family: 'IBM Plex Mono', monospace; }}


/* ---- spacing ----
   Streamlit packs elements tightly by default, which reads as crowded once a
   page carries charts, tables and headings together. One vertical rhythm is set
   here so nothing has to be nudged case by case: sections breathe, a chart gets
   room on both sides of it, and a caption stays attached to what it describes
   while a caption stays attached to whatever it describes. */
[data-testid="stVerticalBlock"] {{ gap: 1.1rem; }}
.mb-section {{ margin-top: 3.4rem !important; }}
.mb-section + .mb-note {{ margin-top: 0.4rem; }}

/* A chart needs air, and more below than above: it sits under its own heading
   but must not collide with whatever follows. */
[data-testid="stVegaLiteChart"], .stVegaLiteChart, [data-testid="stAltairChart"] {{
    margin: 1.6rem 0 2.6rem;
}}
/* Two charts side by side were nearly touching down the middle. */
[data-testid="stHorizontalBlock"] {{ gap: 2.2rem; }}
[data-testid="stHorizontalBlock"] [data-testid="stVegaLiteChart"] {{ margin-bottom: 1.2rem; }}

[data-testid="stDataFrame"] {{ margin: 1.1rem 0 2.2rem; }}
[data-testid="stMetric"] {{ margin-bottom: 0.6rem; }}
[data-testid="stExpander"] {{ margin: 1.4rem 0 2.2rem; }}
.stSlider, .stSelectbox, .stMultiSelect {{ margin-bottom: 0.8rem; }}
.stDownloadButton {{ margin: 1.4rem 0 2.4rem; }}
.mb-band {{ margin-bottom: 1.2rem; }}
hr {{ margin: 2.6rem 0; }}

/* ---- nothing is rounded, rules are heavy ---- */
* {{ border-radius: 0 !important; }}

/* ---- metrics as cut panels ---- */
[data-testid="stMetric"] {{
    background: {PAPER_2}; border: 2px solid {INK}; padding: 14px 18px;
}}
[data-testid="stMetricValue"] {{
    font-family: 'Unbounded', sans-serif !important; font-size: 25px !important;
    font-weight: 700 !important; line-height: 1.15; color: {INK};
    /* A tier split reads "86/85/85", which is wide. Wrapping is better than the
       ellipsis Streamlit applies, which turned it into "86/8...". */
    white-space: normal; overflow-wrap: anywhere;
}}
/* Streamlit clips the value in an inner div with an ellipsis, which turned a
   perfectly good "23/23/23" into "23/23/...". Let it show and wrap. */
[data-testid="stMetricValue"] > div, [data-testid="stMetricLabel"] > div,
[data-testid="stMetricLabel"] p {{
    overflow: visible !important; text-overflow: clip !important;
    white-space: normal !important;
}}
[data-testid="stMetricLabel"] {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 10px !important;
    color: {MUTED}; text-transform: uppercase; letter-spacing: 0.08em;
    /* Full tracking clipped "framework layers" to "FRAMEWORK LAY" in a narrow
       column, so the label wraps across two lines. */
    white-space: normal; line-height: 1.35;
}}
[data-testid="stMetricLabel"] p {{ overflow: visible; font-family: 'IBM Plex Mono', monospace !important; }}

/* ---- tabs: cut blocks ----
   Streamlit renamed these from data-baseweb to data-testid; both are matched so
   the styling survives either version. */
.stTabs [role="tablist"] {{
    gap: 8px; border-bottom: 3px solid {INK}; padding-bottom: 0; margin-top: 12px;
}}
.stTabs [data-testid="stTab"], .stTabs [data-baseweb="tab"] {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.16em; color: {MUTED};
    background: transparent;
    border: 2px solid {RULE}; border-bottom: none; padding: 9px 18px; height: auto;
}}
.stTabs [data-testid="stTab"] p, .stTabs [data-baseweb="tab"] p {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.16em; color: inherit;
}}
.stTabs [aria-selected="true"] {{
    color: {PAPER} !important; background: {INK} !important; border-color: {INK} !important;
}}
.stTabs [aria-selected="true"] p {{ color: {PAPER} !important; }}
.stTabs [data-baseweb="tab-highlight"], .stTabs [data-baseweb="tab-border"] {{ display: none; }}

/* ---- sidebar ---- */
[data-testid="stSidebar"] {{ background: {PAPER_2}; border-right: 3px solid {INK}; }}
[data-testid="stSidebar"] .stMarkdown p {{ font-size: 13px; }}

/* ---- controls ---- */
.stButton > button {{
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.16em;
    background: {PAPER}; color: {INK}; border: 2px solid {INK}; padding: 12px 22px;
}}
.stButton > button:hover {{ background: {INK}; color: {PAPER}; border-color: {INK}; }}
/* The primary action is where the second ink belongs: gold carries it, and the
   dark ground colour reads on top at 9.12. */
.stButton > button[kind="primary"] {{ background: {acc}; color: {ON_ACCENT}; border: 2px solid {acc}; }}
.stButton > button[kind="primary"]:hover {{ background: {INK}; border-color: {INK}; color: {PAPER}; }}
.stDownloadButton > button {{
    font-family: 'IBM Plex Mono', monospace; background: {PAPER}; color: {INK};
    border: 2px solid {INK};
}}
/* Streamlit ships its own dark styling on the uploader's inner button, which the
   global ink colour turned into ink-on-ink. Restate the whole control. */
[data-testid="stFileUploaderDropzone"] {{
    background: {PAPER_2}; border: 3px dashed {INK}; padding: 22px 16px;
}}
[data-testid="stFileUploaderDropzone"] button {{
    background: {PAPER} !important; color: {INK} !important;
    border: 2px solid {INK} !important;
    font-family: 'IBM Plex Mono', monospace !important; font-size: 11px !important;
}}
[data-testid="stFileUploaderDropzone"] button:hover {{
    background: {INK} !important; color: {PAPER} !important;
}}
[data-testid="stFileUploaderDropzoneInstructions"] {{ color: {MUTED}; }}
[data-testid="stFileUploaderDropzoneInstructions"] * {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 13px;
}}
[data-testid="stFileUploaderFile"] * {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 13px; color: {INK};
}}
[data-baseweb="select"] > div, .stTextInput input, .stNumberInput input {{
    background: {PAPER_2}; border: 2px solid {INK} !important; font-family: 'IBM Plex Mono', monospace;
}}
[data-testid="stWidgetLabel"] p {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 13px; color: {MUTED};
}}

/* ---- sliders and checkboxes come in Streamlit red by default ---- */
[data-testid="stSlider"] [data-baseweb="slider"] div[role="slider"] {{
    background: {INK} !important; border: 2px solid {INK} !important;
    box-shadow: none !important;
}}
[data-testid="stSlider"] [data-baseweb="slider"] > div > div > div:first-child {{
    background: {acc} !important;
}}
[data-testid="stSlider"] [data-testid="stThumbValue"] {{
    color: {INK} !important; font-family: 'IBM Plex Mono', monospace !important;
    font-size: 11px !important; background: transparent;
}}
[data-testid="stSlider"] [data-testid="stTickBarMin"],
[data-testid="stSlider"] [data-testid="stTickBarMax"] {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 10px; color: {MUTED};
}}
[data-testid="stCheckbox"] [data-baseweb="checkbox"] span[aria-hidden="true"] {{
    background: {PAPER} !important; border: 2px solid {INK} !important;
}}
[data-testid="stCheckbox"] [data-baseweb="checkbox"] input:checked + span {{
    background: {INK} !important;
}}
[data-testid="stExpander"] details {{ border: 2px solid {INK}; background: {PAPER_2}; }}
[data-testid="stExpander"] summary {{
    font-family: 'IBM Plex Mono', monospace !important; font-size: 13px; color: {INK};
}}

/* ---- dataframes read as printed tables ---- */
[data-testid="stDataFrame"] {{ border: 2px solid {INK}; }}
[data-testid="stDataFrame"] * {{ font-family: 'IBM Plex Mono', monospace !important; font-size: 13px; }}

/* ---- callouts ---- */
[data-testid="stAlert"] {{ border: 2px solid {INK}; background: {PAPER_2}; }}
[data-testid="stAlert"] p {{ color: {INK_TEXT_2}; }}

hr {{ border: none; height: 3px; background: {INK}; margin: 30px 0; }}

/* ---- identity pieces ---- */
.mb-studio {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px;
              text-transform: uppercase; letter-spacing: 0.16em; color: {ACCENT}; }}
.mb-studio-note {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px;
                   color: {MUTED}; margin-left: 12px; letter-spacing: 0.1em; }}

.mb-rule {{ height: 7px; background: {INK}; margin: 22px 0 16px;
           clip-path: polygon(0% 0%, 100% 14%, 99.8% 100%, 0.2% 86%); }}
.mb-tagline {{ font-size: 20px; color: {INK_TEXT_2}; margin: 14px 0 0; max-width: 52ch; }}

.mb-chip {{ font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: {PAPER};
           background: {acc}; padding: 6px 13px; display: inline-block;
           clip-path: polygon(0.8% 4%, 100% 0%, 99% 95%, 0% 100%); }}
.mb-meta {{ font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: {MUTED}; padding: 6px 13px; }}

.mb-marker {{ display: inline-block; width: 18px; height: 18px; background: {acc};
             clip-path: polygon(4% 0%, 100% 6%, 94% 100%, 0% 93%); margin-right: 12px;
             vertical-align: -3px; }}
.mb-section {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.03em;
              margin: 40px 0 4px; }}
.mb-note {{ font-family: 'Inter', sans-serif; font-size: 13px; line-height: 1.6;
           color: {MUTED}; max-width: 74ch; }}

.mb-tag {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: {PAPER};
          background: {INK}; padding: 6px 13px; display: inline-block;
          clip-path: polygon(1% 6%, 100% 0%, 99% 94%, 0% 100%); }}

.mb-claim {{ display: flex; gap: 0; margin: 22px 0 0; }}
.mb-claim .bar {{ flex: none; width: 11px; background: {acc}; }}
.mb-claim .body {{ padding-left: 24px; }}
.mb-claim .q {{ font-family: 'Unbounded', sans-serif; font-weight: 700; letter-spacing: -0.015em; font-size: 31px; line-height: 1.08;
               letter-spacing: -0.02em; max-width: 24ch; color: {INK}; }}
.mb-claim .src {{ font-family: 'IBM Plex Mono', monospace; font-size: 13px; color: {MUTED}; margin-top: 12px; }}

.mb-evidence li {{ padding: 12px 0; border-bottom: 1px solid {RULE}; font-size: 16px;
                  color: {INK_TEXT_2}; list-style: none; max-width: 88ch; }}
.mb-evidence ul {{ margin: 14px 0 0; padding: 0; }}
.mb-evidence b {{ color: {INK}; }}

.mb-band {{ display: flex; align-items: center; gap: 12px; padding: 11px 16px;
           background: {acc}; border: 2px solid {INK}; margin-top: 14px; }}
.mb-band .k {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: {PAPER}; }}
.mb-band .v {{ font-size: 13px; color: {ON_ACCENT}; }}

.mb-foot {{ display: flex; justify-content: space-between; align-items: center; gap: 24px;
           padding: 20px 0 40px; flex-wrap: wrap; border-top: 3px solid {INK}; margin-top: 44px; }}
.mb-foot .r {{ font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: {MUTED}; }}
</style>
"""


def inject_css(st, accent_name: str = "violet") -> None:
    """Apply the Monk-E Bars identity to a Streamlit page."""
    st.markdown(_css(accent(accent_name)), unsafe_allow_html=True)


def imprint(st, note: str = "an instrument under the studio", sidebar: bool = False) -> None:
    """The studio's name signing the page, set in type.

    This used to draw a two-tone chip standing in for a wordmark that was never
    drawn, which is the kind of placeholder that quietly becomes permanent and
    reads as a logo to anyone who does not know it is fake. A name set in the
    studio's own mono face says the same thing and claims nothing. When a real
    wordmark exists, it belongs here.
    """
    target = st.sidebar if sidebar else st
    target.markdown(
        f'<div><span class="mb-studio">Studio Monk-E</span>'
        f'<span class="mb-studio-note">{note}</span></div>',
        unsafe_allow_html=True,
    )


def header(st, title: str = "Monk-E Bars",
           tagline: str = "Lexical, hashtag and colour analysis of scraped social posts.",
           meta: str = "") -> None:
    """Masthead: black on bare paper, as the painted mark is."""
    imprint(st)
    st.markdown(f"# {title}")
    st.markdown(f'<div class="mb-tagline">{tagline}</div>', unsafe_allow_html=True)
    st.markdown('<div class="mb-rule"></div>', unsafe_allow_html=True)
    if meta:
        st.markdown(meta, unsafe_allow_html=True)


def section(st, label: str, note: str = "") -> None:
    st.markdown(
        f'<div class="mb-section"><span class="mb-marker"></span>{label.upper()}</div>'
        + (f'<div class="mb-note">{note}</div>' if note else ""),
        unsafe_allow_html=True,
    )


def footer(st) -> None:
    st.markdown(
        '<div class="mb-foot">'
        '<div><span class="mb-studio">Studio Monk-E</span></div>'
        '<div class="r">monk-e bars &nbsp;/&nbsp; open source &nbsp;/&nbsp; MIT</div>'
        '</div>',
        unsafe_allow_html=True,
    )


# --- charts -------------------------------------------------------------

def _axis(alt):
    return dict(
        labelColor=MUTED, titleColor=MUTED, tickColor=INK,
        domainColor=INK, gridColor=RULE,
        labelFont="IBM Plex Mono", titleFont="IBM Plex Mono",
        labelFontSize=11, titleFontSize=11,
    )


def bar(df, x_col: str, y_col: str, color: str = INK, height: int = 320):
    """A single-series bar chart. Square corners, ink fill."""
    import altair as alt
    ax = _axis(alt)
    return (
        alt.Chart(df).mark_bar(color=color)
        .encode(
            x=alt.X(f"{x_col}:N", sort="-y", axis=alt.Axis(labelAngle=-45, title=None, **ax)),
            y=alt.Y(f"{y_col}:Q", axis=alt.Axis(title=None, **ax)),
            tooltip=[x_col, y_col],
        )
        .properties(height=height, background="transparent")
        .configure_view(strokeWidth=0)
    )


def hbar(df, label_col: str, value_col: str, color: str = INK,
         height: int | None = None, tooltip=None, domain=None):
    """A horizontal ranked bar chart.

    Height scales with the row count: at a fixed height Vega thins the axis to
    every other tick once bars get dense, silently leaving half the words
    unlabelled. ``labelOverlap=False`` keeps every one.

    ``domain`` fixes the value axis to a given ``[low, high]``. Pass the same one
    to two charts that will be read side by side: left to themselves they each
    scale to their own maximum, so equal-looking bars can stand for values an
    order of magnitude apart, and a comparison drawn that way argues the opposite
    of what the numbers say.
    """
    import altair as alt
    ax = _axis(alt)
    if height is None:
        height = max(240, 24 * max(len(df), 1))
    x_scale = alt.Scale(domain=list(domain)) if domain is not None else alt.Undefined
    return (
        alt.Chart(df).mark_bar(color=color)
        .encode(
            y=alt.Y(f"{label_col}:N", sort="-x",
                    axis=alt.Axis(title=None, labelOverlap=False, labelLimit=180,
                                  labelFont="Inter", labelFontSize=13,
                                  labelColor=INK, tickColor=INK, domainColor=INK,
                                  gridColor=RULE, titleColor=MUTED, titleFont="IBM Plex Mono")),
            x=alt.X(f"{value_col}:Q", scale=x_scale,
                    axis=alt.Axis(title=value_col, **ax)),
            tooltip=tooltip or [label_col, value_col],
        )
        .properties(height=height, background="transparent")
        .configure_view(strokeWidth=0)
    )


def opposed(df_left, df_right, label_col: str, value_col: str,
            left_color: str = ACCENT, right_color: str = ACCENT_ALT["cobalt"],
            height: int | None = None):
    """Two tiers facing each other across a spine, on one shared scale.

    This is the signature view: the argument is the opposition, so the sides
    must be directly comparable. Position and the panel headings carry the
    distinction, which is why equal visual weight either side is correct.
    """
    import altair as alt
    import pandas as pd
    ax = _axis(alt)
    if height is None:
        height = max(240, 26 * max(len(df_left), len(df_right), 1))
    top = float(max(
        df_left[value_col].max() if len(df_left) else 0,
        df_right[value_col].max() if len(df_right) else 0,
    )) or 1.0

    def side(df, color, reverse):
        return (
            alt.Chart(df).mark_bar(color=color)
            .encode(
                y=alt.Y(f"{label_col}:N", sort="-x",
                        axis=alt.Axis(title=None, labelOverlap=False, labelLimit=150,
                                      orient="right" if reverse else "left",
                                      labelFont="Inter", labelFontSize=13,
                                      labelColor=INK, tickColor=INK, domainColor=INK,
                                      gridColor=RULE)),
                x=alt.X(f"{value_col}:Q",
                        scale=alt.Scale(domain=[0, top], reverse=reverse),
                        axis=alt.Axis(title=value_col, **ax)),
                tooltip=[label_col, value_col],
            )
            # Background belongs to the concatenated chart: Altair rejects it on
            # an hconcat sub-chart.
            .properties(height=height, width=340)
        )

    return alt.hconcat(
        side(df_left, left_color, True), side(df_right, right_color, False),
        spacing=14, background="transparent",
    ).configure_view(strokeWidth=0)


def stacked_tiers(df_long, x_col: str, y_col: str, tier_col: str, tier_labels, height: int = 340):
    """Value split across engagement tiers, drawn in the ink ramp, High->Low."""
    import altair as alt
    ax = _axis(alt)
    order = list(tier_labels)
    return (
        alt.Chart(df_long).mark_bar()
        .encode(
            x=alt.X(f"{x_col}:N", sort=None,
                    axis=alt.Axis(labelAngle=-30, title=None, labelFont="Inter",
                                  labelFontSize=13, labelColor=INK, tickColor=INK,
                                  domainColor=INK, gridColor=RULE)),
            y=alt.Y(f"{y_col}:Q", stack=True,
                    axis=alt.Axis(title="share of tier tokens (%)", **ax)),
            color=alt.Color(f"{tier_col}:N", sort=order,
                            scale=alt.Scale(domain=order, range=tier_range(order)),
                            legend=alt.Legend(title=None, labelColor=INK,
                                              labelFont="IBM Plex Mono", labelFontSize=11,
                                              orient="top")),
            order=alt.Order(f"{tier_col}:N", sort="ascending"),
            tooltip=[x_col, tier_col, y_col],
        )
        .properties(height=height, background="transparent")
        .configure_view(strokeWidth=0)
    )
