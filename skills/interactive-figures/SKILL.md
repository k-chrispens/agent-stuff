---
name: interactive-figures
description: "Design and build a single interactive scientific figure (Distill-style explorable, interactive diagram, molecular or density-map viewer with controls) as one self-contained HTML file with static stills for papers. Use when a figure should respond to the reader, or when asked for an explorable or interactive version of a figure. Extends figure-design; not for whole articles or dashboards."
---

# Interactive Figures

This skill extends `figure-design`. Read that skill's SKILL.md first: its whiteboard turn, drafting rules, palette, one-version-per-turn loop and `brief.md` all apply here, with the changes listed below. This skill adds:

- a gate that decides whether the figure should be interactive at all;
- an interaction spec;
- a build contract;
- tools that check, bundle and export the figure.

Readers use interaction when the argument depends on it and almost never otherwise (evidence in `references/design.md`). So design the figure static first, and treat each control as an addition that must earn its place.

## Gate: should it be interactive?

Decide this in turn 1, before the concepts. A figure earns interaction only when the reader has a question that a control answers better than a picture can. Typical questions:

- what happens as a parameter changes
- which model fits
- what the structure looks like from another angle or at another contour
- what the reader predicts before seeing the answer

Make it static instead when any of these hold:

- one takeaway fits in 2–4 small multiples;
- the task is precise comparison (small multiples beat toggles and animation);
- there is no model or process to manipulate, so the only interaction would be filtering;
- the audience will skim (print, poster, social media); a talk is fine, because the presenter drives the figure;
- the figure cannot be made keyboard-accessible.

Where a static figure goes:

- conceptual figures → `figure-design`
- data plots → the `dataviz` skill if available, otherwise matplotlib

An A/B toggle in place is fine for spotting one local difference (blink comparison); comparing magnitudes across options needs small multiples. If the user asked for interactive but the gate says static, say so in one or two sentences, recommend the static figure, and offer the interactive version as one concept. Do not refuse.

## Turn 1: whiteboard plus interaction spec

Run `figure-design`'s turn 1, with these changes:

- **Open with the gate verdict**, one or two sentences.
- **Add an inputs item.** Say what data the figure needs and where it comes from. Flag simulated data, and flag circular data, such as a map calculated from the model it is meant to support.
- **Give the full spec only for the recommended concept:**
  - **controls:** `control -> the question it answers -> what changes -> what to notice`, at most three controls;
  - **named states:** 2–4 in story order, `default` first. These become arrow-key steps in a talk, checker screenshots, and the paper's stills. Sketch a named state in ASCII only if it differs structurally from the concept's sketch. Otherwise describe it in one line. State names go outside the code fence. For 3D scenes, a rough ASCII sketch plus a one-line description of the viewpoint is enough for each concept.
- **Every other concept gets one line naming its controls.**

Pick idioms from `references/idioms.md`, then stop and wait.

## Session

```
figures/<slug>/
  brief.md          figure-design's brief, plus `data:`, `controls:` and `states:` sections
  v01.html ...      one version per user turn
  assets/           data the figure loads (mmCIF, maps, JSON); every file ships in the bundle
  src/              scripts that prepare assets (cropping maps, precomputing)
  dist/<slug>.html  bundled offline file
  stills/           per-state PNG (and SVG) for papers
  .look/            check.py screenshots: .look/vNN/<viewport>-<state>.png
```

Assets are shared by every version. If you change an asset in a way that would alter earlier versions, write the new data under a new file name instead.

After v01, start the preview and give the user its URL:

```bash
python3 <skill-dir>/tools/preview.py figures/<slug> --open
```

The preview shows the newest `vNN.html` and keeps the reader's state, and in Mol\* figures the camera, across reloads and new versions. Click a thumbnail to pin a version, shift-click to compare two, and press Esc to return to the latest. If the user has no local browser, show `.look/vNN/desktop-default.png`.

## The contract

Start every figure by copying `templates/svg.html` (D3 v7 and SVG) or `templates/molstar.html` (Mol\* and MolViewSpec). Each template is a working example: replace its content and keep its structure. To run the Mol\* template as-is, copy `templates/example/*.cif` and `templates/example/map.ccp4` into `assets/`; `templates/example/make_data.py` made those files.

- **`STATES`**: named states, `default` first. Every state lists every key, and every value is a number, string or boolean of the same type as in `default`; there is no `null`, so use a sentinel (`-1`, `''`) for "none". Order matters: arrow keys step through the states in this order.
- **`LIMITS`** (optional): `{ key: [min, max] }` for numbers and `{ key: [...allowed] }` for strings. Values arriving through the URL hash are clamped or rejected against it. Without it, a string is accepted only if some named state uses it.
- **`id="figure"`** on the `<figure>`, and `role="img"` on the stage: the tools depend on both.
- **`init()`**: build once and wire each control to `figure.set(patch)`.
- **`render(s)`**: draw state `s` completely at the current size, never relying on the previous state.
  - Layout may depend on width (for example, a different viewBox below 560 px). The contract re-renders when the width changes. Nothing in the stage may depend on viewport height (`vh`), or an embedding iframe that sizes itself to the content never settles.
  - Return a promise only for asynchronous work, such as a Mol\* load. Don't make `render` wait for transitions.
  - Animate only discrete changes. The template's `animate` flag shows the pattern, so sliders stay instant.
