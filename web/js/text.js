// Caption normalisation, tokenisation and stopwording.
//
// A port of monke_bars/text.py that has to agree with it token for token, and
// the tests hold it to that. Two differences between the languages would
// otherwise break agreement without any error:
//
// Python's \w matches any letter in any script. JavaScript's matches only ASCII
// unless it is spelled out with Unicode property escapes, so a naive port reads
// "#açaí" as "#a" and leaves "çaí" behind as a word. Every pattern below uses
// \p{L} and \p{N} for that reason.
//
// Python's \w also excludes combining marks, so \p{M} is deliberately absent.

const W = "\\p{L}\\p{N}_";                        // Python's \w on str
const RE_HASHTAG = new RegExp(`#[${W}]+`, "gu");
// Dots only inside a handle, as in ingest/instagram.py.
const RE_MENTION = new RegExp(`@[${W}](?:[${W}.]*[${W}])?`, "gu");
const RE_URL = /http\S+/gu;
const RE_BRACKETS = /\[.*?\]/gu;
const RE_PUNCT = new RegExp(`[^${W}\\s]`, "gu");  // Python's [^\w\s]
const RE_DIGITS = /\p{Nd}+/gu;                     // Python's \d on str
// Python's [^\W\d_]: word characters that are neither decimal digits nor "_".
const RE_WORD = /[\p{L}\p{Nl}\p{No}]+/gu;

let CONTRACTIONS = null;
let CONTRACTION_RE = null;

/** Load the expansion table exported from the Python package. */
export function setContractions(table) {
  CONTRACTIONS = table;
  // Longest first, so "shouldn't've" wins over "shouldn't". Bounded on both
  // sides by anything that is not a word character, which is how the Python
  // library decides where a contraction starts and ends.
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const alt = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  CONTRACTION_RE = new RegExp(`(?<![${W}])(?:${alt})(?![${W}])`, "gu");
}

function expandContractions(text) {
  if (!CONTRACTION_RE) return text;
  // The Python library matches the replacement's case to the text it replaced.
  // Captions are lowercased before this step, so every match is lowercase and
  // so is every replacement: "i'm" becomes "i am", where the table says "I am".
  return text.replace(CONTRACTION_RE, (m) => (CONTRACTIONS[m] ?? m).toLowerCase());
}

/** One caption, cleaned into a list of word tokens. */
export function normalize(caption) {
  if (typeof caption !== "string") return [];
  let t = caption.toLowerCase();
  t = t.replace(RE_HASHTAG, "").replace(RE_MENTION, "").replace(RE_URL, "");
  t = expandContractions(t);
  t = t.replace(RE_BRACKETS, "").replace(RE_PUNCT, "").replace(RE_DIGITS, "");
  return t.match(RE_WORD) || [];
}

/** Tokens that are not stopwords and are longer than one character.
 *  Length counts code points, as Python does. String.length counts UTF-16
 *  units, which makes a styled letter like "𝐴" two characters long. */
export function contentTokens(caption, stopwords) {
  return normalize(caption).filter((t) => !stopwords.has(t) && [...t].length > 1);
}

/** Every stopword list for the languages given, merged with a study's extras. */
export function buildStopwords(data, extra = [], languages = []) {
  const langs = [...new Set((languages || []).filter(Boolean).map((c) => String(c).toLowerCase()))];
  const out = new Set();
  if (langs.length) {
    for (const code of langs) for (const w of data.by_code[code] || []) out.add(w);
  } else {
    for (const w of data.fallback_english) out.add(w);
  }
  for (const w of extra || []) out.add(String(w).toLowerCase());
  return out;
}

export function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i + n <= tokens.length; i++) out.push(tokens.slice(i, i + n));
  return out;
}

// Hashtag and mention extraction, used by the ingest adapters. Same Unicode
// rule, so a tag like #açaíbowl survives whole.
export const HASHTAG_RE = RE_HASHTAG;
export const MENTION_RE = RE_MENTION;
