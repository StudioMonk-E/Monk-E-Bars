// Reading an account's own data export.
//
// Everything else in Monk-E Bars reads a public capture: posts by other people,
// scraped from a hashtag. This reads the opposite, the export a platform hands
// the person who owns the account, which is the only place follow timestamps
// exist. It is first-party data about the account's own audience, and it stays
// in the browser like everything else here.
//
// Two shapes arrive:
//
//   Instagram  "Download your information", JSON. followers_1.json carries one
//              entry per follower with the unix second they followed.
//   TikTok     "Download your data", JSON. The follower list carries a date per
//              follower, written in UTC.
//
// Both change their field names between versions, and an export can be a folder,
// a zip, or a handful of files dropped together. So nothing here insists on a
// path: it walks whatever JSON it is given and recognises records by shape.

const num = (v) => (typeof v === "number" ? v : parseInt(v, 10));

/** A timestamp in milliseconds, from the several forms these exports use. */
export function toMillis(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = num(v);
    if (!Number.isFinite(n)) return null;
    // Seconds until roughly the year 33658, milliseconds after it.
    return n > 1e12 ? n : n * 1000;
  }
  const s = String(v).trim();
  // TikTok writes "2026-01-15 14:32:11" and means UTC.
  const plain = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(:(\d{2}))?$/.exec(s);
  if (plain) return Date.UTC(+plain[1], +plain[2] - 1, +plain[3], +plain[4], +plain[5], +(plain[7] || 0));
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Walk a parsed export, visiting every object inside it. */
function* walk(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  yield node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    if (value && typeof value === "object") yield* walk(value, depth + 1);
  }
}

const KEY = (obj, re) => Object.keys(obj || {}).find((k) => re.test(k));

// --- followers ---------------------------------------------------------------

/**
 * Follow records, whatever the export calls them.
 *
 * Instagram nests the username and the timestamp inside `string_list_data`.
 * TikTok writes a flat `{Date, UserName}`. Both are recognised by shape, so a
 * renamed wrapper key does not break the read.
 */
