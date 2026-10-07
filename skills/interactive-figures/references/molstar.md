# Mol\* and MolViewSpec

The notes below were verified against Mol\* 5.13.0 (Oct 2026). The `templates/molstar.html` template is the working reference.

## Loading

- Libraries come from the CDN: `molstar@5.13.0/build/viewer/molstar.js` (5.3 MB, 1.5 MB gzipped) and `molstar.css`. The bundled offline file is about 5.4 MB plus your data.
- Create the viewer with `molstar.Viewer.create(elementId, options)`. Pass the template's options and its CSS rule to hide the viewport controls, the snapshot controls and the toolbar. Then turn off the axis gizmo with `viewer.plugin.canvas3d.setProps({camera: {helper: {axes: {name: 'off', params: {}}}}})`.
- The template's `render(s)` builds a MolViewSpec tree from the state, then calls `viewer.loadMvsData(JSON.stringify(tree), 'mvsj', {keepCamera: framed, sanityChecks: false})`. Each load replaces the previous scene; `replaceExisting` is not a load option.
  - **Speed:** a full scene reload takes tens of milliseconds with a small structure and a map (10–75 ms measured), fast enough for toggles and sliders.
  - **`keepCamera`:** pass it as false on the first render (so `focus` frames the scene) and true afterwards. Otherwise every state change throws away the reader's rotation.
  - **`sanityChecks: false`:** silences the file-extension warning, which every blob URL triggers.
- Embedded data loads through `assetUrl()`, which turns base64 into a blob URL. It works offline, from `file://`, and inside an iframe.

## Tree recipes

Nodes are `{kind, params, children}`, and the template's `node(kind, params, ...children)` builds them.

- **Structure**:
  ```
  download{url} > parse{format:'mmcif'} > structure{type:'model'}
      > component{selector} > representation{type} > color{color, selector?}
  ```
  - `selector` is one of `'all'`, `'polymer'`, `'protein'`, `'nucleic'`, `'branched'`, `'ligand'`, `'ion'`, `'water'`, `'coarse'`, or a component expression such as `{label_seq_id: 4, label_atom_id: 'NZ'}` or `{auth_asym_id: 'A', beg_auth_seq_id: 10, end_auth_seq_id: 20}`, or a list of expressions, or `{molql: ...}` (below).
  - Representation types: `cartoon`, `backbone`, `ball_and_stick`, `line`, `spacefill`, `surface`, `putty`, `carbohydrate`.
  - Several `color` nodes under one representation apply in order, so a later node with a selector recolors part of it.
- **Density**:
  ```
  download{url} > parse{format:'map'} > volume{}
      > volume_representation{type:'isosurface', relative_isovalue | absolute_isovalue, show_wireframe, show_faces}
          > color{color}, opacity{opacity}
  ```
  - `format:'map'` reads CCP4, MRC and MAP files.
  - `show_wireframe: true, show_faces: false` gives the classic mesh look.
  - `type: 'grid_slice'` with `dimension: 'x'|'y'|'z'` shows a plane through the map.
- **Camera**: put `focus{direction?, up?, radius_factor?}` under a component to frame it from a chosen side; see Keyboard access and named views. `camera{target, position, up}` sets the view direction, but Mol\* may change the distance (one run asked for 17 Å and got 22).
- **Canvas**: `canvas{background_color: 'white'}`.
- **Clipping**: `clip{type: 'plane' | 'sphere' | 'box', ...}`; see Clipping below.

## Gotchas

- **Alternate locations need a MolQL selector.** Component expressions have no altloc field, but a selector can be `{molql: <MolScript expression>}`, which can test `label_alt_id`. The template's `ALTLOC_B` is a working example, and a label's `position` accepts the same form. Add more conditions with `core.logic.and`:
  ```
  const sym = name => ({ name });
  { molql: { head: sym('structure-query.generator.atom-groups'), args: { 'atom-test': { head: sym('core.rel.eq'),
      args: [{ head: sym('structure-query.atom-property.macromolecular.label_alt_id') }, 'B'] } } } }
  ```
  `molql` is a Mol\* extension of MolViewSpec, so other MVS viewers won't read it. Avoid selecting by `atom_id`: ids are file-specific (in the example, ids 25–28 are conformer B in `ensemble.cif` but Ala5's backbone in `single.cif`).
