// Gains: when followers arrived, and what the account did first.
//
// Neither platform records where a follower came from. What an export does
// carry is the moment each one followed, and that is enough to ask a narrower
// question honestly: did follows run above their usual rate in the hours after
// something, and what was that something.
//
// This is correlation inside a time window. A spike after a comment on a large
// account is evidence that commenting worked; it is not a path anyone traced,
// and two things in the same hour cannot be told apart. Every figure here is
// built to be read that way, which is why the lift is reported against a
// measured baseline rather than presented as attribution.
//
// One bias is worth stating wherever these numbers are shown: an export lists
// current followers only. Anyone who followed and later left is absent, so the
// further back a week sits, the thinner it reads.

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Median absolute deviation, scaled to compare with a standard deviation.
 *  A spike would drag a mean and its deviation up with it; this stays put. */
function mad(xs) {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

// A multiple is measured against the usual rate, with a floor under it. Without
// one, an account that normally gains nothing would turn three follows into a
// three-hundred-fold result; with it, a quiet baseline still reads as a quiet
// baseline and the figure stays worth quoting.
const FLOOR_PER_DAY = 1;
const FLOOR_PER_WINDOW = 0.5;
const times = (count, expected, floor) => Math.round((count / Math.max(expected, floor)) * 10) / 10;

const dayStart = (ts) => Math.floor(ts / DAY) * DAY;
const hourStart = (ts) => Math.floor(ts / HOUR) * HOUR;

/** Follows per day across the whole period, including the quiet days. */
export function daily(follows) {
  if (!follows.length) return [];
  const counts = new Map();
  for (const f of follows) counts.set(dayStart(f.ts), (counts.get(dayStart(f.ts)) || 0) + 1);
  const from = dayStart(follows[0].ts), to = dayStart(follows[follows.length - 1].ts);
  const out = [];
  for (let d = from; d <= to; d += DAY) out.push({ start: d, count: counts.get(d) || 0 });
  return out;
}

export function hourly(follows) {
  const counts = new Map();
  for (const f of follows) counts.set(hourStart(f.ts), (counts.get(hourStart(f.ts)) || 0) + 1);
  return counts;
}

/**
 * The usual rate, in follows per hour, over the days before a moment.
 *
 * Taken as a median over a trailing window, so the account's own growth is
 * followed rather than averaged across a year, and a single viral day does not
 * become the standard everything after it is measured against.
 */
export function baseline(days, at, lookbackDays = 28) {
  const window = days.filter((d) => d.start < at && d.start >= at - lookbackDays * DAY);
  const use = window.length >= 3 ? window : days.filter((d) => d.start < at);
  if (!use.length) return { perDay: 0, perHour: 0, spread: 0 };
  const counts = use.map((d) => d.count);
  const perDay = median(counts);
  return { perDay, perHour: perDay / 24, spread: mad(counts) || Math.sqrt(Math.max(perDay, 1)) };
}

/**
 * Days where follows ran clearly above the account's own rate.
 *
 * Three tests together, because any one of them alone fires on noise: the day
 * has to stand above the spread, stand above the rate by half again, and clear
 * a floor, since on a small account two follows in a day is not an event.
 */
export function spikes(follows, { minFollows = 5, z = 3, lift = 1.5 } = {}) {
  const days = daily(follows);
  const byHour = hourly(follows);
  const out = [];
  for (const day of days) {
    const base = baseline(days, day.start);
    const threshold = Math.max(base.perDay + z * base.spread, base.perDay * lift, minFollows);
    if (day.count < threshold) continue;
    // The busiest two hours inside the day, which is the window worth reading
    // an event against.
    let peak = { start: day.start, count: 0 };
    for (let h = day.start; h < day.start + DAY; h += HOUR) {
      const count = (byHour.get(h) || 0) + (byHour.get(h + HOUR) || 0);
      if (count > peak.count) peak = { start: h, count };
    }
    out.push({
      day: day.start, follows: day.count,
      expected: Math.round(base.perDay * 10) / 10,
      times: times(day.count, base.perDay, FLOOR_PER_DAY),
      peakStart: peak.start, peakFollows: peak.count,
    });
  }
  return out.sort((a, b) => b.follows - a.follows);
}

/**
 * What the account did in the hours before a window, nearest first.
 *
 * Nearest, not only, on purpose: a spike with three candidates in front of it
 * should show all three rather than pick one and look certain.
 */
export function precedes(events, at, lookbackHours = 6) {
  return events
    .filter((e) => e.ts <= at && e.ts > at - lookbackHours * HOUR)
    .sort((a, b) => b.ts - a.ts);
}

/**
 * Every action the account took, with the follows that arrived after it.
 *
 * `lift` compares those follows against the baseline for the same stretch of
 * time, so a busy hour on a growing account is not mistaken for an effect. Where
 * two actions sit inside one window, both carry the same follows, and
 * `shared` says so rather than splitting a number nobody can split.
 */
export function stimulus(events, follows, { windowHours = 2, lookbackDays = 28 } = {}) {
  const days = daily(follows);
  const sorted = [...follows].sort((a, b) => a.ts - b.ts);
  const at = (ts) => {                       // index of the first follow at or after ts
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid].ts < ts) lo = mid + 1; else hi = mid; }
    return lo;
  };
  return events.map((e) => {
    const end = e.ts + windowHours * HOUR;
    const count = at(end) - at(e.ts);
    const base = baseline(days, dayStart(e.ts), lookbackDays);
    const expected = base.perHour * windowHours;
    const shared = events.filter((o) => o !== e && o.ts > e.ts - windowHours * HOUR && o.ts < end).length;
    return {
      ...e,
      follows: count,
      expected: Math.round(expected * 10) / 10,
      times: times(count, expected, FLOOR_PER_WINDOW),
      shared,
    };
  }).sort((a, b) => b.follows - a.follows);
}

/** The headline figures for a period. */
export function summary(follows, events) {
  if (!follows.length) return null;
  const days = daily(follows);
  const from = follows[0].ts, to = follows[follows.length - 1].ts;
  const span = Math.max(1, Math.round((to - from) / DAY));
  const last30 = follows.filter((f) => f.ts > to - 30 * DAY).length;
  return {
    follows: follows.length, from, to, days: span,
    perDay: Math.round((follows.length / span) * 10) / 10,
    last30, events: events.length,
    busiest: days.reduce((best, d) => (!best || d.count > best.count ? d : best), null),
  };
}

/** Follows by week, for a period too long to read a day at a time. */
export function weekly(follows) {
  const days = daily(follows);
  const out = [];
  for (const d of days) {
    const week = d.start - ((new Date(d.start).getUTCDay() + 6) % 7) * DAY;   // weeks start on Monday
    const last = out[out.length - 1];
    if (last && last.start === week) last.count += d.count;
    else out.push({ start: week, count: d.count });
  }
  return out;
}
