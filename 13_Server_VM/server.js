/**
 * ═══════════════════════════════════════════════════════════════════
 *  PONTE COMO TV — server per la VM (sostituisce Apps Script)
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Cosa fa
 *  ───────
 *  1) Serve le pagine delle Grafiche Live (cartella statica).
 *  2) Fa da centralino della regia: scalette, messa in onda e stato
 *     partita per 7 canali, con le stesse chiamate che le pagine
 *     facevano ad Apps Script (nessuna modifica alla loro logica).
 *  3) Spinge gli aggiornamenti in tempo reale (SSE): il layer vMix
 *     riceve il comando in pochi millisecondi invece di aspettare il
 *     prossimo giro di interrogazione.
 *  4) Gli invii ai Fogli Google restano su Apps Script: qui vengono
 *     solo inoltrati (là scrivere sui fogli è la cosa giusta, e la
 *     lentezza non conta).
 *
 *  Nessuna libreria esterna: solo Node. Niente da aggiornare, niente
 *  che possa rompersi da solo.
 *
 *  Avvio a mano:   node server.js
 *  In produzione:  systemctl start comotv   (vedi comotv.service)
 */

"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

// ─────────────────────────────────────────────── configurazione
const CONFIG = {
  PORTA: parseInt(process.env.COMOTV_PORTA || "8080", 10),

  // parola d'ordine attesa nei comandi (la stessa cablata nelle pagine)
  TOKEN: process.env.COMOTV_TOKEN || "como_tv_grafiche",

  // cartella con le pagine (live, assets, index.html…)
  SITO: process.env.COMOTV_SITO || "/var/www/comotv",

  // dove viene salvato lo stato (sopravvive ai riavvii)
  STATO: process.env.COMOTV_STATO || "/var/lib/comotv/stato.json",

  // loghi delle squadre caricati dalla redazione (giovanili, amichevoli…)
  LOGHI: process.env.COMOTV_LOGHI || "/var/lib/comotv/loghi",

  CANALI: 7,
  MAX_SCALETTA: 30,

  // gli invii "Al foglio" continuano ad andare qui
  PONTE_FOGLI: process.env.COMOTV_PONTE_FOGLI ||
    "https://script.google.com/macros/s/AKfycbwAw49xwBpCt9P6HfNgJTsc2MBwxy72T7RUsSPqtcHBnh0fyuC40phQTR3FeZEKdfPw/exec"
};

// ─────────────────────────────────────────────── stato in memoria
// regia[c]   = { nonce, items:[{id,tipo,titolo,dest,ts,liv}], liv:{1..5:{state,onair,playNonce}} }
// voci[c][id]= dati completi della grafica
// partita[c] = { fase, camp, casa, osp, p1, p2, rec, clock, cSeq, srvTs, nonce }
let S = { regia: {}, voci: {}, partita: {}, progetti: {} };

function canaleDi(v) {
  const c = parseInt(v, 10);
  if (isNaN(c) || c < 1) return 1;
  return c > CONFIG.CANALI ? CONFIG.CANALI : c;
}

function regiaDi(c) {
  if (!S.regia[c]) S.regia[c] = { nonce: 0, items: [], liv: {} };
  if (!S.regia[c].liv) S.regia[c].liv = {};
  if (!S.regia[c].items) S.regia[c].items = [];
  if (!S.voci[c]) S.voci[c] = {};
  return S.regia[c];
}

// Le grafiche vivono su livelli sovrapposti (1..5): un sottopancia può
// stare in onda insieme a una classifica. Ogni livello ha il suo stato.
const LIVELLI = 5;
function livelloDi(v) {
  const L = parseInt(v, 10);
  if (isNaN(L) || L < 1) return 1;
  return L > LIVELLI ? LIVELLI : L;
}
function livDi(ix, v) {
  const L = livelloDi(v);
  if (!ix.liv[L]) ix.liv[L] = { state: "standby", onair: null, playNonce: 0 };
  return ix.liv[L];
}

