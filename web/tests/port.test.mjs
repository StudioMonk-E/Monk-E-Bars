// Tests for the browser port. Synthetic records only, so nothing here is
// anybody's post. Each case is a behaviour the Python package also holds, and
// most are a bug that the port once had or the package once had.
//
//   cd web && npm test

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as XLSX from "xlsx";

import { parseNdjson, detect, parseRecords, parseTable, toInt } from "../js/ingest.js";
import { setContractions, normalize, contentTokens, buildStopwords } from "../js/text.js";
import { buildCorpus, filterDates, filterLanguages, retier } from "../js/corpus.js";
import { addTokens, keyness, themeCounts, analyze } from "../js/lexical.js";
import { pyRound, mostCommon } from "../js/util.js";
import * as A from "../js/accounts.js";
import { generate, setLanguageNames } from "../js/findings.js";
import { accountsWorkbook } from "../js/export.js";

const data = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const SW = data("stopwords.json");
setContractions(data("contractions.json"));
A.setAccountTypes(data("account_types.json"));
setLanguageNames(data("languages.json"));

const ig = (id, caption, likes, extra = {}) => ({
  source_platform: "instagram.com",
  data: { id, code: "c" + id, media_type: 1, caption: { text: caption }, like_count: likes,
    comment_count: 0, taken_at: 1_700_000_000,
    user: { username: "u" + id, full_name: "User", is_verified: false }, ...extra },
});
const igPosts = (recs) => parseRecords(recs, "instagram");
const corpus = (recs, tierLabels = ["High", "Low"]) =>
  buildCorpus(igPosts(recs), { detect: () => "en", tierLabels }).posts;
const cfg = (extra = {}) => ({ name: "t", language: null, tier_labels: ["High", "Low"], ...extra });

// --- text ------------------------------------------------------------------

test("hashtags and mentions come out whole in any script", () => {
  const [p] = igPosts([ig("1", "Best #açaíbowl by @avec.naomi.", 1)]);
  assert.deepEqual(p.hashtags, ["#açaíbowl"]);
  assert.deepEqual(p.mentions, ["@avec.naomi"]);      // no trailing dot
  assert.deepEqual(normalize("bowl by @avec.naomi in brighton"), ["bowl", "by", "in", "brighton"]);
});

test("contractions never reach inside a word", () => {
  // The library once read the final "u" of cupuaçu as text-speak for "you".
  assert.deepEqual(normalize("cupuaçu and I'm here"), ["cupuaçu", "and", "i", "am", "here"]);
});

test("a styled letter counts as one character", () => {
  // "𝐴" is two UTF-16 units and one code point; Python drops it as too short.
  assert.deepEqual(contentTokens("𝐴 bowl", new Set()), ["bowl"]);
});

test("stopwords follow the languages given, with English as the fallback", () => {
  assert.ok(buildStopwords(SW, [], ["nl"]).has("het"));
  assert.ok(!buildStopwords(SW, [], ["nl"]).has("the"));
  assert.ok(buildStopwords(SW, [], []).has("the"));
  assert.ok(buildStopwords(SW, ["Yummy"], ["en"]).has("yummy"));
});

// --- numbers ---------------------------------------------------------------

test("rounding matches Python, half to even on the exact binary value", () => {
  assert.equal(pyRound(0.125, 2), 0.12);
  assert.equal(pyRound(0.375, 2), 0.38);
  assert.equal(pyRound(2.675, 2), 2.67);   // stored just under 2.675
  assert.equal(pyRound(2.5, 0), 2);
});

test("equal counts keep first-seen order, as Counter.most_common does", () => {
  assert.deepEqual(mostCommon(["b", "a", "a", "c", "b", "d"], 3), [["b", 2], ["a", 2], ["c", 1]]);
});

// --- ingest ----------------------------------------------------------------

test("the platform is read from the capture's own stamp", () => {
  assert.equal(detect([{ source_platform: "tiktok.com" }]).platform, "tiktok");
  assert.equal(detect([{ foo: 1 }]).kind, "unknown");
  assert.equal(parseNdjson('{"a":1}\n\n{"b":2}\n{"trunc').length, 2);
});

