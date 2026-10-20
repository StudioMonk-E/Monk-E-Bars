// Ingestion: a dropped file becomes a list of posts in one shape.
//
// A port of monke_bars/ingest and monke_bars/detect.py. Every platform yields
// the same post object, so nothing downstream needs to know where a post came
// from. Field names match the Python package's PostRecord.to_dict().

import { HASHTAG_RE, MENTION_RE } from "./text.js";

const PLATFORM_HOSTS = {
  "instagram.com": "instagram", instagram: "instagram",
  "tiktok.com": "tiktok", tiktok: "tiktok",
  "twitter.com": "twitter", "x.com": "twitter", "reddit.com": "reddit",
};
const SUPPORTED = new Set(["instagram", "tiktok"]);
const IG_MEDIA = { 1: "photo", 2: "video", 8: "carousel" };

const int = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};
const tsFromUnix = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : null;
};
const first = (d, keys, fallback = null) => {
  for (const k of keys) if (d && d[k] !== undefined && d[k] !== null && d[k] !== "") return d[k];
  return fallback;
};
const lowerAll = (arr) => arr.map((x) => x.toLowerCase());

/** Parse NDJSON text, skipping blank and malformed lines. A scrape interrupted
 *  mid-write leaves a truncated last line, which is dropped here. */
export function parseNdjson(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* truncated line */ }
  }
  return out;
}

/** What a set of records is, read from Zeeschuimer's own stamp. */
export function detect(records) {
  for (const rec of records.slice(0, 25)) {
    if (!rec || typeof rec !== "object") continue;
    const raw = String(rec.source_platform || "").trim().toLowerCase();
    if (!raw) return { kind: "unknown", platform: null,
      note: "JSON with no source_platform field. Zeeschuimer captures carry one on every record." };
    const platform = PLATFORM_HOSTS[raw];
    if (!platform) return { kind: "unknown", platform: null, note: `Capture reports an unsupported platform: ${raw}.` };
    if (!SUPPORTED.has(platform)) return { kind: "unknown", platform,
      note: `The ${platform} adapter is a scaffold and cannot read this yet.` };
    return { kind: "zeeschuimer", platform, note: `Zeeschuimer capture, ${platform}.` };
  }
  return { kind: "unknown", platform: null, note: "No readable records in the file." };
}

// --- Instagram ------------------------------------------------------------

function bestCandidate(iv2) {
  const c = (iv2 && iv2.candidates) || [];
  if (!c.length) return null;
  // The largest candidate by area. Ties keep the first, as Python's max() does.
  let best = c[0], area = (best.width || 0) * (best.height || 0);
  for (const x of c) { const a = (x.width || 0) * (x.height || 0); if (a > area) { best = x; area = a; } }
  return best.url || null;
}

function igMedia(data) {
  const urls = [];
  for (const child of data.carousel_media || []) {
    const u = bestCandidate(child.image_versions2 || {}); if (u) urls.push(u);
  }
  if (!urls.length) { const u = bestCandidate(data.image_versions2 || {}); if (u) urls.push(u); }
  return urls;
}

function parseInstagram(record) {
  const data = record.data || record;
  if (!data || typeof data !== "object") return null;
  const postId = data.id || data.pk || record.item_id;
  if (!postId) return null;
  const cap = data.caption && typeof data.caption === "object" ? (data.caption.text || "") : "";
  const user = data.user || {};
  const code = data.code;
  return {
    platform: "instagram",
    post_id: String(postId),
    url: code ? `https://www.instagram.com/p/${code}/` : "",
    author_handle: user.username || "",
    author_name: user.full_name || "",
    author_verified: Boolean(user.is_verified),
    caption_text: cap,
    like_count: int(data.like_count),
    comment_count: int(data.comment_count),
    share_count: 0,
    view_count: int(data.play_count || data.view_count),
    follower_count: 0,
    timestamp: tsFromUnix(data.taken_at),
    media_type: IG_MEDIA[data.media_type] || "unknown",
    is_paid_partnership: Boolean(data.is_paid_partnership),
    hashtags: lowerAll(cap.match(HASHTAG_RE) || []),
    mentions: lowerAll(cap.match(MENTION_RE) || []),
    media_urls: igMedia(data),
  };
}

// --- TikTok ---------------------------------------------------------------

function ttHashtags(data, desc) {
  const tags = [];
  for (const ch of data.challenges || []) if (ch && ch.title) tags.push("#" + String(ch.title).toLowerCase());
  for (const te of data.textExtra || []) if (te && te.hashtagName) tags.push("#" + String(te.hashtagName).toLowerCase());
  const src = tags.length ? tags : lowerAll(desc.match(HASHTAG_RE) || []);
  return [...new Set(src)];
}

