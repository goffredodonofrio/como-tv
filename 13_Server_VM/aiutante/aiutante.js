#!/usr/bin/env node
/*
 * ═══════════════════════════════════════════════════════════════════
 *  AIUTANTE MAM COMO TV — gli export sul computer di chi monta
 * ═══════════════════════════════════════════════════════════════════
 *
 *  (01/10/2026, Goffredo: "velocizzare export e invii in regia, usare le
 *  risorse del computer locale", per Mac e Windows.)
 *
 *  La VM del MAM ha due core e nessuna scheda video, e la NAS del club la
 *  legge da lontano: un 1080p50 esce a 0,66 volte il tempo reale. Il computer
 *  in ufficio sta sulla stessa rete della NAS e ha un codificatore hardware
 *  (VideoToolbox sul Mac, NVENC / QuickSync / AMF su Windows).
 *
 *  Come funziona: la pagina dell'Editing chiede al ponte la RICETTA del
 *  montato (i file sulla NAS con entrata e uscita, il formato, gli stacchi,
 *  le grafiche) e la passa qui. L'aiutante legge i file dalla NAS montata
 *  (se non c'e', attraverso il ponte: piu' lento ma funziona), monta e
 *  codifica in un solo passaggio di ffmpeg, salva una copia nella cartella
 *  "MAM Export" dei Download e carica il file sul ponte: li' diventa un'uscita
 *  come quelle della VM e puo' andare in regia.
 *
 *  Ascolta SOLO sul computer stesso (127.0.0.1) e risponde solo alle pagine
 *  del MAM. Nessuna dipendenza: Node (18 o piu') e ffmpeg.
 *
 *    node aiutante.js            avvia
 *    node aiutante.js --prova    dice cosa vede (ffmpeg, codificatore, NAS) ed esce
 */
"use strict";
const http = require("http"), https = require("https"), fs = require("fs"), path = require("path");
const os = require("os"), cp = require("child_process");

const VERSIONE = "0.1.0";
const WIN = process.platform === "win32", MAC = process.platform === "darwin";

// ── la configurazione: un file accanto all'utente, scritto la prima volta ──
const CONF_FILE = process.env.COMOTV_AIUTANTE_CONF ||
                  (WIN ? path.join(process.env.APPDATA || os.homedir(), "ComoTV-Aiutante.json")
                       : path.join(os.homedir(), ".comotv-aiutante.json"));
const PREDEF = {
  porta: 47800,
  ffmpeg: "", ffprobe: "",            // vuoti: li cerca da solo
  // dove si vede la NAS su questo computer (si cambia qui se e' montata altrove)
  radici: MAC ? { vod: "/Volumes/COMOTV - VOD", frame: "/Volumes/COMOTV - FRAME" }
       : WIN ? { vod: "\\\\QNAP100\\COMOTV - VOD", frame: "\\\\QNAP100\\COMOTV - FRAME" }
             : { vod: "/mnt/qnap100", frame: "/mnt/qnap100-frame" },
  cartella: path.join(os.homedir(), "Downloads", "MAM Export"),
  // le pagine che possono chiedere lavoro, e i ponti da cui si scarica e su cui si carica
  origini: ["https://projects-cloud.it"],
  codificatore: "",                    // vuoto: il piu' veloce che funziona
  bitrate: "16M"
};
function leggiConf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF_FILE, "utf8")) || {}; } catch (e) {
    try { fs.writeFileSync(CONF_FILE, JSON.stringify(PREDEF, null, 2)); } catch (z) {}
  }
  const conf = Object.assign({}, PREDEF, c);
  conf.radici = Object.assign({}, PREDEF.radici, c.radici || {});
  return conf;
}
const CONF = leggiConf();

function log() {
  const t = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log.apply(console, ["[" + t + "]"].concat([].slice.call(arguments)));
}

