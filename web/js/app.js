// Monk-E Bars in the browser.
//
// A dropped file is read, parsed and language-detected once. Every setting after
// that is a filter over an array already in memory, so a click costs
// milliseconds and nothing is ever re-read. The Streamlit version reran the
// whole script on each click, and on a shared server with a gigabyte of memory
// that was the difference between a filter and a reset.
//
// Nothing leaves the tab. There is no server to send a capture to.

import { parseNdjson, detect, parseRecords, parseTable, guessMapping } from "./ingest.js";
import { setContractions } from "./text.js";
import { buildCorpus, filterLanguages, filterDates, retier, languageCounts, makeDetector } from "./corpus.js";
import { analyze, keyness } from "./lexical.js";
import * as A from "./accounts.js";
import { generate, setLanguageNames, langName } from "./findings.js";
import { accountsWorkbook, postsWorkbook, profileUrl } from "./export.js";

// Pinned, so the analysis cannot change underneath a study between visits.
const LIB = {
  franc: "https://cdn.jsdelivr.net/npm/franc@6.2.0/+esm",
  // 0.20.3 from SheetJS's own CDN: the npm registry stops at 0.18.5, which has
  // two published vulnerabilities in its parser.
  xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs",
  yaml: "https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs",
};
const libs = {};
async function lib(name) {
  if (!libs[name]) libs[name] = import(LIB[name]);
  return libs[name];
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Only web links become links. A spreadsheet's URL column can hold anything.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
const link = (u, text) => (safeUrl(u) ? `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));
const emphasis = (t) => esc(t).replace(/\*([^*]+)\*/g, "<b>$1</b>");
const fmt = (n) => (n == null || n === "" ? "" : typeof n === "number" ? n.toLocaleString("en-GB") : String(n));
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

// --- reference data ----------------------------------------------------------

let SW, STUDIES;
async function loadData() {
  const get = (f) => fetch(`data/${f}`).then((r) => { if (!r.ok) throw new Error(f); return r.json(); });
  const [sw, contractions, types, names, studies] = await Promise.all([
    get("stopwords.json"), get("contractions.json"), get("account_types.json"),
    get("languages.json"), get("configs.json")]);
  SW = sw; STUDIES = studies;
  setContractions(contractions);
  A.setAccountTypes(types);
  setLanguageNames(names);
}

/** A study as the pipeline reads it, with the Python package's defaults. */
function normalizeConfig(d, file = "") {
  d = d || {};
  const dateStr = (v) => (v == null || v === "" ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const cfg = {
    file,
    name: d.name || "study",
    description: d.description || "",
    claim: String(d.claim || "").trim(),
    language: d.language === undefined ? "en" : d.language,
    tier_labels: (d.tier_labels && d.tier_labels.length ? d.tier_labels : ["High", "Medium", "Low"]).map(String),
    query_hashtags: (d.query_hashtags || []).map((h) => String(h).toLowerCase()),
    stopwords_extra: (d.stopwords_extra || []).map((w) => String(w).toLowerCase()),
    themes: Object.fromEntries(Object.entries(d.themes || {}).map(([k, v]) => [k, (v || []).map((w) => String(w).toLowerCase())])),
    since: dateStr(d.since), until: dateStr(d.until),
    account_types: { ...(d.account_types || {}) },
    include_types: [...(d.include_types || [])],
    signals: { ...(d.signals || {}) },
    min_signals: Object.fromEntries(Object.entries(d.min_signals || {}).map(([k, v]) => [k, parseInt(v, 10) || 0])),
    min_engagement: parseInt(d.min_engagement, 10) || 0,
    audiences: { ...(d.audiences || {}) },
  };
  const problems = [];
  for (const t of cfg.query_hashtags) if (!t.startsWith("#")) problems.push(`query_hashtag '${t}' should start with '#'.`);
  if (problems.length) throw new Error(problems.join(" "));
  return cfg;
}
const studyLanguages = (cfg) => (cfg.language == null ? [] : [].concat(cfg.language)).map((c) => String(c).toLowerCase());

// --- state -------------------------------------------------------------------

const S = {
  files: [],          // {name, kind, platform, note, records | rows, columns}
  mapping: {},        // spreadsheet column overrides, first table only
  full: null,         // every post, deduplicated and labelled
  raw: 0, platform: "",
  config: null,
  present: [],        // [{language, posts}]
  langs: new Set(), since: "", until: "", lo: "", hi: "",
  view: "report", sub: "keyness",
  acc: null,          // account filters
  kTarget: null, kRef: "rest of corpus",
  version: 0,         // bumps whenever the corpus or the study changes
};
let memo = { key: null };
let accMemo = { key: null };

// --- intake ------------------------------------------------------------------

const TABLE_EXT = /\.(csv|tsv|txt|xlsx|xls)$/i;

async function readFile(file) {
  if (TABLE_EXT.test(file.name)) {
    const XLSX = await lib("xlsx");
    const binary = /\.xlsx?$/i.test(file.name);
    const wb = binary
      ? XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true })
      : XLSX.read(await file.text(), { type: "string", raw: true, FS: /\.tsv$/i.test(file.name) ? "\t" : undefined });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
    const columns = rows.length ? Object.keys(rows[0]) : [];
    const ok = rows.length > 0;
    return { name: file.name, kind: "table", platform: "table", rows, columns, ok,
      note: ok ? `Spreadsheet, ${rows.length} rows, ${columns.length} columns.` : "The first sheet holds no rows." };
  }
  const text = await file.text();
  let records;
  const head = text.trimStart();
  if (head.startsWith("[")) { try { records = JSON.parse(head); } catch { records = []; } }
  else records = parseNdjson(text);
  const d = detect(records);
  return { name: file.name, kind: d.kind, platform: d.platform, note: d.note, records, ok: d.kind === "zeeschuimer" };
}

async function onFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  $("#intake").hidden = true;
  $("#loaded").hidden = false;
  $("#work").hidden = true;
  $("#files").innerHTML = `<p class="note">Reading ${files.length} file${files.length > 1 ? "s" : ""}.</p>`;
  try {
    S.files = await Promise.all(files.map(readFile));
  } catch (e) {
    $("#files").innerHTML = `<div class="warn">A file could not be read: ${esc(e.message)}</div>`;
    return;
  }
  S.mapping = {};
  renderFiles();
  const bad = S.files.filter((f) => !f.ok);
  const platforms = new Set(S.files.map((f) => f.platform));
  if (bad.length) return;
  if (platforms.size > 1) {
    $("#files").insertAdjacentHTML("beforeend", `<div class="warn">These files come from ${esc([...platforms].join(" and "))}. `
      + "Pooling them would rank two engagement scales against each other, so each needs its own analysis.</div>");
    return;
  }
  renderMapping();
  await buildFull();
}

function renderFiles() {
  $("#files").innerHTML = S.files.map((f) => `<div class="file"><span class="mark ${f.ok ? (f.kind === "table" ? "table" : "") : "bad"}"></span>`
    + `<span><b>${esc(f.name)}</b> &nbsp;/&nbsp; ${esc(f.note)}</span></div>`).join("");
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
    <p class="note">Matched by name. A wrong match changes the ranking, so it is worth a look before reading the results.</p>
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

/** Parse, detect language once, deduplicate. The only slow step, and it runs
 *  once per set of files. */
async function buildFull() {
  let posts;
  try {
    posts = S.files.flatMap((f, i) => (f.kind === "table"
      ? parseTable(f.rows, f.name, S.files.findIndex((x) => x.kind === "table") === i ? S.mapping : {})
      : parseRecords(f.records, f.platform)));
  } catch (e) {
    $("#files").insertAdjacentHTML("beforeend", `<div class="warn">${esc(e.message)}</div>`);
    return;
  }
  if (!posts.length) {
    $("#files").insertAdjacentHTML("beforeend", `<div class="warn">No posts could be read from these files.</div>`);
    return;
  }
  S.raw = posts.length;
  S.platform = S.files[0].platform === "table" ? "spreadsheet" : S.files[0].platform;

  progress(0, 1, "Loading the language detector");
  let detectLang;
  try { detectLang = makeDetector((await lib("franc")).franc); }
  catch { progress(0, 1, "The language detector could not load, so every post is marked undetected."); detectLang = () => "unknown"; }

  // Detected in slices, handing the page back between them, so a capture of
  // several thousand posts keeps the tab responsive and shows progress.
  const labels = new Map();
  const CHUNK = 200;
  for (let i = 0; i < posts.length; i += CHUNK) {
    for (const p of posts.slice(i, i + CHUNK)) if (!labels.has(p.post_id)) labels.set(p.post_id, detectLang(p.caption_text));
    progress(Math.min(i + CHUNK, posts.length), posts.length,
      `Detecting languages, ${Math.min(i + CHUNK, posts.length)} of ${posts.length} posts`);
    await nextFrame();
  }
  const { posts: full } = buildCorpus(posts, { detect: (_, p) => labels.get(p.post_id), tierLabels: ["High"] });
  S.full = full;
  $("#progress").hidden = true;
  S.present = languageCounts(full);

  const times = full.map((p) => p.timestamp).filter(Boolean).sort();
  S.lo = times.length ? times[0].slice(0, 10) : "";
  S.hi = times.length ? times[times.length - 1].slice(0, 10) : "";

  if (!S.config) selectStudy(STUDIES.find((s) => s.file === "generic.yaml") ? "generic.yaml" : STUDIES[0].file, false);
  applyStudyDefaults();
  $("#work").hidden = false;
  render();
}

// --- study -------------------------------------------------------------------

function renderStudyOptions() {
  const current = S.config ? S.config.file : "";
  $("#study").innerHTML = STUDIES.map((s) => `<option value="${esc(s.file)}"${s.file === current ? " selected" : ""}>${esc(s.file)}</option>`).join("")
    + `<option value="__upload"${current === "__upload" ? " selected" : ""}>upload a study file (YAML)</option>`;
}

function selectStudy(file, rerender = true) {
  if (file === "__upload") { $("#study-upload-wrap").hidden = false; return; }
  $("#study-upload-wrap").hidden = true;
  S.config = normalizeConfig(STUDIES.find((s) => s.file === file), file);
  if (rerender) { applyStudyDefaults(); render(); }
}

/** A study brings its own languages, dates and account filters; switching
 *  study resets them to what it asks for. */
function applyStudyDefaults() {
  const present = S.present.map((r) => r.language);
  const wanted = studyLanguages(S.config).filter((l) => present.includes(l));
  S.langs = new Set(wanted.length ? wanted : present);
  const clamp = (d) => (d < S.lo ? S.lo : d > S.hi ? S.hi : d);
  S.since = S.config.since && S.lo ? clamp(S.config.since) : S.lo;
  S.until = S.config.until && S.hi ? clamp(S.config.until) : S.hi;
  S.acc = null;
  S.kTarget = S.config.tier_labels[0];
  S.kRef = "rest of corpus";
  S.version++;
  renderStudyOptions();
  renderSettings();
}

function renderSettings() {
  const total = S.full.length;
  $("#langs").innerHTML = S.present.map(({ language, posts }) => `<label class="toggle">
      <input type="checkbox" value="${esc(language)}"${S.langs.has(language) ? " checked" : ""}>
      <span>${esc(langName(language))} ${posts}</span></label>`).join("");
  $("#lang-label").textContent = `Languages, ${S.present.length} detected in ${total} posts`;
  for (const id of ["since", "until"]) {
    const el = $(`#${id}`);
    el.disabled = !S.lo;
    el.min = S.lo; el.max = S.hi; el.value = S[id];
  }
}