// ─────────────────────────────────────────────── salvataggio su disco
let salvataggioInCorso = null;
function salva() {
  if (salvataggioInCorso) return;
  salvataggioInCorso = setTimeout(() => {
    salvataggioInCorso = null;
    try {
      fs.mkdirSync(path.dirname(CONFIG.STATO), { recursive: true });
      // scrittura atomica: prima il file temporaneo, poi la sostituzione
      const tmp = CONFIG.STATO + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(S));
      fs.renameSync(tmp, CONFIG.STATO);
    } catch (err) {
      console.error("[stato] salvataggio fallito:", err.message);
    }
  }, 400);
}

function carica() {
  try {
    if (fs.existsSync(CONFIG.STATO)) {
      const letto = JSON.parse(fs.readFileSync(CONFIG.STATO, "utf8"));
      if (letto && letto.regia) S = Object.assign({ regia: {}, voci: {}, partita: {}, progetti: {} }, letto);
      if (!S.progetti) S.progetti = {};
      // stato salvato prima dei livelli: quello che era in onda finisce
      // sul livello 1, così un aggiornamento del ponte non spegne nulla
      let convertiti = 0;
      for (const c of Object.keys(S.regia)) {
        const ix = S.regia[c];
        if (!ix.liv && (ix.state || ix.onair)) {
          ix.liv = { 1: { state: ix.state || "standby", onair: ix.onair || null, playNonce: ix.playNonce || 0 } };
          (ix.items || []).forEach(i => { if (i.liv == null) i.liv = 1; });
          delete ix.state; delete ix.onair; delete ix.playNonce;
          convertiti++;
        }
      }
      console.log("[stato] ripreso da " + CONFIG.STATO + (convertiti ? " (" + convertiti + " canali convertiti ai livelli)" : ""));
    }
  } catch (err) {
    console.error("[stato] file illeggibile, riparto pulito:", err.message);
  }
}

// ─────────────────────────────────────────────── tempo reale (SSE)
// Ogni layer vMix e ogni console tiene aperta una connessione: quando
// qualcosa cambia riceve la novità all'istante, senza interrogare.
const ascoltatori = new Map();   // canale -> Set(response)

function iscrivi(c, res) {
  if (!ascoltatori.has(c)) ascoltatori.set(c, new Set());
  ascoltatori.get(c).add(res);
  res.on("close", () => {
    const g = ascoltatori.get(c);
    if (g) g.delete(res);
  });
}

function annuncia(c, tipo) {
  const g = ascoltatori.get(c);
  if (!g || !g.size) return;
  const corpo = tipo === "partita" ? statoPartita(c) : statoRegia(c);
  const riga = "event: " + tipo + "\ndata: " + JSON.stringify(corpo) + "\n\n";
  for (const res of g) {
    try { res.write(riga); } catch (err) { /* connessione caduta: la ripulisce 'close' */ }
  }
}

// ─────────────────────────────────────────────── letture
function statoRegia(c) {
  const ix = regiaDi(c);
  const liv = {};
  for (let L = 1; L <= LIVELLI; L++) {
    const lv = ix.liv[L];
    if (!lv) continue;
    const voce = { playNonce: lv.playNonce, state: lv.state, onair: lv.onair };
    if (lv.onair) {
      voce.dati = S.voci[c][lv.onair] || null;
      const on = ix.items.find(i => i.id === lv.onair);
      voce.tipo = on ? on.tipo : "formazione";
    }
    liv[String(L)] = voce;
  }
  // il livello 1 resta anche in cima, così le pagine più vecchie
  // continuano a funzionare senza sapere nulla dei livelli
  const uno = ix.liv[1] || { state: "standby", onair: null, playNonce: 0 };
  const out = {
    canale: c, nonce: ix.nonce, playNonce: uno.playNonce,
    state: uno.state, onair: uno.onair, items: ix.items, liv: liv,
    ver: versionePagine()
  };
  if (uno.onair) {
    out.dati = S.voci[c][uno.onair] || null;
    const on = ix.items.find(i => i.id === uno.onair);
    out.tipo = on ? on.tipo : "formazione";
  }
  return out;
}

