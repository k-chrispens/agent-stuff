#!/usr/bin/env python3
import argparse, functools, http.server, json, re, sys, webbrowser
from pathlib import Path
from urllib.parse import unquote, urlparse

VERSION = re.compile(r"^v(\d+)\.html$", re.I)

PAGE = """<!doctype html><meta charset=utf-8><title>figure preview</title>
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#e9e9e9;font:12px ui-monospace,monospace;color:#4d4d4d}
body{display:grid;grid-template-rows:1fr auto}
#stage{display:flex;gap:16px;padding:16px;min-height:0}
.paper{flex:1;background:#fff;box-shadow:0 1px 4px #0002;display:flex;flex-direction:column;min-width:0}
.paper iframe{flex:1;border:0;width:100%}
.paper div{padding:4px 8px;border-top:1px solid #eee}
#strip{display:flex;gap:8px;padding:8px 16px;overflow-x:auto;background:#dcdcdc}
.thumb{flex:0 0 120px;height:90px;background:#fff;border:2px solid transparent;cursor:pointer;display:flex;flex-direction:column}
.thumb.on{border-color:#4b5faa}.thumb img{flex:1;min-height:0;width:100%;object-fit:contain}.thumb span{padding:0 4px}
#empty{margin:auto}
</style>
<div id=stage><div id=empty>waiting for v01.html ...</div></div><div id=strip></div>
<script>
let versions=[], pinned=[], sig="", frames={}
const shown=()=>{const live=pinned.map(n=>versions.find(v=>v.name==n)).filter(Boolean);return live.length?live:versions.slice(-1)}
function draw(force){
  if(!versions.length)return
  const s=shown(), stage=document.getElementById("stage")
  const key=s.map(v=>v.name+v.mtime).join()
  if(force||stage.dataset.key!==key){
    const hashOf=f=>{try{return f?f.contentWindow.location.hash:""}catch(e){return ""}}
    const previous=hashOf(Object.values(frames)[0])
    const hashes=Object.fromEntries(s.map(v=>[v.name,hashOf(frames[v.name])||(s.length===1?previous:"")]))
    stage.dataset.key=key
    stage.innerHTML=s.map(v=>`<div class=paper><iframe data-n="${v.name}" src="f/${encodeURIComponent(v.name)}?t=${v.mtime}${hashes[v.name]||""}"></iframe><div>${v.name}${pinned.length?"  [pinned, esc = latest]":"  [latest]"}</div></div>`).join("")
    frames={};stage.querySelectorAll("iframe").forEach(f=>frames[f.dataset.n]=f)
  }
  document.getElementById("strip").innerHTML=[...versions].reverse().map(v=>
    `<div class="thumb${s.includes(v)?" on":""}" data-n="${v.name}">${v.thumb?`<img src="f/${v.thumb}?t=${v.thumbMtime}">`:"<img>"}<span>${v.name}</span></div>`).join("")
}
document.getElementById("strip").onclick=e=>{
  const t=e.target.closest(".thumb");if(!t)return
  const n=t.dataset.n
  pinned=e.shiftKey?(pinned.includes(n)?pinned.filter(x=>x!=n):[...pinned,n].slice(-2)):[n]
  draw()
}
onkeydown=e=>{if(e.key=="Escape"){pinned=[];draw()}}
async function poll(){
  try{const r=await fetch("state",{cache:"no-store"});const j=await r.text();if(j!=sig){sig=j;versions=JSON.parse(j);draw()}}catch(e){}
  setTimeout(poll,500)
}
poll()
</script>"""


def versions(root):
    out = []
    for n, path in sorted((int(m[1]), p) for p in root.iterdir() if p.is_file() and (m := VERSION.match(p.name))):
        entry = {"name": path.name, "mtime": path.stat().st_mtime_ns}
        thumb = root / ".look" / path.stem / "desktop-default.png"
        if thumb.is_file():
            entry |= {"thumb": thumb.relative_to(root).as_posix(), "thumbMtime": thumb.stat().st_mtime_ns}
        out.append(entry)
    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        root = Path(self.directory)
        path = unquote(urlparse(self.path).path)
        if path in ("/", "/state"):
            body = (PAGE if path == "/" else json.dumps(versions(root))).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8" if path == "/" else "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/f/"):
            self.path = self.path[2:]
            return super().do_GET()
        self.send_error(404)


def main():
    parser = argparse.ArgumentParser(description="Live-reloading preview of vNN.html in a figure directory.")
    parser.add_argument("figure_dir", type=Path)
    parser.add_argument("--port", type=int, default=8775)
    parser.add_argument("--open", action="store_true", help="open a browser tab")
    args = parser.parse_args()
    root = args.figure_dir.resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    handler = functools.partial(Handler, directory=str(root))
    for port in range(args.port, args.port + 20):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
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
