# herdr-frontpage

A stand-alone Herdr layout package: a Terminal-style personal reading queue
that learns from your feedback and explains itself. Three pages — Queue,
Reading, Capture — marks with undo, `w` why-receipts, an optional agent pane
(`a`), feed subscriptions, and a first-run onboarding that rates five demo
stories and shows the queue reorder.

## Install

Copy into your Herdr home:

    layouts/frontpage.json  -> ~/.config/herdr-app/layouts/
    mods/frontpage/         -> ~/.config/herdr-app/mods/
    mods/frontpage-status/  -> ~/.config/herdr-app/mods/

Then check and switch:

    herdr-app check ~/.config/herdr-app/mods/frontpage
    herdr-app check ~/.config/herdr-app/mods/frontpage-status
    herdr-app do layout.switch --name frontpage

Or install from herdr.dev/layouts (`justEstif/herdr-frontpage`).

## Prerequisites

Extraction uses [defuddle](https://github.com/kepano/defuddle) via
`npx -y defuddle parse <url> --json --markdown` — no global install needed,
but Node/npx must be on PATH. Without it, Capture falls back to a crude
fetch-and-strip-tags.

## Privacy

Everything stays on your machine: the store is local JSON under the mod's
`data/` folder and nothing leaves the app — unless you open an agent pane
(`a`), which sends the story's URL and text to whichever agent you run, as a
prefilled prompt you can edit before sending.
