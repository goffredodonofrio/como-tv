"use strict";
// ══════════════════════════════════════════════════════════════════════
//  CLIP LIVE — registrare il flusso, tenerlo a portata di DVR, tagliarlo
// ══════════════════════════════════════════════════════════════════════
//
//  Il ponte sa gia' servire un video al tag <video> e conosce le partite di
//  Airtable. Quello che non sa fare e' guardare un flusso mentre va in onda.
//  Qui si aggiunge quel pezzo, e nient'altro: un ffmpeg per evento che
//  RIMULTIPLEXA (non transcodifica) il flusso in segmenti da pochi secondi,
//  con una playlist che cresce. Quella playlist e' il DVR: il browser la
//  legge con hls.js e puo' tornare indietro fin dove si e' registrato.
//
//  Il taglio e' la stessa idea al contrario: da IN a OUT, ffmpeg ricopia i
//  byte gia' scritti. Nessuna ricodifica, un secondo di CPU, e la clip esce
//  mentre la partita e' ancora in corso. La ricodifica si paga solo quando
//  si chiede il taglio preciso al fotogramma o il formato verticale.
//
//  Sta in un file suo, e non fa NIENTE se non gli si accende l'interruttore
//  (COMOTV_CLIP=1). Cosi' questo codice puo' viaggiare fino in produzione
//  restando spento, e la regia in onda non si accorge che esiste.
//
//  Perimetro: tutto quello che scrive sta sotto la cartella di lavoro, che
//  in dev e' /var/lib/comotv-dev/clip — separata da quella di produzione
//  come lo stato e i contributi.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFile, execFileSync } = require("child_process");
const os = require("os");
const dgram = require("dgram");
const crypto = require("crypto");

const ATTIVO = process.env.COMOTV_CLIP === "1";

const FFMPEG  = process.env.COMOTV_FFMPEG  || "ffmpeg";
const FFPROBE = process.env.COMOTV_FFPROBE || "ffprobe";

// Segmenti corti: si vede prima in DVR e il taglio in copia parte piu' vicino
// al punto chiesto (in copia si puo' cominciare solo da un inizio segmento).
// A 2 secondi lo scarto in testa e' al massimo di 2 secondi, e una partita di
// due ore fa 3.600 segmenti: tanti file, ma nessun problema.
const SEGMENTO = parseInt(process.env.COMOTV_CLIP_SEG || "2", 10);
// IL PROXY. Una copia leggera che si scrive mentre la partita entra, e che
// serve a LAVORARE: si scorre, si cerca, si taglia sopra quella. Misurato su
// un 1080p50 vero: 480x270 a 25 fotogrammi pesa 71 KB ogni due secondi
// contro 2,24 MB dell'originale — un trentunesimo — e a guardarlo alla
// misura del monitor non si distingue (il cronometro si legge). Costa due
// terzi di un core, e la macchina ne ha due: quindi non piu' di due dirette
// alla volta, e mai per la semplice anteprima.
const PROXY_ACCESO = process.env.COMOTV_CLIP_PROXY !== "0";
const MAX_PROXY = parseInt(process.env.COMOTV_CLIP_MAX_PROXY || "2", 10);
const PROXY_LARGO = parseInt(process.env.COMOTV_CLIP_PROXY_W || "480", 10);
// Rete di sicurezza: una registrazione dimenticata accesa mangia il disco.
const MAX_SECONDI = parseInt(process.env.COMOTV_CLIP_MAX || "18000", 10);   // 5 ore
// Una clip piu' lunga di cosi' non e' una clip: e' l'integrale.
const MAX_CLIP = 900;
// I formati in cui esce una clip. Il 16:9 e' il flusso com'e': si ricopiano i
// byte e basta. Gli altri due ritagliano l'immagine, quindi si ricodificano —
// non e' una scelta, e' che si sta cambiando l'inquadratura.
// ── L'INQUADRATURA CHE SI MUOVE ───────────────────────────────────────
//
//  Da un 16:9 un verticale prende il 31% della larghezza: quello che resta
//  fuori, resta fuori. Finora il ritaglio era fermo al centro, e su
//  un'azione che attraversa il campo si vedeva erba vuota. Adesso il
//  ritaglio puo' SEGUIRE, guidato da qualche punto — dei keyframe: {t, x}
//  con t in secondi dal principio del pezzo e x il centro dell'inquadratura
//  da 0 (tutto a sinistra) a 1 (tutto a destra).
//
//  I punti li propone la macchina (inquadra.py) e li corregge chi monta:
//  l'automatico non ha mai l'ultima parola, perche' segue i giocatori e i
//  giocatori non sono la palla.
const INQUADRA_PY = path.join(__dirname, "inquadra.py");
const LARGHEZZA_FORMATO = { "9:16": (9 / 16) / (16 / 9), "3:4": (3 / 4) / (16 / 9), "1:1": 1 / (16 / 9) };

// SENZA SCATTI. Fra un punto e l'altro non si va in retta ma con una curva
// che parte e arriva ferma (3u^2-2u^3): con la retta, a ogni keyframe
// l'inquadratura cambiava direzione di colpo e si vedeva uno strappo.
// Le virgole vanno protette: dentro un filtro separano i filtri.
function fraDuePunti(a, b, t0, t1, quale) {
  const dt = Math.max(0.04, t1 - t0);
  const u = "((t-" + t0.toFixed(2) + ")/" + dt.toFixed(2) + ")";
  const morbido = "(" + u + "*" + u + "*(3-2*" + u + "))";
  return "(" + a + "+(" + b + "-" + a + ")*" + morbido + ")";
}
// una qualsiasi delle tre curve (x, y, zoom) come espressione di t
function espressioneDi(punti, campo, difetto, avvolgi) {
  const p = (punti || []).slice().filter((k) => isFinite(k.t)).sort((a, b) => a.t - b.t);
  if (!p.length) return null;
  const v = (k) => avvolgi((k[campo] === undefined ? difetto : k[campo]));
  let e = v(p[p.length - 1]);
  for (let i = p.length - 2; i >= 0; i--) {
    e = "if(lt(t\\," + p[i + 1].t.toFixed(2) + ")\\," +
        fraDuePunti(v(p[i]), v(p[i + 1]), p[i].t, p[i + 1].t, campo) + "\\," + e + ")";
  }
  if (p[0].t > 0.01) e = "if(lt(t\\," + p[0].t.toFixed(2) + ")\\," + v(p[0]) + "\\," + e + ")";
  return e;
}

// Il filtro completo per un pezzo. Il ritaglio puo' muoversi in tutte e due
// le direzioni e stringersi: la larghezza e l'altezza vengono dallo zoom,
// e sopra o sotto ci si sposta solo se si e' stretto qualcosa (a zoom 1 un
// 9:16 prende gia' tutta l'altezza e non c'e' margine).
//  LO ZOOM E' PER CLIP, I MOVIMENTI NO. Nel filtro crop di ffmpeg la
//  larghezza e l'altezza si calcolano UNA VOLTA all'inizio: solo x e y si
//  rivalutano a ogni fotogramma (eval=frame). Quindi quanto si stringe e'
//  una scelta per il pezzo, e dentro quella finestra ci si muove liberi in
//  tutte e due le direzioni — che e' anche il motivo per cui lo zoom
//  serve: a piena altezza, sopra e sotto non c'e' margine dove andare.
function ritaglioDelPezzo(formato, inq) {
  const base = (FORMATI[formato] || FORMATI["16:9"]).vf;
  const largo = LARGHEZZA_FORMATO[formato];
  if (!base || !largo || !inq) return base;
  const punti = Array.isArray(inq) ? inq : (inq.punti || []);
  const z = Math.max(0.35, Math.min(1, Array.isArray(inq) ? 1 : (inq.z || 1)));
  if (!punti.length && z >= 0.999) return base;
  const h = "ih*" + z.toFixed(4);
  const w = "ih*" + (z * largo * 16 / 9).toFixed(6);
  const cx = espressioneDi(punti.length ? punti : [{ t: 0, x: 0.5, y: 0.5 }], "x", 0.5,
                           (v) => "(" + Number(v).toFixed(4) + "*iw)");
  const cy = espressioneDi(punti.length ? punti : [{ t: 0, x: 0.5, y: 0.5 }], "y", 0.5,
                           (v) => "(" + Number(v).toFixed(4) + "*ih)");
  const X = "max(0\\,min(iw-" + w + "\\," + cx + "-(" + w + ")/2))";
  const Y = "max(0\\,min(ih-" + h + "\\," + cy + "-(" + h + ")/2))";
  const scala = /scale=\d+:\d+/.exec(base);
  // niente eval=frame: in ffmpeg 6 x e y sono gia' rivalutate a ogni
  // fotogramma (il flag T nelle opzioni), e l'opzione non esiste piu'
  return "crop=w=" + w + ":h=" + h + ":x='" + X + "':y='" + Y + "'" +
         (scala ? "," + scala[0] : "");
}

const FORMATI = {
  "16:9": { vf: "" },
  "1:1":  { vf: "crop=ih:ih,scale=1080:1080" },
  "3:4":  { vf: "crop=ih*3/4:ih,scale=1080:1440" },
  "9:16": { vf: "crop=ih*9/16:ih,scale=1080:1920" }
};
// Il picco dichiarato e' 10-12 partite insieme (Goffredo, 2026-09-04): il
// tetto sta sopra, non sotto. Ogni registratore costa ~1,3% di una CPU e
// ~60 MB, misurati sulla VM: a fare paura e' il disco, non il resto.
const MAX_REG = parseInt(process.env.COMOTV_CLIP_MAX_REG || "16", 10);
// Sotto questi giga liberi non si comincia una registrazione nuova: meglio
// dirlo prima che riempire il disco a meta' serata.
const MIN_GB = parseInt(process.env.COMOTV_CLIP_MIN_GB || "10", 10);
// L'anello: quanti giorni resta il MATERIALE (segmenti e integrale) di una
// registrazione finita. Le clip tagliate e i dati (marker, kickoff) restano.
const GIORNI = parseFloat(process.env.COMOTV_CLIP_GIORNI || "3");
// Quante volte si riparte se il flusso cade. Alto: una partita dura due ore
// e chi trasmette puo' staccare piu' volte senza che sia un guasto nostro.
const MAX_RIAGGANCI = parseInt(process.env.COMOTV_CLIP_RIAGGANCI || "200", 10);
// L'integrale raddoppia il disco: gli stessi secondi, scritti due volte. Con
// dodici partite insieme non e' sostenibile, quindi di suo non si fa e si
// chiede quando serve (o lo fara' il lavoro notturno che porta al server).
const INTEGRALE_DA_SOLO = process.env.COMOTV_CLIP_INTEGRALE === "1";

// ── QUANDO SIAMO NOI AD ASPETTARE ─────────────────────────────────────
//
//  Di solito andiamo noi a prendere il flusso (caller). Ma chi gestisce le
//  macchine dall'altra parte puo' non voler aprire il proprio firewall a un
//  indirizzo nuovo: e' piu' semplice che siano loro a spingere verso di noi.
//  Allora ascoltiamo noi: si sceglie una porta libera, si consegna un
//  indirizzo, e chi trasmette lo incolla nella sua uscita SRT.
//
//  Le porte rispecchiano quelle di Mola (10001 in su): dodici, quante sono
//  le partite del picco.
// Le porte sono della MACCHINA, non del ponte: dev e produzione girano sulla
// stessa e non possono ascoltare sullo stesso numero. Quindi l'intervallo si
// configura, e i due ambienti ne hanno uno per uno — altrimenti il secondo
// che prova a mettersi in ascolto fallisce con un "indirizzo occupato" nel
// momento peggiore, cioe' quando qualcuno sta per registrare una partita.
const PORTE = (function () {
  const t = String(process.env.COMOTV_CLIP_PORTE || "10001-10012");
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(t.trim());
  const a = m ? parseInt(m[1], 10) : 10001;
  const b = m ? parseInt(m[2], 10) : 10012;
  const fuori = [];
  for (let i = a; i <= b && fuori.length < 32; i++) fuori.push(i);
  return fuori.length ? fuori : [10001];
})();
const IP_PUBBLICO = process.env.COMOTV_IP_PUBBLICO || "209.227.239.211";
// Una porta aperta sul mondo senza parola d'ordine e' un invito a spingerci
// dentro qualsiasi cosa. Con la passphrase, chi non ce l'ha non entra.
const PASSPHRASE = process.env.COMOTV_CLIP_PASS || "";

let DIR = "";                       // cartella di lavoro, decisa da server.js
// L'SSE del ponte manda lo stato della REGIA a un canale: una registrazione
// non e' roba di canale e non ci sta dentro senza forzare. Finche' non ha un
// suo flusso, la pagina di Clip Live richiede lo stato ogni paio di secondi —
// e' una richiesta piccola e non tiene aperto niente.
let annuncia = function () {};

// registro: sopravvive ai riavvii del ponte, come lo stato della regia
let R = { reg: {}, clip: {}, seq: {}, prog: {} };
const PROC = new Map();      // idRegistrazione -> processo ffmpeg
const PROXYS = new Map();     // i processi che scrivono la copia leggera

// ── utilita' minime ───────────────────────────────────────────────────

function nuovoId(pref) {
  return pref + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function sicuro(s) { return /^[A-Za-z0-9_-]{1,48}$/.test(String(s || "")); }
function num(v, min, max, dif) {
  const n = Number(v);
  if (!isFinite(n)) return dif;
  return Math.min(max, Math.max(min, n));
}
function cartellaReg(id) { return path.join(DIR, id); }
// Le clip stanno FUORI dalla cartella della registrazione: l'anello butta i
// segmenti dopo qualche giorno, e quello che e' stato tagliato deve
// sopravvivere a quella pulizia.
const CARTELLA_CLIP = "_clip";
const CARTELLA_HL = "_hl";
function fileClip(id) { return path.join(DIR, CARTELLA_CLIP, id + ".mp4"); }

function liberiGB() {
  try { const st = fs.statfsSync(DIR); return (st.bavail * st.bsize) / 1e9; }
  catch (e) { return 999; }
}
function playlistDi(id) { return path.join(cartellaReg(id), "live.m3u8"); }

// C'e' ancora, quel processo? Il segnale 0 non fa niente: chiede e basta.
// Ma un numero di processo si riusa: dopo un riavvio quel numero puo' essere
// diventato di qualcun altro. Quindi non basta che esista: deve essere
// l'ffmpeg che scrive PROPRIO in questa registrazione.
function vivo(pid, id) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch (e) { return false; }
  if (!id) return true;
  try {
    const riga = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
    return riga.indexOf(id) >= 0 && riga.indexOf("hls_segment_filename") >= 0;
  } catch (e) { return false; }        // niente /proc: meglio dirlo morto
}

// Chiedere al sistema, non al proprio registro: sulla stessa macchina girano
// due ponti, e un riavvio puo' lasciare in giro un ffmpeg che tiene la porta.
function portaLibera(porta) {
  try {
    const s = dgram.createSocket("udp4");
    let libera = true;
    s.on("error", () => { libera = false; });
    try { s.bind({ port: porta, exclusive: true }); } catch (e) { libera = false; }
    const stato = s.address ? true : true;
    try { s.close(); } catch (e) {}
    return libera;
  } catch (e) { return false; }
}

// LE PORTE, UNA PER UNA. In regia si sa su quale porta sta trasmettendo
// chi trasmette: e allora la porta si sceglie, non la si subisce. Qui si
// dice, per ognuna, se e' libera, se e' nostra e in attesa, se ci sta
// entrando qualcosa, o se se l'e' presa qualcun altro (l'altro ambiente
// sulla stessa macchina, o un processo rimasto da un riavvio).
function statoPorte() {
  const mie = {};
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato !== "registra" || !r.ascolto) return;
    mie[r.ascolto.porta] = r;
  });
  return PORTE.map((porta) => {
    const r = mie[porta];
    if (r) {
      const scritto = durataRegistrata(r.id);
      return { porta: porta, stato: scritto > 0 ? (r.guarda ? "guarda" : "rec") : "attesa",
               reg: r.id, titolo: r.titolo || "", durata: scritto };
    }
    return { porta: porta, stato: portaLibera(porta) ? "libera" : "occupata" };
  });
}

function assicura(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

let scritturaInCorso = null;
function scrivi() {
  if (scritturaInCorso) { scritturaInCorso.ancora = true; return; }
  scritturaInCorso = { ancora: false };
  const tmp = path.join(DIR, "registro.tmp");
  const fine = path.join(DIR, "registro.json");
  try {
    fs.writeFileSync(tmp, JSON.stringify(R));
    fs.renameSync(tmp, fine);
  } catch (e) { console.log("[clip] registro non salvato: " + e.message); }
  const ancora = scritturaInCorso.ancora;
  scritturaInCorso = null;
  if (ancora) scrivi();
}

function leggi() {
  try {
    const t = fs.readFileSync(path.join(DIR, "registro.json"), "utf8");
    const d = JSON.parse(t);
    if (d && d.reg) R = { reg: d.reg || {}, clip: d.clip || {}, seq: d.seq || {}, prog: d.prog || {} };
    // Un export "in lavorazione" non sopravvive a un riavvio: ffmpeg se ne
    // va con il servizio. Se resta scritto "lavora" la pagina mostra per
    // sempre un avanzamento fermo al 28%, e chi guarda aspetta un file che
    // non arrivera' mai. Alla riaccensione si dice com'e' andata davvero.
    let fermi = 0;
    Object.keys(R.seq).forEach((k) => {
      const q = R.seq[k];
      if (q.export && q.export.stato === "lavora") {
        q.export = { stato: "errore", formato: q.export.formato || "",
                     errore: "l'esportazione si e' fermata a un riavvio del ponte: rilanciala" };
        fermi++;
      }
      // stesso discorso per i pezzi in casa: uno stato "lavora" rimasto
      // appeso bloccava per sempre — ogni richiesta successiva usciva
      // subito dicendo "sto gia' lavorando", e non lavorava piu' nessuno
      if (q.casa && q.casa.stato === "lavora") {
        q.casa = { stato: "interrotto", fatti: q.casa.fatti || 0, quanti: q.casa.quanti || 0 };
        fermi++;
      }
    });
    if (fermi) console.log("[clip] " + fermi + " esportazione/i interrotta/e da un riavvio: segnate come da rifare");
  } catch (e) { /* prima accensione */ }
}

// Quanto dura, davvero, quello che e' stato registrato finora: la somma
// degli EXTINF della playlist. Contare i segmenti per la durata nominale
// sbaglia appena il flusso ha un buco o riparte.
function durataRegistrata(id) {
  try {
    const t = fs.readFileSync(playlistDi(id), "utf8");
    let tot = 0;
    const re = /#EXTINF:([0-9.]+)/g;
    let m;
    while ((m = re.exec(t))) tot += parseFloat(m[1]) || 0;
    return Math.round(tot * 10) / 10;
  } catch (e) { return 0; }
}

// La playlist, letta come una mappa: ogni segmento con il secondo in cui
// comincia. E' quello che serve per tagliare senza chiedere niente a nessuno.
function segmenti(id) {
  let testo;
  try { testo = fs.readFileSync(playlistDi(id), "utf8"); } catch (e) { return []; }
  const righe = testo.split("\n");
  const fuori = [];
  let dur = 0, t0 = 0, ora = 0;
  for (let i = 0; i < righe.length; i++) {
    const r = righe[i].trim();
    const m = /^#EXTINF:([0-9.]+)/.exec(r);
    if (m) { dur = parseFloat(m[1]) || 0; continue; }
    // ffmpeg scrive per ogni segmento l'ORA VERA in cui l'ha scritto. E'
    // quella che permette di incrociare un evento di ESPN — che porta anche
    // lui la sua ora — con il punto giusto della registrazione, senza fare
    // aritmetica sui minuti e senza indovinare i recuperi.
    const o = /^#EXT-X-PROGRAM-DATE-TIME:(.+)$/.exec(r);
    if (o) { const d = Date.parse(o[1].trim()); if (!isNaN(d)) ora = d; continue; }
    if (!r || r[0] === "#") continue;
    fuori.push({ file: path.join(cartellaReg(id), path.basename(r)), dur: dur, t0: t0, ora: ora });
    t0 += dur; dur = 0; ora = 0;
  }
  return fuori;
}

// I fotogrammi al secondo del materiale. Serve per la sequenza di Premiere,
// che ragiona in FRAME e non in secondi: darle 25 quando il flusso e' a 50
// vorrebbe dire una sequenza lunga il doppio e ogni taglio nel punto
// sbagliato. Il vMix di Como TV manda 1080p50, misurato il 2026-09-05.
function probeFps(file) {
  return new Promise((si) => {
    execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0",
                       "-show_entries", "stream=r_frame_rate",
                       "-of", "default=nw=1:nk=1", file], { timeout: 20000 },
      (err, out) => {
        if (err) return si(0);
        const m = /(\d+)\s*\/\s*(\d+)/.exec(String(out).trim());
        if (!m) { const n = parseFloat(out); return si(isFinite(n) ? n : 0); }
        const n = parseInt(m[2], 10) ? parseInt(m[1], 10) / parseInt(m[2], 10) : 0;
        si(n);
      });
  });
}

function probe(file) {
  return new Promise((si) => {
    execFile(FFPROBE, ["-v", "error", "-show_entries", "format=duration,size",
                       "-of", "default=nw=1:nk=1", file], { timeout: 20000 },
      (err, out) => {
        if (err) return si({});
        const righe = String(out).trim().split("\n");
        si({ durata: parseFloat(righe[0]) || 0, peso: parseInt(righe[1], 10) || 0 });
      });
  });
}

// ── il registratore ───────────────────────────────────────────────────

// Una master playlist elenca piu' qualita'. Lasciato libero, ffmpeg prende
// la PRIMA, che nei CDN e' quasi sempre la piu' bassa: si registrerebbe la
// partita a 320x180 senza che nessuno se ne accorga finche' non si guarda
// la clip. Quindi la scelta si fa qui, e si scrive nel registro.
async function risolviHls(url, qualita) {
  if (!/^https?:/i.test(url)) return { url: url };
  let testo;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    testo = await r.text();
  } catch (e) { throw new Error("la sorgente non risponde: " + e.message); }
  if (testo.indexOf("#EXT-X-STREAM-INF") < 0) return { url: url };   // gia' una lista di segmenti
  const righe = testo.split("\n");
  const varianti = [];
  for (let i = 0; i < righe.length; i++) {
    const m = /#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/.exec(righe[i]);
    if (!m) continue;
    const ris = /RESOLUTION=(\d+x\d+)/.exec(righe[i]);
    let u = "";
    for (let j = i + 1; j < righe.length; j++) {
      const r2 = righe[j].trim();
      if (r2 && r2[0] !== "#") { u = r2; break; }
    }
    if (u) {
      try { varianti.push({ banda: parseInt(m[1], 10), ris: ris ? ris[1] : "", url: new URL(u, url).toString() }); }
      catch (e) {}
    }
  }
  if (!varianti.length) return { url: url };
  varianti.sort((a, b) => b.banda - a.banda);
  const scelta = qualita === "bassa" ? varianti[varianti.length - 1] : varianti[0];
  return {
    url: scelta.url, scelta: scelta,
    varianti: varianti.map((x) => (x.ris || "?") + " " + Math.round(x.banda / 1000) + "k")
  };
}

function argomentiIngresso(url) {
  // Un flusso non e' un file: se cade, ffmpeg deve riprovare da solo invece
  // di chiudere la registrazione a meta' partita.
  if (/^https?:/i.test(url)) {
    return ["-reconnect", "1", "-reconnect_streamed", "1",
            "-reconnect_delay_max", "10", "-rw_timeout", "15000000", "-i", url];
  }
  if (/^srt:/i.test(url)) {
    // Di suo ci presentiamo noi al listener (caller). Ma se l'indirizzo dice
    // gia' come deve andare — per esempio "mode=listener", quando e' un vMix
    // a spingere verso di noi — si rispetta quello che c'e' scritto.
    if (/[?&]mode=/i.test(url)) return ["-i", url];
    const sep = url.indexOf("?") < 0 ? "?" : "&";
    return ["-i", url + sep + "mode=caller&latency=300"];
  }
  return ["-i", url];
}

function fileProxy(id) { return path.join(cartellaReg(id), "proxy.m3u8"); }
function quantiSegmenti(via) {
  try { return (fs.readFileSync(via, "utf8").match(/#EXTINF:/g) || []).length; } catch (e) { return 0; }
}
// Il proxy si annuncia solo quando ha RAGGIUNTO la registrazione. Se e'
// appena partito su una partita gia' lunga sta ancora rincorrendo, e una
// pagina che ci si appoggiasse vedrebbe una timeline piu' corta del vero.
function durataDi(via) {
  try {
    let t = 0;
    (fs.readFileSync(via, "utf8").match(/#EXTINF:([0-9.]+)/g) || [])
      .forEach((x) => { t += parseFloat(x.slice(8)) || 0; });
    return Math.round(t * 10) / 10;
  } catch (e) { return 0; }
}
function proxyCe(id) {
  const p = durataDi(fileProxy(id));
  if (!p) return false;
  return p >= durataRegistrata(id) - 15;
}

// IL PROXY, SCRITTO DA UN PROCESSO SUO.
//  Non si appende all'ffmpeg che registra: quello scrive in copia diretta e
//  non deve dipendere da niente: se la codifica del proxy rallenta o muore,
//  la partita non se ne accorge. Questo invece LEGGE la playlist mentre
//  cresce — ffmpeg la rilegge da solo finche' non trova la fine — e resta
//  indietro un paio di segmenti. Se muore si riparte da dove il proxy era
//  arrivato, non da capo.
function avviaProxy(r) {
  if (!PROXY_ACCESO || r.guarda || r.stato !== "registra") return;
  if (PROXYS.get(r.id)) return;
  // UN PROXY SOLO PER REGISTRAZIONE. Un riavvio del ponte puo' lasciare in
  // giro quello di prima: due encoder che scrivono gli stessi p00042.ts si
  // sovrascrivono a vicenda, i segmenti escono monchi e non ci si estrae
  // nemmeno un fotogramma. Prima di accenderne uno, si chiude quello vecchio.
  if (r.proxyPid) {
    try { process.kill(r.proxyPid, "SIGKILL"); console.log("[clip] proxy: chiuso l'orfano " + r.proxyPid); } catch (e) {}
    delete r.proxyPid;
  }
  if (PROXYS.size >= MAX_PROXY) { console.log("[clip] proxy: gia' " + PROXYS.size + " in lavorazione, questa diretta ne resta senza"); return; }
  const dir = cartellaReg(r.id);
  if (!fs.existsSync(playlistDi(r.id))) { setTimeout(() => avviaProxy(r), 3000); return; }
  const fatti = quantiSegmenti(fileProxy(r.id));
  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin",
    "-live_start_index", String(fatti), "-i", playlistDi(r.id),
    "-vf", "scale=" + PROXY_LARGO + ":-2,fps=25",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-g", "25", "-keyint_min", "25", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "64k",
    "-f", "hls", "-hls_time", String(SEGMENTO), "-hls_list_size", "0",
    "-hls_flags", "append_list+program_date_time+independent_segments+temp_file",
    "-hls_playlist_type", "event", "-hls_segment_type", "mpegts",
    "-start_number", String(fatti),
    "-hls_segment_filename", path.join(dir, "p%05d.ts"), fileProxy(r.id)];
  // ATTACCATO al ponte, al contrario del registratore. La registrazione non
  // deve morire con un riavvio; il proxy si': e' una copia usa e getta, e
  // uno staccato che sopravvive diventa un orfano che scrive sulla stessa
  // playlist di quello nuovo. Al riavvio si riaccende da dove era arrivato.
  const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
  PROXYS.set(r.id, pr);
  r.proxyPid = pr.pid;
  let coda = "";
  pr.stderr.on("data", (d) => { coda = (coda + d).slice(-2000); });
  pr.on("error", () => { PROXYS.delete(r.id); });
  pr.on("close", () => {
    PROXYS.delete(r.id);
    delete r.proxyPid;
    // finche' la partita entra, il proxy la insegue: se e' caduto, riparte
    if (r.stato === "registra") {
      r.proxyCadute = (r.proxyCadute || 0) + 1;
      if (r.proxyCadute <= 20) return void setTimeout(() => avviaProxy(r), 3000);
      console.log("[clip] proxy: caduto troppe volte su \"" + (r.titolo || r.id) + "\", lascio perdere");
    }
    scrivi();
  });
  console.log("[clip] proxy acceso su \"" + (r.titolo || r.id) + "\" (" + PROXY_LARGO + " di larghezza, da " + fatti + " segmenti)");
}
function fermaProxy(id) {
  const p = PROXYS.get(id);
  if (!p) return;
  PROXYS.delete(id);
  try { process.kill(p.pid, "SIGTERM"); } catch (e) {}
}

// ── L'ANTEPRIMA DI OGNI PORTA ─────────────────────────────────────────
//
//  Chi apre il MAM in diretta vuole vedere, in un colpo d'occhio, cosa sta
//  entrando su ogni porta: e' il multiview della regia. Un video per porta
//  sarebbe dodici lettori aperti; qui invece si scrive un fotogramma ogni
//  pochi secondi — preso dall'ULTIMO segmento della copia leggera, che e'
//  480 di larghezza e costa quasi niente — e la pagina lo rinfresca.
const ANTEPRIMA_OGNI = parseInt(process.env.COMOTV_CLIP_ANTEPRIMA || "5", 10);
const anteprimeInCorso = new Set();

function ultimoSegmento(id) {
  const dir = cartellaReg(id);
  const lista = [];
  try {
    fs.readdirSync(dir).forEach((f) => {
      const m = /^([sp])(\d{5})\.ts$/.exec(f);
      if (!m) return;
      lista.push({ n: parseInt(m[2], 10) + (m[1] === "p" ? 1000000 : 0), f: path.join(dir, f) });
    });
  } catch (e) {}
  if (!lista.length) return "";
  lista.sort((a, b) => a.n - b.n);
  // il PENULTIMO: l'ultimo puo' essere ancora in scrittura, e un segmento a
  // meta' non da' nessun fotogramma
  return lista[Math.max(0, lista.length - 2)].f;
}

async function anteprimaViva(r) {
  if (!r || r.stato !== "registra" || r.arch) return;
  if (anteprimeInCorso.has(r.id)) return;
  const da = ultimoSegmento(r.id);
  if (!da) return;
  anteprimeInCorso.add(r.id);
  const fuori = path.join(cartellaReg(r.id), "vivo.jpg");
  // il file di passaggio tiene l'estensione .jpg: ffmpeg sceglie il formato
  // dal nome, e su un "vivo.jpg.tmp" non scrive niente senza dire perche'
  const mezzo = path.join(cartellaReg(r.id), "vivo-nuovo.jpg");
  try {
    const fatto = await new Promise((si) => {
      const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", da, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "6", "-y", mezzo], { stdio: "ignore" });
      pr.on("error", () => si(false));
      pr.on("close", (code) => si(code === 0));
    });
    if (fatto) { try { fs.renameSync(mezzo, fuori); r.vivoQuando = Date.now(); } catch (e) {} }
  } finally { anteprimeInCorso.delete(r.id); }
}

function giraAnteprime() {
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato !== "registra" || r.arch || r.attesa) return;
    anteprimaViva(r).catch(() => {});
  });
}

// ── VEDERE SENZA TENERE, E TENERE SENZA RIATTACCARE ───────────────────
//
//  In regia si guarda il feed prima di registrarlo: si controlla che sia
//  quello giusto, che l'audio ci sia, che l'inquadratura sia a fuoco. Poi
//  si preme REC. E quando si smette di registrare si continua a guardare.
//
//  Prima erano due registrazioni diverse — "guarda" e "registra" — e
//  passare dall'una all'altra voleva dire ammazzare un ffmpeg e aprirne un
//  altro: chi trasmette si riaggancia, si perdono due secondi, e il file
//  ricomincia da capo. In diretta e' inaccettabile: il momento in cui
//  premi REC e' esattamente quello in cui sta succedendo qualcosa.
//
//  Adesso la connessione SRT e' UNA SOLA, dall'apertura della porta alla
//  chiusura. Cambia solo cosa si TIENE: mentre guardi, il custode butta la
//  testa vecchia; quando premi REC smette di buttare e segna da dove; a
//  STOP segna fino a dove, e ricomincia a buttare solo la coda nuova. REC
//  e STOP non toccano ffmpeg: non c'e' niente da riattaccare.
const FINESTRA_VEDI = parseInt(process.env.COMOTV_CLIP_FINESTRA || "900", 10);

function tenutiDi(r) { return (r.tenuti || []).concat(r.tieniDa !== undefined ? [{ da: r.tieniDa, a: 1e9 }] : []); }

function recAccendi(r) {
  if (r.tieniDa !== undefined) return r;         // gia' in registrazione
  r.tieniDa = durataRegistrata(r.id);
  r.vedi = false;
  scrivi(); annuncia(0, "clip");
  console.log("[clip] REC da " + Math.round(r.tieniDa) + "s su \"" + (r.titolo || r.id) + "\"");
  return r;
}
function recSpegni(r) {
  if (r.tieniDa === undefined) return r;
  const a = durataRegistrata(r.id);
  r.tenuti = (r.tenuti || []).concat([{ da: r.tieniDa, a: a }]);
  console.log("[clip] REC fermata: tenuti " + Math.round(a - r.tieniDa) + "s (" +
              Math.round(r.tieniDa) + "\u2192" + Math.round(a) + ")");
  delete r.tieniDa;
  r.vedi = true;
  scrivi(); annuncia(0, "clip");
  return r;
}

// IL CUSTODE. Mentre si guarda e basta, la testa vecchia non serve a
// nessuno e riempie il disco: se ne tiene un quarto d'ora, il resto va via.
// Quello che e' stato REGISTRATO non si tocca mai — nemmeno la parte in
// mezzo, se hai acceso e spento due volte.
function spazzaAnteprime() {
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato !== "registra" || !r.vedi || r.arch) return;
    const dur = durataRegistrata(r.id);
    const taglio = dur - FINESTRA_VEDI;
    if (taglio <= (r.daSecondo || 0)) return;
    const tenuti = tenutiDi(r);
    let via = 0, nuovoDa = r.daSecondo || 0;
    segmenti(r.id).forEach((sg) => {
      const fine = sg.t0 + sg.dur;
      if (fine > taglio) return;                       // e' ancora nella finestra
      if (tenuti.some((t) => fine > t.da && sg.t0 < t.a)) return;   // e' roba registrata
      try { fs.unlinkSync(sg.file); via++; nuovoDa = Math.max(nuovoDa, fine); } catch (e) {}
    });
    if (!via) return;
    // La playlist la riscrive ffmpeg, quindi le righe restano: si dice da
    // che secondo il materiale c'e' davvero, e la pagina non offre un
    // pezzo che non esiste piu'.
    r.daSecondo = Math.round(nuovoDa);
    scrivi();
    console.log("[clip] anteprima \"" + (r.titolo || r.id) + "\": buttati " + via +
                " segmenti, il materiale comincia a " + r.daSecondo + "s");
  });
}

function avviaProcesso(r) {
  const dir = cartellaReg(r.id);
  assicura(dir);
  // DUE MODI, stesso motore.
  //   registra: la playlist cresce e non dimentica niente — e' il DVR, e
  //             alla fine c'e' tutta la partita.
  //   guarda:   tiene solo gli ultimi venti secondi e butta il resto mentre
  //             va. Serve a VEDERE il flusso — c'e'? e' quello giusto? il
  //             suono c'e'? — senza scrivere un file che poi qualcuno deve
  //             ricordarsi di cancellare. Costa un pugno di megabyte.
  const finestra = r.guarda
    ? ["-hls_list_size", "10",
       "-hls_flags", "delete_segments+program_date_time+independent_segments+temp_file"]
    : ["-hls_list_size", "0",
       "-hls_flags", "append_list+program_date_time+independent_segments+temp_file",
       "-hls_playlist_type", "event"];

  const args = ["-hide_banner", "-loglevel", "warning", "-nostdin"]
    .concat(argomentiIngresso(r.urlLetto || r.url))
    .concat([
      "-t", String(r.guarda ? Math.min(MAX_SECONDI, 10800) : MAX_SECONDI),
      // TUTTO QUELLO CHE ARRIVA. Senza -map ffmpeg sceglie da solo, e
      // sceglie UNA pista audio: se la regia ne manda tre — internazionale,
      // commento, ambiente — le altre due si perdono qui, prima ancora di
      // toccare il disco, e non si recuperano piu'. Costano zero: e' sempre
      // una copia, non si ricodifica niente.
      "-map", "0:v:0?", "-map", "0:a?",
      "-c", "copy",                       // rimultiplexing: la CPU resta libera
      "-f", "hls",
      "-hls_time", String(SEGMENTO)
    ])
    .concat(finestra)
    .concat([
      "-hls_segment_type", "mpegts",
      "-hls_segment_filename", path.join(dir, "s%05d.ts"),
      playlistDi(r.id)
    ]);

  // STACCATO dal ponte: se il ponte si riavvia — un aggiornamento, un
  // errore, systemd — l'ffmpeg che sta registrando la partita non deve
  // morire con lui. Continua a scrivere; al riavvio il ponte lo ritrova dal
  // suo numero di processo e riprende a seguirlo.
  const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  pr.unref();
  r.pid = pr.pid;
  let coda = "";
  pr.stderr.on("data", (d) => { coda = (coda + d).slice(-4000); });
  pr.on("error", (e) => {
    r.stato = "errore"; r.errore = e.message; r.finita = Date.now();
    PROC.delete(r.id); scrivi(); annuncia(0, "clip");
  });
  pr.on("close", (code) => {
    PROC.delete(r.id);
    r.durata = durataRegistrata(r.id);
    if (r.stato !== "registra") fermaProxy(r.id);

    // NESSUNO L'HA FERMATA: allora non e' finita, e' caduta.
    // Sull'SRT non esiste il "riprova da solo" che l'http ha: quando chi
    // trasmette stacca — un attimo di rete, il vMix che si riavvia, la
    // pubblicita' — ffmpeg esce e senza questo la partita finirebbe li'.
    // Si riparte scrivendo in coda alla STESSA playlist: il buco resta
    // visibile nel DVR, ma il seguito c'e'.
    if (r.stato === "registra" && (Date.now() - r.avviata) / 1000 < MAX_SECONDI) {
      r.riagganci = (r.riagganci || 0) + 1;
      // Riagganciarsi ha senso se il flusso c'era e se n'e' andato. Se invece
      // non e' mai partito — porta occupata, indirizzo sbagliato — riprovare
      // ogni due secondi per duecento volte non aggiusta niente: nasconde
      // l'errore e basta.
      const maiPartita = durataRegistrata(r.id) === 0;
      if (maiPartita && (r.riagganci > 4)) {
        r.errore = ultimaRiga(coda) || "non riesco ad aprire questa sorgente";
        r.stato = "errore"; r.finita = Date.now();
        scrivi(); annuncia(0, "clip");
        return;
      }
      if (r.riagganci <= MAX_RIAGGANCI) {
        r.ultimoRiaggancio = Date.now();
        scrivi(); annuncia(0, "clip");
        setTimeout(() => { if (r.stato === "registra") avviaProcesso(r); }, 2000);
        return;
      }
      r.errore = "il flusso e' caduto " + r.riagganci + " volte: mi fermo";
    }

    r.finita = Date.now();
    if (r.stato === "registra") {
      r.stato = code === 0 ? "ferma" : "errore";
      if (code !== 0 && !r.errore) r.errore = ultimaRiga(coda) || ("ffmpeg e' uscito con " + code);
    }
    scrivi(); annuncia(0, "clip");
    if (r.durata > 0 && INTEGRALE_DA_SOLO && !r.guarda) integrale(r);
  });
  PROC.set(r.id, pr);
  // e la copia leggera parte accanto, appena la playlist esiste
  setTimeout(() => avviaProxy(r), 4000);
}

function ultimaRiga(t) {
  const righe = String(t || "").trim().split("\n").filter(Boolean);
  return righe.length ? righe[righe.length - 1].slice(0, 300) : "";
}

// A fine registrazione i segmenti diventano un MP4 unico. E' una ricucitura,
// non una ricodifica: dura secondi e da' il file da mandare in archivio.
function integrale(r) {
  const fuori = path.join(cartellaReg(r.id), "integrale.mp4");
  // Solo i segmenti che ci sono DAVVERO: se lo si chiede mentre il
  // registratore sta ancora chiudendo, la playlist puo' gia' nominare un
  // pezzo non ancora finito di scrivere, e ffmpeg si ferma alla prima riga
  // che non trova.
  const segs = segmenti(r.id).filter((x) => fs.existsSync(x.file));
  if (!segs.length) { r.integrale = "vuoto"; scrivi(); return; }
  // Anche qui i segmenti, non la playlist: se la registrazione e' caduta la
  // playlist non ha la riga di chiusura, e ffmpeg si metterebbe ad aspettare
  // un seguito che non arrivera' mai.
  const lista = path.join(cartellaReg(r.id), "integrale.txt");
  try { fs.writeFileSync(lista, segs.map((x) => "file '" + x.file + "'").join("\n") + "\n"); }
  catch (e) { r.integrale = "errore"; scrivi(); return; }
  r.integrale = "lavora"; scrivi();
  const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "concat", "-safe", "0", "-i", lista,
    "-c", "copy", "-movflags", "+faststart", "-y", fuori], { stdio: ["ignore", "ignore", "pipe"] });
  let coda = "";
  pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1500); });
  pr.on("close", async (code) => {
    try { fs.unlinkSync(lista); } catch (e) {}
    if (code === 0) {
      const d = await probe(fuori);
      r.integralePeso = d.peso || 0;
      // L'integrale deve durare quanto la registrazione. Se non e' cosi' —
      // succede quando il flusso e' caduto e ripartito, e i tempi dentro i
      // segmenti si accavallano — i secondi del DVR non corrispondono piu' a
      // quelli del file, e la sequenza per Premiere cadrebbe nel punto
      // sbagliato senza che nessuno se ne accorga. Meglio dirlo.
      const atteso = durataRegistrata(r.id);
      const vera = d.durata || 0;
      const scarto = atteso ? Math.abs(vera - atteso) / atteso : 0;
      r.integraleDurata = Math.round(vera * 10) / 10;
      if (vera > 6) {
        r.mini = await miniatura(fuori, path.join(cartellaReg(r.id), "mini.jpg"), vera / 2)
          ? "/clip/" + r.id + "/mini.jpg" : "";
      }
      if (atteso && scarto > 0.03) {
        r.integrale = "sospetto";
        r.integraleErrore = "l'integrale dura " + Math.round(vera) + "s ma la registrazione " +
          Math.round(atteso) + "s: il flusso e' caduto e ripartito, i tempi non corrispondono";
      } else {
        r.integrale = "pronto";
        r.integraleErrore = "";
        if (vera) r.durata = Math.round(vera * 10) / 10;
      }
    } else {
      // senza il motivo scritto, un integrale fallito e' un vicolo cieco
      r.integrale = "errore";
      r.integraleErrore = ultimaRiga(coda) || ("ffmpeg e' uscito con " + code);
    }
    scrivi(); annuncia(0, "clip");
  });
  pr.on("error", () => { r.integrale = "errore"; scrivi(); });
}

// ── le azioni che arrivano dal ponte ──────────────────────────────────

async function clipAvvia(p) {
  let url = String(p.url || "").trim();
  let ascolto = null;
  // "ricevi": non andiamo a prendere niente, ci mettiamo in ascolto e
  // consegniamo l'indirizzo a cui trasmettere.
  if (p.ricevi) {
    // UN ASCOLTO ALLA VOLTA.
    // Premere due volte apriva due ascolti su due porte diverse: chi
    // trasmette ne trova uno solo, e la pagina ti mostra l'altro — che resta
    // vuoto per sempre. Se ce n'e' gia' uno in attesa, si torna quello.
    // ...ma se la porta l'hai CHIESTA TU, quella vale: riusare un ascolto
    // aperto su un'altra porta vorrebbe dire ignorare la scelta, e chi
    // trasmette sta gia' bussando li'.
    const gia = Object.keys(R.reg).map((k) => R.reg[k]).find((x) =>
      x.stato === "registra" && x.ascolto && vivo(x.pid, x.id) &&
      (!!x.guarda === !!p.guarda) && durataRegistrata(x.id) === 0 &&
      (!p.porta || x.ascolto.porta === parseInt(p.porta, 10)));
    if (gia) return { ok: true, id: gia.id, gia: true, reg: pubblica(gia) };

    const usate = Object.keys(R.reg)
      .filter((k) => R.reg[k].stato === "registra" && R.reg[k].ascolto)
      .map((k) => R.reg[k].ascolto.porta);
    // e non basta il nostro registro: sulla macchina c'e' anche l'altro
    // ambiente, e possono restare processi orfani di un riavvio
    let porta;
    if (p.porta) {
      // l'ha scelta chi sta in regia: si apre quella o si dice perche' no
      const q = parseInt(p.porta, 10);
      if (PORTE.indexOf(q) < 0) throw new Error("la porta " + q + " non e' fra quelle del MAM");
      if (usate.indexOf(q) >= 0) throw new Error("la porta " + q + " ce l'hai gia' aperta");
      if (!portaLibera(q)) throw new Error("la porta " + q + " e' occupata da qualcun altro");
      porta = q;
    } else {
      porta = PORTE.find((x) => usate.indexOf(x) < 0 && portaLibera(x));
    }
    if (!porta) throw new Error("tutte le porte di ascolto sono occupate");
    const coda = "?mode=listener&latency=300" + (PASSPHRASE ? "&passphrase=" + PASSPHRASE : "") +
                 "&listen_timeout=7200000000";
    url = "srt://0.0.0.0:" + porta + coda;
    ascolto = {
      porta: porta,
      // quello che si consegna a chi trasmette: loro sono il caller
      indirizzo: "srt://" + IP_PUBBLICO + ":" + porta + "?mode=caller&latency=300" +
                 (PASSPHRASE ? "&passphrase=" + PASSPHRASE : ""),
      passphrase: PASSPHRASE || ""
    };
  }
  if (!/^(https?|srt):\/\//i.test(url)) throw new Error("sorgente non valida: serve un indirizzo http(s) o srt");
  const soloVedere = !!p.vedi;      // la porta si apre per guardare: REC viene dopo
  const quante = Object.keys(R.reg).filter((k) => R.reg[k].stato === "registra").length;
  if (quante >= MAX_REG) throw new Error("ci sono gia' " + MAX_REG + " registrazioni aperte");
  const gb = liberiGB();
  if (gb < MIN_GB) throw new Error("sul disco restano " + gb.toFixed(1) +
    " GB: troppo pochi per cominciare (ne servono almeno " + MIN_GB + ")");

  const risolta = await risolviHls(url, p.qualita);

  const r = {
    id: nuovoId("r"),
    evento: String(p.evento || "").slice(0, 64),      // recordId Airtable, se c'e'
    titolo: String(p.titolo || "").slice(0, 160) || "senza titolo",
    competizione: String(p.competizione || "").slice(0, 80),
    sorgente: String(p.sorgente || "").slice(0, 80),
    url: url,
    guarda: !!p.guarda,
    // si apre per GUARDARE: la porta e' aperta, il flusso entra, ma di
    // quello che entra si tiene solo l'ultimo quarto d'ora finche' non
    // premi REC. La connessione e' la stessa: REC non riattacca niente.
    vedi: soloVedere && !p.guarda,
    tenuti: [],
    ascolto: ascolto,
    urlLetto: risolta.url !== url ? risolta.url : "",
    rendition: risolta.scelta ? (risolta.scelta.ris || "?") + " · " +
               Math.round(risolta.scelta.banda / 1000) + " kbps" : "",
    varianti: risolta.varianti || [],
    stato: "registra",
    avviata: Date.now(),
    finita: 0,
    durata: 0,
    kickoff: {},                                       // 1 e 2: secondi sulla registrazione
    marker: [],
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    errore: ""
  };
  R.reg[r.id] = r;
  avviaProcesso(r);
  scrivi(); annuncia(0, "clip");
  return { ok: true, id: r.id, reg: pubblica(r) };
}

function clipFerma(p) {
  const r = R.reg[p.id];
  if (!r) throw new Error("registrazione sconosciuta");
  // se si stava registrando, il tratto si chiude qui: chiudere la porta
  // non deve far perdere il pezzo che stavi tenendo
  if (r.tieniDa !== undefined) { try { recSpegni(r); } catch (e) {} }
  const pr = PROC.get(r.id);
  r.stato = "ferma";            // messo PRIMA di uccidere: cosi' il riaggancio non riparte
  if (pr) { try { pr.kill("SIGINT"); } catch (e) {} }   // SIGINT: chiude la playlist per bene
  else if (vivo(r.pid, r.id)) {
    // adottato dopo un riavvio del ponte: non e' piu' un figlio, ma il
    // numero di processo basta per chiudergli la playlist come si deve
    try { process.kill(r.pid, "SIGINT"); } catch (e) {}
    setTimeout(() => {
      r.finita = Date.now(); r.durata = durataRegistrata(r.id); scrivi(); annuncia(0, "clip");
    }, 1500);
  } else { r.finita = r.finita || Date.now(); r.durata = durataRegistrata(r.id); }
  // Un'anteprima non e' un documento: quando si chiude, sparisce. Lasciarla
  // in elenco vorrebbe dire riempire la lista di righe da zero secondi che
  // qualcuno dovra' cancellare a mano.
  if (r.guarda) {
    const via = r.id;
    setTimeout(() => {
      try { fs.rmSync(cartellaReg(via), { recursive: true, force: true }); } catch (e) {}
      delete R.reg[via];
      scrivi(); annuncia(0, "clip");
    }, 2500);
    return { ok: true, chiusa: true };
  }
  scrivi(); annuncia(0, "clip");
  return { ok: true, reg: pubblica(r) };
}

function clipRinomina(p) {
  const r = R.reg[p.id || p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  if (p.titolo) r.titolo = String(p.titolo).slice(0, 160);
  if (p.evento !== undefined) r.evento = String(p.evento || "").slice(0, 64);
  if (p.competizione !== undefined) r.competizione = String(p.competizione || "").slice(0, 80);
  scrivi(); annuncia(0, "clip");
  return { ok: true, reg: pubblica(r) };
}

function clipKickoff(p) {
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  const tempo = String(p.tempo || "1") === "2" ? "2" : "1";
  if (p.secondi === null || p.secondi === "") delete r.kickoff[tempo];
  // Puo' essere NEGATIVO: si comincia a registrare a partita gia' iniziata
  // piu' spesso di quanto si creda, e il fischio resta il riferimento.
  else r.kickoff[tempo] = num(p.secondi, -MAX_SECONDI, MAX_SECONDI, 0);
  scrivi(); annuncia(0, "clip");
  return { ok: true, kickoff: r.kickoff };
}

function clipMarker(p) {
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  if (p.togli) {
    r.marker = (r.marker || []).filter((m) => m.id !== p.togli);
  } else {
    const m = {
      id: nuovoId("m"),
      secondi: num(p.secondi, 0, MAX_SECONDI, 0),
      testo: String(p.testo || "").slice(0, 200),
      tipo: String(p.tipoAzione || "").slice(0, 40),
    inSequenza: !!p.inSequenza,
      fonte: String(p.fonte || "mano").slice(0, 20),
      chi: String(p.__chi || p.chi || "").slice(0, 40),
      quando: Date.now()
    };
    r.marker = (r.marker || []).concat([m]).sort((a, b) => a.secondi - b.secondi);
  }
  scrivi(); annuncia(0, "clip");
  return { ok: true, marker: r.marker };
}

// Attenzione: il tipo di AZIONE arriva come "tipoAzione". "tipo" e' gia'
// occupato: e' il campo con cui il ponte smista le richieste.
// ── IL BOATO ──────────────────────────────────────────────────────
//  Dove non ci sono appunti, il pubblico sa lo stesso quando succede
//  qualcosa. Un gol, un rigore, un'espulsione: lo stadio alza la voce e la
//  alza in un secondo. Si misura il volume secondo per secondo e si tengono
//  i picchi: non dicono CHE COSA e' successo, dicono DOVE guardare — che per
//  quattromila partite senza una riga scritta e' gia' tutto.
function volumeAlSecondo(via) {
  return new Promise((ok) => {
    execFile(FFMPEG, ["-hide_banner", "-nostdin", "-i", via, "-vn",
                      "-af", "aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1," +
                             "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
                      "-f", "null", "-"],
      { timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }, (e, so, se) => {
        if (e) return ok([]);
        const v = [];
        String(so || "").replace(/RMS_level=(-?[0-9.]+|-inf)/g, (m, x) => { v.push(x === "-inf" ? -90 : parseFloat(x)); return m; });
        ok(v);
      });
  });
}
// I picchi: quanto sopra il solito, e non due nello stesso momento. Poi si
// tengono solo i piu' forti: in una partita i momenti in cui si alza la voce
// sono decine, e una lista di decine non aiuta nessuno. Quindici sono una
// lista che si guarda.
//
// Nota onesta: nel CLEANFEED la telecronaca c'e', quindi il picco e' il
// momento in cui alzano la voce — pubblico e telecronista insieme. Va bene
// lo stesso: e' comunque il segnale "guarda qui".
function picchiDiVolume(v, da, quantiDb, distanza, quanti) {
  if (v.length < 60) return [];
  const ordinati = v.slice().sort((a, b) => a - b);
  const solito = ordinati[Math.floor(ordinati.length / 2)];
  const soglia = solito + (quantiDb || 8);
  const lontano = distanza || 60;
  const fuori = [];
  for (let i = 2; i < v.length - 2; i++) {
    if (v[i] < soglia) continue;
    if (v[i] < v[i - 1] || v[i] < v[i + 1]) continue;          // il colmo, non la salita
    if (fuori.length && i - fuori[fuori.length - 1].i < lontano) {
      if (v[i] > v[fuori[fuori.length - 1].i]) fuori[fuori.length - 1] = { i: i, db: v[i] };
      continue;
    }
    fuori.push({ i: i, db: v[i] });
  }
  return fuori
    .sort((a, b) => b.db - a.db).slice(0, quanti || 15)
    .sort((a, b) => a.i - b.i)
    .map((x) => ({ secondi: Math.round((da || 0) + x.i), forza: Math.round((x.db - solito) * 10) / 10 }));
}
// Il boato diventa un segno sulla partita, come quelli fatti a mano.
async function cercaBoati(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const dir = cartellaReg(r.id);
  const wav = path.join(dir, "voce.wav");
  let via = null, da = 0;
  // se l'audio e' gia' in casa (trascrizione) si usa quello: costa zero
  try { const w = JSON.parse(fs.readFileSync(wav + ".json", "utf8")); fs.statSync(wav); via = wav; da = w.da || 0; }
  catch (e) { via = sorgenteAudio(r); }
  if (!via) throw new Error("di questa registrazione non c'e' audio raggiungibile");
  if (/^https?:/i.test(via) && !p.anchePagando) {
    throw new Error("l'audio di questa partita e' su S3: ascoltarlo tutto vuol dire scaricarla (7 GB)");
  }
  const v = await volumeAlSecondo(via);
  if (!v.length) throw new Error("non sono riuscito a misurare il volume");
  const picchi = picchiDiVolume(v, da, num(p.db, 1, 30, 8), num(p.distanza, 5, 600, 60), num(p.quanti, 1, 60, 15));
  r.marker = (r.marker || []).filter((m) => m.tipo !== "boato");
  picchi.forEach((x) => r.marker.push({
    id: nuovoId("m"), secondi: x.secondi, tipo: "boato",
    testo: "Boato dello stadio (+" + x.forza + " dB)", fonte: "boato", quando: Date.now()
  }));
  r.marker.sort((a, b) => a.secondi - b.secondi);
  scrivi(); annuncia(0, "clip");
  return { ok: true, secondiAscoltati: v.length, boati: picchi.length, picchi: picchi.slice(0, 40) };
}


// ══════════════════════════════════════════════════════════════════════
//  IL LAVORO APPARECCHIATO
// ══════════════════════════════════════════════════════════════════════
//
//  Di una partita d'archivio sappiamo gia' molto: i gol di ESPN, le azioni
//  scritte dalla redazione con il loro voto, quello che ha detto il
//  telecronista, i boati dello stadio. Aprirla e trovarsi davanti un foglio
//  bianco vuol dire rifare a mano un lavoro gia' fatto. Quando si apre, il
//  MAM mette da parte quello che ha — una sequenza per fonte, gia' in ordine
//  e gia' tagliata — e chi monta parte da li' invece che da zero.
// QUANTO PRENDERE ATTORNO A UN'AZIONE.
//  Il minuto scritto negli appunti — e spesso anche quello di ESPN — cade
//  sul REPLAY, non sull'azione dal vivo: chi guarda annota mentre rivede.
//  Trenta secondi prima e trenta dopo prendono tutte e due, e quello che
//  esce e' un grezzo da rifinire invece di un pezzo che comincia dopo.
//  Quanto larghe, l'ha detto la partita e non il pollice: su Genoa-Como i
//  tre gol guardati stanno fra 23 secondi PRIMA e 9 secondi DOPO il minuto
//  scritto, e il replay finisce (torna il cronometro in sovrimpressione)
//  fra 60 e 85 secondi dopo. Da li' le due misure.
const APP_PRE = 30, APP_POST = 45;      // un'azione qualsiasi: c'e' aria per il replay corto
const GOL_PRE = 35, GOL_POST = 80;      // un gol il replay ce l'ha sempre, e lungo
const AZIONE_PRE = 12;          // quanta rincorsa prima della palla in rete
const HL_STRETTO_PRE = 8, HL_STRETTO_POST = 12;   // quando bisogna stare nei minuti
// Cinque minuti di GIOCO. Apertura e calcio d'inizio si aggiungono, non si
// tolgono: prima si mangiavano due minuti di azioni, e il montato perdeva
// meta' delle cose per far spazio alla presentazione.
const HL_DURATA = 300;                  // il tempo delle azioni, la testa e' in piu'
const INTRO_DURATA = 90;                // dal cambio cartello: un minuto e mezzo, che la frase
                                        //   di apertura finisce dopo il minuto
// Il calcio d'inizio: dieci secondi prima e dieci dopo. Il primo fotogramma
// dev'essere la squadra schierata e pronta, non il campo vuoto: venti
// secondi prima si e' ancora nei saluti.
const INIZIO_PRE = 10, INIZIO_POST = 10;

function pezzoDa(dentro, fuori, titolo, tipo, minuto, fonte, peso) {
  return { id: nuovoId("p"), dentro: Math.max(0, Math.round(dentro * 10) / 10),
           fuori: Math.round(fuori * 10) / 10, base: Math.max(0, Math.round(dentro * 10) / 10),
           titolo: String(titolo || "").slice(0, 160), tipo: tipo || "", minuto: minuto || "",
           fonte: fonte || "auto", peso: peso || 1 };
}
// due cose allo stesso momento sono la stessa cosa
// ── CHE COSA E' SUCCESSO, IN UNA PAROLA ───────────────────────────────
//  Le fonti scrivono in tre lingue diverse: la redazione "gran parata di
//  Butez", ESPN "Ammonizione", il Gamecast "Yellow Card". Per poter dire
//  "dammi solo le ammonizioni" serve una parola sola, uguale per tutti, e
//  la si ricava dal testo — non da chi l'ha scritto.
const ETICHETTE = [
  ["annullato", /annullat|disallow/i],
  ["gol", /\bgol\b|\bgoal\b|\brete\b|autogol|segna/i],
  ["rigore", /rigore|penalty|penal/i],
  ["espulsione", /espuls|cartellino rosso|red card/i],
  ["ammonizione", /ammoni|cartellino giallo|yellow card|giallo a /i],
  ["var", /\bvar\b|on.field review|check del/i],
  ["palo", /\bpalo\b|traversa|montante/i],
  ["parata", /parat|respinge|salva|save\b/i],
  ["punizione", /punizion|free.?kick/i],
  ["angolo", /angolo|corner/i],
  ["occasione", /occasion|tiro|conclusion|chance|colpo di testa/i],
  ["fallo", /\bfallo\b|foul/i],
  ["cambio", /sostituzion|cambio|substitution/i],
  ["inizio", /fischio|inizio|fine (primo|secondo) tempo|kick.?off|half.?time/i]
];
function etichettaAzione(tipo, titolo) {
  const t = String(tipo || "") + " " + String(titolo || "");
  for (const [nome, forma] of ETICHETTE) if (forma.test(t)) return nome;
  return "azione";
}

// ── QUANTO CI SI PUO' FIDARE DEL SECONDO ──────────────────────────────
//  Non tutte le fonti portano allo stesso fotogramma. Il tabellone che
//  cambia e' il secondo esatto. ESPN da' il minuto di gioco, e con il
//  cronometro letto quel minuto diventa mezzo minuto di finestra. La
//  redazione scrive DOPO aver visto, e il suo minuto cade sul replay, non
//  sull'azione. Quindi quando due righe raccontano la stessa cosa: l'ora
//  la mette chi ce l'ha piu' precisa, il testo lo mette chi dice di piu'.
function precisioneDi(x) {
  if (x.tabellone) return 4;
  if (x.certezza === "cronometro") return 3;
  if (x.fonte === "espn") return 2;
  if (x.fonte === "appunti") return 1;
  return 0;
}
function quantoDice(x) {
  return (String(x.titolo || "").length) + (x.fonte === "appunti" ? 40 : 0) +
         (x.dettaglio ? 20 : 0) + (x.rating ? 10 : 0);
}
// due righe sulla stessa cosa diventano una: l'ora della piu' precisa, il
// testo della piu' ricca, e tutte e due le firme
function fondiDue(a, b) {
  const ora = precisioneDi(a) >= precisioneDi(b) ? a : b;
  const dice = quantoDice(a) >= quantoDice(b) ? a : b;
  const fuso = Object.assign({}, dice);
  fuso.t = ora.t !== undefined ? ora.t : ora.dentro;
  fuso.dentro = ora.dentro; fuso.fuori = ora.fuori; fuso.base = ora.dentro;
  fuso.tabellone = a.tabellone || b.tabellone || "";
  fuso.minuto = a.minuto || b.minuto || "";
  fuso.rating = Math.max(a.rating || 0, b.rating || 0);
  fuso.peso = Math.max(a.peso || 1, b.peso || 1);
  const firme = []; [a, b].forEach((x) => (x.fonti || [x.fonte]).forEach((f) => { if (f && firme.indexOf(f) < 0) firme.push(f); }));
  fuso.fonti = firme;
  fuso.fonte = dice.fonte;
  return fuso;
}

function togliDoppioni(pezzi, vicino) {
  const fuori = [];
  pezzi.sort((a, b) => a.dentro - b.dentro).forEach((x) => {
    const prima = fuori[fuori.length - 1];
    if (prima && Math.abs(x.dentro - prima.dentro) < (vicino || 20)) {
      // LA STESSA COSA RACCONTATA DA DUE. Prima se ne buttava una — e con
      // lei il minuto piu' preciso, oppure il nome del giocatore. Adesso si
      // fondono: l'ora di chi ce l'ha esatta, il testo di chi dice di piu'.
      // Ma solo se parlano davvero della stessa cosa: un gol e un'
      // ammonizione a venti secondi restano due righe.
      const ea = etichettaAzione(prima.tipo, prima.titolo);
      const eb = etichettaAzione(x.tipo, x.titolo);
      if (ea === eb || ea === "azione" || eb === "azione") {
        fuori[fuori.length - 1] = fondiDue(prima, x);
        return;
      }
    }
    fuori.push(x);
  });
  return fuori;
}
// I GOL SI CONTANO UNA VOLTA SOLA. ESPN dice il minuto esatto, la redazione
// scrive un minuto dopo perche' guarda e poi annota: due righe a sessanta
// secondi di distanza sembrano due gol e sono uno. Il nome del giocatore lo
// dice: se il cognome di ESPN sta dentro la riga della redazione, e' quello.
function uniscoIGol(pezzi, rec) {
  // Le parole che non sono un cognome: il verbo, il punteggio, le squadre.
  // Senza questa lista due gol della stessa squadra a due minuti di distanza
  // si univano perche' condividevano la parola "BOCA".
  const NIENTE = " gol rete goal reti autogol rigore rigori doppietta tris poker "
               + " primo secondo terzo quarto quinto minuto tempo palo ";
  const cognomi = (t) => senzaAccenti(String(t || ""))
    .split(/[^a-z0-9']+/i)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && NIENTE.indexOf(" " + w + " ") < 0);
  const quando = (x) => (x.t !== undefined ? x.t : x.dentro + GOL_PRE);
  const fuori = [];
  pezzi.slice().sort((a, b) => quando(a) - quando(b)).forEach((x) => {
    const gia = fuori.find((y) => {
      const d = Math.abs(quando(y) - quando(x));
      if (d > 190) return false;
      if (d < 25) return true;                                           // stesso istante
      const a = cognomi(y.titolo), b = cognomi(x.titolo);
      return a.some((n) => b.indexOf(n) >= 0);                           // stesso giocatore
    });
    if (!gia) { fuori.push(x); return; }
    // Vince la riga che racconta di piu', ma il momento buono e' quello di
    // ESPN, che il minuto non lo sbaglia. E la finestra si RIFA' sempre dal
    // momento scelto: se no un pezzo unito si allungava a ogni passaggio.
    const t = gia.fonte === "espn" ? quando(gia) : quando(x);
    if ((x.titolo || "").length > (gia.titolo || "").length) Object.assign(gia, x);
    const w = finestraGol(t, rec);
    gia.t = t; gia.dentro = w.dentro; gia.fuori = w.fuori; gia.replay = w.replay;
    if (w.rete) gia.gol = w.rete;
    gia.base = gia.dentro;
  });
  return fuori;
}

// Tutto quello che sappiamo di questa partita, con il secondo nel file.
// Un gol non e' un'azione qualsiasi: la regia lo rivede, e a volte due
// volte. Il pezzo si allunga in coda, non in testa, perche' davanti basta
// l'azione e dietro ci deve stare tutto il replay.
// La finestra di un gol, da un'unica parte: cosi' vale uguale quando il
// pezzo nasce e quando due pezzi si uniscono. Se la fine del replay e' gia'
// stata letta una volta, quella comanda; se no, le maniglie generose.
// La finestra di un gol. Le due estremita' le sa l'inquadratura, quando
// e' stata letta: dove la palla e' entrata (a.gol) e dove il gioco e'
// ripartito (a.replay). Se non e' stata letta, restano le maniglie a
// occhio — che sul minuto scritto tardi aprono a gol gia' fatto.
// Quello che si e' letto una volta e' segnato al secondo dell'appunto. Ma
// l'appunto si puo' spostare — basta che cambi il ritardo misurato sulla
// partita — e allora la chiave esatta non si trova piu' e il pezzo torna
// alle maniglie a occhio. Quindi si cerca la chiave PIU' VICINA: entro
// venticinque secondi e' sempre lo stesso gol.
function vicinoNella(mappa, t) {
  if (!mappa) return 0;
  const k = String(Math.round(t));
  if (mappa[k] !== undefined) return mappa[k];
  let meglio = 0, quanto = 26;
  Object.keys(mappa).forEach((x) => {
    const d = Math.abs(+x - t);
    if (d < quanto) { quanto = d; meglio = mappa[x]; }
  });
  return meglio;
}
function finestraGol(t, rec) {
  const a = rec && ARCHIVIO[rec];
  const noto = a && vicinoNella(a.replay, t);
  const rete = a && vicinoNella(a.gol, t);
  const dentro = rete ? Math.max(0, Math.min(t - GOL_PRE, rete - AZIONE_PRE)) : Math.max(0, t - GOL_PRE);
  return { dentro: dentro,
           fuori: noto ? Math.min(dentro + 200, noto + 3) : t + GOL_POST,
           replay: !!noto, rete: rete || 0 };
}
function allargaPerIlReplay(p, rec) {
  const q = Object.assign({}, p);
  const t = p.t !== undefined ? p.t : p.dentro + APP_PRE;
  const w = finestraGol(t, rec);
  q.dentro = w.dentro; q.fuori = w.fuori; if (w.replay) q.replay = true;
  if (w.rete) q.gol = w.rete;
  return q;
}

function quelloCheSappiamo(r) {
  const rec = r.evento || (r.arch && r.arch.rec) || "";
  const pezzo = (r.arch && r.arch.pezzo) || 0;
  // Quando una partita e' spezzata in piu' file, gli appunti possono cadere
  // tutti in un file diverso da quello aperto: succede sulle partite vecchie
  // di Copa America, tredici pezzi fra FEED, TAGLI e MATERIALE. Prima
  // restava tutto vuoto senza dire perche'; adesso si segna dove sono
  // finiti, e chi apre lo legge.
  const altrove = {};
  // ...e quando la partita e' aperta intera non c'e' nessun altrove: il
  // pezzo dove cade l'azione sta dentro questa stessa registrazione, e il
  // suo secondo si sposta in avanti di quanto quel pezzo entra nella
  // linea del tempo. Il minuto 78 finiva "in un altro pezzo del
  // materiale"; adesso finisce al minuto 78.
  const dentroLaPartita = pezziArch(r);
  const intera = dentroLaPartita.length > 1;
  const dove = (s, d) => {
    const x = secondoNelFile(rec, { s: s, d: d });
    if (!x) return null;
    if (intera) {
      const q = dentroLaPartita[x.pezzo] || dentroLaPartita[dentroLaPartita.length - 1];
      return (q.da || 0) + x.secondi;
    }
    if (x.pezzo !== pezzo) { altrove[x.pezzo] = (altrove[x.pezzo] || 0) + 1; return null; }
    return x.secondi;
  };
  const a = APPUNTI[rec], e = ESPN[rec];
  const azioni = [], gol = [], voce = [], boati = [];
  // IL TABELLONE PRIMA DI TUTTI. Il minuto scritto e' una stima, il minuto
  // di ESPN e' un minuto intero; il risultato che cambia e' un fatto, ed e'
  // al secondo. Quando c'e', le altre fonti gli si appoggiano.
  const tab = (ARCHIVIO[rec] || {}).tabellone;
  const golTab = [];
  if (tab && tab.punti && tab.punti.length) {
    tab.punti.forEach((x) => {
      const d = doveCade(ARCHIVIO[rec], Math.round(x.t - RITARDO_TABELLONE));
      if (!d) return;
      const q = dentroLaPartita.length > 1
        ? (dentroLaPartita[d.pezzo] || dentroLaPartita[dentroLaPartita.length - 1] || { da: 0 })
        : { da: 0 };
      const t = (q.da || 0) + d.secondi;
      if (dentroLaPartita.length <= 1 && d.pezzo !== pezzo) return;
      const p = pezzoDa(t - GOL_PRE, t + GOL_POST, "Gol " + x.dopo, "gol",
                        "", "tabellone", 3);
      p.t = t; p.tabellone = x.dopo;
      golTab.push(p);
    });
  }
  if (a) {
    const rit = ritardoPartita(rec);
    (a.righe || []).forEach((x) => {
      const t = dove(x.s, Math.max(0, (x.d || 0) - rit));
      if (t === null) return;
      const p = pezzoDa(t - APP_PRE, t + APP_POST, x.x, x.t, x.m, "appunti", pesoAzione(x.t, x.hl, x.g));
      p.rating = x.g || 0; p.t = t;
      azioni.push(p);
      if (/gol|rete/i.test(x.t || "") || x.g) gol.push(allargaPerIlReplay(p, rec));
    });
  }
  if (e && e.eventi) {
    e.eventi.forEach((x) => {
      const d = (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + x.stopp * 60;
      const t = dove(x.periodo, Math.max(0, d));
      if (t === null) return;
      const ita = tipoItaliano(x.tipo);
      if (/sostituzione/i.test(ita)) return;                  // un cambio non e' un pezzo
      const p = pezzoDa(t - APP_PRE, t + APP_POST, [ita, x.giocatore].filter(Boolean).join(" · "), ita, x.min + "'", "espn", pesoAzione(ita, false, 0));
      p.t = t;
      azioni.push(p);
      if (/gol|rigore|autogol/i.test(ita) && !/annullato/i.test(ita)) gol.push(allargaPerIlReplay(p, rec));
    });
  }
  (PARLATO[r.id] ? PARLATO[r.id].pezzi : []).forEach((t) => {
    if (!/\bgol\b|\brete\b|che gol|goool/i.test(t.x || "")) return;   // solo i momenti che la voce chiama
    voce.push(pezzoDa(t.a - 12, (t.b || t.a + 10) + 18, "“" + String(t.x).slice(0, 90) + "”", "Telecronaca", "", "voce", 2));
  });
  (r.marker || []).filter((m) => m.fonte === "boato").forEach((m) => {
    boati.push(pezzoDa(m.secondi - 20, m.secondi + 25, m.testo || "Boato", "Boato", "", "boato", 2));
  });
  // la voce dice "gol" spesso, anche per un gol di ieri o annullato: si
  // tengono i momenti distanti fra loro, al massimo quindici
  const voceScelta = togliDoppioni(voce, 60).slice(0, 15);
  // ── GAMECAST: l'aiuto, non la guida ────────────────────────────────
  //  Gli appunti del giornalista comandano: sono l'unica fonte che sa
  //  perche' un'azione conta. ESPN e Gamecast servono a due cose — coprire
  //  le partite dove nessuno ha scritto niente, e dare un secondo aggancio
  //  dove gli appunti ci sono ma il minuto balla. Quindi una riga Gamecast
  //  entra SOLO se in quel minuto non c'e' gia' qualcosa di piu' autorevole.
  if (e && e.gamecast && e.gamecast.length) {
    e.gamecast.forEach((x) => {
      const d = (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + x.stopp * 60;
      const t = dove(x.periodo, Math.max(0, d));
      if (t === null) return;
      if (azioni.some((a2) => Math.abs((a2.t !== undefined ? a2.t : a2.dentro) - t) < 50)) return;
      const p = pezzoDa(t - APP_PRE, t + APP_POST,
                        [x.tipo, x.giocatore].filter(Boolean).join(" · ") + (x.giocatore ? "" : " · " + x.testo.slice(0, 60)),
                        x.tipo, x.min + "'", "gamecast", x.peso);
      p.t = t; p.dettaglio = x.testo;
      azioni.push(p);
    });
  }
  // ── IL TABELLONE METTE D'ACCORDO TUTTI ─────────────────────────────
  //  Il risultato che cambia dice il secondo; ESPN e gli appunti dicono il
  //  nome di chi ha segnato. Non sono due gol, e' lo stesso gol visto da
  //  due parti: si tiene il secondo del tabellone e il nome dell'altro.
  //  Un gol che il tabellone vede e nessuno racconta entra lo stesso — e'
  //  la meta' dell'archivio, le partite di cui non sappiamo niente.
  golTab.forEach((g) => {
    // tutte le righe che raccontano QUEL gol, non solo la piu' vicina:
    // appunti ed ESPN lo dicono tutti e due, e se se ne sposta una sola
    // restano due gol a quaranta secondi l'uno dall'altro
    const vicine = azioni.filter((x) => /gol|rete|rigore/i.test(x.tipo || "") || /gol|rete/i.test(x.titolo || ""))
      .filter((x) => Math.abs((x.t !== undefined ? x.t : x.dentro) - g.t) < 150);
    if (vicine.length) {
      vicine.forEach((v2) => {
        v2.spostato = Math.round((v2.t !== undefined ? v2.t : v2.dentro) - g.t);
        v2.t = g.t;
        v2.dentro = Math.max(0, g.t - GOL_PRE);
        v2.fuori = g.t + GOL_POST;
        v2.base = v2.dentro;
        v2.tabellone = g.tabellone;
      });
      return;
    }
    azioni.push(g);
    gol.push(allargaPerIlReplay(g, rec));
  });
  // con maniglie larghe due azioni vicine si sovrappongono: si sta piu' larghi
  // anche nel togliere i doppioni
  return { azioni: togliDoppioni(azioni, 45), gol: uniscoIGol(gol, rec), voce: voceScelta,
           boati: boati, altrove: altrove, stelle: (a && a.stelle) || 0 };
}

// ── IL TABELLINO ──────────────────────────────────────────────────────
//
//  Finora quello che sappiamo di una partita — appunti, ESPN, Gamecast —
//  veniva fuso, ripulito dai doppioni e poi COLLASSATO subito in sequenze,
//  senza che nessuno lo vedesse. E chi decideva cosa entrava negli
//  highlights era una tabella di parole chiave: "gol" vale 4, "parata" 3.
//  Il criterio buono — il voto della redazione — esiste sul 5,9% delle
//  righe, e la marcatura * sullo 0,5%: su tutto il resto la macchina
//  indovinava.
//
//  Qui la lista si ferma un passo prima e si fa vedere. Si spunta quello
//  che serve e diventa una sequenza. Nessuno deve indovinare piu' niente,
//  e qualunque fonte aggiungeremo domani sara' altre righe nella stessa
//  lista invece che un altro pezzo di logica.
function tabellino(r) {
  const rec = r.evento || (r.arch && r.arch.rec) || "";
  const sap = quelloCheSappiamo(r);
  const a = rec && ARCHIVIO[rec];
  // dove sappiamo che cade il taglio, e quanto ci crediamo:
  //   cronometro -> il numero in sovrimpressione l'abbiamo letto: e' esatto
  //   minuto     -> sappiamo solo il minuto scritto: e' una stima
  const comeLoSappiamo = (t, x) => {
    if (x && x.tabellone) return "tabellone";
    if (a && vicinoNella(a.gol, t)) return "cronometro";
    if (a && vicinoNella(a.replay, t)) return "cronometro";
    return "minuto";
  };
  const golVicino = (t) => sap.gol.find((g) => {
    const tg = g.t !== undefined ? g.t : g.dentro + GOL_PRE;
    return Math.abs(tg - t) < 25;
  });
  const righe = sap.azioni.map((x) => {
    const t = x.t !== undefined ? x.t : x.dentro + APP_PRE;
    // se quell'azione e' un gol, la finestra buona e' quella larga del gol,
    // non le maniglie corte dell'azione: dentro c'e' anche l'esultanza
    const g = golVicino(t);
    const dentro = g ? g.dentro : x.dentro;
    const fuori = g ? g.fuori : x.fuori;
    return {
      t: Math.round(t * 10) / 10,
      dentro: Math.round(dentro * 10) / 10,
      fuori: Math.round(fuori * 10) / 10,
      titolo: x.titolo || "", tipo: x.tipo || "", minuto: x.minuto || "",
      fonte: x.fonte || "", peso: x.peso || 1, rating: x.rating || 0,
      squadra: x.squadra || "", giocatore: x.giocatore || "",
      dettaglio: String(x.dettaglio || "").slice(0, 200),
      gol: !!g || !!x.tabellone, certezza: comeLoSappiamo(t, x),
      tabellone: x.tabellone || "",
      tag: etichettaAzione(x.tipo, x.titolo),
      fonti: x.fonti && x.fonti.length ? x.fonti : [x.fonte || ""]
    };
  }).sort((m, n) => m.t - n.t);
  const conta = {};
  righe.forEach((x) => { conta[x.fonte] = (conta[x.fonte] || 0) + 1; });
  return { ok: true, righe: righe, quante: righe.length, fonti: conta,
           appunti: !!(rec && APPUNTI[rec]), espn: !!(rec && ESPN[rec]),
           altrove: sap.altrove || {} };
}

// Le righe spuntate diventano UNA SEQUENZA NUOVA. Non si aggiungono a
// quella aperta: chi sceglie dal tabellino sta cominciando un montaggio,
// non correggendone uno.
function tabellinoMonta(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const scelti = Array.isArray(p.righe) ? p.righe.map(Number).filter((x) => isFinite(x)) : [];
  if (!scelti.length) throw new Error("non hai scelto nessuna riga");
  // si rifa' il tabellino e si prendono le righe per il loro secondo: gli
  // identificativi cambiano a ogni giro, il secondo no
  const t = tabellino(r);
  const prese = [];
  scelti.forEach((s) => {
    let x = t.righe.find((y) => Math.abs(y.t - s) < 1.2);
    // UN MOMENTO QUALSIASI, NON SOLO UNA RIGA DEL TABELLINO. Da quando si
    // cerca dentro la telecronaca si spunta anche una frase — "eccolo
    // Merentiel" — che non e' un'azione di nessun elenco. E' comunque un
    // secondo della partita, e in timeline ci va uguale, con le maniglie
    // di un'azione normale.
    if (!x) {
      x = { t: s, dentro: Math.max(0, s - APP_PRE), fuori: s + APP_POST,
            titolo: "", tipo: "", minuto: "", fonte: "telecronaca", gol: false };
    }
    if (x && !prese.some((z) => z.t === x.t)) prese.push(x);
  });
  if (!prese.length) throw new Error("quelle righe non si trovano piu': riapri il tabellino");
  prese.sort((m, n) => m.dentro - n.dentro);
  const q = {
    id: nuovoId("s"), reg: r.id,
    titolo: String(p.titolo || "").slice(0, 160) || ("SCELTA · " + (r.titolo || "")),
    pezzi: prese.map((x) => ({
      id: nuovoId("p"), dentro: x.dentro, fuori: x.fuori, base: x.dentro,
      titolo: x.titolo, tipo: x.tipo, minuto: x.minuto, fonte: x.fonte,
      peso: x.peso, rating: x.rating, t: x.t
    })),
    // il formato lo si sceglie mandando in timeline: la sequenza nasce gia'
    // verticale o quadrata, e si apre cosi'
    formato: FORMATI[String(p.formato || "")] ? String(p.formato) : "16:9",
    pre: APP_PRE, post: APP_POST, scarto: 0, avvisi: [], creata: Date.now(),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    banco: String(p.banco || "").slice(0, 60),
    mano: Date.now(),                       // e' una scelta di una persona
    export: null
  };
  if (p.prog) q.prog = String(p.prog);
  R.seq[q.id] = q;
  riallinea(q);
  scrivi(); annuncia(0, "clip");
  console.log("[clip] tabellino: nuova sequenza \"" + q.titolo + "\" con " + q.pezzi.length + " pezzi");
  return { ok: true, seq: q, presi: q.pezzi.length };
}

// L'APERTURA. Un montato non comincia con un tiro: comincia con la voce che
// dice dove siamo e chi gioca. Quella frase sta sempre nello stesso posto,
// poco prima del fischio, mentre le squadre sono schierate. Se la
// telecronaca e' gia' trascritta si prende la prima frase vera; se no si
// prende la finestra prima del fischio, che e' li' che parla.
function pezzoApertura(r) {
  // Il fischio VERO, quello letto dal cronometro: r.kickoff e' l'orario di
  // palinsesto meno l'inizio della registrazione, e sbaglia di minuti. Su
  // Genoa-Como diceva 327 quando il fischio e' a 461: il "calcio d'inizio"
  // cadeva sul minuto di raccoglimento.
  const via = fischioNelFile(r) || 0;
  if (!via) return null;
  // se il cambio cartello e' gia' stato trovato una volta, l'intro comincia
  // esattamente li' e non si va piu' a stima
  const rec0 = r.evento || (r.arch && r.arch.rec) || "";
  const noto = ARCHIVIO[rec0] && ARCHIVIO[rec0].cartello;
  if (noto && via - noto > 20) {
    // Novanta secondi dal cambio cartello: a sessanta la frase di apertura
    // resta a meta'. Se il fischio arriva prima, si taglia li' — quello che
    // viene dopo lo prende il pezzo del calcio d'inizio.
    const da0 = Math.max(0, noto - 3);
    const p0 = pezzoDa(da0, Math.min(da0 + INTRO_DURATA, via - INIZIO_PRE - 1),
                       "Apertura del telecronista", "Apertura", "", "apertura", 9);
    p0.vero = true;
    return p0;
  }
  const detto = PARLATO[r.id] && PARLATO[r.id].pezzi;
  if (detto && detto.length) {
    // la prima frase che dura piu' di due secondi e sta prima del fischio
    const prima = detto.filter((x) => x.a < via && (x.b - x.a) > 2 && String(x.x || "").length > 25);
    if (prima.length) {
      const q = prima[Math.max(0, prima.length - 3)];
      const dentro = Math.max(0, q.a - 2);
      return pezzoDa(dentro, Math.min(via - 2, dentro + 40), "Apertura · “" + String(q.x).slice(0, 70) + "”",
                     "Apertura", "", "apertura", 9);
    }
  }
  // Ripiego, quando il cartello non si e' trovato: i secondi prima del
  // fischio, ma senza mai arrivare addosso al pezzo del calcio d'inizio —
  // se no i due si sovrappongono e lo stesso fotogramma esce due volte.
  if (via < 25) return null;
  const finePi = via - INIZIO_PRE - 1;
  const daPi = Math.max(0, finePi - 45);
  if (finePi - daPi < 12) return null;
  return pezzoDa(daPi, finePi, "Apertura del telecronista", "Apertura", "", "apertura", 9);
}

// IL CALCIO D'INIZIO. Venti secondi prima e venti dopo il fischio: e' il
// secondo pezzo di ogni montato, quello che dice "si comincia". Il fischio
// non e' stimato, lo ha letto il cronometro.
function pezzoCalcioInizio(r) {
  const via = fischioNelFile(r) || 0;
  if (via < INIZIO_PRE + 2) return null;
  return pezzoDa(via - INIZIO_PRE, via + INIZIO_POST, "Calcio d'inizio", "Inizio", "", "inizio", 9);
}

async function preparaSequenze(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const rec = r.evento || (r.arch && r.arch.rec) || "";
  if (!rec) return { ok: true, fatte: 0, perche: "questa registrazione non e' agganciata a un evento" };
  // se ESPN non l'ha ancora vista, si guarda adesso: costa una richiesta
  if (!ESPN[rec] && p.espn !== false) { try { await espnTrova(rec); scriviEspn(); } catch (e) {} }
  const sap = quelloCheSappiamo(r);
  const gia = Object.keys(R.seq).map((k) => R.seq[k]).filter((q) => q.reg === r.id && q.auto);
  // "rifai" e' il permesso esplicito di buttare via il montaggio a mano e
  // ricominciare da quello che sappiamo. Senza, non si tocca niente.
  if (p.rifai) {
    gia.forEach((q) => { delete q.mano; delete q.rifinito; });
    const a0 = ARCHIVIO[rec];
    if (a0 && a0.cartello) { delete a0.cartello; scriviArchivio(); }   // si riguarda anche dove finisce il cartello
  }
  const fatte = [];
  // l'ordine in cui compaiono e' l'ordine in cui servono: prima i gol
  let posto = 0;
  const tenute = [];
  const crea = (nome, pezzi, nota) => {
    if (!pezzi.length) return;
    const vecchia = gia.find((q) => q.auto === nome
      || (nome.indexOf("HIGHLIGHTS") === 0 && String(q.auto).indexOf("HIGHLIGHTS") === 0));
    // se qualcuno l'ha gia' montata, e' sua: si lascia stare
    if (vecchia && vecchia.mano) { tenute.push(nome); return; }
    const q = vecchia || { id: nuovoId("s"), reg: r.id, pezzi: [], pre: APP_PRE, post: APP_POST,
                           scarto: 0, avvisi: [], creata: Date.now(), chi: "", export: null };
    q.auto = nome;
    q.titolo = nome + " · " + (r.titolo || "");
    q.nota = nota || "";
    q.pezzi = pezzi;
    // i pezzi sono nuovi: se la rifinitura non e' gia' dentro (arriva dalla
    // memoria della partita), si rifa'
    if (nome === "GOL" && !pezzi.every((x) => x.replay)) delete q.rifinito;
    // il pannello mette per prime le sequenze piu' recenti: per farle uscire
    // nell'ordine in cui servono si va all'indietro
    q.creata = Date.now() - (posto++);
    R.seq[q.id] = q;
    fatte.push({ nome: nome, pezzi: pezzi.length, id: q.id });
  };

  // L'ordine e' quello in cui si lavora: prima si guarda tutto (AZIONI),
  // poi il montato (HIGHLIGHTS), poi i gol da rifinire uno per uno.
  crea("AZIONI", sap.azioni, "tutto quello che la redazione ha segnato, in ordine, con l'aria per il replay");
  if (sap.azioni.length) {
    // qui le maniglie si stringono: dentro cinque minuti ci devono stare piu'
    // cose, e questa e' la sequenza che assomiglia gia' a un montato
    // e si stringono intorno alla PALLA IN RETE quando l'inquadratura l'ha
    // detta: intorno al minuto scritto, che ogni tanto arriva quasi un
    // minuto dopo, si finiva in mezzo all'esultanza.
    const strette = sap.azioni.map((x) => {
      const t = x.t !== undefined ? x.t : x.dentro + APP_PRE;
      const perno = x.gol || t;
      return Object.assign({}, x, {
        dentro: Math.max(0, perno - HL_STRETTO_PRE),
        fuori: perno + HL_STRETTO_POST
      });
    });
    // La testa del montato non entra in gara con le azioni: prima la voce
    // che presenta, poi il fischio d'inizio, poi il gioco. Il tempo che
    // resta se lo dividono le azioni.
    const testa = [pezzoApertura(r), pezzoCalcioInizio(r)].filter(Boolean);
    const quantoTesta = testa.reduce((n, x) => n + (x.fuori - x.dentro), 0);
    // e le azioni che cadono dentro la testa non si ripetono
    const libere = strette.filter((x) => !testa.some((t) => x.dentro < t.fuori && t.dentro < x.fuori));
    const scelti = stringiAllaDurata(libere, HL_DURATA, HL_STRETTO_PRE, HL_STRETTO_POST);
    const dentro = (scelti.pezzi || []).sort((a, b) => a.dentro - b.dentro);
    const tuttoQuanto = quantoTesta + dentro.reduce((n, x) => n + (x.fuori - x.dentro), 0);
    // ══════════════════════════════════════════════════════════════
    //  LE DUE REGOLE DELLA REDAZIONE
    // ══════════════════════════════════════════════════════════════
    //
    //  VOD — sui falli da rigore va SOLO il replay del fallo con
    //  l'ambientale: niente piu' dinamica, gesto del VAR, monitor. Ma sulle
    //  partite da cinque stelle (Rating Evento su Airtable) si tiene la
    //  sequenza completa, come si e' sempre fatto.
    //
    //  Per i social le regole sono piu' strette (un replay solo, niente gol
    //  annullati se non lo dice il giornalista, niente falli da rigore, tre
    //  secondi di ambientale in coda per la sfumata). Non nasce una
    //  sequenza a parte: il montato e' uno, e le regole si vedono sui pezzi
    //  — un gol annullato e' segnato, un fallo da rigore e' gia' il solo
    //  replay — cosi' chi monta decide con l'informazione davanti.
    const cinqueStelle = (sap.stelle || 0) >= 5;
    const eRigore = (x) => /rigor|penalty/i.test(String(x.titolo || "") + " " + String(x.dettaglio || "") + " " + String(x.tipo || ""));
    const eFalloDaRigore = (x) => eRigore(x) && /fallo|foul|atterrat|trattenut|hand ball|var/i.test(String(x.titolo || "") + " " + String(x.dettaglio || ""));
    const eAnnullato = (x) => /annullat|disallow|ruled out|offside goal/i.test(String(x.titolo || "") + " " + String(x.dettaglio || ""));
    // I gol annullati restano nel montato — buttarli via a monte sarebbe
    // decidere al posto di chi monta — ma si vedono, perche' sui social non
    // vanno a meno che non lo dica il giornalista.
    dentro.forEach((x) => { if (eAnnullato(x)) x.annullato = true; });

    // VOD: il fallo da rigore diventa il solo replay, stretto, con l'audio
    // di campo. Il replay lo sappiamo dove sta: e' il buco del cronometro.
    const perVod = dentro.map(function (x) {
      if (!eFalloDaRigore(x) || cinqueStelle) return x;
      const t = x.t !== undefined ? x.t : x.dentro + HL_STRETTO_PRE;
      const noto = (ARCHIVIO[rec] && ARCHIVIO[rec].replay) ? ARCHIVIO[rec].replay[String(Math.round(t))] : 0;
      const y = Object.assign({}, x, { soloReplay: true });
      if (noto) { y.dentro = Math.max(0, noto - 14); y.fuori = noto + 2; }
      else { y.dentro = t + 8; y.fuori = t + 26; }     // il replay arriva dopo l'azione
      y.titolo = "Replay del fallo · " + String(x.titolo || "").slice(0, 60);
      y.rigore = true;
      return y;
    });
    const quantiRigori = perVod.filter((x) => x.rigore).length;
    const quantiAnnullati = dentro.filter((x) => x.annullato).length;
    crea("HIGHLIGHTS", testa.concat(perVod),
         (testa.length ? "Apertura del telecronista, calcio d'inizio, poi le azioni che pesano di piu'. " : "")
         + (quantiRigori ? "Sui falli da rigore c'e' solo il replay con l'ambientale" +
             (cinqueStelle ? " — ma questa e' da cinque stelle, quindi resta la sequenza completa. " : ". ") : "")
         + (quantiAnnullati ? quantiAnnullati + " gol annullati sono segnati: sui social non vanno, se non lo dice il giornalista. " : "")
         + "Cinque minuti di gioco, piu' " + Math.round(quantoTesta) + " secondi di testa: "
         + Math.floor(tuttoQuanto / 60) + "′" + String(Math.round(tuttoQuanto % 60)).padStart(2, "0") + "″ in tutto. "
         + (scelti.nota ? scelti.nota : ""));
  }
  crea("GOL", sap.gol, "dai " + GOL_PRE + " secondi prima ai " + GOL_POST + " dopo: dentro c'e' l'azione, l'esultanza e il replay");

  // ── SHORTS ────────────────────────────────────────────────────────
  //  Le regole dei social sono piu' strette di quelle del VOD, e sono
  //  scritte: un replay solo per gol, niente gol annullati se non lo dice
  //  il giornalista, niente falli da rigore, niente outro. E in coda due o
  //  tre secondi di ambientale, perche' il video finisce su un'azione e la
  //  regia deve poterci sfumare sopra.
  if (sap.gol.length) {
    const dettoDalGiornalista = (x) => x.fonte === "appunti";
    const eAnnullatoS = (x) => /annullat|disallow|ruled out/i.test(String(x.titolo || "") + " " + String(x.dettaglio || ""));
    const eRigoreS = (x) => /rigor|penalty/i.test(String(x.titolo || "") + " " + String(x.tipo || "") + " " + String(x.dettaglio || ""));
    const golShorts = sap.gol
      .filter((x) => !eAnnullatoS(x) || dettoDalGiornalista(x))
      .filter((x) => !(eRigoreS(x) && /fallo|foul|atterrat|trattenut|hand ball/i.test(String(x.titolo || "") + " " + String(x.dettaglio || ""))))
      .map((x) => {
        const t = x.t !== undefined ? x.t : x.dentro + GOL_PRE;
        const y = Object.assign({}, x);
        // UN REPLAY SOLO: il pezzo finisce dove finisce il primo, non
        // l'ultimo. La differenza la sa il cronometro, che l'ha letta.
        const noto = ARCHIVIO[rec] ? vicinoNella(ARCHIVIO[rec].primoReplay, t) : 0;
        y.fuori = noto ? Math.min(x.fuori, noto + 3) : Math.min(x.fuori, t + 55);
        y.unReplay = true;
        return y;
      });
    if (golShorts.length) {
      const ult = golShorts[golShorts.length - 1];
      // l'ambientale di coda: senza, il video taglia di netto su un'azione
      golShorts[golShorts.length - 1] = Object.assign({}, ult, { fuori: ult.fuori + 3, coda: true });
      const sannoIlReplay = golShorts.filter((x) => {
        const t = x.t !== undefined ? x.t : x.dentro + GOL_PRE;
        return ARCHIVIO[rec] && vicinoNella(ARCHIVIO[rec].primoReplay, t);
      }).length;
      crea("SHORTS", golShorts,
           "Regole social: un replay per gol, niente gol annullati (se non lo dice il giornalista), " +
           "niente falli da rigore, niente outro. Tre secondi di ambientale in coda per la sfumata. " +
           (sannoIlReplay ? sannoIlReplay + " gol su " + golShorts.length + " tagliati sul primo replay letto dal cronometro."
                          : "Su questo feed il cronometro non dice dove finisce il replay: il taglio e' a 55 secondi dal gol, da rifinire a mano."));
    }
  }

  crea("TELECRONACA", sap.voce, "i momenti in cui il telecronista dice gol");
  crea("BOATI", sap.boati, "i momenti in cui lo stadio alza la voce");
  copieDiFormato(r).forEach((f) => fatte.push(f));
  scrivi(); annuncia(0, "clip");
  // i gol si rifiniscono da soli, in coda: il cronometro dira' dove finisce
  // ogni replay. Chi ha aperto la partita intanto ha gia' tutto.
  const seqGol = fatte.find((f) => f.nome === "GOL");
  if (seqGol && r.arch && p.rifinisci !== false && CODA_RIFINITURE.indexOf(seqGol.id) < 0) {
    const q = R.seq[seqGol.id];
    if (q && !q.rifinito) { CODA_RIFINITURE.push(seqGol.id); setTimeout(rifinitureInCoda, 500); }
  }
  // Se non c'e' venuto fuori niente, si dice perche': non c'e' materiale, o
  // il materiale c'e' ma sta in un altro file della stessa partita.
  let perche = "";
  if (!fatte.length) {
    const p2 = Object.keys(sap.altrove || {}).map(Number).sort((x, y) => x - y);
    if (p2.length) {
      const quanti = p2.reduce((n, k) => n + sap.altrove[k], 0);
      perche = "di questa partita sappiamo " + quanti + " azioni, ma cadono in un altro file: "
             + (p2.length === 1 ? "il pezzo " + (p2[0] + 1) : "i pezzi " + p2.map((k) => k + 1).join(", "))
             + ". Apri quel pezzo e le sequenze si apparecchiano li'.";
    } else {
      perche = "di questa partita non abbiamo ancora ne' appunti ne' fatti da ESPN";
    }
  }
  if (tenute.length) console.log("[clip] apparecchiare: lasciate com'erano " + tenute.join(", ") + " (montate a mano)");
  return { ok: true, fatte: fatte.length, sequenze: fatte, perche: perche, tenute: tenute,
           altrove: sap.altrove || {} };
}

// ── LO STESSO MONTAGGIO, IN VERTICALE ────────────────────
//  Il 9:16 non e' un'altra edizione: sono gli stessi tagli visti da una
//  finestra piu' stretta. Per questo non si ricalcolano — si copiano dalla
//  madre e si mettono in un'altra sequenza, che nasce gia' col suo formato
//  addosso. Il riquadro poi lo propone la macchina, pezzo per pezzo, e chi
//  monta lo corregge trascinando. Se qualcuno ha messo le mani su una copia,
//  quella non si tocca piu': e' sua.
const FORMATI_COPIA = ["9:16", "3:4"];
const MADRI_COPIA = ["GOL", "SHORTS", "AZIONI"];
function copieDiFormato(r, quali) {
  const fatte = [];
  const tutte = Object.keys(R.seq).map((k) => R.seq[k]).filter((q) => q.reg === r.id);
  (quali || MADRI_COPIA).forEach((nome) => {
    const madre = tutte.find((q) => q.auto === nome);
    if (!madre || !(madre.pezzi || []).length) return;
    FORMATI_COPIA.forEach((f) => {
      const eti = nome + " " + f;
      const vecchia = tutte.find((q) => q.auto === eti);
      if (vecchia && vecchia.mano) return;
      const q = vecchia || { id: nuovoId("s"), reg: r.id, pre: APP_PRE, post: APP_POST,
                             scarto: 0, avvisi: [], creata: Date.now(), chi: "", export: null };
      q.auto = eti;
      q.formato = f;
      q.titolo = eti + " \u00b7 " + (r.titolo || "");
      q.nota = "Gli stessi tagli di " + nome + ", gia' aperti in " + f + ". L'inquadratura "
             + "la propone la macchina in esportazione: si corregge trascinando il riquadro.";
      // pezzi nuovi, non gli stessi oggetti: cosi' stringere il riquadro qui
      // non tocca la madre, e viceversa. L'inquadratura non si eredita.
      q.pezzi = (madre.pezzi || []).map((x) => {
        const y = Object.assign({}, x, { id: nuovoId("p") });
        delete y.inquadra;
        return y;
      });
      q.daMadre = madre.id;
      R.seq[q.id] = q;
      if (!vecchia) fatte.push({ nome: eti, pezzi: q.pezzi.length, id: q.id });
    });
  });
  return fatte;
}

// ── GLI STACCHI DI REGIA ──────────────────────────────────────────
//  Una clip che comincia in mezzo a un'inquadratura sembra strappata; una
//  che comincia sullo stacco sembra montata. La regia gli stacchi li ha gia'
//  fatti: basta trovarli. ffmpeg confronta un fotogramma con il precedente e
//  dice dove cambia tutto. Si guarda solo qualche secondo attorno al punto —
//  quei byte li stiamo gia' scaricando per fare la clip.
function stacchiVicini(via, quando, raggio) {
  return new Promise((ok) => {
    const da = Math.max(0, quando - raggio);
    execFile(FFMPEG, ["-hide_banner", "-nostdin", "-ss", String(da), "-t", String(raggio * 2),
                      "-i", via, "-vf", "select=gt(scene\\,0.20),showinfo", "-an", "-f", "null", "-"],
      { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => {
        if (e) return ok([]);
        const fuori = [];
        String(se || "").replace(/pts_time:([0-9.]+)/g, (m, t) => { fuori.push(da + parseFloat(t)); return m; });
        ok(fuori);
      });
  });
}
// Il punto agganciato allo stacco piu' vicino, se ce n'e' uno abbastanza
// vicino da non cambiare quello che si voleva prendere.
async function agganciaStacco(r, quando, raggio) {
  try {
    // lo stacco si cerca nel pezzo dove cade il punto, al secondo suo
    const f = r.arch ? fonteAl(r, quando) : null;
    const via = f ? f.via : sorgenteAudio(r);
    const scarto = f ? quando - f.dentro : 0;
    if (!via) return { t: quando, spostato: 0 };
    // un secondo e mezzo: uno stacco piu' lontano non e' il bordo di questa
    // azione, e spostarsi fin li' vorrebbe dire prendere un'altra cosa
    const dentroRaggio = raggio || 1.5;
    const st = (await stacchiVicini(via, quando - scarto, dentroRaggio))
      .map((x) => x + scarto)
      .filter((x) => Math.abs(x - quando) <= dentroRaggio)
      .sort((a, b) => Math.abs(a - quando) - Math.abs(b - quando));
    if (!st.length) return { t: quando, spostato: 0 };
    return { t: Math.round(st[0] * 100) / 100, spostato: Math.round((st[0] - quando) * 100) / 100 };
  } catch (e) { return { t: quando, spostato: 0 }; }
}

async function clipTaglia(p) {
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  // quanti canali ha questo materiale: si scopre alla prima clip e resta
  // scritto. Serve a non ripiegare sei canali dentro due sommando i bus.
  await assicuraCanali(r);
  const dentro = num(p.dentro, 0, MAX_SECONDI, 0);
  const fuori = num(p.fuori, 0, MAX_SECONDI, 0);
  const durata = Math.round((fuori - dentro) * 100) / 100;
  if (durata < 0.5) throw new Error("il punto di uscita deve venire dopo quello di entrata");
  if (durata > MAX_CLIP) throw new Error("una clip cosi' lunga non e' una clip: al massimo " + MAX_CLIP + " secondi");
  // Il taglio si fa sui SEGMENTI, non sulla playlist. Dare il .m3u8 in pasto
  // a ffmpeg sembra la strada breve, ma una playlist che cresce e' un flusso
  // dal vivo: ffmpeg la insegue in tempo reale e una clip di 30 secondi ci
  // mette 30 secondi. I pezzi sono gia' sul disco: si prendono quelli.
  const segs = segmenti(r.id);
  // Passato l'anello i segmenti non ci sono piu': se e' stato fatto
  // l'integrale si taglia da li'. Un MP4 e' un file fermo con il suo indice:
  // ffmpeg ci salta dentro senza inseguire niente.
  if (!segs.length) return taglioDaIntegrale(r, p, dentro, fuori, durata);
  const ultimo = segs[segs.length - 1];
  const registrato = ultimo.t0 + ultimo.dur;
  if (dentro >= registrato) throw new Error("quel punto non e' ancora stato registrato");
  // Se l'uscita e' oltre l'ultimo segmento scritto si taglia fin dove si e'
  // arrivati: meglio una clip un po' corta subito che una promessa in attesa.
  const fine = Math.min(fuori, registrato);
  const scelti = segs.filter((x) => x.t0 + x.dur > dentro && x.t0 < fine);
  if (!scelti.length) throw new Error("nessun segmento copre questo tratto");
  const scarto = dentro - scelti[0].t0;
  const quanto = Math.round((fine - dentro) * 100) / 100;

  const formato = FORMATI[p.formato] ? String(p.formato) : "16:9";
  const ritaglio = FORMATI[formato].vf;
  // Lo sting (la fascia con partita e azione bruciata nei primi tre
  // secondi) esiste, ma di suo e' SPENTO: costa una ricodifica, e per
  // riconoscere una clip basta la miniatura. Si accende chiedendolo.
  const sting = p.sting === true && fontCe();
  const preciso = !!p.preciso || !!ritaglio || sting;

  const c = {
    id: nuovoId("c"),
    reg: r.id,
    sting: sting,
    evento: r.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    dentro: dentro, fuori: dentro + quanto, durata: quanto,
    troncata: fuori > registrato,
    formato: formato,
    preciso: preciso,
    tipo: String(p.tipoAzione || "").slice(0, 40),
    inSequenza: !!p.inSequenza,
    minuto: String(p.minuto || "").slice(0, 12),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    creata: Date.now(),
    stato: "lavora",
    peso: 0
  };
  R.clip[c.id] = c;
  scrivi();

  const lista = path.join(DIR, CARTELLA_CLIP, c.id + ".txt");
  fs.writeFileSync(lista, scelti.map((x) => "file '" + x.file + "'").join("\n") + "\n");

  // In COPIA non si puo' cominciare a meta' segmento: si parte dal suo inizio.
  // Allora non si sposta l'inizio, si accorcia la fine — cosi' la clip finisce
  // ESATTAMENTE sull'uscita chiesta e in testa ha qualche secondo di rincorsa,
  // che a un'azione non fa male. Prima invece durava lo scarto in piu' e
  // sfondava l'uscita.
  // Col taglio PRECISO si ricodifica, quindi l'inizio e' quello chiesto.
  let args = preciso
    ? ["-f", "concat", "-safe", "0", "-ss", String(Math.max(0, scarto)), "-i", lista, "-t", String(quanto)]
    : ["-f", "concat", "-safe", "0", "-i", lista, "-t", String(Math.round((scarto + quanto) * 100) / 100)];
  if (!preciso && scarto > 0.05) {
    c.rincorsa = Math.round(scarto * 100) / 100;      // quanto comincia prima
    c.dentro = Math.round((dentro - scarto) * 100) / 100;
  }
  const stingFiltro = sting ? filtroSting(r, c, path.join(DIR, CARTELLA_CLIP), c.id) : "";
  // la riserva: gli stessi secondi, ma ricodificati
  const panQui = piuDiUnaCoppia(r) ? panDi(quantiCanali(r), p.coppia, null) : "";
  const riserva = preciso ? null : codifica(
    ["-f", "concat", "-safe", "0", "-ss", String(Math.max(0, scarto)), "-i", lista,
     "-t", String(quanto)], true, ritaglio, stingFiltro, panQui);
  esegui(c, codifica(args, preciso, ritaglio, stingFiltro, panQui), lista, riserva);
  return { ok: true, clip: c };
}

// Stessa clip, presa dall'integrale invece che dai segmenti: cambia solo da
// dove si leggono i byte.
function taglioDaIntegrale(r, p, dentro, fuori, durata) {
  // il secondo della linea del tempo diventa il secondo dentro il file che
  // in quel momento sta suonando: con la partita intera non sono piu' la
  // stessa cosa
  const f = r.arch ? fonteAl(r, dentro) : { via: path.join(cartellaReg(r.id), "integrale.mp4"), dentro: dentro, fine: Infinity };
  const file = f.via, daQui = f.dentro;
  if (!r.arch && !fs.existsSync(file)) {
    throw new Error("di questa registrazione non c'e' piu' materiale sul disco");
  }
  // una clip non scavalca l'intervallo fra un pezzo e l'altro: quello che
  // c'e' dopo il buco e' un altro file, e li' dentro non c'e'
  if (r.arch && dentro + durata > f.fine) durata = Math.max(1, f.fine - dentro);
  const formato = FORMATI[p.formato] ? String(p.formato) : "16:9";
  const ritaglio = FORMATI[formato].vf;
  const sting = p.sting === true && fontCe();
  const preciso = !!p.preciso || !!ritaglio || sting;
  const c = {
    id: nuovoId("c"), reg: r.id, evento: r.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    dentro: dentro, fuori: fuori, durata: durata, troncata: false,
    formato: formato, preciso: preciso,
    tipo: String(p.tipoAzione || "").slice(0, 40),
    inSequenza: !!p.inSequenza,
    minuto: String(p.minuto || "").slice(0, 12),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    creata: Date.now(), stato: "lavora", peso: 0, da: "integrale"
  };
  R.clip[c.id] = c;
  scrivi();
  esegui(c, codifica(["-ss", String(daQui), "-i", file, "-t", String(durata)],
                     preciso, ritaglio,
                     sting ? filtroSting(r, c, path.join(DIR, CARTELLA_CLIP), c.id) : "",
                     piuDiUnaCoppia(r) ? panDi(quantiCanali(r), p.coppia, null) : ""), null);
  return { ok: true, clip: c };
}

// Come si scrive la clip: ricopiando i byte, o ricodificando quando il taglio
// ── I CANALI DELLO STUDIO ─────────────────────────────────────────────
//
//  vMix registra lo studio con piu' bus sulla stessa pista: Football Show
//  esce a sei canali dichiarati 5.1, ma non e' un 5.1 — e' il programma
//  sui primi due, un secondo bus sul terzo e quarto, e il quinto e sesto
//  vuoti. Chiunque legga quel file "in stereo" — il browser, ffmpeg, un
//  lettore qualsiasi — piega il centro e i surround dentro le due uscite,
//  e i due bus si sommano: le stesse voci due volte, per due strade
//  diverse. Non e' un riverbero dello studio, e' un'eco che nasce qui.
//
//  La cura non e' un filtro: e' non sommarli. Si prende UNA coppia — la
//  prima, che e' il programma — e si lascia stare il resto; chi vuole
//  l'altra la sceglie. Vale per la clip, per il mix, per l'onda e per
//  l'esportazione, se no una delle quattro riporta l'eco.
function panDi(canali, coppia, canale) {
  const n = Math.max(1, +canali || 2);
  if (n <= 1) return "pan=stereo|c0=c0|c1=c0";
  const k = Math.max(0, Math.min(Math.floor((n - 1) / 2), parseInt(coppia || 0, 10) || 0));
  const L = Math.min(n - 1, 2 * k), R = Math.min(n - 1, 2 * k + 1);
  if (canale === "L") return "pan=stereo|c0=c" + L + "|c1=c" + L;
  if (canale === "R") return "pan=stereo|c0=c" + R + "|c1=c" + R;
  return "pan=stereo|c0=c" + L + "|c1=c" + R;
}
function panMono(canali, coppia) {
  const n = Math.max(1, +canali || 2);
  const k = Math.max(0, Math.min(Math.floor((n - 1) / 2), parseInt(coppia || 0, 10) || 0));
  return "pan=mono|c0=c" + Math.min(n - 1, 2 * k);
}
function quantiCanali(r) { return Math.max(1, +((r && r.canali) || 2)); }
// si chiede una volta sola, e resta scritto sulla registrazione
async function assicuraCanali(r) {
  if (!r || r.canali) return quantiCanali(r);
  let via = null;
  try { via = r.arch ? viaArchivio(r, 0) : sorgenteAudio(r, 0); } catch (e) { via = null; }
  if (!via) return 2;
  try {
    const n = await new Promise((ok, no) => {
      execFile("ffprobe", ["-v", "error", "-select_streams", "a:0",
                           "-show_entries", "stream=channels", "-of", "default=nw=1:nk=1", via],
               { timeout: 60000 }, (e, out) => e ? no(e) : ok(parseInt(String(out).trim(), 10)));
    });
    if (n > 0) { r.canali = n; scrivi(); }
  } catch (e) {}
  return quantiCanali(r);
}
function piuDiUnaCoppia(r) { return quantiCanali(r) > 2; }

// deve essere preciso o l'immagine va ritagliata in verticale.
function codifica(args, preciso, ritaglio, sting, af) {
  let fuori = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(args);
  if (!preciso) {
    // Il video si ricopia, l'audio no: certe partite hanno la telecronaca
    // in 5.1 a sei canali, e un MP4 con l'audio multicanale Firefox si
    // rifiuta di aprirlo — dice "file danneggiato", che sembra un guasto
    // e invece e' una scelta. Ricodificare l'audio costa niente e la clip
    // esce leggibile ovunque.
    fuori = fuori.concat(af ? ["-af", af] : [])
                 .concat(["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
                          "-avoid_negative_ts", "make_zero"]);
  } else {
    // il ritaglio PRIMA, lo sting DOPO: l'etichetta va misurata sul formato
    // che esce davvero, non su quello che entra
    const vf = [ritaglio, sting].filter(Boolean).join(",");
    if (vf) fuori = fuori.concat(["-vf", vf]);
    if (af) fuori = fuori.concat(["-af", af]);
    fuori = fuori.concat(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ac", "2"]);
  }
  return fuori.concat(["-movflags", "+faststart"]);
}

// Da un pezzo di stderr di ffmpeg, i secondi gia' scritti: e' quello che
// -progress stampa come out_time_us (microsecondi, nonostante il nome del
// cugino out_time_ms). Serve alla barra di avanzamento, che senza un numero
// vero sarebbe un'animazione e basta.
function secondiScritti(testo) {
  const m = /out_time_us=(\d+)/g; let u = null, x;
  while ((x = m.exec(testo))) u = +x[1];
  if (u === null) { const m2 = /out_time_ms=(\d+)/g; while ((x = m2.exec(testo))) u = +x[1]; }
  return u === null ? null : u / 1e6;
}
const CON_PROGRESSO = ["-progress", "pipe:2", "-nostats"];

function esegui(c, args, lista, riserva) {
  const fuoriFile = fileClip(c.id);
  const pr = spawn(FFMPEG, CON_PROGRESSO.concat(args, ["-y", fuoriFile]), { stdio: ["ignore", "ignore", "pipe"] });
  let coda = "", ultimoAnnuncio = 0;
  c.avanza = 0;
  pr.stderr.on("data", (d) => {
    coda = (coda + d).slice(-2000);
    const sec = secondiScritti(String(d));
    if (sec !== null && c.durata) {
      c.avanza = Math.max(c.avanza || 0, Math.min(0.99, sec / c.durata));
      if (Date.now() - ultimoAnnuncio > 500) { ultimoAnnuncio = Date.now(); annuncia(0, "clip"); }
    }
  });
  pr.on("error", (e) => { c.stato = "errore"; c.errore = e.message; scrivi(); annuncia(0, "clip"); });
  pr.on("close", async (code) => {
    // IL TAGLIO IN COPIA NON SEMPRE PUO'.
    // Se il flusso e' caduto e ripartito, i tempi dentro i segmenti si
    // accavallano e ricopiare i byte fallisce ("Error muxing a packet").
    // Non e' una ragione per non avere la clip: si rifa' ricodificando, che
    // costa qualche secondo e non ha quel problema. Meglio una clip lenta
    // che un errore — soprattutto se a chiederla e' stato il giro
    // automatico, dove nessuno sta guardando.
    if (code !== 0 && riserva) {
      // la lista dei segmenti serve ancora alla riserva: la si porta avanti
      // e la cancella lei alla fine, invece di toglierla di mezzo adesso
      c.rifattaPreciso = true;
      esegui(c, riserva, lista, null);
      return;
    }
    if (lista) { try { fs.unlinkSync(lista); } catch (e) {} }
    ["t1", "t2", "t3"].forEach((t) => {
      try { fs.unlinkSync(path.join(DIR, CARTELLA_CLIP, c.id + "." + t + ".txt")); } catch (e) {}
    });
    if (code === 0) {
      const d = await probe(fuoriFile);
      c.stato = "pronta"; c.peso = d.peso || 0; c.avanza = 1;
      if (d.durata) c.durataVera = Math.round(d.durata * 100) / 100;
      const dur = d.durata || (c.fuori - c.dentro) || 3;
      c.mini = await miniatura(fuoriFile, path.join(DIR, CARTELLA_CLIP, c.id + ".jpg"), dur / 3)
        ? "/clip/" + CARTELLA_CLIP + "/" + c.id + ".jpg" : "";
      // l'Inserisci di Premiere: la clip, appena pronta, va dritta nella
      // sequenza della sua partita, senza un secondo gesto
      if (c.inSequenza) { try { hlAggiungi({ clip: c.id }); } catch (e) {} }
    } else {
      c.stato = "errore"; c.errore = ultimaRiga(coda) || ("ffmpeg e' uscito con " + code);
    }
    scrivi(); annuncia(0, "clip");
  });
}

function clipElimina(p) {
  if (p.clip) {
    const c = R.clip[p.clip];
    if (!c) throw new Error("clip sconosciuta");
    try { fs.unlinkSync(fileClip(c.id)); } catch (e) {}
    try { fs.unlinkSync(path.join(DIR, CARTELLA_CLIP, c.id + ".jpg")); } catch (e) {}
    delete R.clip[p.clip];
    scrivi(); annuncia(0, "clip");
    return { ok: true };
  }
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  if (PROC.get(r.id)) throw new Error("prima ferma la registrazione");
  try { fs.rmSync(cartellaReg(r.id), { recursive: true, force: true }); } catch (e) {}
  Object.keys(R.clip).forEach((k) => {
    if (R.clip[k].reg !== r.id) return;
    try { fs.unlinkSync(fileClip(k)); } catch (e) {}
    delete R.clip[k];
  });
  delete R.reg[r.id];
  scrivi(); annuncia(0, "clip");
  return { ok: true };
}

function orologio(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), q = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(q).padStart(2, "0");
}

function pubblica(r) {
  const vive = !!PROC.get(r.id) || (r.stato === "registra" && vivo(r.pid, r.id));
  const scritto = durataRegistrata(r.id);
  return Object.assign({}, r, {
    // in ascolto e ancora nessun byte: non e' rotta, sta aspettando che
    // dall'altra parte comincino a trasmettere
    attesa: !!(r.ascolto && r.stato === "registra" && vive && scritto === 0),
    // una partita d'archivio non ha byte qui: ha un indirizzo, che scade e
    // quindi si rifa' ogni volta che qualcuno chiede lo stato
    materiale: r.arch ? "archivio"
             : fs.existsSync(playlistDi(r.id)) ? "segmenti"
             : (fs.existsSync(path.join(cartellaReg(r.id), "integrale.mp4")) ? "integrale" : "scaduto"),
    // l'indirizzo per la PAGINA: quello firmato del magazzino se il browser
    // ci arriva, il ponte sulla VM se il magazzino sta dietro il tunnel
    via: r.arch ? (magazzinoDaFuori(r) ? viaArchivio(r) : viaPonte(r.id)) : undefined,
    // I PEZZI DELLA PARTITA, PER LA PAGINA. Ognuno con il secondo in cui
    // entra nella linea del tempo, quanto dura e da dove si prende: il
    // monitor cambia file da solo quando la testina passa da un tempo
    // all'altro, e chi monta vede due ore, non cinquantasei minuti.
    pezziArch: r.arch ? pezziArch(r).map((x, i) => ({
      da: x.da || 0, durata: x.durata || 0,
      via: magazzinoDaFuori(r) ? viaPezzo(r, x) : viaPonte(r.id, 21600, i)
    })) : undefined,
    // la miniatura si promette solo se il file c'e': una sfilza di 404 ogni
    // tre secondi non e' un'anteprima
    mini: (r.mini && fs.existsSync(path.join(DIR, String(r.mini).replace(/^\/clip\//, "")))) ? r.mini : "",
    durata: r.stato === "registra" ? durataRegistrata(r.id) : (r.durata || durataRegistrata(r.id)),
    // vedere o tenere: la porta e' aperta in tutti e due i casi, cambia
    // solo cosa resta sul disco
    // il fotogramma vivo della porta: la pagina lo rinfresca da sola
    vivo: (r.vivoQuando ? "/clip/" + r.id + "/vivo.jpg" : ""),
    vivoQuando: r.vivoQuando || 0,
    vedi: !!r.vedi,
    rec: r.tieniDa !== undefined,
    recDa: r.tieniDa !== undefined ? r.tieniDa : null,
    tenuti: r.tenuti || [],
    daSecondo: r.daSecondo || 0,
    // la copia leggera, se c'e': la pagina guarda quella e scarica trenta
    // volte meno. Il taglio e l'esportazione restano sull'originale.
    // quanti canali porta la pista: sopra i due la pagina non puo' lasciar
    // fare al browser, che li piegherebbe tutti dentro due uscite
    canali: quantiCanali(r),
    proxy: proxyCe(r.id) ? "/clip/" + r.id + "/proxy.m3u8" : "",
    viva: vive
  });
}

function clipStato(p) {
  ultimaPagina = Date.now();          // c'e' qualcuno davanti al MAM
  // occasione buona per dare una faccia alle registrazioni in corso
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (!r.mini && r.stato !== "carica" && r.materialeTolto === undefined) {
      miniaturaViva(r).catch(() => {});
    }
    // un caricamento lasciato a meta' — la finestra chiusa, la rete caduta —
    // non deve restare in elenco per sempre a dire "caricamento"
    if (r.stato === "carica" && !CARICHI_MAM.get(r.id) && Date.now() - r.avviata > 120000) {
      try { fs.rmSync(cartellaReg(r.id), { recursive: true, force: true }); } catch (e) {}
      delete R.reg[k];
      scrivi();
    }
  });
  const soloReg = p && p.reg ? String(p.reg) : "";
  const reg = Object.keys(R.reg)
    .map((k) => pubblica(R.reg[k]))
    .filter((r) => !soloReg || r.id === soloReg)
    .sort((a, b) => b.avviata - a.avviata);
  const clip = Object.keys(R.clip)
    .map((k) => Object.assign({}, R.clip[k], { nome: nomeScarico(R.clip[k], R.reg[R.clip[k].reg]) }))
    .filter((c) => !soloReg || c.reg === soloReg)
    .sort((a, b) => b.creata - a.creata);
  const gb = liberiGB();
  return {
    ok: true, reg: reg, clip: clip, srv: Date.now(),
    porte: statoPorte(),
    disco: {
      liberi: Math.round(gb * 10) / 10,
      // a 4 Mbps una partita di due ore pesa circa 3,6 GB
      partite: Math.floor(gb / 3.6),
      aperte: reg.filter((r) => r.stato === "registra").length,
      tetto: MAX_REG, giorni: GIORNI
    }
  };
}


// ══════════════════════════════════════════════════════════════════════
//  HIGHLIGHTS — dalla registrazione a una sequenza che si puo' correggere
// ══════════════════════════════════════════════════════════════════════
//
//  Una sequenza NON e' un video: e' un elenco ordinato di pezzi, dove ogni
//  pezzo dice "da questa registrazione, dal secondo X al secondo Y, gol di
//  Douvikas al 63'". Nasce da sola dai marker e dalle clip gia' tagliate, e
//  da quel momento si sposta, si accorcia e si butta. Il video si fa alla
//  fine, quando la sequenza e' quella giusta.
//
//  Perche' cosi': tagliare subito dieci pezzi vuol dire dieci file da
//  rifare al primo ripensamento. Un elenco si corregge, e costa zero.

const HL_PRE = 8, HL_POST = 6;          // maniglie: le stesse di HL Auto-Cut

// I codici delle competizioni su ESPN, per come si chiamano su Airtable —
// che non e' un nome solo: convivono "Coppa di Germania" e "DFB-Pokal".
// Verificati il 2026-09-04 sulle partite gia' giocate (vedi handoff §11).
const ESPN_CODICI = {
  "Serie A": "ita.1", "Serie B": "ita.2", "Coppa Italia": "ita.coppa_italia",
  "Eredivisie": "ned.1", "Scottish Premiership": "sco.1", "Scottish Championship": "sco.2",
  "Championship": "eng.2", "EFL Championship": "eng.2", "Scottish Cup": "sco.tennents",
  "Premier Sports Cup": "sco.cis", "Scottish League Cup": "sco.cis",
  "Saudi Pro League": "ksa.1", "King's Cup": "ksa.kings.cup",
  "Bundesliga Austria": "aut.1", "Coppa di Germania": "ger.dfb_pokal", "DFB-Pokal": "ger.dfb_pokal",
  "Carabao Cup": "eng.league_cup", "Coppa di Francia": "fra.coupe_de_france",
  "Coupe de France": "fra.coupe_de_france", "Coppa di Portogallo": "por.taca.portugal",
  "Taça de Portugal": "por.taca.portugal",
  "Copa Libertadores": "conmebol.libertadores", "Copa Sudamericana": "conmebol.sudamericana",
  "Recopa Sudamericana": "conmebol.recopa",
  "LPF Argentina": "arg.1", "Clausura Liga Profesional": "arg.1",
  "Apertura Liga Profesional": "arg.1"
};
// Un highlight e' fatto di gol, rigori, cartellini e autogol. ESPN da' anche
// calcio d'inizio, intervallo, ritardi e sostituzioni: sono cronaca, non
// highlight, e riempirebbero la sequenza di pezzi da buttare a mano.
const ESPN_UTILI = /(goal|penalty|card|own)/i;

function nomeSemplice(x) {
  return String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Da un'ora del mondo al secondo giusto della registrazione. Si cammina sui
// segmenti invece di fare una sottrazione: cosi' un buco nel flusso non
// sposta tutto quello che viene dopo.
function secondiDaOra(id, ms) {
  const segs = segmenti(id);
  for (let i = 0; i < segs.length; i++) {
    const x = segs[i];
    if (!x.ora) continue;
    if (ms >= x.ora && ms < x.ora + x.dur * 1000) return x.t0 + (ms - x.ora) / 1000;
  }
  // fuori dai segmenti: si dice di quanto, serve a capire se e' prima o dopo
  const primo = segs.find((x) => x.ora), ultimo = [...segs].reverse().find((x) => x.ora);
  if (!primo) return null;
  if (ms < primo.ora) return -(primo.ora - ms) / 1000;
  return (ultimo.t0 + ultimo.dur) + (ms - (ultimo.ora + ultimo.dur * 1000)) / 1000;
}

async function airtableRecord(recId) {
  return atLeggi("https://api.airtable.com/v0/" + AT_BASE + "/" + AT_PARTITE + "/" + recId);
}

// Gli eventi ufficiali della partita. Si cerca anche il giorno prima e dopo:
// le sudamericane cominciano a notte fonda e cadono oltre la mezzanotte nel
// fuso di ESPN — cercando la sola data se ne trovava una su tre.
async function espnEventi(recId) {
  const rec = await airtableRecord(recId);
  const f = (rec && rec.fields) || {};
  const comp = f["Competizione"] || "";
  const code = ESPN_CODICI[comp];
  if (!code) throw new Error("ESPN non copre \"" + comp + "\" (o il codice non e' in tabella)");
  const quando = f["Data | Orario"];
  if (!quando) throw new Error("l'evento non ha data");
  const squadre = String(f["Partita"] || "").replace(/\(.*?\)/g, "").split(/[-–]/)
    .map(nomeSemplice).filter((x) => x.length >= 4);

  const g = new Date(quando);
  let partita = null;
  for (const salto of [0, -1, 1]) {
    const d = new Date(g.getTime() + salto * 86400000);
    const giorno = d.getUTCFullYear() +
      String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
    let sb;
    try {
      const rr = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + code +
                             "/scoreboard?dates=" + giorno, { signal: AbortSignal.timeout(20000) });
      sb = await rr.json();
    } catch (e) { continue; }
    const trovato = (sb.events || []).find((ev) => {
      const nomi = nomeSemplice(ev.name) + nomeSemplice(ev.shortName);
      return squadre.some((sq) => nomi.indexOf(sq.slice(0, 6)) >= 0);
    });
    if (trovato) { partita = trovato; break; }
  }
  if (!partita) throw new Error("ESPN non ha questa partita (" + (f["Partita"] || "") + ")");

  const rr = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + code +
                         "/summary?event=" + partita.id, { signal: AbortSignal.timeout(20000) });
  const sm = await rr.json();
  return (sm.keyEvents || []).filter((k) => ESPN_UTILI.test(((k.type || {}).text) || ""))
    .map((k) => ({
      id: String(k.id || ((k.type || {}).id || "") + "-" + (((k.clock || {}).displayValue) || "")),
      tipo: (k.type || {}).text || "",
      minuto: ((k.clock || {}).displayValue) || "",
      periodo: (k.periodo || (k.period || {}).number) || 0,
      squadra: (k.team || {}).displayName || "",
      giocatore: ((k.participants || [])[0] || {}).athlete
                 ? k.participants[0].athlete.displayName : "",
      testo: k.shortText || k.text || "",
      ora: k.wallclock ? Date.parse(k.wallclock) : 0
    })).filter((x) => x.ora);
}

function nomePezzo(x) {
  return [x.minuto, x.tipo, x.giocatore || x.squadra].filter(Boolean).join(" ").trim() || "pezzo";
}


// ══════════════════════════════════════════════════════════════════════
//  GLI APPUNTI DELLA REDAZIONE
// ══════════════════════════════════════════════════════════════════════
//
//  ESPN da' i FATTI: gol, rigori, cartellini, con il minuto esatto. Gli
//  appunti danno il GIUDIZIO: la parata che vale il pezzo, l'occasione,
//  la giocata. Nessuna delle due basta da sola — il grezzo lo puo' fare
//  solo chi non sbaglia i minuti, il senso solo chi guardava.
//
//  Il parser e' quello di HL Auto-Cut, portato qui: stesse regole, stesse
//  eccezioni, comprese quelle imparate sul campo (la riga "2-0 Como
//  raddoppia" e' un punteggio, non un minuto; "NOTE" non e' una sezione
//  da saltare, se no si spegne il parser per tutta la cella).

const TIPI_APPUNTI = [
  ["Gol", ["gol", "goal", "rete", "segna", "segnato", "raddoppi-", "pareggi-", "tris", "poker"]],
  ["Rigore", ["rigore", "rigori", "penalty", "dischetto"]],
  ["Parata", ["parata", "parato", "parata", "para", "paraton-", "miracolo", "respinge", "respinta", "salva", "rifless-", "vola"]],
  ["Palo", ["traversa", "legno", "palo", "montante", "pali"]],
  ["Cartellino", ["giallo", "rosso", "cartellino", "ammoni-", "espuls-", "espulso"]],
  ["Occasione", ["occasione", "chance", "tiro", "conclusion-", "punizione",
                 "assist", "contropiede", "brivido", "sfiora", "sfiorato"]],
  ["Skill", ["skill", "dribbling", "tunnel", "giocata", "tacco", "numero"]]
];

// A parole intere, non a pezzi di parola: "angolino" contiene "gol" e per
// anni avrebbe fatto passare per gol ogni palla messa nell'angolino. Le
// chiavi che finiscono per "-" valgono come inizio di parola (ammoni-, espuls-).
function tipoDellaRiga(t) {
  const b = " " + senzaAccenti(t).replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const dentro = (k) => k.slice(-1) === "-"
    ? b.indexOf(" " + k.slice(0, -1)) >= 0
    : b.indexOf(" " + k + " ") >= 0;
  for (const [nome, chiavi] of TIPI_APPUNTI) {
    if (!chiavi.some(dentro)) continue;
    // "primo palo", "secondo palo", "sul palo lontano" sono POSTI del campo,
    // non legni colpiti: se il palo compare solo cosi', non e' un palo
    if (nome === "Palo" && !/ (traversa|legno|montante|pali) /.test(b)) {
      const posto = / (primo|secondo) palo | sul palo /.test(b);
      const colpito = / (colpisce|colpito|prende|preso|centra|centrato|stampa|stampato|sbatte) /.test(b) ||
                      /^ palo /.test(b);                   // la riga comincia con "Palo!": e' un palo
      if (posto && !colpito) continue;
    }
    return nome;
  }
  return "";
}

// Se la riga e' un'intestazione di sezione: 1, 2, 3, 4, null (da saltare)
// oppure false (non e' un'intestazione).
function sezioneDi(riga) {
  const t = riga.replace(/[*_#>\s]+/g, " ").trim().toUpperCase();
  if (!t) return false;
  if (t.length > 40) return false;               // una riga lunga e' prosa, non un titolo
  if (/SUPPLEMENT/.test(t)) return /SECONDO|2/.test(t) ? 4 : 3;
  if (/^PRIMO TEMPO/.test(t) || t === "1T" || t === "PT" || t === "1° TEMPO") return 1;
  if (/^SECONDO TEMPO/.test(t) || t === "2T" || t === "ST" || t === "2° TEMPO") return 2;
  if (/^(GOL RATING|RATING|RIGORI|SEQUENZA RIGORI|FORMAZION)/.test(t)) return null;
  return false;
}

// Il tempo in testa alla riga: 45+2 | 9'50" | 63' | 12:30
function tempoInTesta(s) {
  const t = s.replace(/^\s+/, "");
  if (/^\d{1,2}\s*[-–—]\s*\d{1,2}(?!\d)/.test(t)) return null;   // e' un punteggio
  let m = /^(\d{1,2}):(\d{2})\b\s*['’]?\s*(.*)$/.exec(t);
  if (m) return { min: +m[1], sec: +m[2], stopp: 0, resto: m[3].trim() };
  // il recupero puo' stare prima dell'apice (45+2') o dopo (90'+3)
  m = /^(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*(?:['’](?:\s*\+\s*(\d{1,2}))?(?:\s*(\d{1,2})\s*["”]?)?)?\s*(.*)$/.exec(t);
  if (!m) return null;
  const resto = (m[5] || "").replace(/^[\s\-–:.]+/, "");
  if (!m[2] && !m[3] && !m[4] && !/^['’]/.test(t.slice(String(m[1]).length)) && !resto) return null;
  return { min: +m[1], sec: m[4] ? +m[4] : 0, stopp: m[2] ? +m[2] : (m[3] ? +m[3] : 0), resto: resto };
}

// IL GOL RATING. In fondo agli appunti la redazione da' un voto a ogni gol:
//   _Velasco (17): Rating - 4_
// e' il giudizio di chi guardava su quanto vale quel gol. Non e' una riga in
// piu': e' un voto da attaccare al gol che sta gia' negli appunti, e serve a
// scegliere cosa entra negli highlights quando i minuti non bastano.
function leggiRating(testo) {
  const fuori = [];
  String(testo || "").split("\n").forEach((riga) => {
    const m = /^[\s_*]*(.+?)\s*\((\d{1,3})(?:\+\d+)?\)\s*:?\s*ra[it]+ing\s*[-:]?\s*(\d)/i.exec(riga.trim());
    if (!m) return;
    const nome = m[1].replace(/[_*]/g, "").trim();
    if (!nome || nome.length > 40) return;
    // il modello vuoto degli appunti porta un finto cognome: non e' un gol
    if (/^(congome|cognome|nome|giocatore|player)$/i.test(nome)) return;
    fuori.push({ nome: nome, minuto: +m[2], voto: +m[3] });
  });
  return fuori;
}
function leggiAppunti(testo, durataTempo) {
  const dur = durataTempo || 45;
  const fuori = [];
  let sezione = 1, titoli = 0;
  String(testo || "").split("\n").forEach((grezza) => {
    if (!grezza.trim()) return;
    const pulita = grezza.replace(/^[\s>*_#\-]+/, "").replace(/[*_]+$/, "").trim();
    const sez = sezioneDi(pulita);
    if (sez !== false) { sezione = sez; titoli++; return; }
    if (sezione === null) return;                       // dentro rating o rigori
    const hl = /\\\*|(^|\s)\*(?!\*)/.test(grezza);      // il marcatore della redazione
    const grassetto = grezza.indexOf("**") >= 0;
    const riga = pulita.replace(/\*/g, "").replace(/\\/g, "").trim();
    const t = tempoInTesta(riga);
    if (!t) return;                                     // prosa senza riferimento
    let dentroTempo;
    if (sezione === 1 || sezione === 3) dentroTempo = t.min * 60 + t.sec + t.stopp * 60;
    else {
      const base = sezione === 2 ? dur : (2 * dur + 15);
      const off = t.min >= base ? (t.min - base) : t.min;
      dentroTempo = off * 60 + t.sec + t.stopp * 60;
    }
    fuori.push({
      sezione: sezione === 3 ? 1 : (sezione === 4 ? 2 : sezione),
      dentroTempo: dentroTempo,
      minuto: t.stopp ? (t.min + "+" + t.stopp) : (t.min + "'"),
      testo: t.resto || riga,
      tipo: tipoDellaRiga(t.resto || riga),
      hl: hl, forte: grassetto, minutoVero: t.min, secVero: t.sec, stoppVero: t.stopp
    });
  });
  // chi non scrive "secondo tempo" lo dice con i numeri: dal 46' in poi e'
  // ripresa, e il tempo dentro il tempo si conta da li'
  if (!titoli) fuori.forEach((r) => {
    if (r.sezione === 1 && r.minutoVero >= 46) {
      r.sezione = 2; r.dentroTempo = (r.minutoVero - dur) * 60 + r.secVero + r.stoppVero * 60;
    }
  });
  // il voto si attacca al gol piu' vicino: lo stesso minuto, o quasi. Se
  // quel gol negli appunti non c'e', la riga del voto diventa la riga del gol.
  leggiRating(testo).forEach((v) => {
    let meglio = null, distanza = 3;
    fuori.forEach((r) => {
      if (!/gol|goal|rete/i.test((r.tipo || "") + " " + (r.testo || ""))) return;
      const d = Math.abs(r.minutoVero - v.minuto);
      if (d <= distanza) { distanza = d; meglio = r; }
    });
    if (meglio) { meglio.rating = v.voto; if (meglio.testo.toLowerCase().indexOf(v.nome.toLowerCase()) < 0) meglio.testo += " \u00b7 " + v.nome; }
    else {
      const s2 = v.minuto > dur ? 2 : 1;
      fuori.push({ sezione: s2, dentroTempo: (s2 === 2 ? v.minuto - dur : v.minuto) * 60,
                   minuto: v.minuto + "'", testo: "Gol di " + v.nome, tipo: "Gol",
                   hl: false, forte: false, rating: v.voto, minutoVero: v.minuto, secVero: 0, stoppVero: 0 });
    }
  });
  fuori.sort((a, b) => (a.sezione - b.sezione) || (a.dentroTempo - b.dentroTempo));
  fuori.forEach((r) => { delete r.minutoVero; delete r.secVero; delete r.stoppVero; });
  return fuori;
}

async function appuntiDi(recId) {
  const rec = await airtableRecord(recId);
  const f = (rec && rec.fields) || {};
  return leggiAppunti(f["Appunti"] || "", 45);
}

// ── costruire la sequenza ─────────────────────────────────────────────

// Quanto conta un'azione, quando i tre minuti non bastano per tutte.
// Non e' una classifica di bellezza: e' l'ordine in cui si rinuncia.
function pesoAzione(tipo, hl, rating) {
  const t = senzaAccenti(tipo || "");
  if (hl) return 5;                                  // marcata dalla redazione: non si tocca
  // il voto della redazione, quando c'e', vale piu' del tipo: un gol da 4
  // non e' un gol da 1, e quando i minuti non bastano si vede
  if (rating >= 4) return 5;
  if (/goal|gol|own|penalty|rigore/.test(t)) return rating === 1 ? 3 : 4;
  if (/red|rosso|espuls/.test(t)) return 4;
  if (/parata|palo|traversa/.test(t)) return 3;
  if (/card|cartellino|giallo|ammoni/.test(t)) return 2;
  return 1;                                          // occasioni, skill, il resto
}

// I TRE MINUTI.
// Un highlight ha una durata voluta, non una durata che viene fuori. Si
// parte da tutti i pezzi con le maniglie normali e si aggiusta:
//   troppo lungo  -> si rinuncia partendo da quelli che pesano meno, e se
//                    restano solo i gol si stringono le maniglie
//   troppo corto  -> si allungano le maniglie fino a un tetto, e il resto
//                    lo mette una persona trascinando dai suggerimenti
function stringiAllaDurata(pezzi, voluta, pre, post) {
  if (!voluta || !pezzi.length) return { pezzi: pezzi, nota: "" };
  const durata = () => pezzi.reduce((a, x) => a + (x.fuori - x.dentro), 0);
  let tolti = 0;
  while (durata() > voluta && pezzi.length > 1) {
    let peggio = 0;
    for (let i = 1; i < pezzi.length; i++) {
      if (pezzi[i].peso < pezzi[peggio].peso) peggio = i;
    }
    if (pezzi[peggio].peso >= 4) break;              // restano solo i gol: non si butta piu'
    pezzi.splice(peggio, 1); tolti++;
  }
  // ancora lungo: si stringono le maniglie, mai sotto il minimo
  if (durata() > voluta) {
    const troppo = durata() - voluta, quanti = pezzi.length;
    const taglia = Math.min(troppo / quanti, (pre + post) - 7);
    if (taglia > 0.5) {
      pezzi.forEach((x) => {
        const meta = taglia * (pre / (pre + post));
        x.dentro = Math.round((x.dentro + meta) * 10) / 10;
        x.fuori = Math.round((x.fuori - (taglia - meta)) * 10) / 10;
      });
    }
  }
  // corto: si allarga, ma con misura
  if (durata() < voluta * 0.85) {
    const manca = voluta - durata();
    const piu = Math.min(manca / pezzi.length, 6) / 2;
    pezzi.forEach((x) => {
      x.dentro = Math.max(0, Math.round((x.dentro - piu) * 10) / 10);
      x.fuori = Math.round((x.fuori + piu) * 10) / 10;
    });
  }
  const finale = durata();
  let nota = "";
  if (tolti) nota = "Per stare nei " + Math.round(voluta / 60) + " minuti ho lasciato fuori " +
    tolti + (tolti === 1 ? " azione" : " azioni") + " fra le meno importanti.";
  else if (finale < voluta * 0.8) nota = "La sequenza dura " + Math.round(finale) + "s sui " +
    Math.round(voluta) + " voluti: guarda i suggerimenti dagli appunti per riempirla.";
  return { pezzi: pezzi, nota: nota };
}

async function hlGenera(p) {
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  const pre = num(p.pre, 0, 60, HL_PRE), post = num(p.post, 0, 60, HL_POST);
  const fonti = p.fonti || {};
  const durata = r.durata || durataRegistrata(r.id);
  const pezzi = [];
  const avvisi = [];

  // 1. Le clip tagliate durante il live. Sono la cosa piu' preziosa che c'e':
  //    qualcuno le ha scelte mentre guardava la partita.
  if (fonti.clip !== false) {
    Object.keys(R.clip).map((k) => R.clip[k])
      .filter((c) => c.reg === r.id && c.stato === "pronta")
      .sort((a, b) => a.dentro - b.dentro)
      .forEach((c) => pezzi.push({
        id: nuovoId("p"), dentro: c.dentro, fuori: c.fuori, base: c.dentro,
        titolo: c.titolo, tipo: c.tipo || "", minuto: c.minuto || "",
        fonte: "clip", clip: c.id
      }));
  }

  // 2. I segni messi a mano durante la partita.
  if (fonti.marker !== false) {
    (r.marker || []).forEach((m) => pezzi.push({
      id: nuovoId("p"),
      dentro: Math.max(0, m.secondi - pre), fuori: m.secondi + post, base: Math.max(0, m.secondi - pre),
      titolo: m.testo || m.tipo || "segno", tipo: m.tipo || "", minuto: "",
      fonte: "marker"
    }));
  }

  // 3. Gli eventi ufficiali, agganciati per orologio.
  let espn = [];
  if (fonti.espn !== false && r.evento) {
    try {
      espn = await espnEventi(r.evento);
    } catch (e) { avvisi.push("ESPN: " + e.message); }
    // L'orologio e' la strada buona: ogni segmento porta l'ora in cui e' stato
    // scritto, ogni evento ESPN porta la sua, e si incrociano. Ma vale solo
    // sul VIVO: su una replica — o su una registrazione ripresa da un file —
    // le due ore non c'entrano niente fra loro. Allora si torna ai minuti,
    // contati dal fischio d'inizio, che e' quello che HL Auto-Cut fa da
    // sempre. Serve pero' che il fischio sia stato segnato.
    const k1 = r.kickoff ? r.kickoff["1"] : undefined;
    const k2 = r.kickoff ? r.kickoff["2"] : undefined;
    let perOrologio = 0, perMinuti = 0;

    function daiMinuti(e) {
      const m = /(\d+)/.exec(String(e.minuto || ""));
      if (!m) return null;
      const min = parseInt(m[1], 10);
      const rec = /\+\s*(\d+)/.exec(String(e.minuto || ""));
      const extra = rec ? parseInt(rec[1], 10) : 0;
      if (e.periodo === 2 || min > 45) {
        if (k2 === undefined) return null;
        return k2 + (Math.max(46, min) - 46) * 60 + extra * 60;
      }
      if (k1 === undefined) return null;
      return k1 + (min - 1) * 60 + extra * 60;
    }

    espn.forEach((e) => {
      let s = secondiDaOra(r.id, e.ora);
      let via = "orologio";
      if (s === null || s - pre < -60 || s - pre > durata) {
        const alt = daiMinuti(e);
        if (alt === null) return;
        s = alt; via = "minuti";
      }
      if (via === "orologio") perOrologio++; else perMinuti++;
      // QUANTO SI PUO' STRINGERE.
      // L'orologio dice il secondo: bastano le maniglie strette.
      // Il minuto no: "30'" vuol dire che il cronometro stava fra 29:00 e
      // 30:00, e l'azione puo' essere in un punto qualsiasi di quei sessanta
      // secondi. Un pezzo di quattordici secondi la mancherebbe quasi sempre.
      // Quindi da minuti il pezzo copre il minuto intero: si arriva larghi e
      // si stringe guardando, con -1/+1 o con "tara qui".
      const dentro = s - pre;
      if (dentro < -60 || dentro > durata) return;      // e' di un'altra partita, o fuori registrazione
      pezzi.push({
        id: nuovoId("p"),
        dentro: Math.max(0, dentro),
        fuori: Math.min(durata, via === "minuti" ? s + 60 + post : s + post),
        base: dentro,
        titolo: nomePezzo(e) + (via === "minuti" ? " (nel minuto)" : ""),
        tipo: e.tipo, minuto: e.minuto,
        squadra: e.squadra, giocatore: e.giocatore,
        fonte: "espn", ora: e.ora, via: via
      });
    });
    if (perMinuti && !perOrologio) {
      avvisi.push("gli eventi ESPN sono stati messi contando i minuti dal fischio d'inizio: " +
                  "l'orologio del flusso non corrisponde a quello della partita (registrazione differita?)");
    }
    if (espn.length && !pezzi.some((x) => x.fonte === "espn")) {
      avvisi.push("ESPN ha " + espn.length + " eventi ma nessuno cade dentro la registrazione. " +
                  (r.kickoff && (r.kickoff["1"] !== undefined || r.kickoff["2"] !== undefined)
                    ? "Controlla il fischio d'inizio, o tara l'orologio su un pezzo."
                    : "Segna il fischio d'inizio (1\u00ba T e 2\u00ba T) e riprova: senza, i minuti non si possono collocare."));
    }
  }

  // ── IL DOPPIO CONTROLLO ──────────────────────────────────────────
  //
  //  Il grezzo lo fa ESPN. Poi si guardano gli appunti dei giornalisti:
  //  quello che coincide CONFERMA il pezzo e gli presta le parole di chi
  //  guardava ("gol di Diao" diventa "tacco di Diao su cross di Paz");
  //  quello che non coincide non entra da solo — resta un SUGGERIMENTO,
  //  perche' un'occasione la sceglie una persona, non una regola.
  const suggerimenti = [];
  if (fonti.appunti !== false && r.evento) {
    let note = [];
    try { note = await appuntiDi(r.evento); } catch (e) { avvisi.push("Appunti: " + e.message); }
    const k1 = r.kickoff ? r.kickoff["1"] : undefined;
    const k2 = r.kickoff ? r.kickoff["2"] : undefined;
    note.forEach((n) => {
      const k = n.sezione === 2 ? k2 : k1;
      const quando = (k === undefined) ? null : k + n.dentroTempo;
      // c'e' gia' un pezzo li' vicino? allora e' la stessa azione
      let vicino = null;
      if (quando !== null) {
        pezzi.forEach((x) => {
          const centro = x.dentro + pre;
          if (Math.abs(centro - quando) <= 75 && (!vicino || Math.abs(vicino.dentro + pre - quando) > Math.abs(centro - quando))) vicino = x;
        });
      }
      if (vicino) {
        vicino.confermato = true;
        if (n.hl) vicino.hl = true;
        if (n.testo && n.testo.length > 3) vicino.nota = n.testo.slice(0, 120);
        return;
      }
      suggerimenti.push({
        id: nuovoId("g"), minuto: n.minuto, tempo: n.sezione,
        titolo: (n.minuto + " " + (n.tipo ? n.tipo + " · " : "") + n.testo).slice(0, 140),
        tipo: n.tipo, hl: n.hl, testo: n.testo,
        secondi: quando, collocabile: quando !== null && quando >= 0 && quando <= durata,
        peso: pesoAzione(n.tipo, n.hl, n.rating || n.g || 0)
      });
    });
    if (note.length && (k1 === undefined && k2 === undefined)) {
      avvisi.push("Gli appunti ci sono (" + note.length + " azioni) ma senza i fischi d'inizio " +
                  "non so dove cadono: segnali e rigenera.");
    }
  }

  pezzi.forEach((x) => { x.peso = pesoAzione(x.tipo, x.hl, x.rating || x.g || 0); });
  pezzi.sort((a, b) => a.dentro - b.dentro);

  // Due pezzi sovrapposti fanno un highlight che si ripete. Quando succede
  // vince quello scelto da una persona (la clip), non quello automatico.
  const tenuti = [];
  pezzi.forEach((x) => {
    const gia = tenuti[tenuti.length - 1];
    if (gia && x.dentro < gia.fuori - 1) {
      if (x.fonte === "clip" && gia.fonte !== "clip") { tenuti[tenuti.length - 1] = x; }
      else { gia.fuori = Math.max(gia.fuori, x.fuori); }
      return;
    }
    tenuti.push(x);
  });

  // I tre minuti: la durata di un highlight e' una decisione, non un caso.
  const voluta = num(p.durata, 15, 1800, 180);
  const stretta = stringiAllaDurata(tenuti, voluta, pre, post);
  if (stretta.nota) avvisi.push(stretta.nota);

  const q = {
    id: nuovoId("s"),
    reg: r.id,
    titolo: String(p.titolo || "").slice(0, 160) || ("HL " + r.titolo),
    pezzi: stretta.pezzi,
    voluta: voluta,
    suggerimenti: suggerimenti.sort((a, b) => (a.secondi || 0) - (b.secondi || 0)),
    pre: pre, post: post, scarto: 0,
    avvisi: avvisi,
    creata: Date.now(),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    export: null
  };
  R.seq[q.id] = q;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

function seqDi(p) {
  const q = R.seq[p.seq];
  if (!q) throw new Error("sequenza sconosciuta");
  return q;
}

// ══════════════════════════════════════════════════════════════════════
//  I PROGETTI — dove il lavoro sta fermo e si ritrova
// ══════════════════════════════════════════════════════════════════════
//
//  Il banco risolve meta' del problema: impedisce che un montaggio a meta'
//  ti segua di nascosto da una macchina all'altra. Ma poi da quell'altra
//  macchina il lavoro lo vuoi ritrovare — quando lo decidi tu, aprendolo
//  per nome. Questo e' il progetto.
//
//  Un progetto e' PERSONALE ma non chiuso a chiave: lo apri tu, e se domani
//  deve finirlo un altro basta che lo apra. Chi ce l'ha aperto adesso resta
//  scritto, cosi' non ci si pesta i piedi senza saperlo — un avviso, non
//  una serratura, perche' qui il problema e' non sovrapporsi, non difendersi.
//
//  Quello che NON e' un progetto: la partita che apri per tagliare due gol.
//  Quella continua a funzionare com'e', senza chiedere niente a nessuno.
//  Il progetto si crea quando il lavoro deve durare piu' di una sessione o
//  mescolare piu' partite.
function pubblicaProg(g) {
  return Object.assign({}, g, {
    quante: Object.keys(R.seq).filter((k) => R.seq[k].prog === g.id).length,
    partite: (g.reg || []).length
  });
}

function progElenco(p) {
  const banco = String((p && p.banco) || "");
  const tutti = Object.keys(R.prog).map((k) => R.prog[k])
    .sort((a, b) => (b.tocco || b.creata || 0) - (a.tocco || a.creata || 0));
  return { ok: true, prog: tutti.map(pubblicaProg), mio: banco };
}

function progNuovo(p) {
  const nome = String(p.nome || "").trim().slice(0, 120);
  if (!nome) throw new Error("il progetto ha bisogno di un nome");
  const g = {
    id: nuovoId("g"), nome: nome,
    banco: String(p.banco || "").slice(0, 60),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    reg: p.reg ? [String(p.reg)] : [],
    creata: Date.now(), tocco: Date.now(),
    aperto: { banco: String(p.banco || "").slice(0, 60), quando: Date.now() }
  };
  R.prog[g.id] = g;
  scrivi(); annuncia(0, "clip");
  console.log("[clip] progetto nuovo: \"" + nome + "\"");
  return { ok: true, prog: pubblicaProg(g) };
}

function progApri(p) {
  const g = R.prog[String(p.prog || "")];
  if (!g) throw new Error("progetto sconosciuto");
  const banco = String(p.banco || "").slice(0, 60);
  const prima = g.aperto || null;
  // chi ce l'ha aperto adesso: un avviso, non un divieto
  let avviso = "";
  if (prima && prima.banco && prima.banco !== banco && Date.now() - (prima.quando || 0) < 3600000) {
    avviso = "questo progetto era aperto su un altro computer meno di un'ora fa: mettetevi d'accordo prima di lavorarci sopra in due";
  }
  g.aperto = { banco: banco, quando: Date.now() };
  g.tocco = Date.now();
  scrivi(); annuncia(0, "clip");
  const seq = Object.keys(R.seq).map((k) => R.seq[k]).filter((q) => q.prog === g.id)
    .sort((a, b) => b.creata - a.creata);
  seq.forEach((q) => { try { segnaPezziLocali(q); } catch (e) {} });
  return { ok: true, prog: pubblicaProg(g), seq: seq, avviso: avviso };
}

function progTocca(p) {
  const g = R.prog[String(p.prog || "")];
  if (!g) throw new Error("progetto sconosciuto");
  if (p.nome !== undefined) {
    const n = String(p.nome).trim().slice(0, 120);
    if (!n) throw new Error("il progetto ha bisogno di un nome");
    g.nome = n;
  }
  if (p.aggiungi) {
    g.reg = g.reg || [];
    if (g.reg.indexOf(String(p.aggiungi)) < 0) g.reg.push(String(p.aggiungi));
  }
  if (p.togli) g.reg = (g.reg || []).filter((x) => x !== String(p.togli));
  g.tocco = Date.now();
  scrivi(); annuncia(0, "clip");
  return { ok: true, prog: pubblicaProg(g) };
}

function progElimina(p) {
  const g = R.prog[String(p.prog || "")];
  if (!g) throw new Error("progetto sconosciuto");
  // le sequenze del progetto non si buttano con lui: restano, senza padrone,
  // che e' il male minore fra perdere lavoro e lasciare in giro roba
  Object.keys(R.seq).forEach((k) => { if (R.seq[k].prog === g.id) delete R.seq[k].prog; });
  delete R.prog[g.id];
  scrivi(); annuncia(0, "clip");
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
//  IL BANCO — di chi e' il montaggio
// ══════════════════════════════════════════════════════════════════════
//
//  Le sequenze apparecchiate sono la proposta della macchina: le vedono
//  tutti, su tutti i computer, e si rifanno da sole. Ma appena qualcuno le
//  tocca smettono di essere di tutti.
//
//  Prima non era cosi': il montaggio stava sul ponte e basta, quindi un
//  taglio cominciato sul Mac ricompariva sull'altro computer a meta'. Da
//  qui in poi la prima modifica fa una COPIA legata al banco che l'ha
//  fatta, e la proposta resta intatta per chiunque altro.
//
//  La chiave e' il computer, non la persona: e' quello che serve a chi
//  lavora su due macchine e vuole ricominciare pulito sulla seconda.
function seqMia(p) {
  const q = seqDi(p);
  const banco = String(p.banco || "").slice(0, 60);
  if (!banco) return q;                       // chi non si presenta lavora come prima
  if (q.banco === banco) return q;            // gia' tua
  if (!q.auto) {
    if (!q.banco) { q.banco = banco; return q; }   // sequenza a mano senza padrone: diventa tua
    throw new Error("questa sequenza la sta montando un altro computer");
  }
  // e' una proposta della macchina: se ne fa una copia tua, e la proposta
  // resta com'e' per tutti gli altri
  const c = JSON.parse(JSON.stringify(q));
  c.id = nuovoId("s");
  c.banco = banco;
  if (p.prog) c.prog = String(p.prog);      // se c'e' un progetto aperto, e' suo
  c.daAuto = q.auto;
  delete c.auto;                              // non e' piu' apparecchiata: e' tua
  c.titolo = q.titolo;
  c.creata = Date.now();
  delete c.export; delete c.esportati; delete c.premiere; delete c.grafica; delete c.casa;
  R.seq[c.id] = c;
  console.log("[clip] \"" + (c.titolo || c.id) + "\" e' diventata del banco " + banco.slice(0, 8));
  return c;
}

// UNA SEQUENZA TOCCATA A MANO NON SI RIFA' PIU'. Le sequenze apparecchiate
// si rigenerano ogni volta che si apre la partita, ed e' giusto finche' sono
// come le ha lasciate la macchina. Ma se qualcuno ha spostato un taglio,
// buttato un pezzo, cambiato l'ordine, allora quella sequenza e' sua:
// riscriverla vuol dire cancellargli il lavoro. Da qui in poi si tiene com'e'.
// ── ANNULLA ───────────────────────────────────────────────────────────
//
//  Senza annulla non si monta: si sta attenti. E stare attenti e' l'esatto
//  contrario di provare, che e' quello che il montaggio e'. Quindi ⌘Z, e
//  non su qualche comando — su TUTTI, presi in un punto solo.
//
//  Il modo e' quello grosso e stupido: prima di ogni modifica si mette da
//  parte una copia della sequenza intera. Costa qualche kilobyte a colpo, e
//  in cambio non c'e' un solo comando che possa dimenticarsi di essere
//  annullabile — nemmeno quelli che scriveremo il mese prossimo. Le copie
//  stanno in memoria e non nel registro: l'annulla e' una cosa della
//  sessione, non della storia della partita.
const PASSI = new Map();          // sequenza -> { indietro: [], avanti: [] }
const QUANTI_PASSI = 60;

function ricorda(q) {
  if (!q || !q.id) return;
  let p = PASSI.get(q.id);
  if (!p) { p = { indietro: [], avanti: [] }; PASSI.set(q.id, p); }
  const t = JSON.stringify(q);
  // se e' identica all'ultima messa da parte, non e' un passo: e' lo stesso
  // punto. Senza questo controllo un comando che chiama due volte il gancio
  // costerebbe due ⌘Z per tornare indietro di una mossa sola.
  if (p.indietro.length && p.indietro[p.indietro.length - 1] === t) { p.avanti.length = 0; return; }
  p.indietro.push(t);
  if (p.indietro.length > QUANTI_PASSI) p.indietro.shift();
  p.avanti.length = 0;            // si riscrive la storia: il "rifai" decade
}

// rimette dentro il vecchio senza cambiare l'oggetto: la pagina, i timer e
// tutto quello che tiene un riferimento a questa sequenza continuano a
// parlare della stessa cosa
function rimetti(q, testo) {
  const v = JSON.parse(testo);
  Object.keys(q).forEach((k) => { if (!(k in v)) delete q[k]; });
  Object.keys(v).forEach((k) => { q[k] = v[k]; });
  return q;
}

function annullaSeq(p, avanti) {
  const q = seqDi(p);
  const st = PASSI.get(q.id);
  const pila = avanti ? (st && st.avanti) : (st && st.indietro);
  if (!pila || !pila.length) {
    return { ok: false, errore: avanti ? "non c'e' niente da rifare" : "non c'e' altro da annullare" };
  }
  const altra = avanti ? st.indietro : st.avanti;
  altra.push(JSON.stringify(q));
  rimetti(q, pila.pop());
  normalizzaSeq(q);
  segnaPezziLocali(q);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, restano: st.indietro.length, rifare: st.avanti.length };
}

function toccataAMano(q) {
  if (!q) return;
  ricorda(q);                     // prima di toccarla, com'era
  if (!q.mano) console.log("[clip] sequenza \"" + (q.titolo || q.id) + "\": da adesso e' tua, non la rifaccio piu'");
  q.mano = Date.now();
}


// ── LE TRACCE. L'AUDIO SMETTE DI ESSERE UN DISEGNO ─────────────────────
//
//  Fino a ieri la riga A1 sotto il video era un disegno: la stessa clip,
//  ridipinta in verde. Non si poteva selezionare, ne' spostare, ne'
//  staccare — perche' non esisteva. C'era una lista di pezzi e basta, e
//  l'audio era quello che stava dentro il pezzo.
//
//  In Premiere non e' cosi'. Una clip A/V sono DUE oggetti sulla timeline,
//  uno su V1 e uno su A1, tenuti insieme da un legame. Finche' il legame
//  c'e' si muovono insieme e si tagliano insieme; quando lo togli, l'audio
//  e' un oggetto suo — lo sposti su A2, lo metti sotto un altro video, gli
//  cambi il volume, lo sfumi. E' esattamente quello che serve qui: la voce
//  del telecronista di un'azione sopra le immagini di un'altra.
//
//  Il modello e' quindi: q.pezzi resta il video (in ordine, come oggi), e
//  q.audio sono i pezzi audio. Un pezzo audio LEGATO non ha una geometria
//  sua: e' il video, sempre, cosi' che tutto quello che gia' funziona —
//  taglia, sposta, butta, lametta, PRENDI, il vivo che cresce — continui a
//  funzionare senza sapere che l'audio esiste. Uno SCOLLEGATO ce l'ha, e da
//  quel momento va dove vuole.
const TRACCE_V = ["V1", "V2"];
const TRACCE_A = ["A1", "A2", "A3", "A4"];

function tracceDi(q) {
  q.tracce = q.tracce || {};
  TRACCE_V.concat(TRACCE_A).forEach((n) => {
    q.tracce[n] = Object.assign({ muto: false, solo: false, bloccata: false, gain: 0 }, q.tracce[n] || {});
  });
  return q.tracce;
}

function audioDaPezzo(x, traccia) {
  return { id: nuovoId("a"), traccia: traccia || "A1", legato: x.id,
           t0: x.t0 || 0, dentro: x.dentro, fuori: x.fuori,
           canale: "", coppia: 0, gain: 0, entra: 0, esce: 0, muto: false,
           titolo: x.titolo || "" };
}

// Una sequenza vecchia non ha ne' posizioni ne' audio: gliele si da' qui,
// la prima volta che la si guarda. Nessuna migrazione, nessun file da
// convertire — le sequenze di ieri si aprono e basta.
function normalizzaSeq(q) {
  if (!q || !Array.isArray(q.pezzi)) return q;
  tracceDi(q);
  if (!Array.isArray(q.audio)) q.audio = [];
  let t = 0;
  q.pezzi.forEach((x) => {
    if (!x.traccia) x.traccia = "V1";
    if (x.t0 === undefined || !isFinite(x.t0)) x.t0 = Math.round(t * 1000) / 1000;
    t = x.t0 + Math.max(0, x.fuori - x.dentro);
  });
  const vivi = {};
  q.pezzi.forEach((x) => { vivi[x.id] = x; });
  const haAudio = {};
  q.audio.forEach((a) => { if (a.legato) haAudio[a.legato] = true; });
  // L'AUDIO SI CREA UNA VOLTA SOLA. Un pezzo nuovo arriva con il suo suono
  // sotto, come una clip trascinata in Premiere. Ma se poi qualcuno lo
  // scollega, o lo butta per metterci un'altra voce, quel video deve
  // restare muto: rifarglielo qui vorrebbe dire annullare la decisione un
  // istante dopo averla presa. Il segno sul pezzo dice "il suo l'ha gia'
  // avuto", e non se ne parla piu'.
  q.pezzi.forEach((x) => {
    if (haAudio[x.id]) { x.audioFatto = 1; return; }
    if (x.audioFatto) return;
    q.audio.push(audioDaPezzo(x));
    x.audioFatto = 1;
  });
  // l'audio di un video che non c'e' piu' se ne va con lui. Quello
  // scollegato no: quello e' diventato una scelta di chi monta.
  q.audio = q.audio.filter((a) => !a.legato || vivi[a.legato]);
  q.audio.forEach((a) => {
    const x = a.legato && vivi[a.legato];
    if (!x) return;
    a.t0 = x.t0; a.dentro = x.dentro; a.fuori = x.fuori;
    if (!a.titolo) a.titolo = x.titolo || "";
  });
  q.audio.forEach((a) => { if (TRACCE_A.indexOf(a.traccia) < 0) a.traccia = "A1"; });
  return q;
}

// I pezzi video attaccati uno dietro l'altro. E' il montaggio come lo fanno
// gia' tutti i comandi che ci sono — l'ordine nell'elenco E' l'ordine sulla
// timeline — e va richiamato dopo ogni ritocco. L'audio legato ci va dietro
// da solo; quello scollegato resta dov'e', che e' il punto di scollegarlo.
function riallinea(q) {
  if (!q || !Array.isArray(q.pezzi)) return q;
  // una sequenza "libera" ha i video posati dove vuole chi monta, coi
  // buchi: li' non si impacchetta niente. Oggi nessuna lo e' — il video
  // sta attaccato come e' sempre stato — ma il modello e' pronto.
  if (q.libera) {
    // l'ordine nell'elenco deve continuare a essere l'ordine sulla
    // timeline, se no il pezzo "successivo" non e' quello che si vede a
    // destra e tutto quello che c'e' gia' — giunzione, rolling, Programma —
    // comincia a mentire
    q.pezzi.sort((a, b) => (a.t0 || 0) - (b.t0 || 0));
    return normalizzaSeq(q);
  }
  let t = 0;
  q.pezzi.forEach((x) => {
    x.t0 = Math.round(t * 1000) / 1000;
    t += Math.max(0, x.fuori - x.dentro);
  });
  return normalizzaSeq(q);
}

// QUANDO LO SPAZIO E' OCCUPATO. Su una traccia sola due pezzi non possono
// stare nello stesso secondo, quindi trascinandone uno addosso a un altro
// qualcosa deve succedere. Premiere, di suo, SOVRASCRIVE: taglia via quello
// sotto. Qui no — un montaggio si fa provando, e provare non deve costare
// del materiale. Quello che succede e' che il pezzo SI INFILA: si posa sul
// bordo piu' vicino e tutto quello che viene dopo scala in avanti. E' il
// gesto che c'era prima (spostare una clip nella fila) e insieme quello
// nuovo (staccarla e portarla nel vuoto): se dove la lasci c'e' posto, si
// ferma li'; se non ce n'e', si fa largo. In nessuno dei due casi si perde
// un fotogramma, e ⌘Z rimette tutto com'era.
function facciaPosto(q, x) {
  const dur = Math.max(0, x.fuori - x.dentro);
  const altri = () => q.pezzi.filter((y) => y !== x && y.traccia === x.traccia)
    .map((y) => ({ p: y, a: y.t0 || 0, b: (y.t0 || 0) + Math.max(0, y.fuori - y.dentro) }))
    .sort((m, n) => m.a - n.a);
  const t = Math.max(0, x.t0 || 0);
  const addosso = altri().filter((o) => t < o.b - 0.02 && t + dur > o.a + 0.02);
  if (!addosso.length) return { infilato: 0 };

  // il bordo piu' vicino a dove l'hai lasciato: l'inizio del primo pezzo
  // che tocchi, o la sua fine, quello dei due che ti costa meno movimento
  const primo = addosso[0];
  const dove = (Math.abs(t - primo.a) <= Math.abs(t - primo.b)) ? primo.a : primo.b;

  // si fa largo: da quel bordo in poi, tutti avanti di quanto dura il pezzo
  const muovi = (p2, d) => {
    p2.t0 = Math.max(0, (p2.t0 || 0) + d);
    (q.audio || []).forEach((a) => { if (a.legato === p2.id) a.t0 = Math.max(0, (a.t0 || 0) + d); });
  };
  altri().forEach((o) => { if (o.a >= dove - 0.02) muovi(o.p, dur); });
  const prima = x.t0 || 0;
  x.t0 = Math.round(dove * 1000) / 1000;
  (q.audio || []).forEach((a) => { if (a.legato === x.id) a.t0 = Math.max(0, (a.t0 || 0) + (x.t0 - prima)); });
  return { infilato: 1, dove: x.t0 };
}

// I BUCHI. Una sequenza libera puo' avere spazio vuoto fra un pezzo e
// l'altro: in Premiere e' nero e silenzio, e qui deve esserlo anche nel
// file che esce — se no il montaggio che si vede e quello che si esporta
// raccontano due cose diverse.
function buchiDi(q) {
  normalizzaSeq(q);
  const fuori = [];
  let t = 0;
  q.pezzi.forEach((x) => {
    const a = x.t0 || 0;
    if (a > t + 0.04) fuori.push({ da: t, a: a });
    t = Math.max(t, a + Math.max(0, x.fuori - x.dentro));
  });
  return fuori;
}

// Dove finisce il montaggio: l'ultimo fotogramma di qualunque traccia. Un
// audio che sborda oltre l'ultimo video allunga la sequenza, come in
// Premiere.
function fineSequenza(q) {
  normalizzaSeq(q);
  let f = 0;
  q.pezzi.forEach((x) => { f = Math.max(f, (x.t0 || 0) + Math.max(0, x.fuori - x.dentro)); });
  (q.audio || []).forEach((a) => { f = Math.max(f, (a.t0 || 0) + Math.max(0, a.fuori - a.dentro)); });
  (q.grafiche || []).forEach((g) => { f = Math.max(f, g.fuori || 0); });
  return Math.round(f * 1000) / 1000;
}

// Il montaggio e' "semplice" quando l'audio e' ancora quello del video:
// tutto legato, tutto su A1, nessun volume toccato, niente sfumate, niente
// muto. Serve saperlo perche' in quel caso l'esportazione resta quella di
// oggi — si incolla e basta, in pochi secondi. Appena qualcuno tocca
// qualcosa si passa alla strada lunga, che mescola davvero.
function audioSemplice(q) {
  normalizzaSeq(q);
  // con piu' di due canali la strada corta non c'e': ricopiare l'audio
  // com'e' vuol dire riportare fuori tutti i bus, e l'eco con loro
  if (piuDiUnaCoppia(R.reg[q.reg])) return false;
  const t = q.tracce || {};
  if ((t.A1 && (t.A1.muto || t.A1.gain)) ) return false;
  if (TRACCE_A.slice(1).some((n) => t[n] && t[n].solo)) return false;
  if (t.A1 && !t.A1.solo && TRACCE_A.some((n) => t[n] && t[n].solo)) return false;
  return (q.audio || []).every((a) => a.legato && a.traccia === "A1" && !a.gain
                                   && !a.entra && !a.esce && !a.muto && !a.canale);
}

// Quali tracce si sentono: il solo di Premiere spegne tutte le altre.
function tracceCheSuonano(q) {
  const t = tracceDi(q);
  const soli = TRACCE_A.filter((n) => t[n].solo);
  const dentro = {};
  TRACCE_A.forEach((n) => { dentro[n] = soli.length ? t[n].solo : !t[n].muto; });
  return dentro;
}

// ── L'ONDA ────────────────────────────────────────────────────────────
//  Un audio che non si vede non si taglia: si va a tentativi. L'onda la
//  calcola la VM una volta e la tiene, cosi' la pagina la disegna senza
//  scaricare un byte di suono. Costa un decimo di secondo per pezzo e non
//  si rifa' mai — la chiave e' la stessa dei pezzi in casa, cioe' il
//  contenuto: stesso taglio, stessa onda.
const CARTELLA_ONDE = "_onde";
function cartellaOnde() {
  const d = path.join(DIR, CARTELLA_HL, CARTELLA_ONDE);
  assicura(d);
  return d;
}
const ONDE_IN_CORSO = new Set();

function ingressoSolaudio(reg, dentro, fuori, lista) {
  const k = chiavePezzo(reg, dentro, fuori);
  const casa = filePezzo(k);
  if (fs.existsSync(casa)) return ["-ss", String(scartoPezzo(k)), "-i", casa, "-t", String(fuori - dentro)];
  const segs = segmenti(reg);
  if (segs.length) {
    const scelti = segs.filter((sg) => sg.t0 + sg.dur > dentro && sg.t0 < fuori);
    if (!scelti.length) return null;
    fs.writeFileSync(lista, scelti.map((sg) => "file '" + sg.file + "'").join("\n") + "\n");
    return ["-f", "concat", "-safe", "0", "-ss", String(Math.max(0, dentro - scelti[0].t0)),
            "-i", lista, "-t", String(fuori - dentro)];
  }
  const r = R.reg[reg];
  const f = (r && r.arch) ? fonteAl(r, dentro)
          : { via: path.join(cartellaReg(reg), "integrale.mp4"), dentro: dentro, fine: Infinity };
  if (!f.via) return null;
  if (!(r && r.arch) && !fs.existsSync(f.via)) return null;
  return ["-ss", String(f.dentro), "-i", f.via, "-t", String(Math.min(fuori, f.fine) - dentro)];
}

async function calcolaOnda(reg, dentro, fuori) {
  const k = chiavePezzo(reg, dentro, fuori);
  const via = path.join(cartellaOnde(), k + ".json");
  try { return JSON.parse(fs.readFileSync(via, "utf8")); } catch (e) {}
  if (ONDE_IN_CORSO.has(k)) return null;
  ONDE_IN_CORSO.add(k);
  const lista = path.join(cartellaOnde(), k + ".txt");
  try {
    const ingresso = ingressoSolaudio(reg, dentro, fuori, lista);
    if (!ingresso) return null;
    // mono a 8 kHz, grezzo: non serve la qualita', serve la forma. Un pezzo
    // da trenta secondi sono 480 KB che non toccano mai il disco.
    const crudo = await new Promise((ok, no) => {
      const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin"]
        .concat(ingresso)
        .concat(["-vn", "-af", panMono(quantiCanali(R.reg[reg]), 0),
                 "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]),
        { stdio: ["ignore", "pipe", "pipe"] });
      const parti = [];
      let peso = 0;
      pr.stdout.on("data", (d) => { parti.push(d); peso += d.length; if (peso > 40e6) pr.kill("SIGKILL"); });
      pr.on("error", no);
      pr.on("close", () => ok(Buffer.concat(parti)));
      setTimeout(() => { try { pr.kill("SIGKILL"); } catch (e) {} }, 120000);
    });
    const campioni = Math.floor(crudo.length / 2);
    if (!campioni) return null;
    // il PICCO per secchiello, non la media: la media appiattisce tutto e
    // un'onda piatta non dice dove parla il telecronista
    const N = Math.max(60, Math.min(900, Math.round((fuori - dentro) * 12)));
    const onda = new Array(N).fill(0);
    for (let i = 0; i < campioni; i++) {
      const b = Math.min(N - 1, Math.floor(i / campioni * N));
      const v = Math.abs(crudo.readInt16LE(i * 2));
      if (v > onda[b]) onda[b] = v;
    }
    const fuoriOnda = onda.map((v) => Math.round(v / 32768 * 100));
    try { fs.writeFileSync(via, JSON.stringify(fuoriOnda)); } catch (e) {}
    return fuoriOnda;
  } catch (e) {
    console.log("[clip] onda: " + e.message);
    return null;
  } finally {
    ONDE_IN_CORSO.delete(k);
    try { fs.unlinkSync(lista); } catch (e) {}
  }
}

// ── I COMANDI DELL'AUDIO ──────────────────────────────────────────────
function hlAudio(p) {
  const q = seqMia(p);
  normalizzaSeq(q);
  const azione = String(p.azione || "");

  // la traccia intera: muto, solo, lucchetto, volume
  if (azione === "traccia") {
    const n = String(p.traccia || "");
    if (TRACCE_V.concat(TRACCE_A).indexOf(n) < 0) throw new Error("traccia sconosciuta");
    const t = tracceDi(q)[n];
    if (p.muto !== undefined) t.muto = !!p.muto;
    if (p.solo !== undefined) t.solo = !!p.solo;
    if (p.bloccata !== undefined) t.bloccata = !!p.bloccata;
    if (p.gain !== undefined) t.gain = num(p.gain, -60, 12, 0);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q };
  }

  // piu' pezzi in una volta: e' il Canc dopo una selezione a riquadro
  if (azione === "togli" && Array.isArray(p.audio)) {
    const via = {};
    p.audio.forEach((x) => { via[String(x)] = true; });
    const prima = q.audio.length;
    // buttare l'audio di una clip legata vuol dire scollegarlo e basta:
    // il video resta, e resta muto. E' quello che fa Premiere.
    q.audio = q.audio.filter((a) => !via[a.id]);
    toccataAMano(q);
    normalizzaSeq(q);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, tolti: prima - q.audio.length };
  }

  const a = q.audio.filter((y) => y.id === String(p.audio || ""))[0];
  if (!a) throw new Error("pezzo audio sconosciuto");
  const x = a.legato ? q.pezzi.filter((y) => y.id === a.legato)[0] : null;
  toccataAMano(q);

  if (azione === "scollega") {
    delete a.legato;
    a.titolo = (a.titolo || "audio") + " · scollegato";
  } else if (azione === "lega") {
    // si riattacca al video che sta sotto: quello che comincia prima di
    // qui e finisce dopo
    const sotto = q.pezzi.filter((y) => y.t0 <= a.t0 + 0.05 && y.t0 + (y.fuori - y.dentro) >= a.t0 + 0.05)[0];
    if (!sotto) throw new Error("qui sotto non c'e' nessun video a cui legarlo");
    if (q.audio.some((y) => y.id !== a.id && y.legato === sotto.id)) throw new Error("quel video ha gia' il suo audio");
    a.legato = sotto.id;
  } else if (azione === "sposta") {
    if (p.traccia !== undefined) {
      const n = String(p.traccia);
      if (TRACCE_A.indexOf(n) < 0) throw new Error("traccia sconosciuta");
      if (tracceDi(q)[n].bloccata) throw new Error("la traccia " + n + " e' bloccata");
      a.traccia = n;
    }
    if (p.t0 !== undefined) {
      // spostarlo nel tempo lo scollega: un audio legato sta sul suo video
      if (a.legato) delete a.legato;
      a.t0 = Math.round(Math.max(0, num(p.t0, 0, 86400, a.t0)) * 1000) / 1000;
    }
  } else if (azione === "taglia") {
    if (a.legato) delete a.legato;
    const dur = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg)) : 99999;
    // trascinando il bordo sinistro il pezzo si accorcia in testa E si
    // sposta avanti, se no il suono scivolerebbe sotto le immagini
    if (p.dentro !== undefined) {
      const d = num(p.dentro, 0, dur, a.dentro);
      a.t0 = Math.max(0, a.t0 + (d - a.dentro));
      a.dentro = d;
    }
    if (p.fuori !== undefined) a.fuori = num(p.fuori, 0, dur, a.fuori);
    if (a.fuori - a.dentro < 0.2) throw new Error("il pezzo audio diventerebbe vuoto");
  } else if (azione === "togli") {
    q.audio = q.audio.filter((y) => y.id !== a.id);
  } else if (azione === "gain") {
    a.gain = num(p.gain, -60, 12, 0);
  } else if (azione === "muto") {
    a.muto = p.muto === undefined ? !a.muto : !!p.muto;
  } else if (azione === "dissolvenza") {
    const d = Math.max(0.05, a.fuori - a.dentro);
    if (p.entra !== undefined) a.entra = num(p.entra, 0, d, a.entra);
    if (p.esce !== undefined) a.esce = num(p.esce, 0, d, a.esce);
  } else if (azione === "dividi") {
    // la lametta sull'audio da solo
    const t = num(p.a, 0, 86400, 0);
    const fin = a.t0 + (a.fuori - a.dentro);
    if (!(t > a.t0 + 0.15 && t < fin - 0.15)) throw new Error("il taglio cadrebbe sul bordo del pezzo");
    const dopo = Object.assign({}, a, { id: nuovoId("a"), t0: t, dentro: a.dentro + (t - a.t0), entra: 0 });
    delete dopo.legato;
    a.fuori = a.dentro + (t - a.t0);
    a.esce = 0;
    delete a.legato;
    q.audio.push(dopo);
  } else if (azione === "canali") {
    // I CANALI DIVISI. Su questo materiale l'audio e' UNA coppia stereo, e
    // spesso le due meta' non dicono la stessa cosa: da una parte
    // l'ambiente, dall'altra il commento. Divisi diventano due pezzi mono
    // su due tracce, e da li' si spegne quello che non serve.
    if (a.canale) throw new Error("questo pezzo e' gia' un canale solo");
    const destra = Object.assign({}, a, { id: nuovoId("a"), canale: "R", traccia: "A2",
                                          titolo: (a.titolo || "audio") + " · R" });
    delete destra.legato;
    a.canale = "L";
    a.titolo = (a.titolo || "audio") + " · L";
    q.audio.push(destra);
  } else if (azione === "coppia") {
    // QUALE COPPIA DI CANALI. Lo studio arriva con piu' bus sulla stessa
    // pista — programma sui primi due, un altro sul terzo e quarto — e chi
    // monta sceglie quale sentire, come in Premiere si sceglie il canale
    // sorgente. Di suo prende il programma, che e' la prima.
    a.coppia = Math.max(0, parseInt(p.coppia || 0, 10) || 0);
    if (a.titolo) a.titolo = a.titolo.replace(/\s·\scanali\s\d-\d$/, "");
    if (a.coppia) a.titolo = (a.titolo || "audio") + " · canali " + (a.coppia * 2 + 1) + "-" + (a.coppia * 2 + 2);
  } else if (azione === "sotto") {
    // "mettilo sotto quel video": prende il video indicato e ci appoggia
    // sopra questo audio, dall'inizio. E' il gesto che si fa a mano dieci
    // volte al giorno, in un comando solo.
    const v = q.pezzi.filter((y) => y.id === String(p.pezzo || ""))[0];
    if (!v) throw new Error("pezzo video sconosciuto");
    delete a.legato;
    a.t0 = v.t0;
  } else {
    throw new Error("comando audio sconosciuto: " + azione);
  }
  normalizzaSeq(q);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, audio: a.id };
}

function hlElenco(p) {
  const seq = Object.keys(R.seq).map((k) => R.seq[k])
    .filter((q) => !p || !p.reg || q.reg === p.reg)
    .sort((a, b) => b.creata - a.creata);
  // quali pezzi sono gia' in casa: la pagina li riproduce da qui invece che
  // da Parigi, e il salto fra una clip e l'altra sparisce
  const banco = String((p && p.banco) || "").slice(0, 60);
  const prog = String((p && p.prog) || "");
  // Le proposte della macchina le vedono tutti. I montaggi: quelli del
  // progetto aperto, se ce n'e' uno; se no quelli di questo banco.
  const mie = seq.filter((q) => (q.auto && !q.banco) ||
                                (prog ? q.prog === prog : (!q.banco || q.banco === banco)));
  mie.forEach((q) => { try { crescoLaDiretta(q); } catch (e) {} });
  // prima si mettono in riga — cosi' l'audio c'e' — poi si guarda cosa e'
  // gia' in casa: al contrario si segnavano i pezzi di una sequenza che
  // l'audio non ce l'aveva ancora, e le onde risultavano sempre mancanti
  mie.forEach((q) => { try { riallinea(q); } catch (e) {} });
  mie.forEach((q) => { try { segnaPezziLocali(q); } catch (e) {} });
  return { ok: true, seq: mie };
}

// ritocco di un pezzo: sposta l'entrata, l'uscita, il nome — o lo butta
function hlPezzo(p) {
  const q = seqMia(p);
  toccataAMano(q);
  // Piu' pezzi in una volta: e' quello che succede quando si selezionano a
  // riquadro e si preme Canc. Uno alla volta, con una richiesta ciascuno,
  // la sequenza si vedeva sfarinare pezzo per pezzo.
  if (p.togli && Array.isArray(p.pezzi) && p.pezzi.length) {
    const via = {};
    p.pezzi.forEach((x) => { via[String(x)] = true; });
    const prima = q.pezzi.length;
    q.pezzi = q.pezzi.filter((x) => !via[String(x.id)]);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, tolti: prima - q.pezzi.length };
  }
  const i = q.pezzi.findIndex((x) => x.id === p.pezzo);
  if (i < 0) throw new Error("pezzo sconosciuto");
  if (p.togli) { q.pezzi.splice(i, 1); scrivi(); return { ok: true, seq: q }; }
  const x = q.pezzi[i];
  const durata = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg)) : 99999;
  if (p.dentro !== undefined) x.dentro = num(p.dentro, 0, durata, x.dentro);
  if (p.fuori !== undefined) x.fuori = num(p.fuori, 0, durata, x.fuori);
  if (p.titolo !== undefined) x.titolo = String(p.titolo).slice(0, 160);
  if (x.fuori - x.dentro < 0.5) throw new Error("il pezzo diventerebbe vuoto");
  // toccato a mano: la taratura dell'orologio non deve piu' spostarlo
  if (p.dentro !== undefined || p.fuori !== undefined) x.mano = true;
  // e se era il pezzo del vivo, adesso e' tuo: smette di allungarsi da solo.
  // Il vivo si riprende con LIVE, che rimette la coda da qui a adesso.
  if (p.dentro !== undefined || p.fuori !== undefined) delete x.vivo;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// L'INSERISCI DI PREMIERE, ISTANTANEO. Il pezzo entra nella sequenza come
// entrata e uscita SULLA PARTITA, subito: niente file da aspettare. Il
// Programma lo riproduce dal materiale, e il video si rende solo quando
// si esporta — che e' esattamente il modello di Premiere, dove la timeline
// e' fatta di riferimenti e non di file.
async function hlInserisci(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const durataMax = r.durata || durataRegistrata(r.id) || MAX_SECONDI;
  let dentro = num(p.dentro, 0, durataMax, 0), fuori = num(p.fuori, 0, durataMax, 0);
  if (fuori - dentro < 0.5) throw new Error("il punto di uscita deve venire dopo quello di entrata");
  // il pezzo comincia sullo stacco di regia, non in mezzo a un'inquadratura
  let agganciato = 0;
  if (p.aggancia !== false) {
    const a1 = await agganciaStacco(r, dentro, 1.5);
    if (a1.spostato && a1.t < fuori - 0.5) { dentro = a1.t; agganciato = a1.spostato; }
  }
  let q = p.seq ? R.seq[p.seq] : null;
  if (!q) q = Object.keys(R.seq).map((k) => R.seq[k]).filter((x) => x.reg === r.id).sort((a, b) => b.creata - a.creata)[0];
  if (!q) {
    q = { id: nuovoId("s"), reg: r.id, titolo: "HL " + r.titolo, pezzi: [], pre: HL_PRE, post: HL_POST,
          scarto: 0, avvisi: [], creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null };
    R.seq[q.id] = q;
  }
  const pezzo = { id: nuovoId("p"), dentro: dentro, fuori: fuori, base: dentro, stacco: agganciato || 0,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    tipo: "", minuto: "", fonte: "mano", mano: true };
  const dove = (p.dove === undefined || p.dove === null) ? q.pezzi.length
             : Math.max(0, Math.min(q.pezzi.length, Math.round(num(p.dove, 0, 999, 0))));
  ricorda(q);                     // com'era prima che entrasse
  q.pezzi.splice(dove, 0, pezzo);
  toccataAMano(q);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, pezzo: pezzo.id, agganciato: agganciato };
}

// File > Nuova sequenza: una sequenza vuota, con un nome, sulla partita
// aperta. Prima nasceva solo al primo pezzo; a volte si vuole cominciare
// dal titolo, come in Premiere.
// ── LA DIRETTA IN TIMELINE ────────────────────────────────────────────
//
//  Il modo vecchio: si guarda il flusso nel monitor SORGENTE, si segna
//  entrata e uscita, si spedisce il pezzo in timeline. La timeline e' il
//  risultato, e mentre monti il vivo non ce l'hai piu' davanti.
//
//  Il modo nuovo: la diretta STA in timeline. Appena si apre una partita in
//  corso c'e' una sequenza sola — DIRETTA — con dentro un pezzo che va da
//  zero a adesso e che si allunga da solo. Ci si lavora sopra mentre corre:
//  lametta, Canc, sposta. Tagliare non toglie niente alla partita, perche'
//  un pezzo e' solo un'entrata e un'uscita dentro la registrazione, che sul
//  disco resta intera. Quando il montaggio e' finito si salva col suo nome
//  e la DIRETTA torna intera.
//
//  L'allungamento non si scrive: si ricalcola ogni volta che qualcuno
//  guarda. La durata vera e' quella della playlist, e scriverla ogni due
//  secondi sarebbe stato scrivere lo stato duecento volte per tempo.
function crescoLaDiretta(q) {
  if (!q || !q.diretta) return q;
  // il pezzo che cresceva non c'e' piu': la diretta si guarda nel LIVE
  // FEED. Resta la funzione per le sequenze nate prima del cambio.
  const r = R.reg[q.reg];
  if (!r) return q;
  const dur = durataRegistrata(r.id);
  if (r.stato !== "registra") {                 // finita: il pezzo si ferma dov'e' finita
    q.pezzi.forEach((p) => { if (p.vivo) { p.fuori = Math.min(p.fuori, dur) || dur; delete p.vivo; } });
    return q;
  }
  // Il pezzo che cresceva non esiste piu': la diretta si guarda nel LIVE
  // FEED e la timeline e' solo il montaggio. Le sequenze nate prima del
  // cambio se lo portano dietro: si toglie qui, una volta.
  const prima = q.pezzi.length;
  q.pezzi = q.pezzi.filter((p) => !p.vivo);
  if (q.pezzi.length !== prima) {
    console.log("[clip] tolto il pezzo della diretta da \"" + (q.titolo || q.id) + "\": adesso in timeline c'e' solo il montaggio");
    scrivi();
  }
  return q;
}

// La DIRETTA di questa registrazione: se non c'e' nasce, e comunque cresce.
function laDiretta(idReg, banco, prog) {
  const r = R.reg[String(idReg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  if (durataRegistrata(r.id) < 2) throw new Error("questa porta non ha ancora ricevuto niente");
  const b = String(banco || "").slice(0, 60);
  let q = Object.keys(R.seq).map((k) => R.seq[k])
    .find((x) => x.diretta && x.reg === r.id && (!b || !x.banco || x.banco === b));
  if (!q) {
    // LA DIRETTA NON STA IN TIMELINE. Ci stava, ed era giusto finche' il
    // vivo non aveva un monitor suo: adesso ce l'ha (LIVE FEED), e il
    // monitor del montaggio deve mostrare solo le clip. Quindi la sequenza
    // nasce VUOTA e si riempie con quello che si registra fra I e O.
    q = { id: nuovoId("s"), reg: r.id, diretta: true, banco: b,
          titolo: "CLIP \u00b7 " + (r.titolo || ""),
          pezzi: [],
          pre: HL_PRE, post: HL_POST, scarto: 0, avvisi: [],
          creata: Date.now(), chi: "", export: null };
    if (prog) q.prog = String(prog);
    R.seq[q.id] = q;
    console.log("[clip] diretta in timeline: \"" + (r.titolo || r.id) + "\"");
    scrivi(); annuncia(0, "clip");
  }
  return crescoLaDiretta(q);
}

// TORNA AL VIVO. Il cursore lo riporta al bordo la pagina; qui si rimette
// il pezzo, se nel frattempo la coda e' stata tagliata via. Riparte
// dall'ultimo secondo che il montatore ha tenuto: cosi' "torno al punto di
// partenza" e' vero anche dopo aver fatto macelli in mezzo.
function riattaccaLaDiretta(idSeq) {
  const q = R.seq[String(idSeq || "")];
  if (!q || !q.diretta) throw new Error("questa non e' una diretta");
  const r = R.reg[q.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  const dur = durataRegistrata(r.id);
  if (r.stato !== "registra") return { ok: true, seq: crescoLaDiretta(q), finita: true };
  if (!q.pezzi.some((p) => p.vivo)) {
    const fine = q.pezzi.reduce((n, p) => Math.max(n, p.fuori), 0);
    q.pezzi.push({ id: nuovoId("p"), dentro: Math.min(fine, Math.max(0, dur - 1)), fuori: dur, titolo: "diretta", vivo: true });
    scrivi(); annuncia(0, "clip");
  }
  return { ok: true, seq: crescoLaDiretta(q) };
}

// PRENDI: GLI ULTIMI SECONDI, SENZA MUOVERE IL VIDEO.
//  In diretta il gesto vero non e' "scorro indietro, cerco il gol, segno
//  entrata e uscita": e' "il gol e' appena successo, premo un tasto". Qui
//  il pezzo si costruisce sulla coda di quello che e' gia' entrato — dalla
//  durata registrata all'indietro — e finisce in timeline davanti al pezzo
//  del vivo. Chi guarda non ha spostato niente: nessun salto dentro il
//  flusso, quindi niente da ricaricare, quindi nessuna attesa.
//
//  Non si ritaglia nessun file: sono un'entrata e un'uscita, e a
//  riprodurle ci pensa la copia leggera. Il file vero lo fara' semmai
//  l'esportazione, che pesca dai segmenti originali.
function oraCorta(s) {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), q = t % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(q).padStart(2, "0");
}
function prendiDalVivo(p) {
  const q = R.seq[String(p.seq || "")];
  if (!q || !q.diretta) throw new Error("questa non e' una diretta");
  const r = R.reg[q.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  const dur = durataRegistrata(r.id);
  if (dur < 3) throw new Error("non e' ancora entrato niente da prendere");
  const quanti = num(p.quanti, 5, 300, 40);
  const fuori = Math.round(dur * 10) / 10;
  const dentro = Math.max(0, Math.round((fuori - quanti) * 10) / 10);
  const x = { id: nuovoId("p"), dentro: dentro, fuori: fuori, base: dentro, mano: true,
              titolo: "PRESO " + oraCorta(dentro) };
  // davanti al vivo: i pezzi tuoi stanno prima, la diretta resta in coda
  const iv = q.pezzi.findIndex((y) => y.vivo);
  if (iv < 0) q.pezzi.push(x); else q.pezzi.splice(iv, 0, x);
  toccataAMano(q);
  scrivi(); annuncia(0, "clip");
  console.log("[clip] preso dal vivo: " + quanti + "s (" + oraCorta(dentro) + " \u2192 " + oraCorta(fuori) + ")");
  return { ok: true, seq: crescoLaDiretta(q), pezzo: x.id, quanti: Math.round(fuori - dentro) };
}

// SALVA IL MONTATO. Quello che c'e' in timeline diventa una sequenza sua,
// con il nome; la DIRETTA torna intera e riattaccata al vivo.
function salvaIlMontato(p) {
  const q = R.seq[String(p.seq || "")];
  if (!q || !q.diretta) throw new Error("questa non e' una diretta");
  const r = R.reg[q.reg];
  const tenuti = q.pezzi.filter((x) => !x.vivo);
  if (!tenuti.length) throw new Error("in timeline non c'e' ancora niente di tuo: la diretta e' tutta intera");
  const c = JSON.parse(JSON.stringify(q));
  c.id = nuovoId("s");
  c.pezzi = tenuti.map((x) => { const y = Object.assign({}, x); delete y.vivo; return y; });
  c.titolo = String(p.titolo || "").slice(0, 160) || ("MONTATO \u00b7 " + (r && r.titolo || ""));
  c.creata = Date.now();
  c.mano = Date.now();
  delete c.diretta;
  delete c.export; delete c.esportati; delete c.premiere; delete c.grafica; delete c.casa;
  R.seq[c.id] = c;
  // e la diretta torna intera
  const dur = durataRegistrata(q.reg);
  q.pezzi = [{ id: nuovoId("p"), dentro: 0, fuori: Math.max(dur, 1), titolo: "diretta", vivo: r && r.stato === "registra" }];
  if (!(r && r.stato === "registra")) delete q.pezzi[0].vivo;
  scrivi(); annuncia(0, "clip");
  console.log("[clip] montato salvato: \"" + c.titolo + "\" (" + c.pezzi.length + " pezzi)");
  return { ok: true, seq: c, diretta: crescoLaDiretta(q) };
}

// Chiede a inquadra.py dove guarderebbe lui. Legge dal pezzo gia' in casa
// se c'e' (costa solo CPU), se no dal materiale della registrazione.
async function proponiInquadratura(q, x, largo) {
  const k = chiavePezzo(q.reg, x.dentro, x.fuori);
  const casa = filePezzo(k);
  let via, da;
  if (fs.existsSync(casa)) { via = casa; da = scartoPezzo(k); }
  else {
    const r = R.reg[q.reg];
    if (!r) throw new Error("registrazione sconosciuta");
    if (r.arch) {
      const f = fonteAl(r, x.dentro);
      via = f.via; da = f.dentro;
    // LA COPIA LEGGERA E' PROPRIO QUELLO CHE SERVE QUI: l'analisi guarda a
    // 320 di larghezza, e il proxy e' 480. Leggere dalla playlist grande
    // per poi rimpicciolire vuol dire decodificare trenta volte i byte che
    // servono — su un pezzo in mezzo a una partita lunga si aspetta.
    } else if (fs.existsSync(fileProxy(r.id))) via = fileProxy(r.id);
    else if (fs.existsSync(playlistDi(r.id))) via = playlistDi(r.id);
    else throw new Error("di questo pezzo non ho il materiale sottomano");
    if (da === undefined) da = x.dentro;
  }
  const dur = Math.min(300, Math.max(1, x.fuori - x.dentro));
  return await new Promise((ok) => {
    execFile("python3", [INQUADRA_PY, via, String(da), String(dur), String(largo)],
      { timeout: 900000, maxBuffer: 2 * 1024 * 1024 },
      (e, so) => {
        if (e) return ok({ errore: "non sono riuscito a guardare il pezzo" });
        try { ok(JSON.parse(String(so))); } catch (x2) { ok({ errore: "risposta illeggibile" }); }
      });
  });
}

function hlNuova(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const q = { id: nuovoId("s"), reg: r.id,
    titolo: String(p.titolo || "").slice(0, 160) || ("HL " + r.titolo),
    pezzi: [], pre: HL_PRE, post: HL_POST, scarto: 0, avvisi: [],
    creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null };
  R.seq[q.id] = q;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// L'ANNULLA. La pagina tiene lo storico della sequenza e, quando si torna
// indietro, manda qui l'intera lista dei pezzi com'era. Il server non
// ragiona: controlla che ogni pezzo abbia senso e la rimette cosi'.
function hlImposta(p) {
  const q = seqDi(p);
  const durata = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg) || MAX_SECONDI) : MAX_SECONDI;
  const dati = Array.isArray(p.pezzi) ? p.pezzi : [];
  if (dati.length > 400) throw new Error("troppi pezzi");
  const vecchi = {}; q.pezzi.forEach((x) => { vecchi[x.id] = x; });
  q.pezzi = dati.map((d) => {
    const dentro = num(d.dentro, 0, durata, 0), fuori = num(d.fuori, 0, durata, 0);
    if (fuori - dentro < 0.5) return null;
    const base = vecchi[d.id] ? Object.assign({}, vecchi[d.id]) : { id: nuovoId("p"), fonte: "mano", mano: true, tipo: "", minuto: "" };
    return Object.assign(base, { dentro: dentro, fuori: fuori, base: dentro,
      titolo: String(d.titolo || base.titolo || "").slice(0, 160),
      clip: (d.clip && R.clip[d.clip]) ? d.clip : base.clip, mano: true });
  }).filter(Boolean);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// Il Ctrl+K di Premiere: il pezzo si divide dove sta il cursore, e le due
// meta' restano al loro posto. Serve per togliere il centro di un'azione
// lunga senza rifare entrata e uscita da capo.
function hlDividi(p) {
  const q = seqMia(p);
  toccataAMano(q);
  const i = q.pezzi.findIndex((x) => x.id === p.pezzo);
  if (i < 0) throw new Error("pezzo sconosciuto");
  const x = q.pezzi[i];
  const a = +p.a;
  if (!(a > x.dentro + 0.2 && a < x.fuori - 0.2)) throw new Error("il taglio cadrebbe sul bordo del pezzo");
  const nuovo = Object.assign({}, x, { id: nuovoId("p"), dentro: a, base: a, mano: true });
  x.fuori = a; x.mano = true;
  delete x.vivo;                      // la testa e' tua, la coda resta il vivo
  q.pezzi.splice(i + 1, 0, nuovo);
  // la lametta taglia anche l'audio, e la meta' nuova si porta dietro
  // volume, traccia e sfumate: in Premiere si comporta cosi'
  normalizzaSeq(q);
  const suo = (q.audio || []).filter((y) => y.legato === x.id)[0];
  if (suo) {
    q.audio.push(Object.assign({}, suo, { id: nuovoId("a"), legato: nuovo.id, entra: 0 }));
    suo.esce = 0;
  }
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, nuovo: nuovo.id };
}

// Aggiungere un pezzo prendendolo da una clip gia' tagliata: e' il gesto
// del trascinamento. Se una sequenza non c'e' ancora, nasce qui — perche'
// "comincio a montare" non deve essere un comando in piu' da ricordare.
function hlAggiungi(p) {
  const c = R.clip[p.clip];
  if (!c) throw new Error("clip sconosciuta");
  let q = p.seq ? R.seq[p.seq] : null;
  if (!q) {
    q = Object.keys(R.seq).map((k) => R.seq[k])
      .filter((x) => x.reg === c.reg).sort((a, b) => b.creata - a.creata)[0];
  }
  if (!q) {
    const r = R.reg[c.reg];
    q = {
      id: nuovoId("s"), reg: c.reg,
      titolo: "HL " + (r ? r.titolo : ""),
      pezzi: [], pre: HL_PRE, post: HL_POST, scarto: 0, avvisi: [],
      creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null
    };
    R.seq[q.id] = q;
  }
  toccataAMano(q);
  if (q.pezzi.some((x) => x.clip === c.id)) {
    return { ok: true, seq: q, gia: true };     // gia' dentro: non si duplica
  }
  const pezzo = {
    id: nuovoId("p"), dentro: c.dentro, fuori: c.fuori, base: c.dentro,
    titolo: c.titolo, tipo: c.tipo || "", minuto: c.minuto || "",
    fonte: "clip", clip: c.id, mano: true
  };
  // dove lo si e' lasciato cadere, non per forza in fondo
  const dove = (p.dove === undefined || p.dove === null) ? q.pezzi.length
             : Math.max(0, Math.min(q.pezzi.length, Math.round(num(p.dove, 0, 999, 0))));
  ricorda(q);                     // com'era prima che entrasse
  q.pezzi.splice(dove, 0, pezzo);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// Un suggerimento degli appunti entra nella sequenza solo se qualcuno lo
// sceglie. E' la differenza fra un elenco di fatti e un highlight.
function hlSuggerimento(p) {
  const q = seqDi(p);
  const g = (q.suggerimenti || []).find((x) => x.id === p.suggerimento);
  if (!g) throw new Error("suggerimento sconosciuto");
  if (g.secondi === null || g.secondi === undefined) {
    throw new Error("non so dove cade: segna prima il fischio d'inizio");
  }
  const r = R.reg[q.reg];
  const durata = r ? (r.durata || durataRegistrata(q.reg)) : 99999;
  const dentro = Math.max(0, g.secondi - (q.pre || HL_PRE));
  const pezzo = {
    id: nuovoId("p"),
    dentro: dentro, fuori: Math.min(durata, g.secondi + (q.post || HL_POST)),
    base: dentro, titolo: g.titolo, tipo: g.tipo || "", minuto: g.minuto,
    fonte: "appunti", hl: g.hl, peso: g.peso
  };
  q.pezzi.push(pezzo);
  q.pezzi.sort((a, b) => a.dentro - b.dentro);
  q.suggerimenti = q.suggerimenti.filter((x) => x.id !== g.id);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

function hlOrdina(p) {
  const q = seqMia(p);
  toccataAMano(q);
  const ordine = Array.isArray(p.ordine) ? p.ordine : [];
  const mappa = {};
  q.pezzi.forEach((x) => { mappa[x.id] = x; });
  const nuovi = ordine.map((id) => mappa[id]).filter(Boolean);
  q.pezzi.forEach((x) => { if (nuovi.indexOf(x) < 0) nuovi.push(x); });
  q.pezzi = nuovi;
  scrivi();
  return { ok: true, seq: q };
}

// LA TARATURA DELL'OROLOGIO.
// Il flusso arriva in ritardo sul vivo: un secondo in SRT, mezzo minuto
// sull'HLS di un CDN. Quel ritardo e' costante, quindi non si corregge
// evento per evento: si guarda UN pezzo, si dice dov'e' davvero, e tutti
// gli altri si spostano della stessa quantita'. Quelli gia' aggiustati a
// mano non si toccano: chi li ha mossi sapeva quello che faceva.
function hlTaratura(p) {
  const q = seqDi(p);
  let scarto = q.scarto || 0;
  if (p.pezzo) {
    const x = q.pezzi.find((y) => y.id === p.pezzo);
    if (!x) throw new Error("pezzo sconosciuto");
    const vero = num(p.secondi, 0, 999999, x.dentro);
    scarto = Math.round((vero - x.base) * 100) / 100;
  } else {
    scarto = num(p.scarto, -600, 600, 0);
  }
  const durata = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg)) : 99999;
  const dl = scarto - (q.scarto || 0);
  q.pezzi.forEach((x) => {
    if (x.mano || x.fonte === "clip") return;
    x.dentro = Math.max(0, Math.min(durata, x.dentro + dl));
    x.fuori = Math.max(0, Math.min(durata, x.fuori + dl));
  });
  q.scarto = scarto;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

function hlElimina(p) {
  const q = seqDi(p);
  try { fs.rmSync(path.join(DIR, CARTELLA_HL, q.id), { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(path.join(DIR, CARTELLA_HL, q.id + ".xml")); } catch (e) {}
  ["", "_16x9", "_3x4", "_9x16"].forEach((sf) => {
    try { fs.unlinkSync(path.join(DIR, CARTELLA_HL, q.id + sf + ".mp4")); } catch (e) {}
  });
  delete R.seq[q.id];
  scrivi();
  return { ok: true };
}

// ── l'uscita 1: il video montato ──────────────────────────────────────
//
//  Ogni pezzo si ricodifica con gli stessi parametri e poi si incollano:
//  incollare pezzi codificati in modo diverso da' un file che si vede male
//  o non si vede affatto. Si paga qualche secondo di CPU e si dorme la notte.

// TUTTI I FORMATI IN UN COLPO.
// Il montaggio e' lo stesso: cambia solo il ritaglio. Farlo premere tre
// volte vuol dire tre attese e tre occasioni di dimenticarne uno — e chi
// pubblica li vuole tutti, non uno.
async function hlEsportaTutti(q, formati, p2) {
  q.esportati = q.esportati || {};
  for (const f of formati) {
    await hlEsportaVideo(q, f, true, p2);
  }
  q.export = { stato: "pronto", tutti: true, formati: formati,
               fatti: formati.length, quanti: formati.length };
  scrivi(); annuncia(0, "clip");
}

// ══════════════════════════════════════════════════════════════════════
//  I PEZZI IN CASA — la cache del montaggio
// ══════════════════════════════════════════════════════════════════════
//
//  Il materiale sta a Parigi. Oggi ogni scorrimento del Programma, ogni
//  anteprima e ogni esportazione lo vanno a riprendere da li': di qui il
//  salto fra una clip e l'altra, e il traffico che si ripaga ogni volta.
//
//  Un pezzo pero' non cambia finche' non lo tocchi. Quindi si scarica una
//  volta sola, si taglia esatto e si tiene: da quel momento il Programma
//  parte subito, l'esportazione non scarica piu' niente, e un 16:9 senza
//  grafiche esce SENZA RICODIFICARE — si incollano i pezzi e basta.
//
//  Il taglio si fa in ricodifica (non in copia) perche' la copia parte dal
//  fotogramma chiave precedente, e un gol che comincia un secondo prima non
//  e' il gol che hai montato. Meglio pagare una codifica sola, buona, e
//  averlo esatto per sempre.
//  Sulla qualita' bisogna dire la verita': su due core, "medium" costa tre
//  volte il tempo reale — un montato da sette minuti sarebbero venticinque
//  minuti di macchina. Quindi il preset resta veloce, e la qualita' si
//  guadagna dove non costa niente:
//    · i 50 fotogrammi al secondo della sorgente, invece dei 25 forzati
//      (era la perdita piu' visibile, e non serviva a nulla);
//    · una codifica sola invece di due (prima il montato veniva ricodificato
//      per incollarci la grafica, e la seconda mangiava la prima);
//    · lanczos sull'ingrandimento verticale.
//  Chi vuole spendere tempo per una qualita' piu' alta alza le due variabili
//  qui sotto senza toccare il codice.
const CACHE_CRF = process.env.COMOTV_CACHE_CRF || "19";
const CACHE_PRESET = process.env.COMOTV_CACHE_PRESET || "veryfast";

function cartellaPezzi() {
  const d = path.join(DIR, CARTELLA_HL, "_pezzi");
  assicura(d);
  return d;
}
function chiavePezzo(reg, dentro, fuori) {
  return crypto.createHash("sha1")
    .update(String(reg) + "|" + Number(dentro).toFixed(2) + "|" + Number(fuori).toFixed(2))
    .digest("hex").slice(0, 16);
}
function filePezzo(k) { return path.join(cartellaPezzi(), k + ".mp4"); }
function viaPezzo(k) { return "/clip/" + CARTELLA_HL + "/_pezzi/" + k + ".mp4"; }

// Quanti fotogrammi al secondo ha davvero il materiale. La sorgente di
// questo archivio ne ha 50: forzare 25 come si faceva prima buttava via
// meta' dei fotogrammi, ed e' la perdita che sul calcio si vede di piu'.
async function fpsDi(via) {
  return await new Promise((ok) => {
    execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0",
                       "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", via],
      { timeout: 60000 }, (e, out) => {
        if (e) return ok(0);
        const p = String(out).trim().split("/");
        const n = parseFloat(p[0]) / (parseFloat(p[1]) || 1);
        ok(isFinite(n) && n > 0 && n <= 120 ? Math.round(n) : 0);
      });
  });
}

// Il fotogramma chiave a cui si puo' tagliare senza ricodificare: quello
// subito PRIMA del punto voluto. Su questo archivio ce n'e' uno al secondo,
// quindi non si torna mai indietro di piu' di un secondo.
async function chiaveVicina(via, quando) {
  const da = Math.max(0, quando - 2.5);
  const out = await new Promise((ok) => {
    execFile(FFPROBE, ["-v", "error", "-read_intervals", da + "%+3",
                       "-select_streams", "v:0", "-skip_frame", "nokey",
                       "-show_entries", "frame=pts_time", "-of", "csv=p=0", via],
      { timeout: 120000 }, (e, o) => ok(e ? "" : String(o)));
  });
  let k = null;
  out.split(/\s+/).forEach((r) => {
    const t = parseFloat(r);
    if (isFinite(t) && t <= quando + 0.01 && (k === null || t > k)) k = t;
  });
  return k === null ? Math.max(0, quando) : k;
}

function pezziDaScaricare(q) {
  // l'audio scollegato pesca da un altro punto della partita: quel pezzo
  // va portato in casa come gli altri, o all'esportazione non c'e'
  const tutti = (q.pezzi || []).concat((q.audio || []).filter((a) => !a.legato));
  const visti = {};
  return tutti.filter((x) => {
    const k = chiavePezzo(q.reg, x.dentro, x.fuori);
    if (visti[k]) return false;
    visti[k] = true;
    return !fs.existsSync(filePezzo(k));
  });
}

// Porta in casa i pezzi che mancano. NON si ricodifica: si copia il flusso
// cosi' com'e', partendo dal fotogramma chiave prima del punto voluto e
// segnando di quanto si e' partiti prima. Ricodificare a 50 fotogrammi
// costava due volte e mezzo il tempo reale su due core — un montato da
// sette minuti sarebbero stati venti minuti di macchina, per riottenere
// un'immagine peggiore di quella che c'era gia'.
async function costruisciPezzi(q, avanti) {
  const r = R.reg[q.reg];
  if (!r) throw new Error("registrazione sconosciuta");
  await assicuraCanali(r);
  const segs = segmenti(q.reg);
  const usaIntegrale = !segs.length;
  const integrale = (r && r.arch) ? viaArchivio(r) : path.join(cartellaReg(q.reg), "integrale.mp4");
  if (usaIntegrale && !(r && r.arch) && !fs.existsSync(integrale)) throw new Error("non c'e' piu' materiale per questa registrazione");

  const daFare = pezziDaScaricare(q);
  let fatti = 0;
  const uno = async (x) => {
    const k = chiavePezzo(q.reg, x.dentro, x.fuori);
    const fuoriFile = filePezzo(k);
    const parziale = fuoriFile.replace(/\.mp4$/, "-parte.mp4");
    let ingresso, lista = null, scarto = 0;
    if (usaIntegrale) {
      const f = (r && r.arch) ? fonteAl(r, x.dentro)
              : { via: integrale, dentro: x.dentro, fine: Infinity };
      const quanto = Math.min(x.fuori, f.fine) - x.dentro;
      const kf = await chiaveVicina(f.via, f.dentro);
      scarto = Math.max(0, f.dentro - kf);
      ingresso = ["-ss", String(kf), "-i", f.via, "-t", String(scarto + Math.max(0.2, quanto) + 0.2)];
    } else {
      const scelti = segs.filter((sg) => sg.t0 + sg.dur > x.dentro && sg.t0 < x.fuori);
      if (!scelti.length) return;
      lista = parziale.replace(/\.mp4$/, "") + ".txt";
      fs.writeFileSync(lista, scelti.map((sg) => "file '" + sg.file + "'").join("\n") + "\n");
      const da = Math.max(0, x.dentro - scelti[0].t0);
      const kf = await chiaveVicina(lista, da);      // sui segmenti la lista basta a ffprobe
      scarto = Math.max(0, da - kf);
      ingresso = ["-f", "concat", "-safe", "0", "-ss", String(kf), "-i", lista,
                  "-t", String(x.fuori - scelti[0].t0 - kf + 0.2)];
    }
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(ingresso).concat([
      // le piste audio se le porta dietro tutte: il montaggio le vuole
      "-map", "0:v:0?", "-map", "0:a?",
      "-c", "copy", "-movflags", "+faststart", "-y", parziale]);
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1200); });
      pr.on("error", no);
      pr.on("close", (code) => {
        if (lista) { try { fs.unlinkSync(lista); } catch (e) {} }
        code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("ffmpeg " + code)));
      });
    });
    try { fs.renameSync(parziale, fuoriFile); }
    catch (e) { console.log("[clip] in casa: non riesco a rinominare " + parziale + ": " + e.message); throw e; }
    // lo scarto si tiene accanto al file: dice di quanto il pezzo comincia
    // prima, e serve sia a riprodurlo esatto sia a esportarlo esatto
    try { fs.writeFileSync(fuoriFile + ".json", JSON.stringify({ off: Math.round(scarto * 1000) / 1000 })); } catch (e) {}
    const st = (function () { try { return fs.statSync(fuoriFile).size; } catch (e) { return 0; } })();
    console.log("[clip] in casa: " + path.basename(fuoriFile) + " " + Math.round(st / 1e6) + " MB, comincia " +
                scarto.toFixed(2) + "s prima");
    fatti++;
    if (avanti) avanti(fatti, daFare.length);
  };

  for (let i = 0; i < daFare.length; i += 2) {
    await Promise.all(daFare.slice(i, i + 2).map(uno));
  }
  return { fatti: fatti, quanti: daFare.length };
}

function scartoPezzo(k) {
  try { return JSON.parse(fs.readFileSync(filePezzo(k) + ".json", "utf8")).off || 0; }
  catch (e) { return 0; }
}

// Il segno che la pagina legge: quali pezzi sono gia' in casa.
function segnaPezziLocali(q) {
  let quanti = 0;
  (q.pezzi || []).forEach((x) => {
    const k = chiavePezzo(q.reg, x.dentro, x.fuori);
    if (fs.existsSync(filePezzo(k))) {
      x.locale = viaPezzo(k);
      x.scarto = scartoPezzo(k);        // di quanto il file comincia prima
      quanti++;
    } else { delete x.locale; delete x.scarto; }
  });
  // e i pezzi audio: uno scollegato pesca da un altro punto della partita,
  // e per farlo sentire alla pagina serve il suo file, non quello del video
  (q.audio || []).forEach((a) => {
    const k = chiavePezzo(q.reg, a.dentro, a.fuori);
    if (fs.existsSync(filePezzo(k))) { a.locale = viaPezzo(k); a.scarto = scartoPezzo(k); }
    else { delete a.locale; delete a.scarto; }
    a.onda = fs.existsSync(path.join(cartellaOnde(), k + ".json"));
  });
  return quanti;
}

async function hlInCasa(p) {
  const q = seqDi(p);
  if (!q.pezzi.length) throw new Error("la sequenza e' vuota");
  if (q.casa && q.casa.stato === "lavora") return { ok: true, casa: q.casa };
  if (p.solo === "stato") {
    segnaPezziLocali(q);
    return { ok: true, seq: q, mancano: pezziDaScaricare(q).length };
  }
  q.casa = { stato: "lavora", fatti: 0, quanti: pezziDaScaricare(q).length };
  scrivi(); annuncia(0, "clip");
  costruisciPezzi(q, (f, n) => { q.casa = { stato: "lavora", fatti: f, quanti: n }; scrivi(); annuncia(0, "clip"); })
    .then((e) => {
      segnaPezziLocali(q);
      q.casa = { stato: "pronto", fatti: e.fatti, quanti: e.quanti, quando: Date.now() };
      console.log("[clip] in casa: " + e.fatti + " pezzi di \"" + (q.titolo || q.id) + "\"");
      scrivi(); annuncia(0, "clip");
    })
    .catch((err) => { q.casa = { stato: "errore", errore: err.message }; scrivi(); annuncia(0, "clip"); });
  return { ok: true, casa: q.casa };
}


// ── IL MIX ────────────────────────────────────────────────────────────
//  Finche' l'audio e' quello del video non c'e' niente da mescolare: si
//  incolla, come si e' sempre fatto, e l'esportazione dura dieci secondi.
//  Quando invece c'e' un audio sotto un altro video, o un volume, o una
//  sfumata, o un canale da solo, allora l'audio va costruito: ogni pezzo al
//  suo secondo (adelay), col suo volume, e tutti sommati (amix). Non e' un
//  effetto, e' quello che fa un mixer.
function costruisciMix(q, iBase) {
  normalizzaSeq(q);
  const canaliQui = quantiCanali(R.reg[q.reg]);
  const suona = tracceCheSuonano(q);
  const ingressi = [];
  const uscite = [];
  let catena = "", n = 0, saltati = 0;
  (q.audio || []).forEach((a) => {
    if (a.muto || !suona[a.traccia]) return;
    const t = (q.tracce && q.tracce[a.traccia]) || {};
    const k = chiavePezzo(q.reg, a.dentro, a.fuori);
    const casa = filePezzo(k);
    const dur = Math.max(0.05, a.fuori - a.dentro);
    const idx = iBase + n;
    // SE IN CASA NON C'E', SI VA A PRENDERLO DOVE STA. Prima un pezzo audio
    // che non fosse gia' sul disco veniva semplicemente saltato: il mix
    // usciva senza quella voce, e senza dirlo. Oggi l'esportazione porta in
    // casa da sola prima di montare, quindi non capitava — ma era una
    // dipendenza implicita fra due passaggi lontani, e un montato muto te ne
    // accorgi quando e' gia' online.
    let off = 0;
    if (fs.existsSync(casa)) {
      off = scartoPezzo(k);
      ingressi.push("-ss", String(off), "-t", String(dur), "-i", casa);
    } else {
      const rq = R.reg[q.reg];
      const f = rq && rq.arch ? fonteAl(rq, a.dentro)
              : { via: path.join(cartellaReg(q.reg), "integrale.mp4"), dentro: a.dentro };
      if (!f || !f.via || (!rq.arch && !fs.existsSync(f.via))) { saltati++; return; }
      ingressi.push("-ss", String(f.dentro), "-t", String(dur), "-i", f.via);
    }
    // da quale pista: 0 se ce n'e' una sola, come e' oggi su questo
    // materiale. Il giorno che la regia ne manda tre, qui si sceglie.
    const pista = Math.max(0, parseInt(a.sorg || 0, 10) || 0);
    let f = "[" + idx + ":a:" + pista + "]aresample=48000";
    // il canale da solo: si prende una meta' della coppia e la si rimette
    // su tutte e due, se no il suono esce da un orecchio
    // la coppia di canali, e dentro la coppia l'eventuale mezzo canale:
    // "aformat=stereo" qui pieghegava un sei canali su due sommando i bus
    f += "," + panDi(canaliQui, a.coppia, a.canale);
    const g = (a.gain || 0) + (t.gain || 0);
    if (g) f += ",volume=" + g.toFixed(2) + "dB";
    if (a.entra > 0.01) f += ",afade=t=in:st=0:d=" + a.entra.toFixed(2);
    if (a.esce > 0.01) f += ",afade=t=out:st=" + Math.max(0, dur - a.esce).toFixed(2) + ":d=" + a.esce.toFixed(2);
    const ms = Math.round(Math.max(0, a.t0 || 0) * 1000);
    if (ms) f += ",adelay=" + ms + ":all=1";
    n++;
    f += "[am" + n + "]";
    catena += f + ";";
    uscite.push("[am" + n + "]");
  });
  if (saltati) console.log("[clip] mix: " + saltati + " pezzi audio senza materiale, lasciati fuori");
  if (!uscite.length) return { muta: true, saltati: saltati };
  catena += uscite.length === 1
    ? uscite[0] + "anull[amix];"
    // normalize=0: sommare, non dividere. Con la normalizzazione accesa due
    // tracce a volume pieno escono a meta' ciascuna, e chi ha alzato il
    // commento se lo ritrova piu' basso di prima.
    : uscite.join("") + "amix=inputs=" + uscite.length + ":duration=longest:normalize=0[amix];";
  return { ingressi: ingressi, catena: catena, quanti: n };
}

async function hlEsportaVideo(q, formato, dentroUnGiro, p2) {
  const dir = path.join(DIR, CARTELLA_HL, q.id);
  assicura(dir);
  if (!q.pezzi.length) throw new Error("nessun pezzo da esportare");
  const grafiche0 = (q.grafiche || []).filter((g) => {
    try { return fs.existsSync(path.join(cartellaGrafiche(), g.id + ".png")); } catch (e) { return false; }
  });

  await assicuraCanali(R.reg[q.reg]);
  const ritaglio = (FORMATI[formato] || FORMATI["16:9"]).vf;
  q.export = { stato: "lavora", formato: formato, fatti: 0, quanti: q.pezzi.length, file: "",
               fase: "porto in casa i pezzi", tutti: !!dentroUnGiro };
  scrivi(); annuncia(0, "clip");

  // PRIMO: i pezzi in casa. Se ci sono gia' non si scarica niente; se
  // mancano si scaricano una volta e restano.
  const esito = await costruisciPezzi(q, (f, n) => {
    q.export.fatti = f; q.export.quanti = n || q.pezzi.length;
    q.export.fase = "porto in casa i pezzi";
    q.export.avanza = n ? f / n * 0.5 : 0.5;
    scrivi(); annuncia(0, "clip");
  });
  segnaPezziLocali(q);

  // ── INQUADRA DA SOLO QUELLO CHE NON E' STATO INQUADRATO ─────────────
  //  Su un verticale il ritaglio fermo al centro lascia fuori il gioco: e'
  //  il difetto che si vede in ogni shorts fatto finora. Chi esporta non
  //  deve ricordarsi di premere "Proponi" pezzo per pezzo: lo si fa qui,
  //  una volta, sui pezzi che non hanno ancora un'inquadratura loro. Chi
  //  ha scelto "fermo al centro" non viene toccato, perche' quella e' una
  //  decisione scritta. E dove seguire non serve, la proposta e' comunque
  //  "fermo": la macchina lo misura prima di muovere qualcosa.
  const largoF = LARGHEZZA_FORMATO[formato];
  if (largoF && !(p2 && p2.senzaInquadratura)) {
    const daFare = q.pezzi.filter((x) => !(x.inquadra && x.inquadra[formato]));
    for (let i = 0; i < daFare.length; i++) {
      q.export.fase = "guardo dove inquadrare (" + (i + 1) + " di " + daFare.length + ")";
      q.export.avanza = 0.5;
      scrivi(); annuncia(0, "clip");
      try {
        const pr = await proponiInquadratura(q, daFare[i], largoF);
        if (pr && !pr.errore) {
          daFare[i].inquadra = daFare[i].inquadra || {};
          daFare[i].inquadra[formato] = (pr.punti && pr.punti.length)
            ? { z: 1, punti: pr.punti.map((k) => ({ t: k.t, x: k.x, y: 0.5 })) }
            : { z: 1, punti: [], fisso: true };
        }
      } catch (e) { console.log("[clip] inquadratura: " + e.message); }
    }
    if (daFare.length) { scrivi(); annuncia(0, "clip"); }
  }

  // I pezzi in casa cominciano un po' prima del punto voluto (si e' copiato
  // dal fotogramma chiave). Qui si taglia esatto: e' l'unica codifica del
  // giro, e non scarica niente perche' il materiale e' gia' sul disco.
  // VELOCE O ESATTO. Su due core ricodificare a 50 fotogrammi costa due
  // volte e mezzo il tempo reale: un montato da sette minuti sono venti
  // minuti di macchina. Ma i pezzi in casa cominciano al massimo un secondo
  // prima del punto voluto, e su una clip con trenta secondi di maniglia un
  // secondo non si vede. Quindi: veloce di norma (si incolla e basta,
  // qualita' della sorgente intatta), esatto quando lo si chiede.
  //  Il ritaglio verticale e le grafiche impongono comunque la codifica.
  // l'audio montato a parte non impedisce di andare veloci sul VIDEO: i
  // pezzi restano quelli, si incollano come sempre, e il suono si costruisce
  // a fianco. Quello che cambia e' solo l'ultimo passaggio.
  const mixato = !audioSemplice(q);
  // ...con un'eccezione che il primo montaggio sonoro ha fatto venire fuori
  // subito. Incollare in fretta vuol dire attaccare i pezzi cosi' come sono
  // in casa, e quelli cominciano fino a un secondo prima del punto voluto:
  // sul video non si vede, ma il suono e' posato al SECONDO della timeline,
  // e quel secondo in piu' per pezzo lo sposta. Su quattro pezzi erano
  // cinque secondi di scarto alla fine. Quando c'e' un audio da mescolare
  // il video si taglia esatto: si paga una codifica, ma il suono sta dove
  // e' stato messo.
  // I buchi si riempiono di nero, e il nero va incollato ai pezzi: incollare
  // in fretta vorrebbe dire pretendere che il nero abbia esattamente lo
  // stesso codificatore del materiale. Con i buchi si taglia esatto.
  const buchi = buchiDi(q);
  const veloce = (p2 && p2.esatto) ? false : (!ritaglio && !grafiche0.length && !mixato && !buchi.length);
  const dir2 = path.join(dir, "tagli");
  assicura(dir2);
  const parti = [];
  let orologio = 0;                     // dove siamo arrivati sulla timeline
  for (let i = 0; i < q.pezzi.length; i++) {
    const x = q.pezzi[i];
    const k = chiavePezzo(q.reg, x.dentro, x.fuori);
    const casa = filePezzo(k);
    if (!fs.existsSync(casa)) continue;
    // il buco davanti a questo pezzo: nero, per la durata giusta
    if ((x.t0 || 0) > orologio + 0.04) { parti.push({ vuoto: (x.t0 || 0) - orologio }); }
    orologio = Math.max(orologio, (x.t0 || 0) + (x.fuori - x.dentro));
    const off = scartoPezzo(k), dur = x.fuori - x.dentro;
    // l'inquadratura di QUESTO pezzo: se ha i suoi punti, il ritaglio segue
    const ritaglioQui = ritaglioDelPezzo(formato, x.inquadra && x.inquadra[formato]);
    if (veloce) { parti.push({ file: casa }); q.export.fatti = i + 1; q.export.fase = "preparo"; continue; }
    const esatto = path.join(dir2, "p" + String(i + 1).padStart(3, "0") + ".mp4");
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", String(off), "-i", casa, "-t", String(dur)];
    // se il pezzo comincia gia' dove deve, si copia e basta: niente da fare
    const copiabile = off < 0.08 && !ritaglioQui;
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args.concat(copiabile
        ? ["-c", "copy", "-movflags", "+faststart", "-y", esatto]
        // lanczos va IN CODA alla scala, non in testa: scritto davanti
        // ffmpeg lo prendeva come unico argomento e l'ingrandimento saltava,
        // e il verticale usciva 608x1080 invece di 1080x1920
        : (ritaglioQui ? ["-vf", ritaglioQui.replace(/(scale=\d+:\d+)/, "$1:flags=lanczos")] : [])
          .concat(["-c:v", "libx264", "-preset", CACHE_PRESET, "-crf", CACHE_CRF, "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
           "-movflags", "+faststart", "-y", esatto])), { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1200); });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("ffmpeg " + code))));
    });
    parti.push({ file: esatto });
    q.export.fatti = i + 1;
    q.export.fase = "taglio al fotogramma";
    q.export.avanza = 0.5 + 0.4 * ((i + 1) / q.pezzi.length);
    scrivi(); annuncia(0, "clip");
  }
  if (!parti.filter((z) => z.file).length) throw new Error("nessun pezzo da esportare");

  // IL NERO DEI BUCHI. Si fabbrica sulla misura del primo pezzo vero —
  // stessa larghezza, stessa altezza, stessi fotogrammi al secondo, stesso
  // suono muto — se no l'incollatura rifiuta di attaccarlo.
  if (parti.some((z) => z.vuoto)) {
    const primo = parti.filter((z) => z.file)[0].file;
    const mis = await probeMisure(primo);
    const fps = (await fpsDi(primo)) || 25;
    const LV = mis.w || 1920, LH = mis.h || 1080;
    for (let i = 0; i < parti.length; i++) {
      if (!parti[i].vuoto) continue;
      const dur = Math.max(0.04, parti[i].vuoto);
      const nero = path.join(dir2, "vuoto" + String(i).padStart(3, "0") + ".mp4");
      await new Promise((si, no) => {
        const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
          "-f", "lavfi", "-i", "color=c=black:s=" + LV + "x" + LH + ":r=" + fps + ":d=" + dur.toFixed(3),
          "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-t", dur.toFixed(3),
          "-c:v", "libx264", "-preset", "veryfast", "-crf", CACHE_CRF, "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
          "-movflags", "+faststart", "-y", nero], { stdio: ["ignore", "ignore", "pipe"] });
        let coda = "";
        pr.stderr.on("data", (d) => { coda = (coda + d).slice(-800); });
        pr.on("error", no);
        pr.on("close", (code) => code === 0 ? si() : no(new Error(ultimaRiga(coda) || "nero " + code)));
      });
      parti[i] = { file: nero, era: "vuoto" };
    }
    console.log("[clip] esporto \"" + (q.titolo || q.id) + "\": " + buchi.length + " buco/hi riempiti di nero");
  }

  const suffisso = "_" + String(formato).replace(":", "x");
  const finale = path.join(DIR, CARTELLA_HL, q.id + suffisso + ".mp4");
  const grafiche = grafiche0;

  // SECONDO: si incolla. Un 16:9 senza grafiche non ha niente da
  // ricodificare — i pezzi sono gia' come devono essere — quindi si
  // attaccano e basta: secondi invece di minuti, e zero perdita.
  const listaFin = path.join(dir, "tutti.txt");
  fs.writeFileSync(listaFin, parti.map((x) => "file '" + x.file + "'").join("\n") + "\n");
  q.export.avanza = 0.92;
  q.export.fase = grafiche.length ? "incollo le grafiche" : (veloce ? "monto" : "monto");
  scrivi(); annuncia(0, "clip");

  const soloIncollare = !grafiche.length && !mixato;
  if (soloIncollare) {
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "concat", "-safe", "0", "-i", listaFin, "-c", "copy",
        "-movflags", "+faststart", "-y", finale], { stdio: "ignore" });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error("incollatura fallita")));
    });
  } else if (mixato && !grafiche.length) {
    // SOLO L'AUDIO E' CAMBIATO. Il video si copia com'e' — nessuna
    // ricodifica, nessuna perdita — e il suono si costruisce accanto.
    q.export.fase = "monto l'audio";
    scrivi(); annuncia(0, "clip");
    const mix = costruisciMix(q, 1);
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "concat", "-safe", "0", "-i", listaFin]
      .concat(mix.muta ? [] : mix.ingressi)
      .concat(mix.muta
        ? ["-map", "0:v", "-an"]
        : ["-filter_complex", mix.catena.replace(/;$/, ""), "-map", "0:v", "-map", "[amix]",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000"])
      .concat(["-c:v", "copy", "-movflags", "+faststart", "-y", finale]);
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1500); });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("ffmpeg " + code))));
    });
  } else {
    // TERZO: un solo passaggio per tutto — ritaglio, ingrandimento e
    // grafiche insieme. Prima erano due codifiche in fila, e la seconda
    // mangiava quello che aveva fatto la prima.
    const mis = await probeMisure(parti[0].file);
    const VW = mis.w || 1920, VH = mis.h || 1080;
    let catena = "";
    const ingressi = [];
    let ultimo = "0:v";
    {
      const dopoW = VW, dopoH = VH;
      grafiche.forEach((g, i) => {
        ingressi.push("-i", path.join(cartellaGrafiche(), g.id + ".png"));
        const kk = Math.min(dopoW / (g.w || dopoW), dopoH / (g.h || dopoH));
        const w2 = Math.max(2, Math.round((g.w || dopoW) * kk / 2) * 2);
        const h2 = Math.max(2, Math.round((g.h || dopoH) * kk / 2) * 2);
        const x = Math.round((dopoW - w2) / 2), y = Math.round((dopoH - h2) / 2);
        const usc = (i === grafiche.length - 1) ? "v" : ("g" + i + "o");
        catena += "[" + (i + 1) + ":v]scale=" + w2 + ":" + h2 + "[g" + i + "];" +
                  "[" + ultimo + "][g" + i + "]overlay=" + x + ":" + y +
                  ":enable='between(t," + g.dentro.toFixed(2) + "," + g.fuori.toFixed(2) + ")'" +
                  ":format=auto[" + usc + "];";
        ultimo = usc;
      });
    }
    catena = catena.replace(/;$/, "");
    // l'audio: quello del video se nessuno l'ha toccato, il mix se invece
    // c'e' un montaggio sonoro sotto
    const mix = mixato ? costruisciMix(q, 1 + grafiche.length) : null;
    const catenaTutta = catena + (mix && !mix.muta ? ";" + mix.catena.replace(/;$/, "") : "");
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "concat", "-safe", "0", "-i", listaFin].concat(ingressi)
      .concat(mix && !mix.muta ? mix.ingressi : []).concat([
      "-filter_complex", catenaTutta, "-map", "[" + ultimo + "]"])
      .concat(mix ? (mix.muta ? ["-an"] : ["-map", "[amix]"]) : ["-map", "0:a?"]).concat([
      "-c:v", "libx264", "-preset", CACHE_PRESET, "-crf", CACHE_CRF, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", finale]);
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1500); });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("ffmpeg " + code))));
    });
  }

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  const d = await probe(finale);
  if (!q.mini) {
    const mini = await miniatura(finale, path.join(DIR, CARTELLA_HL, q.id + ".jpg"), (d.durata || 6) / 3);
    q.mini = mini ? "/clip/" + CARTELLA_HL + "/" + q.id + ".jpg" : "";
  }
  q.esportati = q.esportati || {};
  q.esportati[formato] = {
    file: "/clip/" + CARTELLA_HL + "/" + q.id + suffisso + ".mp4",
    durata: d.durata ? Math.round(d.durata * 10) / 10 : 0, peso: d.peso || 0,
    // l'istante serve alla pagina per accorgersi che questa e' un'uscita
    // NUOVA: rifacendo lo stesso formato il nome del file non cambia, e
    // senza un istante l'avviso "pronto" non scattava piu'
    quando: Date.now(), copiato: soloIncollare, veloce: veloce
  };
  q.esportati[formato].nome = nomeScaricoSeq(q, R.reg[q.reg], formato, ".mp4");
  q.export = { stato: "pronto", formato: formato, fatti: q.pezzi.length, quanti: q.pezzi.length,
               fase: "pronto", file: q.esportati[formato].file,
               durata: q.esportati[formato].durata, peso: q.esportati[formato].peso };
  scrivi(); annuncia(0, "clip");
  return q.esportati[formato];
}

// Il testo che finisce dentro l'XML. Un titolo come "GOL di Galvan 3-1
// <replay>" o un nome di partita con la & spaccano il file, e Premiere si
// rifiuta di aprirlo senza dire perche'. Si sostituiscono i cinque
// caratteri che in XML vogliono dire qualcos'altro, e si buttano i
// caratteri di controllo, che in un titolo non ci devono stare.
function xmlEsc(t) {
  return String(t === undefined || t === null ? "" : t)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function hlEsportaPremiere(q, percorso) {
  const r = R.reg[q.reg];
  if (r && r.integrale === "sospetto" && !percorso) {
    throw new Error("l'integrale non torna con la registrazione (" + (r.integraleErrore || "") +
      "): in Premiere i tagli cadrebbero nel punto sbagliato. Rifallo, o indica a mano il file da usare.");
  }
  const integrale = path.join(cartellaReg(q.reg), "integrale.mp4");
  const c1 = fs.existsSync(integrale);
  const nome = (r ? r.titolo.replace(/[^A-Za-z0-9 _-]/g, "") : "integrale") + ".mp4";
  // per una partita d'archivio il file che Premiere deve cercare e' quello
  // del secchio: il montatore ce l'ha gia' su Cyberduck con quel nome
  const nomeArch = (r && r.arch) ? path.basename(r.arch.chiave) : "";
  const via = String(percorso || "").trim() || (c1 ? integrale : (nomeArch || nome));
  // UN FILE PER PEZZO. La partita intera sta in piu' file e ognuno ha il
  // suo tempo interno: dichiararne uno solo mandava tutti i tagli del
  // secondo tempo nel primo, spostati di un'ora. Qui ogni pezzo diventa un
  // <file> suo, e il taglio si conta dall'inizio del file a cui appartiene.
  const arch = (r && r.arch && !c1 && !percorso) ? pezziArch(r) : null;
  const cartellaVia = via.indexOf("/") >= 0 ? via.slice(0, via.lastIndexOf("/") + 1) : "";
  const dovE = (t) => {
    if (!arch) return { id: "file-1", nome: nome, via: via, da: 0 };
    const x = pezzoAl(r, t) || { i: 0, pezzo: arch[0], da: 0 };
    return { id: "file-" + (x.i + 1), nome: path.basename(x.pezzo.chiave),
             via: cartellaVia + path.basename(x.pezzo.chiave), da: x.da || 0 };
  };
  const info = c1 ? await probe(integrale) : {};
  const segs = segmenti(q.reg);
  const daMisurare = c1 ? integrale : (r && r.arch) ? viaArchivio(r)
                   : (segs.length ? segs[Math.floor(segs.length / 2)].file : "");
  let fps = daMisurare ? await probeFps(daMisurare) : 0;
  if (!fps || fps < 5 || fps > 240) fps = 25;
  const ntsc = (Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 23.976) < 0.05 ||
                Math.abs(fps - 59.94) < 0.05) ? "TRUE" : "FALSE";
  const fpsInt = Math.round(fps);
  const frame = (s) => Math.round(s * fps);
  const durataFile = frame(info.durata || (r && r.durata) || 7200);
  const rate = "<rate><timebase>" + fpsInt + "</timebase><ntsc>" + ntsc + "</ntsc></rate>";
  const tc = "<timecode>" + rate + "<string>00:00:00:00</string><frame>0</frame>" +
             "<displayformat>NDF</displayformat></timecode>";
  const indirizzo = (v) => "file://localhost" + (v.charAt(0) === "/" ? "" : "/") + encodeURI(v).replace(/#/g, "%23");
  const url = indirizzo(via);

  // LE TRACCE ESCONO COME SONO. Prima l'XML raccontava sempre la stessa
  // storia — un video su V1 e due canali su A1/A2, incollati sotto — anche
  // quando sulla timeline l'audio era da un'altra parte. Adesso ogni pezzo
  // audio esce sulla sua traccia, al suo secondo, col suo volume, e il
  // legame c'e' solo dove c'e' davvero: aprendo il progetto in Premiere si
  // ritrova il montaggio, non la sua ombra.
  normalizzaSeq(q);
  const iTraccia = (n2) => Math.max(1, TRACCE_A.indexOf(n2) + 1);
  const quanteA = Math.max(2, (q.audio || []).reduce((m, a) => Math.max(m, iTraccia(a.traccia)), 1));
  const audioTr = [];
  for (let k = 0; k < quanteA; k++) audioTr.push("");
  // il numero della clip dentro la sua traccia: serve ai <link>
  const posti = {};
  const contati = {};
  q.pezzi.forEach((x, i) => { contati.v = (contati.v || 0) + 1; posti["v:" + x.id] = contati.v; });
  (q.audio || []).slice().sort((a, b) => (a.t0 || 0) - (b.t0 || 0)).forEach((a) => {
    const t = "a" + iTraccia(a.traccia);
    contati[t] = (contati[t] || 0) + 1;
    posti["a:" + a.id] = contati[t];
  });
  // il volume come lo scrive Premiere: un moltiplicatore, non i decibel
  const livello = (db) => {
    if (!db) return "";
    const v = Math.min(3.98107, Math.max(0, Math.pow(10, db / 20)));
    return '<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid>' +
           '<effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype>' +
           '<mediatype>audio</mediatype><pproBypass>false</pproBypass>' +
           '<parameter authoringApp="PremierePro"><parameterid>level</parameterid><name>Level</name>' +
           '<valuemin>0</valuemin><valuemax>3.98107</valuemax><value>' + v.toFixed(5) + '</value>' +
           '</parameter></effect></filter>';
  };

  let video = "", marker = "", pos = 0;
  const gia = {};
  const schedaFile = (t) => {
    const d = dovE(t || 0);
    if (gia[d.id]) return '<file id="' + d.id + '"/>';
    gia[d.id] = true;
    return '<file id="' + d.id + '"><name>' + xmlEsc(d.nome) + '</name><pathurl>' + xmlEsc(indirizzo(d.via)) + '</pathurl>' + rate +
      '<duration>' + durataFile + '</duration>' + tc +
      '<media><video><samplecharacteristics><width>1920</width><height>1080</height>' +
      '</samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>';
  };

  q.pezzi.forEach((x, i) => {
    // il taglio si conta dall'inizio del SUO file, non della partita
    const dv = dovE(x.dentro);
    const inF = frame(x.dentro - dv.da), outF = frame(x.fuori - dv.da);
    const durF = Math.max(1, outF - inF);
    const start = frame(x.t0 || 0), end = start + durF;
    pos = Math.max(pos, end);
    const n2 = xmlEsc(x.titolo);
    // il legame lo dichiarano tutti e due i lati, video e audio: senza, in
    // Premiere si sposta uno solo dei due
    const suoi = (q.audio || []).filter((a) => a.legato === x.id);
    let link = '<link><linkclipref>v' + i + '</linkclipref><mediatype>video</mediatype>' +
               '<trackindex>1</trackindex><clipindex>' + posti["v:" + x.id] + '</clipindex></link>';
    suoi.forEach((a) => {
      link += '<link><linkclipref>' + a.id + '</linkclipref><mediatype>audio</mediatype>' +
              '<trackindex>' + iTraccia(a.traccia) + '</trackindex><clipindex>' + posti["a:" + a.id] + '</clipindex></link>';
    });
    video += '<clipitem id="v' + i + '"><name>' + n2 + '</name><duration>' + durF + '</duration>' + rate +
             '<start>' + start + '</start><end>' + end + '</end><in>' + inF + '</in><out>' + outF + '</out>' +
             schedaFile(x.dentro) + '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>' +
             (suoi.length ? link : "") + '</clipitem>';
    marker += '<marker><name>' + n2 + '</name><comment>' + xmlEsc(x.fonte || "") +
              '</comment><in>' + start + '</in><out>-1</out></marker>';
  });

  (q.audio || []).forEach((a) => {
    const da = dovE(a.dentro).da;
    const inF = frame(a.dentro - da), outF = frame(a.fuori - da);
    const durF = Math.max(1, outF - inF);
    const start = frame(a.t0 || 0), end = start + durF;
    pos = Math.max(pos, end);
    const k = iTraccia(a.traccia) - 1;
    const iv = q.pezzi.findIndex((x) => x.id === a.legato);
    let link = "";
    if (iv >= 0) {
      link = '<link><linkclipref>v' + iv + '</linkclipref><mediatype>video</mediatype>' +
             '<trackindex>1</trackindex><clipindex>' + posti["v:" + q.pezzi[iv].id] + '</clipindex></link>' +
             '<link><linkclipref>' + a.id + '</linkclipref><mediatype>audio</mediatype>' +
             '<trackindex>' + (k + 1) + '</trackindex><clipindex>' + posti["a:" + a.id] + '</clipindex></link>';
    }
    // il canale diviso: L e' il primo, R il secondo
    const sorg = a.canale === "R" ? 2 : 1;
    audioTr[k] += '<clipitem id="' + a.id + '"><name>' + xmlEsc(a.titolo || "audio") + '</name>' +
      '<duration>' + durF + '</duration>' + rate +
      '<start>' + start + '</start><end>' + end + '</end><in>' + inF + '</in><out>' + outF + '</out>' +
      (a.muto ? '<enabled>FALSE</enabled>' : '') + schedaFile(a.dentro) +
      '<sourcetrack><mediatype>audio</mediatype><trackindex>' + sorg + '</trackindex></sourcetrack>' +
      link + livello(a.gain || 0) + '</clipitem>';
  });

  const tracceXml = audioTr.map((t, k) => {
    const st = (q.tracce && q.tracce[TRACCE_A[k]]) || {};
    return '<track>' + t + '<enabled>' + (st.muto ? "FALSE" : "TRUE") + '</enabled>' +
           '<locked>' + (st.bloccata ? "TRUE" : "FALSE") + '</locked></track>';
  }).join("");

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n' +
    '<sequence id="sequence-1"><name>' + xmlEsc(q.titolo) + '</name><duration>' + pos + '</duration>' + rate + tc + '\n' +
    '<media><video><format><samplecharacteristics>' + rate + '<width>1920</width><height>1080</height>' +
    '</samplecharacteristics></format><track>' + video + '</track></video>' +
    '<audio>' + tracceXml + '</audio></media>\n' + marker + '\n</sequence>\n</xmeml>\n';

  const file = path.join(DIR, CARTELLA_HL, q.id + ".xml");
  fs.writeFileSync(file, xml);
  q.premiere = {
    stato: "pronto", file: "/clip/" + CARTELLA_HL + "/" + q.id + ".xml",
    media: via, integrale: c1, fps: Math.round(fps * 100) / 100
  };
  q.premiere.nome = nomeScaricoSeq(q, R.reg[q.reg], "", ".xml");
  scrivi(); annuncia(0, "clip");
  return q.premiere;
}

async function hlEsporta(p) {
  const q = seqDi(p);
  if (!q.pezzi.length) throw new Error("la sequenza e' vuota");
  if (String(p.come) === "premiere") {
    return { ok: true, premiere: await hlEsportaPremiere(q, p.percorso) };
  }
  if (q.export && q.export.stato === "lavora") return { ok: true, export: q.export };
  const elenco = Array.isArray(p.formati) ? p.formati.filter((f) => FORMATI[f]) : [];
  const formati = elenco.length ? elenco
                : [FORMATI[p.formato] ? String(p.formato) : "16:9"];
  // non si aspetta l'export per rispondere: la pagina guarda lo stato
  hlEsportaTutti(q, formati, p).catch((e) => {
    q.export = { stato: "errore", errore: e.message };
    scrivi(); annuncia(0, "clip");
  });
  return { ok: true, export: q.export, formati: formati };
}


// ── LO STING ──────────────────────────────────────────────────────────
//
//  Una clip esportata, da sola, non dice che cos'e'. Finisce in una
//  cartella o in una chat insieme ad altre venti e nessuno sa piu' quale
//  sia: stesso formato, stessa durata, stesso fotogramma d'apertura.
//
//  Quindi le prime tre secondi portano una fascia in basso con: chi siamo,
//  che partita e', e che azione. Non e' una grafica da messa in onda — per
//  quella c'e' la regia — e' un'etichetta: serve a riconoscerla.
//
//  Costa una ricodifica: il taglio in copia dura un secondo, con lo sting
//  quanto la clip. Per questo si puo' spegnere.

const FONT_DIR = process.env.COMOTV_FONT || "/var/www/comotv/assets/fonts";
const FONT_GROSSO = path.join(FONT_DIR, "MazzardM-ExtraBold.ttf");
const FONT_MEDIO = path.join(FONT_DIR, "MazzardM-Bold.ttf");

function fontCe() {
  try { return fs.existsSync(FONT_GROSSO) && fs.existsSync(FONT_MEDIO); } catch (e) { return false; }
}

// Il testo va su un file, non dentro il filtro: dentro il filtro ogni
// apostrofo, due punti o accento diventa un carattere da proteggere, e basta
// un nome con l'apostrofo per far fallire l'export senza dire perche'.
function scriviTesto(dove, testo) {
  fs.writeFileSync(dove, String(testo || "").slice(0, 120) + "\n", "utf8");
  return dove.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function filtroSting(r, c, cartella, id) {
  if (!fontCe()) return "";
  const occhiello = ["COMO TV", r.competizione || ""].filter(Boolean).join("  \u00b7  ").toUpperCase();
  const partita = String(r.titolo || "").toUpperCase();
  const azione = String(c.titolo || "").toUpperCase();

  const f1 = scriviTesto(path.join(cartella, id + ".t1.txt"), occhiello);
  const f2 = scriviTesto(path.join(cartella, id + ".t2.txt"), partita);
  const f3 = scriviTesto(path.join(cartella, id + ".t3.txt"), azione);
  const font1 = FONT_MEDIO.replace(/:/g, "\\:");
  const font2 = FONT_GROSSO.replace(/:/g, "\\:");

  // Tre secondi, con una comparsa e una sparizione: un cartello che appare
  // di scatto e sparisce di scatto sembra un errore di montaggio.
  const q = "between(t,0.25,3.25)";
  const alfa = "if(lt(t,0.55),(t-0.25)/0.3,if(gt(t,2.85),(3.25-t)/0.4,1))";

  return [
    // la fascia: navy del sistema, non nero
    "drawbox=x=0:y=ih-ih/4.6:w=iw:h=ih/4.6:color=0x0A0F24@0.62:t=fill:enable='" + q + "'",
    // il filo d'oro che la regge
    "drawbox=x=0:y=ih-ih/4.6:w=iw:h=max(2\\,ih/540):color=0xC9A24B@0.95:t=fill:enable='" + q + "'",
    "drawtext=fontfile='" + font1 + "':textfile='" + f1 + "':fontcolor=0xE3C271:" +
      "fontsize=ih/40:x=iw/22:y=ih-ih/5.4:alpha='" + alfa + "':enable='" + q + "'",
    "drawtext=fontfile='" + font2 + "':textfile='" + f2 + "':fontcolor=0xF5F1E6:" +
      "fontsize=ih/17:x=iw/22:y=ih-ih/6.6:alpha='" + alfa + "':enable='" + q + "'",
    "drawtext=fontfile='" + font1 + "':textfile='" + f3 + "':fontcolor=0xD8D2C2:" +
      "fontsize=ih/30:x=iw/22:y=ih-ih/13.5:alpha='" + alfa + "':enable='" + q + "'"
  ].join(",");
}

// ── LA MINIATURA ──────────────────────────────────────────────────────
//
//  Una griglia di rettangoli vuoti non e' un archivio: si legge il titolo
//  di ognuno o non si riconosce niente. Un fotogramma della clip lo dice a
//  colpo d'occhio, ed e' l'unica cosa che si guarda davvero quando se ne
//  hanno venti davanti.
//
//  Si prende a un terzo della clip, non all'inizio: il primo fotogramma e'
//  spesso la fine dell'azione precedente, o una dissolvenza.

function miniatura(file, fuori, quando) {
  return new Promise((si) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", String(Math.max(0, quando)), "-i", file, "-frames:v", "1",
      "-vf", "scale=640:-2", "-q:v", "4", "-y", fuori], { stdio: "ignore" });
    pr.on("error", () => si(false));
    pr.on("close", (code) => si(code === 0));
  });
}

// IL NOME DEI FILE. Una regola sola, per tutto quello che esce:
//   AAAAMMGG_PARTITA_Nome_16x9.mp4       (una clip)
//   AAAAMMGG_PARTITA_HL_16x9.mp4         (una sequenza)
//   AAAAMMGG_PARTITA_HL.xml              (per Premiere)
// Prima la data, cosi' i file si ordinano da soli in una cartella; poi la
// partita, poi che cos'e', poi la forma. Chi lo riceve capisce tutto dal
// nome, che e' l'unica cosa che viaggia insieme al file.
function pulisciNome(t) {
  return String(t || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 _-]/g, " ").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}
function giornoDi(r) {
  const d = r && r.avviata ? new Date(r.avviata) : null;
  return (d && isFinite(d)) ? d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") : "";
}
function nomeScarico(c, r) {
  const pezzi = [giornoDi(r), pulisciNome(r && r.titolo), pulisciNome(c.titolo), (c.formato || "").replace(":", "x")].filter(Boolean);
  return (pezzi.join("_") || c.id) + ".mp4";
}
function nomeScaricoSeq(q, r, formato, est) {
  const cosa = pulisciNome(String(q.titolo || "HL").replace(/^HL\s+/i, "")) ;
  const pezzi = [giornoDi(r), pulisciNome(r && r.titolo), "HL", cosa && cosa !== pulisciNome(r && r.titolo) ? cosa : "",
                 formato ? formato.replace(":", "x") : ""].filter(Boolean);
  return pezzi.join("_") + (est || ".mp4");
}

// ── le sorgenti: la tabella AWS di Airtable ───────────────────────────
//
//  Non si cablano gli indirizzi qui dentro: cambiano a ogni stagione e chi
//  li aggiorna sta su Airtable, non sul ponte. Si leggono i campi cosi'
//  come sono e si tiene quello che ASSOMIGLIA a un flusso — cosi' se domani
//  una colonna cambia nome il menu non si svuota.

const AT_BASE = "appdDMcS8JQ4PTdLB";
const AT_AWS = "tblgZRXXCCWhI327U";
const AT_PARTITE = "tblXKPRWFCLw5pVSt";
let SORG_CACHE = { quando: 0, dati: null };

function atLeggi(url) {
  return new Promise((si, no) => {
    // la base storica ha una chiave sua: si sceglie dall'indirizzo
    const storica = url.indexOf("/" + AT_STORICA + "/") >= 0;
    const tok = (storica && process.env.COMOTV_AIRTABLE_PAT_STORICO) || process.env.COMOTV_AIRTABLE_PAT || "";
    if (!tok) { no(new Error("manca la chiave di Airtable sul ponte (COMOTV_AIRTABLE_PAT)")); return; }
    const req = https.get(url, { headers: { Authorization: "Bearer " + tok } }, (res) => {
      let t = "";
      res.on("data", (d) => { t += d; });
      res.on("end", () => {
        if (res.statusCode !== 200) { no(new Error("Airtable risponde " + res.statusCode)); return; }
        try { si(JSON.parse(t)); } catch (e) { no(new Error("Airtable illeggibile")); }
      });
    });
    req.on("error", (e) => no(new Error("Airtable non raggiungibile: " + e.message)));
    req.setTimeout(20000, () => { req.destroy(); no(new Error("Airtable non risponde")); });
  });
}


// ── IL FOGLIO DEI FEED: quale partita passa su quale encoder ──────────
//  MediaOps tiene un foglio Google con, per ogni partita, la SOURCE (TATA 03,
//  SRT-CP9K-12…), il MAIN FEED e il BACKUP FEED (srt://…), l'ingresso vMix.
//  Il MAM lo legge ogni dieci minuti (e' un CSV pubblico) e cosi', scelta
//  la partita, sa da solo da dove prenderla: e' il "tac, appare".
const FOGLIO_FEED = process.env.COMOTV_FOGLIO_FEED ||
  "https://docs.google.com/spreadsheets/d/1QMqP8J376LDInU8aI9VUEzoNAAvvMpDxohEHjjoNF_U/export?format=csv&gid=80696019";
let FEED = { quando: 0, righe: [], errore: "" };
function fileFeed() { return path.join(DIR, "feed.json"); }
function prendiTesto(url, salti) {
  return new Promise((ok, no) => {
    const req = https.get(url, { headers: { "User-Agent": "curl/8.5.0 comotv" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (salti || 0) < 4) {
        res.resume(); return prendiTesto(res.headers.location, (salti || 0) + 1).then(ok, no);
      }
      if (res.statusCode !== 200) { res.resume(); return no(new Error("il foglio risponde " + res.statusCode)); }
      let b = ""; res.setEncoding("utf8"); res.on("data", (d) => { b += d; }); res.on("end", () => ok(b));
    });
    req.on("error", no); req.setTimeout(20000, () => req.destroy(new Error("foglio: tempo scaduto")));
  });
}
// un CSV con le virgolette fatte bene: celle con virgole e a capo dentro
function leggiCsv(testo) {
  const righe = [], riga = []; let cella = "", dentro = false;
  for (let i = 0; i < testo.length; i++) {
    const c = testo[i];
    if (dentro) {
      if (c === '"') { if (testo[i + 1] === '"') { cella += '"'; i++; } else dentro = false; }
      else cella += c;
    } else if (c === '"') dentro = true;
    else if (c === ",") { riga.push(cella); cella = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && testo[i + 1] === "\n") i++; riga.push(cella); righe.push(riga.slice()); riga.length = 0; cella = ""; }
    else cella += c;
  }
  if (cella.length || riga.length) { riga.push(cella); righe.push(riga.slice()); }
  return righe;
}
const MESI_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function quandoGmt(data, ora) {
  // "Mon, 01-Dec-25" + "17:00"  →  2025-12-01T17:00Z
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/.exec(String(data || ""));
  const h = /(\d{1,2}):(\d{2})/.exec(String(ora || ""));
  if (!m || MESI_EN[m[2].toLowerCase()] === undefined) return "";
  const anno = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(anno, MESI_EN[m[2].toLowerCase()], +m[1], h ? +h[1] : 12, h ? +h[2] : 0)).toISOString();
}
async function leggiFoglioFeed() {
  try {
    const righe = leggiCsv(await prendiTesto(FOGLIO_FEED));
    const testa = (righe[0] || []).map((x) => String(x).trim().toUpperCase());
    const col = (nome) => testa.findIndex((x) => x.indexOf(nome) === 0);
    const iComp = col("COMPETIZIONE"), iPart = col("PARTITA"), iData = col("DATE"), iOra = col("TIME"),
          iSrc = col("SOURCE"), iMain = col("MAIN FEED"), iBack = col("BACKUP FEED"), iVmix = col("VMIX SRT"), iVmixIt = col("VMIX ITALY");
    const fuori = [];
    righe.slice(1).forEach((r) => {
      const partita = String(r[iPart] || "").replace(/\s+/g, " ").trim();
      const quando = quandoGmt(r[iData], r[iOra]);
      if (!partita || !quando) return;
      const celle = [r[iMain], r[iBack]].map((x) => String(x || "").trim());
      const pass = celle.map((x) => (/passphrase\s*:\s*(\S+)/i.exec(x) || [])[1]).filter(Boolean)[0] || "";
      const urls = celle.filter((x) => /^srt:\/\/|^https?:\/\//i.test(x));
      fuori.push({ competizione: String(r[iComp] || "").trim(), partita: partita, quando: quando,
                   source: String(r[iSrc] || "").trim(), main: urls[0] || "", backup: urls[1] || "", passphrase: pass,
                   vmix: String(r[iVmix] || "").trim(), vmixItaly: String(r[iVmixIt] || "").trim(),
                   senzaCleanfeed: /NO NEED/i.test(String(r[iSrc] || "")) });
    });
    FEED = { quando: Date.now(), righe: fuori, errore: "" };
    try { fs.writeFileSync(fileFeed(), JSON.stringify(FEED)); } catch (e) {}
    console.log("[clip] foglio feed: " + fuori.length + " righe");
  } catch (e) { FEED.errore = e.message; console.log("[clip] foglio feed: " + e.message); }
}
function leggiFeedSalvato() { try { FEED = JSON.parse(fs.readFileSync(fileFeed(), "utf8")) || FEED; } catch (e) {} }
// la riga del foglio per una partita: stesso giorno (piu' o meno dodici ore)
// e stesse squadre — il nome uguale prima, poi le parole
function feedPerPartita(nomePartita, quandoIso) {
  const t0 = Date.parse(quandoIso || "");
  const norm = (x) => String(x || "").toUpperCase().replace(/\[[^\]]*\]|\(.*?\)/g, " ").replace(/\s\d+\s*-\s*\d+.*$/, "").replace(/\s+VS\.?\s+/g, "-").replace(/\s*-\s*/g, "-").replace(/[^A-Z0-9\-]+/g, " ").trim();
  const mio = norm(nomePartita);
  const vicine = FEED.righe.filter((r) => !t0 || Math.abs(Date.parse(r.quando) - t0) <= 12 * 3600000);
  let meglio = vicine.find((r) => norm(r.partita) === mio);
  if (!meglio) {
    const mie = squadreDi(nomePartita);
    let punteggio = 0;
    vicine.forEach((r) => {
      const loro = squadreDi(r.partita);
      const n = mie.filter((a) => loro.some((b) => b.tutto === a.tutto || a.parole.some((w) => b.tutto.indexOf(w) >= 0) || b.parole.some((w) => a.tutto.indexOf(w) >= 0))).length;
      if (n > punteggio) { punteggio = n; meglio = r; }
    });
    if (punteggio < Math.min(2, mie.length)) meglio = null;
  }
  if (!meglio) return null;
  // l'indirizzo pronto da dare a ffmpeg: caller, con la passphrase se c'e'
  const pronto = (u) => !u ? "" : u + (u.indexOf("?") >= 0 ? "&" : "?") + "mode=caller&latency=300" + (meglio.passphrase ? "&passphrase=" + encodeURIComponent(meglio.passphrase) : "");
  return Object.assign({}, meglio, { mainPronto: pronto(meglio.main), backupPronto: pronto(meglio.backup) });
}
setTimeout(leggiFoglioFeed, 15000);
setInterval(leggiFoglioFeed, 600000);

// ── I FLUSSI IN ONDA ADESSO ────────────────────────────────────────
//  Cinquanta encoder e canali in tendina, e nessuno sa a memoria su quale
//  passa la partita. Il MAM lo scopre: prova ogni sorgente per qualche
//  secondo, tiene quelle che rispondono con un fotogramma e le mostra. La
//  sonda gira solo se qualcuno la guarda (la pagina LIVE aperta) e non piu'
//  di una volta ogni due minuti.
let FLUSSI = { quando: 0, voci: [], inCorso: false, chiesto: 0 };
function sondaFlusso(sorg) {
  return new Promise((ok) => {
    let url = sorg.url;
    if (/^srt:/i.test(url) && !/mode=/i.test(url)) url += (url.indexOf("?") >= 0 ? "&" : "?") + "mode=caller&latency=300&timeout=4000000";
    const nome = "v" + nuovoId("") + ".jpg", fuori = path.join(DIR, CARTELLA_CLIP, nome);
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-rw_timeout", "6000000", "-i", url,
                      "-frames:v", "1", "-q:v", "5", "-vf", "scale=320:-1", "-y", fuori], { timeout: 12000 },
      (e) => ok(Object.assign({}, sorg, { viva: !e, mini: e ? "" : "/clip/" + CARTELLA_CLIP + "/" + nome, visto: Date.now() })));
  });
}
async function sondaFlussi() {
  if (FLUSSI.inCorso) return;
  FLUSSI.inCorso = true;
  try {
    const lista = ((await clipSorgenti()).sorgenti || []);
    const esiti = [];
    let i = 0;
    const lavora = async () => { while (i < lista.length) { const s = lista[i++]; esiti.push(await sondaFlusso(s)); } };
    await Promise.all([lavora(), lavora(), lavora(), lavora(), lavora(), lavora(), lavora(), lavora()]);
    // le miniature vecchie si buttano
    FLUSSI.voci.forEach((v) => { if (v.mini) { try { fs.unlinkSync(path.join(DIR, v.mini.replace(/^\/clip\//, ""))); } catch (e) {} } });
    FLUSSI.voci = esiti; FLUSSI.quando = Date.now();
    console.log("[clip] sonda flussi: " + esiti.filter((x) => x.viva).length + " in onda su " + esiti.length);
  } catch (e) { console.log("[clip] sonda flussi: " + e.message); }
  finally { FLUSSI.inCorso = false; }
}
function flussiVivi(p) {
  FLUSSI.chiesto = Date.now();
  if (p && p.subito && !FLUSSI.inCorso) FLUSSI.quando = 0;
  if (Date.now() - FLUSSI.quando > 120000 && !FLUSSI.inCorso) sondaFlussi();
  return { ok: true, inCorso: FLUSSI.inCorso, quando: FLUSSI.quando, quante: FLUSSI.voci.length,
           vivi: FLUSSI.voci.filter((v) => v.viva).map((v) => ({ nome: v.nome, campo: v.campo, tipo: v.tipo, url: v.url, mini: v.mini })) };
}
async function clipSorgenti() {
  if (SORG_CACHE.dati && Date.now() - SORG_CACHE.quando < 300000) return SORG_CACHE.dati;
  const j = await atLeggi("https://api.airtable.com/v0/" + AT_BASE + "/" + AT_AWS + "?pageSize=100");
  const fuori = [];
  (j.records || []).forEach((rec) => {
    const f = rec.fields || {};
    // il nome e' il primo campo di testo che non e' un indirizzo
    let nome = "";
    Object.keys(f).forEach((k) => {
      const v = String(f[k] || "");
      if (!nome && v && !/^(srt|https?):\/\//i.test(v) && v.length < 40) nome = v;
    });
    Object.keys(f).forEach((k) => {
      const v = String(f[k] || "").trim();
      if (/^srt:\/\//i.test(v)) fuori.push({ nome: nome || k, campo: k, tipo: "srt", url: v });
      else if (/^https?:\/\/.*\.m3u8/i.test(v)) fuori.push({ nome: nome || k, campo: k, tipo: "hls", url: v });
    });
  });
  const d = { ok: true, quante: fuori.length, sorgenti: fuori };
  SORG_CACHE = { quando: Date.now(), dati: d };
  return d;
}


// ══════════════════════════════════════════════════════════════════════
//  L'ARCHIVIO DELLE PARTITE INTERE (S3)
// ══════════════════════════════════════════════════════════════════════
//
//  Le partite intere stanno in un bucket S3, caricate a mano con Cyberduck.
//  Il MAM non le copia: S3 parla HTTP e capisce le richieste per intervallo
//  di byte, quindi per tagliare venti secondi da una partita di sette giga
//  si scaricano poche decine di mega. L'archivio resta dov'e'; qui dentro
//  arriva solo l'indice — e i pezzi che servono, quando servono.
//
//  Le chiavi non stanno ne' qui ne' nel repo: le legge dall'ambiente, da un
//  file solo-root. Se non ci sono, tutta questa parte semplicemente non c'e'.

const S3 = {
  bucket: process.env.COMOTV_S3_BUCKET || "",
  id: process.env.COMOTV_S3_ID || "",
  segreto: process.env.COMOTV_S3_SEGRETO || "",
  regione: process.env.COMOTV_S3_REGIONE || ""     // se manca, si chiede al bucket
};

// ── I MAGAZZINI ───────────────────────────────────────────────────────
//
//  S3 non e' Amazon: e' un protocollo. Un Synology con Object Storage
//  Server, o un MinIO, rispondono alle stesse richieste firmate nello
//  stesso modo. Quindi qui dentro non c'e' "il" magazzino: c'e' un elenco,
//  e ogni partita porta gia' scritto in quale sta — il campo bucket ce
//  l'ha da sempre.
//
//  Amazon resta com'era e non si tocca. Gli altri si accendono mettendo le
//  loro chiavi nell'ambiente, esattamente come si e' sempre fatto: qui
//  dentro non ne entra nessuna, e se non ci sono quel magazzino
//  semplicemente non esiste.
//
//  Due differenze pratiche, e sono le uniche:
//    — l'indirizzo. Amazon lo costruisce dal nome del secchio
//      (secchio.s3.regione.amazonaws.com); gli altri hanno un indirizzo
//      loro e il secchio sta nel percorso (nas.tuo/secchio/chiave). E' lo
//      "stile path", ed e' quello che parlano tutti tranne Amazon.
//    — la regione. Ad Amazon si chiede; agli altri no, e vale quella
//      scritta nella configurazione (di solito us-east-1, che e' quella
//      che i server compatibili si aspettano nella firma).
const MAGAZZINI = [];
(function leggiMagazzini() {
  // IL MAGAZZINO DI CARTELLA. La NAS non parla S3: e' montata sulla VM come
  // una cartella, in sola lettura, dentro il tunnel. Per il resto del
  // programma e' un secchio come gli altri — ha un nome, una radice, delle
  // chiavi — con una differenza sola: alla domanda "dammi l'indirizzo di
  // questa chiave" risponde con un percorso invece che con un URL, e
  // ffmpeg un percorso lo legge senza chiedere altro. Niente credenziali:
  // il permesso l'ha dato la NAS al montaggio.
  const c = process.env.COMOTV_NAS_CARTELLA || "";
  if (c) {
    MAGAZZINI.push({
      nome: process.env.COMOTV_NAS_NOME || "nas",
      cartella: c.replace(/\/+$/, ""),
      bucket: process.env.COMOTV_NAS_BUCKET || "nas-magazzino",
      radice: (process.env.COMOTV_NAS_RADICE || "").replace(/^\/+/, ""),
      regione: "locale", id: "", segreto: "", endpoint: "", fuori: false
    });
  }
  // il Synology, o qualunque altro S3 di casa
  const e = process.env.COMOTV_NAS_ENDPOINT || "";
  if (!e) return;
  MAGAZZINI.push({
    nome: process.env.COMOTV_NAS_NOME || "synology",
    endpoint: e.replace(/\/+$/, ""),
    bucket: process.env.COMOTV_NAS_BUCKET || "",
    id: process.env.COMOTV_NAS_ID || "",
    segreto: process.env.COMOTV_NAS_SEGRETO || "",
    regione: process.env.COMOTV_NAS_REGIONE || "us-east-1",
    radice: process.env.COMOTV_NAS_RADICE || "",
    // il browser dei montatori ci arriva? Di norma no: sta dietro il
    // tunnel, che arriva alla VM e basta. Allora il video passa dalla VM.
    fuori: process.env.COMOTV_NAS_FUORI === "1"
  });
})();
// SGANCIARE AMAZON. Non e' un guasto da gestire: e' una decisione. Quando
// il magazzino di casa c'e' e funziona, il secchio a Francoforte esce dal
// giro — non si legge, non si elenca, non si firma — e le partite che
// stavano solo li' escono dall'indice. Le chiavi restano dove sono, il
// secchio pure: qui dentro semplicemente non esiste piu'. Si riaccende
// togliendo una riga dall'ambiente, e un giro di scandaglio lo rimette.
const S3_SPENTO = process.env.COMOTV_S3_SPENTO === "1";
const AMAZZONE = S3_SPENTO
  ? { nome: "amazon", endpoint: "", bucket: "", id: "", segreto: "", regione: "", spento: true }
  : { nome: "amazon", endpoint: "", bucket: S3.bucket, id: S3.id,
      segreto: S3.segreto, regione: S3.regione };
function magazzinoPredefinito() {
  return MAGAZZINI.filter(magazzinoAcceso)[0] || MAGAZZINI[0] || AMAZZONE;
}
function magazzinoDi(bucket) {
  const b = bucket || (S3_SPENTO ? magazzinoPredefinito().bucket : S3.bucket);
  const m = MAGAZZINI.filter((x) => x.bucket && x.bucket === b)[0];
  if (m) return m;
  // un secchio che non e' di nessun magazzino acceso non ha un indirizzo:
  // meglio dirlo subito che tirare fuori una firma che nessuno onorera'
  if (S3_SPENTO) throw new Error("il magazzino \"" + b + "\" non c'e' piu': Amazon e' sganciato");
  return AMAZZONE;
}
function magazzinoAcceso(m) { return !!(m && m.bucket && ((m.id && m.segreto) || (m.cartella && fs.existsSync(m.cartella)))); }
function s3Acceso() { return magazzinoAcceso(AMAZZONE) || MAGAZZINI.some(magazzinoAcceso); }

// L'unica codifica che AWS accetta nella firma: encodeURIComponent lascia
// stare cinque caratteri che invece vanno codificati.
function uriAws(x) {
  return encodeURIComponent(x).replace(/[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function uriChiave(k) { return String(k).split("/").map(uriAws).join("/"); }
function sha256(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function hmac(k, x) { return crypto.createHmac("sha256", k).update(x).digest(); }

// In quale regione sta il bucket. Non si indovina: si bussa alla porta e lo
// dice lui in un'intestazione, anche quando risponde di no.
const regioneVista = {};
async function s3Regione(bucket) {
  const b = bucket || (S3_SPENTO ? magazzinoPredefinito().bucket : S3.bucket);
  // a un magazzino di casa non si chiede niente: la regione e' quella
  // scritta nella configurazione, e bussare a un indirizzo di Amazon col
  // nome del nostro secchio non avrebbe senso
  const m = magazzinoDi(b);
  if (m.cartella) return "locale";
  if (m.endpoint) return m.regione || "us-east-1";
  if (!bucket && S3.regione) return S3.regione;
  if (regioneVista[b]) return regioneVista[b];
  const r = await fetch("https://" + b + ".s3.amazonaws.com/",
                        { method: "HEAD", signal: AbortSignal.timeout(15000) });
  regioneVista[b] = r.headers.get("x-amz-bucket-region") || "us-east-1";
  return regioneVista[b];
}

// Un indirizzo firmato che vale per un po'. Serve a tutto: a ffmpeg per
// tagliare, al browser per guardare, a noi per elencare.
async function s3Firma(chiave, cerca, quanto, bucket) {
  return firmaConRegione(await s3Regione(bucket), chiave, cerca, quanto, bucket);
}

// La firma vera e' un conto, non una domanda: una volta saputa la regione
// si fa qui e adesso. Serve dove non si puo' aspettare — dentro il taglio,
// che e' scritto per lavorare su un file e non deve sapere di internet.
function firmaConRegione(regione, chiave, cerca, quanto, bucket) {
  const secchio = bucket || S3.bucket;
  const m = magazzinoDi(secchio);
  // una cartella non si firma: si indica. Chi chiede l'indirizzo per
  // elencare (chiave vuota) riceve la cartella stessa.
  if (m.cartella) return path.join(m.cartella, String(chiave || ""));
  // Amazon mette il secchio nel nome dell'host; tutti gli altri nel
  // percorso. E' l'unica differenza che conta, ed e' qui.
  let protocollo = "https:", host, via, base = "";
  if (m.endpoint) {
    const u = new URL(m.endpoint);
    protocollo = u.protocol;
    host = u.host;                                   // porta compresa
    base = u.pathname.replace(/\/+$/, "");           // se sta sotto un percorso
    via = base + "/" + uriAws(secchio) + "/" + (chiave ? uriChiave(chiave) : "");
  } else {
    host = secchio + ".s3." + regione + ".amazonaws.com";
    via = "/" + (chiave ? uriChiave(chiave) : "");
  }
  const reg = m.endpoint ? (m.regione || "us-east-1") : regione;
  const ora = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const giorno = ora.slice(0, 8);
  const ambito = giorno + "/" + reg + "/s3/aws4_request";

  const q = Object.assign({}, cerca || {}, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": m.id + "/" + ambito,
    "X-Amz-Date": ora,
    "X-Amz-Expires": String(quanto || 3600),
    "X-Amz-SignedHeaders": "host"
  });
  const query = Object.keys(q).sort()
    .map((k) => uriAws(k) + "=" + uriAws(q[k])).join("&");

  const richiesta = ["GET", via, query, "host:" + host, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const daFirmare = ["AWS4-HMAC-SHA256", ora, ambito, sha256(richiesta)].join("\n");
  let k = hmac("AWS4" + m.segreto, giorno);
  k = hmac(k, reg); k = hmac(k, "s3"); k = hmac(k, "aws4_request");
  const firma = crypto.createHmac("sha256", k).update(daFirmare).digest("hex");

  return protocollo + "//" + host + via + "?" + query + "&X-Amz-Signature=" + firma;
}

function fraTag(xml, tag) {
  const dentro = [], re = new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">", "g");
  let m; while ((m = re.exec(xml))) dentro.push(m[1]);
  return dentro;
}

// Una pagina dell'elenco. S3 ne da' mille per volta e dice dove riprendere.
// Con il delimitatore S3 smette di srotolare tutto e risponde per cartelle:
// e' il modo di guardare dentro un archivio grande senza tirarselo dietro.
async function s3Pagina(prefisso, ripresa, bucket, delimitatore) {
  const mg = magazzinoDi(bucket || "");
  if (mg.cartella) return elencaCartella(mg.cartella, prefisso || "", delimitatore);
  const cerca = { "list-type": "2", "max-keys": "1000" };
  if (prefisso) cerca.prefix = prefisso;
  if (ripresa) cerca["continuation-token"] = ripresa;
  if (delimitatore) cerca.delimiter = delimitatore;
  const url = await s3Firma("", cerca, 300, bucket);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const xml = await r.text();
  if (!r.ok) {
    const m = /<Message>([\s\S]*?)<\/Message>/.exec(xml);
    throw new Error("S3 ha detto no (" + r.status + "): " + (m ? m[1] : xml.slice(0, 200)));
  }
  const oggetti = fraTag(xml, "Contents").map((c) => ({
    chiave: (fraTag(c, "Key")[0] || "").replace(/&amp;/g, "&"),
    peso: +(fraTag(c, "Size")[0] || 0),
    quando: fraTag(c, "LastModified")[0] || ""
  })).filter((o) => o.peso > 0);
  const cartelle = fraTag(xml, "CommonPrefixes").map((c) => fraTag(c, "Prefix")[0] || "");
  return { oggetti: oggetti, cartelle: cartelle,
           ancora: (fraTag(xml, "IsTruncated")[0] === "true") ? fraTag(xml, "NextContinuationToken")[0] : "" };
}

// Una pagina dell'elenco, ma da una cartella: stessa forma della risposta di
// S3 — oggetti con chiave, peso e data — cosi' lo scandaglio non se ne
// accorge. Il delimitatore, se c'e', ferma la discesa a un livello, come
// farebbe S3. Le chiavi sono percorsi relativi alla cartella, con la barra.
function elencaCartella(radice, prefisso, delimitatore) {
  const oggetti = [], cartelle = new Set();
  const dentro = (dir, rel) => {
    let voci = [];
    try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    voci.forEach((v) => {
      if (v.name.startsWith(".") || v.name === "#recycle" || v.name === "@eaDir") return;
      const k = rel ? rel + "/" + v.name : v.name;
      if (v.isDirectory()) {
        if (delimitatore && k.startsWith(prefisso)) { cartelle.add(k + "/"); return; }
        dentro(path.join(dir, v.name), k);
        return;
      }
      if (!k.startsWith(prefisso)) return;
      let st; try { st = fs.statSync(path.join(dir, v.name)); } catch (e) { return; }
      if (st.size > 0) oggetti.push({ chiave: k, peso: st.size, quando: st.mtime.toISOString() });
    });
  };
  // SI PARTE DALLA CARTELLA GIUSTA. La radice e' tutta la NAS — tre tera e
  // mezzo, e domani di piu'. Camminarla per intero a ogni giro per poi
  // buttare via tutto quello che non sta sotto il prefisso e' lavoro
  // sprecato: se il prefisso e' una cartella vera si comincia da li'.
  let base = radice, rel = "";
  const pre = String(prefisso || "");
  if (pre.indexOf("..") < 0) {
    const dir = pre.endsWith("/") ? pre.slice(0, -1) : pre.replace(/\/[^\/]*$/, "");
    if (dir) {
      try { if (fs.statSync(path.join(radice, dir)).isDirectory()) { base = path.join(radice, dir); rel = dir; } }
      catch (e) {}
    }
  }
  dentro(base, rel);
  return Promise.resolve({ oggetti: oggetti, cartelle: Array.from(cartelle), ancora: "" });
}

async function s3Tutto(prefisso, tetto) {
  const fuori = []; let ripresa = "", giri = 0;
  do {
    const p = await s3Pagina(prefisso, ripresa);
    fuori.push(...p.oggetti); ripresa = p.ancora;
  } while (ripresa && ++giri < 60 && fuori.length < (tetto || 20000));
  return fuori;
}

// ── dall'archivio alle partite ────────────────────────────────────────
//
//  Le chiavi hanno una forma, e la forma dice tutto:
//
//    TEMP/20260904/GENOA-COMO/GENOA-COMO [AUDIO ITA]/CLEANFEED/MultiCorder3 … 08-39-34.mp4
//         giorno   partita    variante audio          pulito    ora di inizio
//
//  CLEANFEED e' la registrazione intera e pulita: e' quella che ci serve.
//  TAGLI sono i pezzi gia' fatti in regia, che non c'entrano con il DVR.

const ARCH_BUCKET = process.env.COMOTV_S3_ARCHIVIO ||
                    (S3_SPENTO ? magazzinoPredefinito().bucket : "mola-italy-como-archive");
const ARCH_RADICE = process.env.COMOTV_S3_RADICE || "TEMP/";
// la radice di ogni magazzino: quella di Amazon e' TEMP/, quella di casa la
// dice chi la configura (e se non la dice, si guarda tutto il secchio)
// PIU' DI UNA CARTELLA. Il materiale non sta tutto in un posto: i tagli di
// vMix in una condivisione, i cleanfeed delle partite intere in un'altra.
// La radice si scrive separata da virgole e diventano piu' rami, guardati
// uno dopo l'altro nello stesso giro. Domani se ne aggiunge un'altra e
// basta una riga.
function radiciDi(bucket) {
  const m = magazzinoDi(bucket);
  const r = (m.endpoint || m.cartella) ? (m.radice || "") : ARCH_RADICE;
  const v = String(r).split(",").map((x) => x.trim()).filter((x, i, a) => x !== "" || a.length === 1);
  return v.length ? v : [""];
}
function radiceDi(bucket) { return radiciDi(bucket)[0]; }

// Le parole che contano di un nome di partita: via i punteggi, via "vs",
// via le sigle corte. Restano i nomi delle squadre, che e' quello su cui
// due scritture diverse della stessa partita si incontrano.
function paroleSquadre(x) {
  return senzaAccenti(String(x || "").replace(/\[.*?\]/g, " ").replace(/\(.*?\)/g, " "))
    .split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && w !== "rigori" && !/^\d+$/.test(w));
}

// Como-Juventus e Como U20-Juventus U20 hanno le stesse parole lunghe: la
// differenza sta tutta in tre lettere, che il filtro di sopra butterebbe
// via. Il livello si guarda a parte, ed e' l'errore piu' facile da fare e
// il piu' brutto da scoprire dopo, con la clip gia' pubblicata.
function livelloDi(x) {
  const t = senzaAccenti(String(x || ""));
  const u = /\bu\s?(\d{2})\b/.exec(t);
  if (u) return "u" + u[1];
  if (/\bfemminil|\bwomen|\bfem\b/.test(t)) return "femminile";
  if (/\bprimavera\b/.test(t)) return "primavera";
  return "";
}
function quantoSiSomigliano(a, b, livA) {
  const la = (livA === undefined ? livelloDi(a) : livA), lb = livelloDi(b);
  if (la && lb && la !== lb) return 0;
  const A = new Set(paroleSquadre(a)), B = new Set(paroleSquadre(b));
  if (!A.size || !B.size) return 0;
  let insieme = 0; A.forEach((w) => { if (B.has(w)) insieme++; });
  const s = insieme / Math.max(A.size, B.size);
  return (la === lb) ? s : s * 0.55;
}

// L'ora sta in fondo al nome, ma non sempre in ultima posizione: i nomi
// vecchi hanno un "- Output 1" appiccicato dopo. Si prende l'ultima.
function oraNelNome(file) {
  const tutte = String(file).match(/\b(\d{2})-(\d{2})-(\d{2})\b/g);
  if (!tutte || !tutte.length) return null;
  const p = tutte[tutte.length - 1].split("-");
  return { h: +p[0], m: +p[1], s: +p[2] };
}
function minutiRoma(ms) {
  const s = new Date(ms).toLocaleString("en-GB", { timeZone: "Europe/Rome", hour12: false });
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(s);
  return m ? (+m[1] * 60 + +m[2]) : null;
}

// Quanti secondi separano il calcio d'inizio dall'inizio di questo file.
// L'orologio del registratore scrive le ore su dodici senza dire se e'
// mattina o sera: fra le due letture si tiene quella che cade vicino al
// calcio d'inizio, e l'ambiguita' si scioglie da sola.
function daKickoffPezzo(file, quandoMs) {
  const o = oraNelNome(file), dentro = minutiRoma(quandoMs);
  if (!o || dentro === null) return null;
  let meglio = null;
  [o.h % 12, (o.h % 12) + 12].forEach((h) => {
    [-1440, 0, 1440].forEach((giro) => {
      const d = (h * 60 + o.m + giro) - dentro;
      if (meglio === null || Math.abs(d) < Math.abs(meglio)) meglio = d;
    });
  });
  if (meglio === null || Math.abs(meglio) > 300) return null;
  return Math.round(meglio * 60 + o.s);
}
function kickoffNelFile(file, quandoMs) {
  const da = daKickoffPezzo(file, quandoMs);
  return da === null ? null : Math.max(0, -da);
}

// L'archivio non ha una forma sola: ne ha due, e sono di due epoche.
//
//   TEMP/20260904/GENOA-COMO/[AUDIO ITA]/CLEANFEED/file.mp4      (le recenti)
//   BACKUP/CALCIO/…/20260303_COMO-INTER/EXPORT/…PARTITA INTERA…  (le altre)
//
//  In tutte e due, da qualche parte nel percorso, c'e' un segmento che dice
//  il giorno — da solo, oppure incollato al nome della partita. Trovato
//  quello, il resto viene dietro. Cercare la forma invece della cartella
//  fa la differenza fra indicizzare seimila oggetti e indicizzarne
//  trecentomila.
// Il nome che scrive vMix, che e' la terza forma dell'archivio:
//
//   VOD/TAGLI/20260520 - PALERMO-CATANZARO - 20 maggio 2026 - 07-54-25  - Output 1.mp4
//
//  Qui la data non sta in una cartella: sta nel NOME, due volte. Le otto
//  cifre in testa sono il nome della sessione di vMix, impostato una volta
//  e spesso mai piu' toccato — sul materiale vero sbaglia il giorno in un
//  file su nove. La data buona e' quella scritta in italiano in mezzo, e
//  l'ora accanto e' l'ora a cui e' partita la registrazione: e' la stessa
//  informazione che l'archivio S3 mette nei CLEANFEED, e serve a mettere
//  in fila i pezzi di una stessa partita (vMix ne apre uno nuovo a ogni
//  stop). Tredici file su millequattrocento si chiamano solo "vmix 6":
//  quelli restano senza nome e si agganciano per ora, non per titolo.
const MESI_IT = { gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6, luglio: 7,
                  agosto: 8, settembre: 9, ottobre: 10, novembre: 11, dicembre: 12 };
function nomeVmix(file) {
  const m = /^(?:(\d{8})[\s\-_]+)?(.*?)\s*-\s*(\d{1,2})\s+([a-z\u00e0-\u00f9]+)\s+(\d{4})\s*-\s*(\d{2})-(\d{2})-(\d{2})\s*-?\s*(Output\s*(\d+))?\s*\.\w+$/i.exec(file);
  if (!m) return null;
  const mese = MESI_IT[m[4].toLowerCase()];
  if (!mese) return null;
  // LA MEZZANOTTE. Le partite sudamericane finiscono dopo le due, ora
  // italiana: vMix chiude il file del primo tempo il 30 e apre quello del
  // secondo il 1°, e i due pezzi finivano in due partite diverse — la
  // seconda senza aggancio ad Airtable, perche' l'evento sta il 30.
  // Le otto cifre davanti al nome le scrive chi registra, ed e' il giorno
  // della partita: quando cade a ridosso della registrazione e' la risposta
  // giusta per tutti i pezzi, compreso quello ripreso alle cinque e mezza
  // — la regola secca "prima delle sei" spaccava in due Como-Napoli.
  // Quando invece il prefisso e' un preset riciclato e sta mesi lontano,
  // non vale niente e si torna alla mezzanotte.
  const reg = Date.UTC(+m[5], mese - 1, +m[3]);
  let d = new Date(reg);
  const pf = /^(20\d{2})(0\d|1[0-2])([0-2]\d|3[01])$/.exec(m[1] || "");
  const pd = pf ? Date.UTC(+pf[1], +pf[2] - 1, +pf[3]) : NaN;
  if (pd === pd && Math.abs(pd - reg) <= 86400000) d = new Date(pd);
  else if (+m[6] < 6) d = new Date(reg - 86400000);
  const giorno = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
  const titolo = m[2].replace(/\s+/g, " ").trim();
  return { giorno: giorno, partita: titolo, uscita: m[10] ? +m[10] : 1,
           senzaNome: /^vmix\b/i.test(titolo) };
}

// QUELLO CHE VIENE DOPO IL TITOLO NON E' IL TITOLO. Nei nomi dei file la
// partita ha sempre la stessa forma — X-Y — e poi comincia la coda: la
// lingua fra parentesi quadre, il tempo, l'intervista, gli scarichi. Se la
// coda resta attaccata al titolo ogni file diventa una partita diversa, e
// i due tempi del Torino-Como finiscono in due posti che nessuno riunisce.
const CODA_FILE = /\s*[\-_]?\s*(?:\[[^\]]*\]|\b(?:CLEANFEED|AUDIO ?FX|SOCIAL|INTERVIST\w*|SCARICH\w*|PREMIAZION\w*|CONFERENZ\w*|TIFOS\w*|RESPEAK\w*|ULTIMO TAKE|ARABIAN NIGHT|PARTITA INTERA|FULL MATCH|FULL INTERNATIONAL SOUND|INTERNATIONAL SOUND|PRIMO TEMPO|SECONDO TEMPO|[12][°º]? TEMPO|INTRO|LANCIO)\b).*$/i;

function spezzaTitolo(titolo) {
  const pulito = String(titolo || "").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  const m = CODA_FILE.exec(pulito);
  const base = m && m.index > 0 ? pulito.slice(0, m.index).replace(/[\s\-_]+$/, "") : pulito;
  return { base: base || pulito, coda: pulito.slice((base || pulito).length).replace(/^[\s\-_]+/, "").trim() };
}

// Primo tempo, secondo tempo. Non c'e' l'ora nel nome: l'unico ordine
// possibile e' quello che c'e' scritto.
function tempoDi(nome) {
  const t = String(nome || "");
  if (/\b(primo|1[°ºo]?)\s*tempo\b|\b1T\b/i.test(t)) return 1;
  if (/\b(secondo|2[°ºo]?)\s*tempo\b|\b2T\b/i.test(t)) return 2;
  return 0;
}

function pezziChiave(k) {
  const p = k.split("/");
  // prima la forma di vMix: la data e' nel nome del file, e il gruppo e'
  // "giorno + titolo", perche' non c'e' una cartella per partita
  const vm = nomeVmix(p[p.length - 1]);
  if (vm) {
    // LE VARIANTI STANNO NELLO STESSO GRUPPO. "COMO-NAPOLI [ITA]" e
    // "COMO-NAPOLI [ENG]" sono la stessa partita in due lingue, e "COMO-NAPOLI
    // - CLEANFEED AUDIO FX" e' lo stesso incontro con un altro audio: un
    // evento Airtable ne aggancia uno solo, e gli altri restavano orfani —
    // 108 su 141. Il tag e la coda si tolgono dal nome del gruppo e restano
    // in "dentro", che e' dove scegliMateriale va a cercare la lingua.
    const t = spezzaTitolo(vm.partita);
    return { giorno: vm.giorno, partita: t.base,
             gruppo: gruppoDi(p, vm.giorno, t.base),
             dentro: [t.coda, vm.uscita > 1 ? "Output " + vm.uscita : ""].filter(Boolean).join(" "),
             file: p[p.length - 1], uscita: vm.uscita };
  }
  for (let i = 0; i < p.length - 1; i++) {
    let giorno = "", partita = "", primo = i;
    if (/^\d{8}$/.test(p[i])) { giorno = p[i]; partita = p[i + 1] || ""; primo = i + 1; }
    else {
      const m = /^(\d{8})[_\s-]+(.+)$/.exec(p[i]);
      if (!m) continue;
      giorno = m[1]; partita = m[2];
    }
    if (!/^20\d{2}(0\d|1[0-2])([0-2]\d|3[01])$/.test(giorno)) continue;
    return { giorno: giorno, partita: partita, gruppo: p.slice(0, primo + 1).join("/"),
             dentro: p.slice(primo + 1, p.length - 1).join("/"), file: p[p.length - 1] };
  }
  // NON TUTTO PASSA DA VMIX. Una parte dei file e' salvata a mano —
  // "20260905_TORINO-COMO U20_PRIMO TEMPO.mp4" — senza data italiana ne'
  // orario: il riconoscitore di vMix li scartava tutti e restavano fuori
  // dall'indice, 163 file, fra cui partite intere e tempi separati.
  const fl = /^(\d{8})[\s\-_]+(.+)\.\w+$/.exec(p[p.length - 1]);
  if (fl && /^20\d{2}(0\d|1[0-2])([0-2]\d|3[01])$/.test(fl[1])) {
    const t = spezzaTitolo(fl[2]);
    return { giorno: fl[1], partita: t.base, gruppo: gruppoDi(p, fl[1], t.base),
             dentro: t.coda, file: p[p.length - 1], uscita: 1 };
  }
  return null;
}

// Il nome del gruppo: cartella + giorno + titolo, con i trattini stretti
// perche' "COMO - NAPOLI" e "COMO-NAPOLI" sono la stessa partita.
function gruppoDi(p, giorno, base) {
  return p.slice(0, -1).join("/") + "/" + giorno + "_" +
         base.toUpperCase().replace(/\s*-\s*/g, "-");
}

// Dentro una cartella partita c'e' di tutto: le clip social, gli scarichi
// delle camere, le interviste, le iso. Niente di tutto questo e' la
// partita, e prenderne uno per sbaglio significa aprire un file di tre
// giga che non c'entra niente.
const NON_E_LA_PARTITA = /clip[ _]?social|tifos|scarich|camere|iso[_ ]|intervist|conferenz|social|highlight|magazine|promo|sigla|grafic|lancio|premiazion|\bintro\b|\bOutput [2-9]\b|audio fx|respeak|\brespk\b|ultimo take|arabian night|\bgoal\b|\bgol\b/i;
const E_LA_PARTITA = /partita[ _]intera|full[ _]match|cleanfeed/i;
const VIDEO = /\.(mp4|mxf|mov|ts|m4v)$/i;

function scegliMateriale(gruppo, tag) {
  const buoni = gruppo.file.filter((f) =>
    VIDEO.test(f.file) && (E_LA_PARTITA.test(f.dentro + " " + f.file) ||
                           !NON_E_LA_PARTITA.test(f.dentro + " " + f.file)));
  if (!buoni.length) return null;
  const vuole = (f) => !tag || (f.dentro + " " + f.file).toUpperCase().indexOf(tag) >= 0;
  const conTag = buoni.filter(vuole);
  const campo = conTag.length ? conTag : buoni;

  // 1) l'export "partita intera": un file solo, gia' pronto
  const intere = campo.filter((f) => E_LA_PARTITA.test(f.file) && !/cleanfeed/i.test(f.dentro));
  // 2) il cleanfeed, che ha l'ora nel nome e quindi si sa dove sta il tempo
  const puliti = campo.filter((f) => /cleanfeed/i.test(f.dentro));
  // 3) i pezzi con l'orologio nel nome: un file per tempo
  const conOra = campo.filter((f) => oraNelNome(f.file));

  // 4) i due tempi salvati a mano: nessun orario nel nome, ma l'ordine
  //    c'e' scritto sopra. Due file, una partita.
  const tempi = campo.filter((f) => tempoDi(f.dentro + " " + f.file))
    .sort((a, b) => tempoDi(a.dentro + " " + a.file) - tempoDi(b.dentro + " " + b.file));

  if (puliti.length) return { fonte: "intero", pezzi: [piuGrosso(puliti)] };
  if (conOra.length > 1) return { fonte: "pezzi", pezzi: conOra };
  if (tempi.length > 1) return { fonte: "pezzi", pezzi: tempi };
  if (intere.length) return { fonte: "intera", pezzi: [piuGrosso(intere)] };
  if (conOra.length) return { fonte: "pezzi", pezzi: conOra };
  return { fonte: "unico", pezzi: [piuGrosso(campo)] };
}
function piuGrosso(v) { return v.slice().sort((a, b) => b.peso - a.peso)[0]; }

let ARCHIVIO = {};       // recId -> { chiave, peso, variante, kickoff, ... }

// L'indirizzo firmato di una partita d'archivio. Vale sei ore: piu' che
// abbastanza per una sessione di montaggio, e se scade si rifa' da solo
// alla prossima richiesta di stato.
// ── LA PARTITA INTERA ─────────────────────────────────────────────────
//
//  vMix chiude e riapre il file a ogni stop: una partita sta in due, tre,
//  sette file. Aprirne uno voleva dire aprire un tempo — cinquantasei
//  minuti al posto di due ore — e gli appunti del secondo tempo cadevano
//  in un materiale che finiva prima.
//
//  Adesso una registrazione d'archivio li tiene tutti, e la sua linea del
//  tempo e' l'OROLOGIO DEL MURO: ogni pezzo entra al secondo in cui e'
//  partito davvero, e l'intervallo fra un file e l'altro resta un buco
//  invece di sparire. Non e' un dettaglio: fra il primo e il secondo tempo
//  ci sono quattordici minuti in cui non si registra, e incollare i due
//  file avrebbe spostato tutto il secondo tempo di quattordici minuti.
//  Cosi' il minuto 78 e' il minuto 78 anche se sta in un altro file.
function pezziArch(r) {
  const a = r && r.arch; if (!a) return [];
  if (a.pezzi && a.pezzi.length) return a.pezzi;
  return [{ chiave: a.chiave, da: 0, durata: r.durata || 0 }];
}
// Quale file, e a che secondo dentro quel file. Un tempo che cade in un
// buco prende il pezzo che comincia dopo: meglio un fotogramma vicino che
// un errore.
function pezzoAl(r, t) {
  const pz = pezziArch(r); if (!pz.length) return null;
  const s = Math.max(0, +t || 0);
  for (let i = 0; i < pz.length; i++) {
    const fine = (pz[i].da || 0) + (pz[i].durata || 0);
    if (s < fine || i === pz.length - 1) {
      return { i: i, pezzo: pz[i], dentro: Math.max(0, s - (pz[i].da || 0)), da: pz[i].da || 0, fine: fine };
    }
  }
  return null;
}
function viaPezzo(r, x) {
  return firmaConRegione(r.arch.regione, x.chiave, {}, 21600, r.arch.bucket);
}
function viaArchivio(r, t) {
  const x = pezzoAl(r, t || 0);
  return viaPezzo(r, x ? x.pezzo : { chiave: r.arch.chiave });
}
// Il file giusto e il secondo giusto dentro quel file, per chi poi ci
// mette un -ss davanti.
function fonteAl(r, dentro) {
  const x = pezzoAl(r, dentro);
  if (!x) return { via: viaArchivio(r), dentro: Math.max(0, +dentro || 0), fine: Infinity };
  return { via: viaPezzo(r, x.pezzo), dentro: x.dentro, fine: x.fine, i: x.i };
}

// Una partita che sta su S3 diventa una registrazione come le altre. Non
// e' un trucco: il MAM chiama "registrazione" del materiale con una linea
// del tempo, e questa ce l'ha. Da qui in poi taglio, formati, sequenza,
// ricerca e grafica funzionano senza sapere che i byte sono a Francoforte.
async function archivioApri(p) {
  const a = ARCHIVIO[String(p.rec || "")];
  if (!a) return { ok: false, errore: "questa partita non e' nell'indice dell'archivio" };
  const tutti = a.pezzi && a.pezzi.length ? a.pezzi : [{ chiave: a.chiave, peso: a.peso }];
  // chi vuole un tempo solo lo chiede: p.pezzo con p.intera a false
  const unoSolo = p.intera === false;
  const i = Math.min(Math.max(0, num(p.pezzo, 0, tutti.length - 1, 0)), tutti.length - 1);
  const pezzi = unoSolo ? [tutti[i]] : tutti;
  const scelto = pezzi[0];

  const gia = Object.keys(R.reg).map((k) => R.reg[k])
    .find((r) => r.arch && r.arch.rec === String(p.rec || "") &&
                 (pezziArch(r).length > 1) !== unoSolo && r.arch.chiave === scelto.chiave);
  if (gia) {
    // Una partita gia' aperta tornava indietro cosi' com'era, e chi l'aveva
    // vista prima che esistessero le sequenze non le vedeva piu': erano 30
    // registrazioni su 36. Adesso si apparecchia anche al ritorno; se le
    // sequenze ci sono gia', preparaSequenze se ne accorge e non le rifa'.
    // NON SI APPARECCHIA PIU' NIENTE DA SOLE. Aprendo una partita nascevano
    // nove sequenze — GOL, SHORTS, AZIONI per tre formati — decise da una
    // tabella di parole chiave. Adesso si apre il tabellino, si spunta, e la
    // sequenza la fa chi monta: una, con dentro quello che ha scelto.
    // Chi le vuole comunque: clip-prepara a mano.
    if (p.prepara === true) setTimeout(() => { preparaSequenze({ reg: gia.id }).catch((e) => console.log("[clip] apparecchiare: " + e.message)); }, 300);
    return { ok: true, reg: pubblica(gia), giaAperta: true };
  }

  const regione = await s3Regione(a.bucket);
  // ogni pezzo va misurato: la durata vera dice dove finisce, e l'ora nel
  // nome dice dove comincia. Le due cose insieme fanno la linea del tempo.
  const misura = async (chiave) => {
    try {
      return Math.round(+(await new Promise((ok, no) => {
        execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                             "-of", "default=nw=1:nk=1",
                             firmaConRegione(regione, chiave, {}, 3600, a.bucket)],
                 { timeout: 60000 }, (e, out) => e ? no(e) : ok(String(out).trim()));
      })) || 0);
    } catch (e) { return 0; }
  };
  const durate = [];
  for (const x of pezzi) durate.push((x.minuti && x.minuti > 5) ? Math.round(x.minuti * 60) : await misura(x.chiave));
  // quanti canali audio porta dietro: lo studio ne ha sei, la partita due
  let canali = 2;
  try {
    canali = await new Promise((ok, no) => {
      execFile("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels",
                           "-of", "default=nw=1:nk=1", firmaConRegione(regione, scelto.chiave, {}, 3600, a.bucket)],
               { timeout: 60000 }, (e, out) => e ? no(e) : ok(parseInt(String(out).trim(), 10) || 2));
    });
  } catch (e) { canali = 2; }
  // l'inizio di ognuno, contato dal primo. Se l'ora nel nome c'e' si usa
  // quella — e i buchi restano buchi; se no si incollano uno dopo l'altro.
  const ore = pezzi.map((x) => oraNelNome(path.basename(x.chiave)));
  const conOra = ore.every(Boolean);
  const dentroDi = [];
  let corre = 0;
  pezzi.forEach((x, n) => {
    if (!conOra) { dentroDi.push(corre); corre += durate[n] || 0; return; }
    if (n === 0) { dentroDi.push(0); return; }
    const gi = (o) => (o.h % 12) * 3600 + o.m * 60 + o.s;
    let d = gi(ore[n]) - gi(ore[0]);
    while (d < dentroDi[n - 1]) d += 12 * 3600;        // l'orologio e' a dodici ore
    dentroDi.push(d);
  });
  const dettaglio = pezzi.map((x, n) => ({ chiave: x.chiave, da: dentroDi[n], durata: durate[n] || 0 }));
  // le durate misurate ora valgono anche per l'indice: e' con quelle che si
  // vede il buco dell'intervallo, e quindi dove comincia il secondo tempo
  if (!unoSolo) {
    let scritte = 0;
    (a.pezzi || []).forEach((x, n) => {
      if (!x.minuti && durate[n]) { x.minuti = Math.round(durate[n] / 60); scritte++; }
    });
    if (scritte) scriviArchivio();
  }
  const durata = Math.round(dettaglio.reduce((t, x) => Math.max(t, x.da + x.durata), 0));
  const arch = { rec: p.rec, bucket: a.bucket, chiave: scelto.chiave, regione: regione,
                 pezzo: unoSolo ? i : 0, pezzi: dettaglio, intera: !unoSolo && pezzi.length > 1 };

  const r = {
    // l'evento e' la chiave stessa dell'indice: senza, la partita aperta
    // dall'archivio non ritrovava i suoi appunti ne' le rose di ESPN, e
    // whisper si trascriveva la telecronaca senza sapere un nome
    id: nuovoId("r"), evento: String(p.rec || ""), __durata: durata,
    titolo: titoloMateriale(a, unoSolo ? i : -1, durata),
    competizione: "", sorgente: "archivio", origine: "archivio", url: "",
    stato: "finita", avviata: Date.parse(a.quando) || Date.now(), finita: Date.now(),
    // il calcio d'inizio e' sempre dentro il primo pezzo, e la linea del
    // tempo comincia li': vale per la partita intera come per il 1º tempo
    durata: durata, kickoff: ((unoSolo ? i === 0 : true) && a.kickoff !== null && a.kickoff !== undefined)
      ? { "1": a.kickoff } : {},
    marker: [], chi: String(p.__chi || "").slice(0, 40), errore: "", arch: arch,
    canali: canali
  };
  assicura(cartellaReg(r.id));
  R.reg[r.id] = r; scrivi(); annuncia(0, "clip");
  // una partita che si apre passa in testa alla coda delle durate: in pochi
  // secondi si sa se il file e' l'intera o un tempo, e il nome si aggiusta
  if (!a.misurato && CODA_DURATE.indexOf(p.rec) < 0) { CODA_DURATE.unshift(String(p.rec)); giraDurate(); }
  // e intanto si apparecchia quello che sappiamo di lei: gol, azioni,
  // telecronaca, boati, ognuno nella sua sequenza. Chi apre non aspetta.
  if (p.prepara === true) setTimeout(() => { preparaSequenze({ reg: r.id }).catch((e) => console.log("[clip] apparecchiare: " + e.message)); }, 300);
  return { ok: true, reg: pubblica(r) };
}

// Il nome del materiale e' il nome della partita — MAIUSCOLO, SQUADRA-SQUADRA,
// con il risultato se c'e' o la data se no — e un suffisso solo quando il file
// e' davvero un tempo. "1ª parte" era il nome del file, non della partita.
function titoloMateriale(a, i, durataVera) {
  let nome = String(a.partita || "partita").toUpperCase().replace(/\s+VS\.?\s+/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
  if (!/\b\d+-\d+\b/.test(nome)) {
    const d = new Date(a.quando || 0);
    if (isFinite(d) && d.getTime()) nome += " \u00b7 " + String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getFullYear()).slice(2);
  }
  if (i < 0) return nome;                       // la partita intera: solo il nome
  const pezzi = (a.pezzi && a.pezzi.length) ? a.pezzi : [{}];
  const x = pezzi[i] || {};
  // se il file dura piu' di un'ora e venticinque non e' un tempo, e' la
  // partita: la durata vera del materiale aperto batte qualsiasi indizio
  if (durataVera && durataVera >= 85 * 60) return nome;
  if (pezzi.length <= 1 || (x.minuti && x.minuti >= 85)) return nome;
  // due file sono i due tempi; di piu' (una serata di boxe, un evento a
  // blocchi) sono parti numerate
  if (pezzi.length === 2) return nome + (i === 0 ? " \u00b7 1\u00ba tempo" : " \u00b7 2\u00ba tempo");
  return nome + " \u00b7 parte " + (i + 1) + " di " + pezzi.length;
}
// le partite gia' aperte prendono il nome nuovo (all'avvio e dopo le durate)
function rinominaMaterialeArchivio() {
  let n = 0;
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k]; if (!r.arch) return;
    const a = ARCHIVIO[r.arch.rec]; if (!a) return;
    // se le durate hanno tolto il file di questa voce (un doppione, un taglio)
    // la voce non ha piu' materiale dietro: se non ha clip, se ne va
    const pz = a.pezzi || [];
    if (pz.length && !pz.some((x) => x.chiave === r.arch.chiave) && !Object.keys(R.clip).some((c) => R.clip[c].reg === r.id)) {
      delete R.reg[k]; n++; return;
    }
    // I TEMPI SCIOLTI SE NE VANNO. Prima aprire una partita voleva dire
    // aprire un file per tempo: due voci in elenco, ognuna mezza partita.
    // Adesso la partita e' una sola, e i vecchi mezzi tempi — se nessuno
    // ci ha tagliato niente — non servono piu' a nessuno.
    if (pz.length > 1 && pezziArch(r).length === 1 &&
        !Object.keys(R.clip).some((c) => R.clip[c].reg === r.id) &&
        Object.keys(R.reg).some((k2) => R.reg[k2].arch && R.reg[k2].arch.rec === r.arch.rec &&
                                        pezziArch(R.reg[k2]).length > 1)) {
      delete R.reg[k]; n++; return;
    }
    if (!r.evento && r.arch.rec) { r.evento = r.arch.rec; n++; }
    const t = titoloMateriale(a, pezziArch(r).length > 1 ? -1 : (r.arch.pezzo || 0), r.durata || 0);
    if (t !== r.titolo) { r.titolo = t; n++; }
  });
  if (n) { scrivi(); annuncia(0, "clip"); }
  return n;
}
function fileArchivio() { return path.join(DIR, "archivio.json"); }
function leggiArchivio() {
  try { ARCHIVIO = JSON.parse(fs.readFileSync(fileArchivio(), "utf8")) || {}; }
  catch (e) { ARCHIVIO = {}; }
  if (!S3_SPENTO) return;
  // il file dell'indice se le ricorda anche dopo: si tolgono qui, una
  // volta, e chi vuole rivederle riaccende Amazon e riscandaglia
  const vivi = {}; MAGAZZINI.filter(magazzinoAcceso).forEach((m) => { vivi[m.bucket] = true; });
  let via = 0;
  Object.keys(ARCHIVIO).forEach((k) => {
    if (!vivi[ARCHIVIO[k].bucket]) { delete ARCHIVIO[k]; via++; }
  });
  if (via) { console.log("[clip] archivio: " + via + " partite di magazzini sganciati tolte dall'indice"); scriviArchivio(); }
}
function scriviArchivio() {
  try {
    const tmp = fileArchivio() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ARCHIVIO));
    fs.renameSync(tmp, fileArchivio());
  } catch (e) { console.log("[clip] indice archivio non salvato: " + e.message); }
}

async function archivioScandaglia(p) {
  if (!s3Acceso()) return { ok: false, errore: "nessun magazzino configurato" };
  const bucket = p.bucket || ARCH_BUCKET;
  const radici = p.radice !== undefined ? [String(p.radice)] : radiciDi(bucket);
  const giorni = num(p.giorni, 1, 3650, 400);
  const limite = Date.now() - giorni * 86400000;
  const minimo = num(p.minimoMB, 1, 100000, 700) * 1000000;

  // 1) tutto l'archivio, non un ramo solo. Trecentomila oggetti si elencano
  //    in un minuto; quello che si tiene sono i file video abbastanza
  //    grossi da poter essere una partita, raggruppati per cartella-partita.
  const gruppi = {}, perGiorno = {};
  let visti = 0, tenuti = 0, ripresa = "", giri = 0;
  for (const radice of (p.prefisso ? [String(p.prefisso)] : radici)) {
  ripresa = ""; giri = 0;
  do {
    const pg = await s3Pagina(radice, ripresa, bucket, "");
    pg.oggetti.forEach((o) => {
      visti++;
      if (o.peso < minimo || !VIDEO.test(o.chiave)) return;
      const z = pezziChiave(o.chiave);
      if (!z) return;
      const g = z.giorno;
      const quando = Date.UTC(+g.slice(0, 4), +g.slice(4, 6) - 1, +g.slice(6, 8));
      if (quando < limite) return;
      tenuti++;
      let gr = gruppi[z.gruppo];
      if (!gr) {
        gr = gruppi[z.gruppo] = { giorno: g, partita: z.partita, dove: z.gruppo, file: [] };
        (perGiorno[g] = perGiorno[g] || []).push(gr);
      }
      gr.file.push({ chiave: o.chiave, peso: o.peso, file: z.file, dentro: z.dentro });
    });
    ripresa = pg.ancora;
  } while (ripresa && ++giri < 2000);
  }

  // 2) le partite di Airtable, appaiate per giorno e per nome
  const base = "https://api.airtable.com/v0/" + AT_BASE + "/" + AT_PARTITE;
  const formula = "AND(IS_AFTER({Data | Orario}, DATEADD(TODAY(), -" + Math.round(giorni) +
    ", 'days')), NOT({Partita} = BLANK()))";
  let offset = "", tornate = 0, agganciate = 0, conKickoff = 0, intere = 0, scartati = 0;
  const orfane = [];
  do {
    const q = new URLSearchParams({ filterByFormula: formula, pageSize: "100" });
    if (offset) q.set("offset", offset);
    const j = await atLeggi(base + "?" + q.toString());
    (j.records || []).forEach((rec) => {
      const f = rec.fields || {};
      aggancia(rec.id, f["Partita"] || "", f["Competizione"] || "", f["Data | Orario"] || "");
    });
    offset = j.offset || "";
  } while (offset);
  // ...e gli eventi della base storica, letti dall'ultimo import
  STORICI.forEach((e) => aggancia(e.id, e.partita, e.competizione, e.quando));
  // LE PARTITE APPENA AGGANCIATE VANNO CERCATE SU ESPN DA SOLE. Su una
  // partita della notte prima nessuno ha ancora scritto appunti: se ESPN
  // non la cerca, il tabellino esce vuoto e sembra che il magazzino non
  // abbia dati. Bastava chiederglielo — adesso lo si chiede qui, in coda,
  // per tutte quelle agganciate che non hanno ancora niente.
  let daCercare = 0;
  Object.keys(ARCHIVIO).forEach((rec) => {
    if (ARCHIVIO[rec].bucket !== bucket || rec.startsWith("s3:")) return;
    if (ESPN[rec] || CODA_ESPN.indexOf(rec) >= 0) return;
    CODA_ESPN.push(rec); daCercare++;
  });
  if (daCercare) { console.log("[clip] scandaglio: " + daCercare + " partite da cercare su ESPN"); giraEspn(); }

  function aggancia(recId, nomePartita, nomeComp, quandoIso) {
    {
      tornate++;
      const f = { "Partita": nomePartita, "Competizione": nomeComp, "Data | Orario": quandoIso };
      const rec = { id: recId };
      const quando = Date.parse(quandoIso || "");
      if (!quando) return;
      // uno show settimanale ha lo stesso nome ogni settimana: si aggancia
      // solo a una cartella dello stesso giorno che sia uno show anche lei
      const eShow = /SHOW|STUDIO|INTERVALLO|PRE PARTITA|POST PARTITA|PRE-PARTITA|POST-PARTITA|\u{1F3A5}/iu.test(nomePartita) || /Studio/i.test(nomeComp);
      const candidati = [];
      (eShow ? [0] : [0, -1, 1]).forEach((salto) => {
        const g = new Date(quando + salto * 86400000);
        const chiave = g.getUTCFullYear() + String(g.getUTCMonth() + 1).padStart(2, "0") +
                       String(g.getUTCDate()).padStart(2, "0");
        (perGiorno[chiave] || []).forEach((x) => {
          if (eShow && !/SHOW|STUDIO|LIVE|PRE|POST|INTERVALLO/i.test(x.partita)) return;
          candidati.push(x);
        });
      });
      const livello = livelloDi(String(f["Partita"] || "") + " " + String(f["Competizione"] || ""));
      let meglio = null, punteggio = 0;
      candidati.forEach((gr) => {
        const s = quantoSiSomigliano(f["Partita"], gr.partita, livello);
        if (s > punteggio) { punteggio = s; meglio = gr; }
      });
      if (!meglio || punteggio < 0.5) {
        if (candidati.length) orfane.push(f["Partita"] + " (" +
          new Date(quando).toISOString().slice(0, 10) + ")");
        return;
      }
      const tag = (/\[([A-Z]{2,4})\]/.exec(String(f["Partita"] || "")) || [])[1] || "";
      const scelta = scegliMateriale(meglio, tag);
      if (!scelta) return;
      meglio.presa = rec.id;

      let pezzi = scelta.pezzi.map((x) => Object.assign({}, x, {
        da: daKickoffPezzo(x.file, quando)
      })).sort((x, y) => (x.da === null ? 0 : x.da) - (y.da === null ? 0 : y.da));
      // SOLO QUELLO CHE STA DENTRO LA PARTITA. vMix apre un file nuovo a
      // ogni stop, e nella stessa giornata con lo stesso titolo finiscono
      // anche le prove, il preshow, il collegamento di quattro ore prima:
      // Gremio-Bolivar aveva quattro pezzi, e due erano di un'altra cosa.
      // L'ora di inizio ce l'ha ogni file e il calcio d'inizio lo dice
      // Airtable: si tiene la finestra della partita — da un'ora prima a
      // due ore e mezza dopo — e il resto si scarta. Se cosi' non resta
      // niente si tiene tutto: meglio un pezzo di troppo che nessuno.
      const dentroLaPartita = pezzi.filter((x) => x.da === null || (x.da >= -3600 && x.da <= 9000));
      if (dentroLaPartita.length) {
        scartati += pezzi.length - dentroLaPartita.length;
        pezzi = dentroLaPartita;
      }
      const kick = kickoffNelFile(pezzi[0].file, quando);
      if (kick !== null) conKickoff++;
      if (scelta.fonte === "intera" || scelta.fonte === "intero") intere++;
      agganciate++;
      const orologioPrima = (ARCHIVIO[rec.id] || {}).orologio;
      ARCHIVIO[rec.id] = { orologio: orologioPrima, bucket: bucket, chiave: pezzi[0].chiave, peso: pezzi[0].peso,
        partita: f["Partita"] || "", competizione: f["Competizione"] || "",
        variante: "", giorno: meglio.giorno, dove: meglio.dove,
        fonte: scelta.fonte, pezzi: pezzi, kickoff: kick,
        sicuro: punteggio >= 0.8 && scelta.fonte !== "unico", quando: f["Data | Orario"] };
    }
  }

  // 3) Le partite che Airtable non conosce. La base parte da meta' 2025, il
  //    secchio dal 2023: in mezzo ci sono migliaia di cartelle con dentro
  //    una partita intera e nessun record a cui agganciarle. Non avranno
  //    appunti ne' calcio d'inizio, ma esistono, e un archivio che le
  //    nasconde perche' manca una riga in un database non e' un archivio.
  //    Prendono un'identita' loro, fatta dal percorso, e stanno in elenco.
  let soleS3 = 0, assorbite = 0, promosse = 0;
  // la stessa partita sta spesso in due posti: TEMP/<giorno>/ con la
  // registrazione intera e BACKUP/... con i pezzi esportati. Non sono due
  // partite. Si riconoscono da giorno e nome (senza risultato ne' parentesi)
  const chiaveDoppia = (g, t) => g + "|" + String(t || "").toUpperCase().replace(/\[[^\]]*\]|\(.*?\)|\b\d+\s*-\s*\d+\b/g, "").replace(/[^A-Z0-9]+/g, " ").trim();
  const linkate = {};
  Object.keys(ARCHIVIO).forEach((k) => { if (k.indexOf("s3:") !== 0) linkate[chiaveDoppia(ARCHIVIO[k].giorno, ARCHIVIO[k].partita)] = k; });
  // I minuti misurati appartengono al FILE, non alla partita: si tengono da
  // parte e si rimettono, se no ogni giro dell'indice li butta e bisogna
  // rimisurare ventiduemila file (e rifare la scelta del materiale).
  const durateNote = {};
  Object.keys(ARCHIVIO).forEach((k) => (ARCHIVIO[k].pezzi || []).forEach((x) => {
    if (x.chiave && x.minuti) durateNote[x.chiave] = x.minuti;
  }));
  const orologiSoleS3 = {};
  Object.keys(ARCHIVIO).forEach((k) => {
    if (k.indexOf("s3:") !== 0 || ARCHIVIO[k].bucket !== bucket) return;
    if (ARCHIVIO[k].orologio) orologiSoleS3[k] = ARCHIVIO[k].orologio;   // l'id e' stabile: si ritrova
    delete ARCHIVIO[k];
  });
  Object.keys(gruppi).forEach((k) => {
    const gr = gruppi[k];
    if (gr.presa) return;
    const scelta = scegliMateriale(gr, "");
    if (!scelta || scelta.fonte === "unico") return;      // non e' una partita intera: si lascia stare
    const g = gr.giorno;
    const quando = new Date(Date.UTC(+g.slice(0, 4), +g.slice(4, 6) - 1, +g.slice(6, 8), 18, 0)).toISOString();
    const pezzi = scelta.pezzi.slice().sort((x, y) => {
      const ox = oraNelNome(x.file), oy = oraNelNome(y.file);
      return ((ox ? (ox.h % 12) * 3600 + ox.m * 60 + ox.s : 0) - (oy ? (oy.h % 12) * 3600 + oy.m * 60 + oy.s : 0));
    });
    // la competizione e' il pezzo di percorso subito sopra la stagione o la partita
    const via = gr.dove.split("/");
    const comp = via.slice(1, -1).filter((x) => !/^(stagione|partite|\d{4}|\d{2}-\d{2}|turno|round|giornata|andata|ritorno|fase)/i.test(x)).pop() || "";
    const gemella = linkate[chiaveDoppia(g, gr.partita.replace(/[_]+/g, " "))];
    if (gemella) {
      const L = ARCHIVIO[gemella];
      // se qui c'e' la partita intera e la gemella aveva solo i pezzi, il
      // materiale migliore passa alla gemella (il cronometro va riletto)
      if (scelta.fonte === "intero" && L.fonte !== "intero") {
        Object.assign(L, { chiave: pezzi[0].chiave, peso: pezzi[0].peso, dove: gr.dove, fonte: scelta.fonte, pezzi: pezzi,
                           kickoff: kickoffNelFile(pezzi[0].file, Date.parse(L.quando)), orologio: undefined });
        promosse++;
      } else assorbite++;
      return;
    }
    // ANCHE LE ORFANE HANNO UNA LINEA DEL TEMPO. Senza riga Airtable non
    // c'e' un calcio d'inizio da cui contare, e i pezzi restavano senza
    // "da": il cronometro e il tabellone non sapevano dove andare a
    // guardare, e proprio queste — quelle di cui non sappiamo niente —
    // sono le partite che avrebbero piu' bisogno di essere lette. L'asse
    // ce l'hanno lo stesso: e' l'ora scritta nel nome dei file, contata dal
    // primo. Il fischio vero lo trovera' il cronometro.
    const primaOra = oraNelNome(pezzi[0].file);
    if (primaOra) {
      const inSecondi = (o2) => (o2.h % 12) * 3600 + o2.m * 60 + o2.s;
      let scorso = 0;
      pezzi.forEach((x, n2) => {
        if (n2 === 0) { x.da = 0; return; }
        const o2 = oraNelNome(x.file);
        if (!o2) { x.da = null; return; }
        let d = inSecondi(o2) - inSecondi(primaOra);
        while (d < scorso) d += 12 * 3600;
        x.da = d; scorso = d;
      });
    }
    const id = "s3:" + crypto.createHash("sha1").update(gr.dove).digest("hex").slice(0, 14);
    ARCHIVIO[id] = { orologio: orologiSoleS3[id], bucket: bucket, chiave: pezzi[0].chiave, peso: pezzi[0].peso,
      partita: gr.partita.replace(/[_]+/g, " ").trim(), competizione: comp.replace(/[_]+/g, " "),
      variante: "", giorno: g, dove: gr.dove, fonte: scelta.fonte, pezzi: pezzi,
      kickoff: null, sicuro: false, quando: quando, soloS3: true };
    soleS3++;
  });

  // si rimettono i minuti conosciuti, e chi li ha tutti non va rimisurato
  let riavuti = 0;
  Object.keys(ARCHIVIO).forEach((k) => {
    const a = ARCHIVIO[k], pz = a.pezzi || [];
    pz.forEach((x) => { if (!x.minuti && durateNote[x.chiave]) { x.minuti = durateNote[x.chiave]; riavuti++; } });
    if (pz.length && pz.every((x) => x.minuti)) a.misurato = a.misurato || new Date().toISOString();
  });
  if (riavuti) console.log("[clip] archivio: " + riavuti + " durate gia' note rimesse a posto");
  scriviArchivio();
  if (scartati) console.log("[clip] archivio: " + scartati + " pezzi fuori dalla partita scartati");
  return { ok: true, oggettiVisti: visti, fileTenuti: tenuti, durateRimesse: riavuti, pezziScartati: scartati,
           cartellePartita: Object.keys(gruppi).length,
           partiteViste: tornate, agganciate: agganciate, intere: intere, doppieAssorbite: assorbite, promosseAIntere: promosse,
           conKickoff: conKickoff, soloS3: soleS3, senzaAggancio: orfane.slice(0, 15),
           // l'elenco intero, per chi vuole capire PERCHE' non si agganciano:
           // le partite di Airtable rimaste senza file, e i file rimasti senza
           // partita — messi uno accanto all'altro si vede se e' una regola
           orfaneTutte: p.tutte ? orfane : undefined,
           soleNas: p.tutte ? Object.keys(gruppi).filter((k) => !gruppi[k].presa).map((k) => ({
             giorno: gruppi[k].giorno, partita: gruppi[k].partita,
             file: gruppi[k].file.length, gb: Math.round(gruppi[k].file.reduce((a, f) => a + f.peso, 0) / 1e8) / 10 })) : undefined };
}

// ══════════════════════════════════════════════════════════════════════
//  QUELLO CHE E' STATO DETTO
// ══════════════════════════════════════════════════════════════════════
//
//  I giornalisti scrivono le azioni che contano, e sono precisi. Ma in due
//  ore di telecronaca si dicono altre mille cose — il nome di chi ha fatto
//  il fallo, la formazione, il precedente, la battuta — che nessuno mette
//  negli appunti perche' nessuno puo' scrivere tutto.
//
//  La trascrizione le rende cercabili. Non sostituisce gli appunti: quelli
//  dicono COSA E' SUCCESSO, questa dice COSA SI E' DETTO, e le due cose si
//  sommano invece di farsi concorrenza.
//
//  Gira in casa, su questa macchina, con whisper.cpp: l'audio delle nostre
//  partite non esce da qui. Il prezzo e' il tempo — due processori sono
//  due processori — e per questo si lavora una cosa alla volta e mai
//  mentre c'e' una registrazione in corso: la diretta viene prima.

const WHISPER = process.env.COMOTV_WHISPER || "/opt/whisper.cpp/build/bin/whisper-cli";
const MODELLO = process.env.COMOTV_WHISPER_MODELLO || "/opt/whisper.cpp/models/ggml-small.bin";
const LINGUA_MAM = process.env.COMOTV_WHISPER_LINGUA || "it";

let PARLATO = {};        // regId -> { lingua, pezzi: [{a, b, x}] }
const CODA_VOCE = [];
let voceAlLavoro = null;

function fileParlato() { return path.join(DIR, "parlato.json"); }
function leggiParlato() {
  try { PARLATO = JSON.parse(fs.readFileSync(fileParlato(), "utf8")) || {}; }
  catch (e) { PARLATO = {}; }
}
function scriviParlato() {
  try {
    const tmp = fileParlato() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(PARLATO));
    fs.renameSync(tmp, fileParlato());
  } catch (e) { console.log("[clip] parlato non salvato: " + e.message); }
}
function whisperCe() { return fs.existsSync(WHISPER) && fs.existsSync(MODELLO); }

// Da dove si prendono i byte dell'audio: il disco se ci sono, l'indirizzo
// firmato se la partita sta in archivio. Con -ss e -t si scarica solo il
// pezzo che serve, non tutto il file.
function sorgenteAudio(r, t) {
  if (r.arch) return viaArchivio(r, t || 0);
  const integrale = path.join(cartellaReg(r.id), "integrale.mp4");
  if (fs.existsSync(integrale)) return integrale;
  const segs = segmenti(r.id);
  if (segs.length) return playlistDi(r.id);   // la lista locale: ffmpeg la legge come un file solo
  return null;
}

// Dove comincia davvero la partita dentro il file: il calcio d'inizio letto
// dal cronometro se c'e', altrimenti quello stimato dall'ora nel nome.
function fischioNelFile(r) {
  if (!r.arch) return (r.kickoff && r.kickoff["1"] !== undefined) ? r.kickoff["1"] : null;
  const a = ARCHIVIO[r.arch.rec];
  if (!a || a.kickoff === null || a.kickoff === undefined) return null;
  if ((r.arch.pezzo || 0) !== 0) return null;           // le altre parti cominciano gia' in mezzo
  const o = a.orologio || {};
  return Math.round(a.kickoff + (o.inizio1 !== undefined && o.inizio1 !== null ? o.inizio1 : 0));
}
function trascriviChiedi(p) {
  if (!whisperCe()) {
    return { ok: false, errore: "il motore di trascrizione non e' installato su questa macchina" };
  }
  const r = R.reg[String(p.reg || "")];
  if (!r) return { ok: false, errore: "registrazione sconosciuta" };
  // Il pre-partita non ha niente da dire, e per whisper e' una trappola: sulla
  // musica dello stadio entra in circolo e ripete "[Musica]" all'infinito
  // senza avanzare. Se si sa dove comincia la partita, si comincia da li'.
  const dalFischio = fischioNelFile(r);
  const da = (p.da === undefined || p.da === null) && dalFischio !== null
    ? Math.max(0, dalFischio - 60) : num(p.da, 0, MAX_SECONDI, 0);
  const durataTotale = r.durata || 0;
  const a = num(p.a, 0, MAX_SECONDI, durataTotale || (da + 600));
  if (a - da < 5) return { ok: false, errore: "un pezzo cosi' corto non ha niente da dire" };

  const gia = CODA_VOCE.find((x) => x.reg === r.id && x.da === da && x.a === a);
  if (gia || (voceAlLavoro && voceAlLavoro.reg === r.id && voceAlLavoro.da === da)) {
    return { ok: true, giaInCoda: true, quantiInCoda: CODA_VOCE.length + (voceAlLavoro ? 1 : 0) };
  }
  // chiesta a mano: la lingua scritta nel nome vale subito, se no la annusa
  // la coda quando ci arriva
  CODA_VOCE.push({ reg: r.id, da: da, a: a, chiesta: Date.now(),
                   lingua: String(p.lingua || "") || linguaScritta(r) || r.lingua || "" });
  giraLaCoda();
  return { ok: true, inCoda: true, quantiInCoda: CODA_VOCE.length + (voceAlLavoro ? 1 : 0),
           minuti: Math.round((a - da) / 60) };
}

// Una alla volta, e mai sopra una diretta: due processori non si dividono
// in tre. Se c'e' una registrazione in corso la coda aspetta — l'archivio
// non scappa, la partita si'.
// Un whisper che macina due ore non deve morire con il servizio: se al
// riavvio si trova un voce.json piu' fresco del biglietto, quel lavoro e'
// finito — magari da un processo rimasto orfano — e si prende.
function metteDentroParlato(regId, finestra, j) {
  const pezzi = (j.transcription || []).map((t) => ({
    a: Math.round((t.offsets.from / 1000 + finestra.da) * 10) / 10,
    b: Math.round((t.offsets.to / 1000 + finestra.da) * 10) / 10,
    x: String(t.text || "").trim()
  })).filter((t) => t.x);
  if (!pezzi.length) return 0;
  const dentro = PARLATO[regId] || (PARLATO[regId] = { lingua: LINGUA_MAM, pezzi: [] });
  if (finestra.intera) dentro.intera = new Date().toISOString();
  dentro.pezzi = dentro.pezzi.filter((t) => t.b <= finestra.da || t.a >= finestra.a).concat(pezzi).sort((x, y) => x.a - y.a);
  scriviParlato();
  return pezzi.length;
}
function raccogliParlato() {
  Object.keys(R.reg).forEach((k) => {
    const dir = cartellaReg(k), biglietto = path.join(dir, "voce.corso.json"), esito = path.join(dir, "voce.json");
    let f, e;
    try { f = JSON.parse(fs.readFileSync(biglietto, "utf8")); e = fs.statSync(esito); } catch (x) { return; }
    if (e.mtimeMs < (f.quando || 0)) return;                 // il json e' di prima: whisper sta ancora macinando
    if (voceAlLavoro && voceAlLavoro.reg === k) return;      // ci sta lavorando qualcuno adesso
    try {
      const n = metteDentroParlato(k, f, JSON.parse(fs.readFileSync(esito, "utf8")));
      fs.unlinkSync(biglietto);
      if (n) console.log("[clip] raccolta una trascrizione rimasta indietro: " + ((R.reg[k] || {}).titolo || k) + " (" + n + " pezzi)");
    } catch (x) { console.log("[clip] raccolta non riuscita (" + k + "): " + x.message); }
  });
}
setInterval(raccogliParlato, 120000);

// Quello che sta sul disco della VM (le dirette registrate) si trascrive
// senza spendere niente: a fine registrazione entra in coda tutta, e le
// registrazioni gia' sul disco si mettono in coda una volta al giorno di notte
// Al massimo tre a notte: una trascrizione tiene ferma la macchina per
// un'ora, e i cronometri hanno anche loro il diritto di andare avanti.
// ── IN CHE LINGUA PARLA QUESTA PARTITA ────────────────────────────────
//
//  Trascrivere una partita costa un'ora e venti di macchina. Farlo su un
//  international sound — dove c'e' solo l'ambiente dello stadio — o su una
//  telecronaca in spagnolo con il modello puntato sull'italiano, e' un'ora
//  e venti buttata, e il risultato non lo scarta nessuno perche' sembra
//  testo.
//
//  Il nome del file spesso lo dice gia': [ITA], [ENG]. Quando non lo dice,
//  si chiede a whisper stesso — in dodici secondi risponde "it (p=0.97)" e
//  poi si esce. Dodici secondi contro un'ora e venti: la domanda si fa
//  sempre. La risposta resta scritta sulla registrazione, e non si richiede
//  piu'.
const LINGUE_BUONE = ["it", "en"];
function tagMateriale(r) {
  const pezzi = r.arch ? pezziArch(r).map((x) => x.chiave).join(" ") : "";
  return (pezzi + " " + (r.titolo || "") + " " + ((ARCHIVIO[(r.arch || {}).rec] || {}).partita || "")).toUpperCase();
}
function linguaScritta(r) {
  const t = tagMateriale(r);
  if (/\[ENG\]|FULL MATCH ENG/.test(t)) return "en";
  if (/\[ITA\]/.test(t)) return "it";
  return "";
}
// l'inglese si tiene solo dove ha senso: le partite del Como in versione
// internazionale. Una telecronaca inglese di un'altra partita non serve a
// nessuno, e costa uguale.
function linguaCiSta(r, lingua) {
  if (lingua === "it") return true;
  if (lingua !== "en") return false;
  return /COMO/.test(tagMateriale(r));
}
async function annusaLaLingua(r) {
  if (r.lingua) return r.lingua;
  const f = fischioNelFile(r);
  const da = f !== null ? f + 600 : Math.min(900, Math.max(0, (r.durata || 600) / 3));
  const fonte = r.arch ? fonteAl(r, da) : { via: sorgenteAudio(r, da), dentro: da };
  if (!fonte || !fonte.via) return "";
  const wav = path.join(os.tmpdir(), "lingua-" + r.id + ".wav");
  try {
    await new Promise((ok, no) => {
      execFile("nice", ["-n", "15", FFMPEG, "-hide_banner", "-loglevel", "error",
                        "-ss", String(fonte.dentro), "-t", "60", "-i", fonte.via,
                        "-vn", "-af", panMono(quantiCanali(r), 0), "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", "-y", wav], { timeout: 600000 }, (e) => e ? no(e) : ok());
    });
    const fuori = await new Promise((ok) => {
      execFile("nice", ["-n", "15", WHISPER, "-m", MODELLO, "-l", "auto", "-dl", "-f", wav, "-t", "2"],
        { timeout: 600000 }, (e, so, se) => ok(String(so || "") + String(se || "")));
    });
    const m = /auto-detected language:\s*([a-z]{2})\s*\(p\s*=\s*([0-9.]+)\)/i.exec(fuori);
    if (!m) return "";
    // se non e' sicura, e' rumore di stadio: meglio non trascrivere niente
    r.lingua = (+m[2] >= 0.5) ? m[1].toLowerCase() : "muta";
    r.linguaSicura = Math.round(+m[2] * 100) / 100;
    scrivi();
    console.log("[clip] lingua di \"" + (r.titolo || r.id) + "\": " + r.lingua + " (p=" + r.linguaSicura + ")");
    return r.lingua;
  } catch (e) { return ""; }
  finally { try { fs.unlinkSync(wav); } catch (e) {} }
}

function parlatoLocaleInCoda(quante) {
  if (!whisperCe()) return 0;
  const tetto = quante || 3;
  let n = 0;
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.guarda || r.stato === "registra" || r.stato === "carica") return;
    if ((r.durata || 0) < 600) return;
    if (PARLATO[r.id] && PARLATO[r.id].intera) return;
    if (CODA_VOCE.some((x) => x.reg === r.id) || (voceAlLavoro && voceAlLavoro.reg === r.id)) return;
    if (CODA_VOCE.length >= tetto) return;
    // ANCHE L'ARCHIVIO. Erano escluse perche' l'audio veniva da S3 e due ore
    // di partita erano due ore di traffico da pagare. Dal magazzino di casa
    // non costa niente, e sono le partite che nessuno ha mai trascritto.
    const via = r.arch ? viaArchivio(r, 0) : sorgenteAudio(r);
    if (!via || /^https?:/i.test(via)) return;      // niente che si paghi a consumo
    // la lingua scritta nel nome basta; quella da annusare la decide la coda
    // quando ci arriva, perche' costa dodici secondi di macchina
    const scritta = linguaScritta(r);
    if (scritta && !linguaCiSta(r, scritta)) return;
    if (r.lingua && !linguaCiSta(r, r.lingua)) return;
    // dal fischio d'inizio, se si sa dov'e': il pre-partita e' una trappola
    const f = fischioNelFile(r);
    CODA_VOCE.push({ reg: r.id, da: f !== null ? Math.max(0, f - 60) : 0, a: r.durata,
                     chiesta: Date.now(), intera: true, lingua: scritta || r.lingua || "" }); n++;
  });
  CODA_VOCE.sort((x, y) => ((R.reg[y.reg] || {}).avviata || 0) - ((R.reg[x.reg] || {}).avviata || 0));
  giraLaCoda();
  return n;
}
setInterval(() => { const h = new Date().getHours(); if (h >= 1 && h < 6) parlatoLocaleInCoda(); }, 1800000);
let vocePid = 0, voceSpenta = false;
// SI DEVE POTER DIRE BASTA. Whisper gira staccato dal servizio apposta —
// cosi' due ore di lavoro sopravvivono a un riavvio — ma questo vuol dire
// che riavviare non lo ferma. Qui si ferma davvero: si svuota la coda e si
// chiude il gruppo di processi che sta macinando.
function fermaParlato(riaccendi) {
  if (riaccendi) { voceSpenta = false; setTimeout(giraLaCoda, 500); return { ok: true, acceso: true }; }
  voceSpenta = true;
  const quanti = CODA_VOCE.length;
  CODA_VOCE.length = 0;
  let ucciso = false;
  if (vocePid) { try { process.kill(-vocePid, "SIGTERM"); ucciso = true; } catch (e) {} }
  console.log("[clip] trascrizione fermata a mano: " + quanti + " in coda buttate" + (ucciso ? ", whisper chiuso" : ""));
  return { ok: true, acceso: false, tolteDallaCoda: quanti, fermato: ucciso };
}

function giraLaCoda() {
  if (voceSpenta || voceAlLavoro || !CODA_VOCE.length) return;
  const registrando = registrandoDavvero() || laDirettaGira();
  if (registrando) { setTimeout(giraLaCoda, 60000); return; }
  // una alla volta DAVVERO: dopo un riavvio puo' restare in giro un whisper
  // orfano che sta ancora macinando, e due su due core vanno la meta'
  if (whisperGira()) { setTimeout(giraLaCoda, 60000); return; }
  // il magazzino e' della regia prima che nostro: se ci stanno scrivendo,
  // due ore di lettura aspettano
  if (magazzinoOccupato()) { setTimeout(giraLaCoda, 300000); return; }
  voceAlLavoro = CODA_VOCE.shift();
  const lavoro = voceAlLavoro;
  const r0 = R.reg[lavoro.reg];
  // LA LINGUA SI DECIDE QUI, NON PRIMA. Dodici secondi di macchina per non
  // sprecarne quattromilaottocento su un ambiente di stadio o su una
  // telecronaca in spagnolo.
  Promise.resolve(lavoro.lingua || (r0 ? annusaLaLingua(r0) : ""))
    .then((lingua) => {
      lavoro.lingua = lingua || LINGUA_MAM;
      if (r0 && lingua && !linguaCiSta(r0, lingua)) {
        console.log("[clip] salto \"" + (r0.titolo || lavoro.reg) + "\": parla " + lingua);
        return null;
      }
      return trascriviDavvero(lavoro);
    })
    .catch((e) => console.log("[clip] trascrizione fallita: " + e.message))
    .then(() => { voceAlLavoro = null; annuncia(0, "clip"); setTimeout(giraLaCoda, 1000); setTimeout(giraOrologi, 1500); });
}

// I nomi propri sono quelli che il modello sbaglia — "Henry Kane" per Harry
// Kane, "o Lise" per Olise — ed e' un peccato, perche' sono esattamente le
// parole che poi si cercano. La cura e' dirglieli prima: i cognomi stanno
// gia' negli appunti di quella partita, scritti da chi guardava.
// Negli appunti la maiuscola non fa il cognome: a inizio riga ci finiscono
// "Palo", "Occasione", "Contropiede". Dirle al modello come se fossero nomi
// propri lo porta fuori strada proprio sulle parole che poi si cercano.
const NON_E_UN_NOME = new Set(("gol,goal,palo,traversa,parata,parato,occasione,contropiede,rigore,angolo,corner,fallo,giallo," +
  "rosso,cartellino,tiro,cross,colpo,gran,grande,bella,bello,primo,secondo,terzo,tempo,minuto,squadra,partita,super,doppia," +
  "doppio,ottima,ottimo,buona,buono,altra,altro,ancora,dopo,prima,sinistro,destro,testa,area,porta,rete,punizione,calcio," +
  "replay,sostituzione,cambio,espulsione,ammonizione,assist,passaggio,errore,salvataggio,miracolo,uscita,respinta,deviazione," +
  "chiusura,anticipo,scivolata,inserimento,verticalizzazione,azione,giocata,fischio,arbitro,portiere,difesa,attacco,centrocampo," +
  "sviluppi,mischia,volo,volee,piede,mano,braccio,fuorigioco,annullato,convalidato,intervento,recupero,supplementari,rigori," +
  "clip,social,skills,rating,note,appunti,formazione,formazioni,live,show,studio,pre,post,intervallo,poi,quindi,adesso,ecco," +
  "molto,tutto,tutti,niente,nessuno,sempre,mai,anche,solo,ecco,bene,male,meglio,peggio").split(","));
function nomiDaSuggerire(r) {
  const a = ARCHIVIO[r.evento] ? APPUNTI[r.evento] : APPUNTI[r.evento];
  const parole = new Set();
  (r.titolo || "").split(/[^A-Za-zÀ-ÿ]+/).forEach((w) => { if (w.length > 3 && !NON_E_UN_NOME.has(w.toLowerCase())) parole.add(w); });
  if (a) {
    a.righe.forEach((x) => {
      String(x.x || "").split(/[^A-Za-zÀ-ÿ']+/).forEach((w) => {
        // i cognomi in una riga di appunti sono le parole con la maiuscola
        // gli appunti sono scritti in maiuscolo, e passando "KANE" al
        // modello si ottiene un modello che urla: si rimette la forma
        // normale di un cognome, che e' quella che poi si cerca
        if (w.length > 3 && w[0] === w[0].toUpperCase() && !NON_E_UN_NOME.has(w.toLowerCase())) {
          parole.add(w[0].toUpperCase() + w.slice(1).toLowerCase());
        }
      });
    });
  }
  // le rose di ESPN hanno la grafia ufficiale: sono i nomi migliori
  // le rose di ESPN hanno la grafia ufficiale: vanno in testa, prima delle
  // parole raccolte a mano, perche' il modello guarda soprattutto le prime
  const dalleRose = [];
  const e = ESPN[r.evento];
  if (e && e.rose) Object.keys(e.rose).forEach((sq) => e.rose[sq].forEach((n) => {
    const cognome = String(n).split(/\s+/).pop();
    if (cognome && cognome.length > 2) { dalleRose.push(cognome); parole.delete(cognome); }
  }));
  const lista = dalleRose.concat([...parole]).slice(0, 80).join(", ");
  return lista ? ("Telecronaca di calcio. Nomi: " + lista + ".") : "";
}

function trascriviDavvero(lavoro) {
  const r = R.reg[lavoro.reg];
  if (!r) return Promise.reject(new Error("registrazione sparita"));
  const fonte = r.arch ? fonteAl(r, lavoro.da) : null;
  const via = fonte ? fonte.via : sorgenteAudio(r);
  const daQui = fonte ? fonte.dentro : lavoro.da;
  const finoA = fonte ? Math.min(lavoro.a, fonte.fine) : lavoro.a;
  const dir = cartellaReg(r.id);
  const wav = path.join(dir, "voce.wav");
  const partenza = Date.now();

  return new Promise((ok, no) => {
    // audio solo, mono, sedicimila: e' quello che vuole il modello, e pesa
    // un centesimo del video
    const args = via
      ? ["-hide_banner", "-loglevel", "error", "-ss", String(daQui), "-i", via,
         "-t", String(Math.max(1, finoA - lavoro.da)), "-vn",
         "-af", panMono(quantiCanali(r), 0), "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-y", wav]
      : null;
    if (!args) return no(new Error("di questa registrazione non c'e' audio raggiungibile"));
    // l'audio gia' tirato fuori si tiene: un riavvio non deve far riscaricare
    // sette giga da S3 per riavere gli stessi centosessanta minuti di parlato
    try {
      // l'audio in casa: prima si guarda CHE FINESTRA copre, poi si decide.
      // (Guardare solo la misura del file diceva "e' gia' quello" anche
      //  quando la finestra chiesta era un'altra.)
      const w = JSON.parse(fs.readFileSync(wav + ".json", "utf8"));
      const c = fs.statSync(wav);
      if (Math.abs(w.da - lavoro.da) < 1 && Math.abs(w.a - lavoro.a) < 2) {
        console.log("[clip] audio gia' pronto: " + Math.round(c.size / 1e6) + " MB");
        return ok();
      }
      // copre piu' di quello che serve: si taglia qui, invece di ricomprare
      // gli stessi minuti da S3
      if (lavoro.da >= w.da && lavoro.a <= w.a + 1) {
        const dentroWav = lavoro.da - w.da;
        const stretto = path.join(dir, "voce.finestra.wav");
        return execFile("nice", ["-n", "15", "ffmpeg", "-hide_banner", "-loglevel", "error",
                                 "-ss", String(dentroWav), "-t", String(lavoro.a - lavoro.da),
                                 "-i", wav, "-c", "copy", "-y", stretto], { timeout: 600000 },
          (e) => { if (e) return no(e); try { fs.renameSync(stretto, wav); fs.writeFileSync(wav + ".json", JSON.stringify({ da: lavoro.da, a: lavoro.a })); } catch (x) {}
                   console.log("[clip] audio ritagliato in casa: da " + lavoro.da + "s"); ok(); });
      }
    } catch (e) { /* non c'e', o non copre: si estrae */ }
    // a bassa priorita': la trascrizione e' lavoro di notte, non deve
    // rallentare ne' una diretta ne' le altre code
    execFile("nice", ["-n", "15", "ffmpeg"].concat(args), { timeout: 3600000 }, (e) => {
      if (e) return no(e);
      try { fs.writeFileSync(wav + ".json", JSON.stringify({ da: lavoro.da, a: lavoro.a })); } catch (x) {}
      ok();
    });
  }).then(() => new Promise((ok, no) => {
    // il biglietto accanto al lavoro: se il servizio muore mentre whisper
    // macina, chi riparte sa che finestra stava trascrivendo e la raccoglie
    try { fs.writeFileSync(path.join(dir, "voce.corso.json"), JSON.stringify({ da: lavoro.da, a: lavoro.a, intera: !!lavoro.intera, quando: Date.now() })); } catch (e) {}
    const suggeriti = nomiDaSuggerire(r);
    // -mc 0: ogni finestra si decide da sola, senza portarsi dietro il testo
    // di quella prima. E' la cura della ripetizione: sulle parole poco chiare
    // il modello si aggrappava all'ultima e la ripeteva venti volte.
    const args = ["-m", MODELLO, "-l", lavoro.lingua || LINGUA_MAM, "-f", wav, "-oj", "-of",
                  path.join(dir, "voce"), "-t", "2", "-np", "-nt", "-mc", "0", "-et", "2.8"];
    if (suggeriti) args.push("--prompt", suggeriti);
    // STACCATO DAVVERO. Con execFile whisper scrive su una pipe che appartiene
    // al nodo: se il servizio si riavvia la pipe si rompe e due ore di lavoro
    // muoiono con un SIGPIPE. Sessione sua, niente pipe, il log su file: cosi'
    // sopravvive al riavvio, finisce, e raccogliParlato lo va a prendere.
    let log;
    try { log = fs.openSync(path.join(dir, "voce.log"), "w"); } catch (e) { log = "ignore"; }
    const bimbo = spawn("nice", ["-n", "15", WHISPER].concat(args),
                        { detached: true, stdio: ["ignore", log, log] });
    vocePid = bimbo.pid || 0;
    if (typeof log === "number") { try { fs.closeSync(log); } catch (e) {} }
    bimbo.on("error", no);
    bimbo.on("exit", (codice, segnale) => { vocePid = 0; return codice === 0 ? ok()
      : no(new Error("whisper e' uscito con " + (segnale || codice))); });
  })).then(() => {
    try { fs.unlinkSync(path.join(dir, "voce.corso.json")); } catch (e) {}
    const j = JSON.parse(fs.readFileSync(path.join(dir, "voce.json"), "utf8"));
    const pezzi = (j.transcription || []).map((t) => ({
      a: Math.round((t.offsets.from / 1000 + lavoro.da) * 10) / 10,
      b: Math.round((t.offsets.to / 1000 + lavoro.da) * 10) / 10,
      x: String(t.text || "").trim()
    })).filter((t) => t.x);

    const dentro = PARLATO[r.id] || (PARLATO[r.id] = { lingua: LINGUA_MAM, pezzi: [] });
    if (lavoro.intera) dentro.intera = new Date().toISOString();
    // finche' l'audio e' in mano si prende anche il resto: i boati costano
    // un minuto di CPU e non un byte in piu'
    volumeAlSecondo(wav).then((v) => {
      if (!v.length) return;
      const picchi = picchiDiVolume(v, lavoro.da, 8, 60, 15);
      r.marker = (r.marker || []).filter((m) => m.fonte !== "boato");
      picchi.forEach((x) => r.marker.push({ id: nuovoId("m"), secondi: x.secondi, tipo: "boato",
        testo: "Boato dello stadio (+" + x.forza + " dB)", fonte: "boato", quando: Date.now() }));
      r.marker.sort((a, b) => a.secondi - b.secondi);
      scrivi(); annuncia(0, "clip");
      console.log("[clip] boati trovati in " + (r.titolo || r.id) + ": " + picchi.length);
    }).catch(() => {});
    // si rifa' la finestra invece di accodare: chiedere due volte lo stesso
    // pezzo non deve raddoppiare quello che ci si trova dentro
    dentro.pezzi = dentro.pezzi.filter((t) => t.b <= lavoro.da || t.a >= lavoro.a)
                               .concat(pezzi)
                               .sort((x, y) => x.a - y.a);
    scriviParlato();
    try { fs.unlinkSync(wav); } catch (e) {}
    console.log("[clip] trascritti " + Math.round((lavoro.a - lavoro.da) / 60) + " minuti di " +
                r.titolo + " in " + Math.round((Date.now() - partenza) / 1000) + "s: " +
                pezzi.length + " frasi");
  });
}

// Le frasi che contengono le parole cercate, con dentro quale partita e a
// che secondo sono state dette.
function cercaNelParlato(q, limite) {
  const fuori = [];
  Object.keys(PARLATO).forEach((regId) => {
    const r = R.reg[regId];
    if (!r) return;
    const tele = (APPUNTI[r.evento] || {}).telecronista || "";
    const capo = comeSiCerca([r.titolo, r.competizione, tele]);
    if (!quandoTorna(r.avviata, q)) return;
    PARLATO[regId].pezzi.forEach((t) => {
      if (!tutteDentro(comeSiCerca([t.x, capo]), q.parole)) return;
      fuori.push({ reg: regId, partita: r.titolo, secondi: t.a, testo: t.x,
                   telecronista: tele, quando: r.avviata });
    });
  });
  return fuori.slice(0, limite);
}

// ══════════════════════════════════════════════════════════════════════
//  L'ARCHIVIO DEGLI APPUNTI
// ══════════════════════════════════════════════════════════════════════
//
//  Novecentonovanta partite giocate hanno gia' dentro 9.595 azioni
//  tipizzate: gol, parate, pali, occasioni, con minuto e descrizione. Sono
//  scritte da chi guardava e oggi vivono dentro una cella di Airtable, che
//  e' come dire che non esistono: nessuno le cerca perche' non si possono
//  cercare.
//
//  Portarle qui non richiede di avere il video: un'azione trovata dice
//  QUALE partita e QUALE minuto, e il materiale sta sul server della
//  redazione. E' l'ottanta per cento del valore di un archivio, senza un
//  byte di video.
//
//  Stanno in un file loro: cambiano una volta ogni tanto e sono tante,
//  quindi non devono appesantire il registro che si riscrive a ogni clip.

let APPUNTI = {};        // recId -> { partita, competizione, quando, righe[] }

function fileAppunti() { return path.join(DIR, "appunti.json"); }

function leggiArchivioAppunti() {
  try { APPUNTI = JSON.parse(fs.readFileSync(fileAppunti(), "utf8")) || {}; }
  catch (e) { APPUNTI = {}; }
}
function scriviArchivioAppunti() {
  try {
    const tmp = fileAppunti() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(APPUNTI));
    fs.renameSync(tmp, fileAppunti());
  } catch (e) { console.log("[clip] archivio appunti non salvato: " + e.message); }
}

// Chi ha raccontato la partita. Su Airtable il campo cambia forma — un
// nome, una lista, una scheda con dentro il nome — e cambia anche il titolo
// della colonna: si prende quello che c'e'.
function chiRacconta(f) {
  const dentro = (v) => Array.isArray(v) ? v.map(dentro).filter(Boolean).join(", ")
    : (v && typeof v === "object") ? String(v.name || v.displayName || v.email || "").trim()
    : String(v || "").trim();
  for (const k of ["Commento 1", "Commento", "Telecronista", "Telecronaca", "Commento 2"]) {
    const v = dentro(f[k]);
    if (v) return v.replace(/[\[\]']/g, "").trim();
  }
  return "";
}
async function appuntiImporta(p) {
  const giorni = num(p.giorni, 1, 3650, 400);
  const tetto = num(p.quante, 1, 5000, 1200);
  const formula = "AND(IS_BEFORE({Data | Orario}, TODAY()), " +
    "IS_AFTER({Data | Orario}, DATEADD(TODAY(), -" + Math.round(giorni) + ", 'days')), " +
    "NOT({Partita} = BLANK()))";
  const base = "https://api.airtable.com/v0/" + AT_BASE + "/" + AT_PARTITE;
  let offset = "", giri = 0, viste = 0, conRighe = 0, righe = 0;

  do {
    const q = new URLSearchParams({
      filterByFormula: formula, pageSize: "100",
      "sort[0][field]": "Data | Orario", "sort[0][direction]": "desc"
    });
    if (offset) q.set("offset", offset);
    const j = await atLeggi(base + "?" + q.toString());
    (j.records || []).forEach((rec) => {
      if (viste >= tetto) return;
      viste++;
      const f = rec.fields || {};
      const note = leggiAppunti(f["Appunti"] || "", 45);
      if (!note.length) { delete APPUNTI[rec.id]; return; }
      conRighe++; righe += note.length;
      APPUNTI[rec.id] = {
        partita: f["Partita"] || "", competizione: f["Competizione"] || "",
        telecronista: chiRacconta(f),
        quando: f["Data | Orario"] || "",
        // "Rating Evento" da 1 a 5: le partite da cinque stelle tengono la
        // sequenza completa del rigore, le altre solo il replay del fallo
        stelle: Number(f["Rating Evento"] || 0) || 0,
        righe: note.map((n) => ({
          m: n.minuto, t: n.tipo, x: n.testo.slice(0, 180), s: n.sezione,
          d: n.dentroTempo, hl: n.hl ? 1 : 0, g: n.rating || 0
        }))
      };
    });
    offset = j.offset || "";
  } while (offset && ++giri < 30 && viste < tetto);

  scriviArchivioAppunti();
  return { ok: true, partiteViste: viste, partiteConAzioni: conRighe, azioni: righe };
}

// ── LA BASE STORICA (2021 → ottobre 2025) ─────────────────────────
//  Prima della base di oggi ce n'era un'altra, con tremilaseicento partite
//  e gli stessi appunti per tempo. Il MAM non la sapeva. Si legge per id
//  di campo (i nomi non sono esposti), si tiene in appunti.json con le
//  altre e in storici.json come elenco di eventi da agganciare a S3.
const AT_STORICA = "app3Q50LflohJszRj", AT_STORICA_TAB = "tblNrLWnDRU6aHtkF";
const ST = { partita: "fldmjmdjDuLYA0YZj", giorno: "fld6wMroEYwLGEnAW", ora: "fldXzEfFf4R42Uy5W",
             competizione: "fldzTqQ1ikWxZx2Ts", telecronista: "fldOECoJujTvlZEwc", appunti: "fldy0ecGL4j9HtpQX" };
let STORICI = [];
function fileStorici() { return path.join(DIR, "storici.json"); }
function leggiStorici() { try { STORICI = JSON.parse(fs.readFileSync(fileStorici(), "utf8")) || []; } catch (e) { STORICI = []; } }
// la data e' un giorno e l'ora un testo "20:45": insieme fanno l'orario di
// Roma, che e' quello che serve per leggere l'ora nel nome del file
function quandoStorico(giorno, ora) {
  const m = /^(\d{1,2})[:.](\d{2})/.exec(String(ora || "").trim());
  if (!giorno) return "";
  const hh = m ? +m[1] : 18, mm = m ? +m[2] : 0;
  const locale = new Date(giorno + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00");
  // il fuso di Roma: la VM sta in UTC, quindi si corregge a mano (+1 o +2)
  const sRoma = new Date(locale.getTime()).toLocaleString("en-GB", { timeZone: "Europe/Rome", hour12: false });
  const mr = /(\d{2}):(\d{2})/.exec(sRoma);
  const scarto = mr ? ((+mr[1] * 60 + +mr[2]) - (hh * 60 + mm)) : 0;
  const norm = ((scarto + 720) % 1440) - 720;
  return new Date(locale.getTime() - norm * 60000).toISOString();
}
async function appuntiStoriciImporta(p) {
  const base = "https://api.airtable.com/v0/" + AT_STORICA + "/" + AT_STORICA_TAB;
  let offset = "", viste = 0, conRighe = 0, righe = 0, giri = 0;
  const eventi = [];
  do {
    const q = new URLSearchParams({ pageSize: "100", returnFieldsByFieldId: "true" });
    if (offset) q.set("offset", offset);
    const j = await atLeggi(base + "?" + q.toString());
    (j.records || []).forEach((rec) => {
      const f = rec.fields || {};
      const partita = String(f[ST.partita] || "").replace(/\s+/g, " ").trim();
      const quando = quandoStorico(f[ST.giorno], f[ST.ora]);
      if (!partita || !quando) return;
      viste++;
      const comp = (f[ST.competizione] && f[ST.competizione].name) || f[ST.competizione] || "";
      const tele = String((f[ST.telecronista] && f[ST.telecronista].name) || f[ST.telecronista] || "").replace(/[\[\]']/g, "").trim();
      eventi.push({ id: rec.id, partita: partita, competizione: String(comp).trim(), quando: quando });
      const note = leggiAppunti(f[ST.appunti] || "", 45);
      if (!note.length) { if (APPUNTI[rec.id] && APPUNTI[rec.id].fonte === "storico") delete APPUNTI[rec.id]; return; }
      conRighe++; righe += note.length;
      APPUNTI[rec.id] = {
        partita: partita, competizione: String(comp).trim(), quando: quando, fonte: "storico",
        telecronista: String(tele).trim(),
        righe: note.map((n) => ({ m: n.minuto, t: n.tipo, x: n.testo.slice(0, 180), s: n.sezione, d: n.dentroTempo, hl: n.hl ? 1 : 0, g: n.rating || 0 }))
      };
    });
    offset = j.offset || "";
  } while (offset && ++giri < 60);
  STORICI = eventi;
  try { fs.writeFileSync(fileStorici(), JSON.stringify(STORICI)); } catch (e) {}
  scriviArchivioAppunti();
  console.log("[clip] base storica: " + viste + " partite, " + conRighe + " con appunti, " + righe + " righe");
  return { ok: true, partiteViste: viste, partiteConAzioni: conRighe, azioni: righe };
}

// Dove cade un appunto dentro il file d'archivio. Il primo tempo e' una
// somma semplice; il secondo passa per l'intervallo, che dura quindici
// minuti quando va bene e non lo sa nessuno con precisione. Si dice che
// e' una stima invece di far finta di no.
// ── DOVE COMINCIA IL SECONDO TEMPO ────────────────────────────────────
//
//  Senza cronometro letto, il secondo tempo si stimava "un'ora dopo il
//  calcio d'inizio". Non e' mai vero: l'intervallo dura quindici minuti,
//  piu' il recupero del primo tempo, piu' il rientro in campo — sulle
//  partite vere la ripresa cade fra i 62 e i 68 minuti. Sei minuti di
//  errore sono un'altra azione, e spesso cadevano PRIMA che il file del
//  secondo tempo cominciasse: l'appunto finiva nella coda di un file gia'
//  finito, ed e' per questo che degli appunti si leggeva solo il primo
//  tempo.
//
//  Ma i due tempi stanno in due file, e il registratore si ferma
//  all'intervallo: il buco fra un file e l'altro E' l'intervallo. Allora
//  lo zero del secondo tempo non si stima, si guarda — e' l'inizio del
//  secondo file, piu' i pochi minuti in cui si registra prima del fischio.
//  Resta una stima, ma di un ordine di grandezza piu' vicina; il
//  cronometro, quando c'e', vince sempre.
const BUCO_INTERVALLO = 180;      // sotto i tre minuti e' uno stop, non l'intervallo
// Misurato leggendo il cronometro su undici partite: fra l'inizio del file
// del secondo tempo e il fischio di ripresa passano da 10 a 372 secondi,
// mediana 162. Con questo numero l'errore tipico resta sotto il minuto,
// contro i cinque-dieci minuti — sempre in anticipo — della vecchia regola.
const ANTICIPO_RIPRESA = 160;
function ripresaStimata(a) {
  const pezzi = (a.pezzi || []).filter((x) => x.da !== null && x.da !== undefined);
  if (pezzi.length < 2) return null;
  let buco = 0, dopo = null, durateNote = true;
  for (let i = 1; i < pezzi.length; i++) {
    const d0 = pezzi[i - 1].minuti ? pezzi[i - 1].minuti * 60 : null;
    if (d0 === null) { durateNote = false; continue; }
    const g = pezzi[i].da - (pezzi[i - 1].da + d0);
    if (g > buco) { buco = g; dopo = pezzi[i]; }
  }
  if (durateNote) return (dopo && buco >= BUCO_INTERVALLO) ? dopo.da + ANTICIPO_RIPRESA : null;
  // senza durate non si vede il buco: vale il pezzo che comincia dove puo'
  // cominciare solo una ripresa, fra i quaranta e gli ottanta minuti
  const c = pezzi.slice(1).filter((x) => x.da >= 2400 && x.da <= 4800);
  return c.length === 1 ? c[0].da + ANTICIPO_RIPRESA : null;
}

function secondoNelFile(rec, r) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  // secondi dal calcio d'inizio: il secondo tempo comincia un'ora dopo,
  // quarantacinque di gioco piu' un intervallo che nessuno cronometra
  // ...a meno che il cronometro non sia stato letto dal video: allora i due
  // tempi cominciano dove cominciano davvero (vedi calibraOrologio)
  const o = a.orologio || {};
  const inizio = r.s === 2
    ? (o.inizio2 !== undefined && o.inizio2 !== null ? o.inizio2
       : (ripresaStimata(a) === null ? 60 * 60 : ripresaStimata(a)))
    : (o.inizio1 !== undefined && o.inizio1 !== null ? o.inizio1 : 0);
  return doveCade(a, inizio + (r.d || 0));
}
// dove cade, fra i pezzi del materiale, un tempo t contato dal calcio
// d'inizio stimato: e' l'asse su cui stanno anche i "da" dei pezzi
function doveCade(a, t) {
  const pezzi = (a.pezzi || []).filter((x) => x.da !== null && x.da !== undefined);
  if (!pezzi.length) {
    if (a.kickoff === null || a.kickoff === undefined) return null;
    return { pezzo: 0, secondi: Math.round(a.kickoff + t), chiave: a.chiave };
  }
  let i = -1;
  pezzi.forEach((x, k) => { if (x.da <= t) i = k; });
  if (i < 0) return null;                    // l'azione cade prima del materiale
  // e se cade DOPO la fine di quel pezzo — nel buco fra un file e l'altro —
  // non e' nella coda di un file finito: e' all'inizio di quello dopo
  if (pezzi[i].minuti && (t - pezzi[i].da) > pezzi[i].minuti * 60 && pezzi[i + 1]) i++;
  return { pezzo: i, secondi: Math.max(0, Math.round(t - pezzi[i].da)), chiave: pezzi[i].chiave || a.chiave };
}

// ── IL CRONOMETRO LETTO DAL VIDEO ─────────────────────────────────
//  L'orario ufficiale dice quando la partita DOVREBBE cominciare; il
//  fischio arriva un minuto o due dopo, e la ripresa non e' a sessanta
//  minuti esatti ma dove capita: recupero, intervallo, ritardi. Al 70'
//  l'errore fa sei minuti, e sei minuti sono un'altra azione. L'unico che
//  sa l'ora giusta e' il cronometro in sovrimpressione: si prende un
//  fotogramma per tempo, si legge "63:50", e da li' si sa dove cade ogni
//  minuto degli appunti. Tre fotogrammi per partita, qualche decina di
//  mega dal bucket, un minuto di lavoro.
const TESSERACT = process.env.COMOTV_TESSERACT || "tesseract";
let tesseractVisto = null;
function tesseractCe() {
  if (tesseractVisto !== null) return tesseractVisto;
  try { execFileSync(TESSERACT, ["--version"], { stdio: "ignore", timeout: 5000 }); tesseractVisto = true; }
  catch (e) { tesseractVisto = false; }
  return tesseractVisto;
}

// la fascia alta di un fotogramma, a grandezza naturale: e' li' che sta
// la grafica. Il file resta su S3: ffmpeg salta al secondo e prende uno
const OROLOGIO_PY = path.join(__dirname, "orologio.py");
const CAMPO_PY = path.join(__dirname, "campo.py");
function fasciaAlta(via, sec) {
  return new Promise((ok) => {
    const png = path.join(os.tmpdir(), "orologio-" + nuovoId("") + ".png");
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, sec)), "-i", via,
                      "-frames:v", "1", "-vf", "crop=iw:ih*0.25:0:0", "-y", png],
      { timeout: 90000 }, (e, so, se) => {
        if (e) { console.log("[clip] cronometro: ffmpeg al secondo " + sec + ": " + String(se || e.message).trim().slice(0, 160)); return ok(null); }
        ok(png);
      });
  });
}
// Due fotogrammi a venti secondi di distanza: orologio.py trova la grafica
// (quello che fra i due sta fermo), la targa del cronometro, e la legge in
// tutti e due. Se le due letture non distano venti secondi, una delle due
// e' sbagliata e si buttano via entrambe: meglio niente che un minuto falso.
async function leggiOrologioSicuro(fascia, t, tutto) {
  const f1 = await fascia(t), f2 = f1 ? await fascia(t + 20) : null;
  const via = [f1, f2].filter(Boolean);
  const butta = () => { if (!process.env.COMOTV_OROLOGIO_DEBUG) via.forEach((f) => { try { fs.unlinkSync(f); } catch (x) {} }); };
  if (!f1 || !f2) { butta(); return null; }
  const esito = await new Promise((ok) => {
    execFile("python3", [OROLOGIO_PY, f1, f2], { timeout: 120000 }, (e, so, se) => {
      if (e) { console.log("[clip] cronometro: orologio.py: " + String(se || e.message).trim().slice(0, 200)); return ok(null); }
      try { ok(JSON.parse(String(so))); } catch (x) { ok(null); }
    });
  });
  butta();
  if (!esito || !esito.letture) return null;
  const c1 = esito.letture[0], c2 = esito.letture[1];
  console.log("[clip] cronometro: a " + t + "s dalla stima legge " + c1 + " e " + c2 +
              (esito.cifre ? " (targa " + esito.cifre.join(",") + ")" : "") + (esito.perche ? " — " + esito.perche : ""));
  if (c1 === null || c2 === null) return null;
  if (Math.abs((c2 - c1) - 20) > 3) return null;
  return tutto ? { c: c1, cifre: esito.cifre || esito.box || null } : c1;
}

// ══════════════════════════════════════════════════════════════════════
//  LA RIFINITURA DEI GOL — dove finisce il replay
// ══════════════════════════════════════════════════════════════════════
//
//  Il pezzo del gol nasce con maniglie generose, ottanta secondi in coda,
//  perche' il replay dura quanto vuole. Ottanta secondi a volte sono troppi
//  e a volte pochi. Il secondo giusto pero' e' scritto sullo schermo: la
//  regia TOGLIE il cronometro quando manda il replay e lo RIMETTE quando si
//  ricomincia. Non serve capire le immagini, basta guardare se quel numero
//  c'e' o non c'e'.
//
//  Costa: una decina di fotogrammi per gol, presi con una richiesta di
//  intervallo (pochi mega l'uno). Si fa in coda, una partita alla volta, e
//  solo per le partite che qualcuno apre davvero.

// Un fotogramma alla volta, tenuto sul disco finche' serve.
async function fascia(via, secondi) { return await fasciaAlta(via, Math.max(0, Math.round(secondi))); }
function butta(f) { try { if (f) fs.unlinkSync(f); } catch (e) {} }

// Quanto due fotogrammi si assomigliano dentro una finestra. 1 = identici.
async function quantoSiAssomigliano(box, rif, file) {
  return await new Promise((ok) => {
    execFile("python3", [OROLOGIO_PY, "--presente", box.join(","), rif].concat(file), { timeout: 60000 },
      (e, so) => { if (e) return ok([]); try { ok(JSON.parse(String(so)).somiglianze || []); } catch (x) { ok([]); } });
  });
}

// Il secondo in cui il cronometro torna dopo essere sparito. null se il
// replay non si trova (e allora si tiene la maniglia larga).
//
//  Il criterio non e' piu' "il lettore legge l'ora": il lettore ogni tanto
//  non legge anche quando la targa c'e', e un "non letto" scambiato per
//  "non c'e'" allungava il pezzo dentro il gioco. Adesso si guarda il
//  DISEGNO della targa: o c'e' o non c'e', e le cifre non contano.
// LE CIFRE DENTRO LA GRAFICA. Il cercatore di targhe a volte restituisce
// tutta la barra — "GRO 0 1 TWE 06:15" — e li' dentro il lettore di testo
// si perde fra il punteggio e le sigle. Ma il cronometro sta sempre a un
// capo della barra: si provano i due capi, e si tiene quello che legge un
// orario che avanza come deve.
async function targaDelleCifre(via, targa, t) {
  if (!targa) return null;
  const [x, y, w, h] = targa;
  if (w <= 140) return targa;                      // gia' stretta: sono le cifre
  const prova = [];
  [0.30, 0.26, 0.34].forEach((q) => {
    const lw = Math.round(w * q);
    prova.push([Math.round(x + w - lw), y, lw, h]);   // capo destro
    prova.push([x, y, lw, h]);                        // capo sinistro
  });
  for (const c of prova) {
    const a1 = await oraDelCronometro(via, c, t);
    if (a1 === null || a1 <= 0 || a1 > 8000) continue;
    const a2 = await oraDelCronometro(via, c, t + 20);
    if (a2 === null) continue;
    if (Math.abs((a2 - a1) - 20) <= 3) {
      console.log("[clip] cifre del cronometro: " + c.join(",") + " (legge " + a1 + " e " + a2 + ")");
      return c;
    }
  }
  return null;
}

// Legge il NUMERO del cronometro a un certo secondo. Serve per il secondo
// modo di riconoscere un replay, quello che vale sui feed che la grafica
// non la tolgono mai.
async function oraDelCronometro(via, targa, secondi) {
  const f = await fascia(via, secondi);
  if (!f) return null;
  const letto = await new Promise((ok) => {
    execFile("python3", [OROLOGIO_PY, "--targa", targa.join(","), f], { timeout: 60000 },
      (e, so) => { if (e) return ok(null); try { ok(JSON.parse(String(so)).letture[0]); } catch (x) { ok(null); } });
  });
  butta(f);
  return (letto === null || letto === undefined) ? null : letto;
}

// QUANDO RICOMINCIA IL GIOCO
//  Ci sono due modi in cui una regia dice "questo e' un replay". C'e' chi
//  TOGLIE il cronometro (Genoa): quello lo trova `fineDelReplay`. E c'e'
//  chi lo LASCIA acceso e lo fa correre uguale (Groningen): li' il
//  cronometro non dice niente, e per anni non si trovava niente.
//
//  Su quei feed si guarda l'INQUADRATURA. Il replay e' sempre stretto —
//  una camera dietro la porta, un carrello a bordo campo — e stacca in
//  continuazione; il gioco vero e' la camera larga in tribuna, che sta
//  ferma e riprende ventidue giocatori piccoli. Fra le due cose ci sono
//  cinque volte di differenza. Quindi non si cerca il replay: si cerca
//  DOVE RICOMINCIA IL GIOCO, che e' poi il punto in cui il pezzo deve
//  chiudere.
//
//  Tre numeri per ogni secondo (li fa campo.py) e una regola:
//    prato > 0,45   c'e' il campo
//    alto  < 0,15   in cima ci sono gli spalti, non altro prato — e' qui
//                   che casca un primo piano su un giocatore in mezzo al
//                   campo, che di verde ne ha 0,86 anche in alto
//    moto  < 25     la camera larga sta ferma
//
//  Misurato su quattro gol di GRONINGEN-TWENTE: la ripartenza trovata
//  cade entro un secondo da quella vera in tutti e quattro.
async function guardaIlCampo(via, da, durata, passo) {
  return await new Promise((ok) => {
    execFile("python3", [CAMPO_PY, via, String(da), String(durata), String(passo || 1)],
      { timeout: 900000, maxBuffer: 4 * 1024 * 1024 },
      (e, so) => { if (e) return ok([]); try { ok(JSON.parse(String(so)).campo || []); } catch (x) { ok([]); } });
  });
}

// Chi e' largo e chi no, secondo per secondo.
function larghi(campo) {
  return campo.map((x) => x.prato > 0.45 && x.alto < 0.15 && x.moto < 30);
}

// IL SECONDO IN CUI RIPARTE IL GIOCO, dopo il gol.
//  Si cerca il primo pezzo di camera larga che arriva dopo almeno otto
//  secondi di roba stretta (esultanza e replay non stanno mai sotto). E
//  poi si controlla che il gioco CONTINUI: ogni tanto anche un replay lo
//  fanno con la camera larga, ma dura quattro secondi e poi si torna in
//  stretto, mentre la ripartenza vera resta larga.
function ripartenza(campo, da) {
  const largo = larghi(campo);
  const MINIMO = 3, PRIMA = 8, DOPO = 15;
  for (let i = Math.max(da, PRIMA); i + MINIMO <= largo.length; i++) {
    if (!largo[i] || largo[i - 1]) continue;
    let bene = true;
    for (let j = i; j < i + MINIMO; j++) if (!largo[j]) { bene = false; break; }
    if (!bene) continue;
    let stretti = 0;
    for (let j = i - 1; j >= 0 && !largo[j]; j--) stretti++;
    if (stretti < PRIMA) continue;
    let dopo = 0, quanti = 0;
    for (let j = i; j < Math.min(largo.length, i + DOPO); j++) { quanti++; if (largo[j]) dopo++; }
    if (quanti >= 8 && dopo * 2 < quanti) continue;      // era un replay in campo largo
    return i;
  }
  return -1;
}

// IL SECONDO IN CUI E' STATO FATTO IL GOL.
//  Lo stesso disegno, letto al contrario: finche' si gioca c'e' la camera
//  larga, e nell'istante in cui la palla entra la regia va sui visi e non
//  torna piu' per un pezzo. Quindi il gol e' dove FINISCE l'ultima lunga
//  camera larga prima dell'appunto. Serve perche' il minuto scritto dal
//  giornalista puo' arrivare tardissimo: su GRONINGEN-TWENTE, cinquantun
//  secondi dopo la palla in rete.
function momentoDelGol(campo, fino) {
  const largo = larghi(campo);
  const LUNGA = 6, DOPO = 8;
  const fine = Math.min(fino, largo.length);
  for (let i = fine - 1; i >= LUNGA; i--) {
    if (!largo[i] || largo[i + 1]) continue;             // deve essere la FINE di una fila
    let lunga = 0;
    for (let j = i; j >= 0 && largo[j]; j--) lunga++;
    if (lunga < LUNGA) continue;                          // una fila corta e' un replay largo
    // dopo il gol si sta stretti un pezzo. Non per forza di fila: dentro
    // l'esultanza ci scappa un secondo di campo largo, e non deve contare.
    let stretti = 0, quanti = 0;
    for (let j = i + 1; j < Math.min(fine, i + 1 + DOPO); j++) { quanti++; if (!largo[j]) stretti++; }
    if (quanti < DOPO || stretti < DOPO - 2) continue;
    return i;
  }
  return -1;
}

async function fineDelReplay(via, targa, rif, t) {
  const visto = {};
  const cE = async (s) => {
    if (visto[s] !== undefined) return visto[s];
    const f = await fascia(via, s);
    if (!f) return (visto[s] = undefined);
    const q = (await quantoSiAssomigliano(targa, rif, [f]))[0];
    butta(f);
    // Misurato su Genoa-Como: con la targa in chiaro la somiglianza sta fra
    // 0,31 e 0,86 (cambia lo sfondo dietro la grafica, che e' trasparente);
    // senza targa sta a zero o sotto. Venti centesimi separano le due cose
    // con largo margine.
    return (visto[s] = (q === null || q === undefined ? undefined : q > 0.20));
  };
  const senza = [];
  for (let s = t + 15; s <= t + 115; s += 20) { if ((await cE(s)) === false) senza.push(s); }
  if (senza.length < 2) return null;             // un buco solo e' un caso, non un replay
  // Dopo un gol il cronometro sparisce DUE volte: una per l'esultanza, in
  // stretto sul giocatore, e una per il replay. Il pezzo deve finire dopo
  // la seconda, quindi si guarda l'ULTIMA fila di buchi — e dev'essere una
  // fila: un buco solo, isolato, e' un fotogramma sfortunato, non un replay.
  const file = [];
  senza.forEach((s2) => {
    const f = file[file.length - 1];
    if (f && s2 - f[f.length - 1] <= 20) f.push(s2); else file.push([s2]);
  });
  const lunghe = file.filter((f) => f.length >= 2);
  if (!lunghe.length) return null;
  const fila = lunghe[lunghe.length - 1];
  const ultimo = fila[fila.length - 1];
  // e dove finisce il PRIMO replay: per i social ne va uno solo, quindi il
  // pezzo deve poter finire li' invece che dopo l'ultimo
  const primaFila = lunghe[0];
  let primoFine = primaFila[primaFila.length - 1] + 10;
  if (lunghe.length > 1) {
    let b1 = primaFila[primaFila.length - 1], a1 = b1 + 20;
    for (let g = 0; g < 3 && a1 - b1 > 4; g++) {
      const m1 = Math.round((b1 + a1) / 2);
      if ((await cE(m1)) === false) b1 = m1; else a1 = m1;
    }
    primoFine = a1;
  }
  let basso = ultimo, alto = ultimo + 20;
  for (let giro = 0; giro < 3 && alto - basso > 4; giro++) {
    const mezzo = Math.round((basso + alto) / 2);
    if ((await cE(mezzo)) === false) basso = mezzo; else alto = mezzo;
  }
  return { fine: alto, primo: Math.min(primoFine, alto) };
}

// ── L'INTRO DEL TELECRONISTA ──────────────────────────────────────────
//  Prima della partita il feed manda il cartello — su questo archivio un
//  "COMING SOON" animato, non un fermo immagine. Poi il cartello lascia il
//  posto al clean feed, e li' comincia l'intro: "buonasera e benvenuti…",
//  fino a "si parte". Quel momento non si indovina, si trova: il cartello
//  e' sempre uguale a se stesso, e quando finisce il quadro cambia del
//  tutto.
//
//  Misurato su Genoa-Como, quadro intero contro il primo fotogramma del
//  file: cartello 0,42-0,87 — clean feed 0,09-0,24. Non si cerca a meta'
//  perche' piu' avanti arrivano le grafiche delle formazioni, che al
//  cartello assomigliano: si scorre dall'inizio e ci si ferma al primo
//  cambio vero.
function fotogrammino(via, sec) {
  return new Promise((ok) => {
    const png = path.join(os.tmpdir(), "quadro-" + nuovoId("") + ".png");
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", String(Math.max(0, Math.round(sec))),
                      "-i", via, "-frames:v", "1", "-vf", "scale=320:-1", "-y", png],
      { timeout: 90000 }, (e) => ok(e ? null : png));
  });
}

async function inizioCleanFeed(via, fischio) {
  if (fischio < 90) return null;
  // Il riferimento non e' il primo fotogramma del file — li' il cartello e'
  // ancora in dissolvenza e non somiglia a niente — ma uno a venti secondi,
  // controllato contro un altro a cinquanta: se quei due si assomigliano,
  // quello e' il cartello e si puo' cercare dove finisce.
  //
  // Si guarda la FASCIA ALTA e non il quadro intero: misurato su
  // Genoa-Como, cartello contro cartello 0,93 — cartello contro campo
  // -0,12. Piu' avanti arrivano le grafiche delle formazioni, che al
  // cartello assomigliano un po', ma la ricerca va dall'inizio in avanti e
  // si ferma al primo cambio: quelle non le incontra mai.
  const rif = await fasciaAlta(via, 20);
  if (!rif) return null;
  const somiglia = async (s) => {
    const f = await fasciaAlta(via, s);
    if (!f) return undefined;
    const q = (await quantoSiAssomigliano([0, 0, 0, 0], rif, [f]))[0];
    butta(f);
    return (q === null || q === undefined) ? undefined : q;
  };
  try {
    const prova = await somiglia(50);
    if (prova === undefined || prova < 0.45) return null;   // niente cartello: si comincia gia' in campo
    // NON CI SI FERMA AL PRIMO FOTOGRAMMA DIVERSO. Il "COMING SOON" e'
    // un'animazione che ogni tanto passa dal nero: un fotogramma preso li'
    // non somiglia al cartello, e la ricerca si fermava mezzo minuto dopo
    // l'inizio dicendo che il cartello era finito. Su Groningen-Twente il
    // cartello arrivava fino oltre il secondo 255 e l'intro cominciava a
    // 171, cioe' su un altro pezzo di cartello.
    //
    // Il clean feed invece, una volta cominciato, non torna indietro:
    // servono DUE sguardi di fila diversi dal cartello per crederci.
    const fine = fischio - 15;
    let ultimoCartello = 50, primoFeed = null, sospetto = null;
    for (let s = 80; s <= fine; s += 30) {
      const q = await somiglia(s);
      if (q === undefined) continue;
      if (q >= 0.45) { ultimoCartello = s; sospetto = null; continue; }
      if (sospetto === null) { sospetto = s; continue; }   // il primo puo' essere il nero
      primoFeed = sospetto; break;                          // due di fila: e' cominciata la partita
    }
    console.log("[clip] cartello: ultimo a " + ultimoCartello + "s, primo clean feed a " + primoFeed + "s (fischio " + fischio + "s)");
    if (primoFeed === null) return null;
    // e nel restringere, un solo fotogramma scuro non basta a spostare il
    // confine: si controlla anche cinque secondi dopo
    let basso = ultimoCartello, alto = primoFeed;
    for (let giro = 0; giro < 4 && alto - basso > 4; giro++) {
      const mezzo = Math.round((basso + alto) / 2);
      const q = await somiglia(mezzo);
      let cartello = q !== undefined && q >= 0.45;
      if (!cartello) {
        const q2 = await somiglia(mezzo + 5);
        if (q2 !== undefined && q2 >= 0.45) cartello = true;   // era solo il nero fra due giri
      }
      if (cartello) basso = mezzo; else alto = mezzo;
    }
    return alto;
  } finally { butta(rif); }
}

const CODA_RIFINITURE = [];
let rifinituraInCorso = false;
async function rifinisciGol(idSeq) {
  const q = R.seq[String(idSeq || "")];
  if (!q || q.rifinito) return { ok: true, gia: true };
  const r = q && R.reg[q.reg];
  if (!r || !r.arch) return { ok: false, errore: "questa sequenza non viene dall'archivio" };
  if (!q.pezzi.length || q.pezzi.length > 8) return { ok: false, errore: "troppi pezzi, o nessuno" };
  const a = ARCHIVIO[r.arch.rec];
  if (!a) return { ok: false, errore: "partita sconosciuta" };

  // Il file intero si firma solo se serve: il primo modo, quello che
  // guarda l'inquadratura, lavora sul pezzo gia' in casa e non tocca
  // Parigi.
  // LA PARTITA STA IN PIU' FILE, E OGNI SECONDO SA IN QUALE. "fetta" da'
  // il file e il secondo dentro quel file; "base" e' quanto va rimesso al
  // ritorno per tornare al tempo della registrazione. Senza, ogni lettura
  // del secondo tempo finiva nel primo.
  const fetta = (t) => fonteAl(r, Math.max(0, t));
  const baseDi = (t) => { const x = pezzoAl(r, Math.max(0, t)); return x ? x.da : 0; };
  const fileIntero = async () => fetta(0).via;

  // Il cronometro: targa e fotogramma di riferimento. Si preparano una
  // volta sola, e solo per i gol su cui l'inquadratura non ha detto
  // niente.
  let orologio;
  const preparaOrologio = async () => {
    if (orologio !== undefined) return orologio;
    orologio = null;
    if (!tesseractCe()) return orologio;
    if (!a.orologio || !a.orologio.verificato) return orologio;
    let targa = a.orologio.cifre;
    if (!targa) {
      // La targa si cerca dove si e' sicuri che ci sia gioco: due minuti
      // prima di un gol, o due dopo. Un tentativo solo non basta — un
      // fotogramma puo' capitare su un primo piano, su una grafica.
      const quando = [];
      q.pezzi.forEach((pz) => {
        const t = pz.t !== undefined ? pz.t : pz.dentro + GOL_PRE;
        quando.push(t - 150, t + 200, t - 400);
      });
      for (const t0 of quando.filter((x) => x > 60).slice(0, 8)) {
        const e = await leggiOrologioSicuro((t) => { const f = fetta(t); return fasciaAlta(f.via, f.dentro); }, Math.round(t0), true);
        if (e && e.cifre) { targa = e.cifre; break; }
      }
      if (!targa) return orologio;
      const t0 = Math.max(60, Math.round(q.pezzi[0].dentro) - 150);
      const strette = await targaDelleCifre(fetta(t0).via, targa, fetta(t0).dentro);
      if (strette) targa = strette;
      a.orologio.cifre = targa; scriviArchivio();
      console.log("[clip] rifinitura: targa del cronometro " + targa.join(",") + " per " + (a.partita || ""));
    }
    // il fotogramma di riferimento: la targa com'e' quando c'e' di sicuro,
    // cioe' poco prima del primo gol, con il gioco in corso
    const t1 = (q.pezzi[0].t !== undefined ? q.pezzi[0].t : q.pezzi[0].dentro + GOL_PRE);
    for (const d of [-150, -400, 200, -80]) {
      const ft = fetta(Math.max(30, t1 + d));
      const f = await fascia(ft.via, ft.dentro);
      if (!f) continue;
      const letto = await new Promise((ok) => {
        execFile("python3", [OROLOGIO_PY, "--targa", targa.join(","), f], { timeout: 60000 },
          (e, so) => { if (e) return ok(null); try { ok(JSON.parse(String(so)).letture[0]); } catch (x) { ok(null); } });
      });
      if (letto !== null && letto !== undefined) { orologio = { targa: targa, rif: f }; break; }
      butta(f);
    }
    return orologio;
  };

  let cambiati = 0, daCampo = 0, daCronometro = 0, provatoIlCronometro = false;
  for (const pz of q.pezzi) {
    const t = pz.t !== undefined ? pz.t : pz.dentro + GOL_PRE;
    let fine = null;
    let primo = null;

    // PRIMO MODO: l'inquadratura. Sul pezzo in casa costa solo CPU, e
    // vale su qualunque feed perche' non legge niente.
    // Una lettura sola dell'inquadratura, e dentro ci sono tutte e due le
    // cose: dove e' stato fatto il gol e dove il gioco riparte. Sul pezzo
    // gia' in casa costa solo CPU.
    let campo = [], base = 0;
    const k2 = chiavePezzo(q.reg, pz.dentro, pz.fuori);
    const casa = filePezzo(k2);
    if (fs.existsSync(casa)) {
      campo = await guardaIlCampo(casa, 0, 200, 1);
      base = pz.dentro - scartoPezzo(k2);               // dal tempo del pezzo a quello del file
    } else {
      const f = fetta(t - 75);
      campo = await guardaIlCampo(f.via, f.dentro, 200, 1);
      base = baseDi(t - 75);
    }
    if (campo.length >= 20) {
      const quando = (i) => Math.round(campo[i].s + base);
      let iT = campo.findIndex((x) => x.s + base >= t);
      if (iT < 0) iT = campo.length;
      // il gol: l'ultima camera larga lunga prima dell'appunto
      const i1 = momentoDelGol(campo, iT);
      let gol = i1 >= 0 ? quando(i1) : null;
      if (gol === null || gol <= quando(0) + 2) {
        // la tavola comincia a gol gia' fatto: si guarda piu' indietro nel
        // file. Succede quando il giornalista scrive tardi.
        const f2 = fetta(t - 95);
        const pr = await guardaIlCampo(f2.via, f2.dentro, 95, 1);
        const j = pr.length >= 20 ? momentoDelGol(pr, pr.length) : -1;
        if (j >= 0) gol = Math.round(pr[j].s + baseDi(t - 95));
      }
      if (gol !== null && gol < t) {
        pz.gol = gol;
        a.gol = a.gol || {}; a.gol[String(Math.round(t))] = gol;
      }
      // la ripartenza: si cerca da dopo il gol, non da dopo l'appunto
      let daQui = Math.max(0, iT - 5);
      if (gol !== null) {
        const g = campo.findIndex((x) => x.s + base >= gol);
        if (g >= 0) daQui = g;
      }
      const i2 = ripartenza(campo, daQui);
      if (i2 >= 0) { fine = quando(i2); pz.replayVisto = "campo"; daCampo++; }
    }

    // SECONDO MODO: il cronometro che sparisce. Serve ancora, perche' dice
    // anche dove finisce il PRIMO replay — che per gli shorts e' l'unico
    // che va tenuto.
    const sannoGia = a.primoReplay && a.primoReplay[String(Math.round(t))] !== undefined;
    if (fine === null || (!a.cronometroCieco && !sannoGia)) {
      const o = await preparaOrologio();
      if (o) {
        provatoIlCronometro = true;
        let esito = null;
        const f3 = fetta(t), b3 = baseDi(t);
        try { esito = await fineDelReplay(f3.via, o.targa, o.rif, f3.dentro); } catch (e) { esito = null; }
        if (esito) {
          primo = esito.primo === null || esito.primo === undefined ? esito.primo : esito.primo + b3;
          if (fine === null) { fine = esito.fine + b3; pz.replayVisto = "cronometro"; daCronometro++; }
        }
      }
    }

    if (fine === null) { pz.replay = false; continue; }
    // il pezzo comincia dall'azione, non dal minuto scritto: dodici
    // secondi di rincorsa prima che la palla entri
    if (pz.gol && pz.gol - AZIONE_PRE < pz.dentro) pz.dentro = Math.max(0, pz.gol - AZIONE_PRE);
    pz.fuori = Math.min(pz.dentro + 200, fine + 3);
    pz.replay = true;
    a.replay = a.replay || {};
    a.replay[String(Math.round(t))] = fine;     // letto una volta, buono per sempre
    // il PRIMO replay lo sa dire solo il cronometro: l'inquadratura dice
    // dove riprende il gioco, cioe' dove finisce l'ULTIMO. Se non si sa,
    // non si scrive: gli shorts se ne accorgono e tagliano a occhio.
    if (primo !== null) {
      a.primoReplay = a.primoReplay || {};
      a.primoReplay[String(Math.round(t))] = primo;
    }
    cambiati++;
    console.log("[clip] gol al " + (pz.minuto || "?") + ": palla in rete a " + (pz.gol || "?") +
                "s, il gioco riparte a " + Math.round(fine) +
                "s (" + (pz.replayVisto === "campo" ? "inquadratura" : "cronometro") +
                ", pezzo " + Math.round(pz.fuori - pz.dentro) + "s)");
  }
  if (orologio && orologio.rif) butta(orologio.rif);
  // Se il cronometro e' stato interrogato e non ha detto niente su nessun
  // gol, e' un feed che la grafica non la toglie mai: si scrive, e la
  // prossima volta non si spendono fotogrammi per riprovarci.
  if (provatoIlCronometro && !daCronometro && !(a.primoReplay && Object.keys(a.primoReplay).length)) a.cronometroCieco = true;
  scriviArchivio();
  // e gia' che il file e' aperto: dove finisce il cartello e comincia
  // l'intro del telecronista
  try { await trovaLIntro(r, await fileIntero()); } catch (e) { console.log("[clip] intro: " + e.message); }
  q.rifinito = Date.now();
  if (!cambiati) {
    a.replayNo = true; scriviArchivio();
    q.nota = "Su questi gol non si e' capito dove finisce il replay: ne' il cronometro ne' l'inquadratura "
           + "lo dicono, quindi restano le maniglie larghe (" + GOL_PRE + "s prima, " + GOL_POST + "s dopo).";
  } else {
    delete a.replayNo;
    q.nota = "Rifinito: " + cambiati + " gol su " + q.pezzi.length + " finiscono dove riprende il gioco"
           + (daCampo && daCronometro ? " (" + daCampo + " dall'inquadratura, " + daCronometro + " dal cronometro)"
              : daCampo ? " (visto dall'inquadratura)" : " (visto dal cronometro)") + ".";
  }
  // i tagli sono cambiati: le copie verticali seguono la madre, se non le
  // ha ancora prese in mano nessuno
  if (cambiati && q.auto === "GOL") copieDiFormato(r, ["GOL"]);
  scrivi(); annuncia(0, "clip");
  return { ok: true, cambiati: cambiati, pezzi: q.pezzi.length, campo: daCampo, cronometro: daCronometro };
}

// L'intro trovata sul serio: dal cambio cartello, un minuto, o fino al
// fischio se il fischio arriva prima. Va a sostituire il primo pezzo degli
// highlights, quello messo li' a occhio.
async function trovaLIntro(r, via) {
  const fischio = fischioNelFile(r) || 0;
  if (!fischio) return;
  const q = Object.keys(R.seq).map((k) => R.seq[k])
    .find((x) => x.reg === r.id && String(x.auto).indexOf("HIGHLIGHTS") === 0);
  if (!q || !q.pezzi.length) return;
  const rec = r.evento || (r.arch && r.arch.rec) || "";
  const a = ARCHIVIO[rec];
  let via2 = a && a.cartello;
  if (!via2) {
    via2 = await inizioCleanFeed(via, fischio);
    if (via2 === null) { console.log("[clip] intro: cartello non trovato prima del fischio"); return; }
    if (a) { a.cartello = via2; scriviArchivio(); }
  }
  // Tre secondi di margine all'indietro: la ricerca stringe a quattro
  // secondi, e sbagliare in avanti vuol dire cominciare a frase iniziata.
  // Sbagliare indietro vuol dire aprire sugli ultimi istanti del cartello,
  // che in un montato sembra un titolo. Fra i due errori si sceglie quello
  // che non costa niente.
  const dentro = Math.max(0, via2 - 3);
  const fuori = Math.min(dentro + INTRO_DURATA, fischio - INIZIO_PRE - 1);
  if (fuori - dentro < 12) return;
  const apre = pezzoDa(dentro, fuori, "Apertura del telecronista", "Apertura", "", "apertura", 9);
  apre.vero = true;
  const dove = q.pezzi.findIndex((x) => x.tipo === "Apertura");
  if (dove >= 0) q.pezzi[dove] = apre; else q.pezzi.unshift(apre);
  q.nota = "Si apre dove il cartello lascia il clean feed (" + Math.round(dentro) + "s), "
         + Math.round(fuori - dentro) + " secondi di intro, poi il calcio d'inizio, poi le azioni.";
  scrivi(); annuncia(0, "clip");
  console.log("[clip] intro: cartello fino a " + via2 + "s, fischio a " + fischio + "s");
}

function rifinitureInCoda() {
  if (rifinituraInCorso || !CODA_RIFINITURE.length) return;
  rifinituraInCorso = true;
  const id = CODA_RIFINITURE.shift();
  rifinisciGol(id).then((e) => { if (e && !e.ok) console.log("[clip] rifinitura saltata: " + e.errore); })
    .catch((e) => console.log("[clip] rifinitura: " + e.message))
    .then(() => { rifinituraInCorso = false; setTimeout(rifinitureInCoda, 1500); });
}

// Due ancore: un fotogramma nel primo tempo dice a che secondo del file
// e' cominciata la partita, uno nel secondo dice dove e' cominciata la
// ripresa. Un terzo fotogramma, al 70', controlla che il conto torni.
let orologioAlLavoro = null;
const orologiAttivi = new Set();     // le partite in lettura in questo momento (la coda piu' una a domanda)
async function calibraOrologio(rec, rifai) {
  const a = ARCHIVIO[rec];
  if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
  if (a.orologio && !rifai) return a.orologio;
  if (!tesseractCe()) throw new Error("sulla macchina manca tesseract: il cronometro non si puo' leggere");
  if (orologiAttivi.has(rec)) throw new Error("sto gia' leggendo il cronometro di " + (a.partita || rec));
  if (orologiAttivi.size >= OROLOGI_INSIEME + 1) throw new Error("troppe letture insieme: riprova fra un minuto");
  orologiAttivi.add(rec);
  orologioAlLavoro = a.partita || rec;
  // se il materiale cambia durante la lettura, la lettura non vale
  const firmaMateriale = () => (a.pezzi || []).map((x) => x.chiave).join("|") + "#" + a.kickoff;
  const firma0 = firmaMateriale();
  try {
    const regione = await s3Regione(a.bucket);
    const vie = {};
    const leggiA = async (t) => {
      const d = doveCade(a, t);
      if (!d) return null;
      if (!vie[d.chiave]) vie[d.chiave] = firmaConRegione(regione, d.chiave, {}, 3600, a.bucket);
      return fasciaAlta(vie[d.chiave], d.secondi);
    };
    const esito = { letti: 0, quando: new Date().toISOString() };
    // primo tempo: dal 10' stimato in poi, finche' il lettore non legge
    // un'ora da primo tempo (prima del 45') che stia a meno di un quarto
    // d'ora dalla stima
    for (const t of [600, 780, 960, 1200, 1500, 1800, 2100]) {
      const e = await leggiOrologioSicuro(leggiA, t, true); esito.letti += 2;
      const c = e && e.c;
      if (e && e.cifre && !esito.cifre) esito.cifre = e.cifre;
      if (c === null || c === undefined || c <= 0 || c >= 2700) continue;
      const inizio1 = t - c;
      if (Math.abs(inizio1) > 1500) continue;
      esito.inizio1 = inizio1; break;
    }
    if (esito.inizio1 === undefined) throw new Error("nel primo tempo non ho letto nessun cronometro");
    // secondo tempo: dal 60' stimato in poi (dopo la ripresa vera in ogni
    // caso), un'ora da secondo tempo (dopo il 45') che stia entro i quaranta
    // minuti dopo il primo
    const base = esito.inizio1 + 2700;
    for (const t of [base + 1200, base + 1440, base + 1680, base + 1920, base + 2160, base + 2400, base + 2700]) {
      const c = await leggiOrologioSicuro(leggiA, t); esito.letti += 2;
      if (c === null || c <= 2700) continue;
      const inizio2 = t - (c - 2700);
      if (inizio2 < base + 480 || inizio2 > base + 2400) continue;
      esito.inizio2 = inizio2; break;
    }
    if (esito.inizio2 === undefined) throw new Error("nel secondo tempo non ho letto nessun cronometro");
    // la prova del nove: al 70' il cronometro deve dire 70:00, piu' o meno
    let c70 = null, atteso = 4200;
    for (const piu of [0, 60, 120]) {
      c70 = await leggiOrologioSicuro(leggiA, esito.inizio2 + 1500 + piu); esito.letti += 2;
      if (c70 !== null) { atteso = 4200 + piu; break; }
    }
    esito.scarto = c70 === null ? null : c70 - atteso;
    esito.verificato = esito.scarto !== null && Math.abs(esito.scarto) <= 15;
    // un cronometro che al 70' dice un'altra ora non e' un cronometro: e'
    // una grafica letta male, e salvarlo sarebbe peggio della stima
    if (esito.scarto !== null && Math.abs(esito.scarto) > 60) {
      throw new Error("la prova del nove non torna (al 70' legge " + Math.round(c70 / 60) + "')");
    }
    if (firmaMateriale() !== firma0) throw new Error("il materiale e' cambiato durante la lettura");
    a.orologio = esito; delete a.orologioFallito;
    // le partite gia' aperte nel progetto imparano il fischio vero: il fermo
    // immagine, l'Info e la miniatura si rifanno sul calcio d'inizio letto
    const kick0 = (a.kickoff !== null && a.kickoff !== undefined) ? a.kickoff : null;
    if (kick0 !== null) Object.keys(R.reg).forEach((k) => {
      const r = R.reg[k];
      if (!r.arch || r.arch.rec !== rec || (r.arch.pezzo || 0) !== 0) return;
      r.kickoff = { "1": Math.max(0, Math.round(kick0 + esito.inizio1)), "2": Math.max(0, Math.round(kick0 + esito.inizio2)) };
      r.mini = ""; miniaturaViva(r).catch(() => {});
    });
    scrivi();
    scriviArchivio();
    console.log("[clip] cronometro letto: " + (a.partita || rec) + " → fischio a " + esito.inizio1 +
                "s dalla stima, ripresa a " + esito.inizio2 + "s" + (esito.verificato ? " ✓" : " (scarto " + esito.scarto + ")"));
    return esito;
  } finally {
    orologiAttivi.delete(rec);
    const altro = Array.from(orologiAttivi)[0];
    orologioAlLavoro = altro ? ((ARCHIVIO[altro] || {}).partita || altro) : null;
  }
}

// Tutte le partite con appunti e materiale, una alla volta, mai mentre si
// registra: mille partite sono una notte di lavoro e qualche decina di giga
// dal bucket. Si accende a mano (clip-archivio-orologi).
// "Registrando davvero": un flusso che arriva. Un ascolto aperto in attesa
// (zero byte) o un'anteprima non fermano le code di notte.
// ── LA DIRETTA NON LA REGISTRA DEV ────────────────────────────────────
//
//  "Si ferma se si sta registrando" guardava solo il registro di casa
//  propria. Ma la diretta la registra l'altro servizio, sulla stessa
//  macchina e sugli stessi due core: dev non ne sapeva niente e avrebbe
//  continuato a macinare whisper sotto una partita in onda. Si chiede a
//  lui, una volta al minuto, con una chiamata che non esce dalla macchina.
const ALTRO_PONTE = process.env.COMOTV_ALTRO_PONTE || "http://127.0.0.1:8080/api";
let altroVistoQuando = 0, altroRegistra = false;
function laDirettaGira() {
  if (Date.now() - altroVistoQuando < 60000) return altroRegistra;
  altroVistoQuando = Date.now();
  // la risposta serve per la prossima volta: non si aspetta nessuno
  fetch(ALTRO_PONTE, { method: "POST", headers: { "Content-Type": "text/plain" },
                       body: JSON.stringify({ tipo: "clip-stato" }), signal: AbortSignal.timeout(8000) })
    .then((r) => r.json())
    .then((d) => {
      const prima = altroRegistra;
      altroRegistra = (d.reg || []).some((x) => x.stato === "registra" && !x.guarda);
      if (altroRegistra && !prima) console.log("[clip] l'altro servizio sta registrando: le code si fermano");
    })
    .catch(() => {});
  return altroRegistra;
}

function registrandoDavvero() {
  return Object.keys(R.reg).some((k) => {
    const r = R.reg[k];
    if (r.stato !== "registra" || r.guarda) return false;
    if (r.ascolto && durataRegistrata(r.id) === 0) return false;
    return true;
  });
}
// C'e' un whisper che macina? Anche uno orfano, rimasto da prima di un
// riavvio. Si chiede al sistema, non piu' di una volta ogni venti secondi.
let whisperVistoQuando = 0, whisperVisto = false;
function whisperGira() {
  if (Date.now() - whisperVistoQuando < 20000) return whisperVisto;
  whisperVistoQuando = Date.now();
  // -x, non -f: cercando la riga di comando si trovano anche i comandi che
  // stanno solo GUARDANDO se whisper gira, e si aspetta per sempre
  try { execFileSync("pgrep", ["-x", "whisper-cli"], { stdio: "ignore" }); whisperVisto = true; }
  catch (e) { whisperVisto = false; }
  return whisperVisto;
}
const CODA_OROLOGI = [];
let orologiFatti = 0, orologiFalliti = 0, orologiRipassati = false, orologiInMoto = 0, orologiRimandati = 0;
// ── IL TABELLONE DICE DOVE SONO I GOL ─────────────────────────────────
//
//  Il cronometro dice CHE ORA E'. Il tabellone, due centimetri piu' in la',
//  dice QUANTO STA. E il risultato ha una proprieta' che nessun'altra
//  fonte ha: cambia solo quando c'e' un gol, e non torna mai indietro.
//
//  Quindi non serve guardare la partita per trovare i gol: basta chiedere
//  il risultato all'inizio e alla fine, e se e' cambiato dimezzare. Ogni
//  domanda taglia a meta' il tempo in cui il gol puo' stare: da due ore si
//  arriva a venti secondi in otto letture. Sei gol costano centoquaranta
//  fotogrammi e due minuti — e valgono per le partite di cui non sappiamo
//  niente, quelle senza appunti e senza ESPN, che sono la meta' del NAS.
//
//  Il ritardo: il tabellone lo cambia una persona, e lo cambia dopo. Otto
//  secondi e' la cifra che si toglie; il punto esatto lo trova poi la
//  rifinitura, guardando l'inquadratura.
const RITARDO_TABELLONE = 8;
const TABELLONE_INCERTEZZA = 20;    // sotto i venti secondi si smette di dimezzare
let tabelloniAttivi = new Set();

function numeriDi(p) { const v = String(p || "").split("-"); return [parseInt(v[0], 10), parseInt(v[1], 10)]; }
function nonCala(p0, p1) {
  const a = numeriDi(p0), b = numeriDi(p1);
  return b[0] >= a[0] && b[1] >= a[1];
}

async function leggiTabellone(rec, rifai) {
  const a = ARCHIVIO[rec];
  if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
  if (a.tabellone && !rifai) return a.tabellone;
  if (!tesseractCe()) throw new Error("sulla macchina manca tesseract: il tabellone non si puo' leggere");
  if (tabelloniAttivi.has(rec)) throw new Error("sto gia' leggendo il tabellone di " + (a.partita || rec));
  if (tabelloniAttivi.size >= 2) throw new Error("troppe letture insieme: riprova fra un minuto");
  // senza cronometro non si sa dove guardare ne' dove comincia il secondo
  // tempo: si legge prima quello
  const o = a.orologio || await calibraOrologio(rec);
  if (!o || !o.cifre) throw new Error("la targa del cronometro non e' stata trovata: senza non so dove sta il risultato");
  tabelloniAttivi.add(rec);
  try {
    const regione = await s3Regione(a.bucket);
    const vie = {};
    const fotogramma = async (t) => {
      const d = doveCade(a, Math.round(t));
      if (!d) return null;
      if (!vie[d.chiave]) vie[d.chiave] = firmaConRegione(regione, d.chiave, {}, 3600, a.bucket);
      return fasciaAlta(vie[d.chiave], d.secondi);
    };
    let letti = 0;
    const python = (args) => new Promise((ok) => {
      execFile("python3", [OROLOGIO_PY].concat(args), { timeout: 300000 }, (e, so) => {
        if (e) return ok(null);
        try { ok(JSON.parse(String(so))); } catch (x) { ok(null); }
      });
    });
    const butta = (f) => { if (f) try { fs.unlinkSync(f); } catch (e) {} };

    // 1) dove sta scritto il risultato: si prova su tre fotogrammi del primo
    //    tempo e vince il riquadro che legge sempre la stessa cosa
    const i1 = o.inizio1 || 0;
    const tre = [];
    // tre fotogrammi vicini fra loro: se fossero lontani, in mezzo ci
    // starebbe un gol e il riquadro giusto leggerebbe due numeri diversi
    for (const t of [i1 + 300, i1 + 390, i1 + 480]) { const f = await fotogramma(t); if (f) { tre.push(f); letti++; } }
    if (tre.length < 2) throw new Error("non sono riuscito a tirare fuori i fotogrammi");
    const cal = await python(["--tabellone", o.cifre.join(",")].concat(tre));
    tre.forEach(butta);
    if (!cal || !cal.box) throw new Error("sul tabellone non trovo il riquadro del risultato");
    const box = cal.box.join(",");

    // 2) il risultato a un dato secondo, confermato da un secondo fotogramma
    const uno = async (t) => {
      const f = await fotogramma(t);
      if (!f) return null;
      letti++;
      const v = await python(["--punteggio", "--box", box, f]);
      butta(f);
      return v && v.punteggi ? v.punteggi[0] : null;
    };
    const leggi = async (t) => {
      for (const scarto of [0, 20, -20, 45, -45]) {
        const p = await uno(t + scarto);
        if (p && (await uno(t + scarto + 7)) === p) return p;
      }
      return null;
    };

    // 3) si dimezza
    const punti = [], incerti = [];
    const cerca = async (t0, s0, t1, s1, liv) => {
      if (s0 === s1) return;
      if (t1 - t0 <= TABELLONE_INCERTEZZA || liv > 13) {
        punti.push({ t: Math.round((t0 + t1) / 2), prima: s0, dopo: s1, incerto: Math.round((t1 - t0) / 2) });
        return;
      }
      // il punto di mezzo puo' capitare dove il tabellone non c'e': un
      // replay lungo, un primo piano, l'intervallo. Prima di arrendersi si
      // prova a un quarto e a tre quarti — un passo piu' corto, ma un passo
      let tm = 0, sm = null;
      for (const parte of [0.5, 0.25, 0.75, 0.37, 0.63]) {
        tm = Math.round(t0 + (t1 - t0) * parte);
        if (tm <= t0 + 5 || tm >= t1 - 5) continue;
        sm = await leggi(tm);
        if (sm && nonCala(s0, sm) && nonCala(sm, s1)) break;
        sm = null;
      }
      if (!sm) { incerti.push({ da: Math.round(t0), a: Math.round(t1), prima: s0, dopo: s1 }); return; }
      await cerca(t0, s0, tm, sm, liv + 1);
      await cerca(tm, sm, t1, s1, liv + 1);
    };
    const primoBuono = async (t, passo, quanti) => {
      for (let i = 0; i < (quanti || 6); i++) { const p = await leggi(t + i * passo); if (p) return { t: t + i * passo, p: p }; }
      return null;
    };
    const pezzi = (a.pezzi || []).filter((x) => x.da !== null && x.da !== undefined);
    const fineTutto = pezzi.length
      ? pezzi[pezzi.length - 1].da + (pezzi[pezzi.length - 1].minuti || 55) * 60 - 120
      : (o.inizio2 || 3600) + 3300;
    // AL FISCHIO D'INIZIO E' ZERO A ZERO. Non c'e' bisogno di leggerlo, e
    // leggerlo costava i gol dei primi minuti: se la prima lettura buona
    // cadeva al 5' e li' era gia' 0-2, quei due gol non li cercava nessuno.
    //
    // Poi due tratti, non uno: in mezzo c'e' l'intervallo, e dimezzare
    // dentro l'intervallo vuol dire chiedere il risultato a un fotogramma
    // che il tabellone non ce l'ha. Il punto di giunzione e' l'inizio del
    // secondo tempo: quello che c'e' scritto li' e' anche quello con cui
    // era finito il primo, e cosi' i due tratti si toccano senza buchi.
    const fine = await primoBuono(fineTutto, -45, 10);
    const dopoIntervallo = o.inizio2 ? await primoBuono(o.inizio2 + 60, 45, 10) : null;
    let finale = fine ? fine.p : null;
    if (dopoIntervallo) {
      const primaDellIntervallo = (await primoBuono(o.inizio2 - 60, -45, 12)) || { t: o.inizio2 - 60, p: dopoIntervallo.p };
      if (nonCala("0-0", primaDellIntervallo.p)) await cerca(i1, "0-0", primaDellIntervallo.t, primaDellIntervallo.p, 0);
      if (fine && nonCala(dopoIntervallo.p, fine.p)) await cerca(dopoIntervallo.t, dopoIntervallo.p, fine.t, fine.p, 0);
    } else if (fine) {
      await cerca(i1, "0-0", fine.t, fine.p, 0);
    }

    // 4) la prova del nove: il risultato finale letto sul tabellone deve
    //    essere quello scritto nel nome della partita. Se non torna, la
    //    lettura c'e' ma non ci si mette la firma.
    const nel = /\b(\d{1,2})\s*-\s*(\d{1,2})\b/.exec(String(a.partita || ""));
    const atteso = nel ? nel[1] + "-" + nel[2] : null;
    const esito = { quando: new Date().toISOString(), box: cal.box, letti: letti,
                    punti: punti.sort((x, y) => x.t - y.t), incerti: incerti,
                    finale: finale, atteso: atteso,
                    verificato: !!(atteso && finale && atteso === finale) };
    a.tabellone = esito; scriviArchivio();
    console.log("[clip] tabellone: " + (a.partita || rec) + " → " + punti.length + " gol, finale " +
                finale + (atteso ? " (nel nome " + atteso + ")" : "") + ", " + letti + " fotogrammi");
    return esito;
  } finally { tabelloniAttivi.delete(rec); }
}

const OROLOGI_INSIEME = 2;          // due partite alla volta: ffmpeg e tesseract pesano poco, S3 aspetta
// prima il Como, poi le partite piu' recenti: e' l'ordine in cui servono
function prioritaPartita(rec) {
  const a = ARCHIVIO[rec] || {};
  const como = /\bCOMO\b/i.test(a.partita || "") ? 0 : 1;
  return como * 1e13 + (1e13 - (Date.parse(a.quando) || 0));
}
// Se una pagina sta chiedendo lo stato, qualcuno sta lavorando: le code di
// sottofondo scendono a una alla volta e la macchina risponde a lui.
let ultimaPagina = 0;
function qualcunoLavora() { return Date.now() - ultimaPagina < 90000; }
// ── IL MAGAZZINO E' DELLA REGIA, PRIMA CHE NOSTRO ─────────────────────
//
//  La NAS non e' un archivio morto: e' il disco su cui la regia STA
//  registrando mentre noi leggiamo. Andarci a prendere sei giga di
//  fotogrammi mentre entra una conferenza stampa o una partita non e' un
//  errore di programma, e' un rischio preso sul lavoro di qualcun altro.
//  Allora prima si guarda: se in cartella qualcosa e' stato scritto negli
//  ultimi quindici minuti, la regia sta lavorando e si aspetta. Di notte
//  la coda riparte da sola.
const NAS_FERMO_MIN = 15;
let nasVistoQuando = 0, nasOccupato = false;
function magazzinoOccupato() {
  const m = magazzinoDi(ARCH_BUCKET);
  if (!m || !m.cartella) return false;
  if (Date.now() - nasVistoQuando < 60000) return nasOccupato;   // si chiede al massimo una volta al minuto
  nasVistoQuando = Date.now();
  nasOccupato = false;
  const limite = Date.now() - NAS_FERMO_MIN * 60000;
  try {
    radiciDi(ARCH_BUCKET).forEach((rd) => {
      if (nasOccupato) return;
      const dir = path.join(m.cartella, rd);
      let voci = [];
      try { voci = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      voci.forEach((v) => {
        if (nasOccupato || !v.isFile()) return;
        try { if (fs.statSync(path.join(dir, v.name)).mtimeMs > limite) nasOccupato = true; } catch (e) {}
      });
    });
  } catch (e) {}
  if (nasOccupato) console.log("[clip] il magazzino sta ricevendo roba nuova: aspetto");
  return nasOccupato;
}

function giraOrologi() {
  // mentre si trascrive i cronometri stanno fermi: due core non si dividono
  // in tre, e una trascrizione lasciata a meta' costa piu' di un'attesa.
  // Quando la voce ha finito, riprendono da soli.
  if (!orologiInMoto && (voceAlLavoro || whisperGira())) { setTimeout(giraOrologi, 60000); return; }
  const insieme = qualcunoLavora() ? 1 : OROLOGI_INSIEME;
  if (orologiInMoto >= insieme) return;
  // a coda finita, le partite non lette si ritentano una volta: un sondaggio
  // caduto su un replay o su una grafica spenta la seconda volta cade altrove
  if (!CODA_OROLOGI.length) {
    if (!orologiInMoto && !orologiRipassati) { orologiRipassati = true; Object.keys(ARCHIVIO).forEach((k) => { if (ARCHIVIO[k].orologioFallito && !ARCHIVIO[k].orologio) delete ARCHIVIO[k].orologioFallito; }); orologiInCoda(true); }
    return;
  }
  const registrando = registrandoDavvero() || laDirettaGira();
  if (registrando) { setTimeout(giraOrologi, 60000); return; }
  if (magazzinoOccupato()) { setTimeout(giraOrologi, 300000); return; }
  // le durate cambiano il materiale: leggere il cronometro nel frattempo
  // vuol dire prendere i due fotogrammi da file diversi. Si aspetta che
  // finiscano (un'ora), e intanto la macchina respira
  if (CODA_DURATE.length || durateInMoto) { setTimeout(giraOrologi, 60000); return; }
  const rec = CODA_OROLOGI.shift();
  orologiInMoto++;
  calibraOrologio(rec).then(() => { orologiFatti++; })
    .catch((e) => {
      orologiFalliti++; console.log("[clip] cronometro non letto (" + rec + "): " + e.message);
      // ci si ricorda del fallimento: a un riavvio non si ricomincia dalle
      // stesse partite senza grafica; si ritentano solo nel giro finale
      if (ARCHIVIO[rec]) { ARCHIVIO[rec].orologioFallito = { quando: new Date().toISOString(), motivo: String(e.message).slice(0, 80) }; scriviArchivio(); }
    })
    .then(() => { orologiInMoto--; setTimeout(giraOrologi, 500); });
  setTimeout(giraOrologi, 3000);       // e intanto parte la seconda
}
// Ogni cronometro costa ~50 MB letti da S3: AWS ne regala 100 GB al mese,
// oltre si paga. Il filtro tiene la coda dentro il gratuito: il Como e la
// stagione in corso; il resto quando (e se) si decide di spendere.
let FILTRO_OROLOGI = process.env.COMOTV_OROLOGI_FILTRO || "";   // nessun filtro: si pesca ovunque
function passaFiltro(a) {
  if (!FILTRO_OROLOGI) return true;
  const testo = ((a.partita || "") + " " + (a.quando || "")).toLowerCase();
  return FILTRO_OROLOGI.split("|").some((p) => p && testo.indexOf(p.toLowerCase()) >= 0);
}
function orologiInCoda(ripasso) {
  if (!CODA_OROLOGI.length) orologiRipassati = false;
  const gia = new Set(CODA_OROLOGI);
  // SI PESCA OVUNQUE. Prima la coda guardava solo le partite con gli
  // appunti: ma le partite dove il cronometro serve DI PIU' sono proprio
  // quelle senza — li' il tabellino esce vuoto perche' il minuto di ESPN
  // non sa diventare un secondo. Adesso entra qualunque partita di cui
  // sappiamo qualcosa, appunti o ESPN che sia, e senza filtro sul nome.
  const candidate = new Set(Object.keys(APPUNTI).filter((k) => (APPUNTI[k].righe || []).length)
                      .concat(Object.keys(ESPN).filter((k) => ((ESPN[k] || {}).eventi || []).length)));
  candidate.forEach((rec) => {
    const a = ARCHIVIO[rec];
    if (!a || a.orologio || gia.has(rec)) return;
    if (a.orologioFallito && !ripasso) return;        // gia' provata: al giro finale
    CODA_OROLOGI.push(rec);
  });
  CODA_OROLOGI.sort((x, y) => prioritaPartita(x) - prioritaPartita(y));
  giraOrologi();
  return CODA_OROLOGI.length;
}

// ── LE DURATE MISURATE ─────────────────────────────────────────────
//  Il peso di un file dice poco: 3,3 GB sono un tempo o una partita intera
//  a bitrate basso. ffprobe legge l'indice del file (qualche MB) e dice i
//  minuti. Con i minuti la scelta del materiale si fa da sola: un file da
//  cento minuti in su e' la partita intera e basta lui; due da 45-75 sono i
//  due tempi; sotto i 35 e' un taglio di regia e si scarta, se c'e' altro.
function durataFile(via) {
  return new Promise((ok) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", via],
      { timeout: 90000 }, (e, so) => {
        const sec = parseFloat(String(so || "").trim());
        ok(e || !isFinite(sec) ? null : Math.round(sec / 60 * 10) / 10);
      });
  });
}
const CODA_DURATE = [];
let durateInMoto = 0, durateFatte = 0, durateFallite = 0, durateCambiate = 0, durateDaScrivere = 0;
const DURATE_INSIEME = 2;
async function misuraPartita(rec) {
  const a = ARCHIVIO[rec];
  if (!a) return;
  const regione = await s3Regione(a.bucket);
  const pezzi = (a.pezzi && a.pezzi.length) ? a.pezzi : [{ chiave: a.chiave, peso: a.peso, file: (a.chiave || "").split("/").pop() }];
  for (const x of pezzi) {
    if (x.minuti !== undefined && x.minuti !== null) continue;
    x.minuti = await durataFile(firmaConRegione(regione, x.chiave, {}, 3600, a.bucket));
  }
  const misurati = pezzi.filter((x) => x.minuti);
  const intere = misurati.filter((x) => x.minuti >= 100);
  const tempi = misurati.filter((x) => x.minuti >= 40 && x.minuti < 100);
  let nuovi = pezzi, fonte = a.fonte;
  if (intere.length) {
    // la piu' lunga: se sono due uguali (la partita salvata due volte), una basta
    nuovi = [intere.slice().sort((x, y) => y.minuti - x.minuti)[0]]; fonte = "intero";
  } else if (tempi.length >= 2) {
    nuovi = tempi.slice().sort((x, y) => ((x.da === null || x.da === undefined) ? 0 : x.da) - ((y.da === null || y.da === undefined) ? 0 : y.da)); fonte = "pezzi";
  } else if (tempi.length === 1 && pezzi.length > 1) {
    // un tempo solo e dei tagli: si tiene il tempo, si lasciano i tagli sotto i 35'
    nuovi = pezzi.filter((x) => !x.minuti || x.minuti >= 35); fonte = "pezzi";
  }
  const prima = pezzi.map((x) => x.chiave).join("|"), dopo = nuovi.map((x) => x.chiave).join("|");
  if (prima !== dopo) {
    const capoCambiato = nuovi[0].chiave !== pezzi[0].chiave;
    a.pezzi = nuovi; a.chiave = nuovi[0].chiave; a.peso = nuovi[0].peso; a.fonte = fonte;
    if (capoCambiato) {
      a.kickoff = a.quando ? kickoffNelFile(nuovi[0].file, Date.parse(a.quando)) : a.kickoff;
      if (a.orologio) { delete a.orologio; if (CODA_OROLOGI.indexOf(rec) < 0 && APPUNTI[rec]) CODA_OROLOGI.unshift(rec); }
    }
    durateCambiate++;
    console.log("[clip] durate: " + (a.partita || rec) + " → " + pezzi.length + " file → " + nuovi.length + " (" + fonte + ": " + nuovi.map((x) => x.minuti + "'").join(" + ") + ")");
  }
  a.misurato = new Date().toISOString();
  rinominaMaterialeArchivio();
  if (++durateDaScrivere >= 20) { durateDaScrivere = 0; scriviArchivio(); }
}
function giraDurate() {
  const insiemeD = qualcunoLavora() ? 1 : DURATE_INSIEME;
  if (durateInMoto >= insiemeD || !CODA_DURATE.length) { if (!CODA_DURATE.length && !durateInMoto) scriviArchivio(); return; }
  const registrando = registrandoDavvero() || laDirettaGira();
  if (registrando) { setTimeout(giraDurate, 60000); return; }
  // una misura in coda puo' aspettare: la regia che scrive no
  if (CODA_DURATE.length > 2 && magazzinoOccupato()) { setTimeout(giraDurate, 300000); return; }
  const rec = CODA_DURATE.shift();
  durateInMoto++;
  misuraPartita(rec).then(() => { durateFatte++; })
    .catch((e) => { durateFallite++; console.log("[clip] durate non misurate (" + rec + "): " + e.message); })
    .then(() => { durateInMoto--; setTimeout(giraDurate, 200); });
  setTimeout(giraDurate, 1500);
}
// Anche misurare costa: ffprobe legge l'indice di ogni file, e ventiduemila
// file sono qualche decina di giga. Lo stesso filtro dei cronometri tiene il
// lavoro dentro il traffico che AWS regala; le altre si misurano quando
// qualcuno le apre.
function durateInCoda(tutte) {
  const gia = new Set(CODA_DURATE);
  Object.keys(ARCHIVIO).forEach((rec) => {
    const a = ARCHIVIO[rec];
    if (a.misurato || gia.has(rec)) return;
    if (!tutte && !passaFiltro(a)) return;
    CODA_DURATE.push(rec);
  });
  // prima le partite che qualcuno ha gia' aperto nel progetto (il nome e il
  // materiale devono essere giusti subito), poi lo stesso ordine dei cronometri
  const aperte = new Set(Object.keys(R.reg).map((k) => (R.reg[k].arch || {}).rec).filter(Boolean));
  CODA_DURATE.sort((x, y) => ((aperte.has(x) ? 0 : 1) - (aperte.has(y) ? 0 : 1)) || (prioritaPartita(x) - prioritaPartita(y)));
  giraDurate();
  return CODA_DURATE.length;
}

// L'archivio cresce quando qualcuno carica con Cyberduck, e nessuno avvisa
// il MAM. Ogni ora si guardano gli ultimi dieci giorni su S3: se compare una
// cartella-partita nuova si rifa' l'indice. Alle cinque del mattino si
// rifa' comunque, per le cartelle vecchie riordinate a mano.
let cartelleRecenti = null, scandaglioInCorso = false;
async function controllaArchivioNuovo() {
  if (!s3Acceso() || scandaglioInCorso) return;
  try {
    // L'ARCHIVIO NON HA UNA FORMA SOLA, E NEANCHE IL CONTROLLO. Su S3 le
    // partite nuove sono cartelle nuove sotto il giorno; sulla NAS sono
    // file nuovi dentro la stessa cartella, e cercare le cartelle-giorno
    // li' non trovava mai niente: l'indice si sarebbe rifatto solo alle
    // cinque. Si guarda quello che c'e' — cartelle e file — e si tiene il
    // conto: se cambia, e' arrivato qualcosa.
    const oggi = new Date(), viste = [];
    if (magazzinoDi(ARCH_BUCKET).cartella) {
      for (const rd of radiciDi(ARCH_BUCKET)) {
        const pg = await s3Pagina(rd, "", ARCH_BUCKET, "/");
        (pg.cartelle || []).forEach((c) => viste.push(c));
        (pg.oggetti || []).forEach((o) => viste.push(o.chiave + "|" + o.peso));
      }
    } else {
      for (let i = 0; i < 10; i++) {
        const d = new Date(oggi.getTime() - i * 86400000);
        const g = d.getUTCFullYear() + ("0" + (d.getUTCMonth() + 1)).slice(-2) + ("0" + d.getUTCDate()).slice(-2);
        const pg = await s3Pagina(radiceDi(ARCH_BUCKET) + g + "/", "", ARCH_BUCKET, "/");
        (pg.cartelle || []).forEach((c) => viste.push(c));
      }
    }
    const firma = viste.length + ":" + viste.sort().join("|");
    const ora = new Date().getHours();
    const nuove = cartelleRecenti !== null && firma !== cartelleRecenti;
    cartelleRecenti = firma;
    if (!nuove && !(ora === 5 && !ultimoScandaglioOggi())) return;
    scandaglioInCorso = true;
    console.log("[clip] archivio: " + (nuove ? "roba nuova nel magazzino" : "giro delle cinque") + ", rifaccio l'indice");
    const r = await archivioScandaglia({ giorni: 3650 });   // tutto l'archivio, non gli ultimi 400 giorni
    console.log("[clip] archivio: indice rifatto, " + (r.partiteViste || 0) + " partite viste, " + (r.intere || 0) + " intere");
    ultimoScandaglio = Date.now();
  } catch (e) { console.log("[clip] archivio: controllo non riuscito: " + e.message); }
  finally { scandaglioInCorso = false; }
}
let ultimoScandaglio = 0;
function ultimoScandaglioOggi() { return new Date(ultimoScandaglio).toDateString() === new Date().toDateString(); }
setTimeout(controllaArchivioNuovo, 90000);
setInterval(controllaArchivioNuovo, 3600000);

// Le partite dell'archivio per nome, competizione e data: e' l'unico modo
// di trovare le quattromila che Airtable non conosce.
function cercaNellArchivio(q, limite) {
  if (!q.parole.length && !q.quando) return [];
  const fuori = [];
  Object.keys(ARCHIVIO).forEach((rec) => {
    const a = ARCHIVIO[rec], ms = Date.parse(a.quando);
    if (!quandoTorna(ms, q)) return;
    const testo = comeSiCerca([a.partita, a.competizione, dataScritta(ms)]);
    if (!tutteDentro(testo, q.parole)) return;
    fuori.push({ rec: rec, partita: a.partita, competizione: a.competizione || "", quando: a.quando,
                 pezzi: (a.pezzi || []).length || 1, soloS3: !!a.soloS3, fonte: a.fonte || "" });
  });
  fuori.sort((x, y) => (Date.parse(y.quando) || 0) - (Date.parse(x.quando) || 0));
  return fuori.slice(0, limite);
}


// ── I FATTI DI ESPN ─────────────────────────────────────────────────
//  Gli appunti danno il giudizio; ESPN da' i fatti: gol, rigori,
//  cartellini, sostituzioni, VAR, con il minuto e il giocatore, e le rose
//  con la grafia ufficiale. Per ogni partita agganciata all'archivio si
//  cerca l'evento ESPN (stesso giorno, stesse squadre), si scaricano i
//  fatti e si tengono in espn.json. Poi diventano risultati di ricerca
//  come le azioni degli appunti, con il secondo dal cronometro. E sui gol,
//  dove ci sono tutte e due le fonti, si misura di quanto ogni telecronista
//  scrive in ritardo.
let ESPN = {}, RITARDI = {}, RIT_PARTITA = {};
function fileEspn() { return path.join(DIR, "espn.json"); }
function fileRitardi() { return path.join(DIR, "ritardi.json"); }
function leggiEspn() {
  try { ESPN = JSON.parse(fs.readFileSync(fileEspn(), "utf8")) || {}; } catch (e) { ESPN = {}; }
  try {
    const r = JSON.parse(fs.readFileSync(fileRitardi(), "utf8")) || {};
    // il file vecchio era solo la tabella per persona
    if (r.persone || r.partite) { RITARDI = r.persone || {}; RIT_PARTITA = r.partite || {}; }
    else { RITARDI = r; RIT_PARTITA = {}; }
  } catch (e) { RITARDI = {}; RIT_PARTITA = {}; }
}
function scriviEspn() {
  try { fs.writeFileSync(fileEspn() + ".tmp", JSON.stringify(ESPN)); fs.renameSync(fileEspn() + ".tmp", fileEspn()); } catch (e) {}
  try { fs.writeFileSync(fileRitardi(), JSON.stringify({ persone: RITARDI, partite: RIT_PARTITA })); } catch (e) {}
}
// il bordo di ESPN respinge i client che non conosce: questa forma passa
function espnPrendi(url) {
  return new Promise((ok, no) => {
    const req = https.get(url, { headers: { "User-Agent": "curl/8.5.0 comotv-sonda" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return no(new Error("ESPN risponde " + res.statusCode)); }
      let b = ""; res.setEncoding("utf8");
      res.on("data", (d) => { b += d; });
      res.on("end", () => { try { ok(JSON.parse(b)); } catch (e) { no(new Error("ESPN: risposta non leggibile")); } });
    });
    req.on("error", no);
    req.setTimeout(20000, () => { req.destroy(new Error("ESPN: tempo scaduto")); });
  });
}
// in quali leghe ESPN puo' stare questa partita: la competizione dice
// quasi tutto, e dove e' ambigua si provano piu' codici
const ESPN_LEGHE = {
  "Serie A": ["ita.1"], "Serie B": ["ita.2"], "Coppa Italia": ["ita.coppa_italia"],
  "Eredivisie": ["ned.1"], "Scottish Premiership": ["sco.1"], "Scottish Championship": ["sco.2"],
  "Championship": ["sco.2", "eng.2"], "EFL Championship": ["eng.2"],
  "Scottish Cup": ["sco.tennents"], "Coppa di Scozia": ["sco.tennents"],
  "Premier Sports Cup": ["sco.cis"], "Scottish League Cup": ["sco.cis"], "Scottish League Cup ": ["sco.cis"],
  "Saudi Pro League": ["ksa.1"], "King's Cup": ["ksa.kings.cup"],
  "Bundesliga Austria": ["aut.1"], "Bundesliga Austriaca": ["aut.1"],
  "Coppa di Germania": ["ger.dfb_pokal"], "DFB-Pokal": ["ger.dfb_pokal"],
  "Carabao Cup": ["eng.league_cup"], "Coppa di Francia": ["fra.coupe_de_france"], "Coupe de France": ["fra.coupe_de_france"],
  "Coppa di Portogallo": ["por.taca.portugal"], "Taça de Portugal": ["por.taca.portugal"],
  "Copa Libertadores": ["conmebol.libertadores"], "Copa Sudamericana": ["conmebol.sudamericana"],
  "Recopa": ["conmebol.recopa"], "Recopa Sudamericana": ["conmebol.recopa"],
  "LPF Argentina": ["arg.1"], "Liga Profesional": ["arg.1"], "Clausura Liga Profesional": ["arg.1"],
  "Apertura Liga Profesional": ["arg.1"], "Copa de la Liga Profesional": ["arg.1"],
  "Super League Grecia": ["gre.1"], "Brasileirao": ["bra.1"], "Copa America": ["conmebol.america"],
  "Como 1907 | Prima Squadra": ["ita.1", "ita.coppa_italia", "ita.2"]
};
function legheDi(comp) { return ESPN_LEGHE[String(comp || "").trim()] || []; }
// le due squadre dal titolo: via risultato, parentesi e sigle audio
// Gli esonimi: la redazione scrive Salisburgo, Colonia, Lipsia, San Paolo;
// ESPN scrive Salzburg, Köln, Leipzig, São Paulo. Si traduce prima di cercare.
const ESONIMI = [
  ["SALISBURGO", "Salzburg"], ["VIENNA", "Vienna"], ["COLONIA", "Koln"], ["AMBURGO", "Hamburg"], ["FRIBURGO", "Freiburg"],
  ["MAGONZA", "Mainz"], ["LIPSIA", "Leipzig"], ["AUGUSTA", "Augsburg"], ["STOCCARDA", "Stuttgart"], ["NORIMBERGA", "Nurnberg"],
  ["FRANCOFORTE", "Frankfurt"], ["BAYERN MONACO", "Bayern Munich"], ["MONACO 1860", "1860 Munich"], ["BRUNSWICK", "Braunschweig"],
  ["PARIGI", "Paris"], ["MARSIGLIA", "Marseille"], ["NIZZA", "Nice"], ["LILLA", "Lille"], ["TOLOSA", "Toulouse"], ["LIONE", "Lyon"],
  ["SIVIGLIA", "Sevilla"], ["LISBONA", "Lisbon"], ["ATENE", "Athens"], ["SALONICCO", "Thessaloniki"], ["ZAGABRIA", "Zagreb"],
  ["SPALATO", "Split"], ["VARSAVIA", "Warsaw"], ["PRAGA", "Prague"], ["BRUGES", "Brugge"], ["ANVERSA", "Antwerp"], ["GAND", "Gent"],
  ["COPENAGHEN", "Copenhagen"], ["STOCCOLMA", "Stockholm"], ["BASILEA", "Basel"], ["ZURIGO", "Zurich"], ["BERNA", "Bern"],
  ["GINEVRA", "Geneva"], ["LOSANNA", "Lausanne"], ["ATLETICO MINEIRO", "AtleticoMG"], ["ATHLETICO PARANAENSE", "AthleticoPR"],
  ["SAN PAOLO", "Sao Paulo"], ["RIAD", "Riyadh"], ["GEDDA", "Jeddah"], ["IL CAIRO", "Cairo"], ["DEP. RIESTRA", "Deportivo Riestra"],
  ["INDEP. MEDELLIN", "Independiente Medellin"], ["U. DE CHILE", "Universidad de Chile"], ["UNIV. CATOLICA", "Universidad Catolica"],
  ["HEART OF MIDLOTIAN", "Hearts"], ["HEART OF MIDLOTHIAN", "Hearts"], ["DUNDEE UTD", "Dundee United"], ["KILMARNOK", "Kilmarnock"]
];
function conEsonimi(t) {
  let u = String(t || "");
  ESONIMI.forEach(([ita, eng]) => { u = u.replace(new RegExp("\\b" + ita.replace(/[.]/g, "\\.") + "\\b", "gi"), eng); });
  return u;
}
function squadreDi(partita) {
  const t = conEsonimi(String(partita || "").replace(/\[[^\]]*\]|\(.*?\)/g, " ").replace(/\s\d+\s*-\s*\d+.*$/, "")).trim();
  return t.split(/\s+vs\.?\s+|\s+-\s+|-/i).map((x) => ({
    tutto: nomeSemplice(x),
    // le parole lunghe del nome: "DEP. RIESTRA" trova "Deportivo Riestra" per "riestra"
    parole: x.split(/[^A-Za-zÀ-ÿ]+/).map((w) => nomeSemplice(w)).filter((w) => w.length >= 4 && !/^(real|club|atletico|deportivo|sporting|united|city|town|athletic|football)$/.test(w))
  })).filter((x) => x.tutto.length >= 3);
}
function squadraCombacia(nostra, ev) {
  const nomi = [];
  ((ev.competitions || [])[0] || {}).competitors && ev.competitions[0].competitors.forEach((c) => {
    const tm = c.team || {};
    [tm.displayName, tm.shortDisplayName, tm.name, tm.location, tm.abbreviation].forEach((n) => { if (n) nomi.push(nomeSemplice(n)); });
  });
  [ev.name, ev.shortName].forEach((n) => { if (n) nomi.push(nomeSemplice(n)); });
  if (nomi.some((n) => n.length >= 4 && (n.indexOf(nostra.tutto) >= 0 || nostra.tutto.indexOf(n) >= 0))) return true;
  return nostra.parole.some((w) => nomi.some((n) => n.indexOf(w) >= 0));
}
const espnCache = {};
async function espnScoreboard(lega, giorno) {
  const k = lega + "|" + giorno;
  if (espnCache[k]) return espnCache[k];
  const d = await espnPrendi("https://site.api.espn.com/apis/site/v2/sports/soccer/" + lega + "/scoreboard?dates=" + giorno + "&limit=200");
  espnCache[k] = d.events || [];
  if (Object.keys(espnCache).length > 400) Object.keys(espnCache).slice(0, 200).forEach((x) => delete espnCache[x]);
  return espnCache[k];
}
function minutoEspn(v) {
  const m = /(\d{1,3})'?\s*(?:\+\s*(\d{1,2}))?/.exec(String(v || ""));
  return m ? { min: +m[1], stopp: m[2] ? +m[2] : 0 } : null;
}
function espnDatiDi(rec) {
  const a = ARCHIVIO[rec] || APPUNTI[rec] || (STORICI.find((e) => e.id === rec) || null);
  return a ? { partita: a.partita, competizione: a.competizione, quando: a.quando } : null;
}
async function espnTrova(rec) {
  const info = espnDatiDi(rec);
  if (!info || !info.quando) throw new Error("partita senza data");
  const leghe = legheDi(info.competizione);
  if (!leghe.length) { ESPN[rec] = { mancante: "competizione non coperta", quando: info.quando }; return ESPN[rec]; }
  const squadre = squadreDi(info.partita);
  if (squadre.length < 2) { ESPN[rec] = { mancante: "titolo senza due squadre", quando: info.quando }; return ESPN[rec]; }
  const t0 = Date.parse(info.quando);
  let trovato = null, legaTrovata = "";
  for (const lega of leghe) {
    for (const salto of [0, -1, 1]) {
      const g = new Date(t0 + salto * 86400000);
      const giorno = g.getUTCFullYear() + String(g.getUTCMonth() + 1).padStart(2, "0") + String(g.getUTCDate()).padStart(2, "0");
      let eventi = [];
      try { eventi = await espnScoreboard(lega, giorno); } catch (e) { continue; }
      const buoni = eventi.map((ev) => ({ ev: ev, n: squadre.filter((sq) => squadraCombacia(sq, ev)).length,
                                          dt: Math.abs((Date.parse(ev.date) || 0) - t0) }))
        .filter((x) => x.n >= 1 && x.dt < 30 * 3600000)
        .sort((x, y) => (y.n - x.n) || (x.dt - y.dt));
      // tutte e due le squadre; una sola basta se quel giorno, in quella lega,
      // quella squadra gioca in una partita sola (l'altra e' scritta male)
      if (buoni.length && buoni[0].n >= Math.min(2, squadre.length)) { trovato = buoni[0].ev; legaTrovata = lega; break; }
      if (buoni.length && buoni[0].n === 1) {
        const sq = squadre.find((x) => squadraCombacia(x, buoni[0].ev));
        const altre = eventi.filter((ev) => ev !== buoni[0].ev && squadraCombacia(sq, ev));
        if (!altre.length && buoni[0].dt < 6 * 3600000) { trovato = buoni[0].ev; legaTrovata = lega; break; }
      }
    }
    if (trovato) break;
  }
  if (!trovato) { ESPN[rec] = { mancante: "non trovata su ESPN", quando: info.quando }; return ESPN[rec]; }
  const sm = await espnPrendi("https://site.api.espn.com/apis/site/v2/sports/soccer/" + legaTrovata + "/summary?event=" + trovato.id);
  // GAMECAST: nella stessa risposta c'e' la telecronaca scritta, che finora
  // buttavamo via. Sono cinque volte gli eventi chiave — tiri, parate,
  // occasioni, falli — e soprattutto ci sono anche dove nessun giornalista
  // ha scritto appunti, che sono migliaia di partite.
  const gamecast = leggiGamecast(sm);
  const eventi = (sm.keyEvents || []).map((k) => {
    const tipo = ((k.type || {}).text) || "";
    const mm = minutoEspn((k.clock || {}).displayValue);
    if (!mm || /kickoff|half|end |full|start/i.test(tipo)) return null;
    const periodo = ((k.period || {}).number) || (mm.min > 45 ? 2 : 1);
    return { tipo: tipo, min: mm.min, stopp: mm.stopp, periodo: periodo,
             squadra: ((k.team || {}).displayName) || "",
             giocatore: (((k.participants || [])[0] || {}).athlete || {}).displayName || "",
             testo: k.shortText || k.text || "" };
  }).filter(Boolean);
  const rose = {};
  (sm.rosters || []).forEach((r) => {
    const nome = ((r.team || {}).displayName) || "?";
    rose[nome] = (r.roster || []).map((x) => (x.athlete || {}).displayName).filter(Boolean);
  });
  const comp = (trovato.competitions || [])[0] || {};
  const casaOsp = (comp.competitors || []).map((c) => ((c.team || {}).displayName) || "");
  ESPN[rec] = { id: trovato.id, lega: legaTrovata, quando: trovato.date || info.quando, nome: trovato.name || "",
                squadre: casaOsp, eventi: eventi, gamecast: gamecast, rose: rose,
                letto: new Date().toISOString() };
  misuraRitardo(rec);
  return ESPN[rec];
}
// ══════════════════════════════════════════════════════════════════════
//  GAMECAST — la telecronaca scritta di ESPN
// ══════════════════════════════════════════════════════════════════════
//
//  Arriva dentro la stessa risposta che chiediamo gia' per i gol: una
//  novantina di righe per partita, in inglese, con il minuto e una frase.
//  Non serve alla PRECISIONE — quella la da' il cronometro letto
//  dall'immagine — ma alla COMPLETEZZA: e' l'unica fonte sulle migliaia di
//  partite dove nessuno ha scritto appunti.
//
//  Le righe non valgono tutte uguale. Un tiro in porta e una parata sono
//  highlights; un fallo a centrocampo e una rimessa laterale no, e messi
//  tutti in fila renderebbero la lista illeggibile. Quindi ognuna porta il
//  suo peso, e il montato prende dall'alto.
const TIPI_GAMECAST = [
  // [come lo scrive ESPN, come si chiama da noi, quanto pesa]
  [/^goal|goal!/i,                       "Gol",          10],
  [/penalty (saved|missed)/i,            "Rigore",        9],
  [/^attempt saved/i,                    "Parata",        7],
  [/^attempt blocked/i,                  "Occasione",     5],
  [/hits the (bar|post)|woodwork/i,      "Palo",          8],
  [/^attempt missed/i,                   "Occasione",     5],
  [/second yellow|red card/i,            "Espulsione",    8],
  [/yellow card|booked/i,                "Ammonizione",   4],
  [/substitution/i,                      "Cambio",        2],
  [/offside/i,                           "Fuorigioco",    2],
  [/corner/i,                            "Angolo",        3],
  [/wins a free kick/i,                  "Punizione",     2],
  [/^foul by|hand ball/i,                "Fallo",         1],
  [/delay|var|review/i,                  "VAR",           4],
  [/first half (begins|ends)|second half (begins|ends)|match ends/i, "Tempo", 1]
];
function tipoGamecast(testo, tipoEspn) {
  // Il testo e il tipo si guardano SEPARATI: incollati insieme le regole
  // ancorate all'inizio ("^attempt saved") non trovavano piu' niente, e
  // uscivano solo angoli e punizioni — cioe' l'esatto contrario di quello
  // che serve a un montato.
  const a = String(testo || "").trim(), b = String(tipoEspn || "").trim();
  for (const [r, nome, peso] of TIPI_GAMECAST) if (r.test(a) || r.test(b)) return { tipo: nome, peso: peso };
  return { tipo: "", peso: 0 };
}
// Il nome di chi fa la cosa: ESPN lo scrive per esteso, seguito dalla
// squadra fra parentesi. "Attempt saved. Brynjolfur Willumsson (Groningen)
// header..." -> Willumsson.
function chiFaGamecast(testo) {
  const m = /([A-ZÀ-Þ][\wÀ-ÿ'’.-]+(?: [A-ZÀ-Þ][\wÀ-ÿ'’.-]+){0,3})\s*\(/.exec(String(testo || ""));
  return m ? m[1].trim() : "";
}
function leggiGamecast(sm) {
  const fuori = [];
  (sm.commentary || []).forEach((c) => {
    const testo = String(c.text || "").trim();
    if (!testo) return;
    const mm = minutoEspn((c.time || {}).displayValue || "");
    if (!mm) return;
    const pl = c.play || {};
    const q = tipoGamecast(testo, ((pl.type || {}).text) || "");
    // sotto il quattro sono angoli, falli, rimesse e cambi: in un montato
    // non ci vanno, e in elenco coprirebbero le cose che contano
    if (!q.tipo || q.peso < 4) return;
    const periodo = ((pl.period || {}).number) || (mm.min > 45 ? 2 : 1);
    fuori.push({ tipo: q.tipo, peso: q.peso, min: mm.min, stopp: mm.stopp, periodo: periodo,
                 giocatore: chiFaGamecast(testo), testo: testo.slice(0, 200) });
  });
  return fuori;
}

// Un telecronista scrive il minuto DOPO aver visto l'azione. Sui gol, dove
// ESPN dice il minuto vero, si misura di quanto: la mediana per persona e'
// il suo ritardo, e si sottrae a tutte le sue righe.
function misuraRitardo(rec) {
  const a = APPUNTI[rec], e = ESPN[rec];
  if (!a || !e || !e.eventi || !a.telecronista) return;
  const goalEspn = e.eventi.filter((x) => /goal/i.test(x.tipo) && !/cancel|disallow|no goal/i.test(x.tipo));
  const goalNostri = a.righe.filter((r) => /gol/i.test(r.t || "") || /\bgol\b|\bgoal\b/i.test(r.x || ""));
  goalEspn.forEach((g) => {
    const mg = g.min + g.stopp;
    let meglio = null;
    goalNostri.forEach((r) => {
      const mn = /^(\d+)(?:\+(\d+))?/.exec(r.m || ""); if (!mn) return;
      const mr = +mn[1] + (mn[2] ? +mn[2] : 0);
      const d = mr - mg;
      if (Math.abs(d) <= 4 && (meglio === null || Math.abs(d) < Math.abs(meglio))) meglio = d;
    });
    if (meglio === null) return;
    const t = a.telecronista;
    RITARDI[t] = RITARDI[t] || { valori: [] };
    RITARDI[t].valori.push(meglio);
    if (RITARDI[t].valori.length > 400) RITARDI[t].valori.shift();
    // e sulla PARTITA, che e' quella che conta
    RIT_PARTITA[rec] = RIT_PARTITA[rec] || { valori: [] };
    RIT_PARTITA[rec].valori.push(meglio);
  });
}
function mediana(v) {
  const x = v.slice().sort((a, b) => a - b);
  return x[Math.floor(x.length / 2)];
}
// Quanto tardi ha scritto CHI HA RACCONTATO QUESTA PARTITA, quella sera.
//  Prima si prendeva l'abitudine della persona, misurata su tutte le sue
//  partite. Ma non e' detto che un telecronista si comporti allo stesso
//  modo tutte le volte: dipende dalla serata, da quanto ha da dire, da
//  chi gli sta parlando in cuffia. Quindi si misura la singola partita, e
//  se la partita non ha abbastanza gol per dirlo non si corregge niente:
//  meglio nessuno spostamento che uno spostamento preso da un'altra sera.
// Rifa' il conto su tutto quello che e' gia' in casa: ESPN e appunti ci
// sono, non serve ricomprare niente. Serve dopo un cambiamento del modo di
// misurare — o la prima volta, che la tabella per partita nasce vuota.
function rimisuraRitardi() {
  RITARDI = {}; RIT_PARTITA = {};
  Object.keys(ESPN).forEach((rec) => { try { misuraRitardo(rec); } catch (e) {} });
  scriviEspn();
  const con = Object.keys(RIT_PARTITA).filter((k) => RIT_PARTITA[k].valori.length >= 2);
  console.log("[clip] ritardi rimisurati: " + con.length + " partite lo sanno dire da sole");
  return con.length;
}
function ritardoPartita(rec) {
  const r = RIT_PARTITA[rec || ""];
  if (!r || r.valori.length < 2) return 0;
  const med = mediana(r.valori);
  return Math.abs(med) <= 3 ? med * 60 : 0;
}
// l'abitudine della persona resta, ma solo da guardare: non sposta niente
function ritardoDi(telecronista) {
  const r = RITARDI[telecronista || ""];
  if (!r || r.valori.length < 6) return 0;
  const med = mediana(r.valori);
  return Math.abs(med) <= 3 ? med * 60 : 0;
}
const CODA_ESPN = [];
let espnInMoto = false, espnFatti = 0, espnTrovati = 0, espnFalliti = 0, espnDaScrivere = 0;
function giraEspn() {
  if (espnInMoto || !CODA_ESPN.length) { if (!CODA_ESPN.length && !espnInMoto) scriviEspn(); return; }
  espnInMoto = true;
  const rec = CODA_ESPN.shift();
  espnTrova(rec).then((e) => { espnFatti++; if (e && !e.mancante) espnTrovati++; })
    .catch((er) => { espnFalliti++; console.log("[clip] espn (" + rec + "): " + er.message); })
    .then(() => {
      espnInMoto = false;
      if (++espnDaScrivere >= 25) { espnDaScrivere = 0; scriviEspn(); }
      setTimeout(giraEspn, 250);         // con garbo: quattro richieste al secondo bastano
    });
}
function espnInCoda(rifai) {
  const gia = new Set(CODA_ESPN);
  Object.keys(ARCHIVIO).forEach((rec) => {
    if (rec.indexOf("s3:") === 0 || gia.has(rec)) return;
    if (ESPN[rec] && !(rifai && ESPN[rec].mancante)) return;
    CODA_ESPN.push(rec);
  });
  CODA_ESPN.sort((x, y) => prioritaPartita(x) - prioritaPartita(y));
  giraEspn();
  return CODA_ESPN.length;
}
// I fatti come risultati di ricerca: stessa forma delle azioni degli
// appunti, con "fonte: espn", cosi' in pagina stanno nella stessa lista
const TIPI_ESPN = [
  [/own goal/i, "Autogol"], [/penalty.*(missed|saved)/i, "Rigore sbagliato"], [/penalty/i, "Rigore"],
  [/goal.*(cancel|disallow)|no goal|var/i, "Gol annullato (VAR)"], [/goal/i, "Gol"],
  [/yellow/i, "Ammonizione"], [/red/i, "Espulsione"], [/substitution/i, "Sostituzione"]
];
function tipoItaliano(tipo) {
  for (const [re, ita] of TIPI_ESPN) if (re.test(tipo || "")) return ita;
  return tipo || "";
}
function cercaNeiFatti(q, limite) {
  const fuori = [];
  Object.keys(ESPN).forEach((rec) => {
    const e = ESPN[rec];
    if (!e || !e.eventi) return;
    const info = espnDatiDi(rec) || {};
    const quando = info.quando || e.quando;
    if (!quandoTorna(Date.parse(quando), q)) return;
    const capo = comeSiCerca([info.partita, info.competizione, (APPUNTI[rec] || {}).telecronista, dataScritta(Date.parse(quando))]);
    e.eventi.forEach((x) => {
      const ita = tipoItaliano(x.tipo);
      const testo = comeSiCerca([ita, x.tipo, x.giocatore, x.squadra, x.testo, capo,
                                 /Gol/.test(ita) ? "goal rete segna" : "", /Espuls/.test(ita) ? "rosso cartellino" : "",
                                 /Ammon/.test(ita) ? "giallo cartellino" : "", /Sostit/.test(ita) ? "cambio" : ""]);
      if (!tutteDentro(testo, q.parole)) return;
      const d = (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + x.stopp * 60;
      const dove = secondoNelFile(rec, { s: x.periodo, d: Math.max(0, d) });
      const nellAzione = q.parole.length ? tutteDentro(comeSiCerca([ita, x.tipo, x.giocatore, x.squadra, x.testo]), q.parole) : false;
      fuori.push({ peso: nellAzione ? 1 : 0,
        rec: rec, partita: info.partita || e.nome, competizione: info.competizione || "", quando: quando,
        minuto: x.min + (x.stopp ? "+" + x.stopp : "'"), tempo: x.periodo, tipo: ita,
        testo: [ita, x.giocatore, x.squadra ? "(" + x.squadra + ")" : ""].filter(Boolean).join(" "),
        hl: false, fonte: "espn", telecronista: (APPUNTI[rec] || {}).telecronista || "",
        archivio: !!ARCHIVIO[rec], dove: (dove || {}).secondi || null,
        pezzo: (dove || {}).pezzo || 0, d: Math.max(0, d),
        orologio: !!(ARCHIVIO[rec] && ARCHIVIO[rec].orologio)
      });
    });
  });
  return fuori;
}


// ══════════════════════════════════════════════════════════════════════
//  CERCARE PER SIGNIFICATO
// ══════════════════════════════════════════════════════════════════════
//
//  La ricerca per lettere trova "palo" solo dove c'e' scritto "palo". Ma
//  chi cerca ha in testa una cosa, non una parola: "legno da fuori area"
//  vuole dire anche "traversa clamorosa dalla distanza". Un modello piccolo
//  trasforma ogni riga in trecentottantaquattro numeri, e frasi che vogliono
//  dire la stessa cosa finiscono vicine. Gira sulla CPU della VM, venti
//  millisecondi a frase, e non tocca un byte di video.
const VETT_DIM = 384;
const VETT_MODELLO = "Xenova/multilingual-e5-small";
let SIGN = { pronto: false, ids: [], meta: [], vett: null, quanti: 0, inCorso: false, fatti: 0, errore: "" };
let modelloVett = null, modelloInCorso = null;

function fileVettori() { return path.join(DIR, "vettori.bin"); }
function fileVettoriMeta() { return path.join(DIR, "vettori.json"); }

async function apriModello() {
  if (modelloVett) return modelloVett;
  if (modelloInCorso) return modelloInCorso;
  modelloInCorso = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");
    env.cacheDir = path.join(__dirname, "modelli");
    env.allowLocalModels = false;
    modelloVett = await pipeline("feature-extraction", VETT_MODELLO, { quantized: true });
    console.log("[clip] modello del significato pronto");
    return modelloVett;
  })();
  return modelloInCorso;
}

// Le righe da capire: gli appunti della redazione e quello che e' stato
// detto. I fatti di ESPN no: sono formule ("Gol Nico Paz"), e per quelle
// la ricerca per lettere basta e avanza.
function statoSignificato() {
  const tutte = righeDaCapire().length;
  return { capite: SIGN.quanti, daCapire: Math.max(0, tutte - SIGN.quanti), inCorso: SIGN.inCorso,
           pronto: SIGN.pronto, modello: VETT_MODELLO, errore: SIGN.errore };
}
function righeDaCapire() {
  const fuori = [];
  Object.keys(APPUNTI).forEach((rec) => {
    const a = APPUNTI[rec];
    (a.righe || []).forEach((r, i) => {
      const testo = String(r.x || "").trim();
      if (testo.length < 12) return;
      fuori.push({ id: "a:" + rec + ":" + i, testo: testo,
                   meta: { tipo: "appunto", rec: rec, i: i } });
    });
  });
  Object.keys(PARLATO).forEach((reg) => {
    (PARLATO[reg].pezzi || []).forEach((t, i) => {
      const testo = String(t.x || "").trim();
      if (testo.length < 25) return;
      fuori.push({ id: "v:" + reg + ":" + i, testo: testo,
                   meta: { tipo: "detta", reg: reg, i: i, secondi: t.a } });
    });
  });
  return fuori;
}

function leggiVettori() {
  try {
    const m = JSON.parse(fs.readFileSync(fileVettoriMeta(), "utf8"));
    const b = fs.readFileSync(fileVettori());
    const n = m.ids.length;
    if (b.length !== n * VETT_DIM * 4) throw new Error("misura che non torna");
    SIGN.ids = m.ids; SIGN.meta = m.meta; SIGN.quanti = n;
    SIGN.vett = new Float32Array(b.buffer, b.byteOffset, n * VETT_DIM);
    SIGN.pronto = n > 0;
    console.log("[clip] significato: " + n + " righe gia' capite");
  } catch (e) { SIGN.ids = []; SIGN.meta = []; SIGN.vett = null; SIGN.quanti = 0; SIGN.pronto = false; }
}
function scriviVettori() {
  try {
    fs.writeFileSync(fileVettoriMeta() + ".tmp", JSON.stringify({ ids: SIGN.ids, meta: SIGN.meta, modello: VETT_MODELLO }));
    fs.writeFileSync(fileVettori() + ".tmp", Buffer.from(SIGN.vett.buffer, SIGN.vett.byteOffset, SIGN.quanti * VETT_DIM * 4));
    fs.renameSync(fileVettoriMeta() + ".tmp", fileVettoriMeta());
    fs.renameSync(fileVettori() + ".tmp", fileVettori());
  } catch (e) { console.log("[clip] significato non salvato: " + e.message); }
}

// Si capiscono le righe nuove, trentadue alla volta, e ci si ferma appena
// arriva una diretta: e' lavoro che puo' aspettare.
async function capisciRighe(tetto) {
  if (SIGN.inCorso) return { gia: true };
  SIGN.inCorso = true; SIGN.errore = "";
  try {
    const tutte = righeDaCapire();
    const gia = new Set(SIGN.ids);
    const nuove = tutte.filter((x) => !gia.has(x.id));
    if (!nuove.length) { SIGN.pronto = SIGN.quanti > 0; return { ok: true, nuove: 0, totale: SIGN.quanti }; }
    const estrai = await apriModello();
    const massimo = tetto || nuove.length;
    const daFare = nuove.slice(0, massimo);
    // si cresce l'archivio dei numeri: un blocco nuovo grande quanto serve
    const vecchi = SIGN.vett;
    const grande = new Float32Array((SIGN.quanti + daFare.length) * VETT_DIM);
    if (vecchi) grande.set(vecchi.subarray(0, SIGN.quanti * VETT_DIM));
    let scritti = SIGN.quanti;
    // Lotti piccoli e un respiro fra l'uno e l'altro: il modello lavora sul
    // filo principale, e a lotti da trentadue il ponte smetteva di rispondere
    // per mezzo secondo alla volta (nel log erano 504).
    for (let i = 0; i < daFare.length; i += 8) {
      if (registrandoDavvero()) { console.log("[clip] significato: c'e' una diretta, mi fermo"); break; }
      await new Promise((r) => setTimeout(r, 15));
      const lotto = daFare.slice(i, i + 8);
      const v = await estrai(lotto.map((x) => "passage: " + x.testo.slice(0, 400)), { pooling: "mean", normalize: true });
      lotto.forEach((x, k) => {
        grande.set(v.data.subarray(k * VETT_DIM, (k + 1) * VETT_DIM), scritti * VETT_DIM);
        SIGN.ids.push(x.id); SIGN.meta.push(x.meta); scritti++;
      });
      SIGN.fatti += lotto.length;
      if (scritti % 2048 < 8) console.log("[clip] significato: " + scritti + " righe su " + tutte.length);
    }
    SIGN.vett = grande; SIGN.quanti = scritti; SIGN.pronto = scritti > 0;
    scriviVettori();
    console.log("[clip] significato: " + scritti + " righe capite in tutto");
    return { ok: true, nuove: scritti - (vecchi ? vecchi.length / VETT_DIM : 0), totale: scritti };
  } catch (e) {
    SIGN.errore = e.message; console.log("[clip] significato: " + e.message);
    return { ok: false, errore: e.message };
  } finally { SIGN.inCorso = false; }
}

// La domanda diventa numeri, e si cercano i vicini. Venticinquemila righe
// si confrontano in una ventina di millisecondi: non serve un database.
async function cercaPerSignificato(domanda, limite) {
  if (!SIGN.pronto || !SIGN.quanti) return [];
  const estrai = await apriModello();
  const q = await estrai(["query: " + String(domanda).slice(0, 300)], { pooling: "mean", normalize: true });
  const qd = q.data, v = SIGN.vett, n = SIGN.quanti;
  const punti = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, b = i * VETT_DIM;
    for (let k = 0; k < VETT_DIM; k++) s += qd[k] * v[b + k];
    punti[i] = s;
  }
  const ordine = Array.from(punti.keys()).sort((a, b) => punti[b] - punti[a]).slice(0, (limite || 20) * 3);
  const fuori = [];
  for (const i of ordine) {
    const m = SIGN.meta[i];
    if (punti[i] < 0.835) break;                      // sotto questo non e' vicinanza, e' rumore
    if (m.tipo === "appunto") {
      const a = APPUNTI[m.rec], r = a && a.righe[m.i];
      if (!r) continue;
      const rit = ritardoPartita(m.rec);
      const dove = secondoNelFile(m.rec, { s: r.s, d: Math.max(0, (r.d || 0) - rit) });
      fuori.push({ rec: m.rec, partita: a.partita, competizione: a.competizione, quando: a.quando,
                   minuto: r.m, tempo: r.s, tipo: r.t, testo: r.x, hl: !!r.hl, rating: r.g || 0,
                   fonte: a.fonte === "storico" ? "storico" : "appunti", telecronista: a.telecronista || "",
                   vicinanza: Math.round(punti[i] * 100) / 100,
                   archivio: !!ARCHIVIO[m.rec], dove: (dove || {}).secondi || null,
                   pezzo: (dove || {}).pezzo || 0, d: Math.max(0, (r.d || 0) - rit),
                   orologio: !!(ARCHIVIO[m.rec] && ARCHIVIO[m.rec].orologio) });
    } else {
      const reg = R.reg[m.reg], p = PARLATO[m.reg] && PARLATO[m.reg].pezzi[m.i];
      if (!reg || !p) continue;
      fuori.push({ reg: m.reg, partita: reg.titolo, secondi: p.a, testo: p.x,
                   quando: reg.avviata, vicinanza: Math.round(punti[i] * 100) / 100, fonte: "voce" });
    }
    if (fuori.length >= (limite || 20)) break;
  }
  return fuori;
}

function cercaNegliAppunti(q, limite) {
  const fuori = [];
  Object.keys(APPUNTI).forEach((rec) => {
    const a = APPUNTI[rec];
    // il telecronista fa parte di quello che si cerca: "i gol di Douvikas
    // raccontati da Taglieri" e' una domanda legittima
    const capo = comeSiCerca([a.partita, a.competizione, a.telecronista, dataScritta(Date.parse(a.quando))]);
    if (!quandoTorna(Date.parse(a.quando), q)) return;
    a.righe.forEach((r) => {
      const testo = comeSiCerca([r.x, r.t, r.m, r.g ? "rating " + r.g : "", capo]);
      if (!tutteDentro(testo, q.parole)) return;
      const rit = ritardoPartita(rec);
      const dove = secondoNelFile(rec, { s: r.s, d: Math.max(0, (r.d || 0) - rit) });
      // le parole nell'azione valgono piu' delle parole nel nome della partita:
      // "como" sta in mille titoli, "Paz palo" in una riga sola
      const nellAzione = q.parole.length ? tutteDentro(comeSiCerca([r.x, r.t, r.m]), q.parole) : false;
      fuori.push({ peso: nellAzione ? 1 : 0,
        rec: rec, partita: a.partita, competizione: a.competizione, quando: a.quando,
        minuto: r.m, tempo: r.s, tipo: r.t, testo: r.x, hl: !!r.hl, rating: r.g || 0,
        fonte: a.fonte === "storico" ? "storico" : "appunti", telecronista: a.telecronista || "",
        archivio: !!ARCHIVIO[rec], dove: (dove || {}).secondi || null,
        pezzo: (dove || {}).pezzo || 0, d: Math.max(0, (r.d || 0) - rit),
        orologio: !!(ARCHIVIO[rec] && ARCHIVIO[rec].orologio)
      });
    });
  });
  cercaNeiFatti(q, limite).forEach((x) => fuori.push(x));
  // una sostituzione non pesa come un gol: quando la domanda non distingue
  // (si cerca una squadra, un giocatore) l'ordine lo fa quello che e' successo
  const conta = (x) => /sostituzione|cambio/i.test(x.tipo || "") ? 0
                     : /gol|rete|rigore|autogol/i.test(x.tipo || "") ? 3
                     : /palo|traversa|parata|espuls/i.test(x.tipo || "") ? 2 : 1;
  // se la domanda nomina una cosa precisa — "palo", "parata", "rosso" —
  // quella cosa viene prima di tutto: chi cerca un palo non vuole un gol
  // che ha la parola "palo" dentro la descrizione
  const chiesto = [["gol", /gol|rete|rigore|autogol/i], ["palo", /palo|traversa/i], ["traversa", /palo|traversa/i],
                   ["parata", /parata/i], ["rigore", /rigore/i], ["rosso", /cartellino|espuls/i],
                   ["espulsione", /cartellino|espuls/i], ["giallo", /cartellino|ammoni/i],
                   ["occasione", /occasione/i], ["giocata", /skill/i]]
    .filter(([parola]) => q.parole.indexOf(parola) >= 0).map(([, re]) => re);
  fuori.forEach((x) => {
    x.conta = conta(x) + (x.rating ? 1 : 0) + (x.hl ? 1 : 0)
            + (chiesto.length && chiesto.some((re) => re.test(x.tipo || "")) ? 6 : 0);
  });
  fuori.sort((a, b) => ((b.peso || 0) - (a.peso || 0)) || ((b.conta || 0) - (a.conta || 0)) ||
                       ((Date.parse(b.quando) || 0) - (Date.parse(a.quando) || 0)) ||
                       ((a.tempo || 0) - (b.tempo || 0)) || ((a.d || 0) - (b.d || 0)));
  // non piu' di otto righe per partita: chi cerca un giocatore vuole vedere
  // le partite, non centocinquanta righe della stessa
  const perPartita = {}, scelte = [];
  fuori.forEach((x) => {
    perPartita[x.rec] = (perPartita[x.rec] || 0) + 1;
    if (perPartita[x.rec] <= 8) scelte.push(x);
  });
  return scelte.slice(0, limite);
}

// ── i file: playlist, segmenti, clip ──────────────────────────────────

const TIPI = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4",
               ".xml": "application/xml", ".jpg": "image/jpeg",
               // il PNG serve alle grafiche del livello V2: senza, l'anteprima
               // sopra il Programma era un riquadro vuoto con dentro un 404
               ".png": "image/png" };

// ── IL PONTE SUL MAGAZZINO DI CASA ────────────────────────────────────
//
//  Un magazzino in casa sta dietro un tunnel, e il tunnel arriva alla VM —
//  non ai portatili dei montatori. Ma nel MAM il video va dal browser
//  DIRETTAMENTE al magazzino: e' cosi' che funziona con S3, ed e' il motivo
//  per cui guardare una partita non costa niente alla VM.
//
//  Per il materiale di casa quel salto non si puo' fare, e allora la VM fa
//  da ponte: chiede i byte alla NAS e li ripassa al browser come sono,
//  intervalli compresi. Gli intervalli sono la parte che conta: senza,
//  spostarsi dentro due ore di partita vorrebbe dire scaricarle tutte.
//
//  L'indirizzo scade, come quelli firmati di S3 — stessa idea, altra
//  chiave. Se no il magazzino privato di Como diventerebbe leggibile da
//  chiunque sappia indovinare un identificativo.
const CHIAVE_PONTE = process.env.COMOTV_CHIAVE_COMANDO || process.env.COMOTV_TOKEN || "ponte";
function firmaPonte(id, fino, pezzo) {
  return crypto.createHmac("sha256", CHIAVE_PONTE)
    .update(id + "|" + fino + "|" + (pezzo || 0)).digest("hex").slice(0, 32);
}
// il pezzo sta nell'indirizzo: la partita intera e' piu' file, e il
// browser deve poter chiedere quello che gli serve
function viaPonte(id, quanto, pezzo) {
  const fino = Math.floor(Date.now() / 1000) + (quanto || 21600);
  const i = pezzo || 0;
  return "/magazzino/" + encodeURIComponent(id) + "?fino=" + fino +
         (i ? "&p=" + i : "") + "&f=" + firmaPonte(id, fino, i);
}
// il magazzino di questa partita e' raggiungibile dal browser?
function magazzinoDaFuori(r) {
  if (!r || !r.arch) return true;
  const m = magazzinoDi(r.arch.bucket);
  if (m.cartella) return false;                    // un percorso sul disco: il browser non lo apre mai
  if (!m.endpoint) return true;                    // Amazon: sempre
  return m.fuori === true;                         // di casa: solo se lo dici tu
}
function serviFileLocale(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
    const base = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
                   "Cache-Control": "private, max-age=3600", "Access-Control-Allow-Origin": "*" };
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let a = m && m[1] ? parseInt(m[1], 10) : 0;
      let b = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (m && !m[1] && m[2]) { a = Math.max(0, st.size - parseInt(m[2], 10)); b = st.size - 1; }
      b = Math.min(b, st.size - 1);
      if (a > b) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, Object.assign({}, base, { "Content-Length": b - a + 1,
        "Content-Range": "bytes " + a + "-" + b + "/" + st.size }));
      fs.createReadStream(file, { start: a, end: b }).pipe(res);
      return;
    }
    res.writeHead(200, Object.assign({}, base, { "Content-Length": st.size }));
    fs.createReadStream(file).pipe(res);
  });
}
async function serviMagazzino(req, res, u) {
  const id = decodeURIComponent(u.pathname.slice("/magazzino/".length));
  const fino = parseInt(u.searchParams.get("fino") || "0", 10);
  const f = u.searchParams.get("f") || "";
  const i = Math.max(0, parseInt(u.searchParams.get("p") || "0", 10) || 0);
  if (!fino || fino < Math.floor(Date.now() / 1000) || f !== firmaPonte(id, fino, i)) {
    res.writeHead(403).end("indirizzo scaduto"); return;
  }
  const r = R.reg[id];
  if (!r || !r.arch) { res.writeHead(404).end("non trovato"); return; }
  const pz = pezziArch(r);
  if (i >= pz.length) { res.writeHead(404).end("questo pezzo non c'e'"); return; }
  let sorgente;
  try { sorgente = viaPezzo(r, pz[i]); } catch (e) { res.writeHead(502).end("magazzino non raggiungibile"); return; }
  // un magazzino di cartella da' un percorso: si serve il file, con gli
  // intervalli, senza passare da nessuna rete
  if (!/^https?:\/\//.test(sorgente)) return serviFileLocale(req, res, sorgente);
  const testa = {};
  if (req.headers.range) testa.Range = req.headers.range;
  try {
    const risp = await fetch(sorgente, { headers: testa, signal: AbortSignal.timeout(30000) });
    const fuori = {
      "Content-Type": risp.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "Access-Control-Allow-Origin": "*"
    };
    ["content-length", "content-range"].forEach((k) => {
      const v = risp.headers.get(k); if (v) fuori[k === "content-length" ? "Content-Length" : "Content-Range"] = v;
    });
    res.writeHead(risp.status, fuori);
    if (!risp.body) { res.end(); return; }
    // si ripassa a pezzi, senza tenere niente in memoria: una partita da
    // sette giga non entra in un buffer e non deve entrarci
    const lettore = risp.body.getReader();
    const passa = () => lettore.read().then(({ done, value }) => {
      if (done) { res.end(); return; }
      if (!res.write(Buffer.from(value))) {
        res.once("drain", passa);
      } else passa();
    }).catch(() => { try { res.end(); } catch (e) {} });
    req.on("close", () => { try { lettore.cancel(); } catch (e) {} });
    passa();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502);
    res.end("magazzino non raggiungibile: " + e.message);
  }
}

function serviHttp(req, res, u) {
  if (ATTIVO && u.pathname.startsWith("/magazzino/")) { serviMagazzino(req, res, u); return true; }
  if (!ATTIVO || !u.pathname.startsWith("/clip/")) return false;
  const pezzi = decodeURIComponent(u.pathname.slice(6)).split("/").filter(Boolean);
  if (!pezzi.length || pezzi.length > 3 || pezzi.some((x) => !/^[A-Za-z0-9._-]+$/.test(x) || x.startsWith("."))) {
    res.writeHead(404).end("non trovato"); return true;
  }
  const est = path.extname(pezzi[pezzi.length - 1]).toLowerCase();
  if (!TIPI[est]) { res.writeHead(404).end("non trovato"); return true; }
  const file = path.join(DIR, pezzi.join(path.sep));
  if (!file.startsWith(DIR + path.sep)) { res.writeHead(404).end("non trovato"); return true; }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
    const base = {
      "Content-Type": TIPI[est],
      "Accept-Ranges": "bytes",
      // la playlist cresce: metterla in cache vorrebbe dire un DVR fermo
      // il fotogramma vivo cambia ogni pochi secondi: in cache sarebbe fermo
      "Cache-Control": (est === ".m3u8" || /vivo\.jpg$/.test(file)) ? "no-store" : "public, max-age=86400",
      "Access-Control-Allow-Origin": "*"
    };
    if (u.searchParams.get("scarica")) {
      // Un file che si chiama "cmto1k971pzmb.mp4" sul computer di chi lo
      // riceve non vuol dire niente. Si scarica col nome della partita e
      // dell'azione, che e' l'altra meta' del problema che risolve lo sting.
      let nome = pezzi[pezzi.length - 1];
      const idc = /^([A-Za-z0-9-]+?)(?:_(16x9|3x4|9x16))?\.(mp4|xml)$/.exec(nome);
      const idSeq = idc ? (R.seq[idc[1]] ? idc[1] : (pezzi.length > 1 && R.seq[pezzi[pezzi.length - 2]] ? pezzi[pezzi.length - 2] : null)) : null;
      if (idc && idc[3] === "mp4" && R.clip[idc[1]]) nome = nomeScarico(R.clip[idc[1]], R.reg[R.clip[idc[1]].reg]);
      else if (idc && idSeq) {
        const q = R.seq[idSeq];
        nome = nomeScaricoSeq(q, R.reg[q.reg], idc[2] ? idc[2].replace("x", ":") : (idc[3] === "mp4" ? "16:9" : ""), "." + idc[3]);
      } else if (nome === "integrale.mp4" && pezzi.length > 1 && R.reg[pezzi[0]]) {
        nome = R.reg[pezzi[0]].titolo.replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "-") + "_integrale.mp4";
      }
      base["Content-Disposition"] = 'attachment; filename="' + nome + '"';
    }
    const range = req.headers.range;
    if (range && est !== ".m3u8") {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let a = m && m[1] ? parseInt(m[1], 10) : 0;
      let b = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(a) || a < 0) a = 0;
      if (isNaN(b) || b >= st.size) b = st.size - 1;
      if (a > b) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, Object.assign({}, base, {
        "Content-Range": "bytes " + a + "-" + b + "/" + st.size,
        "Content-Length": (b - a + 1)
      }));
      return fs.createReadStream(file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, Object.assign({}, base, { "Content-Length": st.size }));
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

// ── quanto spazio occupa tutto questo ─────────────────────────────────

function peso(dir) {
  let tot = 0;
  try {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((v) => {
      const p = path.join(dir, v.name);
      if (v.isDirectory()) tot += peso(p);
      else { try { tot += fs.statSync(p).size; } catch (e) {} }
    });
  } catch (e) {}
  return tot;
}


// ══════════════════════════════════════════════════════════════════════
//  CERCARE
// ══════════════════════════════════════════════════════════════════════
//
//  Non un linguaggio da imparare: si scrive come si parla. «Genoa-Como del
//  4 settembre», «gol di Diao», «le verticali di settembre». Chi cerca in
//  redazione non sa — e non deve sapere — come si chiama un campo.
//
//  Si cerca in tre posti insieme, perche' sono tre domande diverse:
//    partite  — «dov'e' quella partita»
//    clip     — «dov'e' quel pezzo che avevamo tagliato»
//    segni    — «dov'e' quell'azione», ed e' la piu' preziosa: sono i
//               marker di ESPN, degli appunti e quelli messi a mano, cioe'
//               il minuto per minuto che oggi muore dentro una cella.
//
//  Tutte le parole devono trovarsi (e non "una qualsiasi"): chi scrive due
//  parole sta restringendo, non allargando.

const MESI_N = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio",
                "agosto","settembre","ottobre","novembre","dicembre"];
const GIORNI_N = ["domenica","lunedi","martedi","mercoledi","giovedi","venerdi","sabato"];

function senzaAccenti(t) {
  return String(t || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
// Il testo su cui si cerca: tutto quello che di quella cosa qualcuno
// potrebbe ricordare, scritto in tutti i modi in cui potrebbe scriverlo.
function comeSiCerca(pezzi) {
  return senzaAccenti(pezzi.filter(Boolean).join(" ")).replace(/[^a-z0-9:\/\s'-]/g, " ");
}
function dataScritta(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const gg = d.getDate(), mm = d.getMonth() + 1;
  return [GIORNI_N[d.getDay()], gg + " " + MESI_N[d.getMonth()], gg + "/" + mm,
          ("0" + gg).slice(-2) + "/" + ("0" + mm).slice(-2), d.getFullYear()].join(" ");
}

const FORMATI_DETTI = { "verticale": "9:16", "verticali": "9:16", "story": "9:16", "quadrato": "1:1", "quadrati": "1:1",
  "orizzontale": "16:9", "orizzontali": "16:9", "feed": "3:4", "quadrotto": "3:4", "quadrata": "3:4" };
const GENERI_DETTI = { "clip": "clip", "clips": "clip", "integrale": "integrale",
  "integrali": "integrale", "hl": "hl", "highlight": "hl", "highlights": "hl",
  "sequenza": "hl", "partita": "partita", "partite": "partita", "segno": "segno",
  "segni": "segno", "marker": "segno" };

function leggiDomanda(q) {
  const parole = senzaAccenti(q).split(/\s+/).filter(Boolean);
  const fuori = { parole: [], formato: "", genere: "", quando: null };
  const salta = { "del": 1, "della": 1, "di": 1, "il": 1, "lo": 1, "la": 1, "le": 1,
                  "i": 1, "gli": 1, "un": 1, "una": 1, "con": 1, "in": 1, "a": 1, "da": 1 };
  let giorno = 0, mese = -1, anno = 0;
  parole.forEach((p) => {
    if (/^(9:16|16:9|3:4|1:1)$/.test(p)) { fuori.formato = p; return; }
    if (FORMATI_DETTI[p]) { fuori.formato = FORMATI_DETTI[p]; return; }
    if (GENERI_DETTI[p]) { fuori.genere = GENERI_DETTI[p]; return; }
    if (p === "oggi" || p === "ieri") {
      const d = new Date(); if (p === "ieri") d.setDate(d.getDate() - 1);
      giorno = d.getDate(); mese = d.getMonth(); anno = d.getFullYear(); return;
    }
    const im = MESI_N.indexOf(p);
    if (im >= 0) { mese = im; return; }
    if (/^\d{1,2}$/.test(p) && +p >= 1 && +p <= 31) { giorno = +p; return; }
    if (/^\d{4}$/.test(p)) { anno = +p; return; }
    const dm = /^(\d{1,2})[\/-](\d{1,2})$/.exec(p);
    if (dm) { giorno = +dm[1]; mese = +dm[2] - 1; return; }
    if (salta[p] || p.length < 2) return;
    fuori.parole.push(p);
  });
  if (mese >= 0 || giorno) fuori.quando = { giorno: giorno, mese: mese, anno: anno };
  return fuori;
}

function quandoTorna(ms, q) {
  if (!q.quando || !ms) return true;
  const d = new Date(ms);
  if (q.quando.mese >= 0 && d.getMonth() !== q.quando.mese) return false;
  if (q.quando.giorno && d.getDate() !== q.quando.giorno) return false;
  if (q.quando.anno && d.getFullYear() !== q.quando.anno) return false;
  return true;
}
function tutteDentro(testo, parole) {
  return parole.every((p) => testo.indexOf(p) >= 0);
}

async function clipCerca(p) {
  const q = leggiDomanda(String(p.q || ""));
  const limite = num(p.limite, 1, 200, 40);
  if (!q.parole.length && !q.quando && !q.formato && !q.genere) {
    return { ok: true, vuota: true, partite: [], clip: [], segni: [] };
  }

  // il testo di una registrazione vale anche per le sue clip e i suoi segni:
  // «il gol di Diao in Genoa-Como» e' una frase sola, non due ricerche
  const testoReg = {};
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    testoReg[k] = comeSiCerca([r.titolo, r.competizione, r.sorgente, dataScritta(r.avviata)]);
  });

  const partite = [], clip = [], segni = [];

  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (q.genere && q.genere !== "partita" && q.genere !== "integrale") return;
    if (q.genere === "integrale" && r.integrale !== "pronto") return;
    if (!quandoTorna(r.avviata, q)) return;
    if (!tutteDentro(testoReg[k], q.parole)) return;
    partite.push(Object.assign({}, pubblica(r), { marker: undefined, quanteClip:
      Object.keys(R.clip).filter((c) => R.clip[c].reg === k).length }));
  });

  Object.keys(R.clip).forEach((k) => {
    const c = R.clip[k];
    if (q.genere && q.genere !== "clip") return;
    if (q.formato && c.formato !== q.formato) return;
    const r = R.reg[c.reg];
    if (!quandoTorna(c.creata || (r && r.avviata), q)) return;
    const testo = comeSiCerca([c.titolo, c.tipo, c.minuto, c.chi, c.formato,
                               testoReg[c.reg] || ""]);
    if (!tutteDentro(testo, q.parole)) return;
    clip.push(Object.assign({}, c, { partita: r ? r.titolo : "" }));
  });

  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (q.genere && q.genere !== "segno") return;
    if (q.formato) return;                       // un segno non ha formato
    if (!quandoTorna(r.avviata, q)) return;
    (r.marker || []).forEach((m) => {
      const testo = comeSiCerca([m.testo, m.tipo, m.fonte, m.chi, testoReg[k]]);
      if (!tutteDentro(testo, q.parole)) return;
      segni.push({ id: m.id, reg: k, partita: r.titolo, competizione: r.competizione,
                   secondi: m.secondi, testo: m.testo, tipo: m.tipo, fonte: m.fonte,
                   quando: r.avviata });
    });
  });

  // I segni delle sequenze: un pezzo di highlight e' anche lui un'azione
  Object.keys(R.seq).forEach((k) => {
    const s = R.seq[k];
    if (q.genere && q.genere !== "hl") return;
    const r = R.reg[s.reg];
    if (!quandoTorna(s.creata, q)) return;
    const testo = comeSiCerca([s.titolo, testoReg[s.reg] || ""]);
    if (!tutteDentro(testo, q.parole)) return;
    clip.push({ id: s.id, seq: true, reg: s.reg, titolo: s.titolo, formato: "16:9",
                durata: Math.round(s.pezzi.reduce((a, x) => a + (x.fuori - x.dentro), 0)),
                stato: "pronta", pezzi: s.pezzi.length, creata: s.creata,
                partita: r ? r.titolo : "" });
  });

  partite.sort((a, b) => b.avviata - a.avviata);
  clip.sort((a, b) => (b.creata || 0) - (a.creata || 0));
  segni.sort((a, b) => (b.quando || 0) - (a.quando || 0));

  // il quarto fronte: le azioni scritte dai giornalisti nelle partite
  // passate, anche quelle di cui qui non c'e' un fotogramma
  const azioni = (q.genere && q.genere !== "segno") ? []
    : (q.parole.length || q.quando ? cercaNegliAppunti(q, limite) : []);

  // il quinto fronte: quello che e' stato detto a voce
  const dette = q.parole.length ? cercaNelParlato(q, limite) : [];
  // il sesto: le partite dell'archivio, per nome
  const archivio = (q.genere && q.genere !== "partita") ? [] : cercaNellArchivio(q, limite);

  // il settimo fronte: quello che VUOL DIRE la stessa cosa, anche se le
  // parole sono altre. Si tolgono le righe che la ricerca per lettere ha
  // gia' trovato: dire due volte la stessa riga non e' un risultato in piu'.
  let vicini = [];
  if (q.parole.length && SIGN.pronto && p.vicini !== false) {
    try {
      const gia = new Set(azioni.map((x) => x.rec + "|" + x.tempo + "|" + Math.round(x.d || 0))
                    .concat(dette.map((x) => x.reg + "|v|" + Math.round(x.secondi || 0))));
      // pochi e buoni: e' un "forse cercavi", non una seconda ricerca
      vicini = (await cercaPerSignificato(String(p.q || ""), 12))
        .filter((x) => !gia.has(x.fonte === "voce" ? (x.reg + "|v|" + Math.round(x.secondi || 0))
                                                   : (x.rec + "|" + x.tempo + "|" + Math.round(x.d || 0))));
    } catch (e) { console.log("[clip] significato in ricerca: " + e.message); }
  }

  return {
    ok: true,
    domanda: { parole: q.parole, formato: q.formato, genere: q.genere, quando: q.quando },
    quante: partite.length + clip.length + segni.length + azioni.length + dette.length + archivio.length + vicini.length,
    azioni: azioni, dette: dette, archivio: archivio, vicini: vicini,
    partite: partite.slice(0, limite),
    clip: clip.slice(0, limite),
    segni: segni.slice(0, limite)
  };
}


// ══════════════════════════════════════════════════════════════════════
//  LA GRAFICA ADDOSSO ALLA CLIP
// ══════════════════════════════════════════════════════════════════════
//
//  Il generatore la grafica la sa disegnare — font, maschere, dati della
//  partita, e le modifiche fatte a mano da chi la sta preparando. Quello
//  che non sa fare bene e' incollarla su un video: registra il canvas in
//  tempo reale, quindi dipende da dove hai il mouse, dalla finestra in
//  primo piano, dal browser. Sei secondi di clip, sei secondi di attesa, e
//  se la finestra passa dietro esce un'immagine ferma.
//
//  Quindi si dividono i compiti: il generatore manda qui il suo strato
//  trasparente (un PNG), il ponte lo incolla con ffmpeg. Nessuna finestra
//  da tenere davanti, un secondo invece di sei, e funziona anche a
//  portatile chiuso.
//
//  L'inquadratura arriva insieme al PNG: sono gli stessi numeri con cui il
//  generatore mostra la foto (spostamento e zoom), riprodotti qui con
//  scale+crop. Se non arrivano, si fa quello che fa lui di suo: riempire
//  il riquadro dal centro.

function clipGrafica(p) {
  const c = R.clip[p.clip];
  if (!c) throw new Error("clip sconosciuta");
  if (c.stato !== "pronta") throw new Error("la clip non e' ancora pronta");
  const dati = String(p.png || "");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dati.replace(/\s/g, ""));
  if (!m) throw new Error("la grafica non e' arrivata come PNG");
  const png = Buffer.from(m[1], "base64");
  if (png.length > 12 * 1024 * 1024) throw new Error("grafica troppo pesante");

  const W = Math.round(num(p.w, 16, 4096, 1080));
  const H = Math.round(num(p.h, 16, 4096, 1920));
  const inq = p.inquadratura || {};
  const dx = num(inq.dx, -9999, 9999, 0), dy = num(inq.dy, -9999, 9999, 0);
  const zoom = num(inq.s, 0.1, 8, 1);
  const cx = num(inq.cx, -9999, 9999, 0), cy = num(inq.cy, -9999, 9999, 0);

  const nuova = {
    id: nuovoId("c"),
    reg: c.reg, evento: c.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (c.titolo + " · con grafica"),
    dentro: c.dentro, fuori: c.fuori, durata: c.durata,
    formato: W > H ? "16:9" : (Math.abs(W / H - 3 / 4) < 0.05 ? "3:4" : "9:16"),
    preciso: true, grafica: true, daClip: c.id,
    tipo: c.tipo || "", minuto: c.minuto || "",
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    creata: Date.now(), stato: "lavora", peso: 0
  };
  R.clip[nuova.id] = nuova;
  scrivi();

  const strato = path.join(DIR, CARTELLA_CLIP, nuova.id + ".png");
  fs.writeFileSync(strato, png);
  const dentroFile = fileClip(c.id);

  // Le misure vere della clip servono per riprodurre l'inquadratura: si
  // chiedono al file invece di fidarsi di quello che dice la pagina.
  probeMisure(dentroFile).then((mis) => {
    const sw = mis.w || 1920, sh = mis.h || 1080;
    const cov = Math.max(W / sw, H / sh);
    const scala = cov * zoom;
    const lw = Math.max(2, Math.round(sw * scala)), lh = Math.max(2, Math.round(sh * scala));
    // dove finisce l'angolo in alto a sinistra dell'immagine, con lo stesso
    // conto che fa il generatore sul canvas
    const x0 = dx + cx + zoom * ((W - sw * cov) / 2 - cx);
    const y0 = dy + cy + zoom * ((H - sh * cov) / 2 - cy);
    const cropX = Math.min(Math.max(0, Math.round(-x0)), Math.max(0, lw - W));
    const cropY = Math.min(Math.max(0, Math.round(-y0)), Math.max(0, lh - H));

    const filtro = "[0:v]scale=" + lw + ":" + lh + ",crop=" + W + ":" + H + ":" + cropX + ":" + cropY +
                   ",setsar=1[v0];[v0][1:v]overlay=0:0:format=auto[v]";
    const fuoriFile = fileClip(nuova.id);
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", dentroFile, "-i", strato,
      "-filter_complex", filtro, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", fuoriFile];

    const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let coda = "";
    pr.stderr.on("data", (d) => { coda = (coda + d).slice(-2000); });
    pr.on("error", (e) => { nuova.stato = "errore"; nuova.errore = e.message; scrivi(); });
    pr.on("close", async (code) => {
      try { fs.unlinkSync(strato); } catch (e) {}
      if (code === 0) {
        const d = await probe(fuoriFile);
        nuova.stato = "pronta"; nuova.peso = d.peso || 0;
        if (d.durata) nuova.durataVera = Math.round(d.durata * 100) / 100;
        nuova.mini = await miniatura(fuoriFile, path.join(DIR, CARTELLA_CLIP, nuova.id + ".jpg"),
                                     (d.durata || 3) / 3)
          ? "/clip/" + CARTELLA_CLIP + "/" + nuova.id + ".jpg" : "";
      } else {
        nuova.stato = "errore";
        nuova.errore = ultimaRiga(coda) || ("ffmpeg e' uscito con " + code);
      }
      scrivi(); annuncia(0, "clip");
    });
  }).catch((e) => { nuova.stato = "errore"; nuova.errore = e.message; scrivi(); });

  return { ok: true, clip: nuova };
}

// ── LA GRAFICA SU UN MONTATO ──────────────────────────────────────────
//  Finora il generatore sapeva vestire solo una CLIP: una cosa sola, un
//  taglio solo. Ma quello che si pubblica e' il montato — i gol, gli
//  highlights — e su quello non c'era strada. Qui e' anche piu' semplice:
//  l'uscita ha gia' la forma giusta (se e' 9:16 e' 9:16), quindi la
//  maschera si posa sopra e basta, senza reinquadrare niente.
// ══════════════════════════════════════════════════════════════════════
//  IL LIVELLO DELLE GRAFICHE (V2)
// ══════════════════════════════════════════════════════════════════════
//
//  Una grafica non e' un'altra esportazione: e' un pezzo della sequenza,
//  come una clip, solo che sta sopra. Vive nel TEMPO DELLA SEQUENZA (non
//  del materiale), quindi puo' stare a cavallo di due tagli, e si vede
//  nel Programma prima di esportare — che e' l'unico modo per accorgersi
//  che copre la faccia di qualcuno.
//
//  Il PNG arriva dal generatore e resta un file: in memoria un montato con
//  dieci grafiche sarebbe venti mega di base64 dentro il registro.
function cartellaGrafiche() {
  const d = path.join(DIR, CARTELLA_HL, "_grafiche");
  assicura(d);
  return d;
}

function hlGrafica(p) {
  const q = seqMia(p);
  q.grafiche = q.grafiche || [];
  const durataSeq = q.pezzi.reduce((n, x) => n + (x.fuori - x.dentro), 0);

  if (p.togli) {
    const prima = q.grafiche.length;
    q.grafiche = q.grafiche.filter((g) => {
      if (g.id !== p.grafica) return true;
      try { fs.unlinkSync(path.join(cartellaGrafiche(), g.id + ".png")); } catch (e) {}
      return false;
    });
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, tolte: prima - q.grafiche.length };
  }

  if (p.grafica && p.dividi !== undefined) {        // la lametta
    const g = q.grafiche.filter((x) => x.id === p.grafica)[0];
    if (!g) throw new Error("grafica sconosciuta");
    const dove = num(p.dividi, 0, durataSeq, 0);
    if (!(dove > g.dentro + 0.3 && dove < g.fuori - 0.3)) throw new Error("il taglio cadrebbe sul bordo");
    // il PNG si COPIA: due grafiche che puntano allo stesso file si
    // porterebbero via l'immagine a vicenda quando una viene cancellata
    const id2 = nuovoId("g");
    try {
      fs.copyFileSync(path.join(cartellaGrafiche(), g.id + ".png"),
                      path.join(cartellaGrafiche(), id2 + ".png"));
    } catch (e) { throw new Error("non sono riuscito a copiare la grafica"); }
    const g2 = Object.assign({}, g, { id: id2, dentro: dove,
      file: "/clip/" + CARTELLA_HL + "/_grafiche/" + id2 + ".png", quando: Date.now() });
    g.fuori = dove;
    q.grafiche.push(g2);
    q.grafiche.sort((a, b) => a.dentro - b.dentro);
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, grafica: g2 };
  }

  if (p.grafica) {                                  // spostare o allungare
    const g = q.grafiche.filter((x) => x.id === p.grafica)[0];
    if (!g) throw new Error("grafica sconosciuta");
    if (p.dentro !== undefined) g.dentro = num(p.dentro, 0, durataSeq, g.dentro);
    if (p.fuori !== undefined) g.fuori = num(p.fuori, 0, durataSeq, g.fuori);
    if (p.nome !== undefined) g.nome = String(p.nome).slice(0, 120);
    if (g.fuori - g.dentro < 0.4) throw new Error("la grafica diventerebbe un lampo");
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q };
  }

  // nuova: arriva il PNG dal generatore
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p.png || "").replace(/\s/g, ""));
  if (!m) throw new Error("la grafica non e' arrivata come PNG");
  const dati = Buffer.from(m[1], "base64");
  if (dati.length > 12 * 1024 * 1024) throw new Error("grafica troppo pesante");
  const id = nuovoId("g");
  fs.writeFileSync(path.join(cartellaGrafiche(), id + ".png"), dati);
  const dentro = num(p.dentro, 0, Math.max(0, durataSeq), 0);
  const dur = num(p.durata, 0.5, 600, 5);
  const g = { id: id, dentro: dentro, fuori: Math.min(durataSeq || dentro + dur, dentro + dur),
              nome: String(p.nome || "grafica").slice(0, 120),
              w: Math.round(num(p.w, 16, 4096, 1080)), h: Math.round(num(p.h, 16, 4096, 1920)),
              file: "/clip/" + CARTELLA_HL + "/_grafiche/" + id + ".png", quando: Date.now() };
  if (g.fuori - g.dentro < 0.5) g.fuori = g.dentro + dur;
  q.grafiche.push(g);
  q.grafiche.sort((a, b) => a.dentro - b.dentro);
  toccataAMano(q); scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, grafica: g };
}

function graficaSuUscita(p) {
  const q = R.seq[String(p.seq || "")];
  if (!q) throw new Error("sequenza sconosciuta");
  const nome = String(p.file || "").replace(/[^A-Za-z0-9_.-]/g, "");
  const dentroFile = path.join(DIR, CARTELLA_HL, nome);
  if (!nome || !fs.existsSync(dentroFile)) throw new Error("questo video esportato non c'e' piu': rifai l'esportazione");
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(p.png || "").replace(/\s/g, ""));
  if (!m) throw new Error("la grafica non e' arrivata come PNG");
  const png = Buffer.from(m[1], "base64");
  if (png.length > 12 * 1024 * 1024) throw new Error("grafica troppo pesante");

  const fuoriNome = nome.replace(/\.mp4$/i, "") + "-grafica.mp4";
  const fuoriFile = path.join(DIR, CARTELLA_HL, fuoriNome);
  const strato = path.join(os.tmpdir(), "grafica-" + nuovoId("") + ".png");
  fs.writeFileSync(strato, png);

  q.grafica = { stato: "lavora", da: nome, file: "" };
  scrivi(); annuncia(0, "clip");

  // Le misure si CONTANO qui, non dentro ffmpeg: main_w e main_h esistono
  // solo dentro overlay, e provare a usarle in scale faceva uscire ffmpeg
  // con "Invalid argument" prima ancora di leggere il file.
  (async () => {
    const v = await probeMisure(dentroFile);
    const m2 = await probeMisure(strato);
    const VW = v.w || 1080, VH = v.h || 1920;
    const MW = m2.w || VW, MH = m2.h || VH;
    const k = Math.min(VW / MW, VH / MH);            // la maschera entra intera, senza deformarsi
    const w2 = Math.max(2, Math.round(MW * k / 2) * 2), h2 = Math.max(2, Math.round(MH * k / 2) * 2);
    const x = Math.round((VW - w2) / 2), y = Math.round((VH - h2) / 2);
    const filtro = "[1:v]scale=" + w2 + ":" + h2 + "[g];[0:v][g]overlay=" + x + ":" + y + ":format=auto[v]";
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-i", dentroFile, "-i", strato,
      "-filter_complex", filtro, "-map", "[v]", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", fuoriFile];
    const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
    let coda = "";
    pr.stderr.on("data", (d) => { coda = (coda + d).slice(-2000); });
    pr.on("error", (e) => { q.grafica = { stato: "errore", errore: e.message }; scrivi(); annuncia(0, "clip"); });
    pr.on("close", async (code) => {
      try { fs.unlinkSync(strato); } catch (e) {}
      if (code === 0) {
        const d = await probe(fuoriFile);
        q.grafica = { stato: "pronto", da: nome, file: "/clip/" + CARTELLA_HL + "/" + fuoriNome,
                      peso: d.peso || 0, durata: d.durata || 0, quando: Date.now() };
        console.log("[clip] grafica su " + nome + " (" + VW + "x" + VH + ") → " + fuoriNome);
      } else {
        q.grafica = { stato: "errore", errore: ultimaRiga(coda) || ("ffmpeg e' uscito con " + code) };
      }
      scrivi(); annuncia(0, "clip");
    });
  })().catch((e) => { q.grafica = { stato: "errore", errore: e.message }; scrivi(); annuncia(0, "clip"); });
  return { ok: true, grafica: q.grafica };
}

function probeMisure(file) {
  return new Promise((si) => {
    execFile(FFPROBE, ["-v", "error", "-select_streams", "v:0",
                       "-show_entries", "stream=width,height",
                       "-of", "csv=p=0", file], { timeout: 20000 }, (err, out) => {
      if (err) return si({});
      const p = String(out).trim().split(",");
      si({ w: parseInt(p[0], 10) || 0, h: parseInt(p[1], 10) || 0 });
    });
  });
}


// ══════════════════════════════════════════════════════════════════════
//  CONTENUTI CARICATI A MANO
// ══════════════════════════════════════════════════════════════════════
//
//  Non tutto quello che serve nasce da un SRT. Un montato che torna dal
//  NAS, un contributo girato con il telefono, un vecchio integrale: sono
//  materiale come gli altri e devono stare nello stesso posto, altrimenti
//  l'archivio diventa due archivi.
//
//  Un file caricato diventa una REGISTRAZIONE come le altre, con
//  l'integrale gia' pronto al posto dei segmenti. Non e' un trucco: una
//  registrazione e' "materiale con una linea del tempo", e un file lo e'
//  esattamente quanto un flusso. Cosi' taglio, highlights, ricerca,
//  miniature e grafica funzionano gia' tutti, senza una riga in piu'.

const MAX_CARICO = parseInt(process.env.COMOTV_CLIP_MAX_FILE || "2000", 10) * 1024 * 1024;
const CARICHI_MAM = new Map();

function caricaInizia(p) {
  const gb = liberiGB();
  if (gb < MIN_GB) throw new Error("sul disco restano " + gb.toFixed(1) + " GB: troppo pochi");
  const peso = num(p.peso, 1, MAX_CARICO, 0);
  if (!peso) throw new Error("file troppo grande: al massimo " + Math.round(MAX_CARICO / 1e6) + " MB");

  const r = {
    id: nuovoId("r"),
    evento: String(p.evento || "").slice(0, 64),
    titolo: String(p.titolo || "").slice(0, 160) || "contenuto",
    competizione: String(p.competizione || "").slice(0, 80),
    sorgente: "caricato",
    origine: "file",
    url: "",
    stato: "carica",
    avviata: Date.now(), finita: 0, durata: 0,
    kickoff: {}, marker: [],
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    errore: ""
  };
  assicura(cartellaReg(r.id));
  R.reg[r.id] = r;
  CARICHI_MAM.set(r.id, {
    via: path.join(cartellaReg(r.id), "integrale.mp4"),
    scritti: 0, peso: peso, quando: Date.now()
  });
  scrivi();
  return { ok: true, id: r.id, reg: pubblica(r) };
}

function caricaPezzo(p) {
  const c = CARICHI_MAM.get(p.id);
  if (!c) throw new Error("caricamento sconosciuto (o scaduto)");
  const dati = Buffer.from(String(p.pezzo || ""), "base64");
  if (!dati.length) throw new Error("pezzo vuoto");
  if (c.scritti + dati.length > c.peso + 1024) throw new Error("il file e' piu' lungo di quanto dichiarato");
  fs.appendFileSync(c.via, dati);
  c.scritti += dati.length;
  return { ok: true, scritti: c.scritti, quanto: Math.round(c.scritti / c.peso * 100) };
}

async function caricaFine(p) {
  const c = CARICHI_MAM.get(p.id);
  const r = R.reg[p.id];
  if (!c || !r) throw new Error("caricamento sconosciuto");
  CARICHI_MAM.delete(p.id);

  const d = await probe(c.via);
  if (!d.durata) {
    try { fs.rmSync(cartellaReg(r.id), { recursive: true, force: true }); } catch (e) {}
    delete R.reg[r.id]; scrivi();
    throw new Error("questo file non e' un video che so leggere");
  }
  r.stato = "ferma";
  r.finita = Date.now();
  r.durata = Math.round(d.durata * 10) / 10;
  r.integrale = "pronto";
  r.integraleDurata = r.durata;
  r.integralePeso = d.peso || c.scritti;
  r.mini = await miniatura(c.via, path.join(cartellaReg(r.id), "mini.jpg"), r.durata / 3)
    ? "/clip/" + r.id + "/mini.jpg" : "";
  scrivi(); annuncia(0, "clip");
  return { ok: true, reg: pubblica(r) };
}

// La miniatura di una registrazione che sta ancora andando: si prende dal
// materiale gia' scritto, cosi' la colonna dei contenuti non e' una lista di
// riquadri vuoti mentre la partita e' in corso.
async function miniaturaViva(r) {
  if (r.mini || r.miniInCorso) return;
  r.miniInCorso = true;
  let da = "", quando = 0.5;
  const integrale = path.join(cartellaReg(r.id), "integrale.mp4");
  const segs = segmenti(r.id);
  if (segs.length >= 4) {
    // dal mezzo di quello che c'e': l'inizio di una registrazione e' spesso
    // il cartello o il campo vuoto prima del fischio
    da = segs[Math.floor(segs.length / 2)].file;
  } else if (fs.existsSync(integrale)) {
    da = integrale; quando = Math.max(1, (r.durata || 6) / 3);
  } else if (r.arch) {
    // una partita d'archivio la faccia ce l'ha, sta solo a Parigi: si va a
    // prendere un fotogramma dieci minuti dopo il fischio, che e' gioco
    // sicuro e non il cartello del prepartita
    da = viaArchivio(r, ((r.kickoff && r.kickoff["1"]) || 300) + 600);
    // dieci minuti dopo il fischio VERO, se il cronometro e' stato letto:
    // l'inizio della registrazione e' il "coming soon", non la partita
    const f0 = fonteAl(r, ((r.kickoff && r.kickoff["1"]) || 300) + 600);
    quando = f0.dentro;
  }
  if (!da) { r.miniInCorso = false; return; }
  const ok = await miniatura(da, path.join(cartellaReg(r.id), "mini.jpg"), quando);
  r.mini = ok ? "/clip/" + r.id + "/mini.jpg" : "";
  r.miniInCorso = false;
  scrivi();
}


// ══════════════════════════════════════════════════════════════════════
//  IL GIRO AUTOMATICO — mentre la partita va
// ══════════════════════════════════════════════════════════════════════
//
//  Finora i segni li metteva una persona e gli highlights nascevano quando
//  qualcuno premeva un tasto. Ma il valore vero e' un altro: che venti
//  secondi dopo il gol la clip del gol ESISTA GIA', senza che nessuno
//  l'abbia chiesta. Il social apre il MAM e la trova.
//
//  Ogni minuto, per ogni registrazione agganciata a una partita, si chiede
//  a ESPN che cosa e' successo. Gli eventi nuovi diventano segni; quelli
//  che contano — gol, rigori, rossi — diventano anche una clip tagliata.
//
//  Due prudenze. La prima: si taglia solo cio' che e' gia' stato scritto
//  su disco, mai oltre il bordo. La seconda: un evento si mette una volta
//  sola, e il conto di quelli gia' visti sta nella registrazione, quindi
//  sopravvive a un riavvio del ponte.

const GIRO_ESPN = parseInt(process.env.COMOTV_CLIP_GIRO || "60", 10) * 1000;
// che cosa merita di essere gia' tagliato: "gol" (di suo), "tutto", "no"
const PRETAGLIO = String(process.env.COMOTV_CLIP_PRETAGLIO || "gol").toLowerCase();

function meritaTaglio(tipo) {
  if (PRETAGLIO === "no") return false;
  if (PRETAGLIO === "tutto") return true;
  const t = senzaAccenti(tipo || "");
  return /goal|gol|penalty|rigore|own/.test(t) || /red card|rosso/.test(t);
}

async function giroEspn() {
  const vive = Object.keys(R.reg).map((k) => R.reg[k])
    .filter((r) => r.stato === "registra" && r.evento && !r.guarda);
  for (const r of vive) {
    let eventi = [];
    try { eventi = await espnEventi(r.evento); } catch (e) { continue; }
    if (!eventi.length) continue;
    r.espnVisti = r.espnVisti || [];
    const durata = durataRegistrata(r.id);
    let nuovi = 0;

    for (const e of eventi) {
      if (r.espnVisti.indexOf(e.id) >= 0) continue;
      // dove cade: sul vivo l'orologio, altrimenti i minuti dal fischio
      let s = secondiDaOra(r.id, e.ora);
      if (s === null || s < 0 || s > durata) {
        const m = /(\d+)/.exec(String(e.minuto || ""));
        const k = (e.periodo === 2 || (m && +m[1] > 45)) ? (r.kickoff || {})["2"] : (r.kickoff || {})["1"];
        if (k === undefined || !m) continue;               // non so dove metterlo: lo lascio a dopo
        const min = +m[1];
        s = k + ((e.periodo === 2 || min > 45) ? (Math.max(46, min) - 46) : (min - 1)) * 60;
      }
      if (s < 0 || s > durata) continue;                   // fuori da quello che c'e' scritto

      r.espnVisti.push(e.id);
      nuovi++;
      r.marker = (r.marker || []).concat([{
        id: nuovoId("m"), secondi: Math.round(s * 10) / 10,
        testo: nomePezzo(e), tipo: e.tipo, fonte: "espn", chi: "", quando: Date.now()
      }]).sort((a, b) => a.secondi - b.secondi);

      // e se conta, la clip esce da sola
      if (meritaTaglio(e.tipo)) {
        const dentro = Math.max(0, s - HL_PRE);
        const fuori = Math.min(durata, s + HL_POST + 6);
        if (fuori - dentro > 3) {
          try {
            clipTaglia({ reg: r.id, dentro: dentro, fuori: fuori,
                         titolo: nomePezzo(e), tipoAzione: e.tipo, minuto: e.minuto,
                         chi: "ESPN", sting: false });
          } catch (err) { /* il taglio riprovera' al giro dopo */ }
        }
      }
    }
    if (nuovi) {
      console.log("[clip] " + r.titolo + ": " + nuovi + " eventi nuovi da ESPN");
      scrivi(); annuncia(0, "clip");
    }
  }
}

// ── l'anello ──────────────────────────────────────────────────────────
//
//  Dodici partite in una sera sono una quarantina di giga: il disco della VM
//  ne regge una serata, non due. Il materiale delle registrazioni finite se
//  ne va da solo dopo qualche giorno; restano il record, i marker e le clip
//  gia' tagliate, che pesano niente e servono ancora.

// ══════════════════════════════════════════════════════════════════════
//  LE USCITE SI CANCELLANO DA SOLE
// ══════════════════════════════════════════════════════════════════════
//
//  Un video esportato e' una COPIA: la sequenza resta, il materiale resta,
//  e rifarlo costa un minuto di macchina. Tenerlo per sempre invece costa
//  disco per sempre — e infatti sette file avevano preso dieci giga, uno
//  solo da 8,2, su un disco che ne ha cinquanta liberi. Nessuno li
//  cancellava perche' nessuno sapeva che c'erano.
//
//  Quindi scadono: dopo una settimana l'uscita se ne va e resta la
//  sequenza, che e' quello che serve per rifarla. Gli avanzi senza piu'
//  padrone (la sequenza cancellata, l'export interrotto) se ne vanno dopo
//  un giorno. E se il disco scende sotto la soglia si comincia dalle piu'
//  vecchie, senza aspettare la scadenza.
const GIORNI_USCITE = parseFloat(process.env.COMOTV_USCITE_GIORNI || "7");
const DISCO_MINIMO = parseFloat(process.env.COMOTV_DISCO_MINIMO || "12");   // giga liberi sotto i quali si fa spazio

function pesoDiUnPezzo(via) {
  try {
    const st = fs.statSync(via);
    if (!st.isDirectory()) return { peso: st.size, quando: st.mtimeMs };
    let tot = 0, ultimo = st.mtimeMs;
    for (const n of fs.readdirSync(via)) {
      const q = pesoDiUnPezzo(path.join(via, n));
      tot += q.peso; ultimo = Math.max(ultimo, q.quando);
    }
    return { peso: tot, quando: ultimo };
  } catch (e) { return { peso: 0, quando: 0 }; }
}

// Tutto quello che sta nelle cartelle delle uscite, con l'eta' e il padrone.
function uscite() {
  const fuori = [];
  // le grafiche del livello V2 non sono uscite: sono PARTE della sequenza.
  // Si guardano una per una, e il padrone e' la sequenza che le usa —
  // trattare la cartella come un avanzo vorrebbe dire cancellarle tutte
  // insieme al primo giro di pulizia.
  const graficheVive = {};
  Object.keys(R.seq).forEach((k) => {
    (R.seq[k].grafiche || []).forEach((g) => { graficheVive[g.id] = k; });
  });
  const guarda = (cartella, chi) => {
    const dove = path.join(DIR, cartella);
    let nomi = [];
    try { nomi = fs.readdirSync(dove); } catch (e) { return; }
    nomi.forEach((n) => {
      const via = path.join(dove, n);
      if (chi === "seq" && n === "_pezzi") {
        // i pezzi in casa: il padrone e' la sequenza che li usa. Cancellarli
        // non perde niente (si riscaricano), ma non si butta la cartella
        // intera mentre qualcuno sta montando.
        const vivi = {};
        Object.keys(R.seq).forEach((k2) => {
          (R.seq[k2].pezzi || []).forEach((x) => { vivi[chiavePezzo(R.seq[k2].reg, x.dentro, x.fuori)] = true; });
        });
        let dentro2 = [];
        try { dentro2 = fs.readdirSync(via); } catch (e) { return; }
        dentro2.forEach((f) => {
          const id2 = f.replace(/\.[a-z0-9]+$/i, "");
          const q3 = pesoDiUnPezzo(path.join(via, f));
          fuori.push({ via: path.join(via, f), nome: f, id: id2, tipo: "pezzo",
                       peso: q3.peso, quando: q3.quando, orfano: !vivi[id2], alLavoro: false });
        });
        return;
      }
      if (chi === "seq" && n === "_grafiche") {
        let png = [];
        try { png = fs.readdirSync(via); } catch (e) { return; }
        png.forEach((f) => {
          const id = f.replace(/\.[a-z0-9]+$/i, "");
          const q2 = pesoDiUnPezzo(path.join(via, f));
          fuori.push({ via: path.join(via, f), nome: f, id: id, tipo: "grafica",
                       peso: q2.peso, quando: q2.quando,
                       orfano: !graficheVive[id], alLavoro: !!graficheVive[id] });
        });
        return;
      }
      const id = n.replace(/\.[a-z0-9]+$/i, "").split("_")[0];
      const q = pesoDiUnPezzo(via);
      const padrone = chi === "seq" ? R.seq[id] : R.clip[id];
      fuori.push({ via: via, nome: n, id: id, tipo: chi, peso: q.peso, quando: q.quando,
                   orfano: !padrone,
                   alLavoro: !!(padrone && ((padrone.export && padrone.export.stato === "lavora") || padrone.stato === "lavora")) });
    });
  };
  guarda(CARTELLA_HL, "seq");
  guarda(CARTELLA_CLIP, "clip");
  return fuori.sort((a, b) => a.quando - b.quando);
}

function pulisciUscite(p) {
  p = p || {};
  const prova = !!p.prova;
  const giorni = num(p.giorni, 0, 365, GIORNI_USCITE);
  const scadenza = Date.now() - giorni * 86400000;
  const scadenzaOrfani = Date.now() - Math.min(1, giorni) * 86400000;
  const tutte = uscite();
  const via = [];
  tutte.forEach((u) => {
    if (u.alLavoro) return;                                  // si sta ancora scrivendo
    const limite = u.orfano ? scadenzaOrfani : scadenza;
    if (u.quando > limite) return;
    via.push(u);
  });
  // e se il disco e' comunque stretto, si continua dalle piu' vecchie
  let liberi = liberiGB();
  const gia = {};
  via.forEach((u) => { gia[u.via] = true; });
  if (liberi < DISCO_MINIMO) {
    const stimati = via.reduce((n, u) => n + u.peso, 0) / 1e9;
    let dopo = liberi + stimati;
    for (const u of tutte) {
      if (dopo >= DISCO_MINIMO) break;
      if (gia[u.via] || u.alLavoro) continue;
      via.push(u); gia[u.via] = true; dopo += u.peso / 1e9;
    }
  }
  let tolti = 0, giga = 0;
  if (!prova) {
    via.forEach((u) => {
      try { fs.rmSync(u.via, { recursive: true, force: true }); tolti++; giga += u.peso; } catch (e) {}
      // e si toglie anche il ricordo, se no la pagina offre un link morto
      const q = u.tipo === "seq" ? R.seq[u.id] : null;
      if (q) {
        if (q.esportati) Object.keys(q.esportati).forEach((f) => {
          if (String(q.esportati[f].file || "").indexOf(u.nome) >= 0) delete q.esportati[f];
        });
        if (q.export && String(q.export.file || "").indexOf(u.nome) >= 0) q.export = null;
        if (q.premiere && String(q.premiere.file || "").indexOf(u.nome) >= 0) q.premiere = null;
      }
    });
    if (tolti) { scrivi(); annuncia(0, "clip"); console.log("[clip] uscite: tolti " + tolti + " file per " + (giga / 1e9).toFixed(1) + " GB"); }
  }
  return { ok: true, prova: prova, giorni: giorni,
           quante: tutte.length, tolte: prova ? via.length : tolti,
           giga: Math.round((prova ? via.reduce((n, u) => n + u.peso, 0) : giga) / 1e8) / 10,
           liberiPrima: Math.round(liberi * 10) / 10,
           liberiDopo: prova ? undefined : Math.round(liberiGB() * 10) / 10,
           elenco: via.slice(0, 30).map((u) => ({ nome: u.nome, giga: Math.round(u.peso / 1e8) / 10,
             giorni: Math.round((Date.now() - u.quando) / 86400000 * 10) / 10, orfano: u.orfano })) };
}

function anello() {
  const limite = Date.now() - GIORNI * 86400000;
  let tolti = 0;

  // Le registrazioni che non hanno mai ricevuto un byte non sono materiale:
  // sono ascolti aperti e richiusi, prove, tentativi. Lasciarle in elenco
  // riempie la colonna delle partite di righe da zero secondi tutte uguali,
  // e chi cerca la partita di ieri non la trova piu'. Dopo dieci minuti se
  // ne vanno da sole, con la loro cartella vuota.
  const vecchie = Date.now() - 600000;
  const archivioVecchio = Date.now() - 30 * 86400000;
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato === "registra" || r.stato === "carica" || PROC.get(r.id)) return;
    // una partita aperta dall'archivio non ha byte qui per scelta: resta un
    // mese da quando e' stata aperta (finita = apertura), e per sempre se ha clip
    if (r.arch && (r.finita || 0) > archivioVecchio) return;
    if (durataRegistrata(r.id) > 0) return;
    if (r.origine === "file" && r.integrale === "pronto") return;
    if ((r.finita || r.avviata) > vecchie) return;
    if (Object.keys(R.clip).some((c) => R.clip[c].reg === r.id)) return;
    try { fs.rmSync(cartellaReg(r.id), { recursive: true, force: true }); } catch (e) {}
    delete R.reg[r.id];
    tolti++;
  });
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato === "registra" || PROC.get(r.id)) return;
    if (!r.finita || r.finita > limite) return;
    if (!fs.existsSync(cartellaReg(r.id))) return;
    try {
      fs.rmSync(cartellaReg(r.id), { recursive: true, force: true });
      r.materialeTolto = Date.now();
      tolti++;
    } catch (e) {}
  });
  if (tolti) { scrivi(); console.log("[clip] anello: tolto il materiale di " + tolti + " registrazioni"); }
  try { pulisciUscite({}); } catch (e) { console.log("[clip] uscite: " + e.message); }
  return tolti;
}

// ── innesto nel ponte ─────────────────────────────────────────────────

const AZIONI = {
  "clip-avvia": clipAvvia,
  "clip-ferma": clipFerma,
  "clip-rinomina": clipRinomina,
  "clip-stato": clipStato,
  "clip-taglia": clipTaglia,
  "clip-marker": clipMarker,
  "clip-kickoff": clipKickoff,
  "clip-elimina": clipElimina,
  "clip-sorgenti": clipSorgenti,
  "clip-flussi-vivi": flussiVivi,
  "clip-boati": cercaBoati,
  "clip-significato": (p) => {
    // capire trentamila righe sono dieci minuti: si comincia e si risponde
    // subito, lo stato si chiede quando si vuole
    if (p.avvia && !SIGN.inCorso) capisciRighe(num(p.quante, 1, 40000, 0) || 0).catch(() => {});
    return { ok: true, avviato: !!p.avvia, stato: statoSignificato() };
  },
  "clip-feed-partita": async (p) => {
    if (p.rinfresca || !FEED.righe.length) await leggiFoglioFeed();
    const f = feedPerPartita(String(p.partita || ""), String(p.quando || ""));
    return { ok: true, feed: f, righe: FEED.righe.length, letto: FEED.quando, errore: FEED.errore };
  },
  "clip-cerca": clipCerca,
  "clip-archivio-stato": async () => {
    if (!s3Acceso()) return { ok: true, acceso: false };
    // che magazzini ci sono, e quale risponde: serve per accorgersi che il
    // Synology e' spento prima di scoprirlo aprendo una partita
    const elenco = [];
    if (magazzinoAcceso(AMAZZONE)) elenco.push({ nome: "amazon", bucket: AMAZZONE.bucket, dove: "amazonaws.com" });
    MAGAZZINI.filter(magazzinoAcceso).forEach((m) => elenco.push({ nome: m.nome, bucket: m.bucket,
      dove: m.endpoint || m.cartella, radice: m.radice || "" }));
    return { ok: true, acceso: true, regione: await s3Regione(),
             bucket: S3_SPENTO ? magazzinoPredefinito().bucket : S3.bucket,
             magazzini: elenco, archivio: ARCH_BUCKET, s3Spento: S3_SPENTO,
             radice: radiciDi(ARCH_BUCKET).join(", ") };
  },
  "clip-archivio-elenca": async (p) => {
    if (!s3Acceso()) return { ok: false, errore: "l'archivio S3 non e' configurato" };
    const pg = await s3Pagina(p.prefisso || "", p.ripresa || "", p.bucket || "",
                              p.cartelle ? "/" : "");
    const quante = num(p.quante, 1, 1000, 40);
    return { ok: true, quanti: pg.oggetti.length, ancora: !!pg.ancora,
             ripresa: pg.ancora, cartelle: pg.cartelle,
             oggetti: pg.oggetti.slice(0, quante) };
  },
  // Un fotogramma preso dal file vero. Dal browser non si puo': il video
  // sta su un altro dominio e il canvas si rifiuta di leggerlo. Qui invece
  // ffmpeg apre il file, salta al secondo giusto e ne tira fuori uno.
  "clip-fotogramma": (p) => new Promise((ok, no) => {
    const r = R.reg[String(p.reg || "")];
    if (!r) return no(new Error("registrazione sconosciuta"));
    const sec = Math.max(0, +p.secondi || 0);
    const fz = r.arch ? fonteAl(r, sec) : null;
    const via = fz ? fz.via
      : fs.existsSync(path.join(cartellaReg(r.id), "integrale.mp4")) ? path.join(cartellaReg(r.id), "integrale.mp4")
      : (segmenti(r.id).length ? playlistDi(r.id) : null);
    if (!via) return no(new Error("di questa registrazione non c'e' materiale da cui prendere un fotogramma"));
    const dentroFile = fz ? fz.dentro : sec;
    const nome = "f" + nuovoId("") + ".jpg", fuori = path.join(DIR, CARTELLA_CLIP, nome);
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", String(dentroFile), "-i", via,
                      "-frames:v", "1", "-q:v", "2", "-y", fuori], { timeout: 60000 },
      (e) => e ? no(new Error("fotogramma non riuscito: " + e.message))
               : ok({ ok: true, file: "/clip/" + CARTELLA_CLIP + "/" + nome, secondi: sec }));
  }),
  "clip-reg-evento": (p) => {
    const r = R.reg[String(p.id || "")];
    if (!r) throw new Error("registrazione sconosciuta");
    if (r.arch) throw new Error("una partita d'archivio ha gia' il suo evento");
    r.evento = String(p.evento || "").slice(0, 64);
    if (p.titolo) r.titolo = String(p.titolo).slice(0, 160);
    if (p.competizione !== undefined) r.competizione = String(p.competizione || "").slice(0, 80);
    scrivi(); annuncia(0, "clip");
    return { ok: true, reg: pubblica(r) };
  },
  "clip-trascrivi": trascriviChiedi,
  "clip-parlato-locale": (p) => ({ ok: true, inCoda: parlatoLocaleInCoda(num(p.quante, 1, 20, 3)), coda: CODA_VOCE.length, alLavoro: voceAlLavoro ? voceAlLavoro.reg : "" }),
  "clip-parlato-basta": (p) => fermaParlato(!!p.riaccendi),
  "clip-parlato": (p) => {
    const d = PARLATO[String(p.reg || "")];
    return { ok: true, pezzi: (d && d.pezzi) || [], spenta: voceSpenta,
             inCorso: !!(voceAlLavoro && voceAlLavoro.reg === p.reg),
             inCoda: CODA_VOCE.filter((x) => x.reg === p.reg).length,
             motore: whisperCe() };
  },
  "clip-archivio-scandaglia": archivioScandaglia,
  "clip-appunti-storici": appuntiStoriciImporta,
  // legge il cronometro di una partita (o restituisce quello gia' letto) e
  // dice dove cade un minuto degli appunti, se glielo si chiede
  "clip-archivio-tabellone": async (p) => {
    const t = await leggiTabellone(String(p.rec || ""), !!p.rifai);
    return { ok: true, tabellone: t };
  },
  "clip-archivio-orologio": async (p) => {
    const rec = String(p.rec || "");
    const o = await calibraOrologio(rec, !!p.rifai);
    const fuori = { ok: true, orologio: o };
    if (p.tempo) {
      const d = secondoNelFile(rec, { s: +p.tempo, d: +p.d || 0 });
      fuori.dove = d ? d.secondi : null; fuori.pezzo = d ? d.pezzo : 0;
    }
    return fuori;
  },
  "clip-archivio-espn": (p) => {
    if (p.avvia) espnInCoda(!!p.rifai);
    if (p.rimisura) rimisuraRitardi();
    const rit = {}; Object.keys(RITARDI).forEach((t) => { rit[t] = { n: RITARDI[t].valori.length, secondi: ritardoDi(t) }; });
    const ritP = Object.keys(RIT_PARTITA).filter((k) => RIT_PARTITA[k].valori.length >= 2).length;
    return { ok: true, inCoda: CODA_ESPN.length, fatti: espnFatti, trovati: espnTrovati, falliti: espnFalliti,
             inMoto: espnInMoto, partiteConFatti: Object.keys(ESPN).filter((k) => ESPN[k] && ESPN[k].eventi).length,
             mancanti: Object.keys(ESPN).filter((k) => ESPN[k] && ESPN[k].mancante).length,
             ritardi: rit, partiteConRitardo: ritP,
             nota: "il ritardo che sposta gli appunti e' quello della singola partita; la tabella per persona e' solo da guardare" };
  },
  "clip-archivio-espn-partita": async (p) => {
    const e = await espnTrova(String(p.rec || "")); scriviEspn(); return { ok: true, espn: e };
  },
  "clip-archivio-durate": (p) => {
    if (p.avvia) durateInCoda(!!p.tutte);
    return { ok: true, inCoda: CODA_DURATE.length, fatte: durateFatte, fallite: durateFallite, cambiate: durateCambiate, filtro: FILTRO_OROLOGI,
             inMoto: durateInMoto, misurate: Object.keys(ARCHIVIO).filter((k) => ARCHIVIO[k].misurato).length };
  },
  "clip-archivio-orologi": (p) => {
    if (typeof p.filtro === "string") { FILTRO_OROLOGI = p.filtro; CODA_OROLOGI.length = 0; }
    if (p.avvia) orologiInCoda();
    return { ok: true, inCoda: CODA_OROLOGI.length, fatti: orologiFatti, falliti: orologiFalliti, filtro: FILTRO_OROLOGI,
             alLavoro: orologioAlLavoro || "", inMoto: orologiInMoto, lettore: tesseractCe(),
             letti: Object.keys(ARCHIVIO).filter((k) => ARCHIVIO[k].orologio).length };
  },
  "clip-archivio-apri": archivioApri,
  "clip-rifinisci-gol": async (p) => {
    if (p.seq) return await rifinisciGol(String(p.seq));
    const r = R.reg[String(p.reg || "")];
    if (!r) return { ok: false, errore: "registrazione sconosciuta" };
    const q = Object.keys(R.seq).map((k) => R.seq[k]).find((x) => x.reg === r.id && x.auto === "GOL");
    if (!q) return { ok: false, errore: "questa partita non ha una sequenza GOL" };
    if (p.rifai) delete q.rifinito;
    return await rifinisciGol(q.id);
  },
  // Apparecchia tutte le partite d'archivio gia' aperte che non hanno
  // ancora le loro sequenze: serve una volta sola, dopo un cambiamento.
  "clip-apparecchia-tutte": async () => {
    const conSeq = {};
    for (const k in R.seq) if (R.seq[k].auto) conSeq[R.seq[k].reg] = true;
    const da = Object.keys(R.reg).map((k) => R.reg[k]).filter((r) => r.arch && !conSeq[r.id]);
    let fatte = 0, vuote = 0;
    for (const r of da) {
      try {
        const e = await preparaSequenze({ reg: r.id });
        if (e && e.fatte) fatte++; else vuote++;
      } catch (err) { vuote++; }
    }
    return { ok: true, guardate: da.length, apparecchiate: fatte, senzaNiente: vuote };
  },
  // L'elenco di quello che l'archivio sa gia' offrire: serve alla tendina
  // delle partite, che altrimenti conosce solo quelle di oggi.
  "clip-archivio-partite": (p) => {
    const quante = num(p.quante, 1, 8000, 400);
    // qualche cartella porta una data che non puo' essere vera (2028): e'
    // un errore di chi l'ha scritta, non del calendario. Si tiene, ma in
    // fondo e con il segno, invece di farla comparire come prima cosa.
    const domani = Date.now() + 2 * 86400000;
    const fuori = Object.keys(ARCHIVIO).map((rec) => {
      const a = ARCHIVIO[rec], ms = Date.parse(a.quando) || 0;
      // "intera": la partita c'e' tutta — un file da cento minuti in su, oppure
      // i due tempi. Prima della misura ci si fida della forma del materiale.
      const pz = a.pezzi || [];
      const minuti = pz.reduce((t, x) => t + (x.minuti || 0), 0);
      const intera = a.misurato ? (minuti >= 85) : (a.fonte === "intero" || a.fonte === "intera" || pz.length >= 2);
      return { rec: rec, titolo: a.partita, quando: a.quando, variante: a.variante,
               competizione: a.competizione || "", soloS3: !!a.soloS3,
               dataSospetta: !!a.soloS3 && ms > domani,
               pezzi: pz.length || 1, sicuro: !!a.sicuro, intera: intera, minuti: Math.round(minuti),
               kickoff: a.kickoff === undefined ? null : a.kickoff };
    }).sort((x, y) => (x.dataSospetta - y.dataSospetta) || ((Date.parse(y.quando) || 0) - (Date.parse(x.quando) || 0)));
    return { ok: true, quante: fuori.length, partite: fuori.slice(0, quante) };
  },
  "clip-archivio-link": async (p) => {
    const a = ARCHIVIO[String(p.rec || "")];
    if (!a) return { ok: false, errore: "questa partita non e' nell'indice dell'archivio" };
    const url = await s3Firma(a.chiave, {}, num(p.quanto, 60, 43200, 21600), a.bucket);
    return { ok: true, url: url, kickoff: a.kickoff, peso: a.peso,
             variante: a.variante, chiave: a.chiave };
  },
  "clip-appunti-importa": appuntiImporta,
  "clip-appunti-partita": (p) => {
    const a = APPUNTI[String(p.rec || "")];
    if (!a) return { ok: false, errore: "di questa partita non ci sono appunti" };
    const arc = ARCHIVIO[String(p.rec || "")];
    return { ok: true, rec: p.rec, partita: a.partita, competizione: a.competizione,
             quando: a.quando, archivio: !!arc,
             righe: a.righe.map((r) => {
               const d = secondoNelFile(p.rec, r) || {};
               return Object.assign({}, r, { dove: d.secondi || null, pezzo: d.pezzo || 0 });
             }) };
  },
  "clip-appunti-stato": () => ({ ok: true, partite: Object.keys(APPUNTI).length,
    azioni: Object.keys(APPUNTI).reduce((a, k) => a + APPUNTI[k].righe.length, 0) }),
  "clip-grafica": clipGrafica,
  "clip-carica-inizia": caricaInizia,
  "clip-carica-pezzo": caricaPezzo,
  "clip-carica-fine": caricaFine,
  "clip-prepara": preparaSequenze,
  "clip-hl-genera": hlGenera,
  "clip-hl-elenco": hlElenco,
  "clip-hl-pezzo": hlPezzo,
  "clip-hl-dividi": hlDividi,
  "clip-hl-inserisci": hlInserisci,
  // L'INQUADRATURA DI UN PEZZO, formato per formato. Punti vuoti = fermo
  // al centro, come prima.
  "clip-hl-inquadra": (p) => {
    const q = seqMia(p);
    const x = q.pezzi.filter((y) => y.id === p.pezzo)[0];
    if (!x) throw new Error("pezzo sconosciuto");
    const f = FORMATI[p.formato] ? String(p.formato) : "9:16";
    const punti = Array.isArray(p.punti) ? p.punti
      .map((k) => ({ t: num(k.t, 0, 3600, 0), x: num(k.x, 0, 1, 0.5), y: num(k.y, 0, 1, 0.5) }))
      .sort((a, b) => a.t - b.t).slice(0, 60) : [];
    const z = num(p.z, 0.35, 1, 1);
    x.inquadra = x.inquadra || {};
    // "Fermo al centro" e' una DECISIONE, non un vuoto: si scrive, se no
    // l'inquadratura automatica dell'export la rifarebbe da capo ogni volta
    // contro quello che hai appena deciso.
    x.inquadra[f] = { z: z, punti: punti, fisso: !punti.length };
    if (!Object.keys(x.inquadra).length) delete x.inquadra;
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, punti: punti };
  },
  "clip-hl-inquadra-proponi": async (p) => {
    const q = seqMia(p);
    const x = q.pezzi.filter((y) => y.id === p.pezzo)[0];
    if (!x) throw new Error("pezzo sconosciuto");
    const f = FORMATI[p.formato] ? String(p.formato) : "9:16";
    const largo = LARGHEZZA_FORMATO[f];
    if (!largo) throw new Error("il 16:9 non si ritaglia: non c'e' niente da inquadrare");
    const proposta = await proponiInquadratura(q, x, largo);
    if (proposta.errore) throw new Error(proposta.errore);
    x.inquadra = x.inquadra || {};
    if (proposta.punti && proposta.punti.length) {
      const z0 = (x.inquadra[f] && !Array.isArray(x.inquadra[f]) && x.inquadra[f].z) || 1;
      x.inquadra[f] = { z: z0, punti: proposta.punti.map((k) => ({ t: k.t, x: k.x, y: 0.5 })) };
    } else delete x.inquadra[f];
    if (!Object.keys(x.inquadra).length) delete x.inquadra;
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, proposta: proposta };
  },
  // SPOSTARE UN PEZZO VIDEO NEL TEMPO. Finche' nessuno lo fa, la sequenza
  // resta attaccata come e' sempre stata: il primo spostamento la dichiara
  // "libera", e da li' in poi i pezzi stanno dove li metti, buchi compresi.
  // E' il gesto a dirlo, non un interruttore da trovare.
  "clip-hl-sposta": (p) => {
    const q = seqMia(p);
    normalizzaSeq(q);
    const x = q.pezzi.filter((y) => y.id === String(p.pezzo || ""))[0];
    if (!x) throw new Error("pezzo sconosciuto");
    if ((tracceDi(q).V1 || {}).bloccata) throw new Error("la traccia V1 e' bloccata");
    toccataAMano(q);
    const prima = x.t0 || 0;
    const dopo = Math.max(0, Math.round(num(p.t0, 0, 86400, prima) * 1000) / 1000);
    const eraLibera = !!q.libera;
    q.libera = true;
    x.t0 = dopo;
    const fatto = facciaPosto(q, x);
    // L'ELENCO SEGUE IL TEMPO. Riattaccando, i pezzi si impacchettano
    // nell'ordine in cui stanno NELL'ELENCO: se l'elenco e' ancora quello di
    // prima, il riordino appena fatto viene annullato un istante dopo. Prima
    // si mette l'elenco in fila per t0, poi si impacchetta.
    q.pezzi.sort((a, b) => (a.t0 || 0) - (b.t0 || 0));
    // se era attaccata e si e' solo infilato in mezzo, resta attaccata: si
    // e' riordinata, non staccata. Il buco lo fa solo chi va nel vuoto.
    if (fatto.infilato && !eraLibera) { delete q.libera; }
    // l'audio legato va dietro al suo video, sempre: e' cio' che vuol dire
    // essere legati. Quello scollegato resta dov'e'.
    const d = dopo - prima;
    if (d) (q.audio || []).forEach((a) => { if (a.legato === x.id) a.t0 = Math.max(0, (a.t0 || 0) + d); });
    riallinea(q);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, buchi: buchiDi(q).length, infilato: fatto.infilato || 0 };
  },
  // e la via del ritorno: si richiudono i buchi e si torna attaccati
  "clip-hl-attacca": (p) => {
    const q = seqMia(p);
    toccataAMano(q);
    delete q.libera;
    riallinea(q);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q };
  },
  "clip-tabellino": (p) => {
    const r = R.reg[String(p.reg || "")];
    if (!r) throw new Error("registrazione sconosciuta");
    return tabellino(r);
  },
  "clip-tabellino-monta": tabellinoMonta,
  "clip-hl-annulla": (p) => annullaSeq(p, false),
  "clip-hl-rifai": (p) => annullaSeq(p, true),
  "clip-hl-audio": hlAudio,
  // le onde: la pagina chiede quelle che le mancano, poche alla volta, e
  // intanto disegna quelle che ci sono. Nessuna attesa davanti a un
  // montaggio che si apre.
  "clip-hl-onde": async (p) => {
    const q = seqDi(p);
    normalizzaSeq(q);
    const fuori = {};
    let mancano = 0, fatte = 0;
    for (const a of (q.audio || [])) {
      const k = chiavePezzo(q.reg, a.dentro, a.fuori);
      const via = path.join(cartellaOnde(), k + ".json");
      if (fs.existsSync(via)) { try { fuori[a.id] = JSON.parse(fs.readFileSync(via, "utf8")); } catch (e) {} continue; }
      if (fatte >= 4) { mancano++; continue; }      // le altre al giro dopo
      const o = await calcolaOnda(q.reg, a.dentro, a.fuori);
      if (o) { fuori[a.id] = o; fatte++; } else mancano++;
    }
    return { ok: true, onde: fuori, mancano: mancano };
  },
  "clip-hl-nuova": hlNuova,
  // I E O SONO LA REGISTRAZIONE. Il montatore non pensa "adesso accendo il
  // registratore": pensa "da qui" e "fin qui". Quindi I apre il tratto da
  // tenere e O lo chiude — e il pezzo appena registrato va in timeline da
  // solo, che e' l'unica ragione per cui l'hai registrato. Dopo la O il
  // flusso continua a entrare, ma non si tiene piu' niente.
  "clip-rec": (p) => {
    const r = R.reg[String(p.id || p.reg || "")];
    if (!r) throw new Error("registrazione sconosciuta");
    if (r.stato !== "registra") throw new Error("questo flusso non e' aperto");
    const spegne = (p.on === false || p.on === "0" || p.on === 0);
    if (!spegne) return { ok: true, reg: pubblica(recAccendi(r)) };
    recSpegni(r);
    const t = (r.tenuti || [])[(r.tenuti || []).length - 1];
    let q = null;
    if (t && t.a - t.da > 0.5) {
      q = laDiretta(r.id, p.banco, p.prog);
      const x = { id: nuovoId("p"), dentro: t.da, fuori: t.a, base: t.da, mano: true,
                  titolo: "REC " + oraCorta(t.da) };
      const iv = q.pezzi.findIndex((y) => y.vivo);
      if (iv < 0) q.pezzi.push(x); else q.pezzi.splice(iv, 0, x);
      toccataAMano(q);
      scrivi(); annuncia(0, "clip");
      console.log("[clip] in timeline il tratto registrato: " + Math.round(t.a - t.da) + "s");
    }
    return { ok: true, reg: pubblica(r), seq: q, tratto: t || null };
  },
  "clip-diretta": (p) => ({ ok: true, seq: laDiretta(p.reg, p.banco, p.prog) }),
  "clip-diretta-riattacca": (p) => riattaccaLaDiretta(p.seq),
  "clip-diretta-salva": salvaIlMontato,
  "clip-diretta-prendi": prendiDalVivo,
  "clip-hl-imposta": hlImposta,
  "clip-hl-aggiungi": hlAggiungi,
  "clip-hl-suggerimento": hlSuggerimento,
  "clip-hl-ordina": hlOrdina,
  "clip-hl-taratura": hlTaratura,
  "clip-hl-esporta": hlEsporta,
  "clip-hl-elimina": hlElimina,
  "clip-integrale": clipIntegrale,
  "clip-anello": () => ({ ok: true, tolti: anello() }),
  "clip-grafica-uscita": graficaSuUscita,
  "clip-hl-grafica": hlGrafica,
  "clip-hl-in-casa": hlInCasa,
  "clip-prog-elenco": progElenco,
  "clip-prog-nuovo": progNuovo,
  "clip-prog-apri": progApri,
  "clip-prog-tocca": progTocca,
  "clip-prog-elimina": progElimina,
  "clip-uscite": (p) => (p && p.pulisci) ? pulisciUscite(p)
    : { ok: true, elenco: uscite().map((u) => ({ nome: u.nome, tipo: u.tipo, giga: Math.round(u.peso / 1e8) / 10,
        giorni: Math.round((Date.now() - u.quando) / 86400000 * 10) / 10, orfano: u.orfano, alLavoro: u.alLavoro })),
        giga: Math.round(uscite().reduce((n, u) => n + u.peso, 0) / 1e8) / 10,
        liberi: Math.round(liberiGB() * 10) / 10, scadenza: GIORNI_USCITE },
  "clip-spazio": () => ({ ok: true, peso: peso(DIR), liberi: Math.round(liberiGB() * 10) / 10 })
};

// L'integrale si chiede: e' la copia da mandare in archivio, e finche' non
// serve i segmenti bastano (e occupano la meta').
function clipIntegrale(p) {
  const r = R.reg[p.reg || p.id];
  if (!r) throw new Error("registrazione sconosciuta");
  if (r.stato === "registra" || PROC.get(r.id)) {
    throw new Error("il registratore sta ancora scrivendo: riprova fra qualche secondo");
  }
  if (r.integrale === "lavora") return { ok: true, integrale: "lavora" };
  integrale(r);
  return { ok: true, integrale: r.integrale };
}

// UN GANCIO SOLO. I comandi che c'erano gia' — taglia, sposta, butta,
// lametta, PRENDI, il vivo che cresce — muovono i pezzi video e non sanno
// che esiste un audio. Rimetterli in riga a mano in quindici punti diversi
// sarebbe stato quindici occasioni di dimenticarsene. Si fa qui, una volta:
// qualunque comando restituisca una sequenza, la sequenza esce allineata.
function rimettiInRiga(d) {
  if (!d || typeof d !== "object") return d;
  let toccato = false;
  ["seq", "diretta"].forEach((k) => {
    if (d[k] && Array.isArray(d[k].pezzi)) { riallinea(d[k]); toccato = true; }
  });
  if (Array.isArray(d.seq)) { d.seq.forEach((q) => { if (q && Array.isArray(q.pezzi)) riallinea(q); }); toccato = true; }
  if (toccato) scrivi();
  return d;
}

function azione(p) {
  const f = AZIONI[p.tipo];
  if (!f) throw new Error("tipo di invio sconosciuto: " + p.tipo);
  if (String(p.tipo || "").indexOf("clip-") !== 0) return f(p);
  const d = f(p);
  return (d && typeof d.then === "function") ? d.then(rimettiInRiga) : rimettiInRiga(d);
}

function avvio(opz) {
  if (!ATTIVO) return false;
  DIR = opz.dir;
  if (opz.annuncia) annuncia = opz.annuncia;
  assicura(DIR);
  assicura(path.join(DIR, CARTELLA_CLIP));
  assicura(path.join(DIR, CARTELLA_HL));
  leggi();
  leggiArchivioAppunti();
  leggiArchivio();
  leggiStorici();
  leggiEspn();
  leggiFeedSalvato();
  leggiVettori();
  setTimeout(raccogliParlato, 5000);
  rinominaMaterialeArchivio();
  leggiParlato();
  // Il ponte si e' riavviato: gli ffmpeg che stava seguendo sono morti con
  // lui. Meglio dirlo che lasciare in pagina una registrazione che sembra
  // viva e non scrive piu' niente.
  let adottate = 0;
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato !== "registra") return;
    if (vivo(r.pid, r.id)) {
      // sta ancora scrivendo: si riprende a seguirla, non e' successo niente
      adottate++;
      r.adottata = Date.now();
      // il proxy invece muore col ponte (non e' staccato: se cade non fa
      // danni). Si riaccende da dove era arrivato.
      setTimeout(() => avviaProxy(r), 5000);
      return;
    }
    r.stato = "interrotta";
    r.finita = Date.now();
    r.durata = durataRegistrata(r.id);
    r.errore = "il ponte si e' riavviato e il registratore non c'era piu'";
  });
  if (adottate) console.log("[clip] riprese " + adottate + " registrazioni che stavano gia' andando");
  Object.keys(R.clip).forEach((k) => {
    if (R.clip[k].stato === "lavora") { R.clip[k].stato = "errore"; R.clip[k].errore = "ponte riavviato"; }
  });
  scrivi();
  anello();
  setInterval(anello, 3600000).unref();
  // il custode delle anteprime: ogni mezzo minuto, perche' un flusso a nove
  // megabit riempie in fretta e non si vuole aspettare l'ora dell'anello
  setInterval(() => { try { spazzaAnteprime(); } catch (e) {} }, 30000).unref();
  // il multiview: un fotogramma per porta, ogni pochi secondi
  setInterval(() => { try { giraAnteprime(); } catch (e) {} }, ANTEPRIMA_OGNI * 1000).unref();
  setInterval(() => { giroEspn().catch(() => {}); }, GIRO_ESPN).unref();
  // Gli appunti delle partite appena giocate: la redazione li scrive nei
  // giorni dopo, quindi si ripassa una finestra corta e si lascia stare
  // il resto dell'archivio, che non cambia piu'.
  const rinfresca = () => appuntiImporta({ giorni: 30, quante: 200 }).catch(() => {});
  setTimeout(() => {
    if (!Object.keys(APPUNTI).length) appuntiImporta({ giorni: 400, quante: 1500 }).catch(() => {});
    else rinfresca();
  }, 30000).unref();
  setInterval(rinfresca, 6 * 3600000).unref();
  console.log("[clip] Clip Live acceso, cartella " + DIR +
              " — fino a " + MAX_REG + " registrazioni, materiale per " + GIORNI + " giorni, " +
              Math.round(liberiGB()) + " GB liberi");
  return true;
}

module.exports = { attivo: () => ATTIVO, avvio, azione, serviHttp };