- **`sync(s)`**: make the controls show `s`.
- **The contract block** at the bottom: copy it exactly. It provides:
  - the URL hash: type-checked against `default`, validated against `LIMITS` (values a named state uses, such as sentinels, are always accepted), throttled, flushed on page exit, and skipped silently where browsers forbid it (sandboxed iframes);
  - render coalescing;
  - arrow keys, ignored when a modifier key is held or an input has focus;
  - re-render on width changes, and no render before `init()` finishes;
  - `?talk` full-screen mode;
  - iframe auto-height;
  - `assetUrl`, `FAST` and `reducedMotion`.
- **The camera** in Mol\* figures is view state, not figure state. The template keeps it in `sessionStorage`. A named state that needs a particular view sets it explicitly; see `references/molstar.md`.

Data and libraries:

- Load every file through `assetUrl('assets/...')`.
- Compute what the figure shows from data or from a stated model. Illustrative numbers (example logits, simulated profiles) are fine if `brief.md` and later the caption say so.
- Load libraries with classic `<script src="https://cdn.jsdelivr.net/npm/<lib>@<exact version>/...">` tags using UMD builds. D3, Observable Plot, JSXGraph and Mol\* all ship one. Never `import` from a CDN: `bundle.py` can only inline classic scripts.
- Use system fonts.
- In SVG figures, put `class="figure-svg"` on the drawing so stills export cleanly.

## Stack

- **SVG + D3 v7** is the default. Above about 2,000 marks, use Canvas inside the stage, with the SVG (`class="figure-svg"`, a direct child of `.stage`) on top for overlays; stills composite the canvas in.
- **Mol\*** for molecules and density, driven by MolViewSpec (`references/molstar.md`).
- **JSXGraph** for draggable geometry.
- **Observable Plot** for chart-shaped figures.
- **Avoid** anything that needs a build step or a server: Svelte, React, Observable Framework, Quarto OJS, marimo WASM.

## After v01: iterate fast

Follow `figure-design`'s loop, with `check.py` in place of `look.py`:

```bash
uv run <skill-dir>/tools/check.py figures/<slug>/vNN.html --viewports desktop
```

It renders every named state, lints the default state's SVG against the palette (lint findings are printed, never failures), and reports:

- console errors (with the URL of any failed request) and contract violations;
- controls without an accessible name or not reachable by Tab;
- horizontal overflow;
- touch targets under 24 px on mobile.

Read the PNG of every state, not just the default: a bug that appears only in one state is invisible elsewhere. Then fix objective defects by overwriting `vNN`. The lint can't see inside a Mol\* canvas, so check 3D colors, contrast and labels by eye. For fine SVG detail, zoom the default state's SVG (`.look/vNN/default.svg`) with `figure-design`'s `look.py --crop x,y,w,h`. `check.py` passing means the plumbing works, not that the figure is right. Drop `--viewports` (meaning desktop, mobile and slide) every few versions and before export. After the labeling pass, add `--labeled`: the text count stops warning, and a missing figure or stage `aria-label`, `<title>` or caption becomes a failure.

Requests that change the figure's structure ("make it one story", "more visceral" when that means a new view) go through `figure-design`'s options turn first.

## Changes to figure-design's drafting rules

- **No text in the stage**, as in `figure-design`. Controls are UI, not figure, so they carry short visible labels ("single", "ensemble", "contour") from v01. Without labels a draft can't be reviewed.
- **UI color is ink gray.** Hue belongs only to the argument in the stage, so one hue keeps one meaning.
- **Contrast:** marks that carry the claim need 3:1 contrast. Scaffold such as a density mesh, grids or wireframes may be lighter, as `figure-design`'s palette allows.
- **Size:** the HTML is fluid. `figure-design`'s physical sizes apply to the stills. Journals don't host interactives, so for a paper the HTML goes in the supplement or on a website.

## Interaction rules

1. **The default state carries the claim.** A reader who never touches the figure still gets the point.
2. **Every control answers a question in the brief.** At most three controls. Dragging to rotate a 3D view doesn't count, but its keyboard alternative does.
3. **Hover is for detail only.** Anything hover reveals also appears on focus and on tap.
4. **Feedback is immediate.** Continuous controls render in under about 100 ms. If that's impossible, use discrete steps.
5. **Show the mechanism, not just the output.** Linked views change together.
6. **Concrete, then varying, then everything.** Show one case, then one parameter varying, then the whole space.
7. **Predict, then reveal** for surprising results. This is the best-evidenced learning effect.
8. **The reader controls time.** Any animation has pause and step. Nothing plays on its own for more than 2 s. Respect `reducedMotion()`.
9. **Accessibility floor:**
   - keyboard reach;
   - a non-drag alternative to every drag (for Mol\* rotation, named views; see `references/molstar.md`);
   - `role="img"` with a label on the stage;
   - after labeling, a caption that states the claim and says what to try.
