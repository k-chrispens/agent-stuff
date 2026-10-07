#!/usr/bin/env -S uv run --script
# /// script
# dependencies = ["playwright", "pillow"]
# ///
import argparse, base64, functools, http.server, importlib.util, io, mimetypes, os, re, sys, threading, time, urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter
from playwright.sync_api import Error as PlaywrightError, sync_playwright

CACHE = Path(os.environ.get("INTERACTIVE_FIGURES_CACHE", Path.home() / ".cache" / "interactive-figures"))
LOOK = Path(__file__).resolve().parents[2] / "figure-design" / "tools" / "look.py"
VIEWPORTS = {
    "desktop": dict(viewport={"width": 1280, "height": 800}),
    "mobile": dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True),
    "slide": dict(viewport={"width": 1920, "height": 1080}),
}
QUERY = {"desktop": "?fast", "mobile": "?fast", "slide": "?fast&talk"}
MIN_TARGET_PX = 24
SETTLE_MS = 400
STILL_DIFF_LIMIT = 0.005  # fraction of inked pixels that may differ between an exported SVG still and the live screenshot

CONTRACT_JS = """() => {
  const f = window.figure;
  if (!f || !f.states || !f.set || !f.get || !f.ready) return 'window.figure must expose states, get, set, ready';
  if (!document.getElementById('figure')) return 'the figure must be an element with id="figure"';
  const keys = Object.keys(f.states.default || {}).sort().join();
  if (!keys) return 'figure.states.default is missing or empty';
  for (const [name, s] of Object.entries(f.states)) {
    if (Object.keys(s).sort().join() !== keys) return `state "${name}" must list exactly the keys of default (${keys})`;
    for (const [k, v] of Object.entries(s)) {
      if (v === null || typeof v === 'object') return `state "${name}".${k} must be a number, string or boolean (use a sentinel such as -1 or '' for "none")`;
      if (typeof v !== typeof f.states.default[k]) return `state "${name}".${k} is a ${typeof v} but default.${k} is a ${typeof f.states.default[k]}`;
    }
  }
  return '';
}"""

CONTROLS_JS = """() => [...document.querySelectorAll('#figure input, #figure button, #figure select, #figure textarea, #figure [tabindex]')]
  .filter(e => e.offsetParent !== null && !e.closest('.msp-plugin'))
  .map(e => ({
    tag: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.dataset && Object.keys(e.dataset).length ? `[${Object.entries(e.dataset)[0].join('=')}]` : ''),
    size: Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height),
    name: (e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].textContent) ||
           (e.getAttribute('aria-labelledby') && document.getElementById(e.getAttribute('aria-labelledby'))?.textContent) || e.textContent || '').trim(),
  }))"""

NAMES_JS = """() => {
  const missing = [];
  const fig = document.getElementById('figure'), stage = fig.querySelector('[role="img"]');
  if (!(fig.getAttribute('aria-label') || '').trim()) missing.push('#figure aria-label');
  if (!stage) missing.push('an element with role="img" (the stage)');
  else if (!(stage.getAttribute('aria-label') || '').trim()) missing.push('stage aria-label');
  if (!document.title.trim() || document.title.trim() === 'figure') missing.push('<title>');
  const caption = fig.querySelector('figcaption');
  if (!caption || !caption.textContent.trim()) missing.push('figcaption');
  return missing;
}"""

