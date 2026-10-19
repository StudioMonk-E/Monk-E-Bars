// Charts, as inline SVG.
//
// No charting library: the page loads franc, SheetJS and js-yaml from a CDN
// because porting them would be foolish, but a bar and a line are a few dozen
// lines each and a library would be the largest thing on the page. Inline SVG
// also inherits the palette's custom properties directly, so a chart cannot
// drift from the stylesheet.
//
// Every function takes posts and returns a string. Nothing here reads state.

const W = 900;                       // user units; the svg scales to its column
const PAD = { l: 46, r: 12, t: 10, b: 26 };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-GB") : String(n ?? ""));
const short = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)));

/** Tier colours, matching the bars in app.js. An ordered ramp, because tiers
 *  are ordered: heavyweight really is "more" than lightweight. */
const TIER_FILL = ["var(--ink)", "var(--ink-60)", "var(--ink-35)", "#A89B8B", "#C0B6A8", "#D6CDBE"];
const tierFill = (tiers, t) => TIER_FILL[Math.max(0, tiers.indexOf(t)) % TIER_FILL.length];

/** Categories are not ordered -- a photo is not "more" than a video -- so they
 *  take distinct hues from the palette rather than steps along one ramp. */
const CAT_FILL = ["var(--gold)", "var(--cobalt)", "var(--ink)", "var(--alert)", "var(--ink-35)", "#8E7CC3"];
export const catFill = (i) => CAT_FILL[i % CAT_FILL.length];

function frame(h, body, title) {
  return `<div class="chart"><svg viewBox="0 0 ${W} ${h}" role="img" preserveAspectRatio="xMidYMid meet">`
    + `<title>${esc(title)}</title>${body}</svg></div>`;
}
const note = (text) => `<p class="plain">${esc(text)}</p>`;

function axisLabel(x, y, text, anchor = "middle", cls = "ax") {
  return `<text class="${cls}" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`;
}

// --- time --------------------------------------------------------------------

const DAY = 86400000;

