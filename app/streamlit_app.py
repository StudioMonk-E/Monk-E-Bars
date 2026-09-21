"""Monk-E Bars.

Run from the repo root:
    pip install -e ".[app]"
    streamlit run app/streamlit_app.py

Drop a Zeeschuimer capture or a spreadsheet and the analysis follows. The platform
is read out of the file, so nothing has to be chosen before there are results.

Two views. The Report argues: it opens on what the corpus shows, with the authored
reading and the generated evidence kept visibly apart. The Workbench is where the
corpus gets handled: the tables, the controls, the exports.
"""

from __future__ import annotations

import hashlib
import os
import sys
import tempfile
from pathlib import Path

import pandas as pd
import streamlit as st
import yaml

# Importable when run as `streamlit run app/streamlit_app.py`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from monke_bars.config import Config
from monke_bars.corpus import (build_corpus, language_counts, filter_languages,
                               filter_dates, retier)
from monke_bars.detect import detect
from monke_bars.ingest import load_auto, read_table, guess_mapping
from monke_bars import (lexical, color as color_mod, branding, topics, findings,
                        accounts as accounts_mod, export)

# A drawn mark. The house rules bar emoji everywhere, tab icons included, and a
# stand-in glyph is the kind of placeholder that lasts.
_ICON = Path(__file__).resolve().parent / "static" / "icon.png"
st.set_page_config(page_title="Monk-E Bars", layout="wide",
                   page_icon=str(_ICON) if _ICON.exists() else None)
branding.inject_css(st)

CONFIG_DIR = Path(__file__).resolve().parent.parent / "configs"

# A hosted container starts with no NLTK data and an empty disk, so the tokeniser
# fetch would otherwise run inside the first analysis and look like a hang.
# Warming it here moves the wait to startup, and a failure is harmless because
# the regex tokeniser takes over.
@st.cache_resource(show_spinner=False)
def _warm_tokeniser() -> bool:
    from monke_bars.text import ensure_nltk
    try:
        return ensure_nltk()
    except Exception:
        return False


_warm_tokeniser()

# Language detection runs at roughly a second per hundred posts on a laptop and
# slower on a shared instance, so a hosted copy caps the corpus and says so.
# Unset it to lift the cap when running locally.
MAX_POSTS = int(os.environ.get("MONKE_BARS_MAX_POSTS", "0")) or None
ACCEPTED = ["ndjson", "jsonl", "json", "csv", "tsv", "xlsx", "xls"]


# --- helpers ------------------------------------------------------------

def fingerprint(uploads) -> str:
    """A stable id for a set of uploads, taken from their contents.

    Streamlit hands back the same bytes on every rerun but nothing that
    identifies them, so anything cached against an upload needs an id derived
    from the data itself.
    """
    h = hashlib.sha1()
    for up in uploads:
        h.update(up.name.encode("utf-8"))
        h.update(up.getvalue())
    return h.hexdigest()[:16]


@st.cache_data(show_spinner=False, max_entries=2)
def spill(fp: str, _uploads) -> list[str]:
    """Write uploads to disk so detection and the adapters can read real files.

    Cached on the fingerprint, so one capture lands in one directory and keeps
    the same paths for as long as it is being worked on.
    """
    paths = []
    tmp = tempfile.mkdtemp(prefix=f"monke-bars-{fp}-")
    for up in _uploads:
        path = os.path.join(tmp, up.name)
        with open(path, "wb") as fh:
            fh.write(up.getvalue())
        paths.append(path)
    return paths


def emphasis_to_html(text: str) -> str:
    """Render a finding's ``*word*`` emphasis as HTML.

    findings.py writes plain text with markdown emphasis, which suits the CLI and
    any other consumer. The Report injects those lines as raw HTML, where markdown
    is never parsed, so the asterisks would otherwise print literally.
    """
    import html as _html
    import re as _re
    return _re.sub(r"\*([^*]+)\*", r"<b>\1</b>", _html.escape(text))


