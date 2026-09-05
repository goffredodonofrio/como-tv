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

// ── Clip Live (registrazione del flusso, DVR, taglio) ─────────────────
// Vive in un file suo e resta SPENTO se non lo si accende con COMOTV_CLIP=1:
// il ponte di produzione carica queste righe e non cambia di comportamento.
let CLIP = null;
try { CLIP = require("./clip.js"); } catch (e) { CLIP = null; }


// ─────────────────────────────────────────────── configurazione
const CONFIG = {
  PORTA: parseInt(process.env.COMOTV_PORTA || "8080", 10),

  // parola d'ordine attesa nei comandi (la stessa cablata nelle pagine)
  TOKEN: process.env.COMOTV_TOKEN || "como_tv_grafiche",
  // DUE LIVELLI, dall'ambiente (mai scritte qui: questo file sta su un repo
  // pubblico). Vuote = livelli spenti, e vale solo il vecchio TOKEN: cosi'
  // un ponte non ancora configurato continua a funzionare come prima.
  CHIAVE_COMANDO: process.env.COMOTV_CHIAVE_COMANDO || "",
  CHIAVE_CONTRIBUTO: process.env.COMOTV_CHIAVE_CONTRIBUTO || "",
  // Una password a testa, invece di una sola che gira fra tutti. Si scrive
  //   COMOTV_CHIAVI="panda:xxxx,marco:yyyy"
  // Chi lavora da casa se la digita una volta sul suo computer e non deve
  // piu' chiederla a nessuno; e se un giorno una va tolta, si toglie quella
  // sola senza cambiare la chiave a tutta la redazione.
  CHIAVI: String(process.env.COMOTV_CHIAVI || "")
    .split(",").map(x => x.trim()).filter(Boolean)
    .map(x => {
      const i = x.indexOf(":");
      return i > 0 ? { nome: x.slice(0, i).trim(), chiave: x.slice(i + 1).trim() }
                   : { nome: "", chiave: x };
    }).filter(x => x.chiave),
  // Passaggio: con COMOTV_VECCHIO_OK=1 il vecchio token continua a valere,
  // ma SOLO come contributo. Serve nel momento del cambio, quando in giro ci
  // sono ancora pagine aperte con dentro la chiave vecchia: quelle possono
  // mandare in scaletta, non mandare in onda. Si toglie appena tutti hanno
  // ricaricato.
  VECCHIO_OK: process.env.COMOTV_VECCHIO_OK === "1",

  // cartella con le pagine (live, assets, index.html…)
  SITO: process.env.COMOTV_SITO || "/var/www/comotv",

  // dove viene salvato lo stato (sopravvive ai riavvii)
  STATO: process.env.COMOTV_STATO || "/var/lib/comotv/stato.json",

  // loghi delle squadre caricati dalla redazione (giovanili, amichevoli…)
  LOGHI: process.env.COMOTV_LOGHI || "/var/lib/comotv/loghi",

  // contributi video del PAT (origine "cloud"): accanto allo stato, cosi'
  // dev e produzione hanno cartelle separate senza configurare nulla
  VIDEO: process.env.COMOTV_VIDEO || null,   // risolta a runtime da STATO

  CANALI: 8,
  // Nessun tetto alle grafiche in scaletta: trenta bastavano per una partita,
  // non per una giornata intera o per un progetto d'archivio. Resta un numero
  // altissimo come rete di sicurezza contro un invio impazzito che riempirebbe
  // il disco e il polling della console — non e' un limite che si incontra
  // lavorando. Si cambia con COMOTV_MAX_SCALETTA.
  MAX_SCALETTA: parseInt(process.env.COMOTV_MAX_SCALETTA, 10) || 5000,

  // gli invii "Al foglio" continuano ad andare qui
  PONTE_FOGLI: process.env.COMOTV_PONTE_FOGLI ||
    "https://script.google.com/macros/s/AKfycbwAw49xwBpCt9P6HfNgJTsc2MBwxy72T7RUsSPqtcHBnh0fyuC40phQTR3FeZEKdfPw/exec",
  // Il budget MediaOps parla a un progetto Apps Script SEPARATO ("Budget
  // Drive"): quello delle grafiche resta suo e non viene mai toccato.
  PONTE_BUDGET: process.env.COMOTV_PONTE_BUDGET ||
    "https://script.google.com/macros/s/AKfycbxiJai4HubfJnfuA78yMYW1jUQYHiig-jL_IeZ_tPaMAk58Itu17n2mg1SMdXsfv0s/exec",
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
// ── LA PRESA DEL CANALE ────────────────────────────────────────────────
// Comanda una console alla volta. Chi apre la regia "prende" il canale e
// manda un battito ogni 15 secondi; se il battito manca per un minuto la
// presa scade da sola (computer spento, scheda chiusa) e il canale torna
// libero senza che nessuno debba sbloccarlo.
//
// Cosa NON tocca, di proposito:
//   · il playout in vMix, che legge soltanto;
//   · i contributi (regia-load): un inviato deve poter mandare in scaletta
//     da fuori anche mentre un altro sta comandando. Quello che arriva in
//     scaletta non va in onda da solo: lo arma e lo manda chi comanda.
//
// Sta in memoria e non nello stato salvato: al riavvio del ponte nessuno
// tiene in mano niente, ed e' giusto cosi'.
const PRESE = new Map();                 // canale -> { id, chi, dal, ultimo }
const PRESA_SCADE = 60000;

function presaViva(c) {
  const p = PRESE.get(c);
  if (!p) return null;
  if (Date.now() - p.ultimo > PRESA_SCADE) { PRESE.delete(c); return null; }
  return p;
}
function presaPubblica(c) {
  const p = presaViva(c);
  return p ? { chi: p.chi, dal: p.dal, id: p.id } : null;
}

// Chi non ha la presa non comanda. Le chiamate SENZA sessione (il tasto
// fisico dello Stream Deck, una pagina vecchia) passano: bloccarle
// spegnerebbe cose che oggi funzionano.
function guardiaPresa(p, c) {
  const viva = presaViva(c);
  if (!viva || !p.sid) return;
  if (viva.id !== String(p.sid)) {
    throw new Error("il comando di questo canale e' adesso su un altro computer (" + viva.chi + ")");
  }
}

function regiaPresa(p) {
  const c = canaleDi(p.c);
  const id = String(p.sid || "").slice(0, 40);
  if (!id) throw new Error("manca l'identificativo della console");
  const chi = String(p.chi || "").slice(0, 40) || "un'altra console";
  const viva = presaViva(c);
  if (viva && viva.id !== id && !p.forza) {
    return { ok: false, occupato: true, presa: presaPubblica(c) };
  }
  const dal = (viva && viva.id === id) ? viva.dal : Date.now();
  PRESE.set(c, { id, chi, dal, ultimo: Date.now() });
  annuncia(c, "regia");
  return { ok: true, presa: presaPubblica(c) };
}
function regiaBattito(p) {
  const c = canaleDi(p.c);
  const viva = presaViva(c);
  if (!viva) return { ok: true, tua: false, presa: null };          // libero
  if (viva.id !== String(p.sid || "")) return { ok: true, tua: false, presa: presaPubblica(c) };
  viva.ultimo = Date.now();
  return { ok: true, tua: true, presa: presaPubblica(c) };
}
function regiaMolla(p) {
  const c = canaleDi(p.c);
  const viva = presaViva(c);
  if (viva && viva.id === String(p.sid || "")) { PRESE.delete(c); annuncia(c, "regia"); }
  return { ok: true };
}

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
    megafono: ix.megafono || null,
    prog: ix.prog || null,          // quale progetto e' caricato su questo canale
    armato: ix.armato || null,
    presa: presaPubblica(c),

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
// Quante voci nuove sono arrivate di fila, e quando: serve per tenere in
// ordine una raffica di invii senza scompigliare il resto della scaletta.
// Sta solo in memoria: se il ponte riparte, la prossima voce va in cima.
const RAFFICHE = new Map();

function regiaLoad(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  if (ix.items.length >= CONFIG.MAX_SCALETTA) {
    throw new Error("scaletta piena (" + CONFIG.MAX_SCALETTA + " grafiche): \u00e8 il tetto di sicurezza, non un limite di lavoro \u2014 svuota qualcosa dalla console");
  }
  const id = String(Date.now()) + String(Math.floor(Math.random() * 1000));
  S.voci[c][id] = p.dati || {};

  // titoli mai uguali: il doppione diventa "… (2)", "… (3)" ecc.
  const base = p.titolo || p.grafica || "grafica";
  let titolo = base, n = 2;
  while (ix.items.some(i => i.titolo === titolo)) { titolo = base + " (" + n + ")"; n++; }

  // Le novita' entrano IN CIMA alla scaletta: in diretta si vedono subito e
  // l'ordine gia' sistemato piu' in basso non si tocca. Se pero' arrivano in
  // raffica (piu' grafiche spedite una dopo l'altra) restano fra loro
  // nell'ordine di invio, tutte in testa: si accodano all'ultima arrivata.
  const ora = Date.now();
  const raff = RAFFICHE.get(c);
  const posto = (raff && ora - raff.fino < 60000) ? Math.min(raff.quanti, ix.items.length) : 0;
  ix.items.splice(posto, 0, {
    id, tipo: p.grafica || "formazione", titolo,
    dest: p.dest === "partita" ? "partita" : (p.dest === "studio" ? "studio" : ""),
    ts: ora, liv: livelloDi(p.liv)
  });
  RAFFICHE.set(c, { fino: ora, quanti: posto + 1 });
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
  guardiaPresa(p, c);
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

// "Arma" la grafica selezionata in regia: il ponte ricorda qual è pronta a
// partire, così un pulsante fisico (Stream Deck) può mandarla in onda con una
// sola chiamata, senza sapere nulla della selezione dentro la pagina.
// NON tocca l'onda e NON alza il nonce: armare non deve ridisegnare i playout.
function regiaArma(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const id = p.id ? String(p.id) : "";
  if (!id) {
    ix.armato = null;
  } else {
    const it = ix.items.find(i => i.id === id);
    ix.armato = it ? { id: id, liv: (p.liv != null ? livelloDi(p.liv) : (it.liv || 1)) } : null;
  }
  salva();
  return { ok: true, canale: c, armato: ix.armato };
}

function regiaDel(p) {
  const c = canaleDi(p.c);
  guardiaPresa(p, c);
  const ix = regiaDi(c);
  for (const L of Object.keys(ix.liv)) {
    const lv = ix.liv[L];
    if (lv.onair === p.id && lv.state === "play") throw new Error("questa grafica è IN ONDA: prima Fuori onda");
  }
  ix.items = ix.items.filter(i => i.id !== p.id);
  for (const L of Object.keys(ix.liv)) {
    if (ix.liv[L].onair === p.id) ix.liv[L].onair = null;
  }
  if (ix.armato && ix.armato.id === p.id) ix.armato = null;
  delete S.voci[c][p.id];
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce, state: ix.state, onair: ix.onair };
}

// Svuota la playlist del canale: via tutte le voci, ma i progetti salvati
// non vengono toccati. Con qualcosa in onda si rifiuta: prima Fuori onda.
function regiaSvuota(p) {
  const c = canaleDi(p.c);
  guardiaPresa(p, c);
  const ix = regiaDi(c);
  for (const L of Object.keys(ix.liv)) {
    const lv = ix.liv[L];
    if (lv.state === "play" && lv.onair) throw new Error("c'è una grafica IN ONDA: prima Fuori onda, poi si svuota");
  }
  ix.items = [];
  for (const L of Object.keys(ix.liv)) ix.liv[L].onair = null;
  ix.armato = null;
  RAFFICHE.delete(c);
  S.voci[c] = {};
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

// Megafono: un avviso silenzioso a chi è in regia. Non tocca l'onda né la
// scaletta: deposita solo il nome della grafica "pronta". Il PLAYOUT MEGAFONO
// del canale (megafono-live.html?c=…) lo fa lampeggiare oro/blu e poi svanisce.
// Ogni click alza un seq: è così che il playout capisce che è un avviso NUOVO.
function regiaMegafono(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const titolo = String(p.titolo || "").slice(0, 80).trim();
  if (!titolo) throw new Error("niente da annunciare");
  const seq = ((ix.megafono && ix.megafono.seq) || 0) + 1;
  ix.megafono = { titolo, seq, ts: Date.now() };
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, seq: seq, nonce: ix.nonce };
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

// Sposta il punto d'inizio (e di fine) di un contributo GIA' in scaletta.
// Serve in diretta: la clip del gol e' li' dentro, la si riprende dal punto
// giusto e si manda in onda quel pezzo. Il file non si tocca, e nemmeno il
// resto della voce — titolo, posizione e livello restano quelli.
// Il playout costruisce il suo indirizzo dai dati della voce nel momento in
// cui va in onda, quindi il taglio cambiato adesso vale al prossimo TAKE.
function regiaTaglio(p) {
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const it = ix.items.find(i => i.id === p.id);
  if (!it) throw new Error("grafica non trovata in scaletta");
  // Il carico della voce NON sta dentro la voce: la scaletta tiene i cartellini
  // (id, titolo, tipo) e i dati veri stanno in S.voci[canale][id]. Cercarli in
  // it.dati faceva rispondere "non e' un contributo video" a un contributo
  // video, e il taglio non veniva mai salvato: in onda ripartiva da capo.
  const dati = S.voci[c] && S.voci[c][p.id];
  if (!dati || dati.k !== "video") throw new Error("il taglio vale solo per i contributi video");
  const da = Math.max(0, parseFloat(p.da) || 0);
  const a = Math.max(0, parseFloat(p.a) || 0);
  if (da) dati.da = Math.round(da * 10) / 10; else delete dati.da;
  if (a > da) dati.a = Math.round(a * 10) / 10; else delete dati.a;
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce, da: dati.da || 0, a: dati.a || 0 };
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
  // la regia ha messo mano all'ordine: la raffica e' chiusa, la prossima
  // novita' torna in cima invece di accodarsi dove non c'entra piu' nulla
  RAFFICHE.delete(c);
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
  RAFFICHE.delete(c);          // ordine toccato a mano: raffica chiusa
  ix.nonce = Date.now();
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nonce: ix.nonce };
}

