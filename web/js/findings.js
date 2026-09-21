// Generated findings: the statements a corpus supports on its own.
//
// A port of monke_bars/findings.py. Every sentence is derived from counts the
// pipeline already computes, and nothing here interprets. A study may carry one
// authored `claim`, which prints above the evidence under its own heading.

import { topWordsByTier, keyness, themeShares, themeCounts, cooccurringHashtags } from "./lexical.js";
import { pyRound } from "./util.js";

let LANG_NAMES = {};
export function setLanguageNames(names) { LANG_NAMES = names; }
export const langName = (code) => LANG_NAMES[String(code ?? "").toLowerCase()] ?? String(code);

/** "*a*, *b* and *c*": italics are marked with asterisks, rendered by the UI. */
function fmtList(words, n = 5) {
  const w = words.slice(0, n);
  if (!w.length) return "";
  if (w.length === 1) return `*${w[0]}*`;
  return w.slice(0, -1).map((x) => `*${x}*`).join(", ") + ` and *${w[w.length - 1]}*`;
}

/** Python's f"{x:.2f}". */
const f2 = (x) => pyRound(x, 2).toFixed(2);

export function corpusFinding(posts, rawCount, languages) {
  const kept = posts.length;
  if (rawCount && rawCount > kept) {
    const dropped = rawCount - kept;
    const pct = pyRound((dropped / rawCount) * 100, 0);
    const langs = [].concat(languages || []);
    const lang = langs.length ? ` The filter keeps ${langs.map(langName).join(" and ")} only.` : "";
    return { kind: "corpus", text: `${kept} of ${rawCount} captured posts enter the corpus. `
      + `${dropped} are removed by deduplication, language and date filtering, `
      + `which is ${pct} percent of the capture.${lang}` };
  }
  return { kind: "corpus", text: `${kept} posts in the corpus.` };
}

/** How much the two ends of the corpus share by raw frequency. The finding
 *  that motivates keyness. */
export function overlapFinding(posts, tiers, topN = 15) {
  if (tiers.length < 2) return null;
  const hi = tiers[0], lo = tiers[tiers.length - 1];
  const by = topWordsByTier(posts, [hi, lo], topN);
  const hw = by[hi].map((r) => r.word), lw = by[lo].map((r) => r.word);
  if (!hw.length || !lw.length) return null;
  const shared = hw.filter((w) => lw.includes(w)).length;
  const lead = hw[0] === lw[0] ? ` and both lead on *${hw[0]}*` : "";
  return { kind: "overlap", text: `The ${hi.toLowerCase()} and ${lo.toLowerCase()} tiers share `
    + `${shared} of their top ${topN} words by raw frequency${lead}.` };
}

export function keynessFinding(posts, tiers, topN = 5) {
  if (tiers.length < 2) return null;
  const hi = tiers[0], lo = tiers[tiers.length - 1];
  const kh = keyness(posts, hi, lo, topN), kl = keyness(posts, lo, hi, topN);
  if (!kh.length && !kl.length) return null;
  const parts = [];
  if (kh.length) parts.push(`the ${hi.toLowerCase()} tier over-uses ${fmtList(kh.map((r) => r.word), topN)}`);
  if (kl.length) parts.push(`the ${lo.toLowerCase()} tier over-uses ${fmtList(kl.map((r) => r.word), topN)}`);
  return { kind: "keyness", text: "Measured as keyness, " + parts.join("; ") + "." };
}

export function exclusiveFinding(posts, tiers, topN = 20) {
  if (tiers.length < 2) return null;
  const hi = tiers[0], lo = tiers[tiers.length - 1];
  const excl = keyness(posts, hi, lo, topN).filter((r) => r.reference_freq === 0);
  if (!excl.length) return null;
  return { kind: "keyness", text: `${excl.length} of the ${hi.toLowerCase()} tier's distinctive words `
    + `do not appear in the ${lo.toLowerCase()} tier at all, led by ${fmtList(excl.map((r) => r.word), 3)}.` };
}

/** Direction of travel for each framework layer. Under a tenth of a point
 *  between the ends counts as flat: below that the direction is noise. */
export function themeFindings(posts, config, tiers) {
  if (!config.themes || !Object.keys(config.themes).length || tiers.length < 2) return [];
  const hiT = tiers[0], loT = tiers[tiers.length - 1];
  const shares = themeShares(posts, config);
  const totals = Object.fromEntries(themeCounts(posts, config).map((r) => [r.theme, r.total]));
  const rising = [], falling = [], flat = [];
  for (const row of shares) {
    const hi = row[hiT], lo = row[loT], spread = hi - lo;
    if (Math.abs(spread) < 0.1) flat.push([row.theme, hi, lo]);
    else (spread > 0 ? rising : falling).push([row.theme, hi, lo]);
  }
  const out = [];
  for (const [label, group] of [["rises", rising], ["falls", falling]]) {
    if (group.length) out.push({ kind: "theme",
      text: `Share ${label} with engagement for ${fmtList(group.map((g) => g[0]), 4)}.` });
  }
  for (const [theme, hi, lo] of flat) {
    out.push({ kind: "theme", text: `*${theme}* holds flat across tiers at ${f2(hi)} against ${f2(lo)} `
      + `percent, on ${totals[theme] || 0} token hits in the whole corpus.` });
  }
  return out;
}

export function hashtagFinding(posts, config) {
  const top = cooccurringHashtags(posts, config.query_hashtags || [], 5);
  if (!top.length) return null;
  return { kind: "hashtag", text: `The most common co-occurring hashtag is *${top[0].hashtag}* `
    + `at ${top[0].frequency} posts.` };
}

/** Every statement the corpus supports, in reading order. `posts` must
 *  already carry content tokens. */
export function generate(posts, config, { rawCount = null, languages = null } = {}) {
  const tiers = config.tier_labels.filter((t) => posts.some((p) => p.engagement_tier === t));
  const out = [corpusFinding(posts, rawCount, languages)];
  for (const fn of [overlapFinding, keynessFinding, exclusiveFinding]) {
    const f = fn(posts, tiers);
    if (f) out.push(f);
  }
  out.push(...themeFindings(posts, config, tiers));
  const h = hashtagFinding(posts, config);
  if (h) out.push(h);
  return out;
}
