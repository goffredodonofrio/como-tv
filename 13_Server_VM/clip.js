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
const { spawn, execFile } = require("child_process");

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
  "4:3":  { vf: "crop=ih*4/3:ih,scale=1440:1080" },
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
const PORTE = [];
for (let i = 10001; i <= 10012; i++) PORTE.push(i);
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
    const usate = Object.keys(R.reg)
      .filter((k) => R.reg[k].stato === "registra" && R.reg[k].ascolto)
      .map((k) => R.reg[k].ascolto.porta);
    const porta = PORTE.find((x) => usate.indexOf(x) < 0);
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
  const preciso = !!p.preciso || !!ritaglio;

  const c = {
    id: nuovoId("c"),
    reg: r.id,
    evento: r.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    dentro: dentro, fuori: dentro + quanto, durata: quanto,
    troncata: fuori > registrato,
    formato: formato,
    preciso: preciso,
    tipo: String(p.tipoAzione || "").slice(0, 40),
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
  esegui(c, codifica(args, preciso, ritaglio), lista);
  return { ok: true, clip: c };
}

// Stessa clip, presa dall'integrale invece che dai segmenti: cambia solo da
// dove si leggono i byte.
function taglioDaIntegrale(r, p, dentro, fuori, durata) {
  const file = path.join(cartellaReg(r.id), "integrale.mp4");
  if (!fs.existsSync(file)) {
    throw new Error("di questa registrazione non c'e' piu' materiale sul disco");
  }
  const formato = FORMATI[p.formato] ? String(p.formato) : "16:9";
  const ritaglio = FORMATI[formato].vf;
  const preciso = !!p.preciso || !!ritaglio;
  const c = {
    id: nuovoId("c"), reg: r.id, evento: r.evento,
    titolo: String(p.titolo || "").slice(0, 160) || (r.titolo + " " + orologio(dentro)),
    dentro: dentro, fuori: fuori, durata: durata, troncata: false,
    formato: formato, preciso: preciso,
    tipo: String(p.tipoAzione || "").slice(0, 40),
    minuto: String(p.minuto || "").slice(0, 12),
    chi: String(p.__chi || p.chi || "").slice(0, 40),
    creata: Date.now(), stato: "lavora", peso: 0, da: "integrale"
  };
  R.clip[c.id] = c;
  scrivi();
  esegui(c, codifica(["-ss", String(dentro), "-i", file, "-t", String(durata)],
                     preciso, ritaglio), null);
  return { ok: true, clip: c };
}

