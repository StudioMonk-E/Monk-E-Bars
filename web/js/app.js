// Monk-E Bars in the browser.
//
// A dropped file is read, parsed and language-detected once. Every setting after
// that filters an array already in memory, so a click costs milliseconds and
// nothing is ever re-read. The Streamlit version reran its whole script on each
// interaction, which on a shared server was the difference between a filter and
// a reset.
//
// Nothing leaves the tab. There is no server to send a capture to.
//
// The interface says what each thing is: Overview, Words, Accounts, Posts, and
// Scope and Setup for the two kinds of setting. The gym voice is kept to the
// chrome -- the title, "Load the bar", "Warming up" -- and to the tier names
// themselves, which read as what they are: Heavyweight down to Lightweight.
// An earlier version named every control in gym terms and printed its plain
// meaning underneath, which meant reading each label twice to find anything.

import { parseNdjson, detect, parseRecords, parseTable, guessMapping } from "./ingest.js";
import { setContractions } from "./text.js";
import { buildCorpus, filterLanguages, filterDates, filterViews, retier, languageCounts, makeDetector } from "./corpus.js";
import { analyze, keyness, keynessAllTiers, topWords, overUsed } from "./lexical.js";
import * as H from "./hooks.js";
import * as C from "./charts.js";
import * as M from "./months.js";
import { discoverThemes } from "./topics.js";
import * as A from "./accounts.js";
import { generate, setLanguageNames, langName } from "./findings.js";
import { accountsWorkbook, postsWorkbook, profileUrl } from "./export.js";
import { looksLikeExport, readZip, buildAccountData } from "./account.js";
import * as G from "./gains.js";

// Pinned, so an analysis cannot change underneath a program between visits.
const LIB = {
  franc: "https://cdn.jsdelivr.net/npm/franc@6.2.0/+esm",
  // 0.20.3 from SheetJS's own CDN: the npm registry stops at 0.18.5, which has
  // two published vulnerabilities in its parser.
  xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
  yaml: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs",
  // Reads the JSON out of an export zip and leaves the media compressed.
  fflate: "https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm",
};
const libs = {};
const lib = (name) => (libs[name] ??= import(LIB[name]));

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Only web links become links. A spreadsheet's URL column can hold anything.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const link = (u, text) => (safeUrl(u) ? `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));
const emphasis = (t) => esc(t).replace(/\*([^*]+)\*/g, "<b>$1</b>");
const fmt = (n) => (n == null || n === "" ? "" : typeof n === "number" ? n.toLocaleString("en-GB") : String(n));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const lines = (v) => String(v || "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

// --- reference data ----------------------------------------------------------

let SW, SAMPLES;
async function loadData() {
  const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  const [sw, contractions, types, names, studies] = await Promise.all([
    get("stopwords.json"), get("contractions.json"), get("account_types.json"),
    get("languages.json"), get("configs.json")]);
  SW = sw; SAMPLES = studies;
  setContractions(contractions);
  A.setAccountTypes(types);
  setLanguageNames(names);
}

// Tiers are weight classes here. A program that names its own tiers keeps them.
const WEIGHTS = ["Heavyweight", "Middleweight", "Lightweight"];
const DEFAULT_TIERS = ["High", "Medium", "Low"];

/** A program in the shape the pipeline reads, with the package's defaults. */
function normalizeProgram(d, file = "") {
  d = d || {};
  const dateStr = (v) => (v == null || v === "" ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const tiers = (d.tier_labels && d.tier_labels.length ? d.tier_labels : DEFAULT_TIERS).map(String);
  const p = {
    file,
    name: d.name || "session",
    description: d.description || "",
    claim: String(d.claim || "").trim(),
    language: d.language === undefined ? null : d.language,
    tier_labels: String(tiers) === String(DEFAULT_TIERS) ? [...WEIGHTS] : tiers,
    query_hashtags: (d.query_hashtags || []).map((h) => String(h).toLowerCase()),
    stopwords_extra: (d.stopwords_extra || []).map((w) => String(w).toLowerCase()),
    themes: Object.fromEntries(Object.entries(d.themes || {}).map(([k, v]) => [k, (v || []).map((w) => String(w).toLowerCase())])),
    since: dateStr(d.since), until: dateStr(d.until),
    account_types: { ...(d.account_types || {}) },
    include_types: [...(d.include_types || [])],
    signals: { ...(d.signals || {}) },
    min_signals: Object.fromEntries(Object.entries(d.min_signals || {}).map(([k, v]) => [k, parseInt(v, 10) || 0])),
    min_engagement: parseInt(d.min_engagement, 10) || 0,
    // A post-level view floor, applied before ranking. Distinct from
    // min_engagement, which filters accounts by their best post.
    min_views: parseInt(d.min_views, 10) || 0,
    audiences: { ...(d.audiences || {}) },
    account_overrides: Object.fromEntries(Object.entries(d.account_overrides || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])),
  };
  const bad = p.query_hashtags.filter((t) => !t.startsWith("#"));
  if (bad.length) throw new Error(`a hashtag has to start with #: ${bad.join(", ")}`);
  return p;
}
const programLanguages = (p) => (p.language == null ? [] : [].concat(p.language)).map((c) => String(c).toLowerCase());
const blankProgram = () => normalizeProgram({ name: "session", language: null });

// --- state -------------------------------------------------------------------

const S = {
  files: [], mapping: {},
  full: null, raw: 0, platform: "", sources: [],
  program: null, liftAuto: true, seeds: [],
  present: [], langs: new Set(), since: "", until: "", lo: "", hi: "", accountOnly: "",
  view: "session", acc: null,
  kTarget: null, kRef: "the rest",
  log: { q: "", weight: "" },
  months: { dim: null, limitCol: "", limitVal: "", cmp: null, focus: null },
  sorts: {}, dismissed: new Set(),
  account: null,      // an account's own export: follows and what it did
  gains: { window: 2, lookback: 6 },
  version: 0,          // a new file or a loaded program resets what depends on it
};
let memo = { key: null };
let accMemo = { key: null };

const STORE = "monke-bars-program";
function remember() {
  try { localStorage.setItem(STORE, JSON.stringify({ program: S.program, liftAuto: S.liftAuto })); } catch { /* private window */ }
}
function recall() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved && saved.program) { S.program = normalizeProgram(saved.program, saved.program.file || ""); S.liftAuto = saved.liftAuto !== false; }
  } catch { /* unreadable storage is the same as none */ }
}

// --- intake ------------------------------------------------------------------

const TABLE_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;
const ZIP_EXT = /\.zip$/i;

async function readFile(file) {
  // An account's own export: a zip from either platform, or its JSON files.
  if (ZIP_EXT.test(file.name)) {
    const parts = await readZip(file, await lib("fflate"));
    const useful = parts.filter((p) => looksLikeExport(p.data));
    return { name: file.name, kind: "export", platform: "export", parts: useful, ok: useful.length > 0,
      note: useful.length ? `Account export, ${useful.length} file${useful.length > 1 ? "s" : ""} read.`
        : "Zip with no follower or activity JSON in it." };
  }
  if (TABLE_EXT.test(file.name)) {
    const XLSX = await lib("xlsx");
    const binary = /\.xlsx?$/i.test(file.name);
    const wb = binary
      ? XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true })
      : XLSX.read(await file.text(), { type: "string", raw: true, FS: /\.tsv$/i.test(file.name) ? "\t" : undefined });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: true });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { name: file.name, kind: "table", platform: "table", rows, columns, ok: rows.length > 0,
      note: rows.length ? `Spreadsheet, ${rows.length} rows, ${columns.length} columns.` : "The first sheet holds no rows." };
  }
  const text = await file.text();
  const head = text.trimStart();
  let records;
  if (head.startsWith("[") || head.startsWith("{")) {
    try {
      const parsed = JSON.parse(head);
      if (looksLikeExport(parsed)) {
        return { name: file.name, kind: "export", platform: "export", parts: [{ path: file.name, data: parsed }],
          ok: true, note: "Account export." };
      }
      records = Array.isArray(parsed) ? parsed : parseNdjson(text);
    } catch { records = parseNdjson(text); }
  } else records = parseNdjson(text);
  const d = detect(records);
  return { name: file.name, kind: d.kind, platform: d.platform, note: d.note, records, ok: d.kind === "zeeschuimer" };
}

async function onFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  $("#intake").hidden = true;
  $("#loaded").hidden = false;
  $("#work").hidden = true;
  $("#reading").innerHTML = `<p class="note">Reading ${files.length} file${files.length > 1 ? "s" : ""}.</p>`;
  try { S.files = await Promise.all(files.map(readFile)); }
  catch (e) { $("#reading").innerHTML = `<div class="warn">A file could not be read: ${esc(e.message)}</div>`; return; }
  S.mapping = {};
  renderFiles();
  if (S.files.some((f) => !f.ok)) return;
  renderMapping();
  await buildFull();
}

