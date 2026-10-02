#!/usr/bin/env python3
"""Il ricevitore dei link di Frame (02/10/2026).

Per riportare sulla NAS del Como 1907 quello che c'e' su Frame e manca (o e'
rotto), servono i link di download degli originali. Li chiede a Frame la
scheda di Frame aperta nel Chrome di Goffredo (la sua sessione, niente API) e
li manda qui con un POST: cosi' i link non passano da nessun altro.

Ascolta su 127.0.0.1:8099, nginx gli passa /como-tv/frame-ponte/ (fuori dal
cancello Google: protegge la chiave in /etc/comotv/frame-ponte.chiave).
Scrive /var/lib/comotv-1907/frame-scarico/link.json: {id_frame: {url, ts}}.
I link scadono (circa 16 ore): lo scaricatore usa solo quelli ancora buoni.
"""
import json, os, re, time, threading, hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CASA = "/var/lib/comotv-1907/frame-scarico"
LINK = os.path.join(CASA, "link.json")
CHIAVE = open("/etc/comotv/frame-ponte.chiave").read().strip()
LOCK = threading.Lock()
os.makedirs(CASA, exist_ok=True)

def leggi():
    try: return json.load(open(LINK))
    except Exception: return {}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def rispondi(self, code, o):
        b = json.dumps(o).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "https://next.frame.io")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_OPTIONS(self):
        self.send_response(204); self.send_header("Access-Control-Allow-Origin", "https://next.frame.io")
        self.send_header("Access-Control-Allow-Methods", "GET, POST"); self.send_header("Access-Control-Allow-Headers", "Content-Type"); self.end_headers()
    # la scheda di Frame chiede quali link servono: i prossimi del piano, non ancora
    # scaricati e senza un link buono per almeno due ore
    def do_GET(self):
        try:
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            if not hmac.compare_digest(q.get("chiave", [""])[0], CHIAVE): return self.rispondi(403, {"ok": False, "errore": "chiave"})
            n = max(1, min(500, int(q.get("n", ["200"])[0])))
            try: fatti = {k for k, v in json.load(open(os.path.join(CASA, "stato.json"))).items() if v.get("stato") == "fatto"}
            except Exception: fatti = set()
            d = leggi(); ora = time.time(); ids = []; resto = 0
            for r in open(os.path.join(CASA, "piano.tsv"), encoding="utf-8"):
                if r.startswith("#"): continue
                i = r.split("\t")[1]
                if i in fatti: continue
                resto += 1
                v = d.get(i); m = re.search(r"[?&]Expires=(\d+)", v["url"]) if v else None
                if m and int(m.group(1)) > ora + 7200: continue
                if len(ids) < n: ids.append(i)
            self.rispondi(200, {"ok": True, "ids": ids, "da_fare": resto})
        except Exception as e:
            self.rispondi(400, {"ok": False, "errore": str(e)[:200]})
    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20_000_000: return self.rispondi(413, {"ok": False})
            p = json.loads(self.rfile.read(n) or b"{}")
            if not hmac.compare_digest(str(p.get("chiave", "")), CHIAVE): return self.rispondi(403, {"ok": False, "errore": "chiave"})
            voci = p.get("voci") or []
            ora = int(time.time()); messi = 0
            with LOCK:
                d = leggi()
                for v in voci:
                    i, u = str(v.get("id", "")), str(v.get("url", ""))
                    if len(i) == 36 and u.startswith("https://assets.frame.io/"): d[i] = {"url": u, "ts": ora}; messi += 1
                json.dump(d, open(LINK + ".tmp", "w")); os.replace(LINK + ".tmp", LINK)
            self.rispondi(200, {"ok": True, "messi": messi, "tot": len(d)})
        except Exception as e:
            self.rispondi(400, {"ok": False, "errore": str(e)[:200]})

ThreadingHTTPServer(("127.0.0.1", 8099), H).serve_forever()
