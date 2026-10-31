# herdr-frontpage

A stand-alone Herdr layout package: a Terminal-style personal reading queue
that learns from your feedback and explains itself. Three pages — Queue,
Reading, Capture — marks with undo, `w` why-receipts, an optional agent pane
(`a`), feed subscriptions, and a first-run onboarding that rates five demo
stories and shows the queue reorder.

## Install (as a tab — the default)

Copy the mods into your Herdr home, check them, and open a frontpage tab:

    cp -r mods/frontpage mods/frontpage-status ~/.config/herdr-app/mods/
    herdr-app check ~/.config/herdr-app/mods/frontpage
    herdr-app do tab.new --name frontpage --mod frontpage

In tab mode the mod is self-sufficient: its own footer carries the day
streak, event count and locality note. `frontpage-status` is only used by
the optional fullscreen layout below, but it's harmless to copy.

### Optional: fullscreen layout variant

If you prefer the whole window:

    cp layouts/frontpage.json ~/.config/herdr-app/layouts/
    herdr-app do layout.switch --name frontpage

`layouts/frontpage.json` shows the `frontpage` mod full-window with the
`frontpage-status` strip across the top (26px). The mod never switches
layouts itself; `ctrl-shift-l` cycles back to your previous layout.

Or install from herdr.dev/layouts (`justEstif/herdr-frontpage`).

## Prerequisites

Extraction uses [defuddle](https://github.com/kepano/defuddle) via
`npx -y defuddle parse <url> --json --markdown` — no global install needed,
but Node/npx must be on PATH. Without it, Capture falls back to a crude
fetch-and-strip-tags.

## Privacy

Everything stays on your machine: the store is local JSON under the mod's
`data/` folder and nothing leaves the app — unless you open an agent pane
(`a`), which sends the story's title and URL to whichever agent you run, as
a prefilled prompt you can edit before sending.
