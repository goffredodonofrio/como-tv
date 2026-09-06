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
// Rete di sicurezza: una registrazione dimenticata accesa mangia il disco.
const MAX_SECONDI = parseInt(process.env.COMOTV_CLIP_MAX || "18000", 10);   // 5 ore
// Una clip piu' lunga di cosi' non e' una clip: e' l'integrale.
const MAX_CLIP = 900;
// I formati in cui esce una clip. Il 16:9 e' il flusso com'e': si ricopiano i
// byte e basta. Gli altri due ritagliano l'immagine, quindi si ricodificano —
// non e' una scelta, e' che si sta cambiando l'inquadratura.
const FORMATI = {
  "16:9": { vf: "" },
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
let R = { reg: {}, clip: {}, seq: {} };
const PROC = new Map();             // idRegistrazione -> processo ffmpeg

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
    if (d && d.reg) R = { reg: d.reg || {}, clip: d.clip || {}, seq: d.seq || {} };
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
    const gia = Object.keys(R.reg).map((k) => R.reg[k]).find((x) =>
      x.stato === "registra" && x.ascolto && vivo(x.pid, x.id) &&
      (!!x.guarda === !!p.guarda) && durataRegistrata(x.id) === 0);
    if (gia) return { ok: true, id: gia.id, gia: true, reg: pubblica(gia) };

    const usate = Object.keys(R.reg)
      .filter((k) => R.reg[k].stato === "registra" && R.reg[k].ascolto)
      .map((k) => R.reg[k].ascolto.porta);
    // e non basta il nostro registro: sulla macchina c'e' anche l'altro
    // ambiente, e possono restare processi orfani di un riavvio
    const porta = PORTE.find((x) => usate.indexOf(x) < 0 && portaLibera(x));
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
function clipTaglia(p) {
  const r = R.reg[p.reg];
  if (!r) throw new Error("registrazione sconosciuta");
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
  const riserva = preciso ? null : codifica(
    ["-f", "concat", "-safe", "0", "-ss", String(Math.max(0, scarto)), "-i", lista,
     "-t", String(quanto)], true, ritaglio, stingFiltro);
  esegui(c, codifica(args, preciso, ritaglio, stingFiltro), lista, riserva);
  return { ok: true, clip: c };
}

// Stessa clip, presa dall'integrale invece che dai segmenti: cambia solo da
// dove si leggono i byte.
function taglioDaIntegrale(r, p, dentro, fuori, durata) {
  const file = r.arch ? viaArchivio(r) : path.join(cartellaReg(r.id), "integrale.mp4");
  if (!r.arch && !fs.existsSync(file)) {
    throw new Error("di questa registrazione non c'e' piu' materiale sul disco");
  }
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
  esegui(c, codifica(["-ss", String(dentro), "-i", file, "-t", String(durata)],
                     preciso, ritaglio,
                     sting ? filtroSting(r, c, path.join(DIR, CARTELLA_CLIP), c.id) : ""), null);
  return { ok: true, clip: c };
}

// Come si scrive la clip: ricopiando i byte, o ricodificando quando il taglio
// deve essere preciso o l'immagine va ritagliata in verticale.
function codifica(args, preciso, ritaglio, sting) {
  let fuori = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(args);
  if (!preciso) {
    // Il video si ricopia, l'audio no: certe partite hanno la telecronaca
    // in 5.1 a sei canali, e un MP4 con l'audio multicanale Firefox si
    // rifiuta di aprirlo — dice "file danneggiato", che sembra un guasto
    // e invece e' una scelta. Ricodificare l'audio costa niente e la clip
    // esce leggibile ovunque.
    fuori = fuori.concat(["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
                          "-avoid_negative_ts", "make_zero"]);
  } else {
    // il ritaglio PRIMA, lo sting DOPO: l'etichetta va misurata sul formato
    // che esce davvero, non su quello che entra
    const vf = [ritaglio, sting].filter(Boolean).join(",");
    if (vf) fuori = fuori.concat(["-vf", vf]);
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
    via: r.arch ? viaArchivio(r) : undefined,
    durata: r.stato === "registra" ? durataRegistrata(r.id) : (r.durata || durataRegistrata(r.id)),
    viva: vive
  });
}

function clipStato(p) {
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
  ["Gol", ["gol", "goal", "rete", "segna", "raddoppi", "pareggi"]],
  ["Rigore", ["rigore", "penalty", "dal dischetto"]],
  ["Parata", ["parata", "para ", "miracolo", "respinge", "salva", "rifless", "vola", "paraton"]],
  ["Palo", ["traversa", "legno", "palo"]],
  ["Cartellino", ["giallo", "rosso", "cartellino", "ammoni", "espuls"]],
  ["Occasione", ["occasione", "chance", "tiro", "conclusion", "punizione",
                 "colpo di testa", "assist", "contropiede", "brivido"]],
  ["Skill", ["skill", "dribbling", "numero", "tunnel", "giocata", "tacco"]]
];

function tipoDellaRiga(t) {
  const b = senzaAccenti(t);
  for (const [nome, chiavi] of TIPI_APPUNTI) if (chiavi.some((k) => b.indexOf(k) >= 0)) return nome;
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
function pesoAzione(tipo, hl) {
  const t = senzaAccenti(tipo || "");
  if (hl) return 5;                                  // marcata dalla redazione: non si tocca
  if (/goal|gol|own|penalty|rigore/.test(t)) return 4;
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
        peso: pesoAzione(n.tipo, n.hl)
      });
    });
    if (note.length && (k1 === undefined && k2 === undefined)) {
      avvisi.push("Gli appunti ci sono (" + note.length + " azioni) ma senza i fischi d'inizio " +
                  "non so dove cadono: segnali e rigenera.");
    }
  }

  pezzi.forEach((x) => { x.peso = pesoAzione(x.tipo, x.hl); });
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

function hlElenco(p) {
  const seq = Object.keys(R.seq).map((k) => R.seq[k])
    .filter((q) => !p || !p.reg || q.reg === p.reg)
    .sort((a, b) => b.creata - a.creata);
  return { ok: true, seq: seq };
}

// ritocco di un pezzo: sposta l'entrata, l'uscita, il nome — o lo butta
function hlPezzo(p) {
  const q = seqDi(p);
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
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q };
}

