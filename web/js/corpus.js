// Corpus construction: posts into a ranked, tiered, filterable set.
//
// A port of monke_bars/corpus.py. The expensive step, language detection, runs
// once in buildCorpus. Everything after it (filterLanguages, filterDates,
// retier) is cheap slicing, which is the whole reason this runs in the browser:
// a filter change touches an array already in memory and nothing else.

/** Tier labels for positions 0..n-1, already sorted best first. Equal bands. */
export function assignTiers(n, labels) {
  const k = labels.length;
  const band = n ? n / k : 1;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = labels[Math.min(Math.floor(i / band), k - 1)];
  return out;
}

/** Rank by engagement and cut into tiers. A stable sort keeps tied posts in
 *  input order, matching the Python package: nearly half a capture can tie. */
export function retier(posts, labels) {
  const out = posts.slice().sort((a, b) => b.engagement_score - a.engagement_score);
  const tiers = assignTiers(out.length, labels);
  return out.map((p, i) => ({ ...p, engagement_rank: i + 1, engagement_tier: tiers[i] }));
}

/** Languages actually present, commonest first. Ties keep first appearance,
 *  as pandas value_counts does. */
export function languageCounts(posts) {
  const counts = new Map();
  for (const p of posts) counts.set(p.language, (counts.get(p.language) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, posts]) => ({ language, posts }));
}

export function filterLanguages(posts, languages) {
  if (!languages || !languages.length) return posts.slice();
  const want = new Set(languages.map((l) => String(l).toLowerCase()));
  return posts.filter((p) => want.has(String(p.language).toLowerCase()));
}

/** Posts published inside a window. Posts without a timestamp are dropped
 *  whenever a bound is set, since there is no honest way to place them in it. */
export function filterDates(posts, since = null, until = null) {
  if (!since && !until) return posts.slice();
  const lo = since ? Date.parse(since) : null;
  // An "until" date means through the end of that day.
  const hi = until ? Date.parse(until) + (String(until).length <= 10 ? 86399999 : 0) : null;
  return posts.filter((p) => {
    if (!p.timestamp) return false;
    const t = Date.parse(p.timestamp);
    return (lo === null || t >= lo) && (hi === null || t <= hi);
  });
}

/**
 * Dedup, detect language once, and tier.
 *
 * `detect` is injected: the browser passes franc, and the tests pass the
 * Python package's own labels so that only the port is under test.
 */
export function buildCorpus(posts, { detect, tierLabels = ["High", "Medium", "Low"], onProgress } = {}) {
  const seen = new Set(), unique = [];
  for (const p of posts) { if (seen.has(p.post_id)) continue; seen.add(p.post_id); unique.push(p); }

  const labelled = unique.map((p, i) => {
    if (onProgress && i % 25 === 0) onProgress(i, unique.length);
    return { ...p, language: detect(p.caption_text, p) };
  });
  const ranked = retier(labelled, tierLabels);
  return {
    posts: ranked.map((p) => ({ ...p, hashtag_list: p.hashtags, mention_list: p.mentions,
                                hashtag_count: p.hashtags.length })),
    duplicatesRemoved: posts.length - unique.length,
  };
}

// --- language detection -------------------------------------------------------

const W = "\\p{L}\\p{N}_";
const STRIP_TAG = new RegExp(`#[${W}]+`, "gu");
const STRIP_MENTION = new RegExp(`@[${W}](?:[${W}.]*[${W}])?`, "gu");

// franc speaks ISO 639-3; the stopword lists and the rest of the tool use 639-1.
const ISO3_TO_1 = {
  eng: "en", nld: "nl", deu: "de", fra: "fr", spa: "es", por: "pt", ita: "it", afr: "af",
  dan: "da", nob: "no", nno: "no", swe: "sv", fin: "fi", pol: "pl", ind: "id", zlm: "ms",
  tur: "tr", rus: "ru", hun: "hu", ron: "ro", ces: "cs", slk: "sk", cym: "cy", swh: "sw",
  som: "so", tgl: "tl", vie: "vi", arb: "ar", est: "et", cat: "ca", slv: "sl", hrv: "hr",
  lit: "lt", lvs: "lv", ell: "el", ukr: "uk", heb: "he", hin: "hi", jpn: "ja", kor: "ko",
  cmn: "zh-cn", tha: "th", ben: "bn", tam: "ta", urd: "ur", kaz: "kk", uzn: "uz", tgk: "tg",
  sqi: "sq", eus: "eu", bel: "be", nep: "ne",
};

// Only languages the tool has stopword lists for. franc's full model covers
// several hundred, and small relatives act as attractors on short captions:
// measured against langdetect on 432 real posts, English came back as Scots
// eleven times and Dutch as Low German. Restricting the candidates removed
// both and raised agreement from 77 to 82 percent.
export const FRANC_ONLY = ["eng", "nld", "deu", "fra", "spa", "por", "ita", "afr", "dan", "nob",
  "swe", "fin", "ind", "tur", "rus", "hun", "ron", "slv", "cat", "ell", "heb", "arb", "ben",
  "tam", "kaz", "uzn", "tgk", "sqi", "eus", "bel", "cmn", "hin", "nep"];

/** Wrap franc into the detector buildCorpus expects. Hashtags and mentions are
 *  removed first and short remainders are left undetected, as in Python. */
export function makeDetector(franc) {
  return (caption) => {
    const prose = (caption || "").replace(STRIP_TAG, "").replace(STRIP_MENTION, "").trim();
    if (prose.length < 10) return "unknown";
    const code = franc(prose, { minLength: 10, only: FRANC_ONLY });
    return code === "und" ? "unknown" : (ISO3_TO_1[code] || code);
  };
}