// Come si scrive la clip: ricopiando i byte, o ricodificando quando il taglio
// deve essere preciso o l'immagine va ritagliata in verticale.
function codifica(args, preciso, ritaglio) {
  let fuori = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(args);
  if (!preciso) {
    fuori = fuori.concat(["-c", "copy", "-avoid_negative_ts", "make_zero"]);
  } else {
    if (ritaglio) fuori = fuori.concat(["-vf", ritaglio]);
    fuori = fuori.concat(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
                          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"]);
  }
  return fuori.concat(["-movflags", "+faststart"]);
}

function esegui(c, args, lista) {
  const fuoriFile = fileClip(c.id);
  const pr = spawn(FFMPEG, args.concat(["-y", fuoriFile]), { stdio: ["ignore", "ignore", "pipe"] });
  let coda = "";
  pr.stderr.on("data", (d) => { coda = (coda + d).slice(-2000); });
  pr.on("error", (e) => { c.stato = "errore"; c.errore = e.message; scrivi(); annuncia(0, "clip"); });
  pr.on("close", async (code) => {
    if (lista) { try { fs.unlinkSync(lista); } catch (e) {} }
    if (code === 0) {
      const d = await probe(fuoriFile);
      c.stato = "pronta"; c.peso = d.peso || 0;
      if (d.durata) c.durataVera = Math.round(d.durata * 100) / 100;
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
    materiale: fs.existsSync(playlistDi(r.id)) ? "segmenti"
             : (fs.existsSync(path.join(cartellaReg(r.id), "integrale.mp4")) ? "integrale" : "scaduto"),
    durata: r.stato === "registra" ? durataRegistrata(r.id) : (r.durata || durataRegistrata(r.id)),
    viva: vive
  });
}

function clipStato(p) {
  const soloReg = p && p.reg ? String(p.reg) : "";
  const reg = Object.keys(R.reg)
    .map((k) => pubblica(R.reg[k]))
    .filter((r) => !soloReg || r.id === soloReg)
    .sort((a, b) => b.avviata - a.avviata);
  const clip = Object.keys(R.clip)
    .map((k) => R.clip[k])
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
  return atLeggi("https://api.airtable.com/v0/" + AT_BASE + "/tblXKPRWFCLw5pVSt/" + recId);
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

// ── costruire la sequenza ─────────────────────────────────────────────

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

  const q = {
    id: nuovoId("s"),
    reg: r.id,
    titolo: String(p.titolo || "").slice(0, 160) || ("HL " + r.titolo),
    pezzi: tenuti,
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
  try { fs.unlinkSync(path.join(DIR, CARTELLA_HL, q.id + ".mp4")); } catch (e) {}
  delete R.seq[q.id];
  scrivi();
  return { ok: true };
}

// ── l'uscita 1: il video montato ──────────────────────────────────────
//
//  Ogni pezzo si ricodifica con gli stessi parametri e poi si incollano:
//  incollare pezzi codificati in modo diverso da' un file che si vede male
//  o non si vede affatto. Si paga qualche secondo di CPU e si dorme la notte.

async function hlEsportaVideo(q, formato) {
  const dir = path.join(DIR, CARTELLA_HL, q.id);
  assicura(dir);
  const r = R.reg[q.reg];
  const segs = segmenti(q.reg);
  const usaIntegrale = !segs.length;
  const integrale = path.join(cartellaReg(q.reg), "integrale.mp4");
  if (usaIntegrale && !fs.existsSync(integrale)) throw new Error("non c'e' piu' materiale per questa registrazione");

  const ritaglio = (FORMATI[formato] || FORMATI["16:9"]).vf;
  q.export = { stato: "lavora", formato: formato, fatti: 0, quanti: q.pezzi.length, file: "" };
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
    let args = ["-hide_banner", "-loglevel", "error", "-nostdin"].concat(ingresso);
    if (ritaglio) args = args.concat(["-vf", ritaglio]);
    args = args.concat(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                        "-r", "25", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
                        "-movflags", "+faststart", "-y", fuoriFile]);
    await new Promise((si, no) => {
      const pr = spawn(FFMPEG, args, { stdio: ["ignore", "ignore", "pipe"] });
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
  const finale = path.join(DIR, CARTELLA_HL, q.id + ".mp4");
  await new Promise((si, no) => {
    const pr = spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "concat", "-safe", "0", "-i", listaFin, "-c", "copy",
      "-movflags", "+faststart", "-y", finale], { stdio: "ignore" });
    pr.on("error", no);
    pr.on("close", (code) => code === 0 ? si() : no(new Error("incollatura fallita")));
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}   // i pezzi non servono piu'
  const d = await probe(finale);
  q.export = { stato: "pronto", formato: formato, fatti: q.pezzi.length, quanti: q.pezzi.length,
               file: "/clip/" + CARTELLA_HL + "/" + q.id + ".mp4",
               durata: d.durata ? Math.round(d.durata * 10) / 10 : 0, peso: d.peso || 0 };
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
  const via = String(percorso || "").trim() || (c1 ? integrale : nome);
  const info = c1 ? await probe(integrale) : {};
  // il ritmo si misura sul materiale, non si suppone: integrale se c'e',
  // altrimenti un segmento qualsiasi della registrazione
  const segs = segmenti(q.reg);
  const daMisurare = c1 ? integrale : (segs.length ? segs[Math.floor(segs.length / 2)].file : "");
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
  scrivi(); annuncia(0, "clip");
  return q.premiere;
}

async function hlEsporta(p) {
  const q = seqDi(p);
  if (!q.pezzi.length) throw new Error("la sequenza e' vuota");
  if (String(p.come) === "premiere") {
    return { ok: true, premiere: await hlEsportaPremiere(q, p.percorso) };
  }
  const formato = FORMATI[p.formato] ? String(p.formato) : "16:9";
  if (q.export && q.export.stato === "lavora") return { ok: true, export: q.export };
  // non si aspetta l'export per rispondere: la pagina guarda lo stato
  hlEsportaVideo(q, formato).catch((e) => {
    q.export = { stato: "errore", errore: e.message };
    scrivi(); annuncia(0, "clip");
  });
  return { ok: true, export: q.export };
}

// ── le sorgenti: la tabella AWS di Airtable ───────────────────────────
//
//  Non si cablano gli indirizzi qui dentro: cambiano a ogni stagione e chi
//  li aggiorna sta su Airtable, non sul ponte. Si leggono i campi cosi'
//  come sono e si tiene quello che ASSOMIGLIA a un flusso — cosi' se domani
//  una colonna cambia nome il menu non si svuota.

const AT_BASE = "appdDMcS8JQ4PTdLB";
const AT_AWS = "tblgZRXXCCWhI327U";
let SORG_CACHE = { quando: 0, dati: null };

function atLeggi(url) {
  return new Promise((si, no) => {
    const tok = process.env.COMOTV_AIRTABLE_PAT || "";
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

// ── i file: playlist, segmenti, clip ──────────────────────────────────

const TIPI = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".xml": "application/xml" };

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
      base["Content-Disposition"] = 'attachment; filename="' + pezzi[pezzi.length - 1] + '"';
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

// ── l'anello ──────────────────────────────────────────────────────────
//
//  Dodici partite in una sera sono una quarantina di giga: il disco della VM
//  ne regge una serata, non due. Il materiale delle registrazioni finite se
//  ne va da solo dopo qualche giorno; restano il record, i marker e le clip
//  gia' tagliate, che pesano niente e servono ancora.

function anello() {
  const limite = Date.now() - GIORNI * 86400000;
  let tolti = 0;
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
  "clip-hl-genera": hlGenera,
  "clip-hl-elenco": hlElenco,
  "clip-hl-pezzo": hlPezzo,
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
  console.log("[clip] Clip Live acceso, cartella " + DIR +
              " — fino a " + MAX_REG + " registrazioni, materiale per " + GIORNI + " giorni, " +
              Math.round(liberiGB()) + " GB liberi");
  return true;
}

module.exports = { attivo: () => ATTIVO, avvio, azione, serviHttp };
