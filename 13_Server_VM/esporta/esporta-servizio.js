#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  SERVIZIO ESPORTA — la coda che trasforma le grafiche in file video
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Sta ACCANTO al ponte, non dentro: Chrome e' pesante e ogni tanto si
 *  pianta, e se si piantasse dentro il ponte cadrebbero le grafiche in onda.
 *  Da qui il ponte non se ne accorge nemmeno, e cambiare questo file non lo
 *  riavvia.
 *
 *  Un'esportazione alla volta, a priorita' bassa (nice 19): il ponte ha
 *  sempre la precedenza sulla CPU. Resta la regola della trascrizione —
 *  niente esportazioni durante una diretta — scritta anche accanto al tasto.
 *
 *  Parla con gli editor (Talent Hunters, risultati, classifiche, tabelloni):
 *    GET  salute              -> {ok, occupato, coda}
 *    POST avvia  {motore, d, nome}  -> {ok, id}   (sempre a 50 fps, dal 22/09/2026)
 *    GET  stato?id=           -> {stato: coda|lavoro|pronto|errore, fotogrammi, posto, errore}
 *    GET  file?id=            -> il file, da scaricare
 *
 *  Rende solo i motori dell'elenco qui sotto, e solo dalla casa sua
 *  (ESPORTA_BASE): non e' un Chrome a disposizione di chiunque.
 *
 *  Variabili: ESPORTA_PORTA (8091 dev), ESPORTA_BASE (indirizzo della cartella
 *  live), ESPORTA_CHROME (il chrome-headless-shell).
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const PORTA = parseInt(process.env.ESPORTA_PORTA || "8091", 10);
const BASE = process.env.ESPORTA_BASE || "https://projects-cloud.it/como-tv-dev/live/";
const CHROME = process.env.ESPORTA_CHROME || "";
const LAVORI = path.join(__dirname, "lavori");
const TIENI_MS = 2 * 3600 * 1000;          // i file restano due ore, poi si buttano
const CODA_MAX = 5;
fs.mkdirSync(LAVORI, { recursive: true });

// i motori che si possono esportare: il formato (le trasparenti in MOV, le
// grafiche col loro fondo in MP4) e come comincia il nome del file
const MOTORI = {
  "th-carta-vmix.html":    { ext: "mp4", nome: "TH_carta" },
  "th-approved-vmix.html": { ext: "mp4", nome: "TH_approved" },
  "th-heatmap-vmix.html":  { ext: "mp4", nome: "TH_heatmap" },
  "th-torta-vmix.html":    { ext: "mov", nome: "TH_torta" },
  "th-radar-vmix.html":    { ext: "mov", nome: "TH_radar" },
  // dal 21/09/2026: le grafiche di dati, col loro fondo e con la WIPE Como
  // TV davanti (le bande oro, come le montano in post): MOV trasparente,
  // perche' prima che la wipe copra si vede il pezzo precedente. Talent
  // Hunters la wipe non ce l'ha.
  "risultati-vmix.html":   { ext: "mp4", nome: "RISULTATI", wipe: true },
  "classifica-vmix.html":  { ext: "mp4", nome: "CLASSIFICA", wipe: true },
  "tabellone-vmix.html":   { ext: "mp4", nome: "TABELLONE", wipe: true },
  "gruppi-vmix.html":      { ext: "mp4", nome: "GIRONI", wipe: true }
};
// la wipe sta accanto al servizio (1920x1080, ProRes 4444, 60 fps, 0,95 s:
// le bande coprono tutto a 0,5 s). Se manca, si esporta senza, in MP4.
const WIPE = path.join(__dirname, "wipe-como.mov");
function conWipe(M) { return !!(M.wipe && fs.existsSync(WIPE)); }

const lavori = new Map();   // id -> {stato, motore, url, ext, nome, fotogrammi, errore, creato}
const coda = [];
let inCorso = null;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pulito(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function rispondi(res, codice, obj) {
  res.writeHead(codice, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function prossimo() {
  if (inCorso || !coda.length) return;
  const id = coda.shift(), L = lavori.get(id);
  if (!L) return prossimo();
  inCorso = id;
  L.stato = "lavoro";
  const out = path.join(LAVORI, id + "." + L.ext);
  const args = ["-n", "19", process.execPath, path.join(__dirname, "esporta-grafica.js"),
                "--url", L.url, "--out", out, "--secondi", "auto", "--fps", String(L.fps || 25)];
  if (CHROME) args.push("--chrome", CHROME);
  if (L.wipe) args.push("--wipe", WIPE, "--wipe-copre", "0.5");
  const p = spawn("nice", args, { stdio: ["ignore", "pipe", "pipe"] });
  let coda_err = "";
  p.stdout.on("data", (b) => {
    String(b).split("\n").forEach((riga) => {
      const m = riga.match(/^FOTOGRAMMI (\d+)/);
      if (m) L.fotogrammi = parseInt(m[1], 10);
    });
  });
  p.stderr.on("data", (b) => { coda_err = (coda_err + String(b)).slice(-600); });
  // un'esportazione non dura mai piu' di cinque minuti (dieci a 50 fps, che
  // sono il doppio dei fotogrammi): se succede, Chrome si e' piantato, e la
  // coda non deve restare ferma per sempre
  const tempo = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) {} }, (L.fps === 50 ? 10 : 5) * 60 * 1000);
  p.on("close", (codice) => {
    clearTimeout(tempo);
    if (codice === 0 && fs.existsSync(out)) { L.stato = "pronto"; L.file = out; }
    else {
      L.stato = "errore";
      const m = coda_err.match(/ERRORE (.*)/);
      L.errore = m ? m[1].trim() : "esportazione non riuscita";
      try { fs.unlinkSync(out); } catch (e) {}
      console.error("[esporta] " + id + " fallita: " + coda_err);
    }
    inCorso = null;
    prossimo();
  });
}