// --- the filtered corpus -----------------------------------------------------

function current() {
  const key = [S.version, [...S.langs].sort().join(","), S.since, S.until].join("|");
  if (memo.key === key) return memo.value;
  const cfg = S.config;
  const langs = [...S.langs];
  let posts = filterLanguages(S.full, langs);
  if (!langs.length) posts = [];
  posts = retier(filterDates(posts, S.since || null, S.until || null), cfg.tier_labels);
  let value = { posts, results: null, findings: [] };
  if (posts.length) {
    const results = analyze(posts, cfg, SW);
    const subset = langs.length < S.present.length ? langs : null;
    value = { posts, results, findings: generate(results.posts, cfg, { rawCount: S.raw, languages: subset }) };
  }
  memo = { key, value };
  return value;
}

function render() {
  const { posts, results } = current();
  const cfg = S.config;
  const tiers = cfg.tier_labels.map((t) => `${posts.filter((p) => p.engagement_tier === t).length}`).join(" / ");
  $("#summary").innerHTML = `<span class="chip">${esc(cfg.name)}</span><span class="meta">${esc(S.platform)} &nbsp;/&nbsp; `
    + `${fmt(posts.length)} posts &nbsp;/&nbsp; ${fmt(S.raw)} records read &nbsp;/&nbsp; tiers ${esc(tiers)}</span>`;
  const warn = [];
  if (!posts.length) warn.push(S.langs.size ? "Nothing is left after these filters. Widen the languages or the dates."
    : "No language is selected, so nothing is kept.");
  else if (posts.every((p) => !p.engagement_score)) warn.push("Every post scores zero engagement, so the tiers carry no information. "
    + "A likes or comments column fixes that; until then the vocabulary sections are the ones to read.");
  $("#warnings").innerHTML = warn.map((w) => `<div class="warn">${esc(w)}</div>`).join("");
  $$(".views button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === S.view)));
  const view = $("#view");
  if (!results) { view.innerHTML = ""; return; }
  if (S.view === "report") view.innerHTML = reportView();
  else if (S.view === "accounts") renderAccounts(view);
  else renderWorkbench(view);
}

// --- drawing -----------------------------------------------------------------

function bars(rows, labelKey, valueKey, { max = null, cls = "", fmtValue = fmt } = {}) {
  const top = max ?? (Math.max(...rows.map((r) => r[valueKey]), 0) || 1);
  return `<div class="bars ${cls}">${rows.map((r) => `<div class="row">
    <span class="lbl" title="${esc(r[labelKey])}">${esc(r[labelKey])}</span>
    <span class="track"><span class="fill" style="display:block;width:${Math.max(0, (r[valueKey] / top) * 100).toFixed(2)}%"></span></span>
    <span class="num">${esc(fmtValue(r[valueKey]))}</span></div>`).join("")}</div>`;
}

const TIER_FILL = ["var(--ink)", "var(--ink-60)", "var(--ink-35)", "#A89B8B", "#C0B6A8", "#D6CDBE"];

function themeChart(shares, tiers) {
  const top = Math.max(...shares.flatMap((r) => tiers.map((t) => r[t])), 0) || 1;
  return `<div class="legend">${tiers.map((t, i) => `<span><i style="background:${TIER_FILL[i % 6]}"></i>${esc(t)}</span>`).join("")}</div>
    <div class="themes">${shares.map((r) => `<div class="theme"><div class="name">${esc(r.theme)}</div>
      ${tiers.map((t, i) => `<div class="row"><span class="t">${esc(t)}</span>
        <span class="track"><span class="fill" style="display:block;background:${TIER_FILL[i % 6]};width:${((r[t] / top) * 100).toFixed(2)}%"></span></span>
        <span class="t" style="text-align:right">${r[t].toFixed(2)}%</span></div>`).join("")}</div>`).join("")}</div>`;
}

function table(rows, cols, { limit = Infinity, numeric = [], wrap = [], render: cell = {} } = {}) {
  if (!rows.length) return `<p class="note">Nothing to show.</p>`;
  const shown = rows.slice(0, limit);
  const head = cols.map((c) => `<th class="${numeric.includes(c) ? "n" : ""}">${esc(c)}</th>`).join("");
  const body = shown.map((r) => `<tr>${cols.map((c) => {
    const cls = numeric.includes(c) ? "n" : wrap.includes(c) ? "wrap" : "";
    const v = cell[c] ? cell[c](r) : esc(fmt(r[c]));
    return `<td class="${cls}">${v}</td>`;
  }).join("")}</tr>`).join("");
  const more = rows.length > shown.length
    ? `<p class="note">Showing the first ${fmt(shown.length)} of ${fmt(rows.length)} rows. The download holds every one.</p>` : "";
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

function section(label, note = "") {
  return `<div class="section">${esc(label)}</div>${note ? `<p class="note">${note}</p>` : ""}`;
}

// --- downloads ---------------------------------------------------------------

function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function csv(rows, cols) {
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;  // voice: ignore
  };
  return "﻿" + [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "study";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function runFilters(extra = {}) {
  const all = S.present.length === S.langs.size;
  return { languages: all ? [] : [...S.langs].map(langName), since: S.since, until: S.until, ...extra };
}

// --- report ------------------------------------------------------------------

function reportView() {
  const { posts, results, findings } = current();
  const cfg = S.config;
  const tiers = cfg.tier_labels;
  let h = section("Finding");
  h += cfg.claim
    ? `<div class="claim"><div class="bar"></div><div class="body"><div class="q">${esc(cfg.claim)}</div>
        <div class="src">reading, authored &nbsp;/&nbsp; ${esc(cfg.file === "__upload" ? cfg.name : cfg.file)}</div></div></div>`
    : `<p class="note" style="margin-top:18px">No reading is authored for this study, and the tool does not write one.
        A <code>claim:</code> line in the study file prints here, above the evidence, attributed to whoever wrote it.</p>`;
  h += `<div style="margin-top:30px"><span class="tag">GENERATED FROM THE CORPUS</span></div>
    <ul class="evidence">${findings.map((f) => `<li>${emphasis(f.text)}</li>`).join("")}</ul>`;

  const flat = posts.every((p) => !p.engagement_score);
  if (tiers.length >= 2 && !flat) {
    const hi = tiers[0], lo = tiers[tiers.length - 1];
    const kh = keyness(results.posts, hi, lo, 12), kl = keyness(results.posts, lo, hi, 12);
    if (kh.length || kl.length) {
      const max = Math.max(...kh.map((r) => r.log_likelihood), ...kl.map((r) => r.log_likelihood), 1);
      const side = (rows, cls) => (rows.length ? bars(rows, "word", "log_likelihood", { max, cls: `keyness ${cls}`, fmtValue: (v) => v.toFixed(2) })
        : `<p class="note">nothing distinctive at this end</p>`);
      h += section("Keyness", `What separates ${esc(hi.toLowerCase())} from ${esc(lo.toLowerCase())} once frequency is controlled for.`);
      h += `<div class="grid two"><div><div class="band">${esc(hi)} engagement</div>${side(kh, "")}</div>
        <div><div class="band cobalt">${esc(lo)} engagement</div>${side(kl, "cobalt")}</div></div>
        <p class="note">Log-likelihood ranks confidence that a difference is real. Log ratio, in the Workbench, is the size of it.</p>`;
    }
  }

  h += section("Corpus");
  h += `<div class="grid four">${[
    ["posts analysed", fmt(posts.length)], ["records read", fmt(S.raw)],
    ["tiers", tiers.map((t) => posts.filter((p) => p.engagement_tier === t).length).join("/")],
    ["framework layers", Object.keys(cfg.themes).length],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join("")}</div>`;

  h += section("Thematic layers");
  h += Object.keys(cfg.themes).length
    ? themeChart(results.themeShares, tiers) + `<p class="note">Share of each tier's content words that fall in the layer's word list.
        Dictionary counting finds what it was given; the Python package models topics from the vocabulary alone as a check.</p>`
    : `<p class="note">No framework is defined for this study. Themes are a lens brought to a corpus, so a study file with a
        <code>themes:</code> block adds one. Topics modelled from the vocabulary alone come from the Python package:
        <code>monke-bars analyze --discover-themes 5</code>.</p>`;

  if (results.hashtags.length) {
    h += section("Hashtags", "Co-occurring with the seed tags, seeds excluded.");
    h += `<div class="hashtags">${results.hashtags.slice(0, 12).map((r) => `<span>${esc(r.hashtag)}<b>${r.frequency}</b></span>`).join("")}</div>`;
  }

  h += section("Colour");
  h += `<p class="note">Colour is not read in the browser. Instagram and TikTok serve media from hosts that refuse to let
    another page read the pixels, so palettes are extracted by the Python package, close to the time of the scrape, since
    capture links expire.</p>`;
  return h;
}

// --- accounts ----------------------------------------------------------------

function allAccounts() {
  const key = memo.key;
  if (accMemo.key === key) return accMemo.value;
  const value = A.buildAccounts(current().posts, S.config);
  accMemo = { key, value };
  return value;
}

const signalNames = (cfg) => Object.keys(cfg.signals || {});
const signalMax = (spec = {}) => ["detected_language", "caption_words", "hashtags"]
  .filter((k) => (Array.isArray(spec[k]) ? spec[k].length : spec[k])).length || 1;

function defaultAccountFilters(accs) {
  const cfg = S.config;
  const present = [...new Set(accs.map((a) => a.account_type))].sort();
  const want = (cfg.include_types || []).filter((t) => present.includes(t));
  const cap = Math.max(0, ...accs.map((a) => a.best_engagement));
  return {
    types: new Set(want.length ? want : present),
    min_engagement: Math.min(cfg.min_engagement || 0, cap),
    verified: null, min_followers: 0,
    min_signals: Object.fromEntries(signalNames(cfg).map((n) => [n, cfg.min_signals[n] || 0])),
  };
}

function activeFilters() {
  const f = S.acc;
  return { types: [...f.types], verified: f.verified, min_engagement: f.min_engagement,
    min_followers: f.min_followers, min_signals: f.min_signals };
}

function renderAccounts(view) {
  const accs = allAccounts();
  const cfg = S.config;
  if (!accs.length) { view.innerHTML = section("Accounts") + `<p class="note">No accounts could be identified in this corpus.</p>`; return; }
  // Kept across language and date changes; a new file or study resets them.
  if (!S.acc || S.acc.version !== S.version) S.acc = { ...defaultAccountFilters(accs), version: S.version };
  const f = S.acc;
  const present = [...new Set(accs.map((a) => a.account_type))].sort();
  const cap = Math.max(1, ...accs.map((a) => a.best_engagement));
  const hasFollowers = accs.some((a) => a.followers > 0);
  const presets = Object.keys(cfg.audiences || {});

  let h = section("Accounts", "One row per account, ranked by its strongest post. These filters never delete: every account left out keeps its reason.");
  h += `<div class="grid settings">
    <div><span class="label" id="type-label">Account types</span>
      <div class="toggles" role="group" aria-labelledby="type-label">${present.map((t) => `<label class="toggle">
        <input type="checkbox" data-type value="${esc(t)}"${f.types.has(t) ? " checked" : ""}><span>${esc(t)} ${accs.filter((a) => a.account_type === t).length}</span></label>`).join("")}</div></div>
    <label class="field"><span>Minimum engagement, best post</span>
      <input type="number" id="min-eng" min="0" max="${cap}" step="1" value="${f.min_engagement}"></label>
    <label class="field"><span>Verified</span><select id="verified">
      <option value=""${f.verified == null ? " selected" : ""}>either</option>
      <option value="1"${f.verified === true ? " selected" : ""}>verified only</option>
      <option value="0"${f.verified === false ? " selected" : ""}>not verified</option></select></label>
  </div>`;
  const extra = [];
  if (hasFollowers) extra.push(`<label class="field"><span>Minimum followers</span>
    <input type="number" id="min-fol" min="0" step="100" value="${f.min_followers}"></label>`);
  for (const n of signalNames(cfg)) {
    const max = signalMax(cfg.signals[n]);
    extra.push(`<label class="field"><span>Minimum ${esc(n)} score, <output id="sig-out-${esc(n)}">${f.min_signals[n] || 0}</output> of ${max}</span>
      <input type="range" data-signal="${esc(n)}" min="0" max="${max}" step="1" value="${f.min_signals[n] || 0}"></label>`);
  }
  if (extra.length) h += `<div class="grid three">${extra.join("")}</div>`;
  if (presets.length) {
    h += `<p class="note" style="margin-top:22px">Presets from the study. Each is a shortcut over the filters above, and states its rule.</p>
      <div class="presets">${presets.map((p) => `<div class="preset"><button class="btn small${f.preset === p ? " primary" : ""}" type="button" aria-pressed="${f.preset === p}" data-preset="${esc(p)}">${esc(p)}</button>
        <span class="rule-text">${esc(A.describeAudience(cfg, p))}</span></div>`).join("")}</div>`;
  }
  h += `<div id="acc-results"></div>`;
  view.innerHTML = h;

  $$("[data-type]", view).forEach((el) => el.addEventListener("change", () => {
    el.checked ? f.types.add(el.value) : f.types.delete(el.value); renderAccountResults(true);
  }));
  $("#min-eng", view).addEventListener("change", (e) => { f.min_engagement = Math.max(0, parseInt(e.target.value, 10) || 0); renderAccountResults(true); });
  $("#verified", view).addEventListener("change", (e) => { f.verified = e.target.value === "" ? null : e.target.value === "1"; renderAccountResults(true); });
  $("#min-fol", view)?.addEventListener("change", (e) => { f.min_followers = Math.max(0, parseInt(e.target.value, 10) || 0); renderAccountResults(true); });
  $$("[data-signal]", view).forEach((el) => el.addEventListener("input", () => {
    f.min_signals[el.dataset.signal] = parseInt(el.value, 10);
    $(`#sig-out-${CSS.escape(el.dataset.signal)}`, view).textContent = el.value;
    renderAccountResults(true);
  }));
  $$("[data-preset]", view).forEach((el) => el.addEventListener("click", () => {
    const p = A.audienceFilters(cfg, el.dataset.preset);
    S.acc = { version: S.version, preset: el.dataset.preset,
      types: new Set(p.types ? p.types.filter((t) => present.includes(t)) : present),
      min_engagement: p.min_engagement, verified: p.verified, min_followers: p.min_followers,
      min_signals: { ...Object.fromEntries(signalNames(cfg).map((n) => [n, 0])), ...p.min_signals } };
    renderAccounts(view);
  }));
  renderAccountResults();
}

function renderAccountResults(manual = false) {
  if (manual && S.acc.preset) {
    S.acc.preset = null;
    $$("[data-preset]").forEach((b) => { b.classList.remove("primary"); b.setAttribute("aria-pressed", "false"); });
  }
  const accs = allAccounts();
  const cfg = S.config;
  const scored = A.applyFilters(accs, activeFilters());
  const kept = scored.filter((a) => !a.excluded_because);
  const left = scored.filter((a) => a.excluded_because);
  const hasFollowers = accs.some((a) => a.followers > 0);
  const hasViews = accs.some((a) => a.best_post_views > 0);
  const sigCols = accs.length ? Object.keys(accs[0]).filter((c) => c.startsWith("signal_")) : [];
  const plat = S.platform === "tiktok" ? "tiktok" : "instagram";

  const cols = ["username", "account_type", "type_reason", ...(hasFollowers ? ["followers"] : []), "best_engagement",
    ...(hasViews ? ["engagement_rate_pct"] : []), "posts", "verified", "months_since_best", ...sigCols];
  const numeric = ["followers", "best_engagement", "engagement_rate_pct", "posts", "months_since_best", ...sigCols];
  const cell = {
    username: (r) => (S.platform === "spreadsheet" ? esc(r.username) : link(profileUrl(r.username, plat), r.username)),
    verified: (r) => (r.verified ? "yes" : ""),
  };

  let h = `<div class="grid metrics" style="margin-top:30px">${[
    ["accounts in list", kept.length], ["accounts found", accs.length], ["left out", left.length],
  ].map(([k, v]) => `<div class="metric"><div class="k">${k}</div><div class="v">${fmt(v)}</div></div>`).join("")}</div>`;
  h += `<div class="btns"><button class="btn primary" type="button" id="dl-accounts"${kept.length ? "" : " disabled"}>Download the account list (Excel)</button></div>`;
  h += table(kept, cols, { limit: 250, numeric, render: cell });
  h += `<p class="note">${hasFollowers
    ? "Follower counts come with this capture. Engagement rate is measured against views, which is how TikTok is read."
    : "Reach counts likes plus comments. This capture carries no follower counts, so a small account with one popular post can outrank a large one, and the top names are worth checking by hand."}
    Account type is a keyword match on the handle and display name, which is why the type_reason column is there to be read.</p>`;
  h += `<details class="panel"><summary>Left out (${fmt(left.length)})</summary><div class="inner">
    <p class="note">A keyword classifier makes mistakes in both directions. This is where they surface.</p>
    ${table(left, ["username", "account_type", "type_reason", "best_engagement", "excluded_because"], { limit: 250, numeric: ["best_engagement"], wrap: ["excluded_because"], render: cell })}
    </div></details>`;
  $("#acc-results").innerHTML = h;

  $("#dl-accounts").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const XLSX = await lib("xlsx");
      const f = activeFilters();
      const buf = accountsWorkbook(XLSX, { passed: kept.map(({ excluded_because, ...r }) => r), all: scored, config: cfg,
        filters: runFilters({ ...f, types: f.types.length === new Set(accs.map((a) => a.account_type)).size ? [] : f.types }),
        corpusRows: current().posts.length, rawRows: S.raw, platform: S.platform });
      save(buf, `${slug(cfg.name)}-accounts.xlsx`, XLSX_TYPE);
    } finally { e.target.disabled = false; }
  });
}

