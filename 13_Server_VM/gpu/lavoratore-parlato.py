#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Il lavoratore GPU: trascrive le telecronache dell'archivio con WhisperX.

Gira su una macchina EC2 con GPU nella stessa regione del bucket
(eu-west-3): l'audio non esce da AWS, quindi non costa traffico. Prende la
lista delle partite da S3 (MAM/parlato/lista.json, scritta dalla VM), le
lavora una alla volta in ordine, e per ciascuna scrive su S3:

    MAM/parlato/<rec>.json     la trascrizione, parola per parola, con i tempi
    MAM/parlato/<rec>.fatto    il segno che e' finita (per ripartire)
    MAM/parlato/<rec>.lock     mentre ci lavora (piu' macchine, nessun doppione)

Quando la lista e' finita, spegne la macchina (shutdown -> terminate).

Uso sulla macchina:
    python3 lavoratore-parlato.py --bucket mola-italy-como-archive --prefisso MAM/parlato/ \
        --modello large-v3 --lingua it [--solo como] [--max 400]
"""
import argparse
import datetime
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

import boto3
from botocore.exceptions import ClientError

ARG = argparse.ArgumentParser()
ARG.add_argument("--bucket", required=True)
ARG.add_argument("--prefisso", default="MAM/parlato/")
ARG.add_argument("--modello", default="large-v3")
ARG.add_argument("--lingua", default="it")
ARG.add_argument("--solo", default="", help="filtro sul nome (es. 'como')")
ARG.add_argument("--max", type=int, default=0, help="quante al massimo, poi si spegne")
ARG.add_argument("--non-spegnere", action="store_true")
ARG.add_argument("--batch", type=int, default=16)
A = ARG.parse_args()

S3 = boto3.client("s3")
IO = socket.gethostname()


def dice(*x):
    print(datetime.datetime.now().strftime("%H:%M:%S"), *x, flush=True)


def esiste(chiave):
    try:
        S3.head_object(Bucket=A.bucket, Key=chiave)
        return True
    except ClientError:
        return False


def leggi_json(chiave):
    return json.loads(S3.get_object(Bucket=A.bucket, Key=chiave)["Body"].read().decode("utf-8"))


def scrivi(chiave, corpo, tipo="application/json"):
    S3.put_object(Bucket=A.bucket, Key=chiave, Body=corpo.encode("utf-8") if isinstance(corpo, str) else corpo,
                  ContentType=tipo)


def audio_da_s3(chiave, dove):
    """L'audio della partita: mono, 16 kHz, dal file su S3 (stessa regione, gratis)."""
    url = S3.generate_presigned_url("get_object", Params={"Bucket": A.bucket, "Key": chiave}, ExpiresIn=7200)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", url, "-vn", "-ac", "1", "-ar", "16000",
           "-c:a", "pcm_s16le", "-y", dove]
    subprocess.run(cmd, check=True, timeout=3600)


def carica_modello():
    import whisperx
    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dice("dispositivo:", device, "modello:", A.modello)
    modello = whisperx.load_model(A.modello, device, compute_type="float16" if device == "cuda" else "int8",
                                  language=A.lingua)
    allinea, meta = whisperx.load_align_model(language_code=A.lingua, device=device)
    return whisperx, device, modello, allinea, meta


def trascrivi(wx, device, modello, allinea, meta, wav, nomi):
    audio = wx.load_audio(wav)
    # i nomi propri sono quelli che il modello sbaglia: si suggeriscono prima
    prompt = ("Telecronaca di calcio. Nomi: " + ", ".join(nomi[:80]) + ".") if nomi else None
    esito = modello.transcribe(audio, batch_size=A.batch, language=A.lingua,
                               **({"initial_prompt": prompt} if prompt else {}))
    esito = wx.align(esito["segments"], allinea, meta, audio, device, return_char_alignments=False)
    pezzi = []
    for s in esito.get("segments", []):
        parole = [{"w": w.get("word", "").strip(), "a": round(w["start"], 2), "b": round(w["end"], 2)}
                  for w in s.get("words", []) if "start" in w and "end" in w]
        testo = s.get("text", "").strip()
        if not testo:
            continue
        pezzi.append({"a": round(s["start"], 2), "b": round(s["end"], 2), "x": testo, "parole": parole})
    return pezzi


def main():
    lista = leggi_json(A.prefisso + "lista.json")
    voci = lista.get("partite", [])
    if A.solo:
        voci = [v for v in voci if A.solo.lower() in (v.get("partita", "") + " " + v.get("competizione", "")).lower()]
    dice(len(voci), "partite in lista")
    wx, device, modello, allinea, meta = carica_modello()
    fatte = 0
    inizio = time.time()
    for v in voci:
        rec = v["rec"]
        if esiste(A.prefisso + rec + ".fatto") or esiste(A.prefisso + rec + ".lock"):
            continue
        scrivi(A.prefisso + rec + ".lock", json.dumps({"chi": IO, "quando": datetime.datetime.utcnow().isoformat()}))
        t0 = time.time()
        try:
            risultato = {"rec": rec, "partita": v.get("partita"), "lingua": A.lingua, "modello": A.modello,
                         "chi": IO, "pezzi": []}
            for i, chiave in enumerate(v.get("chiavi", [])):
                with tempfile.TemporaryDirectory() as tmp:
                    wav = os.path.join(tmp, "voce.wav")
                    audio_da_s3(chiave, wav)
                    pezzi = trascrivi(wx, device, modello, allinea, meta, wav, v.get("nomi", []))
                    for p in pezzi:
                        p["pezzo"] = i
                    risultato["pezzi"].extend(pezzi)
            risultato["secondi_lavoro"] = round(time.time() - t0)
            scrivi(A.prefisso + rec + ".json", json.dumps(risultato, ensure_ascii=False))
            scrivi(A.prefisso + rec + ".fatto", datetime.datetime.utcnow().isoformat())
            fatte += 1
            dice("fatta", v.get("partita"), "in", risultato["secondi_lavoro"], "s |", fatte, "finite")
        except Exception as e:
            dice("FALLITA", v.get("partita"), "→", repr(e)[:200])
            scrivi(A.prefisso + rec + ".errore", repr(e)[:500], "text/plain")
        finally:
            try:
                S3.delete_object(Bucket=A.bucket, Key=A.prefisso + rec + ".lock")
            except ClientError:
                pass
        if A.max and fatte >= A.max:
            break
    dice("finito:", fatte, "partite in", round((time.time() - inizio) / 60), "minuti")
    if not A.non_spegnere:
        subprocess.run(["sudo", "shutdown", "-h", "now"])


if __name__ == "__main__":
    sys.exit(main())