test("TikTok carries followers and views, Instagram carries neither", () => {
  const [t] = parseRecords([{ data: { id: "9", desc: "yum #acai", createTime: 1_700_000_000,
    author: { uniqueId: "chef", verified: true }, authorStats: { followerCount: 1200 },
    stats: { diggCount: 50, commentCount: 5, playCount: 900 } } }], "tiktok");
  assert.equal(t.follower_count, 1200);
  assert.equal(t.engagement_score, 55);
  assert.equal(t.view_count, 900);
  assert.equal(igPosts([ig("1", "x", 1)])[0].follower_count, 0);
});

test("spreadsheets map columns by name and read abbreviated counts", () => {
  const posts = parseTable([{ Caption: "hello #tag", Likes: "2.1K", "likes_per_view": 9, Comments: "1,204" }]);
  assert.equal(posts[0].like_count, 2100);
  assert.equal(posts[0].comment_count, 1204);
  assert.equal(toInt("3M"), 3_000_000);
  assert.throws(() => parseTable([{ likes: 1 }]), /No caption column/);
});

// --- corpus ----------------------------------------------------------------

test("duplicates go, and tied posts keep their input order", () => {
  const { posts, duplicatesRemoved } = buildCorpus(igPosts([
    ig("1", "a", 5), ig("1", "dup", 5), ig("2", "b", 5), ig("3", "c", 9),
  ]), { detect: () => "en", tierLabels: ["High", "Low"] });
  assert.equal(duplicatesRemoved, 1);
  assert.deepEqual(posts.map((p) => p.post_id), ["3", "1", "2"]);
});

test("an until date includes the whole of that day", () => {
  const posts = [{ timestamp: "2026-03-10T23:30:00.000Z" }, { timestamp: "2026-03-11T00:00:00.000Z" }];
  assert.equal(filterDates(posts, null, "2026-03-10").length, 1);
  assert.equal(filterDates(posts, "2026-03-11", null).length, 1);
});

test("a language filter and a retier leave the rest untouched", () => {
  const posts = [{ language: "nl", engagement_score: 1 }, { language: "en", engagement_score: 2 }];
  const kept = retier(filterLanguages(posts, ["NL"]), ["High"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].engagement_rank, 1);
  assert.equal(posts.length, 2);
});

// --- lexical ---------------------------------------------------------------

test("keyness surfaces what is distinctive, not what is shared", () => {
  const posts = addTokens(corpus([
    ig("1", "bowl bowl bowl vibrant vibrant vibrant vibrant", 100),
    ig("2", "bowl bowl bowl detox detox detox detox", 1),
  ]), cfg(), SW);
  const hi = keyness(posts, "High", "Low", 25, 1).map((r) => r.word);
  assert.ok(hi.includes("vibrant") && !hi.includes("bowl"));
  assert.ok(keyness(posts, "Low", "High", 25, 1).map((r) => r.word).includes("detox"));
});

test("theme order is the order the study wrote", () => {
  const c = cfg({ themes: { Zebra: ["amazon"], Apple: ["healthy"] } });
  const posts = addTokens(corpus([ig("1", "amazon amazon", 9), ig("2", "healthy", 1)]), c, SW);
  const rows = themeCounts(posts, c);
  assert.deepEqual(rows.map((r) => [r.theme, r.total]), [["Zebra", 2], ["Apple", 1]]);
});

test("findings run with no framework and with a tier that over-uses nothing", () => {
  const posts = addTokens(corpus([ig("1", "keto keto keto keto bowl", 100), ig("2", "bowl fruit", 1)]), cfg(), SW);
  const out = generate(posts, cfg(), { rawCount: 4 });
  assert.match(out[0].text, /^2 of 4 captured posts/);
  assert.ok(out.some((f) => f.kind === "keyness"));
  assert.ok(!out.some((f) => f.kind === "theme"));
});

test("the full suite runs on an empty-ish corpus without throwing", () => {
  const r = analyze(corpus([ig("1", "one", 1)]), cfg(), SW);
  assert.equal(r.topWords[0].word, "one");
});

// --- accounts --------------------------------------------------------------

