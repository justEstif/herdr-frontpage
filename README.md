# herdr-frontpage

A stand-alone Herdr layout package: a Terminal-style personal reading queue
that learns from your feedback and explains itself, shaped like Herdr's own
window — a collapsible left rail (queue + capture), a center reader where
every story opens as its own tab, and a status bar. Marks with undo, `w`
why-receipts, an optional agent pane (`a`), feed subscriptions, and a
first-run onboarding that rates five demo stories and shows the queue reorder.

## Install (as a layout)

Copy the package into your Herdr home, check both mods, and switch:

    cp -r mods/frontpage mods/frontpage-status ~/.config/herdr-app/mods/
    cp layouts/frontpage.json ~/.config/herdr-app/layouts/
    cp keys.json ~/.config/herdr-app/keys.json   # merges the [/] rail keys
    herdr-app check ~/.config/herdr-app/mods/frontpage
    herdr-app check ~/.config/herdr-app/mods/frontpage-status
    herdr-app do layout.switch --name frontpage

The layout gives you: the left rail (300px, `z` compacts it to 44, `[` hides
it, `/` refocuses it), Herdr's native tab bar with a `read: …` tab per opened
story, and the status bar with live counts and the persistent `[/] rail` hint.
`ctrl-shift-l` cycles back to your previous layout. The mods never switch
layouts themselves.

You can also open a lone reader tab without the layout:

    herdr-app do tab.new --name frontpage --mod frontpage --props '{"role":"reader"}'

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
