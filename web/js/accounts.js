// Account-level analysis: which accounts are posting.
//
// A port of monke_bars/accounts.py. The vocabulary views ask how a subject is
// discussed; this asks which accounts to approach, so it groups by author and
// returns one row per account. Nothing is ever deleted: accounts are labelled,
// and a filtered-out account keeps its row with the reason attached.

import { pyRound } from "./util.js";

export let DEFAULT_MARKER = "default";
export let DEFAULT_ACCOUNT_TYPES = {};

/** Load the generic types exported from the Python package. */
export function setAccountTypes(data) {
  DEFAULT_MARKER = data.default_marker;
  DEFAULT_ACCOUNT_TYPES = data.types;
}

const isDefault = (spec) => spec === DEFAULT_MARKER || spec == null;
const lower = (xs) => (xs || []).map((x) => String(x).toLowerCase());
const bareTags = (xs) => (xs || []).map((t) => String(t).toLowerCase().replace(/^#+/, ""));

// --- signals ---------------------------------------------------------------

/** How many of `words` appear in a caption, as substrings. Substring matching
 *  catches a word still carrying punctuation, and inside a compound, with no
 *  tokeniser per language. */
function captionWordHits(caption, words) {
  const low = (caption || "").toLowerCase();
  return words.filter((w) => w && low.includes(w)).length;
}

/** One `signal_<name>` score per configured signal, a point per passing test.
 *  `exclude_words` carries no points and vetoes: enough hits zero the score. */
export function scoreSignals(posts, config) {
  const signals = config.signals || {};
  const names = Object.keys(signals);
  if (!names.length) return posts;
  const specs = names.map((name) => {
    const s = signals[name] || {};
    return {
      col: `signal_${name.toLowerCase()}`,
      lang: s.detected_language,
      words: lower(s.caption_words), minWords: parseInt(s.min_caption_words, 10) || 1,
      tags: new Set(bareTags(s.hashtags)), minTags: parseInt(s.min_hashtags, 10) || 1,
      excl: lower(s.exclude_words), minExcl: parseInt(s.min_exclude_words, 10) || 1,
    };
  });
  return posts.map((p) => {
    const out = { ...p };
    const caption = p.caption_text || "";
    for (const s of specs) {
      let pts = 0;
      if (!(s.excl.length && captionWordHits(caption, s.excl) >= s.minExcl)) {
        if (s.lang && String(p.language ?? "").toLowerCase() === String(s.lang).toLowerCase()) pts++;
        if (s.words.length && captionWordHits(caption, s.words) >= s.minWords) pts++;
        if (s.tags.size) {
          const have = new Set(bareTags(p.hashtag_list));
          let n = 0; for (const t of have) if (s.tags.has(t)) n++;
          if (n >= s.minTags) pts++;
        }
      }
      out[s.col] = pts;
    }
    return out;
  });
}

// --- classification --------------------------------------------------------

/** Study types layered over the generic ones, most specific first. A type the
 *  study shares with the defaults takes the union of both word lists; a study's
 *  own catch-all replaces the generic one. */
export function resolveAccountTypes(config) {
  const study = config.account_types;
  if (!study || !Object.keys(study).length) return { ...DEFAULT_ACCOUNT_TYPES };
  const merged = {};
  const studyDefault = Object.values(study).some(isDefault);
  const LISTS = ["handle_words", "name_words", "hashtags"];

  for (const [name, spec] of Object.entries(study)) {
    const base = DEFAULT_ACCOUNT_TYPES[name];
    if (isDefault(spec) || base == null || typeof base !== "object") { merged[name] = spec; continue; }
    const combined = { ...base };
    for (const k of LISTS) combined[k] = [...new Set([...(base[k] || []), ...((spec || {})[k] || [])])];
    for (const [k, v] of Object.entries(spec || {})) if (!LISTS.includes(k)) combined[k] = v;
    merged[name] = combined;
  }
  for (const [name, spec] of Object.entries(DEFAULT_ACCOUNT_TYPES)) {
    if (name in merged) continue;
    if (spec === DEFAULT_MARKER && studyDefault) continue;
    merged[name] = spec;
  }
  return merged;
}

/** Python's f"{x:.0%}". */
const pct0 = (x) => `${pyRound(x * 100, 0)}%`;

/** The account type for one account, first match wins, with the reason. A
 *  plain substring test on handle and display name, then a hashtag route for a
 *  vendor whose name gives nothing away. Crude on purpose: every decision is
 *  inspectable and every word list editable. */
export function classifyAccount(handle, name, tagShare, types) {
  const text = `${handle || ""} ${name || ""}`.toLowerCase();
  let fallback = "Unclassified";
  for (const [typeName, spec] of Object.entries(types)) {
    if (isDefault(spec)) { fallback = typeName; continue; }
    const s = spec || {};
    const words = lower([...(s.handle_words || []), ...(s.name_words || [])]);
    const hit = words.find((w) => text.includes(w));
    if (hit) return [typeName, `name contains '${hit.trim()}'`];
    const threshold = parseFloat(s.min_post_share) || 0.5;
    const share = tagShare[typeName] || 0;
    if (share > threshold) return [typeName, `${pct0(share)} of posts carry its hashtags`];
  }
  return [fallback, "no word matched"];
}

/** Share of an account's posts carrying enough hashtags for each type. */
function tagShares(posts, types) {
  const out = {};
  const n = posts.length;
  if (!n) return out;
  for (const [typeName, spec] of Object.entries(types)) {
    if (spec === DEFAULT_MARKER || !spec) continue;
    const tags = new Set(bareTags(spec.hashtags));
    if (!tags.size) continue;
    const need = parseInt(spec.min_hashtag_hits, 10) || 2;
    let hits = 0;
    for (const p of posts) {
      const have = new Set(bareTags(p.hashtag_list));
      let k = 0; for (const t of have) if (tags.has(t)) k++;
      if (k >= need) hits++;
    }
    out[typeName] = hits / n;
  }
  return out;
}

// --- rollup ----------------------------------------------------------------

/** Compare by code point, as Python sorts strings. */
function cmpCodePoints(a, b) {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * One row per account, ranked by the account's strongest single post. A one-off
 * announcement is a single large post, and a sum would reward an account that
 * posts constantly over the one that posted the thing being looked for.
 */
export function buildAccounts(posts, config, now = new Date()) {
  if (!posts.length) return [];
  const scored = scoreSignals(posts, config);
  const signalCols = Object.keys(scored[0]).filter((c) => c.startsWith("signal_"));
  const types = resolveAccountTypes(config);

  const groups = new Map();
  for (const p of scored) {
    if (!p.author_handle) continue;
    if (!groups.has(p.author_handle)) groups.set(p.author_handle, []);
    groups.get(p.author_handle).push(p);
  }
  // pandas groupby sorts its keys; the final sort is stable, so this order
  // decides ties on best engagement.
  const handles = [...groups.keys()].sort(cmpCodePoints);

  const rows = handles.map((handle) => {
    const ps = groups.get(handle);
    let best = ps[0];
    for (const p of ps) if (p.engagement_score > best.engagement_score) best = p;
    const times = ps.map((p) => (p.timestamp ? Date.parse(p.timestamp) : NaN)).filter(Number.isFinite);
    const bestTs = best.timestamp ? Date.parse(best.timestamp) : NaN;
    const months = Number.isFinite(bestTs)
      ? pyRound(Math.floor((now.getTime() - bestTs) / 86400000) / 30.44, 1) : null;
    const followers = Math.max(0, ...ps.map((p) => p.follower_count || 0));
    const views = best.view_count || 0;
    // Against views, as TikTok is read: the For You page serves a video to
    // people who do not follow the account.
    const rate = views ? pyRound((best.engagement_score / views) * 100, 2) : null;
    const [account_type, type_reason] = classifyAccount(
      handle, best.author_name || "", tagShares(ps, types), types);

    const row = {
      username: handle,
      full_name: best.author_name || "",
      verified: ps.some((p) => !!p.author_verified),
      account_type, type_reason,
      posts: ps.length,
      followers,
      best_engagement: best.engagement_score,
      best_post_views: views,
      engagement_rate_pct: rate,
      total_engagement: ps.reduce((s, p) => s + p.engagement_score, 0),
      best_post_url: best.url || "",
      best_post_date: Number.isFinite(bestTs) ? dateOnly(bestTs) : null,
      months_since_best: months,
      last_post_date: times.length ? dateOnly(Math.max(...times)) : null,
      paid_partnership: ps.some((p) => !!p.is_paid_partnership),
      best_caption: [...(best.caption_text || "")].slice(0, 300).join(""),
    };
    for (const c of signalCols) row[c] = Math.max(...ps.map((p) => p[c]));
    return row;
  });
  return rows.sort((a, b) => b.best_engagement - a.best_engagement);
}

// --- filtering -------------------------------------------------------------
//
// Three filters kept independent: type (what the account is), verified (what
// the platform states) and reach (engagement on its best post, or followers
// where the capture has them). Nothing in a capture identifies an influencer,
// so a preset composes one from these and prints the rule it applies.

/** Add `excluded_because` to every account. Nothing is dropped. */
export function applyFilters(accounts, { types = null, verified = null, min_engagement = 0,
  max_engagement = null, min_followers = 0, min_signals = null } = {}) {
  const hasCol = (c) => accounts.length && c in accounts[0];
  return accounts.map((row) => {
    const why = [];
    if (types && types.length && !types.includes(row.account_type)) why.push(`type is ${row.account_type}`);
    if (verified != null && !!row.verified !== !!verified) why.push(verified ? "not verified" : "verified");
    if (min_engagement && row.best_engagement < min_engagement) why.push(`under ${min_engagement} engagement`);
    if (max_engagement != null && row.best_engagement >= max_engagement) why.push(`at or over ${max_engagement} engagement`);
    if (min_followers) {
      // Unknown followers cannot answer this, and excluding on a missing
      // figure would empty an Instagram list silently.
      const have = row.followers || 0;
      if (have && have < min_followers) why.push(`under ${min_followers} followers`);
    }
    for (const [name, threshold] of Object.entries(min_signals || {})) {
      const col = `signal_${name.toLowerCase()}`;
      if (hasCol(col) && row[col] < parseInt(threshold, 10)) why.push(`${name} score ${row[col]} under ${threshold}`);
    }
    return { ...row, excluded_because: why.join("; ") };
  });
}

export function passing(accounts, filters) {
  return applyFilters(accounts, filters)
    .filter((r) => r.excluded_because === "")
    .map(({ excluded_because, ...rest }) => rest);
}

/** The filter set behind a named preset. The name is only a shortcut. */
export function audienceFilters(config, name) {
  const spec = (config.audiences || {})[name] || {};
  return {
    types: spec.types && spec.types.length ? [...spec.types] : null,
    min_engagement: parseInt(spec.min_engagement, 10) || 0,
    max_engagement: spec.max_engagement ?? null,
    min_followers: parseInt(spec.min_followers, 10) || 0,
    verified: spec.verified ?? null,
    min_signals: { ...(spec.min_signals || config.min_signals || {}) },
  };
}

/** One line stating what a preset actually selects. */
export function describeAudience(config, name) {
  const f = audienceFilters(config, name);
  const bits = [];
  if (f.types) bits.push(f.types.join(" or ").toLowerCase());
  if (f.verified === true) bits.push("verified");
  else if (f.verified === false) bits.push("not verified");
  if (f.min_engagement) bits.push(`at least ${f.min_engagement} engagement`);
  if (f.min_followers) bits.push(`at least ${f.min_followers} followers where known`);
  if (f.max_engagement != null) bits.push(`under ${f.max_engagement} engagement`);
  for (const [sig, n] of Object.entries(f.min_signals)) bits.push(`${sig} score ${n} or more`);
  return bits.length ? bits.join(", ") : "every account";
}

/** The study's own default filters. */
export function configFilters(config) {
  return {
    types: config.include_types && config.include_types.length ? [...config.include_types] : null,
    min_engagement: parseInt(config.min_engagement, 10) || 0,
    min_signals: { ...(config.min_signals || {}) },
  };
}