def palette_html(palette) -> str:
    if not palette:
        return "<em>no colour data</em>"
    cells = "".join(
        f"<div style='flex:{sw['weight']:.4f};background:{sw['hex']};height:52px;"
        f"display:flex;align-items:center;justify-content:center;color:{branding.ON_ACCENT};"
        f"font-family:IBM Plex Mono,monospace;font-size:11px;"
        f"text-shadow:0 0 3px #000'>{sw['weight'] * 100:.0f}%</div>"
        for sw in palette
    )
    return f"<div style='display:flex;width:100%;border:2px solid #F5F0E8'>{cells}</div>"


def load_config_choice(choice, uploaded):
    try:
        if choice == "Upload my own":
            if uploaded is None:
                return None
            data = yaml.safe_load(uploaded.getvalue().decode("utf-8")) or {}
        else:
            data = yaml.safe_load((CONFIG_DIR / choice).read_text(encoding="utf-8")) or {}
        return Config.from_dict(data).validate()
    except Exception as exc:
        st.sidebar.error(f"Config problem: {exc}")
        return None


def render_discovery(corpus_tok, config, key: str):
    """Topics modelled from the vocabulary, for a corpus with no framework."""
    n = st.slider("Topics to model", 3, 10, 5, key=f"{key}_n")
    if st.button("Model topics", key=f"{key}_go"):
        with st.spinner("Modelling"):
            discovered, table = topics.discover_themes(corpus_tok, n_topics=n)
        if not discovered:
            st.warning("Not enough text in this corpus to model topics.")
            return
        shares = lexical.theme_shares(corpus_tok, config, themes=discovered)
        long = shares.melt(id_vars="Theme", value_vars=config.tier_labels,
                           var_name="Tier", value_name="Share")
        st.altair_chart(
            branding.stacked_tiers(long, "Theme", "Share", "Tier", config.tier_labels),
            use_container_width=True,
        )
        st.markdown('<div class="mb-note">each topic is labelled by its top three words</div>',
                    unsafe_allow_html=True)
        st.dataframe(table, hide_index=True, use_container_width=True)


# --- sidebar ------------------------------------------------------------

branding.imprint(st, "the instrument", sidebar=True)
st.sidebar.markdown("### Monk-E Bars")

uploads = st.sidebar.file_uploader(
    "Capture or spreadsheet", type=ACCEPTED, accept_multiple_files=True,
)

bundled = sorted(p.name for p in CONFIG_DIR.glob("*.yaml")) if CONFIG_DIR.exists() else []
default_ix = bundled.index("generic.yaml") if "generic.yaml" in bundled else 0
config_choice = st.sidebar.selectbox("Study", bundled + ["Upload my own"], index=default_ix)
config_upload = None
if config_choice == "Upload my own":
    config_upload = st.sidebar.file_uploader("Study YAML", type=["yaml", "yml"], key="cfg")

with st.sidebar.expander("Refinements"):
    run_color = st.checkbox("Download media for colour", value=False)
    accent_name = st.selectbox("Second ink", ["gold", "amber", "sand", "cobalt"], index=0)

if accent_name != "gold":
    branding.inject_css(st, accent_name)

go = st.sidebar.button("Run analysis", type="primary")


# --- intake: the whole first screen -------------------------------------

if not uploads:
    branding.header(st)
    st.markdown(
        '<div style="border:3px dashed #F5F0E8;background:#472e05;padding:58px 36px;'
        'text-align:center;margin-top:26px">'
        '<div style="font-family:Unbounded,sans-serif;font-weight:700;'
        'font-size:clamp(22px,4.2vw,39px);letter-spacing:-0.02em;line-height:1.15">'
        'Drop a capture to begin</div>'
        '<div style="font-size:20px;color:#E8E0D2;margin-top:12px">'
        'The platform is read from the file. Nothing to choose first.</div>'
        '<div style="margin-top:24px;font-family:IBM Plex Mono,monospace;font-size:11px">'
        + "".join(
            f'<span style="background:#F5F0E8;color:{branding.ON_ACCENT};padding:5px 11px;margin:0 4px">{e}</span>'
            for e in ["ndjson", "jsonl", "csv", "tsv", "xlsx"]
        )
        + "</div></div>",
        unsafe_allow_html=True,
    )
    st.markdown(
        '<div class="mb-note" style="margin-top:22px;max-width:74ch;line-height:1.6">'
        'A spreadsheet needs only a column of post text. Likes, comments and dates are '
        'matched by name where they exist. Captures from two different platforms are '
        'refused in one analysis, because pooling them would rank two engagement scales '
        'against each other.</div>',
        unsafe_allow_html=True,
    )
    branding.footer(st)
    st.stop()