// Versione delle pagine: cambia a ogni aggiornamento del sito. I layer
// vMix la controllano e si ricaricano da soli, così una modifica al
// disegno entra in onda senza andare a riavviare sette macchine.
let verCache = { v: "", quando: 0 };
function versionePagine() {
  const ora = Date.now();
  if (ora - verCache.quando < 5000) return verCache.v;
  verCache.quando = ora;
  try {
    const f = path.join(CONFIG.SITO, "live", "partita-live.html");
    verCache.v = String(Math.floor(fs.statSync(f).mtimeMs));
  } catch (err) {
    verCache.v = "";
  }
  return verCache.v;
}

function statoPartita(c) {
  const p = S.partita[c] || {};
  return Object.assign({}, p, { srv: Date.now(), ver: versionePagine() });
}

// ─────────────────────────────────────────────── comandi
function regiaLoad(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  if (ix.items.length >= CONFIG.MAX_SCALETTA) {
    throw new Error("scaletta piena (" + CONFIG.MAX_SCALETTA + " grafiche): elimina qualcosa dalla console");
  }
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  S.voci[c][id] = p.dati || {};

  // titoli mai uguali: il doppione diventa "… (2)", "… (3)" ecc.
  const base = p.titolo || p.grafica || "grafica";
  let titolo = base, n = 2;
  while (ix.items.some(i => i.titolo === titolo)) { titolo = base + " (" + n + ")"; n++; }

  ix.items.push({
    id, tipo: p.grafica || "formazione", titolo,
    dest: p.dest === "partita" ? "partita" : (p.dest === "studio" ? "studio" : ""),
    ts: Date.now(), liv: livelloDi(p.liv)
  });
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, id, nonce: ix.nonce };
}

// sposta una grafica su un altro livello
function regiaLiv(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const it = ix.items.find(i => i.id === p.id);
  if (it) it.liv = livelloDi(p.liv);
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

function regiaState(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  // il livello arriva dal comando; se non c'è si usa quello della grafica
  let L = p.liv;
  if (L == null && p.id) {
    const it = ix.items.find(i => i.id === p.id);
    if (it) L = it.liv;
  }
  const lv = livDi(ix, L);
  if (p.state === "play") {
    const id = p.id || lv.onair;
    if (!ix.items.some(i => i.id === id)) throw new Error("grafica non trovata in scaletta");
    lv.onair = id;
    lv.state = "play";
  } else if (p.state === "out") {
    lv.state = "out";
  } else {
    lv.state = "standby";
  }
  ix.nonce = Date.now();
  lv.playNonce = ix.nonce;
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce, state: lv.state, onair: lv.onair, liv: livelloDi(L) };
}

function regiaDel(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  for (const L of Object.keys(ix.liv)) {
    const lv = ix.liv[L];
    if (lv.onair === p.id && lv.state === "play") throw new Error("questa grafica è IN ONDA: prima Fuori onda");
  }
  ix.items = ix.items.filter(i => i.id !== p.id);
  for (const L of Object.keys(ix.liv)) {
    if (ix.liv[L].onair === p.id) ix.liv[L].onair = null;
  }
  delete S.voci[c][p.id];
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce, state: ix.state, onair: ix.onair };
}