const shortName = (n) => n.replace(/\.[a-z]+$/i, "").replace(/^#/, "").slice(0, 28);

function renderFiles() {
  const html = S.files.map((f) => `<div class="file"><span class="mark ${f.ok ? (f.kind === "table" ? "table" : "") : "bad"}"></span>`
    + `<span><b>${esc(f.name)}</b> &nbsp;/&nbsp; ${esc(f.note)}</span></div>`).join("");
  // A file that cannot be read has to be seen straight away; the rest belong in
  // the scope panel, where they stop taking the top of the page once read.
  const bad = S.files.some((f) => !f.ok);
  $("#reading").innerHTML = bad ? html : "";
  $("#files").innerHTML = bad ? "" : html;
}

const MAP_FIELDS = [
  ["caption_text", "post text"], ["like_count", "likes"], ["comment_count", "comments"],
  ["timestamp", "date"], ["author_handle", "account"], ["follower_count", "followers"], ["url", "post link"],
];

function renderMapping() {
  const t = S.files.find((f) => f.kind === "table");
  if (!t) { $("#mapping").innerHTML = ""; return; }
  const guess = { ...guessMapping(t.columns), ...S.mapping };
  $("#mapping").innerHTML = `<details class="panel"><summary>Columns matched in ${esc(t.name)}</summary><div class="inner">
    <p class="plain">Matched by name. A wrong match changes the ranking, so it is worth a look before reading anything.</p>
    <div class="grid three">${MAP_FIELDS.map(([f, label]) => `<label class="field"><span>${label}</span>
      <select data-map="${f}"><option value="">(none)</option>${t.columns.map((c) =>
        `<option value="${esc(c)}"${guess[f] === c ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>`).join("")}
    </div></div></details>`;
  $$("#mapping select").forEach((sel) => sel.addEventListener("change", async () => {
    S.mapping[sel.dataset.map] = sel.value;
    await buildFull();
  }));
}

function progress(done, total, text) {
  $("#progress").hidden = false;
  $("#progress-fill").style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("#progress-text").textContent = text;
}

/** The hashtag a capture was searched on: the tag on most of its posts. */
function mainLift(posts) {
  const counts = new Map();
  for (const p of posts) for (const t of new Set((p.hashtags || []).map((x) => x.toLowerCase()))) counts.set(t, (counts.get(t) || 0) + 1);
  let best = null;
  for (const [tag, n] of counts) if (!best || n > best[1]) best = [tag, n];
  return best && best[1] / posts.length >= 0.5 ? best[0] : null;
}

/** Parse, tag by file, detect language once, deduplicate. The one slow step. */
async function buildFull() {
  const exports_ = S.files.filter((f) => f.kind === "export");
  S.account = exports_.length ? buildAccountData(exports_.flatMap((f) => f.parts)) : null;
  if (S.account && !S.account.follows.length) S.account = null;
  const captures = S.files.filter((f) => f.kind !== "export");
  if (!captures.length) {
    // An export on its own: there is no corpus to read, only gains.
    $("#progress").hidden = true;
    document.body.classList.add("working");
    S.full = []; S.raw = 0; S.platforms = []; S.platform = "account export"; S.sources = [];
    S.present = []; S.lo = ""; S.hi = "";
    if (!S.program) { recall(); if (!S.program) S.program = blankProgram(); }
    resetForNewData();
    S.view = "gains";
    $("#work").hidden = false;
    renderRack(); renderProgram(); render();
    return;
  }
  let posts, seeds = [];
  try {
    const firstTable = captures.findIndex((f) => f.kind === "table");
    posts = captures.flatMap((f, i) => {
      const own = (f.kind === "table" ? parseTable(f.rows, f.name, i === firstTable ? S.mapping : {}) : parseRecords(f.records, f.platform))
        .map((p) => ({ ...p, source: shortName(f.name) }));
      const lift = mainLift(own);
      if (lift) seeds.push(lift);
      return own;
    });
  } catch (e) { $("#reading").insertAdjacentHTML("beforeend", `<div class="warn">${esc(e.message)}</div>`); return; }
  if (!posts.length) { $("#reading").insertAdjacentHTML("beforeend", `<div class="warn">No posts could be read from these files.</div>`); return; }

  S.raw = posts.length;
  S.platforms = [...new Set(posts.map((p) => p.platform))].sort();
  S.platform = S.platforms.map((x) => (x === "table" ? "spreadsheet" : x)).join(" and ");
  S.seeds = [...new Set(seeds)];

  progress(0, 1, "Loading the language detector");
  let detectLang;
  try { detectLang = makeDetector((await lib("franc")).franc); }
  catch { progress(1, 1, "The language detector did not load, so every post is marked undetected."); detectLang = () => "unknown"; }

  // Detected in slices, handing the page back between them, so several thousand
  // posts keep the tab responsive and show progress.
  const labels = new Map();
  const CHUNK = 200;
  for (let i = 0; i < posts.length; i += CHUNK) {
    for (const p of posts.slice(i, i + CHUNK)) if (!labels.has(p.post_id)) labels.set(p.post_id, detectLang(p.caption_text));
    progress(Math.min(i + CHUNK, posts.length), posts.length, `Reading ${Math.min(i + CHUNK, posts.length)} of ${posts.length} posts`);
    await nextFrame();
  }
  const { posts: full } = buildCorpus(posts, { detect: (_, p) => labels.get(p.post_id), tierLabels: ["High"] });
  S.full = full;
  S.sources = [...new Set(full.map((p) => p.source))];
  $("#progress").hidden = true;
  document.body.classList.add("working");

  S.present = languageCounts(full);
  const times = full.map((p) => p.timestamp).filter(Boolean).sort();
  S.lo = times.length ? times[0].slice(0, 10) : "";
  S.hi = times.length ? times[times.length - 1].slice(0, 10) : "";

  if (!S.program) { recall(); if (!S.program) S.program = blankProgram(); }
  if (S.liftAuto) S.program.query_hashtags = [...S.seeds];
  resetForNewData();
  $("#work").hidden = false;
  renderRack(); renderProgram(); render();
}

function resetForNewData() {
  const present = S.present.map((r) => r.language);
  const wanted = programLanguages(S.program).filter((l) => present.includes(l));
  S.langs = new Set(wanted.length ? wanted : present);
  const clamp = (d) => (d < S.lo ? S.lo : d > S.hi ? S.hi : d);
  S.since = S.program.since && S.lo ? clamp(S.program.since) : S.lo;
  S.until = S.program.until && S.hi ? clamp(S.program.until) : S.hi;
  S.acc = null;
  S.kTarget = S.program.tier_labels[0];
  S.kRef = "the rest";
  S.log = { q: "", weight: "" };
  S.sorts = {};
  S.version++;
  memo = { key: null }; accMemo = { key: null };
}

// --- the filtered corpus -----------------------------------------------------

/** True when any post in the session carries a view count. Instagram captures
 *  carry none, and a floor cannot be applied to a number nobody supplied. */
function hasViews() {
  return (S.full || []).some((p) => p.view_count > 0);
}

function current() {
  const p = S.program;
  const key = JSON.stringify([S.version, [...S.langs].sort(), S.since, S.until,
    p.tier_labels, p.stopwords_extra, p.query_hashtags, p.themes, p.min_views, S.accountOnly]);
  if (memo.key === key) return memo.value;
  const langs = [...S.langs];
  let base = langs.length ? filterLanguages(S.full, langs) : [];
  base = filterViews(filterDates(base, S.since || null, S.until || null), p.min_views);

  // One capture can hold several brands. Narrowing to one is what makes the
  // reading about that brand rather than about the set, and the tiers are cut
  // after the narrowing so a post is ranked against its own account's posts
  // and not against a larger account's.
  //
  // `everyAccount` keeps the unnarrowed set, because the benchmark is the one
  // reading that needs the others: narrowing to our own account and then
  // asking whether the others fell would answer itself.
  const everyAccount = base;
  const posts = weightClasses(
    S.accountOnly ? base.filter((x) => x.author_handle === S.accountOnly) : base, p.tier_labels);
  let value = { posts, everyAccount, results: null, findings: [] };
  if (posts.length) {
    const results = analyze(posts, p, SW);
    const subset = langs.length < S.present.length ? langs : null;
    value = { posts, everyAccount, results,
              findings: generate(results.posts, p, { rawCount: S.raw, languages: subset, minViews: p.min_views }) };
  }
  memo = { key, value };
  return value;
}

/**
 * Rank and cut into weight classes, one platform at a time.
 *
 * Likes on Instagram and on TikTok are not the same scale, and pooling them
 * would let one platform fill the heavyweight class on its own. Each platform
 * is ranked inside itself, which is what makes a mixed session honest.
 */
function weightClasses(posts, labels) {
  const platforms = [...new Set(posts.map((p) => p.platform))];
  if (platforms.length < 2) return retier(posts, labels);
  const out = [];
  for (const one of platforms) out.push(...retier(posts.filter((p) => p.platform === one), labels));
  return out.sort((a, b) => b.engagement_score - a.engagement_score);
}

function allMembers() {
  const p = S.program;
  const key = memo.key + JSON.stringify([p.account_types, p.account_overrides, p.signals]);
  if (accMemo.key === key) return accMemo.value;
  const value = A.buildAccounts(current().posts, p);
  accMemo = { key, value };
  return value;
}

// --- drawing helpers ---------------------------------------------------------

const TIER_FILL = ["var(--ink)", "var(--ink-60)", "var(--ink-35)", "#A89B8B", "#C0B6A8", "#D6CDBE"];

function section(label, plain = "") {
  return `<div class="section">${esc(label)}</div>${plain ? `<p class="plain">${plain}</p>` : ""}`;
}

/** Bars with the word itself as a button: it opens that word's posts, and the
 *  drop button beside it removes the word from every count. */
function bars(rows, labelKey, valueKey, { max = null, cls = "", fmtValue = fmt, words = false, bench = true } = {}) {
  const top = max ?? (Math.max(...rows.map((r) => r[valueKey]), 0) || 1);
  return `<div class="bars ${cls}${words && bench ? "" : " nobench"}">${rows.map((r) => {
    const label = String(r[labelKey]);
    const name = words
      ? `<button class="word" type="button" data-word="${esc(label)}" title="Posts using ${esc(label)}">${esc(label)}</button>`
      : esc(label);
    return `<div class="row"><span class="lbl">${name}</span>
      <span class="track"><span class="fill" style="display:block;width:${Math.max(0, (r[valueKey] / top) * 100).toFixed(2)}%"></span></span>
      <span class="num">${esc(fmtValue(r[valueKey]))}</span>
      ${words && bench ? `<span><button class="bench" type="button" data-bench="${esc(label)}" title="Drop ${esc(label)} from every count">drop</button></span>` : ""}</div>`;
  }).join("")}</div>`;
}

function themeChart(shares, tiers) {
  const top = Math.max(...shares.flatMap((r) => tiers.map((t) => r[t])), 0) || 1;
  return `<div class="legend">${tiers.map((t, i) => `<span><i style="background:${TIER_FILL[i % 6]}"></i>${esc(t)}</span>`).join("")}</div>
    <div class="themes">${shares.map((r) => `<div class="theme"><div class="name">${esc(r.theme)}</div>
      ${tiers.map((t, i) => `<div class="row"><span class="t">${esc(t)}</span>
        <span class="track"><span class="fill" style="display:block;background:${TIER_FILL[i % 6]};width:${((r[t] / top) * 100).toFixed(2)}%"></span></span>
        <span class="t" style="text-align:right">${r[t].toFixed(2)}%</span></div>`).join("")}</div>`).join("")}</div>`;
}

// Column keys are the names the exports and the Python package use, and they
// stay that way: a sort, a CSV and a spreadsheet all key off them. Only the
// header a person reads is translated, and a column with no entry here is
// already plain enough to print as it is.
const COL_LABELS = {
  target_freq: "in target", reference_freq: "in reference",
  log_likelihood: "keyness", log_ratio: "effect size",
  engagement_rank: "rank", engagement_tier: "tier", engagement_score: "engagement",
  caption_text: "caption", author_handle: "account", author_name: "name",
  like_count: "likes", comment_count: "comments", view_count: "views",
  share_count: "shares", media_type: "media", post_id: "post id", post_url: "link",
  hashtag_count: "hashtags", is_paid_partnership: "paid partnership",
  account_type: "type", type_reason: "why", best_engagement: "best post",
  best_post_views: "views on best", engagement_rate_pct: "rate %",
  best_post_url: "best post", best_post_date: "best post date",
  months_since_best: "months since", last_post_date: "last post",
  total_engagement: "total engagement", paid_partnership: "paid partnership",
  best_caption: "best caption", excluded_because: "why excluded",
  follower_count: "followers", full_name: "name", detected_language: "language",
  in_better_half: "in better half", median_engagement: "median engagement",
  top3_share: "top-3 share", a_pct: "earlier", b_pct: "later", measured: "with views",
};
const colLabel = (c) => COL_LABELS[c] || String(c).replace(/_/g, " ");

/** A table that can sort itself. `id` keys the sort state, so a re-render keeps it. */
function table(rows, cols, { id = "", limit = Infinity, numeric = [], wrap = [], render: cell = {}, sortable = false } = {}) {
  if (!rows.length) return `<p class="plain">Nothing to show here.</p>`;
  let out = rows;
  const sort = S.sorts[id];
  if (sortable && sort && cols.includes(sort.key)) {
    const dir = sort.dir === "asc" ? 1 : -1;
    out = rows.slice().sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (typeof x === "number" && typeof y === "number") return (x - y) * dir;
      return String(x ?? "").localeCompare(String(y ?? "")) * dir;
    });
  }
  const shown = out.slice(0, limit);
  const head = cols.map((c) => {
    const cls = numeric.includes(c) ? "n" : "";
    const mark = sort && sort.key === c ? (sort.dir === "asc" ? " ↑" : " ↓") : "";
    const label = colLabel(c);
    return `<th class="${cls}">${sortable
      ? `<button class="sort" type="button" data-sort="${esc(id)}" data-key="${esc(c)}">${esc(label)}${mark}</button>` : esc(label)}</th>`;
  }).join("");
  const body = shown.map((r) => `<tr>${cols.map((c) => {
    const cls = numeric.includes(c) ? "n" : wrap.includes(c) ? "wrap" : "";
    return `<td class="${cls}">${cell[c] ? cell[c](r) : esc(fmt(r[c]))}</td>`;
  }).join("")}</tr>`).join("");
  const more = out.length > shown.length
    ? `<p class="plain">Showing ${fmt(shown.length)} of ${fmt(out.length)} rows. An export holds every one.</p>` : "";
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

// --- files out ---------------------------------------------------------------

function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function csv(rows, cols) {
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;    // voice: ignore
  };
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "session";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function runFilters(extra = {}) {
  const all = S.present.length === S.langs.size;
  return { languages: all ? [] : [...S.langs].map(langName), since: S.since, until: S.until,
    min_views: S.program.min_views || 0, ...extra };
}

// --- scope -------------------------------------------------------------------

function renderRackSummary() {
  const { posts } = current();
  const p = S.program;
  if (!S.full.length && S.account) {
    const sum = G.summary(S.account.follows, S.account.events);
    $("#rack-summary").innerHTML = `account export &nbsp;/&nbsp; <b>${fmt(sum.follows)} followers</b>`
      + ` &nbsp;/&nbsp; ${esc(fmtDay(sum.from))} to ${esc(fmtDay(sum.to))}`
      + ` &nbsp;/&nbsp; ${fmt(sum.events)} posts and comments`;
    return;
  }
  const langs = [...S.langs].map(langName);
  const shownLangs = langs.length === S.present.length ? "every language" : langs.slice(0, 3).join(", ") + (langs.length > 3 ? ` +${langs.length - 3}` : "");
  const lift = p.query_hashtags.length ? `<span class="lift">${esc(p.query_hashtags.slice(0, 3).join(" "))}</span> &nbsp;/&nbsp; ` : "";
  const dates = S.lo ? `${esc(S.since)} to ${esc(S.until)} &nbsp;/&nbsp; ` : "";
  const floor = p.min_views ? `over ${fmt(p.min_views)} views &nbsp;/&nbsp; ` : "";
  const who = S.accountOnly ? `<b class="who">@${esc(S.accountOnly)}</b> &nbsp;/&nbsp; ` : "";
  $("#rack-summary").innerHTML = `${lift}${esc(S.platform)}${S.platforms && S.platforms.length > 1 ? " (ranked apart)" : ""} &nbsp;/&nbsp; ${esc(shownLangs)} &nbsp;/&nbsp; ${who}${dates}${floor}`
    + `<b>${fmt(posts.length)} of ${fmt(S.raw)} posts</b>`;
}

/** The controls themselves. Rebuilt only when the file or the program changes,
 *  so a language click keeps the checkbox it landed on, and the focus with it. */
function renderRack() {
  renderRackSummary();
  const present = S.present;
  const big = present.filter((r) => r.posts >= 3);
  const small = present.filter((r) => r.posts < 3);
  const shown = S.showAllLangs ? present : (big.length ? big : present);
  const hidden = S.showAllLangs ? [] : present.filter((r) => !shown.includes(r));
  $("#langs").innerHTML = shown.map(({ language, posts: n }) => `<label class="toggle">
      <input type="checkbox" value="${esc(language)}"${S.langs.has(language) ? " checked" : ""}>
      <span>${esc(langName(language))} ${n}</span></label>`).join("")
    // The long tail stays behind one chip rather than out of sight: a language
    // nobody can see is still in scope, and its posts still count.
    + (hidden.length ? `<label class="toggle"><input type="checkbox" value="__tail"${
        hidden.some((r) => S.langs.has(r.language)) ? " checked" : ""}>
        <span>${hidden.length} more, ${fmt(hidden.reduce((n, r) => n + r.posts, 0))} posts</span></label>` : "");
  $("#lang-label").textContent = `Languages, ${present.length} detected`;
  $("#lang-tools").innerHTML = `<button class="linkish" type="button" data-langs="all">every language</button>
    <button class="linkish" type="button" data-langs="none">none</button>`
    + (small.length && !S.showAllLangs ? `<button class="linkish" type="button" data-langs="more">show ${small.length} with under three posts</button>` : "");
  for (const id of ["since", "until"]) {
    const el = $(`#${id}`);
    el.disabled = !S.lo; el.min = S.lo; el.max = S.hi; el.value = S[id];
  }
  // Without a single view count the floor has nothing to test, so the control
  // says so rather than sitting there inviting a number that changes nothing.
  const mv = $("#min-views");
  mv.value = S.program.min_views || 0;
  mv.disabled = !hasViews();

  // Offered only when the capture holds more than one account; a single-brand
  // capture has nothing to narrow to.
  const counts = new Map();
  for (const x of S.full || []) if (x.author_handle) counts.set(x.author_handle, (counts.get(x.author_handle) || 0) + 1);
  const accounts = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("#account-field").hidden = accounts.length < 2;
  if (accounts.length >= 2) {
    if (S.accountOnly && !counts.has(S.accountOnly)) S.accountOnly = "";
    $("#account-only").innerHTML = `<option value="">every account (${fmt(accounts.length)})</option>`
      + accounts.map(([h, n]) => `<option value="${esc(h)}"${h === S.accountOnly ? " selected" : ""}>`
        + `${esc(h)} (${fmt(n)})</option>`).join("");
  }
  $$("#lang-tools .linkish").forEach((b) => b.addEventListener("click", () => {
    const present2 = S.present.map((r) => r.language);
    if (b.dataset.langs === "all") S.langs = new Set(present2);
    else if (b.dataset.langs === "none") S.langs = new Set();
    else S.showAllLangs = true;
    renderRack(); render();
  }));
}

