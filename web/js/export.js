// Excel export: the account worklist, and the posts behind it.
//
// A port of monke_bars/export.py. Three sheets: "Accounts" (the ones that
// passed, with blank Checked and Notes columns to work in), "Left out" (every
// other account, with its reason) and "About this run" (the settings and the
// caveats, so a file emailed onward still explains itself).
//
// SheetJS arrives as an argument. The same module then runs in the browser,
// where the library comes from a CDN, and under Node in the tests.

export const ACCOUNT_COLUMNS = [
  "username", "profile_url", "platforms", "account_type", "type_reason",
  "followers", "best_engagement", "engagement_rate_pct", "best_post_views",
  "posts", "verified", "paid_partnership",
  "best_post_date", "months_since_best", "best_post_url",
  "total_engagement", "last_post_date", "full_name", "best_caption",
];

export function profileUrl(handle, platform = "instagram") {
  if (!handle) return "";
  return platform === "tiktok" ? `https://www.tiktok.com/@${handle}` : `https://www.instagram.com/${handle}/`;
}

/** Order the columns, add the profile link, append the blanks to fill in. */
export function prepareAccounts(accounts, platform = "instagram") {
  if (!accounts.length) return [];
  const cols = Object.keys(accounts[0]);
  const signals = cols.filter((c) => c.startsWith("signal_")).sort();
  const withUrl = [...cols, "profile_url"];
  const ordered = ACCOUNT_COLUMNS.filter((c) => withUrl.includes(c)).concat(signals);
  for (const c of cols) if (!ordered.includes(c) && c !== "excluded_because") ordered.push(c);
  return accounts.map((a) => {
    const row = {};
    // A merged list holds accounts from two platforms, so each row's own
    // platform decides its link rather than the session's.
    const src = { ...a, profile_url: profileUrl(a.username, a.platform || platform) };
    for (const c of ordered) row[c] = src[c] ?? "";
    // Left empty on purpose: a judgment the tool cannot make belongs in a
    // column someone fills in by hand.
    row.Checked = ""; row.Notes = "";
    return row;
  });
}

const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The run's own settings, as [Setting, Value] rows. */
export function runParameters(config, filters, corpusRows, rawRows, platform = "") {
  const rows = [
    ["Study", config.name || ""],
    ["Exported", stamp(new Date())],
    ["Source", platform],
    ["Records read", rawRows],
    ["Posts in corpus", corpusRows],
    ["Languages kept", (filters.languages || []).join(", ") || "every language"],
    ["Posted from", filters.since || "no lower bound"],
    ["Posted until", filters.until || "no upper bound"],
    ["Account types kept", (filters.types || []).join(", ") || "every type"],
    ["Minimum engagement", filters.min_engagement || 0],
  ];
  if (filters.min_followers) rows.push(["Minimum followers", filters.min_followers]);
  if (filters.verified === true) rows.push(["Verified", "verified accounts only"]);
  if (filters.verified === false) rows.push(["Verified", "unverified accounts only"]);
  for (const [name, t] of Object.entries(filters.min_signals || {})) rows.push([`Minimum ${name} score`, t]);
  rows.push(
    ["", ""],
    ["Ranking", "likes plus comments on the account's strongest single post"],
    ["Caveat", "Follower counts arrive with TikTok captures and are absent from "
      + "Instagram hashtag captures. Where the followers column reads 0 "
      + "the figure is unknown, so reach is engagement alone and a small "
      + "account with one popular post can outrank a large one. Check "
      + "those by hand."],
    ["Caveat", "Engagement rate is measured against views, which is how TikTok "
      + "is read: the For You page serves a video to people who do not "
      + "follow the account, so a rate taken against followers returns "
      + "figures in the thousands of percent."],
    ["Caveat", "Account type is decided by matching words in the handle and "
      + "display name. It produces false positives and misses. The "
      + "type_reason column states what matched."],
    ["Caveat", "Language is detected in the browser by franc, which agrees with "
      + "the Python package's detector on about four captions in five. "
      + "Short captions and close relatives such as Dutch and Afrikaans "
      + "are where the two part."],
    ["Caveat", "A list merged from two platforms ranks each post inside its own "
      + "platform, because likes on Instagram and on TikTok are not the same "
      + "scale. The platforms column states where an account was found, and a "
      + "figure is only comparable within one platform."],
    ["Caveat", "These rows describe real people. Handle them under the same "
      + "rules as any other personal data."],
  );
  return rows;
}

/** A sheet with every column wide enough to read, header row frozen. */
function sheet(XLSX, rows, header, maxWidth = 52) {
  const ws = header ? XLSX.utils.json_to_sheet(rows, { header }) : XLSX.utils.aoa_to_sheet(rows);
  const grid = header ? [header, ...rows.map((r) => header.map((h) => r[h]))] : rows;
  const widths = [];
  for (const r of grid) r.forEach((v, i) => {
    if (v == null || v === "") return;
    widths[i] = Math.min(Math.max(widths[i] || 10, String(v).length + 2), maxWidth);
  });
  ws["!cols"] = widths.map((w) => ({ wch: w || 10 }));  // voice: ignore
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };  // voice: ignore
  ws["!views"] = [{ state: "frozen", ySplit: 1 }];  // voice: ignore
  return ws;
}

const note = (text) => [[""], [text]];

/** The account workbook, as an ArrayBuffer ready to download. */
export function accountsWorkbook(XLSX, { passed, all, config, filters, corpusRows, rawRows, platform = "instagram" }) {
  const wb = XLSX.utils.book_new();
  const ready = prepareAccounts(passed, platform);
  XLSX.utils.book_append_sheet(wb, ready.length ? sheet(XLSX, ready, Object.keys(ready[0]))
    : sheet(XLSX, note("No accounts passed.")), "Accounts");

  const LEFT = ["username", "account_type", "type_reason", "best_engagement", "posts", "excluded_because"];
  const left = all.filter((a) => a.excluded_because).map((a) => Object.fromEntries(LEFT.map((c) => [c, a[c]])));
  XLSX.utils.book_append_sheet(wb, left.length ? sheet(XLSX, left, LEFT)
    : sheet(XLSX, note("Nothing was excluded.")), "Left out");

  XLSX.utils.book_append_sheet(wb, sheet(XLSX,
    [["Setting", "Value"], ...runParameters(config, filters, corpusRows, rawRows, platform)]), "About this run");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

// Post rows go out flat: lists joined, working columns dropped.
const POST_DROP = new Set(["content_tokens", "hashtags", "mentions"]);

/** The post-level corpus, for a study that wants the rows themselves. */
export function postsWorkbook(XLSX, { posts, config, filters, platform = "" }) {
  const rows = posts.map((p) => Object.fromEntries(Object.entries(p)
    .filter(([k]) => !POST_DROP.has(k))
    .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, rows.length ? sheet(XLSX, rows, Object.keys(rows[0]))
    : sheet(XLSX, note("No posts.")), "Posts");
  XLSX.utils.book_append_sheet(wb, sheet(XLSX,
    [["Setting", "Value"], ...runParameters(config, filters, posts.length, posts.length, platform)]), "About this run");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}
