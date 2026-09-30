#!/usr/bin/env python3
"""I RISULTATI DELLE PARTITE DEL COMO REGISTRATE DA COMO TV (Goffredo, 30/09/2026: "aggiungimi i risultati")

Per il MAM Como 1907 (Stagione > Partite del Como): un risultato per ogni registrazione del Como, da
queste fonti, nell'ordine:
  1. comotv    : il risultato che il MAM di Como TV ha gia' (ris dell'evento)
  2. espn      : la partita su ESPN (il file del MAM 1907 con i gol per squadra, o i gol contati nella cronaca)
  3. tabellone : il punteggio letto in video dal MAM di Como TV; non verificato, quindi la pagina lo segna
                 "da tabellone" e qui si scartano quelli impossibili (piu' di 12 gol per squadra)
Uscita: pub/risultati-comotv.json {rec: ["2-1", fonte]}. Gira nella notte dopo l'indice.
"""
import json, os, re, urllib.request

CASA = "/var/lib/comotv-1907"
USCITA = os.path.join(CASA, "pub", "risultati-comotv.json")
CLIP = "/var/lib/comotv/clip"


def norm(s): return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def eventi():
    r = urllib.request.Request("http://127.0.0.1:8080/api", data=json.dumps({"tipo": "clip-qnap-eventi"}).encode(), headers={"Content-Type": "text/plain"})
    return json.load(urllib.request.urlopen(r, timeout=120)).get("eventi", [])


def del_como(x):
    nomi = " ".join(s.get("nome", "") for s in (x.get("squadre") or [])) + " " + (x.get("partita") or "")
    return not x.get("studio") and re.search(r"\bcomo\b", nomi, re.I)


def da_espn(e, x):
    """[gol casa, gol ospite] dalla partita ESPN"""
    f = os.path.join(CASA, "espn", "%s.json" % e.get("id"))
    if os.path.exists(f):
        sq = json.load(open(f)).get("squadre") or []
        c = [s for s in sq if s.get("casa")]; o = [s for s in sq if not s.get("casa")]
        if c and o and str(c[0].get("gol", "")).isdigit() and str(o[0].get("gol", "")).isdigit(): return [int(c[0]["gol"]), int(o[0]["gol"])]
    sq = e.get("squadre") or []
    if len(sq) != 2: return None
    gol = [0, 0]
    for ev in e.get("eventi") or []:
        t = ev.get("tipo", "")
        if not re.search(r"goal|penalty - scored", t, re.I) or re.search(r"missed|saved|disallowed", t, re.I): continue
        i = [norm(s) for s in sq].index(norm(ev.get("squadra"))) if norm(ev.get("squadra")) in [norm(s) for s in sq] else None
        if i is None: return None
        if re.search(r"own goal", t, re.I): i = 1 - i      # l'autogol conta per l'altra squadra
        gol[i] += 1
    return gol


def main():
    esp = json.load(open(os.path.join(CLIP, "espn.json")))
    arch = json.load(open(os.path.join(CLIP, "archivio.json")))
    out, conta = {}, {"comotv": 0, "espn": 0, "tabellone": 0, "nessuno": 0}
    for x in eventi():
        if not del_como(x) or not x.get("rec"): continue
        rec, ris, fonte = x["rec"], None, ""
        if isinstance(x.get("ris"), list) and len(x["ris"]) == 2: ris, fonte = x["ris"], "comotv"
        if not ris:
            e = esp.get(rec) or {}
            if e.get("id"):
                g = da_espn(e, x)
                if g: ris, fonte = g, "espn"
        if not ris:
            t = ((arch.get(rec) or {}).get("tabellone") or {}).get("finale") or ""
            m = re.fullmatch(r"(\d{1,2})-(\d{1,2})", t)
            if m and int(m.group(1)) <= 12 and int(m.group(2)) <= 12: ris, fonte = [int(m.group(1)), int(m.group(2))], "tabellone"
        if ris: out[rec] = ["%d-%d" % (int(ris[0]), int(ris[1])), fonte]; conta[fonte] += 1
        else: conta["nessuno"] += 1
    json.dump(out, open(USCITA + ".tmp", "w"), ensure_ascii=False); os.replace(USCITA + ".tmp", USCITA)
    print("risultati delle partite del Como:", conta)


if __name__ == "__main__":
    main()
