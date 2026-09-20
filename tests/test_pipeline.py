"""Unit tests for the platform-agnostic core.

These use tiny synthetic records so they run offline and fast, and they lock in
the behaviour the thesis relies on: dedup, tiering, stopwording, theme counting
and the Instagram/TikTok field mappings.
"""

import json
import math

from monke_bars.config import Config
from monke_bars.corpus import assign_tiers, build_corpus
from monke_bars.ingest import get_adapter, load_posts
from monke_bars.ingest.base import PostRecord
from monke_bars import lexical, text


def _ig_record(pid, caption, likes, comments=0, code="abc"):
    return {
        "data": {
            "id": pid, "code": code, "media_type": 1,
            "caption": {"text": caption},
            "like_count": likes, "comment_count": comments,
            "taken_at": 1_700_000_000,
            "user": {"username": "u" + pid, "full_name": "User", "is_verified": False},
            "image_versions2": {"candidates": [{"url": "http://x/img.jpg", "width": 640, "height": 640}]},
        }
    }


def test_instagram_adapter_maps_fields():
    rec = _ig_record("1", "Best #acai bowl @brand in #brazil", 10, 2)
    post = get_adapter("instagram").parse_record(rec)
    assert post.platform == "instagram"
    assert post.like_count == 10 and post.comment_count == 2
    assert post.engagement_score == 12
    assert "#acai" in post.hashtags and "#brazil" in post.hashtags
    assert "@brand" in post.mentions
    assert post.media_urls == ["http://x/img.jpg"]
    assert post.url == "https://www.instagram.com/p/abc/"


def test_tiktok_adapter_maps_fields():
    rec = {"data": {
        "id": "99", "desc": "yummy #acaibowl", "createTime": 1_700_000_000,
        "author": {"uniqueId": "chef", "nickname": "Chef", "verified": True},
        "stats": {"diggCount": 50, "commentCount": 5, "shareCount": 3, "playCount": 900},
        "challenges": [{"title": "acaibowl"}],
        "video": {"cover": "http://x/cover.jpg"},
    }}
    post = get_adapter("tiktok").parse_record(rec)
    assert post.platform == "tiktok"
    assert post.like_count == 50 and post.share_count == 3 and post.view_count == 900
    assert post.author_verified is True
    assert "#acaibowl" in post.hashtags
    assert post.media_urls == ["http://x/cover.jpg"]


def test_assign_tiers_equal_thirds():
    labels = assign_tiers(9, ["High", "Medium", "Low"])
    assert labels[:3] == ["High"] * 3
    assert labels[3:6] == ["Medium"] * 3
    assert labels[6:] == ["Low"] * 3


def test_build_corpus_dedup_and_tier():
    posts = [
        get_adapter("instagram").parse_record(_ig_record("1", "acai bowl healthy breakfast", 100)),
        get_adapter("instagram").parse_record(_ig_record("1", "dup", 100)),   # duplicate id
        get_adapter("instagram").parse_record(_ig_record("2", "amazon rainforest brazil", 50)),
        get_adapter("instagram").parse_record(_ig_record("3", "follow share comment", 1)),
    ]
    corpus = build_corpus(posts, language=None, tier_labels=["High", "Medium", "Low"])
    assert len(corpus) == 3  # duplicate removed
    # highest engagement ranked first
    assert corpus.iloc[0]["post_id"] == "1"
    assert set(corpus["engagement_tier"]) <= {"High", "Medium", "Low"}


def test_normalization_and_stopwords():
    stop = text.build_stopwords(["yummy"])
    toks = text.content_tokens("I'm loving this #acai bowl!! http://x.co yummy 123", stop)
    assert "acai" not in toks       # hashtag stripped
    assert "yummy" not in toks      # extra stopword
    assert "http" not in toks and "123" not in toks
    assert "loving" in toks


def test_theme_counts_and_shares():
    cfg = Config.from_dict({
        "name": "t", "language": None, "tier_labels": ["High", "Low"],
        "themes": {"Nature": ["amazon", "rainforest", "brazil"], "Wellness": ["healthy"]},
    })
    posts = [
        get_adapter("instagram").parse_record(_ig_record("1", "amazon rainforest brazil nature", 100)),
        get_adapter("instagram").parse_record(_ig_record("2", "healthy healthy food", 1)),
    ]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels)
    corpus = lexical.add_tokens(corpus, cfg)
    counts = lexical.theme_counts(corpus, cfg)
    nature = counts[counts["Theme"] == "Nature"].iloc[0]
    assert nature["Total"] == 3
    shares = lexical.theme_shares(corpus, cfg)
    assert (shares.set_index("Theme").loc["Wellness"] >= 0).all()


