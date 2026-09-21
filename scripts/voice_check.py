#!/usr/bin/env python3
"""Check the repo's prose against the Studio Monk-E voice rules.

Run it before pushing:

    python scripts/voice_check.py            # fail on hard violations
    python scripts/voice_check.py --strict   # also fail on the house tics
    python scripts/voice_check.py --list     # show every rule and exit

Exit status is 0 when clean and 1 when anything failed, so this drops into a
git hook or a CI step unchanged.

Two classes of finding, deliberately separated.

**Violations** break a hard rule and always fail: em-dashes, direct reader
address, question hooks, exclamation marks, emoji. These are mechanical, and a
regex catches them reliably.

**Tics** are habits of phrasing that read as machine-written. The antithesis
("X, not Y" and its relatives) and the rhetorical triad are the two that keep
coming back. A regex cannot tell a rhetorical triad from a factual list of three
real things, so these are reported for a person to judge and only fail under
``--strict``.

The detector knows about its own false positives. CSS ``!important`` is not an
exclamation, a query string is not a question, and the stopword corpora in
monke_bars/stopwords.py contain the literal words "you" and "your" as data. Put
``# voice: ignore`` on a line to silence it anywhere else.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Files exempt from prose rules, with the reason each one is here.
EXEMPT_FILES = {
    # Word-list data. The English stopword corpora contain "you" and "your".
    "monke_bars/stopwords.py",
    # This file quotes every pattern it searches for, so it matches itself.
    "scripts/voice_check.py",
}

# Test fixtures are sample data, not prose: a caption reading "bowl!!" is the
# input a tokeniser is being checked against.
SKIP_DIRS = {".venv", "__pycache__", ".git", "node_modules", "runs",
             "media_cache", "tests", "design"}
SCAN_SUFFIXES = {".py", ".yaml", ".yml", ".md", ".js", ".mjs", ".html", ".css"}

# In these the prose is only part of each line: comments, string text and, in
# HTML, what sits between the tags. The operators around it are code, and "!x"
# or "a ? b : c" are not an exclamation or a question.
PARTIAL = {".js", ".mjs", ".html", ".css"}

PRAGMA = re.compile(r"(#|//)\s*voice:\s*ignore")

_STRING = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|`(?:[^`\\]|\\.)*`')
_INTERP = re.compile(r"\$\{[^{}]*\}")
_TAG = re.compile(r"<[^>]*>")


def _prose(line: str, suffix: str, in_block: bool) -> tuple[str, bool]:
    """The part of a code line that is prose, and whether a block comment is open.

    Line based and approximate, which suits a lint: a template literal spread
    over lines is read line by line, and its interpolations are dropped.
    """
    if suffix == ".html":
        return _TAG.sub(" ", line), False
    parts = []
    rest = line
    if in_block or rest.lstrip().startswith("/*") or rest.lstrip().startswith("*"):
        end = rest.find("*/")
        if end < 0:
            return rest, True
        parts.append(rest[:end])
        rest = rest[end + 2:]
        in_block = False
    if suffix == ".css":
        start = rest.find("/*")
        if start >= 0:
            end = rest.find("*/", start)
            parts.append(rest[start + 2:end if end >= 0 else None])
            in_block = end < 0
        return " ".join(parts), in_block
    code = rest
    while True:                      # interpolations hold code, innermost first
        stripped = _INTERP.sub(" ", code)
        if stripped == code:
            break
        code = stripped
    for m in _STRING.finditer(code):
        parts.append(m.group(0)[1:-1])
    comment = re.search(r"(?:^|\s|;)//(.*)$", _STRING.sub('""', code))
    if comment:
        parts.append(comment.group(1))
    return " ".join(parts), in_block


@dataclass
class Rule:
    name: str
    pattern: re.Pattern
    hard: bool
    note: str


RULES = [
    Rule("em-dash", re.compile(r"—"), True,
         "Use a comma, a colon or a full stop."),
    Rule("direct address", re.compile(r"\b(you|your|yours|yourself)\b", re.I), True,
         "Say what the thing does, without addressing a reader."),
    Rule("question hook", re.compile(r"\?"), True,
         "State it. A question aimed at the reader is a hook."),
    Rule("exclamation", re.compile(r"!"), True,
         "Never in prose or interface copy."),
    Rule("emoji", re.compile(r"[\U0001F300-\U0001FAFF☀-➿️]"), True,
         "Nowhere, tab icons and empty states included."),
    Rule("antithesis", re.compile(
        r"(,\s*not\b|\bnot\b[^.]{0,40}\bbut\b|\brather than\b|,\s*never\b|\binstead of\b)",
        re.I), False,
         "Rebuild the sentence so the contrast is not its shape."),
    Rule("rhetorical triad", re.compile(
        r"\b([\w'-]+(?:\s[\w'-]+){0,2}),\s([\w'-]+(?:\s[\w'-]+){0,2})\sand\s"
        r"([\w'-]+(?:\s[\w'-]+){0,2})\b"), False,
         "Three is a habit. A factual list of three real things is fine."),
]


# A line that is code rather than prose: a regex literal, a shebang, a URL.
_CODE_LINE = re.compile(r"(re\.compile|re\.match|re\.search|re\.sub|^#!|https?://)")


def _false_positive(rule: str, line: str) -> bool:
    """Known innocent matches, so the report stays worth reading.

    Every entry here was a real false positive on this repo. Guessing at others
    would hide genuine findings, so the list only grows when something concrete
    turns up.
    """
    if _CODE_LINE.search(line):
        return True
    if rule == "exclamation":
        # CSS priority, the not-equals operator, an HTML comment or doctype, and
        # regex lookarounds, which appear on the continuation lines of a long
        # pattern where the re.compile test above cannot see them.
        return any(tok in line for tok in ("!important", "!=", "<!", "(?!", "(?<!"))
    if rule == "question hook":
        # Regex quantifiers and groups.
        return any(tok in line for tok in ("?:", "?=", "?!", ".*?", ".+?", "\\?", "(?"))
    if rule == "direct address":
        # Proper nouns containing the word: TikTok's feed is called the For You
        # page, which is a product name and not an address to the reader.
        if re.search(r"For You page", line):
            return True
        # Sphinx cross-references, identifiers, and the stopword data block.
        return bool(re.search(r"(:func:|:mod:|:class:|_your|your_|\byours?elf\b\s+\w+\s+\w+)", line))
    return False


def scan(path: Path) -> list[tuple[int, Rule, str]]:
    rel = path.relative_to(ROOT).as_posix()
    if rel in EXEMPT_FILES:
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (UnicodeDecodeError, OSError):
        return []
    found = []
    in_block = False
    for n, raw in enumerate(lines, 1):
        if PRAGMA.search(raw):
            continue
        line = raw
        if path.suffix in PARTIAL:
            line, in_block = _prose(raw, path.suffix, in_block)
        for rule in RULES:
            if rule.pattern.search(line) and not _false_positive(rule.name, line):
                found.append((n, rule, raw.strip()[:88]))
    return found


def walk(root: Path):
    for p in sorted(root.rglob("*")):
        if p.is_dir() or p.suffix not in SCAN_SUFFIXES:
            continue
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        yield p


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Check prose against the studio voice rules.")
    ap.add_argument("paths", nargs="*", default=None,
                    help="files or directories to scan (default: the whole repo)")
    ap.add_argument("--strict", action="store_true",
                    help="fail on the house tics as well as the hard rules")
    ap.add_argument("--list", action="store_true", help="print the rules and exit")
    args = ap.parse_args(argv)

    if args.list:
        for r in RULES:
            print(f"{'FAIL  ' if r.hard else 'review'}  {r.name:18} {r.note}")
        return 0

    targets = [Path(p).resolve() for p in args.paths] if args.paths else [ROOT]
    files = []
    for t in targets:
        files.extend(walk(t) if t.is_dir() else [t])

    hard = soft = 0
    for path in files:
        hits = scan(path)
        if not hits:
            continue
        rel = path.relative_to(ROOT) if ROOT in path.parents or path == ROOT else path
        print(f"\n{rel}")
        for n, rule, line in hits:
            tag = "FAIL  " if rule.hard else "review"
            print(f"  {tag} L{n:<4} [{rule.name}] {line}")
            if rule.hard:
                hard += 1
            else:
                soft += 1

    print(f"\n{len(files)} files scanned.  "
          f"{hard} hard violation(s), {soft} tic(s) for review.")
    if hard:
        print("Hard violations break the voice rules and have to go.")
    if soft and not args.strict:
        print("Tics are reported only. Re-run with --strict to fail on them too.")
    return 1 if (hard or (soft and args.strict)) else 0


if __name__ == "__main__":
    sys.exit(main())
