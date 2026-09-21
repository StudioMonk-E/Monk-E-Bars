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
from nltk.util import bigrams as _bigrams, trigrams as _trigrams

# Runs of letters in any script. Digits and underscores are excluded, which is
# what keeps a decorative "_____" line and a trailing "fotografie_" out of the
# vocabulary.
_WORD_RE = re.compile(r"[^\W\d_]+")


def ensure_nltk() -> bool:
    """Kept for callers that warm the tokeniser. Nothing needs downloading now."""
    return False


def _tokenize(text: str) -> list[str]:
    """Split cleaned text into word tokens with one deterministic regex.

    This used to prefer NLTK's Punkt tokeniser and fall back to the regex. Punkt
    kept underscores inside tokens, so "fotografie_" and "fotografie" counted as
    different words and a line of underscores counted as one, and it split
    "cannot" in two. By this point punctuation and digits are already gone, so
    Punkt had nothing left to contribute beyond those differences.

    On the thesis corpus the switch changes no count at all: the top thirty words
    and every figure behind them are identical. The browser version runs this
    same regex, which is what lets the two tools agree token for token, and no
    runtime download remains.
    """
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


# --- contractions --------------------------------------------------------

def _contraction_table() -> dict:
    """The mapping contractions.fix() applies, in the order the library adds it."""
    merged: dict = {}
    for table in (contractions.contractions_dict, contractions.leftovers_dict,
                  contractions.slang_dict):
        for k, v in table.items():
            merged[k.lower()] = v
    return merged


_CONTRACTIONS = _contraction_table()
# Longest first, so "shouldn't've" wins over "shouldn't". Bounded by anything
# that is not a word character in any script.
#
# The contractions library decides boundaries with an ASCII rule, so to it "ç"
# is not part of a word. In "cupuaçu", an Amazonian fruit and a relative of açaí,
# it saw the final "u" as the text-speak word "u" and rewrote the name as
# "cupuaçyou". Applying the library's own table with a Unicode boundary keeps
# every expansion it makes and stops it reaching inside words it cannot read.
_CONTRACTION_RE = re.compile(
    r"(?<![^\W])(?:"
    + "|".join(re.escape(k) for k in sorted(_CONTRACTIONS, key=len, reverse=True))
    + r")(?![^\W])"
)


def _expand_contractions(text: str) -> str:
    # Captions are lowercased before this step, and the library matches a
    # replacement's case to what it replaced, so every replacement is lowercase.
    return _CONTRACTION_RE.sub(lambda m: _CONTRACTIONS[m.group(0)].lower(), text)


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
    text = _expand_contractions(text)
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