def test_keyness_surfaces_distinctive_not_shared_words():
    """A word shared by both tiers must not outrank a word exclusive to the target."""
    cfg = Config.from_dict({"name": "t", "language": None, "tier_labels": ["High", "Low"]})
    posts = [
        get_adapter("instagram").parse_record(
            _ig_record("1", "bowl bowl bowl vibrant vibrant vibrant vibrant", 100)),
        get_adapter("instagram").parse_record(
            _ig_record("2", "bowl bowl bowl detox detox detox detox", 1)),
    ]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels)
    corpus = lexical.add_tokens(corpus, cfg)

    kdf = lexical.keyness(corpus, "High", "Low", min_freq=1)
    words = list(kdf["Word"])
    assert "vibrant" in words, "exclusive word should surface"
    # 'bowl' is equally frequent in both tiers, so it is not distinctive of either.
    assert "bowl" not in words
    assert kdf.iloc[0]["Log ratio"] > 0

    # Symmetry: the reverse comparison surfaces the other tier's exclusive word.
    rev = lexical.keyness(corpus, "Low", "High", min_freq=1)
    assert "detox" in list(rev["Word"])


def test_detect_reads_platform_from_capture(tmp_path):
    """The platform is stated in the file, so nothing should ask the user for it."""
    from monke_bars.detect import detect
    # A real capture wraps the payload in Zeeschuimer's envelope, which is where
    # the platform stamp lives. _ig_record models the payload only.
    envelope = {
        "item_id": "1", "source_platform": "instagram.com",
        "source_platform_url": "https://www.instagram.com/p/abc/",
        **_ig_record("1", "hello", 5),
    }
    p = tmp_path / "cap.ndjson"
    p.write_text(json.dumps(envelope) + "\n", encoding="utf-8")
    d = detect(str(p))
    assert d.kind == "zeeschuimer" and d.platform == "instagram"

    # A JSON file with no Zeeschuimer stamp is not silently accepted.
    q = tmp_path / "other.ndjson"
    q.write_text(json.dumps({"foo": "bar"}) + "\n", encoding="utf-8")
    assert detect(str(q)).kind == "unknown"

    assert detect(str(tmp_path / "sheet.csv")).kind == "table"


def test_tabular_adapter_guesses_columns_and_counts(tmp_path):
    """Awkward headers and formatted counts still land in a PostRecord."""
    import pandas as pd
    from monke_bars.ingest import TabularAdapter

    csv = tmp_path / "posts.csv"
    pd.DataFrame({
        "Post Text": ["first #tag", "second #tag @who"],
        "Likes": ["1,204", "2.1K"],
        "Number of Comments": [3, 7],
        "Date Posted": ["2025-01-04", "2025-02-11"],
    }).to_csv(csv, index=False)

    posts = TabularAdapter().load(str(csv))
    assert len(posts) == 2
    assert posts[0].like_count == 1204        # comma-separated
    assert posts[1].like_count == 2100        # "2.1K"
    assert posts[0].engagement_score == 1207
    assert posts[0].hashtags == ["#tag"]
    assert posts[1].mentions == ["@who"]
    assert posts[0].timestamp is not None


def test_tabular_requires_a_caption_column(tmp_path):
    import pandas as pd
    import pytest
    from monke_bars.ingest import TabularAdapter

    csv = tmp_path / "nocaption.csv"
    pd.DataFrame({"Likes": [1], "Comments": [2]}).to_csv(csv, index=False)
    with pytest.raises(ValueError, match="caption"):
        TabularAdapter().load(str(csv))


def test_findings_are_generated_without_a_framework():
    """Findings must work on a corpus nobody has written a framework for."""
    from monke_bars import findings
    cfg = Config.from_dict({"name": "t", "language": None, "tier_labels": ["High", "Low"]})
    posts = [
        get_adapter("instagram").parse_record(
            _ig_record(str(i), f"bowl bowl keto post {i} #tag", 500 + i)) for i in range(5)
    ] + [
        get_adapter("instagram").parse_record(
            _ig_record(str(100 + i), f"bowl bowl fresh fruit {i} #tag", i)) for i in range(5)
    ]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels)
    out = findings.generate(corpus, cfg, raw_count=12)
    kinds = {f.kind for f in out}
    assert "corpus" in kinds and "overlap" in kinds
    assert not any(f.kind == "theme" for f in out)   # no framework, no theme claims
    assert "12" in out[0].text                       # reports what was filtered out


