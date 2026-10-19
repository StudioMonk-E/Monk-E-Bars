// Month by month: is the baseline falling, or have the hits stopped?
//
// Those are two different stories with two different fixes, and a monthly
// total cannot tell them apart. A month of steady, unremarkable posts and a
// month carried by one hit can add up to the same number.
//
//   median per post  -- the baseline. What an ordinary post does.
//   top-three share  -- the hit dependence. How much of the month rode on
//                       its three best posts.
//
// Read together they separate the two: a falling median is a baseline
// problem, a falling top-three share with a steady median means the hits
// stopped arriving, and both falling at once is the platform or the mix.
//
// The median is used throughout rather than the mean, because one hit drags a
// mean up by itself, which is the very thing being measured.

export const UNTAGGED = "untagged";

export function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const monthKey = (ts) => String(ts).slice(0, 7);          // "2026-09"
export const monthName = (key) => {
  const [y, m] = String(key).split("-");
  return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
    .replace(" ", " ");
};

/** True when any post carries a view count. Instagram captures carry none, so
 *  a view-based reading has to fall back to likes plus comments and say so. */
export const hasViews = (posts) => posts.some((p) => p.view_count > 0);

/** Every tag column present, plus the media type the adapters already set. */
export function dimensions(posts) {
  const names = new Set();
  for (const p of posts) for (const k of Object.keys(p.tags || {})) names.add(k);
  const out = [...names].sort();
  if (posts.some((p) => p.media_type && p.media_type !== "unknown")) out.unshift("media type");
  return out;
}

/** One post's value on a dimension, including the built-in media type. */
export function valueOf(post, dim) {
  if (dim === "media type") return post.media_type && post.media_type !== "unknown" ? post.media_type : UNTAGGED;
  const v = (post.tags || {})[dim];
  return v === undefined || v === "" ? UNTAGGED : String(v);
}

/** The distinct values a dimension takes, commonest first. */
export function valuesOf(posts, dim) {
  const counts = new Map();
  for (const p of posts) {
    const v = valueOf(p, dim);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, posts]) => ({ value, posts }));
}

/**
 * The months themselves, oldest first.
 *
 * `metric` is "views" or "engagement". A post with no timestamp has no month
 * and is counted out, with the number of those reported, because silently
 * dropping a tenth of a capture out of a trend is how a trend gets invented.
 */
export function byMonth(posts, metric = "views") {
  const get = metric === "views" ? (p) => p.view_count || 0 : (p) => p.engagement_score || 0;
  const groups = new Map();
  let undated = 0;
  for (const p of posts) {
    if (!p.timestamp) { undated++; continue; }
    const k = monthKey(p.timestamp);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  const rows = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, ps]) => {
    const vals = ps.map(get);
    const total = vals.reduce((s, v) => s + v, 0);
    const top3 = vals.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
    return {
      month: key,
      label: monthName(key),
      posts: ps.length,
      median: median(vals),
      total,
      // Undefined rather than 0 when the month scored nothing at all: a share
      // of nothing is not zero percent, it is unanswerable.
      top3_share: total ? Math.round((top3 / total) * 100) : null,
      // A month of one or two posts cannot have a meaningful top three.
      thin: ps.length < 4,
      items: ps,
    };
  });
  return { rows, undated };
}

/**
 * A dimension's share of each month, and how each value actually did.
 *
 * Returns one row per month with a count and a median per value, so a mix
 * change and a performance change can be read off the same table: more photos
 * is only an explanation if photos also do worse.
 */
export function mixByMonth(posts, dim, metric = "views") {
  const get = metric === "views" ? (p) => p.view_count || 0 : (p) => p.engagement_score || 0;
  const { rows } = byMonth(posts, metric);
  const values = valuesOf(posts, dim).map((v) => v.value);
  return {
    values,
    rows: rows.map((r) => {
      const counts = {}, medians = {};
      for (const v of values) {
        const ps = r.items.filter((p) => valueOf(p, dim) === v);
        counts[v] = ps.length;
        medians[v] = ps.length ? median(ps.map(get)) : null;
      }
      return { month: r.month, label: r.label, posts: r.posts, counts, medians };
    }),
  };
}

/**
 * The reading the two series support, in one sentence.
 *
 * Deliberately conservative: it compares the first and last third of the
 * months covered rather than the first and last month, which on a short run
 * would turn one quiet August into a trend. It says nothing at all under four
 * months, because three points do not carry a direction.
 */
export function readTrend(rows) {
  const usable = rows.filter((r) => !r.thin);
  if (usable.length < 4) return null;
  const n = Math.max(1, Math.floor(usable.length / 3));
  const early = usable.slice(0, n), late = usable.slice(-n);
  const avg = (xs) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
  const m0 = avg(early.map((r) => r.median)), m1 = avg(late.map((r) => r.median));
  const s0 = avg(early.filter((r) => r.top3_share != null).map((r) => r.top3_share));
  const s1 = avg(late.filter((r) => r.top3_share != null).map((r) => r.top3_share));
  const pct = (a, b) => (a ? Math.round(((b - a) / a) * 100) : null);
  const medianChange = pct(m0, m1), shareChange = s1 - s0;

  const span = `${early[0].label}–${early[early.length - 1].label} against `
    + `${late[0].label}–${late[late.length - 1].label}`;
  const down = medianChange != null && medianChange <= -10;
  const up = medianChange != null && medianChange >= 10;
  const hitsDown = shareChange <= -8;

  let reading;
  if (down && hitsDown) reading = "Both have fallen: the ordinary post does less and the hits have thinned out too. "
    + "That pattern usually points outside the content, so the benchmark is the next thing to check.";
  else if (down) reading = "The baseline has fallen: an ordinary post does less than it did. "
    + "That is a content or mix question, not a missing-hit question.";
  else if (hitsDown) reading = "The baseline is holding and the hits have thinned out. "
    + "The months that looked better were carried by their top posts, not by a stronger average post.";
  else if (up) reading = "The baseline has risen.";
  else reading = "Neither the baseline nor the hit dependence has moved much.";

  return { span, medianChange, shareChange: Math.round(shareChange), reading,
           earlyMedian: Math.round(m0), lateMedian: Math.round(m1) };
}
