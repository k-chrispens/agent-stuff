---
name: pymol-pml-scripting
description: |
  Generate correct PyMOL .pml scripts for molecular visualization. Use when:
  (1) user asks to create a PyMOL script or .pml file, (2) user wants to load,
  align, color, or group molecular structures in PyMOL, (3) user gets SyntaxError
  or IndentationError from a .pml file, (4) user wants cartoon outlines, transparency,
  or ray tracing settings, (5) a cartoon renders as disconnected fragments / stray
  loops around alternate-conformation (alt-loc) residues. Covers .pml syntax rules,
  grouping pitfalls, outline rendering via ray_trace_mode, color-by-element, chain
  break hiding, the alt-loc backbone-break cartoon fix, and more.
author: Claude Code
version: 1.1.0
date: 2026-06-04
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

**Semicolons are the worst offender — keep `#` comments semicolon-free.** A `;`
splits a line into separate commands *even inside a `#` comment*: PyMOL runs the
text after the `;` as its own command, producing a SyntaxError or
"Unrecognized command" on every run.

```pml
# WRONG - the tail after ';' is executed as a command -> SyntaxError
# Outline inherited from .pymolrc (gray30); antialias 2 also from there.

# CORRECT - no semicolon
# Outline inherited from .pymolrc (gray30) - antialias 2 also from there.
```

(Inside a `python` / `python end` block, `;` is fine — that is real Python.)

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

### Rule 11: Alt-loc backbone breaks the cartoon

**Symptom:** the cartoon renders as disconnected fragments or stray loops
around residues with alternate conformations. Turning off the gap dashes
(`set cartoon_gap_cutoff, 0`) only hides the dashes, not the break.

**Cause:** the structure file encodes the blank alt-loc as a quoted space
(`' '`) instead of the mmCIF null (`.`). PyMOL bonds two atoms only when their
alt-loc codes are compatible — equal, or one of them *empty* — and it tests
"empty" as the empty string. A space is neither empty nor equal to `A`/`B`, so
every blank↔A/B backbone peptide bond is dropped at load (within-alt A–A / B–B
and blank–blank bonds are still fine). Adding the bonds by hand with `bond`
does **not** fix the cartoon: the cartoon spline is built from *load-time*
connectivity and cached, and `bond`/`sort` do not invalidate that cache. This
is common in crystallographic/experimental density inputs.

**Fix at the source whenever you can:** make the writer emit `.` (or empty),
not `' '`, for `label_alt_id` on non-alternate atoms. Then PyMOL bonds
correctly at load with no runtime workaround at all.

#### Default fix (non-rebond — works in PyMOL < 3.2)

`rebond` (below) is the clean fix but is only in PyMOL 3.2, which is not yet a
full release. Until it ships, **default to the source fix**: rewrite the blank
alt-id to `.` *before* load (the spline is cached at load, so it must be fixed
first), then load the corrected text in memory via `cmd.load_raw(text, "cif", obj)`.

**Rewrite ONLY the `label_alt_id` column — never a blind global replace.** A
naive `txt.replace(" ' ' ", " . ")` (or `sed "s/ ' ' / . /g"`) also clobbers any
*other* quoted single-space token, and a naive whitespace split mangles
unquoted primes in atom names like `O5'`. Detect the column from the
`_atom_site.` loop header and rewrite that field only, with an mmCIF-aware
tokenizer (a quote opens a token only at token start; the close quote must be
followed by whitespace/eol). Drop this helper block near the top of the `.pml`
and call `load_altfix file.cif, obj` wherever a density/experimental input is
loaded:

```pml
python
def _altfix_text(txt):
    L = txt.split("\n")
    cols = [l.strip() for l in L if l.strip().startswith("_atom_site.")]
    if "_atom_site.label_alt_id" not in cols:
        return txt
    ai = cols.index("_atom_site.label_alt_id")
    def fix(line):
        i, n, k = 0, len(line), 0
        while i < n:
            while i < n and line[i] in " \t":
                i += 1
            if i >= n:
                break
            s = i
            if line[i] in "'\"":
                q = line[i]; i += 1
                while i < n and not (line[i] == q and (i + 1 >= n or line[i + 1] in " \t")):
                    i += 1
                i += 1; v = line[s + 1:i - 1]
            else:
                while i < n and line[i] not in " \t":
                    i += 1
                v = line[s:i]
            if k == ai:
                return (line[:s] + "." + line[i:]) if v.strip() == "" else line
            k += 1
        return line
    return "\n".join(fix(l) if (l[:4] == "ATOM" or l[:6] == "HETATM") else l for l in L)
def load_altfix(filename, oname):
    with open(filename) as _fh:
        cmd.load_raw(_altfix_text(_fh.read()), "cif", oname.strip())
cmd.extend("load_altfix", load_altfix)
python end

load_altfix ./density_input.cif, density_input
```

This is column-surgical (only blank alt-id fields change), needs no temp files,
and restores the dropped blank↔A/B backbone bonds so the cartoon stays intact.
Apply it only to the experimental/density objects that have the bug — leave
plain `load` on multi-state prediction ensembles (load_raw is single-object).

#### PyMOL 3.2+ alternative (rebond)

When PyMOL 3.2 is a full release, the in-PyMOL fix is two lines after `load`:

```pml
load density_input.cif, density_input
alter density_input, alt=alt.strip()
rebond density_input
```

`alt.strip()` rewrites the space to `""` so the bonder will form blank↔A/B;
`rebond` reconnects by distance and rebuilds the cartoon, still honoring
alt-loc incompatibility (no spurious A↔B bonds, even sub-Å A/B contacts stay
unbonded). **Caveats:** `rebond` takes an object name (whole-object only, not a
selection) and recomputes *every* distance bond — safe for protein-only
objects, but for ligands/metals whose bonds distance can't reproduce, fix at
the source instead. At that point the non-rebond block above can simply be
deleted.

**Gotcha — reserved object names load silently empty.** Names like `fixed`,
`x`, `y`, `z` are PyMOL selection keywords; loading into them prints
`Warning: '<name>' is a reserved keyword, appending underscore` and the object
becomes `<name>_`, so later `count_atoms("fixed")` / selections see nothing.
Pick non-reserved object names (`corrected`, `density_input`, ...).

## Verification

After generating a `.pml` script:

1. Scan every line: is it a valid PyMOL command or `#` comment?
2. No Python syntax (no `for`, `def`, `if`, `import`, indentation, `"""`)
   outside a `python` / `python end` block
3. No `;` in any `#` comment (it would run the tail as a command)
4. No multi-line comments with problematic punctuation
5. Groups are flat (one level only, no nesting groups into groups)
6. All file paths are correct relative paths
7. `util.cnc` follows every `color` command if element coloring is desired
8. If a cartoon breaks at alt-loc residues, apply the Rule 11 alt-loc fix
   (rewrite the blank `label_alt_id` column to `.` before load) and use
   non-reserved object names

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
- [PyMOL Wiki - Rebond](https://pymolwiki.org/index.php/Rebond) (alt-loc cartoon fix; PyMOL 3.2+)
- [PyMOL Wiki - Load_raw](https://pymolwiki.org/index.php/Load_raw) (load a fixed CIF from a string)