// Stato del budget MediaOps: un pacchetto solo (fatture + forecast),
// nessun canale. La pagina lo legge all'apertura e lo riscrive a ogni
// modifica: cosi' i dati sono gli stessi da qualsiasi computer.
function budgetSet(p) {
  // la richiesta d'invio al Drive e l'ultimo esito NON appartengono alla
  // pagina: un salvataggio automatico non deve cancellarli dalla bacheca
  const vecchio = S.budget || {};
  S.budget = p.stato || {};
  if (vecchio.richiesta) S.budget.richiesta = vecchio.richiesta;
  if (vecchio.esito && !S.budget.esito) S.budget.esito = vecchio.esito;
  S.budget.srvTs = Date.now();
  salva();
  return { ok: true, fatture: (S.budget.fatture || []).length };
}

// La pagina chiede l'invio al Drive: la richiesta resta in bacheca e lo
// script "Budget Drive" (trigger a tempo su Apps Script) la ritira entro
// un minuto, scrive il foglio e riporta l'esito. Cosi' non serve nessuna
// web app pubblica e lo script delle grafiche non viene toccato.
function budgetInvia(p) {
  if (!p.fatture || !p.fatture.length) return { ok: false, errore: "nessuna fattura nel pacchetto" };
  if (!S.budget) S.budget = {};
  S.budget.richiesta = {
    quando: Date.now(), servita: null,
    pacchetto: { fatture: p.fatture, forecast: p.forecast || {}, categorie: p.categorie || [] }
  };
  delete S.budget.esito;
  salva();
  return { ok: true, inCoda: true };
}