// ── ffmpeg: dove sta (lanciato all'accensione il PATH e' corto) ──
function trova(nome) {
  const voluto = CONF[nome];
  if (voluto && fs.existsSync(voluto)) return voluto;
  const exe = WIN ? nome + ".exe" : nome;
  const posti = WIN
    ? [path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", exe), "C:\\ffmpeg\\bin\\" + exe, path.join(__dirname, exe)]
    : ["/opt/homebrew/bin/" + exe, "/usr/local/bin/" + exe, "/usr/bin/" + exe, path.join(__dirname, exe)];
  for (const p of posti) if (p && fs.existsSync(p)) return p;
  try {
    const out = cp.execFileSync(WIN ? "where" : "which", [exe], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const r = out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (r) return r;
  } catch (e) {}
  return null;
}
const FFMPEG = trova("ffmpeg"), FFPROBE = trova("ffprobe");

// ── il codificatore: il primo hardware che funziona davvero, se no il processore ──
const CANDIDATI = MAC ? ["h264_videotoolbox"] : WIN ? ["h264_nvenc", "h264_qsv", "h264_amf"] : [];
function argsCodifica(c) {
  const b = CONF.bitrate || "16M", m = String(Math.round(parseInt(b, 10) * 1.4)) + "M";
  switch (c) {
    case "h264_videotoolbox": return ["-c:v", c, "-b:v", b, "-maxrate", m, "-bufsize", m, "-profile:v", "high", "-allow_sw", "1", "-pix_fmt", "yuv420p"];
    case "h264_nvenc": return ["-c:v", c, "-preset", "p5", "-rc", "vbr", "-cq", "20", "-b:v", b, "-maxrate", m, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_qsv": return ["-c:v", c, "-preset", "faster", "-global_quality", "21", "-pix_fmt", "nv12"];
    case "h264_amf": return ["-c:v", c, "-quality", "speed", "-rc", "vbr_peak", "-b:v", b, "-maxrate", m, "-pix_fmt", "yuv420p"];
    default: return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p"];
  }
}
let CODIFICATORE = "libx264";
function scegliCodificatore() {
  if (!FFMPEG) return "libx264";
  const lista = CONF.codificatore ? [CONF.codificatore] : CANDIDATI;
  for (const c of lista) {
    const r = cp.spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25", "-t", "1"]
      .concat(argsCodifica(c)).concat(["-f", "null", "-"]), { timeout: 30000 });
    if (r.status === 0) return c;
  }
  return "libx264";
}

// ── la NAS: si vede? ──
function radiciViste() {
  const o = {};
  for (const [k, r] of Object.entries(CONF.radici)) { try { o[k] = fs.existsSync(r) && fs.readdirSync(r).length > 0; } catch (e) { o[k] = false; } }
  return o;
}
function fileLocale(sorg) {
  const r = CONF.radici[sorg.root];
  if (!r) return null;
  const f = path.join.apply(path, [r].concat(String(sorg.rel).split("/")));
  try { return fs.existsSync(f) ? f : null; } catch (e) { return null; }
}

// ── rete: scaricare un file piccolo, caricare il montato ──
function host(u) { try { const x = new URL(u); return x.protocol + "//" + x.host; } catch (e) { return ""; } }
function permesso(u) {
  const h = host(u);
  return !!h && (CONF.origini.indexOf(h) >= 0 || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
}
function scarica(url, dove) {
  return new Promise((ok, no) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "ComoTV-Aiutante/" + VERSIONE } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return no(new Error("scaricando una grafica: " + res.statusCode)); }
      const f = fs.createWriteStream(dove);
      res.pipe(f); f.on("finish", () => f.close(() => ok(dove))); f.on("error", no);
    });
    req.on("error", no);
    req.setTimeout(120000, () => req.destroy(new Error("scaricando una grafica: tempo scaduto")));
  });
}
function carica(url, file, L) {
  return new Promise((ok, no) => {
    const peso = fs.statSync(file).size;
    const u = new URL(url), mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": peso,
      "User-Agent": "ComoTV-Aiutante/" + VERSIONE, "X-Aiutante": os.hostname() } }, (res) => {
      let corpo = ""; res.on("data", (d) => { corpo += d; });
      res.on("end", () => { let j = null; try { j = JSON.parse(corpo); } catch (e) {}
        if (res.statusCode === 200 && j && j.ok) ok(j); else no(new Error((j && j.errore) || ("caricando: " + res.statusCode))); });
    });
    req.on("error", no);
    let mandati = 0;
    const lettore = fs.createReadStream(file);
    lettore.on("data", (d) => { mandati += d.length; L.avanza = 0.9 + 0.1 * (mandati / peso); L.fase = "carico sul MAM " + Math.round(mandati / peso * 100) + "%"; });
    L.ferma = () => { try { req.destroy(new Error("annullato")); } catch (e) {} };
    lettore.pipe(req);
  });
}