# --- what was dropped ---------------------------------------------------

fingerprint_ = fingerprint(uploads)
paths = spill(fingerprint_, uploads)
detections = [(p, detect(p)) for p in paths]

branding.header(st)
for p, d in detections:
    ok = d.ok
    mark = branding.ACCENT if d.kind == "table" else branding.INK
    st.markdown(
        f'<div style="display:flex;align-items:center;gap:14px;border:2px solid #F5F0E8;'
        f'background:#472e05;padding:12px 16px;margin-top:10px">'
        f'<span style="flex:none;width:14px;height:14px;background:{mark if ok else "#E8845A"}"></span>'
        f'<span style="font-size:16px;color:#E8E0D2">'
        f'<b style="font-family:IBM Plex Mono,monospace;color:#F5F0E8">{os.path.basename(p)}</b>'
        f' &nbsp;·&nbsp; {d.note}</span></div>',
        unsafe_allow_html=True,
    )

bad = [d for _, d in detections if not d.ok]
if bad:
    st.stop()

config = load_config_choice(config_choice, config_upload)
if config is None:
    st.warning("Choose a study, or upload one, to continue.")
    st.stop()

# Column mapping only matters for spreadsheets, and only once one is present.
mapping = {}
if any(d.kind == "table" for _, d in detections):
    tpath = next(p for p, d in detections if d.kind == "table")
    try:
        frame = read_table(tpath)
        guessed = guess_mapping(frame.columns)
        with st.expander("Columns matched in the spreadsheet"):
            cols = ["(none)"] + list(frame.columns)
            grid = st.columns(3)
            for i, field in enumerate(["caption_text", "like_count", "comment_count",
                                       "timestamp", "author_handle", "media_urls"]):
                with grid[i % 3]:
                    cur = guessed.get(field)
                    pick = st.selectbox(
                        field, cols,
                        index=cols.index(cur) if cur in cols else 0,
                        key=f"map_{field}",
                    )
                    if pick != "(none)":
                        mapping[field] = pick
    except Exception as exc:
        st.error(f"The spreadsheet could not be read: {exc}")
        st.stop()

if not go:
    st.markdown(
        '<div class="mb-note" style="margin-top:20px">Ready. Press Run analysis in the sidebar.</div>',
        unsafe_allow_html=True,
    )
    branding.footer(st)
    st.stop()


# --- run ----------------------------------------------------------------

# Keyed on what was uploaded, so a filter change reuses the work. Streamlit
# reruns this script on every interaction, and an earlier version keyed the cache
# on temporary file paths that `spill` regenerated each time. Every cache lookup
# missed, every filter change re-ran language detection, and the panel appeared
# to hang. The fingerprint is stable across reruns because it comes from the
# bytes rather than from where they happen to sit on disk.
@st.cache_data(show_spinner="Reading captions and detecting languages", max_entries=2)
def prepare(fp: str, tier_labels, max_posts, _paths, _mapping):
    """Parse, cap and build the corpus once per uploaded capture.

    Arguments prefixed with an underscore are excluded from the cache key by
    Streamlit, which is what lets the heavy objects ride along without being
    hashed on every rerun.
    """
    posts, label = load_auto(_paths, mapping=_mapping or None)
    raw_count = len(posts)
    capped = False
    if max_posts and raw_count > max_posts:
        posts = sorted(posts, key=lambda p: p.engagement_score, reverse=True)[:max_posts]
        capped = True
    corpus = build_corpus(posts, language=None, tier_labels=list(tier_labels))
    return corpus, label, raw_count, capped


