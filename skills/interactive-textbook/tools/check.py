# /// script
# dependencies = ["playwright"]
# ///
"""Browser checks for an interactive-textbook build, in a real DOM (headless Chromium).

  uv run tools/check.py widget widgets/ch03-rw-pca.mjs '{"n": 100}' [--out DIR] [--max-ms 50]
      Mount one anywidget module the way the MyST theme does (shadow root + get/set/on model),
      drive every control, and fail on exceptions or NaN/undefined in the output.
      Saves light and dark screenshots. No book build needed.

  uv run tools/check.py book _build/html [--out DIR]
      Check every page of a built book: widgets render, no console errors, every {term}
      link opens a hover card, cards nest, live code cells run. Saves dark-mode widget shots.

If Chromium is missing: uv run --with playwright playwright install chromium
"""
import argparse, functools, http.server, json, pathlib, sys, threading
from playwright.sync_api import sync_playwright

LAUNCH_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]  # WebGL (Mol*) in headless
# JupyterLite probes these optional indexes; the 404s are harmless.
BENIGN = ("pypi/all.json", "api/contents", "Failed to load resource")
BAD_ATTR_JS = """root => [...root.querySelectorAll('*')].flatMap(e => [...e.attributes]
  .filter(a => /NaN|undefined/.test(a.value)).map(a => `<${e.tagName.toLowerCase()} ${a.name}="${a.value.slice(0, 40)}">`))"""

HARNESS = """<!doctype html><html><body style="margin:0;padding:16px;font:14px system-ui;width:720px">
<div id="host"></div>
<script type="module">
const state = %s, listeners = {};
const model = {
  get: k => state[k],
  set: (k, v) => { state[k] = v; (listeners["change:" + k] || []).forEach(f => f()); },
  on: (ev, f) => (listeners[ev] ||= []).push(f),
  // The MyST theme's model shim throws on these; mirror it so widgets that rely on them fail here too.
  save_changes() { throw new Error("model.save_changes is not implemented in the MyST anywidget shim"); },
  send() { throw new Error("model.send is not implemented in the MyST anywidget shim"); },
  off() { throw new Error("model.off is not implemented in the MyST anywidget shim"); },
};
const el = document.createElement("div");
document.getElementById("host").attachShadow({ mode: "open" }).appendChild(el);
const w = (await import("./%s")).default;
const t0 = performance.now();
if (w.initialize) await w.initialize({ model });
window.__cleanup = await w.render({ model, el });
window.__ms = performance.now() - t0;
window.__ready = true;
</script></body></html>"""


def launch(p):
    try:
        return p.chromium.launch(args=LAUNCH_ARGS)
    except Exception as e:
        sys.exit(f"Could not start Chromium ({e}).\nInstall it with: uv run --with playwright playwright install chromium")


