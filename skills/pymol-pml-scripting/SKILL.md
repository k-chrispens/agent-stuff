---
name: pymol-pml-scripting
description: |
  Generate correct PyMOL .pml scripts for molecular visualization. Use when:
  (1) user asks to create a PyMOL script or .pml file, (2) user wants to load,
  align, color, or group molecular structures in PyMOL, (3) user gets SyntaxError
  or IndentationError from a .pml file, (4) user wants cartoon outlines, transparency,
  or ray tracing settings. Covers .pml syntax rules, grouping pitfalls, outline
  rendering via ray_trace_mode, color-by-element, chain break hiding, and more.
author: Claude Code
version: 1.0.0
date: 2026-03-26
---

# PyMOL .pml Script Generation

## Problem

PyMOL `.pml` scripts are executed line-by-line as PyMOL commands, NOT as Python
scripts. Writing them with Python syntax (multi-line strings, for-loops, dicts,
f-strings, indentation blocks) causes pervasive SyntaxError/IndentationError
failures. Additionally, PyMOL's `group` command, outline rendering, and
transparency settings have non-obvious behaviors.

## Context / Trigger Conditions

Use this skill when:

- Creating or editing `.pml` files for PyMOL
- User reports SyntaxError, IndentationError, or "Unrecognized command" from a `.pml` file
- User wants structures loaded, aligned, colored, grouped, or ray-traced
- User asks for cartoon outlines, transparency control, or publication-quality rendering
- User mentions PyMOL in any molecular visualization context

## Solution

### Rule 1: .pml files are line-by-line PyMOL commands

Each line in a `.pml` file is executed independently as a PyMOL command.
**You CANNOT use:**

- Python `for`/`while` loops, `if` statements, `def` functions
- Multi-line strings (triple quotes `"""`)
- Dictionaries, lists, f-strings
- `import` statements
- Indentation-based blocks
- `os.path.join()` or any Python stdlib

**Every command must be a single, self-contained line.** If there are many
repetitive commands (e.g., loading 64 structures), you must write out all 64
load commands explicitly. Generate these programmatically in your response
(e.g., using a Python helper to emit the .pml), but the output file must
contain only flat PyMOL commands.

```pml
# CORRECT - flat PyMOL commands
load file1.cif, obj1
load file2.cif, obj2
align obj2, obj1
color red, obj1
color blue, obj2
show cartoon, obj1
show cartoon, obj2

# WRONG - Python syntax in .pml
for f in files:
    cmd.load(f)
```

### Rule 2: Use `python` / `python end` blocks for Python

If Python logic is truly needed, wrap it in a `python` / `python end` block.
The entire block is sent to the Python interpreter as one unit:

```pml
python
import os
for seed in range(42, 50):
    cmd.load(f"pred_s{seed}.cif", f"pred_s{seed}")
python end
```

**Caveat:** Some users prefer pure .pml commands. Always ask or default to
flat commands unless the script would be unmanageably large (>500 lines).

### Rule 3: Comments must be self-contained single lines

PyMOL parses comments line-by-line. A comment that looks like it continues
to the next line can cause the next line to be misinterpreted:

```pml
# WRONG - PyMOL may try to parse "very faint on..." as a command
# ray_trace_gain controls edge darkening; stronger on opaque GT,
# very faint on transparent baselines since edges scale with opacity.

# CORRECT - each comment is independent
# Edge darkening for ray tracing outlines on opaque GT
```

Avoid commas, colons, or code-like syntax inside comments that could confuse
PyMOL's parser if the comment were stripped.

### Rule 4: Grouping objects

PyMOL's `group` command adds objects to a named group. Key rules:

**Leaf groups work with explicit member lists:**
```pml
group model_A, obj_s42 obj_s43 obj_s44 obj_s45
group model_B, obj_s42 obj_s43 obj_s44 obj_s45
```

**Do NOT nest groups into parent groups:**
```pml
# WRONG - causes "Invalid parent for rec" errors
group all_models, model_A model_B ground_truth
```

Nesting groups (putting a group that already contains children into another
group) causes "Invalid parent for rec:" errors on every child object. Stick
to a single level of grouping only.

### Rule 5: Cartoon outlines for ray tracing (BLOPIG method)

To get black outlines around cartoon structures during `ray`:

```pml
set ray_trace_mode, 1
set ray_trace_gain, 0.01
set antialias, 2
```

- `ray_trace_mode, 1`: Normal color + black outline (the key setting)
- `ray_trace_mode, 2`: Black outline only (silhouette)
- `ray_trace_mode, 3`: Quantized color + black outline
- `ray_trace_gain`: Controls outline thickness (lower = thinner)

**Critical behavior:** In modes 1/2/3, **transparent objects do NOT get
outlines**. This means you can use `cartoon_transparency` to selectively
control which objects get outlines:

