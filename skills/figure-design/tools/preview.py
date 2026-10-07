#!/usr/bin/env python3
import argparse, json, mimetypes, re, sys, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

VERSION = re.compile(r"^v(\d+)\.(svg|png)$", re.I)

PAGE = """<!doctype html><meta charset=utf-8><title>figure preview</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#e9e9e9;font:12px ui-monospace,monospace;color:#4d4d4d}
body{display:grid;grid-template-rows:1fr auto}
#stage{display:flex;gap:16px;padding:16px;min-height:0}
.paper{flex:1;background:#fff;box-shadow:0 1px 4px #0002;display:flex;flex-direction:column;min-width:0}
.paper object,.paper img{flex:1;width:100%;min-height:0;object-fit:contain;pointer-events:none}
.paper div{padding:4px 8px;border-top:1px solid #eee}
#strip{display:flex;gap:8px;padding:8px 16px;overflow-x:auto;background:#dcdcdc}
.thumb{flex:0 0 120px;height:90px;background:#fff;border:2px solid transparent;cursor:pointer;display:flex;flex-direction:column}
.thumb.on{border-color:#4b5fab}.thumb object,.thumb img{flex:1;min-height:0;width:100%;object-fit:contain;pointer-events:none}
.thumb span{padding:0 4px}
#empty{margin:auto}
</style>
<div id=stage><div id=empty>waiting for v01.svg ...</div></div><div id=strip></div>
<script>
let versions=[], pinned=[], sig=""
const url=v=>"f/"+encodeURIComponent(v.name)+"?t="+v.mtime
const media=v=>v.name.toLowerCase().endsWith(".svg")
  ?`<object type="image/svg+xml" data="${url(v)}"></object>`:`<img src="${url(v)}">`
function shown(){
  const live=pinned.map(n=>versions.find(v=>v.name==n)).filter(Boolean)
  return live.length?live:versions.slice(-1)
}
function draw(){
  const s=shown()
  if(!versions.length)return
  document.getElementById("stage").innerHTML=s.map(v=>`<div class=paper>${media(v)}<div>${v.name}${pinned.length?"  [pinned, esc = latest]":"  [latest]"}</div></div>`).join("")
  document.getElementById("strip").innerHTML=[...versions].reverse().map(v=>
    `<div class="thumb${s.includes(v)?" on":""}" data-n="${v.name}">${media(v)}<span>${v.name}</span></div>`).join("")
}
document.getElementById("strip").onclick=e=>{
  const t=e.target.closest(".thumb"); if(!t)return
  const n=t.dataset.n
  pinned=e.shiftKey?(pinned.includes(n)?pinned.filter(x=>x!=n):[...pinned,n].slice(-2)):[n]
  draw()
}
onkeydown=e=>{if(e.key=="Escape"){pinned=[];draw()}}
async function poll(){
  try{
    const r=await fetch("state",{cache:"no-store"}); const j=await r.text()
    if(j!=sig){sig=j;versions=JSON.parse(j);draw()}
  }catch(e){}
  setTimeout(poll,400)
}
poll()
</script>"""


def versions(root):
    hits = [(int(m[1]), p) for p in root.iterdir() if p.is_file() and (m := VERSION.match(p.name))]
    by_number = {}
    for n, p in sorted(hits, key=lambda h: (h[0], h[1].suffix.lower() == ".svg")):
        by_number[n] = p
    return [{"name": p.name, "mtime": p.stat().st_mtime_ns} for _, p in sorted(by_number.items())]


def handler(root):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, code, body, kind):
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = unquote(urlparse(self.path).path)
            if path == "/":
                return self.send(200, PAGE.encode(), "text/html; charset=utf-8")
            if path == "/state":
                return self.send(200, json.dumps(versions(root)).encode(), "application/json")
            if path.startswith("/f/"):
                target = (root / path[3:]).resolve()
                if target.is_file() and target.is_relative_to(root):
                    kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    return self.send(200, target.read_bytes(), kind)
            self.send(404, b"not found", "text/plain")

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Live-reloading preview of vNN.svg / vNN.png in a figure directory.")
    parser.add_argument("figure_dir", type=Path)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="open a browser tab")
    args = parser.parse_args()
    root = args.figure_dir.resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    mimetypes.add_type("image/svg+xml", ".svg")
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), handler(root))
            break
        except OSError:
            continue
    else:
        sys.exit(f"no free port in {args.port}-{args.port + 19}")
    url = f"http://127.0.0.1:{port}/"
    print(f"previewing {root} at {url}", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
