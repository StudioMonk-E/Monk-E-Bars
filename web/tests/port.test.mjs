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
import { buildCorpus, filterDates, filterLanguages, filterViews, retier } from "../js/corpus.js";
import { addTokens, keyness, themeCounts, analyze } from "../js/lexical.js";
import { pyRound, mostCommon } from "../js/util.js";
import * as A from "../js/accounts.js";
import { generate, setLanguageNames } from "../js/findings.js";
import { accountsWorkbook, prepareAccounts } from "../js/export.js";
import { discoverThemes } from "../js/topics.js";
import * as H from "../js/hooks.js";
import * as C from "../js/charts.js";
import * as MO from "../js/months.js";
import { readFollowers, looksLikeExport, buildAccountData } from "../js/account.js";
import * as G from "../js/gains.js";

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

test("a view floor drops thin posts but never one with no view count", () => {
  const posts = [
    { post_id: "a", view_count: 50_000, engagement_score: 100 },
    { post_id: "b", view_count: 633, engagement_score: 80 },   // the loud percentage
    { post_id: "c", view_count: 0, engagement_score: 90 },      // Instagram: no views given
    { post_id: "d", engagement_score: 70 },                     // no column at all
    { post_id: "e", view_count: 2000, engagement_score: 10 },   // exactly on the floor
  ];
  const kept = filterViews(posts, 2000).map((p) => p.post_id);
  assert.deepEqual(kept, ["a", "c", "d", "e"]);
  // A floor of zero is no floor, and the array comes back whole.
  assert.equal(filterViews(posts, 0).length, 5);
});

