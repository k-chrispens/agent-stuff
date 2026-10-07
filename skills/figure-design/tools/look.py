#!/usr/bin/env python3
import argparse, glob, importlib.util, math, os, re, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

PALETTE_FILE = Path(__file__).resolve().parent.parent / "references" / "palette.md"
HEX = re.compile(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b")
PAINT = re.compile(r"(stroke-width|stroke|fill|stop-color|flood-color)\s*:\s*([^;}\s]+)")
TEXT_TAGS = {"text", "tspan", "textPath", "foreignObject"}
IGNORED_PAINT = {"none", "currentcolor", "transparent", "inherit"}
UNITS_TO_PX = {"": 1, "px": 1, "pt": 4 / 3, "pc": 16, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4}
MIN_LINE_CONTRAST = 3.0

CHROME_CANDIDATES = [
    os.environ.get("CHROME", ""),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    *sorted(glob.glob(os.path.expanduser("~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/*"))),
    *sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome")),
    *(shutil.which(n) or "" for n in ("google-chrome", "chromium", "chromium-browser")),
]


def normalize(color):
    color = color.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{3}", color):
        color = "#" + "".join(c * 2 for c in color[1:])
    return {"white": "#ffffff", "black": "#000000"}.get(color, color)


def rgb(color):
    return [int(color[i:i + 2], 16) for i in (1, 3, 5)]


def contrast_on_white(color):
    channels = [c / 255 for c in rgb(color)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 1.05 / (0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2] + 0.05)


def is_mix(color, base, anchor, tolerance=6):
    c, b, a = rgb(color), rgb(base), rgb(anchor)
    span = [x - y for x, y in zip(a, b)]
    norm = sum(s * s for s in span) or 1
    t = max(0, min(1, sum((x - y) * s for x, y, s in zip(c, b, span)) / norm))
    return all(abs(x - (y + t * s)) <= tolerance for x, y, s in zip(c, b, span))


def is_gray(color, tolerance=3):
    r, g, b = rgb(color)
    return max(r, g, b) - min(r, g, b) <= tolerance


def on_palette(color, palette):
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        return False
    return is_gray(color) or any(is_mix(color, base, anchor) for base in palette for anchor in ("#ffffff", "#000000"))


def local(tag):
    return tag.rsplit("}", 1)[-1]


def length_px(value):
    m = re.fullmatch(r"\s*([\d.]+(?:e-?\d+)?)\s*([a-z]*)\s*", value or "")
    return float(m[1]) * UNITS_TO_PX[m[2]] if m and m[2] in UNITS_TO_PX else None


def view_box(root):
    box = [float(v) for v in re.split(r"[\s,]+", root.get("viewBox", "").strip()) if v]
    return box if len(box) == 4 and box[2] > 0 and box[3] > 0 else None


def size_px(root):
    width, height, box = length_px(root.get("width")), length_px(root.get("height")), view_box(root)
    if box:
        aspect = box[3] / box[2]
        width, height = width or (height and height / aspect), height or (width and width * aspect)
        width, height = width or box[2], height or box[3]
    return (width, height) if width and height else (1200, 800)


def declarations(root):
    for e in root.iter():
        for key in ("fill", "stroke", "stroke-width", "stop-color", "flood-color"):
            if key in e.attrib:
                yield key, e.attrib[key]
        yield from PAINT.findall(e.attrib.get("style", ""))
        if local(e.tag) == "style":
            yield from PAINT.findall(e.text or "")


def lint(root):
    text_count = sum(local(e.tag) in TEXT_TAGS for e in root.iter())
    box = view_box(root)
    pt_per_unit = 0.75 * (size_px(root)[0] / box[2] if box else 1)
    colors, strokes, widths_pt = set(), set(), set()
    for key, value in declarations(root):
        value = value.strip().lower()
        if key == "stroke-width":
            if (px := length_px(value)) is not None:
                widths_pt.add(round(px * pt_per_unit / 0.05) * 0.05)
        elif value not in IGNORED_PAINT and not value.startswith("url("):
            colors.add(normalize(value))
            if key == "stroke":
                strokes.add(normalize(value))
    palette = {normalize(c) for c in HEX.findall(PALETTE_FILE.read_text())} if PALETTE_FILE.exists() else set()
    off_palette = sorted(c for c in colors if not on_palette(c, palette))
    pale = sorted(c for c in strokes if re.fullmatch(r"#[0-9a-f]{6}", c) and not is_gray(c)
                  and contrast_on_white(c) < MIN_LINE_CONTRAST)
    report = [f"text: {text_count}" + ("  <-- must be 0 before the labeling pass" if text_count else "")]
    report.append(f"colors ({len(colors)}): {' '.join(sorted(colors))}")
    if off_palette:
        report.append(f"off-palette: {' '.join(off_palette)}  <-- see references/palette.md")
    if pale:
        report.append("pale strokes: " + " ".join(f"{c} {contrast_on_white(c):.1f}:1" for c in pale)
                      + "  <-- lines need 3:1; use the line shade")
    report.append(f"stroke widths, pt at final size ({len(widths_pt)}): {' '.join(f'{w:g}' for w in sorted(widths_pt))}"
                  + ("  <-- use at most 3" if len(widths_pt) > 3 else ""))
    return report


def chrome_raster(chrome, svg_path, png_path, width, height, scale):
    scale = min(scale, 8)  # larger device scale factors on the minimum-size window crash chrome
    with tempfile.TemporaryDirectory() as scratch:
        page = Path(scratch) / "page.html"
        page.write_text(f'<html style="margin:0;background:#fff"><body style="margin:0">'
                        f'<object type="image/svg+xml" data="{Path(svg_path).resolve().as_uri()}" '
                        f'style="display:block;width:{width}px;height:{height}px"></object></body></html>')
        window = f"--window-size={max(math.ceil(width), 800)},{math.ceil(height) + 200}"  # headless clamps width, eats ~90px of height
        subprocess.run([chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
                        "--allow-file-access-from-files", f"--user-data-dir={scratch}/profile",
                        f"--force-device-scale-factor={scale}", window, f"--screenshot={png_path}", page.as_uri()],
                       check=True, capture_output=True, timeout=60)
    try:
        from PIL import Image
    except ImportError:
        return print("note: install Pillow to crop the chrome screenshot to the figure bounds")
    with Image.open(png_path) as image:
        image.crop((0, 0, round(width * scale), round(height * scale))).save(png_path)


def raster(svg_path, png_path, root, long_side):
    width, height = size_px(root)
    scale = long_side / max(width, height)
    out_w, out_h = round(width * scale), round(height * scale)
    backend = os.environ.get("LOOK_BACKEND")
    usable = lambda name, ok: (backend or name) == name and ok
    if usable("rsvg", shutil.which("rsvg-convert")):
        return subprocess.run(["rsvg-convert", "-w", str(out_w), "-h", str(out_h), "-b", "white", "-o", png_path, svg_path], check=True)
    if usable("inkscape", shutil.which("inkscape")):
        return subprocess.run(["inkscape", svg_path, "--export-type=png", f"--export-filename={png_path}", f"--export-width={out_w}",
                               "--export-background=white", "--export-background-opacity=1"], check=True, capture_output=True)
    if usable("cairosvg", importlib.util.find_spec("cairosvg")):
        import cairosvg
        return cairosvg.svg2png(url=str(Path(svg_path).resolve()), write_to=str(png_path), output_width=out_w,
                                output_height=out_h, background_color="white", unsafe=True)
    chrome = next((c for c in CHROME_CANDIDATES if c and os.path.isfile(c)), None)
    if usable("chrome", chrome):
        return chrome_raster(chrome, svg_path, png_path, width, height, scale)
    sys.exit("no rasterizer: install librsvg (brew install librsvg), inkscape, cairosvg, or Chrome (or set $CHROME)")


def cropped_copy(svg_path, root, crop, long_side):
    x, y, w, h = crop
    scale = long_side / max(w, h)
    root.set("viewBox", f"{x} {y} {w} {h}")
    root.set("width", f"{w * scale}px")
    root.set("height", f"{h * scale}px")
    handle, path = tempfile.mkstemp(prefix=".look-", suffix=".svg", dir=Path(svg_path).parent)
    with os.fdopen(handle, "wb") as out:
        ET.ElementTree(root).write(out, xml_declaration=True, encoding="utf-8")
    return path


def main():
    parser = argparse.ArgumentParser(description="Rasterize an SVG for the agent to look at, then lint it.")
    parser.add_argument("svg", type=Path)
    parser.add_argument("png", type=Path, nargs="?", help="default: <dir>/.look/<stem>[-crop-x_y_w_h].png")
    parser.add_argument("--long-side", type=int, default=1600, help="pixels on the longer edge")
    parser.add_argument("--crop", help="x,y,w,h in viewBox units: re-render just that region at full resolution")
    args = parser.parse_args()
    if args.svg.suffix.lower() != ".svg":
        sys.exit(f"{args.svg} is not an svg; read it directly")
    try:
        for _, (prefix, uri) in ET.iterparse(args.svg, events=["start-ns"]):
            if not re.fullmatch(r"ns\d+", prefix):
                ET.register_namespace(prefix, uri)
        root = ET.parse(args.svg).getroot()
    except (ET.ParseError, OSError) as error:
        sys.exit(f"cannot parse {args.svg}: {error}")
    report = lint(root)
    suffix = "-crop-" + args.crop.replace(",", "_") if args.crop else ""
    png = args.png or args.svg.parent / ".look" / f"{args.svg.stem}{suffix}.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    if args.crop:
        try:
            crop = [float(v) for v in args.crop.split(",")]
        except ValueError:
            crop = []
        if len(crop) != 4 or crop[2] <= 0 or crop[3] <= 0:
            sys.exit("--crop takes x,y,w,h with positive w and h")
        source = cropped_copy(args.svg, root, crop, args.long_side)
        try:
            raster(source, str(png), ET.parse(source).getroot(), args.long_side)
        finally:
            os.remove(source)
    else:
        raster(str(args.svg), str(png), root, args.long_side)
    print(png)
    print("\n".join(report))


if __name__ == "__main__":
    main()
