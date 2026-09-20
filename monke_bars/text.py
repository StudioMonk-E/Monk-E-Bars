"""Caption normalisation, tokenisation and stopwording.

This is the text-cleaning heart of the pipeline, lifted from the thesis notebook
and made reusable. The normalisation choices are deliberate and documented so the
method is auditable: hashtags and @mentions are stripped (they are analysed
separately), contractions are expanded before tokenising, and URLs, bracketed
content, punctuation and bare digits are removed.
"""

from __future__ import annotations

import re
from functools import lru_cache

import contractions
import nltk
from nltk.util import bigrams as _bigrams, trigrams as _trigrams

_NLTK_OK: "bool | None" = None
_WORD_RE = re.compile(r"[^\W\d_]+")  # runs of letters (Unicode), no digits/underscore


def ensure_nltk() -> bool:
    """Ensure the Punkt tokeniser is available; download it once if possible.

    Returns True if NLTK's word_tokenize can be used, False if we should fall
    back to the regex tokeniser (e.g. offline environments where the download is
    blocked). Result is cached so this is cheap to call repeatedly.
    """
    global _NLTK_OK
    if _NLTK_OK is not None:
        return _NLTK_OK
    for pkg in ("punkt", "punkt_tab"):
        try:
            nltk.data.find(f"tokenizers/{pkg}")
        except LookupError:
            try:
                nltk.download(pkg, quiet=True)
            except Exception:
                pass
    try:
        from nltk.tokenize import word_tokenize
        word_tokenize("probe test")
        _NLTK_OK = True
    except Exception:
        _NLTK_OK = False
    return _NLTK_OK


def _tokenize(text: str) -> list[str]:
    """Tokenise cleaned text. Uses NLTK Punkt when available, else a regex.

    By this point captions are already lowercased and stripped of punctuation and
    digits, so regex word-splitting matches Punkt's output on our inputs, the
    fallback keeps the tool working offline without changing results.
    """
    if ensure_nltk():
        from nltk.tokenize import word_tokenize
        try:
            return word_tokenize(text)
        except Exception:
            pass
    return _WORD_RE.findall(text)


# --- stopwords ----------------------------------------------------------

# Snowball English stopwords (http://snowball.tartarus.org/algorithms/english/stop.txt).
SNOWBALL_STOPWORDS = frozenset("""
i me my myself we our ours ourselves you your yours yourself yourselves he him his
himself she her hers herself it its itself they them their theirs themselves what
which who whom this that these those am is are was were be been being have has had
having do does did doing a an the and but if or because as until while of at by for
with about against between into through during before after above below to from up
down in out on off over under again further then once here there when where why how
all any both each few more most other some such no nor not only own same so than too
very s t can will just don should now
""".split())


@lru_cache(maxsize=32)
def _stopword_set(extra: tuple[str, ...], languages: tuple[str, ...]) -> frozenset:
    from .stopwords import for_languages
    base = for_languages(languages) if languages else SNOWBALL_STOPWORDS
    return base | frozenset(w.lower() for w in extra)


def build_stopwords(extra=None, languages=None) -> frozenset:
    """The stopword list for a study: its languages, plus its own extras.

    ``languages`` takes ISO codes and selects the matching lists from
    :mod:`monke_bars.stopwords`. Passing the wrong language is worse than passing
    none, because an English list over a Dutch corpus removes almost nothing and
    leaves a ranking of Dutch grammar looking like a finding.

    With no languages given it falls back to the built-in English list, which
    keeps every existing caller behaving exactly as before.
    """
    if isinstance(languages, str):
        languages = [languages]
    langs = tuple(sorted({str(c).lower() for c in (languages or []) if c}))
    return _stopword_set(tuple(sorted(extra or [])), langs)


# --- normalisation ------------------------------------------------------

_RE_HASHTAG = re.compile(r"#\w+")
_RE_MENTION = re.compile(r"@\w+")
_RE_URL = re.compile(r"http\S+")
_RE_BRACKETS = re.compile(r"\[.*?\]")
_RE_PUNCT = re.compile(r"[^\w\s]")
_RE_DIGITS = re.compile(r"\d+")


def normalize(caption: str) -> list[str]:
    """Normalise one caption into a list of word tokens.

    Lowercase -> strip hashtags/mentions/URLs -> expand contractions ->
    drop bracketed content, punctuation and digits -> tokenise.
    """
    if not isinstance(caption, str):
        return []
    text = caption.lower()
    text = _RE_HASHTAG.sub("", text)
    text = _RE_MENTION.sub("", text)
    text = _RE_URL.sub("", text)
    text = contractions.fix(text)
    text = _RE_BRACKETS.sub("", text)
    text = _RE_PUNCT.sub("", text)
    text = _RE_DIGITS.sub("", text)
    return _tokenize(text)


def content_tokens(caption: str, stopwords) -> list[str]:
    """Normalise then keep only non-stopword tokens of length > 1."""
    return [t for t in normalize(caption) if t not in stopwords and len(t) > 1]


def bigrams(tokens):
    return list(_bigrams(tokens))


def trigrams(tokens):
    return list(_trigrams(tokens))
