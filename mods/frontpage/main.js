// herdr-frontpage: a Terminal-style personal reading queue that learns from
// feedback and explains itself. Three pages: Queue, Reading, Capture.
// Local-only store (store.js), learned ranking (rank.js), why-receipts (w),
// optional agent pane (a) via pane.split + hc send.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextView } from "gpui-base";
import { theme, exec, hc, run, panes, knownAgents, setShared, notify } from "herdr";
import { Store, detectTopic, estReadMs } from "./store.js";
import { buildWeights, rank, whyReceipt } from "./rank.js";

const QUEUE_CAP = 30;
const FOOT = {
  queue: "j/k move · enter open · x dismiss · S save · m/f more-less · w why · v saved · u undo · c capture",
  reading: "h mark · m/f more-less · u undo · w why · a agent · q queue · n next · c capture",
  capture: "esc back · enter in a field acts",
};

export default class Frontpage extends View {
  init(_props, cx) {
    this.page = "queue";
    this.store = new Store();
    this.weights = { terms: new Map(), sources: new Map() };
    this.sel = 0;
    this.savedView = false;
    this.whyFor = null; // story id with its receipt shown inline
    this.reading = null; // story id
    this.onboardingLeft = 5;
    this.flash = null;
    this.agentPane = null;
    this.agentAddr = null;
    this.urlIn = InputState.new({ placeholder: "https:// story url" });
    this.feedIn = InputState.new({ placeholder: "https:// feed url (rss/atom)" });
    this.fetchState = null; // {busy, result:{title,text,topic,chars}, error}
    this.toast = null;
    this.h = cx.focus_handle();

    this.urlIn.on("submit", () => this.captureFetch(cx));
    this.feedIn.on("submit", () => this.subscribeFeed(cx));

    cx.spawn(async (cx) => {
      await this.store.load();
      this.reweigh();
      this.publish();
      cx.notify();
    });
    // feed polling, gently
    cx.timer.every(15 * 60 * 1000, (cx) => cx.spawn(async (cx) => { await this.pollFeeds(); cx.notify(); }));
    this.h.focus();
  }

  // -- data plumbing -------------------------------------------------------

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

  flashSet(msg, cx) {
    this.flash = msg;
    cx.notify();
    // fade the flash without a redraw loop: next action clears it
  }

  async act(kind, storyId, target, cx) {
    await this.store.act(kind, storyId, target);
    this.reweigh();
    this.publish();
    if (cx) cx.notify();
  }

  list() {
    if (this.savedView) {
      return this.store.savedStories().map((s) => ({ story: s, score: 0, parts: [] }));
    }
    return rank(this.store.queue(), this.weights).slice(0, QUEUE_CAP);
  }

  story() {
    return this.store.byId(this.reading ?? "") ?? null;
  }

  // -- actions -------------------------------------------------------------

  open(idx, cx) {
    const item = this.list()[idx];
    if (!item) return;
    this.reading = item.story.id;
    this.page = "reading";
    this.whyFor = null;
    cx.notify();
  }

  async dismiss(sel, cx) {
    const item = this.list()[sel];
    if (!item) return;
    await this.act("skip", item.story.id, undefined, cx);
    this.clampSel();
  }

  clampSel() {
    const n = this.list().length;
    if (this.sel >= n) this.sel = Math.max(0, n - 1);
  }

  async undo(cx) {
    const ev = await this.store.undo();
    this.reweigh();
    this.publish();
    this.flash = ev ? `undid ${ev.kind}` : "nothing to undo";
    cx.notify();
  }