export function readFollowers(data) {
  const out = [];
  const seen = new Set();
  for (const node of walk(data)) {
    if (Array.isArray(node)) continue;

    // Instagram: { "string_list_data": [ { value, href, timestamp } ] }
    const sld = node.string_list_data;
    if (Array.isArray(sld) && sld.length && sld[0] && "timestamp" in sld[0]) {
      for (const entry of sld) {
        const ts = toMillis(entry.timestamp);
        if (ts) out.push({ ts, username: String(entry.value || "").replace(/^@/, ""), url: entry.href || "" });
      }
      continue;
    }

    // TikTok: { "Date": "2026-01-15 14:32:11", "UserName": "someone" }
    const dateKey = KEY(node, /^(date|time)$/i);
    const userKey = KEY(node, /^(username|user ?name|nickname|user)$/i);
    if (dateKey && userKey && typeof node[userKey] !== "object") {
      const ts = toMillis(node[dateKey]);
      if (ts) out.push({ ts, username: String(node[userKey] || "").replace(/^@/, ""), url: node.Link || node.link || "" });
    }
  }
  // An export can repeat a follower across files; the first record wins.
  return out.filter((f) => {
    const key = `${f.username}|${f.ts}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.ts - b.ts);
}

// --- what the account itself did ---------------------------------------------

const clip = (s, n = 90) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return [...t].length > n ? [...t].slice(0, n).join("") + "…" : t;
};

/**
 * The account's own actions, each with a timestamp: posts, videos, stories and
 * comments left on other people's posts. These are the stimulus a spike in
 * follows gets read against.
 */
export function readEvents(data) {
  const out = [];
  // A post carries its own timestamp and repeats it on each piece of media
  // inside it. The media is part of the post, not a second thing the account did.
  const inner = new WeakSet();
  for (const node of walk(data)) {
    if (Array.isArray(node)) continue;
    if (Array.isArray(node.media)) for (const m of node.media) if (m && typeof m === "object") inner.add(m);
    if (inner.has(node)) continue;

    // Instagram posts, reels and stories all carry creation_timestamp.
    if (node.creation_timestamp && !node.string_list_data) {
      const ts = toMillis(node.creation_timestamp);
      const media = Array.isArray(node.media) ? node.media[0] : null;
      const label = clip(node.title || (media && (media.title || media.uri)) || "post");
      if (ts) out.push({ ts, kind: "post", label, url: (media && media.uri) || node.uri || "" });
      continue;
    }

    // Instagram comments: a string_map_data block with Time, and the owner of
    // the post commented on, which is the whole point of tracking them.
    const smd = node.string_map_data;
    if (smd && typeof smd === "object") {
      const timeKey = KEY(smd, /^time$/i);
      const ts = timeKey ? toMillis((smd[timeKey] || {}).timestamp ?? (smd[timeKey] || {}).value) : null;
      if (ts) {
        const ownerKey = KEY(smd, /owner|author|account/i);
        const textKey = KEY(smd, /comment|caption|text/i);
        const owner = ownerKey ? String((smd[ownerKey] || {}).value || "") : "";
        out.push({ ts, kind: "comment", label: owner ? `comment on @${owner.replace(/^@/, "")}` : "comment",
          note: textKey ? clip((smd[textKey] || {}).value, 70) : "", url: "" });
      }
      continue;
    }

    // TikTok comments: { date, comment } with no host account recorded.
    if (node.comment && (node.date || node.Date)) {
      const ts = toMillis(node.date || node.Date);
      if (ts) out.push({ ts, kind: "comment", label: "comment", note: clip(node.comment, 70), url: node.url || "" });
      continue;
    }

    // TikTok videos: { Date, Link, ... } with no username beside them.
    const dateKey = KEY(node, /^date$/i);
    const linkKey = KEY(node, /^(link|videolink|url)$/i);
    if (dateKey && linkKey && !KEY(node, /^(username|user ?name|nickname)$/i)) {
      const ts = toMillis(node[dateKey]);
      if (ts) out.push({ ts, kind: "post", label: "video", url: String(node[linkKey] || "") });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// --- what a dropped file is --------------------------------------------------

/** Whether a parsed JSON file looks like an account export rather than a capture. */
export function looksLikeExport(data) {
  if (!data || typeof data !== "object") return false;
  for (const node of walk(data, 9)) {
    if (Array.isArray(node)) continue;
    if (node.string_list_data || node.string_map_data) return true;
    if (KEY(node, /^(fanslist|follower list|followerlist)$/i)) return true;
    if (KEY(node, /^(date|time)$/i) && KEY(node, /^(username|user ?name|nickname)$/i)) return true;
    // A posts or reels file carries no followers at all, and is still part of
    // the export: it is where the stimulus behind a spike comes from.
    if (node.creation_timestamp && (node.media || node.title !== undefined || node.uri)) return true;
    if (node.comment && (node.date || node.Date)) return true;
  }
  return false;
}

const EXPORT_FILE = /(follower|fans|user_data|posts_|reels|stories|comments|videos)/i;

/** Unpack a zip and keep only the JSON an export analysis can use. Media is left
 *  compressed, which is what keeps a multi-gigabyte Instagram export workable. */
export async function readZip(file, fflate) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const files = await new Promise((resolve, reject) => {
    fflate.unzip(buf, { filter: (f) => /\.json$/i.test(f.name) && f.originalSize < 80e6 }, (err, out) => err ? reject(err) : resolve(out));
  });
  const dec = new TextDecoder();
  const out = [];
  for (const [path, bytes] of Object.entries(files)) {
    if (!EXPORT_FILE.test(path) && Object.keys(files).length > 12) continue;
    try { out.push({ path, data: JSON.parse(dec.decode(bytes)) }); } catch { /* not the JSON we want */ }
  }
  return out;
}

/** Everything an account export yields, from however many files it arrived in. */
export function buildAccountData(parts) {
  const follows = [], events = [];
  for (const { path, data } of parts) {
    const isFollowing = /following|follow_requests|close_friends|blocked|hide_story/i.test(path);
    if (!isFollowing) follows.push(...readFollowers(data));
    events.push(...readEvents(data));
  }
  const seen = new Set();
  const unique = follows.filter((f) => {
    const key = `${f.username}|${f.ts}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { follows: unique.sort((a, b) => a.ts - b.ts), events: events.sort((a, b) => a.ts - b.ts) };
}
