# frontpage

A Terminal-style personal reading queue that learns from feedback and explains
itself, laid out like Herdr itself: a collapsible left rail holding the queue
and capture, a center reader that opens stories as their own tabs, and a
status bar. Everything you keep, skip, rate or mark nudges term and source
weights, and every story can show a plain-language "why" receipt for its
score. Local-only JSON storage; first-run onboarding seeds 12 demo stories and
asks for 5 ratings.

![frontpage](preview.png)

## What you see

Left to right, `ink` theme, 13px text on the theme background:

1. **Left rail** (sidebar column, 300px default, 40px minimum, resizable,
   hideable with `[`; 1px right divider, chrome background):
   - **Header** (26px): `frontpage` in accent 11px semibold, the view name
     (`queue` or `saved`, 10px dim), the queue count right-aligned (10px).
   - **Queue rows**: each labeled `Q1`..`Qn` by queue position (10px, accent
     when selected), a 6px `>` selection marker, the truncated title (muted;
     foreground when selected), the source (70px, 10px dim) and the read time
     (`8m`, 26px right-aligned). Selected rows tint `selected`; hover
     highlights; clicking a row selects and opens it in the center.
   - **Compact rail** (sidebar at 40–120px): rows collapse to `Qn` plus the
     truncated title at 10px, and the queue never disappears — at least 3
     rows always render, with a `queue: N more` line under them when the
     queue is longer.
   - **Capture card** (press `c`): an accent-bordered card (popover
     background, rounded 7) that expands over the tail of the queue — the
     queue rows above it stay visible. It has `> add a story` with a URL
     input and `fetch`, the fetched result (`> defuddle · N chars · kernel`,
     a `queue it` button), `> add a feed` with a subscribe input, and up to 3
     subscribed sources as `> <title> · every 6h` lines. `esc`/`c` closes it.
   - **Rail footer** (20px): `j/k move · enter open · v saved · c capture ·
     z rail` (9.5px dim); `j/k · enter` when compact; during onboarding
     `m more · f less · enter when done`.
2. **Center**: Herdr's native tab bar (30px) over the reader pane (cards with
   1px borders, accent border while focused). Each opened story gets its own
   tab named `read: <title>` — multiple reader collections live side by side.
   A reader shows the story title (15px semibold) with `source · 8m`, the
   extracted markdown body (scrollable), and, when the agent pane is on or
   the pane is narrow, a `> why: …` receipt line (10.5px muted, top border).
   With nothing open it lists the top three queue rows (`Q1`..`Q3`, accent
   labels) and says `nothing open — enter opens the top of the rail`.
   The agent line draws as a bordered strip with a `>` gutter marker and no
   literal brackets; below 560px it truncates with `…` and the inline
   why-receipt replaces the pane.
3. **Status bar** (24px, full width, chrome): `frontpage` label in accent,
   `queue N · saved N · events N` (11px muted), then the persistent
   `[/] rail` hint (11px accent — visible on every screen), then
   `onboarding — rate 5 to tune your queue` before onboarding, otherwise
   `local only · nothing leaves your machine` (11px dim).

## How it behaves

- First run seeds 12 demo stories and enters onboarding in the rail:
  `j`/`k` move, `m` = "more like this", `f` = "less like this"; after 5
  ratings `enter` finishes, unhides everything not rated, and flashes
  `queue reordered from your ratings`.
- Rail keys: `j`/`k` move, `enter` opens the story in the center (a new
  `read: <title>` tab, or `tab.select` back onto the existing one), `v`
  toggles the saved view, `c` toggles the capture card, `z` cycles the rail
  between expanded (300px) and compact (44px); `[` hides/shows the whole
  sidebar and `/` refocuses it. Nothing else — the rail deliberately keeps
  only these keys.
- Reader keys: `h` marks read, `m`/`f` rate, `u` undo, `w` toggles the
  why-receipt, `a` toggles the agent pane, `n`/`x` dismiss and advance to the
  next ranked story, `q`/`escape` close the tab. With nothing open, `enter`
  falls through to the top of the rail.
- Reader copies never write the store: their mark/rate/skip/undo actions go
  over shared state to the rail copy, which owns every ledger write (so the
  CAS writes never race). Feed polling is guarded to one owner — the reader
  role, else the first instance — via a shared timestamp; duplicates skip.
- Capture: submit in the URL field (or `fetch`) runs
  `npx -y defuddle parse <url> --json --markdown` and falls back to a
  strip-tags fetch; the feed field subscribes and re-polls every 6h (15-minute
  check timer, up to 3 new items per source per poll, toast when items land).
- Agent pane (`a` in the reader): picks the first installed agent,
  `pane.split` right, waits for the pane, then `hc send`s
  `ask about this story: "<title>" (<url>)`. Pressing `a` again closes it.
  Narrow pane (under 560px): no split — the inline why-receipt is the
  fallback and the agent strip truncates with `…`.
- Learning: ledger events weigh the tokenized title+topic terms and the
  source. keep/mark +1, rate +2/-2, skip -1; an `undo` voids the event it
  undid. Term contribution is capped at ±1.5, source at ±1.0; stories younger
  than 14 days get up to +0.5 freshness. The receipt shows the top three
  parts with their kept/skipped counts.