function regiaRename(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const it = ix.items.find(i => i.id === p.id);
  if (it) it.titolo = String(p.titolo || "").slice(0, 60) || it.titolo;
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

function regiaOrder(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const mappa = new Map(ix.items.map(i => [i.id, i]));
  const nuovo = [];
  (p.order || []).forEach(id => {
    if (mappa.has(id)) { nuovo.push(mappa.get(id)); mappa.delete(id); }
  });
  for (const resto of mappa.values()) nuovo.push(resto);   // voci non citate: in coda, mai perse
  ix.items = nuovo;
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

function regiaMove(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const i = ix.items.findIndex(x => x.id === p.id);
  const j = i + (p.dir === "up" ? -1 : 1);
  if (i === -1 || j < 0 || j >= ix.items.length) return { ok: true, canale: c, nonce: ix.nonce };
  const t = ix.items[i]; ix.items[i] = ix.items[j]; ix.items[j] = t;
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

function partitaSet(p) {
  const c = canaleDi(p.c);
  const stato = p.stato || {};
  // due click ravvicinati possono superarsi in rete: vince la sequenza
  // più alta del pannello, le scritture in ritardo vengono scartate
  const vecchio = S.partita[c];
  if (stato.cSeq && vecchio && vecchio.cSeq && vecchio.cSeq >= stato.cSeq) {
    return { ok: true, canale: c, scartata: true, nonce: vecchio.nonce };
  }
  stato.srvTs = Date.now();
  stato.nonce = stato.srvTs;
  S.partita[c] = stato;
  salva(); annuncia(c, "partita");
  return { ok: true, canale: c, nonce: stato.nonce };
}

// ─────────────────────────────────────────────── inoltro ad Apps Script
// Gli invii ai Fogli Google (e la lettura dei file su Drive) restano
// dove hanno senso: qui vengono solo passati avanti.
function inoltra(corpo) {
  return new Promise((risolvi) => {
    const dati = Buffer.from(JSON.stringify(corpo), "utf8");
    const u = new URL(CONFIG.PONTE_FOGLI);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8", "Content-Length": dati.length }
    }, (res) => {
      // Apps Script risponde con un redirect: lo seguiamo a mano
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (r2) => {
          let buf = "";
          r2.on("data", d => buf += d);
          r2.on("end", () => risolvi(interpreta(buf)));
        }).on("error", e => risolvi({ ok: false, errore: "foglio non raggiungibile: " + e.message }));
        return;
      }
      let buf = "";
      res.on("data", d => buf += d);
      res.on("end", () => risolvi(interpreta(buf)));
    });
    req.on("error", e => risolvi({ ok: false, errore: "foglio non raggiungibile: " + e.message }));
    req.write(dati);
    req.end();
  });

  function interpreta(testo) {
    try { return JSON.parse(testo); }
    catch (err) { return { ok: false, errore: "risposta inattesa dal foglio Google" }; }
  }
}

// ─────────────────────────────────────────────── progetti
// Un progetto e' una scaletta senza canale: la redazione lo riempie nei
// giorni prima (Football Show del lunedi', preparato il sabato) e il
// giorno del live lo si versa nel canale. Resta finche' non viene
// cancellato a mano.
function progettoCrea(p) {
  const nome = String(p.nome || "").trim();
  if (!nome) throw new Error("manca il nome del progetto");
  const id = String(Date.now());
  S.progetti[id] = { nome: nome, creato: Date.now(), items: [] };
  salva();
  return { ok: true, id: id, nome: nome };
}

function progettoDi(p) {
  const pr = S.progetti[String(p.id || "")];
  if (!pr) throw new Error("progetto inesistente (forse cancellato)");
  return pr;
}

function progettoAggiungi(p) {
  const pr = progettoDi(p);
  if (pr.items.length >= CONFIG.MAX_SCALETTA) {
    throw new Error("progetto pieno (" + CONFIG.MAX_SCALETTA + " grafiche)");
  }
  const base = p.titolo || p.grafica || "grafica";
  let titolo = base, n = 2;
  while (pr.items.some(i => i.titolo === titolo)) { titolo = base + " (" + n + ")"; n++; }
  pr.items.push({
    tipo: p.grafica || "formazione", titolo: titolo,
    liv: livelloDi(p.liv), dati: p.dati || {}, ts: Date.now()
  });
  salva();
  return { ok: true, id: p.id, nome: pr.nome, quante: pr.items.length };
}