function budgetEsito(p) {
  if (!S.budget) S.budget = {};
  S.budget.esito = p.esito || { ok: false, errore: "esito vuoto" };
  delete S.budget.richiesta;
  salva();
  return { ok: true };
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
function inoltra(corpo, indirizzo) {
  return new Promise((risolvi) => {
    const dati = Buffer.from(JSON.stringify(corpo), "utf8");
    const u = new URL(indirizzo || CONFIG.PONTE_FOGLI);
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

function nuovoId() {
  return String(Date.now()) + String(Math.floor(Math.random() * 1000));
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
    // il "pid" e' il segno di riconoscimento della grafica dentro il
    // progetto: serve a ritrovarla nella scaletta quando il progetto viene
    // riaggiornato, invece di reimportare tutto da capo
    pid: nuovoId(),
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
  // i progetti vecchi non hanno il segno di riconoscimento: glielo do qui,
  // cosi' anche loro si possono copiare voce per voce
  let daSalvare = false;
  for (const i of pr.items) { if (!i.pid) { i.pid = nuovoId(); daSalvare = true; } }
  if (daSalvare) salva();
  return { ok: true, nome: pr.nome,
           items: pr.items.map(i => ({ pid: i.pid, tipo: i.tipo, titolo: i.titolo, liv: i.liv })) };
}

// Copia UNA grafica da un progetto a un altro. Serve a non rifare due volte
// lo stesso lavoro: la formazione preparata per il pre-partita finisce anche
// nel progetto del post, senza ricompilarla.
function progettoCopia(p) {
  const da = S.progetti[String(p.da || "")];
  const a = S.progetti[String(p.a || "")];
  if (!da) throw new Error("progetto di partenza inesistente");
  if (!a) throw new Error("progetto di destinazione inesistente");
  if (String(p.da) === String(p.a)) throw new Error("\u00e8 lo stesso progetto");
  if (a.items.length >= CONFIG.MAX_SCALETTA) {
    throw new Error('"' + a.nome + '" \u00e8 pieno (' + CONFIG.MAX_SCALETTA + " grafiche)");
  }
  const it = da.items.find(i => String(i.pid) === String(p.pid));
  if (!it) throw new Error("grafica non trovata nel progetto di partenza");

  // titoli mai uguali dentro lo stesso progetto
  let titolo = it.titolo, n = 2;
  while (a.items.some(i => i.titolo === titolo)) { titolo = it.titolo + " (" + n + ")"; n++; }

  a.items.push({
    pid: nuovoId(),              // nel progetto nuovo e' una grafica sua
    tipo: it.tipo, titolo: titolo, liv: it.liv || 1,
    dati: JSON.parse(JSON.stringify(it.dati || {})),   // copia staccata: toccarne una non tocca l'altra
    ts: Date.now()
  });
  salva();
  return { ok: true, da: da.nome, a: a.nome, titolo: titolo, quante: a.items.length };
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
// Toglie UNA grafica da un progetto. Il progetto e' archivio: quello che e'
// gia' sceso in una scaletta non viene toccato, resta dov'e'.
function progettoTogli(p) {
  const pr = progettoDi(p);
  const prima = pr.items.length;
  const via = pr.items.find(i => String(i.pid) === String(p.pid));
  if (!via) throw new Error("grafica non trovata in questo progetto");
  pr.items = pr.items.filter(i => String(i.pid) !== String(p.pid));
  salva();
  return { ok: true, nome: pr.nome, titolo: via.titolo,
           quante: pr.items.length, tolte: prima - pr.items.length };
}

// Spostare = copiare di la' e togliere di qua, in un colpo solo: se la copia
// non riesce, di qua non si tocca niente.
function progettoSposta(p) {
  const esito = progettoCopia(p);
  progettoTogli({ id: p.da, pid: p.pid });
  return { ok: true, spostata: true, da: esito.da, a: esito.a,
           titolo: esito.titolo, quante: esito.quante };
}

function progettoCarica(p) {
  const pr = progettoDi(p);
  if (!pr.items.length) {
    throw new Error('il progetto "' + pr.nome + '" \u00e8 vuoto: mandagli le grafiche dalle loro pagine, poi caricalo');
  }
  // i progetti vecchi non hanno il segno di riconoscimento: glielo do adesso
  let daSalvare = false;
  for (const it of pr.items) { if (!it.pid) { it.pid = nuovoId(); daSalvare = true; } }

  const idProg = String(p.id || "");
  const c = canaleDi(p.c);
  const ix = regiaDi(c);
  const inOnda = new Set();
  for (const L of Object.keys(ix.liv)) {
    const lv = ix.liv[L];
    if (lv && lv.state === "play" && lv.onair) inOnda.add(lv.onair);
  }

  // È lo STESSO progetto gia' caricato su questo canale? Allora non si
  // ricomincia da capo: l'ordine che la regia si e' costruita e' lavoro suo e
  // non si tocca. Si aggiornano le grafiche che c'erano gia', si tolgono
  // quelle sparite dal progetto e le nuove entrano in cima, dove si vedono.
  const aggiorna = (ix.prog === idProg);

  const voceViva = new Map();      // pid -> voce di scaletta
  if (aggiorna) {
    for (const i of ix.items) { if (i.prog === idProg && i.pid) voceViva.set(i.pid, i); }
  }

  const restano = [];
  const nuovi = [];
  let aggiornate = 0, tolte = 0;

  if (aggiorna) {
    const pidVivi = new Set(pr.items.map(i => i.pid));
    for (const i of ix.items) {
      const mia = (i.prog === idProg);
      // resta: quello che e' in onda, quello che non viene da questo progetto,
      // e quello che nel progetto c'e' ancora
      if (inOnda.has(i.id) || !mia || pidVivi.has(i.pid)) { restano.push(i); }
      else { delete S.voci[c][i.id]; tolte++; }
    }
    for (const it of pr.items) {
      const gia = voceViva.get(it.pid);
      if (!gia) continue;
      // la grafica c'era gia': si rinfrescano i dati e il nome, la POSIZIONE no
      gia.titolo = it.titolo;
      gia.liv = it.liv || gia.liv || 1;
      S.voci[c][gia.id] = it.dati || {};
      aggiornate++;
    }
  } else {
    // progetto diverso (o primo caricamento): la scaletta viene sostituita,
    // come e' sempre stato. Resta solo quello che e' in onda adesso.
    for (const i of ix.items) {
      if (inOnda.has(i.id)) restano.push(i);
      else { delete S.voci[c][i.id]; }
    }
  }

  for (const it of pr.items) {
    if (aggiorna && voceViva.has(it.pid)) continue;      // c'era gia'
    if (restano.length + nuovi.length >= CONFIG.MAX_SCALETTA) break;
    const id = nuovoId();
    S.voci[c][id] = it.dati || {};
    nuovi.push({ id: id, tipo: it.tipo, titolo: it.titolo, dest: "",
                 ts: Date.now(), liv: it.liv || 1, prog: idProg, pid: it.pid });
  }

  // le novita' in cima, il resto nell'ordine in cui stava
  ix.items = nuovi.concat(restano);
  ix.prog = idProg;
  RAFFICHE.delete(c);          // le prossime novita' ripartono dalla cima
  ix.nonce = Date.now();
  if (daSalvare) { /* i pid nuovi vanno scritti col resto */ }
  salva(); annuncia(c, "regia");
  return { ok: true, canale: c, nome: pr.nome, aggiornamento: aggiorna,
           caricate: nuovi.length, aggiornate: aggiornate, tolte: tolte,
           tenuteInOnda: restano.filter(i => inOnda.has(i.id)).length, nonce: ix.nonce };
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
  // resta scritto chi l'ha caricata, se ha una password sua: quando una foto
  // cambia e nessuno sa perche', questa riga risponde
  if (p.__chi) console.log("[foto] " + chiave + est + " caricata da " + p.__chi);
  return { ok: true, nome: nome, url: "/loghi/" + chiave + est, chi: p.__chi || undefined };
}

function logoElenco() {
  try {
    const file = fs.readdirSync(CONFIG.LOGHI);
    return { ok: true, loghi: file.filter(f => Object.values(TIPI_LOGO).includes(path.extname(f)))
      .map(f => {
        // peso e data servono al Magazzino; le pagine vecchie leggono
        // solo chiave e url e non si accorgono di nulla
        let size = 0, ts = 0;
        try { const st = fs.statSync(path.join(CONFIG.LOGHI, f)); size = st.size; ts = Math.floor(st.mtimeMs); } catch (err) {}
        return { chiave: path.basename(f, path.extname(f)), url: "/loghi/" + f, size, ts };
      }) };
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

// ─────────────────────────────────────────────── contributi video (PAT)
// L'origine "cloud" del PAT Video: i file MP4 caricati dal browser vivono
// accanto allo stato (dev e produzione restano separati da soli). L'upload
// arriva A PEZZI da ~2MB in base64 dentro i normali POST JSON: cosi' non
// serve toccare nginx (che ha il suo tetto sulle richieste) ne' aprire
// nuovi percorsi. Il file si serve con gli HTTP Range, che al <video>
// servono per durata e ricerca.
function cartellaVideo() {
  return CONFIG.VIDEO || path.join(path.dirname(CONFIG.STATO), "video");
}
const MAX_VIDEO = 800 * 1024 * 1024;          // 800 MB a file: oltre non e' un contributo
const CARICHI = new Map();                     // id -> upload in corso

function slugVideoNome(nome) {
  const base = String(nome || "").replace(/\.[^.]*$/, "");
  const chiave = slug(base) || "clip";
  return chiave + ".mp4";
}

function videoInizia(p) {
  const dir = cartellaVideo();
  fs.mkdirSync(dir, { recursive: true });
  // pulizia di upload rimasti a meta' (piu' vecchi di un giorno)
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".up-") && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 864e5) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (err) {}
  const nome = slugVideoNome(p.nome);
  const tot = parseInt(p.tot, 10) || 0;
  if (tot > MAX_VIDEO) throw new Error("file troppo grande (massimo 800 MB)");
  const id = String(Date.now()) + String(Math.floor(Math.random() * 10000));
  const tmp = path.join(dir, ".up-" + id);
  // i pezzi arrivano IN PARALLELO e in qualsiasi ordine: ognuno dichiara il
  // suo scostamento e viene scritto alla posizione giusta nel file
  const fd = fs.openSync(tmp, "w");
  CARICHI.set(id, { nome, tmp, fd, scritti: 0, tot });
  return { ok: true, id, nome };
}

function videoPezzo(p) {
  const c = CARICHI.get(String(p.id || ""));
  if (!c) throw new Error("upload sconosciuto (scaduto o mai iniziato)");
  const off = parseInt(p.off, 10);
  const buf = Buffer.from(String(p.dati || ""), "base64");
  if (!buf.length) throw new Error("pezzo vuoto");
  if (isNaN(off) || off < 0 || off + buf.length > MAX_VIDEO) throw new Error("scostamento non valido");
  fs.writeSync(c.fd, buf, 0, buf.length, off);
  c.scritti += buf.length;
  return { ok: true, scritti: c.scritti };
}

function videoFine(p) {
  const c = CARICHI.get(String(p.id || ""));
  if (!c) throw new Error("upload sconosciuto");
  CARICHI.delete(String(p.id));
  try { fs.closeSync(c.fd); } catch (err) {}
  if (!c.scritti) { try { fs.unlinkSync(c.tmp); } catch (err) {} throw new Error("nessun dato ricevuto"); }
  if (c.tot && c.scritti < c.tot) {
    try { fs.unlinkSync(c.tmp); } catch (err) {}
    throw new Error("upload incompleto: ricevuti " + c.scritti + " byte su " + c.tot);
  }
  const finale = path.join(cartellaVideo(), c.nome);
  try { fs.unlinkSync(finale); } catch (err) {}   // ricaricare = sostituire
  fs.renameSync(c.tmp, finale);
  return { ok: true, file: c.nome, url: "/video/" + c.nome, bytes: c.scritti };
}

// ── prelievo da un link ────────────────────────────────────────────────
// Google, e non solo lui, non lascia suonare i propri file da un altro sito:
// sull'indirizzo che serve il contenuto mette cross-origin-resource-policy
// same-site e content-disposition: attachment, e il lettore video li rifiuta.
// A NOI pero' il file lo da': qui non c'e' un browser e non c'e' un'origine,
// quelle intestazioni non vietano niente. Quindi lo scarica il ponte, e da quel
// momento e' un contributo come tutti gli altri — servito da questa macchina,
// senza dipendere da Google mentre si e' in onda, che per mezzo giga in diretta
// e' comunque la scelta giusta.
const PRELIEVI = new Map();

function prelievoPulisci() {
  const ora = Date.now();
  for (const [k, v] of PRELIEVI) if (ora - v.nato > 36e5) PRELIEVI.delete(k);
}

function prelievoScarica(indirizzo, st, salti) {
  if (salti > 5) { prelievoFallito(st, "troppi rimbalzi fra indirizzi"); return; }
  let u;
  try { u = new URL(indirizzo); } catch (err) { prelievoFallito(st, "indirizzo non valido"); return; }
  if (u.protocol !== "http:" && u.protocol !== "https:") { prelievoFallito(st, "serve un indirizzo http o https"); return; }
  const mod = u.protocol === "https:" ? https : http;
  const req = mod.get(u, { headers: { "User-Agent": "ComoTV-ponte/1.0", "Accept": "*/*" } }, (res) => {
    // i rimbalzi: drive.google.com manda a drive.usercontent, e quello puo'
    // rimbalzare ancora
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      prelievoScarica(new URL(res.headers.location, u).href, st, salti + 1);
      return;
    }
    if (res.statusCode !== 200) { res.resume(); prelievoFallito(st, "il link risponde " + res.statusCode); return; }

    const tipo = String(res.headers["content-type"] || "").toLowerCase();
    // Se torna una pagina invece di un video, il file non e' pubblico o il link
    // e' sbagliato: salvarla come .mp4 vorrebbe dire scoprirlo in onda.
    if (/^text\/|application\/xhtml|application\/json/.test(tipo)) {
      res.resume();
      prelievoFallito(st, "quel link non da' un video ma una pagina: se e' Google Drive, " +
                          "il file va condiviso con chiunque abbia il link");
      return;
    }
    const dichiarata = parseInt(res.headers["content-length"], 10) || 0;
    if (dichiarata > MAX_VIDEO) { res.resume(); prelievoFallito(st, "file troppo grande (massimo 800 MB)"); return; }
    st.tot = dichiarata;

    // il nome: quello chiesto, se no quello che dichiara il server, se no il
    // pezzo finale dell'indirizzo
    if (!st.nome) {
      const cd = String(res.headers["content-disposition"] || "");
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      st.nome = slugVideoNome(m ? decodeURIComponent(m[1]) : path.basename(u.pathname) || "contributo");
    }

    const dir = cartellaVideo();
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, ".giu-" + st.id);
    const out = fs.createWriteStream(tmp);
    st.tmp = tmp;

    res.on("data", (c) => {
      st.scritti += c.length;
      if (st.scritti > MAX_VIDEO) {
        req.destroy(); out.destroy();
        try { fs.unlinkSync(tmp); } catch (err) {}
        prelievoFallito(st, "file troppo grande (massimo 800 MB)");
      }
    });
    res.pipe(out);
    out.on("finish", () => {
      if (st.errore) return;
      const finale = path.join(dir, st.nome);
      try { fs.unlinkSync(finale); } catch (err) {}
      try { fs.renameSync(tmp, finale); } catch (err) { prelievoFallito(st, "non riesco a salvare: " + err.message); return; }
      st.file = st.nome; st.fatto = true;
      console.log("[preleva] " + st.nome + " (" + st.scritti + " byte) da " + u.host);
    });
    out.on("error", (e) => prelievoFallito(st, e.message));
  });
  req.on("error", (e) => prelievoFallito(st, "non raggiungibile: " + e.message));
  req.setTimeout(60000, () => { req.destroy(); prelievoFallito(st, "il link non risponde"); });
}

function prelievoFallito(st, perche) {
  if (st.errore) return;
  st.errore = perche; st.fatto = true;
  if (st.tmp) { try { fs.unlinkSync(st.tmp); } catch (err) {} }
}

function videoPreleva(p) {
  prelievoPulisci();
  const u = String(p.url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("serve un indirizzo http o https");
  const id = String(Date.now()) + String(Math.floor(Math.random() * 10000));
  const st = { id, nome: slugVideoNome(p.nome || ""), scritti: 0, tot: 0,
               fatto: false, errore: "", file: "", tmp: "", nato: Date.now() };
  PRELIEVI.set(id, st);
  prelievoScarica(u, st, 0);
  return { ok: true, id };
}

// ── LE PARTITE DA AIRTABLE ─────────────────────────────────────────────
// Serve al pannello di Premiere: il montatore sceglie la partita da una tendina
// e il nome della competizione si scrive da solo, senza che nessuno lo digiti.
// Oggi quel passaggio a mano produce refusi che finiscono in onda.
//
// Il token NON puo' stare nel pannello, ne' nel browser: sta qui, in una
// variabile d'ambiente, e chi chiede riceve solo le partite. E' la stessa
// ragione per cui gli altri ponti stanno qui e non nelle pagine.
//
// Il filtro e la mappatura sono quelli gia' scritti in generatore-airtable.js:
// da due giorni indietro in avanti, niente RINVIATA e niente PRE SHOW (slot
// interni di studio che non diventano mai grafiche), i FOOTBALL SHOW invece
// restano perche' sono programmi con una loro grafica.
const AT_BASE = "appdDMcS8JQ4PTdLB";
const AT_TAB = "tblXKPRWFCLw5pVSt";
const AT_COMP = {
  "Bundesliga Austria": "bundesliga_austria", "Eredivisie": "eredivisie",
  "Scottish Premiership": "scottish_premiership", "Saudi Pro League": "saudi_pro",
  "Carabao Cup": "carabao", "DFB-Pokal": "dfb_pokal", "Coppa di Germania": "dfb_pokal",
  "Coupe de France": "coupe_france", "Premier Sports Cup": "scottish_lc",
  "Scottish Cup": "scottish_cup", "Ta\u00e7a de Portugal": "taca", "SuperSport HNL": "hnl",
  "Copa Libertadores": "libertadores", "Copa Sudamericana": "sudamericana",
  "Recopa Sudamericana": "recopa", "LPF Argentina": "lpf",
  "Clausura Liga Profesional": "lpf", "Supercopa Internacional": "supercopa_int",
  "Trofeo de Campeones": "trofeo_campeones", "Saudi Super Cup": "saudi_super",
  "Scottish Championship": "scottish_championship", "Championship": "scottish_championship",
  "EFL Championship": "efl_championship", "Supertaça Portugal": "supertaca",
  "Serie A": "serie_a", "Coppa Italia": "coppa_italia",
  "Coppa Italia Primavera": "coppa_italia_primavera", "Primavera 1": "primavera1",
  "Studio Live": ""
};
let AT_CACHE = { quando: 0, dati: null };

function atLeggi(url) {
  return new Promise((ok, no) => {
    const tok = process.env.COMOTV_AIRTABLE_PAT || "";
    if (!tok) { no(new Error("manca la chiave di Airtable sul ponte (COMOTV_AIRTABLE_PAT)")); return; }
    const req = https.get(url, { headers: { Authorization: "Bearer " + tok } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { t += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) { no(new Error("Airtable risponde " + res.statusCode)); return; }
        try { ok(JSON.parse(t)); } catch (e) { no(new Error("risposta non leggibile")); }
      });
    });
    req.on("error", (e) => no(new Error("Airtable non raggiungibile: " + e.message)));
    req.setTimeout(20000, () => { req.destroy(); no(new Error("Airtable non risponde")); });
  });
}

// "PARMA-COMO 3-4 (dcr)" → casa e ospite puliti. Due cose che i dati veri
// hanno insegnato, e che il parsing di prima sbagliava:
//
//  · l'etichetta della lingua sta dentro il nome: "GENOA-COMO [ITA]" faceva
//    diventare l'ospite "COMO [ITA]". Va tolta e tenuta a parte — 33 righe su
//    181 ce l'hanno, e la stessa partita compare tre volte, una per lingua.
//  · un programma con un trattino dentro veniva letto come partita:
//    "FOOTBALL SHOW: Live pre partita Genoa-Como" diventava una sfida fra
//    "FOOTBALL SHOW: LIVE PRE PARTITA GENOA" e "COMO". Per riconoscerlo non
//    basta guardare i trattini: si guarda la competizione, che per i programmi
//    e' "Studio Live" — verificato, tutte e 16 le righe cosi' sono programmi e
//    nessuna partita vera comincia con un simbolo.
function atPartita(testo, competizione) {
  let grezza = String(testo || "");
  const et = grezza.match(/\[([^\]]+)\]/);
  const lingua = et ? et[1].trim().toUpperCase() : "";
  grezza = grezza.replace(/\s*\[[^\]]*\]\s*/g, " ");
  const pulita = grezza
    .replace(/\s+RINVIATA.*$/i, "")
    .replace(/\s*\(\d+-\d+.*?\).*$/i, "")
    .replace(/\s+\d+-\d+\s*(dcr)?.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const eProgramma = competizione === "Studio Live" || /^[^A-Za-z0-9]/.test(pulita);
  if (eProgramma) {
    const t = pulita.replace(/^[^A-Za-z0-9]+/, "").trim();
    const due = t.indexOf(":");
    return due > 0
      ? { casa: t.slice(0, due).trim().toUpperCase(), ospite: t.slice(due + 1).trim().toUpperCase(),
          programma: true, lingua, pulita: t }
      : { casa: t.toUpperCase(), ospite: "", programma: true, lingua, pulita: t };
  }

  const p = pulita.split("-");
  const casa = (p[0] || "").trim().replace(/^\d+\s*/, "").toUpperCase();
  const ospite = (p.slice(1).join("-") || "").trim().replace(/^\d+\s*/, "").toUpperCase();
  if (!ospite) return { casa, ospite: "", programma: true, lingua, pulita };
  return { casa, ospite, programma: false, lingua, pulita };
}

// Quello che si legge nella tendina: "gio 4 set · Genoa-Como · Serie A".
// La data serve piu' del nome, perche' le stesse due squadre tornano.
const GIORNI = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
function etichettaEvento(r) {
  const d = new Date(r.quando);
  const quando = isNaN(d) ? "" : GIORNI[d.getDay()] + " " + d.getDate() + " " + MESI[d.getMonth()];
  const chi = r.programma ? (r.ospite ? r.casa + ": " + r.ospite : r.casa)
                          : r.casa + "-" + r.ospite;
  return [quando, chi, r.competizione].filter(Boolean).join(" \u00b7 ");
}

async function airtableEventi() {
  if (AT_CACHE.dati && Date.now() - AT_CACHE.quando < 60000) return AT_CACHE.dati;
  const formula = "AND(" +
    "IS_AFTER({Data | Orario}, DATEADD(TODAY(), -2, 'days')), " +
    "NOT({Partita} = BLANK()), " +
    'NOT(FIND("RINVIATA", UPPER({Partita}))), ' +
    'NOT(FIND("PRE SHOW", UPPER({Partita})))' +
    ")";
  const base = "https://api.airtable.com/v0/" + AT_BASE + "/" + AT_TAB;
  let offset = "", righe = [], giri = 0;
  do {
    const q = new URLSearchParams({
      filterByFormula: formula, pageSize: "100",
      "sort[0][field]": "Data | Orario", "sort[0][direction]": "asc"
    });
    if (offset) q.set("offset", offset);
    const j = await atLeggi(base + "?" + q.toString());
    (j.records || []).forEach((r) => {
      const f = r.fields || {};
      const comp = f["Competizione"] || "";
      const p = atPartita(f["Partita"], comp);
      righe.push({
        id: r.id,
        quando: f["Data | Orario"] || "",
        competizione: comp,
        compKey: AT_COMP[comp] !== undefined ? AT_COMP[comp] : "",
        partita: f["Partita"] || "",
        casa: p.casa, ospite: p.ospite, programma: p.programma,
        lingua: p.lingua,                       // ITA, ENG, AUDIO ONLY: e' un feed, non un nome
        turno: f["Turno"] || ""
      });
    });
    offset = j.offset || "";
  } while (offset && ++giri < 20);

  // Una tendina vuole una riga per partita. Airtable ne ha una per FEED: la
  // stessa GENOA-COMO compare in ITA, ENG e AUDIO ONLY. Chi monta sceglie la
  // partita, non la lingua del commento — quindi si accorpano per giorno piu'
  // squadre, e le lingue restano dentro come dato, non come tre voci uguali.
  const unite = new Map();
  righe.forEach((r) => {
    const chiave = r.quando.slice(0, 10) + "|" + r.casa + "|" + r.ospite;
    const gia = unite.get(chiave);
    if (gia) {
      if (r.lingua && gia.lingue.indexOf(r.lingua) < 0) gia.lingue.push(r.lingua);
      gia.ids.push(r.id);
      return;
    }
    unite.set(chiave, Object.assign({}, r, {
      lingue: r.lingua ? [r.lingua] : [], ids: [r.id],
      etichetta: etichettaEvento(r)
    }));
  });
  const eventi = Array.from(unite.values());
  eventi.forEach((e) => { delete e.lingua; delete e.id; });

  const fuori = { ok: true, quante: eventi.length, righe: righe.length, eventi: eventi };
  AT_CACHE = { quando: Date.now(), dati: fuori };
  return fuori;
}

// ══════════════════════════════════════════════════════════════════════
//  IL TITOLO COME IMMAGINE
// ══════════════════════════════════════════════════════════════════════
//
//  Le grafiche native di Premiere tengono il testo in un parametro che UXP
//  non sa scrivere — provato in ogni modo il 2026-09-04. E il canvas dentro
//  UXP non sa disegnare testo, quindi il pannello non puo' comporlo da se'.
//
//  Restava una sola strada: comporlo QUI, dove il font si installa e il
//  disegno si controlla, e mandare al pannello un PNG bell'e' fatto. Mettere
//  immagini in timeline il pannello lo sa gia' fare — e' come mette le
//  maschere delle competizioni.
//
//  Il disegno passa da rsvg-convert: si scrive un SVG e torna un PNG.
//  Nessuna libreria da mantenere, nessun browser da tenere in piedi.

// Il disegno non lo facciamo noi: lo fa il motore del generatore, quello
// stesso che produce le maschere per i social. La copia sta in ottgen.js e
// si rifa' con estrai-motore.py — riscrivere l'estetica a mano avrebbe
// voluto dire due maschere che dopo un mese non si somigliano piu'.
const MASCHERA = "feed_maschera_1080x1920";

// Il motore si carica alla PRIMA maschera, non all'avvio. Non e' pigrizia:
// aggiorna.sh copia solo server.js, e su una macchina dove ottgen.js non e'
// ancora arrivato un require in cima farebbe morire tutto il ponte —
// scalette, messa in onda, grafiche live — per una funzione che serve a un
// pannello di montaggio. Cosi' invece si ferma solo la maschera, e lo dice.
let MOTORE = null;
function motore() {
  if (MOTORE) return MOTORE;
  try { MOTORE = require("./ottgen.js"); }
  catch (e) {
    throw new Error("il motore delle grafiche non e' su questa macchina (" +
                    e.message + "): serve ottgen.js accanto a server.js");
  }
  return MOTORE;
}

// ── come si scrive, qualunque cosa arrivi ─────────────────────────────
// Chi incolla non deve ricordarsi le convenzioni: le applica il ponte.
// Il titolo va sempre in maiuscolo, il sottotitolo mai.
function comeTitolo(t) { return String(t || "").trim().toUpperCase(); }

// Il sottotitolo: minuscolo, con la sola iniziale maiuscola. Con
// un'eccezione, che non e' un capriccio ma una cosa che abbassata diventa
// sbagliata: i nomi delle competizioni. Non c'e' bisogno di indovinare come
// vanno scritti, li abbiamo — arrivano da Airtable — quindi dopo aver
// abbassato tutto si rimette la grafia buona di quelli che si riconoscono.
//
// Nessuna regola generica sulle lettere sole. Sarebbe il rimedio ovvio a
// "Serie a", ed e' peggio del male: alza anche le preposizioni, e "fase a
// gironi" diventa "fase A gironi". "Serie A" lo rimette il dizionario.
//
// Fuori da questa, si abbassa e basta: "5ª GIORNATA" deve diventare "5ª
// giornata", ed e' il motivo per cui la regola esiste.
function nomiDelleCompetizioni() {
  const d = AT_CACHE && AT_CACHE.dati;
  if (!d || !d.eventi) return [];
  const visti = {};
  d.eventi.forEach((e) => { if (e.competizione) visti[e.competizione] = 1; });
  // dalle piu' lunghe: "Coppa Italia Primavera" prima di "Coppa Italia"
  return Object.keys(visti).sort((a, b) => b.length - a.length);
}

function comeSottotitolo(t) {
  let x = String(t || "").trim().toLowerCase();
  if (!x) return "";

  // le competizioni tornano come le scrive chi fa il palinsesto
  nomiDelleCompetizioni().forEach((nome) => {
    const dove = x.indexOf(nome.toLowerCase());
    if (dove >= 0) x = x.slice(0, dove) + nome + x.slice(dove + nome.length);
  });

  return x.charAt(0).toUpperCase() + x.slice(1);
}

function svgTitolo(p) {
  const G = motore();
  const formato = G.items().filter((i) => i.key === MASCHERA)[0];
  if (!formato) throw new Error("il motore non conosce " + MASCHERA);

  // Dove va a capo il titolo lo decide chi scrive, non una formula: il
  // motore spezza sul "·", e il pannello ha due caselle apposta.
  const titolo = [p.t1, p.t2].map(comeTitolo).filter(Boolean).join(" · ");

  let svg = G.svgFor(formato, {
    comp: String(p.comp || "").toUpperCase(),
    mkTitle: titolo,
    mkSub: comeSottotitolo(p.sott)
  }, {}, {}, "");

  // Il sottotitolo un filo piu' leggero: nel generatore e' un semibold, e
  // sotto un titolo cosi' grasso pesa troppo. E' l'UNICA differenza fra
  // questa maschera e quella dei social — se un giorno si vuole tornare
  // identici, si toglie questa riga; se si vuole cambiare anche la', si
  // cambia il generatore e questa riga sparisce da se'.
  svg = svg.replace(/(<g data-obj="t-sub"[^>]*>\s*<text[^>]*?)font-weight="600"/,
                    '$1font-weight="400"');
  return svg;
}

// Un disegnatore solo per tutti: gli SVG cambiano, rsvg-convert no.
function pngDaSvg(svg) {
  return new Promise((ok, no) => {
    const cp = require("child_process").spawn("rsvg-convert", ["-f", "png"]);
    const pezzi = [], errori = [];
    cp.stdout.on("data", (d) => pezzi.push(d));
    cp.stderr.on("data", (d) => errori.push(d));
    cp.on("error", (e) => no(new Error("rsvg-convert non parte: " + e.message)));
    cp.on("close", (codice) => {
      if (codice !== 0) return no(new Error(Buffer.concat(errori).toString().trim() || "disegno fallito"));
      ok(Buffer.concat(pezzi));
    });
    cp.stdin.end(svg);
  });
}

function pngDelTitolo(p) { return pngDaSvg(svgTitolo(p)); }

// ══════════════════════════════════════════════════════════════════════
//  LA LOCANDINA DELLA COLONNA
// ══════════════════════════════════════════════════════════════════════
//
//  La colonna del ticker e' 420x1080: quasi tre volte piu' alta che larga.
//  Una locandina fatta per i social e' 2:3, e li' dentro o si rimpicciolisce
//  lasciando meta' colonna vuota, o si taglia perdendo i nomi delle squadre.
//  Provate tutte e due: si vede che sono sbagliate.
//
//  Quindi la locandina della colonna si DISEGNA nel formato della colonna.
//  Non e' la stessa cosa di scrivere sopra una locandina finita — quello lo
//  avevo fatto ed era il testo di qualcun altro coperto dal nostro. Qui il
//  testo e' parte del disegno, e il disegno e' fatto per questo spazio.
//
//  Si disegna al doppio, 840x2160, perche' in onda la colonna e' scalata e
//  un PNG alla misura esatta si vede sgranato sui bordi delle lettere.

// Dentro un SVG cinque caratteri vanno protetti, se no un nome con la
// "&" spacca il disegno. C'era quando il titolo lo componevamo a mano, ed
// e' andata via col resto: qui serve ancora.
function xmlSicuro(t) {
  return String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const LOC = { W: 840, H: 2160, m: 62 };

// Quanto e' larga una riga: rsvg non lo dice, quindi si stima. Per un
// bastone grasso in maiuscolo il carattere medio sta attorno al 58% del
// corpo. Stima, non misura — per questo il margine e' generoso: meglio un
// nome un filo piu' piccolo che uno che esce dall'inquadratura.
//
// Questa funzione c'era gia' quando il titolo lo disegnavamo a mano; e' andata
// via quando il titolo e' passato al motore del generatore. Qui serve ancora,
// perche' la locandina della colonna la disegniamo noi.
function corpoCheCiSta(testo, corpo, larghezza) {
  let c = corpo;
  while (c > corpo * 0.5 && String(testo).length * c * 0.58 > larghezza) c -= 2;
  return c;
}

// Le foto stanno nel magazzino della macchina: si prendono da li' e si
// mettono DENTRO l'svg, perche' rsvg non va a prendersi niente in rete.
function dentroLoSvg(nomeFile) {
  if (!nomeFile) return "";
  const pulito = String(nomeFile).replace(/^.*[\\/]/, "");   // mai fuori dalla cartella
  if (!/^[A-Za-z0-9._ -]+$/.test(pulito)) return "";
  try {
    const via = path.join(CONFIG.LOGHI, pulito);
    const b = fs.readFileSync(via);
    const tipo = /\.png$/i.test(pulito) ? "image/png"
               : /\.webp$/i.test(pulito) ? "image/webp" : "image/jpeg";
    return "data:" + tipo + ";base64," + b.toString("base64");
  } catch (e) { return ""; }
}

function svgLocandina(p) {
  const W = LOC.W, H = LOC.H, m = LOC.m, utile = W - m * 2;
  const foto = dentroLoSvg(p.foto);
  const marchio = dentroLoSvg("como-tv-logo.png");

  // Costruita dal BASSO: cosi' un nome corto e uno lungo finiscono appoggiati
  // alla stessa riga, invece di galleggiare a altezze diverse.
  const yMarchio = H - 150;          // il marchio, in fondo
  const yFilo    = yMarchio - 78;
  const yQuando  = yFilo - 54;
  const yOspite  = yQuando - 122;
  const yCasa    = yOspite - 116;
  const yComp    = yCasa - 118;
  const finFoto  = yComp - 150;      // dove la foto smette di contare

  const casa = comeTitolo(p.casa), ospite = comeTitolo(p.ospite);
  // Un corpo solo per tutt'e due: due misure diverse non sono una sfida.
  let corpo = 104;
  [casa, ospite].forEach((t) => { corpo = Math.min(corpo, corpoCheCiSta(t, 104, utile - 90)); });

  const quando = [p.data, p.ora].filter(Boolean);

  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ' +
    'width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
    "<defs>" +
      '<linearGradient id="giu" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#0A0F24" stop-opacity="0.10"/>' +
        '<stop offset="0.34" stop-color="#0A0F24" stop-opacity="0.22"/>' +
        '<stop offset="0.72" stop-color="#0F1533" stop-opacity="0.88"/>' +
        '<stop offset="1" stop-color="#0A0F24"/></linearGradient>' +
      '<linearGradient id="filo" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#C9A24B" stop-opacity="0"/>' +
        '<stop offset="0.2" stop-color="#C9A24B"/>' +
        '<stop offset="0.8" stop-color="#C9A24B"/>' +
        '<stop offset="1" stop-color="#C9A24B" stop-opacity="0"/></linearGradient>' +
      "<style>" +
        ".sq{font-family:'Mazzard M ExtraBold','Mazzard M',sans-serif;font-weight:800;" +
        "letter-spacing:-1px}" +
        ".vs{font-family:'Mazzard M',sans-serif;font-weight:700;font-style:italic;" +
        "font-size:44px;fill:#C9A24B}" +
        ".cp{font-family:'Mazzard M',sans-serif;font-weight:700;font-size:30px;" +
        "fill:#C9A24B;letter-spacing:9px}" +
        ".qd{font-family:'Mazzard M ExtraBold','Mazzard M',sans-serif;font-weight:800;" +
        "font-size:54px;fill:#F5F1E6;letter-spacing:2px}" +
        ".or{fill:#C9A24B}" +
      "</style>" +
    "</defs>" +
    // il fondo della colonna, lo stesso della barra
    '<rect width="' + W + '" height="' + H + '" fill="#0E1430"/>' +
    (foto ? '<image xlink:href="' + foto + '" x="0" y="0" width="' + W + '" height="' + finFoto +
            '" preserveAspectRatio="xMidYMid slice"/>' : "") +
    '<rect width="' + W + '" height="' + H + '" fill="url(#giu)"/>' +
    (p.comp ? '<text x="' + m + '" y="' + yComp + '" class="cp">' +
              xmlSicuro(String(p.comp).toUpperCase()) + "</text>" : "") +
    '<text x="' + m + '" y="' + yCasa + '" class="sq" style="font-size:' + corpo + 'px" fill="#F5F1E6">' +
      xmlSicuro(casa) + (ospite ? ' <tspan class="vs">vs</tspan>' : "") + "</text>" +
    (ospite ? '<text x="' + m + '" y="' + yOspite + '" class="sq" style="font-size:' + corpo +
              'px" fill="#C9A24B">' + xmlSicuro(ospite) + "</text>" : "") +
    (quando.length ? '<text x="' + m + '" y="' + yQuando + '" class="qd">' +
       xmlSicuro(String(p.data || "").toUpperCase()) +
       (p.ora ? ' <tspan class="or">\u00b7 ' + xmlSicuro(p.ora) + "</tspan>" : "") + "</text>" : "") +
    '<rect x="' + m + '" y="' + yFilo + '" width="' + utile + '" height="3" fill="url(#filo)"/>' +
    (marchio ? '<image xlink:href="' + marchio + '" x="' + (W / 2 - 46) + '" y="' + yMarchio +
               '" width="92" height="156" preserveAspectRatio="xMidYMid meet"/>' : "") +
    "</svg>";
}

// ── che cosa c'e' in una cartella di Drive ─────────────────────────────
// Una cartella non e' un file: non si "scarica". Si legge la sua pagina
// pubblica e si tira fuori l'elenco, poi si sceglie quale video portare qui.
//
// Si legge l'HTML, non un'API: per l'API servirebbe una chiave Google che qui
// non c'e', e per una cartella condivisa con "chiunque abbia il link" la pagina
// basta. Il prezzo e' che Google puo' cambiare il suo HTML quando vuole e
// questo smette di funzionare: per questo, se non trova niente, lo dice invece
// di far finta che la cartella sia vuota — cosi' si capisce subito che e'
// cambiato qualcosa e si torna a incollare il link del singolo file.
function drivePagina(indirizzo, salti) {
  return new Promise((ok, no) => {
    if (salti > 5) { no(new Error("troppi rimbalzi")); return; }
    let u;
    try { u = new URL(indirizzo); } catch (err) { no(new Error("indirizzo non valido")); return; }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { headers: { "User-Agent": "Mozilla/5.0 (ComoTV-ponte)", "Accept-Language": "it" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        drivePagina(new URL(res.headers.location, u).href, salti + 1).then(ok, no);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); no(new Error("la cartella risponde " + res.statusCode)); return; }
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (t.length < 4e6) t += c; });
      res.on("end", () => ok(t));
    });
    req.on("error", (e) => no(new Error("non raggiungibile: " + e.message)));
    req.setTimeout(30000, () => { req.destroy(); no(new Error("la cartella non risponde")); });
  });
}

