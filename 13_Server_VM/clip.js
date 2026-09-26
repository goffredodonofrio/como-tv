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
const http = require("http");
const cp = require("child_process");
const { execFileSync } = cp;
// IL LAVORO DI FONDO CEDE IL PASSO (26/09/2026). Il giro della casa teneva i
// due core al 100% con ffmpeg e tesseract alla stessa priorita' del ponte:
// la Libreria rispondeva in 3,5 s invece di 2, e sulla stessa macchina girano
// le grafiche live. Quello che parte dentro SFONDO.run(...) si lancia con
// "nice -n 15": usa tutto il processore che avanza, e quando una pagina chiede
// qualcosa passa davanti. Le stesse funzioni chiamate da una pagina restano a
// priorita' normale (il contesto lo porta avanti AsyncLocalStorage, anche
// attraverso await e callback).
const SFONDO = new (require("async_hooks").AsyncLocalStorage)();
function conNice(cmd, args) {
  if (!SFONDO.getStore() || cmd === "nice") return [cmd, args || []];
  return ["nice", ["-n", "15", cmd].concat(args || [])];
}
function spawn(cmd, args, ...resto) { const x = conNice(cmd, args); return cp.spawn(x[0], x[1], ...resto); }
function execFile(cmd, args, ...resto) { const x = conNice(cmd, args); return cp.execFile(x[0], x[1], ...resto); }
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

// il riquadro di un formato, spostato in orizzontale (cx da 0 a 1)
function ritaglioDi(formato, cx) {
  const f = { "1:1": ["1", 1080, 1080], "3:4": ["3/4", 1080, 1440], "9:16": ["9/16", 1080, 1920] }[formato];
  if (!f) return "";
  if (Math.abs(cx - 0.5) < 0.005) return FORMATI[formato].vf;
  return "crop=ih*" + f[0] + ":ih:(iw-ih*" + f[0] + ")*" + cx.toFixed(3) + ":0,scale=" + f[1] + ":" + f[2];
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
// DUE PORTE, DATE DALLA REGIA. Non un intervallo da cui scegliere: i numeri
// precisi su cui i vMix spingono, scritti nell'ambiente (COMOTV_CLIP_PORTE,
// separati da virgola). Il MAM non chiama nessuno e non cerca nessuno: sta
// in ascolto li', e su nient'altro.
const PORTE = (function () {
  const t = String(process.env.COMOTV_CLIP_PORTE || "10021,10022");
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(t.trim());
  let fuori = [];
  if (m) { for (let i = parseInt(m[1], 10); i <= parseInt(m[2], 10) && fuori.length < 2; i++) fuori.push(i); }
  else fuori = t.split(/[,\s]+/).map((x) => parseInt(x, 10)).filter((x) => x > 0 && x < 65536).slice(0, 2);
  return fuori.length ? fuori : [10021, 10022];
})();
const IP_PUBBLICO = process.env.COMOTV_IP_PUBBLICO || "209.227.239.211";
// LA RICEZIONE SI SPEGNE PER AMBIENTE. In produzione le porte SRT restano
// chiuse (deciso il 14 settembre, per i conflitti con i vMix): stesso
// codice di dev, ma con COMOTV_RICEZIONE_SPENTA=1 nessuno apre una porta
// e la pagina lo dice. Tutto il resto — archivio, sottotitoli, traduzione,
// vocabolario — lavora uguale.
const RICEZIONE_SPENTA = process.env.COMOTV_RICEZIONE_SPENTA === "1";
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
// UNA SEQUENZA CHE PERDE TUTTI I PEZZI LASCIA UN SEGNO. E' successo cinque
// volte in una settimana, a montaggi di giorni diversi, e nel registro non
// resta traccia di chi l'ha fatto: la sequenza c'e' ancora, col suo nome e
// il suo formato, e dentro non c'e' piu' niente. Qui non si difende nulla —
// si guarda soltanto: prima di ogni salvataggio, se una sequenza che aveva
// dei pezzi adesso e' vuota, si scrive nel giornale con la pila delle
// chiamate. La prossima volta si sa da dove e' arrivata.
const PEZZI_PRIMA = {};
function guardaSeVuota() {
  try {
    Object.keys(R.seq || {}).forEach((k) => {
      const n = ((R.seq[k] || {}).pezzi || []).length;
      const p0 = PEZZI_PRIMA[k];
      if (p0 > 0 && n === 0) {
        console.log("[clip] ATTENZIONE: \"" + ((R.seq[k] || {}).titolo || k) + "\" (" + k + ") aveva " + p0 +
                    " pezzi e adesso e' vuota\n" + String(new Error().stack || "").split("\n").slice(2, 8).join("\n"));
      }
      PEZZI_PRIMA[k] = n;
    });
  } catch (e) {}
}
function scrivi() {
  guardaSeVuota();
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

// L'ingresso e' uno solo: la porta SRT in ascolto. Niente caller verso
// indirizzi altrui, niente HLS: era quello che faceva litigare il MAM con i
// vMix della regia, e non si rifa'.
function argomentiIngresso(url) { return ["-i", url]; }

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
    // LA COPIA LEGGERA E' PER GUARDARE, NON PER MONTARE: a dodici fotogrammi
    // e col preset piu' veloce costa un terzo, e su due core quel terzo e'
    // quello che manca ai sottotitoli dal vivo. Il taglio resta sull'originale.
    "-vf", "scale=" + PROXY_LARGO + ":-2,fps=12.5",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-threads", "1",
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
  // e a bassa priorita': se la CPU manca, manca alla copia, non al vivo
  const pr = spawn("nice", ["-n", "10", FFMPEG].concat(args), { stdio: ["ignore", "ignore", "pipe"] });
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
  if (RICEZIONE_SPENTA) throw new Error("in questo ambiente la ricezione e' spenta: le porte si aprono solo in dev");
  let url = "";
  let ascolto = null;
  // SI RICEVE E BASTA. Non andiamo a prendere niente: ci si mette in ascolto
  // su una delle due porte e si consegna l'indirizzo a cui trasmettere.
  if (p.url) throw new Error("il MAM non va a prendere flussi: si mette in ascolto sulle sue porte");
  p.ricevi = true;
  {
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
  // su una partita dell'archivio il fischio segnato a mano vale per la
  // partita, non per questa sola registrazione: gli appunti, ESPN e il
  // tabellino si rifanno tutti su quel secondo (vedi ancoraAMano)
  if (r.arch && ARCHIVIO[r.arch.rec]) {
    ancoraAMano(r.arch.rec, r, tempo, (p.secondi === null || p.secondi === "") ? null : r.kickoff[tempo]);
    return { ok: true, kickoff: r.kickoff, orologio: ARCHIVIO[r.arch.rec].orologio || null };
  }
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
// Con "da" e "quanto" si ascolta una finestra invece di tutta la partita:
// per puntare un gol bastano due minuti d'audio, non due ore — e il
// magazzino e' della regia, non nostro.
function volumeAlSecondo(via, da, quanto) {
  // DIETRO IL PONTE IL CONTO LO FA LA EC2. Misurare il livello di tre minuti
  // vuol dire leggere tre minuti di video: centocinquanta mega per una sola
  // azione, e le azioni sono migliaia. Sulla EC2 il file si legge in regione
  // (gratis) e qui arriva la lista dei decibel: un kilobyte, tre secondi.
  const pp = pontePer(via);
  if (pp) return new Promise((ok) => {
    const q = new URLSearchParams({ k: pp.chiave, da: String(Math.max(0, Math.round(da || 0))),
                                    dur: String(Math.max(1, Math.round(quanto || 180))) });
    const r = http.get(pp.ponte + "/rms?" + q.toString(), { timeout: 900000 }, (res) => {
      let t = ""; res.on("data", (b) => { t += b; });
      res.on("end", () => {
        try { const j = JSON.parse(t); ok(j && j.ok && Array.isArray(j.db) ? j.db : []); }
        catch (e) { ok([]); }
      });
    });
    r.on("error", () => ok([]));
    r.on("timeout", () => { r.destroy(); ok([]); });
  });
  const prima = ["-hide_banner", "-nostdin"];
  if (da) prima.push("-ss", String(Math.max(0, Math.round(da))));
  if (quanto) prima.push("-t", String(Math.round(quanto)));
  return new Promise((ok) => {
    execFile(FFMPEG, prima.concat(["-i", via, "-vn",
                      "-af", "aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1," +
                             "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
                      "-f", "null", "-"]),
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
// QUANDO IL SECONDO E' MISURATO, LA RINCORSA SI ACCORCIA. Le maniglie larghe
// (trenta, trentacinque secondi) servivano a coprire l'errore dell'appunto:
// il minuto scritto cade sul replay e non si sa di quanto. Ma dove il
// tabellone o il boato hanno detto il secondo esatto quell'errore non c'e'
// piu', e trenta secondi di rincorsa sono trenta secondi di gioco in mezzo
// al campo prima dell'azione. Quindici bastano a far capire da dove nasce.
const PUNTATO_PRE = 15;
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
  ["gol", /\bgol\b|\bgoal\b|autogol|\bsegna\b|\bsegnat[oa]\b|marcatur|in rete\b|gonfia la rete/i],
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
// IL TIPO SCELTO DA CHI SCRIVE VALE PIU' DELLA PROSA. Il giornalista sceglie
// "Gol", "Occasione", "Parata", "Palo" da un elenco chiuso; il testo invece
// racconta, e in un racconto "il guardalinee ha SEGNAlato il fuorigioco" o
// "tiro a RETE" finivano etichettati come gol. Una partita da due gol ne
// mostrava tre nella legenda (23/09). Il testo si guarda solo quando il tipo
// non c'e': succede negli appunti scritti di fretta.
function etichettaAzione(tipo, titolo) {
  const soloTipo = String(tipo || "").trim(), testo = String(titolo || "");
  // un gol annullato non e' un gol, e lo dice il testo: vale piu' del tipo
  if (/annullat|disallow/i.test(testo)) return "annullato";
  // QUELLO CHE NON E' ENTRATO NON E' UN GOL, anche quando chi scrive ha
  // scelto "Gol" come tipo: "Quinones vicino al gol", "Zajc si mangia il
  // gol", "Stojkovic vicino al gol del pari". Nella legenda una partita da
  // due gol ne mostrava tre (23/09).
  // LA RETE PRESA DA FUORI NON E' UN GOL. "sull'esterno della rete" e
  // "calcia alto" sono conclusioni sbagliate, e la parola rete le faceva
  // passare per gol anche quando chi scrive aveva messo tipo "Gol".
  const quasi = /sfior|si mangia|si divora|mangia(to)? il gol|vicino al gol|per poco|gol (mangiato|sbagliato|fallito)|a un passo dal gol|fallisce|esterno della rete|sull.esterno|\ba lato\b|sul fondo|di poco fuori|calcia (alto|fuori)|alto sopra/i.test(testo);
  // UN GOL VERO PORTA CON SE' IL PUNTEGGIO CHE CAMBIA: "AUTOGOL DI VALINCIC,
  // sulla conclusione di Babec (3-1 DIN)" e' un gol anche se il tipo dice
  // "Occasione". E' il modo in cui la redazione segna che la palla e' entrata.
  if (!quasi && /\b(auto)?gol\b/i.test(testo) && /\(\s*\d{1,2}\s*[-\u2013]\s*\d{1,2}/.test(testo)) return "gol";
  const cerca = (dove) => {
    for (const [nome, forma] of ETICHETTE) {
      if (!forma.test(dove)) continue;
      if (nome === "gol" && quasi) continue;
      return nome;
    }
    return null;
  };
  // il tipo scelto da chi scrive vale piu' della prosa: il testo racconta, e
  // in un racconto "ha SEGNAlato il fuorigioco" passava per gol
  return (soloTipo && cerca(soloTipo)) || cerca(soloTipo + " " + testo) || "azione";
}


// ── QUANTO CI SI PUO' FIDARE DEL SECONDO ──────────────────────────────
//  Non tutte le fonti portano allo stesso fotogramma. Il tabellone che
//  cambia e' il secondo esatto. ESPN da' il minuto di gioco, e con il
//  cronometro letto quel minuto diventa mezzo minuto di finestra. La
//  redazione scrive DOPO aver visto, e il suo minuto cade sul replay, non
//  sull'azione. Quindi quando due righe raccontano la stessa cosa: l'ora
//  la mette chi ce l'ha piu' precisa, il testo lo mette chi dice di piu'.
function precisioneDi(x) {
  if (x.momento) return 6;                 // l'inquadratura: al secondo
  if (x.tabellone) return 5;
  // IL BOATO MANCAVA DA QUESTA SCALA. Una riga inchiodata al secondo dallo
  // stadio che non prende fiato vale piu' del minuto ufficiale di ESPN, che
  // e' un minuto e basta: fondendo le due, il secondo esatto veniva buttato
  // via e restava l'arrotondamento. Ordine: tabellone > boato > cronometro >
  // minuto di ESPN > minuto del giornalista.
  if (x.certezza === "boato" || x.boato) return 4;
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
  fuso.momento = ora.momento || 0;
  fuso.minuto = a.minuto || b.minuto || "";
  fuso.rating = Math.max(a.rating || 0, b.rating || 0);
  fuso.peso = Math.max(a.peso || 1, b.peso || 1);
  const firme = []; [a, b].forEach((x) => (x.fonti || [x.fonte]).forEach((f) => { if (f && firme.indexOf(f) < 0) firme.push(f); }));
  fuso.fonti = firme;
  fuso.fonte = dice.fonte;
  return fuso;
}

// le parole che in un appunto non sono un cognome
const NON_NOMI = new Set(("GOAL GOLS RETE RETI CROSS ASSIST TIRO TIRI CALCIO ANGOLO PUNIZIONE RIGORE AREA PALLA PALLONE " +
  "SINISTRO DESTRO TESTA PIEDE PORTA PORTIERE TRAVERSA PALO DOPO PRIMA SUPER GRANDE BELLA BELLO PRIMO SECONDO TEMPO " +
  "MINUTO CONTROPIEDE AZIONE VANTAGGIO PAREGGIO RADDOPPIO ANNULLATO CONCLUSIONE DEVIAZIONE PARATA CASA OSPITI").split(" "));
function nomiDentro(x) {
  return (String(x.giocatore || "") + " " + String(x.titolo || ""))
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
    .split(/[^A-Z]+/).filter((w) => w.length >= 4 && !NON_NOMI.has(w));
}
// IL NOME DELLA SQUADRA NON E' IL NOME DI UN GIOCATORE. "GOL VALLE. Tiro di
// Loor..." e "GOL VALLE. Rigore dato..." sono due gol diversi dell'Independiente
// del Valle, e la parola VALLE li faceva contare per uno solo (23/09).
function stessoNome(a, b, squadre) {
  const na = nomiDentro(a), nb = nomiDentro(b);
  return na.some((w) => nb.indexOf(w) >= 0 && !(squadre && squadre.has(w)));
}
function togliDoppioni(pezzi, vicino, squadre) {
  const fuori = [];
  const eti = (z) => etichettaAzione(z.tipo, z.titolo);
  pezzi.sort((a, b) => a.dentro - b.dentro).forEach((x) => {
    // SI GUARDA INDIETRO, NON SOLO ALLA RIGA DI PRIMA. Fra il gol visto da
    // ESPN e quello scritto dalla redazione ci puo' stare un'occasione, e
    // allora la catena si spezzava e il gol restava doppio (23/09).
    const ex = eti(x);
    for (let n = fuori.length - 1; n >= 0; n--) {
      const y = fuori[n], dist = Math.abs(x.dentro - y.dentro);
      if (dist >= 240) break;                       // piu' indietro non si guarda
      const ey = eti(y);
      // LO STESSO GOL VISTO DA DUE PARTI ARRIVA A UN MINUTO DI DISTANZA:
      // ESPN arrotonda al minuto, il giornalista scrive dopo aver visto.
      // Per i gol la finestra si allarga a cento secondi, ma solo se le due
      // righe nominano lo stesso giocatore: cosi' una doppietta ravvicinata
      // resta di due gol.
      // quattro minuti, non due: il ritardo del giornalista sposta la sua
      // riga rispetto a quella di ESPN, e "Johansen gol" al 48' con "Gol ·
      // Nicolas Johansen" al 49' finivano a tre minuti di distanza
      const quanto = (ex === "gol" && ey === "gol" && stessoNome(x, y, squadre)) ? 240 : (vicino || 20);
      if (dist >= quanto) continue;
      // Ma solo se parlano davvero della stessa cosa: un gol e
      // un'ammonizione a venti secondi restano due righe.
      if (ex === ey || ex === "azione" || ey === "azione") {
        fuori[n] = fondiDue(y, x);
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
function finestraGol(t, rec, misurato) {
  const a = rec && ARCHIVIO[rec];
  const noto = a && vicinoNella(a.replay, t);
  const rete = a && vicinoNella(a.gol, t);
  const dentro = rete ? Math.max(0, rete - PUNTATO_PRE)
               : misurato ? Math.max(0, t - PUNTATO_PRE)
               : Math.max(0, t - GOL_PRE);
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
  const fine = a ? ritardoFine(rec) : 0;
  if (a) {
    const rit = ritardoPartita(rec);
    (a.righe || []).forEach((x) => {
      const t = dove(x.s, Math.max(0, (x.d || 0) - rit - fine));
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
  // POI IL BOATO, per quello che il tabellone non ha messo al secondo.
  // Vale per i gol delle partite senza lettura, e per le azioni che un
  // tabellone non registra: un palo, un rosso, una parata.
  // IL BOATO SI RIATTACCA ALLA SUA RIGA, e questo era il punto rotto.
  //
  //  Il boato veniva cercato per vicinanza: "un boato entro dodici secondi
  //  dal secondo della riga". Solo che il secondo della riga NON STA FERMO
  //  — lo sposta indietro la correzione del ritardo del giornalista, che e'
  //  la mediana degli scarti dei boati stessi, quasi quaranta secondi. Cioe'
  //  la misura buona spostava la riga via dal boato che l'aveva prodotta:
  //  piu' misuravamo bene, meno boati si attaccavano. Su 548 righe ne
  //  arrivavano sedici. Seimila secondi gia' misurati non arrivavano a
  //  nessuno.
  //
  //  Adesso: prima la chiave (chi l'ha scritta, che minuto, che cosa) che
  //  non si muove; poi, per i boati vecchi che la chiave non ce l'hanno, il
  //  piu' vicino — provato anche sull'asse di PRIMA della correzione — con
  //  due regole che tengono: ogni boato vale per UNA riga sola, e si
  //  assegnano partendo dalle coppie piu' vicine. Cosi' due azioni a
  //  cinquanta secondi non si contendono lo stesso urlo.
  const boa = ((ARCHIVIO[rec] || {}).boati || []).filter((y) => y.t !== null && y.t !== undefined);
  if (boa.length) {
    const rumorose = azioni.filter((x) => !x.tabellone &&
      DA_BOATO.test(String(x.tipo || "") + " " + String(x.titolo || "")));
    const tDi = (x) => (x.t !== undefined ? x.t : x.dentro + APP_PRE);
    const paia = [];
    rumorose.forEach((x, i) => {
      const t = tDi(x), k = chiaveRiga(x);
      boa.forEach((y, j) => {
        if (y.rigaK && y.rigaK === k) { paia.push({ i: i, j: j, d: -1 }); return; }
        if (y.rigaK) return;                  // ha gia' la sua riga, e non e' questa
        const d = Math.min(Math.abs(y.stimato - t), Math.abs(y.stimato - (t + fine)));
        if (d <= BOATO_LONTANO) paia.push({ i: i, j: j, d: d });
      });
    });
    paia.sort((p, q) => p.d - q.d);
    const rPresa = {}, bPreso = {};
    paia.forEach((p) => {
      if (rPresa[p.i] || bPreso[p.j]) return;
      rPresa[p.i] = 1; bPreso[p.j] = 1;
      const x = rumorose[p.i], b = boa[p.j], t = tDi(x);
      x.spostato = Math.round(t - b.t);
      x.t = b.t; x.boato = b.db;
      // il boato ha detto il secondo: rincorsa corta
      const w = finestraGol(b.t, rec, true);
      x.dentro = w.dentro; x.fuori = w.fuori; x.base = x.dentro;
    });
  }
  // POI L'INQUADRATURA, che viene per ultima perche' e' la piu' precisa:
  //  il tabellone sa il gol entro venti secondi, il boato entro una decina;
  //  la regia che passa dalla camera larga ai primi piani lo sa al secondo.
  //  Misurata una volta dal giro della casa (puntaMomenti), per chiave di
  //  riga e in secondi del FILE: si riporta in qualunque coordinata.
  // (dopo aver tolto i doppioni: e' sulle righe fuse che si e' misurato)
  const squadre = new Set(nomiDentro({ titolo: ((ARCHIVIO[rec] || {}).partita || r.titolo || "") }));
  const fuse = togliDoppioni(azioni, 45, squadre);
  const mom = (ARCHIVIO[rec] || {}).momenti;
  if (mom) fuse.forEach((x) => {
    const m = mom[chiaveRiga(x)]; if (!m || m.sec === null || m.sec === undefined) return;
    const t = x.t !== undefined ? x.t : x.dentro + APP_PRE;
    const p = pezzoAl(r, t); if (!p || !p.pezzo || (p.pezzo.chiave && m.chiave && p.pezzo.chiave !== m.chiave)) return;
    const nuovo = t + (m.sec - p.dentro);
    if (Math.abs(nuovo - t) > 150) return;
    x.spostato = Math.round(t - nuovo); x.t = nuovo; x.momento = 1;
    const w = finestraGol(nuovo, rec, true);
    x.dentro = w.dentro; x.fuori = w.fuori; x.base = x.dentro;
  });
  // con maniglie larghe due azioni vicine si sovrappongono: si sta piu' larghi
  // anche nel togliere i doppioni
  // le parole del nome della partita: servono a non scambiare una squadra
  // per un giocatore quando si decide se due righe sono lo stesso gol
  return { azioni: fuse, gol: uniscoIGol(gol, rec), voce: voceScelta,
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
  if (rec && ARCHIVIO[rec] && !ARCHIVIO[rec].orologio) ancoraSeManca(rec);
  const sap = quelloCheSappiamo(r);
  const a = rec && ARCHIVIO[rec];
  // dove sappiamo che cade il taglio, e quanto ci crediamo:
  //   cronometro -> il numero in sovrimpressione l'abbiamo letto: e' esatto
  //   minuto     -> sappiamo solo il minuto scritto: e' una stima
  const comeLoSappiamo = (t, x) => {
    if (x && x.momento) return "inquadratura";
    if (x && x.tabellone) return "tabellone";
    if (x && x.boato) return "boato";
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
    // una riga messa al secondo dall'inquadratura tiene la sua finestra
    const dentro = g && !x.momento ? g.dentro : x.dentro;
    const fuori = g && !x.momento ? g.fuori : x.fuori;
    return {
      t: Math.round(t * 10) / 10,
      dentro: Math.round(dentro * 10) / 10,
      fuori: Math.round(fuori * 10) / 10,
      titolo: x.titolo || "", tipo: x.tipo || "", minuto: x.minuto || "",
      fonte: x.fonte || "", peso: x.peso || 1, rating: x.rating || 0,
      squadra: x.squadra || "", giocatore: x.giocatore || "",
      dettaglio: String(x.dettaglio || "").slice(0, 200),
      gol: !!g || !!x.tabellone || !!(x.momento && /\b(gol|goal|rete)\b/i.test((x.tipo || "") + " " + (x.titolo || ""))), certezza: comeLoSappiamo(t, x),
      tabellone: x.tabellone || "", boato: x.boato || 0,
      spostato: x.spostato === undefined ? 0 : x.spostato,
      tag: etichettaAzione(x.tipo, x.titolo),
      fonti: x.fonti && x.fonti.length ? x.fonti : [x.fonte || ""]
    };
  }).sort((m, n) => m.t - n.t);
  const conta = {};
  righe.forEach((x) => { conta[x.fonte] = (conta[x.fonte] || 0) + 1; });
  // quanto ci si puo' fidare dei minuti: senza cronometro letto e senza ora
  // nel nome del file, l'inizio della partita e' solo un'ipotesi
  const oro = (a && a.orologio) || {};
  const fonteDi = (n) => (oro["inizio" + n] !== undefined && oro["inizio" + n] !== null) ? ((oro.fonti || {})[n] || oro.fonte || "cronometro") : null;
  const ancora = fonteDi(1) || fonteDi(2)
               || ((a && (a.pezzi || []).some((x) => oraNelNome(path.basename(x.chiave || "")))) ? "ora del file" : "niente");
  // dove cade il fischio su QUESTA registrazione, e da dove lo sappiamo
  const fischio = {};
  if (a) ["1", "2"].forEach((n) => {
    const s = secondoNelFile(rec, { s: +n, d: 0 });
    if (!s) return;
    const pz = pezziArch(r);
    const dentro = pz.length > 1 ? ((pz[s.pezzo] || pz[pz.length - 1]).da || 0) + s.secondi : (s.pezzo === ((r.arch && r.arch.pezzo) || 0) ? s.secondi : null);
    if (dentro === null) return;
    fischio[n] = { t: dentro, fonte: fonteDi(n) || "stima", verificato: n === "1" ? !!oro.verificato : !!oro.verificato };
  });
  return { ok: true, righe: righe, quante: righe.length, fonti: conta, ancora: ancora, fischio: fischio,
           prove: oro.prove || null, orologioFallito: (a && a.orologioFallito) || null,
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


// ── I SOTTOTITOLI CHE SEGUONO IL TAGLIO ───────────────────────────────
//
//  La telecronaca trascritta ha i tempi del file intero. Una clip comincia
//  al suo secondo, una sequenza incolla pezzi presi qua e la': i tempi vanno
//  rifasati sul PEZZO, se no in Premiere il sottotitolo arriva dieci minuti
//  dopo. Da qui escono: le righe che cadono dentro un tratto, gia'
//  spostate; il testo SRT (un file per lingua); e il file ASS che ffmpeg
//  imprime nel video, con gli stili della casa: italiano Nexa Bold 51
//  giallo, inglese Nexa Bold 55 bianco, tutte e due insieme se le si vuole
//  nello stesso video (inglese sotto, italiano sopra).
//  La lingua che manca si traduce al momento: per una clip sono dieci
//  righe, un secondo di Argos, e restano scritte per la prossima volta.
function righeParlato(reg, lingua, da, a, sposta) {
  const d = PARLATO[reg];
  if (!d || !(d.pezzi || []).length) return [];
  const propria = d.lingua || LINGUA_MAM;
  const voglio = ["it", "en"].indexOf(String(lingua || "")) >= 0 ? String(lingua) : propria;
  const dentro = d.pezzi.filter((x) => !x.vivo && x.b > da && x.a < a).sort((u, v) => u.a - v.a);
  const fuori = [];
  dentro.forEach((x, i) => {
    const sua = x.l || propria;
    const testo = String((sua === voglio) ? x.x : (x.ya === voglio && x.y ? x.y : x.x) || "").trim();
    if (!testo) return;
    const dopo = dentro[i + 1];
    let a0 = Math.max(x.a, da), b0 = Math.min(x.b, a, dopo ? dopo.a - 0.05 : x.b);
    // una riga che il taglio prende solo di striscio (meno di un secondo e
    // meno di meta') lampeggerebbe con un pezzo di frase: si lascia fuori
    if (b0 - a0 < 1 && b0 - a0 < (x.b - x.a) / 2) return;
    if (b0 - a0 < 0.4) b0 = Math.min(a, a0 + 0.8);
    if (b0 <= a0) return;
    fuori.push({ a: Math.round((a0 - da + (sposta || 0)) * 1000) / 1000,
                 b: Math.round((b0 - da + (sposta || 0)) * 1000) / 1000, testo, lingua: voglio, sua, p: x, n: x.n,
                 tradotta: sua !== voglio && x.ya === voglio && !!x.y,
                 manca: sua !== voglio && !(x.ya === voglio && x.y) });
  });
  return fuori;
}
// le stesse righe, ma con la lingua che manca tradotta adesso e scritta
// nella telecronaca, cosi' la prossima volta c'e' gia'
async function righeTradotte(reg, lingua, da, a, sposta, r) {
  const righe = righeParlato(reg, lingua, da, a, sposta);
  const mancano = righe.filter((x) => x.manca);
  for (let i = 0; i < mancano.length; i += 20) {
    const lotto = mancano.slice(i, i + 20);
    try {
      const tr = await traduciConINomi(lotto.map((x) => x.p.x), lotto[0].sua, lingua, r || R.reg[reg] || {});
      if (!tr || tr.some((t) => !t)) console.log("[clip] sottotitoli: traduzione " + lotto[0].sua + "\u2192" + lingua + " di " + lotto.length + " righe: " + (tr ? tr.filter((t) => !t).length + " vuote" : "nessuna risposta"));
      lotto.forEach((x, k) => { if (tr && tr[k]) { x.p.y = tr[k]; x.p.ya = lingua; x.p.l = x.p.l || x.sua; x.testo = tr[k]; x.manca = false; x.tradotta = true; } });
    } catch (e) { console.log("[clip] traduzione per i sottotitoli: " + e.message); break; }
  }
  if (mancano.some((x) => !x.manca)) scriviParlato();
  return righe;
}
// legge un SRT (o un VTT senza stili): numero, "hh:mm:ss,mmm --> hh:mm:ss,mmm", testo su una o piu' righe
function leggiSrt(testo) {
  const t = String(testo || "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocchi = t.split(/\n{2,}/), fuori = [];
  const tempo = (x) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(x); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, "0").slice(0, 3)) / 1000 : null; };
  blocchi.forEach((b) => {
    const righe = b.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!righe.length) return;
    let i = 0, n = 0;
    if (/^\d+$/.test(righe[0])) { n = +righe[0]; i = 1; }
    const m = righe[i] && /(\S+)\s*-->\s*(\S+)/.exec(righe[i]);
    if (!m) return;
    const a = tempo(m[1]), bb = tempo(m[2]);
    if (a === null || bb === null || bb <= a) return;
    const x = righe.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (x) fuori.push({ n: n || fuori.length + 1, a, b: bb, x });
  });
  return fuori;
}
function tempoSrt(s) {
  const ms = Math.max(0, Math.round(s * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, ss = Math.floor(ms / 1000) % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + "," + String(ms % 1000).padStart(3, "0");
}
function tempoAss(s) {
  const cs = Math.max(0, Math.round(s * 100)), h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, ss = Math.floor(cs / 100) % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + "." + String(cs % 100).padStart(2, "0");
}
// una riga sopra i 42 caratteri si spezza in due, vicino a meta': e' la
// misura di sicurezza dei sottotitoli in onda, e Premiere non lo fa da se'
function spezzaSotto(t, aCapo) {
  if (t.length <= 42) return t;
  let k = -1, meglio = 1e9;
  for (let i = 18; i < t.length - 8; i++) if (t[i] === " " && Math.abs(i - t.length / 2) < meglio) { meglio = Math.abs(i - t.length / 2); k = i; }
  return k < 0 ? t : t.slice(0, k) + (aCapo || "\n") + t.slice(k + 1);
}
function testoSrt(righe, numeriPropri) {
  // un SRT importato riesce con i SUOI numeri (regola di Manolo: la
  // numerazione non si tocca); se e' spezzato o mescolato, si rinumera
  const propri = numeriPropri && righe.length && righe.every((x) => x.n) && new Set(righe.map((x) => x.n)).size === righe.length;
  return righe.map((x, i) => (propri ? x.n : i + 1) + "\n" + tempoSrt(x.a) + " --> " + tempoSrt(x.b) + "\n" + spezzaSotto(x.testo) + "\n").join("\n");
}
// LA FONT DEI SOTTOTITOLI: la Nexa Bold, se e' installata sulla macchina
// (fontconfig la trova per nome); se no la Mazzard, che c'e' sempre. Si
// chiede una volta e si tiene a mente.
let fontSottoVista = null;
function fontSotto() {
  if (fontSottoVista) return fontSottoVista;
  let nome = "Mazzard M";
  try {
    const m = String(execFileSync("fc-match", ["-f", "%{family}", "Nexa:bold"], { timeout: 4000 }) || "");
    if (/nexa/i.test(m)) nome = m.split(",")[0].trim();
  } catch (e) {}
  fontSottoVista = nome;
  console.log("[clip] sottotitoli impressi con la font \"" + nome + "\"" + (nome === "Mazzard M" ? " (la Nexa non e' installata)" : ""));
  return nome;
}
// gli stili della casa, su un quadro 1920x1080: libass li scala sull'altezza
// del video che esce, quindi sul verticale crescono in proporzione
const STILI_SOTTO = {
  it: { nome: "IT", corpo: 51, colore: "&H0000FFFF" },   // giallo   (AABBGGRR)
  en: { nome: "EN", corpo: 55, colore: "&H00FFFFFF" }    // bianco
};
function testoAss(blocchi) {
  const font = fontSotto();
  const due = blocchi.filter((b) => b.righe.length).length > 1;
  // con due lingue l'inglese sta sotto e l'italiano sopra, a distanza di
  // due righe inglesi; da solo ognuno sta in basso
  const margine = { en: 54, it: due ? 54 + Math.round(55 * 1.25 * 2) + 10 : 54 };
  const stili = Object.keys(STILI_SOTTO).map((l) => {
    const st = STILI_SOTTO[l];
    return "Style: " + st.nome + "," + font + "," + st.corpo + "," + st.colore + ",&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2.2,0,2,80,80," + margine[l] + ",1";
  }).join("\n");
  const eventi = [];
  blocchi.forEach((b) => {
    const st = STILI_SOTTO[b.lingua] || STILI_SOTTO.it;
    b.righe.forEach((x) => {
      const t = spezzaSotto(x.testo.replace(/[{}]/g, ""), "\\N");
      eventi.push("Dialogue: 0," + tempoAss(x.a) + "," + tempoAss(x.b) + "," + st.nome + ",,0,0,0,," + t);
    });
  });
  return "[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
    stili + "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" + eventi.join("\n") + "\n";
}
// il filtro di ffmpeg: libass legge l'ASS e lo disegna sul video
function filtroSottotitoli(fileAss) {
  const via = fileAss.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
  return "subtitles=filename='" + via + "':fontsdir=/usr/local/share/fonts/comotv";
}
// che cosa chiede chi esporta: niente, il file, impresso nel video, o tutti
// e due; e in che lingua — una, o tutte e due insieme
function vuoleSotto(p) {
  const s = String((p && p.sotto) || "").toLowerCase();
  const l = String((p && p.sottoLingua) || "").toLowerCase();
  const lingue = (l === "entrambe" || l === "it+en" || l === "en+it") ? ["it", "en"] : (["it", "en"].indexOf(l) >= 0 ? [l] : []);
  return { file: s === "srt" || s === "entrambi", video: s === "video" || s === "entrambi", lingue };
}
function lingueSotto(v, reg) { return v.lingue.length ? v.lingue : [(PARLATO[reg] || {}).lingua || LINGUA_MAM]; }
// per UNA clip: scrive gli srt accanto al file e l'ASS per ffmpeg, e dice
// quale filtro aggiungere. Il tratto e' quello della clip com'e' uscita,
// rincorsa compresa: cosi' comincia col primo fotogramma.
async function sottoPerLaClip(r, c, p) {
  const v = vuoleSotto(p);
  if (!v.file && !v.video) return "";
  const blocchi = [];
  for (const l of lingueSotto(v, r.id)) blocchi.push({ lingua: l, righe: await righeTradotte(r.id, l, c.dentro, c.fuori, 0, r) });
  if (!blocchi.some((b) => b.righe.length)) throw new Error("sottotitoli chiesti, ma in questo tratto la telecronaca non e' trascritta");
  c.sottoLingue = blocchi.map((b) => b.lingua);
  c.sottoLingua = c.sottoLingue[0];
  c.sottoRighe = blocchi.reduce((n, b) => n + b.righe.length, 0);
  c.sottoMancano = blocchi.reduce((n, b) => n + b.righe.filter((x) => x.manca).length, 0);
  if (v.file) {
    c.srts = blocchi.filter((b) => b.righe.length).map((b) => {
      fs.writeFileSync(path.join(DIR, CARTELLA_CLIP, c.id + "." + b.lingua + ".srt"), testoSrt(b.righe));
      return { lingua: b.lingua, file: "/clip/" + CARTELLA_CLIP + "/" + c.id + "." + b.lingua + ".srt", righe: b.righe.length };
    });
    c.srt = c.srts[0].file;
  }
  if (!v.video) return "";
  const ass = path.join(DIR, CARTELLA_CLIP, c.id + ".ass");
  fs.writeFileSync(ass, testoAss(blocchi));
  c.sottoImpressi = true;
  return filtroSottotitoli(ass);
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
  // DOVE STA IL RIQUADRO (cx: 0 tutto a sinistra, 1 tutto a destra). Nel
  // verticale di una partita l'azione non sta sempre al centro: la Diretta
  // lo sposta come la Riformattazione di Premiere. Senza cx, al centro.
  const cx = (p.cx === undefined || p.cx === null || p.cx === "") ? 0.5 : num(p.cx, 0, 1, 0.5);
  const ritaglio = ritaglioDi(formato, cx);
  // Lo sting (la fascia con partita e azione bruciata nei primi tre
  // secondi) esiste, ma di suo e' SPENTO: costa una ricodifica, e per
  // riconoscere una clip basta la miniatura. Si accende chiedendolo.
  const sting = p.sting === true && fontCe();
  const sottoV = vuoleSotto(p);
  if ((sottoV.file || sottoV.video) && !lingueSotto(sottoV, r.id).some((l) => righeParlato(r.id, l, dentro, fine, 0).length))
    throw new Error("sottotitoli chiesti, ma in questo tratto la telecronaca non e' trascritta (Telecronaca \u2192 trascrivi)");
  // imprimere il testo vuol dire ricodificare: si taglia esatto
  const preciso = !!p.preciso || !!ritaglio || sting || sottoV.video;

  const c = {
    id: nuovoId("c"),
    reg: r.id,
    sting: sting,
    evento: r.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    dentro: dentro, fuori: dentro + quanto, durata: quanto,
    troncata: fuori > registrato,
    formato: formato,
    cx: (typeof cx === "number" && Math.abs(cx - 0.5) >= 0.005) ? Math.round(cx * 1000) / 1000 : undefined,
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
  const stingFiltro = [sting ? filtroSting(r, c, path.join(DIR, CARTELLA_CLIP), c.id) : "", await sottoPerLaClip(r, c, p)].filter(Boolean).join(",");
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
async function taglioDaIntegrale(r, p, dentro, fuori, durata) {
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
  // DOVE STA IL RIQUADRO (cx: 0 tutto a sinistra, 1 tutto a destra). Nel
  // verticale di una partita l'azione non sta sempre al centro: la Diretta
  // lo sposta come la Riformattazione di Premiere. Senza cx, al centro.
  const cx = (p.cx === undefined || p.cx === null || p.cx === "") ? 0.5 : num(p.cx, 0, 1, 0.5);
  const ritaglio = ritaglioDi(formato, cx);
  const sting = p.sting === true && fontCe();
  const sottoV = vuoleSotto(p);
  if ((sottoV.file || sottoV.video) && !lingueSotto(sottoV, r.id).some((l) => righeParlato(r.id, l, dentro, dentro + durata, 0).length))
    throw new Error("sottotitoli chiesti, ma in questo tratto la telecronaca non e' trascritta (Telecronaca \u2192 trascrivi)");
  const preciso = !!p.preciso || !!ritaglio || sting || sottoV.video;
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
                     [sting ? filtroSting(r, c, path.join(DIR, CARTELLA_CLIP), c.id) : "", await sottoPerLaClip(r, c, p)].filter(Boolean).join(","),
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
    try { fs.unlinkSync(path.join(DIR, CARTELLA_CLIP, c.id + ".ass")); } catch (e) {}
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
    // una partita S3 gia' copiata sulla NAS: la pagina toglie i freni
    inCasa: inCasaReg(r),
    // una partita d'archivio non ha byte qui: ha un indirizzo, che scade e
    // quindi si rifa' ogni volta che qualcuno chiede lo stato
    materiale: r.arch ? (magazzinoCe(r) ? "archivio" : "scaduto")
             : fs.existsSync(playlistDi(r.id)) ? "segmenti"
             : (fs.existsSync(path.join(cartellaReg(r.id), "integrale.mp4")) ? "integrale" : "scaduto"),
    // l'indirizzo per la PAGINA: quello firmato del magazzino se il browser
    // ci arriva, il ponte sulla VM se il magazzino sta dietro il tunnel
    // UNA REGISTRAZIONE ORFANA NON SPEGNE LA PAGINA. Se il suo magazzino non
    // c'e' piu' — la Synology staccata, un secchio sganciato — il suo
    // indirizzo non si puo' fare: si lascia vuoto e si va avanti. Prima
    // l'eccezione saliva fino a clip-stato, che rispondeva con un errore
    // solo: niente registrazioni, niente monitor, e sembrava rotto tutto.
    via: (function () {
      if (!r.arch) return undefined;
      if (staccataDaS3(r)) return undefined;   // ancora solo a Parigi: non si apre
      try { return magazzinoDaFuori(r) ? viaArchivio(r) : viaPonte(r.id); }
      catch (e) { return undefined; }
    })(),
    // I PEZZI DELLA PARTITA, PER LA PAGINA. Ognuno con il secondo in cui
    // entra nella linea del tempo, quanto dura e da dove si prende: il
    // monitor cambia file da solo quando la testina passa da un tempo
    // all'altro, e chi monta vede due ore, non cinquantasei minuti.
    pezziArch: (r.arch && magazzinoCe(r) && !staccataDaS3(r)) ? pezziArch(r).map((x, i) => ({
      da: x.da || 0, durata: x.durata || 0,
      via: magazzinoDaFuori(r) ? viaFileArchivio(r, x) : viaPonte(r.id, 21600, i)
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
    sottotitoli: r.sottotitoli || null,
    sottotitoliLingua: (VIVI.get(r.id) || {}).lingua || "",
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
    ricezione: !RICEZIONE_SPENTA,
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
  // UN 48' NEL BLOCCO DEL PRIMO TEMPO E' UNA RIGA SCRITTA NEL POSTO
  // SBAGLIATO. Capita quando il titolo "secondo tempo" arriva dopo: la riga
  // resta sopra, e l'azione finisce quindici minuti prima di dove sta
  // davvero. Nell'archivio erano trecentocinquanta. Il 46' e il 47' invece
  // si lasciano stare: quasi sempre sono il recupero scritto senza il piu'.
  fuori.forEach((r) => {
    if (r.sezione === 1 && r.stoppVero === 0 && r.minutoVero >= 48) {
      r.sezione = 2; r.dentroTempo = (r.minutoVero - dur) * 60 + r.secVero;
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
  if (GIRO_AZIONE && p.giro === GIRO_AZIONE) return;   // questo comando ha gia' il suo passo
  const t = JSON.stringify(q);
  // se e' identica all'ultima messa da parte, non e' un passo: e' lo stesso
  // punto. Senza questo controllo un comando che chiama due volte il gancio
  // costerebbe due ⌘Z per tornare indietro di una mossa sola.
  if (p.indietro.length && p.indietro[p.indietro.length - 1].t === t) { p.avanti.length = 0; return; }
  const voce = { t: t, cosa: PASSO_IN_CORSO || "Modifica", quando: Date.now() };
  ULTIMO_PASSO = { pila: p, voce: voce, giro: GIRO_AZIONE, avanti: p.avanti.slice() };
  p.indietro.push(voce);
  p.giro = GIRO_AZIONE;
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

// LA CRONOLOGIA. I passi fatti (dal piu' vecchio) e quelli annullati (dal
// prossimo da rifare), col loro nome. E un salto: si torna al passo scelto
// annullando o rifacendo quanti passi servono, uno per uno, come fa Annulla.
function storiaSeq(p) {
  const q = seqDi(p);
  const st = PASSI.get(q.id) || { indietro: [], avanti: [] };
  const riga = (x) => ({ cosa: x.cosa || "Modifica", quando: x.quando || 0 });
  return { ok: true, fatti: st.indietro.map(riga), disfatti: st.avanti.slice().reverse().map(riga) };
}
function storiaVai(p) {
  const n = Math.round(+p.passi || 0);
  if (!n) return storiaSeq(p);
  let ultimo = null;
  for (let i = 0; i < Math.abs(n); i++) {
    const r = annullaSeq(p, n > 0);
    if (!r.ok) break;
    ultimo = r;
  }
  const s0 = storiaSeq(p);
  return { ok: true, seq: ultimo ? ultimo.seq : seqDi(p), fatti: s0.fatti, disfatti: s0.disfatti };
}
function annullaSeq(p, avanti) {
  const q = seqDi(p);
  const st = PASSI.get(q.id);
  const pila = avanti ? (st && st.avanti) : (st && st.indietro);
  if (!pila || !pila.length) {
    return { ok: false, errore: avanti ? "non c'e' niente da rifare" : "non c'e' altro da annullare" };
  }
  const altra = avanti ? st.indietro : st.avanti;
  const passo = pila.pop();
  // il passo cambia pila ma resta lui: col suo nome e la sua ora
  altra.push({ t: JSON.stringify(q), cosa: passo.cosa, quando: passo.quando });
  rimetti(q, passo.t);
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
// "G" e' la traccia delle grafiche e dei titoli, cioe' la V3 di Premiere;
// "C" quella dei sottotitoli. Hanno l'occhio e il lucchetto come le altre.
const TRACCE_V = ["V1", "V2", "G", "C"];
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
  // OGNI TRACCIA VA IN FILA PER CONTO SUO. Un pezzo su V2 sta SOPRA il
  // video, non dopo: impacchettarlo insieme agli altri lo spingeva in coda
  // al montato invece di lasciarlo dove si sovrappone.
  const fin = {};
  q.pezzi.forEach((x) => {
    const n = x.traccia || "V1";
    if (fin[n] === undefined) fin[n] = 0;
    x.t0 = Math.round(fin[n] * 1000) / 1000;
    fin[n] += Math.max(0, x.fuori - x.dentro);
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
  // il nero si mette dove manca il VIDEO DI BASE: sopra V2 c'e' quello che
  // c'e', e un buco su V2 non e' un buco nel montato
  q.pezzi.filter((x) => (x.traccia || "V1") === "V1").forEach((x) => {
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
                                   && !a.entra && !a.esce && !a.muto && !a.canale
                                   && !((a.volumi || []).length));
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
  const fineNota = (f.fine > dentro && isFinite(f.fine)) ? f.fine : Infinity;
  return ["-ss", String(f.dentro), "-i", f.via, "-t", String(Math.min(fuori, fineNota) - dentro)];
}

// l'onda di un file che sta gia' qui: si legge e basta, niente ponte
async function ondaDaFile(via, dentro, fuori, dove) {
  try { return JSON.parse(fs.readFileSync(dove, "utf8")); } catch (e) {}
  const db = await volumeAlSecondo(via, dentro, Math.max(1, Math.round(fuori - dentro)));
  if (!db.length) return null;
  const onda = db.map((v) => Math.max(0, Math.min(100, Math.round((v + 60) / 60 * 100))));
  try { fs.writeFileSync(dove, JSON.stringify(onda)); } catch (e) {}
  return onda;
}

async function calcolaOnda(reg, dentro, fuori) {
  const k = chiavePezzo(reg, dentro, fuori);
  const via = path.join(cartellaOnde(), k + ".json");
  try { return JSON.parse(fs.readFileSync(via, "utf8")); } catch (e) {}
  if (ONDE_IN_CORSO.has(k)) return null;
  ONDE_IN_CORSO.add(k);
  const lista = path.join(cartellaOnde(), k + ".txt");
  try {
    // SE IL FILE STA DIETRO IL PONTE, L'ONDA LA MISURA LA EC2. Tirare qui i
    // campioni grezzi di un pezzo vuol dire scaricarne l'audio da S3 —
    // centinaia di mega per disegnare una linea verde. A Parigi il file si
    // legge in regione e torna una lista di decibel: un kilobyte. Un valore
    // al secondo invece di dodici, quindi la forma e' piu' grossa, ma dice
    // lo stesso dove parla il telecronista e dove urla lo stadio, che e'
    // tutto quello che serve per tagliare e per mettere una dissolvenza.
    const reggi = R.reg[reg];
    const fonte = (reggi && reggi.arch) ? fonteAl(reggi, dentro) : null;
    if (fonte && fonte.via && pontePer(fonte.via)) {
      const db = await volumeAlSecondo(fonte.via, fonte.dentro, Math.max(1, Math.round(fuori - dentro)));
      if (!db.length) return null;
      // da decibel a zero-cento: sotto i -60 dB non c'e' niente da vedere
      const onda = db.map((v) => Math.max(0, Math.min(100, Math.round((v + 60) / 60 * 100))));
      try { fs.writeFileSync(via, JSON.stringify(onda)); } catch (e) {}
      return onda;
    }
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
    const dReg2 = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg)) : 0;
    const dur = dReg2 > 0 ? dReg2 : MAX_SECONDI;
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
  } else if (azione === "volume") {
    // LA LINEA DEL VOLUME. Il gain e' un numero solo per tutta la clip: va
    // bene per alzare una voce bassa, non per abbassare il campo mentre
    // parla il telecronista e rialzarlo sul boato. I punti dicono quanti
    // decibel a quale secondo DENTRO la clip, e in mezzo si interpola.
    const dur = Math.max(0.05, a.fuori - a.dentro);
    const punti = Array.isArray(p.punti) ? p.punti
      .map((k) => ({ t: num(k.t, 0, dur, 0), db: num(k.db, -60, 12, 0) }))
      .sort((x, y) => x.t - y.t).slice(0, 40) : [];
    if (punti.length) a.volumi = punti; else delete a.volumi;
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

// LA BASE DEI TEMPI DELLA SEQUENZA. Il timecode di Premiere ha i
// fotogrammi (HH:MM:SS:FF), e i fotogrammi dipendono dal materiale: il
// MultiCorder registra a 50, un file da telefono a 30. Si misura UNA volta
// sulla registrazione — pochi byte di intestazione, anche dall'archivio —
// e si ricorda. Finche' non si sa, la pagina non inventa: niente
// fotogrammi, solo i secondi.
const FPS_IN_CORSO = new Set();
function fpsDellaSeq(q) {
  const r = R.reg[q.reg]; if (!r) return 0;
  if (r.fps) return r.fps;
  if (!FPS_IN_CORSO.has(r.id)) {
    FPS_IN_CORSO.add(r.id);
    (async () => {
      let via = "";
      try {
        via = r.arch ? viaArchivio(r) : ((segmenti(r.id)[0] || {}).file || path.join(cartellaReg(r.id), "integrale.mp4"));
      } catch (e) {}
      const f = via ? await fpsDi(via) : 0;
      if (f) { r.fps = f; scrivi(); annuncia(0, "clip"); }
    })().catch(() => {}).then(() => FPS_IN_CORSO.delete(r.id));
  }
  return 0;
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
  // il MAM nuovo non ha banchi: chiede tutte le sequenze della partita
  const mie = (p && p.tutte) ? seq : seq.filter((q) => (q.auto && !q.banco) ||
                                (prog ? q.prog === prog : (!q.banco || q.banco === banco)));
  mie.forEach((q) => { try { crescoLaDiretta(q); } catch (e) {} });
  // prima si mettono in riga — cosi' l'audio c'e' — poi si guarda cosa e'
  // gia' in casa: al contrario si segnavano i pezzi di una sequenza che
  // l'audio non ce l'aveva ancora, e le onde risultavano sempre mancanti
  mie.forEach((q) => { try { riallinea(q); } catch (e) {} });
  mie.forEach((q) => { try { segnaPezziLocali(q); } catch (e) {} });
  mie.forEach((q) => { try { const f = fpsDellaSeq(q); if (f) q.fps = f; } catch (e) {} });
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
  // DUE GUASTI IN TRE RIGHE, e insieme distruggevano il pezzo invece di
  // rifiutare il gesto.
  //  1. Una partita che sta su S3 ha durata ZERO: nessuno l'ha misurata,
  //     perche' misurarla vorrebbe dire leggere il file. Zero finiva come
  //     limite superiore, e allora QUALUNQUE entrata o uscita veniva
  //     schiacciata a zero: bastava tirare il bordo di una clip e quella
  //     diventava 0 → 0. Non sapere quanto dura non vuol dire che duri
  //     niente.
  //  2. E il controllo "il pezzo diventerebbe vuoto" arrivava DOPO aver
  //     gia' scritto i nuovi valori: l'errore usciva, ma il pezzo restava
  //     rotto. Adesso si calcola a parte e si scrive solo se regge.
  const rPz = regDi(q, x);
  const dReg = rPz ? (rPz.durata || durataRegistrata(rPz.id)) : 0;
  const durata = dReg > 0 ? dReg : MAX_SECONDI;
  let nDentro = x.dentro, nFuori = x.fuori;
  if (p.dentro !== undefined) nDentro = num(p.dentro, 0, durata, x.dentro);
  if (p.fuori !== undefined) nFuori = num(p.fuori, 0, durata, x.fuori);
  if (nFuori - nDentro < 0.5) throw new Error("il pezzo diventerebbe vuoto: non c'e' piu' materiale da quella parte");
  x.dentro = nDentro; x.fuori = nFuori;
  if (p.titolo !== undefined) x.titolo = String(p.titolo).slice(0, 160);
  // LA VELOCITA'. Il posto che il pezzo occupa nel montato non cambia: e'
  // quanta azione ci entra dentro che cambia. A meta' velocita', in quattro
  // secondi di montato ci stanno due secondi di partita, visti al doppio del
  // tempo — che e' il replay al rallentatore. Fatta cosi', la lunghezza sulla
  // timeline resta "fuori meno dentro" dappertutto, e nessuno degli altri
  // conti della sequenza deve sapere che la velocita' esiste.
  // IL COLORE DEL PEZZO. Tre manopole, quelle che servono davvero su un
  // campo: quanta luce, quanto stacco fra chiaro e scuro, quanto colore.
  // Le partite arrivano da regie diverse e una accanto all'altra si vede.
  // DOVE STA IL RIQUADRO di un pezzo messo sopra: in frazioni del
  // fotogramma, cosi' vale uguale in 16:9 e in verticale.
  // LA TRANSIZIONE STA SULLO STACCO, e si tiene sul pezzo che entra: e'
  // l'unico modo perche' resti attaccata al taglio giusto quando i pezzi si
  // riordinano. Due sole, quelle che si usano: la dissolvenza incrociata e
  // il passaggio dal nero.
  if (p.transizione !== undefined) {
    const t0 = p.transizione || {};
    const d0 = num(t0.durata, 0, 5, 0);
    const tipo = String(t0.tipo || "dissolvenza") === "nero" ? "nero" : "dissolvenza";
    if (d0 < 0.06) delete x.transizione; else x.transizione = { tipo: tipo, durata: Math.round(d0 * 100) / 100 };
  }
  if (p.riquadro !== undefined) {
    const r0 = p.riquadro || {};
    x.riquadro = { x: num(r0.x, 0, 1, 0.66), y: num(r0.y, 0, 1, 0.62), w: num(r0.w, 0.1, 1, 0.3) };
  }
  if (p.traccia !== undefined) {
    const n = String(p.traccia);
    if (["V1", "V2"].indexOf(n) < 0) throw new Error("traccia video sconosciuta");
    x.traccia = n;
    if (n === "V2" && !x.riquadro) x.riquadro = { x: 0.66, y: 0.62, w: 0.3 };
    riallinea(q);
  }
  if (p.colore !== undefined) {
    const c = p.colore || {};
    const lum = num(c.lum, -0.5, 0.5, 0), con = num(c.con, 0.5, 2, 1), sat = num(c.sat, 0, 2.5, 1);
    if (Math.abs(lum) < 0.005 && Math.abs(con - 1) < 0.005 && Math.abs(sat - 1) < 0.005) delete x.colore;
    else x.colore = { lum: Math.round(lum * 1000) / 1000, con: Math.round(con * 1000) / 1000, sat: Math.round(sat * 1000) / 1000 };
  }
  if (p.velocita !== undefined) {
    const v = num(p.velocita, 0.2, 4, 1);
    if (Math.abs(v - 1) < 0.001) delete x.velocita; else x.velocita = Math.round(v * 100) / 100;
  }
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
  // UN PEZZO DI UN'ALTRA PARTITA si ricorda da dove viene. Senza, un pezzo
  // di Chelsea-Luton messo nella sequenza di Udinese-Como diventava
  // Udinese-Como allo stesso minuto: immagini, audio e sottotitoli sbagliati.
  if (r.id !== q.reg) { pezzo.reg = r.id; pezzo.partita = r.titolo || ""; }
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
  const k = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
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
  // nata dentro un progetto: la sequenza lo sa, e il progetto impara la partita
  if (p.prog && R.prog[String(p.prog)]) { q.prog = String(p.prog); const g = R.prog[q.prog]; g.reg = g.reg || []; if (g.reg.indexOf(r.id) < 0) g.reg.push(r.id); g.tocco = Date.now(); }
  R.seq[q.id] = q;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}
// una sequenza cambia progetto (o ne esce): serve al montaggio nuovo, che
// non ha il Progetto a sinistra come quello vecchio
function hlProgetto(p) {
  const q = seqDi(p);
  const prog = String(p.prog || "");
  if (prog) {
    const g = R.prog[prog];
    if (!g) throw new Error("progetto sconosciuto");
    q.prog = prog; g.reg = g.reg || []; if (g.reg.indexOf(q.reg) < 0) g.reg.push(q.reg); g.tocco = Date.now();
  } else delete q.prog;
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// L'ANNULLA. La pagina tiene lo storico della sequenza e, quando si torna
// indietro, manda qui l'intera lista dei pezzi com'era. Il server non
// ragiona: controlla che ogni pezzo abbia senso e la rimette cosi'.
// QUESTA FUNZIONE CANCELLAVA I MONTAGGI, e nel modo peggiore: senza dire
// niente e facendo finta di aver fatto il suo lavoro.
//
//  Riscrive la lista dei pezzi con quella che le arriva. Ma "Rinomina la
//  sequenza" manda soltanto il titolo — nessun pezzo — e la lista che
//  arrivava era VUOTA: q.pezzi = []. Rinominare un montaggio lo
//  svuotava. E il titolo non lo scriveva nemmeno: la funzione p.titolo non
//  l'ha mai letto. Quindi il gesto piu' innocuo che esista — dare un nome
//  a una selezione — buttava via il lavoro e non faceva quello che aveva
//  promesso. Cinque sequenze vuote in una settimana: tutte rinominate.
//
//  Adesso: si tocca solo quello che arriva davvero. I pezzi si riscrivono
//  SOLO se qualcuno li manda; il titolo, le maniglie, lo scarto e il
//  formato si scrivono quando ci sono. E prima di riscrivere i pezzi si
//  tiene da parte com'era, che Annulla li riporti indietro.
function hlImposta(p) {
  const q = seqDi(p);
  const durata = R.reg[q.reg] ? (R.reg[q.reg].durata || durataRegistrata(q.reg) || MAX_SECONDI) : MAX_SECONDI;
  if (p.titolo !== undefined) q.titolo = String(p.titolo).slice(0, 160);
  if (p.pre !== undefined) q.pre = num(p.pre, 0, 120, q.pre || HL_PRE);
  if (p.post !== undefined) q.post = num(p.post, 0, 120, q.post || HL_POST);
  if (p.scarto !== undefined) q.scarto = num(p.scarto, -600, 600, q.scarto || 0);
  if (p.formato !== undefined && FORMATI[String(p.formato)]) q.formato = String(p.formato);
  if (!Array.isArray(p.pezzi)) { scrivi(); annuncia(0, "clip"); return { ok: true, seq: q }; }
  const dati = p.pezzi;
  if (dati.length > 400) throw new Error("troppi pezzi");
  if (!dati.length && (q.pezzi || []).length) {
    throw new Error("per svuotare un montaggio si tolgono i pezzi uno a uno: cosi' non si fa");
  }
  ricorda(q);                       // com'era prima: Annulla lo riporta
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
  // IL GIRO: quale formato di quanti, e da quando. La pagina ne fa una
  // barra sola per tutto l'export, col tempo passato e quello che manca.
  const inizio = Date.now();
  for (let i = 0; i < formati.length; i++) {
    q.exportGiro = { i: i, n: formati.length, inizio: inizio };
    await hlEsportaVideo(q, formati[i], true, p2);
  }
  delete q.exportGiro;
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
// LA PARTITA DI UN PEZZO. Una sequenza nasce su una partita, e per quasi
// tutti i pezzi e' quella. Ma una gol collection prende da dieci partite
// diverse, e allora il pezzo se la porta dietro: x.reg. Dove non c'e',
// vale quella della sequenza — cosi' tutto il montato di prima resta
// esattamente com'era.
function regDi(q, x) { return R.reg[(x && x.reg) || q.reg] || null; }
function idRegDi(q, x) { return ((x && x.reg) || q.reg); }
// le partite che una sequenza tocca davvero
function regDellaSeq(q) {
  const vis = {};
  (q.pezzi || []).forEach((x) => { if (!x.media) vis[idRegDi(q, x)] = 1; });
  (q.audio || []).forEach((a) => { vis[idRegDi(q, a)] = 1; });
  vis[q.reg] = 1;
  return Object.keys(vis).filter((k) => R.reg[k]);
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

// ══════════ IL MATERIALE DI CASA ══════════
//  Fino a qui una sequenza era una finestra dentro UNA partita: ogni pezzo
//  diceva "da qui a qui" e il resto lo sapeva la registrazione. Ma un
//  montato vero ha anche le sigle, le grafiche in movimento, una clip
//  girata col telefono — roba che sta sulla VM e non dentro nessuna
//  partita. Adesso un pezzo puo' portarsi la SUA sorgente: se ce l'ha, non
//  si scarica niente perche' e' gia' qui, e dentro/fuori sono i secondi
//  dentro QUEL file.
// IL NOME DALLA CARTELLA. Le partite che Airtable non conosce (soloS3) un
// nome ce l'hanno: la cartella che chi le ha caricate ha scritto a mano,
// TEMP/giorno/NOME/... ("Red Bull Salzburg vs SK Puntigamer Sturm Graz",
// "COMO CUP", "FOOTBALL SHOW MONDAY NIGHT"). La lingua in coda (ITA, ENG)
// non e' il nome: e' la versione audio.
function nomeDaCartella(a) {
  if (!a) return "";
  const pz = String(a.dove || a.chiave || "").split("/");
  let n = (pz[0] === "TEMP" ? pz[2] : pz[pz.length - 2]) || "";
  n = n.replace(/\[[^\]]*\b(ITA|ENG|INT)\b[^\]]*\]/ig, "").replace(/[\s_-]+(ITA|ENG)$/i, "").replace(/\s+/g, " ").trim();
  return /^\d{6,8}$/.test(n) ? "" : n;
}
// UN NOME E' SICURO se l'abbinamento con Airtable e' certo, oppure se il
// tabellone letto sul video ha dato lo stesso risultato che dice il nome
// (o ESPN): calcolato qui e non scritto, cosi' lo scandaglio orario, che
// riscrive "sicuro", non puo' cancellarlo.
function nomeSicuro(a) {
  if (!a) return false;
  if (a.sicuro === true) return true;
  if (a.tabellone && a.tabellone.verificato) return true;
  if (a.riconosciuta && a.riconosciuta.sicura !== false && a.riconosciuta.confermata) return true;
  return false;
}
function puntata(a) {
  if (!a) return false;
  return !!(a.orologio || a.orologioFallito) && !!(a.boati || a.boatiFatti);
}
function cartellaMedia() {
  const d = (process.env.COMOTV_VIDEO || path.join(path.dirname(DIR), "video"));
  return d;
}
function mediaVia(x) {
  const f = x && x.media ? path.basename(String(x.media)) : "";
  if (!f || !/\.(mp4|mov|m4v)$/i.test(f)) return null;
  const via = path.join(cartellaMedia(), f);
  return fs.existsSync(via) ? via : null;
}
const DURATE_MEDIA = new Map();
function durataMedia(via) {
  if (DURATE_MEDIA.has(via)) return DURATE_MEDIA.get(via);
  let d = 0;
  try {
    const r = require("child_process").execFileSync(FFPROBE || "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", via],
      { timeout: 20000 });
    d = Math.max(0, parseFloat(String(r).trim()) || 0);
  } catch (e) { d = 0; }
  DURATE_MEDIA.set(via, d);
  return d;
}

function pezziDaScaricare(q) {
  // l'audio scollegato pesca da un altro punto della partita: quel pezzo
  // va portato in casa come gli altri, o all'esportazione non c'e'
  const tutti = (q.pezzi || []).concat((q.audio || []).filter((a) => !a.legato));
  const visti = {};
  return tutti.filter((x) => {
    if (mediaVia(x)) return false;          // ce l'ha gia' in casa: e' suo
    const k = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
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
  if (!R.reg[q.reg]) throw new Error("registrazione sconosciuta");
  // OGNI PARTITA CHE LA SEQUENZA TOCCA, non solo quella su cui e' nata:
  // in una gol collection i pezzi arrivano da dieci registrazioni diverse
  // e ognuna ha i suoi canali, i suoi segmenti, il suo file.
  for (const id of regDellaSeq(q)) await assicuraCanali(R.reg[id]);

  const daFare = pezziDaScaricare(q);
  let fatti = 0;
  const uno = async (x) => {
    if (mediaVia(x)) return;                // gia' in casa
    const r = regDi(q, x);
    if (!r) return;
    const segs = segmenti(r.id);
    const usaIntegrale = !segs.length;
    const integrale = r.arch ? viaArchivio(r) : path.join(cartellaReg(r.id), "integrale.mp4");
    if (usaIntegrale && !r.arch && !fs.existsSync(integrale)) throw new Error("di \"" + (r.titolo || r.id) + "\" non c'e' piu' materiale");
    const k = chiavePezzo(r.id, x.dentro, x.fuori);
    const fuoriFile = filePezzo(k);
    const parziale = fuoriFile.replace(/\.mp4$/, "-parte.mp4");
    let ingresso, lista = null, scarto = 0;
    if (usaIntegrale) {
      const f = (r && r.arch) ? fonteAl(r, x.dentro)
              : { via: integrale, dentro: x.dentro, fine: Infinity };
      // SE NON SI SA DOVE FINISCE IL PEZZO, NON SI ACCORCIA LA LETTURA.
      // I pezzi dell'archivio arrivano dall'inventario di S3 con la durata a
      // zero: nessuno l'ha misurata, e misurarla vorrebbe dire leggere il
      // file. Ma "durata zero" veniva letto come "finisce adesso", e allora
      // di un pezzo da sei secondi se ne chiedevano due decimi: ogni export
      // di una partita che sta su S3 usciva come un moncone da un secondo e
      // mezzo, senza un errore. Non sapere dove finisce vuol dire non
      // mettere un limite, non metterne uno a zero.
      const fineNota = (f.fine > x.dentro && isFinite(f.fine)) ? f.fine : Infinity;
      const quanto = Math.min(x.fuori, fineNota) - x.dentro;
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
    const mio = mediaVia(x);
    if (mio) { x.locale = "/video/" + path.basename(mio); x.scarto = 0; quanti++; return; }
    const k = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
    if (fs.existsSync(filePezzo(k))) {
      x.locale = viaPezzo(k);
      x.scarto = scartoPezzo(k);        // di quanto il file comincia prima
      quanti++;
    } else { delete x.locale; delete x.scarto; }
  });
  // e i pezzi audio: uno scollegato pesca da un altro punto della partita,
  // e per farlo sentire alla pagina serve il suo file, non quello del video
  (q.audio || []).forEach((a) => {
    const k = chiavePezzo(idRegDi(q, a), a.dentro, a.fuori);
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
    const suoP = a.legato ? (q.pezzi || []).filter((y) => y.id === a.legato)[0] : null;
    const mioA = mediaVia(suoP);
    const k = chiavePezzo(idRegDi(q, suoP || a), a.dentro, a.fuori);
    const casa = mioA || filePezzo(k);
    const dur = Math.max(0.05, a.fuori - a.dentro);
    // se il video sopra e' rallentato, il suo suono va steso insieme a lui:
    // se no la voce finisce prima delle immagini
    const suo = a.legato ? (q.pezzi || []).filter((y) => y.id === a.legato)[0] : null;
    const velA = (suo && +suo.velocita) || 1;
    const idx = iBase + n;
    // SE IN CASA NON C'E', SI VA A PRENDERLO DOVE STA. Prima un pezzo audio
    // che non fosse gia' sul disco veniva semplicemente saltato: il mix
    // usciva senza quella voce, e senza dirlo. Oggi l'esportazione porta in
    // casa da sola prima di montare, quindi non capitava — ma era una
    // dipendenza implicita fra due passaggi lontani, e un montato muto te ne
    // accorgi quando e' gia' online.
    let off = 0;
    if (fs.existsSync(casa)) {
      off = mioA ? a.dentro : scartoPezzo(k);
      ingressi.push("-ss", String(off), "-t", String(Math.max(0.05, dur * velA)), "-i", casa);
    } else {
      const rq = R.reg[q.reg];
      const f = rq && rq.arch ? fonteAl(rq, a.dentro)
              : { via: path.join(cartellaReg(q.reg), "integrale.mp4"), dentro: a.dentro };
      if (!f || !f.via || (!rq.arch && !fs.existsSync(f.via))) { saltati++; return; }
      ingressi.push("-ss", String(f.dentro), "-t", String(Math.max(0.05, dur * velA)), "-i", f.via);
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
    // atempo tiene solo da 0.5 a 2: fuori di li' si incatena piu' passaggi
    if (velA !== 1) {
      let resta = velA;
      while (resta < 0.5) { f += ",atempo=0.5"; resta /= 0.5; }
      while (resta > 2) { f += ",atempo=2"; resta /= 2; }
      if (Math.abs(resta - 1) > 0.001) f += ",atempo=" + resta.toFixed(4);
    }
    const g = (a.gain || 0) + (t.gain || 0);
    // con i punti il volume si muove nel tempo: si scrive l'espressione a
    // tratti (la stessa macchina del ritaglio verticale) e la si rivaluta a
    // ogni fotogramma. In decibel dentro, lineare fuori, perche' il filtro
    // volume di ffmpeg accetta il suffisso dB solo per le costanti.
    const curva = (a.volumi || []).length >= 2
      ? espressioneDi((a.volumi || []).map((k) => ({ t: k.t, db: (k.db || 0) + (t.gain || 0) })),
                      "db", 0, (v) => Number(v).toFixed(2))
      : null;
    if (curva) f += ",volume=volume='pow(10\\," + "(" + curva + ")/20)':eval=frame";
    else if (g) f += ",volume=" + g.toFixed(2) + "dB";
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


// per UNA SEQUENZA: i pezzi stanno sulla timeline uno dopo l'altro (o dove
// li ha messi chi monta, col nero nei buchi): ogni pezzo porta le sue righe
// spostate al suo posto. Stessa aritmetica del montaggio, se no non torna.
async function righeDellaSequenza(q, lingua) {
  normalizzaSeq(q);
  let orologio = 0; const tutte = [];
  for (const x of q.pezzi) {
    const parte = Math.max(orologio, x.t0 || 0), dur = Math.max(0, x.fuori - x.dentro);
    // OGNI PEZZO PARLA CON LA SUA PARTITA: in una gol collection il pezzo
    // di Como-Lazio portava le righe di Como-Genoa (quelle di q.reg), nello
    // stesso punto del file. E a meta' velocita' ci sta meta' partita, e
    // ogni riga dura il doppio: stessa aritmetica dei marcatori.
    const vel = +x.velocita || 1, reg = idRegDi(q, x);
    if (!x.vivo && !x.media) (await righeTradotte(reg, lingua, x.dentro, x.dentro + dur * vel, 0, R.reg[reg])).forEach((y) => {
      y.a = Math.round((parte + y.a / vel) * 1000) / 1000; y.b = Math.round((parte + y.b / vel) * 1000) / 1000;
      tutte.push(y);
    });
    orologio = parte + dur;
  }
  return tutte;
}
async function scriviSrtSequenza(q, v, conAss) {
  const blocchi = [];
  for (const l of lingueSotto(v, q.reg)) blocchi.push({ lingua: l, righe: await righeDellaSequenza(q, l) });
  if (!blocchi.some((b) => b.righe.length)) throw new Error("sottotitoli chiesti, ma la telecronaca di questi pezzi non e' trascritta (Telecronaca \u2192 trascrivi)");
  assicura(path.join(DIR, CARTELLA_HL));
  const files = blocchi.filter((b) => b.righe.length).map((b) => {
    fs.writeFileSync(path.join(DIR, CARTELLA_HL, q.id + "." + b.lingua + ".srt"), testoSrt(b.righe));
    return { lingua: b.lingua, file: "/clip/" + CARTELLA_HL + "/" + q.id + "." + b.lingua + ".srt",
             nome: nomeScaricoSeq(q, R.reg[q.reg], "", "." + b.lingua + ".srt"), righe: b.righe.length };
  });
  q.sottotitoli = { stato: "pronto", file: files[0].file, nome: files[0].nome, files, lingue: files.map((f) => f.lingua),
                    lingua: files[0].lingua, righe: files.reduce((n, f) => n + f.righe, 0),
                    mancano: blocchi.reduce((n, b) => n + b.righe.filter((x) => x.manca).length, 0), quando: Date.now() };
  scrivi(); annuncia(0, "clip");
  let ass = "";
  if (conAss) { ass = path.join(DIR, CARTELLA_HL, q.id + ".ass"); fs.writeFileSync(ass, testoAss(blocchi)); }
  return { via: ass, blocchi };
}

async function hlEsportaVideo(q, formato, dentroUnGiro, p2) {
  const dir = path.join(DIR, CARTELLA_HL, q.id);
  assicura(dir);
  if (!q.pezzi.length) throw new Error("nessun pezzo da esportare");
  // L'OCCHIO SPENTO VALE ANCHE NELL'EXPORT. Una traccia nascosta in
  // Premiere non esce: qui era un interruttore che si ricordava e basta.
  const trV = tracceDi(q);
  const grafiche0 = trV.G.muto ? [] : (q.grafiche || []).filter((g) => {
    try { return fs.existsSync(path.join(cartellaGrafiche(), g.id + ".png")); } catch (e) { return false; }
  });
  const v1Spenta = !!trV.V1.muto;
  const adattate = [];               // grafiche senza la versione per questo formato

  await assicuraCanali(R.reg[q.reg]);
  const ritaglio = (FORMATI[formato] || FORMATI["16:9"]).vf;
  q.export = { stato: "lavora", formato: formato, fatti: 0, quanti: q.pezzi.length, file: "",
               fase: "porto in casa i pezzi", tutti: !!dentroUnGiro, avanza: 0,
               inizio: Date.now(), giro: dentroUnGiro && q.exportGiro ? q.exportGiro : null };
  scrivi(); annuncia(0, "clip");

  // PRIMO: i pezzi in casa. Se ci sono gia' non si scarica niente; se
  // mancano si scaricano una volta e restano.
  const esito = await costruisciPezzi(q, (f, n) => {
    q.export.fatti = f; q.export.quanti = n || q.pezzi.length;
    q.export.fase = "porto in casa i pezzi";
    q.export.avanza = n ? f / n * 0.25 : 0.25;
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
      q.export.avanza = 0.25 + 0.1 * (i / daFare.length);
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
  // i sottotitoli seguono il secondo della timeline: col taglio veloce i
  // pezzi cominciano fino a un secondo prima e si sfasano. Con i
  // sottotitoli si taglia esatto, e per imprimerli si ricodifica comunque.
  const sottoV = vuoleSotto(p2);
  const srtSeq = (sottoV.file || sottoV.video) ? await scriviSrtSequenza(q, sottoV, !!sottoV.video) : null;
  // la traccia dei sottotitoli nascosta: il file SRT esce, impressi no
  const brucia = !!(sottoV.video && srtSeq) && !tracceDi(q).C.muto;
  const rallentati = (q.pezzi || []).some((x) => (+x.velocita && +x.velocita !== 1) || x.colore || (x.traccia || "V1") === "V2");
  // le transizioni vogliono che i pezzi si SOVRAPPONGANO: incollare e basta
  // non basta piu', e ogni pezzo dev'essere tagliato esatto
  const conFusione = (q.pezzi || []).some((x, i) => i > 0 && (x.traccia || "V1") !== "V2" && x.transizione && +x.transizione.durata > 0.06);
  // un file di casa non e' codificato come i pezzi della partita: incollarli
  // e basta vorrebbe dire pretendere che abbiano lo stesso codificatore
  const conMedia = (q.pezzi || []).some((x) => !!mediaVia(x));
  let veloce = (p2 && p2.esatto) || srtSeq || v1Spenta ? false : (!ritaglio && !grafiche0.length && !mixato && !buchi.length && !rallentati && !conFusione && !conMedia);
  const dir2 = path.join(dir, "tagli");
  assicura(dir2);
  const parti = [];
  let orologio = 0;                     // dove siamo arrivati sulla timeline
  const sopra = trV.V2.muto ? [] : (q.pezzi || []).filter((x) => (x.traccia || "V1") === "V2");
  const base = (q.pezzi || []).filter((x) => (x.traccia || "V1") !== "V2");
  // LA STRADA VELOCE INCOLLA I PEZZI COM'E' IL FILE, e il file in casa
  // comincia PRIMA del taglio: il ritaglio in copia parte dal fotogramma
  // chiave precedente, e quel secondo di rincorsa serve a riprodurlo
  // esatto. Incollandolo cosi' finiva nel montato: ogni clip partiva un
  // secondo prima di dove l'avevi tagliata, e il montato usciva piu' lungo
  // di quello che avevi fatto (148,9 s diventavano 151,3). Se anche un
  // pezzo solo ha la rincorsa, si ricodifica e si taglia esatto: meglio
  // qualche minuto di macchina che un gol che comincia prima.
  if (veloce && base.some((x) => {
    if (mediaVia(x)) return (x.dentro || 0) > 0.04;
    const k = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
    return fs.existsSync(filePezzo(k)) && scartoPezzo(k) > 0.04;
  })) veloce = false;
  for (let i = 0; i < base.length; i++) {
    const x = base[i];
    const mio = mediaVia(x);
    const k = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
    const casa = mio || filePezzo(k);
    if (!fs.existsSync(casa)) continue;
    // il buco davanti a questo pezzo: nero, per la durata giusta
    if ((x.t0 || 0) > orologio + 0.04) { parti.push({ vuoto: (x.t0 || 0) - orologio }); }
    orologio = Math.max(orologio, (x.t0 || 0) + (x.fuori - x.dentro));
    const off = mio ? x.dentro : scartoPezzo(k), dur = x.fuori - x.dentro;
    // l'inquadratura di QUESTO pezzo: se ha i suoi punti, il ritaglio segue
    const ritaglioQui = ritaglioDelPezzo(formato, x.inquadra && x.inquadra[formato]);
    if (veloce) { parti.push({ file: casa }); q.export.fatti = i + 1; q.export.fase = "preparo"; continue; }
    const esatto = path.join(dir2, "p" + String(i + 1).padStart(3, "0") + ".mp4");
    // A META' VELOCITA' SI LEGGE META' SORGENTE. Non serve dirlo a ffmpeg:
    // "-t" dopo "-i" limita l'USCITA, e con setpts che stende i tempi
    // ffmpeg legge da solo quanta sorgente gli serve per riempire quei
    // secondi. Scriverlo sull'ingresso tagliava il montato a meta'.
    const vel = +x.velocita || 1;
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", String(off), "-i", casa, "-t", String(dur)];
    // se il pezzo comincia gia' dove deve, si copia e basta: niente da fare
    const copiabile = off < 0.08 && !ritaglioQui && vel === 1 && !x.colore && !v1Spenta;
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args.concat(copiabile
        ? ["-c", "copy", "-movflags", "+faststart", "-y", esatto]
        // lanczos va IN CODA alla scala, non in testa: scritto davanti
        // ffmpeg lo prendeva come unico argomento e l'ingrandimento saltava,
        // e il verticale usciva 608x1080 invece di 1080x1920
        : (function(){
            const filtri = [];
            if (vel !== 1) filtri.push("setpts=PTS/" + vel.toFixed(4));
            if (x.colore) filtri.push("eq=brightness=" + (x.colore.lum || 0).toFixed(3) +
                                      ":contrast=" + (x.colore.con || 1).toFixed(3) +
                                      ":saturation=" + (x.colore.sat || 1).toFixed(3));
            if (ritaglioQui) filtri.push(ritaglioQui.replace(/(scale=\d+:\d+)/, "$1:flags=lanczos"));
            // V1 nascosta: sotto non c'e' niente, quindi nero — l'audio resta
            if (v1Spenta) filtri.push("drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill");
            return filtri.length ? ["-vf", filtri.join(",")] : [];
          })()
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
    q.export.avanza = 0.35 + 0.25 * ((i + 1) / q.pezzi.length);
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

  // ── LE TRANSIZIONI ────────────────────────────────────────────────
  //  Incollare mette il primo fotogramma del pezzo dopo subito dopo
  //  l'ultimo di quello prima. Una dissolvenza invece li fa vivere insieme
  //  per un secondo, quindi il montato si ACCORCIA di quel secondo: il
  //  materiale non si inventa, i due pezzi si sovrappongono.
  //  Si costruisce un file unito con xfade e si rimette al posto della
  //  lista: da qui in poi tutto il resto dell'export non cambia di una
  //  riga, e non c'e' un secondo posto dove le cose possono rompersi.
  if (conFusione && parti.length > 1 && !buchi.length) {
    q.export.fase = "sfumo gli stacchi";
    scrivi(); annuncia(0, "clip");
    // QUANTO OCCUPA UN PEZZO NEL MONTATO: "fuori meno dentro", e basta.
    // La velocita' non allunga il posto, cambia quanta partita ci sta
    // dentro (mezza velocita' = meta' materiale, stessa lunghezza sulla
    // timeline). Dividendo per la velocita' la dissolvenza successiva
    // veniva chiesta a un secondo che nel file non esiste.
    const durataDi = (i) => Math.max(0.2, base[i].fuori - base[i].dentro);
    // E GLI INGRESSI VANNO PAREGGIATI. xfade pretende che i due pezzi
    // abbiano la stessa misura, gli stessi fotogrammi al secondo e la
    // stessa base dei tempi: una sigla girata col telefono ha 1/12800
    // dove un taglio di partita ha 1/50000, e ffmpeg si rifiutava di
    // comporli — "Nothing was written into output file", cioe' export
    // fallito senza dire perche'. Si pareggia tutto sul primo pezzo.
    const mis0 = await probeMisure(parti[0].file);
    const LW = mis0.w || 1920, LH2 = mis0.h || 1080;
    const FPS = (await fpsDi(parti[0].file)) || 25;
    const ingr = [];
    parti.forEach((z) => ingr.push("-i", z.file));
    const fv = [], fa = [];
    for (let i = 0; i < parti.length; i++) {
      fv.push("[" + i + ":v]fps=" + FPS + ",scale=" + LW + ":" + LH2 +
              ":force_original_aspect_ratio=decrease:flags=lanczos,pad=" + LW + ":" + LH2 +
              ":(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p,settb=1/90000,setpts=PTS-STARTPTS[n" + i + "v]");
      fa.push("[" + i + ":a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[n" + i + "a]");
    }
    let uv = "n0v", ua = "n0a", lungo = durataDi(0);
    for (let i = 1; i < parti.length; i++) {
      const tr = base[i] && base[i].transizione;
      const suo = durataDi(i);
      let D = tr && +tr.durata > 0.06 ? +tr.durata : 0;
      D = Math.min(D, suo - 0.2, lungo - 0.2);
      const uscV = "v" + i, uscA = "a" + i;
      if (D > 0.06) {
        const come = tr.tipo === "nero" ? "fadeblack" : "fade";
        fv.push("[" + uv + "][n" + i + "v]xfade=transition=" + come + ":duration=" + D.toFixed(2) +
                ":offset=" + (lungo - D).toFixed(2) + "[" + uscV + "]");
        fa.push("[" + ua + "][n" + i + "a]acrossfade=d=" + D.toFixed(2) + ":c1=tri:c2=tri[" + uscA + "]");
        lungo = lungo + suo - D;
      } else {
        fv.push("[" + uv + "][n" + i + "v]concat=n=2:v=1:a=0[" + uscV + "]");
        fa.push("[" + ua + "][n" + i + "a]concat=n=2:v=0:a=1[" + uscA + "]");
        lungo = lungo + suo;
      }
      uv = uscV; ua = uscA;
    }
    const unito = path.join(dir2, "unito.mp4");
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(ingr).concat([
        "-filter_complex", fv.concat(fa).join(";"),
        "-map", "[" + uv + "]", "-map", "[" + ua + "]",
        "-c:v", "libx264", "-preset", CACHE_PRESET, "-crf", CACHE_CRF, "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", "-y", unito]),
        { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1200); });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("sfumature " + code))));
    });
    fs.writeFileSync(listaFin, "file '" + unito + "'\n");
    console.log("[clip] esporto \"" + (q.titolo || q.id) + "\": stacchi sfumati, il montato dura " + Math.round(lungo) + "s");
  }
  q.export.avanza = 0.6;
  q.export.fase = grafiche.length ? "incollo le grafiche" : (veloce ? "monto" : "monto");
  scrivi(); annuncia(0, "clip");

  // UN PEZZO SOPRA VA COMPOSTO, non incollato. Senza questo l'export
  // prendeva la strada corta — copiare il video e basta — e il riquadro nel
  // riquadro spariva in silenzio: il montato usciva, solo senza.
  const soloIncollare = !grafiche.length && !mixato && !brucia && !sopra.length;
  if (soloIncollare) {
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "concat", "-safe", "0", "-i", listaFin, "-c", "copy",
        "-movflags", "+faststart", "-y", finale], { stdio: "ignore" });
      pr.on("error", no);
      pr.on("close", (code) => code === 0 ? si() : no(new Error("incollatura fallita")));
    });
  } else if (mixato && !grafiche.length && !brucia && !sopra.length) {
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
    // I PEZZI SOPRA (V2). Vanno prima delle grafiche, perche' una grafica
    // deve poter stare anche sopra di loro. Ognuno entra come un ingresso
    // suo, si rimpicciolisce al riquadro che gli e' stato dato e si sposta
    // nel tempo con setpts: l'enable da solo non basterebbe, farebbe
    // comparire il primo fotogramma del pezzo invece di quello giusto.
    {
      sopra.forEach((x, j) => {
        const k2 = chiavePezzo(idRegDi(q, x), x.dentro, x.fuori);
        const casa2 = filePezzo(k2);
        if (!fs.existsSync(casa2)) return;
        const off2 = scartoPezzo(k2), dur2 = Math.max(0.2, x.fuori - x.dentro);
        const v2 = +x.velocita || 1;
        ingressi.push("-ss", String(off2), "-t", String(dur2 * v2), "-i", casa2);
        const n2 = ingressi.filter((z) => z === "-i").length;   // il suo numero d'ingresso
        const rq = x.riquadro || { x: 0.66, y: 0.62, w: 0.3 };
        const w2 = Math.max(2, Math.round(VW * Math.min(1, rq.w) / 2) * 2);
        const px = Math.round(VW * Math.min(1, rq.x)), py = Math.round(VH * Math.min(1, rq.y));
        const a2 = (x.t0 || 0), b2 = a2 + dur2;
        let f2 = "[" + n2 + ":v]scale=" + w2 + ":-2:flags=lanczos";
        if (v2 !== 1) f2 += ",setpts=PTS/" + v2.toFixed(4);
        if (x.colore) f2 += ",eq=brightness=" + (x.colore.lum || 0).toFixed(3) +
                            ":contrast=" + (x.colore.con || 1).toFixed(3) +
                            ":saturation=" + (x.colore.sat || 1).toFixed(3);
        f2 += ",setpts=PTS+" + a2.toFixed(3) + "/TB[s" + j + "];";
        const usc2 = "s" + j + "o";
        catena += f2 + "[" + ultimo + "][s" + j + "]overlay=" + px + ":" + py +
                  ":enable='between(t," + a2.toFixed(2) + "," + b2.toFixed(2) + ")'" +
                  ":eof_action=pass:format=auto[" + usc2 + "];";
        ultimo = usc2;
      });
    }
    // QUALE STRATO PER OGNI GRAFICA, IN QUESTO FORMATO. La versione fatta per
    // questo formato se c'e'; il titolo ridisegnato nativo (lo scriviamo
    // noi); altrimenti l'originale adattato — e allora lo si dice, perche'
    // un sottopancia 16:9 dentro un verticale non e' quello che si voleva.
    const strati = [];
    for (const g of grafiche) {
      const st = await stratoPerFormato(g, formato);
      if (st.adattata) adattate.push(g.nome || "grafica");
      strati.push(st);
    }
    {
      const dopoW = VW, dopoH = VH;
      grafiche.forEach((g0, i) => {
        const g = strati[i];
        ingressi.push("-i", g.file);
        const nG = ingressi.filter((z) => z === "-i").length;
        const kk = Math.min(dopoW / (g.w || dopoW), dopoH / (g.h || dopoH));
        const w2 = Math.max(2, Math.round((g.w || dopoW) * kk / 2) * 2);
        const h2 = Math.max(2, Math.round((g.h || dopoH) * kk / 2) * 2);
        const x = Math.round((dopoW - w2) / 2), y = Math.round((dopoH - h2) / 2);
        const usc = (i === grafiche.length - 1) ? "v" : ("g" + i + "o");
        catena += "[" + nG + ":v]scale=" + w2 + ":" + h2 + "[g" + i + "];" +
                  "[" + ultimo + "][g" + i + "]overlay=" + x + ":" + y +
                  ":enable='between(t," + g0.dentro.toFixed(2) + "," + g0.fuori.toFixed(2) + ")'" +
                  ":format=auto[" + usc + "];";
        ultimo = usc;
      });
    }
    // i sottotitoli impressi vanno per ultimi: sopra le grafiche, sul
    // formato che esce davvero
    if (brucia) { catena += "[" + ultimo + "]" + filtroSottotitoli(srtSeq.via) + "[sot];"; ultimo = "sot"; }
    catena = catena.replace(/;$/, "");
    // l'audio: quello del video se nessuno l'ha toccato, il mix se invece
    // c'e' un montaggio sonoro sotto
    const mix = mixato ? costruisciMix(q, ingressi.filter((z) => z === "-i").length + 1) : null;
    const catenaTutta = catena + (mix && !mix.muta ? ";" + mix.catena.replace(/;$/, "") : "");
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(CON_PROGRESSO).concat([
      "-f", "concat", "-safe", "0", "-i", listaFin]).concat(ingressi)
      .concat(mix && !mix.muta ? mix.ingressi : []).concat([
      "-filter_complex", catenaTutta, "-map", "[" + ultimo + "]"])
      .concat(mix ? (mix.muta ? ["-an"] : ["-map", "[amix]"]) : ["-map", "0:a?"]).concat([
      "-c:v", "libx264", "-preset", CACHE_PRESET, "-crf", CACHE_CRF, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-y", finale]);
    // IL PASSAGGIO LUNGO SI MISURA: e' qui che se ne va il grosso del
    // tempo, e con la barra ferma al 92% sembrava che l'export fosse morto.
    // ffmpeg dice quanti secondi ha scritto; la sequenza quanti ne ha.
    const totale = Math.max(1, (q.pezzi || []).reduce((m, x) => Math.max(m, (x.t0 || 0) + Math.max(0, x.fuori - x.dentro)), 0));
    let ultimoAnnuncio = 0;
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      let coda = "";
      pr.stderr.on("data", (d) => {
        // le righe chiave=valore sono il progresso: per l'errore si tiene il resto
        coda = (coda + String(d).replace(/^[a-z_0-9]+=\S*\r?$/gm, "")).replace(/\n{2,}/g, "\n").slice(-1500);
        const sec = secondiScritti(String(d));
        if (sec !== null) {
          q.export.avanza = Math.max(q.export.avanza || 0, 0.6 + 0.39 * Math.min(1, sec / totale));
          if (Date.now() - ultimoAnnuncio > 1000) { ultimoAnnuncio = Date.now(); annuncia(0, "clip"); }
        }
      });
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
  if (adattate.length) console.log("[clip] export " + formato + ": grafiche senza la loro versione, adattate: " + adattate.join(", "));
  q.esportati[formato] = {
    adattate: adattate.slice(0, 20),
    file: "/clip/" + CARTELLA_HL + "/" + q.id + suffisso + ".mp4",
    durata: d.durata ? Math.round(d.durata * 10) / 10 : 0, peso: d.peso || 0,
    // l'istante serve alla pagina per accorgersi che questa e' un'uscita
    // NUOVA: rifacendo lo stesso formato il nome del file non cambia, e
    // senza un istante l'avviso "pronto" non scattava piu'
    quando: Date.now(), copiato: soloIncollare, veloce: veloce, sottoImpressi: brucia
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

// IL VOLUME DEL MONTATORE. L'XML dichiara dove sta ogni file. Finora
// dichiarava il nome e basta: Premiere apriva la sequenza con tutte le
// clip OFFLINE e il montatore doveva ricollegarne una a mano. Ma il
// magazzino il montatore ce l'ha montato sul suo Mac — la QNAP e'
// "COMOTV - VOD" — e allora basta dirgli dove: si scrive il percorso
// vero e la sequenza si apre gia' attaccata al materiale. Per le partite
// che stanno sulla NAS si scrive la chiave intera (le cartelle sono
// quelle); per le altre il nome del file, che il montatore ha scaricato.
// ══════════════════════════════════════════════════════════════════════
//  IMPORTARE UN XML — e ritrovare i file nell'archivio
// ══════════════════════════════════════════════════════════════════════
//
//  Un montatore ha una sequenza in Premiere e la vuole qui: la esporta in
//  XML e la porta dentro. L'XML pero' dice dove stavano i file sul SUO
//  computer, e quei percorsi qui non esistono.
//
//  Non importa: il nome del file lo sappiamo leggere, e l'archivio quei
//  nomi ce li ha tutti — le chiavi dei magazzini, i pezzi delle partite
//  intere, il materiale di casa. Quindi si prende il nome, si cerca, e la
//  sequenza si ricostruisce ATTACCATA al nostro materiale: i tagli sono
//  quelli, i secondi sono quelli, ma quello che si vede viene da qui.
//
//  Quello che non si trova non si inventa: si dice quale file manca, per
//  nome, e la sequenza entra lo stesso con i pezzi che abbiamo.
function xmlBlocchi(testo, tag) {
  const fuori = [], re = new RegExp("<" + tag + "\\b[^>]*>[\\s\\S]*?</" + tag + ">", "g");
  let m; while ((m = re.exec(testo))) fuori.push(m[0]);
  return fuori;
}
function xmlDentro(blocco, tag) {
  const m = new RegExp("<" + tag + "\\b[^>]*>([\\s\\S]*?)</" + tag + ">").exec(blocco || "");
  return m ? m[1] : "";
}
function xmlTesto(blocco, tag) {
  const v = xmlDentro(blocco, tag).trim();
  return v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function xmlNum(blocco, tag) { const v = parseFloat(xmlTesto(blocco, tag)); return isNaN(v) ? null : v; }
function xmlId(blocco) { const m = /\bid="([^"]+)"/.exec(blocco || ""); return m ? m[1] : ""; }
// il nome del file, da <name> o dall'indirizzo, senza cartelle e senza %20
function nomeDaXml(bl) {
  let n = xmlTesto(bl, "name");
  const u = xmlTesto(bl, "pathurl");
  if (!n && u) { try { n = decodeURIComponent(u); } catch (e) { n = u; } n = n.split("/").pop(); }
  return String(n || "").trim();
}
// UN NOME SI RICONOSCE ANCHE SE QUALCUNO L'HA TOCCATO: via l'estensione,
// via i doppi spazi, tutto minuscolo. Un file rinominato "copia 2" non si
// riconosce, e va bene cosi': meglio dire che manca che attaccare il video
// sbagliato a un montaggio.
function nomePiatto(n) {
  return String(n || "").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}
// (il nome cercaNellArchivio era gia' preso: quella cerca le partite per
// parole, questa cerca UN FILE per nome. Due mestieri diversi.)
function cercaFileNellArchivio(nome) {
  const piatto = nomePiatto(nome);
  if (!piatto) return null;
  // prima il materiale di casa: e' piccolo e i nomi sono esatti
  try {
    for (const f of fs.readdirSync(cartellaMedia())) {
      if (nomePiatto(f) === piatto) return { media: f };
    }
  } catch (e) {}
  // poi le partite: la chiave del magazzino, o uno dei pezzi
  for (const rec of Object.keys(ARCHIVIO)) {
    const a = ARCHIVIO[rec];
    const pz = (a.pezzi && a.pezzi.length) ? a.pezzi : (a.chiave ? [{ chiave: a.chiave, da: 0 }] : []);
    for (const x of pz) {
      if (nomePiatto(path.basename(x.chiave || "")) === piatto) {
        return { rec: rec, da: x.da || 0, chiave: x.chiave };
      }
    }
  }
  return null;
}
async function hlImportaXml(p) {
  const testo = String(p.xml || "");
  if (testo.length < 40 || testo.indexOf("<") < 0) throw new Error("questo non sembra un XML");
  if (/<fcpxml/i.test(testo)) {
    throw new Error("questo e' FCPXML di Final Cut X: da Premiere scegli \"Final Cut Pro XML\" (quello vecchio), che e' quello che leggiamo");
  }
  // i file dichiarati, per id: dopo la prima volta l'XML li richiama vuoti
  const file = {};
  xmlBlocchi(testo, "file").forEach((bl) => {
    const id = xmlId(bl); if (!id) return;
    const nome = nomeDaXml(bl);
    if (!nome && file[id]) return;
    const tb = xmlNum(bl, "timebase");
    file[id] = { nome: nome, fps: tb && tb > 4 ? tb : 0 };
  });
  const fpsSeq = (function(){ const t = xmlNum(xmlDentro(testo, "sequence"), "timebase"); return t && t > 4 ? t : 25; })();
  // LE CLIP VIDEO, e qui c'era la trappola: dentro OGNI file c'e' un altro
  // <media><video>, quindi tagliare il documento al primo </video> tagliava
  // in mezzo alla prima clip e non si trovava piu' niente. Si prendono
  // tutte le clip e si scartano quelle audio, che lo dicono da sole.
  const voci = [];
  xmlBlocchi(testo, "clipitem").forEach((bl) => {
    // il tipo e' quello della clip, non quello dei suoi collegamenti: una
    // clip video porta dentro i <link> alle sue due tracce audio, e
    // guardando tutto il blocco sembrava audio anche lei
    if (/<mediatype>\s*audio\s*<\/mediatype>/i.test(bl.split("<link")[0])) return;
    const idf = (function(){ const f = /<file\b[^>]*\bid="([^"]+)"/.exec(bl); return f ? f[1] : ""; })();
    const f = file[idf] || { nome: nomeDaXml(xmlDentro(bl, "file")), fps: 0 };
    const fps = f.fps || xmlNum(bl, "timebase") || fpsSeq;
    const dentro = xmlNum(bl, "in"), fuori = xmlNum(bl, "out"), start = xmlNum(bl, "start");
    if (dentro === null || fuori === null || fuori <= dentro) return;
    if (start === null || start < 0) return;             // dentro una transizione: lo rifa' chi monta
    voci.push({ nome: f.nome, titolo: xmlTesto(bl, "name") || f.nome,
                dentro: dentro / fps, fuori: fuori / fps, t0: start / fpsSeq });
  });
  if (!voci.length) throw new Error("nell'XML non ho trovato nessuna clip video");
  // dove stanno, da noi
  const mancanti = [], trovate = [];
  const conta = {};
  voci.forEach((v) => {
    const dove = cercaFileNellArchivio(v.nome);
    if (!dove) { if (mancanti.indexOf(v.nome) < 0) mancanti.push(v.nome); return; }
    v.dove = dove; trovate.push(v);
    if (dove.rec) conta[dove.rec] = (conta[dove.rec] || 0) + 1;
  });
  if (!trovate.length) {
    throw new Error("nessuno dei file dell'XML sta nell'archivio: " + voci.slice(0, 3).map((v) => v.nome).join(", "));
  }
  // UNA SEQUENZA, DIECI PARTITE. La gol collection della stagione prende
  // da dieci partite diverse: si apre ognuna e ogni pezzo si porta dietro
  // la sua. Quella "della sequenza" resta la piu' presente, che e' quella
  // su cui si apre il monitor, ma non comanda piu' sul materiale.
  const rec = Object.keys(conta).sort((a, b) => conta[b] - conta[a])[0] || "";
  const regDiRec = {};
  for (const k of Object.keys(conta)) {
    let rr = Object.keys(R.reg).map((z) => R.reg[z]).find((x) => x.arch && x.arch.rec === k);
    if (!rr) { const ap = await archivioApri({ rec: k }); rr = ap && ap.reg; }
    if (rr) regDiRec[k] = R.reg[rr.id] || rr;
  }
  const reg = regDiRec[rec] || null;
  if (!reg) throw new Error("i file ci sono ma non riesco ad aprire la partita a cui appartengono");
  const q = { id: nuovoId("s"), reg: reg.id, libera: true,
              titolo: String(p.titolo || "").slice(0, 160) || ("IMPORTATA " + (reg.titolo || "")),
              pezzi: [], grafiche: [], audio: [], pre: HL_PRE, post: HL_POST, scarto: 0, avvisi: [],
              creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null };
  if (p.prog && R.prog[String(p.prog)]) q.prog = String(p.prog);
  const altrove = [];
  trovate.forEach((v) => {
    const d = v.dove;
    if (d.media) {
      q.pezzi.push({ id: nuovoId("p"), media: d.media, dentro: v.dentro, fuori: v.fuori, base: v.dentro,
                     t0: Math.round(v.t0 * 100) / 100, traccia: "V1", fonte: "casa", mano: true,
                     titolo: v.titolo || d.media });
      return;
    }
    const suaReg = regDiRec[d.rec];
    if (!suaReg) { if (altrove.indexOf(v.nome) < 0) altrove.push(v.nome); return; }
    // IL SECONDO DENTRO IL FILE DIVENTA IL SECONDO DENTRO LA PARTITA, e lo
    // scostamento va preso da DOVE LO PRENDE L'EXPORT — i pezzi della
    // registrazione, non quelli dell'indice. I due possono non coincidere
    // (l'indice ha i minuti dichiarati, la registrazione le durate
    // misurate) e allora la sequenza rientrava spostata di una manciata di
    // secondi: i tagli c'erano tutti, ma un filo in la'.
    const suo = pezziArch(suaReg).find((z) => z.chiave === d.chiave);
    const da = suo ? (suo.da || 0) : (d.da || 0);
    const dentro = da + v.dentro, fuori = da + v.fuori;
    const pz = { id: nuovoId("p"), dentro: dentro, fuori: fuori, base: dentro,
                 t0: Math.round(v.t0 * 100) / 100, traccia: "V1", fonte: "xml", mano: true,
                 titolo: v.titolo || "" };
    // la sua partita, se non e' quella della sequenza
    if (suaReg.id !== reg.id) { pz.reg = suaReg.id; pz.partita = suaReg.titolo || ""; }
    q.pezzi.push(pz);
  });
  if (!q.pezzi.length) throw new Error("i pezzi dell'XML non sono di questa partita");
  q.pezzi.sort((a, b) => (a.t0 || 0) - (b.t0 || 0));
  R.seq[q.id] = q;
  scrivi(); annuncia(0, "clip");
  console.log("[clip] XML importato su \"" + (reg.titolo || reg.id) + "\": " + q.pezzi.length + " clip, " +
              mancanti.length + " file non trovati");
  const partite = regDellaSeq(q).map((id) => (R.reg[id] || {}).titolo || id);
  return { ok: true, seq: q, quante: q.pezzi.length, mancanti: mancanti, altrove: altrove,
           partita: reg.titolo || "", partite: partite, clipNellXml: voci.length };
}

async function hlEsportaPremiere(q, percorso, volume) {
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
  const vol = String(volume || "").trim().replace(/\/+$/, "");
  // sulla NAS le cartelle ce le ha anche il montatore: si scrive la chiave
  // intera. Altrove il file ce l'ha scaricato lui, e il nome basta.
  const suNasDi = (rx) => !!(rx && rx.arch && (magazzinoDi2(rx.arch.bucket) || {}).cartella);
  const suNas = suNasDi(r);
  const sotto = (chiave, rx) => (suNasDi(rx || r) ? chiave : path.basename(chiave));
  const cartellaVia = vol ? vol + "/" : (via.indexOf("/") >= 0 ? via.slice(0, via.lastIndexOf("/") + 1) : "");
  const via1 = (vol && r && r.arch && !c1 && !percorso) ? vol + "/" + sotto(r.arch.chiave) : via;
  // OGNI PEZZO IL SUO FILE, anche di un'altra partita. In una gol
  // collection i pezzi arrivano da dieci registrazioni: l'XML deve
  // dichiarare dieci file, e ogni taglio si conta dall'inizio del SUO.
  const dovE = (t, pz) => {
    const rx = pz ? regDi(q, pz) : r;
    if (pz && pz.media) {
      return { id: "casa-" + pz.media.replace(/[^A-Za-z0-9]/g, "-"), nome: path.basename(pz.media),
               via: (vol ? vol + "/" : "") + path.basename(pz.media), da: 0, durata: 0 };
    }
    if (rx && rx.id !== q.reg) {
      const pzz = pezziArch(rx);
      let i = 0; pzz.forEach((z, k) => { if ((z.da || 0) <= t) i = k; });
      const y = pzz[i] || pzz[0];
      if (!y) return { id: "file-1", nome: nome, via: via1, da: 0 };
      const base = rx.arch ? (vol ? vol + "/" : "") + sotto(y.chiave, rx) : path.join(cartellaReg(rx.id), "integrale.mp4");
      return { id: "reg-" + rx.id + "-" + (i + 1), nome: path.basename(y.chiave || "integrale.mp4"),
               via: base, da: y.da || 0, durata: rx.durata || 0 };
    }
    if (!arch) return { id: "file-1", nome: nome, via: via1, da: 0 };
    const x = pezzoAl(r, t) || { i: 0, pezzo: arch[0], da: 0 };
    return { id: "file-" + (x.i + 1), nome: path.basename(x.pezzo.chiave),
             via: cartellaVia + sotto(x.pezzo.chiave, r), da: x.da || 0 };
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
  const url = indirizzo(via1);

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
  const schedaFile = (t, pz) => {
    const d = dovE(t || 0, pz);
    if (gia[d.id]) return '<file id="' + d.id + '"/>';
    gia[d.id] = true;
    return '<file id="' + d.id + '"><name>' + xmlEsc(d.nome) + '</name><pathurl>' + xmlEsc(indirizzo(d.via)) + '</pathurl>' + rate +
      '<duration>' + (d.durata ? frame(d.durata) : durataFile) + '</duration>' + tc +
      '<media><video><samplecharacteristics><width>1920</width><height>1080</height>' +
      '</samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>';
  };

  q.pezzi.forEach((x, i) => {
    // il taglio si conta dall'inizio del SUO file, non della partita
    const dv = dovE(x.dentro, x);
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
             schedaFile(x.dentro, x) + '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>' +
             (suoi.length ? link : "") + '</clipitem>';
    marker += '<marker><name>' + n2 + '</name><comment>' + xmlEsc(x.fonte || "") +
              '</comment><in>' + start + '</in><out>-1</out></marker>';
  });

  (q.audio || []).forEach((a) => {
    const da = dovE(a.dentro, (q.pezzi || []).filter((y) => y.id === a.legato)[0]).da;
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
      (a.muto ? '<enabled>FALSE</enabled>' : '') + schedaFile(a.dentro, (q.pezzi || []).filter((y) => y.id === a.legato)[0]) +
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
    return { ok: true, premiere: await hlEsportaPremiere(q, p.percorso, p.volume) };
  }
  if (q.export && q.export.stato === "lavora") return { ok: true, export: q.export };
  const elenco = Array.isArray(p.formati) ? p.formati.filter((f) => FORMATI[f]) : [];
  const formati = elenco.length ? elenco
                : [FORMATI[p.formato] ? String(p.formato) : "16:9"];
  // non si aspetta l'export per rispondere: la pagina guarda lo stato
  hlEsportaTutti(q, formati, p).catch((e) => {
    console.log("[clip] export della sequenza \"" + (q.titolo || q.id) + "\" fallito: " + e.message + "\n" + String(e.stack || "").split("\n").slice(1, 5).join("\n"));
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
  const pp = pontePer(file);
  if (pp) return fotogrammaDalPonte(pp, quando, fuori, { w: 640, q: 4 });
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


// ── L'ARCHIVIO ──
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
// IL MAGAZZINO DI SOLO ELENCO. L'archivio di Como Football sta su S3 a
// Parigi (145 TB) e la VM non ha una chiave: l'elenco pero' ce l'abbiamo,
// fatto dalla EC2 nella stessa regione e portato qui come un JSON da due
// mega (s3-inventario.json nella cartella dei dati). Con quello le partite
// entrano nell'indice e nella Libreria come "su S3", si appaiano ad
// Airtable, si cercano per appunti ed ESPN. Leggerne i byte no: finche'
// non c'e' una chiave (o un ponte sulla EC2) ogni firma dice di no,
// chiaramente, e le code che leggono video (misure, cronometro) lo saltano.
let inventarioVisto = "";
function registraInventario() {
  if (!DIR) return;
  const via = path.join(DIR, "s3-inventario.json");
  if (inventarioVisto === via) return;
  if (!fs.existsSync(via)) return;
  inventarioVisto = via;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(via, "utf8")); } catch (e) { console.log("[clip] s3-inventario.json illeggibile: " + e.message); return; }
  if (!j || !j.bucket || !Array.isArray(j.oggetti)) return;
  if (MAGAZZINI.some((m) => m.bucket === j.bucket)) return;
  // il ponte: il servizio sulla EC2 (nella regione del secchio, quindi a
  // traffico zero verso S3) che legge a intervalli e conta ogni byte. Con
  // il ponte i file si aprono; senza, resta il solo elenco
  MAGAZZINI.push({ nome: "amazon-inventario", inventario: via, bucket: String(j.bucket), regione: String(j.regione || "eu-west-3"),
                   radice: String(j.radice || "TEMP/"), id: "", segreto: "", endpoint: "", fuori: false,
                   ponte: String(process.env.COMOTV_S3_PONTE || "").replace(/\/+$/, ""),
                   oggetti: j.oggetti.map((o) => ({ chiave: String(o.k), peso: +o.s || 0, quando: String(o.d || "") })).filter((o) => o.peso > 0) });
  const m0 = MAGAZZINI[MAGAZZINI.length - 1];
  console.log("[clip] magazzino " + (m0.ponte ? "S3 via ponte " + m0.ponte : "di solo elenco") + ": " + j.bucket + " (" + j.oggetti.length + " oggetti, " + (j.quando || "") + ")");
}
function magazzinoInventario(bucket) { return MAGAZZINI.filter((x) => x.bucket && x.bucket === (bucket || "") && x.inventario)[0] || null; }
// solo elenco: niente da leggere (nessun ponte, nessuna chiave)
function soloElenco(bucket) { const m = magazzinoInventario(bucket); return !!(m && !m.ponte); }
// dall'inventario: si legge (col ponte) ma le code automatiche — misure,
// cronometro — non partono da sole: ogni lettura da S3 e' contata, e si fa
// quando qualcuno la chiede
function senzaCode(bucket) { return !!magazzinoInventario(bucket); }

// ── LE PARTITE S3 PORTATE IN CASA ─────────────────────────────────────
//  scarica_partite.py copia le partite da S3 sulla QNAP, nella cartella
//  S3-ARCHIVIO, con lo STESSO percorso della chiave. Una partita e' "in
//  casa" quando TUTTI i suoi pezzi ci sono, col peso giusto al byte: da li'
//  ogni lettura (riproduzione, tagli, pose, misure, cronometro) va sulla
//  NAS invece che a Parigi, le code automatiche la trattano come una della
//  NAS, e nella Libreria resta UNA voce sola. L'indice non cambia: cambia
//  da dove si leggono i byte — cosi' lo scandaglio orario, che riscrive
//  l'indice, non puo' rimettere niente com'era.
const SPECCHIO_DIR = process.env.COMOTV_NAS_SPECCHIO || "S3-ARCHIVIO";
let SPECCHIO = new Map();                            // chiave S3 -> percorso sulla NAS
let SPECCHIO_QUANDO = 0;
function copiaInCasa(chiave) { return chiave ? (SPECCHIO.get(String(chiave)) || null) : null; }
function partiDi(a) { return a && a.pezzi && a.pezzi.length ? a.pezzi : (a && a.chiave ? [{ chiave: a.chiave, peso: a.peso }] : []); }
// una riga d'indice o una registrazione: in casa solo se c'e' TUTTA
function inCasa(a) { const pz = partiDi(a); return !!pz.length && pz.every((z) => SPECCHIO.has(z.chiave)); }
function inCasaReg(r) { return !!(r && r.arch && magazzinoInventario(r.arch.bucket) && inCasa(r.arch)); }
// il freno delle code S3 non vale per le partite gia' in casa
function senzaCodeDi(a) { return !!a && senzaCode(a.bucket) && !inCasa(a); }
// ── L'AVANZAMENTO DELLA COPIA, per la barra nella Libreria ─────────────
//  Si legge quello che lo script lascia sulla NAS (.scarica-stato.json,
//  .scarica.log) e si pesa la cartella, file a meta' compresi: la velocita'
//  e' la crescita degli ultimi minuti, la fine prevista quello che manca
//  diviso per la velocita'. Il conto delle partite e' quello del MAM: una
//  partita conta quando c'e' TUTTA (inCasa), non quando e' arrivato un file.
// il MAM non legge da S3: solo lo script di copia (fuori dal ponte) ci parla
const S3_STACCATO = process.env.COMOTV_S3_STACCATO !== "0";
function staccataDaS3(r) { return !!(S3_STACCATO && r && r.arch && magazzinoInventario(r.arch.bucket) && !inCasa(r.arch)); }
const COPIA_CAMPIONI = [];
let COPIA_ULTIMO = null;
//  Pesare tutta la cartella sulla NFS costa: si fa ogni 20 secondi. In mezzo
//  (la barra chiede ogni pochi secondi) si ripesano solo i file a meta', e
//  quelli finiti restano nel conto di prima: cosi' i MB salgono dal vivo
//  senza bloccare il ponte.
const COPIA_PESO = { quando: 0, fatti: 0, parziali: [] };
const COPIA_FILE = new Map();   // file a meta' -> campioni {t, b} per la sua velocita'
function pesaCopia(base) {
  let fatti = 0; const parziali = [];
  const giro = (d, prof) => {
    let v; try { v = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const x of v) {
      if (x.name.startsWith(".") || x.name === "_script") continue;
      const p = path.join(d, x.name);
      if (x.isDirectory()) { if (prof < 8) giro(p, prof + 1); continue; }
      if (/\.parziale/.test(x.name)) { parziali.push(p); continue; }
      try { fatti += fs.statSync(p).size; } catch (e) {}
    }
  };
  giro(path.join(base, "TEMP"), 0);
  Object.assign(COPIA_PESO, { quando: Date.now(), fatti, parziali });
}
function velocitaTra(campioni, ora, finestra) {
  // la crescita tra adesso e il campione piu' vecchio dentro la finestra
  const ultimo = campioni[campioni.length - 1];
  const primo = campioni.find((c) => ora - c.t <= finestra);
  if (!ultimo || !primo || ultimo.t - primo.t < 4000) return null;
  return Math.max(0, (ultimo.b - primo.b) / ((ultimo.t - primo.t) / 1000));
}
async function statoCopia() {
  if (COPIA_ULTIMO && Date.now() - COPIA_ULTIMO.quando < 2500) return COPIA_ULTIMO;
  const base = path.join(QNAP_RADICE, SPECCHIO_DIR);
  // la passata sulla NAS gira in sottofondo ogni 20 secondi; la prima volta la si aspetta
  if (Date.now() - COPIA_PESO.quando > 120000) { const g = giroNas(); if (!COPIA_PESO.quando) await g; }
  // i file a meta' si ripesano adesso (sono pochi), senza bloccare; quello
  // sparito e' stato rinominato: e' finito, e la prossima passata lo conta
  const ora = Date.now(), inArrivo = [];
  let inCorsoByte = 0;
  const pesi = await Promise.all(COPIA_PESO.parziali.map((p) => fs.promises.stat(p).then((st) => st.size, () => null)));
  // un file a meta' sparito e' stato rinominato: il suo peso passa SUBITO tra i
  // finiti, se no i GB calano fino alla prossima passata e la velocita' va a zero
  const finali = await Promise.all(COPIA_PESO.parziali.map((p, i) => pesi[i] !== null ? null
    : fs.promises.stat(p.replace(/\.parziale(\.[^/]*)?$/, "")).then((st) => st.size, () => null)));
  finali.forEach((b) => { if (b) COPIA_PESO.fatti += b; });
  const finito = [];
  COPIA_PESO.parziali = COPIA_PESO.parziali.filter((p, i) => {
    const b = pesi[i];
    if (b === null) { finito.push(p); COPIA_FILE.delete(p); return false; }
    inCorsoByte += b;
    const cc = COPIA_FILE.get(p) || []; cc.push({ t: ora, b });
    while (cc.length > 2 && ora - cc[0].t > 60000) cc.shift();
    COPIA_FILE.set(p, cc);
    inArrivo.push({ p, b, v: velocitaTra(cc, ora, 30000) });
    return true;
  });
  for (const p of COPIA_FILE.keys()) if (!COPIA_PESO.parziali.includes(p)) COPIA_FILE.delete(p);
  // un file appena finito: si ricontano specchio e peso (in sottofondo), cosi' la partita si apre subito dalla NAS
  if (finito.length) giroNas();
  const sullaNas = COPIA_PESO.fatti + inCorsoByte, inCorso = inArrivo.length;
  COPIA_CAMPIONI.push({ t: ora, b: sullaNas });
  while (COPIA_CAMPIONI.length > 2 && ora - COPIA_CAMPIONI[0].t > 600000) COPIA_CAMPIONI.shift();
  const velocita = COPIA_CAMPIONI[0] && ora - COPIA_CAMPIONI[0].t > 25000 ? velocitaTra(COPIA_CAMPIONI, ora, 600000) : null;
  const velocitaOra = velocitaTra(COPIA_CAMPIONI, ora, 30000);
  let partite = 0, byteTot = 0, partiteCasa = 0, byteCasa = 0;
  const pesoDi = new Map();
  Object.keys(ARCHIVIO).forEach((rec) => {
    const a = ARCHIVIO[rec]; if (!a || !a.chiave || !magazzinoInventario(a.bucket)) return;
    const pz = partiDi(a), b = pz.reduce((n, z) => n + (z.peso || 0), 0);
    pz.forEach((z) => pesoDi.set(z.chiave, { peso: z.peso || 0, partita: a.partita || "" }));
    partite++; byteTot += b;
    if (inCasa(a)) { partiteCasa++; byteCasa += b; }
  });
  let stato = null; try { stato = JSON.parse(fs.readFileSync(path.join(base, ".scarica-stato.json"), "utf8")); } catch (e) {}
  let righe = [], logQuando = 0;
  try { righe = fs.readFileSync(path.join(base, ".scarica.log"), "utf8").trim().split("\n").slice(-300); logQuando = fs.statSync(path.join(base, ".scarica.log")).mtimeMs; } catch (e) {}
  // TEMP/giorno/PARTITA/[lingua]/...: il nome e' la cartella della partita, con la lingua se c'e'
  const nomeFile = (chiave) => {
    const pz = chiave.split("/");
    const lingua = pz.slice(3, -1).map((z) => /AUDIO ONLY/i.test(z) ? "solo audio" : ((/\b(ITA|ENG)\b/i.exec(z) || [])[1] || "").toUpperCase()).filter(Boolean)[0];
    return (pz[2] || pz[pz.length - 1]) + (lingua ? " (" + lingua + ")" : "");
  };
  const ultimi = righe.filter((r) => /  ok /.test(r)).slice(-6).reverse().map((r) => {
    const m = /  ok (.+?) ([\d.]+) GB in (\d+) s/.exec(r);
    return m ? { file: nomeFile(m[1]), gb: +m[2], secondi: +m[3] } : null;
  }).filter(Boolean);
  const file = inArrivo.map((x) => {
    const chiave = path.relative(base, x.p).replace(/\.parziale(\.[^/]*)?$/, "");
    const info = pesoDi.get(chiave) || {};
    return { file: nomeFile(chiave), chiave, giorno: (chiave.split("/")[1] || ""), byte: x.b, peso: info.peso || null, velocita: x.v };
  }).sort((a, b) => (b.peso ? b.byte / b.peso : 0) - (a.peso ? a.byte / a.peso : 0));
  // un errore conta solo se e' l'ultima cosa successa: quelli vecchi sono passati
  const ultimaRiga = righe.length ? righe[righe.length - 1] : "";
  const errore = /ERRORE|\['  File/.test(ultimaRiga) ? (righe.filter((r) => /ERRORE/.test(r)).slice(-1)[0] || "").replace(/^\S+ \S+\s+/, "").slice(0, 200) : "";
  const manca = Math.max(0, byteTot - sullaNas);
  // il grafico: un punto ogni 15 secondi sugli ultimi 10 minuti
  const storia = [];
  let ancora = COPIA_CAMPIONI[0];
  for (const c of COPIA_CAMPIONI) {
    if (c.t - ancora.t < 15000) continue;
    storia.push({ t: c.t, v: Math.round(Math.max(0, (c.b - ancora.b) / ((c.t - ancora.t) / 1000))) });
    ancora = c;
  }
  const vFine = velocita || velocitaOra;
  COPIA_ULTIMO = {
    ok: true, quando: ora, cartella: base,
    partite, partiteCasa, byteTot, byteCasa, sullaNas, inCorso,
    velocita, velocitaOra, storia: storia.slice(-40),
    fine: vFine && vFine > 1e5 ? ora + manca / vFine * 1000 : null,
    // pagato e' tutto quello che e' uscito da S3, file a meta' compresi
    spesi: Math.round(Math.max(stato ? stato.byte || 0 : 0, sullaNas) / 1e9 * 0.03 * 100) / 100,
    daSpendere: Math.round(manca / 1e9 * 0.03),
    scaricati: stato ? { byte: stato.byte || 0, file: stato.file || 0 } : null,
    attiva: !!logQuando && ora - logQuando < 20 * 60000 && (inCorso > 0 || (velocita || 0) > 1e5),
    fermaDa: logQuando ? ora - logQuando : null,
    file, ultimi, errore
  };
  return COPIA_ULTIMO;
}
// ── IL GIRO DELLA CASA ──────────────────────────────────────────────
//  Ogni partita arrivata sulla NAS passa da tutte le letture, una partita
//  alla volta e un passo alla volta, prima il Como e poi dalla piu' recente:
//    ESPN        gol, cartellini, cambi e la telecronaca scritta (gratis, fuori)
//    cronometro  dove comincia la partita nel file: con lo studio dentro
//                (pre-show, intervallo) il fischio non e' all'inizio
//    tabellone   i gol al secondo, e il risultato che conferma il nome
//    boati       le azioni rumorose di appunti ed ESPN, al secondo
//  In casa costa zero. Mai sopra una registrazione, una diretta, una
//  trascrizione o un'altra lettura: la macchina ha due core.
const CASA = { attive: new Map(), fatte: 0, fallite: 0, dal: Date.now() };
function passoCasa(rec, a) {
  // lo studio (pre, intervallo, post) non ha ne' risultato ne' fischio suo:
  // sta nel file della partita, e la partita la legge lei
  if (DA_STUDIO.test(a.partita || "")) return null;
  if (!ESPN[rec]) return "espn";
  if (!a.orologio && !a.orologioFallito) return "cronometro";
  if (a.orologio && !a.tabellone && !a.tabelloneFallito) return "tabellone";
  if (!a.boatiFatti && ((APPUNTI[rec] || {}).righe || []).length + (((ESPN[rec] || {}).eventi) || []).length) return "boati";
  if (a.boatiFatti && (!a.momentiFatti || (a.momentiVer || 1) < MOMENTI_VER) && ((APPUNTI[rec] || {}).righe || []).length + (((ESPN[rec] || {}).eventi) || []).length) return "momenti";
  return null;
}
function inCasaDaLavorare() {
  return Object.keys(ARCHIVIO).filter((k) => {
    const a = ARCHIVIO[k];
    return a && a.chiave && magazzinoInventario(a.bucket) && inCasa(a) && !CASA.attive.has(k) && passoCasa(k, a);
  }).sort((x, y) => prioritaPartita(x) - prioritaPartita(y));
}
// due partite insieme (una sola se qualcuno sta usando il MAM): assorbe
// anche il giro dei nomi, perche' il tabellone letto qui dice gia' se il
// risultato combacia con quello atteso (tabellone.verificato)
async function giroCasa() {
  const quante = qualcunoLavora() ? 1 : 2;
  if (CASA.attive.size >= quante) return;
  if (registrandoDavvero() || laDirettaGira() || magazzinoOccupato() || voceAlLavoro || whisperGira() ||
      orologiInMoto || NOMI.attive.size || CODA_DURATE.length || durateInMoto) return;
  const rec = inCasaDaLavorare()[0]; if (!rec) return;
  const a = ARCHIVIO[rec], passo = passoCasa(rec, a);
  CASA.attive.set(rec, { rec, partita: a.partita || rec, passo, dal: Date.now() });
  setTimeout(() => { giroCasa().catch(() => {}); }, 5000);      // e intanto parte la seconda
  try {
    await SFONDO.run(true, async () => {
    if (passo === "espn") { await espnTrova(rec); scriviEspn(); }
    else if (passo === "cronometro") await calibraOrologio(rec);
    else if (passo === "tabellone") { const t = await leggiTabellone(rec); NOMI.fatte++; if (t && t.verificato) NOMI.verificate++; }
    else if (passo === "boati") await puntaBoati(rec);
    else if (passo === "momenti") await puntaMomenti(rec);
    });
    CASA.fatte++;
  } catch (e) {
    CASA.fallite++;
    const perche = String(e.message || e).slice(0, 160);
    console.log("[clip] casa: " + (a.partita || rec) + ", " + passo + " no — " + perche);
    // ci si ricorda del no: il giro non deve ripescare la stessa partita all'infinito
    if (passo === "espn") { ESPN[rec] = { mancante: "errore: " + perche.slice(0, 80), quando: a.quando }; scriviEspn(); }
    else if (passo === "cronometro") a.orologioFallito = { quando: new Date().toISOString(), motivo: perche.slice(0, 80) };
    else if (passo === "tabellone") { a.tabelloneFallito = perche; NOMI.fallite++; }
    else if (passo === "boati") a.boatiFatti = new Date().toISOString();
    else if (passo === "momenti") a.momentiFatti = new Date().toISOString();
    scriviArchivio();
  } finally {
    CASA.attive.delete(rec);
    setTimeout(() => { giroCasa().catch(() => {}); }, 3000);
  }
}
function statoCasa() {
  const n = { partite: 0, espn: 0, appunti: 0, cronometro: 0, tabellone: 0, boati: 0, momenti: 0, finite: 0, studio: 0 };
  Object.keys(ARCHIVIO).forEach((k) => {
    const a = ARCHIVIO[k];
    if (!a || !a.chiave || !magazzinoInventario(a.bucket) || !inCasa(a)) return;
    n.partite++;
    if (ESPN[k]) n.espn++;
    if (((APPUNTI[k] || {}).righe || []).length) n.appunti++;
    if (a.orologio || a.orologioFallito) n.cronometro++;
    if (a.tabellone || a.tabelloneFallito) n.tabellone++;
    if (a.boatiFatti) n.boati++;
    if (a.momentiFatti && (a.momentiVer || 1) >= MOMENTI_VER) n.momenti++;
    if (a.orologio && a.orologio.inizio1 > 600) n.studio++;
    if (!passoCasa(k, a)) n.finite++;
  });
  const adesso = [...CASA.attive.values()];
  return Object.assign(n, { adesso: adesso[0] || null, tutte: adesso, fatte: CASA.fatte, fallite: CASA.fallite });
}
// ── IL GIRO DEI NOMI ────────────────────────────────────────────────────
//  Per le partite gia' in casa col nome non sicuro si legge il tabellone:
//  se il finale combacia con quello atteso (nel nome o in ESPN) la partita
//  diventa sicura (nomeSicuro). Due alla volta, prima il Como e poi dalla
//  piu' recente; mai sopra una registrazione in corso. In casa costa zero.
const NOMI = { attive: new Set(), fatte: 0, verificate: 0, fallite: 0, dal: 0 };
function daVerificare() {
  return Object.keys(ARCHIVIO).filter((rec) => {
    const a = ARCHIVIO[rec];
    return a && a.partita && magazzinoInventario(a.bucket) && inCasa(a) && !nomeSicuro(a) &&
           !a.tabellone && !a.tabelloneFallito && !NOMI.attive.has(rec);
  }).sort((x, y) => {
    const a = ARCHIVIO[x], b = ARCHIVIO[y];
    const cx = /\bCOMO\b/i.test(a.partita) ? 0 : 1, cy = /\bCOMO\b/i.test(b.partita) ? 0 : 1;
    return cx - cy || String(b.quando || "").localeCompare(String(a.quando || ""));
  });
}
function giroNomi() {
  return;   // dal 25/09/2026 lo fa il giro della casa (passo "tabellone")
  if (!tesseractCe()) return;
  if ([...PROC.keys()].length) return;                       // c'e' una registrazione: la diretta viene prima
  if (!NOMI.dal) NOMI.dal = Date.now();
  while (NOMI.attive.size < 2) {
    const rec = daVerificare()[0]; if (!rec) return;
    const a = ARCHIVIO[rec];
    NOMI.attive.add(rec);
    leggiTabellone(rec)
      .then((t) => { NOMI.fatte++; if (t && t.verificato) NOMI.verificate++; })
      .catch((e) => { NOMI.fallite++; a.tabelloneFallito = String(e.message || e).slice(0, 160); scriviArchivio(); })
      .then(() => { NOMI.attive.delete(rec); setTimeout(giroNomi, 2000); });
  }
}
function statoNomi() {
  let partite = 0, sicure = 0, daControllare = 0, inAttesa = 0;
  Object.keys(ARCHIVIO).forEach((rec) => {
    const a = ARCHIVIO[rec]; if (!a || !magazzinoInventario(a.bucket)) return;
    partite++;
    if (a.partita && nomeSicuro(a)) sicure++;
    else if (a.tabellone || a.tabelloneFallito || !a.partita) daControllare++;
    else inAttesa++;
  });
  return { partite, sicure, daControllare, inAttesa, inCorso: [...CASA.attive.values()].filter((x) => x.passo === "tabellone").map((x) => x.partita),
           fatte: NOMI.fatte, verificate: NOMI.verificate, fallite: NOMI.fallite };
}
// LA NAS SI LEGGE UNA VOLTA SOLA, IN SOTTOFONDO. Prima lo specchio faceva
// 1.850 domande alla NAS una dopo l'altra (una per file dell'archivio), e il
// peso della copia camminava la cartella: tutto bloccante. Con la copia che
// scrive a 100 MB/s la NAS risponde piano, e il ponte restava fermo 40-60
// secondi — pagine vuote, loghi in 504 (25/09/2026). Adesso: una passata
// asincrona sulla cartella (dove ci sono solo i file arrivati), e specchio
// e peso si calcolano in memoria da quella.
let NAS_FILE = new Map();          // chiave S3 -> byte, per i file finiti
let NAS_PARZIALI = [];             // percorsi dei file a meta'
let nasInCorso = null;
function giroNas() {
  if (nasInCorso) return nasInCorso;
  const base = path.join(QNAP_RADICE, SPECCHIO_DIR);
  nasInCorso = (async () => {
    const finiti = new Map(), parziali = [], daPesare = [];
    // prima le cartelle (poche domande), poi i pesi SEDICI ALLA VOLTA: con la
    // copia che scrive, la NAS mette ~0,2 s a domanda, e 337 domande in fila
    // erano 66 secondi (25/09/2026)
    const giro = async (dir, rel, prof) => {
      let voci; try { voci = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      await Promise.all(voci.map(async (v) => {
        if (v.name.startsWith(".") || v.name === "_script") return;
        const p = path.join(dir, v.name), r = rel ? rel + "/" + v.name : v.name;
        if (v.isDirectory()) { if (prof < 8) await giro(p, r, prof + 1); return; }
        if (/\.parziale/.test(v.name)) { parziali.push(p); return; }
        daPesare.push([r, p]);
      }));
    };
    await giro(path.join(base, "TEMP"), "TEMP", 0);
    for (let i = 0; i < daPesare.length; i += 16) {
      await Promise.all(daPesare.slice(i, i + 16).map(([r, p]) => fs.promises.stat(p).then((st) => { finiti.set(r, st.size); }, () => {})));
    }
    NAS_FILE = finiti; NAS_PARZIALI = parziali;
    // lo specchio: una partita e' in casa se c'e' TUTTA, al byte
    const nuovo = new Map(); let partite = 0;
    Object.keys(ARCHIVIO).forEach((rec) => {
      const a = ARCHIVIO[rec]; if (!a || !a.chiave || !magazzinoInventario(a.bucket)) return;
      const pz = partiDi(a);
      if (!pz.length || !pz.every((z) => finiti.has(z.chiave) && (!z.peso || finiti.get(z.chiave) === z.peso))) return;
      pz.forEach((z) => nuovo.set(z.chiave, path.join(base, z.chiave))); partite++;
    });
    const cambiato = nuovo.size !== SPECCHIO.size;
    SPECCHIO = nuovo; SPECCHIO_QUANDO = Date.now();
    // si tiene su disco: al riavvio lo specchio c'e' subito, senza aspettare la NAS
    if (cambiato) { try { fs.writeFileSync(path.join(DIR, "specchio.json"), JSON.stringify([...nuovo])); } catch (e) {} }
    let fatti = 0; finiti.forEach((b) => { fatti += b; });
    Object.assign(COPIA_PESO, { quando: Date.now(), fatti, parziali: parziali.slice() });
    if (cambiato) { console.log("[clip] specchio S3: " + partite + " partite in casa (" + nuovo.size + " file) in " + base); annuncia(0, "clip"); }
    return { partite, file: nuovo.size };
  })().finally(() => { nasInCorso = null; });
  return nasInCorso;
}
function aggiornaSpecchio() { return giroNas(); }
// una pagina dell'elenco, ma dall'inventario: stessa forma di S3
function elencaInventario(mg, prefisso, delimitatore) {
  const pre = prefisso || "", oggetti = [], cartelle = new Set();
  mg.oggetti.forEach((o) => {
    if (pre && !o.chiave.startsWith(pre)) return;
    if (delimitatore) {
      const resto = o.chiave.slice(pre.length), i = resto.indexOf(delimitatore);
      if (i >= 0) { cartelle.add(pre + resto.slice(0, i + 1)); return; }
    }
    oggetti.push(o);
  });
  return { oggetti: oggetti, cartelle: Array.from(cartelle), ancora: "" };
}
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
  registraInventario();
  const b = bucket || (S3_SPENTO ? magazzinoPredefinito().bucket : S3.bucket);
  const m = MAGAZZINI.filter((x) => x.bucket && x.bucket === b)[0];
  if (m) return m;
  // un secchio che non e' di nessun magazzino acceso non ha un indirizzo:
  // meglio dirlo subito che tirare fuori una firma che nessuno onorera'
  if (S3_SPENTO) throw new Error("il magazzino \"" + b + "\" non c'e' piu': Amazon e' sganciato");
  return AMAZZONE;
}
function magazzinoAcceso(m) { return !!(m && m.bucket && ((m.id && m.segreto) || (m.cartella && fs.existsSync(m.cartella)) || (m.inventario && fs.existsSync(m.inventario)))); }
function s3Acceso() { registraInventario(); return magazzinoAcceso(AMAZZONE) || MAGAZZINI.some(magazzinoAcceso); }

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
  if (m.inventario) return m.regione || "eu-west-3";
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
  if (m.inventario && chiave) { const qui = copiaInCasa(chiave); if (qui) return qui; }   // gia' in casa: la NAS
  // STACCATI DA S3 (25/09/2026, deciso da Goffredo): il MAM non legge piu'
  // niente da Parigi. Le partite ci arrivano solo con la copia sulla NAS;
  // finche' non e' finita, una partita che sta solo su S3 non si apre.
  if (m.inventario && S3_STACCATO) throw new Error("questa partita sta ancora su S3: si apre quando la copia l'ha portata sulla NAS");
  if (m.inventario) {
    if (m.ponte) return m.ponte + "/o/" + uriChiave(chiave);
    throw new Error("di questo archivio S3 abbiamo solo l'elenco: per aprire i file serve il ponte sulla EC2 o la chiave in sola lettura");
  }
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
  if (mg.inventario) return elencaInventario(mg, prefisso || "", delimitatore);
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
      // il cestino non e' archivio: la Synology lo chiama "#recycle", la
      // QNAP "@Recycle". Una partita buttata via tornava in elenco come le
      // altre, e per giunta illeggibile
      if (v.name.startsWith(".") || v.name === "#recycle" || v.name === "@eaDir" ||
          v.name.toLowerCase() === "@recycle") return;
      // LO SPECCHIO DI S3 NON E' ARCHIVIO DELLA NAS: quelle partite restano
      // le righe S3 che erano (con le loro letture), solo lette da qui
      if (!rel && v.name === SPECCHIO_DIR) return;
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
  const r = (m.endpoint || m.cartella || m.inventario) ? (m.radice || "") : ARCH_RADICE;
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
// parole che nel nome di una cartella non dicono niente della partita
const PAROLE_VUOTE = new Set(["full", "match", "cleanfeed", "clean", "feed", "audio", "only", "commentary", "output",
  "multicorder1", "multicorder2", "multicorder3", "coppa", "italia", "gara", "live", "partita", "intera"]);
// la stessa parola scritta un po' diversa: Villareal/Villarreal,
// Feynoord/Feyenoord, Strasburgo/Strasbourg, Guaira/Laguaira
function paroleUguali(x, y) {
  if (x === y) return true;
  if (x.length < 5 || y.length < 5) return false;
  if (x.startsWith(y) || y.startsWith(x) || x.endsWith(y) || y.endsWith(x)) return true;
  if (x.slice(0, 5) === y.slice(0, 5) && Math.abs(x.length - y.length) <= 2) return true;
  if (Math.abs(x.length - y.length) > 1) return false;
  // una lettera in piu', in meno o cambiata
  let i = 0, j = 0, diff = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return diff + (x.length - i) + (y.length - j) <= 1;
}
function quantoSiSomigliano(a, b, livA) {
  const la = (livA === undefined ? livelloDi(a) : livA), lb = livelloDi(b);
  if (la && lb && la !== lb) return 0;
  const A = new Set(paroleSquadre(a)), B = new Set(paroleSquadre(b));
  if (!A.size || !B.size) return 0;
  const Bv = [...B], ha = (w, lista) => lista.some((v) => paroleUguali(w, v));
  let insieme = 0; A.forEach((w) => { if (ha(w, Bv)) insieme++; });
  // COMO NON BASTA. Il Como sta in centinaia di partite: averlo in comune
  // non dice niente. Se tutt'e due i nomi hanno un'altra squadra e l'altra
  // squadra non combacia, non e' la stessa partita. Con 0,5 di soglia
  // Como-Milan passava per Como-Fiorentina e Fiorentina-Como per
  // Como-Parma (25/09/2026). Le partite senza il Como restano come prima:
  // li' "Nizza" e "Nice" sono la stessa squadra scritta in due lingue.
  const Ax = [...A].filter((w) => w !== "como"), Bx = Bv.filter((w) => w !== "como" && !PAROLE_VUOTE.has(w));
  if (A.has("como") && B.has("como") && Ax.length && Bx.length && !Ax.some((w) => ha(w, Bx))) return 0;
  // e i numeri: Karate Combat 55 non e' il 56, gara 1 non e' gara 2 (i
  // risultati "2-1" non contano)
  const numeri = (x) => {
    const t = senzaAccenti(String(x || "")).replace(/\b\d+\s*-\s*\d+\b/g, " ");
    const n = new Set(t.match(/\b\d{2,3}\b/g) || []);
    (t.match(/\b(?:gara|game|leg)\s*(\d)\b/g) || []).forEach((z) => n.add("g" + z.replace(/\D/g, "")));
    return n;
  };
  const na = numeri(a), nb = numeri(b);
  if (na.size && nb.size && ![...na].some((n) => nb.has(n))) return 0;
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
// il giorno com'e' in Italia, AAAAMMGG: l'ISO di Airtable e' in UTC, e a
// mezzanotte e mezza di Roma e' ancora il giorno prima
function giornoRoma(ms) {
  const s = new Date(ms).toLocaleDateString("en-CA", { timeZone: "Europe/Rome" });
  return s.replace(/-/g, "");
}
// il numero del giorno, per sottrarre due date senza pensare ai mesi
function giornoNumero(g) {
  return Math.round(Date.UTC(+g.slice(0, 4), +g.slice(4, 6) - 1, +g.slice(6, 8)) / 86400000);
}
// LA DATA SCRITTA NEL NOME, non il giorno della partita: nomeVmix arretra
// di un giorno i file aperti prima delle sei, perche' quella e' la notte
// della partita di ieri. Qui serve il giorno vero del calendario, se no la
// registrazione delle cinque del mattino cerca i candidati ventiquattr'ore
// piu' indietro e non ne trova nessuno.
function dataNelNome(file) {
  const m = /-\s*(\d{1,2})\s+([a-z\u00e0-\u00f9]+)\s+(\d{4})\s*-\s*\d{2}-\d{2}-\d{2}/i.exec(String(file));
  const mese = m ? MESI_IT[m[2].toLowerCase()] : 0;
  if (!mese) return null;
  return m[3] + String(mese).padStart(2, "0") + String(+m[1]).padStart(2, "0");
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
// come si riconosce uno show dal nome: non e' una partita, e' una
// trasmissione — studio, pre, post, il recap del lunedi'
const DA_STUDIO = /SHOW|STUDIO|INTERVALLO|SPECIALE|RECAP|PRE[ -]?PARTITA|POST[ -]?PARTITA|\u{1F3A5}/iu;
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

// come si chiama un registratore, non una partita
const NOME_MACCHINA = /multicorder|^\s*output\s*\d|^\s*rec\s*\d|^\s*camera/i;
// le cartelle di servizio dentro una partita: non sono il suo nome
const CARTELLA_TECNICA = /^(tagli|clean\s*feed|cleanfeed|materiale|feed|audio|grafiche|clip|iso|camere|social|export|render)\b/i;
// IL NOME DELLA PARTITA STA NELLA CARTELLA. Nell'archivio di Mola il
// cleanfeed — che e' la partita intera — si chiama "MultiCorder3 - Output 1",
// e il nome vero ce l'ha la cartella sopra: "ABERDEEN-RANGERS". Prendendo il
// nome dal file, milleseicento partite si chiamavano MultiCorder e si
// agganciavano ad Airtable solo passando dai TAGLI, che nel nome il nome ce
// l'hanno. Tolti i tagli, restavano orfane (23/09/2026).
function daCartella(p) {
  for (let i = 0; i < p.length - 1; i++) {
    let giorno = "", partita = "", primo = i;
    if (/^\d{8}$/.test(p[i])) { giorno = p[i]; partita = p[i + 1] || ""; primo = i + 1; }
    else {
      const m = /^(\d{8})[_\s-]+(.+)$/.exec(p[i]);
      if (!m) continue;
      giorno = m[1]; partita = m[2];
    }
    if (!/^20\d{2}(0\d|1[0-2])([0-2]\d|3[01])$/.test(giorno)) continue;
    if (!partita || CARTELLA_TECNICA.test(partita) || NOME_MACCHINA.test(partita)) continue;
    return { giorno: giorno, partita: partita, gruppo: p.slice(0, primo + 1).join("/"),
             dentro: p.slice(primo + 1, p.length - 1).join("/"), file: p[p.length - 1] };
  }
  return null;
}
function pezziChiave(k) {
  const p = k.split("/");
  // prima la forma di vMix: la data e' nel nome del file, e il gruppo e'
  // "giorno + titolo", perche' non c'e' una cartella per partita
  const vm = nomeVmix(p[p.length - 1]);
  const cart = daCartella(p);
  if (cart && (!vm || NOME_MACCHINA.test(vm.partita || ""))) return cart;
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
  if (cart) return cart;
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

// LA LINGUA STA SCRITTA NEL NOME, E VA CREDUTA. Gli export si chiamano
// "FULL MATCH ENG", "FULL MATCH ITA", "[AUDIO ONLY]": quando la riga di
// Airtable chiede una lingua e il file ne dichiara un'altra, quel file non
// e' suo. Prima, non trovando niente col tag giusto, si ripiegava su
// qualunque file del giorno: cosi' GENOA-COMO [ITA] apriva l'unico export
// che c'era, che era in inglese — e chi montava se ne accorgeva ascoltando.
// Meglio una riga senza materiale che una riga con il materiale di un'altra.
const LINGUA_NEL_NOME = { "ITA": /\bITA\b/i, "ENG": /\bENG\b/i, "AUDIO ONLY": /\bAUDIO ?ONLY\b/i };
function diceUnAltraLingua(testo, tag) {
  if (!tag || !LINGUA_NEL_NOME[tag]) return false;
  if (LINGUA_NEL_NOME[tag].test(testo)) return false;
  return Object.keys(LINGUA_NEL_NOME).some((k) => k !== tag && LINGUA_NEL_NOME[k].test(testo));
}
// I TAGLI NON SONO LA PARTITA. Nell'archivio di Mola ogni giornata ha due
// cartelle: CLEANFEED con la registrazione intera, TAGLI con i pezzi montati
// (mezz'ora, tre quarti d'ora). Fino al 23/09 l'indice prendeva l'uno o
// l'altro a seconda di com'era scritto il nome, e milleottocento partite su
// tremila aprivano un taglio: gli appunti del secondo tempo cadevano in un
// file che finiva prima, e il tabellino restava vuoto. Un taglio si usa solo
// se di quella partita non c'e' altro, e allora non e' una partita intera:
// fuori dall'indice.
const TAGLIO = /TAGLI/i;
// il taglio puo' stare a qualsiasi altezza del percorso: "PARTITA/TAGLI/x.mp4"
// ma anche "TEMP/20250225/TAGLI/x.mp4", dove la cartella dei tagli e' finita
// a fare da nome alla partita. Si guardano tutte le cartelle, non il nome
// del file (un giocatore puo' chiamarsi Tagliafico)
function dentroUnTaglio(f) {
  const via = String((f && f.chiave) || "");
  const cartelle = via.split("/").slice(0, -1);
  return cartelle.some((c) => TAGLIO.test(c)) || TAGLIO.test(String((f && f.dentro) || ""));
}
function scegliMateriale(gruppo, tag) {
  const tutti = gruppo.file.filter((f) =>
    VIDEO.test(f.file) && (E_LA_PARTITA.test(f.dentro + " " + f.file) ||
                           !NON_E_LA_PARTITA.test(f.dentro + " " + f.file)));
  const buoni = tutti.filter((f) => !dentroUnTaglio(f));
  if (!buoni.length) return null;
  const vuole = (f) => !tag || (f.dentro + " " + f.file).toUpperCase().indexOf(tag) >= 0;
  const conTag = buoni.filter(vuole);
  const campo = conTag.length
    ? conTag
    : buoni.filter((f) => !diceUnAltraLingua(f.dentro + " " + f.file, tag));
  if (!campo.length) return null;

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
// (si chiamava viaPezzo come quella dei pezzi in casa, tre righe piu' su:
//  la seconda definizione vinceva e l'export di ogni sequenza con i pezzi
//  gia' in casa moriva con "reading 'regione'". Trovato il 21/09.)
function viaFileArchivio(r, x) {
  if (!r || !r.arch) throw new Error("questa registrazione non ha un file nel magazzino");
  if (!x || !x.chiave) throw new Error("di questa registrazione non so quale file aprire");
  return firmaConRegione(r.arch.regione, x.chiave, {}, 21600, r.arch.bucket);
}
function viaArchivio(r, t) {
  const x = pezzoAl(r, t || 0);
  return viaFileArchivio(r, x ? x.pezzo : { chiave: r.arch.chiave });
}
// Il file giusto e il secondo giusto dentro quel file, per chi poi ci
// mette un -ss davanti.
function fonteAl(r, dentro) {
  const x = pezzoAl(r, dentro);
  if (!x) return { via: viaArchivio(r), dentro: Math.max(0, +dentro || 0), fine: Infinity };
  return { via: viaFileArchivio(r, x.pezzo), dentro: x.dentro, fine: x.fine, i: x.i };
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
    // stessa partita, stesso primo file, e stessa forma — intera o un tempo
    // solo. Col "!==" una partita in UN pezzo non si ritrovava mai, e ogni
    // volta che la si apriva ne nasceva una copia.
    .find((r) => r.arch && r.arch.rec === String(p.rec || "") &&
                 (pezziArch(r).length > 1) === (pezzi.length > 1) &&
                 r.arch.chiave === scelto.chiave);
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
  // (la durata di una partita S3 non si misura qui: la dice il video appena
  //  carica nel browser, e la misura vera si chiede quando serve)
  if (!a.misurato && !senzaCodeDi(a) && CODA_DURATE.indexOf(p.rec) < 0) { CODA_DURATE.unshift(String(p.rec)); giraDurate(); }
  // SENZA CRONOMETRO QUESTA PARTITA NON SA CHE ORA E'. Una registrazione
  // intera comincia con il cartello — tredici minuti di "COMING SOON" su
  // Como-Lipsia — e in mezzo ha l'intervallo, altri diciassette. Se il file
  // non ha l'orario nel nome non c'e' niente da cui contare: il minuto 54
  // degli appunti finirebbe al secondo 3240, che in quel file e' ancora
  // primo tempo. Mezz'ora di errore. L'unico che sa l'ora vera e' il
  // cronometro in sovrimpressione, e costa venticinque secondi: si legge
  // appena la partita si apre, senza far aspettare chi l'ha aperta.
  const senzaOra = (a.pezzi || []).every((x) => !oraNelNome(path.basename(x.chiave || "")));
  // su S3 ogni lettura e' traffico contato: il cronometro si legge col tasto
  // nell'Asset, non da solo all'apertura (il 23/09 partiva a ogni apertura)
  if (!a.orologio && !a.orologioFallito && senzaOra && tesseractCe() && !senzaCodeDi(a)) {
    setTimeout(() => {
      calibraOrologio(String(p.rec))
        .then((o) => console.log("[clip] cronometro all'apertura di " + (a.partita || "") +
                                 ": fischio " + o.inizio1 + "s, ripresa " + o.inizio2 + "s"))
        .catch((e) => console.log("[clip] cronometro all'apertura: " + e.message));
    }, 1500);
  }
  // e intanto si apparecchia quello che sappiamo di lei: gol, azioni,
  // telecronaca, boati, ognuno nella sua sequenza. Chi apre non aspetta.
  if (p.prepara === true) setTimeout(() => { preparaSequenze({ reg: r.id }).catch((e) => console.log("[clip] apparecchiare: " + e.message)); }, 300);
  return { ok: true, reg: pubblica(r) };
}

// Il nome del materiale e' il nome della partita — MAIUSCOLO, SQUADRA-SQUADRA,
// con il risultato se c'e' o la data se no — e un suffisso solo quando il file
// e' davvero un tempo. "1ª parte" era il nome del file, non della partita.
function titoloMateriale(a, i, durataVera) {
  let nome = String(a.partita || nomeDaCartella(a) || "partita").toUpperCase().replace(/\s+VS\.?\s+/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").trim();
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
    // il magazzino da cui veniva non c'e' piu': la registrazione non ha piu'
    // materiale dietro. Se nessuno ci ha tagliato niente, se ne va.
    if (!magazzinoCe(r)) {
      if (!Object.keys(R.clip).some((c) => R.clip[c].reg === r.id)) { delete R.reg[k]; n++; }
      return;
    }
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
// ── CHI GIOCA, QUANDO IL NOME NON LO DICE ─────────────────────────────
//
//  Meta' dei file dell'archivio non dice che partita e': si chiamano
//  "MultiCorder3 - Output 1 - 01 settembre 2026 - 07-26-43.mp4". Il giorno e
//  l'ora restringono il campo a due o tre partite — Como TV ne registra
//  parecchie in parallelo — ma non lo chiudono. Il tabellone in
//  sovrimpressione invece dice chi gioca e come sta finendo.
//
//  Quello che si decide resta scritto qui, per gruppo di file: lo scandaglio
//  lo rilegge e aggancia quella partita a quel materiale, senza rifare la
//  lettura ogni volta.
const RICONOSCI_PY = path.join(__dirname, "riconosci.py");
let RICONOSCIUTE = {};
function fileRiconosciute() { return path.join(DIR, "riconosciute.json"); }
function leggiRiconosciute() {
  try { RICONOSCIUTE = JSON.parse(fs.readFileSync(fileRiconosciute(), "utf8")) || {}; }
  catch (e) { RICONOSCIUTE = {}; }
}
function scriviRiconosciute() {
  try { fs.writeFileSync(fileRiconosciute(), JSON.stringify(RICONOSCIUTE)); }
  catch (e) { console.log("[clip] riconoscimenti non salvati: " + e.message); }
}

function fileArchivio() { return path.join(DIR, "archivio.json"); }
function leggiArchivio() {
  try { ARCHIVIO = JSON.parse(fs.readFileSync(fileArchivio(), "utf8")) || {}; }
  catch (e) { ARCHIVIO = {}; }
  registraInventario();                 // il magazzino di solo elenco e' vivo: le sue partite restano
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

// quello che si e' misurato sul file di una partita e che uno scandaglio
// dell'indice non deve buttare, finche' il materiale e' lo stesso
const LETTURE_DEL_FILE = ["orologio", "orologioFallito", "tabellone", "tabelloneFallito", "boati", "boatiFatti",
  "momenti", "momentiFatti", "momentiVer", "appuntiImpronta", "gol", "replay", "primoReplay", "replayNo", "cronometroCieco", "misurato", "stelle", "voceProvata"];
async function archivioScandaglia(p) {
  if (!s3Acceso()) return { ok: false, errore: "nessun magazzino configurato" };
  const bucket = p.bucket || ARCH_BUCKET;
  const radici = p.radice !== undefined ? [String(p.radice)] : radiciDi(bucket);
  const giorni = num(p.giorni, 1, 3650, 400);
  const limite = Date.now() - giorni * 86400000;
  const minimo = num(p.minimoMB, 1, 100000, 700) * 1000000;

  // I minuti misurati appartengono al FILE, non alla partita: si tengono da
  // parte e si rimettono, se no ogni giro dell'indice li butta e bisogna
  // rimisurare ventiduemila file (e rifare la scelta del materiale).
  // SI SEGNANO ADESSO, PRIMA DI TOCCARE QUALSIASI COSA. Stavano scritti a
  // meta' strada, dopo che le partite di Airtable erano gia' state rifatte:
  // di quelle il minutaggio era gia' stato buttato, e ogni giro d'indice
  // rimandava a misurare gli stessi file — venti su ventotto.
  const durateNote = {};
  Object.keys(ARCHIVIO).forEach((k) => (ARCHIVIO[k].pezzi || []).forEach((x) => {
    if (x.chiave && x.minuti) durateNote[x.chiave] = x.minuti;
  }));

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
      if (dentroUnTaglio(o)) return;                   // i tagli non sono la partita
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
  const PROPOSTE = [];
  // chi ha trovato materiale in QUESTO giro: a fine scandaglio, le righe di
  // questo magazzino che non ci sono dentro non hanno piu' niente da
  // mostrare e vanno tolte. Senza, una riga che il materiale l'ha perso —
  // perche' era di un'altra lingua, o perche' il tabellone ha detto che
  // quella cartella e' di un'altra partita — restava in elenco a puntare un
  // file che non e' suo.
  const viste = new Set();
  // le partite che non hanno trovato materiale, per giorno: sono i candidati
  // per i file che non dicono come si chiamano
  const senzaMateriale = [];
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
  // L'ASSEGNAZIONE: dalla proposta piu' sicura alla meno sicura
  const usati = new Set();
  let contese = 0;
  // a pari sicurezza (la stessa partita scritta due volte in Airtable) vince
  // la riga che ha gia' piu' lavoro sopra: cronometro, boati, ESPN
  const lavoro = (id) => { const v = ARCHIVIO[id] || {}; return (v.orologio ? 1 : 0) + (v.boati ? 1 : 0) + (v.tabellone ? 1 : 0) + (v.gol ? 1 : 0) + (ESPN[id] ? 1 : 0); };
  PROPOSTE.sort((x, y) => y.meglio - x.meglio || (y.conTag ? 1 : 0) - (x.conTag ? 1 : 0) ||
                          x.vicino - y.vicino || lavoro(y.recId) - lavoro(x.recId));
  // UNA CARTELLA, PIU' PARTITE (la COMO CUP: quattro partite in ENG/ITA).
  // Il file il cui nome dice un'altra partita non e' questa: fuori. I file
  // senza nomi di squadra (MultiCorder...) restano, li decide il resto.
  const nomeNelFile = (f) => {
    const b = path.basename(f.chiave).replace(/\.[^.]+$/, "");
    if (/multicorder|output\s*\d/i.test(b)) return "";
    const n = b.replace(/^\d{6,9}\s*[-_ ]*/, " ").replace(/\d{1,2}\s+[a-z\u00e0-\u00f9]+\s+\d{4}/ig, " ").replace(/\d{2}-\d{2}-\d{2}/g, " ");
    return paroleSquadre(n).filter((w) => !PAROLE_VUOTE.has(w)).length >= 2 ? n : "";
  };
  const soloSuoi = (gr, nome, tag) => {
    // 1) fuori i file che nel nome dicono UN'ALTRA partita: nella cartella
    //    della Como Cup Como-AlUla non e' AlUla-Villarreal
    const nostre = dueSquadre(nome);
    const combacia = (x, y) => paroleSquadra(x).some((w) => paroleSquadra(y).some((v) => stessaParola(w, v)));
    const suaPartita = (f) => {
      const q = dueSquadre(path.basename(f.chiave));
      if (!q || !nostre) return null;                      // il file non dice che partita e'
      return (combacia(nostre[0], q[0]) && combacia(nostre[1], q[1])) || (combacia(nostre[0], q[1]) && combacia(nostre[1], q[0]));
    };
    const tenuti = gr.file.filter((f) => suaPartita(f) !== false);
    // 2) se c'e' un file che porta proprio questa partita nella lingua chiesta,
    //    vince lui (Villarreal-Como ITA prendeva il file piu' grosso della cartella)
    if (tag) {
      const giusti = tenuti.filter((f) => suaPartita(f) === true && (f.dentro + " " + f.file).toUpperCase().indexOf(tag) >= 0);
      if (giusti.length) return Object.assign({}, gr, { file: giusti });
    }
    return tenuti.length === gr.file.length ? gr : Object.assign({}, gr, { file: tenuti });
  };
  PROPOSTE.forEach((pr) => {
    // lo studio sta spesso nello stesso file della partita (pre, intervallo,
    // post): puo' dividerlo con lei, e non lo toglie a nessuno
    const studio = DA_STUDIO.test(pr.nomePartita);
    let presa = null;
    for (const c of pr.classifica) {
      const gr2 = soloSuoi(c.gr, pr.nomePartita, pr.tag);
      if (!gr2.file.length) continue;
      const scelta = scegliMateriale(gr2, pr.tag);
      if (!scelta || !scelta.pezzi.length) continue;
      // la cartella dice un'altra lingua: "COMO ATALANTA ENG" non e' la ITA
      if (pr.tag && diceUnAltraLingua(scelta.pezzi.map((z) => z.chiave).join(" "), pr.tag)) continue;
      if (!studio && scelta.pezzi.some((z) => usati.has(z.chiave))) { contese++; continue; }
      presa = { gr: c.gr, s: c.s, scelta }; break;
    }
    if (presa && !studio) presa.scelta.pezzi.forEach((z) => usati.add(z.chiave));
    aggancia(pr.recId, pr.nomePartita, pr.nomeComp, pr.quandoIso, presa || { gr: null, s: 0 });
  });
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

  // UN FILE, UNA PARTITA. Prima si raccolgono le proposte di tutte le
  // partite, poi si assegnano dalla piu' sicura: un file gia' preso non si
  // da' a nessun altro. Prima si andava in fila e vinceva l'ultima arrivata:
  // 33 file stavano sotto due partite, e cliccando Fiorentina-Como si apriva
  // Como-Parma (25/09/2026).
  function aggancia(recId, nomePartita, nomeComp, quandoIso, deciso) {
    {
      if (!deciso) tornate++;
      const f = { "Partita": nomePartita, "Competizione": nomeComp, "Data | Orario": quandoIso };
      const rec = { id: recId };
      const quando = Date.parse(quandoIso || "");
      if (!quando) return;
      // uno show settimanale ha lo stesso nome ogni settimana: si aggancia
      // solo a una cartella dello stesso giorno che sia uno show anche lei
      const eShow = DA_STUDIO.test(nomePartita) || /Studio/i.test(nomeComp);
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
      const classifica = [];
      if (!deciso) candidati.forEach((gr) => {
        const s = quantoSiSomigliano(f["Partita"], gr.partita, livello);
        if (s >= 0.5) classifica.push({ gr, s });
        if (s > punteggio) { punteggio = s; meglio = gr; }
      });
      // SE QUALCUNO L'HA GIA' RICONOSCIUTA, VALE PIU' DI QUALSIASI SOMIGLIANZA.
      // Il tabellone ha detto che quel materiale e' questa partita: il nome
      // del file non c'entra piu' niente.
      const detto = Object.keys(RICONOSCIUTE).find((dove) => RICONOSCIUTE[dove].rec === rec.id &&
                                                             RICONOSCIUTE[dove].sicura !== false);
      if (detto && !deciso) {
        const suo = candidati.find((gr) => gr.dove === detto) ||
                    Object.keys(gruppi).map((kk) => gruppi[kk]).find((gr) => gr.dove === detto);
        if (suo) { meglio = suo; punteggio = 1; classifica.unshift({ gr: suo, s: 1.5 }); }
      }
      // la lingua si legge anche senza parentesi: "NAPOLI-COMO - ITA"
      const tag = (/\[([A-Z][A-Z ]{1,12})\]/.exec(String(f["Partita"] || "")) || [])[1] ||
                  (/(?:^|[^A-Z])(ITA|ENG)(?:[^A-Z]|$)/.exec(String(f["Partita"] || "").toUpperCase()) || [])[1] || "";
      if (!deciso) {
        // il giorno conta a parita' di nome: prima la cartella dello stesso giorno
        const lontano = (gr) => Math.abs(giornoNumero(gr.giorno) - giornoNumero(giornoRoma(quando)));
        classifica.sort((x, y) => y.s - x.s || lontano(x.gr) - lontano(y.gr));
        const primo = classifica[0];
        PROPOSTE.push({ recId, nomePartita, nomeComp, quandoIso, tag, classifica,
                        meglio: primo ? primo.s : 0, conCandidati: candidati.length > 0,
                        // a pari nome: prima chi ha la lingua scritta nel file, poi chi e' dello stesso giorno
                        conTag: !!(primo && tag && primo.gr.file.some((z) => (z.dentro + " " + z.file).toUpperCase().indexOf(tag) >= 0)),
                        vicino: primo ? lontano(primo.gr) : 9 });
        return;
      }
      meglio = deciso.gr; punteggio = deciso.s > 1 ? 1 : deciso.s;
      if (!meglio || punteggio < 0.5) {
        if (candidati.length) orfane.push(f["Partita"] + " (" +
          new Date(quando).toISOString().slice(0, 16).replace("T", " ") + ")");
        // il minuto di Roma si calcola qui una volta: dentro il giro delle
        // cartelle (1.700 su S3 × 3.000 partite × 2 letture dell'ora) la
        // toLocaleString bloccava il ponte per un quarto d'ora (22/09/2026)
        const qMs = Date.parse(quandoIso || "");
        const mR = qMs ? minutiRoma(qMs) : null;
        senzaMateriale.push({ rec: rec.id, nome: f["Partita"] || "", quando: quandoIso,
                              minutoRoma: mR, giornoRoma: (qMs && mR !== null) ? giornoNumero(giornoRoma(qMs)) * 1440 + mR : null });
        return;
      }
      // anche le etichette di due parole: "[AUDIO ONLY]" e' una consegna a
      // se', non un modo di dire la stessa partita, e prendersi l'export
      // completo di qualcun altro non le serve
      const scelta = deciso.scelta;
      if (!scelta) return;
      meglio.presa = rec.id;
      // IL FILE CHE SI LEGGE VINCE. Se la partita ha gia' il materiale in un
      // magazzino vero (la QNAP) e questo giro e' su un magazzino di solo
      // elenco (S3 senza chiave), la riga resta com'e': si segna soltanto
      // che la partita sta anche la', per quando la chiave ci sara'
      if (magazzinoInventario(bucket)) {
        const gia = ARCHIVIO[rec.id];
        if (gia && gia.bucket && gia.bucket !== bucket && !magazzinoInventario(gia.bucket)) {
          gia.ancheSu = { bucket: bucket, dove: meglio.dove, chiave: scelta.pezzi[0] && scelta.pezzi[0].chiave };
          viste.add(rec.id); agganciate++;
          return;
        }
      }

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
      // UN FILE SENZA ORA NEL NOME HA COMUNQUE UNA LINEA DEL TEMPO. I file
      // esportati a mano — "20260904_GENOA-COMO - FULL MATCH ENG.mp4" —
      // hanno il giorno e il nome ma non l'orario, quindi nessun "da" e
      // nessun calcio d'inizio: e senza quello il tabellino resta vuoto,
      // perche' non si sa a che secondo del file corrisponde il minuto 12.
      // L'asse ce l'hanno lo stesso: comincia dove comincia il file. Il
      // fischio vero lo trovera' il cronometro, che senza asse non poteva
      // nemmeno partire.
      if (pezzi.every((x) => x.da === null || x.da === undefined)) {
        let corre = 0;
        pezzi.forEach((x, n2) => {
          x.da = corre;
          corre += Math.round((x.minuti || 0) * 60) || 0;
        });
      }
      const kick = kickoffNelFile(pezzi[0].file, quando);
      if (kick !== null) conKickoff++;
      if (scelta.fonte === "intera" || scelta.fonte === "intero") intere++;
      agganciate++;
      viste.add(rec.id);
      // QUELLO CHE E' COSTATO LETTURE NON SI RIFA' OGNI ORA. Il cronometro,
      // il tabellone, i boati, i replay: sono ore di ffmpeg e di tesseract,
      // e appartengono al MATERIALE. Finche' la riga apre la stessa cartella
      // di prima se li tiene; se il materiale cambia vanno buttati, perche'
      // parlano di un altro file.
      const prima = ARCHIVIO[rec.id] || {};
      const stessaRoba = prima.dove === meglio.dove && prima.bucket === bucket;
      // TUTTE, anche i "fatto" e i "fallito": senza boatiFatti,
      // orologioFallito, tabelloneFallito il giro della casa rifaceva i boati
      // e riprovava i cronometri gia' falliti a ogni scandaglio (26/09/2026)
      const letture = { orologio: prima.orologio };
      if (stessaRoba) LETTURE_DEL_FILE.forEach((c) => { if (prima[c] !== undefined) letture[c] = prima[c]; });
      ARCHIVIO[rec.id] = Object.assign(letture, { bucket: bucket, chiave: pezzi[0].chiave, peso: pezzi[0].peso,
        partita: f["Partita"] || "", competizione: f["Competizione"] || "",
        variante: "", giorno: meglio.giorno, dove: meglio.dove,
        // senza ora nel nome il calcio d'inizio non si sa: si parte da zero,
        // cioe' dall'inizio del file, e il cronometro lo corregge
        fonte: scelta.fonte, pezzi: pezzi, kickoff: kick === null && pezzi[0].da === 0 ? 0 : kick,
        sicuro: punteggio >= 0.8 && scelta.fonte !== "unico", quando: f["Data | Orario"] });
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
  // anche le orfane si tengono le loro letture: l'id e' fatto dal percorso
  // ed e' stabile, quindi si ritrovano a fine giro
  const lettureSoleS3 = {};
  Object.keys(ARCHIVIO).forEach((k) => {
    if (k.indexOf("s3:") !== 0 || ARCHIVIO[k].bucket !== bucket) return;
    const v = ARCHIVIO[k];
    lettureSoleS3[k] = {};
    LETTURE_DEL_FILE.forEach((c) => { if (v[c] !== undefined) lettureSoleS3[k][c] = v[c]; });
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
    // CHI POTREBBE ESSERE. Le partite rimaste senza materiale il cui calcio
    // d'inizio cade dentro questa registrazione. Si confrontano due orologi
    // da parete — giorno e minuto scritti nel nome del file, giorno e minuto
    // di Airtable — senza passare per i fusi. L'ora del nome e' a dodici: si
    // provano tutt'e due le letture. Senza il confronto sul giorno passava
    // qualunque partita di qualunque data: mille candidati invece di tre.
    const oraFile = oraNelNome(pezzi[0].file);
    const dataFile = dataNelNome(pezzi[0].file);
    const candidatiSuoi = [];
    if (oraFile) {
      const durataMin = pezzi.reduce((t, x) => t + (x.minuti || 0), 0) || 120;
      const base = giornoNumero(dataFile || g) * 1440;
      [(oraFile.h % 12), (oraFile.h % 12) + 12].forEach((hh) => {
        const parte = base + hh * 60 + oraFile.m;
        senzaMateriale.forEach((sm) => {
          if (sm.giornoRoma === null || sm.giornoRoma === undefined) return;
          const d2 = sm.giornoRoma - parte;
          if (d2 < -25 || d2 > durataMin) return;
          if (!candidatiSuoi.some((c) => c.rec === sm.rec)) candidatiSuoi.push({ rec: sm.rec, nome: sm.nome, quando: sm.quando });
        });
      });
    }
    const id = "s3:" + crypto.createHash("sha1").update(gr.dove).digest("hex").slice(0, 14);
    ARCHIVIO[id] = Object.assign({}, lettureSoleS3[id], { bucket: bucket, chiave: pezzi[0].chiave, peso: pezzi[0].peso,
      partita: titoloAMano(gr.dove) || gr.partita.replace(/[_]+/g, " ").trim(), competizione: comp.replace(/[_]+/g, " "),
      variante: "", giorno: g, dove: gr.dove, fonte: scelta.fonte, pezzi: pezzi,
      kickoff: null, sicuro: false, quando: quando, soloS3: true,
      candidati: candidatiSuoi, riconosciuta: RICONOSCIUTE[gr.dove] || undefined });
    soleS3++;
  });

  // le righe rimaste senza materiale escono dall'indice
  let tolte = 0;
  Object.keys(ARCHIVIO).forEach((k) => {
    const v = ARCHIVIO[k];
    if (k.indexOf("s3:") === 0 || v.bucket !== bucket || viste.has(k)) return;
    if (!(Date.parse(v.quando) >= limite)) return;      // fuori dalla finestra guardata: non si tocca
    delete ARCHIVIO[k]; tolte++;
  });
  if (tolte) console.log("[clip] archivio: " + tolte + " righe senza piu' materiale tolte dall'indice");

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
           conKickoff: conKickoff, soloS3: soleS3, tolte: tolte, senzaAggancio: orfane.slice(0, 15), fileContesi: contese,
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

// ── I SOTTOTITOLI DAL VIVO ────────────────────────────────────────────
//
//  Mentre il flusso entra dalla porta, quello che si dice si legge in
//  pagina — nella lingua in cui lo dicono e tradotto. Non si aspetta la
//  fine della partita: ogni otto secondi di audio nuovo si prendono i
//  segmenti appena scritti dal registratore, si tirano fuori sedici kHz
//  mono, whisper li legge (il modello piccolo: in diretta conta la
//  velocita', la versione buona la fa dopo la trascrizione dell'archivio)
//  e il traduttore in casa — Argos su 127.0.0.1, niente esce dalla
//  macchina — li volta nell'altra lingua. Italiano verso inglese, inglese
//  verso italiano; la lingua la riconosce whisper al primo giro e poi
//  resta quella. Ritardo: una quindicina di secondi dal parlato.
//
//  Costa CPU: si accende a mano, dalla pagina, e un giro alla volta su
//  tutta la macchina anche se le porte aperte sono due.
const MODELLO_VIVO = process.env.COMOTV_WHISPER_VIVO || path.join(path.dirname(MODELLO), "ggml-base.bin");
// IL MODELLO ITALIANO PER L'ITALIANO. Quello rifinito sul parlato italiano
// (LocalAI, ricetta YODAS) vale il vanilla sui nomi e un filo di piu' sulle
// parole; ma e' stato addestrato SOLO sull'italiano, e su una telecronaca
// inglese e' peggio. Quindi si sceglie per lingua: italiano → italiano,
// tutto il resto → il modello di sempre.
const MODELLO_IT = process.env.COMOTV_WHISPER_IT || "";
const MODELLO_VIVO_IT = process.env.COMOTV_WHISPER_VIVO_IT || "";
function modelloPer(lingua, vivo) {
  const it = !lingua || lingua === "it" || lingua === "auto";
  if (vivo) return (it && MODELLO_VIVO_IT && fs.existsSync(MODELLO_VIVO_IT)) ? MODELLO_VIVO_IT : MODELLO_VIVO;
  return (it && MODELLO_IT && fs.existsSync(MODELLO_IT)) ? MODELLO_IT : MODELLO;
}
const TRADUCI = process.env.COMOTV_TRADUCI || "http://127.0.0.1:5077";
const VIVO_PEZZO = parseInt(process.env.COMOTV_VIVO_PEZZO || "6", 10);   // secondi d'audio per giro
const VIVI = new Map();          // regId -> { fatto, lingua, prompt }
const TRADUZIONI = new Map();    // regId -> avanzamento della traduzione in sottofondo
let vivoInCorso = false;

function eseguiVivo(cmd, args, quanto) {
  return new Promise((ok, no) => {
    execFile(cmd, args, { timeout: quanto || 60000, maxBuffer: 8 * 1024 * 1024 },
      (e, so, se) => e ? no(new Error(String(se || e.message).split("\n").slice(-2).join(" "))) : ok(String(so || "")));
  });
}
function traduci(testi, da, a) {
  return new Promise((ok) => {
    try {
      const u = new URL(TRADUCI);
      const corpo = JSON.stringify({ da: da, a: a, testi: testi });
      const req = http.request({ host: u.hostname, port: u.port || 80, path: "/", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(corpo) } }, (res) => {
        let d = ""; res.on("data", (x) => { d += x; });
        res.on("end", () => { try { const j = JSON.parse(d); ok(j.ok ? j.tradotti : null); } catch (e) { ok(null); } });
      });
      req.on("error", () => ok(null));
      req.setTimeout(20000, () => { req.destroy(); ok(null); });
      req.end(corpo);
    } catch (e) { ok(null); }
  });
}
// UNA LINGUA SOLA IN PAGINA. Chi guarda sceglie in che lingua leggere —
// italiano o inglese — non le due insieme. Se e' la lingua in cui parlano,
// si mostra il parlato com'e'; se e' l'altra, la traduzione. Il traduttore
// lavora solo quando serve.
function sottotitoliAccendi(r, lingua, mostra) {
  const l = ["it", "en", "auto"].indexOf(String(lingua || "auto")) >= 0 ? String(lingua || "auto") : "auto";
  const m = ["it", "en"].indexOf(String(mostra || "")) >= 0 ? String(mostra) : "it";
  r.sottotitoli = { acceso: true, lingua: l, mostra: m, da: Date.now() };
  // si comincia da ADESSO, non dall'inizio: i sottotitoli servono al vivo,
  // il pregresso lo fara' la trascrizione intera a fine partita
  VIVI.set(r.id, { fatto: Math.max(0, durataRegistrata(r.id) - VIVO_PEZZO), lingua: l === "auto" ? "" : l, prompt: "" });
  scrivi(); annuncia(0, "clip");
  console.log("[clip] sottotitoli accesi su \"" + (r.titolo || r.id) + "\" (" + l + ")");
}
function sottotitoliSpegni(r) {
  r.sottotitoli = { acceso: false };
  VIVI.delete(r.id);
  scrivi(); annuncia(0, "clip");
}
async function trascriviVivo(r, v, presi) {
  const dir = cartellaReg(r.id);
  const wav = path.join(dir, "vivo.wav"), base = path.join(dir, "vivo");
  const t0 = presi[0].t0, u = presi[presi.length - 1], t1 = u.t0 + u.dur;
  await eseguiVivo(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-i", "concat:" + presi.map((x) => x.file).join("|"),
    "-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-f", "wav", wav], 30000);
  // -mc 0 e -et: la cura della ripetizione. Su pezzi corti il modello si
  // aggrappa all'ultima frase e la ripete ("poi di Vicas, poi di Vicas");
  // senza contesto trascinato e con la soglia di entropia si ferma prima.
  const args = ["-m", modelloPer(v.lingua, true), "-f", wav, "-oj", "-of", base, "-t", "2", "-np",
                "-mc", "0", "-et", "2.4", "-l", v.lingua || "auto"];
  // il vocabolario davanti — squadre, allenatori, cognomi come li scrive
  // ESPN — e in coda la frase di prima: whisper su otto secondi non sa di
  // che si parla, e con i nomi davanti li scrive giusti
  args.push("--prompt", promptPer(r, v.lingua, v.prompt));
  await eseguiVivo(WHISPER, args, 60000);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(base + ".json", "utf8")); } catch (e) {}
  const lettaLingua = j.result && j.result.language;
  if (!v.lingua && lettaLingua && ["it", "en"].indexOf(lettaLingua) >= 0) v.lingua = lettaLingua;
  let testo = (j.transcription || []).map((t) => String(t.text || "").trim()).filter(Boolean).join(" ")
    .replace(/\s+/g, " ").trim();
  v.fatto = t1;
  // le allucinazioni del silenzio: whisper sul nulla scrive "Sottotitoli a
  // cura di..." o ripete l'ultima frase. Non si tiene.
  if (!testo || /sottotitoli|subtitles|thanks for watching|amara\.org/i.test(testo) || testo === v.ultimo) return;
  // una frase che ripete in gran parte quella prima e' un'allucinazione,
  // non una frase nuova: si butta. E dentro la frase, una coda ripetuta
  // ("poi di Vicas, poi di Vicas, poi di Vicas") si taglia alla prima.
  testo = testo.replace(/(\b[^,.;]{4,40}[,;]?\s+)(\1\s*){1,}/gi, "$1").trim();
  const paroleNuove = testo.toLowerCase().split(/\s+/), paroleVecchie = new Set(String(v.ultimo || "").toLowerCase().split(/\s+/));
  if (paroleNuove.length >= 4 && paroleNuove.filter((w) => paroleVecchie.has(w)).length / paroleNuove.length > 0.6) return;
  const lingua = v.lingua || "it";
  testo = numeriNelTesto(testo, lingua);
  const corretto = correggiConIlVocabolario(testo, r);
  if (corretto.cambi.length) console.log("[clip] sottotitoli: " + corretto.cambi.join(", "));
  testo = corretto.testo;
  // si traduce solo verso la lingua che chi guarda ha scelto, e solo se e'
  // diversa da quella in cui parlano
  const vuole = (r.sottotitoli || {}).mostra || (lingua === "it" ? "en" : "it");
  const tr = vuole !== lingua && ["it", "en"].indexOf(vuole) >= 0 ? await traduciConINomi([testo], lingua, vuole, r) : null;
  const dentro = PARLATO[r.id] || (PARLATO[r.id] = { lingua: lingua, pezzi: [] });
  dentro.pezzi.push({ a: Math.round(t0 * 10) / 10, b: Math.round(t1 * 10) / 10, x: testo,
                      y: tr ? tr[0] : "", l: lingua, vivo: true });
  v.prompt = testo.slice(-200); v.ultimo = testo;
  scriviParlato(); annuncia(0, "clip");
}
async function giraSottotitoli() {
  if (vivoInCorso || !VIVI.size) return;
  for (const [id, v] of VIVI) {
    const r = R.reg[id];
    if (!r || r.stato !== "registra" || !(r.sottotitoli || {}).acceso) { VIVI.delete(id); continue; }
    // SE SI RESTA INDIETRO SI SALTA AVANTI. Un sottotitolo di tre minuti fa
    // non serve a nessuno: quando la macchina non tiene il passo si perde
    // un pezzo e si torna sul vivo, invece di accumulare ritardo per tutta
    // la partita.
    const scritto = durataRegistrata(id);
    if (scritto - v.fatto > VIVO_PEZZO * 2.5) {
      console.log("[clip] sottotitoli (" + (r.titolo || id) + "): indietro di " + Math.round(scritto - v.fatto) + "s, salto avanti");
      v.fatto = scritto - VIVO_PEZZO;
    }
    const segs = segmenti(id).filter((x) => x.t0 >= v.fatto - 0.05);
    const presi = []; let quanto = 0;
    for (const x of segs) { presi.push(x); quanto += x.dur; if (quanto >= VIVO_PEZZO) break; }
    if (quanto < VIVO_PEZZO * 0.75) continue;                 // ancora poco audio: si aspetta
    vivoInCorso = true;
    try { await trascriviVivo(r, v, presi); }
    catch (e) { console.log("[clip] sottotitoli (" + (r.titolo || id) + "): " + e.message); v.fatto = presi[presi.length - 1].t0 + presi[presi.length - 1].dur; }
    vivoInCorso = false;
    return;                                                   // un giro, una registrazione
  }
}
setInterval(() => { giraSottotitoli().catch(() => { vivoInCorso = false; }); }, 800);

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
  dentro.pezzi = dentro.pezzi.filter((t) => t.m || t.b <= finestra.da || t.a >= finestra.a).concat(pezzi).sort((x, y) => x.a - y.a);
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
    if (r.voceFallita && r.voceFallita.n >= 2 && Date.now() - r.voceFallita.quando < 86400000) return;
    if (CODA_VOCE.some((x) => x.reg === r.id) || (voceAlLavoro && voceAlLavoro.reg === r.id)) return;
    if (CODA_VOCE.length >= tetto) return;
    // ANCHE L'ARCHIVIO. Erano escluse perche' l'audio veniva da S3 e due ore
    // di partita erano due ore di traffico da pagare. Dal magazzino di casa
    // non costa niente, e sono le partite che nessuno ha mai trascritto.
    // una partita ancora su S3 non si apre (e' staccato): prima faceva cadere
    // il ponte ogni mezz'ora, perche' l'errore usciva da un timer (26/09)
    let via = null;
    try { via = r.arch ? viaArchivio(r, 0) : sorgenteAudio(r); } catch (e) { return; }
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
// LA TRASCRIZIONE DI NOTTE ASPETTA LA COPIA. Goffredo: "quello lo facciamo
// quando tutte le partite sono sul nas". Whisper tiene i due core per ore, e
// il giro della casa (cronometro, tabellone, boati, gol) ha la precedenza.
setInterval(async () => {
  const h = new Date().getHours(); if (h < 1 || h >= 6) return;
  try { const c = await statoCopia(); if (!(c && c.partite && c.partiteCasa >= c.partite)) return; } catch (e) { return; }
  try { parlatoLocaleInCoda(); } catch (e) { console.log("[clip] trascrizione di notte: " + e.message); }
}, 1800000);
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
  // una trascrizione dura un'ora: non si parte sopra un export video
  if (!giraLaCoda.chiesto) {
    siEsporta().then((si) => {
      if (si) return setTimeout(giraLaCoda, 30000);
      giraLaCoda.chiesto = true; try { giraLaCoda(); } finally { giraLaCoda.chiesto = false; }
    });
    return;
  }
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
    .catch((e) => {
      console.log("[clip] trascrizione fallita: " + e.message);
      // si segna sulla registrazione: dopo due fallimenti la coda automatica
      // la lascia stare per un giorno (in dev un flusso rotto era stato
      // ritentato 44 volte, un'estrazione audio fallita ogni volta)
      const rf = R.reg[lavoro.reg];
      if (rf) { rf.voceFallita = { n: ((rf.voceFallita || {}).n || 0) + 1, quando: Date.now(), perche: String(e.message || "").slice(0, 160) }; scrivi(); }
    })
    .then(() => { voceAlLavoro = null; annuncia(0, "clip"); setTimeout(giraLaCoda, 1000); setTimeout(giraOrologi, 1500); });
}

// ── IL VOCABOLARIO: I NOMI CHE ESPN SCRIVE GIUSTI ─────────────────────
//
//  whisper non conosce i calciatori: "Perotti" diventa "piuttro schie", e
//  Argos, dopo, traduce "Banco" con "bank". La cura non e' un modello piu'
//  grosso: e' dirgli i nomi prima. ESPN ce li ha con la grafia ufficiale —
//  le rose di quattromila partite, gli allenatori con i loro club — e qui
//  diventano un vocabolario solo: per squadra, i giocatori e chi la allena;
//  per tutti, i termini del calcio nelle due lingue. Si rifa' da solo
//  quando ESPN cresce, e si legge con "clip-vocabolario" per controllarlo.
//
//  Serve in due posti. A whisper, come prompt: la partita che sta entrando
//  ha due rose, due allenatori e una competizione, e con quelli davanti i
//  cognomi escono scritti come li scrive ESPN. Ad Argos, come lista di
//  parole da NON tradurre: i nomi si coprono prima e si scoprono dopo.
const TERMINI_IT = ["calcio d'angolo", "rigore", "fuorigioco", "ammonizione", "espulsione", "cartellino giallo",
  "cartellino rosso", "traversa", "palo", "parata", "punizione", "rimessa laterale", "recupero", "VAR",
  "fallo", "contropiede", "cross", "colpo di testa", "tiro", "gol", "portiere", "difensore", "centrocampista",
  "attaccante", "sostituzione", "intervallo", "primo tempo", "secondo tempo", "autogol", "assist", "dribbling",
  "pressing", "ripartenza", "raddoppio", "pareggio", "vantaggio", "area di rigore", "dischetto", "arbitro",
  "guardalinee", "capitano", "panchina", "tribuna", "curva", "Sinigaglia", "Como", "Lariani",
  "blocco basso", "linea difensiva", "classifica", "allenamento", "Serie A", "Champions League", "Como Cup", "Primavera", "Fàbregas"];
const TERMINI_EN = ["corner", "penalty", "offside", "booking", "yellow card", "red card", "sending off", "crossbar",
  "post", "save", "free kick", "throw-in", "stoppage time", "VAR", "foul", "counter-attack", "cross", "header",
  "shot", "goal", "goalkeeper", "defender", "midfielder", "striker", "substitution", "half-time", "first half",
  "second half", "own goal", "assist", "dribble", "pressing", "equaliser", "lead", "penalty area", "referee",
  "linesman", "captain", "bench", "clean sheet", "Sinigaglia", "Como",
  "low block", "defensive line", "the table", "training", "Serie A", "Champions League", "Como Cup", "FA Cup", "Fàbregas"];
let VOCABOLARIO = { quando: 0, squadre: {}, cognomi: {}, leghe: {} };
function fileVocabolario() { return path.join(DIR, "vocabolario.json"); }
function fileAllenatori() { return path.join(DIR, "..", "allenatori.json"); }
function costruisciVocabolario() {
  const squadre = {}, cognomi = {}, leghe = {};
  Object.keys(ESPN).forEach((k) => {
    const e = ESPN[k]; if (!e) return;
    if (e.lega) leghe[e.lega] = (leghe[e.lega] || 0) + 1;
    Object.keys(e.rose || {}).forEach((sq) => {
      const v = squadre[sq] || (squadre[sq] = { giocatori: {}, lega: e.lega || "", ultima: "" });
      if (String(e.quando || "") > v.ultima) { v.ultima = String(e.quando || ""); v.lega = e.lega || v.lega; }
      (e.rose[sq] || []).forEach((n) => {
        const nome = String(n).trim(); if (!nome) return;
        v.giocatori[nome] = (v.giocatori[nome] || 0) + 1;
        const c = nome.split(/\s+/).pop();
        if (c && c.length > 2) cognomi[c] = (cognomi[c] || 0) + 1;
      });
    });
  });
  // gli allenatori, dal file che il ponte delle grafiche tiene aggiornato
  let quantiAll = 0;
  try {
    const a = JSON.parse(fs.readFileSync(fileAllenatori(), "utf8")) || {};
    Object.keys(a.perId || {}).forEach((id) => {
      const x = a.perId[id]; if (!x || !x.squadra) return;
      const v = squadre[x.squadra] || (squadre[x.squadra] = { giocatori: {}, lega: x.lega || "", ultima: "" });
      v.allenatore = [x.nome, x.cognome].filter(Boolean).join(" "); quantiAll++;
      if (x.cognome) cognomi[x.cognome] = (cognomi[x.cognome] || 0) + 1;
    });
  } catch (e) {}
  // per ogni squadra la rosa RECENTE conta piu' di quella di due stagioni
  // fa: si tengono i giocatori visti piu' volte, fino a trentacinque
  Object.keys(squadre).forEach((sq) => {
    const v = squadre[sq];
    v.giocatori = Object.keys(v.giocatori).sort((x, y) => v.giocatori[y] - v.giocatori[x]).slice(0, 35);
  });
  VOCABOLARIO = { quando: Date.now(), squadre: squadre, cognomi: cognomi, leghe: leghe,
                  conteggio: { squadre: Object.keys(squadre).length, cognomi: Object.keys(cognomi).length, allenatori: quantiAll } };
  try { fs.writeFileSync(fileVocabolario(), JSON.stringify(VOCABOLARIO)); } catch (e) {}
  console.log("[clip] vocabolario: " + VOCABOLARIO.conteggio.squadre + " squadre, " + VOCABOLARIO.conteggio.cognomi +
              " cognomi, " + quantiAll + " allenatori");
  return VOCABOLARIO;
}
function leggiVocabolario() {
  try { VOCABOLARIO = JSON.parse(fs.readFileSync(fileVocabolario(), "utf8")) || VOCABOLARIO; } catch (e) {}
  if (!VOCABOLARIO.quando || Date.now() - VOCABOLARIO.quando > 86400000) costruisciVocabolario();
}
// la squadra come la chiama ESPN, partendo da come la chiamiamo noi
function squadraNelVocabolario(nome) {
  const n = String(nome || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const tutte = Object.keys(VOCABOLARIO.squadre || {});
  let meglio = null, voto = 0;
  tutte.forEach((sq) => {
    const q = sq.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    let v = 0;
    if (q === n) v = 3;
    else if (q.indexOf(n) >= 0 || n.indexOf(q) >= 0) v = 2;
    else { const a = new Set(n.split(" ")), b = q.split(" "); const c = b.filter((w) => w.length > 3 && a.has(w)).length; if (c) v = 1 + c * 0.1; }
    if (v > voto) { voto = v; meglio = sq; }
  });
  return voto >= 1.1 ? meglio : null;
}
// Il vocabolario di UNA registrazione: le due squadre, i loro allenatori,
// le rose, la competizione. Senza evento ne' titolo si torna al Como, che
// e' la squadra di casa di chi guarda.
function vocabolarioDi(r) {
  const e = r && r.evento ? ESPN[r.evento] : null;
  let nomi = e && e.squadre && e.squadre.length ? e.squadre.slice() : [];
  if (!nomi.length && r && r.titolo) {
    String(r.titolo).split(/\s*-\s*|\s+vs\.?\s+/i).slice(0, 2).forEach((t) => { const q = squadraNelVocabolario(t); if (q) nomi.push(q); });
  }
  // senza evento ne' titolo si guarda l'ora: se c'e' una partita che ESPN
  // mette in onda adesso — cominciata da meno di due ore e mezza, o che
  // comincia fra poco — e' quasi certamente quella che sta entrando. Il
  // Como ha la precedenza; se no la prima che si trova.
  if (!nomi.length) {
    const ora = Date.now();
    const inOnda = Object.keys(ESPN).map((k) => ESPN[k]).filter((e) => {
      const q = Date.parse(e && e.quando || ""); return q && ora - q < 2.5 * 3600000 && q - ora < 1800000 && e.squadre && e.squadre.length === 2;
    }).sort((x, y) => (/\bComo\b/.test(y.squadre.join(" ")) ? 1 : 0) - (/\bComo\b/.test(x.squadre.join(" ")) ? 1 : 0));
    if (inOnda.length) nomi = inOnda[0].squadre.slice();
  }
  if (!nomi.length) nomi = ["Como"];
  const squadre = [], allenatori = [], giocatori = [];
  nomi.forEach((n) => {
    const sq = VOCABOLARIO.squadre[n] || VOCABOLARIO.squadre[squadraNelVocabolario(n) || ""];
    if (!sq) { squadre.push(n); return; }
    squadre.push(n);
    if (sq.allenatore) allenatori.push(sq.allenatore);
    (e && e.rose && e.rose[n] ? e.rose[n] : sq.giocatori).forEach((g) => giocatori.push(g));
  });
  return { squadre: squadre, allenatori: allenatori, giocatori: giocatori, lega: e ? e.lega : "" };
}
// COME SI DICE UN NOME IN TELECRONACA. Il cognome, quasi sempre — ma non
// l'ultima parola e basta: "Da Cunha" si dice con la particella, e whisper
// lo scriveva "Dacugna" perche' nel prompt c'era solo "Cunha". E quando il
// nome e' corto e famoso si dice intero: "Nico Paz", non "Paz". Regola:
// tutto tranne il primo nome; se il primo nome e' corto (fino a quattro
// lettere) si tiene tutto.
const PARTICELLE = new Set(["da", "de", "di", "del", "della", "van", "von", "der", "den", "le", "la", "el", "al", "dos", "das", "mac", "mc", "ben", "abu"]);
function comeSiDice(nome) {
  const t = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (t.length <= 1) return t[0] || "";
  if (t[0].length <= 4) return t.join(" ");
  let i = 1;
  while (i < t.length - 1 && !PARTICELLE.has(t[i].toLowerCase())) i++;
  return t.slice(PARTICELLE.has(t[i].toLowerCase()) ? i : t.length - 1).join(" ");
}
// Quello che si dice a whisper prima di ogni pezzo. Il modello legge
// soprattutto le prime parole e ne tiene poche (circa duecento token):
// squadre, allenatori e cognomi in testa, i termini in coda, e l'ultima
// frase detta dal vivo per chiudere, quando c'e'.
function promptPer(r, lingua, ultimaFrase) {
  const v = vocabolarioDi(r);
  const it = (lingua || LINGUA_MAM) !== "en";
  const cognomi = [...new Set(v.giocatori.map(comeSiDice).filter((c) => c && c.length > 2))];
  // whisper tiene circa duecento token di prompt e, se e' piu' lungo, tiene
  // gli ULTIMI: la testa — squadre e allenatori — e' la parte che conta e
  // non deve cadere. Quindi si sta sotto i cinquecento caratteri, e a
  // stringere sono i cognomi, non le squadre.
  const fisso = (it ? "Telecronaca di calcio. " : "Football commentary. ") +
    (v.squadre.length ? (it ? "Squadre: " : "Teams: ") + v.squadre.join(", ") + ". " : "") +
    (v.allenatori.length ? (it ? "Allenatori: " : "Coaches: ") + v.allenatori.join(", ") + ". " : "");
  const termini = " " + (it ? TERMINI_IT : TERMINI_EN).slice(0, 8).join(", ") + ".";
  const coda = ultimaFrase ? " " + String(ultimaFrase).slice(-110) : "";
  let quanti = Math.min(40, cognomi.length);
  let testa = "";
  do {
    testa = quanti ? (it ? "Giocatori: " : "Players: ") + cognomi.slice(0, quanti).join(", ") + "." : "";
    quanti -= 4;
  } while (quanti > 8 && (fisso + testa + termini + coda).length > 520);
  return (fisso + testa + termini + coda).replace(/\s+/g, " ").trim();
}
// ── NUMERI E MINUTI COME SI SCRIVONO ───────────────────────────────────
//  "al quarantacinquesimo" diventa "al 45'", "due a uno" diventa "2-1":
//  e' la forma con cui si cerca ("al 45'") e con cui la redazione scrive.
//  Vale per l'italiano e per l'inglese; tutto il resto resta com'e'.
const UNITA_IT = { zero: 0, uno: 1, un: 1, una: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6, sette: 7, otto: 8, nove: 9,
  dieci: 10, undici: 11, dodici: 12, tredici: 13, quattordici: 14, quindici: 15, sedici: 16, diciassette: 17, diciotto: 18,
  diciannove: 19, venti: 20, trenta: 30, quaranta: 40, cinquanta: 50, sessanta: 60, settanta: 70, ottanta: 80, novanta: 90, cento: 100 };
const DECINE_IT = { vent: 20, trent: 30, quarant: 40, cinquant: 50, sessant: 60, settant: 70, ottant: 80, novant: 90, cent: 100 };
function cardinaleIt(w) {
  w = String(w || "").toLowerCase().replace(/[àáâ]/g, "a").replace(/[èéê]/g, "e").replace(/[ìíî]/g, "i").replace(/[òóô]/g, "o").replace(/[ùúû]/g, "u");
  if (UNITA_IT[w] !== undefined) return UNITA_IT[w];
  for (const base of Object.keys(DECINE_IT)) {
    if (!w.startsWith(base)) continue;
    const resto = w.slice(base.length);                 // "i" / "a" / "o" + unita', o l'unita' senza vocale
    const tetto = base === "cent" ? 100 : 10;
    for (const coda of [resto.slice(1), resto]) {
      if (coda === "" && resto.length <= 1) return DECINE_IT[base];
      if (UNITA_IT[coda] !== undefined && UNITA_IT[coda] > 0 && UNITA_IT[coda] < tetto) return DECINE_IT[base] + UNITA_IT[coda];
      if (base === "cent" && coda) { const n = cardinaleIt(coda); if (n !== null && n > 0 && n < 100) return 100 + n; }
    }
  }
  return null;
}
// "quarantacinquesimo" -> 45: si toglie -esimo/-esima e si prova il cardinale
// con e senza la vocale finale (ventitre-esimo, quarant-esimo, sett-imo)
const ORDINALI_IT = { primo: 1, prima: 1, secondo: 2, seconda: 2, terzo: 3, terza: 3, quarto: 4, quarta: 4, quinto: 5, quinta: 5,
  sesto: 6, sesta: 6, settimo: 7, settima: 7, ottavo: 8, ottava: 8, nono: 9, nona: 9, decimo: 10, decima: 10 };
function ordinaleIt(w) {
  const l = String(w || "").toLowerCase();
  if (ORDINALI_IT[l] !== undefined) return ORDINALI_IT[l];
  const m = /^(.+?)esim[oa]$/.exec(l); if (!m) return null;
  const stem = m[1];
  for (const cand of [stem, stem + "o", stem + "a", stem + "e", stem + "i", stem.replace(/tre$/, "tré")]) {
    const n = cardinaleIt(cand); if (n !== null && n > 0) return n;
  }
  return null;
}
const UNITA_EN = { zero: 0, nil: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ORD_EN = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18,
  nineteenth: 19, twentieth: 20, thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60, seventieth: 70, eightieth: 80, ninetieth: 90 };
function cardinaleEn(w) {
  const l = String(w || "").toLowerCase();
  if (UNITA_EN[l] !== undefined) return UNITA_EN[l];
  const m = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)$/.exec(l);
  return m ? UNITA_EN[m[1]] + UNITA_EN[m[2]] : null;
}
function ordinaleEn(w) {
  const l = String(w || "").toLowerCase();
  if (ORD_EN[l] !== undefined) return ORD_EN[l];
  const m = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/.exec(l);
  return m ? UNITA_EN[m[1]] + ORD_EN[m[2]] : null;
}
function numeriNelTesto(testo, lingua) {
  let t = String(testo || "");
  if ((lingua || "it") !== "en") {
    // minuti: "al quarantacinquesimo", "al 45esimo", "nel novantesimo" -> 45'
    t = t.replace(/\b(al|nel|del|il|dal|sul)\s+([a-zàèéìòù]+esim[oa]|\d{1,3}\s?esim[oa])\b(?!\s+(tempo|posto|anno|minuto\s+di))/gi, (m, pre, w) => {
      const n = /^\d/.test(w) ? parseInt(w, 10) : ordinaleIt(w);
      return n !== null && n >= 1 && n <= 125 ? pre + " " + n + "'" : m;
    });
    t = t.replace(/(\d{1,3}')\s+minuto\b/g, "$1");
    // "minuto quarantacinque" -> "minuto 45"
    t = t.replace(/\b(minuto)\s+([a-zàèéìòù]+)\b/gi, (m, pre, w) => { const n = cardinaleIt(w); return n !== null ? pre + " " + n : m; });
    // risultati: "due a uno", "uno a zero", "tre a tre" -> 2-1 (solo numeri piccoli, come i gol)
    t = t.replace(/\b([a-zàèéìòù]+)\s+a\s+([a-zàèéìòù]+)\b/gi, (m, a, b) => {
      const x = cardinaleIt(a), y = cardinaleIt(b);
      return x !== null && y !== null && x <= 15 && y <= 15 && a.toLowerCase() !== "una" ? x + "-" + y : m;
    });
  } else {
    // "in the forty-fifth minute", "the 45th minute" -> 45'
    t = t.replace(/\b(the|in the|on|at)\s+([a-z]+(?:[- ][a-z]+)?|\d{1,3}(?:st|nd|rd|th))\s+minute\b/gi, (m, pre, w) => {
      const n = /^\d/.test(w) ? parseInt(w, 10) : ordinaleEn(w);
      return n !== null && n >= 1 && n <= 125 ? pre + " " + n + "'" : m;
    });
    // "two-nil", "two nil", "three all", "one one" -> 2-0, 3-3, 1-1
    const NUM = "(?:" + Object.keys(UNITA_EN).join("|") + ")(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?";
    t = t.replace(new RegExp("\\b(" + NUM + ")[- ](nil|all|" + NUM + ")\\b", "gi"), (m, a, b) => {
      const x = cardinaleEn(a); if (x === null || x > 15) return m;
      const y = b.toLowerCase() === "all" ? x : cardinaleEn(b);
      return y !== null && y <= 15 ? x + "-" + y : m;
    });
  }
  return t;
}

// I NOMI QUASI GIUSTI SI RADDRIZZANO. whisper scrive "Paturina",
// "Dacugna", "Nicopass": a una o due lettere dal nome vero, e il nome vero
// ce l'abbiamo. Ogni parola maiuscola del testo che non e' gia' un nome
// noto si confronta con i nomi della partita — anche attaccati, "nicopaz",
// perche' whisper fonde nome e cognome — e se la distanza e' piccola si
// mette la forma ufficiale. Solo maiuscole e solo parole lunghe: "Sono",
// "Ecco", "Mentre" non si toccano. Si prova anche la coppia con la parola
// dopo, per "Da Cugna" scritto in due.
function piattaMinuscola(x) { return String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, ""); }
function distanza(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n || Math.abs(m - n) > 3) return 99;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function formeDeiNomi(r) {
  const v = vocabolarioDi(r);
  const forme = new Map();      // forma piatta -> come si scrive
  const metti = (scritto) => { const k = piattaMinuscola(scritto); if (k.length >= 4) forme.set(k, scritto); };
  v.giocatori.forEach((g) => { metti(comeSiDice(g)); metti(g); const c = String(g).split(/\s+/).pop(); if (c.length > 3) metti(c); });
  v.allenatori.forEach((a) => { metti(a); metti(String(a).split(/\s+/).pop()); });
  v.squadre.forEach((sq) => metti(sq));
  return forme;
}
// LE PRONUNCE CONFERMATE. alias.json (in DIR) dice, per come lo scrive
// whisper, qual e' il nome vero: "acco boramon" -> Jacobo Ramón. Le
// propone alias-nomi.py dall'archivio, le conferma una persona, e da li'
// valgono prima di qualsiasi somiglianza — anche quando la distanza e'
// troppa per la regola automatica.
let ALIAS = { quando: 0, voci: {} };
function fileAlias() { return path.join(DIR, "alias.json"); }
function leggiAlias() {
  try {
    const st = fs.statSync(fileAlias());
    if (st.mtimeMs === ALIAS.quando) return;
    const j = JSON.parse(fs.readFileSync(fileAlias(), "utf8")) || {};
    const voci = {};
    Object.keys(j).forEach((k) => { if (j[k]) voci[piattaMinuscola(k)] = String(j[k]); });
    ALIAS = { quando: st.mtimeMs, voci: voci };
    console.log("[clip] alias: " + Object.keys(voci).length + " pronunce confermate");
  } catch (e) { ALIAS = { quando: 0, voci: {} }; }
}
// nomi che non stanno in nessuna rosa ma che l'ASR storpia sempre allo
// stesso modo: lo stadio, le competizioni, le citta' delle avversarie.
// Gli alias verso questi nomi valgono in ogni partita.
const NOMI_FISSI = ["Sinigaglia", "Como Cup", "Champions League", "Serie A", "Serie B", "Serie C", "Primavera",
  "FA Cup", "Lipsia", "Leipzig", "Europa League", "Conference League", "Coppa Italia"];
function applicaAlias(testo, r) {
  leggiAlias();
  // UNA PRONUNCIA VALE SOLO SE QUEL GIOCATORE E' IN CAMPO. "Cugna" e' Marcos
  // Acuña a River Plate e Da Cunha a Como: l'alias e' globale, la partita
  // no. Si tengono solo gli alias il cui nome vero sta nel vocabolario di
  // questa registrazione (rose, allenatori, squadre); per gli altri decide
  // la somiglianza, come prima.
  const inCampo = new Set(NOMI_FISSI.map(piattaMinuscola));
  if (r) {
    const v = vocabolarioDi(r);
    (v.giocatori || []).concat(v.allenatori || [], v.squadre || []).forEach((n) => {
      inCampo.add(piattaMinuscola(n)); const c = String(n).split(/\s+/).pop(); if (c) inCampo.add(piattaMinuscola(c));
    });
  }
  const chiavi = Object.keys(ALIAS.voci).filter((k) => {
    if (!r) return true;
    const nome = ALIAS.voci[k];
    return inCampo.has(piattaMinuscola(nome)) || inCampo.has(piattaMinuscola(String(nome).split(/\s+/).pop()));
  });
  if (!chiavi.length) return { testo: testo, cambi: [], considerati: 0, inCampo: inCampo.size };
  // e da qui in poi si guarda SOLO fra quelle passate dal filtro: guardare
  // in tutto l'elenco vanificava il filtro, e "Cugna" a Como tornava Acuña
  const voci = {}; chiavi.forEach((k) => { voci[k] = ALIAS.voci[k]; });
  const cambi = [];
  // si scorre parola per parola e da ogni parola si provano finestre di
  // tre, due, una parola: la forma piatta della finestra e' l'alias?
  const pezzi = String(testo).split(/(\s+)/);          // parole e spazi, alternati
  const parole = pezzi.map((x, i) => ({ i: i, x: x, w: i % 2 === 0 ? x.replace(/^[^A-Za-zÀ-ÿ']+|[^A-Za-zÀ-ÿ']+$/g, "") : "" }));
  for (let i = 0; i < pezzi.length; i += 2) {
    for (let n = 3; n >= 1; n--) {
      const fine = i + 2 * (n - 1);
      if (fine >= pezzi.length) continue;
      const finestra = [];
      for (let k = i; k <= fine; k += 2) finestra.push(parole[k].w);
      if (finestra.some((w) => !w)) continue;
      const piatta = piattaMinuscola(finestra.join(" "));
      if (!voci[piatta]) continue;
      const nuovo = voci[piatta];
      // si tengono la testa e la coda di punteggiatura della prima e dell'ultima parola
      const testa = (/^[^A-Za-zÀ-ÿ']*/.exec(pezzi[i]) || [""])[0], coda = (/[^A-Za-zÀ-ÿ']*$/.exec(pezzi[fine]) || [""])[0];
      cambi.push(finestra.join(" ") + " → " + nuovo);
      pezzi[i] = testa + nuovo + coda;
      for (let k = i + 1; k <= fine; k++) pezzi[k] = "";
      i = fine; break;
    }
  }
  return { testo: pezzi.join(""), cambi: cambi, considerati: chiavi.length, inCampo: inCampo.size,
           quali: chiavi.slice(0, 20).map((k) => k + "→" + ALIAS.voci[k]) };
}
function correggiConIlVocabolario(testo, r) {
  const conAlias = applicaAlias(testo, r);
  testo = conAlias.testo;
  const forme = formeDeiNomi(r);
  if (!forme.size) return { testo: testo, cambi: conAlias.cambi };
  const chiavi = [...forme.keys()];
  const noti = new Set(chiavi);
  // i NOMI DI BATTESIMO della rosa non si toccano: "Diego" e' Diego Carlos,
  // non una storpiatura di Diao
  vocabolarioDi(r).giocatori.forEach((g) => { const pn = piattaMinuscola(String(g).split(/\s+/)[0]); if (pn.length >= 3) noti.add(pn); });
  const comuni = new Set((TERMINI_IT.concat(TERMINI_EN)).join(" ").toLowerCase().split(/[^a-z]+/));
  const vicinoCon = (parola) => {
    const k = piattaMinuscola(parola);
    if (k.length < 5 || noti.has(k) || comuni.has(k)) return null;
    // quanto si perdona: una lettera sulle parole corte, tre sulle lunghe.
    // "Corso" a due lettere da "Couto" e' una parola, non un errore.
    const tolleranza = k.length >= 9 ? 3 : (k.length >= 7 ? 2 : 1);
    let meglio = null, d0 = 99;
    chiavi.forEach((c) => { const d = distanza(k, c); if (d < d0) { d0 = d; meglio = c; } });
    return meglio && d0 <= tolleranza ? { nome: forme.get(meglio), d: d0 } : null;
  };
  const vicino = (parola) => { const v = vicinoCon(parola); return v ? v.nome : null; };
  const cambi = [];
  const parole = String(testo).split(/(\s+)/);
  for (let i = 0; i < parole.length; i++) {
    const w = parole[i];
    // una particella corta ("Da", "De", "Van") entra solo in coppia con la
    // parola dopo: "Da Cugna" e' Da Cunha, e da sola non vale niente
    // ...anche minuscola: "scarica da Cugna" e' Da Cunha, e il "da" e' suo
    const particella = /^[A-Za-zÀ-ÿ]{2,4}$/.test(w) && PARTICELLE.has(w.toLowerCase()) &&
                       /^[A-ZÀ-Ý]/.test(parole[i + 2] || "");
    if (!particella && !/^[A-ZÀ-Ý][A-Za-zÀ-ÿ']{3,}[.,;:!?]?$/.test(w)) continue;
    const coda = (/[.,;:!?]$/.exec(w) || [""])[0];
    const nuda = coda ? w.slice(0, -1) : w;
    // prima la coppia con la parola dopo ("Da Cugna", "Nico Passe")
    // la parola dopo entra in coppia solo se e' maiuscola: "Nico Passe" e'
    // Nico Paz scritto male, "Nico passa" e' Nico che passa
    const dopo = parole[i + 2];
    if (dopo && /^[A-ZÀ-Ý][A-Za-zÀ-ÿ']{1,}[.,;:!?]?$/.test(dopo)) {
      const coda2 = (/[.,;:!?]$/.exec(dopo) || [""])[0];
      const coppia = vicinoCon(nuda + (coda2 ? dopo.slice(0, -1) : dopo));
      const sola = particella ? null : vicinoCon(nuda);
      const giusto2 = coppia ? coppia.nome : null;
      // la coppia vale solo se il nome vero HA quella particella: "da Cugna"
      // e' Da Cunha, ma "di Nicopas" e' "di" + Nico Paz, e il "di" resta.
      // E vale solo se e' piu' vicina della parola da sola: "Nicopas al" e'
      // Nico Paz seguito da "al", non un nome di due parole.
      const particellaSua = !particella || giusto2 && giusto2.toLowerCase().startsWith(nuda.toLowerCase() + " ");
      const meglioInCoppia = coppia && (!sola || coppia.d < sola.d);
      if (giusto2 && giusto2.indexOf(" ") > 0 && particellaSua && meglioInCoppia) { cambi.push(nuda + " " + dopo + " → " + giusto2); parole[i] = giusto2 + coda2; parole[i + 1] = ""; parole[i + 2] = ""; continue; }
    }
    if (particella) continue;
    const giusto = vicino(nuda);
    if (giusto && giusto !== nuda) { cambi.push(nuda + " → " + giusto); parole[i] = giusto + coda; }
  }
  return { testo: parole.join(""), cambi: conAlias.cambi.concat(cambi), daAlias: conAlias.cambi, daSomiglianza: cambi };
}
// I NOMI NON SI TRADUCONO. Prima di dare la frase ad Argos i nomi noti —
// giocatori, allenatori, squadre della partita — si coprono con un
// segnaposto, e dopo si rimettono. Se il traduttore perde un segnaposto si
// tiene la traduzione nuda: meglio "bank" che una frase con un buco.
function coprendoINomi(testo, r) {
  const v = vocabolarioDi(r);
  const nomi = new Set();
  v.squadre.forEach((x) => nomi.add(x));
  v.allenatori.forEach((x) => { nomi.add(x); nomi.add(x.split(/\s+/).pop()); });
  v.giocatori.forEach((x) => { nomi.add(x); const c = x.split(/\s+/).pop(); if (c.length > 2) nomi.add(c); });
  const lista = [...nomi].filter((x) => x && x.length > 2).sort((a, b) => b.length - a.length);
  const messi = [];
  let coperto = testo;
  const piatto = (x) => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const scappa = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  lista.forEach((nome) => {
    const forme = [...new Set([nome, piatto(nome)])].map(scappa).join("|");
    const re = new RegExp("(^|[^A-Za-zÀ-ÿ])(?:" + forme + ")(?=$|[^A-Za-zÀ-ÿ])", "g");
    if (!re.test(coperto)) return;
    const k = messi.length; messi.push(nome);
    coperto = coperto.replace(re, (m, pre) => pre + "NOME" + k + "X");
  });
  return { coperto: coperto, messi: messi };
}
function scoprendoINomi(tradotto, messi) {
  let t = String(tradotto || "");
  for (let k = 0; k < messi.length; k++) {
    const re = new RegExp("NOME\\s?" + k + "\\s?X", "gi");
    if (!re.test(t)) return null;                       // perso: non ci si fida
    t = t.replace(re, messi[k]);
  }
  return t;
}
// IL GLOSSARIO DEL CALCIO. "Direttore di gara" per Argos e' un "race
// director": le locuzioni del mestiere si coprono prima e si scoprono dopo
// gia' tradotte, nelle due direzioni. La stessa strada dei nomi.
const GLOSSARIO = [["direttore di gara", "referee"], ["calcio d'angolo", "corner"], ["fuorigioco", "offside"],
  ["calcio di rigore", "penalty"], ["rigore", "penalty"], ["traversa", "crossbar"], ["calcio di punizione", "free kick"],
  ["punizione", "free kick"], ["rimessa laterale", "throw-in"], ["rimessa dal fondo", "goal kick"], ["recupero", "stoppage time"],
  ["ammonizione", "booking"], ["espulsione", "sending-off"], ["cartellino giallo", "yellow card"], ["cartellino rosso", "red card"],
  ["portiere", "goalkeeper"], ["contropiede", "counter-attack"], ["colpo di testa", "header"], ["autogol", "own goal"],
  ["area di rigore", "penalty area"], ["dischetto", "penalty spot"], ["guardalinee", "linesman"], ["assistente", "assistant referee"],
  ["intervallo", "half-time"], ["primo tempo", "first half"], ["secondo tempo", "second half"], ["pareggio", "equaliser"],
  ["raddoppio", "second goal"], ["tiro", "shot"], ["parata", "save"], ["cross", "cross"], ["fallo", "foul"],
  ["esultanza", "celebration"], ["panchina", "bench"], ["capitano", "captain"], ["difensore", "defender"],
  ["centrocampista", "midfielder"], ["attaccante", "striker"], ["allenatore", "manager"], ["tecnico", "manager"],
  ["fischio finale", "final whistle"], ["fischio d'inizio", "kick-off"], ["calcio d'inizio", "kick-off"],
  ["ammonisce", "books"], ["ammonito", "booked"], ["espulso", "sent off"], ["segna", "scores"], ["ha segnato", "has scored"],
  ["fuori", "wide"], ["alto", "over the bar"], ["in rete", "into the net"], ["porta", "goal"], ["arbitro", "referee"],
  // dalla guida SRT di Manolo (17_AI Motori/Como_1907_SRT_Context_for_Claude.docx): inglese da broadcast, non letterale
  ["blocco basso", "low block"], ["linea difensiva", "defensive line"], ["contropiedi", "counterattacks"],
  ["classifica", "the table"], ["allenamenti", "training"], ["allenamento", "training"], ["tre punti", "three points"],
  ["il campo", "the pitch"], ["dal primo giorno", "since day one"], ["fare un primo bilancio", "take stock"],
  ["entrato in campo", "came onto the pitch"], ["Serie A", "Serie A"], ["Champions League", "Champions League"],
  ["Como Cup", "Como Cup"], ["Sinigaglia", "Sinigaglia"]];
function coprendoIlGlossario(testo, da, a) {
  const messi = [];
  let coperto = testo;
  // le locuzioni lunghe prima, misurate nella lingua di PARTENZA: "penalty
  // spot" deve vincere su "penalty", "calcio di rigore" su "rigore"
  const coppie = GLOSSARIO.slice().sort((x, y) => (da === "it" ? y[0].length - x[0].length : y[1].length - x[1].length));
  coppie.forEach(([it, en]) => {
    const [suo, altro] = da === "it" ? [it, en] : [en, it];
    if (!suo || suo === altro) return;
    const re = new RegExp("(^|[^A-Za-zÀ-ÿ])" + suo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^A-Za-zÀ-ÿ])", "gi");
    if (!re.test(coperto)) return;
    const k = messi.length; messi.push(altro);
    coperto = coperto.replace(re, (m, pre) => pre + "TERM" + k + "X");
  });
  return { coperto: coperto, messi: messi };
}
function scoprendoIlGlossario(tradotto, messi) {
  let t = String(tradotto || "");
  for (let k = 0; k < messi.length; k++) {
    const re = new RegExp("TERM\\s?" + k + "\\s?X", "gi");
    if (!re.test(t)) return null;
    t = t.replace(re, messi[k]);
  }
  return t;
}
async function traduciConINomi(testi, da, a, r) {
  // prima il glossario, poi i nomi: due strati di segnaposto diversi
  const glos = testi.map((x) => coprendoIlGlossario(x, da, a));
  const coperti = glos.map((g) => coprendoINomi(g.coperto, r));
  const tr = await traduci(coperti.map((c) => c.coperto), da, a);
  if (!tr) return null;
  const fuori = tr.map((t, i) => { const n1 = scoprendoINomi(t, coperti[i].messi); return n1 === null ? null : scoprendoIlGlossario(n1, glos[i].messi); });
  if (fuori.some((x) => x === null)) {
    const nudi = await traduci(testi, da, a);
    return fuori.map((x, i) => x !== null ? x : (nudi ? nudi[i] : ""));
  }
  return fuori;
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
  const voc = vocabolarioDi(r);
  const daVoc = voc.giocatori.map((g) => String(g).split(/\s+/).pop()).filter((c) => c && c.length > 2);
  const lista = [...new Set(dalleRose.concat(daVoc).concat([...parole]))].slice(0, 70).join(", ");
  const testa = (voc.squadre.length ? "Squadre: " + voc.squadre.join(", ") + ". " : "") +
                (voc.allenatori.length ? "Allenatori: " + voc.allenatori.join(", ") + ". " : "");
  return lista ? ("Telecronaca di calcio. " + testa + "Nomi: " + lista + ". " + TERMINI_IT.slice(0, 10).join(", ") + ".") : "";
}

function trascriviDavvero(lavoro) {
  const r = R.reg[lavoro.reg];
  if (!r) return Promise.reject(new Error("registrazione sparita"));
  const fonte = r.arch ? fonteAl(r, lavoro.da) : null;
  const via = fonte ? fonte.via : sorgenteAudio(r);
  const daQui = fonte ? fonte.dentro : lavoro.da;
  const finoA = fonte ? Math.min(lavoro.a, fonte.fine) : lavoro.a;
  const dir = cartellaReg(r.id);
  // una registrazione vecchia puo' non avere ancora la sua cartella: senza,
  // ffmpeg non sa dove scrivere e la trascrizione muore in silenzio
  assicura(dir);
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
    // -ml 90 -sow: righe da sottotitolo, non da muro di testo. Un segmento di
    // trenta secondi in una striscia sotto il video non si legge; novanta
    // caratteri spezzati sulle parole si'.
    const args = ["-m", modelloPer(lavoro.lingua || LINGUA_MAM, false), "-l", lavoro.lingua || LINGUA_MAM, "-f", wav, "-oj", "-of",
                  path.join(dir, "voce"), "-t", "2", "-np", "-nt", "-mc", "0", "-et", "2.8", "-ml", "90", "-sow"];
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
    // anche in archivio i numeri si scrivono come si cercano (45', 2-1) e
    // i nomi quasi giusti si raddrizzano col vocabolario della partita
    const linguaPezzi = lavoro.lingua || LINGUA_MAM;
    // ogni riga porta la SUA lingua: i sottotitoli e la traduzione decidono
    // da li' che cosa mostrare e in che verso tradurre. Senza, una
    // telecronaca inglese passava per italiana e finiva tradotta "da
    // italiano a inglese".
    const pezzi = (j.transcription || []).map((t) => ({
      a: Math.round((t.offsets.from / 1000 + lavoro.da) * 10) / 10,
      b: Math.round((t.offsets.to / 1000 + lavoro.da) * 10) / 10,
      x: correggiConIlVocabolario(numeriNelTesto(String(t.text || "").trim(), linguaPezzi), r).testo,
      l: linguaPezzi
    })).filter((t) => t.x);

    const dentro = PARLATO[r.id] || (PARLATO[r.id] = { lingua: linguaPezzi, pezzi: [] });
    dentro.lingua = linguaPezzi;
    if (r.voceFallita) { delete r.voceFallita; scrivi(); }
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
    // ...ma le righe corrette a mano restano: sono verita', non stima
    dentro.pezzi = dentro.pezzi.filter((t) => t.m || t.b <= lavoro.da || t.a >= lavoro.a)
                               .concat(pezzi)
                               .sort((x, y) => x.a - y.a);
    scriviParlato();
    try { if (r.arch && ARCHIVIO[r.arch.rec] && !ARCHIVIO[r.arch.rec].orologio) ancoraSeManca(r.arch.rec); } catch (e) {}
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
// GLI APPUNTI SONO DELLA PARTITA, NON DELLA VERSIONE. La redazione li scrive
// sulla riga ITA; la ENG e l'audio internazionale sono la stessa partita e
// restavano senza (113 partite in casa su 274, il 25/09/2026). Li ereditano
// dalla gemella — stesso giorno, stesse squadre — segnati "ereditati": i
// minuti sono della partita, e il cronometro di ogni file li mette al secondo.
function appuntiGemelli() {
  const conAppunti = new Map();
  Object.keys(ARCHIVIO).forEach((k) => {
    const a = ARCHIVIO[k], ap = APPUNTI[k];
    if (!a || !ap || !(ap.righe || []).length || ap.ereditati || DA_STUDIO.test(a.partita || "")) return;
    const c = chiaveGemella(a); if (!c) return;
    // a parita', quella in italiano (e' li' che scrive la redazione); poi
    // quella con piu' righe, poi la chiave. SEMPRE LA STESSA: la scelta
    // dipendeva dall'ordine delle chiavi, che cambia a ogni scandaglio, e
    // nove versioni cambiavano fonte a ogni avvio perdendo i boati (26/09)
    const voto = (x) => [/\bITA\b/i.test((ARCHIVIO[x] || {}).partita || "") ? 1 : 0, ((APPUNTI[x] || {}).righe || []).length];
    const g = conAppunti.get(c);
    if (!g) { conAppunti.set(c, k); return; }
    const vk = voto(k), vg = voto(g);
    if (vk[0] > vg[0] || (vk[0] === vg[0] && (vk[1] > vg[1] || (vk[1] === vg[1] && k < g)))) conAppunti.set(c, k);
  });
  let dati = 0;
  Object.keys(ARCHIVIO).forEach((k) => {
    const a = ARCHIVIO[k];
    if (!a || k.startsWith("s3:") || DA_STUDIO.test(a.partita || "")) return;
    if (APPUNTI[k] && (APPUNTI[k].righe || []).length && !APPUNTI[k].ereditati) return;
    const c = chiaveGemella(a), da = c && conAppunti.get(c);
    if (!da || da === k) return;
    // nuovi davvero solo se cambiano le righe. L'impronta sta sulla partita:
    // l'import di Airtable all'avvio rimette a queste versioni i loro appunti
    // vuoti, e confrontare con quelli rifaceva i boati a ogni riavvio (26/09)
    const impronta = crypto.createHash("md5").update(JSON.stringify(((APPUNTI[da] || {}).righe || []).map((y) => [y.m, y.t, y.x]))).digest("hex").slice(0, 16);
    // (la prima volta, chi ha gia' ereditato da questa gemella non e' nuovo)
    const nuovo = a.appuntiImpronta === undefined ? !(APPUNTI[k] && APPUNTI[k].ereditati === da) : a.appuntiImpronta !== impronta;
    a.appuntiImpronta = impronta;
    const eng = /(^|[^A-Z])ENG([^A-Z]|$)/.test(String(a.partita || "").toUpperCase());
    APPUNTI[k] = Object.assign({}, APPUNTI[da], { partita: a.partita || APPUNTI[da].partita, ereditati: da,
      telecronista: eng ? "Paul Dempsey" : (/AUDIO ?ONLY/i.test(a.partita || "") ? "" : APPUNTI[da].telecronista) });
    // col puntamento fatto senza appunti si rifanno i boati
    if (nuovo) { delete a.boatiFatti; dati++; }
  });
  if (dati) { scriviArchivioAppunti(); scriviArchivio(); console.log("[clip] appunti: " + dati + " versioni (ENG, audio) prendono quelli della gemella"); }
  return dati;
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
  appuntiGemelli();
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
  appuntiGemelli();
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

// ── IL FISCHIO DALLA TELECRONACA ─────────────────────────────────
//  Quando il cronometro in sovrimpressione non si legge (grafica diversa,
//  file senza orologio) resta la voce. Il telecronista dice "fischia,
//  comincia il secondo tempo"; chiama il gol di Kamara che ESPN e gli
//  appunti mettono al 29'; dice "siamo al 23'". Ogni frase e' un'ancora
//  con un peso; le ancore che vanno d'accordo entro un minuto e mezzo
//  fanno il fischio. Stessa forma del cronometro letto (inizio1/inizio2
//  sull'asse dei pezzi, dal kickoff stimato), cosi' il resto non cambia.
//  Udinese-Como [ITA]: cronometro mai letto, appunti al 15' che cadevano
//  al minuto 8 del file; il fischio vero e' al 5', la ripresa al 72'
//  (in mezzo c'e' una puntata di Goleada).
function pianoTesto(x) { return String(x || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
// da un secondo della registrazione all'asse del materiale: quello di
// doveCade, che conta dal calcio d'inizio STIMATO (il "da" del primo pezzo
// e' -kickoff, quindi un fischio letto a 299s di file con kickoff 263 fa
// inizio1 = 36, come nel cronometro letto). Senza pezzi, l'asse e' il
// file meno il kickoff.
function alMateriale(a, r, t) {
  const q = pezzoAl(r, t);
  const pezzi = (a.pezzi || []).filter((x) => x.da !== null && x.da !== undefined);
  if (!q || !pezzi.length) return t - (a.kickoff || 0);
  const idx = (r.arch && r.arch.pezzi && r.arch.pezzi.length > 1) ? q.i : ((r.arch && r.arch.pezzo) || 0);
  const p = pezzi[idx] || pezzi[0];
  return (p.da || 0) + q.dentro;
}
function regsDellaPartita(rec) {
  return Object.keys(R.reg).map((k) => R.reg[k]).filter((r) => r.arch && r.arch.rec === rec);
}
const FISCHIO_1T = /fischi[ao]\b.{0,30}\b(inizio|via|comincia|si parte|partit|iniz)|(inizio|si parte|si comincia|comincia)\b.{0,30}\bfischi|calcio d.{0,2}inizio|\bsi parte\b|\bsi comincia\b|\bcomincia (la partita|il match|la gara|la sfida|l.incontro|il primo tempo)\b|\bpartiti\b|palla al centro|prende il via|\be.{0,2} (iniziata|cominciata)\b|\b(inizia|comincia|via al|al via il) (la partita|il match|la gara|il primo tempo)|kick.?off|under ?way|we.re off|here we go|get(s)? us started/;
const FISCHIO_2T = /(comincia|inizia|riparte|ricomincia|si riparte|fischi[ao]|al via|via al|parte)\b.{0,40}\b(secondo tempo|ripresa|seconda frazione)|(secondo tempo|ripresa|seconda frazione)\b.{0,40}\b(comincia|inizia|al via|si parte|si riparte|riparte|ricomincia|e.{0,2} cominciat|e.{0,2} iniziat)|\bsi riparte\b|\bsi ricomincia\b|second half (is )?(under ?way|begins|starts|gets)|back under ?way|restart/;
const NON_ADESSO = /\b(fra|tra) (poco|pochissimo|qualche|un|pochi|due|tre|cinque|dieci|quindici)\b|a breve|\bmanca(no)?\b|minuti al|prima del fischio|dopo il fischio|\bieri\b|scors[aoie]\b|ultim[aoie]\b|fischi dalla|fischiat|\bnon (comincia|inizia|riparte)|quando (comincia|inizia|riparte)|all.andata|al ritorno|la prossima|moments away|minutes away|about to|shortly|\bsoon\b|earlier|last (week|season|time)/;
const MINUTO_DETTO = /\b(\d{1,2})\s?(?:°|º|esimo)?\s?(?:minuto|di gioco|del primo tempo|del secondo tempo|di gara|minute)\b|\bminuto (\d{1,2})\b|\bsiamo al (\d{1,2})\b|\b(\d{1,2})[°º]|\bminute (\d{1,2})\b/g;
function paroleDelTipo(tipo) {
  const t = pianoTesto(tipo);
  if (/goal|gol|rete|scored/.test(t) && !/miss|saved/.test(t)) return /\b(gol|goal|rete|segna|vantaggio|pareggi|raddoppi|in rete|la mette dentro|gonfia|scores|finds the net|back of the net|equalis|ahead)/;
  if (/yellow|ammon|giallo/.test(t)) return /\b(giallo|ammonit|cartellino|ammonizione|yellow|booked|booking|caution)/;
  if (/red|espuls|rosso/.test(t)) return /\b(rosso|espuls|red card|sent off|dismiss)/;
  if (/substitution|sostitu|cambio/.test(t)) return /\b(cambio|sostituzion|entra|esce|al posto|lascia il campo|richiamato|substitut|replaces|comes on|goes off|replaced)/;
  if (/penalty|rigor/.test(t)) return /\b(rigore|dischetto|undici metri|penalty|spot)/;
  if (/parat/.test(t)) return /\b(parat|para\b|respin|salva|miracol|save)/;
  if (/occasion|palo|traversa/.test(t)) return /\b(occasion|palo|traversa|tiro|conclusion|colpo di testa|vicin|sfiora|chance|post|crossbar)/;
  if (/angolo|corner/.test(t)) return /\b(angolo|corner)/;
  if (/punizion|free/.test(t)) return /\b(punizion|free kick)/;
  return null;
}
function cognomiDi(nome, testoAppunto) {
  const fuori = [];
  const agg = (w) => { w = pianoTesto(w).replace(/[^a-z]/g, ""); if (w.length >= 3 && fuori.indexOf(w) < 0) fuori.push(w); };
  if (nome) { const p = String(nome).trim().split(/\s+/); agg(p[p.length - 1]); if (p.length > 1 && p[p.length - 1].length <= 3) agg(p.slice(-2).join("")); }
  if (testoAppunto) String(testoAppunto).split(/[^A-Za-zÀ-ÿ']+/).slice(1).forEach((w) => {
    if (w.length >= 4 && /^[A-ZÀ-Ý]/.test(w) && !/^(GOL|Gol|Occasione|Parata|Udinese|Como|Serie|Butez|Okoye)$/.test(w)) agg(w);
  });
  return fuori;
}
// le ancore di un tempo: valori sull'asse del materiale, con un peso
function ancoreDelTempo(rec, tempo, righe, inizio1) {
  const cand = [];
  const prima = tempo === 2 ? (inizio1 === null ? 2400 : inizio1 + 2700 + 240) : -900;
  const dopo = tempo === 2 ? (inizio1 === null ? 7200 : inizio1 + 2700 + 3600) : 3600;
  const dentro = (v) => v >= prima && v <= dopo;
  // 1) le frasi del fischio
  const re = tempo === 2 ? FISCHIO_2T : FISCHIO_1T;
  righe.forEach((x) => {
    if (!re.test(x.t) || NON_ADESSO.test(x.t)) return;
    if (tempo === 1 && FISCHIO_2T.test(x.t)) return;
    if (!dentro(x.m)) return;
    cand.push({ v: x.m, w: 3, come: "frase", testo: x.testo, t: x.s, reg: x.reg });
  });
  // 2) gli eventi con un minuto: ESPN e appunti. Ogni evento vale uno (due
  //    un gol) e lo divide fra le frasi in cui e' nominato
  const eventi = [];
  const e = ESPN[rec];
  if (e && e.eventi) e.eventi.forEach((x) => {
    const per = x.periodo === 2 || (!x.periodo && x.min > 45) ? 2 : 1;
    if (per !== tempo) return;
    const sec = Math.max(0, (x.min - (per === 2 ? 45 : 0) - 1) * 60 + 30 + (x.stopp || 0) * 60);
    eventi.push({ sec, nomi: cognomiDi(x.giocatore), tipo: paroleDelTipo(x.tipo), w: /goal|scored/i.test(x.tipo) ? 2 : 1, che: "ESPN " + x.min + "' " + (x.giocatore || "") + " " + x.tipo });
  });
  const ap = APPUNTI[rec];
  const rit = ritardoPartita(rec);
  if (ap && ap.righe) ap.righe.forEach((x) => {
    if ((x.s || 1) !== tempo) return;
    const nomi = cognomiDi("", x.x);
    if (!nomi.length) return;
    eventi.push({ sec: Math.max(0, (x.d || 0) - rit), nomi, tipo: paroleDelTipo(x.t || x.x), w: /gol|rete/i.test(x.t || "") || x.g ? 2 : (x.t ? 1 : 0.5), che: "appunti " + (x.m || "") + " " + String(x.x || "").slice(0, 50) });
  });
  eventi.forEach((ev) => {
    const trovate = [];
    righe.forEach((x, i) => {
      const v = x.m - ev.sec;
      if (!dentro(x.m) || v < prima || v > dopo) return;
      if (!ev.nomi.some((n) => new RegExp("\\b" + n).test(x.p))) return;
      if (ev.tipo) {
        const vicino = (righe[i - 1] ? righe[i - 1].t + " " : "") + x.t + (righe[i + 1] ? " " + righe[i + 1].t : "");
        if (!ev.tipo.test(vicino)) return;
      }
      trovate.push({ v, testo: x.testo, t: x.s, reg: x.reg });
    });
    if (!trovate.length) return;
    trovate.forEach((f) => cand.push({ v: f.v, w: ev.w / trovate.length, come: "evento", testo: f.testo, t: f.t, reg: f.reg, che: ev.che }));
  });
  // 3) i minuti detti a voce ("siamo al 23'", "al 45°")
  righe.forEach((x) => {
    MINUTO_DETTO.lastIndex = 0;
    let m;
    while ((m = MINUTO_DETTO.exec(x.t))) {
      const min = +(m[1] || m[2] || m[3] || m[4] || m[5]);
      if (!min || min > 95) continue;
      const per = min > 45 ? 2 : 1;
      if (per !== tempo) continue;
      const v = x.m - ((min - (per === 2 ? 45 : 0)) - 0.5) * 60;
      if (v < prima || v > dopo) continue;
      cand.push({ v, w: 1, come: "minuto", testo: x.testo, t: x.s, reg: x.reg });
    }
  });
  if (!cand.length) return null;
  // il gruppo piu' pesante entro 150 secondi, poi la mediana pesata
  cand.sort((p, q) => p.v - q.v);
  let meglio = null;
  for (let i = 0; i < cand.length; i++) {
    let w = 0, j = i;
    while (j < cand.length && cand[j].v - cand[i].v <= 150) { w += cand[j].w; j++; }
    if (!meglio || w > meglio.w) meglio = { i, j, w };
  }
  const gruppo = cand.slice(meglio.i, meglio.j);
  const frasi = gruppo.some((c) => c.come === "frase");
  // una frase sola basta per la ripresa ("fischia, comincia il secondo
  // tempo"); per il primo tempo no: prima del fischio si parla di tutto,
  // e "si parte" puo' essere la sigla. Ci vuole almeno un'altra prova.
  if (meglio.w < 3 || (gruppo.length < 2 && !(frasi && tempo === 2))) return { scarso: true, peso: Math.round(meglio.w * 10) / 10, prove: gruppo.slice(0, 6) };
  let acc = 0, val = gruppo[0].v;
  for (const c of gruppo) { acc += c.w; if (acc >= meglio.w / 2) { val = c.v; break; } }
  // "fischia, comincia il secondo tempo" e' detto AL fischio: se una frase
  // cosi' sta nel gruppo, e' lei il secondo giusto, non la media degli altri
  if (frasi) {
    const f = gruppo.filter((c) => c.come === "frase").sort((p, q) => Math.abs(p.v - val) - Math.abs(q.v - val))[0];
    val = f.v;
  }
  return { inizio: Math.round(val), peso: Math.round(meglio.w * 10) / 10, quante: gruppo.length,
           prove: gruppo.sort((p, q) => q.w - p.w).slice(0, 6).map((c) => ({ t: Math.round(c.t), v: Math.round(c.v), w: Math.round(c.w * 10) / 10, come: c.come, che: c.che || "", testo: String(c.testo || "").slice(0, 120) })) };
}
function ancoraDallaTelecronaca(rec) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  const righe = [];
  regsDellaPartita(rec).forEach((r) => {
    const d = PARLATO[r.id];
    if (!d || !(d.pezzi || []).length) return;
    d.pezzi.forEach((x) => {
      if (x.vivo || !x.x) return;
      const t = pianoTesto(x.x);
      righe.push({ s: x.a, m: alMateriale(a, r, x.a), t, p: t.replace(/[^a-z ]/g, ""), testo: x.x, reg: r.id });
    });
  });
  if (righe.length < 20) return null;
  righe.sort((p, q) => p.m - q.m);
  const uno = ancoreDelTempo(rec, 1, righe, null);
  const inizio1 = uno && uno.inizio !== undefined ? uno.inizio : null;
  const due = ancoreDelTempo(rec, 2, righe, inizio1);
  const inizio2 = due && due.inizio !== undefined ? due.inizio : null;
  if (inizio1 === null && inizio2 === null) return null;
  const esito = { fonte: "telecronaca", quando: new Date().toISOString(), letti: 0, verificato: false, fonti: {},
                  prove: { 1: uno ? uno.prove : [], 2: due ? due.prove : [] }, pesi: { 1: uno ? uno.peso : 0, 2: due ? due.peso : 0 } };
  if (inizio1 !== null) { esito.inizio1 = inizio1; esito.fonti["1"] = "telecronaca"; }
  if (inizio2 !== null) { esito.inizio2 = inizio2; esito.fonti["2"] = "telecronaca"; }
  return esito;
}
// il fischio vale per tutti: l'indice dell'archivio, le registrazioni
// aperte su quella partita (r.kickoff), il fermo immagine
function applicaOrologio(rec, esito) {
  const a = ARCHIVIO[rec];
  if (!a) return;
  if (esito && ((esito.inizio1 !== undefined && esito.inizio1 !== null) || (esito.inizio2 !== undefined && esito.inizio2 !== null))) {
    esito.fonti = Object.assign({}, esito.fonti || {});
    ["1", "2"].forEach((n) => {
      if (esito["inizio" + n] === undefined || esito["inizio" + n] === null) { delete esito["inizio" + n]; delete esito.fonti[n]; return; }
      if (!esito.fonti[n]) esito.fonti[n] = esito.fonte || "cronometro";
    });
    a.orologio = esito; delete a.orologioFallito;
  } else delete a.orologio;
  const kick0 = (a.kickoff !== null && a.kickoff !== undefined) ? a.kickoff : null;
  const o = a.orologio || {};
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (!r.arch || r.arch.rec !== rec || (r.arch.pezzo || 0) !== 0) return;
    const kk = {};
    if (kick0 !== null) {
      if (o.inizio1 !== undefined) kk["1"] = Math.max(0, Math.round(kick0 + o.inizio1));
      else kk["1"] = kick0;
      if (o.inizio2 !== undefined) kk["2"] = Math.max(0, Math.round(kick0 + o.inizio2));
    }
    r.kickoff = kk; r.mini = ""; miniaturaViva(r).catch(() => {});
  });
  scrivi(); annuncia(0, "clip");
  scriviArchivio();
}
// il fischio segnato da una persona sul video: vince su tutto
function ancoraAMano(rec, r, tempo, secondi) {
  const a = ARCHIVIO[rec];
  if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
  const n = String(tempo) === "2" ? "2" : "1";
  const o = Object.assign({}, a.orologio || {}, { fonti: Object.assign({}, (a.orologio || {}).fonti || {}) });
  if (secondi === null || secondi === undefined || secondi === "") { delete o["inizio" + n]; delete o.fonti[n]; }
  else {
    o["inizio" + n] = Math.round(r ? alMateriale(a, r, +secondi) : (+secondi - (a.kickoff || 0)));
    o.fonti[n] = "mano";
  }
  o.fonte = "mano"; o.quando = new Date().toISOString(); delete o.verificato; delete o.scarto;
  applicaOrologio(rec, o);
  return a.orologio || null;
}
// se il cronometro manca, si prova con la voce: una volta per ogni stato
// della telecronaca, cosi' non si rifa' il conto a ogni tabellino
function ancoraSeManca(rec, anchePerForza) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  if (a.orologio) return a.orologio;
  // da sola (senza che qualcuno prema il tasto) la voce si prova solo dove
  // c'e' una partita con eventi: su uno show in studio non c'e' nessun fischio
  if (!anchePerForza && !((ESPN[rec] || {}).eventi || []).length && !((APPUNTI[rec] || {}).righe || []).length) return null;
  const firma = regsDellaPartita(rec).map((r) => { const d = PARLATO[r.id]; return r.id + ":" + ((d && d.intera) || "") + ":" + ((d && d.pezzi) ? d.pezzi.length : 0); }).join("|") +
                "#" + (((ESPN[rec] || {}).eventi || []).length) + "/" + (((APPUNTI[rec] || {}).righe || []).length);
  if (a.voceProvata === firma) return null;
  a.voceProvata = firma;
  let e = null;
  try { e = ancoraDallaTelecronaca(rec); } catch (err) { console.log("[clip] fischio dalla voce (" + (a.partita || rec) + "): " + err.message); }
  if (e) {
    applicaOrologio(rec, e);
    console.log("[clip] fischio dalla telecronaca: " + (a.partita || rec) + " → 1T " + (e.inizio1 === undefined ? "?" : e.inizio1 + "s (peso " + e.pesi["1"] + ")") +
                ", 2T " + (e.inizio2 === undefined ? "?" : e.inizio2 + "s (peso " + e.pesi["2"] + ")"));
  } else scriviArchivio();
  return e;
}

function secondoNelFile(rec, r) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  // secondi dal calcio d'inizio: il secondo tempo comincia un'ora dopo,
  // quarantacinque di gioco piu' un intervallo che nessuno cronometra
  // ...a meno che il cronometro non sia stato letto dal video: allora i due
  // tempi cominciano dove cominciano davvero (vedi calibraOrologio)
  const o = a.orologio || {};
  const i1 = (o.inizio1 !== undefined && o.inizio1 !== null) ? o.inizio1 : 0;
  const inizio = r.s === 2
    ? (o.inizio2 !== undefined && o.inizio2 !== null ? o.inizio2
       : (ripresaStimata(a) === null ? i1 + 60 * 60 : ripresaStimata(a)))
    : i1;
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
// IL FOTOGRAMMA DAL PONTE. Se il file sta dietro il ponte S3 (la EC2 a
// Parigi), il fotogramma lo estrae la EC2 e qui arriva solo l'immagine:
// cento kB invece dei sette mega che costa leggere indice e GOP da fuori.
function pontePer(via) {
  const m = MAGAZZINI.filter((x) => x.inventario && x.ponte && String(via || "").startsWith(x.ponte + "/o/"))[0];
  return m ? { ponte: m.ponte, chiave: decodeURIComponent(String(via).slice(m.ponte.length + 3)) } : null;
}
function fotogrammaDalPonte(p, sec, fuori, come) {
  return new Promise((ok) => {
    const q = new URLSearchParams({ k: p.chiave, t: String(Math.max(0, sec)) });
    if (come && come.crop) q.set("c", come.crop);
    if (come && come.png) q.set("fmt", "png");
    if (come && come.w) q.set("w", String(come.w));
    if (come && come.q) q.set("q", String(come.q));
    const r = http.get(p.ponte + "/f?" + q.toString(), { timeout: 150000 }, (res) => {
      if (res.statusCode !== 200) { let t = ""; res.on("data", (b) => { t += b; }); res.on("end", () => { console.log("[clip] ponte S3: fotogramma a " + sec + "s: " + res.statusCode + " " + t.slice(0, 120)); ok(false); }); return; }
      const w = fs.createWriteStream(fuori);
      res.pipe(w); w.on("finish", () => ok(true)); w.on("error", () => ok(false));
    });
    r.on("error", (e) => { console.log("[clip] ponte S3: " + e.message); ok(false); });
    r.on("timeout", () => { r.destroy(new Error("tempo scaduto")); });
  });
}
function fasciaAlta(via, sec) {
  const pp = pontePer(via);
  if (pp) {
    // in JPEG: la fascia alta in PNG pesava mezzo mega a fotogramma, e un
    // cronometro letto e verificato ne prende venti (12 MB → ~3 MB)
    const jpg = path.join(os.tmpdir(), "orologio-" + nuovoId("") + ".jpg");
    return fotogrammaDalPonte(pp, sec, jpg, { crop: "top", q: 3 }).then((si) => si ? jpg : null);
  }
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
// ── QUANDO SI ESPORTA UN VIDEO, IL MAM ASPETTA ─────────────────────────
//  Le due macchine sono due core: l'export di una grafica (Chrome e ffmpeg,
//  a priorita' bassa) con la lettura dei cronometri accanto passava da un
//  minuto a quattro. Allora si chiede ai due servizi di export (prod e dev)
//  se stanno lavorando, e finche' uno lavora il MAM non comincia il passo
//  dopo. I processi gia' partiti non si congelano: hanno un tempo massimo e
//  verrebbero uccisi come falliti. Un servizio spento non ferma niente.
const ESPORTA_SALUTE = (process.env.COMOTV_ESPORTA_SALUTE || "http://127.0.0.1:8090/salute http://127.0.0.1:8091/salute")
  .split(/\s+/).filter(Boolean);
let esportaVisto = 0, esportaOccupato = false, esportaDetto = false;
function chiediEsporta(url) {
  return new Promise((ok) => {
    const q = http.get(url, { timeout: 2000 }, (res) => {
      let t = ""; res.on("data", (b) => { t += b; });
      res.on("end", () => { try { const j = JSON.parse(t); ok(!!(j.occupato || j.coda)); } catch (e) { ok(false); } });
    });
    q.on("timeout", () => { q.destroy(); ok(false); });
    q.on("error", () => ok(false));
  });
}
async function siEsporta() {
  if (Date.now() - esportaVisto < 4000) return esportaOccupato;
  esportaVisto = Date.now();
  esportaOccupato = (await Promise.all(ESPORTA_SALUTE.map(chiediEsporta))).some(Boolean);
  return esportaOccupato;
}
async function aspettaEsporta() {
  const fino = Date.now() + 30 * 60000;   // una coda d'export impazzita non ferma il MAM per sempre
  while (Date.now() < fino && await siEsporta()) {
    if (!esportaDetto) { esportaDetto = true; console.log("[clip] c'e' un export video: il MAM aspetta"); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (esportaDetto) { esportaDetto = false; console.log("[clip] export finito: il MAM riparte"); }
}

// Due fotogrammi a venti secondi di distanza: orologio.py trova la grafica
// (quello che fra i due sta fermo), la targa del cronometro, e la legge in
// tutti e due. Se le due letture non distano venti secondi, una delle due
// e' sbagliata e si buttano via entrambe: meglio niente che un minuto falso.
async function leggiOrologioSicuro(fascia, t, tutto) {
  await aspettaEsporta();
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
    const k2 = chiavePezzo(idRegDi(q, pz), pz.dentro, pz.fuori);
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
  // un fischio segnato a mano non si sovrascrive con una lettura automatica
  if (a.orologio && a.orologio.fonte === "mano" && rifai !== "forza") return a.orologio;
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
    let vistaRipresa = null, buio = 0;
    for (const t of [600, 780, 960, 1200, 1500, 1800, 2100]) {
      const e = await leggiOrologioSicuro(leggiA, t, true); esito.letti += 2;
      const c = e && e.c;
      if (e && e.cifre && !esito.cifre) esito.cifre = e.cifre;
      // QUATTRO SONDE AL BUIO BASTANO. Un file di solo audio, o una partita
      // giovanile senza cronometro in sovrimpressione, non ne ha uno da
      // leggere: insistere fino alla settima sonda costa quattordici
      // fotogrammi per niente, e nell'archivio queste partite sono centinaia.
      if (c === null || c === undefined) { if (++buio >= 4) break; continue; }
      if (c <= 0) continue;
      // IL CRONOMETRO CHE DICE "57:00" NON E' DA BUTTARE. Certe partite —
      // le giovanili soprattutto — hanno su Airtable un orario sbagliato di
      // quasi un'ora: le sonde del primo tempo cadono tutte nel secondo, il
      // lettore legge una cifra oltre il 45' e la lettura veniva scartata.
      // Quella cifra pero' dice dove sta la ripresa, e da li' si ritrova il
      // primo tempo. Si sposta la finestra e si riprova, una volta sola.
      if (c >= 2700) { if (c < 7500 && !vistaRipresa) vistaRipresa = { t: t, c: c }; continue; }
      const inizio1 = t - c;
      if (Math.abs(inizio1) > 1500) continue;
      esito.inizio1 = inizio1; break;
    }
    if (esito.inizio1 === undefined && vistaRipresa) {
      const ripresaQui = vistaRipresa.t - (vistaRipresa.c - 2700);   // dove comincia il secondo tempo
      const primoQui = ripresaQui - 3600;                            // e dove doveva cominciare il primo
      console.log("[clip] cronometro: le sonde cadevano nel secondo tempo (letto " +
                  Math.round(vistaRipresa.c / 60) + "'): sposto di " + Math.round(primoQui / 60) + "' e riprovo");
      for (const d of [600, 900, 1200, 1500, 1800]) {
        const e = await leggiOrologioSicuro(leggiA, primoQui + d, true); esito.letti += 2;
        const c = e && e.c;
        if (e && e.cifre && !esito.cifre) esito.cifre = e.cifre;
        if (c === null || c === undefined || c <= 0 || c >= 2700) continue;
        esito.inizio1 = primoQui + d - c; break;
      }
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
    // le partite gia' aperte nel progetto imparano il fischio vero: il fermo
    // immagine, l'Info e la miniatura si rifanno sul calcio d'inizio letto
    esito.fonte = "cronometro";
    applicaOrologio(rec, esito);
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
    // SENZA RIQUADRO SI LEGGE LA BARRA. Un riquadro fisso che vada bene per
    // tutta la partita ce l'hanno le grafiche regolari; le altre spostano il
    // punteggio, lo allargano col nome del marcatore, lo mettono sotto il
    // cronometro invece che di fianco. Prima, li', la lettura del tabellone
    // si fermava e la partita restava senza un solo gol al secondo: adesso
    // si legge tutta la striscia attorno al cronometro e dentro si cerca la
    // forma "cifra trattino cifra".
    const box = cal && cal.box ? cal.box.join(",") : null;
    if (!box) console.log("[clip] tabellone: " + (a.partita || rec) + " senza riquadro fisso, si legge la barra");

    // 2) il risultato a un dato secondo, confermato da un secondo fotogramma
    const uno = async (t) => {
      const f = await fotogramma(t);
      if (!f) return null;
      letti++;
      const v = await python(box ? ["--punteggio", "--box", box, f]
                                 : ["--barra", o.cifre.join(","), f]);
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
      // a barra una lettura su due salta (il nome del marcatore, una grafica
      // sopra): prima di arrendersi si prova in piu' punti
      for (const parte of (box ? [0.5, 0.25, 0.75, 0.37, 0.63] : [0.5, 0.25, 0.75, 0.37, 0.63, 0.12, 0.88, 0.44, 0.56])) {
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
    // "GENOA-COMO [ENG]" non dice il risultato: lo sa ESPN, che lo abbiamo
    // gia' in casa. Senza atteso la lettura non si poteva verificare.
    const nel = /\b(\d{1,2})\s*-\s*(\d{1,2})\b/.exec(String(a.partita || ""));
    let atteso = nel ? nel[1] + "-" + nel[2] : null;
    if (!atteso && ESPN[rec] && Array.isArray(ESPN[rec].squadre) && ESPN[rec].squadre.length === 2) {
      // ESPN non scrive il risultato: si contano i gol, e l'autogol va
      // all'altra squadra
      const [casa, ospite] = ESPN[rec].squadre;
      let gc = 0, go = 0;
      (ESPN[rec].eventi || []).forEach((ev) => {
        if (!/goal/i.test(ev.tipo || "") || /missed|saved/i.test(ev.tipo || "")) return;
        const propria = ev.squadra === casa;
        const aCasa = /own/i.test(ev.tipo) ? !propria : propria;
        if (aCasa) gc++; else go++;
      });
      if (gc + go > 0) atteso = gc + "-" + go;
    }
    const esito = { quando: new Date().toISOString(), box: cal && cal.box ? cal.box : null, letti: letti,
                    comeLetto: box ? "riquadro" : "barra",
                    punti: punti.sort((x, y) => x.t - y.t), incerti: incerti,
                    finale: finale, atteso: atteso,
                    verificato: !!(atteso && finale && atteso === finale) };
    a.tabellone = esito; scriviArchivio();
    console.log("[clip] tabellone: " + (a.partita || rec) + " → " + punti.length + " gol, finale " +
                finale + (atteso ? " (nel nome " + atteso + ")" : "") + ", " + letti + " fotogrammi");
    return esito;
  } finally { tabelloniAttivi.delete(rec); }
}

// ── LA LETTURA DEL TABELLONE, PARTITA PER PARTITA ─────────────────────
//  Prima il cronometro: da' la targa verificata — quel rettangolo e' il
//  cronometro perche' ci si sono lette due ore a venti secondi di distanza —
//  e dice dove comincia la partita. Poi si guarda la barra attorno alla
//  targa, al novantesimo per il risultato e a meta' tempo per le squadre.
//  Guardare la PARTITA e non il file e' quello che fa la differenza: un file
//  con tredici minuti di cartello e diciassette di intervallo, letto a
//  percentuali, si guarda sempre nel posto sbagliato.
let riconoscimentiAlLavoro = new Set();
// un file che non dice come si chiama: "MultiCorder3 - Output 1", "Output 2"
const SENZA_NOME = /multicorder|output\s*\d|^\s*$/i;
async function riconosciPartita(rec) {
  const a = ARCHIVIO[String(rec || "")];
  if (!a) throw new Error("questa partita non e' nell'indice");
  if (!a.soloS3) throw new Error("questa partita ha gia' il suo nome");
  const cand = a.candidati || [];
  if (!cand.length) throw new Error("nessuna partita di quel giorno puo' essere questa");
  if (!tesseractCe()) throw new Error("sulla macchina manca tesseract");
  if (riconoscimentiAlLavoro.has(rec)) throw new Error("ci sto gia' lavorando");
  riconoscimentiAlLavoro.add(rec);
  try {
    let o = a.orologio;
    if (!o || !o.cifre) { try { o = await calibraOrologio(rec); } catch (e) { o = a.orologio || {}; } }
    // PRIMA SI MISURA, POI SI LEGGE. Senza la durata vera si tirava a
    // indovinare due ore, e i momenti da guardare cadevano fuori posto: la
    // registrazione di tre ore del 9 settembre veniva letta come se fosse di
    // due, e diceva la partita sbagliata. Con la durata giusta l'ha presa.
    if (!a.misurato) { try { await misuraPartita(rec); } catch (e) {} }
    const pz = (a.pezzi || [])[0];
    if (!pz) throw new Error("questa partita non ha materiale");
    const regione = await s3Regione(a.bucket);
    const via = firmaConRegione(regione, pz.chiave, {}, 3600, a.bucket);
    const durata = Math.round((pz.minuti || 0) * 60) || 7200;
    const fuori = await new Promise((ok) => {
      execFile("python3", [RICONOSCI_PY, via, String(durata), JSON.stringify(cand),
                           o && o.cifre ? JSON.stringify(o.cifre) : "null",
                           o && o.inizio1 !== undefined && o.inizio1 !== null ? String(o.inizio1) : "null",
                           o && o.inizio2 !== undefined && o.inizio2 !== null ? String(o.inizio2) : "null"],
        { timeout: 900000, maxBuffer: 4 * 1024 * 1024 },
        (e, so) => { if (e) return ok(null); try { ok(JSON.parse(String(so))); } catch (x) { ok(null); } });
    });
    if (!fuori) throw new Error("la lettura del tabellone non e' riuscita");
    // SE LA PARTITA COMINCIA A META' FILE, IL FILE NON E' LA PARTITA. Il
    // MultiCorder non registra il segnale dello stadio: registra quello che
    // Como TV manda in onda. Prima del fischio ci puo' stare il cartello, e
    // certe sere un'ora di studio — il 9 settembre il file dura tre ore e
    // dodici, e St. Johnstone-Celtic entra al minuto sessanta. Quel file e'
    // lo show, con dentro la partita, e va chiamato con il suo nome.
    // Dove cade il calcio d'inizio lo dice l'ora scritta nel nome del file,
    // senza leggere niente: tre-sei minuti in tutte le partite vere, un'ora
    // quando prima c'era altro.
    if (fuori.scelto) {
      const suo = cand.find((c) => c.rec === fuori.scelto.rec);
      const dentro = suo ? kickoffNelFile(pz.file, Date.parse(suo.quando)) : null;
      if (dentro !== null && dentro > 1500) {
        const show = cand.find((c) => c.rec !== fuori.scelto.rec && DA_STUDIO.test(c.nome) &&
          (kickoffNelFile(pz.file, Date.parse(c.quando)) || 0) <= 900);
        if (show) {
          fuori.dentro = { rec: fuori.scelto.rec, nome: fuori.scelto.nome, da: dentro };
          fuori.scelto = { rec: show.rec, nome: show.nome, voto: fuori.scelto.voto,
            perche: (fuori.scelto.perche || []).concat([
              fuori.scelto.nome + " comincia al minuto " + Math.round(dentro / 60) + ": prima c'e' lo studio"]) };
        }
      }
    }
    if (fuori.scelto) {
      RICONOSCIUTE[a.dove] = { rec: fuori.scelto.rec, nome: fuori.scelto.nome,
                               voto: fuori.scelto.voto, perche: fuori.scelto.perche,
                               dentro: fuori.dentro, quando: new Date().toISOString() };
      scriviRiconosciute();
      // UNA CARTELLA, UNA PARTITA. Se quel materiale era gia' finito sotto
      // un altro nome — una lettura di prima, o un aggancio per somiglianza
      // — quella riga adesso non ha piu' niente: va via, se no la stessa
      // registrazione si vede due volte in elenco con due nomi diversi.
      Object.keys(ARCHIVIO).forEach((k) => {
        if (k === fuori.scelto.rec || k.indexOf("s3:") === 0) return;
        if (ARCHIVIO[k].dove === a.dove && ARCHIVIO[k].bucket === a.bucket) delete ARCHIVIO[k];
      });
      a.riconosciuta = RICONOSCIUTE[a.dove]; scriviArchivio();
      console.log("[clip] tabellone: " + a.dove.split("/").pop() + " e' " + fuori.scelto.nome +
                  " (" + (fuori.scelto.perche || []).join(", ") + ")");
    } else {
      // QUANDO NON BASTA PER DECIDERE, RESTA UN SOSPETTO. Una sigla sola
      // letta bene non e' una prova, ma e' molto piu' di niente: si tiene da
      // parte come proposta — non aggancia il materiale, si vede in pagina e
      // la conferma la da' una persona.
      const primo = (fuori.voti || [])[0], secondo = (fuori.voti || [])[1];
      if (primo && primo.voto >= 2 && (!secondo || primo.voto >= secondo.voto + 3)) {
        RICONOSCIUTE[a.dove] = { rec: primo.rec, nome: primo.nome, voto: primo.voto,
                                 perche: primo.perche, sigle: fuori.sigle || [],
                                 risultati: fuori.risultati || [], sicura: false,
                                 quando: new Date().toISOString() };
        scriviRiconosciute();
        a.riconosciuta = RICONOSCIUTE[a.dove]; scriviArchivio();
      }
      console.log("[clip] tabellone: " + a.dove.split("/").pop() + " non deciso — " +
                  (fuori.voti || []).slice(0, 2).map((v) => v.voto + " " + v.nome).join(" | ") +
                  " · sigle " + JSON.stringify((fuori.sigle || []).slice(0, 8)) +
                  " · ris " + JSON.stringify((fuori.risultati || []).slice(0, 8)));
    }
    return fuori;
  } finally { riconoscimentiAlLavoro.delete(rec); }
}

// ── IL BOATO COME PUNTATORE ───────────────────────────────────────────
//
//  Il minuto scritto negli appunti e quello di ESPN dicono il minuto, non
//  il secondo: dentro ci stanno sessanta secondi di gioco, e il taglio
//  puo' cadere prima che la palla parta o dopo che e' finita in rete.
//  Lo stadio invece sa il secondo. Al gol il livello dell'audio sale di
//  dieci-quindici decibel in un attimo, e quella salita e' l'unica cosa
//  che succede esattamente quando succede il gol — prima del tabellone,
//  che lo scrive otto secondi dopo, e prima del replay.
//
//  Non si ascolta tutta la partita: due minuti e mezzo attorno al minuto
//  scritto, e dentro si cerca prima il colmo, poi la SALITA — il momento
//  in cui il rumore ha cominciato a crescere, che e' il gol, mentre il
//  colmo arriva qualche secondo dopo, quando il boato e' pieno.
// La finestra non e' simmetrica: l'appunto si scrive DOPO, mai prima, e il
// minuto di ESPN sta in fondo al suo minuto. Guardare novanta secondi
// indietro e venti avanti copre il ritardo di chi scrive senza andare a
// prendere il boato dell'azione successiva.
const BOATO_PRIMA = 75, BOATO_DOPO = 25;
const BOATO_MINIMO = 6;           // decibel sopra il solito: meno di cosi' non e' un boato
// Quanto lontano puo' stare un boato dalla riga a cui lo si riattacca,
// quando la chiave non c'e'. Novanta secondi: il giornalista scrive in
// mediana trentasette secondi dopo, il novantesimo percentile e'
// settantacinque. Piu' in la' si prenderebbe l'urlo dell'azione dopo.
const BOATO_LONTANO = 90;
async function boatoVicino(rec, tRiga, chiave, secFile, rigaK) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  a.boati = a.boati || [];
  // gia' misurato? prima per chiave (regge anche se il tempo si e' spostato),
  // poi per vicinanza, come si faceva prima
  const gia = (rigaK && a.boati.find((x) => x.rigaK === rigaK))
           || a.boati.find((x) => Math.abs(x.stimato - tRiga) <= 12);
  if (gia) { if (rigaK && !gia.rigaK) { gia.rigaK = rigaK; scriviArchivio(); } return gia; }
  // LE COORDINATE NON SI MESCOLANO. La riga del tabellino sta nei secondi
  // del file (o della partita intera); l'asse di doveCade parte dal calcio
  // d'inizio scritto in Airtable. Passare l'uno per l'altro voleva dire
  // ascoltare quattro-sei minuti dopo il punto giusto e credere di aver
  // trovato il boato. Qui si ascolta il file e il secondo che ci dice chi
  // chiama, e si torna con uno spostamento: quello vale in qualunque
  // coordinata.
  const daFile = Math.max(0, secFile - BOATO_PRIMA);
  const qui = secFile - daFile;
  const regione = await s3Regione(a.bucket);
  const via = firmaConRegione(regione, chiave, {}, 3600, a.bucket);
  const v = await volumeAlSecondo(via, daFile, qui + BOATO_DOPO);
  const esito = { stimato: Math.round(tRiga), t: null, db: 0 };
  if (rigaK) esito.rigaK = rigaK;
  if (v.length >= 40) {
    const ordinati = v.slice().sort((x, y) => x - y);
    const solito = ordinati[Math.floor(ordinati.length / 2)];
    // IL SEGNO DEL GOL E' IL SILENZIO CHE SPARISCE. Nel CLEANFEED c'e' la
    // telecronaca: il livello e' la voce, e ogni pochi secondi cade di venti
    // decibel quando il telecronista prende fiato. Al gol non prende piu'
    // fiato — lui grida, lo stadio sotto — e per venti, trenta secondi il
    // livello non scende mai. Il picco invece inganna: un urlo isolato, un
    // annuncio, un coro. Si cerca il tratto piu' lungo senza pause vicino
    // al minuto scritto, e il gol e' dove quel tratto comincia.
    const forte = solito - 3;                       // sotto qui e' una pausa
    const tratti = [];
    let inizio = -1, buchi = 0;
    for (let i = 0; i <= v.length; i++) {
      const alto = i < v.length && v[i] >= forte;
      if (alto) { if (inizio < 0) { inizio = i; buchi = 0; } continue; }
      // una pausa sola dentro il tratto si perdona: il fiato fra due urla
      if (inizio >= 0 && buchi === 0 && i + 1 < v.length && v[i + 1] >= forte) { buchi = 1; continue; }
      if (inizio >= 0) { tratti.push({ da: inizio, a: i - 1 }); inizio = -1; }
    }
    // IL PIU' FORTE, NON IL PIU' VICINO. Dopo il gol la telecronaca resta
    // fitta per minuti — i replay, il nome del marcatore — e di tratti
    // senza pause ce ne sono tre o quattro in fila: quello vicino al minuto
    // scritto e' spesso il replay. Il gol e' il tratto in cui si grida di
    // piu'; a parita', il primo.
    const lunghi = tratti.filter((x) => x.a - x.da + 1 >= 15)
      .map((x) => Object.assign(x, { forza: v.slice(x.da, x.a + 1).reduce((m, y) => Math.max(m, y), -90) - solito }));
    let scelto = null;
    lunghi.forEach((x) => { if (!scelto || x.forza > scelto.forza + 0.5) scelto = x; });
    if (scelto) {
      const forza = scelto.forza;
      esito.t = Math.round(tRiga + (scelto.da - qui));
      esito.db = Math.round(forza * 10) / 10;
      esito.lungo = scelto.a - scelto.da + 1;
      esito.colmo = esito.t;
    } else {
      // niente tratto senza pause: si prova col picco piu' vicino, ma solo se
      // e' un boato vero
      const picchi = picchiDiVolume(v, 0, BOATO_MINIMO + 2, 25, 12);
      let colmo = -1, vicino = 1e9;   // "vicino" non era dichiarato: qui dentro il boato moriva con "vicino is not defined" (23/09)
      picchi.forEach((x) => { const q = Math.abs(x.secondi - qui); if (q < vicino) { vicino = q; colmo = x.secondi; } });
      if (colmo >= 0) {
        const forza = v[colmo] - solito, soglia = solito + forza * 0.45;
        let su = colmo;
        for (let i = colmo; i >= Math.max(0, colmo - 30); i--) { if (v[i] < soglia) break; su = i; }
        esito.t = Math.round(tRiga + (su - qui)); esito.db = Math.round(forza * 10) / 10;
        esito.colmo = Math.round(tRiga + (colmo - qui)); esito.lungo = 0;
      }
    }
  }
  a.boati.push(esito);
  return esito;
}
// la riga sta nei secondi della registrazione: con un file solo sono i
// secondi del file; con la partita intera in piu' pezzi, ogni pezzo entra
// al suo "da" e il secondo nel file e' quello che resta togliendolo
function pezzoDellaRiga(a, t) {
  const pz = (a.pezzi || []).filter((x) => x.da !== null && x.da !== undefined);
  if (pz.length <= 1) return { chiave: (pz[0] || a).chiave || a.chiave, sec: t };
  let i = 0; pz.forEach((x, k) => { if (x.da <= t) i = k; });
  return { chiave: pz[i].chiave, sec: Math.max(0, t - pz[i].da) };
}
// ── IL MOMENTO VERO, DALL'INQUADRATURA ────────────────────────────────
//  "Assist Diao: passano una decina di secondi prima dell'assist" (Goffredo,
//  26/09/2026). Il tabellone sa il gol entro venti secondi e ci toglie otto
//  secondi fissi di ritardo; su Como-Pisa il tabellone cambia insieme alla
//  palla in rete, e la clip partiva 25 s prima del cross. La regia invece
//  lo dice al secondo: finche' si gioca c'e' la camera larga, e quando la
//  palla entra (o il portiere para, o si prende il palo) si passa ai primi
//  piani e ci si resta. Il momento e' la FINE dell'ultima camera larga
//  lunga seguita dai primi piani (le regole di momentoDelGol), scegliendo
//  quella piu' vicina al punto stimato, dentro una finestra che dipende
//  da quanto la stima e' buona. Su Como-Pisa: larga fino a 2138, primi
//  piani dal 2139, palla in rete a 2138-2140.
// la versione delle regole: cambiandola, il giro della casa rifa' le misure vecchie
const MOMENTI_VER = 3;
const DA_MOMENTO = /gol|goal|rete|rigore|espuls|rosso|traversa|palo|parat|occasion|tiro/i;
// Qui il movimento conta poco: in un contropiede la camera larga fa una
// panoramica veloce (moto 30-45) e con la soglia della ripartenza sembrava un
// primo piano — il gol di Diao in Como-Pisa non si trovava. Il primo piano si
// riconosce gia' dal prato in cima al quadro, il pubblico dal prato che manca.
// E il quarto alto: col gioco vicino alla telecamera la camera larga si
// inclina e in cima entra prato (0,15-0,23); i primi piani stanno sopra 0,68.
// E NON BASTA: quando il gioco e' proprio sotto la telecamera, la larga si
// inclina tanto che il quarto alto e' tutto prato (0,55-0,78) — come un primo
// piano. La differenza e' il movimento: la larga cambia poco (8-16), i primi
// piani molto (23-55). Misurato sui falsi di Frosinone-Como e Como-Parma.
function larghiMomento(campo) {
  return campo.map((x) => x.prato > 0.4 && x.moto < 45 && (x.alto < 0.35 || x.moto <= 18));
}
function momentiNelCampo(campo, severo) {
  const largo = larghiMomento(campo), LUNGA = 6, DOPO = 8, fuori = [];
  const bastano = severo ? DOPO - 1 : DOPO - 2;
  for (let i = LUNGA - 1; i + DOPO < largo.length; i++) {
    if (!largo[i] || largo[i + 1]) continue;
    let lunga = 0; for (let j = i; j >= 0 && largo[j]; j--) lunga++;
    if (lunga < LUNGA) continue;
    let stretti = 0; for (let j = i + 1; j <= i + DOPO; j++) if (!largo[j]) stretti++;
    if (stretti < bastano) continue;
    fuori.push(i);
  }
  return fuori;
}
// dove cercare, rispetto al punto stimato: il tabellone e' otto secondi
// prima del cambio di punteggio (che sta entro sette); il boato e' l'inizio
// del grido; il minuto scritto cade spesso sul replay, cioe' dopo
const FINESTRE_MOMENTO = { tabellone: [-25, 10, 8], boato: [-20, 12, 0], minuto: [-90, 30, 0] };
async function puntaMomenti(rec) {
  const a = ARCHIVIO[rec];
  if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
  const finto = { arch: { rec: rec, pezzo: 0, pezzi: a.pezzi, chiave: a.chiave }, durata: 0 };
  const sap = quelloCheSappiamo(finto);
  // misure fatte con regole piu' vecchie: si rifanno da capo
  // (i gol si tengono: sui gol le regole vecchie e nuove danno lo stesso
  // secondo, verificato su Como-Pisa e a campione su 5 gol di 4 partite)
  if ((a.momentiVer || 1) < MOMENTI_VER) {
    const tieni = {};
    Object.keys(a.momenti || {}).forEach((k) => { if (/\|(gol|goal|rete|autogol)\|/i.test(k) || a.momenti[k].cert === "tabellone") tieni[k] = a.momenti[k]; });
    a.momenti = tieni; delete a.momentiFatti;
  }
  a.momenti = a.momenti || {};
  const regione = await s3Regione(a.bucket);
  let cercati = 0, trovati = 0;
  for (const x of sap.azioni) {
    if (x.momento || !DA_MOMENTO.test(String(x.tipo || "") + " " + String(x.titolo || ""))) continue;
    const k = chiaveRiga(x); if (a.momenti[k]) continue;
    if (registrandoDavvero() || laDirettaGira()) break;          // si riprende al prossimo giro
    const cert = x.tabellone ? "tabellone" : x.boato ? "boato" : "minuto";
    // un gol la regia lo segna sempre (esultanza, replay); un tiro o una
    // parata molto meno. Senza tabellone ne' boato la finestra e' di due
    // minuti, e per un'azione qualsiasi il rischio di prendere un'altra cosa
    // e' troppo alto: la' si resta al minuto (a campione, 26/09: cadeva perfino
    // sulla presentazione delle squadre)
    const eGol = /\b(gol|goal|rete|autogol)\b/i.test(String(x.tipo || "") + " " + String(x.tag || "")) || !!x.tabellone;
    // SOLO I GOL (26/09, secondo controllo a campione: 5 gol su 5 giusti, 0 su
    // 3 fra tiri e parate — la regia dopo un tiro va sulla panchina, su un
    // contrasto, su chiunque). Tiri e parate restano al boato o al minuto.
    if (!eGol) continue;
    const fin = FINESTRE_MOMENTO[cert];
    const t = x.t !== undefined ? x.t : x.dentro + APP_PRE;
    const p = pezzoAl(finto, t); if (!p || !p.pezzo) continue;
    const chiave = p.pezzo.chiave || a.chiave, stima = p.dentro + fin[2];
    const da = Math.max(0, Math.round(stima + fin[0]));
    cercati++;
    let campo = [];
    try { campo = await guardaIlCampo(firmaConRegione(regione, chiave, {}, 3600, a.bucket), da, fin[1] - fin[0] + 10, 1); } catch (e) { campo = []; }
    const esito = { chiave: chiave, sec: null, stima: Math.round(stima), cert: cert };
    if (campo.length >= 20) {
      const vicino = (i) => { const d = campo[i].s - stima; return Math.abs(d) * (cert === "minuto" && d > 0 ? 2 : 1); };
      const c = momentiNelCampo(campo, !eGol).filter((i) => campo[i].s >= stima + fin[0] && campo[i].s <= stima + fin[1])
        .sort((u, v) => vicino(u) - vicino(v))[0];
      if (c !== undefined) { esito.sec = Math.round(campo[c].s); trovati++; }
    } else esito.perche = "poco video";
    a.momenti[k] = esito;
    if (cercati % 5 === 0) scriviArchivio();
  }
  if (!registrandoDavvero() && !laDirettaGira()) { a.momentiFatti = new Date().toISOString(); a.momentiVer = MOMENTI_VER; }
  scriviArchivio();
  if (cercati) console.log("[clip] momenti: " + (a.partita || rec) + " → " + trovati + " su " + cercati + " azioni al secondo");
  return { cercati, trovati };
}
// le righe che possono fare rumore: un cambio non lo fa, un gol si'
const DA_BOATO = /gol|rete|rigore|espuls|rosso|traversa|palo|parat/i;
// LA CHIAVE DI UNA RIGA. Il secondo di una riga si muove a ogni giro — lo
// spostano il ritardo del giornalista, il cronometro riletto, il fischio
// corretto a mano. Quello che NON si muove e' chi l'ha scritta, il minuto
// che c'era scritto, che cos'era e di chi. Un boato misurato su quella riga
// deve portarsi dietro questa, non un numero di secondi.
function chiaveRiga(x) {
  return [x.fonte || "", x.minuto || "", String(x.tipo || "").toLowerCase(),
          String(x.giocatore || x.titolo || "").slice(0, 40).toLowerCase()].join("|");
}
// Punta col boato tutte le azioni rumorose di una partita. Quelle che il
// tabellone ha gia' messo al secondo non si toccano: il tabellone e' una
// prova, il boato e' un indizio forte.
async function puntaBoati(rec) {
  const a = ARCHIVIO[rec];
  if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
  const finto = { arch: { rec: rec, pezzo: 0, pezzi: a.pezzi, chiave: a.chiave }, durata: 0 };
  const sap = quelloCheSappiamo(finto);
  let cercati = 0, trovati = 0;
  // la riga sta nei secondi della registrazione: con un file solo sono i
  // secondi del file; con la partita intera in piu' pezzi, ogni pezzo entra
  // al suo "da" e il secondo nel file e' quello che resta togliendolo
  const dentroIlFile = (t) => pezzoDellaRiga(a, t);
  for (const x of sap.azioni) {
    if (x.tabellone) continue;
    if (!DA_BOATO.test(String(x.tipo || "") + " " + String(x.titolo || ""))) continue;
    const t = x.t !== undefined ? x.t : x.dentro + APP_PRE;
    const f = dentroIlFile(t);
    cercati++;
    const b = await boatoVicino(rec, t, f.chiave, f.sec, chiaveRiga(x));
    if (b && b.t !== null) trovati++;
  }
  // il giro fatto si segna comunque: una partita senza azioni rumorose da
  // puntare non lascerebbe traccia, e chi gira l'archivio la ripescherebbe
  // all'infinito (23/09)
  a.boatiFatti = new Date().toISOString();
  scriviArchivio();
  if (cercati) console.log("[clip] boati: " + (a.partita || rec) + " → " + trovati + " su " + cercati + " azioni puntate");
  return { cercati: cercati, trovati: trovati };
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
  // il giro finale non azzera il suo segno: se no, a coda vuota, le partite
  // senza cronometro leggibile ripartivano all'infinito (21/09/2026: tre
  // partite ritentate ogni nove minuti per ore, i due core sempre pieni)
  if (!CODA_OROLOGI.length && !ripasso) orologiRipassati = false;
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
    if (a && senzaCodeDi(a)) return;                       // S3 contato: il cronometro si legge a richiesta
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
  // dietro il ponte S3 la misura la fa la EC2: ffprobe legge l'indice del
  // file nella regione del secchio (gratis) e qui arriva un numero. Senza la
  // durata vera il riconoscimento tira a indovinare due ore e guarda i
  // fotogrammi nei posti sbagliati (2 partite nominate su 15, il 22/09)
  const pp = pontePer(via);
  if (pp) return new Promise((ok) => {
    const r = http.get(pp.ponte + "/dur?k=" + encodeURIComponent(pp.chiave), { timeout: 200000 }, (res) => {
      let t = ""; res.on("data", (b) => { t += b; });
      res.on("end", () => {
        try { const j = JSON.parse(t); ok(j && j.ok && isFinite(j.secondi) ? Math.round(j.secondi / 60 * 10) / 10 : null); }
        catch (e) { ok(null); }
      });
    });
    r.on("error", () => ok(null));
    r.on("timeout", () => { r.destroy(); ok(null); });
  });
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
  if (ARCHIVIO[rec] && soloElenco(ARCHIVIO[rec].bucket) && !inCasa(ARCHIVIO[rec])) throw new Error("solo elenco: le durate si misurano quando ci sara' il ponte o la chiave");
  // col ponte la misura non costa: ffprobe gira sulla EC2, in regione
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
function nomiDellEvento(ev) {
  const nomi = [];
  ((ev.competitions || [])[0] || {}).competitors && ev.competitions[0].competitors.forEach((c) => {
    const tm = c.team || {};
    [tm.displayName, tm.shortDisplayName, tm.name, tm.location, tm.abbreviation].forEach((n) => { if (n) nomi.push(nomeSemplice(n)); });
  });
  [ev.name, ev.shortName].forEach((n) => { if (n) nomi.push(nomeSemplice(n)); });
  return nomi;
}
function combaciaCoiNomi(nostra, nomi) {
  if (nomi.some((n) => n.length >= 4 && (n.indexOf(nostra.tutto) >= 0 || nostra.tutto.indexOf(n) >= 0))) return true;
  return nostra.parole.some((w) => nomi.some((n) => n.indexOf(w) >= 0));
}
function squadraCombacia(nostra, ev) { return combaciaCoiNomi(nostra, nomiDellEvento(ev)); }
// QUANTO SI ASSOMIGLIANO DUE NOMI DI SQUADRA. Serve a distinguere un nome
// scritto male da un'altra squadra: "cesenà" e "cesena" sono la stessa,
// "entella" e "lecce" no. Distanza di Levenshtein sul nome semplice.
function distanzaNomi(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let riga = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prec = riga[0]; riga[0] = i;
    for (let j = 1; j <= n; j++) {
      const q = riga[j];
      riga[j] = Math.min(riga[j] + 1, riga[j - 1] + 1, prec + (a[i - 1] === b[j - 1] ? 0 : 1));
      prec = q;
    }
  }
  return riga[n];
}
function somigliaNome(a, b) {
  if (!a || !b) return false;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  const lungo = Math.max(a.length, b.length);
  return 1 - distanzaNomi(a, b) / lungo >= 0.6;
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
  // GIOVANILI E FEMMINILE NON STANNO SU ESPN (che ha le prime squadre): cercandole
  // si trovava la prima squadra di quel giorno — Padova U19-Como U19 diventava
  // Parma-Como, Como Femminile-Bresso diventava Lecce-Como (25/09/2026)
  if (nonDaEspn(rec)) { ESPN[rec] = { mancante: "giovanili o femminile: ESPN non le ha", quando: info.quando }; return ESPN[rec]; }
  const leghe = legheDi(info.competizione);
  if (!leghe.length) { ESPN[rec] = { mancante: "competizione non coperta", quando: info.quando }; return ESPN[rec]; }
  let squadre = squadreDi(info.partita);
  // "BOLOGNA.COMO", "NAPOLI-COMO - ITA": se la divisione semplice non basta, si
  // leggono le due squadre come per gli stemmi (dueSquadre)
  if (squadre.length !== 2) { const q = dueSquadre(info.partita); if (q) squadre = squadreDi(q.join("-")); }
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
        // L'ALTRA SQUADRA DEVE ESSERE UN NOME SCRITTO MALE, NON UN'ALTRA
        // SQUADRA. Questa scorciatoia serviva a salvare i titoli storpiati,
        // ma non sapeva distinguerli: "VIRTUS ENTELLA-COMO" del 19/04/2025
        // finiva su Lecce-Como di quel giorno, perche' il Como in Serie A
        // giocava una partita sola e di Entella non importava niente a
        // nessuno. Risultato: i gol del Lecce dentro una partita dell'Entella.
        const suoi = nomiDellEvento(buoni[0].ev);
        const nonPresa = squadre.find((x) => x !== sq);
        // due modi di essere la stessa partita malgrado il nome che non
        // torna: o il nome si assomiglia (storpiato), o l'ora e' la stessa.
        // "COLONIA" contro "FC Cologne" non si assomigliano per niente ma
        // sono la stessa gara e cominciano insieme; Lecce-Como cominciava
        // quattro ore dopo la registrazione dell'Entella.
        const storpiata = !nonPresa || suoi.some((n) => somigliaNome(n, nonPresa.tutto));
        const stessaOra = buoni[0].dt < 2.5 * 3600000;
        // lo stesso orario da solo NON basta: Padova U19-Como U19 e Parma-Como
        // cominciavano insieme ed erano due partite diverse (25/09/2026)
        void stessaOra;
        if (!altre.length && storpiata && buoni[0].dt < 6 * 3600000) { trovato = buoni[0].ev; legaTrovata = lega; break; }
      }
    }
    if (trovato) break;
  }
  if (!trovato) { ESPN[rec] = { mancante: "non trovata su ESPN", quando: info.quando }; return ESPN[rec]; }
  // L'ULTIMA PAROLA: le due squadre dell'evento devono essere le nostre due,
  // con il confronto severo (stessaSquadra). La ricerca qui sopra e' larga
  // apposta, e "nacional" dentro "internacional" le bastava.
  {
    const noi = dueSquadreDi(ARCHIVIO[rec] || { partita: info.partita });
    const loro = ((((trovato.competitions || [])[0] || {}).competitors) || []).map((c) => (c.team || {}).displayName || "");
    if (noi && loro.length === 2) {
      const ok = (stessaSquadra(noi[0], loro[0], info.competizione) && stessaSquadra(noi[1], loro[1], info.competizione)) ||
                 (stessaSquadra(noi[0], loro[1], info.competizione) && stessaSquadra(noi[1], loro[0], info.competizione));
      if (!ok) { ESPN[rec] = { mancante: "ESPN ha solo un'altra partita: " + loro.join(" - "), quando: info.quando }; return ESPN[rec]; }
    }
  }
  const sm = await espnPrendi("https://site.api.espn.com/apis/site/v2/sports/soccer/" + legaTrovata + "/summary?event=" + trovato.id);
  // GAMECAST: nella stessa risposta c'e' la telecronaca scritta, che finora
  // buttavamo via. Sono cinque volte gli eventi chiave — tiri, parate,
  // occasioni, falli — e soprattutto ci sono anche dove nessun giornalista
  // ha scritto appunti, che sono migliaia di partite.
  const gamecast = leggiGamecast(sm);
  const eventi = eventiEspn(sm);
  const rose = {};
  (sm.rosters || []).forEach((r) => {
    const nome = ((r.team || {}).displayName) || "?";
    rose[nome] = (r.roster || []).map((x) => (x.athlete || {}).displayName).filter(Boolean);
  });
  const comp = (trovato.competitions || [])[0] || {};
  const casaOsp = (comp.competitors || []).map((c) => ((c.team || {}).displayName) || "");
  // lo stemma di ogni squadra, com'e' su ESPN: serve alla ricerca del magazzino
  const loghi = {};
  (comp.competitors || []).forEach((c) => { const tm = c.team || {}; if (!tm.displayName) return;
    const l = (tm.logos && tm.logos[0] && tm.logos[0].href) || tm.logo || (tm.id ? "https://a.espncdn.com/i/teamlogos/soccer/500/" + tm.id + ".png" : "");
    if (l) loghi[tm.displayName] = l; });
  ESPN[rec] = { id: trovato.id, lega: legaTrovata, quando: trovato.date || info.quando, nome: trovato.name || "",
                squadre: casaOsp, eventi: eventi, gamecast: gamecast, rose: rose, loghi: loghi,
                letto: new Date().toISOString() };
  misuraRitardo(rec);
  return ESPN[rec];
}
// ═══════════════════════════════════════════════════════════
//  GLI STEMMI DELLE SQUADRE, per le anteprime della Libreria
// ═══════════════════════════════════════════════════════════
//
//  Da dove, in ordine:
//    1. la cartella dei loghi della redazione: "stemma-<squadra>" o il nome
//       semplice ("padova.svg", "al-faisaly.png"). Vince su tutto: e' chi li
//       mette a mano che sa quale e' giusto.
//    2. ESPN, dalla PARTITA: per le 3.000 partite che ESPN ha riconosciuto
//       conosciamo il nome esatto delle due squadre. Estudiantes, Racing,
//       Liverpool non si indovinano dal nome: si leggono dall'evento.
//    3. ESPN, dal NOME, cercando prima nel campionato della partita. A
//       parita' di candidati non si sceglie: meglio la sigla che uno stemma
//       sbagliato (Red Bull Salisburgo finiva sul Red Bull New York).
//  Gli stemmi ESPN si scaricano una volta sola e stanno nella cartella dei
//  loghi come "stemma-espn-<id>.png": la pagina non dipende da ESPN.
const STEMMI_DIR = process.env.COMOTV_LOGHI || "/var/lib/comotv/loghi";
const LEGHE_STEMMI = ("ita.1 ita.2 ita.coppa_italia eng.1 eng.2 eng.3 eng.4 eng.league_cup eng.fa ger.1 ger.2 ger.dfb_pokal " +
  "fra.1 fra.2 fra.coupe_de_france esp.1 esp.2 por.1 por.taca.portugal ned.1 ned.2 sco.1 sco.2 sco.3 sco.tennents sco.cis " +
  "bel.1 aut.1 sui.1 gre.1 tur.1 den.1 nor.1 swe.1 ksa.1 ksa.kings.cup arg.1 bra.1 col.1 uru.1 chi.1 ecu.1 per.1 par.1 ven.1 " +
  "bol.1 mex.1 usa.1 conmebol.libertadores conmebol.sudamericana uefa.champions uefa.europa uefa.europa.conf").split(" ");
// la cartella di lavoro si conosce solo all'avvio: il file si chiede al momento
function fileCatalogo() { return path.join(DIR, "espn-squadre.json"); }
let CATALOGO = { quando: 0, squadre: {} };            // id -> { id, nomi[], logo, leghe[] }
function leggiCatalogo() {
  try { const c = JSON.parse(fs.readFileSync(fileCatalogo(), "utf8")); if (c.squadre) CATALOGO = c; } catch (e) {}
}
let catalogoInCorso = false;
async function aggiornaCatalogo() {
  if (catalogoInCorso) return; catalogoInCorso = true;
  try {
    const nuovo = {};
    for (const l of LEGHE_STEMMI) {
      try {
        const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + l + "/teams", { signal: AbortSignal.timeout(30000) });
        if (!r.ok) continue;
        const j = await r.json();
        const lega = (((j.sports || [])[0] || {}).leagues || [])[0];
        ((lega && lega.teams) || []).forEach((x) => {
          const t = x.team || {}, logo = ((t.logos || [])[0] || {}).href;
          if (!t.id || !logo) return;
          const v = nuovo[t.id] || (nuovo[t.id] = { id: t.id, nomi: [], logo: logo, leghe: [] });
          ["displayName", "shortDisplayName", "name", "location"].forEach((k) => { if (t[k] && v.nomi.indexOf(t[k]) < 0) v.nomi.push(t[k]); });
          if (v.leghe.indexOf(l) < 0) v.leghe.push(l);
        });
      } catch (e) {}
    }
    // quelle gia' viste restano anche se quest'anno giocano in un'altra serie
    Object.keys(CATALOGO.squadre || {}).forEach((id) => { if (!nuovo[id]) nuovo[id] = CATALOGO.squadre[id]; });
    if (Object.keys(nuovo).length > 200) {
      CATALOGO = { quando: Date.now(), squadre: nuovo };
      fs.writeFileSync(fileCatalogo(), JSON.stringify(CATALOGO));
      STEMMI_CACHE.clear();
      console.log("[clip] stemmi: catalogo ESPN con " + Object.keys(nuovo).length + " squadre");
    }
  } finally { catalogoInCorso = false; }
}
// le parole che non dicono quale squadra e'
const PAROLE_CLUB = new Set(["fc", "cf", "ac", "as", "sc", "ssc", "us", "club", "calcio", "de", "del", "da", "la", "le", "los", "el", "the",
  "cd", "ca", "afc", "bk", "fk", "sv", "vfb", "vfl", "tsg", "rb", "sk", "if", "united", "city", "town", "1907", "1909", "1913"]);
// si ricorda: conEsonimi passa sessanta espressioni, e i nomi si ripetono
const PAROLE_MEMO = new Map();
function paroleSquadra(x) {
  const k = String(x || "");
  let v = PAROLE_MEMO.get(k);
  if (!v) {
    v = senzaAccenti(conEsonimi(k)).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !PAROLE_CLUB.has(w) && !/^(19|20)\d\d$/.test(w));
    if (PAROLE_MEMO.size > 20000) PAROLE_MEMO.clear();
    PAROLE_MEMO.set(k, v);
  }
  return v;
}
// le parole e i nomi esatti di ogni squadra del catalogo, fatti una volta
let CAT_INDICE = null;
function indiceCatalogo() {
  if (CAT_INDICE && CAT_INDICE.n === Object.keys(CATALOGO.squadre).length) return CAT_INDICE;
  const voci = Object.keys(CATALOGO.squadre).map((id) => {
    const t = CATALOGO.squadre[id], parole = [];
    t.nomi.forEach((n) => paroleSquadra(n).forEach((w) => { if (parole.indexOf(w) < 0) parole.push(w); }));
    return { id, t, parole, esatti: t.nomi.map((n) => nomeSemplice(n)) };
  });
  CAT_INDICE = { n: voci.length, voci };
  return CAT_INDICE;
}
function senzaGiovanili(nome) {
  return String(nome || "").replace(/\b(U\s?\d{2}|UNDER\s?\d{2}|PRIMAVERA|WOMEN|FEMMINILE|FEM|YOUTH|ACADEMY)\b/gi, " ").replace(/\s+/g, " ").trim();
}
function slugSquadra(nome) {
  return senzaAccenti(senzaGiovanili(nome)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
// LA STESSA PAROLA, SCRITTA UN PO' DIVERSA — ma solo se e' lunga. Con le
// parole corte una lettera cambia la squadra: Lecco non e' Lecce, Parma non
// e' Palma (25/09/2026: Lecco e Bresso prendevano lo stemma del Lecce).
function stessaParola(w, v) {
  if (w === v) return true;
  const corta = Math.min(w.length, v.length);
  if (corta >= 6 && (w.startsWith(v) || v.startsWith(w))) return true;        // Lokomotiv/Lokomotiva
  if (corta >= 7 && Math.abs(w.length - v.length) <= 1) return paroleUguali(w, v); // Villareal/Villarreal
  return false;
}
// quelle che non si possono indovinare: nomi della redazione che non somigliano a quelli di ESPN
const ALIAS_STEMMI = {
  "olympique lyonnais": "Lyon", "ol lyonnes": "Lyon", "olympique de marseille": "Marseille", "olympique marsiglia": "Marseille",
  "red bull salzburg": "Salzburg", "red bull salisburgo": "Salzburg", "rb salisburgo": "Salzburg",
  "sk puntigamer sturm graz": "Sturm Graz", "sturm graz": "Sturm Graz", "paris st germain": "Paris Saint-Germain",
  "psg": "Paris Saint-Germain", "paris saint germain": "Paris Saint-Germain", "al nayma": "Al Najma", "al najmah": "Al Najma",
  "al okhdooood": "Al Okhdood", "al okhdoood": "Al Okhdood", "al faysaly": "Al Faisaly", "manchester utd": "Manchester United",
  "man city": "Manchester City", "man utd": "Manchester United", "birminhgham city": "Birmingham City", "milwall": "Millwall",
  "u de cile": "Universidad de Chile", "univ de cile": "Universidad de Chile", "universitario de cile": "Universidad de Chile",
  "universidad de cile": "Universidad de Chile", "u de chile": "Universidad de Chile", "betis siviglia": "Real Betis", "betis": "Real Betis",
  "junior barranquilla": "Junior", "atletico junior": "Junior", "universidad cile": "Universidad de Chile", "losc lille": "Lille", "racing avellaneda": "Racing Club", "racing club avellaneda": "Racing Club", "hadjuk split": "Hajduk Split", "hadjuk spalato": "Hajduk Split",
  "universidad central": "UCV FC", "universidad central ven": "UCV FC", "afs": "AVS", "tarma": "ADT", "colonia": "FC Cologne",
  "psg": "Paris Saint-Germain", "inter": "Internazionale",
  "idv": "Independiente del Valle", "ind del valle": "Independiente del Valle", "al qadisiyah": "Al Qadsiah", "al qadsiyah": "Al Qadsiah"
};
// PAESE DELLA COMPETIZIONE: TheSportsDB cerca in tutto il mondo, e "Gorica"
// trovava quella slovena, "Manchester" una squadra di Gibilterra, "Zebras"
// una delle Bermuda. Uno stemma si accetta solo se il paese combacia; dove il
// paese non si sa, o non e' calcio a squadre di club, non si accetta.
const SUDAMERICA = ["Argentina", "Brazil", "Uruguay", "Chile", "Colombia", "Ecuador", "Peru", "Paraguay", "Bolivia", "Venezuela"];
function paesiDi(comp) {
  const c = String(comp || "");
  if (/kings league|cage warriors|karate|maratona/i.test(c)) return null;
  if (/HNL|croazia/i.test(c)) return ["Croatia"];
  if (/francia|coupe de france|ligue/i.test(c)) return ["France"];
  if (/portogallo|portugal|ta[cç]a|superta/i.test(c)) return ["Portugal"];
  if (/germania|dfb|bundesliga(?! austria)/i.test(c)) return ["Germany"];
  if (/austria/i.test(c)) return ["Austria"];
  if (/grecia/i.test(c)) return ["Greece"];
  if (/saudi|king'?s cup/i.test(c)) return ["Saudi Arabia"];
  if (/scottish|scozia|premier sports/i.test(c)) return ["Scotland"];
  if (/carabao|efl|fa cup/i.test(c)) return ["England", "Wales"];
  if (/^championship$/i.test(c.trim())) return ["England", "Wales", "Scotland"];
  if (/eredivisie/i.test(c)) return ["Netherlands"];
  if (/serie a|serie b|serie c|primavera|coppa italia|como 1907|under 1\d|coppa gambardella/i.test(c)) return ["Italy"];
  if (/liga profesional|apertura|clausura|argentin|trofeo de campeones/i.test(c)) return ["Argentina"];
  if (/libertadores|sudamericana|recopa/i.test(c)) return SUDAMERICA;
  return [];                                           // non si sa: TheSportsDB no
}
// come chiedere a TheSportsDB le squadre che hanno un nome piu' lungo la'
const TSDB_CHIEDI = { "gorica": "HNK Gorica", "rw essen": "Rot-Weiss Essen", "vukovar 1991": "Vukovar", "nk istra 1961": "Istra 1961" };
// i loghi della redazione con un nome di file diverso da quello della squadra
const FILE_STEMMI = { "hebc amburgo": "hamburg-eimsbutteler-ballspiel-club-logo-svg.webp", "al faysaly": "al-faisaly.png" };
// dal nome: prima nel campionato della partita, e solo se il candidato e' uno
const DAL_NOME_MEMO = new Map();
function squadraEspnDalNome(nome, comp) {
  const km = nome + "|" + (comp || "") + "|" + Object.keys(CATALOGO.squadre).length;
  if (DAL_NOME_MEMO.has(km)) return DAL_NOME_MEMO.get(km);
  const v = squadraEspnDalNomeDavvero(nome, comp);
  DAL_NOME_MEMO.set(km, v);
  return v;
}
function squadraEspnDalNomeDavvero(nome, comp) {
  const alias = ALIAS_STEMMI[senzaAccenti(senzaGiovanili(nome)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()];
  if (alias) nome = alias;
  const noi = paroleSquadra(senzaGiovanili(nome)); if (!noi.length) return null;
  const esatto = nomeSemplice(conEsonimi(senzaGiovanili(nome)));
  const leghe = legheDi(comp);
  const cand = [];
  indiceCatalogo().voci.forEach(({ id, t, parole: loro, esatti }) => {
    const inLega = t.leghe.some((l) => leghe.indexOf(l) >= 0);
    if (esatti.indexOf(esatto) >= 0) { cand.push({ id, s: 2, lega: inLega }); return; }
    const prese = noi.filter((w) => loro.some((v) => stessaParola(w, v))).length;
    // tutte le nostre parole devono esserci: "Red Bull Salisburgo" non e' "Red Bull New York"
    if (prese === noi.length) cand.push({ id, s: 1, lega: inLega });
  });
  const MAGGIORI = ["ita.1", "eng.1", "esp.1", "ger.1", "fra.1", "por.1", "ned.1", "sco.1", "uefa.champions"];
  const scegli = (lista) => {
    if (!lista.length) return null;
    const top = Math.max.apply(null, lista.map((c) => c.s)), primi = lista.filter((c) => c.s === top);
    if (primi.length === 1) return primi[0].id;
    // a pari merito, e senza campionato che decida: la squadra di un campionato maggiore, se e' una sola
    const grandi = primi.filter((c) => CATALOGO.squadre[c.id].leghe.some((l) => MAGGIORI.indexOf(l) >= 0));
    return grandi.length === 1 ? grandi[0].id : null;
  };
  const inLega = cand.filter((c) => c.lega);
  return inLega.length ? scegli(inLega) : scegli(cand);
}
function squadraEspnDalNomeEspn(n) {
  const k = nomeSemplice(n);
  const v = indiceCatalogo().voci.find((x) => x.esatti.indexOf(k) >= 0);
  return v ? v.id : null;
}
const STEMMI_CACHE = new Map();
const STEMMI_CODA = new Set();
let stemmiInCorso = false;
function fileRedazione(nome) {
  const chiaro = senzaAccenti(senzaGiovanili(nome)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (FILE_STEMMI[chiaro] && fs.existsSync(path.join(STEMMI_DIR, FILE_STEMMI[chiaro]))) return "/loghi/" + FILE_STEMMI[chiaro];
  const slug = slugSquadra(nome); if (!slug) return "";
  for (const b of ["stemma-" + slug, slug]) for (const est of [".png", ".svg", ".webp"]) {
    if (fs.existsSync(path.join(STEMMI_DIR, b + est))) return "/loghi/" + b + est;
  }
  return "";
}
function stemmaEspn(id, logo) {
  const f = "stemma-espn-" + id + ".png";
  if (fs.existsSync(path.join(STEMMI_DIR, f))) return "/loghi/" + f;
  STEMMI_CODA.add(JSON.stringify([id, logo || (CATALOGO.squadre[id] || {}).logo || ""]));
  if (!stemmiInCorso) setTimeout(() => { scaricaStemmi().catch(() => {}); }, 500);
  return "";
}
async function scaricaStemmi() {
  if (stemmiInCorso) return; stemmiInCorso = true;
  let presi = 0;
  try {
    while (STEMMI_CODA.size) {
      const k = STEMMI_CODA.values().next().value; STEMMI_CODA.delete(k);
      const [id, logo] = JSON.parse(k); if (!logo) continue;
      const f = path.join(STEMMI_DIR, "stemma-espn-" + id + ".png");
      if (fs.existsSync(f)) continue;
      try {
        // la versione da 250 px basta per una scheda e pesa un quarto
        const u = logo.indexOf("a.espncdn.com/i/teamlogos") >= 0
          ? "https://a.espncdn.com/combiner/i?img=" + encodeURIComponent(new URL(logo).pathname) + "&w=250&h=250" : logo;
        const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) continue;
        fs.writeFileSync(f + ".tmp", Buffer.from(await r.arrayBuffer()));
        fs.renameSync(f + ".tmp", f);
        presi++;
      } catch (e) {}
      await new Promise((ok) => setTimeout(ok, 150));
    }
    STEMMI_CACHE.clear();
    if (presi) console.log("[clip] stemmi: " + presi + " scaricati da ESPN");
  } finally { stemmiInCorso = false; }
}
// LE DUE SQUADRE DA UN TITOLO. I titoli sono scritti a mano e in cento modi:
// "BOLOGNA - COMO - ITA", "INTER-COMO - SEMI COPPA ITALIA RITORNO",
// "UNIV. CATOLICA-ESTUDIANTES 1-1", "Como U19 vs Empoli U19", "BOLOGNA.COMO".
// Si tolgono lingua, risultato e parole di servizio; poi, tra i pezzi separati
// da " - ", quello con dentro un trattino (o "vs") e' la partita.
const MESI_NOMI = "gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre";
function dueSquadre(testo) {
  let t = String(testo || "").replace(/\u{1F3A5}/gu, " ").replace(/\.(mp4|mov|mxf|mkv|m4v|ts)$/i, "").replace(/_+/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(new RegExp("\\d{1,2}\\s+(" + MESI_NOMI + ")\\s+\\d{4}\\b.*$", "i"), " ")
    .replace(/^\s*\d{6,9}\s*[_-]?\s*/, "")
    .replace(/\b(MultiCorder\d*|Output\s*\d+|BCK|SRT|FULL\s*MATCH|FULLMATCH|FULL|PARTITA\s+INTERA|CLEAN\s*FEED|CLEANFEED|INTERNATIONAL\s+SOUND|COMMENTARY|AUDIO\s*ONLY|PGM FX|PGM_FX|GARA\s*\d|GAME\s*\d|LEG\s*\d|SEMI\s*FINALS?|SEMIFINALE|QUARTI|OTTAVI|FINALE?)\b/gi, " ")
    .replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/\s\d{1,2}\s*-\s*\d{1,2}\b.*$/, "").trim();                       // il risultato e quello che segue
  // "UNIVERSITARIO (PERU)-BARCELONA": tolto il paese resta "UNIVERSITARIO  -BARCELONA"
  t = t.replace(/\s+-(?=\S)/g, " - ").replace(/(?<=\S)-\s+/g, " - ");
  t = t.replace(/(\s*[-–]\s*|\s+)(ITA|ENG|ITALIANO|ENGLISH)\s*$/i, "").replace(/^[\s\-–:]+|[\s\-–:]+$/g, "").trim();
  const seg = t.split(/\s+[-–]\s+/).map((x) => x.trim()).filter(Boolean);
  let coppia = null;
  const conTrattino = seg.find((x) => /\S-\S|\svs\.?\s/i.test(x));
  if (conTrattino) {
    coppia = conTrattino.split(/\s+vs\.?\s+|(?<=\S)-(?=\S)/i);
    // un trattino dentro il nome (Al-Ahli, Al-Hilal): il pezzo corto si riattacca al seguente
    if (coppia.length > 2) {
      const uniti = [];
      for (let k = 0; k < coppia.length; k++) {
        if ((coppia[k].trim().length <= 3 || /\bSAINT$/i.test(coppia[k].trim())) && k + 1 < coppia.length) { coppia[k + 1] = coppia[k].trim() + (/\bSAINT$/i.test(coppia[k].trim()) ? "-" : " ") + coppia[k + 1]; continue; }
        uniti.push(coppia[k]);
      }
      coppia = uniti;
    }
  }
  else if (seg.length === 2) coppia = seg;
  else if (seg.length === 1 && /^[^.]+\.[^.]+$/.test(seg[0]) && !/\b[A-Z]{1,4}\.\s/i.test(seg[0])) coppia = seg[0].split(".");  // BOLOGNA.COMO
  if (!coppia || coppia.length !== 2) return null;
  coppia = coppia.map((x) => x.replace(/^[\s\-–:+]+|[\s\-–:+]+$/g, "").replace(/\s+/g, " ").trim());
  // due nomi veri: almeno due lettere, e non parole di servizio
  if (coppia.some((x) => x.length < 2 || !/[A-Za-zÀ-ÿ]{2}/.test(x) || /^(ITA|ENG|LIVE|SHOW|STUDIO|COMO CUP)$/i.test(x))) return null;
  // non sono partite: conferenze, allenamenti, sorteggi, discorsi
  if (coppia.some((x) => /\b(PRESS|CONFERENC|CONFERENZA|TRAINING|SESSION|CAMP|SORTEGGI|RESPEECH|INTERVIST|CERIMONIA)/i.test(x))) return null;
  // "GRONINGEN RINVIATA": la partita resta, la parola no
  coppia = coppia.map((x) => x.replace(/\s+(RINVIATA|SOSPESA|ANNULLATA)\b/i, "").trim());
  return coppia;
}
// il titolo, il nome del file, la cartella: il primo che dice due squadre
function dueSquadreDi(a) {
  const cartelle = String(a.dove || "").split("/").filter((x) => x && !/^(TEMP|\d{6,9}|CLEAN ?FEED|ITA|ENG|\[.*\])$/i.test(x));
  for (const t of [a.partita, path.basename(String(a.chiave || ""))].concat(cartelle.reverse())) {
    const q = dueSquadre(t); if (q) return q;
  }
  return null;
}
// TheSportsDB, ultima fonte (gratis, senza chiave): per le squadre che ESPN
// non ha — il campionato croato, le serie minori. Si accetta solo se il
// risultato di calcio che contiene tutte le nostre parole e' uno solo.
const TSDB_FILE = () => path.join(DIR, "sportsdb-squadre.json");
let TSDB = null, tsdbInCorso = false;
const TSDB_CODA = new Set();
function tsdbDi(nome, comp) {
  const paesi = paesiDi(comp);
  if (!paesi || !paesi.length) return "";
  if (!TSDB) { try { TSDB = JSON.parse(fs.readFileSync(TSDB_FILE(), "utf8")); } catch (e) { TSDB = {}; } }
  let k = senzaAccenti(conEsonimi(senzaGiovanili(nome))).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (TSDB_CHIEDI[k]) k = TSDB_CHIEDI[k].toLowerCase();
  if (!k) return "";
  if (TSDB[k] === undefined) { TSDB_CODA.add(k); if (!tsdbInCorso) setTimeout(() => { cercaTsdb().catch(() => {}); }, 1000); return ""; }
  if (!TSDB[k]) return "";
  if (paesi.indexOf(TSDB[k].paese) < 0) return "";      // un'omonima di un altro paese
  const f = "stemma-tsdb-" + TSDB[k].id + ".png";
  return fs.existsSync(path.join(STEMMI_DIR, f)) ? "/loghi/" + f : "";
}
async function cercaTsdb() {
  if (tsdbInCorso) return; tsdbInCorso = true;
  let presi = 0;
  try {
    while (TSDB_CODA.size) {
      const k = TSDB_CODA.values().next().value; TSDB_CODA.delete(k);
      if (TSDB[k] !== undefined) continue;
      let esito = null;
      try {
        const r = await fetch("https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=" + encodeURIComponent(k), { signal: AbortSignal.timeout(20000) });
        if (r.status === 429) { TSDB_CODA.add(k); await new Promise((ok) => setTimeout(ok, 60000)); continue; }
        const j = r.ok ? await r.json() : {};
        const noi = paroleSquadra(k);
        const buoni = ((j && j.teams) || []).filter((t) => t.strSport === "Soccer" && t.strBadge && noi.length &&
          noi.every((w) => paroleSquadra(t.strTeam + " " + (t.strTeamAlternate || "")).some((v) => stessaParola(w, v))));
        if (buoni.length === 1) {
          const t = buoni[0], f = path.join(STEMMI_DIR, "stemma-tsdb-" + t.idTeam + ".png");
          if (!fs.existsSync(f)) {
            const g = await fetch(t.strBadge + "/small", { signal: AbortSignal.timeout(20000) });
            const b = g.ok ? g : await fetch(t.strBadge, { signal: AbortSignal.timeout(20000) });
            if (b.ok) { fs.writeFileSync(f + ".tmp", Buffer.from(await b.arrayBuffer())); fs.renameSync(f + ".tmp", f); presi++; }
          }
          esito = { id: t.idTeam, nome: t.strTeam, paese: t.strCountry || "" };
        }
      } catch (e) { continue; }                          // rete: si riprova al prossimo giro
      TSDB[k] = esito || false;
      if (Object.keys(TSDB).length % 10 === 0) { try { fs.writeFileSync(TSDB_FILE(), JSON.stringify(TSDB)); } catch (e) {} }
      await new Promise((ok) => setTimeout(ok, 2200));   // la chiave gratuita regge una trentina di domande al minuto
    }
    fs.writeFileSync(TSDB_FILE(), JSON.stringify(TSDB));
    STEMMI_CACHE.clear();
    if (presi) console.log("[clip] stemmi: " + presi + " presi da TheSportsDB");
  } finally { tsdbInCorso = false; }
}
// Le due squadre di una partita, con lo stemma (o "": la pagina fa la sigla)
function squadreConStemma(rec, a) {
  const chiaveCache = rec + "|" + (a.partita || "") + "|" + (a.chiave || "");
  // la memoria scade: un "senza stemma" deciso prima che ESPN fosse caricato non deve restare
  const c = STEMMI_CACHE.get(chiaveCache);
  if (c && Date.now() - c.t < 15 * 60000) return c.v;
  // l'MMA e il karate non hanno squadre ne' stemmi: resta il titolo
  const nomi = DA_STUDIO.test(a.partita || "") || /cage warriors|karate/i.test(a.competizione || "") ? null : dueSquadreDi(a);
  if (!nomi) { STEMMI_CACHE.set(chiaveCache, { v: null, t: Date.now() }); return null; }
  const e = ESPN[rec] || {};
  // nel confronto con l'evento le parole di tante squadre non contano: Boca
  // Juniors e Argentinos Juniors hanno in comune solo "juniors"
  const GENERICHE = new Set(["juniors", "junior", "atletico", "deportivo", "athletic", "universidad", "univ", "unidos",
    "futebol", "football", "calcio", "club", "rovers", "wanderers", "albion"]);
  const simile = (noi, loro) => {
    const tutte = paroleSquadra(senzaGiovanili(noi)), distinte = tutte.filter((w) => !GENERICHE.has(w));
    const A = distinte.length ? distinte : tutte, B = paroleSquadra(loro);
    return A.filter((w) => B.some((v) => stessaParola(w, v))).length;
  };
  // DALL'EVENTO ESPN, ma solo se e' davvero questa partita: ogni nostra
  // squadra deve somigliare alla sua. ESPN a volte ha preso un'altra partita
  // dello stesso giorno (Libertad-U. Central letta come IdV-Rosario Central).
  let daEvento = [null, null], loghiEvento = ["", ""];
  if ((e.squadre || []).length === 2 && Object.keys(CATALOGO.squadre).length) {
    const ids = e.squadre.map((n) => {
      const u = (e.loghi || {})[n]; const m = u && /\/(\d+)\.png/.exec(u);
      return m ? m[1] : squadraEspnDalNomeEspn(n);
    });
    const lg = e.squadre.map((n) => (e.loghi || {})[n] || "");
    const d0 = simile(nomi[0], e.squadre[0]), d1 = simile(nomi[1], e.squadre[1]);
    const s0 = simile(nomi[0], e.squadre[1]), s1 = simile(nomi[1], e.squadre[0]);
    if (d0 && d1 && d0 + d1 >= s0 + s1) { daEvento = [ids[0], ids[1]]; loghiEvento = [lg[0], lg[1]]; }
    else if (s0 && s1) { daEvento = [ids[1], ids[0]]; loghiEvento = [lg[1], lg[0]]; }
  }
  let manca = false;
  const fuori = nomi.map((nome, i) => {
    const suo = fileRedazione(nome);
    if (suo) return { nome, stemma: suo };
    const id = daEvento[i] || squadraEspnDalNome(nome, a.competizione);
    let st = id ? stemmaEspn(id, loghiEvento[i]) : "";
    if (id && !st) manca = true;                        // sta arrivando: non si tiene in memoria
    if (!id) { st = tsdbDi(nome, a.competizione); if (!st && TSDB_CODA.size) manca = true; }
    return { nome, stemma: st };
  });
  if (!manca) STEMMI_CACHE.set(chiaveCache, { v: fuori, t: Date.now() });
  return fuori;
}
function preparaStemmi() {
  const chiavi = Object.keys(ARCHIVIO); let i = 0;
  const blocco = () => {
    const fine = Math.min(chiavi.length, i + 40);
    for (; i < fine; i++) {
      const a = ARCHIVIO[chiavi[i]]; if (!a || !a.chiave) continue;
      try { squadreConStemma(chiavi[i], a); studioDi(chiavi[i], a); } catch (e) {}
    }
    if (i < chiavi.length) setTimeout(blocco, 50);
  };
  blocco();
}
// I NOMI DATI A MANO alle cartelle senza riga Airtable (soloS3): il giro
// dell'indice rimetterebbe il nome della cartella, quindi stanno a parte,
// per cartella, e vincono sempre. "FESTEGGIAMENTI PULLMAN COMO CHAMPIONS"
// -> "Bus scoperto Champions League" (Goffredo, 25/09/2026).
const TITOLI_FILE = () => path.join(DIR, "titoli-a-mano.json");
let TITOLI = null;
function titoliAMano() { if (!TITOLI) { try { TITOLI = JSON.parse(fs.readFileSync(TITOLI_FILE(), "utf8")); } catch (e) { TITOLI = {}; } } return TITOLI; }
function titoloAMano(dove) { return titoliAMano()[dove] || ""; }
// IL TITOLO per le anteprime senza squadre: il nome se dice qualcosa, se no
// la cartella ("MultiCorder3 - Output 1…" non dice niente a nessuno)
// il logo di un evento (Como Cup, Kings League…): "evento-<nome>" nella cartella dei loghi
function logoEvento(a) {
  for (const n of [a.competizione, titoloDi(a)]) {
    const slug = senzaAccenti(String(n || "")).toLowerCase().replace(/\b(ita|eng)\b/g, " ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) continue;
    for (const est of [".png", ".svg", ".webp"]) if (fs.existsSync(path.join(STEMMI_DIR, "evento-" + slug + est))) return "/loghi/evento-" + slug + est;
  }
  return "";
}
function titoloDi(a) {
  if (a.soloS3 && titoloAMano(a.dove)) return titoloAMano(a.dove);
  const p = String(a.partita || "").trim().replace(/\s*[-–]\s*(ITA|ENG)\s*$/i, "");
  // un nome che e' solo una data o "3 CLEANFEED" non dice niente; "20260728_COMO CUP CLEANFEED" dice COMO CUP
  const pulito = p.replace(/\.(mp4|mov|mxf|mkv)$/i, "").replace(/^\d{6,9}[\s_-]*/, "").replace(/[\s_-]*clean ?feed\s*$/i, "").replace(/_+/g, " ").trim();
  const vuoto = !pulito || /^\d{6,9}$|^\d*[\s_]*clean ?feed$/i.test(p.trim());
  if (!vuoto && pulito !== p && !/multicorder|output\s*\d/i.test(pulito)) return pulito;
  if (p && !vuoto && !/multicorder|output\s*\d/i.test(p) && p.replace(/[\s\-–]/g, "").length > 2) return p.replace(/\s*[-–]\s*$/, "");
  const cartelle = String(a.dove || "").split("/").filter((x) => x && !/^(TEMP|\d{6,9}|ITA|ENG|\[.*\]|\d*[\s_]*CLEAN ?FEED|cleanfeed)$/i.test(x.trim()));
  const t = (cartelle.pop() || "").replace(/_+/g, " ").trim();
  if (t && !/multicorder|output\s*\d/i.test(t)) return t;
  // non dice niente nemmeno la cartella: si dice che cosa e' e quando
  const g = a.giorno || (Date.parse(a.quando) ? giornoRoma(Date.parse(a.quando)) : "");
  return g ? "Registrazione del " + g.slice(6, 8) + "/" + g.slice(4, 6) + "/" + g.slice(0, 4) : "Registrazione";
}
// LO STUDIO: il format (Football Show, Pre Show, Intervallo, Post Partita,
// Speciale) e il resto del titolo; se dentro c'e' una partita ("+ Como-Parma",
// "Liverpool-Como") le sue due squadre, con gli stemmi.
const FORMATI_STUDIO = [
  [/FOOTBALL\s*SHOW/i, "Football Show"], [/FUTBOL\s*SHOW/i, "Futbol Show"], [/COMO\s*CUP\s*SHOW/i, "Como Cup Show"],
  [/PRE[ -]?SHOW/i, "Pre Show"], [/PRE[ -]?PARTITA/i, "Pre Partita"], [/POST[ -]?PARTITA/i, "Post Partita"],
  [/INTERVALLO/i, "Intervallo"], [/SPECIALE/i, "Speciale"], [/RECAP/i, "Recap"], [/STUDIO/i, "Studio"], [/SHOW/i, "Show"]
];
function studioDi(rec, a) {
  const t0 = String(a.partita || "").replace(/\u{1F3A5}/gu, " ").replace(/\s+/g, " ").trim();
  if (!DA_STUDIO.test(a.partita || "")) return null;
  const f = FORMATI_STUDIO.find(([re]) => re.test(t0));
  const formato = f ? f[1] : "Studio";
  let sotto = f ? t0.replace(f[0], " ") : t0;
  sotto = sotto.replace(/^[\s:+\-–·|]+|[\s:+\-–·|]+$/g, "").replace(/\s+/g, " ").trim();
  // la partita di cui si parla: "Live Monday Night + Como-Parma" -> Como-Parma
  const dopoPiu = sotto.split("+").pop().replace(/^\s*(PRE|POST|LIVE)\b\s*/i, "");
  const q2 = dueSquadre(dopoPiu);
  let squadre = null;
  if (q2) {
    const q = squadreConStemma("studio|" + rec, { partita: q2.join("-"), competizione: a.competizione });
    if (q && q.length === 2) squadre = q;
  }
  return { formato, sotto, squadre };
}
// LA STESSA SQUADRA? Il nostro nome (scritto a mano, spesso in italiano) e
// quello di ESPN. Ne' troppo largo — "nacional" sta dentro "internacional",
// e Nacional-Atletico Nacional diventava Bahia-Internacional — ne' troppo
// stretto: "inter" e' l'inizio di "internazionale", "U de Cile" e'
// l'Universidad de Chile, e lo stemma uguale vuol dire squadra uguale.
function stessaSquadra(noi, loro, comp) {
  const chiaro = senzaAccenti(senzaGiovanili(noi)).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const alias = ALIAS_STEMMI[chiaro];
  const A = paroleSquadra(senzaGiovanili(alias || noi)), B = paroleSquadra(loro);
  if (A.some((w) => B.some((v) => stessaParola(w, v) || (w.length >= 3 && v.length > w.length && v.startsWith(w))))) return true;
  if (alias && nomeSemplice(alias) === nomeSemplice(loro)) return true;
  const idNoi = squadraEspnDalNome(noi, comp), idLoro = squadraEspnDalNomeEspn(loro);
  return !!(idNoi && idLoro && idNoi === idLoro);
}
// giovanili e femminile: dal titolo, dalla competizione o dalla cartella
function nonDaEspn(rec) {
  const a = ARCHIVIO[rec] || {};
  return /\b(U\s?\d{2}|UNDER\s?\d{2}|PRIMAVERA|FEMMINILE|WOMEN|GIOVANILI)\b/i.test([a.partita, a.competizione, a.dove].join(" "));
}
// L'EVENTO ESPN E' DAVVERO QUESTA PARTITA? Le due squadre nostre devono
// esserci tutte e due tra quelle dell'evento.
function espnCombacia(rec) {
  const a = ARCHIVIO[rec], e = ESPN[rec];
  if (!a || !e || !e.id) return true;
  if (nonDaEspn(rec)) return false;
  const noi = dueSquadreDi(a);
  const loro = (e.squadre && e.squadre.length === 2) ? e.squadre : String(e.nome || "").split(/\s+(?:at|vs\.?)\s+/i);
  if (!noi || loro.length !== 2) return true;             // non si puo' dire: si lascia
  const sim = (x, y) => stessaSquadra(x, y, a.competizione);
  return (sim(noi[0], loro[0]) && sim(noi[1], loro[1])) || (sim(noi[0], loro[1]) && sim(noi[1], loro[0]));
}
// UNO STEMMA DA UN NOME SOLO (conferenze, giornate): redazione, ESPN, TheSportsDB
function unoStemma(nome, comp) {
  const suo = fileRedazione(nome); if (suo) return suo;
  const id = squadraEspnDalNome(nome, comp);
  if (id) return stemmaEspn(id, "");
  return tsdbDi(nome, comp);
}
// I CONTENUTI SPECIALI, disegnati come gli studi (Goffredo, 25/09/2026):
//   conferenza stampa -> lo stemma della squadra e la scritta
//   giornata di Como Cup -> gli stemmi di tutte le squadre di quel giorno,
//                           lette dai nomi dei file della cartella del giorno
function specialeDi(rec, a) {
  const t = String(a.partita || "");
  const conf = /(?:REC\s+)?(?:CONF(?:ERENZA)?\.?\s*STAMPA|PRESS\s+CONFERENCE)\s+(.+)$/i.exec(t);
  if (conf) {
    const chi = conf[1].split(/\s+[-–]\s+/)[0].trim();
    const comp = /sudamericana/i.test(t + " " + a.competizione) ? "Copa Sudamericana" : a.competizione;
    return { formato: "Conferenza stampa", sotto: chi, squadre: [{ nome: chi, stemma: unoStemma(chi, comp) }] };
  }
  if ((/como cup/i.test(a.competizione || "") || /^COMO CUP\b/i.test(titoloDi(a))) && !dueSquadreDi(a)) {
    const g = a.giorno || (Date.parse(a.quando) ? giornoRoma(Date.parse(a.quando)) : "");
    const mg = magazzinoInventario(a.bucket);
    // SOLO LA CARTELLA DEL TORNEO: quel giorno nella cartella del giorno ci
    // sono anche altre partite (Aberdeen, Porto…). Se il file sta alla radice
    // del giorno, si guarda la cartella "COMO CUP" accanto.
    // fino alla cartella del torneo compresa: "TEMP/20260728/COMO CUP/ITA/…" -> "TEMP/20260728/COMO CUP/"
    const pezzi = String(a.dove || "").split("/"), i = pezzi.findIndex((x) => /^\s*como\s*cup\s*$/i.test(x));
    let cartella = i >= 0 ? pezzi.slice(0, i + 1).join("/") + "/" : "";
    if (!cartella && g && mg) {
      const c = elencaInventario(mg, "TEMP/" + g + "/", "/").cartelle.find((x) => /como\s*cup/i.test(x));
      if (c) cartella = c;
    }
    const nomi = [];
    if (cartella && mg) elencaInventario(mg, cartella, "").oggetti.forEach((o) => {
      if (!VIDEO.test(o.chiave)) return;
      const q = dueSquadre(path.basename(o.chiave)); if (!q) return;
      q.forEach((n) => {
        const p = paroleSquadra(senzaGiovanili(n));
        // la stessa squadra scritta male (Famalico/Famalicao) non e' una squadra in piu'
        if (p.length && !nomi.some((m) => paroleSquadra(senzaGiovanili(m)).some((v) => p.some((w) => stessaParola(w, v))))) nomi.push(n);
      });
    });
    nomi.splice(6);
    if (!nomi.length) return null;
    return { formato: "Como Cup", sotto: nomi.join(" · "), squadre: nomi.map((n) => ({ nome: n, stemma: unoStemma(n, "") })) };
  }
  return null;
}
// I LOGHI DI UN EVENTO: quelli nominati nel titolo o nella competizione
// (un sorteggio Libertadores + Sudamericana ne ha due), e "CW 183" e' Cage
// Warriors, "KC53" Karate Combat
const EVENTI_NOTI = [
  [/libertadores/i, "copa-libertadores"], [/sudamericana/i, "copa-sudamericana"], [/champions/i, "uefa-champions-league"],
  [/cage\s*warriors|^\s*CW\s*\d+/i, "cage-warriors"], [/karate\s*combat|\bKC\s*\d+/i, "karate-combat"],
  [/maratona|marathon|marat[oó]n/i, "maratona-valencia"], [/kings\s*league/i, "kings-league"], [/como\s*cup/i, "como-cup"]
];
function loghiEvento(a) {
  const testo = String(a.partita || "") + " | " + String(a.competizione || "") + " | " + titoloDi(a);
  const fuori = [];
  EVENTI_NOTI.forEach(([re, slug]) => {
    if (!re.test(testo)) return;
    for (const est of [".png", ".svg", ".webp"]) if (fs.existsSync(path.join(STEMMI_DIR, "evento-" + slug + est))) { fuori.push("/loghi/evento-" + slug + est); break; }
  });
  const suo = logoEvento(a); if (suo && fuori.indexOf(suo) < 0) fuori.push(suo);
  return fuori.slice(0, 3);
}
// LA COMPETIZIONE DA SCRIVERE in alto a sinistra: quella di Airtable, o
// quella che si capisce dal titolo quando Airtable non c'e'
const LEGHE_NOMI = { "ita.1": "Serie A", "ita.2": "Serie B", "ita.coppa_italia": "Coppa Italia" };
function competizioneVista(a, rec) {
  const c = String(a.competizione || "").trim();
  // "Como 1907 | Prima Squadra" in Airtable e' un contenitore: dentro ci sono
  // femminile, Primavera e amichevoli. Si dice che cosa e' davvero.
  if (/prima squadra/i.test(c)) {
    const tutto = [a.partita, a.dove].join(" ");
    if (/femminile|women/i.test(tutto)) return "Como Women";
    if (/\b(U\s?\d{2}|UNDER\s?\d{2}|PRIMAVERA)\b/i.test(tutto)) return "Primavera";
    const e = rec ? ESPN[rec] : null;
    if (e && e.id && LEGHE_NOMI[e.lega]) return LEGHE_NOMI[e.lega];
    const m = Date.parse(a.quando) ? new Date(Date.parse(a.quando)).getUTCMonth() + 1 : 0;
    if (m >= 6 && m <= 8) return "Amichevole";
    // in stagione, e ESPN (che ha la prima squadra) non la conosce: e' la Primavera
    return m ? "Primavera" : "Como 1907";
  }
  if (c && !/^(ITA|ENG|EVENTO REC)$/i.test(c) && !/ vs | - /.test(c)) return c;
  const t = String(a.partita || "") + " " + titoloDi(a);
  const u = /\bU\s?(\d{2})\b|\bUNDER\s?(\d{2})\b/i.exec(t);
  if (u) return "Under " + (u[1] || u[2]);
  if (/femminile|women/i.test(t)) return "Como Women";
  if (/primavera/i.test(t)) return "Primavera";
  if (/cage\s*warriors|^\s*CW\s*\d+/i.test(t)) return "Cage Warriors";
  if (/karate\s*combat|\bKC\s*\d+/i.test(t)) return "Karate Combat";
  if (/libertadores/i.test(t)) return "Copa Libertadores";
  if (/sudamericana/i.test(t)) return "Copa Sudamericana";
  if (/champions/i.test(t)) return "UEFA Champions League";
  if (/como\s*cup/i.test(t)) return "Como Cup";
  if (/marat/i.test(t)) return "Maratona";
  return competizioneDedotta(a, rec, t);
}
// SENZA NIENTE IN AIRTABLE (cartelle senza riga): la si deduce, senza inventare
const LEGHE_CASA = { "ita.1": "Serie A", "ita.2": "Serie B", "eng.1": "Premier League", "eng.2": "Championship", "sco.1": "Scottish Premiership",
  "ned.1": "Eredivisie", "aut.1": "Bundesliga Austria", "ger.1": "Bundesliga", "fra.1": "Ligue 1", "esp.1": "LaLiga", "por.1": "Liga Portugal",
  "gre.1": "Super League Grecia", "ksa.1": "Saudi Pro League", "arg.1": "Liga Profesional", "bra.1": "Brasileirao" };
let COMP_GEMELLE = null, compGemelleQuando = 0;
function competizioneDedotta(a, rec, t) {
  // 1) la gemella: stesso giorno, stesse squadre, con la competizione scritta
  if (!COMP_GEMELLE || Date.now() - compGemelleQuando > 60000) {
    COMP_GEMELLE = new Map(); compGemelleQuando = Date.now();
    Object.keys(ARCHIVIO).forEach((k) => {
      const x = ARCHIVIO[k]; if (!x || !x.competizione || /^(ITA|ENG|EVENTO REC)$/i.test(x.competizione.trim())) return;
      const c = chiaveGemella(x); if (!c || COMP_GEMELLE.has(c)) return;
      const v = competizioneVista(x, k); if (v) COMP_GEMELLE.set(c, v);
    });
  }
  const g = chiaveGemella(a); if (g && COMP_GEMELLE.has(g)) return COMP_GEMELLE.get(g);
  // 2) il titolo
  if (/coppa italia/i.test(t)) return "Coppa Italia";
  if (DA_STUDIO.test(t)) return "Studio Live";
  // 3) le due squadre giocano nello stesso campionato
  const q = dueSquadreDi(a);
  if (q) {
    const ids = q.map((n) => squadraEspnDalNome(n, "")).filter(Boolean);
    if (ids.length === 2) {
      const comuni = CATALOGO.squadre[ids[0]].leghe.filter((l) => LEGHE_CASA[l] && CATALOGO.squadre[ids[1]].leghe.indexOf(l) >= 0);
      if (comuni.length === 1) return LEGHE_CASA[comuni[0]];
    }
    // 4) il Como d'estate, fuori dalle coppe: amichevole
    const m = Date.parse(a.quando) ? new Date(Date.parse(a.quando)).getUTCMonth() + 1 : 0;
    if (m >= 6 && m <= 8 && q.some((n) => /^como$/i.test(senzaGiovanili(n).trim()))) return "Amichevole";
  }
  return "";
}
// telecronista e lingua: l'inglese e' sempre Paul Dempsey; l'audio senza voce non ha telecronista
function voceDi(rec, a) {
  const p = String(a.partita || "").toUpperCase();
  if (/AUDIO ?ONLY|INTERNATIONAL SOUND/.test(p)) return { lingua: "AUDIO", tele: "" };
  if (/(^|[^A-Z])ENG([^A-Z]|$)/.test(p)) return { lingua: "ENG", tele: "Paul Dempsey" };
  const tele = (APPUNTI[rec] || {}).telecronista || "";
  return { lingua: tele || /(^|[^A-Z])ITA([^A-Z]|$)/.test(p) ? "ITA" : "", tele };
}
function risultatoProprio(a) {
  const m = /\s(\d{1,2})\s*-\s*(\d{1,2})\b/.exec(String(a.partita || ""));
  if (m) return [+m[1], +m[2]];
  const f = a.tabellone && a.tabellone.verificato && /^(\d+)-(\d+)$/.exec(a.tabellone.finale || "");
  return f ? [+f[1], +f[2]] : null;
}
// LA PARTITA E' UNA, LE VERSIONI TANTE: la ENG e l'audio internazionale non
// portano il risultato nel titolo, ma e' lo stesso della ITA. Si cerca la
// gemella: stesso giorno, stesse due squadre.
let GEMELLI = null, gemelliQuando = 0;
function chiaveGemella(a) {
  const q = dueSquadreDi(a); if (!q) return "";
  const g = a.giorno || (Date.parse(a.quando) ? giornoRoma(Date.parse(a.quando)) : "");
  return g + "|" + q.map((x) => nomeSemplice(conEsonimi(x))).join("|");
}
function risultatoDi(a) {
  const mio = risultatoProprio(a); if (mio) return mio;
  if (!GEMELLI || Date.now() - gemelliQuando > 60000) {
    GEMELLI = new Map(); gemelliQuando = Date.now();
    Object.keys(ARCHIVIO).forEach((k) => {
      const x = ARCHIVIO[k]; if (!x || DA_STUDIO.test(x.partita || "")) return;
      const r = risultatoProprio(x); if (!r) return;
      const c = chiaveGemella(x); if (c && !GEMELLI.has(c)) GEMELLI.set(c, r);
    });
  }
  const c = chiaveGemella(a);
  return (c && GEMELLI.get(c)) || null;
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
// Gli eventi chiave di ESPN. In un gol il secondo "participant" e'
// l'assistman: fino al 26/09/2026 si teneva solo il primo, e "assist di
// Nico Paz" non si poteva sapere.
function eventiEspn(sm) {
  return (sm.keyEvents || []).map((k) => {
    const tipo = ((k.type || {}).text) || "";
    const mm = minutoEspn((k.clock || {}).displayValue);
    if (!mm || /kickoff|half|end |full|start/i.test(tipo)) return null;
    const periodo = ((k.period || {}).number) || (mm.min > 45 ? 2 : 1);
    const chi = (k.participants || []).map((p) => ((p || {}).athlete || {}).displayName || "");
    const x = { tipo: tipo, min: mm.min, stopp: mm.stopp, periodo: periodo,
                squadra: ((k.team || {}).displayName) || "",
                giocatore: chi[0] || "",
                testo: k.shortText || k.text || "" };
    if (/goal|penalty - scored/i.test(tipo) && !/own goal/i.test(tipo)) x.assist = chi[1] || "";
    if (k.text && k.text !== x.testo) x.lungo = String(k.text).slice(0, 240);
    return x;
  }).filter(Boolean);
}
// RILEGGERE ESPN per le partite gia' riconosciute: gli assistman degli
// eventi chiave e, dove manca, la cronaca (tiri, parate, pali). Si
// chiede l'evento per numero, una partita alla volta, piano: ESPN e'
// gratis e non ha fretta. Le versioni ITA/ENG/AUDIO della stessa gara
// hanno lo stesso numero ESPN: una domanda sola per tutte.
const RILEGGI = { fatte: 0, fallite: 0, totale: 0, inCorso: false, ultima: "" };
async function giroRileggiEspn() {
  if (RILEGGI.inCorso) return; RILEGGI.inCorso = true;
  try {
    const perId = {};
    Object.keys(ESPN).forEach((rec) => { const e = ESPN[rec]; if (!e || !e.id || !e.lega || e.riletto) return; (perId[e.id] = perId[e.id] || []).push(rec); });
    // prima le partite che sono in casa, poi quelle dell'archivio, poi il resto
    const peso = (ids) => ids.some((rec) => ARCHIVIO[rec] && !ARCHIVIO[rec].soloS3) ? 0 : ids.some((rec) => ARCHIVIO[rec]) ? 1 : 2;
    const coda = Object.keys(perId).sort((a, b) => peso(perId[a]) - peso(perId[b]));
    RILEGGI.totale = coda.length + RILEGGI.fatte;
    for (const id of coda) {
      const recs = perId[id], e0 = ESPN[recs[0]];
      try {
        const sm = await espnPrendi("https://site.api.espn.com/apis/site/v2/sports/soccer/" + e0.lega + "/summary?event=" + id);
        const eventi = eventiEspn(sm), gamecast = leggiGamecast(sm);
        recs.forEach((rec) => {
          const e = ESPN[rec]; if (!e || String(e.id) !== String(id)) return;
          if (eventi.length) e.eventi = eventi;
          if (gamecast.length) e.gamecast = gamecast;
          e.riletto = new Date().toISOString();
        });
        RILEGGI.fatte++; RILEGGI.ultima = e0.nome || id;
      } catch (err) { RILEGGI.fallite++; recs.forEach((rec) => { if (ESPN[rec]) ESPN[rec].riletto = "errore " + String(err.message).slice(0, 60); }); }
      if ((RILEGGI.fatte + RILEGGI.fallite) % 25 === 0) { scriviEspn(); if (global.__TAB_CACHE) global.__TAB_CACHE.quando = 0; }
      await new Promise((ok) => setTimeout(ok, 1500));
    }
    scriviEspn(); if (global.__TAB_CACHE) global.__TAB_CACHE.quando = 0;
    console.log("[clip] espn riletto: " + RILEGGI.fatte + " partite, " + RILEGGI.fallite + " non lette");
  } finally { RILEGGI.inCorso = false; }
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
// IL RITARDO FINE, MISURATO SUL BOATO. Il minuto che scrive il giornalista
// cade sul replay, non sull'azione, e di quanto lo dice il boato: sul gol
// il boato da' il secondo esatto, e la differenza fra dove la riga era
// stimata e dove lo stadio ha urlato e' il ritardo di QUELLA sera, contato
// in secondi invece che in minuti. Si applica alle azioni silenziose — un
// tiro alto, una parata — che un boato non ce l'hanno e che altrimenti
// restano indietro di tutta la distanza.
function ritardoFine(rec) {
  const a = ARCHIVIO[rec];
  if (!a || !(a.boati || []).length) return 0;
  const scarti = a.boati.filter((x) => x.t !== null && x.t !== undefined && x.stimato !== undefined)
                        .map((x) => x.stimato - x.t);
  if (scarti.length < 2) return 0;                  // con un gol solo non e' una misura
  const m = mediana(scarti);
  return Math.abs(m) <= 120 ? Math.round(m) : 0;    // oltre due minuti non e' ritardo, e' un altro errore
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
               ".xml": "application/xml", ".jpg": "image/jpeg", ".srt": "text/plain; charset=utf-8",
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
// il magazzino di questa partita esiste ancora?
// come magazzinoDi, ma senza lanciare: serve solo a sapere se quel secchio
// e' una cartella montata (la NAS) o un secchio vero
function magazzinoDi2(bucket) {
  try { return magazzinoDi(bucket); } catch (e) { return null; }
}
function magazzinoCe(r) {
  if (!r || !r.arch) return false;
  try { magazzinoDi(r.arch.bucket); return true; } catch (e) { return false; }
}
function magazzinoDaFuori(r) {
  if (!r || !r.arch) return true;
  let m;
  // un magazzino che non c'e' piu' non e' raggiungibile da nessuno: si
  // risponde "no", non si alza un'eccezione. Chiederlo e' una domanda.
  try { m = magazzinoDi(r.arch.bucket); } catch (e) { return false; }
  if (m.cartella) return false;                    // un percorso sul disco: il browser non lo apre mai
  if (m.inventario) return false;                  // il ponte sta sulla VM: il video passa da qui, contato
  if (!m.endpoint) return true;                    // Amazon: sempre
  return m.fuori === true;                         // di casa: solo se lo dici tu
}
function serviFileLocale(req, res, file, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("non trovato"); return; }
    const tipoFile = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
                       ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ts": "video/mp2t", ".txt": "text/plain; charset=utf-8",
                       ".json": "application/json; charset=utf-8", ".srt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
                       ".log": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                       ".wav": "audio/wav", ".mp3": "audio/mpeg", ".pdf": "application/pdf", ".bin": "application/octet-stream" }[path.extname(file).toLowerCase()] || "video/mp4";
    const base = Object.assign({ "Content-Type": tipoFile, "Accept-Ranges": "bytes",
                   "Cache-Control": "private, max-age=3600", "Access-Control-Allow-Origin": "*" }, extra || {});
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
// ── IL FINDER DEL MAGAZZINO ────────────────────────────────────────────
//
//  La QNAP si sfoglia come una cartella: cartelle e file, con peso, data e
//  — se il file e' una partita che l'archivio conosce — il nome della
//  partita e il modo di aprirla nel MAM. Rinominare, spostare e fare una
//  cartella passano da qui, dentro la radice del magazzino e mai fuori.
//  Se la QNAP e' montata in sola lettura lo si dice, non si prova.
const QNAP_RADICE = process.env.COMOTV_NAS_CARTELLA || "/mnt/qnap100";
const QNAP_NASCOSTI = /^[.@]|^#recycle$|^\.DS_Store$/i;
let qnapScrivibile = null;
// LE RADICI: la QNAP, e le cartelle della VM (dati del ponte, sito, codice,
// motori). Sulla VM si guarda soltanto: rinominare li' dentro romperebbe
// il ponte, e per liberare spazio si decide a mano.
function qnapRadici() {
  const dev = /comotv-dev/.test(DIR);
  const suff = dev ? "-dev" : "";
  return [
    { id: "qnap", nome: "QNAP \u00b7 archivio partite", via: QNAP_RADICE, scrive: true },
    { id: "dati", nome: "VM \u00b7 dati del ponte" + (dev ? " (dev)" : ""), via: path.dirname(DIR), scrive: false },
    { id: "sito", nome: "VM \u00b7 sito pubblicato" + (dev ? " (dev)" : ""), via: "/var/www/comotv" + suff, scrive: false },
    { id: "ponte", nome: "VM \u00b7 codice del ponte" + (dev ? " (dev)" : ""), via: "/opt/comotv" + suff, scrive: false },
    { id: "whisper", nome: "VM \u00b7 whisper e modelli", via: "/opt/whisper.cpp", scrive: false },
    { id: "traduci", nome: "VM \u00b7 traduttore", via: "/opt/traduci", scrive: false }
  ].filter((r) => { try { return fs.statSync(r.via).isDirectory(); } catch (e) { return false; } });
}
function qnapRadice(id) {
  const r = qnapRadici().find((x) => x.id === String(id || "qnap")) || qnapRadici()[0];
  if (!r) throw new Error("nessun magazzino raggiungibile");
  return r;
}
function qnapDentro(via, radiceId) {
  const R0 = qnapRadice(radiceId);
  const pulita = String(via || "").replace(/\\/g, "/").split("/").filter((x) => x && x !== "." && x !== "..").join("/");
  const pieno = path.resolve(R0.via, pulita);
  if (pieno !== R0.via && !pieno.startsWith(R0.via + path.sep)) throw new Error("fuori dal magazzino");
  return { rel: pulita, pieno, radice: R0 };
}
// il peso di una cartella, contando fino a un tetto: sulla VM serve a capire
// che cosa occupa il disco, sulla QNAP quanto pesa una stagione
function qnapPeso(p) {
  const { pieno } = qnapDentro(p.via, p.radice);
  let peso = 0, file = 0, cartelle = 0, tetto = 60000, tronco = false;
  const giro = (d) => {
    let voci; try { voci = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const v of voci) {
      if (file + cartelle > tetto) { tronco = true; return; }
      const suo = path.join(d, v.name);
      if (v.isDirectory()) { cartelle++; giro(suo); }
      else if (v.isFile()) { file++; try { peso += fs.statSync(suo).size; } catch (e) {} }
    }
  };
  giro(pieno);
  return { ok: true, peso, file, cartelle, tronco };
}
function qnapSiScrive() {
  if (qnapScrivibile !== null) return qnapScrivibile;
  try { const f = path.join(QNAP_RADICE, ".comotv-prova-scrittura"); fs.writeFileSync(f, "x"); fs.unlinkSync(f); qnapScrivibile = true; }
  catch (e) { qnapScrivibile = false; }
  setTimeout(() => { qnapScrivibile = null; }, 600000);
  return qnapScrivibile;
}
function qnapPartite() {
  const m = {};
  Object.keys(ARCHIVIO || {}).forEach((rec) => {
    const a = ARCHIVIO[rec]; if (!a) return;
    const nome = a.partita || a.titolo || a.nome || "";
    const chiavi = (a.pezzi && a.pezzi.length ? a.pezzi.map((x) => x.chiave) : [a.chiave]).filter(Boolean);
    chiavi.forEach((c) => { m[c] = { rec, partita: nome, riconosciuta: !!a.riconosciuta || !!nome }; });
  });
  return m;
}
function qnapElenco(p) {
  const { rel, pieno, radice } = qnapDentro(p.via, p.radice);
  let voci;
  try { voci = fs.readdirSync(pieno, { withFileTypes: true }); }
  catch (e) { throw new Error(e.code === "ENOENT" ? "questa cartella non c'e' (piu')" : "magazzino non raggiungibile: " + e.message); }
  const partite = qnapPartite();
  const elenco = [];
  voci.forEach((d) => {
    if (QNAP_NASCOSTI.test(d.name) && !p.nascosti) return;
    const suo = path.join(pieno, d.name);
    let st = null; try { st = fs.statSync(suo); } catch (e) { return; }
    const relSuo = rel ? rel + "/" + d.name : d.name;
    const est = d.isDirectory() ? "" : path.extname(d.name).slice(1).toLowerCase();
    const v = { nome: d.name, via: relSuo, tipo: d.isDirectory() ? "cartella" : "file", peso: d.isDirectory() ? 0 : st.size,
                quando: st.mtimeMs, est, video: /^(mp4|mov|mxf|mkv|ts|m4v)$/.test(est), immagine: /^(jpe?g|png|gif|webp)$/.test(est) };
    const pa = partite[relSuo]; if (pa) { v.rec = pa.rec; v.partita = pa.partita; }
    // una registrazione aperta dal magazzino con questo file: si apre nel MAM anche senza indice
    const r = Object.keys(R.reg).map((k) => R.reg[k]).find((x) => x.arch && (x.arch.chiave === relSuo || (x.arch.pezzi || []).some((z) => z.chiave === relSuo)));
    if (r) { v.reg = r.id; v.partita = v.partita || r.titolo; if (!v.rec && r.arch.rec) v.rec = r.arch.rec; }
    elenco.push(v);
  });
  elenco.sort((a, b) => (a.tipo !== b.tipo) ? (a.tipo === "cartella" ? -1 : 1) : a.nome.localeCompare(b.nome, "it", { numeric: true }));
  return { ok: true, via: rel, radice: radice.id, radici: qnapRadici().map((r) => ({ id: r.id, nome: r.nome })), elenco,
           scrivibile: radice.id === "qnap" ? qnapSiScrive() : false, soloVista: radice.id !== "qnap", quanti: elenco.length };
}
function qnapNomeBuono(n) {
  const nome = String(n || "").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "").trim();
  if (!nome || nome === "." || nome === "..") throw new Error("nome non valido");
  return nome;
}
function qnapErrore(e) {
  if (e.code === "EROFS" || e.code === "EACCES" || e.code === "EPERM") return new Error("il magazzino e' montato in sola lettura: per rinominare o spostare va montato in scrittura");
  if (e.code === "EEXIST") return new Error("c'e' gia' un file o una cartella con questo nome");
  if (e.code === "ENOENT") return new Error("il file non c'e' (piu')");
  if (e.code === "ENOTEMPTY") return new Error("la cartella non e' vuota");
  return e;
}
function qnapSoloQnap(p) { if (String(p.radice || "qnap") !== "qnap") throw new Error("sulla VM si guarda soltanto: qui non si rinomina ne' si sposta"); }
function qnapRinomina(p) {
  qnapSoloQnap(p);
  const { pieno, rel } = qnapDentro(p.via);
  const nuovo = qnapNomeBuono(p.nome);
  const dest = path.join(path.dirname(pieno), nuovo);
  if (dest === pieno) return { ok: true, via: rel };
  if (fs.existsSync(dest)) throw new Error("c'e' gia' un file o una cartella con questo nome");
  try { fs.renameSync(pieno, dest); } catch (e) { throw qnapErrore(e); }
  qnapAggiornaIndice(rel, path.relative(QNAP_RADICE, dest).split(path.sep).join("/"));
  return { ok: true, via: path.relative(QNAP_RADICE, dest).split(path.sep).join("/") };
}
function qnapSposta(p) {
  qnapSoloQnap(p);
  const { pieno, rel } = qnapDentro(p.via);
  const dove = qnapDentro(p.dove);
  let st; try { st = fs.statSync(dove.pieno); } catch (e) { throw new Error("la cartella di destinazione non c'e'"); }
  if (!st.isDirectory()) throw new Error("la destinazione non e' una cartella");
  const dest = path.join(dove.pieno, path.basename(pieno));
  if (dest === pieno) return { ok: true, via: rel };
  if (dest.startsWith(pieno + path.sep)) throw new Error("non si sposta una cartella dentro se stessa");
  if (fs.existsSync(dest)) throw new Error("nella cartella c'e' gia' un file con questo nome");
  try { fs.renameSync(pieno, dest); } catch (e) { throw qnapErrore(e); }
  const nuovaRel = path.relative(QNAP_RADICE, dest).split(path.sep).join("/");
  qnapAggiornaIndice(rel, nuovaRel);
  return { ok: true, via: nuovaRel };
}
function qnapCartella(p) {
  qnapSoloQnap(p);
  const { pieno } = qnapDentro(p.via);
  const nome = qnapNomeBuono(p.nome);
  try { fs.mkdirSync(path.join(pieno, nome)); } catch (e) { throw qnapErrore(e); }
  return { ok: true };
}
// un file rinominato o spostato resta la stessa partita: l'indice e le
// registrazioni aperte seguono il nuovo nome, cosi' il MAM non lo perde
function qnapAggiornaIndice(vecchia, nuova) {
  let toccati = 0;
  const cambia = (o) => { if (o && o.chiave === vecchia) { o.chiave = nuova; toccati++; } if (o && o.chiave && o.chiave.startsWith(vecchia + "/")) { o.chiave = nuova + o.chiave.slice(vecchia.length); toccati++; } };
  Object.keys(ARCHIVIO || {}).forEach((rec) => { const a = ARCHIVIO[rec]; if (!a) return; cambia(a); (a.pezzi || []).forEach(cambia); });
  Object.keys(R.reg).forEach((k) => { const r = R.reg[k]; if (!r.arch) return; cambia(r.arch); (r.arch.pezzi || []).forEach(cambia); });
  if (toccati) { try { scriviArchivio(); } catch (e) {} scrivi(); console.log("[clip] magazzino: \"" + vecchia + "\" \u2192 \"" + nuova + "\" (" + toccati + " riferimenti aggiornati)"); }
}
// l'indirizzo firmato per vedere un file del magazzino dalla pagina
function qnapVia(p) {
  const { rel, radice } = qnapDentro(p.via, p.radice);
  const fino = Math.floor(Date.now() / 1000) + 21600;
  const chiave = radice.id + ":" + rel;
  return { ok: true, via: "/qnap/" + radice.id + "/" + rel.split("/").map(encodeURIComponent).join("/") + "?fino=" + fino + "&f=" + firmaPonte("qnap:" + chiave, fino, 0) };
}
function serviQnap(req, res, u) {
  const dopo = decodeURIComponent(u.pathname.slice("/qnap/".length));
  const radiceId = dopo.split("/")[0], rel = dopo.split("/").slice(1).join("/");
  const fino = parseInt(u.searchParams.get("fino") || "0", 10);
  if (!fino || fino < Math.floor(Date.now() / 1000) || (u.searchParams.get("f") || "") !== firmaPonte("qnap:" + radiceId + ":" + rel, fino, 0)) {
    res.writeHead(403).end("indirizzo scaduto"); return;
  }
  let pieno; try { pieno = qnapDentro(rel, radiceId).pieno; } catch (e) { res.writeHead(404).end("non trovato"); return; }
  // ?scarica=1: il file intero arriva sul computer col suo nome
  const extra = u.searchParams.get("scarica") ? { "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(pieno)) } : null;
  serviFileLocale(req, res, pieno, extra);
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
  try { sorgente = viaFileArchivio(r, pz[i]); } catch (e) { res.writeHead(502).end("magazzino non raggiungibile"); return; }
  // un magazzino di cartella da' un percorso: si serve il file, con gli
  // intervalli, senza passare da nessuna rete
  if (!/^https?:\/\//.test(sorgente)) return serviFileLocale(req, res, sorgente);
  const testa = {};
  if (req.headers.range) testa.Range = req.headers.range;
  try {
    // un HEAD resta un HEAD: con una GET si tirava giu' il file intero da S3
    // per rispondere a una domanda sulla lunghezza (3 GB buttati il 22/09/2026)
    const risp = await fetch(sorgente, { method: req.method === "HEAD" ? "HEAD" : "GET", headers: testa, signal: AbortSignal.timeout(30000) });
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
  if (ATTIVO && u.pathname.startsWith("/qnap/")) { serviQnap(req, res, u); return true; }
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
      const idc = /^([A-Za-z0-9-]+?)(?:_(16x9|3x4|9x16))?(?:\.(it|en))?\.(mp4|xml|srt)$/.exec(nome);
      const idSeq = idc ? (R.seq[idc[1]] ? idc[1] : (pezzi.length > 1 && R.seq[pezzi[pezzi.length - 2]] ? pezzi[pezzi.length - 2] : null)) : null;
      const coda = (idc && idc[3] ? "." + idc[3] : "") + (idc ? "." + idc[4] : "");
      if (idc && (idc[4] === "mp4" || idc[4] === "srt") && R.clip[idc[1]]) nome = nomeScarico(R.clip[idc[1]], R.reg[R.clip[idc[1]].reg]).replace(/\.mp4$/, coda);
      else if (idc && idSeq) {
        const q = R.seq[idSeq];
        nome = nomeScaricoSeq(q, R.reg[q.reg], idc[2] ? idc[2].replace("x", ":") : (idc[4] === "mp4" ? "16:9" : ""), coda);
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

// ══════════ I TITOLI ══════════
//  Per scrivere un nome sullo schermo si usciva dal montaggio, si faceva un
//  PNG da un'altra parte e lo si ricaricava: cioe' si apriva un altro
//  programma, che e' esattamente quello che vogliamo smettere di fare.
//  Un titolo qui e' una grafica come le altre — si trascina, si allunga dai
//  bordi, esce dall'export con lo stesso strato di overlay — solo che il
//  PNG lo disegna la macchina, nei font di Como TV, quando lo chiedi.
// LE GRAFICHE HANNO UNA VERSIONE PER FORMATO. Una grafica del Generatore
// nasce per un formato — la story 9:16 e' 1080x1920, il sottopancia 16:9
// e' 1920x1080 — e posata "contenuta" su un altro formato diventa una
// colonnina al centro o una striscia minuscola. Quindi ogni grafica puo'
// avere una versione per formato (g.varianti), e l'export usa quella
// giusta. Il formato di un PNG si riconosce dalla sua misura.
const TELA_FORMATO = { "16:9": [1920, 1080], "1:1": [1080, 1080], "3:4": [1080, 1440], "9:16": [1080, 1920] };
function formatoDiMisura(w, h) {
  const r = (+w || 16) / (+h || 9);
  let meglio = "16:9", scarto = 1e9;
  Object.keys(TELA_FORMATO).forEach((k) => {
    const t = TELA_FORMATO[k], d = Math.abs(Math.log(r / (t[0] / t[1])));
    if (d < scarto) { scarto = d; meglio = k; }
  });
  return meglio;
}
const STILI_TITOLO = {
  // [dove sta il blocco, quanto e' grande il titolo, quanto il sopratitolo]
  basso:  { x: 96,  y: 812, dim: 58, dim2: 26, fondo: 1 },
  centro: { x: 0,   y: 430, dim: 86, dim2: 32, fondo: 0, mezzo: 1 },
  angolo: { x: 72,  y: 72,  dim: 38, dim2: 20, fondo: 1 }
};
// Il titolo lo disegniamo noi, quindi non si adatta: si RIDISEGNA per il
// formato. La misura del testo resta quella (su un 1080 di larghezza e'
// anzi piu' leggibile), cambiano la tela e il posto: nei formati alti il
// titolo "in basso" sale al 70% dell'altezza, fuori dalla fascia che nei
// Reel e nei TikTok copre la didascalia e i pulsanti.
async function disegnaTitolo(via, testo, sopra, stile, colore, formato) {
  const st0 = STILI_TITOLO[stile] || STILI_TITOLO.basso;
  const tela = TELA_FORMATO[formato] || TELA_FORMATO["16:9"];
  const W = tela[0], H = tela[1], alto = H > W;
  const st = Object.assign({}, st0);
  if (W !== 1920 || H !== 1080) {
    if (stile === "centro") { st.y = Math.round(H / 2 - 110); }
    else if (stile === "angolo") { st.x = st.y = Math.round(Math.min(W, H) * 0.067); }
    else { st.x = Math.round(W * 0.05); st.y = alto ? Math.round(H * 0.70) : H - (1080 - st0.y); }
  }
  const f1 = via + ".t1.txt", f2 = via + ".t2.txt";
  fs.writeFileSync(f1, String(testo || "").slice(0, 120));
  if (sopra) fs.writeFileSync(f2, String(sopra).slice(0, 80));
  const fg = FONT_GROSSO.replace(/:/g, "\\:"), fm = FONT_MEDIO.replace(/:/g, "\\:");
  const oro = "0x" + String(colore || "C9A24B").replace(/[^0-9A-Fa-f]/g, "").slice(0, 6);
  const xT = st.mezzo ? "(w-text_w)/2" : String(st.x);
  // LA TELA DEVE ESSERE DAVVERO TRASPARENTE. "color=black@0.0" sembra
  // trasparente e non lo e': la sorgente color esce senza canale alfa e lo
  // zero se ne va prima del primo filtro. E drawbox scrive il colore ma NON
  // tocca l'alfa, quindi un rettangolo disegnato su una tela trasparente
  // resta invisibile. Il fondo si fa allora con una seconda sorgente, con la
  // sua opacita', sovrapposta alla tela: li' l'alfa arriva davvero.
  const ingressi = ["-f", "lavfi", "-i", "color=c=black:s=" + W + "x" + H + ":d=1"];
  let catena = "[0:v]format=rgba,colorchannelmixer=aa=0[tela];";
  let ultimo = "tela";
  if (st.fondo) {
    const altoB = st.dim + (sopra ? st.dim2 + 14 : 0) + 44;
    const bx = Math.max(0, st.x - 28), by = Math.max(0, st.y - (sopra ? st.dim2 + 30 : 22));
    const largoB = Math.min(1200, W - 2 * Math.max(0, st.x - 28));
    ingressi.push("-f", "lavfi", "-i", "color=c=0x040C1C:s=" + largoB + "x" + altoB + ":d=1");
    catena += "[1:v]format=rgba,colorchannelmixer=aa=0.66[fondo];" +
              "[" + ultimo + "][fondo]overlay=" + bx + ":" + by + ":format=auto[conFondo];";
    ultimo = "conFondo";
  }
  let testi = "";
  if (sopra) {
    testi += "drawtext=fontfile='" + fm + "':textfile='" + f2.replace(/:/g, "\\:") + "'" +
             ":fontsize=" + st.dim2 + ":fontcolor=" + oro + ":x=" + xT + ":y=" + (st.y - st.dim2 - 12) + ",";
  }
  testi += "drawtext=fontfile='" + fg + "':textfile='" + f1.replace(/:/g, "\\:") + "'" +
           ":fontsize=" + st.dim + ":fontcolor=0xF5F1E6:x=" + xT + ":y=" + st.y +
           ":shadowcolor=0x040C1C@0.85:shadowx=2:shadowy=2";
  catena += "[" + ultimo + "]" + testi + "[fuori]";
  await new Promise((si, no) => {
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(ingressi)
      .concat(["-filter_complex", catena, "-map", "[fuori]", "-frames:v", "1", "-y", via]),
      { timeout: 60000 },
      (e, so, se) => e ? no(new Error(ultimaRiga(String(se || e.message)) || "non sono riuscito a disegnare il titolo")) : si());
  });
  try { fs.unlinkSync(f1); } catch (e) {}
  try { fs.unlinkSync(f2); } catch (e) {}
  return { w: W, h: H };
}

// QUALE STRATO DI UNA GRAFICA, IN UN FORMATO. Lo usano l'export e il
// monitor, cosi' quello che si guarda e' quello che esce: la versione fatta
// per quel formato se c'e', il titolo ridisegnato nativo, altrimenti
// l'originale — segnato come adattato.
async function stratoPerFormato(g, formato) {
  const f = TELA_FORMATO[formato] ? formato : "16:9";
  if (g.titolo && f !== "16:9") {
    const nome = g.id + "-" + f.replace(":", "x") + ".png";
    const via = path.join(cartellaGrafiche(), nome);
    let fatto = false; try { fatto = fs.statSync(via).mtimeMs >= (g.quando || 0); } catch (e) {}
    if (!fatto) await disegnaTitolo(via, g.titolo.testo, g.titolo.sopra, g.titolo.stile, g.titolo.colore, f);
    const t = TELA_FORMATO[f];
    return { file: via, url: "/clip/" + CARTELLA_HL + "/_grafiche/" + nome, w: t[0], h: t[1], adattata: false };
  }
  const v = g.varianti && g.varianti[f];
  if (v) return { file: path.join(cartellaGrafiche(), v.id + ".png"), url: v.file, w: v.w, h: v.h, adattata: false };
  return { file: path.join(cartellaGrafiche(), g.id + ".png"), url: g.file, w: g.w, h: g.h,
           adattata: !g.titolo && formatoDiMisura(g.w, g.h) !== f };
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
      Object.keys(g.varianti || {}).forEach((f) => { try { fs.unlinkSync(path.join(cartellaGrafiche(), g.varianti[f].id + ".png")); } catch (e) {} });
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
    const var2 = {};
    Object.keys(g.varianti || {}).forEach((f) => {
      const v = g.varianti[f], idv = nuovoId("g");
      try { fs.copyFileSync(path.join(cartellaGrafiche(), v.id + ".png"), path.join(cartellaGrafiche(), idv + ".png")); } catch (e) { return; }
      var2[f] = Object.assign({}, v, { id: idv, file: "/clip/" + CARTELLA_HL + "/_grafiche/" + idv + ".png" });
    });
    const g2 = Object.assign({}, g, { id: id2, dentro: dove, varianti: var2,
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
  const wN = Math.round(num(p.w, 16, 4096, 1080)), hN = Math.round(num(p.h, 16, 4096, 1920));
  const fmt = formatoDiMisura(wN, hN);
  // LA VERSIONE DI UN'ALTRA GRAFICA. Con una grafica scelta in timeline, il
  // PNG che arriva ne diventa la versione nel suo formato: stessa grafica,
  // stesso posto, stessa durata — un file in piu'.
  if (p.variante) {
    const g0 = q.grafiche.filter((x) => x.id === String(p.variante))[0];
    if (!g0) throw new Error("la grafica scelta non c'e' piu'");
    if (formatoDiMisura(g0.w, g0.h) === fmt && !g0.titolo) {
      // e' lo stesso formato dell'originale: la si sostituisce
      fs.writeFileSync(path.join(cartellaGrafiche(), g0.id + ".png"), dati);
      g0.w = wN; g0.h = hN; g0.quando = Date.now();
    } else {
      g0.varianti = g0.varianti || {};
      const vecchia = g0.varianti[fmt];
      if (vecchia) { try { fs.unlinkSync(path.join(cartellaGrafiche(), vecchia.id + ".png")); } catch (e) {} }
      const idv = nuovoId("g");
      fs.writeFileSync(path.join(cartellaGrafiche(), idv + ".png"), dati);
      g0.varianti[fmt] = { id: idv, w: wN, h: hN, file: "/clip/" + CARTELLA_HL + "/_grafiche/" + idv + ".png" };
    }
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, grafica: g0, formato: fmt, variante: true };
  }
  const id = nuovoId("g");
  fs.writeFileSync(path.join(cartellaGrafiche(), id + ".png"), dati);
  const dentro = num(p.dentro, 0, Math.max(0, durataSeq), 0);
  const dur = num(p.durata, 0.5, 600, 5);
  const g = { id: id, dentro: dentro, fuori: Math.min(durataSeq || dentro + dur, dentro + dur),
              nome: String(p.nome || "grafica").slice(0, 120),
              w: wN, h: hN, formato: fmt,
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
    // una trascrizione in corso ha l'audio in quella cartella: portarla via
    // sotto a whisper e' buttare due ore di macchina (successo il 21/09 su
    // Udinese-Como, una partita d'archivio vecchia di tre giorni)
    if (voceAlLavoro && voceAlLavoro.reg === r.id) return;
    if (fs.existsSync(path.join(cartellaReg(r.id), "voce.corso.json"))) return;
    // una partita d'archivio non ha materiale qui: nella cartella ci sono
    // solo i file della voce, che pesano poco e servono ancora
    if (r.arch) return;
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

// ═══════════════════════════════════════════════════════════════════
//  CANTO — le foto di Mola dentro la nostra ricerca
// ═══════════════════════════════════════════════════════════════════
//
//  Il portale sta su mola.canto.global e parla OAuth 2.0 con credenziali
//  d'applicazione: un identificativo e un segreto che un amministratore del
//  portale crea una volta. Qui dentro non ci sono, e non ci devono essere:
//  si leggono dall'ambiente, come la chiave di Airtable.
//
//      COMOTV_CANTO_ID        l'identificativo dell'applicazione
//      COMOTV_CANTO_SEGRETO   il segreto
//      COMOTV_CANTO_DOMINIO   mola.canto.global
//
//  Il disegno e' lo stesso dell'archivio S3: prima si porta a casa SOLO
//  l'elenco — nome, album, tag, data, misure — che pesa pochi mega e si
//  cerca in casa; le anteprime si tengono in cache; l'originale si scarica
//  soltanto quando qualcuno lo chiede davvero.
const CANTO = {
  id: process.env.COMOTV_CANTO_ID || "",
  segreto: process.env.COMOTV_CANTO_SEGRETO || "",
  dominio: (process.env.COMOTV_CANTO_DOMINIO || "mola.canto.global").replace(/^https?:\/\//, "").replace(/\/+$/, "")
};
const CANTO_TOKEN_URL = "https://oauth.canto.global/oauth/api/oauth2/compatible/token";
function cantoAcceso() { return !!(CANTO.id && CANTO.segreto && CANTO.dominio); }
let cantoGettone = { valore: "", scade: 0 };

function cantoChiediHttps(url, opzioni, corpo) {
  return new Promise((si, no) => {
    const req = https.request(url, opzioni, (res) => {
      let t = "";
      res.on("data", (d) => { t += d; });
      res.on("end", () => si({ stato: res.statusCode, testo: t }));
    });
    req.on("error", (e) => no(new Error("Canto non raggiungibile: " + e.message)));
    req.setTimeout(30000, () => { req.destroy(); no(new Error("Canto non risponde")); });
    if (corpo) req.write(corpo);
    req.end();
  });
}

// il gettone dura un po': si tiene finche' vale, e si rifa' da solo
async function cantoGettoneValido() {
  if (!cantoAcceso()) throw new Error("mancano le credenziali di Canto sul ponte (COMOTV_CANTO_ID e COMOTV_CANTO_SEGRETO)");
  if (cantoGettone.valore && Date.now() < cantoGettone.scade - 60000) return cantoGettone.valore;
  const corpo = new URLSearchParams({
    grant_type: "client_credentials", app_id: CANTO.id, app_secret: CANTO.segreto, scope: "admin"
  }).toString();
  const r = await cantoChiediHttps(CANTO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(corpo) }
  }, corpo);
  if (r.stato !== 200) throw new Error("Canto non da' il gettone (" + r.stato + "): " + r.testo.slice(0, 160));
  let j; try { j = JSON.parse(r.testo); } catch (e) { throw new Error("il gettone di Canto e' illeggibile"); }
  if (!j.accessToken && !j.access_token) throw new Error("nella risposta di Canto non c'e' nessun gettone: " + r.testo.slice(0, 160));
  cantoGettone = { valore: j.accessToken || j.access_token,
                   scade: Date.now() + (Number(j.expiresIn || j.expires_in || 1800) * 1000) };
  return cantoGettone.valore;
}

async function cantoChiedi(via, cerca) {
  const tok = await cantoGettoneValido();
  const q = cerca ? "?" + new URLSearchParams(cerca).toString() : "";
  const url = "https://" + CANTO.dominio + "/api/v1/" + String(via).replace(/^\/+/, "") + q;
  const r = await cantoChiediHttps(url, { method: "GET", headers: { Authorization: "Bearer " + tok } });
  if (r.stato !== 200) throw new Error("Canto risponde " + r.stato + " su /" + via + ": " + r.testo.slice(0, 160));
  try { return JSON.parse(r.testo); } catch (e) { throw new Error("Canto ha risposto qualcosa che non e' JSON"); }
}

// LA SONDA. Al primo accesso non si sa come sono fatti i campi di questo
// portale: invece di indovinarli, si chiede una manciata di asset e si
// riferisce quali nomi ci sono dentro. Da li' si scrive la mappatura vera.
async function cantoProva() {
  const fuori = { ok: true, dominio: CANTO.dominio, credenziali: cantoAcceso() };
  if (!cantoAcceso()) { fuori.ok = false; fuori.errore = "mancano COMOTV_CANTO_ID e COMOTV_CANTO_SEGRETO"; return fuori; }
  await cantoGettoneValido();
  fuori.gettone = "preso";
  const prove = [["search", { limit: "5" }], ["album", { limit: "5" }], ["tree", {}]];
  fuori.risposte = {};
  for (const [via, cerca] of prove) {
    try {
      const j = await cantoChiedi(via, cerca);
      const primo = Array.isArray(j) ? j[0] : (j.results && j.results[0]) || (j.found !== undefined ? j : j);
      fuori.risposte[via] = {
        chiaviInAlto: Object.keys(j || {}).slice(0, 12),
        quanti: j && (j.found !== undefined ? j.found : (Array.isArray(j.results) ? j.results.length : undefined)),
        campiDiUnAsset: primo && typeof primo === "object" ? Object.keys(primo).slice(0, 30) : null,
        assaggio: JSON.stringify(primo || j).slice(0, 700)
      };
    } catch (e) { fuori.risposte[via] = { errore: String(e.message).slice(0, 200) }; }
  }
  return fuori;
}

// ── LA DOMANDA SCRITTA A PAROLE ───────────────────────────────────────
//  "tutti i gol di Douvikas" si spezza in due: i TIPI (gol) e le PAROLE
//  (douvikas). I tipi si cercano in tipo ed etichetta, che il titolo
//  l'hanno gia' classificato; le parole nel testo. Stava dentro la ricerca:
//  adesso lo usa anche chi monta da una ricetta, cosi' la stessa domanda da'
//  le stesse azioni in tutti e due i posti.
const FERMA_DOMANDA = new Set("tutti tutte tutto i il lo la le gli di del della dello dei degli delle da dal dalla a al alla ai alle in nel nella con per e ed o che un una uno su sul sulla mi fammi trova cerca vedere vedi".split(" "));
const TIPI_DOMANDA = [
    [/^(gol|goal|goals|rete|reti|marcatur\w*|segna\w*|marc\w+)$/, /\b(gol|goal|rete|autogol)\b/i],
    [/^(assist)$/, /\bassist/i],
    [/^(rigor\w*|penalty|dischetto)$/, /\brigor|\bpenalty/i],
    [/^(parat\w*|miracol\w*|portier\w*)$/, /\bparat/i],
    [/^(pal[oi]|travers\w*|legn\w*)$/, /\b(palo|pali|traversa)\b/i],
    [/^(ammoni\w*|giall\w*|cartellin\w*|booking)$/, /\b(ammoni|cartellin|giall)/i],
    [/^(espuls\w*|ross[oi])$/, /\bespuls|\brosso\b/i],
    [/^(cambi\w*|sostituz\w*)$/, /\bsostituz|\bcambio\b/i],
    [/^(occasion\w*|tir[oi]|conclusion\w*|chance)$/, /\boccasion|\btiro\b/i],
    [/^(skill|dribbling|giocat[ae]|tunnel|tacco)$/, /\bskill/i],
    [/^(var|annullat\w*)$/, /\bannullat|\bvar\b/i],
    [/^(boat\w*|esultanz\w*)$/, /\bboato|\besult/i],
    [/^(angol[oi]|corner)$/, /\b(angolo|corner)\b/i],
    [/^(punizion\w*)$/, /\bpunizion/i]
  ];
function chiaviDellaDomanda(q) {
  const tipi = [], parole = [];
  String(q || "").toLowerCase().split(/\s+/).forEach((w0) => {
    const w = piattaMinuscola(w0); if (!w || FERMA_DOMANDA.has(w)) return;
    const t = TIPI_DOMANDA.find((x) => x[0].test(w)); if (t) tipi.push(t[1]); else parole.push(w);
  });
  return { tipi, parole };
}
// ── CHI HA FATTO COSA ─────────────────────────────────────────────────
//  "assist Nico Paz": gli appunti scrivono "GOL Perrone! ... assist di Nico
//  Paz" e la riga e' un Gol, ma per chi cerca Nico Paz e' un ASSIST
//  (Goffredo, 26/09/2026). ESPN lo sa gia': negli eventi chiave il secondo
//  "participant" di un gol e' l'assistman, nella cronaca c'e' "Assisted by".
//  Quindi per ogni partita le GIOCATE ESPN — chi segna, chi fa l'assist, chi
//  tira, chi para — e ogni riga (appunti compresi) si aggancia alla giocata
//  del suo minuto. Il testo degli appunti si legge solo dove ESPN non c'e'
//  (giovanili, femminile).
function nomeParole(n) { return String(n || "").split(/[\s\-']+/).map(piattaMinuscola).filter(Boolean); }
function eLui(nome, chi) {
  if (!nome || !chi.length) return false;
  const w = nomeParole(nome);
  return chi.every((p) => w.some((x) => x === p || (p.length >= 4 && x.indexOf(p) === 0)));
}
function assistDalTesto(t) { const m = /Assisted by ([^.]+?)(?:\s+(?:with|following)\b|\.|$)/.exec(String(t || "")); return m ? m[1].trim() : ""; }
function giocateEspn(rec) {
  const e = ESPN[rec]; if (!e || (!e.eventi && !e.gamecast)) return [];
  const g = [];
  const metti = (f) => {
    // lo stesso gol dagli eventi chiave e dalla cronaca: uno solo, con tutto quello che sa ciascuno
    const d = g.find((x) => x.tipo === f.tipo && x.per === f.per && Math.abs(x.min - f.min) <= 1 && x.autore && f.autore && eLui(x.autore, nomeParole(f.autore).slice(-1)));
    if (d) { d.assist = d.assist || f.assist; d.parataDa = d.parataDa || f.parataDa; return; }
    g.push(f);
  };
  (e.eventi || []).forEach((x) => {
    const t = String(x.tipo || ""); let tipo = "";
    if (/own goal/i.test(t)) tipo = "autogol";
    else if (/penalty - (saved|missed|hit)/i.test(t)) tipo = "rigore sbagliato";
    else if (/goal|penalty - scored/i.test(t) && !/disallow|cancel|no goal/i.test(t)) tipo = "gol";
    else if (/yellow/i.test(t)) tipo = "giallo";
    else if (/red card/i.test(t)) tipo = "rosso";
    if (!tipo) return;
    metti({ tipo, per: x.periodo || 1, min: (x.min || 0) + (x.stopp || 0), autore: x.giocatore || "", assist: x.assist || assistDalTesto(x.lungo), parataDa: "" });
  });
  (e.gamecast || []).forEach((x) => {
    const t = String(x.testo || ""); let tipo = "";
    if (x.tipo === "Gol") tipo = /own goal/i.test(t) ? "autogol" : "gol";
    else if (x.tipo === "Occasione") tipo = "tiro";
    else if (x.tipo === "Parata") tipo = "tiro parato";
    else if (x.tipo === "Palo") tipo = "palo";
    else if (x.tipo === "Rigore") tipo = "rigore sbagliato";
    else if (x.tipo === "Ammonizione") tipo = "giallo";
    else if (x.tipo === "Espulsione") tipo = "rosso";
    if (!tipo) return;
    const pd = /saved[^.]*? by ([^(.]+?) \(/.exec(t);
    metti({ tipo, per: x.periodo || 1, min: (x.min || 0) + (x.stopp || 0), autore: x.giocatore || "", assist: assistDalTesto(t), parataDa: pd ? pd[1].trim() : "" });
  });
  return g;
}
// il ruolo di chi si cerca in una giocata
function ruoloIn(f, chi) {
  if (eLui(f.autore, chi)) return f.tipo;
  if (eLui(f.assist, chi)) return f.tipo === "gol" ? "assist" : "passaggio chiave";
  if (eLui(f.parataDa, chi)) return /rigore/.test(f.tipo) ? "rigore parato" : "parata";
  return "";
}
function minutoRiga(x) {
  const m = /(\d+)(?:\s*\+\s*(\d+))?/.exec(String(x.minuto || "")); if (!m) return null;
  const min = +m[1], st = m[2] ? +m[2] : 0;
  return { per: (min > 45 || (min === 45 && !st && x.periodo === 2)) ? 2 : 1, min: min + st };
}
// Senza ESPN: il testo intorno al nome. "assist/lancio/cross ... di Nico Paz"
// e' un assist; il nome subito dopo "GOL" e' il marcatore.
const CUE_ASSIST = /(assist|assit|asssit|asist|passaggio|lancio|verticalizzazione|cross|traversone|imbucata|suggerimento|sponda|filtrante|invito|servizio)\s+(?:\S+\s+){0,2}?(?:di|da|del|dello|della)\s+(?:\S+\s+)?$/;
function ruoloDalTesto(x, chi) {
  const t = senzaAccenti(String(x.titolo || "") + " · " + String(x.dettaglio || "")).toLowerCase().replace(/\s+/g, " ");
  const tipo = senzaAccenti(String(x.tipo || "") + " " + String(x.tag || "")).toLowerCase();
  const i = t.indexOf(chi[chi.length - 1]); if (i < 0) return "";
  const prima = t.slice(Math.max(0, i - 60), i), dopo = t.slice(i, i + 90);
  if (CUE_ASSIST.test(prima) || /\b(il suo tiro diventa un assist|assist per)\b/.test(dopo)) return x.gol || /gol|rete/.test(tipo) ? "assist" : "passaggio chiave";
  if (/rigore (sbagliat|parat)|sbaglia (il )?rigore/.test(tipo + " " + t)) return "rigore sbagliato";
  if (x.gol || /\b(gol|goal|rete)\b/.test(tipo)) return /(gol|goal|rete)[^.!?;]{0,40}$/.test(prima) || /^\S+\s+(segna|insacca|risolve|punisce|batte|firma|sblocca|raddoppia)/.test(dopo) ? "gol" : "nel gol";
  if (/espuls|rosso/.test(tipo)) return "rosso";
  if (/ammoni|giall/.test(tipo)) return "giallo";
  if (/palo|traversa/.test(tipo)) return "palo";
  if (/parat/.test(tipo)) return /(parata di|respinge|salva)\s*$/.test(prima) ? "parata" : "tiro parato";
  if (/occasion|tiro/.test(tipo)) return "tiro";
  return "";
}
// il tipo della riga, per agganciarla solo a giocate dello stesso tipo: un
// cambio al 45' non e' il gol di Nico Paz al 45'+2. Prima il tipo scritto
// (una parata a dieci secondi da un gol ha gol:true, ma resta una parata)
function categoriaRiga(x) {
  const t = senzaAccenti(String(x.tipo || "") + " " + String(x.tag || "")).toLowerCase();
  if (/sostituz|cambio/.test(t)) return "cambio";
  if (/espuls|rosso|red card/.test(t)) return "rosso";
  if (/ammoni|giallo|yellow/.test(t)) return "giallo";
  if (/rigore|penalty/.test(t) && !/\b(gol|goal)\b/.test(t)) return "rigore";
  if (/palo|traversa/.test(t)) return "palo";
  if (/parat/.test(t)) return "parata";
  if (/occasion|tiro|chance/.test(t)) return "tiro";
  if (/\b(gol|goal|rete|autogol)\b/.test(t)) return "gol";
  if (x.gol && /^\W*(gol|goal)\b/i.test(String(x.titolo || ""))) return "gol";
  return "";
}
const GIOCATE_COMPATIBILI = { gol: ["gol", "autogol"], giallo: ["giallo"], rosso: ["rosso"], palo: ["palo"],
  parata: ["tiro parato", "rigore sbagliato"], tiro: ["tiro", "tiro parato", "palo"], rigore: ["rigore sbagliato", "gol"], cambio: [] };
// il ruolo di chi si cerca in questa riga: prima ESPN, poi il testo
function ruoloDi(x, rec, chi, giocate) {
  if (!chi.length) return { ruolo: "", da: "" };
  const m = minutoRiga(x), cat = categoriaRiga(x);
  const parole = new Set(nomeParole([x.titolo, x.giocatore, x.dettaglio].join(" ")));
  const nomina = (n) => { const w = nomeParole(n); return !!w.length && parole.has(w[w.length - 1]); };
  const nominaChi = chi.every((w) => parole.has(w) || Array.from(parole).some((p) => w.length >= 4 && p.indexOf(w) === 0));
  if (giocate.length && m && cat !== "cambio") {
    const ok = cat ? GIOCATE_COMPATIBILI[cat] : null;
    const vicine = giocate.filter((f) => f.per === m.per && Math.abs(f.min - m.min) <= (cat === "gol" ? 3 : 2) &&
                                         (ok ? ok.indexOf(f.tipo) >= 0 : f.tipo !== "gol" && f.tipo !== "autogol"));
    // la giocata di chi la riga nomina, se no la piu' vicina
    const peso = (f) => (nomina(f.autore) || nomina(f.assist) || nomina(f.parataDa) ? 0 : 10) + Math.abs(f.min - m.min);
    vicine.sort((u, v) => peso(u) - peso(v));
    // una riga senza tipo si aggancia solo se nomina chi si cerca
    const f = (ok || nominaChi) ? vicine[0] : null;
    if (f) { const r = ruoloIn(f, chi); if (r) return { ruolo: r, da: "espn" }; }
  }
  if (!nominaChi) return { ruolo: "", da: "" };
  const r = ruoloDalTesto(x, chi);
  return { ruolo: r, da: r ? "testo" : "" };
}
// LA SCHEDA DEL GIOCATORE: le sue giocate ESPN nelle partite dell'archivio,
// una volta per gara (ITA, ENG e AUDIO sono la stessa partita)
function schedaGiocatore(parole, cache) {
  if (!cache.parolesquadre) {
    const w = new Set();
    Object.keys(ESPN).forEach((rec) => { ((ESPN[rec] || {}).squadre || []).forEach((n) => nomeParole(n).forEach((x) => w.add(x))); });
    cache.parolesquadre = w;
  }
  const chi = parole.filter((x) => !cache.parolesquadre.has(x));
  if (!chi.length) return null;
  const visti = new Set(), conta = {}, nomi = {}, partite = new Set();
  let conCronaca = 0, gare = 0;
  Object.keys(ARCHIVIO).forEach((rec) => {
    const e = ESPN[rec]; if (!e || !e.id || visti.has(e.id)) return; visti.add(e.id);
    gare++; if (e.gamecast && e.gamecast.length) conCronaca++;
    const gc = cache.giocate || (cache.giocate = {});
    (gc[rec] || (gc[rec] = giocateEspn(rec))).forEach((f) => {
      const r = ruoloIn(f, chi); if (!r) return;
      conta[r] = (conta[r] || 0) + 1; partite.add(e.id);
      const n = eLui(f.autore, chi) ? f.autore : eLui(f.assist, chi) ? f.assist : f.parataDa;
      nomi[n] = (nomi[n] || 0) + 1;
    });
  });
  if (!partite.size) return null;
  const nome = Object.keys(nomi).sort((a, b) => nomi[b] - nomi[a])[0];
  return { nome, chi, conta, partite: partite.size, gare, conCronaca };
}
// come la domanda chiama ogni ruolo: "gol" vuole i SUOI gol, "assist" i suoi assist
const RUOLO_PAROLE = { "gol": "gol", "assist": "assist", "autogol": "autogol", "rigore sbagliato": "rigore sbagliato", "rigore parato": "rigore parata",
  "parata": "parata", "tiro parato": "tiro occasione", "tiro": "tiro occasione", "passaggio chiave": "occasione", "palo": "palo", "giallo": "ammonizione giallo",
  "rosso": "espulsione rosso", "nel gol": "" };
function combaciaRiga(x, titoloPartita, tipi, parole) {
  const soggetto = [x.tipo, x.tag].join(" ") || x.titolo;
  if (tipi.length && !tipi.every((re) => re.test(soggetto))) return false;
  const testo = piattaMinuscola([x.titolo, x.giocatore, x.squadra, x.dettaglio, titoloPartita].join(" "));
  return parole.every((w) => testo.indexOf(w) >= 0);
}

const AZIONI = {
  "clip-canto-prova": cantoProva,
  "clip-avvia": clipAvvia,
  "clip-ferma": clipFerma,
  "clip-rinomina": clipRinomina,
  "clip-stato": clipStato,
  "clip-taglia": clipTaglia,
  "clip-marker": clipMarker,
  "clip-kickoff": clipKickoff,
  "clip-elimina": clipElimina,
  "clip-boati": cercaBoati,
  "clip-significato": (p) => {
    // capire trentamila righe sono dieci minuti: si comincia e si risponde
    // subito, lo stato si chiede quando si vuole
    if (p.avvia && !SIGN.inCorso) capisciRighe(num(p.quante, 1, 40000, 0) || 0).catch(() => {});
    return { ok: true, avviato: !!p.avvia, stato: statoSignificato() };
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
  "clip-vocabolario": async (p) => {
    if (p.rifai) costruisciVocabolario();
    if (p.correggi) {
      const r = R.reg[String(p.reg || "")] || { evento: String(p.rec || ""), titolo: String(p.titolo || "") };
      const a0 = applicaAlias(String(p.correggi), r);
      return Object.assign({ ok: true, alias: { considerati: a0.considerati, inCampo: a0.inCampo, totali: Object.keys(ALIAS.voci).length } }, correggiConIlVocabolario(String(p.correggi), r));
    }
    // una frase di prova: com'e' tradotta coi nomi coperti, e senza
    if (p.prova) {
      const r = R.reg[String(p.reg || "")] || { evento: String(p.rec || ""), titolo: String(p.titolo || "") };
      const da = String(p.da || "it"), a = String(p.a || (da === "it" ? "en" : "it"));
      const coperta = coprendoINomi(String(p.prova), r);
      const [conNomi, nuda] = await Promise.all([traduciConINomi([String(p.prova)], da, a, r), traduci([String(p.prova)], da, a)]);
      return { ok: true, coperta: coperta.coperto, nomi: coperta.messi, conNomi: conNomi && conNomi[0], nuda: nuda && nuda[0] };
    }
    if (p.reg || p.rec || p.titolo) {
      const r = R.reg[String(p.reg || "")] || { evento: String(p.rec || ""), titolo: String(p.titolo || "") };
      return { ok: true, partita: vocabolarioDi(r), prompt: promptPer(r, p.lingua), quando: VOCABOLARIO.quando };
    }
    if (p.squadra) return { ok: true, squadra: p.squadra, voce: VOCABOLARIO.squadre[squadraNelVocabolario(p.squadra) || p.squadra] || null };
    return { ok: true, quando: VOCABOLARIO.quando, conteggio: VOCABOLARIO.conteggio || {},
             leghe: VOCABOLARIO.leghe, squadre: Object.keys(VOCABOLARIO.squadre).length,
             termini: { it: TERMINI_IT.length, en: TERMINI_EN.length } };
  },
  "clip-sottotitoli": (p) => {
    const r = R.reg[String(p.id || p.reg || "")];
    if (!r) return { ok: false, errore: "registrazione sconosciuta" };
    if (r.stato !== "registra") return { ok: false, errore: "i sottotitoli si accendono su una porta aperta" };
    if (!fs.existsSync(MODELLO_VIVO)) return { ok: false, errore: "manca il modello whisper per il vivo (" + MODELLO_VIVO + ")" };
    // cambiare lingua mentre sono accesi: senza spegnere e riaccendere
    if (p.on === undefined && p.mostra && r.sottotitoli && r.sottotitoli.acceso) {
      r.sottotitoli.mostra = ["it", "en"].indexOf(String(p.mostra)) >= 0 ? String(p.mostra) : r.sottotitoli.mostra;
      scrivi(); annuncia(0, "clip"); return { ok: true, reg: pubblica(r) };
    }
    if (p.on) sottotitoliAccendi(r, p.lingua, p.mostra); else sottotitoliSpegni(r);
    return { ok: true, reg: pubblica(r) };
  },
  // le righe dette dal vivo dopo un certo secondo: la pagina le chiede ogni
  // due secondi e mostra l'ultima
  // LA TELECRONACA TRADOTTA, ANCHE IN ARCHIVIO. Le righe di una partita gia'
  // trascritta si traducono tutte nella lingua chiesta — in sottofondo, a
  // pacchetti, coi nomi coperti — e restano scritte accanto all'originale.
  // La pagina chiede, poi guarda l'avanzamento ogni due secondi.
  "clip-parlato-traduci": (p) => {
    const reg = String(p.reg || ""), a = ["it", "en"].indexOf(String(p.a || "")) >= 0 ? String(p.a) : "en";
    const d = PARLATO[reg];
    if (!d || !(d.pezzi || []).length) return { ok: false, errore: "questa registrazione non ha ancora una telecronaca trascritta" };
    const r = R.reg[reg] || { evento: (R.reg[reg] || {}).evento || "" };
    const da = d.lingua || LINGUA_MAM;
    const mancano = d.pezzi.filter((x) => (x.l || da) !== a && (!x.y || x.ya !== a));
    const stato = TRADUZIONI.get(reg) || { fatte: 0, totale: 0, inCorso: false, verso: a };
    if (da === a) return { ok: true, giaNellaLingua: true, fatte: d.pezzi.length, totale: d.pezzi.length, verso: a };
    if (!stato.inCorso && mancano.length) {
      stato.inCorso = true; stato.fatte = 0; stato.totale = mancano.length; stato.verso = a; TRADUZIONI.set(reg, stato);
      (async () => {
        try {
          for (let i = 0; i < mancano.length; i += 12) {
            const lotto = mancano.slice(i, i + 12);
            // per strada si sistemano anche numeri e nomi, come dal vivo
            lotto.forEach((x) => { if (!x.m) x.x = correggiConIlVocabolario(numeriNelTesto(x.x, da), r).testo; });
            const tr = await traduciConINomi(lotto.map((x) => x.x), da, a, r);
            lotto.forEach((x, k) => { x.y = tr ? tr[k] : ""; x.ya = a; x.l = x.l || da; });
            stato.fatte = Math.min(mancano.length, i + lotto.length);
            if (i % 60 === 0) scriviParlato();
          }
        } catch (e) { console.log("[clip] traduzione (" + reg + "): " + e.message); }
        scriviParlato(); stato.inCorso = false;
      })();
    }
    return { ok: true, fatte: stato.inCorso ? stato.fatte : d.pezzi.length - mancano.length + stato.fatte, totale: d.pezzi.length,
             inCorso: stato.inCorso, verso: a, lingua: da };
  },
  "clip-parlato-vivo": (p) => {
    const d = PARLATO[String(p.reg || "")];
    const da = +p.da || 0;
    const pezzi = ((d && d.pezzi) || []).filter((x) => x.vivo && x.a > da);
    return { ok: true, pezzi: pezzi.slice(-30), lingua: (VIVI.get(String(p.reg || "")) || {}).lingua || "" };
  },
  "clip-parlato": (p) => {
    const d = PARLATO[String(p.reg || "")];
    // ogni riga porta una chiave sua: e' con quella che la pagina la
    // corregge, e resta la stessa anche se le righe intorno cambiano
    if (d && (d.pezzi || []).some((x) => !x.k)) { d.pezzi.forEach((x) => { if (!x.k) x.k = nuovoId("s"); }); scriviParlato(); }
    return { ok: true, pezzi: (d && d.pezzi) || [], spenta: voceSpenta,
             inCorso: !!(voceAlLavoro && voceAlLavoro.reg === p.reg),
             inCoda: CODA_VOCE.filter((x) => x.reg === p.reg).length,
             motore: whisperCe() };
  },
  // LA TELECRONACA COME FILE SRT: una riga per pezzo, tempi contati dal
  // primo fotogramma del file (come li vede Premiere quando importa lo
  // stesso file dalla QNAP), testo nella lingua chiesta se c'e' la
  // traduzione, altrimenti quello detto. Righe lunghe spezzate in due.
  // LA TRACCIA SI CORREGGE A MANO, come in Premiere: si entra nella riga,
  // si cambia il testo (nella lingua parlata o nella traduzione), i tempi,
  // se ne aggiunge una o se ne toglie una. La riga corretta porta il segno
  // m: una ritrascrizione non la sovrascrive, la traduzione automatica
  // non la ritocca, e ogni export — srt, impressi, telecronaca intera —
  // esce gia' corretto.
  "clip-parlato-modifica": (p) => {
    const reg = String(p.reg || ""), d = PARLATO[reg];
    if (!d) throw new Error("questa registrazione non ha una telecronaca");
    d.pezzi = d.pezzi || [];
    const propria = d.lingua || LINGUA_MAM;
    let x = null;
    if (p.nuova) {
      const a = Math.max(0, +p.a || 0), b = +p.b > a ? +p.b : a + 3;
      x = { k: nuovoId("s"), a: Math.round(a * 10) / 10, b: Math.round(b * 10) / 10, x: "", l: ["it", "en"].indexOf(String(p.l || "")) >= 0 ? String(p.l) : propria, m: true };
      d.pezzi.push(x);
    } else {
      x = d.pezzi.find((z) => z.k && z.k === String(p.k || ""));
      if (!x) throw new Error("riga non trovata: ricarica la telecronaca");
    }
    if (p.cancella) {
      d.pezzi = d.pezzi.filter((z) => z !== x);
      scriviParlato(); return { ok: true, tolta: x.k };
    }
    const sua = x.l || propria, altra = sua === "it" ? "en" : "it";
    const pulisci = (t) => String(t || "").replace(/\s+/g, " ").trim();
    const yDato = p.y !== undefined ? pulisci(p.y) : null, yVecchio = x.y || "";
    if (p.x !== undefined && pulisci(p.x) !== (x.x || "")) {
      x.x = pulisci(p.x);
      // cambiato il parlato, la traduzione automatica di prima non vale
      // piu': si toglie e si rifa' da sola (se non e' stata scritta a mano)
      if (yDato === null || yDato === yVecchio) { delete x.y; delete x.ya; }
    }
    if (yDato !== null && yDato !== yVecchio) { x.y = yDato; if (x.y) x.ya = altra; else { delete x.y; delete x.ya; } }
    if (p.a !== undefined || p.b !== undefined) {
      const a = p.a !== undefined ? Math.max(0, +p.a || 0) : x.a;
      const b = p.b !== undefined ? +p.b : x.b;
      if (!(b > a)) throw new Error("l'uscita deve venire dopo l'entrata");
      x.a = Math.round(a * 100) / 100; x.b = Math.round(b * 100) / 100;
    }
    x.l = sua; x.m = true;
    if (!x.x && !x.y) { d.pezzi = d.pezzi.filter((z) => z !== x); scriviParlato(); return { ok: true, tolta: x.k }; }
    d.pezzi.sort((u, v) => u.a - v.a);
    scriviParlato();
    return { ok: true, pezzo: x };
  },
  // UN SRT CHE ARRIVA DA FUORI (Premiere, un traduttore, Manolo) diventa
  // la telecronaca della registrazione: numeri e timecode come sono, il
  // testo come e', righe segnate "a mano" cosi' nessun automatismo le
  // tocca. Con "sostituisci" si butta quello che c'era; se no si tiene il
  // resto e si rimpiazzano solo le righe che cadono nello stesso tratto.
  "clip-qnap-elenco": qnapElenco,
  "clip-qnap-rinomina": qnapRinomina,
  "clip-qnap-sposta": qnapSposta,
  "clip-qnap-cartella": qnapCartella,
  "clip-qnap-via": qnapVia,
  // GLI EVENTI COMPLETI: tutti i video della QNAP, anche nelle sottocartelle,
  // con la partita se l'archivio la conosce. E' la lista su cui si cerca.
  // UNA PARTITA E' "PUNTATA" quando il cronometro e' stato letto (o
  // dichiarato illeggibile, che e' comunque una risposta) e il giro del
  // boato e' passato: da quel momento un appunto scritto al 23' cade sul
  // 23' vero, e cercarci dentro serve a qualcosa. Prima non lo si poteva
  // chiedere: in Libreria le partite pronte stavano in mezzo a quelle
  // ancora da raddrizzare, e si aprivano a caso.
  "clip-qnap-eventi": (p) => {
    const partite = qnapPartite();
    const regs = Object.keys(R.reg).map((k) => R.reg[k]).filter((x) => x.arch);
    const fuori = []; let contati = 0;
    const giro = (rel, prof) => {
      let voci; try { voci = fs.readdirSync(path.join(QNAP_RADICE, rel), { withFileTypes: true }); } catch (e) { return; }
      for (const d of voci) {
        if (QNAP_NASCOSTI.test(d.name)) continue;
        // la copia delle partite S3 non fa voci sue: sarebbero doppioni (e una
        // partita in due file, due voci). Quelle partite restano la riga S3,
        // segnata "in casa" qui sotto.
        if (!rel && d.name === SPECCHIO_DIR) continue;
        if (++contati > 5000) return;
        const relSuo = rel ? rel + "/" + d.name : d.name;
        if (d.isDirectory()) { if (prof < 4) giro(relSuo, prof + 1); continue; }
        const est = path.extname(d.name).slice(1).toLowerCase();
        if (!/^(mp4|mov|mxf|mkv|ts|m4v)$/.test(est)) continue;
        let st; try { st = fs.statSync(path.join(QNAP_RADICE, relSuo)); } catch (e) { continue; }
        const v = { nome: d.name, via: relSuo, cartella: rel, peso: st.size, quando: st.mtimeMs, est };
        const pa = partite[relSuo]; if (pa) { v.rec = pa.rec; v.partita = pa.partita; }
        const r = regs.find((x) => x.arch.chiave === relSuo || (x.arch.pezzi || []).some((z) => z.chiave === relSuo));
        if (r) { v.reg = r.id; v.partita = v.partita || r.titolo; v.durata = r.durata || 0; if (!v.rec && r.arch.rec) v.rec = r.arch.rec; v.telecronaca = !!(PARLATO[r.id] && (PARLATO[r.id].pezzi || []).length); }
        const a = v.rec && ARCHIVIO[v.rec]; if (a) { v.quandoPartita = a.quando || a.data || ""; v.competizione = a.competizione || "";
          v.squadre = squadreConStemma(v.rec, a); v.voce = voceDi(v.rec, a); v.ris = risultatoDi(a); v.studio = studioDi(v.rec, a) || specialeDi(v.rec, a); v.titolo = titoloDi(a); v.eventi = loghiEvento(a); v.compVista = competizioneVista(a, v.rec); if (!v.durata && a.pezzi) v.durata = (a.pezzi.reduce((n, z) => n + (z.minuti || 0), 0)) * 60; v.puntata = puntata(a); }
        fuori.push(v);
      }
    };
    giro("", 0);
    // e le partite che stanno solo su S3: si vedono, si cercano, ma i byte
    // non si leggono finche' non c'e' la chiave
    let suS3 = 0;
    Object.keys(ARCHIVIO).forEach((k) => {
      const a = ARCHIVIO[k];
      // tutte le partite che stanno in un magazzino di solo elenco: quelle
      // appaiate ad Airtable (rec…) e quelle ancora senza nome (s3:…)
      if (!a.chiave || !magazzinoInventario(a.bucket)) return;
      const minuti = (a.pezzi || []).reduce((n, z) => n + (z.minuti || 0), 0);
      // la registrazione di QUESTO file: una aperta quando la riga puntava un
      // altro file (prima dell'abbinamento unico) non e' sua
      const r = regs.find((x) => x.arch && x.arch.rec === k && x.arch.chiave === a.chiave) ||
                regs.find((x) => x.arch && x.arch.rec === k && !x.arch.chiave);
      fuori.push({ nome: path.basename(a.chiave), via: a.chiave, cartella: a.dove || path.dirname(a.chiave), peso: a.peso || (a.pezzi || []).reduce((n, z) => n + (z.peso || 0), 0),
                   quando: Date.parse(a.quando) || 0, est: path.extname(a.chiave).slice(1).toLowerCase(), rec: k, partita: a.partita || nomeDaCartella(a) || "",
                   nomeDa: a.soloS3 ? "cartella" : (a.partita ? "airtable" : (nomeDaCartella(a) ? "cartella" : "")), sicuro: !!a.partita && nomeSicuro(a), competizione: a.competizione || "",
                   quandoPartita: a.quando || "", durata: r ? (r.durata || 0) : Math.round(minuti * 60), reg: r ? r.id : undefined,
                   telecronaca: !!(r && PARLATO[r.id] && (PARLATO[r.id].pezzi || []).length), s3: !inCasa(a), inCasa: inCasa(a), senzaNome: !!a.soloS3, bucket: a.bucket, pezzi: (a.pezzi || []).length || 1,
                   soloElenco: soloElenco(a.bucket) && !inCasa(a), puntata: puntata(a),
                   // per l'anteprima: stemmi, telecronista e lingua, risultato
                   // l'anteprima solo per quelle che la Libreria mostra (in casa); gli stemmi
                   // delle altre li prepara prepararaStemmi in sottofondo
                   ...(inCasa(a) ? { squadre: squadreConStemma(k, a), voce: voceDi(k, a), ris: risultatoDi(a), studio: studioDi(k, a) || specialeDi(k, a),
                                    titolo: titoloDi(a), eventi: loghiEvento(a), compVista: competizioneVista(a, k) } : {}),
                   forse: a.riconosciuta && a.riconosciuta.sicura === false ? a.riconosciuta.nome : "" });
      suS3++;
    });
    fuori.sort((a, b) => b.quando - a.quando);
    return { ok: true, eventi: fuori, peso: fuori.reduce((n, x) => n + x.peso, 0), quanti: fuori.length, suS3: suS3, scrivibile: qnapSiScrive() };
  },
  "clip-qnap-peso": qnapPeso,
  // L'AVANZAMENTO DELLA COPIA S3 -> NAS, per la barra della Libreria
  // IL CONTROLLO DEGLI STEMMI: per ogni squadra dell'archivio, da dove viene
  // lo stemma e come si chiama la', per trovare a occhio quelli sbagliati
  // RINOMINARE UNA CARTELLA SENZA RIGA AIRTABLE: il nome resta anche dopo i giri dell'indice
  "clip-archivio-titolo": (p) => {
    const a = ARCHIVIO[String(p.rec || "")];
    if (!a) throw new Error("questa voce non e' nell'archivio");
    if (!a.soloS3) throw new Error("questa partita ha il nome di Airtable: si cambia li'");
    const t = String(p.titolo || "").trim().slice(0, 120);
    if (!t) throw new Error("manca il nome");
    titoliAMano()[a.dove] = t;
    fs.writeFileSync(TITOLI_FILE(), JSON.stringify(TITOLI, null, 1));
    a.partita = t; scriviArchivio(); STEMMI_CACHE.clear();
    return { ok: true, rec: p.rec, titolo: t };
  },
  // il momento dall'inquadratura, a mano su una partita (rifai: si riparte da zero)
  "clip-momenti": async (p) => {
    const a = ARCHIVIO[String(p.rec || "")]; if (!a) return { ok: false, errore: "partita sconosciuta" };
    if (p.rifai) { delete a.momenti; delete a.momentiFatti; delete a.momentiVer; }
    const esito = await puntaMomenti(String(p.rec));
    return { ok: true, esito, momenti: a.momenti };
  },
  "clip-espn-rileggi": (p) => {
    if (p.avvia) giroRileggiEspn().catch(() => {});
    return { ok: true, stato: RILEGGI };
  },
  "clip-espn-controllo": (p) => {
    const sbagliate = Object.keys(ESPN).filter((rec) => ESPN[rec] && ESPN[rec].id && ARCHIVIO[rec] && !espnCombacia(rec))
      .map((rec) => ({ rec, partita: ARCHIVIO[rec].partita, espn: ESPN[rec].nome || (ESPN[rec].squadre || []).join(" - "), quando: ARCHIVIO[rec].quando }));
    if (p.applica) {
      sbagliate.forEach((x) => {
        const a = ARCHIVIO[x.rec];
        ESPN[x.rec] = { mancante: "abbinamento ESPN sbagliato, tolto il " + new Date().toISOString().slice(0, 10), quando: a.quando };
        // i boati misurati su azioni di un'altra partita non valgono: il giro della casa li rifa'
        delete a.boati; delete a.boatiFatti;
      });
      if (sbagliate.length) { scriviEspn(); scriviArchivio(); STEMMI_CACHE.clear(); }
    }
    return { ok: true, sbagliate, tolte: p.applica ? sbagliate.length : 0 };
  },
  "clip-stemmi-verifica": () => {
    const tsdbNome = {}; Object.keys(TSDB || {}).forEach((k) => { if (TSDB[k]) tsdbNome[TSDB[k].id] = TSDB[k].nome; });
    const visti = {};
    Object.keys(ARCHIVIO).forEach((k) => {
      const a = ARCHIVIO[k]; if (!a || !a.chiave) return;
      const q = squadreConStemma(k, a) || ((studioDi(k, a) || {}).squadre) || [];
      q.forEach((x) => {
        const n = String(x.nome).toUpperCase();
        const v = visti[n] || (visti[n] = { nome: n, partite: 0, fonti: {} });
        v.partite++;
        let f = "sigla";
        const me = /stemma-espn-(\d+)/.exec(x.stemma || ""), mt = /stemma-tsdb-(\d+)/.exec(x.stemma || "");
        if (me) f = "ESPN: " + ((CATALOGO.squadre[me[1]] || {}).nomi || [me[1]])[0];
        else if (mt) f = "TheSportsDB: " + (tsdbNome[mt[1]] || mt[1]);
        else if (x.stemma) f = "redazione: " + x.stemma.replace("/loghi/", "");
        v.fonti[f] = (v.fonti[f] || 0) + 1;
      });
    });
    const squadre = Object.values(visti).sort((x, y) => y.partite - x.partite);
    // e i contenuti che non sono ne' partite ne' studi: restano col titolo
    const altri = Object.keys(ARCHIVIO).filter((k) => {
      const a = ARCHIVIO[k]; return a && a.chiave && !squadreConStemma(k, a) && !studioDi(k, a) && !specialeDi(k, a);
    }).map((k) => { const a = ARCHIVIO[k]; return { rec: k, titolo: titoloDi(a), competizione: competizioneVista(a), quando: a.quando || "",
      senzaAirtable: !!a.soloS3, inCasa: inCasa(a), loghi: loghiEvento(a) }; });
    const speciali = Object.keys(ARCHIVIO).map((k) => { const a = ARCHIVIO[k]; const sp = a && a.chiave && specialeDi(k, a); return sp ? { titolo: titoloDi(a), ...sp } : null; }).filter(Boolean);
    return { ok: true, squadre, altri, speciali, conStemma: squadre.filter((x) => !x.fonti.sigla || Object.keys(x.fonti).length > 1).length, totale: squadre.length };
  },
  "clip-archivio-copia": async () => Object.assign({}, await statoCopia(), { nomi: statoNomi(), casa: statoCasa() }),
  // quante partite S3 sono gia' in casa (ricontate adesso)
  "clip-archivio-specchio": async () => Object.assign({ ok: true, cartella: path.join(QNAP_RADICE, SPECCHIO_DIR) }, await aggiornaSpecchio()),
  // UNA POSA: un fotogramma fermo della registrazione al secondo chiesto,
  // fatto una volta e tenuto nella cartella della registrazione. Serve alle
  // schede della Libreria (una partita si riconosce dal campo, non dal
  // nero) e alla testata dell'Asset.
  "clip-posa": async (p) => {
    const r = R.reg[String(p.reg || "")]; if (!r) throw new Error("registrazione sconosciuta");
    const durata = r.durata || durataRegistrata(r.id) || 0;
    let t = p.t === undefined || p.t === null ? Math.round((r.kickoff && r.kickoff["1"] ? r.kickoff["1"] + 1500 : durata * 0.45)) : Math.max(0, Math.round(+p.t || 0));
    if (durata && t > durata - 2) t = Math.max(0, Math.floor(durata - 2));
    t = Math.round(t / 5) * 5;                       // a passi di cinque secondi: le pose si condividono
    const dir = cartellaReg(r.id); assicura(dir);
    const f = path.join(dir, "posa-" + t + ".jpg");
    if (!fs.existsSync(f)) {
      let via, dentro = t;
      if (r.arch) { const x = fonteAl(r, t); via = x.via; dentro = x.dentro; }
      else if (r.materiale === "integrale" || fs.existsSync(path.join(dir, "integrale.mp4"))) via = path.join(dir, "integrale.mp4");
      else via = sorgenteAudio(r);
      if (!via) throw new Error("di questa registrazione non c'e' un file da cui prendere la posa");
      const ok = await miniatura(via, f, dentro);
      if (!ok) throw new Error("posa non riuscita");
    }
    return { ok: true, via: "/clip/" + r.id + "/posa-" + t + ".jpg", t };
  },
  // CERCARE NEI TABELLINI DI TUTTE LE PARTITE. "tutti i gol di douvikas":
  // le parole che dicono un TIPO di azione (gol, rigore, parata, cartellino,
  // palo, cambio, assist...) diventano un filtro sul tipo; il resto sono
  // nomi e si cercano nel titolo dell'azione, nel giocatore, nella squadra.
  // I tabellini si tengono in memoria un minuto: farli costa.
  // ══════════ IL MONTAGGIO SCRITTO A PAROLE ══════════
  //  "tutti i gol", "le parate", "le occasioni di Douvikas": la stessa
  //  domanda della ricerca, ma invece di un elenco esce una sequenza gia'
  //  pronta. Non e' un montato finito — e' il grezzo da cui si parte, che e'
  //  il pezzo di lavoro che nessuno ha voglia di fare a mano venti volte.
  //
  //  UNA SEQUENZA STA DENTRO UNA PARTITA SOLA: e' cosi' che il ponte la
  //  tiene (q.reg), e l'export scarica i pezzi da quella registrazione. Una
  //  ricetta che attraversa piu' partite ("tutti i gol di Douvikas della
  //  stagione") vuole che ogni pezzo si porti dietro la sua registrazione:
  //  e' un lavoro suo, e finche' non c'e' meglio non prometterlo.
  "clip-hl-ricetta": (p) => {
    const r = R.reg[String(p.reg || "")];
    if (!r) throw new Error("registrazione sconosciuta");
    const cosa = String(p.cosa || "").trim();
    const { tipi, parole } = chiaviDellaDomanda(cosa);
    if (!tipi.length && !parole.length) throw new Error("dimmi cosa montare: \"i gol\", \"le parate\", \"le occasioni di Paz\"");
    const prima = num(p.prima, 0, 60, 4), dopo = num(p.dopo, 0.5, 120, 8);
    const quante = num(p.quante, 1, 60, 20);
    const durata = r.durata || durataRegistrata(r.id) || MAX_SECONDI;
    const trovate = (tabellino(r).righe || [])
      .filter((x) => combaciaRiga(x, r.titolo, tipi, parole))
      .sort((a, b) => a.t - b.t);
    if (!trovate.length) throw new Error("in questa partita non c'e' niente che risponda a \"" + cosa + "\"");
    const scelte = trovate.slice(0, quante);
    const q = {
      id: nuovoId("s"), reg: r.id,
      titolo: String(p.titolo || "").slice(0, 120) || (cosa.toUpperCase() + " \u00b7 " + (r.titolo || "")),
      pezzi: [], grafiche: [], audio: [], pre: HL_PRE, post: HL_POST, scarto: 0, avvisi: [],
      formato: FORMATI[String(p.formato || "")] ? String(p.formato) : "16:9",
      creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null, ricetta: cosa
    };
    let t0 = 0;
    scelte.forEach((x) => {
      const dentro = Math.max(0, Math.min(durata - 1, (x.t || x.dentro || 0) - prima));
      const fuori = Math.max(dentro + 0.5, Math.min(durata, (x.t || x.dentro || 0) + dopo));
      q.pezzi.push({ id: nuovoId("p"), dentro: dentro, fuori: fuori, base: dentro, t0: Math.round(t0 * 1000) / 1000,
                     traccia: "V1", stacco: 0, titolo: (x.minuto ? x.minuto + " " : "") + (x.titolo || "azione"),
                     tipo: x.tipo || "", minuto: x.minuto || "", fonte: "ricetta" });
      t0 += fuori - dentro;
    });
    R.seq[q.id] = q;
    normalizzaSeq(q);              // l'audio sotto ogni pezzo, come sempre
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, quante: q.pezzi.length, trovate: trovate.length };
  },
  "clip-tabellino-cerca": (p) => {
    const q = String(p.q || "").trim(); if (q.length < 2) return { ok: true, righe: [] };
    const { tipi, parole } = chiaviDellaDomanda(q);
    if (!tipi.length && !parole.length) return { ok: true, righe: [] };
    const ora = Date.now();
    if (!global.__TAB_CACHE || ora - global.__TAB_CACHE.quando > 60000) {
      const per = {};
      Object.keys(R.reg).forEach((k) => { const r = R.reg[k]; if (!r || !(r.evento || r.arch)) return; try { per[k] = tabellino(r).righe; } catch (e) { per[k] = []; } });
      // E LE PARTITE MAI APERTE. La ricerca guardava solo le registrazioni:
      // "tutti i gol di Douvikas" trovava Udinese-Como e basta, con venti
      // partite negli appunti. Per una partita dell'indice bastano appunti
      // ed ESPN: il secondo lo da' secondoNelFile, e la pagina la apre da
      // sola al primo clic
      const conReg = new Set(); Object.keys(R.reg).forEach((k) => { const r = R.reg[k]; if (r && (r.arch || r.evento)) conReg.add((r.arch && r.arch.rec) || r.evento); });
      const finti = {};
      Object.keys(ARCHIVIO).forEach((rec) => {
        if (conReg.has(rec) || rec.indexOf("s3:") === 0) return;
        const a = ARCHIVIO[rec], ap = APPUNTI[rec], es = ESPN[rec];
        if (!a || !(a.pezzi || []).length) return;
        if (!ap && !(es && es.eventi && es.eventi.length)) return;
        // CON LE LETTURE (cronometro, tabellone, boati, inquadratura) la
        // partita passa dal tabellino vero, come quelle aperte: il minuto
        // scritto da solo sbaglia di mezzo minuto e piu'
        if (a.orologio && (a.momenti || (a.boati || []).length || (a.tabellone && a.tabellone.punti))) {
          const fr = { titolo: a.partita || rec, arch: { rec: rec, chiave: a.chiave, bucket: a.bucket, pezzi: a.pezzi, pezzo: 0 },
                       avviata: Date.parse(a.quando) || 0, finita: 0, finto: true };
          try {
            const tb = tabellino(fr).righe.map((x) => {
              const pa = pezzoAl(fr, x.dentro);
              return Object.assign({}, x, { chiave: (pa && pa.pezzo && pa.pezzo.chiave) || a.chiave, dentroFile: pa ? pa.dentro : x.dentro });
            });
            if (tb.length) { per["arch:" + rec] = tb; finti["arch:" + rec] = fr; return; }
          } catch (e) {}
        }
        const righe = [], rit = ritardoPartita(rec);
        const dove = (s, d) => { const x = secondoNelFile(rec, { s: s, d: Math.max(0, d) }); if (!x) return null; const pz = (a.pezzi || [])[x.pezzo]; return { t: ((pz && pz.da) || 0) + x.secondi, chiave: x.chiave, dentroFile: x.secondi }; };
        if (ap) (ap.righe || []).forEach((x) => {
          const d = dove(x.s || 1, (x.d || 0) - rit); if (!d) return;
          righe.push(Object.assign({ titolo: x.x || "", tipo: x.t || "", minuto: x.m || "", fonte: "appunti", fonti: ["appunti"], giocatore: "", squadra: "", dettaglio: "",
            gol: /gol|rete/i.test(x.t || "") || !!x.g, tag: etichettaAzione(x.t, x.x), rating: x.g || 0, certezza: "minuto" }, d));
        });
        if (es && es.eventi) es.eventi.forEach((x) => {
          const ita = tipoItaliano(x.tipo);
          const d = dove(x.periodo || 1, (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + (x.stopp || 0) * 60); if (!d) return;
          righe.push(Object.assign({ titolo: ita + (x.giocatore ? " \u00b7 " + x.giocatore : ""), tipo: ita, minuto: x.min + (x.stopp ? "+" + x.stopp : "'"), fonte: "espn", fonti: ["espn"],
            giocatore: x.giocatore || "", squadra: x.squadra || "", dettaglio: x.lungo || x.testo || "", gol: /Gol/.test(ita), tag: etichettaAzione(ita, x.testo), rating: 0, certezza: "minuto" }, d));
        });
        // LA CRONACA ESPN: tiri, parate, pali. Dove nessuno ha scritto
        // niente, il minuto di ESPN basta per andare a prendere l'immagine;
        // come nel tabellino, entra solo dove non c'e' gia' una riga vicina
        if (es && es.gamecast) es.gamecast.forEach((x) => {
          const d = dove(x.periodo || 1, (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + (x.stopp || 0) * 60); if (!d) return;
          if (righe.some((y) => Math.abs(y.t - d.t) < 50)) return;
          righe.push(Object.assign({ titolo: [x.tipo, x.giocatore].filter(Boolean).join(" \u00b7 "), tipo: x.tipo, minuto: x.min + (x.stopp ? "+" + x.stopp : "'"), fonte: "gamecast", fonti: ["gamecast"],
            giocatore: x.giocatore || "", squadra: "", dettaglio: x.testo || "", gol: x.tipo === "Gol", tag: etichettaAzione(x.tipo, x.testo), rating: 0, certezza: "minuto" }, d));
        });
        if (!righe.length) return;
        per["arch:" + rec] = righe.map((x) => Object.assign(x, { t: Math.round(x.t * 10) / 10, dentro: Math.max(0, x.t - (x.gol ? GOL_PRE : APP_PRE)), fuori: x.t + (x.gol ? GOL_POST : APP_POST) }));
        finti["arch:" + rec] = { titolo: a.partita || rec, arch: { rec: rec, chiave: a.chiave, bucket: a.bucket }, avviata: Date.parse(a.quando) || 0, finita: 0, finto: true };
      });
      global.__TAB_CACHE = { quando: ora, per, finti };
    }
    const per = global.__TAB_CACHE.per, finti = global.__TAB_CACHE.finti || {}, fuori = [];
    Object.keys(per).forEach((k) => {
      const r = R.reg[k] || finti[k]; if (!r) return;
      const recR = (r.arch && r.arch.rec) || r.evento || "";
      const gc = global.__TAB_CACHE.giocate || (global.__TAB_CACHE.giocate = {});
      const giocate = recR ? (gc[recR] || (gc[recR] = giocateEspn(recR))) : [];
      per[k].forEach((x) => {
        // il tipo si legge da tipo ed etichetta (che classificano gia' il
        // titolo): guardare la prosa faceva prendere "angolo" per "gol"
        // CHI SI CERCA: le parole che non sono nel nome della partita
        const tp = new Set(nomeParole(String(r.titolo || "").replace(/[\[\]()|\-]/g, " ")));
        const chi = parole.filter((w) => !tp.has(w));
        const { ruolo, da } = ruoloDi(x, recR, chi, giocate);
        if (chi.length && (ruolo || da)) {
          // con un giocatore nella domanda, i tipi sono i SUOI: il suo assist non e' un suo gol
          if (tipi.length && !tipi.every((re) => re.test(RUOLO_PAROLE[ruolo] || ""))) return;
          // ESPN dice che c'era lui anche dove gli appunti non lo nominano ("GOL Douvikas", assist di Paz)
          if (da !== "espn" && !combaciaRiga(x, r.titolo, [], parole)) return;
        } else if (!combaciaRiga(x, r.titolo, tipi, parole)) return;
        x = Object.assign({}, x, { ruolo, ruoloDa: da });
        let chiave = x.chiave || "", dentroFile = x.dentroFile !== undefined ? x.dentroFile : x.dentro;
        if (r.arch && !r.finto) { const pa = pezzoAl(r, x.dentro); if (pa && pa.pezzo && pa.pezzo.chiave) { chiave = pa.pezzo.chiave; dentroFile = pa.dentro; } else chiave = r.arch.chiave || ""; }
        fuori.push({ reg: r.finto ? "" : k, partita: r.titolo || k, rec: (r.arch && r.arch.rec) || r.evento || "", t: x.t, dentro: x.dentro, fuori: x.fuori, s3: !!(r.arch && magazzinoInventario(r.arch.bucket) && !inCasaReg(r)),
                     tipo: x.tipo, tag: x.tag, titolo: x.titolo, minuto: x.minuto, fonte: x.fonte, fonti: x.fonti, squadra: x.squadra, giocatore: x.giocatore,
                     gol: x.gol, certezza: x.certezza, chiave, dentroFile, quando: r.finita || r.avviata || 0, ruolo: x.ruolo || "", ruoloDa: x.ruoloDa || "" });
      });
    });
    fuori.sort((u, v) => (v.gol ? 1 : 0) - (u.gol ? 1 : 0) || String(v.quando).localeCompare(String(u.quando)) || u.t - v.t);
    const partite = new Set(fuori.map((x) => x.reg)).size;
    let scheda = null; try { scheda = schedaGiocatore(parole, global.__TAB_CACHE); } catch (e) {}
    return { ok: true, righe: fuori.slice(0, num(p.quante, 1, 2000, 500)), totale: fuori.length, partite, tipi: tipi.length, parole, scheda };
  },
  // I NOMI DIETRO LE FOTO: una foto premium si chiama col cognome
  // (foto-premium-paz), ma chi cerca scrive "nico paz". Da qui la pagina
  // prende, per ogni cognome, i nomi interi e le squadre del vocabolario,
  // e per ogni squadra il suo allenatore: cosi' la ricerca li trova.
  "clip-foto-nomi": () => {
    const perCognome = {};
    Object.keys((VOCABOLARIO && VOCABOLARIO.squadre) || {}).forEach((sq) => {
      const g = VOCABOLARIO.squadre[sq].giocatori || [];
      (Array.isArray(g) ? g : Object.keys(g)).forEach((n) => {
        const c = piattaMinuscola(String(n).trim().split(/\s+/).pop()); if (!c) return;
        (perCognome[c] = perCognome[c] || []).push(n + " \u00b7 " + sq);
      });
    });
    const allenatori = [];
    try {
      const a = JSON.parse(fs.readFileSync(fileAllenatori(), "utf8"));
      Object.keys(a.perId || {}).forEach((id) => { const x = a.perId[id]; if (x && x.squadra) allenatori.push({ id, nome: ((x.nome || "") + " " + (x.cognome || "")).trim(), squadra: x.squadra, slug: piattaMinuscola(x.squadra).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }); });
    } catch (e) {}
    return { ok: true, perCognome, allenatori };
  },
  // CERCARE NELLE TELECRONACHE: "assist di nico paz" trova la riga in cui e'
  // stato detto, in quale partita e a che secondo. Si guardano le parole
  // (senza accenti e maiuscole) su una finestra di due righe, perche' una
  // frase spesso cade a cavallo. Il nome dei giocatori si cerca anche nella
  // forma piatta, cosi' "paz" trova "Paz" e "nicolo" trova "Nicolo'".
  "clip-parlato-cerca": (p) => {
    const parole = piattaMinuscola(String(p.q || "")).split(/\s+/).filter((w) => w.length >= 2);
    if (!parole.length) return { ok: true, righe: [], partite: 0 };
    const tetto = num(p.quante, 1, 500, 120);
    const fuori = []; const perReg = {};
    Object.keys(PARLATO).forEach((reg) => {
      const d = PARLATO[reg]; const r = R.reg[reg]; if (!d || !r || !(d.pezzi || []).length) return;
      const pz = d.pezzi.filter((x) => !x.vivo).sort((u, v) => u.a - v.a);
      const piatte = pz.map((x) => piattaMinuscola((x.x || "") + " " + (x.y || "")));
      for (let i = 0; i < pz.length && fuori.length < tetto * 3; i++) {
        const qui = piatte[i], due = qui + " " + (piatte[i + 1] || "");
        const tutte = parole.every((w) => due.indexOf(w) >= 0);
        if (!tutte) continue;
        const dentroQui = parole.every((w) => qui.indexOf(w) >= 0);
        const x = pz[i], y = pz[i + 1];
        // il file e il secondo dentro il file: la pagina ci mette il player
        let chiave = "", dentro = x.a;
        if (r.arch) { const pa = pezzoAl(r, x.a); if (pa && pa.pezzo && pa.pezzo.chiave) { chiave = pa.pezzo.chiave; dentro = pa.dentro; } else chiave = r.arch.chiave || ""; }
        fuori.push({ reg, titolo: r.titolo || reg, rec: (r.arch && r.arch.rec) || r.evento || "", a: x.a, b: dentroQui ? x.b : (y ? y.b : x.b), chiave, dentro,
                     testo: dentroQui ? x.x : (x.x + " " + (y ? y.x : "")).trim(), lingua: x.l || d.lingua || "it", k: x.k || "", pieno: dentroQui,
                     prima: i > 0 ? pz[i - 1].x : "", dopo: (dentroQui ? y : pz[i + 2]) ? (dentroQui ? y : pz[i + 2]).x : "" });
        perReg[reg] = (perReg[reg] || 0) + 1;
        if (!dentroQui) i++;
      }
    });
    // prima quelle con tutte le parole nella stessa riga, poi per partita recente
    fuori.sort((u, v) => (v.pieno ? 1 : 0) - (u.pieno ? 1 : 0) || String((R.reg[v.reg] || {}).finita || 0).localeCompare(String((R.reg[u.reg] || {}).finita || 0)) || u.a - v.a);
    return { ok: true, righe: fuori.slice(0, tetto), totale: fuori.length, partite: Object.keys(perReg).length, perReg };
  },
  // GLI STEMMI DELLE SQUADRE: nelle grafiche vengono da ESPN, non dal
  // magazzino. Qui si mettono insieme quelli visti (eventi ESPN letti, e le
  // grafiche salvate che ne portano uno) e le squadre del vocabolario senza
  // stemma, cosi' la ricerca trova tutte le squadre e mostra lo stemma dove c'e'.
  "clip-stemmi": () => {
    const loghi = {};
    Object.keys(ESPN || {}).forEach((k) => { const e = ESPN[k]; if (e && e.loghi) Object.keys(e.loghi).forEach((n) => { loghi[n] = { logo: e.loghi[n], lega: e.lega || "" }; }); });
    try {
      const testo = fs.readFileSync(path.join(path.dirname(DIR), "stato.json"), "utf8");
      const re = /"n":\s*"([^"]{2,60})"[^{}]{0,400}?"l":\s*"(https:\/\/a\.espncdn\.com\/i\/teamlogos\/[^"]+)"/g; let m;
      while ((m = re.exec(testo))) { if (!loghi[m[1]]) loghi[m[1]] = { logo: m[2], lega: "" }; }
    } catch (e) {}
    const fuori = Object.keys(loghi).map((n) => ({ nome: n, logo: loghi[n].logo, lega: loghi[n].lega }));
    const visti = new Set(fuori.map((x) => piattaMinuscola(x.nome)));
    Object.keys((VOCABOLARIO && VOCABOLARIO.squadre) || {}).forEach((n) => {
      if (visti.has(piattaMinuscola(n))) { const f = fuori.find((x) => piattaMinuscola(x.nome) === piattaMinuscola(n)); if (f && !f.lega) f.lega = VOCABOLARIO.squadre[n].lega || ""; return; }
      fuori.push({ nome: n, logo: "", lega: VOCABOLARIO.squadre[n].lega || "" });
    });
    fuori.sort((a, b) => (b.logo ? 1 : 0) - (a.logo ? 1 : 0) || a.nome.localeCompare(b.nome, "it"));
    return { ok: true, stemmi: fuori, conLogo: fuori.filter((x) => x.logo).length };
  },
  "clip-qnap-radici": () => ({ ok: true, radici: qnapRadici().map((r) => ({ id: r.id, nome: r.nome })) }),
  "clip-parlato-importa": (p) => {
    const reg = String(p.reg || ""), r = R.reg[reg];
    if (!r) throw new Error("registrazione sconosciuta");
    const lingua = ["it", "en"].indexOf(String(p.lingua || "")) >= 0 ? String(p.lingua) : LINGUA_MAM;
    const righe = leggiSrt(String(p.srt || ""));
    if (!righe.length) throw new Error("in questo file non ho trovato righe SRT (numero, tempi, testo)");
    const sposta = +p.sposta || 0;                     // se il file era tagliato: quanto e' avanti nel video
    const nuove = righe.map((x) => ({ k: nuovoId("s"), n: x.n, a: Math.round((x.a + sposta) * 100) / 100, b: Math.round((x.b + sposta) * 100) / 100, x: x.x, l: lingua, m: true }));
    const d = PARLATO[reg] || (PARLATO[reg] = { lingua: lingua, pezzi: [] });
    const da = nuove[0].a, a = nuove[nuove.length - 1].b;
    d.pezzi = (p.sostituisci ? [] : (d.pezzi || []).filter((t) => t.b <= da || t.a >= a)).concat(nuove).sort((u, v) => u.a - v.a);
    if (p.sostituisci || !d.pezzi.some((t) => !t.m)) d.lingua = lingua;
    d.importato = { quando: new Date().toISOString(), righe: nuove.length, lingua: lingua, nome: String(p.nome || "").slice(0, 120) };
    scriviParlato();
    return { ok: true, righe: nuove.length, da: da, a: a, lingua: lingua };
  },
  "clip-parlato-srt": (p) => {
    const reg = String(p.reg || ""), d = PARLATO[reg], r = R.reg[reg];
    if (!d || !(d.pezzi || []).length) throw new Error("questa registrazione non ha ancora una telecronaca trascritta");
    const voglio = ["it", "en"].indexOf(String(p.lingua || "")) >= 0 ? String(p.lingua) : (d.lingua || LINGUA_MAM);
    const da = Math.max(0, +p.da || 0), a = +p.a > da ? +p.a : Infinity;
    const righe = righeParlato(reg, voglio, da, a, 0);
    if (!righe.length) throw new Error("niente da scrivere in " + voglio + (a < Infinity ? " in questo tratto" : ""));
    const nome = String((r && r.titolo) || reg).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) + "." + voglio + ".srt";
    return { ok: true, srt: testoSrt(righe, da === 0 && a === Infinity), nome, righe: righe.length, lingua: voglio, manca: righe.filter((x) => x.manca).length };
  },
  "clip-archivio-scandaglia": archivioScandaglia,
  "clip-appunti-storici": appuntiStoriciImporta,
  // legge il cronometro di una partita (o restituisce quello gia' letto) e
  // dice dove cade un minuto degli appunti, se glielo si chiede
  // IL NOME SENZA LEGGERE NIENTE. Un file "MultiCorder3 - Output 1" porta
  // pero' il giorno e l'ora nel nome, e quell'ora dice quale partita di
  // Airtable comincia dentro di lui. Quando ne resta UNA SOLA, quella e' la
  // proposta: costa zero byte, e la conferma la da' una persona dall'Asset.
  // Il tabellone, che costa minuti e mega, resta per i casi dubbi.
  // QUANTO ABBIAMO LETTO DA S3. Il traffico in uscita da AWS e' gratis fino a
  // cento giga al mese: il ponte sulla EC2 conta ogni byte e si ferma prima.
  // La pagina lo mostra a chi guarda una partita d'archivio, cosi' si sa
  // quanto costa un play senza doverlo chiedere a nessuno.
  "clip-s3-conto": () => new Promise((ok) => {
    const m = MAGAZZINI.filter((x) => x.inventario && x.ponte)[0];
    if (!m) return ok({ ok: true, ponte: false });
    const r = http.get(m.ponte + "/conto", { timeout: 8000 }, (res) => {
      let t = ""; res.on("data", (b) => { t += b; });
      res.on("end", () => {
        try {
          const j = JSON.parse(t);
          ok({ ok: true, ponte: true, bucket: m.bucket, giorno: j.giorno_byte || 0, mese: j.mese_byte || 0,
               tettoGiorno: j.tetto_giorno_byte || 0, tettoMese: j.tetto_mese_byte || 0 });
        } catch (e) { ok({ ok: true, ponte: false }); }
      });
    });
    r.on("error", () => ok({ ok: true, ponte: false }));
    r.on("timeout", () => { r.destroy(); ok({ ok: true, ponte: false }); });
  }),
  "clip-archivio-proponi": (p) => {
    const quali = Object.keys(ARCHIVIO).filter((k) => {
      const a = ARCHIVIO[k];
      return a.soloS3 && !a.riconosciuta && (a.candidati || []).length === 1 &&
             (p.anchePerNome ? true : SENZA_NOME.test(a.partita || ""));
    });
    let fatte = 0;
    quali.slice(0, num(p.quante, 1, 4000, 2000)).forEach((k) => {
      const a = ARCHIVIO[k], c = a.candidati[0];
      if (!c || !c.rec || !a.dove) return;
      const r = { rec: c.rec, nome: c.nome, voto: 0, sicura: false,
                  perche: ["l'unica partita del " + (a.giorno || "") + " che comincia dentro questo file"],
                  quando: new Date().toISOString() };
      RICONOSCIUTE[a.dove] = r; a.riconosciuta = r; fatte++;
    });
    if (fatte) { scriviRiconosciute(); scriviArchivio(); }
    return { ok: true, proposte: fatte, restano: quali.length - fatte,
             nota: "proposte senza leggere un byte: le conferma una persona dall'Asset" };
  },
  "clip-archivio-riconosci": async (p) => {
    if (p.tutte) {
      // SOLO CHI NON HA UN NOME. Duecentotrentotto cartelle su S3 si
      // chiamano gia' "CERRO PORTENO-MONAGAS": leggere il loro tabellone e'
      // spendere cinque minuti e qualche decina di mega per sapere una cosa
      // che c'e' scritta sopra. Il tabellone serve ai file che si chiamano
      // "MultiCorder3 - Output 1", e basta.
      const quali = Object.keys(ARCHIVIO).filter((k) => ARCHIVIO[k].soloS3 &&
        (ARCHIVIO[k].candidati || []).length && !ARCHIVIO[k].riconosciuta &&
        SENZA_NOME.test(ARCHIVIO[k].partita || ""));
      let fatte = 0, decise = 0;
      for (const k of quali.slice(0, num(p.quante, 1, 60, 40))) {
        if (registrandoDavvero() || laDirettaGira() || magazzinoOccupato()) break;
        try { const r = await riconosciPartita(k); fatte++; if (r && r.scelto) decise++; }
        catch (e) { console.log("[clip] tabellone (" + k + "): " + e.message); }
      }
      return { ok: true, guardate: fatte, decise: decise, restano: quali.length - fatte };
    }
    return { ok: true, esito: await riconosciPartita(String(p.rec || "")) };
  },
  // SI', E' QUESTA. Il tabellone propone, una persona conferma: da qui in
  // avanti la proposta vale come una lettura sicura e al prossimo giro
  // l'indice attacca il materiale alla riga Airtable giusta. Con "no" la
  // proposta sparisce e la partita torna senza nome.
  "clip-archivio-conferma": async (p) => {
    const rec = String(p.rec || ""), a = ARCHIVIO[rec];
    if (!a) return { ok: false, errore: "questa partita non e' nell'indice dell'archivio" };
    const r = RICONOSCIUTE[a.dove];
    if (!r) return { ok: false, errore: "per questa registrazione non c'e' nessuna proposta" };
    if (p.no) { delete RICONOSCIUTE[a.dove]; a.riconosciuta = undefined; }
    else { r.sicura = true; r.confermata = new Date().toISOString(); a.riconosciuta = r; }
    scriviRiconosciute(); scriviArchivio();
    const nome = r.nome;
    if (!p.no) { archivioScandaglia({}).catch((e) => console.log("[clip] tabellone: " + e.message)); }
    return { ok: true, nome: p.no ? "" : nome };
  },
  // PUNTARE: prima il tabellone (che e' una prova), poi il boato (che e'
  // un indizio al secondo). Le stesse cautele delle altre code: se la regia
  // sta registrando o scrivendo sul magazzino, si aspetta.
  "clip-archivio-punta": async (p) => {
    const uno = async (rec) => {
      const a = ARCHIVIO[rec];
      if (!a) return null;
      // SU S3 IL TABELLONE NON SI FA PER ABITUDINE. Leggerlo vuol dire cento
      // fotogrammi e cinque minuti per partita, e su Como-Lipsia ha trovato
      // zero gol: il boato da' lo stesso secondo in quindici secondi. Si
      // legge solo se lo si chiede (23/09).
      // con tabellone:false non si legge mai: serve ai giri lunghi, dove
      // cinque minuti a partita per il tabellone tengono occupati i due core
      // mentre il boato darebbe lo stesso secondo in dieci
      const saltaTabellone = p.tabellone === false || (senzaCodeDi(a) && !p.tabellone);
      if (!a.tabellone && !saltaTabellone) {
        try { await leggiTabellone(rec); }
        catch (e) { console.log("[clip] punta (" + (a.partita || rec) + "): tabellone no — " + e.message); }
      }
      try { return await puntaBoati(rec); }
      catch (e) { console.log("[clip] punta (" + (a.partita || rec) + "): boati no — " + e.message); return null; }
    };
    if (p.tutte) {
      const quali = Object.keys(ARCHIVIO).filter((k) => (ARCHIVIO[k].pezzi || []).length &&
        (APPUNTI[k] || ESPN[k]) && !(ARCHIVIO[k].boati || []).length);
      let fatte = 0, punti = 0;
      for (const k of quali.slice(0, num(p.quante, 1, 200, 40))) {
        if (registrandoDavvero() || laDirettaGira() || magazzinoOccupato()) break;
        const r = await uno(k);
        fatte++; punti += (r && r.trovati) || 0;
      }
      return { ok: true, partite: fatte, azioniPuntate: punti, restano: quali.length - fatte };
    }
    return { ok: true, esito: await uno(String(p.rec || "")) };
  },
  // il boato attorno a un secondo qualsiasi della registrazione: serve a
  // chi vuole controllare una riga, e a chi vuole puntare a mano
  "clip-archivio-boato": async (p) => {
    const rec = String(p.rec || ""), a = ARCHIVIO[rec];
    if (!a) return { ok: false, errore: "questa partita non e' nell'indice dell'archivio" };
    const t = Math.round(+p.t || 0), f = pezzoDellaRiga(a, t);
    if (p.rifai && a.boati) a.boati = a.boati.filter((x) => Math.abs(x.stimato - t) > 12);
    const b = await boatoVicino(rec, t, f.chiave, f.sec);
    scriviArchivio();
    return { ok: true, boato: b };
  },
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
  // il fischio della partita: a mano ("il primo tempo comincia qui"), dalla
  // telecronaca (auto), o via (torna alla stima). Risponde con il tabellino
  // rifatto, cosi' la pagina si ridisegna in un colpo.
  "clip-archivio-ancora": async (p) => {
    const r = p.reg ? R.reg[String(p.reg)] : null;
    const rec = String(p.rec || (r && r.arch && r.arch.rec) || "");
    const a = ARCHIVIO[rec];
    if (!a) throw new Error("questa partita non e' nell'indice dell'archivio");
    let esito = null;
    // solo per vedere: che cosa direbbe la voce, senza toccare niente
    if (p.prova) return { ok: true, orologio: a.orologio || null, voce: ancoraDallaTelecronaca(rec) };
    if (p.via) { applicaOrologio(rec, null); delete a.voceProvata; }
    else if (p.auto) {
      // un cronometro letto dal video (anche nel formato vecchio, senza
      // "fonte") vale piu' della voce: si sovrascrive solo con forza
      const vecchio = a.orologio || {};
      const eraCronometro = vecchio.fonte === "cronometro" || (!vecchio.fonte && vecchio.letti > 0);
      if (eraCronometro && !p.forza) throw new Error("il cronometro di questa partita e' gia' letto dal video: la voce non lo sostituisce (Togli prima, se vuoi rifarlo)");
      if (vecchio.fonte === "mano" && !p.forza) throw new Error("il fischio e' segnato a mano: la voce non lo sostituisce (Togli prima, se vuoi rifarlo)");
      delete a.orologio; delete a.voceProvata;
      esito = ancoraSeManca(rec, true);
      if (!esito) {
        const prova = ancoraDallaTelecronaca(rec);
        scriviArchivio();
        throw new Error(prova === null ? "nella telecronaca non trovo ne' il fischio ne' gli eventi con un minuto: segna il fischio a mano" : "la telecronaca non basta: segna il fischio a mano");
      }
    } else if (p.cronometro) {
      // una lettura andata male lascia il segno: se no chi gira l'archivio
      // riprova la stessa partita all'infinito (23/09)
      try { esito = await calibraOrologio(rec, "forza"); }
      catch (e) {
        a.orologioFallito = { quando: new Date().toISOString(), motivo: String(e.message).slice(0, 120) };
        scriviArchivio();
        throw e;
      }
    } else {
      if (p.t === undefined || p.t === null) throw new Error("a che secondo comincia il tempo?");
      esito = ancoraAMano(rec, r, p.tempo, +p.t);
    }
    return Object.assign({ ok: true, orologio: a.orologio || null }, r ? tabellino(r) : {});
  },
  // CONTROLLA CHE LA PARTITA DI ESPN SIA DAVVERO QUELLA. Una volta legata,
  // nessuno tornava a verificarla: la firma dell'errore e' una squadra del
  // titolo che combacia e l'altra che non combacia ne' assomiglia a niente
  // di quella partita. Con {pulisci:true} le slega, cosi' vengono ricercate
  // con la regola nuova; quelle che non si ritrovano restano senza, che e'
  // meglio di avere addosso i gol di un'altra partita.
  "clip-espn-verifica": (p) => {
    const sospette = [];
    for (const rec of Object.keys(ESPN)) {
      const e = ESPN[rec]; const a = ARCHIVIO[rec];
      if (!e || !e.id || !a) continue;
      const squadre = squadreDi(a.partita);
      if (squadre.length < 2) continue;
      const nomi = (e.squadre || []).map(nomeSemplice).concat(nomeSemplice(e.nome || ""));
      const prese = squadre.filter((x) => combaciaCoiNomi(x, nomi));
      if (prese.length >= 2 || prese.length === 0) continue;
      const fuori = squadre.find((x) => prese.indexOf(x) < 0);
      if (nomi.some((n) => somigliaNome(n, fuori.tutto))) continue;
      sospette.push({ rec: rec, partita: a.partita, giorno: a.giorno || "",
                      competizione: a.competizione || "", espn: e.nome || "",
                      squadreEspn: e.squadre || [], nonTorna: fuori.tutto,
                      eventi: (e.eventi || []).length, gamecast: (e.gamecast || []).length });
    }
    sospette.sort((x, y) => String(y.giorno).localeCompare(String(x.giorno)));
    return { ok: true, quante: sospette.length, righe: sospette.slice(0, +p.quante || 60) };
  },
  // IL SOSPETTO NON BASTA PER BUTTARE VIA. Il controllo qui sopra vede solo
  // i nomi che abbiamo salvato, e quelli sono i nomi lunghi: "HEARTS" contro
  // "Heart of Midlothian", "PSG" contro "Paris Saint-Germain", "COLONIA"
  // contro "FC Cologne" sembrano tutte sbagliate e non lo sono. L'unico modo
  // onesto di sapere se il legame regge e' rifare la ricerca con la regola
  // nuova, che ha davanti i nomi corti e le sigle, e vedere se cade sulla
  // stessa partita. Se cade su un'altra, quella nuova e' quella buona; se non
  // cade su niente, meglio restare senza che tenere i gol di un'altra gara.
  "clip-espn-ricontrolla": async (p) => {
    const quante = Math.max(1, Math.min(200, +p.quante || 60));
    const soli = Array.isArray(p.rec) ? p.rec : (p.rec ? [String(p.rec)] : null);
    const lista = soli || (AZIONI["clip-espn-verifica"]({ quante: 999 }).righe || []).map((x) => x.rec);
    const esito = [];
    for (const rec of lista.slice(0, quante)) {
      const prima = ESPN[rec] || {};
      if (!ARCHIVIO[rec]) continue;
      let dopo = null;
      try { dopo = await espnTrova(rec); } catch (e) { ESPN[rec] = prima; esito.push({ rec: rec, come: "errore", perche: String(e.message).slice(0, 80) }); continue; }
      const uguale = dopo && dopo.id && String(dopo.id) === String(prima.id);
      if (uguale) esito.push({ rec: rec, come: "confermata", partita: ARCHIVIO[rec].partita, espn: dopo.nome || "" });
      else if (dopo && dopo.id) esito.push({ rec: rec, come: "corretta", partita: ARCHIVIO[rec].partita, era: prima.nome || "", ora: dopo.nome || "" });
      else { delete RITARDI[rec]; esito.push({ rec: rec, come: "slegata", partita: ARCHIVIO[rec].partita, era: prima.nome || "" }); }
      await new Promise((f) => setTimeout(f, 250));
    }
    scriviEspn();
    const conto = {};
    esito.forEach((x) => { conto[x.come] = (conto[x.come] || 0) + 1; });
    return { ok: true, viste: esito.length, conto: conto, righe: esito };
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
      // la proposta del tabellone viaggia con la riga: la pagina la mostra
      // come un forse, e la conferma la da' una persona
      const f = a.riconosciuta && a.riconosciuta.sicura === false ? a.riconosciuta : null;
      return { rec: rec, titolo: a.partita, quando: a.quando, variante: a.variante,
               forse: f ? { nome: f.nome, voto: f.voto, perche: f.perche || [] } : undefined,
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
  // IL MATERIALE DI CASA: sigle, grafiche in movimento, clip girate col
  // telefono. Stanno gia' sulla VM e il montaggio non le vedeva.
  "clip-hl-media": () => {
    const dir = cartellaMedia();
    let file = [];
    try { file = fs.readdirSync(dir).filter((f) => /\.(mp4|mov|m4v)$/i.test(f) && f[0] !== "."); } catch (e) {}
    const elenco = file.map((f) => {
      const via = path.join(dir, f);
      let peso = 0; try { peso = fs.statSync(via).size; } catch (e) {}
      return { file: f, url: "/video/" + f, peso: peso, durata: Math.round(durataMedia(via) * 10) / 10 };
    }).filter((x) => x.durata > 0.2).sort((a, b) => a.file.localeCompare(b.file));
    return { ok: true, media: elenco };
  },
  // un pezzo di materiale in timeline: entrata e uscita sono dentro QUEL
  // file, non dentro la partita
  "clip-hl-metti-media": (p) => {
    const q = seqMia(p);
    const f = path.basename(String(p.media || ""));
    const via = mediaVia({ media: f });
    if (!via) throw new Error("quel file non c'e' piu' nel materiale");
    const dur = durataMedia(via);
    if (!(dur > 0.2)) throw new Error("di quel file non riesco a leggere la durata");
    const dentro = num(p.dentro, 0, Math.max(0.1, dur - 0.2), 0);
    const fuori = num(p.fuori, dentro + 0.2, dur, dur);
    const pezzo = { id: nuovoId("p"), media: f, dentro: dentro, fuori: fuori, base: dentro,
                    traccia: ["V1", "V2"].indexOf(String(p.traccia)) >= 0 ? String(p.traccia) : "V1",
                    titolo: String(p.titolo || "").slice(0, 160) || f.replace(/\.[^.]+$/, ""),
                    tipo: "", minuto: "", fonte: "casa", mano: true };
    const dove = (p.dove === undefined || p.dove === null) ? q.pezzi.length
               : Math.max(0, Math.min(q.pezzi.length, Math.round(num(p.dove, 0, 999, 0))));
    ricorda(q);
    q.pezzi.splice(dove, 0, pezzo);
    toccataAMano(q);
    riallinea(q);
    scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, pezzo: pezzo.id };
  },
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
  "clip-hl-storia": storiaSeq,
  "clip-hl-storia-vai": storiaVai,
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
      const suoP = a.legato ? (q.pezzi || []).filter((y) => y.id === a.legato)[0] : null;
      const mioW = mediaVia(suoP);
      const k = mioW ? ("media-" + path.basename(mioW) + "-" + a.dentro.toFixed(2) + "-" + a.fuori.toFixed(2)).replace(/[^A-Za-z0-9._-]/g, "_")
                     : chiavePezzo(idRegDi(q, suoP || a), a.dentro, a.fuori);
      const via = path.join(cartellaOnde(), k + ".json");
      if (fs.existsSync(via)) { try { fuori[a.id] = JSON.parse(fs.readFileSync(via, "utf8")); } catch (e) {} continue; }
      if (fatte >= 4) { mancano++; continue; }      // le altre al giro dopo
      const o = mioW ? await ondaDaFile(mioW, a.dentro, a.fuori, via)
                     : await calcolaOnda(q.reg, a.dentro, a.fuori);
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
  "clip-hl-progetto": hlProgetto,
  "clip-hl-imposta": hlImposta,
  "clip-hl-aggiungi": hlAggiungi,
  "clip-hl-suggerimento": hlSuggerimento,
  "clip-hl-ordina": hlOrdina,
  "clip-hl-taratura": hlTaratura,
  "clip-hl-esporta": hlEsporta,
  // l'srt della sequenza da solo: chi porta l'XML in Premiere lo mette a fianco
  "clip-hl-srt": async (p) => { const q = seqDi(p); if (!q.pezzi.length) throw new Error("la sequenza e' vuota");
                          await scriviSrtSequenza(q, vuoleSotto({ sottoLingua: p.lingua }), false); return { ok: true, sottotitoli: q.sottotitoli }; },
  "clip-hl-importa-xml": async (p) => {
    try { return await hlImportaXml(p); }
    catch (e) { console.log("[clip] importa-xml: " + e.message + "\n" + String(e.stack || "").split("\n").slice(1, 4).join("\n")); throw e; }
  },
  "clip-hl-elimina": hlElimina,
  "clip-integrale": clipIntegrale,
  "clip-anello": () => ({ ok: true, tolti: anello() }),
  "clip-grafica-uscita": graficaSuUscita,
  "clip-hl-grafica": hlGrafica,
  "clip-hl-grafica-formato": async (p) => {
    const q = seqDi(p);
    const g = (q.grafiche || []).filter((x) => x.id === String(p.grafica || ""))[0];
    if (!g) throw new Error("grafica sconosciuta");
    const st = await stratoPerFormato(g, String(p.formato || "16:9"));
    return { ok: true, url: st.url, w: st.w, h: st.h, adattata: st.adattata };
  },
  // un titolo: una grafica che si disegna da sola, nei font di Como TV
  "clip-hl-titolo": async (p) => {
    const q = seqMia(p);
    const testo = String(p.testo || "").trim();
    if (!testo) throw new Error("scrivi il testo del titolo");
    q.grafiche = q.grafiche || [];
    const durataSeq = (q.pezzi || []).reduce((n, x) => n + (x.fuori - x.dentro), 0) || 60;
    const id = nuovoId("g"), via = path.join(cartellaGrafiche(), id + ".png");
    const mis = await disegnaTitolo(via, testo, p.sopra, String(p.stile || "basso"), p.colore);
    const dentro = num(p.dentro, 0, durataSeq, 0);
    const durata = num(p.durata, 0.5, 120, 4);
    q.grafiche.push({ id: id, file: "/clip/" + CARTELLA_HL + "/_grafiche/" + id + ".png",
                      w: mis.w, h: mis.h, nome: testo.slice(0, 60),
                      dentro: dentro, fuori: Math.min(durataSeq + durata, dentro + durata),
                      titolo: { testo: testo, sopra: String(p.sopra || ""), stile: String(p.stile || "basso"), colore: p.colore ? String(p.colore) : "" },
                      quando: Date.now() });
    q.grafiche.sort((a, b) => a.dentro - b.dentro);
    toccataAMano(q); scrivi(); annuncia(0, "clip");
    return { ok: true, seq: q, grafica: id };
  },
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

// IL NOME DEL PASSO, per la Cronologia. In Premiere ogni riga della
// Cronologia dice che cosa e' stato fatto — Taglierino, Sposta, Cancella —
// e non "modifica 14". Il comando che sta girando lo sa, e lo dice qui.
let PASSO_IN_CORSO = "";
// UN COMANDO, UN PASSO. Molti comandi mettono da parte la sequenza due
// volte — "com'era prima" e poi toccataAMano — e fra le due il pezzo e' gia'
// entrato: nella pila finivano due passi, e il primo cmd Z dopo un
// Inserisci rimetteva la sequenza... com'era gia'. Niente di visibile, e si
// pensava che Annulla non funzionasse. Adesso ogni comando ha il suo
// numero e nella pila entra una volta sola, col suo stato di PRIMA.
let GIRO_AZIONE = 0;
// UN COMANDO RIFIUTATO NON LASCIA UN PASSO. Molti comandi mettono da parte
// la sequenza prima di controllare se possono fare quello che gli si chiede
// ("pezzo sconosciuto", "traccia bloccata"...). Il comando si rifiutava,
// ma nella pila di Annulla restava un passo — e il cmd Z successivo non
// cambiava niente. Qui si ricorda l'ultimo passo messo da parte, e se il
// comando fallisce si toglie, rimettendo anche i "rifai" che aveva spento.
let ULTIMO_PASSO = null;
function togliPassoFantasma(giro) {
  const u = ULTIMO_PASSO;
  if (!u || u.giro !== giro) return;
  if (u.pila.indietro.length && u.pila.indietro[u.pila.indietro.length - 1] === u.voce) {
    u.pila.indietro.pop();
    u.pila.avanti = u.avanti;
    u.pila.giro = 0;
  }
  ULTIMO_PASSO = null;
}
function nomeDelPasso(p) {
  const t = String(p.tipo || "");
  if (t === "clip-hl-pezzo") {
    if (p.togli) return "Cancella";
    if (p.velocita !== undefined) return "Velocit\u00e0/durata";
    if (p.colore !== undefined) return "Colore";
    if (p.transizione !== undefined) return "Transizione";
    if (p.traccia !== undefined) return "Sposta di traccia";
    if (p.riquadro !== undefined) return "Riquadro";
    if (p.titolo !== undefined) return "Rinomina clip";
    if (p.dentro !== undefined || p.fuori !== undefined) return "Taglio";
    return "Modifica clip";
  }
  if (t === "clip-hl-audio") {
    const a = String(p.azione || "");
    return { scollega: "Scollega", collega: "Collega", traccia: "Traccia", gain: "Guadagno audio",
             volume: "Volume", muto: "Disattiva audio clip", togli: "Elimina audio", sposta: "Sposta audio" }[a] || "Audio";
  }
  return ({ "clip-hl-inserisci": "Inserisci", "clip-hl-dividi": "Taglierino", "clip-hl-sposta": "Sposta",
            "clip-hl-ordina": "Riordina", "clip-hl-attacca": "Chiudi gli spazi vuoti", "clip-hl-aggiungi": "Aggiungi clip",
            "clip-hl-metti-media": "Importa materiale", "clip-hl-imposta": "Impostazioni sequenza",
            "clip-hl-titolo": "Testo", "clip-hl-grafica": "Grafica", "clip-hl-inquadra": "Inquadratura" })[t] || "Modifica";
}
function azione(p) {
  const f = AZIONI[p.tipo];
  if (!f) throw new Error("tipo di invio sconosciuto: " + p.tipo);
  if (String(p.tipo || "").indexOf("clip-") !== 0) return f(p);
  PASSO_IN_CORSO = nomeDelPasso(p);
  const giro = ++GIRO_AZIONE;
  let d;
  try { d = f(p); } catch (e) { togliPassoFantasma(giro); throw e; }
  if (d && typeof d.then === "function") {
    return d.then((x) => { if (x && x.ok === false) togliPassoFantasma(giro); return rimettiInRiga(x); },
                  (e) => { togliPassoFantasma(giro); throw e; });
  }
  if (d && d.ok === false) togliPassoFantasma(giro);
  return rimettiInRiga(d);
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
  leggiRiconosciute();
  leggiStorici();
  leggiEspn();
  leggiVettori();
  setTimeout(raccogliParlato, 5000);
  rinominaMaterialeArchivio();
  leggiParlato();
  leggiVocabolario();
  // I PROXY ORFANI SI CHIUDONO. Il servizio non uccide i figli al riavvio
  // (cosi' il registratore sopravvive), ma la copia leggera NON deve
  // sopravvivere: due encoder che scrivono la stessa playlist si pestano i
  // piedi, e quattro riavvii in un pomeriggio avevano lasciato quattro
  // ffmpeg a scrivere gli stessi p00042.ts. Si guarda in /proc e si chiude
  // ogni ffmpeg che scrive un proxy.m3u8 di questa cartella e non e' nostro.
  try {
    fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).forEach((pid) => {
      let riga = ""; try { riga = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8"); } catch (e) { return; }
      if (riga.indexOf("ffmpeg") < 0 || riga.indexOf(path.join(DIR, "")) < 0 || riga.indexOf("proxy.m3u8") < 0) return;
      try { process.kill(+pid, "SIGTERM"); console.log("[clip] proxy orfano chiuso (pid " + pid + ")"); } catch (e) {}
    });
  } catch (e) {}
  // i sottotitoli accesi prima del riavvio ripartono da dove siamo adesso
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato === "registra" && r.sottotitoli && r.sottotitoli.acceso && !VIVI.has(k)) {
      VIVI.set(k, { fatto: Math.max(0, durataRegistrata(k) - VIVO_PEZZO), lingua: r.sottotitoli.lingua === "auto" ? "" : r.sottotitoli.lingua, prompt: "" });
    }
  });
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
  // le partite S3 che arrivano sulla NAS: ogni dieci minuti si guarda chi e' in casa
  // lo specchio dell'ultima volta, subito; poi la NAS lo rinfresca
  try { const v = JSON.parse(fs.readFileSync(path.join(DIR, "specchio.json"), "utf8")); if (Array.isArray(v)) { SPECCHIO = new Map(v); SPECCHIO_QUANDO = Date.now(); } } catch (e) {}
  setTimeout(() => { aggiornaSpecchio().catch((e) => console.log("[clip] specchio: " + e.message)); }, 1000).unref();
  // i nomi delle partite in casa: il giro riparte ogni cinque minuti (e da solo appena finisce una)
  setTimeout(() => { try { giroNomi(); } catch (e) {} }, 60000).unref();
  setInterval(() => { try { giroNomi(); } catch (e) {} }, 300000).unref();
  setTimeout(() => { giroCasa().catch(() => {}); }, 90000).unref();
  // il catalogo delle squadre ESPN per gli stemmi: una volta a settimana
  leggiCatalogo();
  // assistman e cronaca ESPN per le partite gia' riconosciute (una volta sola per partita)
  setTimeout(() => { giroRileggiEspn().catch((e) => console.log("[clip] rileggi espn: " + e.message)); }, 90000).unref();
  setTimeout(() => { try { appuntiGemelli(); } catch (e) { console.log("[clip] appunti gemelli: " + e.message); } }, 40000).unref();
  setTimeout(() => {
    let n = 0;
    Object.keys(ESPN).forEach((k) => { if (ESPN[k] && ESPN[k].mancante === "titolo senza due squadre" && ARCHIVIO[k] && dueSquadre(ARCHIVIO[k].partita)) { delete ESPN[k]; n++; } });
    if (n) { scriviEspn(); console.log("[clip] ESPN: " + n + " partite da rifare (titolo letto meglio)"); }
  }, 20000).unref();
  // gli stemmi di tutto l'archivio, a blocchi, senza fermare il ponte
  setTimeout(() => { STEMMI_CACHE.clear(); preparaStemmi(); }, 90000).unref();
  setInterval(() => { preparaStemmi(); }, 6 * 3600000).unref();
  const catalogoNo = (e) => console.log("[clip] stemmi: catalogo ESPN non aggiornato — " + e.message);
  setTimeout(() => { if (Date.now() - (CATALOGO.quando || 0) > 7 * 86400000) aggiornaCatalogo().catch(catalogoNo); }, 30000).unref();
  setInterval(() => { aggiornaCatalogo().catch(catalogoNo); }, 7 * 86400000).unref();
  setInterval(() => { giroCasa().catch(() => {}); }, 120000).unref();
  setInterval(() => { aggiornaSpecchio().catch((e) => console.log("[clip] specchio: " + e.message)); }, 600000).unref();
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