function progettoElenco() {
  const out = Object.keys(S.progetti).map(id => ({
    id: id, nome: S.progetti[id].nome, creato: S.progetti[id].creato,
    quante: S.progetti[id].items.length
  }));
  out.sort((a, b) => b.creato - a.creato);
  return { ok: true, progetti: out };
}

function progettoLeggi(p) {
  const pr = progettoDi(p);
  return { ok: true, nome: pr.nome,
           items: pr.items.map(i => ({ tipo: i.tipo, titolo: i.titolo, liv: i.liv })) };
}

function progettoDel(p) {
  const pr = progettoDi(p);
  delete S.progetti[String(p.id)];
  salva();
  return { ok: true, nome: pr.nome };
}

// Versa il progetto nel canale SOSTITUENDO la scaletta — ma cio' che sta
// in onda in questo momento non si tocca: resta in scaletta e sui suoi
// livelli, il resto viene rimpiazzato dalle grafiche del progetto.
function progettoCarica(p) {
  const pr = progettoDi(p);
  if (!pr.items.length) {
    throw new Error('il progetto "' + pr.nome + '" \u00e8 vuoto: mandagli le grafiche dalle loro pagine, poi caricalo');
  }
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const inOnda = new Set();
  for (const L of Object.keys(ix.liv)) {
    const lv = ix.liv[L];
    if (lv && lv.state === "play" && lv.onair) inOnda.add(lv.onair);
  }
  const tenuti = ix.items.filter(i => inOnda.has(i.id));
  // le voci che escono liberano i loro dati
  for (const i of ix.items) {
    if (!inOnda.has(i.id)) delete S.voci[c][i.id];
  }
  const nuovi = [];
  for (const it of pr.items) {
    if (tenuti.length + nuovi.length >= CONFIG.MAX_SCALETTA) break;
    const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    S.voci[c][id] = it.dati || {};
    nuovi.push({ id: id, tipo: it.tipo, titolo: it.titolo, dest: "", ts: Date.now(), liv: it.liv || 1 });
  }
  ix.items = tenuti.concat(nuovi);
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nome: pr.nome, caricate: nuovi.length,
           tenuteInOnda: tenuti.length, nonce: ix.nonce };
}

// ─────────────────────────────────────────────── loghi delle squadre
// Le giovanili non hanno stemmi su nessuna fonte pubblica: la redazione
// li carica una volta e restano qui, richiamati per nome squadra.
const TIPI_LOGO = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" };