- **`relative_isovalue` is measured on the map you loaded.** Mol\* computes `absolute = relative × σ + mean`, using the loaded map's own σ and mean. Cropping changes both, so "1σ" means a different contour after a crop. Compute σ and the mean on the full map, record them in `brief.md`, and pass `absolute_isovalue: mean + level × σ`.
- **Overlapping components draw twice.** Two components that both include residue 4 each render it, and the one drawn later doesn't reliably win. Recolor inside a single representation instead.
- **The Mol\* canvas is opaque to check.py.** The lint can't see 3D colors, labels or contrast, so judge those from the PNGs.
- **Thin mesh at small sizes.** Mesh lines keep their pixel width as the stage shrinks, so on phones the density can bury the model. The template sets mesh opacity to 0.5 below 600 px.
- **Temporal multisampling is slow in software rendering.** It costs 3–5 s per screenshot. The template turns it off when `FAST` is set, which `check.py` does; stills keep it on.
- **σ over a mostly empty box is small.** In a P1 box around a small model, side chains sit at 6–7σ, so "1σ" gives no intuition. Sample the map at the atoms you care about in `src/` and choose the contour levels from those values.
- **The structure must have a unit cell when used with a map.** Otherwise Mol\* warns "Unknown spacegroup" and uses a dummy cell. `gemmi` writes one if you set `structure.cell` and `spacegroup_hm`.

## 3D labels (labeling pass)

The `label` node takes only `text`. Use a primitive instead, placed as a child of the structure node. At the root, a position given as an atom expression fails with "Structure with ref '<default>' not found".

```
node('structure', { type: 'model' },
  ...components,
  { ...node('primitives', { label_attachment: 'bottom-left' },
      node('primitive', { kind: 'label', position: [x, y, z], text: 'B', label_size: 1.6, label_color: '#367e77' })),
    custom: { molstar_label_params: { borderWidth: 0 } } })
```

- **`custom`** is a property of the node, beside `kind` and `params`, not a parameter. `borderWidth: 0` removes the dark outline Mol\* draws around text by default, which otherwise makes labels look smudged.
- **`position`** resolves to the centroid of everything it matches. `{label_seq_id: 4, label_atom_id: 'NZ'}` matches both conformers and lands between them. Target one conformer with a MolQL expression (altloc and atom name, joined with `core.logic.and`), or pass coordinates `[x, y, z]`.
- **Placement** is set on the `primitives` group with `label_attachment` (`'bottom-left'`, `'top-right'`, …), which puts text beside its anchor rather than centred on it. Move the anchor a little beyond the atom, by coordinates. `label_offset` only pushes text toward the camera, so it can't move text sideways. The group also takes `label_background_color`, `label_show_tether` and `label_tether_length`.
- **Size** is in Å (default 1), so on screen it depends on the framing, and labels shrink on phones. Set `label_size` per width, about 1.5× on narrow screens, and check every viewport's PNG. Distance-relative auto-sizing (`label_size: null`) exists only for the distance and angle measurement primitives, not for `label`.
- **Text contrast** must be 4.5:1, which is darker than the 3:1 line shade. Compute the color, e.g. good_teal darkened to #367e77, and record it in `brief.md`.

## Keyboard access and named views

Mol\* rotates with Shift+arrow keys (and moves with W/A/S/D) while the pointer is over the canvas; no click is needed. Keyboard-only users have no pointer to hover with, and the canvas can't be reached with Tab, so drag-rotation still needs another route (WCAG 2.5.7). Use named views: a `view` key in `STATES` with 2–3 values, each with its own button. The contract ignores Shift+arrows, so Mol\*'s rotation keys and the contract's state-stepping arrows don't collide.