function ttMedia(data) {
  const v = data.video || {};
  for (const k of ["cover", "originCover", "dynamicCover", "reflowCover"]) if (v[k]) return [v[k]];
  return [];
}

function parseTikTok(record) {
  const data = record.data || record;
  if (!data || typeof data !== "object") return null;
  const postId = first(data, ["id", "aweme_id"], record.item_id);
  if (!postId) return null;
  const desc = first(data, ["desc", "description", "text"], "") || "";
  let handle = "", name = "", verified = false;
  const author = data.author || {};
  if (typeof author === "string") { handle = author; }
  else {
    handle = first(author, ["uniqueId", "unique_id", "nickname"], "") || "";
    name = first(author, ["nickname", "signature"], "") || "";
    verified = Boolean(author.verified);
  }
  const stats = data.stats || data.statsV2 || {};
  const aStats = data.authorStats || data.authorStatsV2 || {};
  return {
    platform: "tiktok",
    post_id: String(postId),
    url: handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : "",
    author_handle: handle,
    author_name: name,
    author_verified: verified,
    caption_text: desc,
    like_count: int(first(stats, ["diggCount", "likeCount"], 0)),
    comment_count: int(first(stats, ["commentCount"], 0)),
    share_count: int(first(stats, ["shareCount"], 0)),
    view_count: int(first(stats, ["playCount", "viewCount"], 0)),
    follower_count: int(first(aStats, ["followerCount", "follower_count"], 0)),
    timestamp: tsFromUnix(first(data, ["createTime", "create_time"])),
    media_type: "video",
    is_paid_partnership: Boolean(data.isAd || data.adAuthorization),
    hashtags: ttHashtags(data, desc),
    mentions: lowerAll(desc.match(MENTION_RE) || []),
    media_urls: ttMedia(data),
  };
}

const PARSERS = { instagram: parseInstagram, tiktok: parseTikTok };

function withScore(p) {
  // Likes plus comments: the same baseline across platforms, since an
  // Instagram photo carries no public view count to rank on.
  return { ...p, engagement_score: p.like_count + p.comment_count };
}

/** Records to posts for one platform. */
export function parseRecords(records, platform) {
  const parse = PARSERS[platform];
  if (!parse) throw new Error(`No adapter for ${platform}.`);
  const out = [];
  for (const r of records) { const p = parse(r); if (p) out.push(withScore({ tags: {}, ...p })); }
  return out;
}

// --- spreadsheets -----------------------------------------------------------

const CANDIDATES = {
  caption_text: ["caption", "text", "description", "desc", "body", "content", "message", "post", "title"],
  like_count: ["likes", "like_count", "likecount", "favorites", "favourites", "reactions", "hearts", "diggcount", "score"],
  comment_count: ["comments", "comment_count", "commentcount", "replies", "num_comments"],
  share_count: ["shares", "share_count", "sharecount", "retweets", "reposts"],
  view_count: ["views", "view_count", "viewcount", "plays", "playcount", "impressions"],
  follower_count: ["followers", "follower_count", "followercount"],
  author_handle: ["username", "handle", "author", "user", "account", "screen_name", "creator"],
  timestamp: ["timestamp", "date", "created", "created_at", "taken_at", "datetime", "published", "time", "post_date"],
  url: ["url", "link", "permalink", "post_url"],
  post_id: ["id", "post_id", "item_id", "pk", "shortcode"],
  media_urls: ["image", "image_url", "media", "media_url", "thumbnail", "display_url", "picture"],
  // A sheet holding both platforms has to say which row is which, or every
  // figure taken over it mixes two scales of reach.
  platform: ["platform", "platform_name", "network", "channel", "source", "source_platform"],
};
const norm = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Best guess of field -> column. Exact matches win over substrings, so a sheet
 *  with "likes" and "likes_per_view" maps likes to the former. */
export function guessMapping(columns) {
  const normed = columns.map((c) => [c, norm(c)]);
  const used = new Set(), mapping = {};
  for (const [field, names] of Object.entries(CANDIDATES)) {
    let found = null;
    for (const w of names.map(norm)) {
      const hit = normed.find(([c, n]) => !used.has(c) && n === w);
      if (hit) { found = hit[0]; break; }
    }
    if (!found) for (const w of names.map(norm)) {
      const hit = normed.find(([c, n]) => !used.has(c) && n.includes(w));
      if (hit) { found = hit[0]; break; }
    }
    if (found) used.add(found);
    mapping[field] = found;
  }
  return mapping;
}