10. **Mobile has no hover.** Targets are at least 24 px.

## Labeling pass (on request)

Follow `figure-design`'s labeling pass, and add:

- an inline instruction in the caption: one sentence per control, or one sentence for all of them;
- `aria-label`s on the stage and the figure that state the claim;
- a `<title>`.

Reply with a table: label → placed on the figure, on a control, or in the caption.

## Export (on request)

Export doesn't create a new version; it packages the current one. A data caveat (simulated or circular data) stays in the caption unless the user removes it after seeing it.

1. Run `python3 <skill-dir>/tools/bundle.py figures/<slug>/vNN.html`, which writes `dist/<slug>.html` with the CDN libraries and `assets/` inlined. It must exit 0.
2. Run `uv run <skill-dir>/tools/check.py figures/<slug>/dist/<slug>.html --offline --labeled`. It must pass. This proves the file works with no network. Screenshots go to `.look/dist-<slug>/`, not into `dist/`.
3. Run `uv run <skill-dir>/tools/check.py figures/<slug>/vNN.html --stills figures/<slug>/stills --labeled --width-mm <column width>`. This writes full-quality PNGs and, for SVG figures, SVGs from the desktop layout, one per `figure-svg` element.
   - The SVGs carry computed styles (including `display:none` and color alpha), transforms (with CSS transform-origin), gradients, markers, clips, masks and inlined images. Canvases under the stage are composited in as images. The SVGs are linted at the given physical width.
   - Each SVG is rendered again and compared, in color and at full resolution, with the screenshot of the live figure. If more than 0.5% of the inked pixels differ, the export lost something: open the PNG and the SVG side by side to see what.
   - The SVGs pass the `svg` skill's `tools/validate.sh`: version, xlink and, after labeling, `<title>`/`<desc>` from the figure's and stage's `aria-label`s. The only warning left is for embedded rasters, such as a canvas or picture.
   - Add `--viewports mobile` for phone-layout stills.
   - The stills feed `figure-design` when the paper needs a static version, usually small multiples of the named states.

Reply with the files and the embed snippet for the venue:

- **Website or blog.** This embed sizes itself to the figure on every screen:
  ```html
  <iframe class="figure" src="<slug>.html" style="width:100%;border:0" title="<the claim, one sentence>"></iframe>
  <script>addEventListener('message', e => { for (const f of document.querySelectorAll('iframe.figure')) if (f.contentWindow === e.source && e.data && e.data.figureHeight > 0) f.style.height = Math.min(e.data.figureHeight, 4000) + 'px'; });</script>
  ```
- **Talk:** open `dist/<slug>.html?talk` full screen. Arrow keys step through the named states. Click the background first if a slider has focus.
- **Paper supplement:** the dist file plus the stills.
- **Claude artifact or a sandboxed embed** (notebooks, course sites): the dist file as-is. The URL hash may not update there, but the figure works.

## Tools

- `tools/preview.py DIR [--port 8775] [--open]`: live-reload viewer. Standard library only.
- `tools/check.py FILE.html [--viewports desktop,mobile,slide] [--offline] [--stills DIR] [--width-mm MM] [--labeled]`: a `uv run` script that brings its own Playwright and Pillow.
  - Browser: `$CHROME` if set, then Playwright's Chromium, then installed Chrome. If none works, run `uvx playwright install chromium`.
  - It always uses software WebGL, so 3D rendering is the same on every machine (font rendering still varies).
  - The lint comes from `figure-design`, which must be installed beside this skill; `check.py` says so if it isn't.
  - It loads the figure with `?fast` (figures skip expensive progressive rendering) and the slide viewport with `?talk`. Stills render at full quality.
  - It serves CDN requests from the bundle cache when it can, except with `--offline`, which refuses everything off localhost.
- `tools/bundle.py FILE.html [OUT.html]`: inlines classic scripts and stylesheets (from a CDN or local files, with single or double quotes), plus `assets/`, and strips source maps.
  - It exits 1 on references the bundle can't satisfy:
    - `type="module"` scripts and ES-module imports;
    - `fetch`, `d3.json`/`d3.csv`, and Workers loading URLs;
    - web fonts;
    - protocol-relative `url(//…)`;
    - relative `src`/`href` outside `assetUrl()`, such as `<img src="assets/...">`.
  - It removes HTML comments before inlining, so commented-out tags aren't downloaded. It ignores citation links (`<a href>`) and comments that start a line.
  - Its cache is `~/.cache/interactive-figures/<host>/<path>`. Save a file there by hand to work offline.

## References

- `references/design.md`: the rules with their evidence, tensions between sources, when not to make a figure interactive, and credits.
- `references/idioms.md`: interaction idioms, when to use each, and how each maps onto the contract.
- `references/molstar.md`: Mol\* and MolViewSpec recipes and gotchas, covering density, cropping, conformers, camera, labels and keyboard access.