- **Compute views from geometry** in `src/`, so an agent can do it alone. Write each view to `assets/meta.json` as a `direction` and `up`. Example: face-on to the plane through CB, NZ-A and NZ-B uses that plane's normal; edge-on looks along NZ-A→NZ-B.
- **Apply a view** with the component's focus node: `focus{direction, up, radius_factor}` (both verified). `focus` also takes `radius` and `radius_extent`.
- **The focus node frames the scene.** So `keepCamera` must be false on any render that should apply a view:
  - the first render;
  - any render where `s.view` changed;
  - any render triggered by a view button. Clicking the active view after rotating must snap back, so the button handler sets a `forceView` flag.
  
  On every other render, keep `keepCamera: true` so the reader's rotation survives.
- **Restoring the saved camera.** The template saves the reader's camera to `sessionStorage` and restores it after the first render, two animation frames after `loadMvsData`, because the load's own framing would overwrite it any earlier. If you add views, record the restored view as the last view applied, or the first view change will throw the restore away.

## Clipping

`clip{type: 'sphere', center: [x, y, z], radius, invert: true}` keeps the inside of a sphere. Put it under a `volume_representation` to trim map edges, and the mesh then has no flat box faces. Don't clip ball-and-stick this way: it leaves half-atoms and orphaned sticks. Choose the context residues with component selectors instead.

## Preparing data with gemmi (in `src/`)

Crop the map to the region the figure is about, so the bundle stays small. The example map shrank from 36³ to 19×16×13 at a 4 Å margin. A 6 Å margin plus a clip sphere looks cleaner:

```python
import gemmi, numpy
st = gemmi.read_structure("model.cif")
m = gemmi.read_ccp4_map("full.ccp4", setup=True)
sigma, mean = float(numpy.std(m.grid.array)), float(numpy.mean(m.grid.array))  # record in brief.md before cropping
region = gemmi.Selection("/1/A/4").copy_structure_selection(st)  # "//4" silently selects nothing
# sample the map (e.g. m.grid.interpolate_value) BEFORE set_extent: interpolation on the cropped grid is wrong
m.set_extent(region.calculate_fractional_box(margin=6))  # 4 Å cuts neighbouring density with flat faces
m.write_ccp4_map("assets/map.ccp4")
```

- **Maps from reflections:** MolViewSpec's `parse` node has no MTZ format, so read the MTZ with `gemmi.read_mtz_file` and use `transform_f_phi_to_map`. (The full Mol\* app can open MTZ files directly, but not through MolViewSpec.)
- **Calculated maps** (as in `templates/example/make_data.py`): use `gemmi.DensityCalculatorX` with `d_min`, `rate` and `put_model_density_on_grid`.
- **Large structures:** use `.bcif` (BinaryCIF) rather than `.cif`, and `parse{format:'bcif'}`.

## From a PyMOL scene

PyMOL has no interactive web export, so rebuild the scene as MolViewSpec:

| PyMOL | MolViewSpec |
|---|---|
| `select s, chain A and resi 10-20` | `component{selector: {auth_asym_id: 'A', beg_auth_seq_id: 10, end_auth_seq_id: 20}}` |
| `show cartoon` / `sticks` / `surface` | `representation{type: 'cartoon' / 'ball_and_stick' / 'surface'}` |
| `color good_teal, s` | `color{color: '#4fb9af', selector}`, using the hex values from figure-design's palette |
| `isomesh m, map, 1.0` | `volume_representation{type: 'isosurface', relative_isovalue: 1, show_wireframe: true, show_faces: false}` |
| `set_view` / `orient s` | `camera{...}` / `focus{}` |
| `set transparency, 0.5` | `opacity{opacity: 0.5}` |

## Sources

- Mol\* plugin docs: https://molstar.org/docs/plugin/
- MolViewSpec: https://github.com/molstar/mol-view-spec, and the NAR 2025 paper https://academic.oup.com/nar/article/53/W1/W408/8125619
- MolViewStories, for multi-scene stories with a standalone HTML export: https://molstar.org/mol-view-stories/docs/getting-started.html