test("a view floor changes which posts a weight class is cut from", () => {
  const posts = [
    { post_id: "a", view_count: 50_000, engagement_score: 100 },
    { post_id: "b", view_count: 633, engagement_score: 500 },
  ];
  // Unfiltered, the thin post takes the top class on 633 views.
  assert.equal(retier(posts, ["High", "Low"])[0].post_id, "b");
  assert.equal(retier(filterViews(posts, 2000), ["High", "Low"])[0].post_id, "a");
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

test("muscle groups come out of the vocabulary, same every run", () => {
  // Two subjects, no overlap: the model should separate them.
  // A word common to most posts is dropped as describing the whole corpus, so
  // each subject's vocabulary rotates, as real captions do.
  const A = ["amazon", "rainforest", "brazil", "harvest", "palm", "forest"];
  const B = ["protein", "smoothie", "breakfast", "recipe", "blender", "oats"];
  const recs = [];
  for (let i = 0; i < 18; i++) recs.push(ig(`a${i}`, `${A[i % 6]} ${A[(i + 1) % 6]} ${A[(i + 3) % 6]}`, 50 + i));
  for (let i = 0; i < 18; i++) recs.push(ig(`b${i}`, `${B[i % 6]} ${B[(i + 1) % 6]} ${B[(i + 3) % 6]}`, 10 + i));
  const posts = addTokens(corpus(recs), cfg(), SW);
  const first = discoverThemes(posts, { nTopics: 2, nWords: 5 });
  assert.equal(Object.keys(first.themes).length, 2);
  const joined = Object.values(first.themes).map((w) => w.join(" "));
  assert.ok(joined.some((w) => w.includes("amazon")) && joined.some((w) => w.includes("blender")));
  // No group mixes the two subjects.
  for (const words of Object.values(first.themes)) {
    const fromA = words.filter((w) => A.includes(w)).length;
    assert.ok(fromA === 0 || fromA === words.length, `mixed group: ${words.join(" ")}`);
  }
  // Seeded, so a second run on the same corpus returns the same groups.
  assert.deepEqual(discoverThemes(posts, { nTopics: 2, nWords: 5 }).themes, first.themes);
  assert.deepEqual(discoverThemes([], { nTopics: 2 }), { themes: {}, table: [] });
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

const hookPost = (id, caption, likes, platform = "tiktok") => ({
  post_id: id, platform, caption_text: caption, engagement_score: likes,
});

test("a hook keeps the small words a vocabulary measure would drop", () => {
  // "stuur dit naar" is three stopwords and it is the whole hook.
  assert.deepEqual(H.hookTokens("Stuur dit naar je beste vriend, nu!", 6),
    ["stuur", "dit", "naar", "je", "beste", "vriend"]);
  // Hashtags, mentions and digits go, as everywhere else in the tool.
  assert.deepEqual(H.hookTokens("#ad @tony 10 nieuwe reep", 6), ["nieuwe", "reep"]);
});

test("halves cut by rank inside each platform, and the middle post goes down", () => {
  const posts = [
    hookPost("a", "x", 100), hookPost("b", "x", 90), hookPost("c", "x", 80),
    hookPost("i1", "x", 5, "instagram"), hookPost("i2", "x", 4, "instagram"),
  ];
  const { above, below, cuts } = H.halves(posts);
  // TikTok: 3 posts, so one above and two below. Instagram: one each.
  assert.deepEqual(above.map((p) => p.post_id).sort(), ["a", "i1"]);
  assert.deepEqual(below.map((p) => p.post_id).sort(), ["b", "c", "i2"]);
  // Each platform reports its own cut: likes on one are not likes on the other.
  assert.deepEqual(cuts.map((c) => [c.platform, c.cut]), [["tiktok", 100], ["instagram", 5]]);
});

test("ties do not empty a half, which a median-value cut would", () => {
  const posts = Array.from({ length: 8 }, (_, i) => hookPost(String(i), "x", 50));
  const { above, below } = H.halves(posts);
  assert.equal(above.length, 4);
  assert.equal(below.length, 4);
});

test("an opening needs enough posts behind it before it is reported", () => {
  const posts = [
    hookPost("a", "stuur dit naar je vriend", 500),
    hookPost("b", "stuur dit naar je moeder", 400),
    hookPost("c", "stuur dit naar je zus", 300),
    hookPost("d", "shop nu online vandaag", 10),
    hookPost("e", "shop nu online morgen", 9),      // only two: below the floor
    hookPost("f", "iets heel anders hier", 8),
    hookPost("g", "nog iets anders hier", 7),
  ];
  const rows = H.openers(posts, { size: 3, minPosts: 3 });
  assert.deepEqual(rows.map((r) => r.phrase), ["stuur dit naar"]);
  const row = rows[0];
  assert.equal(row.posts, 3);
  // Seven posts halve into three above and four below, and all three of these
  // are the strongest, so the opening lands in the better half every time.
  assert.equal(row.in_better_half, 3);
  assert.equal(row.share, 1);
  assert.equal(row.median_engagement, 400);
});

test("a caption too short to have an opening is left out, not counted as blank", () => {
  const posts = [hookPost("a", "hoi", 10), hookPost("b", "hoi", 9), hookPost("c", "hoi", 8)];
  assert.deepEqual(H.openers(posts, { size: 3, minPosts: 1 }), []);
  assert.deepEqual(H.commonOpenings(posts, { size: 3 }), []);
});

test("hook keyness reads openings only, not the rest of the caption", () => {
  const above = [
    hookPost("a", "raad de smaak van deze chocolade reep karamel zeezout", 100),
    hookPost("b", "raad de smaak van onze nieuwe chocolade reep karamel", 90),
    hookPost("c", "raad de smaak hiervan chocolade reep karamel zeezout", 80),
  ];
  const below = [
    hookPost("d", "shop nu meteen deze chocolade reep karamel zeezout", 10),
    hookPost("e", "shop nu meteen onze chocolade reep karamel zeezout", 9),
    hookPost("f", "shop nu meteen hiervan chocolade reep karamel zeezout", 8),
  ];
  const words = H.hookKeyness(above, below, { minFreq: 3 }).map((r) => r.word);
  assert.ok(words.includes("raad"));
  // "chocolade" and "karamel" are in every caption but outside the opening,
  // so they cannot distinguish the halves.
  assert.ok(!words.includes("chocolade"));
  assert.ok(!words.includes("karamel"));
});

const atPost = (id, iso, score, extra = {}) => ({
  post_id: id, platform: "tiktok", caption_text: "x", engagement_score: score,
  timestamp: iso, engagement_tier: "Heavyweight", ...extra,
});

test("a chart says so rather than drawing a lie when there is too little data", () => {
  assert.match(C.timeline([atPost("a", "2026-09-01T00:00:00Z", 10)]), /Too few dated posts/);
  assert.match(C.rankedCurve([]), /Too few posts/);
  assert.match(C.viewsScatter([]), /view count/);
  // Posts with no timestamp at all are not dated posts.
  const undated = Array.from({ length: 9 }, (_, i) => ({ post_id: String(i), engagement_score: 1 }));
  assert.match(C.timeline(undated), /Too few dated posts/);
});

test("the time bucket follows the span, and a long range refuses to draw", () => {
  const span = (days) => Array.from({ length: 12 }, (_, i) => atPost(String(i),
    new Date(Date.UTC(2026, 0, 1) + (i / 11) * days * 86400000).toISOString(), 10 + i));
  assert.match(C.timeline(span(10)), /by day/);
  assert.match(C.timeline(span(100)), /by week/);
  assert.match(C.timeline(span(900)), /by month/);
  // Daily buckets over five years would be thousands of columns.
  const sparse = [atPost("a", "2000-01-01T00:00:00Z", 1), atPost("b", "2000-01-02T00:00:00Z", 1),
                  atPost("c", "2000-01-03T00:00:00Z", 1), atPost("d", "2026-01-01T00:00:00Z", 1)];
  assert.match(C.timeline(sparse), /too long to draw/);
});

test("the view floor is only drawn where it falls inside the axis", () => {
  const pts = Array.from({ length: 10 }, (_, i) => atPost(String(i), "2026-09-01T00:00:00Z",
    100 * (i + 1), { view_count: 10_000 * (i + 1) }));
  // Inside the plotted range: drawn, and named.
  assert.match(C.viewsScatter(pts, { floor: 50_000 }), /floor: 50,000 views/);
  // Below everything plotted: a line hard against the axis would say nothing.
  assert.ok(!/floor:/.test(C.viewsScatter(pts, { floor: 5 })));
  assert.ok(!/floor:/.test(C.viewsScatter(pts, { floor: 0 })));
});

test("a chart escapes what it prints, since handles come from a capture", () => {
  const pts = Array.from({ length: 8 }, (_, i) => atPost(String(i), "2026-09-01T00:00:00Z", 100,
    { view_count: 1000 * (i + 1), author_handle: '<script>alert(1)</script>' }));
  const svg = C.viewsScatter(pts);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;"));
});

const mPost = (iso, views, extra = {}) => ({
  post_id: iso + views + JSON.stringify(extra), platform: "table", caption_text: "x",
  timestamp: iso, view_count: views, engagement_score: Math.round(views / 20), tags: {}, ...extra,
});
const monthOf = (m, views, extra) => views.map((v, i) =>
  mPost(`2026-${String(m).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}T12:00:00Z`, v, extra));

test("a count is read in either convention, including the Dutch one", () => {
  // The reverse of the English convention, and an export made on a Dutch
  // machine writes it. Read the English way, 1.204 became 1, silently.
  assert.equal(toInt("1.204"), 1204);          // NL thousands
  assert.equal(toInt("1.234.567"), 1234567);
  assert.equal(toInt("1,204"), 1204);          // en thousands
  assert.equal(toInt("1,234,567"), 1234567);
  // A K or M suffix makes the single separator a decimal point in both.
  assert.equal(toInt("1,2K"), 1200);
  assert.equal(toInt("1.2K"), 1200);
  assert.equal(toInt("2,5M"), 2_500_000);
  // Both separators present: the last one is the decimal point.
  assert.equal(toInt("1.234,56"), 1234);
  assert.equal(toInt("1,234.56"), 1234);
  // One separator with fewer than three digits after it is a decimal point.
  assert.equal(toInt("0,75"), 0);
  assert.equal(toInt("12,50"), 12);
  assert.equal(toInt("1.5"), 1);
  // Digits grouped by spaces, including the non-breaking kinds.
  assert.equal(toInt("1 204"), 1204);
  assert.equal(toInt("1\u00a0204"), 1204);
  // Unchanged behaviour at the edges.
  assert.equal(toInt(""), 0);
  assert.equal(toInt("n/a"), 0);
  assert.equal(toInt(1204), 1204);
  assert.equal(toInt(-42), -42);
});

test("a spreadsheet keeps the columns the mapping did not claim", () => {
  const rows = [{ caption: "hoi", views: "1,204", date: "2026-09-01", formaat: " video met mensen ", geboost: "nee", leeg: "" }];
  const [post] = parseTable(rows, "sheet");
  assert.equal(post.caption_text, "hoi");
  // A comma is read as a thousands separator, which is how exports write it.
  assert.equal(post.view_count, 1204);
  // Trimmed, and a blank cell is absent rather than an empty-string tag.
  assert.deepEqual(post.tags, { formaat: "video met mensen", geboost: "nee" });
});

test("a capture carries an empty tag set, so every post has the field", () => {
  const [post] = parseRecords([ig("1", "hoi", 5)], "instagram");
  assert.deepEqual(post.tags, {});
});

test("the median is the median, not the mean a single hit would drag", () => {
  assert.equal(MO.median([1, 2, 3]), 2);
  assert.equal(MO.median([1, 2, 3, 4]), 3);         // Python-style half-up on the pair
  assert.equal(MO.median([10, 10, 10, 1_000_000]), 10);
  assert.equal(MO.median([]), 0);
});

test("a month reports its baseline and its hit dependence apart", () => {
  // One month carried by a hit, one month of the same total spread evenly.
  const carried = monthOf(2, [100, 100, 100, 100, 9_600]);
  const even = monthOf(3, [2_000, 2_000, 2_000, 2_000, 2_000]);
  const { rows } = MO.byMonth([...carried, ...even]);
  assert.deepEqual(rows.map((r) => r.month), ["2026-02", "2026-03"]);
  // Identical totals, and the two readings separate them.
  assert.equal(rows[0].total, rows[1].total);
  assert.equal(rows[0].median, 100);
  assert.equal(rows[1].median, 2_000);
  assert.equal(rows[0].top3_share, 98);
  assert.equal(rows[1].top3_share, 60);
});

test("undated posts are counted out loud, not quietly dropped from a trend", () => {
  const posts = [...monthOf(2, [100, 200]), { post_id: "x", caption_text: "x", view_count: 50, engagement_score: 2, tags: {} }];
  const { rows, undated } = MO.byMonth(posts);
  assert.equal(undated, 1);
  assert.equal(rows.reduce((s, r) => s + r.posts, 0), 2);
});

test("a month that scored nothing has no share, which is not zero percent", () => {
  const { rows } = MO.byMonth(monthOf(4, [0, 0, 0, 0]));
  assert.equal(rows[0].total, 0);
  assert.equal(rows[0].top3_share, null);
});

test("a thin month is flagged, since three posts have no meaningful top three", () => {
  const { rows } = MO.byMonth([...monthOf(2, [1, 2, 3]), ...monthOf(3, [1, 2, 3, 4])]);
  assert.equal(rows[0].thin, true);
  assert.equal(rows[1].thin, false);
});

test("a trend needs four usable months and compares thirds, not end months", () => {
  const flat = [2, 3, 4, 5].flatMap((m) => monthOf(m, [1000, 1000, 1000, 1000]));
  assert.equal(MO.readTrend(MO.byMonth(flat.slice(0, 8)).rows), null);   // two months
  const steady = MO.readTrend(MO.byMonth(flat).rows);
  assert.equal(steady.medianChange, 0);
  assert.match(steady.reading, /Neither/);

  // A baseline that halves across six months, hits held constant.
  const falling = [2, 3, 4, 5, 6, 7].flatMap((m, i) =>
    monthOf(m, Array.from({ length: 5 }, () => 10_000 - i * 1_000)));
  const t = MO.readTrend(MO.byMonth(falling).rows);
  assert.ok(t.medianChange <= -10);
  assert.match(t.reading, /baseline has fallen/);
});

test("dimensions come from the tags, and an untagged post is named so", () => {
  const posts = [
    ...monthOf(2, [100], { tags: { formaat: "foto" }, media_type: "photo" }),
    ...monthOf(2, [200], { tags: {}, media_type: "video" }),
  ];
  assert.deepEqual(MO.dimensions(posts), ["media type", "formaat"]);
  assert.equal(MO.valueOf(posts[0], "formaat"), "foto");
  assert.equal(MO.valueOf(posts[1], "formaat"), MO.UNTAGGED);
  assert.equal(MO.valueOf(posts[1], "media type"), "video");
  assert.deepEqual(MO.valuesOf(posts, "formaat").map((v) => v.value).sort(), ["foto", MO.UNTAGGED]);
});

test("the mix carries the count behind every median", () => {
  const posts = [
    ...monthOf(2, [1000, 2000, 3000], { tags: { f: "video" } }),
    ...monthOf(2, [100], { tags: { f: "foto" } }),
  ];
  const mix = MO.mixByMonth(posts, "f");
  assert.deepEqual(mix.values, ["video", "foto"]);
  assert.equal(mix.rows[0].counts.video, 3);
  assert.equal(mix.rows[0].counts.foto, 1);
  assert.equal(mix.rows[0].medians.video, 2000);
  assert.equal(mix.rows[0].medians.foto, 100);
});

test("a sheet can name its own platform, and two of them stay apart", () => {
  const rows = [
    { caption: "a", platform: "Instagram", views: 10 },
    { caption: "b", platform: "tiktok", views: 20 },
    { caption: "c", views: 30 },
  ];
  const posts = parseTable(rows, "sheet");
  assert.deepEqual(posts.map((p) => p.platform), ["instagram", "tiktok", "table"]);
  assert.deepEqual(MO.platformsIn(posts), ["instagram", "table", "tiktok"]);
  // Offered for grouping only when a session actually holds more than one.
  assert.ok(MO.dimensions(posts).includes("platform"));
  assert.ok(!MO.dimensions(parseTable([rows[0]], "s")).includes("platform"));
});

test("account is a dimension once a session holds more than one", () => {
  const one = monthOf(2, [1, 2], { author_handle: "tonys" });
  const two = monthOf(2, [3, 4], { author_handle: "benjerry" });
  assert.ok(!MO.dimensions(one).includes("account"));
  assert.ok(MO.dimensions([...one, ...two]).includes("account"));
  assert.equal(MO.valueOf(one[0], "account"), "tonys");
});

test("an account's thin month carries no point, rather than a fall nobody had", () => {
  const posts = [
    ...monthOf(2, [100, 100, 100], { author_handle: "a" }),
    ...monthOf(3, [50], { author_handle: "a" }),            // one post: not a median
    ...monthOf(4, [50, 50, 50], { author_handle: "a" }),
    ...monthOf(2, [200, 200, 200], { author_handle: "b" }),
    ...monthOf(4, [200, 200, 200], { author_handle: "b" }),
  ];
  const { months, series } = MO.byAccountMonth(posts, "views", { minPosts: 3 });
  assert.deepEqual(months, ["2026-02", "2026-03", "2026-04"]);
  const a = series.find((x) => x.handle === "a");
  assert.equal(a.points[1], null);                 // March is skipped, not zero
  assert.equal(a.points[0].index, 100);            // indexed to its own first month
  assert.equal(a.points[2].index, 50);
  assert.equal(a.change, -50);
  // b held flat and is unaffected by a's gap.
  assert.equal(series.find((x) => x.handle === "b").change, 0);
});

test("an account with only one usable month is left out of the comparison", () => {
  const posts = [
    ...monthOf(2, [10, 10, 10], { author_handle: "solo" }),
    ...monthOf(2, [10, 10, 10], { author_handle: "pair" }),
    ...monthOf(3, [10, 10, 10], { author_handle: "pair" }),
  ];
  assert.deepEqual(MO.byAccountMonth(posts).series.map((x) => x.handle), ["pair"]);
});

test("the benchmark reads our change against the median of the others", () => {
  const mk = (handle, from, to) => [
    ...monthOf(2, [from, from, from], { author_handle: handle }),
    ...monthOf(6, [to, to, to], { author_handle: handle }),
  ];
  // Everyone down about the same: the platform, not us.
  let s = MO.byAccountMonth([...mk("us", 100, 50), ...mk("a", 100, 50), ...mk("b", 100, 55)]).series;
  let b = MO.benchmark(s, "us");
  assert.equal(b.mine, -50);
  assert.ok(b.theirs <= -40);
  assert.match(b.reading, /platform rather than at the content/);

  // Only we fell: ours.
  s = MO.byAccountMonth([...mk("us", 100, 50), ...mk("a", 100, 100), ...mk("b", 100, 102)]).series;
  b = MO.benchmark(s, "us");
  assert.match(b.reading, /fell while the others held/);

  // A single other account is not a benchmark.
  s = MO.byAccountMonth([...mk("us", 100, 50), ...mk("a", 100, 100)]).series;
  assert.equal(MO.benchmark(s, "us"), null);
});

test("the default periods are the thirds the reading already describes", () => {
  const rows = MO.byMonth([2, 3, 4, 5, 6, 7].flatMap((m) => monthOf(m, [1, 2, 3, 4, 5]))).rows;
  assert.deepEqual(MO.defaultPeriods(rows),
    { aFrom: "2026-02", aTo: "2026-03", bFrom: "2026-06", bTo: "2026-07" });
  // Under two months there is nothing to set against anything.
  assert.equal(MO.defaultPeriods(MO.byMonth(monthOf(2, [1, 2, 3, 4])).rows), null);
});

test("a period takes both its end months, and tolerates a reversed pair", () => {
  const posts = [2, 3, 4].flatMap((m) => monthOf(m, [100, 200]));
  assert.equal(MO.inPeriod(posts, "2026-02", "2026-03").length, 4);
  assert.equal(MO.inPeriod(posts, "2026-02", "2026-02").length, 2);
  // Picking the later month first should not silently return nothing.
  assert.equal(MO.inPeriod(posts, "2026-04", "2026-02").length, 6);
  assert.equal(MO.inPeriod(posts, "", "2026-04").length, 0);
});

test("a period is measured on the same definitions a month is", () => {
  const carried = monthOf(2, [100, 100, 100, 100, 9_600]);
  const stats = MO.periodStats(carried);
  const month = MO.byMonth(carried).rows[0];
  assert.equal(stats.median, month.median);
  assert.equal(stats.top3_share, month.top3_share);
  assert.equal(stats.total, month.total);
});

test("a mix shift is read in points of share, not in counts", () => {
  // The later period is twice the size; only the share should move.
  const a = monthOf(2, [1, 2], { tags: { f: "video" } }).concat(monthOf(2, [3], { tags: { f: "foto" } }));
  const b = monthOf(9, [1, 2], { tags: { f: "video" } }).concat(monthOf(9, [3, 4, 5, 6], { tags: { f: "foto" } }));
  const shift = MO.mixShift(a, b, "f");
  const foto = shift.find((r) => r.value === "foto");
  assert.equal(foto.a_pct, 33);
  assert.equal(foto.b_pct, 67);
  assert.equal(foto.change, 34);
  // Biggest mover first, whichever direction it moved.
  assert.equal(Math.abs(shift[0].change) >= Math.abs(shift[1].change), true);
});

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

test("a type set by hand beats the keyword match", () => {
  const c = { ...acctCfg(), account_overrides: { stancefotografie: "Engaged couple" } };
  const [row] = A.buildAccounts(corpus([post("2", "stancefotografie", "verloofd", 900)]), c);
  assert.deepEqual([row.account_type, row.type_reason], ["Engaged couple", "set by hand"]);
});

test("an exclusion word vetoes a lookalike language", () => {
  const scored = A.scoreSignals([{ caption_text: "ek is verloofd en gaan trouwen ", hashtag_list: [] },
    { caption_text: "toe ek is verloofd en gaan trouwen", hashtag_list: [] }], acctCfg());
  assert.deepEqual(scored.map((p) => p.signal_dutch), [1, 0]);
});

test("a missing follower count never excludes an account, from either end", () => {
  const rows = [{ account_type: "x", best_engagement: 5, followers: 0 }, { account_type: "x", best_engagement: 5, followers: 10 }];
  assert.deepEqual(A.applyFilters(rows, { min_followers: 100 }).map((r) => r.excluded_because), ["", "under 100 followers"]);
  assert.deepEqual(A.applyFilters(rows, { max_followers: 5 }).map((r) => r.excluded_because), ["", "at or over 5 followers"]);
});

test("a follower band keeps the middle", () => {
  const rows = [800, 12_000, 900_000, 0].map((followers, i) => ({ username: `a${i}`, account_type: "x", best_engagement: 5, followers }));
  const kept = A.passing(rows, { min_followers: 2_000, max_followers: 100_000 });
  assert.deepEqual(kept.map((r) => r.followers), [12_000, 0]);
  const c = cfg({ audiences: { Micro: { min_followers: 2_000, max_followers: 100_000 } } });
  assert.equal(A.describeAudience(c, "Micro"),
    "at least 2000 followers where known, under 100000 followers where known");
});

test("two platforms merge into one member, linked on its own platform", () => {
  const tt = (id, handle, caption, likes) => ({ source_platform: "tiktok.com", data: { id, desc: caption,
    createTime: 1_700_000_000, author: { uniqueId: handle }, authorStats: { followerCount: 4200 },
    stats: { diggCount: likes, commentCount: 0, playCount: 900 } } });
  const posts = buildCorpus([...igPosts([ig("1", "verloofd", 80)]).map((p) => ({ ...p, author_handle: "anna" })),
    ...parseRecords([tt("9", "anna", "verloofd", 300), tt("8", "bram", "verloofd", 10)], "tiktok")],
    { detect: () => "nl", tierLabels: ["High", "Low"] }).posts;
  const rows = A.buildAccounts(posts, cfg());
  const anna = rows.find((r) => r.username === "anna");
  assert.equal(anna.platforms, "instagram, tiktok");
  assert.equal(anna.posts, 2);
  assert.equal(anna.best_engagement, 300);      // the stronger post, whichever platform
  assert.equal(anna.platform, "tiktok");
  assert.equal(anna.followers, 4200);           // TikTok supplies what Instagram cannot
  const ready = prepareAccounts(rows, "instagram");
  assert.equal(ready.find((r) => r.username === "anna").profile_url, "https://www.tiktok.com/@anna");
  assert.equal(ready.find((r) => r.username === "bram").profile_url, "https://www.tiktok.com/@bram");
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

// --- an account's own export -------------------------------------------------

test("follow timestamps are read from either platform's shape", () => {
  // Instagram nests them; TikTok writes them flat and means UTC.
  const ig = { relationships_followers: [
    { string_list_data: [{ href: "https://instagram.com/a", value: "a", timestamp: 1_767_225_600 }] },
    { string_list_data: [{ href: "https://instagram.com/b", value: "b", timestamp: 1_767_229_200 }] },
  ] };
  const tt = { Activity: { "Follower List": { FansList: [
    { Date: "2026-01-01 00:00:00", UserName: "c" },
    { Date: "2026-01-01 01:00:00", UserName: "@d" },
  ] } } };
  assert.deepEqual(readFollowers(ig).map((f) => f.username), ["a", "b"]);
  assert.equal(readFollowers(ig)[0].ts, 1_767_225_600_000);
  assert.deepEqual(readFollowers(tt).map((f) => f.username), ["c", "d"]);
  assert.equal(readFollowers(tt)[0].ts, Date.UTC(2026, 0, 1));
  assert.ok(looksLikeExport(ig) && looksLikeExport(tt));
  // A capture is not an export, and must not be read as one.
  assert.equal(looksLikeExport([{ source_platform: "instagram.com", data: { id: "1" } }]), false);
});

test("a follower list and a following list are told apart", () => {
  const data = [
    { path: "followers_1.json", data: { relationships_followers: [
      { string_list_data: [{ value: "a", timestamp: 1_767_225_600 }] }] } },
    { path: "following.json", data: { relationships_following: [
      { string_list_data: [{ value: "z", timestamp: 1_767_225_600 }] }] } },
  ];
  assert.deepEqual(buildAccountData(data).follows.map((f) => f.username), ["a"]);
});

test("posts and comments come out as the stimulus behind a spike", () => {
  const data = [{ path: "posts_1.json", data: [
    { creation_timestamp: 1_767_225_600, title: "a caption", media: [{ uri: "p.jpg" }] }] },
    { path: "post_comments_1.json", data: { comments_media_comments: [
      { string_map_data: { Comment: { value: "lovely" }, "Media Owner": { value: "bigaccount" },
        Time: { timestamp: 1_767_229_200 } } }] } }];
  const { events } = buildAccountData(data);
  assert.deepEqual(events.map((e) => e.kind), ["post", "comment"]);
  assert.equal(events[1].label, "comment on @bigaccount");
});

test("a spike is measured against the account's own rate, not a flat number", () => {
  const day = 86400e3, start = Date.UTC(2026, 0, 1);
  const follows = [];
  for (let d = 0; d < 40; d++) {            // two a day, every day
    for (let i = 0; i < 2; i++) follows.push({ ts: start + d * day + i * 3600e3, username: `u${d}_${i}` });
  }
  for (let i = 0; i < 60; i++) follows.push({ ts: start + 30 * day + 14 * 3600e3 + i * 60e3, username: `v${i}` });
  const found = G.spikes(follows);
  assert.equal(found.length, 1);
  assert.equal(new Date(found[0].day).toISOString().slice(0, 10), "2026-01-31");
  assert.ok(found[0].times > 10, `expected a large multiple, got ${found[0].times}`);

  // The same account at a steady rate has no spike at all.
  assert.equal(G.spikes(follows.filter((f) => f.username.startsWith("u"))).length, 0);
});

test("an action carries the follows that came after it, and says when it shares them", () => {
  const start = Date.UTC(2026, 0, 1);
  const follows = [];
  for (let d = 0; d < 20; d++) follows.push({ ts: start + d * 86400e3, username: `u${d}` });
  for (let i = 0; i < 30; i++) follows.push({ ts: start + 10 * 86400e3 + 14 * 3600e3 + i * 60e3, username: `v${i}` });
  const events = [
    { ts: start + 10 * 86400e3 + 13.5 * 3600e3, kind: "comment", label: "comment on @big" },
    { ts: start + 3 * 86400e3 + 12 * 3600e3, kind: "post", label: "a quiet post" },
  ];
  const [top, quiet] = G.stimulus(events, follows, { windowHours: 2 });
  assert.equal(top.label, "comment on @big");
  assert.equal(top.follows, 30);
  assert.ok(top.times > 5);
  assert.equal(top.shared, 0);
  assert.equal(quiet.follows, 0);
});