/** Day, week or month, whichever gives a readable number of columns. */
function bucketer(span) {
  if (span <= 24 * DAY) return { size: DAY, label: (d) => `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, name: "day" };
  if (span <= 240 * DAY) return { size: 7 * DAY, label: (d) => `${d.getUTCDate()}/${d.getUTCMonth() + 1}`, name: "week" };
  return { size: 30 * DAY, label: (d) => d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" }), name: "month" };
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/**
 * When posts went out, and how they did.
 *
 * Two rows on one time axis rather than two scales on one axis: counts and
 * engagement do not share units, and drawing them against a second y axis
 * invites the reader to see a crossing where there is only a choice of scale.
 */
export function timeline(posts) {
  const dated = posts.filter((p) => p.timestamp && Number.isFinite(Date.parse(p.timestamp)));
  if (dated.length < 4) return note("Too few dated posts to draw a timeline.");

  const times = dated.map((p) => Date.parse(p.timestamp));
  const lo = Math.min(...times), hi = Math.max(...times);
  const b = bucketer(hi - lo);
  const n = Math.max(1, Math.ceil((hi - lo + 1) / b.size));
  if (n > 64) return note("The date range is too long to draw usefully. Narrow it in Scope.");

  const cells = Array.from({ length: n }, () => []);
  for (const p of dated) cells[Math.min(n - 1, Math.floor((Date.parse(p.timestamp) - lo) / b.size))].push(p);

  const counts = cells.map((c) => c.length);
  const meds = cells.map((c) => median(c.map((p) => p.engagement_score || 0)));
  const maxC = Math.max(...counts, 1), maxM = Math.max(...meds, 1);

  // Each row carries its caption in a band of its own above the plot. Drawn
  // inside it, the first bar paints over the words.
  const rowH = 64, capH = 16, gap = 22;
  const h = PAD.t + (capH + rowH) * 2 + gap + PAD.b + 10;
  const top1 = PAD.t + capH, top2 = top1 + rowH + gap + capH;
  const iw = W - PAD.l - PAD.r;
  const slot = iw / n;
  // A wide column gets proportional air around it; a narrow one keeps 3 units.
  const bw = Math.max(2, Math.min(slot * 0.8, slot - 3));
  const x = (i) => PAD.l + slot * i + (slot - bw) / 2;

  const row = (vals, max, top, fill) => vals.map((v, i) => {
    const bh = max ? (v / max) * rowH : 0;
    return `<rect x="${x(i).toFixed(1)}" y="${(top + rowH - bh).toFixed(1)}" width="${bw.toFixed(1)}" `
      + `height="${Math.max(v ? 1.5 : 0, bh).toFixed(1)}" fill="${fill}"><title>${esc(b.name)} of `
      + `${esc(b.label(new Date(lo + i * b.size)))}: ${fmt(v)}</title></rect>`;
  }).join("");

  // A label every few columns, so they never collide.
  const every = Math.ceil(n / 10);
  const ticks = cells.map((_, i) => (i % every ? "" :
    axisLabel(x(i) + bw / 2, h - 8, b.label(new Date(lo + i * b.size))))).join("");

  const band = (caption, top, max, vals, fill) =>
    axisLabel(PAD.l, top - 5, caption, "start", "ax lab")
    + axisLabel(PAD.l - 8, top + 9, short(max), "end")
    + axisLabel(PAD.l - 8, top + rowH, "0", "end")
    + row(vals, max, top, fill)
    + `<line x1="${PAD.l}" y1="${top + rowH}" x2="${W - PAD.r}" y2="${top + rowH}" stroke="var(--rule)"/>`;

  const body = band("posts published", top1, maxC, counts, "var(--ink-60)")
    + band(`median engagement that ${b.name}`, top2, maxM, meds, "var(--gold)")
    + ticks;
  return frame(h, body, `Posts and median engagement by ${b.name}`);
}

// --- the shape of the engagement ---------------------------------------------

/**
 * Every post ranked, strongest first.
 *
 * Social engagement is heavily skewed, and a histogram of it is one tall bar
 * against an empty axis. The ranked curve shows the skew itself: how steep the
 * head is, how long the tail runs, and where the tier cuts actually fall.
 */
export function rankedCurve(posts, tiers = []) {
  const vals = posts.map((p) => p.engagement_score || 0).sort((a, b) => b - a);
  if (vals.length < 4) return note("Too few posts to draw a curve.");
  const max = Math.max(...vals, 1);
  const h = 190, ih = h - PAD.t - PAD.b, iw = W - PAD.l - PAD.r;
  const x = (i) => PAD.l + (i / (vals.length - 1)) * iw;
  const y = (v) => PAD.t + ih - (v / max) * ih;

  // Tier bands behind the curve: equal groups, as the tiers are cut.
  const per = vals.length / (tiers.length || 1);
  const bands = tiers.map((t, i) => {
    const x0 = PAD.l + (i * per / vals.length) * iw, x1 = PAD.l + ((i + 1) * per / vals.length) * iw;
    return `<rect x="${x0.toFixed(1)}" y="${PAD.t}" width="${Math.max(0, x1 - x0).toFixed(1)}" height="${ih}" `
      + `fill="${tierFill(tiers, t)}" opacity="${0.07 + 0.03 * (tiers.length - i)}"/>`
      + axisLabel((x0 + x1) / 2, PAD.t + 13, t.toLowerCase(), "middle", "ax");
  }).join("");

  const area = `M ${PAD.l} ${PAD.t + ih} ` + vals.map((v, i) => `L ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ")
    + ` L ${(PAD.l + iw).toFixed(1)} ${PAD.t + ih} Z`;
  const line = vals.map((v, i) => `${i ? "L" : "M"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");

  const mid = Math.floor(vals.length / 2), med = vals[mid];
  const body = bands
    + `<path d="${area}" fill="var(--gold)" opacity="0.18"/>`
    + `<path d="${line}" fill="none" stroke="var(--gold)" stroke-width="2"/>`
    + `<line x1="${x(mid).toFixed(1)}" y1="${PAD.t}" x2="${x(mid).toFixed(1)}" y2="${PAD.t + ih}" `
      + `stroke="var(--cobalt)" stroke-width="1.5" stroke-dasharray="4 3"/>`
    + axisLabel(x(mid) + 6, PAD.t + ih - 6, `halfway: ${fmt(med)}`, "start", "ax mark")
    + `<line x1="${PAD.l}" y1="${PAD.t + ih}" x2="${W - PAD.r}" y2="${PAD.t + ih}" stroke="var(--rule)"/>`
    + axisLabel(PAD.l - 8, PAD.t + 10, short(max), "end")
    + axisLabel(PAD.l - 8, PAD.t + ih, "0", "end")
    + axisLabel(PAD.l, h - 6, "strongest post", "start", "ax")
    + axisLabel(W - PAD.r, h - 6, `weakest of ${fmt(vals.length)}`, "end", "ax");
  return frame(h, body, "Every post ranked by engagement");
}

// --- reach against response ---------------------------------------------------

/**
 * Views against engagement, both on a log scale.
 *
 * This is the picture behind the view floor: the posts sitting far left are
 * the ones whose rate is loud because almost nobody saw them. Log scales on
 * both axes because reach spans several orders of magnitude and a linear plot
 * puts every post except the hits in one corner.
 */
export function viewsScatter(posts, { floor = 0, tiers = [] } = {}) {
  const pts = posts.filter((p) => p.view_count > 0 && p.engagement_score > 0);
  if (pts.length < 6) return note("Not enough posts carry a view count to plot this. Instagram captures carry none.");

  const lg = (v) => Math.log10(Math.max(1, v));
  const xs = pts.map((p) => lg(p.view_count)), ys = pts.map((p) => lg(p.engagement_score));
  const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
  const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
  const h = 240, ih = h - PAD.t - PAD.b, iw = W - PAD.l - PAD.r;
  const X = (v) => PAD.l + ((lg(v) - x0) / Math.max(0.0001, x1 - x0)) * iw;
  const Y = (v) => PAD.t + ih - ((lg(v) - y0) / Math.max(0.0001, y1 - y0)) * ih;

  const grid = [];
  for (let e = x0; e <= x1; e++) {
    grid.push(`<line x1="${X(10 ** e).toFixed(1)}" y1="${PAD.t}" x2="${X(10 ** e).toFixed(1)}" y2="${PAD.t + ih}" stroke="var(--rule)" opacity="0.5"/>`);
    grid.push(axisLabel(X(10 ** e), h - 8, short(10 ** e)));
  }
  for (let e = y0; e <= y1; e++) {
    grid.push(`<line x1="${PAD.l}" y1="${Y(10 ** e).toFixed(1)}" x2="${W - PAD.r}" y2="${Y(10 ** e).toFixed(1)}" stroke="var(--rule)" opacity="0.5"/>`);
    grid.push(axisLabel(PAD.l - 8, Y(10 ** e) + 4, short(10 ** e), "end"));
  }

  const dots = pts.map((p) => `<circle cx="${X(p.view_count).toFixed(1)}" cy="${Y(p.engagement_score).toFixed(1)}" r="3.2" `
    + `fill="${tierFill(tiers, p.engagement_tier)}" opacity="0.75"><title>${esc(p.author_handle || "post")}: `
    + `${fmt(p.view_count)} views, ${fmt(p.engagement_score)} engagement</title></circle>`).join("");

  const floorLine = floor > 0 && floor >= 10 ** x0 && floor <= 10 ** x1
    ? `<line x1="${X(floor).toFixed(1)}" y1="${PAD.t}" x2="${X(floor).toFixed(1)}" y2="${PAD.t + ih}" `
      + `stroke="var(--alert)" stroke-width="1.5" stroke-dasharray="4 3"/>`
      + axisLabel(X(floor) + 6, PAD.t + 12, `floor: ${fmt(floor)} views`, "start", "ax mark")
    : "";

  return frame(h, grid.join("") + dots + floorLine
    + axisLabel(PAD.l, PAD.t - 2, "engagement", "start", "ax lab")
    + axisLabel(W - PAD.r, PAD.t + ih - 8, "views \u2192", "end", "ax lab"),
    "Views against engagement, both on a log scale");
}

// --- months -------------------------------------------------------------------

/**
 * One series a month, as columns with their figure printed on top.
 *
 * Months are few enough to label every one, which is worth more than a dense
 * axis: the reader is comparing named months, not reading a curve. A month
 * too thin to mean anything is drawn hollow rather than left out, so a gap in
 * the posting is visible instead of silently closed up.
 */
export function monthBars(rows, key, { fill = "var(--gold)", suffix = "", caption = "" } = {}) {
  const vals = rows.map((r) => (r[key] == null ? 0 : r[key]));
  if (!rows.length) return note("No month holds enough posts to chart.");
  const max = Math.max(...vals, 1);
  const capH = 20, rowH = 96, h = PAD.t + capH + rowH + 30;
  const top = PAD.t + capH;
  // The tallest column stops short of the caption, because its figure is
  // printed above it and the two would otherwise land on each other.
  const plot = rowH * 0.86;
  const iw = W - PAD.l - PAD.r, slot = iw / rows.length;
  const bw = Math.max(6, Math.min(slot * 0.62, 70));
  const x = (i) => PAD.l + slot * i + (slot - bw) / 2;

  const cols = rows.map((r, i) => {
    const v = r[key];
    if (v == null) {
      return axisLabel(x(i) + bw / 2, top + rowH - 6, "\u2013", "middle", "ax");
    }
    const bh = (v / max) * plot;
    const hollow = r.thin
      ? ` fill="none" stroke="${fill}" stroke-width="1.5" stroke-dasharray="3 2"`
      : ` fill="${fill}"`;
    return `<rect x="${x(i).toFixed(1)}" y="${(top + rowH - bh).toFixed(1)}" width="${bw.toFixed(1)}" `
      + `height="${Math.max(1.5, bh).toFixed(1)}"${hollow}><title>${esc(r.label)}: ${fmt(v)}${esc(suffix)}`
      + `${r.thin ? ` (only ${fmt(r.posts)} posts)` : ""}</title></rect>`
      + axisLabel(x(i) + bw / 2, top + rowH - bh - 5, short(v) + suffix, "middle", "ax mark");
  }).join("");

  const ticks = rows.map((r, i) => axisLabel(x(i) + bw / 2, h - 10, r.label)).join("");
  return frame(h, (caption ? axisLabel(PAD.l, top - 5, caption, "start", "ax lab") : "")
    + cols
    + `<line x1="${PAD.l}" y1="${top + rowH}" x2="${W - PAD.r}" y2="${top + rowH}" stroke="var(--rule)"/>`
    + ticks, caption || "By month");
}

/**
 * The mix: each month as a column of one hundred percent, split by value.
 *
 * Shares rather than counts, because the question is whether the mix changed,
 * and a month with more posts in it would otherwise look like a mix change.
 */
export function mixBars(rows, values, { caption = "" } = {}) {
  if (!rows.length || !values.length) return note("Nothing to break down yet.");
  const capH = 16, rowH = 110, h = PAD.t + capH + rowH + 30;
  const top = PAD.t + capH;
  const iw = W - PAD.l - PAD.r, slot = iw / rows.length;
  const bw = Math.max(6, Math.min(slot * 0.62, 70));
  const x = (i) => PAD.l + slot * i + (slot - bw) / 2;

  const cols = rows.map((r, i) => {
    let y = top;
    return values.map((v, vi) => {
      const share = r.posts ? r.counts[v] / r.posts : 0;
      const bh = share * rowH;
      const rect = `<rect x="${x(i).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" `
        + `height="${bh.toFixed(1)}" fill="${catFill(vi)}" opacity="0.92">`
        + `<title>${esc(r.label)}, ${esc(v)}: ${fmt(r.counts[v])} of ${fmt(r.posts)} posts`
        + `${r.medians[v] == null ? "" : `, median ${fmt(r.medians[v])}`}</title></rect>`;
      y += bh;
      return bh > 0 ? rect : "";
    }).join("");
  }).join("");

  const ticks = rows.map((r, i) => axisLabel(x(i) + bw / 2, h - 10, r.label)).join("");
  const legend = values.map((v, vi) => `<span><i style="background:${catFill(vi)}"></i>${esc(v)}</span>`).join("");
  return `<div class="chart">`
    + `<svg viewBox="0 0 ${W} ${h}" role="img" preserveAspectRatio="xMidYMid meet"><title>${esc(caption || "Mix by month")}</title>`
    + (caption ? axisLabel(PAD.l, top - 5, caption, "start", "ax lab") : "")
    + cols
    + `<line x1="${PAD.l}" y1="${top + rowH}" x2="${W - PAD.r}" y2="${top + rowH}" stroke="var(--rule)"/>`
    + `${axisLabel(PAD.l - 8, top + 9, "100%", "end")}${axisLabel(PAD.l - 8, top + rowH, "0", "end")}`
    + ticks + `</svg><div class="legend">${legend}</div></div>`;
}