try:
    full_corpus, source_label, raw_count, was_capped = prepare(
        fingerprint_, tuple(config.tier_labels), MAX_POSTS, paths, mapping)
except ValueError as exc:
    st.error(str(exc))
    st.stop()

if was_capped:
    st.warning(
        f"This instance reads the {MAX_POSTS} strongest posts of a capture, and "
        f"{raw_count} were supplied. Language detection is the limit. "
        f"Running the tool locally removes the cap."
    )

if full_corpus.empty:
    st.error("No posts survived deduplication.")
    st.stop()


# --- settings: what to keep ---------------------------------------------

branding.section(st, "Settings", "the corpus is read once; these filter it")

lang_table = language_counts(full_corpus)
present = list(lang_table["Language"])
lang_labels = {row.Language: f"{findings._lang_name(row.Language)} ({int(row.Posts)})"
               for row in lang_table.itertuples()}
study_langs = ([config.language] if isinstance(config.language, str)
               else list(config.language or []))
preset = [l for l in study_langs if l in present] or present

s1, s2, s3 = st.columns([2, 1, 1])
with s1:
    langs = st.multiselect(
        "Languages",
        options=present,
        default=preset,
        format_func=lambda c: lang_labels.get(c, c),
        help="Only the languages actually detected in this capture are offered.",
    )

dates = pd.to_datetime(full_corpus.get("timestamp"), utc=True, errors="coerce")
has_dates = dates.notna().any()
with s2:
    if has_dates:
        lo, hi = dates.min().date(), dates.max().date()
        # A study's `since` is written for its own corpus and can fall outside
        # what this capture covers. Streamlit raises on a value outside its
        # bounds, so the study date is clamped into range instead.
        start = lo
        if config.since:
            try:
                start = min(max(pd.Timestamp(config.since).date(), lo), hi)
            except (ValueError, TypeError):
                start = lo
        since_val = st.date_input("Posted from", value=start, min_value=lo, max_value=hi)
    else:
        lo = hi = since_val = None
        st.caption("No dates in this capture.")
with s3:
    if has_dates:
        until_val = st.date_input("Posted until", value=hi, min_value=lo, max_value=hi)
    else:
        until_val = None

corpus = filter_languages(full_corpus, langs or None)
corpus = filter_dates(corpus, since_val, until_val)
corpus = retier(corpus, config.tier_labels)

if corpus.empty:
    st.error("Nothing is left after these filters. Widen the languages or the dates.")
    st.stop()

# Keyed on the filter selection, so returning to a previous set of languages or
# dates costs nothing. Tokenising has to follow the selection rather than precede
# it, because the stopword list is chosen from the languages that survive: tokens
# built against every language and then filtered would differ from tokens built
# against the languages actually kept.
@st.cache_data(show_spinner="Reading the corpus", max_entries=6)
def analyse(fp: str, selection, study: str, raw: int, _corpus, _config):
    out = lexical.analyze(_corpus, _config)
    return out, findings.generate(out["corpus"], _config, raw_count=raw)


_selection = (tuple(sorted(langs or [])), str(since_val), str(until_val), len(corpus))
results, generated = analyse(fingerprint_, _selection, config.name, raw_count,
                             corpus, config)
corpus_tok = results["corpus"]

# An engagement score of zero everywhere means the tiers are meaningless. Say so
# so three tiers stop looking like a finding.
flat_engagement = int(corpus["engagement_score"].sum()) == 0

st.markdown(
    f'<div style="margin-top:6px"><span class="mb-chip">{config.name}</span>'
    f'<span class="mb-meta">{source_label} &nbsp;/&nbsp; {len(corpus)} posts '
    f'&nbsp;/&nbsp; {raw_count} records read</span></div>',
    unsafe_allow_html=True,
)

if flat_engagement:
    st.warning("Every post scores zero engagement, so the tiers carry no information. "
               "Map a likes or comments column, or read the vocabulary sections only.")

