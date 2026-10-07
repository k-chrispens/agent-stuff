#!/usr/bin/env python3
import argparse, base64, json, os, re, sys, urllib.request
from pathlib import Path

CACHE = Path(os.environ.get("INTERACTIVE_FIGURES_CACHE", Path.home() / ".cache" / "interactive-figures"))
SCRIPT = re.compile(r"""<script\b([^>]*?)\s+src=(["'])([^"']+)\2([^>]*)>\s*</script>""", re.I)
STYLESHEET = re.compile(r"""<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=(["'])([^"']+)\1[^>]*>""", re.I)
SOURCE_MAP = re.compile(r"^\s*(//|/\*)# sourceMappingURL=.*$", re.M)
HTML_COMMENTS = re.compile(r"<!--.*?-->", re.S)
JS_COMMENTS = re.compile(r"^\s*/\*.*?\*/|^\s*//[^\n]*", re.S | re.M)  # only comments that start a line: a // or /* inside a string is code
FONT_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "fonts.bunny.net")
LINKS = re.compile(r"<a\b[^>]*>", re.I)
EXTERNAL = re.compile(r"""(?<![\w-])(?:src|href|xlink:href)=["'](?!data:|blob:|#|mailto:|javascript:)[^"']+|url\(\s*["']?(?:https?:)?//[^)]+|import\s*\(?\s*["']https?://[^"']+|from\s+["']https?://[^"']+|(?:fetch|d3\.(?:csv|tsv|dsv|json|text|xml|html|svg|image|blob|buffer)|new\s+Worker|importScripts)\(\s*["'`](?:https?:)?//[^"'`]+""", re.I)


def cache_path(url):
    return CACHE / re.sub(r"[^\w.@/-]", "_", re.sub(r"^https?://", "", url))


def read(ref, figure_dir):
    if not re.match(r"https?://", ref):
        path = (figure_dir / ref).resolve()
        if not path.is_file():
            sys.exit(f"cannot inline {ref}: no such file next to the figure")
        return SOURCE_MAP.sub("", path.read_text(encoding="utf-8"))
    path = cache_path(ref)
    if not path.exists():
        try:
            with urllib.request.urlopen(ref, timeout=60) as response:
                data = response.read()
        except OSError as error:
            sys.exit(f"cannot download {ref}: {error}\nseed the cache by saving the file to {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return SOURCE_MAP.sub("", path.read_text(encoding="utf-8"))


def assets_script(figure_dir):
    assets = {}
    root = figure_dir / "assets"
    for path in sorted(root.rglob("*")) if root.is_dir() else []:
        if path.is_file() and not path.name.startswith("."):
            assets[path.relative_to(figure_dir).as_posix()] = base64.b64encode(path.read_bytes()).decode()
    return f"<script>window.__ASSETS__={json.dumps(assets)};</script>", assets


def bundle(html, figure_dir):
    inlined, warnings = [], []

    def script(m):
        before, _, ref, after = m.groups()
        if re.search(r"""type=["']?module""", before + after, re.I):
            warnings.append(f"{ref} is an ES module (type=module), which cannot be inlined: load the library's UMD build with a classic <script src>")
            return m.group(0)
        inlined.append(ref)
        return f"<script{before}{after}>{read(ref, figure_dir).replace('</script', '<' + chr(92) + '/script')}</script>"

    def stylesheet(m):
        ref = m[2]
        if any(host in ref for host in FONT_HOSTS):
            warnings.append(f"{ref} is a web font, which stays external: use system fonts")
            return m.group(0)
        inlined.append(ref)
        css = read(ref, figure_dir)
        warnings.extend(f"{ref} loads {u}" for u in re.findall(r"url\(\s*[\"']?(https?://[^)\"']+)", css))
        return f"<style>{css}</style>"

    html = HTML_COMMENTS.sub("", html)  # commented-out tags must not be downloaded and inlined
    html = SCRIPT.sub(script, html)
    html = STYLESHEET.sub(stylesheet, html)
    tag, assets = assets_script(figure_dir)
    head = re.search(r"<head[^>]*>", html, re.I)
    html = html[:head.end()] + tag + html[head.end():] if head else tag + html
    return html, inlined, assets, warnings


def leftovers(source):
    """External or relative references in the figure's own code that the bundle cannot satisfy."""
    own = LINKS.sub("", JS_COMMENTS.sub("", STYLESHEET.sub("", SCRIPT.sub("", HTML_COMMENTS.sub("", source)))))
    return sorted({m.group(0)[:100] for m in EXTERNAL.finditer(own)})


def main():
    parser = argparse.ArgumentParser(description="Inline scripts, stylesheets and assets/ into one offline HTML file.")
    parser.add_argument("source", type=Path, help="figures/<slug>/vNN.html")
    parser.add_argument("out", type=Path, nargs="?", help="default: figures/<slug>/dist/<slug>.html")
    args = parser.parse_args()
    figure_dir = args.source.resolve().parent
    out = args.out or figure_dir / "dist" / f"{figure_dir.name}.html"
    source = args.source.read_text(encoding="utf-8")
    html, inlined, assets, warnings = bundle(source, figure_dir)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"{out}  {len(html.encode()) / 1e6:.2f} MB")
    for ref in inlined:
        print(f"  inlined {ref}")
    for path, data in assets.items():
        print(f"  asset   {path}  {len(data) * 3 / 4 / 1e3:.0f} kB")
    problems = warnings + [f"still external: {ref} (load data through assetUrl('assets/...'))" for ref in leftovers(source)]
    for problem in problems:
        print(f"  ERROR {problem}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
