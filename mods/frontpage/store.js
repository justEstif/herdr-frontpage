// herdr-frontpage store: local-only JSON state.
// Shape:
//   story  {id, url, title, source, addedAt, readMs, text, topic, saved, dismissed}
//   source {url, title, addedAt, pollHours, lastPollMs, kept, skipped}
//   event  {seq, ts, kind: keep|skip|mark|undo|rate, storyId, target?}
// Storage under <appHome>/mods/frontpage/data/:
//   snapshot.json  full state; `appliedThrough` = ledger seq it includes
//   ledger.jsonl   events since the last snapshot write (append-only)
// Compacted on load: snapshot rewritten, ledger truncated.
import { appHome, readTextFile, writeTextFile } from "herdr";

const LEDGER_LIMIT = 950 * 1024; // stay well under the 1 MiB readTextFile cap
const SNAPSHOT_LIMIT = 900 * 1024;
const TEXT_CAP = 20000; // chars of story text kept per story

const DEMO_PATH = appHome() + "/mods/frontpage/data/demo/demo.json";

export class Store {
  constructor() {
    this.dir = appHome() + "/mods/frontpage/data";
    this.stories = []; // story[]
    this.sources = []; // source[]
    this.events = []; // event[]
    this.onboarded = false;
    this.appliedThrough = 0;
    this._undo = []; // {event, prev: {saved?, dismissed?}}
    this._seq = 0;
    this._dirtyLedger = "";
    this.loaded = false;
  }

  async load() {
    const snapRaw = await readTextFile(this.dir + "/snapshot.json");
    const ledgerRaw = await readTextFile(this.dir + "/ledger.jsonl") ?? "";
    let snap = null;
    if (snapRaw) {
      try {
        snap = JSON.parse(snapRaw);
      } catch (_e) {
        snap = null; // corrupt snapshot: fall back to ledger-only (demo state)
      }
    }
    if (snap) {
      this.stories = snap.stories ?? [];
      this.sources = snap.sources ?? [];
      this.events = snap.events ?? [];
      this.onboarded = !!snap.onboarded;
      this.appliedThrough = snap.appliedThrough ?? 0;
    }
    // Apply ledger lines the snapshot doesn't already include.
    for (const line of ledgerRaw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try {
        ev = JSON.parse(s);
      } catch (_e) {
        continue; // torn tail line from a crash: drop it
      }
      if (ev.seq > this.appliedThrough) {
        this.events.push(ev);
      }
    }
    this._seq = this.events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    this._undo = [];
    if (!snap && this.events.length === 0 && this.stories.length === 0) {
      // First run: seed with demo data for onboarding.
      const demo = await readTextFile(DEMO_PATH);
      if (demo) {
        try {
          const d = JSON.parse(demo);
          this.stories = (d.stories ?? []).map((s) => ({ ...s, saved: false, dismissed: false }));
          this.sources = d.sources ?? [];
        } catch (_e) { /* empty first run */ }
      }
    }
    await this.compact();
    this.loaded = true;
  }

  // -- persistence ---------------------------------------------------------

  async compact() {
    // Fold the ledger into the snapshot, truncate the ledger.
    this.appliedThrough = this._seq;
    this._trimForCap();
    const snap = {
      stories: this.stories,
      sources: this.sources,
      events: this.events.slice(-400),
      onboarded: this.onboarded,
      appliedThrough: this.appliedThrough,
    };
    const text = JSON.stringify(snap);
    await writeTextFile(this.dir + "/snapshot.json", text, null);
    await writeTextFile(this.dir + "/ledger.jsonl", "", this._dirtyLedger || null);
    this._dirtyLedger = "";
  }

  _trimForCap() {
    // Oldest, already-read-or-dismissed stories lose their text first.
    const total = () =>
      JSON.stringify({ s: this.stories, e: this.events.slice(-400) }).length;
    if (total() <= SNAPSHOT_LIMIT) return;
    const trimmed = [...this.stories].sort((a, b) => a.addedAt - b.addedAt);
    for (const st of trimmed) {
      if (!st.text || (!st.saved && (st.dismissed || st.readMs === 0))) continue;
      if (total() <= SNAPSHOT_LIMIT) break;
      st.text = "";
      st.textDropped = true;
    }
    if (total() > SNAPSHOT_LIMIT) {
      // Last resort: drop oldest dismissed stories entirely.
      this.stories = this.stories.filter((s) => !s.dismissed || total() <= SNAPSHOT_LIMIT);
    }
  }