# st.tabs renders every tab on every rerun and hides the inactive ones in CSS,
# so all three views were being rebuilt and sent to the browser each time a
# filter moved. A segmented control renders only what is selected.
VIEW = st.segmented_control("View", ["REPORT", "ACCOUNTS", "WORKBENCH"],
                            default="REPORT", label_visibility="collapsed") or "REPORT"


# ===== REPORT ===========================================================
if VIEW == "REPORT":
    branding.section(st, "Finding")

    if config.claim:
        st.markdown(
            f'<div class="mb-claim"><div class="bar"></div><div class="body">'
            f'<div class="q">{config.claim}</div>'
            f'<div class="src">reading, authored &nbsp;/&nbsp; {config_choice}</div>'
            f'</div></div>',
            unsafe_allow_html=True,
        )
    else:
        st.markdown(
            '<div class="mb-note" style="margin-top:18px;max-width:74ch;line-height:1.6">'
            'No reading is authored for this study. The tool does not write one. '
            'A <code>claim:</code> line in the study file prints here, above the '
            'evidence, attributed to whoever wrote it.</div>',
            unsafe_allow_html=True,
        )

    st.markdown('<div style="margin-top:30px"><span class="mb-tag">GENERATED FROM THE CORPUS</span></div>',
                unsafe_allow_html=True)
    st.markdown(
        '<div class="mb-evidence"><ul>'
        + "".join(f"<li>{emphasis_to_html(f.text)}</li>" for f in generated)
        + "</ul></div>",
        unsafe_allow_html=True,
    )

    # --- the opposed reading
    tiers = config.tier_labels
    if len(tiers) >= 2 and not flat_engagement:
        hi, lo = tiers[0], tiers[-1]
        k_hi = lexical.keyness(corpus_tok, hi, lo, top_n=12)
        k_lo = lexical.keyness(corpus_tok, lo, hi, top_n=12)
        if not k_hi.empty or not k_lo.empty:
            branding.section(
                st, "Keyness",
                f"what separates {hi.lower()} from {lo.lower()} once frequency is controlled for",
            )
            a, b = st.columns(2)
            a.markdown(
                f'<div style="background:{branding.ACCENT};color:{branding.ON_ACCENT};padding:10px 16px;'
                f'font-family:IBM Plex Mono,monospace;font-size:11px;text-transform:uppercase;'
                f'letter-spacing:0.16em">{hi} engagement</div>',
                unsafe_allow_html=True)
            b.markdown(
                f'<div style="background:{branding.ACCENT_ALT["cobalt"]};color:{branding.ON_ACCENT};'
                f'padding:10px 16px;font-family:IBM Plex Mono,monospace;font-size:11px;'
                f'text-transform:uppercase;letter-spacing:0.16em">{lo} engagement</div>',
                unsafe_allow_html=True)
            _top = max(float(k_hi["Log-likelihood"].max()) if len(k_hi) else 0.0,
                       float(k_lo["Log-likelihood"].max()) if len(k_lo) else 0.0) or 1.0
            _shared = [0, _top]
            with a:
                if k_hi.empty:
                    st.markdown('<div class="mb-note">nothing distinctive at this end</div>',
                                unsafe_allow_html=True)
                else:
                    st.altair_chart(
                        branding.hbar(k_hi, "Word", "Log-likelihood",
                                      color=branding.ACCENT, domain=_shared,
                                      tooltip=["Word", "Log-likelihood", "Log ratio",
                                               "Target freq", "Reference freq"]),
                        use_container_width=True)
            with b:
                if k_lo.empty:
                    st.markdown('<div class="mb-note">nothing distinctive at this end</div>',
                                unsafe_allow_html=True)
                else:
                    st.altair_chart(
                        branding.hbar(k_lo, "Word", "Log-likelihood",
                                      color=branding.ACCENT_ALT["cobalt"], domain=_shared,
                                      tooltip=["Word", "Log-likelihood", "Log ratio",
                                               "Target freq", "Reference freq"]),
                        use_container_width=True)
            st.markdown(
                '<div class="mb-note" style="margin-top:6px">log-likelihood ranks confidence '
                'the difference is real; log ratio is the size of it</div>',
                unsafe_allow_html=True)

    # --- corpus
    branding.section(st, "Corpus")
    m = st.columns(4)
    m[0].metric("posts analysed", len(corpus))
    m[1].metric("records read", raw_count)
    m[2].metric("tiers", "/".join(str(int((corpus["engagement_tier"] == t).sum()))
                                  for t in config.tier_labels))
    m[3].metric("framework layers", len(config.themes))

    # --- thematic layers
    branding.section(st, "Thematic layers")
    if config.themes:
        long = results["theme_shares"].melt(
            id_vars="Theme", value_vars=config.tier_labels, var_name="Tier", value_name="Share")
        st.altair_chart(
            branding.stacked_tiers(long, "Theme", "Share", "Tier", config.tier_labels),
            use_container_width=True)
        with st.expander("Cross-check against topics modelled from the data"):
            st.markdown(
                '<div class="mb-note">Dictionary counting finds what it was given. '
                'Modelling the vocabulary with no framework tests that.</div>',
                unsafe_allow_html=True)
            render_discovery(corpus_tok, config, key="crosscheck")
    else:
        st.markdown(
            '<div class="mb-note" style="max-width:74ch;line-height:1.6">'
            'No framework is defined for this study. Themes are a lens brought to a corpus, '
            'so add a <code>themes:</code> block to the study file, or model topics from the '
            'vocabulary below.</div>',
            unsafe_allow_html=True)
        render_discovery(corpus_tok, config, key="discover")

    # --- hashtags
    tags = results["cooccurring_hashtags"]
    if not tags.empty:
        branding.section(st, "Hashtags", "co-occurring with the seed tags, seeds excluded")
        st.markdown(
            '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">'
            + "".join(
                f'<span style="border:2px solid #F5F0E8;background:#472e05;padding:6px 12px;'
                f'font-size:16px">{r.Hashtag} <b style="font-family:IBM Plex Mono,monospace;'
                f'font-size:11px;color:{branding.accent(accent_name)}">{int(r.Frequency)}</b></span>'
                for r in tags.head(12).itertuples())
            + "</div>",
            unsafe_allow_html=True)

    # --- colour
    branding.section(st, "Colour")
    if not run_color:
        st.markdown(
            '<div class="mb-note" style="max-width:74ch;line-height:1.6">'
            'Colour was not part of this run. Media links captured by Zeeschuimer expire, so '
            'palettes are extracted close to the time of the scrape. Turn it on under '
            'Refinements to download and read them.</div>',
            unsafe_allow_html=True)
    else:
        prog = st.progress(0.0, text="Downloading media")
        cres = color_mod.analyze_colors(
            corpus_tok, config, cache_dir=tempfile.mkdtemp(),
            progress=lambda d, t: prog.progress(d / max(t, 1), text=f"media {d}/{t}"))
        prog.empty()
        st.markdown(f'<div class="mb-note">downloaded {cres.n_downloaded} of {cres.n_attempted}</div>',
                    unsafe_allow_html=True)
        if cres.per_post.empty:
            st.markdown(
                '<div class="mb-note">No media could be downloaded. Zeeschuimer links expire, '
                'so this needs a fresher capture.</div>', unsafe_allow_html=True)
        else:
            for tier in config.tier_labels:
                st.markdown(f'<div class="mb-note" style="margin-top:14px">{tier.lower()} tier</div>',
                            unsafe_allow_html=True)
                st.markdown(palette_html(cres.tier_palettes.get(tier, [])), unsafe_allow_html=True)
            st.dataframe(cres.tier_stats, hide_index=True, use_container_width=True)

    branding.footer(st)


