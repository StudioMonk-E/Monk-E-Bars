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

/**
 * Every tag column present, plus the ones the capture already carries.
 *
 * Platform and account are offered only when a session holds more than one,
 * since a dimension with a single value breaks nothing down.
 */
export function dimensions(posts) {
  const names = new Set();
  for (const p of posts) for (const k of Object.keys(p.tags || {})) names.add(k);
  const out = [...names].sort();
  if (posts.some((p) => p.media_type && p.media_type !== "unknown")) out.unshift("media type");
  if (new Set(posts.map((p) => p.author_handle).filter(Boolean)).size > 1) out.unshift("account");
  if (new Set(posts.map((p) => p.platform).filter(Boolean)).size > 1) out.unshift("platform");
  return out;
}

/** One post's value on a dimension, including the built-in ones. */
export function valueOf(post, dim) {
  if (dim === "platform") return post.platform || UNTAGGED;
  if (dim === "account") return post.author_handle || UNTAGGED;
  if (dim === "media type") return post.media_type && post.media_type !== "unknown" ? post.media_type : UNTAGGED;
  const v = (post.tags || {})[dim];
  return v === undefined || v === "" ? UNTAGGED : String(v);
}

/** The platforms a session holds. A median taken across two of them is a
 *  median of two different scales. */
export const platformsIn = (posts) => [...new Set(posts.map((p) => p.platform).filter(Boolean))].sort();

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

// --- two periods --------------------------------------------------------------

/**
 * A default pair of periods: the first third of the months against the last.
 *
 * The same split `readTrend` uses, so the comparison a reader opens on is the
 * one the sentence above it already describes. Thin months are left out of the
 * choosing but not out of the periods themselves: a quiet month still belongs
 * to the stretch it falls in.
 */
export function defaultPeriods(rows) {
  const usable = rows.filter((r) => !r.thin);
  const pool = usable.length >= 4 ? usable : rows;
  if (pool.length < 2) return null;
  const n = Math.max(1, Math.floor(pool.length / 3));
  return {
    aFrom: pool[0].month, aTo: pool[n - 1].month,
    bFrom: pool[pool.length - n].month, bTo: pool[pool.length - 1].month,
  };
}

/** Posts falling inside a month range, inclusive at both ends. */
export function inPeriod(posts, from, to) {
  if (!from || !to) return [];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return posts.filter((p) => {
    if (!p.timestamp) return false;
    const k = monthKey(p.timestamp);
    return k >= lo && k <= hi;
  });
}

/** The headline figures for one period, on the same definitions as a month. */
export function periodStats(posts, metric = "views") {
  const get = metric === "views" ? (p) => p.view_count || 0 : (p) => p.engagement_score || 0;
  const vals = posts.map(get);
  const total = vals.reduce((s, v) => s + v, 0);
  const top3 = vals.slice().sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0);
  return {
    posts: posts.length,
    median: median(vals),
    total,
    top3_share: total ? Math.round((top3 / total) * 100) : null,
    perMonth: new Set(posts.map((p) => monthKey(p.timestamp))).size,
  };
}

/**
 * How a dimension's mix differs between two periods, in points.
 *
 * Shares rather than counts, because the periods are rarely the same length,
 * and a longer period would otherwise look like a mix change on its own.
 */
export function mixShift(a, b, dim) {
  const values = valuesOf([...a, ...b], dim).map((v) => v.value);
  const share = (ps, v) => (ps.length ? (ps.filter((p) => valueOf(p, dim) === v).length / ps.length) * 100 : 0);
  return values.map((value) => {
    // The change is taken from the rounded shares, not from the exact ones.
    // A reader subtracts the two columns in front of them, and 67 minus 33
    // has to be the 34 printed beside it rather than the 33 the unrounded
    // difference would give.
    const a_pct = Math.round(share(a, value)), b_pct = Math.round(share(b, value));
    return { value, a_pct, b_pct, change: b_pct - a_pct };
  }).sort((x, y) => Math.abs(y.change) - Math.abs(x.change));
}

// --- one account against the others --------------------------------------------

/**
 * Each account's median per month, and its trajectory indexed to its own start.
 *
 * The benchmark question is "did everyone fall, or only us", and absolute
 * medians cannot answer it: an account with four times the following has four
 * times the views whatever happens. So each account is indexed to its own
 * first usable month at 100, which puts a small account and a large one on the
 * same axis and compares the shape of the line rather than its height.
 *
 * A month where an account posted fewer than `minPosts` times carries no point
 * at all. A median over one post is noise, and joining the line through it
 * would draw a fall nobody had.
 */
export function byAccountMonth(posts, metric = "views", { minPosts = 3 } = {}) {
  const get = metric === "views" ? (p) => p.view_count || 0 : (p) => p.engagement_score || 0;
  const months = [...new Set(posts.filter((p) => p.timestamp).map((p) => monthKey(p.timestamp)))].sort();
  const handles = [...new Set(posts.map((p) => p.author_handle).filter(Boolean))];

  const series = handles.map((handle) => {
    const mine = posts.filter((p) => p.author_handle === handle && p.timestamp);
    const points = months.map((m) => {
      const ps = mine.filter((p) => monthKey(p.timestamp) === m);
      return ps.length >= minPosts ? { month: m, median: median(ps.map(get)), posts: ps.length } : null;
    });
    const seen = points.filter(Boolean);
    const base = seen.length ? seen[0].median : 0;
    return {
      handle,
      posts: mine.length,
      months: seen.length,
      points: points.map((pt) => (pt && base ? { ...pt, index: Math.round((pt.median / base) * 100) } : null)),
      first: seen.length ? seen[0] : null,
      last: seen.length ? seen[seen.length - 1] : null,
      change: seen.length > 1 && seen[0].median
        ? Math.round(((seen[seen.length - 1].median - seen[0].median) / seen[0].median) * 100) : null,
    };
  }).filter((sx) => sx.months >= 2)
    .sort((a, b) => b.posts - a.posts);

  return { months, series };
}

/**
 * Whether a fall is this account's alone.
 *
 * `focus` is compared against the median change of the others rather than
 * their mean, for the same reason every other figure here is a median: one
 * account having a freak month should not decide what the benchmark says.
 */
export function benchmark(series, focus) {
  const me = series.find((sx) => sx.handle === focus);
  const others = series.filter((sx) => sx.handle !== focus && sx.change != null);
  if (!me || me.change == null || others.length < 2) return null;
  const theirs = median(others.map((sx) => sx.change));
  const gap = me.change - theirs;
  let reading;
  if (me.change <= -10 && theirs <= -10) {
    reading = gap <= -15
      ? "Everyone fell, and this account fell further than most. Part of this is the platform and part of it is ours."
      : "Everyone fell by about the same amount. That points at the platform rather than at the content.";
  } else if (me.change <= -10) {
    reading = "This account fell while the others held. That points at our own content or mix, not at the platform.";
  } else if (theirs <= -10) {
    reading = "The others fell and this account held.";
  } else {
    reading = "Nothing moved much on either side.";
  }
  return { mine: me.change, theirs, gap, others: others.length, reading };
}