# --- account-level studies ---------------------------------------------

def _acct_cfg():
    return Config.from_dict({
        "name": "acct", "language": None, "tier_labels": ["High", "Low"],
        "since": "2025-08-01",
        "account_types": {
            "Wedding business": {
                "handle_words": ["fotograf"],
                "hashtags": ["trouwfotograaf"],
                "min_hashtag_hits": 2,
            },
            "Engaged couple": "default",
        },
        "include_types": ["Engaged couple"],
        "signals": {"Dutch": {"caption_words": ["verloofd", "trouwen"],
                              "min_caption_words": 2,
                              "exclude_words": [" ek "]}},
        "min_signals": {"Dutch": 1},
        "min_engagement": 100,
    })


def _post(pid, handle, caption, likes, when="2026-01-01", tags=None):
    rec = _ig_record(pid, caption, likes)
    rec["data"]["user"]["username"] = handle
    rec["data"]["taken_at"] = int(
        __import__("datetime").datetime.fromisoformat(when).timestamp())
    return get_adapter("instagram").parse_record(rec)


def test_date_window_drops_posts_outside_it():
    posts = [_post("1", "a", "verloofd en trouwen", 500, "2026-01-01"),
             _post("2", "b", "verloofd en trouwen", 500, "2024-01-01")]
    corpus = build_corpus(posts, language=None, tier_labels=["High", "Low"],
                          since="2025-08-01")
    assert len(corpus) == 1 and corpus.iloc[0]["author_handle"] == "a"


def test_account_rollup_ranks_by_best_post_and_classifies():
    from monke_bars import accounts
    cfg = _acct_cfg()
    posts = [
        # One account, two posts: it should appear once, ranked on the stronger.
        _post("1", "couple", "wij zijn verloofd en gaan trouwen", 900),
        _post("2", "couple", "verloofd en trouwen nog steeds", 200),
        # A vendor, caught by its handle rather than by what it posts.
        _post("3", "mijnfotografie", "verloofd en trouwen shoot", 5000),
    ]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels,
                          since=cfg.since)
    acc = accounts.build_accounts(corpus, cfg)

    assert len(acc) == 2                       # one row per account, not per post
    vendor = acc[acc["username"] == "mijnfotografie"].iloc[0]
    couple = acc[acc["username"] == "couple"].iloc[0]
    assert vendor["account_type"] == "Wedding business"
    assert couple["account_type"] == "Engaged couple"
    assert couple["posts"] == 2
    assert couple["best_engagement"] == 900    # best post, not the sum
    assert couple["total_engagement"] == 1100

    # The include list keeps couples only, and says why the vendor was dropped.
    kept = accounts.passing(acc, **accounts.config_filters(cfg))
    assert list(kept["username"]) == ["couple"]
    full = accounts.apply_filters(acc, **accounts.config_filters(cfg))
    assert "Wedding business" in full[full["username"] == "mijnfotografie"].iloc[0]["excluded_because"]


def test_signal_exclusion_vetoes_a_lookalike_language():
    """Afrikaans resembles Dutch closely enough to defeat detection."""
    from monke_bars import accounts
    cfg = _acct_cfg()
    posts = [_post("1", "nl", "wij zijn verloofd en gaan trouwen", 800),
             _post("2", "za", "ons is verloofd ek gaan trouwen", 800)]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels,
                          since=cfg.since)
    acc = accounts.build_accounts(corpus, cfg)
    scores = dict(zip(acc["username"], acc["signal_dutch"]))
    assert scores["nl"] >= 1
    assert scores["za"] == 0                   # vetoed by the exclusion word
    assert list(accounts.passing(acc, **accounts.config_filters(cfg))["username"]) == ["nl"]


def test_corpus_study_ignores_account_keys():
    """An ordinary study config carries none of this and must be unaffected."""
    cfg = Config.from_dict({"name": "t", "language": None})
    assert cfg.is_account_study is False
    assert cfg.account_types == {} and cfg.min_engagement == 0


# --- multilingual stopwords --------------------------------------------