  async agentToggle(cx) {
    if (this.agentAddr) {
      run("pane.close", { pane: this.agentPane });
      this.agentPane = null;
      this.agentAddr = null;
      this.flash = "agent off";
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
    const story = this.page === "reading" ? this.story() : this.list()[this.sel]?.story;
    if (!story) return;
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

  // -- capture -------------------------------------------------------------

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

  async readCaptured(cx) {
    await this.queueCaptured(cx);
    const last = this.store.stories[this.store.stories.length - 1];
    if (last) {
      this.reading = last.id;
      this.page = "reading";
      cx.notify();
    }
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

  // -- onboarding ----------------------------------------------------------

  get onboarding() {
    return !this.store.onboarded && this.store.stories.length > 0;
  }

  async onboardingRate(kind, cx) {
    const q = this.store.queue();
    const item = q[this.sel] ?? q[q.length - 1];
    if (!item) return;
    await this.store.act(kind, item.id);
    this.reweigh();
    this.onboardingLeft -= 1;
    this.clampSel();
    cx.notify();
  }

  async onboardingFinish(cx) {
    // show the reorder: everything not rated comes back for one look
    for (const s of this.store.stories) s.dismissed = false;
    await this.store.finishOnboarding();
    this.reweigh();
    this.publish();
    this.page = "queue";
    this.sel = 0;
    this.flash = "queue reordered from your ratings — press w on any story";
    cx.notify();
  }

  // -- keys ----------------------------------------------------------------

  onKey(e, cx) {
    const k = e.key;
    if (this.page === "capture") {
      if (k === "escape") { this.page = "queue"; cx.notify(); }
      return;
    }
    if (this.onboarding) {
      if (k === "j" || k === "down") { this.sel = Math.min(this.sel + 1, this.list().length - 1); cx.notify(); }
      else if (k === "k" || k === "up") { this.sel = Math.max(this.sel - 1, 0); cx.notify(); }
      else if (k === "m") this.onboardingRate("rate", cx) && 0;
      else if (k === "f") this.onboardingRate("skip", cx) && 0;
      else if (k === "enter" && this.onboardingLeft <= 0) this.onboardingFinish(cx);
      return;
    }
    if (this.page === "queue") {
      const L = this.list();
      if (k === "j" || k === "down") { this.sel = Math.min(this.sel + 1, L.length - 1); cx.notify(); }
      else if (k === "k" || k === "up") { this.sel = Math.max(this.sel - 1, 0); cx.notify(); }
      else if (k === "enter") this.open(this.sel, cx);
      else if (k === "x") this.dismiss(this.sel, cx);
      else if (k === "S") { const it = L[this.sel]; if (it) this.act("keep", it.story.id, undefined, cx); }
      else if (k === "m") { const it = L[this.sel]; if (it) this.act("rate", it.story.id, 1, cx); }
      else if (k === "f") { const it = L[this.sel]; if (it) this.act("rate", it.story.id, -1, cx); }
      else if (k === "w") { const it = L[this.sel]; if (it) { this.whyFor = this.whyFor === it.story.id ? null : it.story.id; cx.notify(); } }
      else if (k === "v") { this.savedView = !this.savedView; this.sel = 0; cx.notify(); }
      else if (k === "u") this.undo(cx);
      else if (k === "c") { this.page = "capture"; cx.notify(); }
      else if (k === "a") this.agentToggle(cx);
    } else if (this.page === "reading") {
      const st = this.story();
      if (!st) { this.page = "queue"; cx.notify(); return; }
      if (k === "q" || k === "escape") { this.page = "queue"; cx.notify(); }
      else if (k === "h") this.act("mark", st.id, undefined, cx);
      else if (k === "m") this.act("rate", st.id, 1, cx);
      else if (k === "f") this.act("rate", st.id, -1, cx);
      else if (k === "u") this.undo(cx);
      else if (k === "w") { this.whyFor = this.whyFor === st.id ? null : st.id; cx.notify(); }
      else if (k === "a") this.agentToggle(cx);
      else if (k === "n" || k === "x") {
        const i = this.list().findIndex((it) => it.story.id === st.id);
        this.page = "queue";
        this.sel = Math.max(0, i);
        this.dismiss(this.sel, cx);
      }
      else if (k === "c") { this.page = "capture"; cx.notify(); }
    }
  }

  // -- render --------------------------------------------------------------

  render(_cx) {
    const t = theme();
    const page = this.onboarding ? this.onboardingPage : this.page;
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.background)
      .text_size(13)
      .track_focus(this.h)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t, page))
      .when(this.flash, (el) => el.child(
        div().px(10).py(2).text_size(11).text_color(t.muted).child("· " + this.flash + " ·")
      ))
      .when(page === "queue" || this.onboarding, (el) => el.child(this.queueBody(t)).flex_1())
      .when(page === "reading", (el) => el.child(this.readingBody(t)).flex_1())
      .when(page === "capture", (el) => el.child(this.captureBody(t)).flex_1())
      .child(this.footer(t, page));
  }