```pml
# Opaque GT gets outlines; transparent predictions do not
set cartoon_transparency, 0.3
set cartoon_transparency, 0.0, *_gt
set ray_trace_mode, 1
```

Reference: [BLOPIG - Making Pretty Pictures in PyMOL v2](https://www.blopig.com/blog/2024/12/making-pretty-pictures-in-pymol-v2/)

### Rule 6: Color by element after base color

To color an object with a base color but keep standard element colors
(N=blue, O=red, S=yellow) on non-carbon atoms, use `util.cnc` after
`color`:

```pml
color good_teal, my_object
util.cnc my_object
```

`util.cnc` = "color non-carbons" - it recolors N, O, S, etc. by element
while leaving carbons at whatever color you set.

### Rule 7: Hide chain break dashed lines

```pml
set cartoon_gap_cutoff, 0
```

This prevents PyMOL from drawing dashed lines across gaps in the backbone.

### Rule 8: Alignment workflow

When loading predictions to compare against a ground truth:

```pml
load ground_truth.cif, gt
load prediction.cif, pred
align pred, gt
```

Always align predictions TO the ground truth (mobile, target), not the other
way around. This keeps the ground truth in its original coordinate frame.

### Rule 9: Relative paths

`.pml` files use paths relative to PyMOL's current working directory. When
sourced with `@script.pml`, PyMOL `cd`s to the script's directory first.
Use `./` prefix for clarity:

```pml
load ./subdir/file.cif, obj_name
load ../other_dir/ref.cif, ref_name
```

### Rule 10: Check the user's .pymolrc for custom colors and settings

Before choosing colors, check `~/.pymolrc` for `set_color` definitions.
Users often define palettes they prefer. Use those color names directly:

```pml
# If .pymolrc defines: set_color good_teal, [0.310, 0.725, 0.686]
color good_teal, my_object
```

Also note any global settings (bg_color, ray_trace_mode, lighting) that the
.pymolrc sets, to avoid overriding them unnecessarily.

## Verification

After generating a `.pml` script:

1. Scan every line: is it a valid PyMOL command or `#` comment?
2. No Python syntax (no `for`, `def`, `if`, `import`, indentation, `"""`)
3. No multi-line comments with problematic punctuation
4. Groups are flat (one level only, no nesting groups into groups)
5. All file paths are correct relative paths
6. `util.cnc` follows every `color` command if element coloring is desired

## Example

**Task:** Load a ground truth and 3 predictions, align, color, group, with
outlines on GT only.

```pml
# Ground truth
load ../processed/1ABC/1ABC_input.cif, gt
color good_gray, gt
util.cnc gt
show cartoon, gt

# Predictions
load ./model_A/pred.cif, pred_A
align pred_A, gt
color good_teal, pred_A
util.cnc pred_A
show cartoon, pred_A

load ./model_B/pred.cif, pred_B
align pred_B, gt
color good_darkblue, pred_B
util.cnc pred_B
show cartoon, pred_B

load ./model_C/pred.cif, pred_C
align pred_C, gt
color good_pink, pred_C
util.cnc pred_C
show cartoon, pred_C

# Groups (flat, one level only)
group predictions, pred_A pred_B pred_C

# Display
set cartoon_transparency, 0.3
set cartoon_transparency, 0.0, gt
set cartoon_gap_cutoff, 0
set ray_trace_mode, 1
set ray_trace_gain, 0.01
set antialias, 2
set ray_shadow, 0
zoom
```

## Notes

- When generating large scripts (many seeds x many models x many targets),
  use a Python/shell helper to emit the .pml file, then write it with the
  Write tool. Do NOT write Python syntax into the .pml itself.
- `ray_trace_mode 1` overrides mode 0 from .pymolrc. Note this in a comment
  so the user knows.
- The `set` command can apply settings per-object: `set setting, value, object`
- Wildcard selections like `*_gt` work in `set` but NOT reliably in `group`.
  Use explicit object names for `group`.
- Test that PyMOL can find all files by verifying paths before writing the
  script. Use Glob to confirm file existence.

## References

- [BLOPIG - Making Pretty Pictures in PyMOL v2](https://www.blopig.com/blog/2024/12/making-pretty-pictures-in-pymol-v2/)
- [BLOPIG - Making Pretty Pictures with PyMOL](https://www.blopig.com/blog/2021/01/making-pretty-pictures-with-pymol/)
- [BLOPIG - Tips & tricks with PyMOL](https://www.blopig.com/blog/2023/10/tips-tricks-with-pymol/)
- [PyMOL Wiki - Ray](https://pymolwiki.org/index.php/Ray)
- [PyMOL Wiki - Group](https://pymolwiki.org/index.php/Group)