// --- the program -------------------------------------------------------------

function programChanged({ reset = false } = {}) {
  remember();
  if (reset) resetForNewData();
  renderProgram();
  if (reset) renderRack(); else renderRackSummary();
  render();
}

function renderProgram() {
  const p = S.program;
  const types = A.resolveAccountTypes(p);
  const custom = Object.keys(p.account_types);
  const overrides = Object.keys(p.account_overrides).length;
  const groups = Object.entries(p.themes);

  $("#program-body").innerHTML = `
    <div class="block">
      <label class="field"><span>Name</span><input type="text" id="prog-name" value="${esc(p.name)}"></label>
      <div class="btns" style="margin-top:12px">
        <button class="btn small" type="button" id="prog-save">Save program</button>
        <button class="btn small" type="button" id="prog-load">Load program</button>
      </div>
      <p class="plain">A program holds the seed hashtag, the dropped words, the themes and the account types. It is kept in
        this browser and saves as a YAML file the Python package reads.</p>
      <label class="field" style="margin-top:10px"><span>Sample programs</span>
        <select id="prog-sample"><option value="">start from blank</option>
          ${SAMPLES.map((s) => `<option value="${esc(s.file)}"${p.file === s.file ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
        </select></label>
      <input type="file" id="prog-file" accept=".yaml,.yml" hidden>
    </div>

    <div class="block">
      <div class="gym">Seed hashtag</div>
      <p class="plain">The hashtag this capture was searched on. It is left out of the hashtag pairings, where it would otherwise
        come back as the top result. ${S.seeds.length ? "Found in the file." : "Nothing obvious was found in the file."}</p>
      <div class="chips">${p.query_hashtags.map((t) => `<span class="chipx lift">${esc(t)}<button type="button" data-drop-lift="${esc(t)}" aria-label="Remove ${esc(t)}">×</button></span>`).join("") || `<span class="plain">none</span>`}</div>
      <div class="add-row"><input type="text" id="lift-add" placeholder="#hashtag"><button class="btn small" type="button" data-add="lift">Add</button></div>
    </div>

    <div class="block">
      <div class="gym">Dropped words</div>
      <p class="plain">Words kept out of every count. The drop button beside any word adds it here.</p>
      <div class="chips">${p.stopwords_extra.map((w) => `<span class="chipx">${esc(w)}<button type="button" data-drop-bench="${esc(w)}" aria-label="Unbench ${esc(w)}">×</button></span>`).join("") || `<span class="plain">none</span>`}</div>
      <div class="add-row"><input type="text" id="bench-add" placeholder="word"><button class="btn small" type="button" data-add="bench">Add</button></div>
    </div>

    <div class="block">
      <div class="gym">Themes</div>
      <p class="plain">Themes modelled from the vocabulary itself, each named by its top three words. Rename them, edit
        the words, and they are counted per engagement tier.</p>
      <label class="field"><span>Groups to model, <output id="k-out">${S.k || 5}</output></span>
        <input type="range" id="k-range" min="3" max="10" step="1" value="${S.k || 5}"></label>
      <div class="btns" style="margin-top:8px">
        <button class="btn small primary" type="button" id="find-groups">Find groups</button>
        ${groups.length ? `<button class="btn small danger" type="button" id="clear-groups">Clear</button>` : ""}
      </div>
      ${groups.map(([name, words], i) => `<details class="item"><summary>${esc(name)}<small>${words.length} words</small></summary>
        <div class="inner">
          <label class="field"><span>Name</span><input type="text" data-group-name="${i}" value="${esc(name)}"></label>
          <label class="field"><span>Words</span><textarea data-group-words="${i}">${esc(words.join(", "))}</textarea></label>
          <button class="btn small danger" type="button" data-group-drop="${i}">Remove group</button>
        </div></details>`).join("")}
    </div>

    <div class="block">
      <div class="gym">Account types</div>
      <p class="plain">What an account is, matched on words in its handle and display name. The generic types come with
        the tool; a type added here is tested first.</p>
      ${Object.entries(types).map(([name, spec]) => {
        const own = custom.includes(name);
        const isDefault = spec === A.DEFAULT_MARKER || spec == null;
        return `<details class="item"><summary>${esc(name)}<small>${isDefault ? "catch-all" : own ? "yours" : "generic"}</small></summary>
          <div class="inner">${isDefault ? `<p class="plain">Everything no other type claims.</p>` : `
            <label class="field"><span>Words in the handle or name</span><textarea data-type-words="${esc(name)}">${esc(((spec || {}).handle_words || []).concat((spec || {}).name_words || []).join(", "))}</textarea></label>
            <label class="field"><span>Hashtags its posts carry</span><textarea data-type-tags="${esc(name)}">${esc(((spec || {}).hashtags || []).join(", "))}</textarea></label>`}
            ${own ? `<button class="btn small danger" type="button" data-type-drop="${esc(name)}">Remove type</button>` : ""}
          </div></details>`;
      }).join("")}
      <div class="add-row"><input type="text" id="type-add" placeholder="Chocolate brand"><button class="btn small" type="button" data-add="type">Add</button></div>
      ${overrides ? `<p class="plain" style="margin-top:10px">${overrides} account${overrides > 1 ? "s" : ""} set by hand.
        <button class="linkish" type="button" id="clear-overrides">clear</button></p>` : ""}
    </div>`;

  wireProgram();
}

function wireProgram() {
  const p = S.program;
  const body = $("#program-body");
  $("#prog-name", body).addEventListener("change", (e) => { p.name = e.target.value.trim() || "session"; programChanged(); });

  $("#prog-save", body).addEventListener("click", async () => {
    const { dump } = await lib("yaml");
    const out = { ...p };
    delete out.file;
    save(dump(out, { lineWidth: 100, sortKeys: false }), `${slug(p.name)}.yaml`, "text/yaml");
  });
  $("#prog-load", body).addEventListener("click", () => $("#prog-file", body).click());
  $("#prog-file", body).addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { load } = await lib("yaml");
      S.program = normalizeProgram(load(await file.text()), "");
      S.liftAuto = !S.program.query_hashtags.length;
      if (S.liftAuto) S.program.query_hashtags = [...S.seeds];
      programChanged({ reset: true });
    } catch (err) { $("#warnings").innerHTML = `<div class="warn">That program file could not be read: ${esc(err.message)}</div>`; }
  });
  $("#prog-sample", body).addEventListener("change", (e) => {
    const file = e.target.value;
    S.program = file ? normalizeProgram(SAMPLES.find((s) => s.file === file), file) : blankProgram();
    S.liftAuto = !S.program.query_hashtags.length;
    if (S.liftAuto) S.program.query_hashtags = [...S.seeds];
    programChanged({ reset: true });
  });

  const addFrom = (input, fn) => { const v = input.value.trim(); if (v) { fn(v); input.value = ""; } };
  $$("[data-add]", body).forEach((btn) => btn.addEventListener("click", () => {
    const kind = btn.dataset.add;
    if (kind === "lift") addFrom($("#lift-add", body), (v) => {
      p.query_hashtags = [...new Set([...p.query_hashtags, v.toLowerCase().startsWith("#") ? v.toLowerCase() : `#${v.toLowerCase()}`])];
      S.liftAuto = false; programChanged();
    });
    if (kind === "bench") addFrom($("#bench-add", body), (v) => {
      p.stopwords_extra = [...new Set([...p.stopwords_extra, v.toLowerCase()])]; programChanged();
    });
    if (kind === "type") addFrom($("#type-add", body), (v) => {
      p.account_types = { [v]: { handle_words: [], hashtags: [] }, ...p.account_types }; programChanged();
    });
  }));
  $$("[data-drop-lift]", body).forEach((b) => b.addEventListener("click", () => {
    p.query_hashtags = p.query_hashtags.filter((t) => t !== b.dataset.dropLift); S.liftAuto = false; programChanged();
  }));
  $$("[data-drop-bench]", body).forEach((b) => b.addEventListener("click", () => {
    p.stopwords_extra = p.stopwords_extra.filter((w) => w !== b.dataset.dropBench); programChanged();
  }));

  const kr = $("#k-range", body);
  kr.addEventListener("input", () => { S.k = parseInt(kr.value, 10); $("#k-out", body).textContent = kr.value; });
  $("#find-groups", body).addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = "Modelling";
    await nextFrame();
    const { results } = current();
    const { themes } = discoverThemes(results ? results.posts : [], { nTopics: S.k || 5 });
    btn.disabled = false; btn.textContent = "Find groups";
    if (!Object.keys(themes).length) {
      $("#warnings").innerHTML = `<div class="warn">There is too little text in this selection to model groups from.</div>`;
      return;
    }
    p.themes = themes; programChanged();
  });
  $("#clear-groups", body)?.addEventListener("click", () => { p.themes = {}; programChanged(); });
  $$("[data-group-name]", body).forEach((el) => el.addEventListener("change", () => {
    const i = +el.dataset.groupName;
    const entries = Object.entries(p.themes);
    entries[i] = [el.value.trim() || entries[i][0], entries[i][1]];
    p.themes = Object.fromEntries(entries); programChanged();
  }));
  $$("[data-group-words]", body).forEach((el) => el.addEventListener("change", () => {
    const i = +el.dataset.groupWords;
    const entries = Object.entries(p.themes);
    entries[i] = [entries[i][0], lines(el.value).map((w) => w.toLowerCase())];
    p.themes = Object.fromEntries(entries); programChanged();
  }));
  $$("[data-group-drop]", body).forEach((el) => el.addEventListener("click", () => {
    p.themes = Object.fromEntries(Object.entries(p.themes).filter((_, i) => i !== +el.dataset.groupDrop)); programChanged();
  }));

  const editType = (name, patch) => {
    const base = typeof p.account_types[name] === "object" && p.account_types[name] ? p.account_types[name] : {};
    p.account_types = { ...p.account_types, [name]: { ...base, ...patch } };
    programChanged();
  };
  $$("[data-type-words]", body).forEach((el) => el.addEventListener("change", () =>
    editType(el.dataset.typeWords, { handle_words: lines(el.value).map((w) => w.toLowerCase()) })));
  $$("[data-type-tags]", body).forEach((el) => el.addEventListener("change", () =>
    editType(el.dataset.typeTags, { hashtags: lines(el.value).map((w) => w.toLowerCase().replace(/^#/, "")) })));
  $$("[data-type-drop]", body).forEach((el) => el.addEventListener("click", () => {
    const { [el.dataset.typeDrop]: _gone, ...rest } = p.account_types;
    p.account_types = rest; programChanged();
  }));
  $("#clear-overrides", body)?.addEventListener("click", () => { p.account_overrides = {}; programChanged(); });
}

// --- views -------------------------------------------------------------------

function render() {
  const { posts, results } = current();
  const p = S.program;
  // A problem stays put; a thing worth knowing once can be dismissed.
  const warn = [];
  // An export-only session has no corpus to be empty, so the corpus warnings
  // would only be noise.
  if (!posts.length && S.full.length) warn.push({ text: S.langs.size ? "Nothing is left in scope. Widen the languages, the dates or the view floor."
    : "No language is selected, so nothing is left." });
  else if (posts.length && posts.every((x) => !x.engagement_score)) warn.push({ text: "Every post scores zero engagement, so the weight "
    + "classes carry no information. A likes or comments column fixes that, and until then the word views are the ones to read." });
  // A saved program can carry a floor into a capture that has no views to
  // test it against, and the scope summary would then name a floor that is not
  // doing anything.
  // Several brands in one capture read as one unless the reader says which is
  // theirs, and every figure outside the benchmark is then about the set.
  const handles = new Set((S.full || []).map((x) => x.author_handle).filter(Boolean));
  if (handles.size > 1 && !S.accountOnly) warn.push({ key: "pooled-accounts",
    text: `This capture holds ${fmt(handles.size)} accounts and every figure pools them. `
      + "Pick yours under Account in Scope: the comparison against the other accounts keeps reading all of them either way." });
  if (p.min_views && S.full.length && !hasViews()) warn.push({ key: "floor-idle", text: `The minimum of ${fmt(p.min_views)} views `
    + "is set, but no post in this session carries a view count, so nothing is being held back. Instagram captures carry no views." });
  if (S.platforms && S.platforms.length > 1) warn.push({ key: "mixed", text: `This session holds ${S.platform}. Engagement tiers `
    + "are cut inside each platform, because likes on one are not likes on the other, and an account posting on both comes "
    + "back as one account with both platforms named." });
  $("#warnings").innerHTML = warn.filter((w) => !w.key || !S.dismissed.has(w.key))
    .map((w) => `<div class="warn"><span>${esc(w.text)}</span>${w.key
      ? `<button class="dismiss" type="button" data-dismiss="${esc(w.key)}" aria-label="Dismiss">got it</button>` : ""}</div>`).join("");
  $$("[data-dismiss]").forEach((b) => b.addEventListener("click", () => { S.dismissed.add(b.dataset.dismiss); render(); }));

  $$(".views [data-view=gains]").forEach((b) => b.remove());
  if (S.account) {
    const btn = document.createElement("button");
    btn.setAttribute("role", "tab"); btn.dataset.view = "gains";
    btn.textContent = "Followers";
    btn.addEventListener("click", () => { S.view = "gains"; render(); });
    $(".views").append(btn);
  } else if (S.view === "gains") S.view = "session";

  $$(".views [data-view=sets]").forEach((b) => b.remove());
  if (S.sources.length > 1) {
    const btn = document.createElement("button");
    btn.setAttribute("role", "tab"); btn.dataset.view = "sets";
    btn.innerHTML = `Sets<small>compare files</small>`;
    btn.addEventListener("click", () => { S.view = "sets"; render(); });
    $(".views").append(btn);
  } else if (S.view === "sets") S.view = "session";

  // Views that read a corpus have nothing to show in an export-only session.
  const corpusViews = ["session", "reps", "members", "log", "sets"];
  $$(".views button").forEach((b) => {
    b.hidden = !S.full.length && corpusViews.includes(b.dataset.view);
    b.setAttribute("aria-selected", String(b.dataset.view === S.view));
  });
  const view = $("#view");
  const changed = S.view !== S.lastView;
  renderExport();
  // The setup describes how a corpus is read, which an export-only session has
  // no use for. Hiding the button hides the way in, so the panel goes with it.
  $("#setup-toggle").hidden = !S.full.length;
  if (!S.full.length) $("#setup-panel").hidden = true;
  if (S.view === "gains" && S.account) {
    view.innerHTML = gainsView();
    wireView(); buildJump();
    $("#gains-window")?.addEventListener("change", (e) => { S.gains.window = +e.target.value; render(); });
    return settle(changed);
  }
  if (!results) { view.innerHTML = ""; return; }
  if (S.view === "session") view.innerHTML = sessionView();
  else if (S.view === "reps") view.innerHTML = repsView();
  else if (S.view === "members") { renderMembers(view); wireView(); buildJump(); return settle(changed); }
  else if (S.view === "months") { view.innerHTML = monthsView(); wireView(); buildJump(); wireMonths(); return settle(changed); }
  else if (S.view === "sets") view.innerHTML = setsView();
  else view.innerHTML = logView();
  wireView(); buildJump(); settle(changed);
}

/** A view that has just replaced another starts at its own top, rather than
 *  wherever the last one had been scrolled to. */
function settle(changed) {
  if (!changed) return;
  S.lastView = S.view;
  const top = $(".results").getBoundingClientRect().top + scrollY - ($("#deck").offsetHeight + 24);
  if (scrollY > top) scrollTo({ top, behavior: "instant" });
}

/** Section links for a view long enough to need them. Built from what was
 *  rendered, so a view never has to list its own sections twice. */
function buildJump() {
  const sections = $$("#view .section");
  const box = $("#jump");
  if (sections.length < 3) { box.innerHTML = ""; return; }
  sections.forEach((el, i) => { el.id = el.id || `sec-${i}`; });
  box.innerHTML = `<span class="gym">On this page</span>`
    + sections.map((el) => `<button type="button" data-jump="${el.id}">${esc(el.textContent.trim())}</button>`).join("");
  $$("[data-jump]", box).forEach((b) => b.addEventListener("click", () => {
    document.getElementById(b.dataset.jump).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

/** One listener for everything a rendered view offers. */
function wireView() {
  const view = $("#view");
  $$("[data-word]", view).forEach((b) => b.addEventListener("click", () => {
    // Where the word was clicked, so the log can offer the way back.
    S.log = { q: b.dataset.word, weight: "", from: S.view, fromWord: b.dataset.word };
    S.view = "log"; render();
  }));
  $$("[data-bench]", view).forEach((b) => b.addEventListener("click", () => {
    S.program.stopwords_extra = [...new Set([...S.program.stopwords_extra, b.dataset.bench.toLowerCase()])];
    programChanged();
  }));
  $("#log-clear", view)?.addEventListener("click", () => { S.log = { q: "", weight: S.log.weight }; render(); });
  $("#log-back", view)?.addEventListener("click", () => {
    const back = S.log.from; S.log = { q: "", weight: "" }; S.view = back; render();
  });
  $$("[data-sort]", view).filter((b) => !b.closest("#member-results")).forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.sort, key = b.dataset.key, cur = S.sorts[id];
    S.sorts[id] = { key, dir: cur && cur.key === key && cur.dir === "desc" ? "asc" : "desc" };
    render();
  }));
}

function claimBlock() {
  const p = S.program;
  return section("Your reading", "The reading this session supports, written by a person. The tool never writes one.")
    + (p.claim
      ? `<div class="claim"><div class="bar"></div><div class="body"><div class="q">${esc(p.claim)}</div>
          <div class="src">authored &nbsp;/&nbsp; ${esc(p.name)} <button class="linkish" type="button" id="claim-edit">edit</button></div></div></div>`
      : `<div class="coach"><textarea id="claim-box" placeholder="One sentence this corpus can carry"></textarea>
          <div class="btns"><button class="btn small" type="button" id="claim-save">Save reading</button></div></div>`);
}

function sessionView() {
  const { posts, results, findings } = current();
  const p = S.program, tiers = p.tier_labels;
  let h = claimBlock();

  // The shape of the session before the sentences about it: when the posts
  // went out, how skewed the engagement is, and how reach relates to response.
  h += section("At a glance", "The shape of this selection, before any of the counts below.");
  h += `<div class="charts">${C.timeline(posts)}${C.rankedCurve(posts, tiers)}`
    + `${posts.some((x) => x.view_count > 0) ? C.viewsScatter(posts, { floor: p.min_views, tiers }) : ""}</div>`;

  h += section("What the data states", "Every line is a count this session can show, with nothing inferred.")
    + `<ul class="evidence">${findings.map((f) => `<li>${emphasis(f.text)}</li>`).join("")}</ul>`;

  const flat = posts.every((x) => !x.engagement_score);
  if (tiers.length >= 2 && !flat) {
    const hi = tiers[0], lo = tiers[tiers.length - 1];
    const kh = keyness(results.posts, hi, lo, 12), kl = keyness(results.posts, lo, hi, 12);
    if (kh.length || kl.length) {
      const max = Math.max(...kh.map((r) => r.log_likelihood), ...kl.map((r) => r.log_likelihood), 1);
      const side = (rows, cls) => (rows.length
        ? bars(rows, "word", "log_likelihood", { max, cls: `keyness ${cls}`, fmtValue: (v) => v.toFixed(2), words: true })
        : `<p class="plain">Nothing distinctive at this end.</p>`);
      h += section("Distinctive words", "Words that set the top posts apart from the bottom, once sheer frequency is controlled for (keyness).");
      h += `<div class="grid two"><div><div class="band">${esc(hi)}</div>${side(kh, "")}</div>
        <div><div class="band cobalt">${esc(lo)}</div>${side(kl, "cobalt")}</div></div>`;
    }
  }

  h += section("Engagement tiers", "Posts are ranked by likes plus comments and cut into equal groups.");
  h += `<div class="grid metrics">${[["posts in scope", fmt(posts.length)], ["records read", fmt(S.raw)],
    ...tiers.map((t) => [t.toLowerCase(), fmt(posts.filter((x) => x.engagement_tier === t).length)]),
  ].map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;

  h += section("Themes", "Modelled from the vocabulary, as a share of each tier's words.");
  h += Object.keys(p.themes).length
    ? themeChart(results.themeShares, tiers)
    : `<p class="plain">No groups yet. Find groups in the program panel models them from this selection, and they can be
        renamed and edited afterwards.</p>`;

  if (results.hashtags.length) {
    h += section("Hashtags together", "Hashtags that travel together, with the seed hashtag left out.");
    h += `<div class="hashtags">${results.hashtags.slice(0, 12).map((r) => `<span>${esc(r.hashtag)}<b>${r.frequency}</b></span>`).join("")}</div>`;
  }
  return h;
}

function repsView() {
  const { results } = current();
  const p = S.program, tiers = p.tier_labels;
  if (!tiers.includes(S.kTarget)) S.kTarget = tiers[0];
  const refs = ["the rest", ...tiers.filter((t) => t !== S.kTarget)];
  if (!refs.includes(S.kRef)) S.kRef = "the rest";
  const k = keyness(results.posts, S.kTarget, S.kRef === "the rest" ? null : S.kRef, 25);
  const kcols = ["word", "target_freq", "reference_freq", "log_likelihood", "log_ratio"];

  let h = section("Top words", "The most repeated words. A word opens its posts, and the drop button removes it from every count.");
  h += bars(results.topWords.slice(0, 20), "word", "frequency", { words: true });
  h += `<div class="grid three">${tiers.map((t) => `<div><span class="label">${esc(t.toLowerCase())}</span>
    ${table(results.topWordsByTier[t], ["word", "frequency"], { numeric: ["frequency"], render: { word: (r) => `<button class="word" type="button" data-word="${esc(r.word)}">${esc(r.word)}</button>` } })}</div>`).join("")}</div>`;

  h += hooksSection(results.posts);

  h += section("Distinctive words", "Keyness, one tier against another.");
  h += `<div class="grid two">
    <label class="field"><span>Class</span><select id="k-target">${tiers.map((t) => `<option${t === S.kTarget ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
    <label class="field"><span>Compared against</span><select id="k-ref">${refs.map((t) => `<option${t === S.kRef ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label></div>`;
  h += table(k, kcols, { id: "keyness", numeric: kcols.slice(1), sortable: true,
    render: { word: (r) => `<button class="word" type="button" data-word="${esc(r.word)}">${esc(r.word)}</button>` } });

  h += section("Word pairs", "Words used back to back.");
  h += `<div class="grid two"><div><span class="label">two words</span>${table(results.bigrams, ["phrase", "frequency"], { numeric: ["frequency"] })}</div>
    <div><span class="label">three words</span>${table(results.trigrams, ["phrase", "frequency"], { numeric: ["frequency"] })}</div></div>`;

  h += section("Hashtags together", "Hashtags that travel together.");
  h += table(results.hashtags, ["hashtag", "frequency"], { id: "tags", numeric: ["frequency"], sortable: true });

  if (Object.keys(p.themes).length) {
    h += section("Themes", "Word hits per tier, and as a share of each tier.");
    h += table(results.themeCounts, ["theme", ...tiers, "total"], { numeric: [...tiers, "total"] });
    h += table(results.themeShares, ["theme", ...tiers], { numeric: tiers });
  }
  return h;
}

/**
 * How the better half opens, against the weaker half.
 *
 * Separate from the tier measures above: those read whole captions with the
 * stopwords dropped, and a hook is mostly stopwords. The halves are cut by
 * rank inside each platform, which `hooks.js` explains.
 */
function hooksSection(posts) {
  const { above, below, cuts } = H.halves(posts);
  let h = section("Hooks", `How the better half of these posts opens, against the weaker half. `
    + `The first ${H.HOOK_WORDS} words of a caption, counted with the small words left in, `
    + `because an opening is mostly small words.`);

  if (above.length < 4 || below.length < 4) {
    return h + `<p class="plain">Too few posts to halve: ${fmt(above.length)} against ${fmt(below.length)}. `
      + `Widen the scope and this fills in.</p>`;
  }

  h += `<p class="plain">${cuts.map((c) => `On ${esc(c.platform)} the halves split at `
    + `<b>${fmt(c.cut)}</b> likes plus comments, over ${fmt(c.posts)} posts.`).join(" ")}</p>`;

  const open = H.openers(posts, { size: 3, minPosts: 3, topN: 12 });
  if (open.length) {
    h += `<span class="label">openings, by how often they land in the better half</span>`;
    h += table(open, ["phrase", "posts", "in_better_half", "share", "median_engagement"], {
      id: "openers", numeric: ["posts", "in_better_half", "median_engagement"], sortable: true,
      render: { share: (r) => `<span class="minibar"><i style="width:${Math.round(r.share * 100)}%"></i></span>`
        + `${Math.round(r.share * 100)}%` } });
    h += `<p class="plain">An opening with no effect scores 50 percent. Three posts is the fewest `
      + `that will appear here, and three posts is not evidence: read the count beside the share.</p>`;
  } else {
    h += `<p class="plain">No opening phrase is used by three or more posts, so there is nothing `
      + `here worth reading yet.</p>`;
  }

  const hk = H.hookKeyness(above, below, { topN: 20 });
  h += `<span class="label">words over-used in the better half's openings</span>`;
  h += hk.length
    ? table(hk, ["word", "target_freq", "reference_freq", "log_likelihood", "log_ratio"],
            { id: "hookkey", numeric: ["target_freq", "reference_freq", "log_likelihood", "log_ratio"],
              sortable: true })
    : `<p class="plain">No opening word clears the minimum of three uses.</p>`;
  return h;
}

// --- months ------------------------------------------------------------------

// The "limit to" options as last rendered, so a change event can resolve its
// index back to a column and a value.
let limitPairs = [];

/**
 * Month by month, to separate a falling baseline from hits that stopped.
 *
 * Views are the metric where the capture carries them and likes plus comments
 * where it does not, which is said on the page rather than assumed: an
 * Instagram capture has no views at all, and a reading of "views" built on
 * likes would be a different claim wearing the same word.
 */
function monthsView() {
  const { posts } = current();
  const st = S.months;

  const metric = M.hasViews(posts) ? "views" : "engagement";
  const metricName = metric === "views" ? "views" : "likes plus comments";

  let h = section("Months", `Is the ordinary post doing less, or have the hits stopped? `
    + `A monthly total cannot tell those apart, so both are drawn: the median per post is the `
    + `baseline, and the share of the month carried by its three best posts is the hit dependence.`);

  // Views on Instagram and on TikTok are not the same number, and a median
  // across both is a median of two scales. Weight classes and the hook halves
  // already cut inside each platform; a month cannot, so it says so instead.
  const plats = M.platformsIn(posts);
  if (plats.length > 1 && !(st.limitCol === "platform" && st.limitVal)) {
    h += `<div class="warn"><span>This session holds ${esc(plats.join(" and "))}. Every figure below `
      + `pools them, and ${metricName} on one platform are not ${metricName} on the other. `
      + `Set <b>Limit to</b> to a single platform before reading any of it.</span></div>`;
  }

  if (metric === "engagement") {
    h += `<p class="plain">No post in this selection carries a view count, so everything below is `
      + `likes plus comments. A CSV exported from Meta Business Suite or TikTok Studio carries `
      + `views, and reading that here changes these figures to real views.</p>`;
  } else {
    // An Instagram capture mixes Reels, which report plays, with photos and
    // carousels, which report nothing. Counting those as zero views would drag
    // every median down, so they are left out and said out loud instead.
    const blind = M.unmeasured(posts, metric);
    if (blind) {
      h += `<p class="plain">${fmt(blind)} of ${fmt(posts.length)} posts carry no view count and are `
        + `left out of every view figure below, rather than counted as zero views. On Instagram a `
        + `Reel reports plays and a photo or carousel reports nothing, so the figures here rest on `
        + `${fmt(posts.length - blind)} posts.</p>`;
    }
  }

  // Limiting to one value, so boosted posts can be set aside before reading.
  const dims = M.dimensions(posts);
  const limited = st.limitCol && st.limitVal
    ? posts.filter((x) => M.valueOf(x, st.limitCol) === st.limitVal) : posts;

  if (dims.length) {
    // The option carries an index, not the pair itself. A tag name and a tag
    // value both come out of someone's spreadsheet, so any delimiter joining
    // them could occur inside one of them -- and a NUL, which could not, does
    // not survive an HTML attribute: the parser replaces it.
    limitPairs = dims.flatMap((d) => M.valuesOf(posts, d).map((v) => [d, v.value, v.posts]));
    h += `<div class="grid two"><label class="field"><span>Limit to</span><select id="m-limit">`
      + `<option value="">every post</option>`
      + limitPairs.map(([d, v, n], i) => `<option value="${i}"${
          st.limitCol === d && st.limitVal === v ? " selected" : ""}>${esc(d)} = ${esc(v)} (${fmt(n)})</option>`).join("")
      + `</select></label>`
      + `<label class="field"><span>Break down by</span><select id="m-dim">`
      + dims.map((d) => `<option${st.dim === d ? " selected" : ""}>${esc(d)}</option>`).join("")
      + `</select></label></div>`;
  }

  const { rows, undated } = M.byMonth(limited, metric);
  if (!rows.length) return h + `<p class="plain">No post in this selection carries a date, so there are no months to read.</p>`;
  if (undated) {
    h += `<p class="plain">${fmt(undated)} post${undated > 1 ? "s carry" : " carries"} no date and `
      + `${undated > 1 ? "are" : "is"} left out of every figure below.</p>`;
  }

  const trend = M.readTrend(rows);
  if (trend) {
    h += `<div class="reading"><p>${esc(trend.reading)}</p><p class="plain">Comparing ${esc(trend.span)}: `
      + `median ${metricName} per post ${trend.medianChange == null ? "unchanged"
          : `${trend.medianChange > 0 ? "up" : "down"} ${Math.abs(trend.medianChange)} percent `
            + `(${fmt(trend.earlyMedian)} to ${fmt(trend.lateMedian)})`}, `
      + `top-three share ${trend.shareChange > 0 ? "up" : "down"} ${Math.abs(trend.shareChange)} points.</p></div>`;
  } else {
    h += `<p class="plain">Fewer than four months carry enough posts to read a direction from. `
      + `Widen the dates in Scope.</p>`;
  }

  h += C.monthBars(rows, "median", { fill: "var(--gold)", caption: `median ${metricName} per post` });
  h += C.monthBars(rows, "top3_share", { fill: "var(--cobalt)", suffix: "%",
    caption: "share of the month carried by its three best posts" });
  h += `<p class="plain">A dashed column is a month of under four posts, where a top three means little. `
    + `A dash is a month that scored nothing at all.</p>`;

  const anyBlind = rows.some((r) => r.measured !== r.posts);
  h += table(rows.map((r) => ({ month: r.label, posts: r.posts, measured: r.measured,
      median: r.median, total: r.total, top3_share: r.top3_share })),
    ["month", "posts", ...(anyBlind ? ["measured"] : []), "median", "total", "top3_share"],
    { id: "months", numeric: ["posts", "measured", "median", "total", "top3_share"], sortable: true,
      render: { top3_share: (r) => (r.top3_share == null ? "\u2013" : `${r.top3_share}%`) } });

  const dim = dims.includes(st.dim) ? st.dim : dims[0];
  if (dim) {
    const mix = M.mixByMonth(limited, dim, metric);
    h += section("The mix", `How the share of each ${esc(dim)} moved, and what each one actually did. `
      + `A mix change only explains a fall if the kind that grew also performs worse.`);
    h += C.mixBars(mix.rows, mix.values, { caption: `share of posts by ${dim}` });
    h += `<span class="label">median ${metricName}, by ${esc(dim)}</span>`;
    // The count rides along with every median. A median over two posts is not
    // a rate, and a table of bare numbers invites it to be read as one.
    h += table(mix.rows.map((r) => Object.fromEntries([["month", r.label],
        ...mix.values.map((v) => [v, r.medians[v] == null ? "\u2013"
          : `${fmt(r.medians[v])} <span class="n-sm">(${fmt(r.counts[v])})</span>`])])),
      ["month", ...mix.values], { id: "mix", numeric: mix.values,
        render: Object.fromEntries(mix.values.map((v) => [v, (r) => r[v]])) });
    h += `<p class="plain">The figure in brackets is how many posts that median is taken over. `
      + `Two or three posts is not a rate.</p>`;
  }

  h += periodsSection(rows, limited, dim, metric, metricName);
  // Deliberately the unnarrowed set: narrowing to our own account and then
  // asking whether the others fell would answer itself.
  const everyone = S.months.limitCol && S.months.limitVal
    ? current().everyAccount.filter((x) => M.valueOf(x, S.months.limitCol) === S.months.limitVal)
    : current().everyAccount;
  h += benchmarkSection(everyone, metric, metricName);
  return h;
}

/**
 * This account's trajectory against the others in the capture.
 *
 * Absolute medians cannot answer "did everyone fall": an account with four
 * times the following has four times the views whatever happens. Each account
 * is indexed to its own first usable month, so the lines compare shape rather
 * than height.
 */
function benchmarkSection(posts, metric, metricName) {
  const handles = [...new Set(posts.map((p) => p.author_handle).filter(Boolean))];
  if (handles.length < 2) return "";

  const { months, series } = M.byAccountMonth(posts, metric, { minPosts: 3 });
  if (series.length < 2) {
    return section("Against the other accounts", "Whether a fall is ours or everyone's.")
      + `<p class="plain">Fewer than two accounts have three or more posts in at least two months, `
      + `so there is nothing to compare yet.</p>`;
  }

  const focus = [S.months.focus, S.accountOnly].find((h) => series.some((x) => x.handle === h))
    || series[0].handle;
  let h = section("Against the other accounts", `Whether a fall is ours or everyone's. Each account is `
    + `indexed to its own first month at 100, because an account with four times the following has `
    + `four times the ${metricName} whatever happens.`);

  h += `<label class="field"><span>Our account</span><select id="m-focus">`
    + series.map((x) => `<option value="${esc(x.handle)}"${x.handle === focus ? " selected" : ""}>`
      + `${esc(x.handle)} (${fmt(x.posts)} posts)</option>`).join("") + `</select></label>`;

  const b = M.benchmark(series, focus);
  if (b) {
    h += `<div class="reading"><p>${esc(b.reading)}</p><p class="plain">`
      + `${esc(focus)} changed <b class="${b.mine < 0 ? "down" : "up"}">${b.mine > 0 ? "+" : ""}${b.mine}%</b> `
      + `from its first month to its last; the other ${fmt(b.others)} accounts changed a median of `
      + `<b class="${b.theirs < 0 ? "down" : "up"}">${b.theirs > 0 ? "+" : ""}${b.theirs}%</b>.</p></div>`;
  }

  h += C.indexedLines(months, series, { focus, caption: `median ${metricName}, indexed to each account's first month` });

  h += table(series.map((x) => ({
    account: x.handle, posts: x.posts, months: x.months,
    first: x.first ? x.first.median : null, last: x.last ? x.last.median : null,
    change: x.change,
  })), ["account", "posts", "months", "first", "last", "change"], {
    id: "bench", numeric: ["posts", "months", "first", "last"],
    render: { change: (r) => (r.change == null ? "\u2013"
      : `<b class="${r.change < 0 ? "down" : r.change > 0 ? "up" : ""}">${r.change > 0 ? "+" : ""}${r.change}%</b>`) } });
  h += `<p class="plain">A month in which an account posted fewer than three times carries no point: `
    + `a median over one post is noise, and a line drawn through it would show a fall nobody had. `
    + `"First" and "last" are that account's own first and last month with enough posts, which `
    + `need not be the same months as another's.</p>`;
  return h;
}

/**
 * Two stretches of months, set against each other.
 *
 * The monthly charts show a direction; this answers what changed. It reads
 * from the tokenised corpus rather than the raw posts, so the keyness here is
 * the same statistic the tier comparison uses, with a period in place of a
 * tier.
 */
function periodsSection(rows, limited, dim, metric, metricName) {
  const { results } = current();
  if (rows.length < 2) return "";

  const def = M.defaultPeriods(rows);
  if (!def) return "";
  const cmp = S.months.cmp || def;
  // A month that has dropped out of scope since the choice was made falls back
  // to the default, rather than silently comparing an empty period.
  const known = new Set(rows.map((r) => r.month));
  const safe = ["aFrom", "aTo", "bFrom", "bTo"].every((k) => known.has(cmp[k])) ? cmp : def;

  let h = section("Two periods compared", "What changed between one stretch of months and another. "
    + "The periods start on the thirds the reading above uses, and can be set to anything.");

  const pick = (id, value) => `<select id="${id}">` + rows.map((r) =>
    `<option value="${esc(r.month)}"${r.month === value ? " selected" : ""}>${esc(r.label)}</option>`).join("") + `</select>`;
  h += `<div class="grid two">
    <label class="field"><span>Earlier period</span><span class="range">${pick("p-a-from", safe.aFrom)}
      <i>to</i>${pick("p-a-to", safe.aTo)}</span></label>
    <label class="field"><span>Later period</span><span class="range">${pick("p-b-from", safe.bFrom)}
      <i>to</i>${pick("p-b-to", safe.bTo)}</span></label></div>`;

  const A = M.inPeriod(limited, safe.aFrom, safe.aTo);
  const B = M.inPeriod(limited, safe.bFrom, safe.bTo);
  if (!A.length || !B.length) {
    return h + `<p class="plain">One of these periods holds no posts.</p>`;
  }
  const sa = M.periodStats(A, metric), sb = M.periodStats(B, metric);
  const delta = (x, y, suffix = "") => {
    if (x == null || y == null) return "\u2013";
    const d = y - x;
    const pct = suffix === "%" ? `${d > 0 ? "+" : ""}${d} pts` : x ? `${d > 0 ? "+" : ""}${Math.round((d / x) * 100)}%` : "\u2013";
    return `<b class="${d < 0 ? "down" : d > 0 ? "up" : ""}">${pct}</b>`;
  };
  // A period of three months beats a period of two on anything that adds up,
  // whatever happened inside them, so the figures that scale with length are
  // given per month beside their totals.
  const pct = (v) => (v == null ? "\u2013" : `${v}%`);
  h += table([
    { figure: "months in the period", earlier: fmt(sa.months), later: fmt(sb.months), change: "" },
    { figure: "posts", earlier: fmt(sa.posts), later: fmt(sb.posts), change: delta(sa.posts, sb.posts) },
    { figure: "posts per month", earlier: fmt(sa.posts_per_month), later: fmt(sb.posts_per_month),
      change: delta(sa.posts_per_month, sb.posts_per_month) },
    { figure: `median ${metricName} per post`, earlier: fmt(sa.median), later: fmt(sb.median), change: delta(sa.median, sb.median) },
    { figure: "top-3 share, typical month", earlier: pct(sa.top3_month), later: pct(sb.top3_month),
      change: delta(sa.top3_month, sb.top3_month, "%") },
    { figure: `total ${metricName}`, earlier: fmt(sa.total), later: fmt(sb.total), change: delta(sa.total, sb.total) },
    { figure: `${metricName} per month`, earlier: fmt(sa.total_per_month), later: fmt(sb.total_per_month),
      change: delta(sa.total_per_month, sb.total_per_month) },
  ], ["figure", "earlier", "later", "change"], { id: "periods", numeric: ["earlier", "later", "change"],
      render: { earlier: (r) => r.earlier, later: (r) => r.later, change: (r) => r.change } });

  if (sa.months !== sb.months) {
    h += `<div class="warn"><span>These periods are ${fmt(sa.months)} and ${fmt(sb.months)} months long. `
      + `Read the per-month rows, not the totals: posts and ${metricName} add up over time, so the longer `
      + `period wins those whatever happened inside it. The median per post and the typical month's top-3 `
      + `share do not depend on length.</span></div>`;
  }

  // A period running to this month is running to today, not to month end.
  const now = M.currentMonth();
  if (safe.bTo === now || safe.aTo === now) {
    h += `<div class="warn"><span>${esc(M.monthName(now))} is not over. A period ending in it is being `
      + `compared as though it were a whole month, which pulls its posts and its total down. End the `
      + `later period on the month before, or read the median per post, which is unaffected.</span></div>`;
  }

  if (dim) {
    const shift = M.mixShift(A, B, dim);
    h += `<span class="label">the ${esc(dim)} mix, as a share of each period</span>`;
    h += table(shift, ["value", "a_pct", "b_pct", "change"], { id: "shift",
      numeric: ["a_pct", "b_pct", "change"],
      render: { a_pct: (r) => `${r.a_pct}%`, b_pct: (r) => `${r.b_pct}%`,
                change: (r) => `<b class="${r.change < 0 ? "down" : r.change > 0 ? "up" : ""}">${r.change > 0 ? "+" : ""}${r.change} pts</b>` } });
  }

  // Keyness needs the tokenised posts, matched back by id.
  const tok = new Map(results.posts.map((x) => [x.post_id, x]));
  const bag = (ps) => ps.flatMap((x) => (tok.get(x.post_id)?.content_tokens) || []);
  const bagA = bag(A), bagB = bag(B);
  const later = overUsed(bagB, bagA, "the earlier period", 12);
  const earlier = overUsed(bagA, bagB, "the later period", 12);
  if (later.length || earlier.length) {
    const max = Math.max(...later.map((r) => r.log_likelihood), ...earlier.map((r) => r.log_likelihood), 1);
    const side = (k, cls) => (k.length
      ? bars(k, "word", "log_likelihood", { max, cls: `keyness ${cls}`, fmtValue: (v) => v.toFixed(2), words: true })
      : `<p class="plain">Nothing distinctive here.</p>`);
    h += `<span class="label">what each period says that the other does not (keyness)</span>`;
    h += `<div class="grid two">
      <div><div class="band cobalt">more in ${esc(M.monthName(safe.bFrom))}\u2013${esc(M.monthName(safe.bTo))}</div>${side(later, "cobalt")}</div>
      <div><div class="band">more in ${esc(M.monthName(safe.aFrom))}\u2013${esc(M.monthName(safe.aTo))}</div>${side(earlier, "")}</div></div>`;
  }
  return h;
}

function wireMonths() {
  const dim = $("#m-dim");
  if (dim) dim.addEventListener("change", (e) => { S.months.dim = e.target.value; render(); });
  for (const id of ["p-a-from", "p-a-to", "p-b-from", "p-b-to"]) {
    const el = $(`#${id}`);
    if (!el) continue;
    el.addEventListener("change", () => {
      S.months.cmp = { aFrom: $("#p-a-from").value, aTo: $("#p-a-to").value,
                       bFrom: $("#p-b-from").value, bTo: $("#p-b-to").value };
      render();
    });
  }
  const foc = $("#m-focus");
  if (foc) foc.addEventListener("change", (e) => { S.months.focus = e.target.value; render(); });
  const lim = $("#m-limit");
  if (lim) lim.addEventListener("change", (e) => {
    const pair = limitPairs[parseInt(e.target.value, 10)];
    S.months.limitCol = pair ? pair[0] : "";
    S.months.limitVal = pair ? pair[1] : "";
    render();
  });
}

// --- members -----------------------------------------------------------------

const signalNames = (p) => Object.keys(p.signals || {});
const signalMax = (spec = {}) => ["detected_language", "caption_words", "hashtags"]
  .filter((key) => (Array.isArray(spec[key]) ? spec[key].length : spec[key])).length || 1;

function defaultMemberFilters(members) {
  const p = S.program;
  const present = [...new Set(members.map((a) => a.account_type))];
  const want = (p.include_types || []).filter((t) => present.includes(t));
  const cap = Math.max(0, ...members.map((a) => a.best_engagement));
  return {
    version: S.version,
    hidden: new Set(want.length ? present.filter((t) => !want.includes(t)) : []),
    min_engagement: Math.min(p.min_engagement || 0, cap),
    verified: null, min_followers: 0, max_followers: 0,
    min_signals: Object.fromEntries(signalNames(p).map((n) => [n, p.min_signals[n] || 0])),
    preset: null, q: "", platform: "",
  };
}

function memberFilters(members) {
  const f = S.acc;
  const present = [...new Set(members.map((a) => a.account_type))];
  return { types: present.filter((t) => !f.hidden.has(t)), verified: f.verified,
    min_engagement: f.min_engagement, min_followers: f.min_followers,
    // Zero is off rather than a cap of none, since an account with no followers
    // would otherwise be the only one left.
    max_followers: f.max_followers || null, min_signals: f.min_signals };
}

function renderMembers(view) {
  const members = allMembers();
  const p = S.program;
  if (!members.length) {
    view.innerHTML = section("Accounts", "One row per account.") + `<p class="plain">No accounts could be identified in this selection.</p>`;
    return;
  }
  if (!S.acc || S.acc.version !== S.version) S.acc = defaultMemberFilters(members);
  const f = S.acc;
  const present = [...new Set(members.map((a) => a.account_type))].sort();
  const cap = Math.max(1, ...members.map((a) => a.best_engagement));
  const hasFollowers = members.some((a) => a.followers > 0);
  const presets = Object.keys(p.audiences || {});

  let h = section("Accounts", "One row per account, ranked by its strongest post. Nothing is deleted: an account that misses the list keeps its reason.");
  h += `<div class="grid settings">
    <div><span class="label" id="type-label">Account types</span>
      <div class="toggles" role="group" aria-labelledby="type-label">${present.map((t) => `<label class="toggle">
        <input type="checkbox" data-type value="${esc(t)}"${f.hidden.has(t) ? "" : " checked"}><span>${esc(t)} ${members.filter((a) => a.account_type === t).length}</span></label>`).join("")}</div></div>
    <label class="field"><span>Minimum engagement, best post</span><input type="number" id="min-eng" min="0" max="${cap}" step="1" value="${f.min_engagement}"></label>
    <label class="field"><span>Verified</span><select id="verified">
      <option value=""${f.verified == null ? " selected" : ""}>either</option>
      <option value="1"${f.verified === true ? " selected" : ""}>verified only</option>
      <option value="0"${f.verified === false ? " selected" : ""}>not verified</option></select></label></div>`;
  const extra = [];
  if (S.platforms && S.platforms.length > 1) extra.push(`<label class="field"><span>Platform</span><select id="member-platform">
    <option value=""${f.platform ? "" : " selected"}>both</option>
    ${S.platforms.map((x) => `<option${f.platform === x ? " selected" : ""}>${esc(x)}</option>`).join("")}
    <option value="__both"${f.platform === "__both" ? " selected" : ""}>on both platforms</option></select></label>`);
  if (hasFollowers) {
    extra.push(`<label class="field"><span>Minimum followers</span><input type="number" id="min-fol" min="0" step="100" value="${f.min_followers}"></label>`);
    extra.push(`<label class="field"><span>Maximum followers, 0 for none</span><input type="number" id="max-fol" min="0" step="100" value="${f.max_followers}"></label>`);
  }
  for (const n of signalNames(p)) {
    const max = signalMax(p.signals[n]);
    extra.push(`<label class="field"><span>Minimum ${esc(n)} score, <output id="sig-${esc(n)}">${f.min_signals[n] || 0}</output> of ${max}</span>
      <input type="range" data-signal="${esc(n)}" min="0" max="${max}" step="1" value="${f.min_signals[n] || 0}"></label>`);
  }
  if (extra.length) h += `<div class="grid three">${extra.join("")}</div>`;
  if (presets.length) {
    h += `<p class="plain" style="margin-top:20px">Classes, from the program. Each one is a shortcut over the filters above and states its rule.</p>
      <div class="presets">${presets.map((n) => `<div class="preset">
        <button class="btn small${f.preset === n ? " primary" : ""}" type="button" aria-pressed="${f.preset === n}" data-preset="${esc(n)}">${esc(n)}</button>
        <span class="rule-text">${esc(A.describeAudience(p, n))}</span></div>`).join("")}</div>`;
  }
  h += `<div id="member-results"></div>`;
  view.innerHTML = h;

  $$("[data-type]", view).forEach((el) => el.addEventListener("change", () => {
    el.checked ? f.hidden.delete(el.value) : f.hidden.add(el.value); manual(); renderMemberResults();
  }));
  $("#min-eng", view).addEventListener("change", (e) => { f.min_engagement = Math.max(0, parseInt(e.target.value, 10) || 0); manual(); renderMemberResults(); });
  $("#verified", view).addEventListener("change", (e) => { f.verified = e.target.value === "" ? null : e.target.value === "1"; manual(); renderMemberResults(); });
  $("#member-platform", view)?.addEventListener("change", (e) => { f.platform = e.target.value; manual(); renderMemberResults(); });
  $("#min-fol", view)?.addEventListener("change", (e) => { f.min_followers = Math.max(0, parseInt(e.target.value, 10) || 0); manual(); renderMemberResults(); });
  $("#max-fol", view)?.addEventListener("change", (e) => { f.max_followers = Math.max(0, parseInt(e.target.value, 10) || 0); manual(); renderMemberResults(); });
  $$("[data-signal]", view).forEach((el) => el.addEventListener("input", () => {
    f.min_signals[el.dataset.signal] = parseInt(el.value, 10);
    $(`#sig-${CSS.escape(el.dataset.signal)}`, view).textContent = el.value;
    manual(); renderMemberResults();
  }));
  $$("[data-preset]", view).forEach((el) => el.addEventListener("click", () => {
    const a = A.audienceFilters(p, el.dataset.preset);
    S.acc = { ...defaultMemberFilters(members), preset: el.dataset.preset,
      hidden: new Set(a.types ? present.filter((t) => !a.types.includes(t)) : []),
      min_engagement: a.min_engagement, verified: a.verified,
      min_followers: a.min_followers, max_followers: a.max_followers || 0,
      min_signals: { ...Object.fromEntries(signalNames(p).map((n) => [n, 0])), ...a.min_signals } };
    renderMembers(view); wireView();
  }));
  renderMemberResults();

  function manual() {
    if (!f.preset) return;
    f.preset = null;
    $$("[data-preset]", view).forEach((b) => { b.classList.remove("primary"); b.setAttribute("aria-pressed", "false"); });
  }
}

function renderMemberResults() {
  const members = allMembers();
  const p = S.program;
  const f = S.acc;
  const scored = A.applyFilters(members, memberFilters(members));
  const q = f.q.trim().toLowerCase();
  const onPlatform = (a) => {
    if (!f.platform) return true;
    const held = (a.platforms || "").split(", ").filter(Boolean);
    return f.platform === "__both" ? held.length > 1 : held.includes(f.platform);
  };
  const match = (a) => onPlatform(a) && (!q || `${a.username} ${a.full_name}`.toLowerCase().includes(q));
  const kept = scored.filter((a) => !a.excluded_because).filter(match);
  const left = scored.filter((a) => a.excluded_because).filter(match);
  const hasFollowers = members.some((a) => a.followers > 0);
  const hasViews = members.some((a) => a.best_post_views > 0);
  const sigCols = members.length ? Object.keys(members[0]).filter((c) => c.startsWith("signal_")) : [];
  const plat = S.platform === "tiktok" ? "tiktok" : "instagram";
  const typeNames = Object.keys(A.resolveAccountTypes(p));

  const mixed = S.platforms && S.platforms.length > 1;
  const cols = ["username", ...(mixed ? ["platforms"] : []), "account_type", "type_reason",
    ...(hasFollowers ? ["followers"] : []), "best_engagement",
    ...(hasViews ? ["engagement_rate_pct"] : []), "posts", "verified", "months_since_best", ...sigCols];
  const numeric = ["followers", "best_engagement", "engagement_rate_pct", "posts", "months_since_best", ...sigCols];
  const cell = {
    username: (r) => (S.platform === "spreadsheet" ? esc(r.username)
      : link(profileUrl(r.username, r.platform || plat), r.username)),
    verified: (r) => (r.verified ? "yes" : ""),
    account_type: (r) => `<select data-override="${esc(r.username)}"><option value="">${esc(r.account_type)}</option>`
      + typeNames.filter((t) => t !== r.account_type).map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("")
      + (p.account_overrides[r.username.toLowerCase()] ? `<option value="__auto">back to automatic</option>` : "") + `</select>`,
  };

  $("#member-results").innerHTML = `<div class="grid metrics" style="margin-top:28px">${[
    ["on the list", kept.length], ["accounts found", members.length], ["excluded", left.length],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${fmt(v)}</div></div>`).join("")}</div>
    <div class="table-tools"><label class="field"><span>Find an account</span>
      <input type="text" id="member-q" value="${esc(f.q)}" placeholder="handle or name"></label></div>
    ${table(kept, cols, { id: "members", limit: 250, numeric, sortable: true, render: cell })}
    <p class="plain">${hasFollowers
      ? "Follower counts come with this capture, and engagement rate is measured against views, which is how TikTok is read."
      : "Weight counts likes plus comments. This capture carries no follower counts, so a small account with one popular post can outrank a large one."}
      A membership type is a keyword match, which is why the reason sits beside it, and the type can be corrected in the table.</p>
    <details class="panel"><summary>Excluded (${fmt(left.length)})</summary><div class="inner">
      <p class="plain">A keyword classifier makes mistakes in both directions. This is where they surface.</p>
      ${table(left, ["username", "account_type", "type_reason", "best_engagement", "excluded_because"],
        { id: "left", limit: 250, numeric: ["best_engagement"], wrap: ["excluded_because"], sortable: true })}
    </div></details>`;

  const box = $("#member-q");
  box.addEventListener("input", () => { f.q = box.value; renderMemberResults(); $("#member-q").focus(); });
  $$("[data-override]").forEach((sel) => sel.addEventListener("change", () => {
    const handle = sel.dataset.override.toLowerCase();
    if (sel.value === "__auto" || !sel.value) { const { [handle]: _gone, ...rest } = p.account_overrides; p.account_overrides = rest; }
    else p.account_overrides = { ...p.account_overrides, [handle]: sel.value };
    programChanged();
  }));
  $$("#member-results [data-sort]").forEach((b) => b.addEventListener("click", () => {
    const id = b.dataset.sort, key = b.dataset.key, cur = S.sorts[id];
    S.sorts[id] = { key, dir: cur && cur.key === key && cur.dir === "desc" ? "asc" : "desc" };
    renderMemberResults();
  }));
}

// --- the training log --------------------------------------------------------

function logRows() {
  const { results } = current();
  const q = S.log.q.trim().toLowerCase();
  return results.posts.filter((p) => {
    if (S.log.weight && p.engagement_tier !== S.log.weight) return false;
    if (!q) return true;
    return (p.caption_text || "").toLowerCase().includes(q)
      || (p.author_handle || "").toLowerCase().includes(q)
      || (p.content_tokens || []).includes(q);
  });
}

function logView() {
  const p = S.program;
  const rows = logRows();
  const cols = ["engagement_rank", "engagement_tier", ...(S.sources.length > 1 ? ["source"] : []), "language",
    "author_handle", "caption_text", "like_count", "comment_count", "engagement_score", "timestamp", "url"];
  let h = section("Posts", "Every post in scope, with the numbers behind its tier.");
  if (S.log.fromWord && S.log.q === S.log.fromWord) {
    h += `<div class="filterchip"><span class="what">Posts using <b>${esc(S.log.fromWord)}</b></span>
      <button class="btn small" type="button" id="log-clear">Show every post</button>
      ${S.log.from && S.log.from !== "log" ? `<button class="btn small" type="button" id="log-back">Back to ${esc(S.log.from === "reps" ? "reps" : S.log.from)}</button>` : ""}</div>`;
  }
  h += `<div class="table-tools">
    <label class="field"><span>Search captions and handles</span><input type="text" id="log-q" value="${esc(S.log.q)}" placeholder="word or handle"></label>
    <label class="field narrow"><span>Engagement tier</span><select id="log-weight">
      <option value="">every tier</option>${p.tier_labels.map((t) => `<option${S.log.weight === t ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label></div>`;
  h += `<p class="plain">${fmt(rows.length)} of ${fmt(current().posts.length)} posts.</p>`;
  h += table(rows, cols, { id: "log", limit: 100, sortable: true, wrap: ["caption_text"],
    numeric: ["engagement_rank", "like_count", "comment_count", "engagement_score"],
    render: { url: (r) => link(r.url, r.url ? "open" : ""), timestamp: (r) => esc((r.timestamp || "").slice(0, 10)) } });
  return h;
}

// --- sets: up to three files against each other ------------------------------

const SET_LIMIT = 3;

function setsView() {
  const { posts, results } = current();
  const sets = S.sources.slice(0, SET_LIMIT);
  // Keyness compares one group of posts against the others, whatever defines the
  // group. Relabelling by file and reusing it answers what is distinctive to each.
  const bySet = results.posts.map((p) => ({ ...p, engagement_tier: p.source }));
  const keyBySet = keynessAllTiers(bySet, sets, 8, 2);
  const tops = Object.fromEntries(sets.map((s) => [s, topWords(bySet.filter((p) => p.engagement_tier === s), 10)]));
  const shared = sets.length > 1
    ? tops[sets[0]].map((r) => r.word).filter((w) => sets.every((s) => tops[s].some((r) => r.word === w))) : [];

  let h = section("Files compared", `Up to three files against each other. ${S.sources.length > SET_LIMIT
    ? `This capture holds ${S.sources.length} files, so the first ${SET_LIMIT} are compared.` : ""}`);
  h += `<div class="grid metrics">${sets.map((s) => {
    const own = posts.filter((p) => p.source === s);
    return `<div class="metric"><div class="k">${esc(s)}</div><div class="v">${fmt(own.length)}</div>
      <div class="k" style="margin-top:6px">posts in scope</div></div>`;
  }).join("")}</div>`;

  h += section("What each set holds alone", "Words over-used in one file against the others pooled (keyness).");
  h += `<div class="grid sets">${sets.map((s, i) => `<div>
    <div class="band${i === 1 ? " cobalt" : ""}"${i > 1 ? ' style="background:var(--ink);color:var(--paper)"' : ""}>${esc(s)}</div>
    ${keyBySet[s].length ? bars(keyBySet[s], "word", "log_likelihood", { cls: `keyness${i === 1 ? " cobalt" : ""}`, fmtValue: (v) => v.toFixed(2), words: true, bench: false })
      : `<p class="plain">Nothing distinctive here.</p>`}</div>`).join("")}</div>`;

  h += section("Top words side by side", "The most repeated words in each file.");
  h += `<div class="grid sets">${sets.map((s) => `<div><span class="label">${esc(s)}</span>
    ${table(tops[s], ["word", "frequency"], { numeric: ["frequency"],
      render: { word: (r) => `<button class="word" type="button" data-word="${esc(r.word)}">${esc(r.word)}</button>` } })}</div>`).join("")}</div>`;

  h += section("Shared ground", "Words in every file's top ten.");
  h += shared.length ? `<div class="hashtags">${shared.map((w) => `<span>${esc(w)}</span>`).join("")}</div>`
    : `<p class="plain">No word appears in every file's top ten, so these sets have little vocabulary in common.</p>`;

  const rows = sets.map((s) => {
    const own = posts.filter((p) => p.source === s);
    const eng = own.map((p) => p.engagement_score);
    return { set: s, posts: own.length, accounts: new Set(own.map((p) => p.author_handle).filter(Boolean)).size,
      median_weight: eng.length ? eng.slice().sort((a, b) => a - b)[Math.floor(eng.length / 2)] : 0,
      best_weight: eng.length ? Math.max(...eng) : 0,
      top_hashtag: (() => {
        const counts = new Map();
        for (const p of own) for (const t of new Set(p.hashtag_list || [])) {
          const low = t.toLowerCase();
          if (S.program.query_hashtags.includes(low)) continue;
          counts.set(low, (counts.get(low) || 0) + 1);
        }
        let best = null;
        for (const [t, n] of counts) if (!best || n > best[1]) best = [t, n];
        return best ? `${best[0]} (${best[1]})` : "";
      })() };
  });
  h += section("File by file", "The same figures for each file.");
  h += table(rows, ["set", "posts", "accounts", "median_weight", "best_weight", "top_hashtag"],
    { id: "sets", numeric: ["posts", "accounts", "median_weight", "best_weight"], sortable: true });
  return h;
}

// --- gains: an account's own followers ---------------------------------------

const fmtDay = (ts) => new Date(ts).toISOString().slice(0, 10);
const fmtHour = (ts) => `${fmtDay(ts)} ${String(new Date(ts).getUTCHours()).padStart(2, "0")}:00`;

function gainsView() {
  const { follows, events } = S.account;
  const sum = G.summary(follows, events);
  const days = G.daily(follows);
  const found = G.spikes(follows);
  const moves = G.stimulus(events, follows, { windowHours: S.gains.window });

  let h = section("Followers gained", "Followers arriving, by the day they arrived. An export carries the moment each one followed, "
    + "which is the only record of timing either platform gives an account about itself.");
  h += `<div class="grid metrics">${[
    ["followers in the export", fmt(sum.follows)], ["days covered", fmt(sum.days)],
    ["a day, on average", fmt(sum.perDay)], ["last 30 days", fmt(sum.last30)],
  ].map(([k, v]) => `<div class="metric"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;

  // The last stretch at a readable width, rather than every day since the account opened.
  // A day at a time reads well over a month; over half a year it is 180 rows of
  // ones and twos, and the week is the unit that shows the shape.
  const byWeek = days.length > 60;
  const series = (byWeek ? G.weekly(follows) : days).slice(-40);
  h += bars(series.map((d) => ({ when: fmtDay(d.start), count: d.count })), "when", "count", { cls: "gainsbars" });
  const unit = byWeek ? `Follows a week, the last ${series.length} weeks, each labelled by its Monday.`
    : `Follows a day, the last ${series.length} days.`;
  h += `<p class="plain">${unit} Quiet periods are drawn too.</p>`;
  h += `<p class="plain">An export lists current followers only. Anyone who followed and has since left is absent, so the
    further back a week sits, the thinner it reads.</p>`;

  h += section("Standout days", "Days when follows ran clearly above this account's own rate. A day has to beat the usual rate by "
    + "half again, stand above its spread, and clear a floor, since two follows on a quiet account is not an event.");
  if (!found.length) {
    h += `<p class="plain">No day stands out above the rest of this period.</p>`;
  } else {
    const rows = found.slice(0, 40).map((sp) => {
      const before = G.precedes(events, sp.peakStart + 2 * 3600e3, S.gains.lookback);
      return { day: fmtDay(sp.day), follows: sp.follows, usual: sp.expected, times: sp.times,
        busiest_hours: fmtHour(sp.peakStart), in_those_hours: sp.peakFollows,
        what_came_first: before.length ? before.slice(0, 3).map((e) => e.label).join("; ") : "nothing in the export" };
    });
    h += table(rows, ["day", "follows", "usual", "times", "busiest_hours", "in_those_hours", "what_came_first"],
      { id: "prs", numeric: ["follows", "usual", "times", "in_those_hours"], wrap: ["what_came_first"], sortable: true });
  }

  h += section("What the account did", "Everything the account did, with the follows that arrived afterwards.");
  h += `<div class="table-tools">
    <label class="field narrow"><span>Window after an action</span><select id="gains-window">
      ${[1, 2, 6, 24].map((n) => `<option value="${n}"${S.gains.window === n ? " selected" : ""}>${n} hour${n > 1 ? "s" : ""}</option>`).join("")}
    </select></label></div>`;
  if (!events.length) {
    h += `<p class="plain">This export holds no posts or comments with timestamps, so there is nothing to read the
      follows against. Instagram keeps those in its posts and comments files, TikTok in its activity file; adding them
      to the same session fills this in.</p>`;
  } else {
    h += table(moves.slice(0, 200).map((e) => ({
      when: fmtHour(e.ts), what: e.kind, detail: e.label + (e.note ? `, ${e.note}` : ""),
      follows: e.follows, usual: e.expected, times: e.times, others_in_window: e.shared,
    })), ["when", "what", "detail", "follows", "usual", "times", "others_in_window"],
      { id: "stimulus", limit: 200, numeric: ["follows", "usual", "times", "others_in_window"], wrap: ["detail"], sortable: true });
    h += `<p class="plain">This is correlation inside a window, and it is worth reading as such. Follows that land after a
      comment on a large account are evidence the comment worked; they are not a path anyone traced. Where two actions
      share a window, both rows carry the same follows, which the last column states.</p>`;
  }
  return h;
}

// --- export ------------------------------------------------------------------

function exportItems() {
  const p = S.program;
  const { posts, results } = current();
  const items = [];

  if (S.account) {
    const { follows, events } = S.account;
    items.push(["Followers", "CSV, every follower with the moment it followed", () => {
      save(csv(follows.map((f) => ({ followed_at: new Date(f.ts).toISOString(), username: f.username })),
        ["followed_at", "username"]), `${slug(p.name)}-gains.csv`, "text/csv");
    }]);
    items.push(["Stimulus", "CSV, each action with the follows that came after", () => {
      const rows = G.stimulus(events, follows, { windowHours: S.gains.window }).map((e) => ({
        when: new Date(e.ts).toISOString(), what: e.kind, detail: e.label, note: e.note || "",
        follows_after: e.follows, usual_for_that_window: e.expected, times_usual: e.times, others_in_window: e.shared,
      }));
      save(csv(rows, ["when", "what", "detail", "note", "follows_after", "usual_for_that_window", "times_usual", "others_in_window"]),
        `${slug(p.name)}-stimulus.csv`, "text/csv");
    }]);
  }
  if (!results) return items;

  return items.concat([
    ["Accounts list", "Excel, three sheets: the list, who was excluded, and the settings", async () => {
      const XLSX = await lib("xlsx");
      const members = allMembers();
      const scored = A.applyFilters(members, memberFilters(members));
      const f = memberFilters(members);
      const allTypes = new Set(members.map((a) => a.account_type)).size;
      save(accountsWorkbook(XLSX, {
        passed: scored.filter((a) => !a.excluded_because).map(({ excluded_because, ...r }) => r), all: scored,
        config: p, filters: runFilters({ ...f, types: f.types.length === allTypes ? [] : f.types }),
        corpusRows: posts.length, rawRows: S.raw, platform: S.platform,
      }), `${slug(p.name)}-members.xlsx`, XLSX_TYPE);
    }],
    ["Posts", "CSV, every post in scope", () => {
      const cols = Object.keys(results.posts[0] || {}).filter((c) => !["content_tokens", "hashtags", "mentions"].includes(c));
      save(csv(results.posts, cols), `${slug(p.name)}-log.csv`, "text/csv");
    }],
    ["Posts", "Excel, every post plus the settings", async () => {
      const XLSX = await lib("xlsx");
      save(postsWorkbook(XLSX, { posts: results.posts, config: p, filters: runFilters(), platform: S.platform }),
        `${slug(p.name)}-log.xlsx`, XLSX_TYPE);
    }],
    ["Distinctive words", "CSV, the keyness table as shown", () => {
      const rows = keyness(results.posts, S.kTarget || p.tier_labels[0], S.kRef === "the rest" ? null : S.kRef, 100);
      save(csv(rows, ["word", "target_freq", "reference_freq", "log_likelihood", "log_ratio", "reference"]),
        `${slug(p.name)}-distinctive-words.csv`, "text/csv");
    }],
    ["Hooks", "CSV, the openings and how they did", () => {
      const rows = H.openers(results.posts, { size: 3, minPosts: 2, topN: 500 });
      save(csv(rows, ["phrase", "posts", "in_better_half", "share", "median_engagement"]),
        `${slug(p.name)}-hooks.csv`, "text/csv");
    }],
    ["Program", "YAML, this setup for another session or the command line", async () => {
      const { dump } = await lib("yaml");
      const out = { ...p }; delete out.file;
      save(dump(out, { lineWidth: 100, sortKeys: false }), `${slug(p.name)}.yaml`, "text/yaml");
    }],
  ]);
}

function renderExport() {
  const items = exportItems();
  $("#export-list").innerHTML = items.map(([label, note], i) =>
    `<button type="button" data-export="${i}">${esc(label)}<small>${esc(note)}</small></button>`).join("");
  $$("#export-list button").forEach((b) => b.addEventListener("click", async () => {
    $("#export-menu").open = false;
    await exportItems()[+b.dataset.export][2]();
  }));
}

// --- wiring ------------------------------------------------------------------

function wire() {
  const drop = $("#drop"), input = $("#file-input");
  input.addEventListener("change", () => onFiles(input.files));
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); onFiles(e.dataTransfer.files); });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (!$("#intake").hidden) onFiles(e.dataTransfer.files); });

  $("#reset").addEventListener("click", () => {
    Object.assign(S, { files: [], full: null, mapping: {}, sources: [] });
    memo = { key: null }; accMemo = { key: null };
    input.value = "";
    document.body.classList.remove("working");
    $("#intake").hidden = false; $("#loaded").hidden = true; $("#work").hidden = true;
    $("#files").innerHTML = ""; $("#mapping").innerHTML = ""; $("#reading").innerHTML = "";
  });

  // Scope and setup behave the same way, and only one is open at a time: two
  // panels of controls above the results would push them off the screen.
  const PANELS = [["#rack-toggle", "#rack-panel", "Scope"], ["#setup-toggle", "#setup-panel", "Setup"]];
  for (const [btnSel, panelSel, label] of PANELS) {
    const btn = $(btnSel);
    btn.addEventListener("click", () => {
      const open = $(panelSel).hidden;
      for (const [b2, p2, l2] of PANELS) {
        const isThis = p2 === panelSel;
        $(p2).hidden = isThis ? !open : true;
        $(b2).setAttribute("aria-expanded", String(isThis && open));
        $(b2).textContent = isThis && open ? `Close ${l2.toLowerCase()}` : l2;
      }
    });
  }

  $("#langs").addEventListener("change", (e) => {
    if (!e.target.matches("input")) return;
    if (e.target.value === "__tail") {
      const big = S.present.filter((r) => r.posts >= 3);
      const tail = S.present.filter((r) => !big.includes(r)).map((r) => r.language);
      for (const code of tail) e.target.checked ? S.langs.add(code) : S.langs.delete(code);
    } else e.target.checked ? S.langs.add(e.target.value) : S.langs.delete(e.target.value);
    renderRackSummary(); render();
  });
  for (const id of ["since", "until"]) {
    $(`#${id}`).addEventListener("change", (e) => {
      S[id] = e.target.value || (id === "since" ? S.lo : S.hi);
      if (S.since && S.until && S.since > S.until) { if (id === "since") S.until = S.since; else S.since = S.until; }
      // A window the reader chose belongs in the program, so it saves with it
      // and the command line reads the same one. A bound sitting on the edge of
      // the capture is not a choice though, and writing that back would bake
      // one file's first and last day into a config meant for the next capture
      // too; so the edges are stored as null, which resetForNewData reads as
      // "use whatever this file holds".
      S.program.since = S.since && S.since !== S.lo ? S.since : null;
      S.program.until = S.until && S.until !== S.hi ? S.until : null;
      remember();
      renderRack(); render();
    });
  }
  // The floor is a methodological choice, so it lives on the program and is
  // saved with it rather than being re-typed every session.
  $("#account-only").addEventListener("change", (e) => {
    S.accountOnly = e.target.value || "";
    renderRack(); render();
  });
  $("#min-views").addEventListener("change", (e) => {
    S.program.min_views = Math.max(0, parseInt(e.target.value, 10) || 0);
    e.target.value = S.program.min_views;
    programChanged();
  });
  $$(".views button").forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.view; render(); }));

  document.addEventListener("click", (e) => {
    if (e.target.id === "claim-edit") { S.program.claim = ""; programChanged(); }
    if (e.target.id === "claim-save") {
      S.program.claim = $("#claim-box").value.trim();
      programChanged();
    }
    const menu = $("#export-menu");
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "log-q") { S.log.q = e.target.value; S.log.fromWord = null; render(); $("#log-q").focus(); }
  });
  document.addEventListener("change", (e) => {
    if (e.target.id === "log-weight") { S.log.weight = e.target.value; render(); }
    if (e.target.id === "k-target") { S.kTarget = e.target.value; render(); }
    if (e.target.id === "k-ref") { S.kRef = e.target.value; render(); }
  });
}

loadData().then(() => { recall(); wire(); }).catch((e) => {
  $("#intake").insertAdjacentHTML("beforeend", `<div class="warn">The reference data did not load (${esc(e.message)}).
    The page has to be served over http, rather than opened as a file.</div>`);
});
