# Palette

Source: Karson's `~/.pymolrc`. The `good_*` set is from the RFdiffusion paper (credit Sam Pellock). PyMOL renders and flat schematics use the same names, so a protein and its abstract stand-in read as one object.

`tools/look.py` parses every hex code in this file. A color counts as on-palette if it is one of these codes, a tint of one (mixed toward white), or a shade of one (mixed toward black). Every neutral gray is on-palette.

## Hues

Contrast is the WCAG ratio against white. A thin line or small mark needs at least 3:1, so each hue lists the lightest shade that reaches 3:1. Any shade darker than that also works. Shading is also roughly what PyMOL's lighting does to a cartoon, so a line shade sits naturally beside a rendered protein of the same hue.

| name | fill | contrast | line shade | black mixed in |
|---|---|---|---|---|
| good_darkblue | #4b5faa | 6.0 | #4b5faa | 0 |
| good_blue | #6686c5 | 3.6 | #6686c5 | 0 |
| good_lightblue | #9596c6 | 2.8 | #8f90be | 0.04 |
| good_teal | #4fb9af | 2.4 | #46a39a | 0.12 |
| good_purple | #d59ab5 | 2.3 | #b9869d | 0.13 |
| other_blue | #9ab5d5 | 2.1 | #8096b1 | 0.17 |
| good_pink | #ffacb7 | 1.8 | #c2838b | 0.24 |
| good_green | #b5d59a | 1.6 | #849b70 | 0.27 |
| good_melon | #ffc6b2 | 1.5 | #b28b7d | 0.30 |
| good_navaho | #ffe0ac | 1.3 | #a69270 | 0.35 |

The warm hues (pink, melon, navaho) turn muddy when shaded, so keep them as fills. If the argument is made of lines (paths, sticks, trajectories), give it a cool hue. Leave out `bad_watermelon`: the pymolrc defines it, but it is named "bad".

## Neutrals

The scaffold is neutral; hue goes only on what the claim is about. The single model, baseline or "old way" a figure argues against is scaffold too: draw it in ink gray, not a hue.

| name | hex | use |
|---|---|---|
| paper | #ffffff | background |
| gray95 | #f2f2f2 | faint scaffold fills |
| good_gray | #dcdcdc | scaffold fills, inactive elements |
| gray65 | #a6a6a6 | scaffold hairlines (wireframes, grids, contours) |
| gray50 | #7f7f7f | secondary strokes |
| gray30 | #4d4d4d | ink: outlines, the foil, PyMOL's `ray_trace_color` |

## Rules

1. One hue means one thing across every panel, and ideally across the whole paper.
2. Category is hue. A continuous variable within a category is lightness, using tints for fills and shades for lines. Steps must be ordered and clearly visible. In a conceptual figure they need not be proportional, but if you map by rank instead of value, say so in `brief.md`.
3. Pale fills that touch need a gray30 outline or a white gap between them.
4. Next to a PyMOL render, a flat fill of the same hex looks paler than the lit protein. Match the render's mid-tone with a shade instead. This is uncalibrated: record the measured shade here after the first real composite.
5. Never let red versus green be the only thing distinguishing two elements.