const acctCfg = () => cfg({
  account_types: {
    "Wedding business": { handle_words: ["fotograf"], hashtags: ["trouwfotograaf", "bruiloft"], min_hashtag_hits: 2 },
    "Engaged couple": "default",
  },
  include_types: ["Engaged couple"],
  signals: { Dutch: { caption_words: ["verloofd", "trouwen"], min_caption_words: 2, exclude_words: [" ek "] } },
  min_signals: { Dutch: 1 },
  min_engagement: 100,
  audiences: { Couples: { types: ["Engaged couple"], min_engagement: 100 } },
});
const post = (id, handle, caption, likes, tags = "") => {
  const r = ig(id, caption + (tags ? " " + tags : ""), likes);
  r.data.user.username = handle;
  return r;
};

test("accounts rank by best post and classify first match wins", () => {
  const c = acctCfg();
  const posts = corpus([
    post("1", "anna", "we zijn verloofd en gaan trouwen", 500),
    post("2", "stancefotografie", "verloofd en trouwen", 900),
    post("3", "anna", "nog een post", 50),
    post("4", "plainvendor", "shoot", 20, "#trouwfotograaf #bruiloft"),
    post("5", "plainvendor", "shoot", 10, "#trouwfotograaf #bruiloft"),
  ]);
  const acc = A.buildAccounts(posts, c);
  assert.deepEqual(acc.map((a) => a.username), ["stancefotografie", "anna", "plainvendor"]);
  const by = Object.fromEntries(acc.map((a) => [a.username, a]));
  assert.equal(by.stancefotografie.account_type, "Wedding business");
  assert.equal(by.stancefotografie.type_reason, "name contains 'fotograf'");
  assert.equal(by.anna.account_type, "Engaged couple");
  assert.equal(by.anna.posts, 2);
  assert.equal(by.anna.best_engagement, 500);
  assert.equal(by.plainvendor.type_reason, "100% of posts carry its hashtags");

  const passed = A.passing(acc, A.configFilters(c));
  assert.deepEqual(passed.map((a) => a.username), ["anna"]);
  const all = A.applyFilters(acc, A.configFilters(c));
  assert.match(all.find((a) => a.username === "stancefotografie").excluded_because, /type is Wedding business/);
  assert.equal(A.describeAudience(c, "Couples"), "engaged couple, at least 100 engagement, Dutch score 1 or more");
});

test("an exclusion word vetoes a lookalike language", () => {
  const scored = A.scoreSignals([{ caption_text: "ek is verloofd en gaan trouwen ", hashtag_list: [] },
    { caption_text: "toe ek is verloofd en gaan trouwen", hashtag_list: [] }], acctCfg());
  assert.deepEqual(scored.map((p) => p.signal_dutch), [1, 0]);
});

test("a missing follower count never excludes an account", () => {
  const rows = [{ account_type: "x", best_engagement: 5, followers: 0 }, { account_type: "x", best_engagement: 5, followers: 10 }];
  const out = A.applyFilters(rows, { min_followers: 100 });
  assert.deepEqual(out.map((r) => r.excluded_because), ["", "under 100 followers"]);
});

test("the workbook has its three sheets, blanks to fill in, and the caveats", () => {
  const c = acctCfg();
  const acc = A.applyFilters(A.buildAccounts(corpus([
    post("1", "anna", "verloofd trouwen", 500), post("2", "fotografx", "x", 5)]), c), A.configFilters(c));
  const buf = accountsWorkbook(XLSX, { passed: acc.filter((a) => !a.excluded_because), all: acc,
    config: c, filters: A.configFilters(c), corpusRows: 2, rawRows: 2 });
  const wb = XLSX.read(buf, { type: "array" });
  assert.deepEqual(wb.SheetNames, ["Accounts", "Left out", "About this run"]);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.Accounts);
  assert.equal(rows[0].username, "anna");
  assert.equal(rows[0].profile_url, "https://www.instagram.com/anna/");
  const header = XLSX.utils.sheet_to_json(wb.Sheets.Accounts, { header: 1 })[0];
  assert.deepEqual(header.slice(0, 2), ["username", "profile_url"]);
  assert.deepEqual(header.slice(-2), ["Checked", "Notes"]);
  const about = XLSX.utils.sheet_to_json(wb.Sheets["About this run"], { header: 1 });
  assert.ok(about.some((r) => r[0] === "Caveat" && /real people/.test(r[1])));
});