def check_widget(args):
    path = pathlib.Path(args.module).resolve()
    out = pathlib.Path(args.out); out.mkdir(parents=True, exist_ok=True)
    state = json.loads(args.state)
    html = HARNESS % (json.dumps(state), path.name)
    errors = []
    with sync_playwright() as p:
        b = launch(p); pg = b.new_page(viewport={"width": 760, "height": 900})
        pg.on("pageerror", lambda e: errors.append(f"exception: {e}"))
        pg.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))

        def serve(route):  # a fake origin, so ES-module imports work without a server
            name = route.request.url.split("check.local/", 1)[1].split("?")[0]
            if name in ("", "index.html"):
                return route.fulfill(body=html, content_type="text/html")
            f = path.parent / name
            route.fulfill(path=str(f)) if f.is_file() else route.fulfill(status=404)

        pg.route("http://check.local/**", serve)
        pg.goto("http://check.local/")
        try:
            pg.wait_for_function("() => window.__ready", timeout=15000)
        except Exception:
            errors.append("render() did not finish within 15 s")
        ms = pg.evaluate("() => window.__ms") or 0
        root = pg.evaluate_handle("() => document.getElementById('host').shadowRoot")
        bad = pg.evaluate(BAD_ATTR_JS, root)

        # Drive every control: ranges/numbers at min, mid, max; selects through all options; toggles; buttons.
        driven = pg.evaluate("""async root => {
          const tick = () => new Promise(r => setTimeout(r, 30)); let n = 0;
          const fire = (e, ...types) => types.forEach(t => e.dispatchEvent(new Event(t, { bubbles: true })));
          for (const e of root.querySelectorAll('input[type=range], input[type=number]')) {
            const lo = +(e.min || 0), hi = +(e.max || 100);
            for (const v of [lo, (lo + hi) / 2, hi]) { e.value = v; fire(e, 'input', 'change'); n++; await tick(); }
          }
          for (const e of root.querySelectorAll('input[type=checkbox], input[type=radio]')) { e.click(); n++; await tick(); e.click(); await tick(); }
          for (const e of root.querySelectorAll('select')) for (const o of e.options) { e.value = o.value; fire(e, 'input', 'change'); n++; await tick(); }
          for (const e of [...root.querySelectorAll('button')].slice(0, 20)) { e.click(); n++; await tick(); }
          return n;
        }""", root)
        bad += pg.evaluate(BAD_ATTR_JS, root)

        host = pg.locator("#host")
        host.screenshot(path=str(out / f"{path.stem}-light.png"))
        pg.evaluate("() => { document.body.style.background = '#0d1117'; document.body.style.color = '#e6edf3'; }")
        host.screenshot(path=str(out / f"{path.stem}-dark.png"))
        pg.evaluate("() => typeof window.__cleanup === 'function' && window.__cleanup()")
        b.close()

    print(f"{path.name}: render {ms:.1f} ms, {driven} control events, screenshots in {out}/")
    problems = errors + [f"bad attribute after render/interaction: {a}" for a in sorted(set(bad))[:10]]
    if args.max_ms and ms > args.max_ms:
        problems.append(f"first render took {ms:.0f} ms (> {args.max_ms} ms); widgets in closed dropdowns and hover cards mount immediately")
    for pr in problems:
        print("  PROBLEM", pr)
    sys.exit(1 if problems else 0)