- Every mod command is also scriptable: `frontpage.<key>` (from keys.json or
  `herdr-app do frontpage.m`) feeds the same key handler. Aliases:
  `more`→m, `less`→f, `why`→w, `open`/`d`→enter, `dismiss`→x, `save`→S,
  `saved`→v, `undo`→u, `capture`→c, `agent`→a, `mark`→h, `next`→n,
  `close`→q, `back`→escape, `up`→k, `down`→j, `focusrail`→focus the rail.

## Built from

- `layouts/frontpage.json`: a `column` root (theme `ink`) with a `body` row —
  a `sidebar` column (300px, min 40, max 480, divider) holding the `rail`
  block (`mod: frontpage`, `props: {role: "rail"}`), and a `work` column
  holding the native `tabs` block (30px) and the `reader` block
  (`tab: "active"`, pane cards with focus borders) — plus a full-width
  `status` block (24px, `mod: frontpage-status`) under it.
- `keys.json`: `layout:frontpage` section — `[` → `layout.toggle:sidebar`,
  `/` → `frontpage.focusrail`.
- `mods/frontpage-status/` — one-file bar mod. Reads
  `shared("frontpage:counts")` (`{queue, saved, events, onboarded}`) and
  renders counts plus the `[/] rail` hint.
- `mods/frontpage/` — the app. `main.js` (one View, two roles), `store.js`
  (JSON store), `rank.js` (weights + rank + why-receipts),
  `data/demo/demo.json` (12 demo stories).
  - herdr imports: `theme`, `exec`, `hc`, `run`, `panes`, `spaces`,
    `knownAgents`, `setShared`, `shared`, `notify`, `nextCommand`,
    `writeTextFile`, `props`, `focused`. gpui-kit/gpui-base: `View`, `div`,
    `v_flex`, `h_flex`, `InputState`, `Input`, `TextView`
    (`TextView.markdown` for story bodies).
  - Commands run: `tab.new`/`tab.select` (reader tabs), `tab.close`,
    `pane.focus` (the `/` key), `pane.split`/`pane.close` (agent pane),
    `layout.resize`/`layout.toggle` (rail z/`[`), `hc` send (prefill),
    `exec("npx", ["-y", "defuddle", "parse", url, "--json", "--markdown"])`
    for capture. `fetch()` for feed XML and the defuddle fallback.
  - Storage lives under `mods/frontpage/data/`: `snapshot.json` (full state,
    rewritten on compaction) plus `ledger.jsonl` (append-only events, folded
    into the snapshot and truncated on compaction). Reads respect the 1 MiB
    `readTextFile` cap (story text trimmed to 20k chars per story, oldest
    read/dismissed text dropped first). Writes are fire-and-forget with a
    last-writer-wins retry so a stalled app file op never freezes the UI;
    `load()` reconciles snapshot + ledger on start. A missing/empty store
    seeds from `demo.json` for onboarding.

## Watch out

- All store writes belong to the rail copy; readers act through
  `shared("frontpage:cmd")`, applied on the rail's next render. If you delete
  the rail (layout without the sidebar), reader actions have nowhere to land.
- The rail's `z` cycle relies on its measured width (`on_size_change`), so it
  needs a frame before `z` works after a layout switch.
- Mod commands must be single tokens; `herdr-app do frontpage.enter` is
  rejected — use `frontpage.d` (or the alias names above). `frontpage.p`
  writes a UI-structure dump to
  `mods/frontpage/data/debug-<role>-<n>.json` (rendered rows with Q labels,
  score, selection, why-receipt; the reader's open story; counts) for
  scripted verification.
- `nextCommand()` delivery is fire-and-forget: `herdr-app do` answers `ok`
  even when the mod is busy. Space commands ~1–2s apart when scripting.
- Capture needs `npx` on PATH and network access; the defuddle path is
  tried first and a crude strip-tags fetch is the fallback. Feed parsing is a
  regex over RSS/Atom XML (`<item>`/`<entry>`, `<title>`/`<link>`), 20 entries
  max, no OPML, no auth feeds.
- Story text is capped at 20k chars and dropped entirely (oldest first) if the
  snapshot would pass ~900 KB; those rows show
  `(text dropped to save space — open the url)`.
- The undo stack is in-memory only (last 20 actions) — an app restart clears
  it; the ledger keeps the history but undo after restart is not wired.
- Onboarding only triggers when stories exist but `onboarded` is false; if you
  delete your store, the demo seed comes back with it.

## Done when

- `herdr-app check mods/frontpage` and `herdr-app check mods/frontpage-status`
  both pass.
- `herdr-app do layout.switch --name frontpage` shows the rail, the tab bar
  and the status bar with no entry in `herdr-app status` errors, and the
  `[/] rail` hint is present on every screen.
- `herdr-app do frontpage.p` dumps rows labeled `Q1`.. with `role: "rail"`;
  opening a story (`enter`) creates a `read: …` tab whose reader dump has
  `role: "reader"` and the story's why-receipt; a reader with no story falls
  through to the top of the queue.
- On a fresh store: the queue lists the 12 demo stories with the onboarding
  footer; rating 5 stories (`m`/`f`) reorders the queue.
- Compacting the sidebar (`z`) keeps at least 3 queue rows plus a
  `queue: N more` line; `c` opens the capture card without removing the rows
  above it.
- Capture: paste a public URL, `fetch` shows a result card via defuddle, and
  `queue it` puts the story in the queue with a detected topic.
