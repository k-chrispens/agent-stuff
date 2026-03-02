---
name: svg
description: "Create and edit SVG files using an Inkscape-friendly, portable SVG profile with validation checks."
---

# SVG Skill

Use this skill when creating or editing SVG assets (icons, logos, UI illustrations, and lightweight diagrams).

## Compatibility Target

Default to a **portable static SVG profile** that opens cleanly in tools like Inkscape.

- Use SVG root namespace (`xmlns="http://www.w3.org/2000/svg"`).
- Include `viewBox`, `width`, and `height`.
- Prefer simple static geometry and presentation attributes.
- Avoid interactive/web-only features (`<script>`, `<foreignObject>`, SMIL animation tags).
- Avoid external HTTP/file references inside `href`/`xlink:href`.

## Prerequisites

- A text editor.
- `python3` for the validation script.
- Optional: `npx` + `svgo` for optimization.

## Starter Template

```svg
<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     version="1.1"
     viewBox="0 0 24 24"
     width="24"
     height="24"
     fill="none">
  <title>Icon title</title>
  <desc>Short description of what the icon shows.</desc>

  <!-- Draw shapes here -->
</svg>
```

## Workflow

1. Choose the canvas and coordinate system (`viewBox`).
2. Build with simple primitives first (`rect`, `circle`, `line`, `polyline`, `path`).
3. Group related elements with `<g>` and reuse repeated parts with `<defs>` + `<use>`.
4. Keep files readable:
   - Use consistent indentation.
   - Prefer transforms/grouping over giant path blobs unless path data is intentional.
   - Keep numeric precision reasonable (2–3 decimals unless more precision is needed).
5. Validate after edits with `./tools/validate.sh file.svg`.
   - Treat compatibility warnings as blockers unless the user explicitly accepts them.
6. Optionally optimize for production with `npx -y svgo file.svg -o file.min.svg`.

## Validation Tool

```bash
./tools/validate.sh path/to/file.svg
```

Checks:
- XML is well-formed.
- Root element is `<svg>` with SVG namespace.
- `viewBox` exists and is valid (4 numeric values, positive width/height).
- Duplicate `id` attributes.
- Inkscape-oriented compatibility checks (disallowed tags, external references, style warnings, `href`/`xlink:href` guidance).
- Accessibility warnings for missing `<title>` / `<desc>`.

## Authoring Tips

- For themeable icons, use `fill="currentColor"` and/or `stroke="currentColor"`.
- For standalone assets, include `<title>` and `<desc>` for accessibility.
- Avoid embedding raster images unless explicitly required.
- Prefer semantic IDs in `<defs>` (for example `id="shadow-soft"`).
- If you use `<use>` or `<image>`, include both `href` and `xlink:href` when possible for broader editor compatibility.