// L'INSERISCI DI PREMIERE, ISTANTANEO. Il pezzo entra nella sequenza come
// entrata e uscita SULLA PARTITA, subito: niente file da aspettare. Il
// Programma lo riproduce dal materiale, e il video si rende solo quando
// si esporta — che e' esattamente il modello di Premiere, dove la timeline
// e' fatta di riferimenti e non di file.
function hlInserisci(p) {
  const r = R.reg[String(p.reg || "")];
  if (!r) throw new Error("registrazione sconosciuta");
  const durataMax = r.durata || durataRegistrata(r.id) || MAX_SECONDI;
  const dentro = num(p.dentro, 0, durataMax, 0), fuori = num(p.fuori, 0, durataMax, 0);
  if (fuori - dentro < 0.5) throw new Error("il punto di uscita deve venire dopo quello di entrata");
  let q = p.seq ? R.seq[p.seq] : null;
  if (!q) q = Object.keys(R.seq).map((k) => R.seq[k]).filter((x) => x.reg === r.id).sort((a, b) => b.creata - a.creata)[0];
  if (!q) {
    q = { id: nuovoId("s"), reg: r.id, titolo: "HL " + r.titolo, pezzi: [], pre: HL_PRE, post: HL_POST,
          scarto: 0, avvisi: [], creata: Date.now(), chi: String(p.__chi || p.chi || "").slice(0, 40), export: null };
    R.seq[q.id] = q;
  }
  const pezzo = { id: nuovoId("p"), dentro: dentro, fuori: fuori, base: dentro,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    tipo: "", minuto: "", fonte: "mano", mano: true };
  const dove = (p.dove === undefined || p.dove === null) ? q.pezzi.length
             : Math.max(0, Math.min(q.pezzi.length, Math.round(num(p.dove, 0, 999, 0))));
  q.pezzi.splice(dove, 0, pezzo);
  scrivi(); annuncia(0, "clip");
  return { ok: true, seq: q, pezzo: pezzo.id };
}

// File > Nuova sequenza: una sequenza vuota, con un nome, sulla partita
// aperta. Prima nasceva solo al primo pezzo; a volte si vuole cominciare
// dal titolo, come in Premiere.
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
  const q = seqDi(p);
  const i = q.pezzi.findIndex((x) => x.id === p.pezzo);
  if (i < 0) throw new Error("pezzo sconosciuto");
  const x = q.pezzi[i];
  const a = +p.a;
  if (!(a > x.dentro + 0.2 && a < x.fuori - 0.2)) throw new Error("il taglio cadrebbe sul bordo del pezzo");
  const nuovo = Object.assign({}, x, { id: nuovoId("p"), dentro: a, base: a, mano: true });
  x.fuori = a; x.mano = true;
  q.pezzi.splice(i + 1, 0, nuovo);
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
  const q = seqDi(p);
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
async function hlEsportaTutti(q, formati) {
  q.esportati = q.esportati || {};
  for (const f of formati) {
    await hlEsportaVideo(q, f, true);
  }
  q.export = { stato: "pronto", tutti: true, formati: formati,
               fatti: formati.length, quanti: formati.length };
  scrivi(); annuncia(0, "clip");
}

async function hlEsportaVideo(q, formato, dentroUnGiro) {
  const dir = path.join(DIR, CARTELLA_HL, q.id);
  assicura(dir);
  const r = R.reg[q.reg];
  const segs = segmenti(q.reg);
  const usaIntegrale = !segs.length;
  // una partita d'archivio non ha byte qui: si legge dal suo indirizzo
  // firmato, con -ss che scarica solo il pezzo che serve
  const integrale = (r && r.arch) ? viaArchivio(r) : path.join(cartellaReg(q.reg), "integrale.mp4");
  if (usaIntegrale && !(r && r.arch) && !fs.existsSync(integrale)) throw new Error("non c'e' piu' materiale per questa registrazione");

  const ritaglio = (FORMATI[formato] || FORMATI["16:9"]).vf;
  q.export = { stato: "lavora", formato: formato, fatti: 0, quanti: q.pezzi.length, file: "",
               tutti: !!dentroUnGiro };
  scrivi(); annuncia(0, "clip");

  const parti = [];
  for (let i = 0; i < q.pezzi.length; i++) {
    const x = q.pezzi[i];
    const fuoriFile = path.join(dir, "p" + String(i + 1).padStart(3, "0") + ".mp4");
    let ingresso;
    let lista = null;
    if (usaIntegrale) {
      ingresso = ["-ss", String(x.dentro), "-i", integrale, "-t", String(x.fuori - x.dentro)];
    } else {
      const scelti = segs.filter((sg) => sg.t0 + sg.dur > x.dentro && sg.t0 < x.fuori);
      if (!scelti.length) continue;
      lista = path.join(dir, "l" + i + ".txt");
      fs.writeFileSync(lista, scelti.map((sg) => "file '" + sg.file + "'").join("\n") + "\n");
      ingresso = ["-f", "concat", "-safe", "0", "-ss", String(Math.max(0, x.dentro - scelti[0].t0)),
                  "-i", lista, "-t", String(x.fuori - x.dentro)];
    }
    let args = CON_PROGRESSO.concat(["-hide_banner", "-loglevel", "error", "-nostdin"], ingresso);
    if (ritaglio) args = args.concat(["-vf", ritaglio]);
    args = args.concat(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                        "-r", "25", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
                        "-movflags", "+faststart", "-y", fuoriFile]);
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
      (function (pezzoI, durPezzo) {
        let ultimo = 0;
        pr.stderr.on("data", (d) => {
          const sec = secondiScritti(String(d));
          if (sec === null || !durPezzo) return;
          q.export.avanza = Math.min(0.99, (pezzoI + Math.min(1, sec / durPezzo)) / q.pezzi.length);
          if (Date.now() - ultimo > 500) { ultimo = Date.now(); annuncia(0, "clip"); }
        });
      })(i, x.fuori - x.dentro);
      let coda = "";
      pr.stderr.on("data", (d) => { coda = (coda + d).slice(-1500); });
      pr.on("error", no);
      pr.on("close", (code) => {
        if (lista) { try { fs.unlinkSync(lista); } catch (e) {} }
        code === 0 ? si() : no(new Error(ultimaRiga(coda) || ("ffmpeg " + code)));
      });
    });
    parti.push(fuoriFile);
    q.export.fatti = i + 1; scrivi(); annuncia(0, "clip");
  }
  if (!parti.length) throw new Error("nessun pezzo da esportare");

  const listaFin = path.join(dir, "tutti.txt");
  fs.writeFileSync(listaFin, parti.map((x) => "file '" + x + "'").join("\n") + "\n");
  const suffisso = "_" + String(formato).replace(":", "x");
  const finale = path.join(DIR, CARTELLA_HL, q.id + suffisso + ".mp4");
  await new Promise((si, no) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "concat", "-safe", "0", "-i", listaFin, "-c", "copy",
      "-movflags", "+faststart", "-y", finale], { stdio: "ignore" });
    pr.on("error", no);
    pr.on("close", (code) => code === 0 ? si() : no(new Error("incollatura fallita")));
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}   // i pezzi non servono piu'
  const d = await probe(finale);
  if (!q.mini) {
    const mini = await miniatura(finale, path.join(DIR, CARTELLA_HL, q.id + ".jpg"), (d.durata || 6) / 3);
    q.mini = mini ? "/clip/" + CARTELLA_HL + "/" + q.id + ".jpg" : "";
  }
  q.esportati = q.esportati || {};
  q.esportati[formato] = {
    file: "/clip/" + CARTELLA_HL + "/" + q.id + suffisso + ".mp4",
    durata: d.durata ? Math.round(d.durata * 10) / 10 : 0, peso: d.peso || 0
  };
  q.esportati[formato].nome = nomeScaricoSeq(q, R.reg[q.reg], formato, ".mp4");
  q.export = { stato: "pronto", formato: formato, fatti: q.pezzi.length, quanti: q.pezzi.length,
               file: q.esportati[formato].file,
               durata: q.esportati[formato].durata, peso: q.esportati[formato].peso };
  scrivi(); annuncia(0, "clip");
  return q.export;
}