function driveSmonta(t) {
  const fuori = [], visti = new Set();
  // il nome sta nell'aria-label della tessera, l'id in un data-id poco dopo
  const rx = /aria-label="([^"]{3,140}?)\s*(?:Video|Immagine|Audio|File PDF|Cartella)?"/g;
  let m;
  while ((m = rx.exec(t))) {
    const coda = t.slice(rx.lastIndex, rx.lastIndex + 700);
    const d = coda.match(/data-id="([A-Za-z0-9_-]{20,})"/);
    if (!d || visti.has(d[1])) continue;
    visti.add(d[1]);
    const nome = m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
                     .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!/\.(mp4|mov|m4v|webm)$/i.test(nome)) continue;      // qui servono i video
    fuori.push({ id: d[1], nome });
  }
  return fuori;
}

async function driveCartella(p) {
  const id = String(p.id || "").trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw new Error("id cartella non valido");
  const t = await drivePagina("https://drive.google.com/drive/folders/" + id, 0);
  const titolo = (t.match(/<title>([^<]*)<\/title>/) || [, ""])[1]
    .replace(/ - Google Drive$/, "").replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
  const file = driveSmonta(t);
  if (!file.length) {
    throw new Error("non trovo video in quella cartella: o non ce ne sono, o non e\u2019 condivisa " +
                    "con chiunque abbia il link. In alternativa apri il file e incolla il suo link.");
  }
  return { ok: true, cartella: titolo, file };
}

