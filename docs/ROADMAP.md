# Roadmap: X/Twitter and Reddit adapters

Instagram and TikTok are fully supported. X and Reddit ship as **scaffolds**, the adapter classes, the registry entries, the CLI/dashboard wiring and the field
maps are all in place; each `parse_record` just needs to be pointed at a real
capture and have its `raise NotImplementedError` removed.

Because everything above ingestion is platform-agnostic, finishing an adapter
means filling one function that returns a `PostRecord`. Nothing downstream
changes.

## Reddit (the easiest, and the place to start)

Reddit barely needs scraping: append `.json` to any listing URL, or use
[PRAW](https://praw.readthedocs.io/). Objects are clean and documented.

Field map (`t3` link object, i.e. `child["data"]`):

| PostRecord field | Reddit field |
|---|---|
| `caption_text` | `title` + " " + `selftext` |
| `like_count` | `score` |
| `comment_count` | `num_comments` |
| `author_handle` | `author` |
| `timestamp` | `created_utc` (unix) |
| `url` | `"https://reddit.com" + permalink` |
| `media_urls` | `preview.images[*].source.url` (fallback `thumbnail`) |

Edit `monke_bars/ingest/reddit.py`, implement `parse_record`, remove the raise,
and add a test mirroring `test_instagram_adapter_maps_fields`.

## X / Twitter (harder)

Zeeschuimer can capture X timelines, but X actively fights scraping and the
payload nests deeply. Field map (`TweetResult` / legacy object):

| PostRecord field | X path |
|---|---|
| `caption_text` | `data.legacy.full_text` |
| `like_count` | `data.legacy.favorite_count` |
| `comment_count` | `data.legacy.reply_count` |
| `share_count` | `data.legacy.retweet_count` (+ `quote_count`) |
| `author_handle` | `data.core.user_results.result.legacy.screen_name` |
| `timestamp` | parse `data.legacy.created_at` (`"Wed Jun 04 12:00:00 +0000 2025"`) |
| `media_urls` | `data.legacy.extended_entities.media[*].media_url_https` |

Verify against a real capture, X's response shape drifts, and some fields move
between `legacy` and newer top-level keys.

## Adding a brand-new platform

1. Create `monke_bars/ingest/<platform>.py` with an `Adapter` subclass whose
   `parse_record` returns a `PostRecord`.
2. Register it in `monke_bars/ingest/__init__.py` (`ADAPTERS`, and `SUPPORTED`
   once it's tested).
3. Add a test. The CLI and dashboard pick it up automatically.
