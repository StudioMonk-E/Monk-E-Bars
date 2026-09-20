"""Study configuration.

A *study* is one research question over one corpus: its seed hashtags, the
extra stopwords that count as noise for that topic, and the thematic lexicons
that operationalise its framework. Keeping all of that in a YAML file (instead
of hard-coded in a notebook) is what lets the same tool serve many case studies.

See ``configs/acai.yaml`` for a worked example and ``configs/template.yaml`` for
a blank, commented starting point.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import yaml


@dataclass
class ColorSettings:
    n_colors: int = 5          # dominant colours to extract per post
    max_posts: int = 200       # cap on media downloads (politeness + speed)
    resize: int = 200          # px longest side before clustering (speed)
    timeout: float = 10.0      # per-download timeout, seconds


@dataclass
class Config:
    """A validated study configuration."""

    name: str = "study"
    description: str = ""
    # The headline reading of this corpus, in the researcher's own words. The
    # tool never writes one: it generates the evidence beneath it and leaves the
    # interpretive claim to the person who can defend it. Optional.
    claim: str = ""
    # One ISO code, a list of them, or None to keep every language.
    language: Any = "en"
    tier_labels: list[str] = field(default_factory=lambda: ["High", "Medium", "Low"])
    query_hashtags: list[str] = field(default_factory=list)   # seeds, excluded from co-occurrence
    stopwords_extra: list[str] = field(default_factory=list)  # added to the built-in list
    themes: dict[str, list[str]] = field(default_factory=dict)  # layer -> word list
    color: ColorSettings = field(default_factory=ColorSettings)

    # -- date window (optional) ------------------------------------------
    since: Optional[str] = None     # keep posts published on or after this date
    until: Optional[str] = None     # keep posts published on or before this date

    # -- account-level study (optional) ----------------------------------
    # Present only for studies asking which accounts to approach. A corpus study
    # leaves them out and the pipeline ignores them.
    account_types: dict[str, Any] = field(default_factory=dict)   # type -> match spec | "default"
    include_types: list[str] = field(default_factory=list)        # types to keep in the list
    signals: dict[str, Any] = field(default_factory=dict)         # name -> signal spec
    min_signals: dict[str, int] = field(default_factory=dict)     # name -> minimum score
    min_engagement: int = 0                                       # on an account's best post
    # Named filter presets, e.g. "Influencers" -> {types, min_engagement, ...}.
    # A preset is a shortcut over the ordinary filters, and the rule stays visible
    # next to its name: a capture with no follower counts leaves the tool unable to
    # separate a creator from a private individual.
    audiences: dict[str, Any] = field(default_factory=dict)

    # -- construction ----------------------------------------------------

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Config":
        d = dict(d or {})
        color = ColorSettings(**(d.pop("color", {}) or {}))
        themes = {k: [str(w).lower() for w in v] for k, v in (d.get("themes") or {}).items()}
        return cls(
            name=d.get("name", "study"),
            description=d.get("description", ""),
            claim=(d.get("claim") or "").strip(),
            language=d.get("language", "en"),
            tier_labels=list(d.get("tier_labels") or ["High", "Medium", "Low"]),
            query_hashtags=[h.lower() for h in (d.get("query_hashtags") or [])],
            stopwords_extra=[w.lower() for w in (d.get("stopwords_extra") or [])],
            themes=themes,
            color=color,
            since=d.get("since"),
            until=d.get("until"),
            account_types=dict(d.get("account_types") or {}),
            include_types=list(d.get("include_types") or []),
            signals=dict(d.get("signals") or {}),
            min_signals={k: int(v) for k, v in (d.get("min_signals") or {}).items()},
            min_engagement=int(d.get("min_engagement") or 0),
            audiences=dict(d.get("audiences") or {}),
        )

    @property
    def is_account_study(self) -> bool:
        """True when this config asks about accounts as well as vocabulary."""
        return bool(self.account_types)

    def validate(self) -> "Config":
        problems = []
        if not self.name:
            problems.append("`name` is required.")
        if len(self.tier_labels) < 1:
            problems.append("`tier_labels` must list at least one tier.")
        for tag in self.query_hashtags:
            if not tag.startswith("#"):
                problems.append(f"query_hashtag '{tag}' should start with '#'.")
        if problems:
            raise ValueError("Invalid config:\n  - " + "\n  - ".join(problems))
        return self


def load_config(path: "str | Path") -> Config:
    """Load and validate a study config from a YAML file."""
    with open(path, encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return Config.from_dict(data).validate()
