// herdr-frontpage: a Terminal-style personal reading queue that learns from
// feedback and explains itself. One mod, two roles via props().role:
//   "rail"   — the sidebar: queue (Q1..Qn) + capture as an overlay card.
//              Keys: j/k · enter (open in the center) · v · c · z.
//   "reader" — a center tab: the reading view. Keys: h/m/f/u/w/a/n/q · enter
//              (nothing open: falls through to the top of the rail).
// The reader (or first) instance owns feed polling; a shared timestamp guard
// keeps duplicates out. All store mutations flow through the rail copy so the
// ledger's CAS writes never race. Local-only store (store.js), learned
// ranking (rank.js), why-receipts (w), optional agent pane (a).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { theme, exec, hc, run, panes, spaces, knownAgents, setShared, shared, notify, nextCommand, writeTextFile, props, focused } from "herdr";
import { Store, detectTopic, estReadMs } from "./store.js";
import { buildWeights, rank, whyReceipt } from "./rank.js";

const QUEUE_CAP = 30;
const POLL_MS = 15 * 60 * 1000;
const RAIL_EXPANDED_PX = 300;
const RAIL_COMPACT_PX = 44;
const RAIL_MIN_QUEUE_ROWS = 3;
const AGENT_MIN_WIDTH = 560; // below this: inline why-receipt instead of an agent pane
const RAIL_FOOT = "j/k move · enter open · v saved · c capture · z rail";
const RAIL_COMPACT_FOOT = "j/k · enter · z";
const READER_FOOT = "h mark · m/f more-less · u undo · w why · a agent · n next · q close";