// --- workbench ---------------------------------------------------------------

const SUBS = [["keyness", "Keyness"], ["words", "Words"], ["phrases", "Phrases"], ["hashtags", "Hashtags"], ["themes", "Themes"], ["corpus", "Corpus"]];

function renderWorkbench(view) {
  view.innerHTML = section("Workbench", "The tables, the controls, the exports.")
    + `<nav class="subviews" role="tablist" aria-label="Table">${SUBS.map(([k, l]) =>
      `<button role="tab" data-sub="${k}" aria-selected="${k === S.sub}">${l}</button>`).join("")}</nav><div id="sub"></div>`;
  $$("[data-sub]", view).forEach((b) => b.addEventListener("click", () => { S.sub = b.dataset.sub; renderWorkbench(view); }));
  renderSub();
}

function renderSub() {
  const { posts, results } = current();
  const cfg = S.config;
  const tiers = cfg.tier_labels;
  const el = $("#sub");
  const sub = S.sub;

  if (sub === "keyness") {
    if (tiers.length < 2) { el.innerHTML = `<p class="note">Keyness needs at least two tiers.</p>`; return; }
    if (!tiers.includes(S.kTarget)) S.kTarget = tiers[0];
    const refs = ["rest of corpus", ...tiers.filter((t) => t !== S.kTarget)];
    if (!refs.includes(S.kRef)) S.kRef = "rest of corpus";
    el.innerHTML = `<div class="grid two">
      <label class="field"><span>Target tier</span><select id="k-target">${tiers.map((t) => `<option${t === S.kTarget ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
      <label class="field"><span>Compared against</span><select id="k-ref">${refs.map((t) => `<option${t === S.kRef ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
    </div><div id="k-out"></div>`;
    const draw = () => {
      const rows = keyness(results.posts, S.kTarget, S.kRef === "rest of corpus" ? null : S.kRef, 25);
      const cols = ["word", "target_freq", "reference_freq", "log_likelihood", "log_ratio"];
      $("#k-out").innerHTML = (rows.length ? table(rows, cols, { numeric: cols.slice(1) })
        + `<div class="btns"><button class="btn small" type="button" id="k-dl">Download keyness (CSV)</button></div>`
        : `<p class="note">Not enough data in this tier.</p>`);
      $("#k-dl")?.addEventListener("click", () => save(csv(rows, [...cols, "reference"]), `${slug(cfg.name)}-keyness-${slug(S.kTarget)}.csv`, "text/csv"));
    };
    $("#k-target").addEventListener("change", (e) => { S.kTarget = e.target.value; renderSub(); });
    $("#k-ref").addEventListener("change", (e) => { S.kRef = e.target.value; draw(); });
    draw();
  } else if (sub === "words") {
    el.innerHTML = bars(results.topWords.slice(0, 20), "word", "frequency")
      + `<div class="grid three">${tiers.map((t) => `<div><span class="label">${esc(t.toLowerCase())}</span>
        ${table(results.topWordsByTier[t], ["word", "frequency"], { numeric: ["frequency"] })}</div>`).join("")}</div>`;
  } else if (sub === "phrases") {
    el.innerHTML = `<div class="grid two"><div><span class="label">bigrams</span>${table(results.bigrams, ["phrase", "frequency"], { numeric: ["frequency"] })}</div>
      <div><span class="label">trigrams</span>${table(results.trigrams, ["phrase", "frequency"], { numeric: ["frequency"] })}</div></div>`;
  } else if (sub === "hashtags") {
    el.innerHTML = bars(results.hashtags.slice(0, 20), "hashtag", "frequency")
      + table(results.hashtags, ["hashtag", "frequency"], { numeric: ["frequency"] });
  } else if (sub === "themes") {
    el.innerHTML = Object.keys(cfg.themes).length
      ? `<span class="label" style="margin-top:22px">token hits</span>${table(results.themeCounts, ["theme", ...tiers, "total"], { numeric: [...tiers, "total"] })}
         <span class="label" style="margin-top:22px">percent of each tier's content words</span>${table(results.themeShares, ["theme", ...tiers], { numeric: tiers })}`
      : `<p class="note">No framework in this study.</p>`;
  } else {
    const cols = ["engagement_rank", "engagement_tier", "language", "author_handle", "caption_text", "like_count",
      "comment_count", "engagement_score", "follower_count", "view_count", "timestamp", "url", "hashtag_list"];
    el.innerHTML = table(results.posts, cols, { limit: 100, wrap: ["caption_text"],
      numeric: ["engagement_rank", "like_count", "comment_count", "engagement_score", "follower_count", "view_count"],
      render: { url: (r) => link(r.url, r.url ? "open" : ""), hashtag_list: (r) => esc((r.hashtag_list || []).join(" ")) } })
      + `<div class="btns"><button class="btn small" type="button" id="c-csv">Download corpus (CSV)</button>
         <button class="btn small" type="button" id="c-xlsx">Download corpus (Excel)</button></div>`;
    const all = Object.keys(results.posts[0] || {}).filter((c) => !["content_tokens", "hashtags", "mentions"].includes(c));
    $("#c-csv").addEventListener("click", () => save(csv(results.posts, all), `${slug(cfg.name)}-corpus.csv`, "text/csv"));
    $("#c-xlsx").addEventListener("click", async () => {
      const XLSX = await lib("xlsx");
      save(postsWorkbook(XLSX, { posts: results.posts, config: cfg, filters: runFilters(), platform: S.platform }),
        `${slug(cfg.name)}-corpus.xlsx`, XLSX_TYPE);
    });
  }
}

// --- wiring ------------------------------------------------------------------

function wire() {
  const drop = $("#drop"), input = $("#file-input");
  input.addEventListener("change", () => onFiles(input.files));
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("over")));
  drop.addEventListener("drop", (e) => { e.preventDefault(); onFiles(e.dataTransfer.files); });
  // A file dropped anywhere else on the page would otherwise open in the tab.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); if (!$("#intake").hidden) onFiles(e.dataTransfer.files); });

  $("#reset").addEventListener("click", () => {
    Object.assign(S, { files: [], full: null, mapping: {} });
    memo = { key: null }; accMemo = { key: null };
    input.value = "";
    $("#intake").hidden = false; $("#loaded").hidden = true; $("#work").hidden = true;
    $("#files").innerHTML = ""; $("#mapping").innerHTML = "";
  });

  $("#langs").addEventListener("change", (e) => {
    if (!e.target.matches("input")) return;
    e.target.checked ? S.langs.add(e.target.value) : S.langs.delete(e.target.value);
    render();
  });
  $$("[data-langs]").forEach((b) => b.addEventListener("click", () => {
    const present = S.present.map((r) => r.language);
    const own = studyLanguages(S.config).filter((l) => present.includes(l));
    S.langs = new Set(b.dataset.langs === "all" || !own.length ? present : own);
    renderSettings(); render();
  }));
  for (const id of ["since", "until"]) {
    $(`#${id}`).addEventListener("change", (e) => {
      const v = e.target.value;
      S[id] = !v ? (id === "since" ? S.lo : S.hi) : v;
      if (S.since && S.until && S.since > S.until) { if (id === "since") S.until = S.since; else S.since = S.until; }
      renderSettings(); render();
    });
  }
  $("#study").addEventListener("change", (e) => selectStudy(e.target.value));
  $("#study-upload").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const { load } = await lib("yaml");
      S.config = normalizeConfig(load(await file.text()), "__upload");
      applyStudyDefaults(); render();
    } catch (err) {
      $("#warnings").innerHTML = `<div class="warn">The study file could not be read: ${esc(err.message)}</div>`;
    }
  });
  $$(".views button").forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.view; render(); }));
}

loadData().then(wire).catch((e) => {
  $("#intake").insertAdjacentHTML("beforeend", `<div class="warn">The reference data did not load (${esc(e.message)}).
    The page has to be served over http, not opened as a file.</div>`);
});