function slug(nome) {
  return String(nome || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function logoSalva(p) {
  const nome = String(p.nome || "").trim();
  if (!nome) throw new Error("manca il nome della squadra");
  const m = String(p.dati || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("immagine non riconosciuta");
  const est = TIPI_LOGO[m[1]];
  if (!est) throw new Error("formato non ammesso: usa PNG, JPG, WEBP o SVG");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 2 * 1024 * 1024) throw new Error("immagine troppo grande (massimo 2 MB)");

  const chiave = slug(nome);
  if (!chiave) throw new Error("nome squadra non valido");
  fs.mkdirSync(CONFIG.LOGHI, { recursive: true });
  // un logo per squadra: caricarne uno nuovo sostituisce il vecchio
  for (const e of Object.values(TIPI_LOGO)) {
    const vecchio = path.join(CONFIG.LOGHI, chiave + e);
    if (fs.existsSync(vecchio)) fs.unlinkSync(vecchio);
  }
  fs.writeFileSync(path.join(CONFIG.LOGHI, chiave + est), buf);
  return { ok: true, nome: nome, url: "/loghi/" + chiave + est };
}

function logoElenco() {
  try {
    const file = fs.readdirSync(CONFIG.LOGHI);
    return { ok: true, loghi: file.filter(f => Object.values(TIPI_LOGO).includes(path.extname(f)))
      .map(f => ({ chiave: path.basename(f, path.extname(f)), url: "/loghi/" + f })) };
  } catch (err) {
    return { ok: true, loghi: [] };
  }
}

function logoCancella(p) {
  const chiave = slug(p.nome);
  let tolti = 0;
  for (const e of Object.values(TIPI_LOGO)) {
    const f = path.join(CONFIG.LOGHI, chiave + e);
    if (fs.existsSync(f)) { fs.unlinkSync(f); tolti++; }
  }
  return { ok: true, tolti: tolti };
}

// ─────────────────────────────────────────────── indirizzi brevi
// Invece di /live/regia.html si scrive /regia. Le pagine con
// il canale accettano l'indirizzo con la barra: /regia/3, /studio/2.
const SCORCIATOIE = {
  "/live":         "/live/classifiche.html",
  "/grafiche":     "/live/classifiche.html",
  "/regia":        "/live/regia.html",
  "/partita":      "/live/partita.html",
  "/match":        "/live/partita.html",
  "/classifiche":  "/live/classifiche-campionati.html",
  "/risultati":    "/live/risultati.html",
  "/formazioni":   "/live/formazioni.html",
  "/marcatori":    "/live/marcatori.html",
  "/sottopancia":  "/live/sottopancia.html",
  "/campetto":     "/live/campetto.html"
};
// con il numero del canale in fondo: /regia/3, /studio/2, /match/5
const SCORCIATOIE_CANALE = {
  "regia":   "/live/regia.html",
  "partita": "/live/partita.html",
  // Il playout e' uno solo: porta le grafiche sui cinque livelli e le due
  // parti del Live Match. E' questo l'indirizzo da mettere nei vMix.
  "playout": "/live/grafica-live.html",
  // vecchi nomi, per gli input non ancora ripuntati
  "studio":  "/live/grafica-live.html",
  "match":   "/live/partita-live.html"
};

function scorciatoia(percorso) {
  const pulito = percorso.replace(/\/+$/, "") || "/";
  if (SCORCIATOIE[pulito]) return { file: SCORCIATOIE[pulito] };
  const m = pulito.match(/^\/([a-z]+)\/([1-7])$/);
  if (m && SCORCIATOIE_CANALE[m[1]]) {
    return { file: SCORCIATOIE_CANALE[m[1]], canale: m[2] };
  }
  return null;
}

// ─────────────────────────────────────────────── file statici
const TIPI = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".txt": "text/plain; charset=utf-8"
};

// Cosa non esce da qui: le cartelle di servizio, i file nascosti e
// tutto ciò che è codice o procedura invece che pagina.
const CARTELLE_CHIUSE = ["13_Server_VM", "8_Push Script"];
const ESTENSIONI_CHIUSE = [".sh", ".command", ".gs", ".py", ".jsx", ".md", ".service", ".timer", ".conf"];

function consentito(rel) {
  const pezzi = rel.split("/").filter(Boolean);
  if (pezzi.some(p => p.startsWith("."))) return false;            // .git, .gitignore…
  if (pezzi.length && CARTELLE_CHIUSE.indexOf(pezzi[0]) >= 0) return false;
  if (ESTENSIONI_CHIUSE.indexOf(path.extname(rel).toLowerCase()) >= 0) return false;
  return true;
}

function serviStatico(req, res, percorso) {
  let rel = decodeURIComponent(percorso.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(CONFIG.SITO, rel);
  // nessuna uscita dalla cartella del sito
  if (!file.startsWith(path.resolve(CONFIG.SITO))) { res.writeHead(403).end("vietato"); return; }
  // Nella cartella del sito c'è il clone del repo: accanto alle pagine
  // finiscono anche .git, il codice di questo server e gli script di
  // installazione. Non sono roba da mettere in mano a chi passa: chi
  // conosce l'indirizzo potrebbe leggersi come funziona il ponte.
  if (!consentito(rel)) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("non trovato"); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("non trovato"); return; }
    const tipo = TIPI[path.extname(file).toLowerCase()] || "application/octet-stream";
    // le pagine non si mettono in cache: gli aggiornamenti sono immediati,
    // niente più numeri di versione da cambiare su vMix
    // Pagine e script non si mettono MAI in cache: sono il codice delle
    // grafiche, e un vMix acceso da ore deve prendere la versione nuova
    // appena si riavvia l'input, senza numeri di versione da cambiare.
    // Font e immagini invece cambiano quasi mai: quelli restano in cache.
    const vivo = tipo.startsWith("text/html") || tipo.startsWith("application/javascript");
    const cache = vivo ? "no-store" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": tipo, "Cache-Control": cache });
    fs.createReadStream(file).pipe(res);
  });
}