SERIALIZE_SVG_JS = r"""async widthMm => {
  const svgs = [...document.querySelectorAll('#figure svg.figure-svg')];
  const font = ['font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline'];
  const refs = ['clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end'];
  const shapes = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan']);
  const rgba = v => { const m = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/); return m && { hex: '#' + m.slice(1, 4).map(n => (+n).toString(16).padStart(2, '0')).join(''), alpha: m[4] === undefined ? 1 : +m[4] }; };
  const bare = v => v.replace(/url\("([^"]+)"\)/g, 'url($1)');
  const dataUrl = async href => {
    const blob = await (await fetch(href)).blob();
    return await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
  };
  const local = (el, cs) => { // the element's own transform, including CSS transform-origin and transform-box
    if (!cs.transform || cs.transform === 'none') return null;
    let ox = 0, oy = 0;
    const origin = cs.transformOrigin.split(' ').map(parseFloat);
    if (cs.transformBox === 'fill-box' && el.getBBox) { const b = el.getBBox(); ox = b.x; oy = b.y; }
    return new DOMMatrix().translate(ox + origin[0], oy + origin[1]).multiply(new DOMMatrix(cs.transform)).translate(-(ox + origin[0]), -(oy + origin[1]));
  };
  const out = [];
  for (const svg of svgs) {
    const clone = svg.cloneNode(true);
    const live = [svg, ...svg.querySelectorAll('*')], copy = [clone, ...clone.querySelectorAll('*')];
    for (let i = 0; i < live.length; i++) {
      const el = live[i], c = copy[i], cs = getComputedStyle(el), tag = el.tagName.toLowerCase();
      if (i > 0 && cs.display === 'none') { c.setAttribute('display', 'none'); c.removeAttribute('class'); c.removeAttribute('style'); continue; }
      const insideDefs = !!el.closest('defs, clipPath, mask, marker, symbol, pattern');
      if (shapes.has(tag) && !el.closest('clipPath, mask')) {
        for (const p of tag === 'line' ? ['stroke'] : ['fill', 'stroke']) {
          const v = cs.getPropertyValue(p), color = rgba(v), opacity = +cs.getPropertyValue(p + '-opacity');
          if (color) { c.setAttribute(p, color.hex); const o = opacity * color.alpha; if (o < 1) c.setAttribute(p + '-opacity', +o.toFixed(3)); else c.removeAttribute(p + '-opacity'); }
          else if (v) { c.setAttribute(p, bare(v)); if (opacity < 1) c.setAttribute(p + '-opacity', opacity); }
        }
        const defaults = { 'stroke-dasharray': 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'miter' };
        if (cs.stroke !== 'none') ['stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'].forEach(p => { const v = cs.getPropertyValue(p); if (v && v !== defaults[p]) c.setAttribute(p, v); });
        else ['stroke-width', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin'].forEach(p => c.removeAttribute(p));
      }
      if (tag === 'text' || tag === 'tspan') font.forEach(p => { const v = cs.getPropertyValue(p); if (v) c.setAttribute(p, v); });
      if (tag === 'stop') { const color = rgba(cs.stopColor); if (color) { c.setAttribute('stop-color', color.hex); c.setAttribute('stop-opacity', +cs.stopOpacity * color.alpha); } }
      refs.forEach(p => { const v = cs.getPropertyValue(p); if (v && v !== 'none') c.setAttribute(p, bare(v)); });
      if (+cs.opacity < 1) c.setAttribute('opacity', cs.opacity);
      if (cs.visibility === 'hidden') c.setAttribute('visibility', 'hidden');
      if (i > 0 && tag !== 'svg') {
        const parentIsRoot = el.parentNode === svg || el.parentNode.tagName.toLowerCase() !== 'svg';
        const own = !insideDefs && parentIsRoot && el.getCTM && el.getCTM(), parentCtm = own && el.parentNode.getCTM && el.parentNode.getCTM();
        const m = own && parentCtm ? parentCtm.inverse().multiply(own) : local(el, cs);
        if (m && ![m.a - 1, m.b, m.c, m.d - 1, m.e, m.f].every(v => Math.abs(v) < 1e-9)) c.setAttribute('transform', `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`);
        else if (own && parentCtm) c.removeAttribute('transform');
      }
      if (tag === 'image') {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        if (href && !href.startsWith('data:')) { c.setAttribute('href', await dataUrl(new URL(href, location.href).href)); c.removeAttribute('xlink:href'); }
      }
      c.removeAttribute('class');
      c.removeAttribute('style');
    }
    const box = svg.getBoundingClientRect(), toUser = svg.getScreenCTM().inverse();
    for (const canvas of document.querySelectorAll('#figure .stage canvas')) { // composite canvases (e.g. dense marks) behind the SVG
      if (canvas.closest('.msp-plugin')) continue;
      const r = canvas.getBoundingClientRect(), p0 = new DOMPoint(r.left, r.top).matrixTransform(toUser), p1 = new DOMPoint(r.right, r.bottom).matrixTransform(toUser);
      const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
      Object.entries({ x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y, preserveAspectRatio: 'none', href: canvas.toDataURL('image/png') }).forEach(([k, v]) => img.setAttribute(k, v));
      clone.insertBefore(img, clone.firstChild);
    }
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('version', '1.1');  // editor compatibility, as the svg skill's validator expects
    clone.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xlink', 'http://www.w3.org/1999/xlink');
    for (const el of clone.querySelectorAll('[href]')) el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', el.getAttribute('href'));
    const name = (document.getElementById('figure').getAttribute('aria-label') || '').trim();
    const description = ((document.querySelector('#figure [role="img"]') || {}).getAttribute?.('aria-label') || '').trim();
    for (const [tag, text] of [['desc', description], ['title', name]]) {  // the still carries the figure's accessible name
      if (!text) continue;
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      node.textContent = text;
      clone.insertBefore(node, clone.firstChild);
    }
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const [, , w, h] = clone.getAttribute('viewBox').split(/[\s,]+/).map(Number);
    clone.setAttribute('width', widthMm ? `${widthMm}mm` : w);
    clone.setAttribute('height', widthMm ? `${widthMm * h / w}mm` : h);
    out.push({ svg: new XMLSerializer().serializeToString(clone), cssWidth: box.width, cssHeight: box.height, index: svgs.indexOf(svg) });
  }
  return out;
}"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            pass


def serve(directory):
    handler = functools.partial(QuietHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def launch(playwright):
    args = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]  # software WebGL: same rendering path on every machine, works headless
    attempts = [dict(executable_path=os.environ["CHROME"])] if os.environ.get("CHROME") else []
    attempts += [{}, dict(channel="chrome")]
    for options in attempts:
        try:
            return playwright.chromium.launch(args=args, **options)
        except PlaywrightError:
            continue
    sys.exit("no browser: run `uvx playwright install chromium`, install Chrome, or set $CHROME")


def router(log, offline):
    def route(r):
        url = r.request.url
        if urllib.parse.urlparse(url).hostname in ("127.0.0.1", "localhost") or url.startswith(("data:", "blob:")):
            return r.continue_()
        if offline:
            log.append(("offline", url))
            return r.abort()
        cached = CACHE / re.sub(r"[^\w.@/-]", "_", re.sub(r"^https?://", "", url))
        if cached.is_file():
            return r.fulfill(path=str(cached), content_type=mimetypes.guess_type(cached.name)[0] or "application/octet-stream")
        log.append(("network", url))
        return r.continue_()
    return route


def set_state(page, name):
    try:
        page.evaluate("name => window.figure.set(window.figure.states[name])", name)
        return ""
    except PlaywrightError as error:
        return str(error).splitlines()[0].replace("Page.evaluate: ", "")


def settle(page):
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.wait_for_timeout(SETTLE_MS)


def snap(page, selector, path):
    page.screenshot(path=str(path), clip=page.locator(selector).first.bounding_box(), full_page=True)


def console_line(message):
    text = message.text[:300]
    if "Failed to load resource" in text and message.location.get("url"):
        text += f" ({message.location['url']})"
    return text


def open_figure(context, url, log, timeout):
    page = context.new_page()
    page.on("console", lambda m: m.type in ("error", "warning") and log.append((m.type, console_line(m))))
    page.on("pageerror", lambda e: log.append(("pageerror", str(e)[:300])))
    started = time.time()
    page.goto(url)
    try:
        page.wait_for_function("() => window.figure && typeof window.figure.set === 'function'", timeout=10000)
    except PlaywrightError:
        raise PlaywrightError("window.figure is not defined: does the page include the contract block from a template?")
    error = page.evaluate(f"""() => Promise.race([
        window.figure.ready.then(() => '', e => 'figure.ready rejected: ' + (e && e.message || e)),
        new Promise(r => setTimeout(() => r('figure.ready did not resolve within {timeout} ms'), {timeout}))])""")
    if error:
        raise PlaywrightError(error)
    if not page.evaluate("() => !!document.getElementById('figure')"):
        raise PlaywrightError('the figure must be an element with id="figure"')
    return page, time.time() - started


def tab_reachable(page, count):
    reached = set()
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    for _ in range(count + 5):
        page.keyboard.press("Tab")
        reached.add(page.evaluate("() => document.activeElement && document.activeElement.closest('#figure') ? document.activeElement.outerHTML.slice(0, 80) : ''"))
    return len(reached - {""})


def lint_svg(path, labeled, width_mm):
    if not LOOK.exists():
        return [f"lint skipped: figure-design not found at {LOOK.parent.parent}"]
    spec = importlib.util.spec_from_file_location("look", LOOK)
    look = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(look)
    lines = look.lint(ET.parse(path).getroot())
    if labeled:
        lines = [line.split("  <--")[0] if line.startswith("text:") else line for line in lines]
    if not width_mm:
        lines = [line.replace("pt at final size", "pt at 1 viewBox unit = 1 px; pass --width-mm") for line in lines]
    return lines


def still_mismatch(page, entry, shot_path):
    """Fraction of inked pixels where the exported SVG, rendered in the same browser, differs from the live screenshot.

    A pixel differs if any channel falls outside the 3x3 neighbourhood range of the other image by more than 32,
    checked in both directions (losses and spurious additions); 1-px antialiasing shifts are tolerated.
    """
    probe = page.context.new_page()
    try:
        data = base64.b64encode(entry["svg"].encode()).decode()
        probe.set_viewport_size({"width": max(400, int(entry["cssWidth"]) + 20), "height": max(300, int(entry["cssHeight"]) + 20)})
        probe.set_content(f'<body style="margin:0;background:#fff"><img id=s style="display:block;width:{entry["cssWidth"]}px;height:{entry["cssHeight"]}px" src="data:image/svg+xml;base64,{data}"></body>')
        probe.wait_for_function("() => document.getElementById('s').complete")
        rendered = Image.open(io.BytesIO(probe.locator("#s").screenshot())).convert("RGB")
    finally:
        probe.close()
    live = Image.open(shot_path).convert("RGB")
    if rendered.size != live.size:
        rendered = rendered.resize(live.size)

    def outside(a, b):
        low, high = b.filter(ImageFilter.MinFilter(3)), b.filter(ImageFilter.MaxFilter(3))
        spread = ImageChops.lighter(ImageChops.subtract(low, a), ImageChops.subtract(a, high))
        return max_channel(spread).point(lambda v: 255 if v > 32 else 0)

    def ink(image):
        return max_channel(ImageChops.invert(image)).point(lambda v: 255 if v > 15 else 0)

    differ = ImageChops.lighter(outside(live, rendered), outside(rendered, live))
    inked = ImageChops.lighter(ink(live), ink(rendered))
    return differ.histogram()[255] / max(1, inked.histogram()[255])


def max_channel(image):
    r, g, b = image.split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b)


def write_stills(browser, url, viewport, names, args, log, problems):
    args.stills.mkdir(parents=True, exist_ok=True)
    context = browser.new_context(**{**VIEWPORTS[viewport], "device_scale_factor": 2})
    context.route("**/*", router(log, args.offline))
    page, _ = open_figure(context, url + QUERY[viewport].replace("fast", "").replace("?&", "?").rstrip("?"), log, args.timeout)
    for name in names:
        set_state(page, name)
        settle(page)
        snap(page, "#figure .stage", args.stills / f"{name}.png")
        entries = page.evaluate(SERIALIZE_SVG_JS, args.width_mm)
        for entry in entries:
            suffix = f"-{entry['index'] + 1}" if len(entries) > 1 else ""
            path = args.stills / f"{name}{suffix}.svg"
            path.write_text(entry["svg"], encoding="utf-8")
            live = args.stills / f".{name}{suffix}-live.png"
            page.screenshot(path=str(live), clip=page.locator("#figure svg.figure-svg").nth(entry["index"]).bounding_box(), full_page=True)
            mismatch = still_mismatch(page, entry, live)
            live.unlink()
            print(f"still {path.name}: " + " | ".join(lint_svg(path, args.labeled, args.width_mm)) + f" | differs from screen: {mismatch:.1%}")
            if mismatch > STILL_DIFF_LIMIT:
                problems.append(f"still {path.name} differs from the screenshot in {mismatch:.1%} of inked pixels: compare stills/{name}.png with the SVG")
    print(f"stills -> {args.stills}")
    context.close()


def main():
    parser = argparse.ArgumentParser(description="Render every named state at several viewports, screenshot, and check the figure contract.")
    parser.add_argument("html", type=Path)
    parser.add_argument("--viewports", help="comma list of desktop,mobile,slide (default: all; desktop with --stills)")
    parser.add_argument("--offline", action="store_true", help="fail on any request that leaves localhost (use on the bundled file)")
    parser.add_argument("--stills", type=Path, help="write full-quality <state>.png (and <state>.svg for SVG figures) here, from the first viewport")
    parser.add_argument("--width-mm", type=float, help="physical width of SVG stills (e.g. 89 or 183 for Nature), so the lint reports real point sizes")
    parser.add_argument("--labeled", action="store_true", help="the labeling pass is done: text is expected, and names, title and caption are required")
    parser.add_argument("--timeout", type=int, default=60000, help="ms to wait for figure.ready")
    args = parser.parse_args()
    html = args.html.resolve()
    if not html.is_file():
        sys.exit(f"not a file: {html}")
    viewports = (args.viewports or ("desktop" if args.stills else "desktop,mobile,slide")).split(",")
    unknown = [v for v in viewports if v not in VIEWPORTS]
    if unknown:
        sys.exit(f"unknown viewport {unknown}; choose from {', '.join(VIEWPORTS)}")
    home = html.parent.parent if html.parent.name == "dist" else html.parent
    out = home / ".look" / (f"dist-{html.stem}" if home != html.parent else html.stem)
    out.mkdir(parents=True, exist_ok=True)
    server = serve(html.parent)
    url = f"http://127.0.0.1:{server.server_port}/{urllib.parse.quote(html.name)}"
    problems, log = [], []
    print(f"{html.name}  {html.stat().st_size / 1e6:.2f} MB")
    with sync_playwright() as playwright:
        browser = launch(playwright)
        for viewport in viewports:
            context = browser.new_context(**VIEWPORTS[viewport])
            context.route("**/*", router(log, args.offline))
            try:
                page, seconds = open_figure(context, url + QUERY[viewport], log, args.timeout)
            except PlaywrightError as error:
                problems.append(f"{viewport}: figure never became ready ({str(error).splitlines()[0]})")
                context.close()
                continue
            contract = page.evaluate(CONTRACT_JS)
            if contract:
                problems.append(f"contract: {contract}")
                context.close()
                break
            names = page.evaluate("() => Object.keys(window.figure.states)")
            shots = []
            for name in names:
                if error := set_state(page, name):
                    problems.append(f"{viewport}/{name}: render failed: {error}")
                settle(page)
                shot = out / f"{viewport}-{name}.png"
                snap(page, "#figure", shot)
                shots.append(shot.name)
                if page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 1"):
                    problems.append(f"{viewport}/{name}: horizontal overflow")
            print(f"{viewport}: ready in {seconds:.1f}s, {len(names)} states -> {out}/{{{','.join(shots)}}}")
            controls = page.evaluate(CONTROLS_JS)
            if viewport == "mobile":
                small = [f"{c['tag']} ({c['size']:.0f}px)" for c in controls if c["size"] < MIN_TARGET_PX]
                if small:
                    problems.append(f"mobile: touch targets under {MIN_TARGET_PX}px: {' '.join(small)}")
            if viewport == viewports[0]:
                if page.evaluate("() => !!document.querySelector('#figure .msp-plugin')"):
                    print("Mol* canvas: the lint cannot see inside it. Read every state's PNG for colors, labels and framing.")
                unnamed = [c["tag"] for c in controls if not c["name"]]
                if unnamed:
                    problems.append(f"controls without an accessible name: {' '.join(unnamed)}")
                reached = tab_reachable(page, len(controls))
                print(f"controls: {len(controls)}, reachable by Tab: {reached}")
                if reached < len(controls):
                    problems.append(f"only {reached} of {len(controls)} controls reachable by Tab")
                missing = page.evaluate(NAMES_JS)
                if missing and args.labeled:
                    problems.append(f"labeling pass incomplete: missing {', '.join(missing)}")
                elif missing:
                    print(f"labels pending (required with --labeled): {', '.join(missing)}")
                set_state(page, "default")
                settle(page)
                entries = page.evaluate(SERIALIZE_SVG_JS, None)
                if entries:
                    path = out / "default.svg"
                    path.write_text(entries[0]["svg"], encoding="utf-8")
                    print("default svg: " + " | ".join(lint_svg(path, args.labeled, None)))
                target = names[-1]
                set_state(page, target)
                settle(page)
                page.evaluate("() => window.figure.flushHash && window.figure.flushHash()")
                expected = page.evaluate("() => window.figure.get()")
                try:
                    fresh, _ = open_figure(context, page.url, log, args.timeout)
                    if fresh.evaluate("() => window.figure.get()") != expected:
                        problems.append(f"state {target} does not survive a reload from its URL hash")
                    fresh.close()
                except PlaywrightError as error:
                    problems.append(f"reload from URL hash failed: {str(error).splitlines()[0]}")
                if args.stills:
                    write_stills(browser, url, viewport, names, args, log, problems)
            context.close()
        browser.close()
    server.shutdown()
    for kind, message in dict.fromkeys(log):
        line = f"{kind}: {message}"
        print(line)
        if kind in ("error", "pageerror", "offline"):
            problems.append(line)
    for problem in dict.fromkeys(problems):
        print(f"FAIL {problem}")
    print("ok" if not problems else f"{len(set(problems))} problem(s)")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
