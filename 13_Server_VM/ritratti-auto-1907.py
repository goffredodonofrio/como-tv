#!/usr/bin/env python3
"""
RITRATTI-AUTO-1907 — dare un volto a chi non ha lo scontornato del Como.
(Goffredo, 28/09/2026: la parete dei volti; 93 persone su 125 senza foto)

Per ogni persona delle rose (e del club) senza foto ne' ritratto:
  1. i suoi video: quelli che la nominano da sola (cartella o nome del file), prima interviste,
     presentazioni e conferenze; da ognuno i volti grandi e di fronte
  2. se nell'archivio foto c'e' un candidato (lo stesso cognome in un'altra squadra: gli ex del
     Como che giocano altrove) si CONFERMA solo se quella faccia c'e' davvero in almeno due dei
     suoi video: allora entra in ritratti.json col volto preso dal NOSTRO video
     (il cognome da solo non basta: "chiesa" e' anche Federico, "henry" e' anche Rico)
  3. se no, se in quei video domina una faccia (almeno 3 video e la meta' di quelli con volti),
     diventa una PROPOSTA (proposte.json): ignoti-1907 la usa per il "Forse e' ..." e decide
     una persona, con un clic, nella pagina
Riprende da dove era arrivato (ritratti-auto.json), si ferma a --minuti e durante le dirette.

  /opt/volti/bin/python ritratti-auto-1907.py --minuti 60 [--solo luis-binks,patrick-cutrone]
"""
import argparse, hashlib, importlib.util, json, os, re, time

import cv2
import numpy as np

CASA = "/var/lib/comotv-1907"
FATTO = os.path.join(CASA, "ritratti-auto.json")      # {pid: esito}: chi e' gia' stato guardato
RITRATTI = os.path.join(CASA, "ritratti.json")
PROPOSTE = os.path.join(CASA, "proposte.json")
RITAGLI = os.path.join(CASA, "pub", "ignoti")
VOLTI = "/var/lib/comotv/volti"
# dove la faccia e' grande: prima le interviste, poi presentazioni; in fondo grafiche e
# allenamenti ("Portrait" nei nomi e' il formato verticale, non un primo piano)
PRIMO = [re.compile(r"interview|\bitw|intw|intervist|soundbite|press ?conf|conferenza|\bpc\b", re.I),
         re.compile(r"signing|new player|welcome|presentazion|media ?day|get to know|documentar|podcast", re.I)]
ULTIMI = re.compile(r"lower ?third|\bgfx\b|grafic|\badv\b|training|allenament|highlights|feed", re.I)
CONFERMA = 0.50       # somiglianza tra la foto candidata e un volto del suo video
STESSA = 0.50         # due volti dei suoi video sono la stessa persona
MAX_VIDEO = 8

sp = importlib.util.spec_from_file_location("volti", "/opt/comotv/volti-1907.py"); V = importlib.util.module_from_spec(sp); sp.loader.exec_module(V)
META = V.META


def leggi(f, d):
    try: return json.load(open(f))
    except Exception: return d


def scrivi(f, x):
    tmp = f + ".tmp"; json.dump(x, open(tmp, "w"), ensure_ascii=False); os.replace(tmp, f)


def candidati(p, perSq, per_file):
    """le foto dell'archivio col suo cognome (in qualsiasi squadra) che sono in galleria"""
    sl = META.slug(p["nome"]).split("-")
    fuori = []
    for k in {"-".join(sl[-2:]), sl[-1]}:
        for f in (perSq.get(k) or {}).values():
            if f in per_file and f not in fuori: fuori.append(f)
        f = "foto-premium-" + k + ".png"
        if f in per_file and f not in fuori: fuori.append(f)
    return fuori


def suoi_video(pid, ind, fpc, ric):
    """i video che nominano solo lui: la cartella (p) o il nome del file (pf); prima i primi piani"""
    fuori = []
    for r in ind["cartelle"]:
        d, md = r[0], r[8] or {}
        if pid in md.get("p", []) and len(md["p"]) == 1:
            for f in fpc.get(d, []): fuori.append(d + "/" + f)
        elif pid in md.get("pf", []):
            for f in fpc.get(d, []):
                if ric.persone(f.rsplit(".", 1)[0]) == [pid]: fuori.append(d + "/" + f)
    fuori = [v for v in fuori if "prox" not in v.lower()]
    fuori.sort(key=lambda v: (0 if PRIMO[0].search(v) else 1 if PRIMO[1].search(v) else 3 if ULTIMI.search(v) else 2, v))
    # non tutti dalla stessa cartella: al massimo due per cartella
    per, scelti = {}, []
    for v in fuori:
        d = v.rsplit("/", 1)[0]
        if per.get(d, 0) >= 2: continue
        per[d] = per.get(d, 0) + 1; scelti.append(v)
        if len(scelti) >= MAX_VIDEO: break
    return scelti


def tre_quarti(f):
    """di fronte o di tre quarti (nelle interviste si guarda chi fa le domande), non di profilo"""
    ex1, ex2, nx = float(f[4]), float(f[6]), float(f[8])
    if ex2 - ex1 < 0.25 * float(f[2]): return False
    return -0.1 <= (nx - ex1) / (ex2 - ex1) <= 1.1