function videoPrelievo(id) {
  const st = PRELIEVI.get(String(id || ""));
  if (!st) return { ok: false, errore: "prelievo sconosciuto" };
  return { ok: !st.errore, id: st.id, scritti: st.scritti, tot: st.tot,
           fatto: st.fatto, errore: st.errore || undefined,
           file: st.file || undefined, url: st.file ? "/video/" + st.file : undefined };
}

// ── origine NAS ────────────────────────────────────────────────────────
// Il NAS della redazione tiene l'archivio vero (SHOW → data → MATERIALE).
// Un'attivita' pianificata su DSM manda qui l'elenco dei file ogni paio di
// minuti: cosi' il catalogo si vede anche da fuori, mentre i BYTE dei video
// restano in LAN (il playout li pesca direttamente dal NAS).
// Sta solo in memoria: e' una fotografia che il NAS rinfresca da solo, non
// merita di ingrassare lo stato su disco.
let NAS = { base: "", file: [], ts: 0 };
const MAX_NAS_FILE = 3000;

function videoNasSet(p) {
  const base = String(p.base || "").trim();
  if (!/^https:\/\//.test(base)) throw new Error("serve una base https (il playout e' https: in http il browser blocca i video)");
  const dentro = Array.isArray(p.file) ? p.file : [];
  const file = [];
  for (const f of dentro) {
    const rel = String((f && f.p) || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!rel || rel.indexOf("..") >= 0) continue;
    if (!/\.mp4$/i.test(rel)) continue;
    file.push({ p: rel, size: Number(f.size) || 0, ts: Number(f.ts) || 0 });
    if (file.length >= MAX_NAS_FILE) break;
  }
  file.sort((a, b) => b.ts - a.ts);
  NAS = { base: base.replace(/\/+$/, "") + "/", file: file, ts: Date.now() };
  return { ok: true, ricevuti: file.length, base: NAS.base };
}

function videoElenco() {
  try {
    const dir = cartellaVideo();
    const out = fs.readdirSync(dir)
      .filter(f => f.endsWith(".mp4") && !f.startsWith("."))
      .map(f => { const st = fs.statSync(path.join(dir, f));
                  return { file: f, url: "/video/" + f, size: st.size, ts: Math.floor(st.mtimeMs) }; });
    out.sort((a, b) => b.ts - a.ts);
    return { ok: true, video: out, nas: NAS, spazio: spazioDisco(out) };
  } catch (err) { return { ok: true, video: [], nas: NAS, spazio: spazioDisco([]) }; }
}

// quanto pesano i contributi caricati e quanto disco resta: i video sono
// l'unica cosa qui dentro che cresce davvero, meglio vederlo per tempo
function spazioDisco(elenco) {
  const usato = elenco.reduce((t, v) => t + (v.size || 0), 0);
  let libero = 0;
  try { const s = fs.statfsSync(cartellaVideo()); libero = s.bavail * s.bsize; } catch (err) {}
  return { usato, libero };
}

// ── quanto spazio c'e' e quanto ne occupano i contenuti ──────────────
// Serve al Magazzino: numeri veri, non stime. Il disco lo chiede al
// sistema; foto e video si contano cartella per cartella.
function pesoCartella(dir, filtro) {
  let n = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(".")) continue;
      if (filtro && !filtro(f)) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) { n++; bytes += st.size; }
      } catch (err) {}
    }
  } catch (err) {}
  return { n, bytes };
}