// ── l'uscita 2: la sequenza per Premiere ──────────────────────────────
//
//  Formato xmeml, lo stesso che HL Auto-Cut gia' produce e che i montatori
//  aprono da mesi: il MAM non cambia loro lo strumento, gli toglie la parte
//  noiosa. Il media e' l'integrale della partita; se in Premiere non e' allo
//  stesso percorso, chiede di ricollegarlo una volta sola.

function xmlEsc(t) {
  return String(t == null ? "" : t).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
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
  const url = "file://localhost" + (via.charAt(0) === "/" ? "" : "/") + encodeURI(via).replace(/#/g, "%23");

  let video = "", a1 = "", a2 = "", marker = "", pos = 0;
  q.pezzi.forEach((x, i) => {
    const inF = frame(x.dentro), outF = frame(x.fuori);
    const durF = Math.max(1, outF - inF);
    const start = pos, end = pos + durF; pos = end;
    const n = xmlEsc(x.titolo);
    const file = i === 0
      ? '<file id="file-1"><name>' + xmlEsc(nome) + '</name><pathurl>' + xmlEsc(url) + '</pathurl>' + rate +
        '<duration>' + durataFile + '</duration>' + tc +
        '<media><video><samplecharacteristics><width>1920</width><height>1080</height>' +
        '</samplecharacteristics></video><audio><channelcount>2</channelcount></audio></media></file>'
      : '<file id="file-1"/>';
    const link = '<link><linkclipref>v' + i + '</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>' + (i + 1) + '</clipindex></link>' +
                 '<link><linkclipref>a1' + i + '</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>' + (i + 1) + '</clipindex></link>' +
                 '<link><linkclipref>a2' + i + '</linkclipref><mediatype>audio</mediatype><trackindex>2</trackindex><clipindex>' + (i + 1) + '</clipindex></link>';
    video += '<clipitem id="v' + i + '"><name>' + n + '</name><duration>' + durF + '</duration>' + rate +
             '<start>' + start + '</start><end>' + end + '</end><in>' + inF + '</in><out>' + outF + '</out>' +
             file + '<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>' + link + '</clipitem>';
    [["a1", 1], ["a2", 2]].forEach((ch) => {
      const pezzo = '<clipitem id="' + ch[0] + i + '"><name>' + n + '</name><duration>' + durF + '</duration>' + rate +
        '<start>' + start + '</start><end>' + end + '</end><in>' + inF + '</in><out>' + outF + '</out>' +
        '<file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>' + ch[1] +
        '</trackindex></sourcetrack>' + link + '</clipitem>';
      if (ch[1] === 1) a1 += pezzo; else a2 += pezzo;
    });
    marker += '<marker><name>' + n + '</name><comment>' + xmlEsc(x.fonte || "") +
              '</comment><in>' + start + '</in><out>-1</out></marker>';
  });

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">\n' +
    '<sequence id="sequence-1"><name>' + xmlEsc(q.titolo) + '</name><duration>' + pos + '</duration>' + rate + tc + '\n' +
    '<media><video><format><samplecharacteristics>' + rate + '<width>1920</width><height>1080</height>' +
    '</samplecharacteristics></format><track>' + video + '</track></video>' +
    '<audio><track>' + a1 + '</track><track>' + a2 + '</track></audio></media>\n' + marker + '\n</sequence>\n</xmeml>\n';

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
  hlEsportaTutti(q, formati).catch((e) => {
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
function s3Acceso() { return !!(S3.bucket && S3.id && S3.segreto); }

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
  const b = bucket || S3.bucket;
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
  const host = secchio + ".s3." + regione + ".amazonaws.com";
  const ora = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const giorno = ora.slice(0, 8);
  const ambito = giorno + "/" + regione + "/s3/aws4_request";

  const q = Object.assign({}, cerca || {}, {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": S3.id + "/" + ambito,
    "X-Amz-Date": ora,
    "X-Amz-Expires": String(quanto || 3600),
    "X-Amz-SignedHeaders": "host"
  });
  const query = Object.keys(q).sort()
    .map((k) => uriAws(k) + "=" + uriAws(q[k])).join("&");
  const via = "/" + (chiave ? uriChiave(chiave) : "");

  const richiesta = ["GET", via, query, "host:" + host, "", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const daFirmare = ["AWS4-HMAC-SHA256", ora, ambito, sha256(richiesta)].join("\n");
  let k = hmac("AWS4" + S3.segreto, giorno);
  k = hmac(k, regione); k = hmac(k, "s3"); k = hmac(k, "aws4_request");
  const firma = crypto.createHmac("sha256", k).update(daFirmare).digest("hex");

  return "https://" + host + via + "?" + query + "&X-Amz-Signature=" + firma;
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

const ARCH_BUCKET = process.env.COMOTV_S3_ARCHIVIO || "mola-italy-como-archive";
const ARCH_RADICE = process.env.COMOTV_S3_RADICE || "TEMP/";

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
function pezziChiave(k) {
  const p = k.split("/");
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
  return null;
}

// Dentro una cartella partita c'e' di tutto: le clip social, gli scarichi
// delle camere, le interviste, le iso. Niente di tutto questo e' la
// partita, e prenderne uno per sbaglio significa aprire un file di tre
// giga che non c'entra niente.
const NON_E_LA_PARTITA = /clip[ _]?social|tifos|scarich|camere|iso[_ ]|intervist|conferenz|social|highlight|magazine|promo|sigla|grafic/i;
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

  if (puliti.length) return { fonte: "intero", pezzi: [piuGrosso(puliti)] };
  if (conOra.length > 1) return { fonte: "pezzi", pezzi: conOra };
  if (intere.length) return { fonte: "intera", pezzi: [piuGrosso(intere)] };
  if (conOra.length) return { fonte: "pezzi", pezzi: conOra };
  return { fonte: "unico", pezzi: [piuGrosso(campo)] };
}
function piuGrosso(v) { return v.slice().sort((a, b) => b.peso - a.peso)[0]; }

let ARCHIVIO = {};       // recId -> { chiave, peso, variante, kickoff, ... }

// L'indirizzo firmato di una partita d'archivio. Vale sei ore: piu' che
// abbastanza per una sessione di montaggio, e se scade si rifa' da solo
// alla prossima richiesta di stato.
function viaArchivio(r) {
  return firmaConRegione(r.arch.regione, r.arch.chiave, {}, 21600, r.arch.bucket);
}

// Una partita che sta su S3 diventa una registrazione come le altre. Non
// e' un trucco: il MAM chiama "registrazione" del materiale con una linea
// del tempo, e questa ce l'ha. Da qui in poi taglio, formati, sequenza,
// ricerca e grafica funzionano senza sapere che i byte sono a Francoforte.
async function archivioApri(p) {
  const a = ARCHIVIO[String(p.rec || "")];
  if (!a) return { ok: false, errore: "questa partita non e' nell'indice dell'archivio" };
  const pezzi = a.pezzi && a.pezzi.length ? a.pezzi : [{ chiave: a.chiave, peso: a.peso }];
  const i = Math.min(Math.max(0, num(p.pezzo, 0, pezzi.length - 1, 0)), pezzi.length - 1);
  const scelto = pezzi[i];

  const gia = Object.keys(R.reg).map((k) => R.reg[k])
    .find((r) => r.arch && r.arch.chiave === scelto.chiave);
  if (gia) return { ok: true, reg: pubblica(gia), giaAperta: true };

  const regione = await s3Regione(a.bucket);
  const arch = { rec: p.rec, bucket: a.bucket, chiave: scelto.chiave, regione: regione, pezzo: i };
  const url = firmaConRegione(regione, scelto.chiave, {}, 3600, a.bucket);
  let durata = 0;
  try {
    durata = Math.round(+(await new Promise((ok, no) => {
      execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration",
                           "-of", "default=nw=1:nk=1", url],
               { timeout: 60000 }, (e, out) => e ? no(e) : ok(String(out).trim()));
    })) || 0);
  } catch (e) { durata = 0; }

  const r = {
    id: nuovoId("r"), evento: a.rec || "",
    titolo: (a.partita || "partita") + (pezzi.length > 1 ? " · " + (i + 1) + "ª parte" : ""),
    competizione: "", sorgente: "archivio", origine: "archivio", url: "",
    stato: "finita", avviata: Date.parse(a.quando) || Date.now(), finita: Date.now(),
    durata: durata, kickoff: (i === 0 && a.kickoff !== null && a.kickoff !== undefined)
      ? { "1": a.kickoff } : {},
    marker: [], chi: String(p.__chi || "").slice(0, 40), errore: "", arch: arch
  };
  assicura(cartellaReg(r.id));
  R.reg[r.id] = r; scrivi(); annuncia(0, "clip");
  return { ok: true, reg: pubblica(r) };
}

function fileArchivio() { return path.join(DIR, "archivio.json"); }
function leggiArchivio() {
  try { ARCHIVIO = JSON.parse(fs.readFileSync(fileArchivio(), "utf8")) || {}; }
  catch (e) { ARCHIVIO = {}; }
}
function scriviArchivio() {
  try {
    const tmp = fileArchivio() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(ARCHIVIO));
    fs.renameSync(tmp, fileArchivio());
  } catch (e) { console.log("[clip] indice archivio non salvato: " + e.message); }
}

async function archivioScandaglia(p) {
  if (!s3Acceso()) return { ok: false, errore: "l'archivio S3 non e' configurato" };
  const bucket = p.bucket || ARCH_BUCKET;
  const giorni = num(p.giorni, 1, 3650, 400);
  const limite = Date.now() - giorni * 86400000;
  const minimo = num(p.minimoMB, 1, 100000, 700) * 1000000;

  // 1) tutto l'archivio, non un ramo solo. Trecentomila oggetti si elencano
  //    in un minuto; quello che si tiene sono i file video abbastanza
  //    grossi da poter essere una partita, raggruppati per cartella-partita.
  const gruppi = {}, perGiorno = {};
  let visti = 0, tenuti = 0, ripresa = "", giri = 0;
  do {
    const pg = await s3Pagina(p.prefisso || "", ripresa, bucket, "");
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

  // 2) le partite di Airtable, appaiate per giorno e per nome
  const base = "https://api.airtable.com/v0/" + AT_BASE + "/" + AT_PARTITE;
  const formula = "AND(IS_AFTER({Data | Orario}, DATEADD(TODAY(), -" + Math.round(giorni) +
    ", 'days')), NOT({Partita} = BLANK()))";
  let offset = "", tornate = 0, agganciate = 0, conKickoff = 0, intere = 0;
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

  function aggancia(recId, nomePartita, nomeComp, quandoIso) {
    {
      tornate++;
      const f = { "Partita": nomePartita, "Competizione": nomeComp, "Data | Orario": quandoIso };
      const rec = { id: recId };
      const quando = Date.parse(quandoIso || "");
      if (!quando) return;
      const candidati = [];
      [0, -1, 1].forEach((salto) => {
        const g = new Date(quando + salto * 86400000);
        const chiave = g.getUTCFullYear() + String(g.getUTCMonth() + 1).padStart(2, "0") +
                       String(g.getUTCDate()).padStart(2, "0");
        (perGiorno[chiave] || []).forEach((x) => candidati.push(x));
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

      const pezzi = scelta.pezzi.map((x) => Object.assign({}, x, {
        da: daKickoffPezzo(x.file, quando)
      })).sort((x, y) => (x.da === null ? 0 : x.da) - (y.da === null ? 0 : y.da));
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
    const id = "s3:" + crypto.createHash("sha1").update(gr.dove).digest("hex").slice(0, 14);
    ARCHIVIO[id] = { orologio: orologiSoleS3[id], bucket: bucket, chiave: pezzi[0].chiave, peso: pezzi[0].peso,
      partita: gr.partita.replace(/[_]+/g, " ").trim(), competizione: comp.replace(/[_]+/g, " "),
      variante: "", giorno: g, dove: gr.dove, fonte: scelta.fonte, pezzi: pezzi,
      kickoff: null, sicuro: false, quando: quando, soloS3: true };
    soleS3++;
  });

  scriviArchivio();
  return { ok: true, oggettiVisti: visti, fileTenuti: tenuti,
           cartellePartita: Object.keys(gruppi).length,
           partiteViste: tornate, agganciate: agganciate, intere: intere, doppieAssorbite: assorbite, promosseAIntere: promosse,
           conKickoff: conKickoff, soloS3: soleS3, senzaAggancio: orfane.slice(0, 15) };
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
function sorgenteAudio(r) {
  if (r.arch) return viaArchivio(r);
  const integrale = path.join(cartellaReg(r.id), "integrale.mp4");
  if (fs.existsSync(integrale)) return integrale;
  const segs = segmenti(r.id);
  if (segs.length) return null;          // dai segmenti si passa per la lista
  return null;
}

function trascriviChiedi(p) {
  if (!whisperCe()) {
    return { ok: false, errore: "il motore di trascrizione non e' installato su questa macchina" };
  }
  const r = R.reg[String(p.reg || "")];
  if (!r) return { ok: false, errore: "registrazione sconosciuta" };
  const da = num(p.da, 0, MAX_SECONDI, 0);
  const durataTotale = r.durata || 0;
  const a = num(p.a, 0, MAX_SECONDI, durataTotale || (da + 600));
  if (a - da < 5) return { ok: false, errore: "un pezzo cosi' corto non ha niente da dire" };

  const gia = CODA_VOCE.find((x) => x.reg === r.id && x.da === da && x.a === a);
  if (gia || (voceAlLavoro && voceAlLavoro.reg === r.id && voceAlLavoro.da === da)) {
    return { ok: true, giaInCoda: true, quantiInCoda: CODA_VOCE.length + (voceAlLavoro ? 1 : 0) };
  }
  CODA_VOCE.push({ reg: r.id, da: da, a: a, chiesta: Date.now() });
  giraLaCoda();
  return { ok: true, inCoda: true, quantiInCoda: CODA_VOCE.length + (voceAlLavoro ? 1 : 0),
           minuti: Math.round((a - da) / 60) };
}

// Una alla volta, e mai sopra una diretta: due processori non si dividono
// in tre. Se c'e' una registrazione in corso la coda aspetta — l'archivio
// non scappa, la partita si'.
function giraLaCoda() {
  if (voceAlLavoro || !CODA_VOCE.length) return;
  const registrando = Object.keys(R.reg).some((k) => R.reg[k].stato === "registra");
  if (registrando) { setTimeout(giraLaCoda, 60000); return; }
  voceAlLavoro = CODA_VOCE.shift();
  trascriviDavvero(voceAlLavoro)
    .catch((e) => console.log("[clip] trascrizione fallita: " + e.message))
    .then(() => { voceAlLavoro = null; annuncia(0, "clip"); setTimeout(giraLaCoda, 1000); });
}

// I nomi propri sono quelli che il modello sbaglia — "Henry Kane" per Harry
// Kane, "o Lise" per Olise — ed e' un peccato, perche' sono esattamente le
// parole che poi si cercano. La cura e' dirglieli prima: i cognomi stanno
// gia' negli appunti di quella partita, scritti da chi guardava.
function nomiDaSuggerire(r) {
  const a = ARCHIVIO[r.evento] ? APPUNTI[r.evento] : APPUNTI[r.evento];
  const parole = new Set();
  (r.titolo || "").split(/[^A-Za-zÀ-ÿ]+/).forEach((w) => { if (w.length > 3) parole.add(w); });
  if (a) {
    a.righe.forEach((x) => {
      String(x.x || "").split(/[^A-Za-zÀ-ÿ']+/).forEach((w) => {
        // i cognomi in una riga di appunti sono le parole con la maiuscola
        // gli appunti sono scritti in maiuscolo, e passando "KANE" al
        // modello si ottiene un modello che urla: si rimette la forma
        // normale di un cognome, che e' quella che poi si cerca
        if (w.length > 3 && w[0] === w[0].toUpperCase()) {
          parole.add(w[0].toUpperCase() + w.slice(1).toLowerCase());
        }
      });
    });
  }
  // le rose di ESPN hanno la grafia ufficiale: sono i nomi migliori
  const e = ESPN[r.evento];
  if (e && e.rose) Object.keys(e.rose).forEach((sq) => e.rose[sq].forEach((n) => {
    const cognome = String(n).split(/\s+/).pop(); if (cognome && cognome.length > 2) parole.add(cognome);
  }));
  const lista = [...parole].slice(0, 80).join(", ");
  return lista ? ("Telecronaca di calcio. Nomi: " + lista + ".") : "";
}

function trascriviDavvero(lavoro) {
  const r = R.reg[lavoro.reg];
  if (!r) return Promise.reject(new Error("registrazione sparita"));
  const via = sorgenteAudio(r);
  const dir = cartellaReg(r.id);
  const wav = path.join(dir, "voce.wav");
  const partenza = Date.now();

  return new Promise((ok, no) => {
    // audio solo, mono, sedicimila: e' quello che vuole il modello, e pesa
    // un centesimo del video
    const args = via
      ? ["-hide_banner", "-loglevel", "error", "-ss", String(lavoro.da), "-i", via,
         "-t", String(lavoro.a - lavoro.da), "-vn", "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-y", wav]
      : null;
    if (!args) return no(new Error("di questa registrazione non c'e' audio raggiungibile"));
    execFile("ffmpeg", args, { timeout: 3600000 }, (e) => e ? no(e) : ok());
  }).then(() => new Promise((ok, no) => {
    const suggeriti = nomiDaSuggerire(r);
    const args = ["-m", MODELLO, "-l", LINGUA_MAM, "-f", wav, "-oj", "-of",
                  path.join(dir, "voce"), "-t", "2", "-np", "-nt"];
    if (suggeriti) args.push("--prompt", suggeriti);
    execFile(WHISPER, args,
             { timeout: 6 * 3600000, maxBuffer: 64 * 1024 * 1024 }, (e) => e ? no(e) : ok());
  })).then(() => {
    const j = JSON.parse(fs.readFileSync(path.join(dir, "voce.json"), "utf8"));
    const pezzi = (j.transcription || []).map((t) => ({
      a: Math.round((t.offsets.from / 1000 + lavoro.da) * 10) / 10,
      b: Math.round((t.offsets.to / 1000 + lavoro.da) * 10) / 10,
      x: String(t.text || "").trim()
    })).filter((t) => t.x);

    const dentro = PARLATO[r.id] || (PARLATO[r.id] = { lingua: LINGUA_MAM, pezzi: [] });
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
    const capo = comeSiCerca([r.titolo, r.competizione]);
    if (!quandoTorna(r.avviata, q)) return;
    PARLATO[regId].pezzi.forEach((t) => {
      if (!tutteDentro(comeSiCerca([t.x, capo]), q.parole)) return;
      fuori.push({ reg: regId, partita: r.titolo, secondi: t.a, testo: t.x,
                   quando: r.avviata });
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
        quando: f["Data | Orario"] || "",
        righe: note.map((n) => ({
          m: n.minuto, t: n.tipo, x: n.testo.slice(0, 180), s: n.sezione,
          d: n.dentroTempo, hl: n.hl ? 1 : 0
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
      const tele = (f[ST.telecronista] && f[ST.telecronista].name) || f[ST.telecronista] || "";
      eventi.push({ id: rec.id, partita: partita, competizione: String(comp).trim(), quando: quando });
      const note = leggiAppunti(f[ST.appunti] || "", 45);
      if (!note.length) { if (APPUNTI[rec.id] && APPUNTI[rec.id].fonte === "storico") delete APPUNTI[rec.id]; return; }
      conRighe++; righe += note.length;
      APPUNTI[rec.id] = {
        partita: partita, competizione: String(comp).trim(), quando: quando, fonte: "storico",
        telecronista: String(tele).trim(),
        righe: note.map((n) => ({ m: n.minuto, t: n.tipo, x: n.testo.slice(0, 180), s: n.sezione, d: n.dentroTempo, hl: n.hl ? 1 : 0 }))
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
function secondoNelFile(rec, r) {
  const a = ARCHIVIO[rec];
  if (!a) return null;
  // secondi dal calcio d'inizio: il secondo tempo comincia un'ora dopo,
  // quarantacinque di gioco piu' un intervallo che nessuno cronometra
  // ...a meno che il cronometro non sia stato letto dal video: allora i due
  // tempi cominciano dove cominciano davvero (vedi calibraOrologio)
  const o = a.orologio || {};
  const inizio = r.s === 2 ? (o.inizio2 !== undefined && o.inizio2 !== null ? o.inizio2 : 60 * 60)
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
  return { pezzo: i, secondi: Math.round(t - pezzi[i].da), chiave: pezzi[i].chiave || a.chiave };
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
async function leggiOrologioSicuro(fascia, t) {
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
  return c1;
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
      const c = await leggiOrologioSicuro(leggiA, t); esito.letti += 2;
      if (c === null || c <= 0 || c >= 2700) continue;
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
    a.orologio = esito;
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
const CODA_OROLOGI = [];
let orologiFatti = 0, orologiFalliti = 0, orologiRipassati = false, orologiInMoto = 0, orologiRimandati = 0;
const OROLOGI_INSIEME = 2;          // due partite alla volta: ffmpeg e tesseract pesano poco, S3 aspetta
// prima il Como, poi le partite piu' recenti: e' l'ordine in cui servono
function prioritaPartita(rec) {
  const a = ARCHIVIO[rec] || {};
  const como = /\bCOMO\b/i.test(a.partita || "") ? 0 : 1;
  return como * 1e13 + (1e13 - (Date.parse(a.quando) || 0));
}
function giraOrologi() {
  if (orologiInMoto >= OROLOGI_INSIEME) return;
  // a coda finita, le partite non lette si ritentano una volta: un sondaggio
  // caduto su un replay o su una grafica spenta la seconda volta cade altrove
  if (!CODA_OROLOGI.length) {
    if (!orologiInMoto && orologiFalliti && !orologiRipassati) { orologiRipassati = true; orologiInCoda(); }
    return;
  }
  const registrando = Object.keys(R.reg).some((k) => R.reg[k].stato === "registra");
  if (registrando) { setTimeout(giraOrologi, 60000); return; }
  // le durate cambiano il materiale: leggere il cronometro nel frattempo
  // vuol dire prendere i due fotogrammi da file diversi. Si aspetta che
  // finiscano (un'ora), e intanto la macchina respira
  if (CODA_DURATE.length || durateInMoto) { setTimeout(giraOrologi, 60000); return; }
  const rec = CODA_OROLOGI.shift();
  orologiInMoto++;
  calibraOrologio(rec).then(() => { orologiFatti++; })
    .catch((e) => { orologiFalliti++; console.log("[clip] cronometro non letto (" + rec + "): " + e.message); })
    .then(() => { orologiInMoto--; setTimeout(giraOrologi, 500); });
  setTimeout(giraOrologi, 3000);       // e intanto parte la seconda
}
function orologiInCoda() {
  if (!CODA_OROLOGI.length) orologiRipassati = false;
  const gia = new Set(CODA_OROLOGI);
  Object.keys(APPUNTI).forEach((rec) => {
    const a = ARCHIVIO[rec];
    if (!a || a.orologio || gia.has(rec)) return;
    if (!(APPUNTI[rec].righe || []).length) return;
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
  if (++durateDaScrivere >= 20) { durateDaScrivere = 0; scriviArchivio(); }
}
function giraDurate() {
  if (durateInMoto >= DURATE_INSIEME || !CODA_DURATE.length) { if (!CODA_DURATE.length && !durateInMoto) scriviArchivio(); return; }
  const registrando = Object.keys(R.reg).some((k) => R.reg[k].stato === "registra");
  if (registrando) { setTimeout(giraDurate, 60000); return; }
  const rec = CODA_DURATE.shift();
  durateInMoto++;
  misuraPartita(rec).then(() => { durateFatte++; })
    .catch((e) => { durateFallite++; console.log("[clip] durate non misurate (" + rec + "): " + e.message); })
    .then(() => { durateInMoto--; setTimeout(giraDurate, 200); });
  setTimeout(giraDurate, 1500);
}
function durateInCoda() {
  const gia = new Set(CODA_DURATE);
  Object.keys(ARCHIVIO).forEach((rec) => {
    const a = ARCHIVIO[rec];
    if (a.misurato || gia.has(rec)) return;
    CODA_DURATE.push(rec);
  });
  // stesso ordine dei cronometri, cosi' le durate stanno sempre davanti
  CODA_DURATE.sort((x, y) => prioritaPartita(x) - prioritaPartita(y));
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
    const oggi = new Date(), viste = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(oggi.getTime() - i * 86400000);
      const g = d.getUTCFullYear() + ("0" + (d.getUTCMonth() + 1)).slice(-2) + ("0" + d.getUTCDate()).slice(-2);
      const pg = await s3Pagina("TEMP/" + g + "/", "", ARCH_BUCKET, "/");
      (pg.cartelle || []).forEach((c) => viste.push(c));
    }
    const firma = viste.sort().join("|");
    const ora = new Date().getHours();
    const nuove = cartelleRecenti !== null && firma !== cartelleRecenti;
    cartelleRecenti = firma;
    if (!nuove && !(ora === 5 && !ultimoScandaglioOggi())) return;
    scandaglioInCorso = true;
    console.log("[clip] archivio: " + (nuove ? "cartelle nuove su S3" : "giro delle cinque") + ", rifaccio l'indice");
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
let ESPN = {}, RITARDI = {};
function fileEspn() { return path.join(DIR, "espn.json"); }
function fileRitardi() { return path.join(DIR, "ritardi.json"); }
function leggiEspn() {
  try { ESPN = JSON.parse(fs.readFileSync(fileEspn(), "utf8")) || {}; } catch (e) { ESPN = {}; }
  try { RITARDI = JSON.parse(fs.readFileSync(fileRitardi(), "utf8")) || {}; } catch (e) { RITARDI = {}; }
}
function scriviEspn() {
  try { fs.writeFileSync(fileEspn() + ".tmp", JSON.stringify(ESPN)); fs.renameSync(fileEspn() + ".tmp", fileEspn()); } catch (e) {}
  try { fs.writeFileSync(fileRitardi(), JSON.stringify(RITARDI)); } catch (e) {}
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
function squadreDi(partita) {
  const t = String(partita || "").replace(/\[[^\]]*\]|\(.*?\)/g, " ").replace(/\s\d+\s*-\s*\d+.*$/, "").trim();
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
      // tutte e due le squadre: una sola combacia anche con la partita sbagliata
      if (buoni.length && buoni[0].n >= Math.min(2, squadre.length)) { trovato = buoni[0].ev; legaTrovata = lega; break; }
    }
    if (trovato) break;
  }
  if (!trovato) { ESPN[rec] = { mancante: "non trovata su ESPN", quando: info.quando }; return ESPN[rec]; }
  const sm = await espnPrendi("https://site.api.espn.com/apis/site/v2/sports/soccer/" + legaTrovata + "/summary?event=" + trovato.id);
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
                squadre: casaOsp, eventi: eventi, rose: rose, letto: new Date().toISOString() };
  misuraRitardo(rec);
  return ESPN[rec];
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
  });
}
function ritardoDi(telecronista) {
  const r = RITARDI[telecronista || ""];
  if (!r || r.valori.length < 6) return 0;
  const v = r.valori.slice().sort((x, y) => x - y);
  const med = v[Math.floor(v.length / 2)];
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
function cercaNeiFatti(q, limite) {
  const fuori = [];
  Object.keys(ESPN).forEach((rec) => {
    const e = ESPN[rec];
    if (!e || !e.eventi) return;
    const info = espnDatiDi(rec) || {};
    const quando = info.quando || e.quando;
    if (!quandoTorna(Date.parse(quando), q)) return;
    const capo = comeSiCerca([info.partita, info.competizione, dataScritta(Date.parse(quando))]);
    e.eventi.forEach((x) => {
      const testo = comeSiCerca([x.tipo, x.giocatore, x.squadra, x.testo, capo]);
      if (!tutteDentro(testo, q.parole)) return;
      const d = (x.min - (x.periodo === 2 ? 45 : 0)) * 60 + x.stopp * 60;
      const dove = secondoNelFile(rec, { s: x.periodo, d: Math.max(0, d) });
      fuori.push({
        rec: rec, partita: info.partita || e.nome, competizione: info.competizione || "", quando: quando,
        minuto: x.min + (x.stopp ? "+" + x.stopp : "'"), tempo: x.periodo, tipo: x.tipo,
        testo: [x.tipo, x.giocatore, x.squadra ? "(" + x.squadra + ")" : ""].filter(Boolean).join(" "),
        hl: false, fonte: "espn", archivio: !!ARCHIVIO[rec], dove: (dove || {}).secondi || null,
        pezzo: (dove || {}).pezzo || 0, d: Math.max(0, d),
        orologio: !!(ARCHIVIO[rec] && ARCHIVIO[rec].orologio)
      });
    });
  });
  return fuori;
}

function cercaNegliAppunti(q, limite) {
  const fuori = [];
  Object.keys(APPUNTI).forEach((rec) => {
    const a = APPUNTI[rec];
    const capo = comeSiCerca([a.partita, a.competizione, dataScritta(Date.parse(a.quando))]);
    if (!quandoTorna(Date.parse(a.quando), q)) return;
    a.righe.forEach((r) => {
      const testo = comeSiCerca([r.x, r.t, r.m, capo]);
      if (!tutteDentro(testo, q.parole)) return;
      const rit = ritardoDi(a.telecronista);
      const dove = secondoNelFile(rec, { s: r.s, d: Math.max(0, (r.d || 0) - rit) });
      fuori.push({
        rec: rec, partita: a.partita, competizione: a.competizione, quando: a.quando,
        minuto: r.m, tempo: r.s, tipo: r.t, testo: r.x, hl: !!r.hl,
        fonte: a.fonte === "storico" ? "storico" : "appunti", telecronista: a.telecronista || "",
        archivio: !!ARCHIVIO[rec], dove: (dove || {}).secondi || null,
        pezzo: (dove || {}).pezzo || 0, d: Math.max(0, (r.d || 0) - rit),
        orologio: !!(ARCHIVIO[rec] && ARCHIVIO[rec].orologio)
      });
    });
  });
  cercaNeiFatti(q, limite).forEach((x) => fuori.push(x));
  fuori.sort((a, b) => ((Date.parse(b.quando) || 0) - (Date.parse(a.quando) || 0)) ||
                       ((a.tempo || 0) - (b.tempo || 0)) || ((a.d || 0) - (b.d || 0)));
  return fuori.slice(0, limite);
}

// ── i file: playlist, segmenti, clip ──────────────────────────────────

const TIPI = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4",
               ".xml": "application/xml", ".jpg": "image/jpeg" };

function serviHttp(req, res, u) {
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
      "Cache-Control": est === ".m3u8" ? "no-store" : "public, max-age=86400",
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

const FORMATI_DETTI = { "verticale": "9:16", "verticali": "9:16", "story": "9:16",
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
    if (/^(9:16|16:9|3:4)$/.test(p)) { fuori.formato = p; return; }
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

function clipCerca(p) {
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

  return {
    ok: true,
    domanda: { parole: q.parole, formato: q.formato, genere: q.genere, quando: q.quando },
    quante: partite.length + clip.length + segni.length + azioni.length + dette.length + archivio.length,
    azioni: azioni, dette: dette, archivio: archivio,
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
    da = viaArchivio(r);
    quando = ((r.kickoff && r.kickoff["1"]) || 300) + 600;
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

function anello() {
  const limite = Date.now() - GIORNI * 86400000;
  let tolti = 0;

  // Le registrazioni che non hanno mai ricevuto un byte non sono materiale:
  // sono ascolti aperti e richiusi, prove, tentativi. Lasciarle in elenco
  // riempie la colonna delle partite di righe da zero secondi tutte uguali,
  // e chi cerca la partita di ieri non la trova piu'. Dopo dieci minuti se
  // ne vanno da sole, con la loro cartella vuota.
  const vecchie = Date.now() - 600000;
  Object.keys(R.reg).forEach((k) => {
    const r = R.reg[k];
    if (r.stato === "registra" || r.stato === "carica" || PROC.get(r.id)) return;
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
  "clip-cerca": clipCerca,
  "clip-archivio-stato": async () => {
    if (!s3Acceso()) return { ok: true, acceso: false };
    return { ok: true, acceso: true, bucket: S3.bucket, regione: await s3Regione() };
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
    const via = r.arch ? viaArchivio(r)
      : fs.existsSync(path.join(cartellaReg(r.id), "integrale.mp4")) ? path.join(cartellaReg(r.id), "integrale.mp4")
      : (segmenti(r.id).length ? playlistDi(r.id) : null);
    if (!via) return no(new Error("di questa registrazione non c'e' materiale da cui prendere un fotogramma"));
    const nome = "f" + nuovoId("") + ".jpg", fuori = path.join(DIR, CARTELLA_CLIP, nome);
    execFile(FFMPEG, ["-hide_banner", "-loglevel", "error", "-ss", String(sec), "-i", via,
                      "-frames:v", "1", "-q:v", "2", "-y", fuori], { timeout: 60000 },
      (e) => e ? no(new Error("fotogramma non riuscito: " + e.message))
               : ok({ ok: true, file: "/clip/" + CARTELLA_CLIP + "/" + nome, secondi: sec }));
  }),
  "clip-trascrivi": trascriviChiedi,
  "clip-parlato": (p) => {
    const d = PARLATO[String(p.reg || "")];
    return { ok: true, pezzi: (d && d.pezzi) || [],
             inCorso: !!(voceAlLavoro && voceAlLavoro.reg === p.reg),
             inCoda: CODA_VOCE.filter((x) => x.reg === p.reg).length,
             motore: whisperCe() };
  },
  "clip-archivio-scandaglia": archivioScandaglia,
  "clip-appunti-storici": appuntiStoriciImporta,
  // legge il cronometro di una partita (o restituisce quello gia' letto) e
  // dice dove cade un minuto degli appunti, se glielo si chiede
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
    const rit = {}; Object.keys(RITARDI).forEach((t) => { rit[t] = { n: RITARDI[t].valori.length, secondi: ritardoDi(t) }; });
    return { ok: true, inCoda: CODA_ESPN.length, fatti: espnFatti, trovati: espnTrovati, falliti: espnFalliti,
             inMoto: espnInMoto, partiteConFatti: Object.keys(ESPN).filter((k) => ESPN[k] && ESPN[k].eventi).length,
             mancanti: Object.keys(ESPN).filter((k) => ESPN[k] && ESPN[k].mancante).length, ritardi: rit };
  },
  "clip-archivio-espn-partita": async (p) => {
    const e = await espnTrova(String(p.rec || "")); scriviEspn(); return { ok: true, espn: e };
  },
  "clip-archivio-durate": (p) => {
    if (p.avvia) durateInCoda();
    return { ok: true, inCoda: CODA_DURATE.length, fatte: durateFatte, fallite: durateFallite, cambiate: durateCambiate,
             inMoto: durateInMoto, misurate: Object.keys(ARCHIVIO).filter((k) => ARCHIVIO[k].misurato).length };
  },
  "clip-archivio-orologi": (p) => {
    if (p.avvia) orologiInCoda();
    return { ok: true, inCoda: CODA_OROLOGI.length, fatti: orologiFatti, falliti: orologiFalliti,
             alLavoro: orologioAlLavoro || "", inMoto: orologiInMoto, lettore: tesseractCe(),
             letti: Object.keys(ARCHIVIO).filter((k) => ARCHIVIO[k].orologio).length };
  },
  "clip-archivio-apri": archivioApri,
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
      return { rec: rec, titolo: a.partita, quando: a.quando, variante: a.variante,
               competizione: a.competizione || "", soloS3: !!a.soloS3,
               dataSospetta: !!a.soloS3 && ms > domani,
               pezzi: (a.pezzi || []).length || 1, sicuro: !!a.sicuro,
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
  "clip-hl-genera": hlGenera,
  "clip-hl-elenco": hlElenco,
  "clip-hl-pezzo": hlPezzo,
  "clip-hl-dividi": hlDividi,
  "clip-hl-inserisci": hlInserisci,
  "clip-hl-nuova": hlNuova,
  "clip-hl-imposta": hlImposta,
  "clip-hl-aggiungi": hlAggiungi,
  "clip-hl-suggerimento": hlSuggerimento,
  "clip-hl-ordina": hlOrdina,
  "clip-hl-taratura": hlTaratura,
  "clip-hl-esporta": hlEsporta,
  "clip-hl-elimina": hlElimina,
  "clip-integrale": clipIntegrale,
  "clip-anello": () => ({ ok: true, tolti: anello() }),
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

function azione(p) {
  const f = AZIONI[p.tipo];
  if (!f) throw new Error("tipo di invio sconosciuto: " + p.tipo);
  return f(p);
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