export default class Frontpage extends View {
  init(_props, cx) {
    this.role = (props()?.role) === "reader" ? "reader" : "rail";
    this.store = new Store();
    this.weights = { terms: new Map(), sources: new Map() };
    this.sel = 0;
    this.savedView = false;
    this.whyFor = null;
    this.width = 0;
    this.flash = null;
    this.lastCmdTs = shared("frontpage:cmd")?.ts ?? 0;
    this.h = cx.focus_handle();

    if (this.role === "rail") {
      this.captureOpen = false;
      this.onboardingLeft = 5;
      this.urlIn = InputState.new({ placeholder: "https:// story url" });
      this.feedIn = InputState.new({ placeholder: "https:// feed url (rss/atom)" });
      this.fetchState = null; // {busy, via, result, error}
      this.urlIn.on("submit", () => this.captureFetch(cx));
      this.feedIn.on("submit", (_v, cx) => this.subscribeFeed(cx));
    } else {
      this.reading = props()?.story ?? null;
      this.agentPane = null;
      this.agentAddr = null;
    }

    cx.spawn(async (cx) => {
      try {
        await this.store.load();
      } catch (e) {
        this.flash = "store failed to load: " + (e?.message ?? e);
      }
      this.reweigh();
      this.publish();
      if (this.role === "reader" && !this.reading) this.reading = this.topStoryId();
      cx.notify();
    });

    // Feed polling: one owner only — the reader role, else whoever claimed
    // first. The shared timestamp doubles as the duplicate guard.
    cx.spawn(async (cx) => {
      const owner = shared("frontpage:pollOwner");
      if (!owner || (owner.role !== "reader" && this.role === "reader") || Date.now() - owner.ts > POLL_MS + 60000) {
        setShared("frontpage:pollOwner", { role: this.role, ts: Date.now() });
        this.polls = true;
      }
    });
    cx.timer.every(POLL_MS, (cx) => {
      const owner = shared("frontpage:pollOwner");
      if (owner && owner.role !== this.role) return;
      setShared("frontpage:pollOwner", { role: this.role, ts: Date.now() });
      cx.spawn(async (cx) => { await this.pollFeeds(); cx.notify(); });
    });

    // Scriptable commands: "frontpage.<cmd>" from keys.json or herdr-app do.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (!c) continue;
        const raw = c.includes(":") ? c.slice(c.lastIndexOf(":") + 1) : c;
        const k = { open: "enter", down: "j", up: "k", why: "w", dismiss: "x", save: "S", less: "f", more: "m", undo: "u", saved: "v", capture: "c", agent: "a", mark: "h", next: "n", close: "q", back: "escape", p: "__dump", focusrail: "__focusrail" }[raw] ?? raw;
        if (k === "__dump") { await this.writeDump(); continue; }
        if (k === "__focusrail") { this.focusRail(); continue; }
        if (this.role === "rail" || k === "a" || k === "w") this.onKey({ key: k }, cx);
      }
    });
    this.h.focus();
  }

  // -- shared data plumbing --------------------------------------------------

  reweigh() {
    this.weights = buildWeights(this.store.events, (id) => this.store.byId(id));
  }

  publish() {
    setShared("frontpage:counts", {
      queue: this.store.queue().length,
      saved: this.store.savedStories().length,
      events: this.store.eventCount(),
      onboarded: this.store.onboarded,
    });
  }

  list() {
    if (this.savedView) {
      return this.store.savedStories().map((s) => ({ story: s, score: 0, parts: [] }));
    }
    return rank(this.store.queue(), this.weights).slice(0, QUEUE_CAP);
  }

  topStoryId() {
    return rank(this.store.queue(), this.weights)[0]?.story.id ?? null;
  }

  story() {
    return this.store.byId(this.reading ?? "") ?? null;
  }

  flashSet(msg, cx) {
    this.flash = msg;
    cx.notify();
  }

  /** Reader copies don't write the store; they hand the action to the rail
   *  via shared state and the rail applies it on its next render. */
  request(cmd, cx) {
    setShared("frontpage:cmd", { ...cmd, ts: Date.now() });
    if (cx) cx.notify();
  }

  applyRemoteCmds(cx) {
    const cmd = shared("frontpage:cmd");
    if (!cmd || cmd.ts === this.lastCmdTs) return;
    this.lastCmdTs = cmd.ts;
    if (cmd.kind === "undo") {
      this.undo(cx);
      return;
    }
    if (cmd.kind) {
      this.act(cmd.kind, cmd.story, cmd.target, cx);
      this.flash = "from reader: " + cmd.kind;
    }
  }

  async act(kind, storyId, target, cx) {
    await this.store.act(kind, storyId, target);
    this.reweigh();
    this.publish();
    if (cx) cx.notify();
  }

  async undo(cx) {
    const ev = await this.store.undo();
    this.reweigh();
    this.publish();
    this.flash = ev ? `undid ${ev.kind}` : "nothing to undo";
    cx.notify();
  }

  // -- rail: open into the center -------------------------------------------

  focusRail() {
    const p = panes().find((x) => x.mod === "frontpage" && (x.props?.role ?? "rail") === "rail");
    if (p) run("pane.focus", { pane: p.pane });
  }

  open(idx, cx) {
    const item = this.list()[idx];
    if (!item) return;
    const st = item.story;
    const name = "read: " + (st.title || st.url).slice(0, 40);
    const space = spaces().find((s) => s.tabs?.some((tb) => tb.id === focusedTabId())) ?? spaces()[0];
    const existing = space?.tabs?.find((tb) => tb.name === name);
    if (existing) run("tab.select", { id: existing.id });
    else run("tab.new", { name, mod: "frontpage", props: { role: "reader", story: st.id } });
    // opening a tab moves focus to the center; nothing else to do
    if (cx) cx.notify();
  }

  // -- rail: z cycles expanded -> compact -> hidden -> expanded --------------

  railCycle(cx) {
    if (this.width >= RAIL_COMPACT_PX + 20) {
      run("layout.resize", { id: "sidebar", px: RAIL_COMPACT_PX });
      this.flash = "rail compact ([ hides it)";
    } else {
      run("layout.resize", { id: "sidebar", px: RAIL_EXPANDED_PX });
      this.flash = "rail expanded";
    }
    if (cx) cx.notify();
  }

  get compact() {
    return this.width > 0 && this.width < 120;
  }

  // -- rail: capture overlay -------------------------------------------------

  async captureFetch(cx) {
    const url = this.urlIn.value().trim();
    if (!/^https?:\/\//.test(url)) {
      this.fetchState = { error: "paste a full http(s) url" };
      cx.notify();
      return;
    }
    this.fetchState = { busy: true };
    cx.notify();
    cx.spawn(async (cx) => {
      let out = null;
      try {
        const r = await exec("npx", ["-y", "defuddle", "parse", url, "--json", "--markdown"]);
        if (r.code === 0 && r.stdout.trim().startsWith("{")) {
          const j = JSON.parse(r.stdout);
          const text = j.markdown || j.content || j.contentMarkdown || j.text || "";
          if (text) out = { title: j.title || url, text, via: "defuddle" };
        }
      } catch (_e) { /* fall through */ }
      if (!out) out = await this.fetchFallback(url);
      if (!out) this.fetchState = { error: "could not extract (is npx on PATH? is the url public?)" };
      else {
        this.fetchState = {
          via: out.via,
          result: {
            url,
            title: out.title,
            text: out.text,
            topic: detectTopic(out.title + " " + out.text),
            chars: out.text.length,
            readMs: estReadMs(out.text),
          },
        };
      }
      cx.notify();
    });
  }

  async fetchFallback(url) {
    try {
      const res = await fetch(url);
      const html = await res.text();
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [, url])[1].trim();
      const body = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      return body.length > 200 ? { title, text: body, via: "strip-tags" } : null;
    } catch (_e) {
      return null;
    }
  }

  async queueCaptured(cx) {
    const r = this.fetchState?.result;
    if (!r) return;
    const st = await this.store.addStory(r);
    this.fetchState = st ? null : { error: "already in the store" };
    this.urlIn.set_value("");
    this.reweigh();
    this.publish();
    if (st) this.flash = `queued: ${st.title.slice(0, 40)}`;
    cx.notify();
  }

  async subscribeFeed(cx) {
    const url = this.feedIn.value().trim();
    if (!/^https?:\/\//.test(url)) return;
    cx.spawn(async (cx) => {
      const items = await this.fetchFeedItems(url);
      const src = await this.store.addSource({ url });
      let added = 0;
      if (items) {
        for (const it of items.slice(0, 5)) {
          if (await this.store.addStory({ url: it.link, title: it.title, source: null, text: "" })) added += 1;
        }
      }
      this.reweigh();
      this.publish();
      this.feedIn.set_value("");
      this.flash = src
        ? `subscribed ${src.title}${items ? ` · ${added} new items` : " (feed unreadable, will retry)"}`
        : "already subscribed";
      cx.notify();
    });
  }

  async fetchFeedItems(url) {
    try {
      const res = await fetch(url);
      const xml = await res.text();
      const items = [];
      const re = /<(item|entry)[\s\S]*?<\/\1>/gi;
      let m;
      while ((m = re.exec(xml)) && items.length < 20) {
        const block = m[0];
        const title = (block.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1]
          .replace(/<!\[CDATA\[|\]\]>/g, "").trim();
        let link = (block.match(/<link[^>]*href="([^"]+)"/i) || [, ""])[1];
        if (!link) link = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [, ""])[1].trim();
        if (title && link) items.push({ title, link });
      }
      return items;
    } catch (_e) {
      return null;
    }
  }

  async pollFeeds() {
    let newCount = 0;
    for (const src of this.store.sourcesDue()) {
      const items = await this.fetchFeedItems(src.url);
      if (items) {
        for (const it of items.slice(0, 3)) {
          if (await this.store.addStory({ url: it.link, title: it.title, source: src.title, text: "" })) newCount += 1;
        }
      }
      await this.store.notePoll(src.url);
    }
    if (newCount) {
      this.publish();
      notify({ title: "frontpage", body: `${newCount} new stories from your feeds`, timeout: 4000 });
    }
  }

  // -- onboarding (rail) -----------------------------------------------------

  get onboarding() {
    return this.role === "rail" && !this.store.onboarded && this.store.stories.length > 0;
  }

  async onboardingRate(kind, cx) {
    const q = this.store.queue();
    const item = q[this.sel] ?? q[q.length - 1];
    if (!item) return;
    await this.store.act(kind === "rate" ? "rate" : kind, item.id, kind === "rate" ? 1 : undefined);
    this.reweigh();
    this.onboardingLeft -= 1;
    this.clampSel();
    cx.notify();
  }

  async onboardingFinish(cx) {
    for (const s of this.store.stories) s.dismissed = false;
    await this.store.finishOnboarding();
    this.reweigh();
    this.publish();
    this.sel = 0;
    this.flash = "queue reordered from your ratings — press enter to read the top";
    cx.notify();
  }

  clampSel() {
    const n = this.list().length;
    if (this.sel >= n) this.sel = Math.max(0, n - 1);
  }

  // -- reader: agent pane ----------------------------------------------------

  async agentToggle(cx) {
    if (this.agentAddr) {
      run("pane.close", { pane: this.agentPane });
      this.agentPane = null;
      this.agentAddr = null;
      this.flash = "agent off";
      cx.notify();
      return;
    }
    const story = this.story();
    if (!story) return;
    if (this.width && this.width < AGENT_MIN_WIDTH) {
      // Tight width: no pane; the inline why-receipt is the fallback.
      this.whyFor = this.whyFor === story.id ? null : story.id;
      this.flash = "too narrow for an agent pane — why-receipt inline";
      cx.notify();
      return;
    }
    const agents = await knownAgents();
    const a = agents.find((x) => x.installed);
    if (!a) {
      this.flash = "no installed agent to open";
      cx.notify();
      return;
    }
    const before = new Set(panes().map((p) => p.pane));
    run("pane.split", { direction: "right", argv: a.run });
    this.flash = `opening ${a.name}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      for (let i = 0; i < 24 && !this.agentAddr; i++) {
        await exec("sleep", ["0.5"]);
        const fresh = panes().find((p) => !before.has(p.pane) && p.terminal);
        if (fresh) {
          this.agentPane = fresh.pane;
          this.agentAddr = fresh.terminal;
          const prompt = `ask about this story: "${story.title}" (${story.url})`;
          await hc(["send", this.agentAddr, prompt]);
          this.flash = `agent on (${a.name})`;
        }
      }
      if (!this.agentAddr) this.flash = "agent pane never appeared";
      cx.notify();
    });
  }

  // -- keys ------------------------------------------------------------------

  onKey(e, cx) {
    const k = e.key;

    if (this.role === "rail") return this.railKey(k, cx);
    return this.readerKey(k, cx);
  }

  railKey(k, cx) {
    if (this.captureOpen) {
      if (k === "escape" || k === "c") { this.captureOpen = false; cx.notify(); }
      return;
    }
    if (this.onboarding) {
      const L = this.list();
      if (k === "j" || k === "down") { this.sel = Math.min(this.sel + 1, L.length - 1); cx.notify(); }
      else if (k === "k" || k === "up") { this.sel = Math.max(this.sel - 1, 0); cx.notify(); }
      else if (k === "m") this.onboardingRate("rate", cx);
      else if (k === "f") this.onboardingRate("skip", cx);
      else if (k === "enter" && this.onboardingLeft <= 0) this.onboardingFinish(cx);
      return;
    }
    const L = this.list();
    if (k === "j" || k === "down") { this.sel = Math.min(this.sel + 1, L.length - 1); cx.notify(); }
    else if (k === "k" || k === "up") { this.sel = Math.max(this.sel - 1, 0); cx.notify(); }
    else if (k === "enter") this.open(this.sel, cx);
    else if (k === "v") { this.savedView = !this.savedView; this.sel = 0; cx.notify(); }
    else if (k === "c") { this.captureOpen = true; cx.notify(); }
    else if (k === "z") this.railCycle(cx);
  }

  readerKey(k, cx) {
    const st = this.story();
    if (k === "enter" && !st) {
      // Nothing open: fall through to the top of the rail.
      const top = this.topStoryId();
      if (top) { this.reading = top; this.whyFor = null; cx.notify(); }
      else this.flashSet("queue is empty — capture something in the rail (c)", cx);
      return;
    }
    if (!st) {
      if (k === "q" || k === "escape") run("tab.close", { confirmed: true });
      return;
    }
    if (k === "q" || k === "escape") run("tab.close", { confirmed: true });
    else if (k === "h") this.request({ kind: "mark", story: st.id }, cx);
    else if (k === "m") this.request({ kind: "rate", story: st.id, target: 1 }, cx);
    else if (k === "f") this.request({ kind: "rate", story: st.id, target: -1 }, cx);
    else if (k === "u") cx.spawn(async (cx) => { /* undo is rail-owned */ this.undoRemote(cx); });
    else if (k === "w") { this.whyFor = this.whyFor === st.id ? null : st.id; cx.notify(); }
    else if (k === "a") this.agentToggle(cx);
    else if (k === "n" || k === "x") this.readerNext(cx);
  }

  async undoRemote(cx) {
    setShared("frontpage:cmd", { kind: "undo", ts: Date.now() });
    cx.notify();
  }

  readerNext(cx) {
    const st = this.story();
    this.request({ kind: "skip", story: st.id }, cx);
    const next = rank(this.store.queue(), this.weights).find((it) => it.story.id !== st.id);
    if (next) { this.reading = next.story.id; this.whyFor = null; }
    else run("tab.close", { confirmed: true });
    cx.notify();
  }

  /** UI-structure evidence for scripts: rendered rows, counts, receipts. */
  async writeDump() {
    const rows = this.role === "rail"
      ? this.list().map((it, i) => ({
        i,
        label: `Q${i + 1}`,
        selected: i === this.sel,
        title: it.story.title,
        source: it.story.source,
        mins: Math.max(1, Math.round(it.story.readMs / 60000)),
        score: Number(it.score.toFixed(2)),
        why: this.whyFor === it.story.id ? whyReceipt(it.story, this.weights) : null,
      }))
      : [{ reading: this.reading, title: this.story()?.title ?? null, why: this.story() ? whyReceipt(this.story(), this.weights) : null }];
    const dump = {
      generatedAt: new Date().toISOString(),
      role: this.role,
      onboarding: this.onboarding,
      captureOpen: this.captureOpen ?? false,
      counts: { queue: this.store.queue().length, saved: this.store.savedStories().length, events: this.store.eventCount() },
      rows,
    };
    this._dumpN = (this._dumpN ?? 0) + 1;
    const path = this.store.dir + "/debug-" + this.role + "-" + this._dumpN + ".json";
    writeTextFile(path, JSON.stringify(dump, null, 1)).catch(() =>
      writeTextFile(path, JSON.stringify(dump, null, 1)).catch(() => {}));
  }

  // -- render ----------------------------------------------------------------

  render(cx) {
    if (this.role === "rail") return this.renderRail(cx);
    return this.renderReader(cx);
  }

  renderRail(cx) {
    this.applyRemoteCmds(cx);
    const t = theme();
    const capture = this.captureOpen;
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.chrome)
      .text_size(13)
      .track_focus(this.h)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(this.railHeader(t))
      .when(this.flash, (el) => el.child(
        div().px(8).py(1).text_size(10).text_color(t.muted).truncate().child("· " + this.flash)
      ))
      .child(this.railQueue(t))
      .when(capture, (el) => el.child(this.captureCard(t)))
      .child(this.railFooter(t));
  }

  railHeader(t) {
    const view = this.savedView ? "saved" : "queue";
    return h_flex()
      .h(26)
      .px(8)
      .items_center()
      .gap(6)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_semibold().text_size(11).text_color(t.accent).child("frontpage"))
      .child(div().text_size(10).text_color(t.dim).child(view))
      .child(div().flex_1())
      .child(div().text_size(10).text_color(t.muted).child(`${this.store.queue().length}`));
  }

  railQueue(t) {
    const items = this.list();
    if (!items.length) {
      return div().flex_1().p(8).child(
        div().text_size(11).text_color(t.dim).child(
          this.savedView ? "no saved stories yet" : "queue empty — c captures"
        )
      );
    }
    // Compact rails never fully hide the queue: at least RAIL_MIN_QUEUE_ROWS
    // rows, then a "queue: N more" line.
    const maxRows = this.compact ? Math.max(RAIL_MIN_QUEUE_ROWS, 0) : items.length;
    const shown = items.slice(0, maxRows);
    const more = items.length - shown.length;
    const rows = shown.map((it, i) => this.railRow(t, it, i));
    if (more > 0) {
      rows.push(div().px(8).py(1).text_size(10).text_color(t.muted).truncate().child(`queue: ${more} more`));
    }
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(rows);
  }

  railRow(t, it, i) {
    const st = it.story;
    const sel = i === this.sel;
    const label = `Q${i + 1}`;
    if (this.compact) {
      return h_flex()
        .id(`q-${st.id}`)
        .px(4).py(1).items_center().gap(4)
        .when(sel, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.sel = i; cx.notify(); })
        .child(div().text_size(10).text_color(sel ? t.accent : t.dim).child(label))
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(sel ? t.foreground : t.muted).child(st.title || st.url));
    }
    const mins = Math.max(1, Math.round(st.readMs / 60000));
    const row = v_flex()
      .id(`q-${st.id}`)
      .px(8).py(2).min_h(22).justify_center()
      .when(sel, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.sel = i; cx.notify(); this.open(i, cx); })
      .child(
        h_flex().gap(6).items_center()
          .child(div().w(20).text_size(10).text_color(sel ? t.accent : t.dim).child(label))
          .child(div().w(6).text_color(sel ? t.accent : t.dim).child(sel ? ">" : " "))
          .child(div().flex_1().min_w(0).truncate().text_color(sel ? t.foreground : t.muted).child(st.title || st.url))
          .child(div().w(70).truncate().text_size(10).text_color(t.dim).child(st.source))
          .child(div().w(26).text_right().text_size(10).text_color(t.dim).child(`${mins}m`))
      );
    if (this.whyFor === st.id) {
      row.child(div().pl(28).text_size(10).text_color(t.muted).truncate().child("> " + whyReceipt(st, this.weights)));
    }
    return row;
  }

  railFooter(t) {
    return h_flex()
      .h(20)
      .px(8)
      .items_center()
      .border_t(1)
      .border_color(t.border)
      .child(div().text_size(9.5).text_color(t.dim).truncate().flex_1()
        .child(this.onboarding ? "m more · f less · enter when done" : (this.compact ? RAIL_COMPACT_FOOT : RAIL_FOOT)));
  }

  // Capture expands as a card over the queue's tail — it never replaces the
  // list (the queue rows above stay visible).
  captureCard(t) {
    const fs = this.fetchState;
    return v_flex()
      .m(6).mt(0).p(8).gap(6)
      .rounded(7)
      .bg(t.popover)
      .border_1()
      .border_color(t.accent)
      .child(div().text_size(11).font_semibold().text_color(t.foreground).child("> add a story"))
      .child(
        h_flex().gap(6).child(
          Input.new(this.urlIn).flex_1().min_w(0).h(26).px(8).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5).text_color(t.foreground)
        ).child(this.btn(t, "fetch", (_e, cx) => this.captureFetch(cx)))
      )
      .when(fs?.busy, (el) => el.child(div().text_size(10).text_color(t.muted).child("fetching…")))
      .when(fs?.error, (el) => el.child(div().text_size(10).text_color(t.blocked).truncate().child(fs.error)))
      .when(fs?.result, (el) => el.child(
        v_flex().gap(4)
          .child(div().text_size(11).text_color(t.foreground).truncate().child(fs.result.title))
          .child(div().text_size(10).text_color(t.dim).truncate().child(`> ${fs.via} · ${fs.result.chars} chars · ${fs.result.topic}`))
          .child(this.btn(t, "queue it", (_e, cx) => this.queueCaptured(cx)))
      ))
      .child(div().text_size(11).font_semibold().text_color(t.foreground).child("> add a feed"))
      .child(
        h_flex().gap(6).child(
          Input.new(this.feedIn).flex_1().min_w(0).h(26).px(8).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(11.5).text_color(t.foreground)
        ).child(this.btn(t, "subscribe", (_e, cx) => this.subscribeFeed(cx)))
      )
      .child(div().text_size(10).text_color(t.dim).child("esc closes · queue stays above"))
      .children(this.store.sources.slice(0, 3).map((s) =>
        div().text_size(10).text_color(t.muted).truncate().child(`> ${s.title} · every ${s.pollHours}h`)));
  }

  renderReader(cx) {
    const t = theme();
    const st = this.story();
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.background)
      .text_size(13)
      .track_focus(this.h)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .when(this.flash, (el) => el.child(
        div().px(10).py(1).text_size(10).text_color(t.muted).truncate().child("· " + this.flash)
      ))
      .child(st ? this.readingBody(t, st) : this.readerEmpty(t))
      .child(this.readerFooter(t, st));
  }

  readerEmpty(t) {
    const top = rank(this.store.queue(), this.weights).slice(0, 3);
    return v_flex().flex_1().p(14).gap(8)
      .child(div().text_color(t.dim).child("nothing open — enter opens the top of the rail"))
      .children(top.map((it, i) =>
        h_flex().id(`top-${it.story.id}`).gap(8).on_click((_e, cx) => { this.reading = it.story.id; cx.notify(); })
          .child(div().text_size(11).text_color(t.accent).child(`Q${i + 1}`))
          .child(div().text_size(11).text_color(t.muted).truncate().flex_1().child(it.story.title || it.story.url))));
  }

  readingBody(t, st) {
    const mins = Math.max(1, Math.round(st.readMs / 60000));
    const narrow = this.width && this.width < AGENT_MIN_WIDTH;
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex().px(12).pt(8).pb(4).gap(10).items_center().child(
          div().text_size(15).font_semibold().text_color(t.foreground).flex_1().min_w(0).truncate().child(st.title)
        ).child(
          div().text_size(11).text_color(t.dim).child(`${st.source} · ${mins}m`)
        )
      )
      .when(this.agentAddr, (el) => el.child(
        // Agent pane indicator: gutter + '>' marker, no [brackets]; '…' when tight.
        h_flex().mx(12).mb(2).px(6).py(2).gap(6).items_center()
          .rounded(6).border_1().border_color(t.border).bg(t.surface)
          .child(div().w(8).text_size(11).text_color(t.accent).child(">"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted)
            .child(narrow ? `agent reading: ${st.title.slice(0, 24)}…` : `agent asked about: ${st.title}`))
      ))
      .child(
        div().flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(6).child(
          st.text
            ? TextView.markdown("story-md", st.text)
            : div().text_color(t.dim).text_size(12).child(st.textDropped ? "(text dropped to save space — open the url)" : "(no extracted text — open the url)")
        )
      )
      .when(this.whyFor === st.id || narrow, (el) => el.child(
        div().px(12).py(2).text_size(10.5).text_color(t.muted).border_t(1).border_color(t.border).truncate()
          .child("> why: " + whyReceipt(st, this.weights))
      ));
  }

  readerFooter(t, st) {
    return h_flex()
      .h(22)
      .px(10)
      .items_center()
      .gap(10)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(div().text_size(10.5).text_color(t.dim).flex_1().truncate().child(st ? READER_FOOT : "enter open top · q close"))
      .child(div().text_size(10.5).text_color(t.muted).child(this.agentAddr ? "agent on" : "local"));
  }

  btn(t, label, onClick) {
    return h_flex()
      .id(`btn-${label}`)
      .px(8)
      .h(24)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(div().text_size(10.5).text_color(t.foreground).child(label));
  }
}

function focusedTabId() {
  return focused()?.tab?.id ?? null;
}
