#!/usr/bin/env python3
"""
Estrae il motore delle grafiche da generatore.html e lo rende un modulo Node.

Perche' estrarre invece di riscrivere: la maschera che il pannello Premiere
mette in timeline deve essere IDENTICA a quella che esce dal generatore per i
social — e' la stessa grafica, non una parente. Due implementazioni della
stessa estetica divergono in un mese, e nessuno se ne accorge finche' non
finisce in onda.

Si puo' fare perche' il motore era gia' scritto per stare in piedi da solo:
non tocca document ne' window, e in fondo ha gia' un module.exports.

Da rilanciare ogni volta che il generatore cambia.
"""
import pathlib, sys

QUI = pathlib.Path(__file__).resolve().parent.parent
SORGENTE = QUI / "10_Look&Feel" / "Como TV OTT Design" / "generatore.html"
DESTINO = QUI / "13_Server_VM" / "ottgen.js"

righe = SORGENTE.read_text(encoding="utf-8", errors="replace").split("\n")

# LOGO_LIB serve al marchio dentro la maschera: sta in un <script> suo.
riga_logo = next(i for i, r in enumerate(righe) if r.lstrip().startswith("<script>var LOGO_LIB="))
# Il motore e' una IIFE che finisce con root.OTTGEN=API e la riga di chiusura.
riga_fine = next(i for i, r in enumerate(righe) if r.strip() == "root.OTTGEN=API;")
riga_inizio = next(i for i in range(riga_fine, 0, -1) if righe[i].lstrip().startswith("<script"))

def pulisci(t):
    return t.replace("<script>", "").replace("</script>", "")

testata = f"""/* ══════════════════════════════════════════════════════════════════════
 *  MOTORE DELLE GRAFICHE — copia automatica, non modificare a mano
 * ══════════════════════════════════════════════════════════════════════
 *  Generato da 13_Server_VM/estrai-motore.py leggendo
 *  10_Look&Feel/Como TV OTT Design/generatore.html
 *  (righe {riga_logo+1} e {riga_inizio+1}-{riga_fine+2})
 *
 *  Ogni modifica fatta qui sparisce alla prossima estrazione: si cambia il
 *  generatore, non questo file.
 */
"""
fuori = testata + pulisci(righe[riga_logo]) + "\n" + \
        "\n".join(pulisci(r) for r in righe[riga_inizio:riga_fine + 2]) + "\n"
DESTINO.write_text(fuori, encoding="utf-8")
print(f"scritto {DESTINO.name}: {len(fuori)} caratteri")