function magazzinoStato() {
  let disco = null;
  try {
    const s = fs.statfsSync(CONFIG.STATO.replace(/\/[^/]*$/, "") || "/");
    const totale = s.blocks * s.bsize;
    const libero = s.bavail * s.bsize;
    disco = { totale, libero, usato: totale - libero };
  } catch (err) {}
  return {
    ok: true,
    disco,
    video: pesoCartella(cartellaVideo(), f => /\.mp4$/i.test(f)),
    foto: pesoCartella(CONFIG.LOGHI)
  };
}

function videoCancella(p) {
  const f = path.basename(String(p.file || ""));
  if (!f.endsWith(".mp4")) throw new Error("file non valido");
  const percorso = path.join(cartellaVideo(), f);
  if (!fs.existsSync(percorso)) throw new Error("file inesistente");
  fs.unlinkSync(percorso);
  return { ok: true, file: f };
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
    // TAKE da pulsante fisico (Stream Deck): manda in onda la grafica ARMATA
    // del canale con UNA sola GET (token in coda, così qualsiasi tasto HTTP la
    // può chiamare). Riusa regiaState → l'SSE spinge il play al playout subito.
    //   ?take=1&canale=N&token=…     → in onda l'armata
    //   ?take=out&canale=N&token=…   → fuori onda il livello dell'armata (o &liv=L)
    if (q.get("take") != null) {
      const tok = q.get("token") || q.get("t") || "";
      // Il tasto fisico manda in onda: vuole la chiave di COMANDO. Durante
      // il passaggio si accetta ancora il vecchio token, ma lo si annota:
      // finche' compare in registro, c'e' uno Stream Deck da aggiornare.
      const okNuova = CONFIG.CHIAVE_COMANDO && tok === CONFIG.CHIAVE_COMANDO;
      // la vecchia vale solo se le chiavi non sono ancora configurate, oppure
      // durante il passaggio: tolta la rete di sicurezza non apre piu' niente
      const okVecchia = (!CONFIG.CHIAVE_COMANDO || CONFIG.VECCHIO_OK) && tok === CONFIG.TOKEN;
      if (!okNuova && !okVecchia) return json(res, { ok: false, errore: "chiave non valida" }, 403);
      if (!okNuova && CONFIG.CHIAVE_COMANDO) {
        console.log("[take] chiave VECCHIA usata da " + (req.socket.remoteAddress || "?") +
                    " — questo pulsante va aggiornato");
      }
      const c = canaleDi(q.get("canale") || q.get("c"));
      const ix = regiaDi(c);
      try {
        if (String(q.get("take")) === "out") {
          const L = q.get("liv") != null ? q.get("liv") : (ix.armato ? ix.armato.liv : 1);
          return json(res, regiaState({ c: c, state: "out", liv: L }));
        }
        const arm = ix.armato;
        if (!arm || !arm.id) return json(res, { ok: false, errore: "niente di armato su questo canale: selezionala in regia" });
        return json(res, regiaState({ c: c, state: "play", id: arm.id, liv: arm.liv }));
      } catch (err) {
        return json(res, { ok: false, errore: err.message });
      }
    }
    // come va il prelievo di un file da un link
    if (q.get("preleva")) return json(res, videoPrelievo(q.get("preleva")));
    // le partite per il pannello di Premiere (e per chiunque altro serva)
    // Il titolo disegnato: torna un PNG, non un json.
    if (q.get("titolo") !== null) {
      return pngDelTitolo({
        t1: q.get("titolo") || "", t2: q.get("t2") || "",
        sott: q.get("sott") || "", comp: q.get("comp") || ""
      }).then((buf) => {
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buf.length,
                             "Cache-Control": "no-store" });
        res.end(buf);
      }).catch((e) => json(res, { ok: false, errore: e.message }));
    }
    // La locandina della colonna, disegnata qui e non ritagliata altrove.
    if (q.get("locandina") !== null) {
      // Il disegno si costruisce DENTRO la promessa. Fuori, un errore nel
      // comporre l'svg esce dalla catena, nessuno lo raccoglie e Node chiude
      // il processo: e' successo, e il ponte e' caduto per una funzione che
      // mancava. Una grafica sbagliata non deve poter spegnere la regia.
      return Promise.resolve()
        .then(() => svgLocandina({
          comp: q.get("comp") || "", casa: q.get("casa") || "", ospite: q.get("ospite") || "",
          data: q.get("data") || "", ora: q.get("ora") || "", foto: q.get("foto") || ""
        }))
        .then(pngDaSvg)
        .then((buf) => {
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": buf.length,
                               "Cache-Control": "no-store" });
          res.end(buf);
        }).catch((e) => json(res, { ok: false, errore: e.message }));
    }
    if (q.get("partite")) {
      return airtableEventi()
        .then((d) => json(res, d))
        .catch((e) => json(res, { ok: false, errore: e.message }));
    }
    if (q.get("regia") === "item" && q.get("id")) {
      const c = canaleDi(q.get("canale") || q.get("c"));
      return json(res, (S.voci[c] && S.voci[c][q.get("id")]) || {});
    }
    if (q.get("regia")) return json(res, statoRegia(canaleDi(q.get("canale") || q.get("c"))));
    if (q.get("partita")) return json(res, statoPartita(canaleDi(q.get("canale") || q.get("c"))));
    if (q.get("loghi")) return json(res, logoElenco());
    if (q.get("video")) return json(res, videoElenco());
    if (q.get("magazzino")) return json(res, magazzinoStato());
    if (q.get("budget") === "drive") {
      // la bacheca per lo script del Drive: consegna la richiesta pendente
      // (e non la riconsegna per 10 minuti, contro i doppioni)
      var ric = S.budget && S.budget.richiesta;
      if (!ric) return json(res, {});
      if (ric.servita && Date.now() - ric.servita < 10 * 60 * 1000) return json(res, {});
      ric.servita = Date.now();
      salva();
      return json(res, ric.pacchetto || {});
    }
    if (q.get("budget")) return json(res, S.budget || {});
    return json(res, { ok: true, servizio: "Ponte Como TV", canali: CONFIG.CANALI, versione: 1 });
  }

