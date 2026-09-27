#!/usr/bin/env python3
"""
SCALDA-MINI-1907 — prepara le miniature dei servizi della linea del tempo del
MAM Como 1907, cosi' la pagina si apre gia' con le immagini (la prima volta una
miniatura costa ~3 s: il servizio-1907 la fa e poi la tiene). Una alla volta,
si ferma durante le dirette. (Goffredo, 27/09/2026)
"""
import hashlib, json, os, time, urllib.parse, urllib.request

CASA = "/var/lib/comotv-1907"


def in_diretta():
    try:
        req = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-stato"}).encode(), headers={"Content-Type": "text/plain"})
        return any(r.get("stato") == "registra" and not r.get("guarda") for r in json.load(urllib.request.urlopen(req, timeout=8)).get("reg", []))
    except Exception:
        return False


def main():
    j = json.load(open(os.path.join(CASA, "pub", "indice.json")))
    vie = [x[7] for x in sorted(j.get("servizi", []), key=lambda x: -x[1]) if x[7]]
    fatte = 0
    for i, v in enumerate(vie):
        k = hashlib.sha1(v.encode()).hexdigest()[:16]
        if os.path.exists(os.path.join(CASA, "mini", k + ".jpg")): continue
        while in_diretta(): time.sleep(300)
        try:
            urllib.request.urlopen("http://127.0.0.1:8097/mini/%s.jpg?v=%s" % (k, urllib.parse.quote(v)), timeout=150).read(); fatte += 1
        except Exception:
            pass
        if i % 100 == 0: print(i, "/", len(vie), flush=True)
    print("miniature fatte:", fatte, "su", len(vie))


if __name__ == "__main__":
    main()
