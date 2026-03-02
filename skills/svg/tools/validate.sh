#!/usr/bin/env bash
# Validate an SVG file for structure and Inkscape-oriented compatibility.
# Usage: ./tools/validate.sh path/to/file.svg

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 path/to/file.svg"
  exit 1
fi

INPUT="$1"

if [ ! -f "$INPUT" ]; then
  echo "Error: file not found: $INPUT"
  exit 1
fi

python3 - "$INPUT" <<'PY'
from __future__ import annotations

import sys
try:
    import defusedxml.ElementTree as ET
except ImportError:
    import xml.etree.ElementTree as ET
    print("Warning: 'defusedxml' is not installed. Falling back to standard xml.etree.ElementTree.", file=sys.stderr)
from collections import Counter

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"
XLINK_HREF = f"{{{XLINK_NS}}}href"

path = sys.argv[1]


def local_name(tag: str) -> str:
    if tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def namespace(tag: str) -> str:
    if tag.startswith("{") and "}" in tag:
        return tag[1:].split("}", 1)[0]
    return ""


def collect_declared_namespaces(file_path: str) -> dict[str, str]:
    namespaces: dict[str, str] = {}
    for _, ns in ET.iterparse(file_path, events=("start-ns",)):
        prefix, uri = ns
        namespaces[prefix or ""] = uri
    return namespaces


errors: list[str] = []
warnings: list[str] = []
_error_seen: set[str] = set()
_warning_seen: set[str] = set()


def add_error(message: str) -> None:
    if message not in _error_seen:
        _error_seen.add(message)
        errors.append(message)


def add_warning(message: str) -> None:
    if message not in _warning_seen:
        _warning_seen.add(message)
        warnings.append(message)


try:
    declared_namespaces = collect_declared_namespaces(path)
    tree = ET.parse(path)
except ET.ParseError as exc:
    print(f"✗ SVG/XML parse error: {exc}")
    raise SystemExit(1)

root = tree.getroot()

if local_name(root.tag) != "svg":
    add_error("Root element must be <svg>.")

root_ns = namespace(root.tag)
if not root_ns:
    add_error('Missing SVG namespace. Add xmlns="http://www.w3.org/2000/svg" on <svg>.')
elif root_ns != SVG_NS:
    add_error(f"Unexpected root namespace: {root_ns}")

version = root.attrib.get("version")
if not version:
    add_warning('For broad editor compatibility, set version="1.1" on <svg>.')
elif version != "1.1":
    add_warning(f'Unexpected version="{version}". Prefer "1.1" for compatibility.')

view_box = root.attrib.get("viewBox")
if not view_box:
    add_error("Missing required viewBox attribute on <svg>.")
else:
    parts = view_box.replace(",", " ").split()
    if len(parts) != 4:
        add_error("viewBox must contain exactly four numbers: min-x min-y width height.")
    else:
        try:
            values = [float(item) for item in parts]
        except ValueError:
            add_error("viewBox values must be numeric.")
        else:
            if values[2] <= 0 or values[3] <= 0:
                add_error("viewBox width/height must be > 0.")

if "width" not in root.attrib or "height" not in root.attrib:
    add_warning("Consider setting both width and height for predictable editor import size.")

unsafe_tags = {
    "script",
    "foreignObject",
    "animate",
    "animateMotion",
    "animateTransform",
    "set",
}
found_unsafe: Counter[str] = Counter()
ids: list[str] = []
external_refs: list[str] = []
image_count = 0
linkable_elements_seen = 0
href_without_xlink = 0
xlink_without_href = 0

for element in root.iter():
    tag = local_name(element.tag)

    if tag in unsafe_tags:
        found_unsafe[tag] += 1

    elem_id = element.attrib.get("id")
    if elem_id:
        ids.append(elem_id)

    href = element.attrib.get("href")
    xlink_href = element.attrib.get(XLINK_HREF)

    if tag in {"use", "image"}:
        linkable_elements_seen += 1

        if not href and not xlink_href:
            add_error(f"<{tag}> is missing href/xlink:href.")

        if href and not xlink_href:
            href_without_xlink += 1

        if xlink_href and not href:
            xlink_without_href += 1

        if href and xlink_href and href != xlink_href:
            add_error(f"<{tag}> has mismatched href and xlink:href values ({href!r} vs {xlink_href!r}).")

    effective_href = href or xlink_href
    if effective_href:
        lowered = effective_href.lower()
        if "://" in lowered or lowered.startswith("//"):
            external_refs.append(f"<{tag}> -> {effective_href}")

    if tag == "image":
        image_count += 1

    if tag == "style":
        css = "".join(element.itertext()).lower()
        if "@import" in css:
            add_warning("<style> uses @import. External CSS imports are not reliably portable.")
        if "var(" in css:
            add_warning("<style> uses CSS variables (var()). Some editors handle them poorly.")
        if "mix-blend-mode" in css or "isolation:" in css:
            add_warning("<style> uses blend/isolation CSS; support varies between editors.")

    inline_style = element.attrib.get("style", "").lower()
    if "var(" in inline_style:
        add_warning(f"<{tag}> uses CSS variables in style attribute; consider plain presentation attributes.")

for tag, count in sorted(found_unsafe.items()):
    add_error(f"Contains <{tag}> ({count}x). Remove web-only/interactive tags for editor compatibility.")

duplicate_ids = [item for item, count in Counter(ids).items() if count > 1]
if duplicate_ids:
    add_error("Duplicate id attributes found: " + ", ".join(sorted(duplicate_ids)))

for ref in sorted(set(external_refs)):
    add_warning(f"External reference found: {ref}. Prefer local/embedded assets.")

if image_count:
    add_warning("Contains <image>. Raster embeds are supported but reduce SVG portability/editability.")

if linkable_elements_seen and href_without_xlink:
    add_warning(
        f"{href_without_xlink} element(s) use href without xlink:href. Add both for broader editor compatibility."
    )

if linkable_elements_seen and xlink_without_href:
    add_warning(
        f"{xlink_without_href} element(s) use xlink:href without href. Add both for SVG2 + legacy compatibility."
    )

if linkable_elements_seen and "xlink" not in declared_namespaces:
    add_warning(
        'No xmlns:xlink declaration found. Add xmlns:xlink="http://www.w3.org/1999/xlink" when using links/references.'
    )

has_title = any(local_name(elem.tag) == "title" for elem in root)
has_desc = any(local_name(elem.tag) == "desc" for elem in root)

if not has_title:
    add_warning("No <title> found. Add one for better accessibility when the SVG is standalone.")
if not has_desc:
    add_warning("No <desc> found. Add one for better accessibility when useful.")

if errors:
    print("✗ SVG validation failed")
    for error in errors:
        print(f"  - {error}")
    if warnings:
        print("Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
    raise SystemExit(1)

print("✓ SVG looks valid")
if warnings:
    print("Warnings:")
    for warning in warnings:
        print(f"  - {warning}")

print(f"Elements: {sum(1 for _ in root.iter())}")
print(f"IDs: {len(ids)}")
PY
