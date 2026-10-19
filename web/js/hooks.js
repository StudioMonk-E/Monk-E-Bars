// Hooks: how the better half of a corpus opens, against the weaker half.
//
// The rest of the tool reads whole captions and drops the stopwords. A hook is
// the first few words only, and it is almost all stopwords: "stuur dit naar"
// is three function words and it is the entire hook. So openings are counted
// here on normalised tokens with nothing removed, and kept apart from the
// vocabulary measures that would otherwise delete them.
//
// The split is a half rather than a tier. Tiers cut a corpus into equal thirds
// and the middle third answers nothing; the question a hook asks is only
// "better or worse than the rest of what we posted".

import { normalize } from "./text.js";
import { overUsed } from "./lexical.js";
import { pyRound, mostCommon } from "./util.js";

export const HOOK_WORDS = 6;

/** The opening of a caption, stopwords and all. */
export function hookTokens(caption, words = HOOK_WORDS) {
  return normalize(caption).slice(0, words);
}

/**
 * Split a corpus into its better and weaker half by engagement.
 *
 * Cut by rank, not by the median value: nearly half a capture can tie on
 * engagement, and a strict "above the median" test then leaves one side almost
 * empty. Each platform is halved inside itself, for the same reason the tiers
 * are cut inside each platform -- likes on one are not likes on the other.
 *
 * An odd count puts the middle post in the weaker half, so a post has to beat
 * the halfway mark rather than merely reach it.
 */
export function halves(posts) {
  const above = [], below = [], cuts = [];
  for (const one of [...new Set(posts.map((p) => p.platform))]) {
    const ps = posts.filter((p) => p.platform === one)
      .slice().sort((a, b) => b.engagement_score - a.engagement_score);
    const half = Math.floor(ps.length / 2);
    above.push(...ps.slice(0, half));
    below.push(...ps.slice(half));
    if (half) cuts.push({ platform: one, cut: ps[half - 1].engagement_score, posts: ps.length });
  }
  return { above, below, cuts };
}

/** Words over-used in the openings of the better half. */
export function hookKeyness(above, below, { words = HOOK_WORDS, topN = 20, minFreq = 3 } = {}) {
  const bag = (ps) => ps.flatMap((p) => hookTokens(p.caption_text, words));
  return overUsed(bag(above), bag(below), "weaker half", topN, minFreq);
}

/**
 * The literal openings, and how they actually did.
 *
 * A phrase is only reported once enough posts used it, because the whole point
 * of the tool's view floor applies here too: two posts opening the same way
 * can read as a hundred percent hit rate and mean nothing. The share is of the
 * better half, so 0.5 is exactly what an opening with no effect would score.
 */
export function openers(posts, { size = 3, minPosts = 3, topN = 12 } = {}) {
  const { above } = halves(posts);
  const hot = new Set(above.map((p) => p.post_id));
  const groups = new Map();
  for (const p of posts) {
    const tokens = hookTokens(p.caption_text, size);
    if (tokens.length < size) continue;          // too short to have an opening
    const phrase = tokens.join(" ");
    if (!groups.has(phrase)) groups.set(phrase, []);
    groups.get(phrase).push(p);
  }
  const rows = [];
  for (const [phrase, ps] of groups) {
    if (ps.length < minPosts) continue;
    const hits = ps.filter((p) => hot.has(p.post_id)).length;
    const scores = ps.map((p) => p.engagement_score).sort((a, b) => a - b);
    const mid = Math.floor(scores.length / 2);
    rows.push({
      phrase,
      posts: ps.length,
      in_better_half: hits,
      share: pyRound(hits / ps.length, 2),
      median_engagement: scores.length % 2 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2),
    });
  }
  // Best hit rate first, then the one more posts stand behind.
  return rows.sort((a, b) => b.share - a.share || b.posts - a.posts).slice(0, topN);
}

/** The commonest openings overall, whether or not they did anything. */
export function commonOpenings(posts, { size = 3, topN = 10 } = {}) {
  const phrases = posts.map((p) => hookTokens(p.caption_text, size))
    .filter((t) => t.length === size).map((t) => t.join(" "));
  return mostCommon(phrases, topN).map(([phrase, frequency]) => ({ phrase, frequency }));
}