def volti_di(vie, riv, trad):
    """[(video, impronta, ritaglio, altezza)] dei volti grandi e di fronte"""
    fuori = []
    for v in vie:
        for im in V.fotogrammi(os.path.join(V.R, v)):
            h, w = im.shape[:2]; riv.setInputSize((w, h)); _, ff = riv.detect(im)
            for f in (ff if ff is not None else []):
                alt = float(f[3] / h)
                if alt < 0.12 or float(f[14]) < 0.85 or not tre_quarti(f): continue
                rit = trad.alignCrop(im, f); e = trad.feature(rit).flatten().astype(np.float32); e /= np.linalg.norm(e)
                fuori.append((v, e, rit, alt))
    return fuori


def salva_ritaglio(pid, rit):
    k = hashlib.sha1(("auto#" + pid).encode()).hexdigest()[:14]
    os.makedirs(RITAGLI, exist_ok=True); cv2.imwrite(os.path.join(RITAGLI, k + ".jpg"), rit, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return k


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--minuti", type=int, default=60)
    a.add_argument("--solo", default="")
    x = a.parse_args()
    os.nice(15)
    fine = time.time() + x.minuti * 60
    g = json.load(open(os.path.join(VOLTI, "galleria.json"))); vet = np.load(os.path.join(VOLTI, "galleria.npy")).astype(np.float32)
    vet /= np.linalg.norm(vet, axis=1, keepdims=True)
    per_file = {y["file"]: i for i, y in enumerate(g)}
    fi = leggi(META.FOTO_MAPPA, {}); perSq = fi.get("perSq", {})
    ind = json.load(open(os.path.join(CASA, "pub", "indice.json")))
    fpc = {d: [f[0] for f in fs if f[0].lower().endswith((".mp4", ".mov", ".mxf", ".m4v", ".mts"))] for d, fs in json.load(open(os.path.join(CASA, "pub", "file.json")))}
    pers = META.persone(); ric = META.Riconosci(pers)
    fatto = leggi(FATTO, {}); ritr = leggi(RITRATTI, {}); prop = leggi(PROPOSTE, {})
    solo = [s for s in x.solo.split(",") if s]
    # chi e' gia' stato battezzato a mano ha gia' il suo volto: niente proposte doppie
    battezzati = set(v for v in leggi(os.path.join(CASA, "battesimi.json"), {}).get("crop", {}).values() if v != "-")
    riv = cv2.FaceDetectorYN.create(V.MODELLI + "/yunet.onnx", "", (V.LATO, V.LATO), 0.7, 0.3, 5000)
    trad = cv2.FaceRecognizerSF.create(V.MODELLI + "/sface.onnx", "")
    for p in pers:
        pid = p["id"]
        if solo and pid not in solo: continue
        if not solo and (p["foto"] or pid in ritr or pid in fatto or pid in battezzati): continue
        if time.time() > fine: break
        while V.in_diretta(): time.sleep(300)
        vie = suoi_video(pid, ind, fpc, ric)
        if not vie: fatto[pid] = {"esito": "senza video"}; scrivi(FATTO, fatto); continue
        facce = volti_di(vie, riv, trad)
        esito = {"video": len(vie), "facce": len(facce)}
        if not facce: esito["esito"] = "senza volti"; fatto[pid] = esito; scrivi(FATTO, fatto); print(pid, esito, flush=True); continue
        E = np.stack([f[1] for f in facce])
        # 2. un candidato dall'archivio foto, confermato dai suoi video
        best = None
        for c in candidati(p, perSq, per_file):
            s = E @ vet[per_file[c]]
            buoni = {facce[i][0] for i in np.where(s >= CONFERMA)[0]}
            if len(buoni) >= 2 and (not best or len(buoni) > best[1]): best = (c, len(buoni), int(np.argmax(s)))
        if best:
            f = facce[best[2]]
            ritr[pid] = {"k": salva_ritaglio(pid, f[2]), "e": V.impronta(f[1]), "da": best[0], "video": best[1], "fonte": "auto"}
            scrivi(RITRATTI, ritr); esito.update(esito="confermato", foto=best[0], video_ok=best[1])
        else:
            # 3. la faccia che domina nei suoi video: una proposta da confermare a mano
            gruppi = []
            for i in np.argsort([-f[3] for f in facce]):
                for gr in gruppi:
                    if float(E[i] @ gr["c"]) >= STESSA:
                        gr["i"].append(i); gr["s"] += E[i]; gr["c"] = gr["s"] / np.linalg.norm(gr["s"]); break
                else:
                    gruppi.append({"i": [i], "s": E[i].copy(), "c": E[i].copy()})
            con_volti = len({f[0] for f in facce})
            gruppi.sort(key=lambda gr: -len({facce[i][0] for i in gr["i"]}))
            gr = gruppi[0]; nv = len({facce[i][0] for i in gr["i"]})
            secondo = len({facce[i][0] for i in gruppi[1]["i"]}) if len(gruppi) > 1 else 0
            if nv >= 3 and nv * 2 >= con_volti and nv > secondo:
                f = facce[gr["i"][0]]
                prop[pid] = {"k": salva_ritaglio(pid, f[2]), "e": V.impronta(gr["c"]), "video": nv, "su": con_volti}
                scrivi(PROPOSTE, prop); esito.update(esito="proposta", video_ok=nv)
            else:
                esito.update(esito="incerto", gruppo=nv, secondo=secondo)
        fatto[pid] = esito; scrivi(FATTO, fatto)
        print(pid, esito, flush=True)


if __name__ == "__main__":
    main()