// ── CHI PUO' FARE COSA ────────────────────────────────────────────────
// Due livelli soltanto:
//   CONTRIBUTO  manda roba in scaletta e carica materiale. Lo hanno gli
//               inviati e i giornalisti, anche da fuori. Quello che arriva
//               in scaletta NON va in onda da solo.
//   COMANDO     mette in onda, toglie, cancella, svuota. Solo la regia.
//               Puo' fare anche tutto quello che puo' il contributo.
// Leggere non richiede nulla, come prima: il playout dei vMix deve poter
// leggere sempre, altrimenti va nero.
// ── LE PAGINE DI LAVORO SONO APERTE ───────────────────────────────────
// I giornalisti lavorano da ovunque e da qualsiasi computer: chiedere una
// chiave per compilare una grafica li blocca e basta. Quindi tutto cio' che
// PREPARA (mandare in scaletta, scrivere in un progetto, caricare una foto)
// non chiede niente. Cio' che MANDA IN ONDA resta della regia, e la chiave
// di comando serve come prima: nessuno mette una grafica sullo schermo
// passando di qui. Con COMOTV_LAVORO_APERTO=0 si richiude tutto.
const LAVORO_APERTO = process.env.COMOTV_LAVORO_APERTO !== "0";

// ── DA CASA NOSTRA NIENTE CHIAVE ──────────────────────────────────────
// Il magazzino sta su un indirizzo pubblico e /api risponde a chiunque: la
// chiave e' l'unica cosa che impedisce a un estraneo di sovrascrivere le foto
// che poi vanno in onda. Toglierla del tutto aprirebbe il magazzino al mondo.
// Cosi' invece dalla rete Como TV (da dove escono i vMix e la redazione) il
// caricamento non chiede niente, e da fuori la chiave serve come prima.
const RETE_CASA = String(process.env.COMOTV_RETE || "")
  .split(",").map(x => x.trim()).filter(Boolean);