def check_book(args):
    root = pathlib.Path(args.html).resolve()
    out = pathlib.Path(args.out); out.mkdir(parents=True, exist_ok=True)
    pages = [""] + sorted(d.name for d in root.iterdir() if (d / "index.html").is_file())
    handler = functools.partial(type("Q", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *_: None}), directory=str(root))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    problems, errs = [], []
    open_all = "() => document.querySelectorAll('details').forEach(d => d.open = true)"
    hosts_js = "() => [...document.querySelectorAll('*')].filter(e => e.shadowRoot)"

    with sync_playwright() as p:
        b = launch(p)
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        pg.on("console", lambda m: m.type == "error" and not any(s in m.text for s in BENIGN) and errs.append(m.text))
        pg.on("pageerror", lambda e: errs.append(f"exception: {e}"))
        nested_start = None
        for name in pages:
            errs.clear()
            pg.goto(f"{base}/{name}", wait_until="networkidle"); pg.wait_for_timeout(1000)
            pg.evaluate(open_all); pg.wait_for_timeout(1500)
            hosts = pg.evaluate(f"() => ({hosts_js})().map(e => e.shadowRoot.querySelectorAll('svg,canvas,img,input,button').length + (e.shadowRoot.textContent || '').trim().length)")
            empty = sum(1 for h in hosts if h == 0)
            links = pg.locator("a[href*='#term-']")
            seen, missing = set(), []
            for i in range(links.count()):
                a = links.nth(i); href = a.get_attribute("href")
                if href in seen or not a.is_visible():
                    continue
                seen.add(href)
                pg.mouse.move(5, 5); pg.wait_for_timeout(150)
                a.scroll_into_view_if_needed(); a.hover(); pg.wait_for_timeout(700)
                card = pg.locator(".hover-card-content")
                if not card.count():
                    missing.append(href)
                elif nested_start is None and card.last.locator("a[href*='#term-']").count():
                    nested_start = (name, href)
            pg.mouse.move(5, 5)
            pg.screenshot(path=str(out / f"page-{name or 'index'}.png"))
            print(f"{name or 'index'}: {len(hosts)} widgets ({empty} empty), {len(seen)} terms ({len(missing)} without a card), {len(errs)} console errors")
            problems += [f"{name}: {empty} widget(s) rendered nothing"] * bool(empty)
            problems += [f"{name}: no hover card for {h}" for h in missing]
            problems += [f"{name}: console: {e[:160]}" for e in errs]

        # Nesting: move straight onto each child link. A trigger mid-screen can push a tall card under the sticky nav.
        if nested_start:
            name, href = nested_start
            pg.goto(f"{base}/{name}", wait_until="networkidle"); pg.wait_for_timeout(800)
            start = pg.locator(f"a[href='{href}']").first
            start.evaluate("e => { e.scrollIntoView({block: 'start'}); window.scrollBy(0, -150); }"); pg.wait_for_timeout(300)
            start.hover(); pg.wait_for_timeout(900)
            for _ in range(3):
                inner = pg.locator(".hover-card-content").last.locator("a[href*='#term-']")
                if not inner.count():
                    break
                cb = pg.locator(".hover-card-content").last.bounding_box()
                pg.mouse.move(cb["x"] + 20, cb["y"] + 15); pg.wait_for_timeout(300)
                lb = inner.first.bounding_box()
                pg.mouse.move(lb["x"] + lb["width"] / 2, lb["y"] + lb["height"] / 2); pg.wait_for_timeout(1100)
            depth = pg.locator(".hover-card-content").count()
            pg.screenshot(path=str(out / "nested.png"))
            print(f"nested cards: {depth} open at once (from {href} on {name or 'index'})")
            if depth < 2:
                problems.append(f"hover cards did not nest (reached {depth}) from {href}")

        # Live code: every page with a compute button, every Run-cell button must produce output.
        for name in pages:
            pg.goto(f"{base}/{name}", wait_until="networkidle")
            start_btn = pg.get_by_role("button", name="start compute environment")
            if not start_btn.count():
                continue
            errs.clear(); start_btn.click()
            run = pg.get_by_role("button", name="Run cell")
            try:
                run.first.wait_for(timeout=120000)
            except Exception:
                problems.append(f"{name}: compute environment never offered a Run button"); continue
            for i in range(run.count()):
                run.nth(i).click()
                try:
                    pg.wait_for_function(f"""() => {{ const o = [...document.querySelectorAll('[class*="output"]')];
                        return o.length > {i} && o.some(e => e.innerText.trim() || e.querySelector('img,svg')); }}""", timeout=180000)
                except Exception:
                    hint = " (a {code-cell} inside a dropdown is never registered; keep cells top-level)" if any("no cell found" in e for e in errs) else ""
                    problems.append(f"{name}: code cell {i + 1} produced no output{hint}")
            print(f"{name}: ran {run.count()} live code cell(s)")
        b.close()

        # Dark mode: screenshot every widget so a human can eyeball contrast.
        ctx = p.chromium.launch(args=LAUNCH_ARGS).new_context(viewport={"width": 1280, "height": 900}, color_scheme="dark")
        pg = ctx.new_page(); n = 0
        for name in pages:
            pg.goto(f"{base}/{name}", wait_until="networkidle")
            if not pg.evaluate("() => document.documentElement.classList.contains('dark')"):
                toggle = pg.get_by_role("button", name="Toggle theme between light and dark mode")
                toggle.count() and toggle.click()
            pg.evaluate(open_all); pg.wait_for_timeout(1200)
            handles = pg.evaluate_handle(hosts_js)
            for i in range(pg.evaluate("h => h.length", handles)):
                el = pg.evaluate_handle("([h, i]) => h[i]", [handles, i]).as_element()
                el.scroll_into_view_if_needed(); pg.wait_for_timeout(150)
                el.screenshot(path=str(out / f"dark-{name or 'index'}-{i}.png")); n += 1
        print(f"dark-mode widget screenshots: {n} in {out}/ (inspect for contrast)")
    srv.shutdown()
    for pr in problems:
        print("  PROBLEM", pr)
    sys.exit(1 if problems else 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("widget"); w.add_argument("module"); w.add_argument("state", nargs="?", default="{}")
    w.add_argument("--out", default="check-out"); w.add_argument("--max-ms", type=float, default=0)
    bk = sub.add_parser("book"); bk.add_argument("html"); bk.add_argument("--out", default="check-out")
    args = ap.parse_args()
    check_widget(args) if args.cmd == "widget" else check_book(args)


if __name__ == "__main__":
    main()