// ── che file e': quanti canali audio, quanti fotogrammi al secondo ──
function sonda(input) {
  return new Promise((ok) => {
    if (!FFPROBE) return ok({ fps: 25, audio: true, canali: 2 });
    cp.execFile(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type,r_frame_rate,channels", "-of", "json", input],
      { timeout: 60000 }, (e, out) => {
        let st = []; try { st = JSON.parse(out).streams || []; } catch (z) {}
        const v = st.find((x) => x.codec_type === "video"), a = st.find((x) => x.codec_type === "audio");
        let fps = 25;
        if (v && v.r_frame_rate) { const [n, d] = v.r_frame_rate.split("/").map(Number); if (n && d) fps = n / d; }
        if (!(fps >= 10 && fps <= 61)) fps = 25;
        ok({ fps: Math.round(fps * 1000) / 1000, audio: !!a, canali: a ? (a.channels || 2) : 0 });
      });
  });
}

// ── la ricetta diventa UN comando di ffmpeg ──
//  Stesse regole dell'export della VM (clip.js, hlEsportaVideo): ogni pezzo
//  tagliato al fotogramma, alla misura del formato, coi suoi colori e la sua
//  velocita'; il nero nei buchi; gli stacchi sfumati; le grafiche sopra al loro
//  secondo; dei sei canali dello studio solo il programma (1-2).
function atempo(v) {
  const f = []; let r = v;
  while (r < 0.5) { f.push("atempo=0.5"); r /= 0.5; }
  while (r > 2) { f.push("atempo=2"); r /= 2; }
  if (Math.abs(r - 1) > 0.001) f.push("atempo=" + r.toFixed(4));
  return f;
}
async function comando(R, L, tmp) {
  const [W, H] = R.tela || [1920, 1080];
  const ingressi = [], fil = [], seg = [];
  let n = 0;
  // i file: dalla NAS montata se si vede, se no attraverso il ponte
  const sorgenti = R.pezzi.filter((z) => z.sorg).map((z) => {
    const loc = fileLocale(z.sorg);
    if (!loc && !permesso(z.sorg.url)) throw new Error("indirizzo non ammesso");
    return { z, input: loc || z.sorg.url, locale: !!loc };
  });
  L.daNas = sorgenti.filter((x) => x.locale).length; L.daRete = sorgenti.length - L.daNas;
  const prima = await sonda(sorgenti[0].input);
  const FPS = Math.min(50, prima.fps || 25);
  const sondate = new Map();
  for (const s of sorgenti) if (!sondate.has(s.input)) sondate.set(s.input, s === sorgenti[0] ? prima : await sonda(s.input));
  let i = 0;
  for (const z of R.pezzi) {
    if (z.nero) {
      ingressi.push("-f", "lavfi", "-t", String(z.nero), "-i", "color=c=black:s=" + W + "x" + H + ":r=" + FPS);
      ingressi.push("-f", "lavfi", "-t", String(z.nero), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      fil.push("[" + n + ":v]setsar=1,format=yuv420p,settb=1/90000,setpts=PTS-STARTPTS[v" + i + "]");
      fil.push("[" + (n + 1) + ":a]asetpts=PTS-STARTPTS[a" + i + "]");
      seg.push({ dur: z.nero, tr: null }); n += 2; i++; continue;
    }
    const s = sorgenti.find((x) => x.z === z), info = sondate.get(s.input) || {};
    const vel = +z.vel || 1, dur = Math.max(0.1, +z.dur || 0);
    ingressi.push("-ss", String(Math.max(0, z.da || 0)), "-t", (dur * vel + 0.08).toFixed(3), "-i", s.input);
    const fv = ["setpts=PTS-STARTPTS"];
    if (vel !== 1) fv.push("setpts=PTS/" + vel.toFixed(4));
    if (z.colore) fv.push("eq=brightness=" + (z.colore.lum || 0).toFixed(3) + ":contrast=" + (z.colore.con || 1).toFixed(3) + ":saturation=" + (z.colore.sat || 1).toFixed(3));
    if (z.vf) fv.push(z.vf);
    fv.push("scale=" + W + ":" + H + ":force_original_aspect_ratio=decrease:flags=lanczos", "pad=" + W + ":" + H + ":(ow-iw)/2:(oh-ih)/2:color=black",
            "setsar=1", "fps=" + FPS, "format=yuv420p", "trim=duration=" + dur.toFixed(3), "settb=1/90000", "setpts=PTS-STARTPTS");
    fil.push("[" + n + ":v]" + fv.join(",") + "[v" + i + "]");
    if (info.audio) {
      // la coppia di canali scelta (0 = il programma) o un canale solo, come panDi nel ponte
      const c = Math.max(1, info.canali || 2);
      const k = Math.max(0, Math.min(Math.floor((c - 1) / 2), parseInt(z.coppia || 0, 10) || 0));
      let cL = Math.min(c - 1, 2 * k), cR = c <= 1 ? 0 : Math.min(c - 1, 2 * k + 1);
      if (z.canale === "L") cR = cL; else if (z.canale === "R") cL = cR;
      const fa = ["pan=stereo|c0=c" + cL + "|c1=c" + cR];
      fa.push("aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo");
      fa.push.apply(fa, atempo(vel));
      fa.push("asetpts=PTS-STARTPTS", "apad", "atrim=0:" + dur.toFixed(3), "asetpts=PTS-STARTPTS");
      fil.push("[" + n + ":a:0]" + fa.join(",") + "[a" + i + "]");
      n += 1;
    } else {
      n += 1;
      ingressi.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
      fil.push("[" + n + ":a]asetpts=PTS-STARTPTS[a" + i + "]");
      n += 1;
    }
    seg.push({ dur, tr: R.conStacchi ? z.transizione : null });
    i++;
  }
  // gli stacchi: dissolvenze dove ci sono, se no si attacca
  let uv = "v0", ua = "a0", lungo = seg[0].dur;
  const conTr = seg.some((x, k) => k > 0 && x.tr);
  if (seg.length === 1) { /* niente da unire */ }
  else if (!conTr) {
    fil.push(seg.map((x, k) => "[v" + k + "][a" + k + "]").join("") + "concat=n=" + seg.length + ":v=1:a=1[vc][ac]");
    uv = "vc"; ua = "ac"; lungo = seg.reduce((t, x) => t + x.dur, 0);
  } else {
    for (let k = 1; k < seg.length; k++) {
      const tr = seg[k].tr; let D = tr ? +tr.durata : 0;
      D = Math.min(D, seg[k].dur - 0.2, lungo - 0.2);
      if (D > 0.06) {
        fil.push("[" + uv + "][v" + k + "]xfade=transition=" + (tr.tipo === "nero" ? "fadeblack" : "fade") + ":duration=" + D.toFixed(2) + ":offset=" + (lungo - D).toFixed(2) + "[xv" + k + "]");
        fil.push("[" + ua + "][a" + k + "]acrossfade=d=" + D.toFixed(2) + ":c1=tri:c2=tri[xa" + k + "]");
        lungo += seg[k].dur - D;
      } else {
        fil.push("[" + uv + "][v" + k + "]concat=n=2:v=1:a=0[xv" + k + "]");
        fil.push("[" + ua + "][a" + k + "]concat=n=2:v=0:a=1[xa" + k + "]");
        lungo += seg[k].dur;
      }
      uv = "xv" + k; ua = "xa" + k;
    }
  }
  // un endtag oltre l'ultima clip allunga il montato: sotto, nero e silenzio
  if (R.oltre > 0.04) {
    fil.push("[" + uv + "]tpad=stop_mode=add:stop_duration=" + R.oltre.toFixed(3) + ":color=black[vt]"); uv = "vt";
    fil.push("[" + ua + "]apad=pad_dur=" + R.oltre.toFixed(3) + "[at]"); ua = "at";
    lungo += R.oltre;
  }
  // le grafiche: scaricate prima (sono piccole), sopra al loro secondo
  for (const [k, g] of (R.grafiche || []).entries()) {
    if (!permesso(g.url)) throw new Error("indirizzo non ammesso");
    L.fase = "scarico le grafiche (" + (k + 1) + " di " + R.grafiche.length + ")";
    const f = await scarica(g.url, path.join(tmp, "g" + k + path.extname(g.nome || ".png")));
    ingressi.push("-i", f);
    const kk = Math.min(W / (g.w || W), H / (g.h || H));
    const w2 = Math.max(2, Math.round((g.w || W) * kk / 2) * 2), h2 = Math.max(2, Math.round((g.h || H) * kk / 2) * 2);
    const x = Math.round((W - w2) / 2), y = Math.round((H - h2) / 2);
    const pre = g.animata ? "setpts=PTS-STARTPTS+" + (+g.dentro).toFixed(3) + "/TB," : "";
    fil.push("[" + n + ":v]" + pre + "scale=" + w2 + ":" + h2 + (g.animata ? ",format=yuva420p" : "") + "[g" + k + "]");
    fil.push("[" + uv + "][g" + k + "]overlay=" + x + ":" + y + ":enable='between(t," + (+g.dentro).toFixed(2) + "," + (+g.fuori).toFixed(2) + ")'" + (g.animata ? ":eof_action=pass" : "") + ":format=auto[go" + k + "]");
    uv = "go" + k; n++;
  }
  const uscita = path.join(tmp, "montato.mp4");
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-nostats"]
    .concat(ingressi).concat(["-filter_complex", fil.join(";"), "-map", "[" + uv + "]", "-map", "[" + ua + "]"])
    .concat(argsCodifica(CODIFICATORE)).concat(["-r", String(FPS), "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", uscita]);
  return { args, uscita, durata: lungo };
}

// ── i lavori: uno alla volta, ognuno con la sua fase e il suo Annulla ──
const LAVORI = [];
let GIRA = false;
function vista(L) {
  return { id: L.id, titolo: L.titolo, formato: L.formato, stato: L.stato, fase: L.fase, avanza: Math.round((L.avanza || 0) * 1000) / 1000,
           errore: L.errore || "", locale: L.locale || "", creato: L.creato, finito: L.finito || 0, secondi: L.secondi || 0,
           codificatore: L.codificatore || "", daNas: L.daNas || 0, daRete: L.daRete || 0, invio: L.invio || "" };
}
async function lavora() {
  if (GIRA) return; GIRA = true;
  try {
    let L;
    while ((L = LAVORI.find((x) => x.stato === "in coda"))) {
      L.stato = "lavora"; L.fase = "preparo"; const t0 = Date.now();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "comotv-"));
      try {
        const c = await comando(L.ricetta, L, tmp);
        if (L.annullato) throw new Error("annullato");
        L.fase = "monto e codifico"; L.codificatore = CODIFICATORE;
        log("export \"" + L.titolo + "\" " + L.formato + " con " + CODIFICATORE + " (" + L.daNas + " pezzi dalla NAS, " + L.daRete + " dalla rete)");
        await new Promise((ok, no) => {
          const pr = cp.spawn(FFMPEG, c.args, { stdio: ["ignore", "pipe", "pipe"] });
          L.ferma = () => { try { pr.kill(WIN ? undefined : "SIGKILL"); } catch (e) {} };
          let err = "", buf = "";
          pr.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
          pr.stdout.on("data", (d) => {
            buf += d; const righe = buf.split("\n"); buf = righe.pop();
            for (const r of righe) { const m = /^out_time_us=(\d+)/.exec(r);
              if (m) { const s = +m[1] / 1e6; L.avanza = Math.min(0.88, 0.02 + 0.86 * s / Math.max(1, c.durata)); L.fase = "monto e codifico " + Math.round(Math.min(1, s / Math.max(1, c.durata)) * 100) + "%"; } }
          });
          pr.on("error", no);
          pr.on("close", (code) => code === 0 ? ok() : no(new Error(L.annullato ? "annullato" : (err.trim().split("\n").pop() || "ffmpeg " + code).slice(0, 300))));
        });
        if (L.annullato) throw new Error("annullato");
        // una copia per chi monta, nei Download
        try {
          fs.mkdirSync(CONF.cartella, { recursive: true });
          const nome = String(L.ricetta.nome || (L.titolo + ".mp4")).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").slice(0, 150);
          L.locale = path.join(CONF.cartella, nome);
          fs.copyFileSync(c.uscita, L.locale);
        } catch (e) { log("copia nei Download non riuscita: " + e.message); }
        L.fase = "carico sul MAM"; L.avanza = 0.9;
        if (!permesso(L.ricetta.carica)) throw new Error("indirizzo di caricamento non ammesso");
        await carica(L.ricetta.carica, c.uscita, L);
        L.stato = "fatto"; L.fase = "pronto"; L.avanza = 1;
      } catch (e) {
        L.stato = L.annullato ? "annullato" : "errore"; L.errore = L.annullato ? "" : e.message; L.fase = L.annullato ? "annullato" : "non riuscito";
        log("export \"" + L.titolo + "\": " + (L.annullato ? "annullato" : "errore: " + e.message));
      } finally {
        L.finito = Date.now(); L.secondi = Math.round((L.finito - t0) / 1000); L.ferma = null;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
        if (L.stato === "fatto") log("export \"" + L.titolo + "\" pronto in " + L.secondi + " s");
      }
    }
  } finally { GIRA = false; }
}

