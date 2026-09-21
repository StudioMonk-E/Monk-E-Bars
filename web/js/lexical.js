// Lexical analysis: frequency, keyness, n-grams, hashtags, thematic layers.
//
// A port of monke_bars/lexical.py, held to it by the parity tests. Every
// function takes posts that already carry `content_tokens` and `engagement_tier`.

import { contentTokens, buildStopwords, ngrams } from "./text.js";
import { pyRound, mostCommon, counter } from "./util.js";

/** Attach content tokens. The stopword list follows the languages the posts
 *  actually hold, so a study keeping every language still loses each one's
 *  grammar words. */
export function addTokens(posts, config, stopwordData) {
  const langs = [...new Set(posts.map((p) => p.language))]
    .filter((c) => c && c !== "unknown");
  const declared = config.language == null ? [] : [].concat(config.language);
  const stop = buildStopwords(stopwordData, config.stopwords_extra || [],
                              posts.some((p) => "language" in p) ? langs : declared);
  return posts.map((p) => ({ ...p, content_tokens: contentTokens(p.caption_text, stop) }));
}

const flatten = (posts) => posts.flatMap((p) => p.content_tokens);
const inTier = (posts, t) => posts.filter((p) => p.engagement_tier === t);

export function topWords(posts, n = 30) {
  return mostCommon(flatten(posts), n).map(([word, frequency]) => ({ word, frequency }));
}

export function topWordsByTier(posts, tiers, n = 20) {
  return Object.fromEntries(tiers.map((t) => [t, topWords(inTier(posts, t), n)]));
}

/**
 * Words over-represented in one tier against another: Dunning log-likelihood,
 * with a log-ratio effect size beside it because the statistic alone rewards
 * sheer frequency. `reference` defaults to every other tier pooled.
 */
export function keyness(posts, target, reference = null, topN = 25, minFreq = 3) {
  const tgt = flatten(inTier(posts, target));
  const refPosts = reference == null ? posts.filter((p) => p.engagement_tier !== target)
                                     : inTier(posts, reference);
  const ref = flatten(refPosts);
  const refLabel = reference == null ? "rest of corpus" : reference;
  const c = tgt.length, d = ref.length;
  if (!c || !d) return [];

  const tc = counter(tgt), rc = counter(ref);
  const rows = [];
  for (const [word, a] of tc) {
    if (a < minFreq) continue;
    const b = rc.get(word) || 0;
    const e1 = (c * (a + b)) / (c + d);
    const e2 = (d * (a + b)) / (c + d);
    const g2 = 2 * ((a ? a * Math.log(a / e1) : 0) + (b ? b * Math.log(b / e2) : 0));
    // +0.5 smoothing keeps a word absent from the reference, where the log
    // ratio would otherwise be infinite and drop it.
    const rt = a / c, rr = (b + 0.5) / d;
    if (rt <= rr) continue;                  // only the target's over-used words
    rows.push({ word, target_freq: a, reference_freq: b,
                log_likelihood: pyRound(g2, 2), log_ratio: pyRound(Math.log2(rt / rr), 2),
                reference: refLabel });
  }
  return rows.sort((x, y) => y.log_likelihood - x.log_likelihood).slice(0, topN);
}

export function keynessAllTiers(posts, tiers, topN = 20, minFreq = 3) {
  return Object.fromEntries(tiers.map((t) => [t, keyness(posts, t, null, topN, minFreq)]));
}

export function topNgrams(posts, size = 2, topN = 20) {
  const grams = posts.flatMap((p) => ngrams(p.content_tokens, size).map((g) => g.join(" ")));
  return mostCommon(grams, topN).map(([phrase, frequency]) => ({ phrase, frequency }));
}

export function cooccurringHashtags(posts, seeds = [], topN = 25) {
  const excluded = new Set(seeds.map((h) => h.toLowerCase()));
  const tags = posts.flatMap((p) => p.hashtag_list.map((t) => t.toLowerCase()))
    .filter((t) => t && !excluded.has(t));
  return mostCommon(tags, topN).map(([hashtag, frequency]) => ({ hashtag, frequency }));
}

function themeHits(tokens, lex) { let n = 0; for (const t of tokens) if (lex.has(t)) n++; return n; }

export function themeCounts(posts, config, themes = config.themes || {}) {
  const tiers = config.tier_labels;
  return Object.entries(themes).map(([theme, words]) => {
    const lex = new Set(words); const row = { theme }; let total = 0;
    for (const t of tiers) {
      const h = inTier(posts, t).reduce((s, p) => s + themeHits(p.content_tokens, lex), 0);
      row[t] = h; total += h;
    }
    row.total = total;
    return row;
  });
}

/** Theme hits as a share of each tier's tokens, so tiers of different sizes
 *  compare on emphasis. */
export function themeShares(posts, config, themes = config.themes || {}) {
  const tiers = config.tier_labels;
  const totals = Object.fromEntries(tiers.map((t) => [t, flatten(inTier(posts, t)).length]));
  return Object.entries(themes).map(([theme, words]) => {
    const lex = new Set(words); const row = { theme };
    for (const t of tiers) {
      const h = inTier(posts, t).reduce((s, p) => s + themeHits(p.content_tokens, lex), 0);
      row[t] = totals[t] ? pyRound((h / totals[t]) * 100, 2) : 0;
    }
    return row;
  });
}

/** The full lexical suite in one object. */
export function analyze(posts, config, stopwordData) {
  const tok = addTokens(posts, config, stopwordData);
  const tiers = config.tier_labels;
  return {
    posts: tok,
    topWords: topWords(tok, 30),
    topWordsByTier: topWordsByTier(tok, tiers, 20),
    keynessByTier: keynessAllTiers(tok, tiers, 20),
    bigrams: topNgrams(tok, 2, 20),
    trigrams: topNgrams(tok, 3, 15),
    hashtags: cooccurringHashtags(tok, config.query_hashtags || [], 25),
    themeCounts: themeCounts(tok, config),
    themeShares: themeShares(tok, config),
  };
}