  header(t, page) {
    const names = [["queue", "queue"], ["reading", "reading"], ["capture", "capture"]];
    const counts = `queue ${this.store.queue().length} · saved ${this.store.savedStories().length} · events ${this.store.eventCount()}`;
    return h_flex()
      .h(30)
      .px(10)
      .items_center()
      .gap(8)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(div().font_semibold().text_color(t.accent).text_size(12).child("read |"))
      .children(names.map(([id, label]) =>
        h_flex()
          .id(`pg-${id}`)
          .px(6)
          .rounded(4)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { if (!this.onboarding) { this.page = id; cx.notify(); } })
          .child(div().text_size(12).text_color(page === id ? t.foreground : t.dim).child(label))
      ))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(counts))
      .child(div().text_size(11).text_color(t.muted).child(this.agentAddr ? "agent on" : "local"));
  }

  footer(t, page) {
    const streak = `day ${this.dayStreak()}`;
    return h_flex()
      .h(24)
      .px(10)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(div().text_size(11).text_color(t.dim).flex_1().child(this.onboarding ? "m more like this · f less · j/k move · enter when done" : FOOT[page]))
      .child(div().text_size(11).text_color(t.muted).child(`${streak} · ${this.store.eventCount()} events · local`));
  }

  /** Consecutive days (UTC) with at least one non-undo ledger event, ending today. */
  dayStreak() {
    const days = new Set(
      this.store.events.filter((e) => e.kind !== "undo").map((e) => Math.floor(e.ts / 86400000))
    );
    if (!days.size) return 0;
    const today = Math.floor(Date.now() / 86400000);
    let streak = days.has(today) ? 1 : 0;
    for (let d = today - 1; days.has(d); d--) streak += 1;
    return streak;
  }

  queueBody(t) {
    const items = this.list();
    if (!items.length) {
      return div().flex_1().p(12).child(
        div().text_color(t.dim).child(this.savedView ? "no saved stories yet — S on the queue saves one" : "queue is empty — press c to capture a url or subscribe a feed")
      );
    }
    const rows = items.map((it, i) => {
      const st = it.story;
      const sel = i === this.sel;
      const mins = Math.max(1, Math.round(st.readMs / 60000));
      const row = v_flex()
        .id(`q-${st.id}`)
        .px(10)
        .py(3)
        .min_h(24)
        .justify_center()
        .when(sel, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.sel = i; cx.notify(); })
        .child(
          h_flex().gap(10).items_center().child(
            div().w(4).text_color(sel ? t.accent : t.dim).child(sel ? ">" : " ")
          ).child(
            div().flex_1().truncate().text_color(sel ? t.foreground : t.muted).child(st.title || st.url)
          ).child(
            div().w(110).truncate().text_color(t.dim).text_size(11).child(st.source)
          ).child(
            div().w(48).text_right().text_color(t.dim).text_size(11).child(`${mins}m`)
          ).child(
            div().w(64).text_right().text_size(11).text_color(it.parts?.length && it.parts[0]?.delta >= 0 ? t.foreground : t.dim)
              .child(it.parts?.length ? fmtDelta(it.score) : "-")
          )
        );
      if (this.whyFor === st.id) {
        row.child(div().pl(14).text_size(11).text_color(t.muted).child("why: " + whyReceipt(st, this.weights)));
      }
      return row;
    });
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(rows);
  }

  readingBody(t) {
    const st = this.story();
    if (!st) return div().flex_1().p(12).child(div().text_color(t.dim).child("nothing open"));
    const mins = Math.max(1, Math.round(st.readMs / 60000));
    return v_flex()
      .flex_1()
      .min_h(0)
      .child(
        h_flex().px(12).pt(8).pb(4).gap(10).items_center().child(
          div().text_size(15).font_semibold().text_color(t.foreground).flex_1().truncate().child(st.title)
        ).child(
          div().text_size(11).text_color(t.dim).child(`${st.source} · ${mins}m`)
        )
      )
      .child(
        div().flex_1().min_h(0).overflow_y_scrollbar().px(12).pb(6).child(
          st.text
            ? TextView.markdown("story-md", st.text)
            : div().text_color(t.dim).text_size(12).child(st.textDropped ? "(text dropped to save space — open the url)" : "(no extracted text — open the url)")
        )
      )
      .child(
        div().px(12).py(3).text_size(11).text_color(t.muted).border_t(1).border_color(t.border)
          .child("why: " + whyReceipt(st, this.weights))
      );
  }

  captureBody(t) {
    const fs = this.fetchState;
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).child("add a story"))
      .child(
        h_flex().gap(8).child(
          Input.new(this.urlIn).flex_1().h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.surface).text_size(12.5).text_color(t.foreground)
        ).child(this.btn(t, "fetch", (_e, cx) => this.captureFetch(cx)))
      )
      .when(fs?.busy, (el) => el.child(div().text_size(11).text_color(t.muted).child("fetching…")))
      .when(fs?.error, (el) => el.child(div().text_size(11).text_color(t.blocked).child(fs.error)))
      .when(fs?.result, (el) => el.child(
        v_flex().gap(6).px(10).py(8).rounded(7).bg(t.surface)
          .child(div().text_size(12).text_color(t.foreground).truncate().child(fs.result.title))
          .child(div().text_size(11).text_color(t.dim).child(`fetched via ${fs.via} · ${fs.result.chars} chars · topic: ${fs.result.topic}`))
          .child(h_flex().gap(8)
            .child(this.btn(t, "queue it", (_e, cx) => this.queueCaptured(cx)))
            .child(this.btn(t, "read now", (_e, cx) => this.readCaptured(cx))))
      ))
      .child(div().text_size(12).font_semibold().text_color(t.foreground).mt(6).child("add a source"))
      .child(
        h_flex().gap(8).child(
          Input.new(this.feedIn).flex_1().h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.surface).text_size(12.5).text_color(t.foreground)
        ).child(this.btn(t, "subscribe", (_e, cx) => this.subscribeFeed(cx)))
      )
      .child(div().text_size(12).font_semibold().text_color(t.foreground).mt(6).child("your sources"))
      .children(this.store.sources.length
        ? this.store.sources.map((s) =>
          h_flex().id(`src-${s.url}`).gap(10).items_center().py(2)
            .child(div().w(160).truncate().text_color(t.foreground).text_size(12).child(s.title))
            .child(div().flex_1().text_size(11).text_color(t.dim).child(`every ${s.pollHours}h · kept ${s.kept} / skipped ${s.skipped}`))
            .child(this.btn(t, "x", (_e, cx) => cx.spawn(async (cx) => { await this.store.removeSource(s.url); this.publish(); cx.notify(); }))))
        : [div().text_size(11).text_color(t.dim).child("none yet")]);
  }

  btn(t, label, onClick) {
    return h_flex()
      .id(`btn-${label}`)
      .px(8)
      .h(28)
      .items_center()
      .rounded(7)
      .border_1()
      .border_color(t.border)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(div().text_size(11.5).text_color(t.foreground).child(label));
  }
}

function fmtDelta(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1);
}