// ── il servizio: solo 127.0.0.1, solo le pagine del MAM ──
function origineAmmessa(o) { return !o || CONF.origini.indexOf(o) >= 0 || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o); }
function rispondi(req, res, code, j) {
  const o = req.headers.origin;
  const h = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" };
  if (o && origineAmmessa(o)) {
    h["Access-Control-Allow-Origin"] = o; h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type"; h["Access-Control-Allow-Private-Network"] = "true"; h["Access-Control-Max-Age"] = "600";
  }
  res.writeHead(code, h); res.end(j === null ? "" : JSON.stringify(j));
}
function corpo(req) {
  return new Promise((ok, no) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 4e6) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (e) { no(new Error("richiesta illeggibile")); } }); req.on("error", no); });
}
let RADICI = radiciViste();
setInterval(() => { RADICI = radiciViste(); }, 60000);
const server = http.createServer(async (req, res) => {
  if (!origineAmmessa(req.headers.origin)) return rispondi(req, res, 403, { ok: false, errore: "pagina non ammessa" });
  if (req.method === "OPTIONS") return rispondi(req, res, 204, null);
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/salute") {
      return rispondi(req, res, 200, { ok: true, nome: "Aiutante MAM Como TV", versione: VERSIONE, computer: os.hostname(),
        sistema: MAC ? "Mac" : WIN ? "Windows" : process.platform, codificatore: CODIFICATORE, ffmpeg: !!FFMPEG, nas: RADICI,
        lavori: LAVORI.filter((x) => x.stato === "lavora" || x.stato === "in coda").length });
    }
    if (u.pathname === "/lavori") return rispondi(req, res, 200, { ok: true, lavori: LAVORI.slice(-30).reverse().map(vista) });
    if (u.pathname === "/esporta" && req.method === "POST") {
      const p = await corpo(req), R = p.ricetta;
      if (!FFMPEG) throw new Error("su questo computer manca ffmpeg");
      if (!R || !Array.isArray(R.pezzi) || !R.pezzi.length || !R.carica) throw new Error("ricetta incompleta");
      if (!permesso(R.carica)) throw new Error("indirizzo di caricamento non ammesso");
      const L = { id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), titolo: String(R.titolo || "montato").slice(0, 120),
                  formato: R.formato || "16:9", ricetta: R, stato: "in coda", fase: "in coda", avanza: 0, creato: Date.now(), invio: String(p.invio || "") };
      LAVORI.push(L); while (LAVORI.length > 60) LAVORI.shift();
      lavora();
      return rispondi(req, res, 200, { ok: true, lavoro: vista(L) });
    }
    if (u.pathname === "/annulla" && req.method === "POST") {
      const p = await corpo(req), L = LAVORI.find((x) => x.id === p.id);
      if (!L) throw new Error("lavoro sconosciuto");
      if (L.stato === "in coda") { L.annullato = true; L.stato = "annullato"; L.fase = "annullato"; L.finito = Date.now(); }
      else if (L.stato === "lavora") { L.annullato = true; if (L.ferma) L.ferma(); }
      return rispondi(req, res, 200, { ok: true, lavoro: vista(L) });
    }
    return rispondi(req, res, 404, { ok: false, errore: "non trovato" });
  } catch (e) { return rispondi(req, res, 400, { ok: false, errore: e.message }); }
});

function prova() {
  console.log("Aiutante MAM Como TV " + VERSIONE + " su " + os.hostname() + " (" + process.platform + ")");
  console.log("configurazione: " + CONF_FILE);
  console.log("ffmpeg: " + (FFMPEG || "NON TROVATO") + " · ffprobe: " + (FFPROBE || "NON TROVATO"));
  console.log("codificatore: " + CODIFICATORE);
  console.log("NAS: " + Object.entries(radiciViste()).map(([k, v]) => k + " " + (v ? "si vede" : "NON si vede") + " (" + CONF.radici[k] + ")").join(" · "));
}
CODIFICATORE = scegliCodificatore();
if (process.argv.indexOf("--prova") >= 0) { prova(); process.exit(0); }
server.on("error", (e) => { log("non riesco ad ascoltare sulla porta " + CONF.porta + ": " + e.message); process.exit(1); });
server.listen(CONF.porta, "127.0.0.1", () => {
  log("Aiutante MAM Como TV " + VERSIONE + " in ascolto su 127.0.0.1:" + CONF.porta + " · codificatore " + CODIFICATORE +
      " · NAS " + JSON.stringify(RADICI) + (FFMPEG ? "" : " · MANCA FFMPEG"));
});
