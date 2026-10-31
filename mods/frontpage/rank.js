// herdr-frontpage ranker: term/interest weights learned from the ledger.
// No fit %, no trust scores — just weights and a human-readable why.
// Voided events (undone) are skipped, so undo really undoes learning.

const STOP = new Set(("the a an and or but for nor so yet at by in of on to up as is are was were be been " +
  "it its this that these those with from into over after before new how why what when who you your we " +
  "not no can will just about more less than then them they their there here out get got has have had do does " +
  "using use used make makes made one two all any some most other such only own same s t don now").split(" "));

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Weighted terms and sources from ledger events. Events the person undid
 *  (an `undo` after them) are voided. keep/mark: +1, rate: target(+1/-1) x2,
 *  skip: -1 — applied to every token of the story's title+topic and its source. */
export function buildWeights(events, storyById) {
  const voided = new Set();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "undo") {
      for (let j = i - 1; j >= 0; j--) {
        if (events[j].kind !== "undo" && events[j].storyId === e.storyId && !voided.has(events[j].seq)) {
          voided.add(events[j].seq);
          break;
        }
      }
    }
  }
  const terms = new Map(); // term -> {score, kept, skipped}
  const sources = new Map(); // source -> {score, kept, skipped}
  const bump = (map, key, delta) => {
    const cur = map.get(key) ?? { score: 0, kept: 0, skipped: 0 };
    cur.score += delta;
    if (delta > 0) cur.kept += 1; else if (delta < 0) cur.skipped += 1;
    map.set(key, cur);
  };
  for (const e of events) {
    if (e.kind === "undo" || voided.has(e.seq)) continue;
    const st = storyById(e.storyId);
    if (!st) continue;
    let delta = 0;
    if (e.kind === "keep" || e.kind === "mark") delta = 1;
    else if (e.kind === "skip") delta = -1;
    else if (e.kind === "rate") delta = (e.target >= 0 ? 1 : -1) * 2;
    if (delta === 0) continue;
    for (const t of new Set(tokenize(st.title + " " + (st.topic || "")))) bump(terms, t, delta);
    if (st.source) bump(sources, st.source, delta);
  }
  return { terms, sources };
}

/** Ranked queue: [{story, score, parts: [{label, delta}]}] best first. */
export function rank(stories, weights, now = Date.now()) {
  const scored = stories.map((st) => {
    const parts = [];
    let score = 0;
    for (const t of new Set(tokenize(st.title + " " + (st.topic || "")))) {
      const w = weights.terms.get(t);
      if (w && w.score !== 0) {
        const cap = Math.max(-1.5, Math.min(1.5, w.score * 0.4)); // one term can't dominate
        score += cap;
        parts.push({ label: t, delta: cap, kept: w.kept, skipped: w.skipped });
      }
    }
    const sw = st.source ? weights.sources.get(st.source) : null;
    if (sw && sw.score !== 0) {
      const cap = Math.max(-1, Math.min(1, sw.score * 0.5));
      score += cap;
      parts.push({ label: st.source, delta: cap, kept: sw.kept, skipped: sw.skipped });
    }
    const ageDays = (now - st.addedAt) / 86400000;
    if (ageDays < 14) {
      const fresh = 0.5 * (1 - ageDays / 14);
      score += fresh;
      parts.push({ label: "new", delta: fresh });
    }
    parts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    return { story: st, score, parts };
  });
  scored.sort((a, b) => b.score - a.score || a.story.addedAt - b.story.addedAt);
  return scored;
}

/** "kernel +0.8 (4 kept · 1 skipped) · lwn.net +0.4 · new +0.3" */
export function whyReceipt(story, weights, now = Date.now()) {
  const r = rank([story], weights, now)[0];
  if (!r.parts.length) return "no signal yet — rate a few stories and this will fill in";
  const fmt = (n) => (n >= 0 ? "+" : "") + n.toFixed(1);
  return r.parts.slice(0, 3).map((p) => {
    let s = `${p.label} ${fmt(p.delta)}`;
    if (p.kept || p.skipped) s += ` (${p.kept} kept${p.skipped ? ` · ${p.skipped} skipped` : ""})`;
    return s;
  }).join(" · ");
}