  async _append(ev) {
    this._seq += 1;
    ev.seq = this._seq;
    this.events.push(ev);
    this._dirtyLedger += JSON.stringify(ev) + "\n";
    if (this._dirtyLedger.length > LEDGER_LIMIT / 2 || this.events.length % 25 === 0) {
      await this.compact();
    }
    return ev;
  }

  // -- actions -------------------------------------------------------------

  byId(id) {
    return this.stories.find((s) => s.id === id) ?? null;
  }

  /** keep = save for later, skip = dismiss, mark = mark/highlight, rate = +/-1. */
  async act(kind, storyId, target) {
    const st = this.byId(storyId);
    if (!st) return null;
    const prev = { saved: st.saved, dismissed: st.dismissed };
    if (kind === "keep") st.saved = true;
    else if (kind === "skip") st.dismissed = true;
    const ev = await this._append({ ts: Date.now(), kind, storyId, ...(target !== undefined ? { target } : {}) });
    this._undo.push({ ev, prev });
    if (this._undo.length > 20) this._undo.shift();
    return ev;
  }

  async undo() {
    const u = this._undo.pop();
    if (!u) return null;
    const st = this.byId(u.ev.storyId);
    if (st) {
      st.saved = u.prev.saved;
      st.dismissed = u.prev.dismissed;
    }
    await this._append({ ts: Date.now(), kind: "undo", storyId: u.ev.storyId });
    return u.ev;
  }

  lastAction() {
    return this._undo.length ? this._undo[this._undo.length - 1].ev : null;
  }

  nextId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  async addStory({ url, title, source, text, topic, readMs }) {
    if (this.stories.some((s) => s.url === url)) return null; // dedupe
    const st = {
      id: this.nextId(),
      url,
      title: title || url,
      source: source || hostname(url) || "web",
      addedAt: Date.now(),
      readMs: readMs ?? estReadMs(text),
      text: (text || "").slice(0, TEXT_CAP),
      topic: topic || detectTopic((title || "") + " " + (text || "")),
      saved: false,
      dismissed: false,
    };
    this.stories.push(st);
    await this.compact();
    return st;
  }

  async addSource({ url, title, pollHours }) {
    if (this.sources.some((s) => s.url === url)) return null;
    const src = {
      url,
      title: title || hostname(url) || url,
      addedAt: Date.now(),
      pollHours: pollHours ?? 6,
      lastPollMs: Date.now(),
      kept: 0,
      skipped: 0,
    };
    this.sources.push(src);
    await this.compact();
    return src;
  }

  async removeSource(url) {
    this.sources = this.sources.filter((s) => s.url !== url);
    await this.compact();
  }

  async finishOnboarding() {
    this.onboarded = true;
    await this.compact();
  }

  sourcesDue(now = Date.now()) {
    return this.sources.filter((s) => now - s.lastPollMs >= s.pollHours * 3600 * 1000);
  }

  async notePoll(url) {
    const s = this.sources.find((x) => x.url === url);
    if (s) s.lastPollMs = Date.now();
    await this.compact();
  }

  queue() {
    return this.stories.filter((s) => !s.dismissed && !s.saved);
  }

  savedStories() {
    return this.stories.filter((s) => s.saved && !s.dismissed);
  }

  eventCount() {
    return this.events.filter((e) => e.kind !== "undo").length;
  }
}

// -- helpers ----------------------------------------------------------------

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_e) {
    return null;
  }
}

export function estReadMs(text) {
  const words = (text || "").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round((words / 200) * 60 * 1000)); // ms at 200 wpm
}

const TOPICS = [
  ["kernel", ["kernel", "linux", "scheduler", "eevdf", "cfs", "driver", "syscall", "rust-for-linux"]],
  ["databases", ["sqlite", "postgres", "database", "query", "index", "sql"]],
  ["infrastructure", ["kubernetes", "docker", "deploy", "server", "cloud", "latency", "uptime"]],
  ["terminal", ["terminal", "tmux", "shell", "cli", "tui", "ssh"]],
  ["ai", ["llm", "model", "agent", "gpt", "claude", "inference", "training", "prompt"]],
  ["web", ["browser", "css", "html", "javascript", "typescript", "http"]],
  ["craft", ["refactor", "testing", "maintainability", "design", "api", "complexity"]],
];

export function detectTopic(text) {
  const t = (text || "").toLowerCase();
  let best = null, hits = 0;
  for (const [name, words] of TOPICS) {
    const n = words.reduce((m, w) => m + (t.includes(w) ? 1 : 0), 0);
    if (n > hits) { hits = n; best = name; }
  }
  return best || "general";
}