/**
 * Counts as exports write them, in either convention.
 *
 * An export made on a Dutch machine writes 1.204 for one thousand two hundred
 * and four, and 1,2K for twelve hundred -- the exact reverse of the English
 * convention. Reading those the English way turned 1.204 into 1 and 1,2K into
 * twelve thousand, and did it silently, which is the dangerous part: a median
 * built on it looks perfectly reasonable and is wrong by three orders of
 * magnitude.
 *
 * The convention is worked out per value rather than guessed once for the
 * file, because a sheet can hold both:
 *
 *   both separators present  the last one is the decimal point
 *   one separator, repeated  it is a thousands separator  (1.234.567)
 *   one separator, once      a K or M suffix makes it a decimal point (1,2K);
 *                            otherwise exactly three digits after it means
 *                            thousands (1.204), and anything else a decimal
 *                            point (0,75)
 *
 * The one case that stays ambiguous is a bare "1.000", which is a thousand to
 * a Dutch exporter and one to an English one. It is read as a thousand: these
 * columns hold view and like counts, where a trailing ".000" is a separator
 * far more often than it is three decimal places.
 */
export function toInt(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  // Spaces group digits in several locales, including the non-breaking kinds
  // a spreadsheet emits.
  let s = String(v).trim().replace(/[\s\u00a0\u202f\u2009]/g, "");
  if (!s) return 0;

  let mult = 1;
  const suffix = s.match(/([kKmM])$/);
  if (suffix) {
    mult = /k/i.test(suffix[1]) ? 1e3 : 1e6;
    s = s.slice(0, -1);
  }

  const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
  if (dot !== -1 && comma !== -1) {
    // Whichever comes last is the decimal point; the other groups digits.
    const [dec, group] = dot > comma ? [".", ","] : [",", "."];
    s = s.split(group).join("").replace(dec, ".");
  } else if (dot !== -1 || comma !== -1) {
    const sep = dot !== -1 ? "." : ",";
    const parts = s.split(sep);
    const tail = parts[parts.length - 1];
    const thousands = parts.length > 2
      || (!suffix && tail.length === 3 && parts[0].length > 0 && /^\d+$/.test(tail));
    s = thousands ? parts.join("") : parts.slice(0, -1).join("") + "." + tail;
  }

  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.trunc(n * mult) : 0;
}

/**
 * Rows (array of objects) from a spreadsheet into posts.
 *
 * A column the mapping does not claim is kept as a tag rather than dropped.
 * That is how a sheet tagged by hand -- format, type, boosted or not -- reaches
 * the monthly view: the tool cannot know what those columns are called, so it
 * keeps whatever is there and lets the reader choose which one to group by.
 */
export function parseTable(rows, source = "table", override = {}) {
  if (!rows.length) return [];
  // An override of "" unsets a guessed column; undefined leaves the guess.
  const m = { ...guessMapping(Object.keys(rows[0])),
    ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v || null])) };
  if (!m.caption_text) throw new Error("No caption column found. Name the column holding post text, or map it explicitly.");
  const cell = (row, f) => (m[f] ? row[m[f]] : undefined);
  // Everything the mapping consumed; what is left over is a tag.
  const claimed = new Set(Object.values(m).filter(Boolean));
  const tagCols = Object.keys(rows[0]).filter((c) => !claimed.has(c));
  return rows.map((row, i) => {
    const cap = cell(row, "caption_text"); const caption = cap == null ? "" : String(cap);
    const ts = cell(row, "timestamp"); const d = ts == null || ts === "" ? null : new Date(ts);
    const media = cell(row, "media_urls"); const handle = cell(row, "author_handle"); const url = cell(row, "url");
    const pid = cell(row, "post_id");
    const plat = cell(row, "platform");
    return withScore({
      // Named by the sheet where it says so; "table" only when it does not.
      platform: plat == null || String(plat).trim() === "" ? "table" : String(plat).trim().toLowerCase(),
      post_id: pid == null || pid === "" ? `${source}:${i}` : String(pid),
      url: url == null ? "" : String(url),
      author_handle: handle == null ? "" : String(handle),
      author_name: "",
      author_verified: false,
      caption_text: caption,
      like_count: toInt(cell(row, "like_count")),
      comment_count: toInt(cell(row, "comment_count")),
      share_count: toInt(cell(row, "share_count")),
      view_count: toInt(cell(row, "view_count")),
      follower_count: toInt(cell(row, "follower_count")),
      timestamp: d && !isNaN(d) ? d.toISOString() : null,
      media_type: "unknown",
      is_paid_partnership: false,
      hashtags: lowerAll(caption.match(HASHTAG_RE) || []),
      mentions: lowerAll(caption.match(MENTION_RE) || []),
      media_urls: media == null || media === "" ? [] : [String(media)],
      tags: tagValues(row, tagCols),
    });
  });
}

/** A row's leftover columns, as trimmed strings. A blank cell is left out
 *  entirely, so a half-tagged sheet reports "untagged" rather than "".  */
function tagValues(row, cols) {
  const out = {};
  for (const c of cols) {
    const v = row[c];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) out[c] = s;
  }
  return out;
}
