// Muscle groups read out of the vocabulary.
//
// A hand-written theme list encodes a framework brought to a corpus. This does
// the opposite: it factorises the captions and reports what clusters, so a
// capture on a subject nobody has theorised still gets a first set of groups.
//
// The method follows monke_bars/topics.py: TF-IDF over the cleaned tokens, then
// non-negative matrix factorisation, each topic labelled by its top three words.
// scikit-learn is not available here, so the factorisation is the standard
// multiplicative-update rule with a seeded start. The groups it finds are close
// to the package's and rarely identical, which is why they are editable and get
// saved into the program once they look right.

const SEED = 0x2545f491;

/** A seeded generator, so the same corpus returns the same groups every run. */
function rng(seed = SEED) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** TF-IDF over documents of tokens, with the package's document-frequency cuts:
 *  a term in fewer than min_df documents is noise, and one in over 40 percent of
 *  them describes the whole corpus rather than a group inside it. */
function tfidf(docs, { maxTerms = 400 } = {}) {
  const minDf = docs.length >= 25 ? 3 : 1;
  const df = new Map();
  for (const toks of docs) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  const keep = [...df.entries()]
    .filter(([, n]) => n >= minDf && n / docs.length <= 0.4)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, maxTerms);
  const vocab = keep.map(([t]) => t);
  const index = new Map(vocab.map((t, i) => [t, i]));
  const idf = keep.map(([, n]) => Math.log((1 + docs.length) / (1 + n)) + 1);

  const rows = docs.map((toks) => {
    const row = new Float64Array(vocab.length);
    for (const t of toks) { const i = index.get(t); if (i !== undefined) row[i] += 1; }
    let norm = 0;
    for (let i = 0; i < row.length; i++) { row[i] *= idf[i]; norm += row[i] * row[i]; }
    norm = Math.sqrt(norm);
    if (norm) for (let i = 0; i < row.length; i++) row[i] /= norm;
    return row;
  });
  return { rows, vocab };
}

/** V ≈ W H by multiplicative updates. Small matrices, so plain arrays. */
function nmf(V, nTerms, k, iterations = 120) {
  const n = V.length;
  const rand = rng();
  const W = Array.from({ length: n }, () => Float64Array.from({ length: k }, () => rand() + 0.01));
  const H = Array.from({ length: k }, () => Float64Array.from({ length: nTerms }, () => rand() + 0.01));
  const eps = 1e-10;

  for (let it = 0; it < iterations; it++) {
    // H *= (Wt V) / (Wt W H)
    const WtV = Array.from({ length: k }, () => new Float64Array(nTerms));
    const WtW = Array.from({ length: k }, () => new Float64Array(k));
    for (let i = 0; i < n; i++) {
      const w = W[i], v = V[i];
      for (let a = 0; a < k; a++) {
        if (w[a] === 0) continue;
        const wa = w[a], target = WtV[a];
        for (let j = 0; j < nTerms; j++) if (v[j]) target[j] += wa * v[j];
        for (let b = 0; b < k; b++) WtW[a][b] += wa * w[b];
      }
    }
    for (let a = 0; a < k; a++) {
      for (let j = 0; j < nTerms; j++) {
        let den = 0;
        for (let b = 0; b < k; b++) den += WtW[a][b] * H[b][j];
        H[a][j] *= WtV[a][j] / (den + eps);
      }
    }
    // W *= (V Ht) / (W H Ht)
    const HHt = Array.from({ length: k }, () => new Float64Array(k));
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
      let s = 0;
      for (let j = 0; j < nTerms; j++) s += H[a][j] * H[b][j];
      HHt[a][b] = s;
    }
    for (let i = 0; i < n; i++) {
      const v = V[i], w = W[i];
      const VHt = new Float64Array(k);
      for (let j = 0; j < nTerms; j++) {
        const vj = v[j];
        if (!vj) continue;
        for (let a = 0; a < k; a++) VHt[a] += vj * H[a][j];
      }
      for (let a = 0; a < k; a++) {
        let den = 0;
        for (let b = 0; b < k; b++) den += w[b] * HHt[b][a];
        w[a] *= VHt[a] / (den + eps);
      }
    }
  }
  return { W, H };
}

/**
 * Discover groups from posts that already carry content tokens.
 *
 * Returns `{ themes, table }`: themes is `{label: [words]}`, the same shape a
 * program's muscle groups take, so it drops straight into the share and count
 * machinery. A corpus too small to model returns empty.
 */
export function discoverThemes(posts, { nTopics = 5, nWords = 10 } = {}) {
  const docs = posts.map((p) => p.content_tokens).filter((t) => t && t.length);
  if (docs.length < 3) return { themes: {}, table: [] };
  const { rows, vocab } = tfidf(docs);
  if (vocab.length < nTopics) return { themes: {}, table: [] };

  const k = Math.min(nTopics, docs.length, vocab.length);
  const { W, H } = nmf(rows, vocab.length, k);

  // Each post counts towards the group it loads on most, which is what the
  // "posts" figure beside a group reports.
  const counts = new Array(k).fill(0);
  for (const w of W) {
    let best = 0;
    for (let a = 1; a < k; a++) if (w[a] > w[best]) best = a;
    counts[best]++;
  }

  const groups = [];
  const seen = new Set();
  for (let a = 0; a < k; a++) {
    const order = [...vocab.keys()].sort((i, j) => H[a][j] - H[a][i] || (vocab[i] < vocab[j] ? -1 : 1));
    const words = order.slice(0, nWords).map((i) => vocab[i]);
    let label = words.slice(0, 3).join(" / ");
    while (seen.has(label)) label += " ·";     // labels name a chart axis, so they stay unique
    seen.add(label);
    groups.push({ label, words, posts: counts[a] });
  }
  groups.sort((x, y) => y.posts - x.posts);
  return {
    themes: Object.fromEntries(groups.map((g) => [g.label, g.words])),
    table: groups.map((g) => ({ group: g.label, words: g.words.join(", "), posts: g.posts })),
  };
}