# ===== ACCOUNTS =========================================================
# The other view asks how a topic is talked about. This one asks which accounts
# to look at, off the same corpus, and ends in a file someone works from.
if VIEW == "ACCOUNTS":
    branding.section(st, "Accounts", "one row per account, ranked by its strongest post")

    @st.cache_data(show_spinner="Rolling up accounts", max_entries=6)
    def _accounts(fp: str, selection, study: str, _corpus, _config):
        return accounts_mod.build_accounts(_corpus, _config)

    all_accounts = _accounts(fingerprint_, _selection, config.name, corpus_tok, config)

    if all_accounts.empty:
        st.warning("No accounts could be identified in this corpus.")
    else:
        types_present = sorted(all_accounts["account_type"].unique())
        presets = list((config.audiences or {}).keys())

        a1, a2, a3 = st.columns([2, 1, 1])
        with a1:
            default_types = [t for t in (config.include_types or types_present)
                             if t in types_present] or types_present
            want_types = st.multiselect("Account types", types_present,
                                        default=default_types)
        with a2:
            cap = int(all_accounts["best_engagement"].max())
            min_eng = st.slider("Minimum engagement", 0, max(cap, 1),
                                min(int(config.min_engagement or 0), cap), step=25)
        with a3:
            ver = st.selectbox("Verified", ["either", "verified only", "not verified"])

        # Signal thresholds stay available, because a study that defines one is
        # usually filtering on it.
        sig_mins = {}
        sig_cols = [c for c in all_accounts.columns if c.startswith("signal_")]
        if sig_cols:
            cols = st.columns(len(sig_cols))
            for col, c in zip(cols, sig_cols):
                name = c.replace("signal_", "")
                with col:
                    sig_mins[name] = st.slider(
                        f"Minimum {name} score", 0, 3,
                        int((config.min_signals or {}).get(name.capitalize(), 0)))

        active = {
            "types": want_types or None,
            "min_engagement": min_eng,
            "verified": {"either": None, "verified only": True,
                         "not verified": False}[ver],
            "min_signals": sig_mins,
        }
        scored = accounts_mod.apply_filters(all_accounts, **active)
        kept = accounts_mod.passing(all_accounts, **active)

        m1, m2, m3 = st.columns(3)
        m1.metric("accounts in list", len(kept))
        m2.metric("accounts found", len(all_accounts))
        m3.metric("types", len(types_present))

        if presets:
            st.markdown('<div class="mb-note">Presets from the study, with the rule each one applies:</div>',
                        unsafe_allow_html=True)
            for name in presets:
                st.markdown(
                    f'<div class="mb-note"><b>{name}</b> &nbsp;·&nbsp; '
                    f'{accounts_mod.describe_audience(config, name)}</div>',
                    unsafe_allow_html=True)

        show = [c for c in ("username", "account_type", "type_reason", "best_engagement",
                            "posts", "verified", "months_since_best") + tuple(sig_cols)
                if c in kept.columns]
        st.dataframe(kept[show] if not kept.empty else kept,
                     hide_index=True, use_container_width=True, height=420)

        st.markdown(
            '<div class="mb-note">Reach counts likes plus comments. '
            'This capture carries no follower counts, so a small account with one popular '
            'post can outrank a large one. Check followers by hand before '
            'acting on the top names. Account type is a keyword match on the handle and '
            'display name, so the type_reason column is there to be read.</div>',
            unsafe_allow_html=True)

        filters_for_file = dict(active)
        filters_for_file.update({"languages": langs, "since": since_val, "until": until_val})
        xl = export.accounts_workbook(kept, scored, config, filters_for_file,
                                      len(corpus), raw_count, platform=source_label)
        st.download_button(
            "Download the account list (Excel)", xl,
            file_name=f"{config.name}-accounts.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            type="primary")

        with st.expander(f"Left out ({int((scored['excluded_because'] != '').sum())})"):
            st.markdown('<div class="mb-note">A keyword classifier makes mistakes in both '
                        'directions. This is where they surface.</div>',
                        unsafe_allow_html=True)
            dropped = scored[scored["excluded_because"] != ""]
            st.dataframe(dropped[[c for c in ("username", "account_type", "type_reason",
                                              "best_engagement", "excluded_because")
                                  if c in dropped.columns]],
                         hide_index=True, use_container_width=True, height=300)

    branding.footer(st)


# ===== WORKBENCH ========================================================
if VIEW == "WORKBENCH":
    branding.section(st, "Workbench", "the tables, the controls, the exports")

    wb = st.tabs(["Keyness", "Words", "Phrases", "Hashtags", "Themes", "Corpus"])

    with wb[0]:
        if len(config.tier_labels) < 2:
            st.markdown('<div class="mb-note">keyness needs at least two tiers</div>',
                        unsafe_allow_html=True)
        else:
            c1, c2 = st.columns(2)
            target = c1.selectbox("Target tier", config.tier_labels, index=0, key="wb_t")
            refs = ["rest of corpus"] + [t for t in config.tier_labels if t != target]
            ref = c2.selectbox("Compared against", refs, key="wb_r")
            kdf = lexical.keyness(corpus_tok, target,
                                  None if ref == "rest of corpus" else ref, top_n=25)
            if kdf.empty:
                st.markdown('<div class="mb-note">not enough data in this tier</div>',
                            unsafe_allow_html=True)
            else:
                st.dataframe(kdf, hide_index=True, use_container_width=True)
                st.download_button("Download keyness (CSV)",
                                   kdf.to_csv(index=False).encode("utf-8-sig"),
                                   file_name=f"{config.name}_keyness_{target.lower()}.csv",
                                   mime="text/csv")

    with wb[1]:
        st.altair_chart(branding.bar(results["top_words"].head(20), "Word", "Frequency"),
                        use_container_width=True)
        cols = st.columns(len(config.tier_labels))
        for col, tier in zip(cols, config.tier_labels):
            with col:
                st.markdown(f'<div class="mb-note">{tier.lower()}</div>', unsafe_allow_html=True)
                st.dataframe(results["top_words_by_tier"][tier], hide_index=True,
                             use_container_width=True)

    with wb[2]:
        a, b = st.columns(2)
        with a:
            st.markdown('<div class="mb-note">bigrams</div>', unsafe_allow_html=True)
            st.dataframe(results["bigrams"], hide_index=True, use_container_width=True)
        with b:
            st.markdown('<div class="mb-note">trigrams</div>', unsafe_allow_html=True)
            st.dataframe(results["trigrams"], hide_index=True, use_container_width=True)

    with wb[3]:
        st.altair_chart(branding.bar(results["cooccurring_hashtags"].head(20),
                                     "Hashtag", "Frequency"), use_container_width=True)
        st.dataframe(results["cooccurring_hashtags"], hide_index=True, use_container_width=True)

    with wb[4]:
        if config.themes:
            st.dataframe(results["theme_counts"], hide_index=True, use_container_width=True)
            st.dataframe(results["theme_shares"], hide_index=True, use_container_width=True)
        else:
            st.markdown('<div class="mb-note">no framework in this study</div>',
                        unsafe_allow_html=True)

    with wb[5]:
        show = corpus_tok.drop(columns=["content_tokens"], errors="ignore")
        # The whole corpus reached about 900 KB of JSON on a 300-post capture,
        # and it crossed the wire on every interaction. A preview covers reading
        # it on screen, and the download covers having all of it.
        PREVIEW = 100
        st.dataframe(show.head(PREVIEW), use_container_width=True, height=460)
        if len(show) > PREVIEW:
            st.markdown(
                f'<div class="mb-note">Showing the first {PREVIEW} of {len(show)} rows. '
                f'The download holds every one.</div>', unsafe_allow_html=True)

        @st.cache_data(show_spinner=False, max_entries=2)
        def _corpus_csv(fp: str, selection, _df):
            return _df.to_csv(index=False).encode("utf-8-sig")

        st.download_button("Download corpus (CSV)",
                           _corpus_csv(fingerprint_, _selection, show),
                           file_name=f"{config.name}_corpus.csv", mime="text/csv")

    branding.footer(st)
