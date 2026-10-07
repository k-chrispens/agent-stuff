---
name: figure-design
description: "Whiteboard-style design of conceptual and schematic figures: paper Fig. 1 overviews, talk diagrams, graphical abstracts, posters, explainers. Use when making or iterating on a conceptual or diagrammatic figure, when handed a whiteboard or paper sketch of one, or when asked for figure concepts. Not for plotting data alone or rendering a molecule alone."
---

# Figure Design

A figure is designed in a conversation, the way a whiteboard session works. There's one slow, divergent turn of ASCII concepts, then a first draft, then many fast small turns. After the first draft, your job is speed and precision, not more design thinking, unless the user asks for it.

## Session

```
figures/<slug>/      slug in kebab-case
  brief.md           the memory across days; reread it whenever you resume
  v01.svg ...        one version per user turn
  src/               scripts that generate geometry
  assets/            PyMOL renders and other rasters linked from the SVG
  .look/             your rasters (the preview ignores them)
```

`brief.md`:

```
# <slug>
claim:    one sentence
venue:    e.g. Nature double column, 183 x 70 mm
concept:  the chosen ASCII sketch and its key
labels:   element -> meaning (the words the figure will carry later)
log:      vNN - what changed and why, one line each
```

After writing v01, start the preview in the background and give the user the URL:

```bash
python3 <skill-dir>/tools/preview.py figures/<slug> --open
```

It shows the newest `vNN.svg` or `vNN.png` and reloads on change. Click a thumbnail to pin it, shift-click to compare two, and press Esc to return to latest. If the user can't open a local browser tab (a remote or headless session), attach or send the `.look/vNN.png` each turn instead.

## Turn 1: whiteboard, no drawing

Reply in chat with these four things, then stop and wait.

1. **Sketch reading.** If the user gave a sketch, transcribe it to ASCII and say what each element is. For each ambiguous mark, say how you read it. If you override something the user drew (a color, a shape, a mark you treat as noise), say so. The sketch's words, kept verbatim, become the first label list.
2. **Claim.** The one sentence a reader should take from the figure without the caption. Add the venue and final size.
3. **3–5 concepts as ASCII sketches.** With a sketch, concept A is the sketch itself, cleaned up. The other concepts must differ from it in structure (metaphor, spatial axis or decomposition), not just style. Each concept gets a sketch of at most 72×24, a glyph key, and one line on what it argues and what it costs.
4. **Recommendation.** One line.

Reserved ASCII glyphs:

- `:` gray scaffold
- `-->` flow
- `[ ]` a panel
- `( )` with `. . .` a zoom lens and its leaders back to the source
- `A B C` colored elements
- `a b c` uncolored named elements, such as an ink-gray foil

Use anything else freely, as long as it's in the key. Hues and words go only in the key, never in the sketch. `references/exemplars.md` has a worked example (Muir et al. Fig. 1A).

## First draft (v01)

v01 is the session's biggest design act, so think here. Choose the hue assignment, what is scaffold and what is argument, how to draw the domain objects, and the canvas. Size the canvas to include room for the labels on the label list, so the labeling pass doesn't have to grow it. Write the claim, concept and labels to `brief.md`, draw v01, then run the look loop below. In the reply, list the decisions you made in a few lines so the user can veto any of them.

## After v01: iterate fast

Each user turn produces exactly one new version, `vNN`. Batch small requests into it.