const SENZA_CHIAVE_DA_CASA = new Set(["logo-carica"]);

// Le password personali aprono SOLO il magazzino delle foto. Non sono chiavi
// di contributo ridotte: chi ne ha una carica le foto e basta, non manda
// grafiche in scaletta e non tocca la regia. Cosi' darne una a chi lavora da
// casa non allarga niente di quello che puo' fare.
const OP_MAGAZZINO = new Set(["logo-carica"]);

function daCasa(ip) {
  if (!RETE_CASA.length || !ip) return false;
  const pulito = String(ip).replace(/^::ffff:/, "").trim();
  return RETE_CASA.indexOf(pulito) >= 0;
}

const OP_COMANDO = new Set([
  "regia-state", "regia-del", "regia-svuota", "regia-move", "regia-order",
  "regia-rename", "regia-taglio", "regia-liv", "regia-arma", "regia-megafono",
  "regia-presa", "regia-battito", "regia-molla",
  "progetto-del", "progetto-carica",
  "logo-togli", "video-togli", "video-nas",
  "clip-elimina"
]);

function permesso(p, ip) {
  const K = CONFIG;
  const t = String(p.token || "");
  // preparare e' aperto, mandare in onda no
  if (LAVORO_APERTO && !OP_COMANDO.has(p.tipo)) {
    const suo = K.CHIAVI.find(x => x.chiave === t);
    if (suo) p.__chi = suo.nome || "";   // se ha una password sua, resta scritto chi
    return;
  }
  // dalla redazione il caricamento delle foto passa senza chiave
  if (SENZA_CHIAVE_DA_CASA.has(p.tipo) && daCasa(ip)) return;
  // finche' le chiavi nuove non sono configurate vale il vecchio token:
  // un ponte aggiornato ma non ancora configurato non si pianta
  if (!K.CHIAVE_COMANDO && !K.CHIAVE_CONTRIBUTO && !K.CHIAVI.length) {
    if (t !== K.TOKEN) throw new Error("token non valido");
    return;
  }
  const comanda = K.CHIAVE_COMANDO && t === K.CHIAVE_COMANDO;
  const personale = K.CHIAVI.find(x => x.chiave === t);
  if (personale) {
    // password personale: vale per il magazzino e per nient'altro
    if (!OP_MAGAZZINO.has(p.tipo)) {
      throw new Error("questa password vale solo per caricare le foto in magazzino");
    }
    p.__chi = personale.nome || "";
    return;
  }
  const contribuisce = (K.CHIAVE_CONTRIBUTO && t === K.CHIAVE_CONTRIBUTO) ||
                       (K.VECCHIO_OK && t === K.TOKEN);
  if (!comanda && !contribuisce) throw new Error("chiave non valida");
  if (OP_COMANDO.has(p.tipo) && !comanda) {
    throw new Error("questa operazione richiede la chiave di comando della regia");
  }
}

  // ── comandi ──
  if (req.method === "POST" && (u.pathname === "/api" || u.pathname === "/exec")) {
    let corpo = "";
    req.on("data", d => {
      corpo += d;
      if (corpo.length > 24e6) { req.destroy(); }     // guardia anti-abuso (i pezzi video arrivano a ~11MB in base64)
    });
    req.on("end", async () => {
      let p, out;
      try { p = JSON.parse(corpo); } catch (err) { return json(res, { ok: false, errore: "richiesta illeggibile" }); }
      // Il referto del pannello Premiere. Non chiede la chiave apposta: il
      // pannello gira su un PC di montaggio, e mettergli in tasca una chiave
      // del ponte per spedire un pezzo di testo sarebbe uno scambio pessimo.
      // Non tocca niente, non legge niente: scrive solo in coda a un file che
      // leggo io. Cappato in lunghezza, e solo qui in sviluppo.
      if (p.tipo === "referto") {
        try {
          const t = String(p.testo || "").slice(0, 200000);
          const dove = path.join(path.dirname(CONFIG.STATO), "referti.txt");
          fs.appendFileSync(dove,
            "\n\n═══ " + new Date().toISOString() + " ═══ " + (p.da || "pannello") + "\n" + t);
          return json(res, { ok: true });
        } catch (err) { return json(res, { ok: false, errore: err.message }); }
      }
      try {
        permesso(p, req.headers["x-real-ip"] || req.socket.remoteAddress);
        switch (p.tipo) {
          case "regia-load":   out = regiaLoad(p); break;
          case "regia-state":  out = regiaState(p); break;
          case "regia-del":    out = regiaDel(p); break;
          case "regia-svuota": out = regiaSvuota(p); break;
          case "regia-move":   out = regiaMove(p); break;
          case "regia-order":  out = regiaOrder(p); break;
          case "regia-rename": out = regiaRename(p); break;
          case "regia-taglio": out = regiaTaglio(p); break;
          case "regia-liv":    out = regiaLiv(p); break;
          case "regia-arma":   out = regiaArma(p); break;
          case "regia-presa":   out = regiaPresa(p); break;
          case "regia-battito": out = regiaBattito(p); break;
          case "regia-molla":   out = regiaMolla(p); break;
          case "regia-megafono": out = regiaMegafono(p); break;
          case "progetto-crea":     out = progettoCrea(p); break;
          case "progetto-aggiungi": out = progettoAggiungi(p); break;
          case "progetto-elenco":   out = progettoElenco(); break;
          case "progetto-leggi":    out = progettoLeggi(p); break;
          case "progetto-del":      out = progettoDel(p); break;
          case "progetto-carica":   out = progettoCarica(p); break;
          case "progetto-copia":    out = progettoCopia(p); break;
          case "progetto-togli":    out = progettoTogli(p); break;
          case "progetto-sposta":   out = progettoSposta(p); break;
          case "partita-set":  out = partitaSet(p); break;
          case "budget-set":   out = budgetSet(p); break;
          case "budget-invia": out = budgetInvia(p); break;
          case "budget-esito": out = budgetEsito(p); break;
          case "logo-carica":  out = logoSalva(p); break;
          case "logo-togli":   out = logoCancella(p); break;
          case "video-inizia": out = videoInizia(p); break;
          case "video-pezzo":  out = videoPezzo(p); break;
          case "video-fine":   out = videoFine(p); break;
          case "video-preleva": out = videoPreleva(p); break;
          case "drive-cartella": out = await driveCartella(p); break;
          case "video-togli":  out = videoCancella(p); break;
          case "video-nas":    out = videoNasSet(p); break;
          // questi vivono sui Fogli Google: si inoltrano
          case "formazioni":
          case "classifica":
          case "eventi":
          case "drive-info":   out = await inoltra(p); break;
          default:
            if (CLIP && CLIP.attivo() && /^clip-/.test(p.tipo)) { out = await CLIP.azione(p); break; }
            throw new Error("tipo di invio sconosciuto: " + p.tipo);
        }
        if (out.ok === undefined) out.ok = true;
      } catch (err) {
        out = { ok: false, errore: err.message };
      }
      json(res, out);
    });
    return;
  }

  // ── contributi video del PAT: serviti con gli HTTP Range ──
  if (u.pathname.startsWith("/video/")) {
    const nome = path.basename(decodeURIComponent(u.pathname));
    const file = path.join(cartellaVideo(), nome);
    if (!nome.endsWith(".mp4") || nome.startsWith(".")) { res.writeHead(404).end("non trovato"); return; }
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
      const range = req.headers.range;
      const base = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
                     "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" };
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let a = m && m[1] ? parseInt(m[1], 10) : 0;
        let b = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
        if (isNaN(a) || a < 0) a = 0;
        if (isNaN(b) || b >= st.size) b = st.size - 1;
        if (a > b) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
        res.writeHead(206, Object.assign({}, base, {
          "Content-Length": b - a + 1,
          "Content-Range": "bytes " + a + "-" + b + "/" + st.size
        }));
        fs.createReadStream(file, { start: a, end: b }).pipe(res);
      } else {
        res.writeHead(200, Object.assign({}, base, { "Content-Length": st.size }));
        fs.createReadStream(file).pipe(res);
      }
    });
  }

  // ── loghi caricati dalla redazione ──
  if (u.pathname.startsWith("/loghi/")) {
    const nome = path.basename(decodeURIComponent(u.pathname));
    const file = path.join(CONFIG.LOGHI, nome);
    return fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
      // rivalidazione invece di cache fissa: la foto resta cache-abile, ma il
      // browser controlla a ogni uso se e' cambiata (etag = mtime+dimensione).
      // Se il Panda la ri-carica si vede SUBITO; se e' uguale, 304 leggero.
      const etag = '"' + st.mtimeMs.toString(36) + "-" + st.size.toString(36) + '"';
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { "ETag": etag, "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
        return res.end();
      }
      res.writeHead(200, {
        "Content-Type": TIPI[path.extname(file).toLowerCase()] || "image/png",
        "Cache-Control": "no-cache",
        "ETag": etag,
        "Last-Modified": st.mtime.toUTCString(),
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

  // ── playlist, segmenti e clip di Clip Live ──
  if (CLIP && CLIP.attivo() && CLIP.serviHttp(req, res, u)) return;

  // ── pagine ──
  serviStatico(req, res, u.pathname);
});

carica();
// la cartella di lavoro sta accanto allo stato: dev e produzione restano
// separati senza configurare niente, come per i contributi video
if (CLIP) CLIP.avvio({
  dir: process.env.COMOTV_CLIP_DIR || path.join(path.dirname(CONFIG.STATO), "clip")
});
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
