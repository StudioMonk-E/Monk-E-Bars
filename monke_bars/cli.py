"""Command-line interface for Monk-E Bars.

Examples
--------
    monke-bars platforms
    monke-bars init configs/mystudy.yaml
    monke-bars analyze --platform instagram --config configs/acai.yaml \\
        --outdir runs/acai "#acaibowl_foryou.ndjson" "#açaíbowl_foryou.ndjson"
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from . import __version__
from .config import load_config
from .corpus import build_corpus
from .ingest import ADAPTERS, SUPPORTED, load_posts
from . import branding, lexical, color as color_mod, viz


def _cmd_platforms(args):
    print("Platforms:")
    for name in ADAPTERS:
        tag = "supported" if name in SUPPORTED else "scaffold (see docs/ROADMAP.md)"
        print(f"  - {name:<10} {tag}")


def _cmd_init(args):
    template = Path(__file__).resolve().parent.parent / "configs" / "template.yaml"
    dest = Path(args.dest)
    if dest.exists() and not args.force:
        sys.exit(f"{dest} already exists (use --force to overwrite).")
    dest.parent.mkdir(parents=True, exist_ok=True)
    if template.exists():
        shutil.copy(template, dest)
    else:  # installed without the configs dir alongside
        dest.write_text("name: mystudy\nlanguage: en\ntier_labels: [High, Medium, Low]\n"
                        "query_hashtags: []\nstopwords_extra: []\nthemes: {}\n", encoding="utf-8")
    print(f"Wrote study template to {dest}")


def _cmd_analyze(args):
    config = load_config(args.config)
    print(f"Study: {config.name}  |  platform: {args.platform}")

    posts = load_posts(args.platform, args.files)
    print(f"Loaded {len(posts)} raw posts from {len(args.files)} file(s).")

    corpus = build_corpus(
        posts, language=None if args.all_languages else config.language,
        tier_labels=config.tier_labels,
    )
    if corpus.empty:
        sys.exit("Corpus is empty after filtering. Check the platform/config/language.")
    print(f"Corpus: {len(corpus)} posts after dedup"
          + (f" + {config.language} filter" if not args.all_languages else "") + ".")

    results = lexical.analyze(corpus, config)

    outdir = Path(args.outdir)
    (outdir / "tables").mkdir(parents=True, exist_ok=True)
    (outdir / "charts").mkdir(parents=True, exist_ok=True)
    t = outdir / "tables"

    results["corpus"].drop(columns=["content_tokens"]).to_csv(
        t / "corpus_metadata.csv", index=False, encoding="utf-8-sig")
    results["top_words"].to_csv(t / "top_words_overall.csv", index=False, encoding="utf-8-sig")
    for tier, df in results["top_words_by_tier"].items():
        df.to_csv(t / f"top_words_{tier.lower()}.csv", index=False, encoding="utf-8-sig")
    for tier, df in results["keyness_by_tier"].items():
        df.to_csv(t / f"keyness_{tier.lower()}.csv", index=False, encoding="utf-8-sig")
    results["bigrams"].to_csv(t / "top_bigrams.csv", index=False, encoding="utf-8-sig")
    results["trigrams"].to_csv(t / "top_trigrams.csv", index=False, encoding="utf-8-sig")
    results["cooccurring_hashtags"].to_csv(t / "cooccurring_hashtags.csv", index=False, encoding="utf-8-sig")

    c = outdir / "charts"
    viz.bar_top_words(results["top_words"].head(20), f"Top words, {config.name}").savefig(c / "top_words_overall.png", dpi=120)
    viz.bar_top_words(results["cooccurring_hashtags"].head(20).rename(columns={"Hashtag": "Word"}),
                      "Co-occurring hashtags",
                      color=branding.ACCENT_ALT["cobalt"]).savefig(c / "cooccurring_hashtags.png", dpi=120)

    # Thematic layer: hand-built framework if defined, else data-driven discovery.
    if config.themes:
        results["theme_counts"].to_csv(t / "theme_counts.csv", index=False, encoding="utf-8-sig")
        results["theme_shares"].to_csv(t / "theme_shares.csv", index=False, encoding="utf-8-sig")
        viz.grouped_theme_shares(results["theme_shares"], config.tier_labels).savefig(c / "theme_shares.png", dpi=120)
    elif args.discover_themes:
        from . import topics
        discovered, table = topics.discover_themes(results["corpus"], n_topics=args.discover_themes)
        if discovered:
            table.to_csv(t / "discovered_topics.csv", index=False, encoding="utf-8-sig")
            shares = lexical.theme_shares(results["corpus"], config, themes=discovered)
            shares.to_csv(t / "discovered_topic_shares.csv", index=False, encoding="utf-8-sig")
            viz.grouped_theme_shares(shares, config.tier_labels).savefig(c / "discovered_topics.png", dpi=120)
            print(f"  discovered {len(discovered)} data-driven topics (no framework in config).")
    else:
        print("  no themes in config; skipping thematic layer (use --discover-themes N to model topics).")

    if not args.no_color:
        print("Colour analysis: downloading media (this can take a while)…")
        cres = color_mod.analyze_colors(corpus, config, cache_dir=str(outdir / "media_cache"))
        print(f"  media downloaded: {cres.n_downloaded}/{cres.n_attempted}")
        if not cres.per_post.empty:
            cres.per_post.to_csv(t / "colors_per_post.csv", index=False, encoding="utf-8-sig")
            cres.tier_stats.to_csv(t / "color_tier_stats.csv", index=False, encoding="utf-8-sig")
            for tier, pal in cres.tier_palettes.items():
                if pal:
                    viz.palette_strip(pal, f"{config.name}, {tier} tier palette").savefig(
                        c / f"palette_{tier.lower()}.png", dpi=120)
        else:
            print("  no media could be downloaded (CDN URLs may have expired).")

    print(f"\nDone. Tables in {t}/  Charts in {c}/")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="monke-bars", description="Lexical, hashtag and colour analysis of scraped social posts.")
    p.add_argument("--version", action="version", version=f"monke-bars {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("platforms", help="list supported platforms")
    sp.set_defaults(func=_cmd_platforms)

    si = sub.add_parser("init", help="write a blank study config")
    si.add_argument("dest", help="path for the new config, e.g. configs/mystudy.yaml")
    si.add_argument("--force", action="store_true")
    si.set_defaults(func=_cmd_init)

    sa = sub.add_parser("analyze", help="run the full pipeline on one or more NDJSON files")
    sa.add_argument("files", nargs="+", help="Zeeschuimer NDJSON file(s)")
    sa.add_argument("--platform", required=True, choices=list(ADAPTERS))
    sa.add_argument("--config", required=True, help="study YAML config")
    sa.add_argument("--outdir", default="runs/output", help="where to write tables + charts")
    sa.add_argument("--no-color", action="store_true", help="skip media download / colour analysis")
    sa.add_argument("--all-languages", action="store_true", help="do not filter by language")
    sa.add_argument("--discover-themes", type=int, metavar="N", default=0,
                    help="when the config has no themes, model N data-driven topics")
    sa.set_defaults(func=_cmd_analyze)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