def test_stopwords_cover_the_languages_langdetect_returns():
    from monke_bars import stopwords as sw
    for code in ("en", "nl", "pt", "es", "id", "ar", "ru", "tr", "de", "fr", "it"):
        assert sw.for_language(code), f"no stopword list for {code}"
    # Chinese is one list reached by both variants langdetect reports.
    assert sw.for_language("zh-tw") is sw.for_language("zh-cn")
    # A language with no list returns empty rather than silently using English,
    # which would imply a corpus had been cleaned when it had not.
    assert sw.for_language("vi") == frozenset()
    assert sw.for_language(None) == frozenset()


def test_dutch_list_removes_the_grammar_that_swamped_the_corpus():
    """NLTK's Dutch corpus omits these, and they topped a real Dutch ranking."""
    from monke_bars import stopwords as sw
    for word in ("jullie", "we", "wel", "heel", "echt", "onze", "waar"):
        assert word in sw.stopwords_dutch


def test_tokens_use_the_corpus_language_not_english():
    """A Dutch corpus must not be stopworded against English."""
    cfg = Config.from_dict({"name": "t", "language": "nl", "tier_labels": ["High", "Low"]})
    posts = [
        get_adapter("instagram").parse_record(
            _ig_record("1", "wij gaan trouwen en de bruiloft wordt prachtig", 100)),
        get_adapter("instagram").parse_record(
            _ig_record("2", "onze mooie dag met de familie en vrienden samen", 10)),
    ]
    corpus = build_corpus(posts, language=None, tier_labels=cfg.tier_labels)
    corpus["language"] = "nl"          # pin it: detection on two short posts is noisy
    corpus = lexical.add_tokens(corpus, cfg)
    words = set(lexical.top_words(corpus, n=30)["Word"])
    assert not {"de", "en", "wij", "onze"} & words, "Dutch grammar survived"
    assert {"trouwen", "bruiloft"} & words, "Dutch content was removed"


def test_stopword_union_for_a_multilingual_corpus():
    from monke_bars import stopwords as sw
    both = sw.for_languages(["nl", "en"])
    assert "the" in both and "de" in both
    assert len(both) > len(sw.stopwords_dutch)


def test_tiktok_carries_follower_counts_instagram_does_not():
    """TikTok ships authorStats on every item, which is what makes reach real."""
    rec = {"data": {
        "id": "7", "desc": "wij zijn #verloofd", "createTime": 1_760_000_000,
        "author": {"uniqueId": "couple", "nickname": "Couple", "verified": False},
        "authorStats": {"followerCount": 17700, "videoCount": 405},
        "stats": {"diggCount": 900, "commentCount": 100, "shareCount": 4, "playCount": 20000},
        "video": {"cover": "http://x/cover.jpg"},
    }}
    post = get_adapter("tiktok").parse_record(rec)
    assert post.follower_count == 17700
    assert post.view_count == 20000

    # An Instagram hashtag capture exposes none, and 0 has to mean "unknown"
    # so nothing downstream reports a rate it cannot support.
    ig = get_adapter("instagram").parse_record(_ig_record("1", "engaged", 50))
    assert ig.follower_count == 0


def test_engagement_rate_uses_views_and_is_absent_without_them():
    from monke_bars import accounts
    cfg = Config.from_dict({"name": "t", "language": None, "tier_labels": ["High", "Low"]})

    def tt(pid, handle, likes, plays, followers):
        return get_adapter("tiktok").parse_record({"data": {
            "id": pid, "desc": "verloofd", "createTime": 1_760_000_000,
            "author": {"uniqueId": handle, "nickname": handle},
            "authorStats": {"followerCount": followers},
            "stats": {"diggCount": likes, "commentCount": 0, "playCount": plays},
        }})

    corpus = build_corpus([tt("1", "a", 1000, 10000, 5000),
                           tt("2", "b", 50, 0, 200)],
                          language=None, tier_labels=cfg.tier_labels)
    acc = accounts.build_accounts(corpus, cfg).set_index("username")
    assert acc.loc["a", "followers"] == 5000
    assert acc.loc["a", "engagement_rate_pct"] == 10.0     # 1000 of 10000 views
    # pandas stores a missing float as NaN, which is the right representation
    # for "this platform did not report views".
    import pandas as _pd
    assert _pd.isna(acc.loc["b", "engagement_rate_pct"])

    # The follower filter never drops an account whose count is unknown.
    kept = accounts.passing(acc.reset_index(), min_followers=1000)
    assert "a" in list(kept["username"])