1. Apply the change and write `vNN`.
2. Run the look loop: `python3 <skill-dir>/tools/look.py figures/<slug>/vNN.svg`, then Read the PNG it prints. Use `--crop x,y,w,h` (in viewBox units) to inspect fine detail at full resolution. Fix objective defects by overwriting `vNN`, and repeat until the lint is clean and nothing is visibly wrong. Objective defects are anything the lint flags, overlaps, clipping, near-misses in alignment, uneven gaps in repeated units, arrowheads that miss their targets, marks escaping the shape that should contain them, and accidental shapes formed between neighbors (Tufte's 1 + 1 = 3).
3. Add a line to the `brief.md` log.
4. Reply in two lines: what changed. Add one line per decision or trade-off the user needs to weigh in on.

No design essays, no unrequested redesigns, no re-ideation. Every five versions or so, check the figure against the claim in `brief.md`, and say one line only if it has drifted.

Some requests change the structure, not a part ("make it one story", "this should be a comparison"). Treat those as "options for": give 2–3 ASCII options, then stop.

User phrases that change the mode:

- "Step back" or "critique": now think deeply. Critique against the claim, the venue and the rules below, and offer at most three changes.
- "Go back to vN" or "vN with the X from vM": build the next version from those files.
- "Options for <part>": a mini whiteboard turn in ASCII for that part only.
- "Labels": the labeling pass. "Export": the final pass.

## Drafting rules

1. **No text** in drafts: no titles, labels, panel letters, axis names, numbers or placeholders. Meaning lives in the label list in `brief.md`. Some distinctions really do need a word eventually (which panel is "ours"); those wait for the labeling pass. But if a reader holding the label list still can't follow the figure, the structure is wrong, and you should fix the structure.
2. **Gray scaffold, colored argument.** Build everything neutral first, then spend hue only on what the claim is about, usually one to three hues. The foil, meaning the baseline or old way the figure argues against, is drawn in ink gray. It keeps the same stroke weight as the elements it is compared with, so color alone carries the difference.
3. **One hue means one thing** across every panel. Category is hue. A continuous variable within a category is lightness.
4. **Lines need 3:1 contrast on white.** Pale palette colors are fills. A line in a pale hue uses that hue's line shade from `references/palette.md`. Warm hues go muddy when shaded, so give line-based arguments a cool hue.
5. **Repeated things are identical**: same size, viewpoint, stroke and spacing. Only the variable differs (small multiples).
6. **Reading order follows the argument.** A flow has one direction, left to right or top to bottom.
7. **Use the simplest glyph that still reads as the thing, and not as some other thing.** A protein is a blob until its shape matters. A single smooth outline reads as a surface, not as a density map. Delete anything that isn't load-bearing.
8. **Span scales with zoom lenses**: a dashed circle with dotted leaders back to the source region, not extra panels.
9. **At most three stroke weights**, roughly 0.5, 1 and 2 pt at final size: hairline for context, regular for structure, heavy for the lines being compared. The lint reports widths in pt.
10. **Align to a grid and keep gaps equal.** Whitespace is structure.

## Venue

Draw at final physical size (`width`/`height` in mm or in, with a matching `viewBox`) so that stroke weights and spacing are real. Height is whatever the claim needs plus room for labels; record it in `brief.md`.

- **Paper**: the journal's column width (Nature: 89 mm single, 183 mm double; check the author guide for others). Readers study a paper figure for minutes, so it can be dense.
- **Slide**: 16:9 (13.33 × 7.5 in), one idea. Builds are `<g id="step1">`, `<g id="step2">`, and so on, revealed in order.
- **Poster**: read from 1–2 m away. Each panel must land in about 10 s.
- **Explainer**: fluid width. If the idea needs interaction, see below.

## Medium, per panel

- **Hand-written SVG** is the default, for schematics, flows and abstract shapes. Use the `svg` skill's portable profile: `viewBox` plus `width`/`height`, presentation attributes, no scripts, no `foreignObject`, no external URLs. Clip paths, masks and gradients are fine.
- **Generated geometry** is for shapes computed from math or data: a landscape surface, density contours, curves, an embedding. Put the script in `src/` and have it write the shapes as paths inside the version SVG, so the lint and the look loop see them. Don't link a matplotlib SVG as an image: its colors and widths escape the lint.
- **PyMOL** is for real molecules. Use the `pymol-pml-scripting` skill. Ray-trace with `set ray_opaque_background, 0`, save into `assets/`, and link the PNG with `<image href="assets/...">`. Both tools resolve relative links.
- **TikZ** only if the user's pipeline is LaTeX. Convert with `pdftocairo -svg`.
- **Mermaid** only for a quick check of a graph's topology, never for the figure itself.

## Labeling pass (on request only)

Work through the label list. Each entry is either placed on the figure or assigned to the caption, and you say which. Keep the user's wording, and flag any word you'd change, such as a method name you don't know. Put labels directly on or beside the thing they name; don't use a legend when a direct label fits. Use sans-serif at the venue's sizes. Nature, for example, uses 5–7 pt text and 8 pt bold lowercase panel letters, but check the author guide; slides and posters need larger type. The caption can also carry words, in text color-matched to the marks (the Distill move). From this pass on, the lint's text count is expected.

## Export

Embed or ship the linked assets, validate with the `svg` skill's `tools/validate.sh`, and produce a PDF if the venue needs one (`rsvg-convert -f pdf` or Inkscape). Stills exported by `interactive-figures` already embed their images and pass that validator; the only warning left is for embedded rasters.

## Interactive figures

When the figure should respond to the reader, or the user asks for an explorable, interactive or web version, switch to the `interactive-figures` skill.

- **Turn 1:** it still runs the whiteboard turn described here. It adds a gate (is interaction worth it?), an inputs check, and a spec of controls and named states.
- **Drafting rules:** the rules above apply to its stage, with two changes. Controls carry short labels from v01, and UI chrome is ink gray.
- **Back to print:** its `check.py --stills` exports each named state as an SVG that has been verified against the screen and linted with this skill's palette. Use those stills as the panels of the static version, usually small multiples of the named states.

If `interactive-figures` isn't installed, say so and ask how to proceed.

## Tools

- `tools/preview.py DIR [--port 8765] [--open]`: live-reload viewer, Python standard library only.
- `tools/look.py FILE.svg [OUT.png] [--long-side 1600] [--crop x,y,w,h]`: writes `.look/<stem>.png` (or `<stem>-crop-x_y_w_h.png`) and prints a lint. The lint covers the text count, the colors used, off-palette colors (tints, shades and grays count as on-palette), chromatic strokes under 3:1, and stroke widths in pt at final size. Rasterizer order: rsvg-convert, Inkscape, cairosvg, Chrome. Force one with `LOOK_BACKEND=rsvg|inkscape|cairosvg|chrome`. On the Chrome path, the image is cropped to the figure's bounds when Pillow is installed.

## References

- `references/exemplars.md`: what to take from Tufte, Bret Victor, Distill, and Muir et al. 2025 Fig. 1, with an ASCII worked example.
- `references/palette.md`: the user's pymolrc colors, with fills, line shades and roles.