// le pulizie: file e lavori piu' vecchi di due ore
setInterval(() => {
  const ora = Date.now();
  for (const [id, L] of lavori) {
    if (ora - L.creato < TIENI_MS || L.stato === "lavoro" || L.stato === "coda") continue;
    if (L.file) { try { fs.unlinkSync(L.file); } catch (e) {} }
    lavori.delete(id);
  }
}, 10 * 60 * 1000);

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const via = u.pathname.replace(/^\/+/, "");

  if (req.method === "GET" && via === "salute") {
    return rispondi(res, 200, { ok: true, occupato: !!inCorso, coda: coda.length });
  }

  if (req.method === "POST" && via === "avvia") {
    let corpo = "";
    req.on("data", (b) => { corpo += b; if (corpo.length > 200000) req.destroy(); });
    req.on("end", () => {
      let p;
      try { p = JSON.parse(corpo); } catch (e) { return rispondi(res, 400, { ok: false, errore: "richiesta non valida" }); }
      const M = MOTORI[p.motore];
      if (!M) return rispondi(res, 400, { ok: false, errore: "questa grafica non si esporta" });
      const wipe = conWipe(M);
      // sempre 50 fotogrammi al secondo: le sequenze di Premiere dei montatori
      // sono a 50p (il 25 e' stato tolto il 22/09/2026)
      const fps = 50;
      const ext = wipe ? "mov" : M.ext;
      if (!p.d || typeof p.d !== "object") return rispondi(res, 400, { ok: false, errore: "mancano i dati della grafica" });
      if (coda.length >= CODA_MAX) return rispondi(res, 429, { ok: false, errore: "troppe esportazioni in fila: riprova fra poco" });
      const url = BASE + p.motore + "?d=" + b64url(p.d);
      // oltre gli 8 KB nginx rifiuta l'indirizzo: meglio dirlo subito che dopo un minuto
      if (url.length > 7800) return rispondi(res, 400, { ok: false, errore: "dati troppo lunghi per l'indirizzo della grafica" });
      const id = crypto.randomBytes(8).toString("hex");
      const giorno = new Date().toISOString().slice(0, 10);
      const nome = [M.nome, pulito(p.nome), giorno].filter(Boolean).join("_") + "." + ext;
      lavori.set(id, { stato: "coda", motore: p.motore, url, ext, nome, wipe, fps, fotogrammi: 0, creato: Date.now() });
      coda.push(id);
      prossimo();
      rispondi(res, 200, { ok: true, id, nome, formato: ext });
    });
    return;
  }

  if (req.method === "GET" && via === "stato") {
    const L = lavori.get(u.searchParams.get("id") || "");
    if (!L) return rispondi(res, 404, { ok: false, errore: "esportazione sconosciuta (forse scaduta)" });
    return rispondi(res, 200, { ok: true, stato: L.stato, fotogrammi: L.fotogrammi, secondi: +(L.fotogrammi / (L.fps || 25)).toFixed(1),
                                posto: L.stato === "coda" ? coda.indexOf(u.searchParams.get("id")) + 1 : 0,
                                nome: L.nome, errore: L.errore || null });
  }

  if (req.method === "GET" && via === "file") {
    const L = lavori.get(u.searchParams.get("id") || "");
    if (!L || L.stato !== "pronto" || !L.file) return rispondi(res, 404, { ok: false, errore: "file non pronto" });
    const st = fs.statSync(L.file);
    res.writeHead(200, {
      "Content-Type": L.ext === "mov" ? "video/quicktime" : "video/mp4",
      "Content-Length": st.size,
      "Content-Disposition": 'attachment; filename="' + L.nome + '"',
      "Cache-Control": "no-store"
    });
    return fs.createReadStream(L.file).pipe(res);
  }

  rispondi(res, 404, { ok: false, errore: "non c'e'" });
}).listen(PORTA, "127.0.0.1", () => console.log("[esporta] in ascolto su 127.0.0.1:" + PORTA + " · base " + BASE));