// ─────────────────────────────────────────────── server
function json(res, corpo, codice) {
  const testo = JSON.stringify(corpo);
  res.writeHead(codice || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(testo);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  const q = u.searchParams;

  // preflight (se qualcuno chiama da un altro indirizzo)
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  // ── tempo reale ──
  if (u.pathname === "/api/stream") {
    const c = canaleDi(q.get("canale") || q.get("c"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",            // nginx non deve accumulare
      "Access-Control-Allow-Origin": "*"
    });
    res.write("retry: 2000\n\n");
    res.write("event: regia\ndata: " + JSON.stringify(statoRegia(c)) + "\n\n");
    res.write("event: partita\ndata: " + JSON.stringify(statoPartita(c)) + "\n\n");
    iscrivi(c, res);
    // battito: tiene viva la connessione attraverso nginx e proxy
    const battito = setInterval(() => { try { res.write(": battito\n\n"); } catch (e) {} }, 20000);
    res.on("close", () => clearInterval(battito));
    return;
  }

  // ── letture compatibili con il vecchio ponte ──
  if (req.method === "GET" && (u.pathname === "/api" || u.pathname === "/exec")) {
    if (q.get("regia") === "item" && q.get("id")) {
      const c = canaleDi(q.get("canale") || q.get("c"));
      return json(res, (S.voci[c] && S.voci[c][q.get("id")]) || {});
    }
    if (q.get("regia")) return json(res, statoRegia(canaleDi(q.get("canale") || q.get("c"))));
    if (q.get("partita")) return json(res, statoPartita(canaleDi(q.get("canale") || q.get("c"))));
    if (q.get("loghi")) return json(res, logoElenco());
    return json(res, { ok: true, servizio: "Ponte Como TV", canali: CONFIG.CANALI, versione: 1 });
  }

  // ── comandi ──
  if (req.method === "POST" && (u.pathname === "/api" || u.pathname === "/exec")) {
    let corpo = "";
    req.on("data", d => {
      corpo += d;
      if (corpo.length > 4e6) { req.destroy(); }      // guardia anti-abuso
    });
    req.on("end", async () => {
      let p, out;
      try { p = JSON.parse(corpo); } catch (err) { return json(res, { ok: false, errore: "richiesta illeggibile" }); }
      try {
        if (p.token !== CONFIG.TOKEN) throw new Error("token non valido");
        switch (p.tipo) {
          case "regia-load":   out = regiaLoad(p); break;
          case "regia-state":  out = regiaState(p); break;
          case "regia-del":    out = regiaDel(p); break;
          case "regia-move":   out = regiaMove(p); break;
          case "regia-order":  out = regiaOrder(p); break;
          case "regia-rename": out = regiaRename(p); break;
          case "regia-liv":    out = regiaLiv(p); break;
          case "progetto-crea":     out = progettoCrea(p); break;
          case "progetto-aggiungi": out = progettoAggiungi(p); break;
          case "progetto-elenco":   out = progettoElenco(); break;
          case "progetto-leggi":    out = progettoLeggi(p); break;
          case "progetto-del":      out = progettoDel(p); break;
          case "progetto-carica":   out = progettoCarica(p); break;
          case "partita-set":  out = partitaSet(p); break;
          case "logo-carica":  out = logoSalva(p); break;
          case "logo-togli":   out = logoCancella(p); break;
          // questi vivono sui Fogli Google: si inoltrano
          case "formazioni":
          case "classifica":
          case "eventi":
          case "drive-info":   out = await inoltra(p); break;
          default: throw new Error("tipo di invio sconosciuto: " + p.tipo);
        }
        if (out.ok === undefined) out.ok = true;
      } catch (err) {
        out = { ok: false, errore: err.message };
      }
      json(res, out);
    });
    return;
  }

  // ── loghi caricati dalla redazione ──
  if (u.pathname.startsWith("/loghi/")) {
    const nome = path.basename(decodeURIComponent(u.pathname));
    const file = path.join(CONFIG.LOGHI, nome);
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
      res.writeHead(200, {
        "Content-Type": TIPI[path.extname(file).toLowerCase()] || "image/png",
        "Cache-Control": "public, max-age=600",
        "Access-Control-Allow-Origin": "*"
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  // Como TV puo' essere servita anche sotto un prefisso di percorso
  // (projects-cloud.it/como-tv): nginx lo toglie prima di passarci la
  // richiesta e ce lo dichiara in questa intestazione. I reindirizzi
  // devono rimetterlo, altrimenti butterebbero il browser fuori dal
  // prefisso a ogni scorciatoia.
  const PREFISSO = String(req.headers["x-forwarded-prefix"] || "");

  // ── vecchi indirizzi ──
  // La cartella si chiamava 11_Script_Live. Finché non sono stati
  // ricontrollati tutti i vMix e i segnalibri della redazione, il
  // vecchio indirizzo deve portare alla pagina giusta invece di dare
  // schermo nero in onda.
  if (u.pathname.indexOf("/11_Script_Live/") === 0) {
    res.writeHead(301, { "Location": PREFISSO + u.pathname.replace("/11_Script_Live/", "/live/") + (u.search || "") });
    return res.end();
  }

  // ── indirizzi brevi ──
  const corta = scorciatoia(u.pathname);
  if (corta) {
    // Si manda sempre il browser sull'indirizzo lungo, non si serve la
    // pagina qui: altrimenti resterebbe in barra /formazioni, e tutti i
    // link relativi della pagina (la barra in alto, la home, le altre
    // schede) cercherebbero i file nella radice invece che in /live/.
    // Il numero del canale viene passato come se fosse stato scritto a
    // mano, così le pagine non cambiano di una riga.
    let coda = u.search || "";
    if (corta.canale && !q.get("c")) {
      coda = "?c=" + corta.canale + (u.search ? "&" + u.search.slice(1) : "");
    }
    res.writeHead(302, { "Location": PREFISSO + corta.file + coda });
    return res.end();
  }

  // ── pagine ──
  serviStatico(req, res, u.pathname);
});

carica();
server.listen(CONFIG.PORTA, () => {
  console.log("Ponte Como TV in ascolto sulla porta " + CONFIG.PORTA);
  console.log("  pagine da:  " + CONFIG.SITO);
  console.log("  stato in:   " + CONFIG.STATO);
  console.log("  canali:     " + CONFIG.CANALI);
});

// spegnimento pulito: salva e chiude le connessioni in tempo reale
["SIGTERM", "SIGINT"].forEach(sig => process.on(sig, () => {
  try {
    fs.mkdirSync(path.dirname(CONFIG.STATO), { recursive: true });
    fs.writeFileSync(CONFIG.STATO, JSON.stringify(S));
  } catch (err) {}
  for (const g of ascoltatori.values()) for (const res of g) { try { res.end(); } catch (e) {} }
  process.exit(0);
}));
