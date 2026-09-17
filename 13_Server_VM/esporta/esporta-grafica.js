#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  ESPORTA GRAFICA — una grafica live diventa un file video
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Per la post-produzione: la stessa grafica che va in onda, a 1920x1080,
 *  fotogramma per fotogramma, senza un fotogramma perso.
 *
 *  Il punto e' il TEMPO. Registrare lo schermo mentre la grafica gira perde
 *  fotogrammi appena la macchina rallenta — e questa macchina e' lenta di
 *  proposito, gira a priorita' bassa. Qui il tempo della pagina e' finto: si
 *  ferma, si scatta, si avanza di un quarantesimo di secondo, si scatta
 *  ancora. Timer, requestAnimationFrame, Date, performance.now, animazioni
 *  CSS e video avanzano solo quando lo decide questo script: la grafica non
 *  sa di essere registrata, e ogni fotogramma e' esattamente quello che
 *  sarebbe andato in onda a quel tempo, anche se scattarlo ha preso un
 *  secondo.
 *
 *  Due uscite, e la scelta non e' di gusto:
 *   · .mp4  (H.264)       grafiche a tutto schermo, col loro fondo
 *   · .mov  (ProRes 4444) grafiche TRASPARENTI, da mettere sopra un video:
 *                          l'mp4 non ha il canale alfa, il ProRes si', e
 *                          Premiere lo legge senza convertire niente.
 *
 *  La durata, se non la si dice, la trova da sola: si va avanti finche' non
 *  resta niente che si muove verso una fine (animazioni, timer, un video non
 *  in loop), poi si tengono due secondi fermi. Il tetto e' 30 secondi.
 *
 *  Uso:
 *    node esporta-grafica.js --url "<motore ?d=...>" --out file.mp4
 *         [--secondi auto|8] [--fps 25] [--chrome /percorso]
 *  Sullo standard output scrive "FOTOGRAMMI n" mentre lavora e "FATTO" alla
 *  fine: e' quello che legge il servizio per dire a che punto e'.
 */
"use strict";
const { spawn } = require("child_process");
const puppeteer = require("puppeteer-core");

function arg(nome, def) {
  const i = process.argv.indexOf("--" + nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const URL_GRAFICA = arg("url");
const OUT = arg("out", "grafica.mp4");
const SECONDI = arg("secondi", "auto");
const FPS = parseInt(arg("fps", "25"), 10);
const CHROME = arg("chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const ALFA = /\.mov$/i.test(OUT);
const TETTO = 30, FERMO = 2, MINIMO = 3;
if (!URL_GRAFICA) { console.error("manca --url"); process.exit(2); }

// ── l'orologio finto, installato prima di qualunque script della pagina ──
function orologioFinto() {
  let ora = 0;
  const base = Date.now(), DateVera = Date;
  // il timer VERO, tenuto da parte: serve solo a non aspettare per sempre un
  // video che non si sposta
  const aspettaDavvero = window.setTimeout.bind(window);
  let seq = 1, rafSeq = 1;
  const timer = new Map();
  let raf = new Map();
  window.setTimeout = (fn, ms, ...a) => { const id = seq++; timer.set(id, { quando: ora + Math.max(0, +ms || 0), fn, a, ogni: 0 }); return id; };
  window.setInterval = (fn, ms, ...a) => { const id = seq++, p = Math.max(1, +ms || 0); timer.set(id, { quando: ora + p, fn, a, ogni: p }); return id; };
  window.clearTimeout = window.clearInterval = (id) => { timer.delete(id); };
  window.requestAnimationFrame = (fn) => { const id = rafSeq++; raf.set(id, fn); return id; };
  window.cancelAnimationFrame = (id) => { raf.delete(id); };
  performance.now = () => ora;
  window.Date = class extends DateVera {
    constructor(...x) { if (x.length === 0) super(base + ora); else super(...x); }
    static now() { return base + ora; }
  };
  window.__esportaAvanza = (fino) => {
    // i timer scaduti, nell'ordine in cui scadono
    for (;;) {
      let pross = null, pid = null;
      for (const [id, t] of timer) if (t.quando <= fino && (!pross || t.quando < pross.quando)) { pross = t; pid = id; }
      if (!pross) break;
      ora = pross.quando;
      if (pross.ogni) pross.quando += pross.ogni; else timer.delete(pid);
      try { typeof pross.fn === "function" ? pross.fn(...pross.a) : (0, eval)(String(pross.fn)); } catch (e) { console.error(e); }
    }
    ora = fino;
    const giro = raf; raf = new Map();
    for (const [, fn] of giro) { try { fn(ora); } catch (e) { console.error(e); } }
    // le animazioni del browser nascono quando le si vede la prima volta, e da
    // li' la loro posizione e' il tempo finto, non quello vero
    for (const an of document.getAnimations()) {
      try {
        if (an.__t0 === undefined) an.__t0 = ora;
        an.pause();
        an.currentTime = Math.max(0, ora - an.__t0);
      } catch (e) {}
    }
    // i video pure: la carta e l'approved possono averne uno al posto della foto
    for (const v of document.querySelectorAll("video")) {
      try {
        if (v.__t0 === undefined) v.__t0 = ora;
        v.pause();
        const t = (ora - v.__t0) / 1000;
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.loop ? t % v.duration : Math.min(t, v.duration - 0.001);
      } catch (e) {}
    }
  };
  // c'e' ancora qualcosa che deve arrivare da qualche parte?
  window.__esportaSiMuove = () => {
    let attesa = 0;
    for (const an of document.getAnimations()) {
      try {
        const fine = an.effect.getComputedTiming().endTime;
        if (isFinite(fine) && (an.currentTime || 0) < fine) attesa = Math.max(attesa, fine - (an.currentTime || 0));
      } catch (e) {}
    }
    for (const [, t] of timer) if (!t.ogni && t.quando > ora) attesa = Math.max(attesa, t.quando - ora);
    for (const v of document.querySelectorAll("video")) {
      if (!v.loop && isFinite(v.duration) && v.duration > 0) attesa = Math.max(attesa, (v.duration - v.currentTime) * 1000);
    }
    return attesa;
  };
  // i video hanno finito di spostarsi sul fotogramma chiesto?
  window.__esportaVideoPronti = () => Promise.all([].map.call(document.querySelectorAll("video"), (v) =>
    v.seeking ? new Promise((ok) => { v.addEventListener("seeked", ok, { once: true }); aspettaDavvero(ok, 1500); }) : null));
}

(async () => {
  const t0 = Date.now();
  const shell = /headless-shell/.test(CHROME);
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: shell ? "shell" : true,
    args: ["--hide-scrollbars", "--force-device-scale-factor=1", "--font-render-hinting=none",
           "--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"]
  });
  const page = await browser.newPage();
  // Il CDN di ESPN rifiuta le chiamate API di un browser che si presenta come
  // "HeadlessChrome" (le immagini no). I motori di oggi non le fanno, ma uno
  // che domani leggesse ESPN in pagina uscirebbe vuoto senza dire perche'.
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36");
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(orologioFinto);
  page.on("console", (m) => { if (m.type() === "error") console.error("  [pagina]", m.text()); });
  await page.goto(URL_GRAFICA, { waitUntil: "networkidle0", timeout: 60000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);

  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-"].concat(
    ALFA
      ? ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-vendor", "apl0", OUT]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT]),
    { stdio: ["pipe", "inherit", "inherit"] });
  const fine = new Promise((ok, no) => ff.on("close", (c) => c === 0 ? ok() : no(new Error("ffmpeg " + c))));

  const fisso = SECONDI !== "auto" ? Math.min(TETTO, Math.max(0.5, parseFloat(SECONDI) || 8)) : null;
  let ultimo = fisso ? Math.round(fisso * FPS) : Math.round(TETTO * FPS);
  for (let i = 0; i < ultimo; i++) {
    const t = (i * 1000) / FPS;
    await page.evaluate((x) => window.__esportaAvanza(x), t);
    await page.evaluate(() => window.__esportaVideoPronti());
    const png = await page.screenshot({ type: "png", omitBackground: ALFA, optimizeForSpeed: true,
                                        clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
    // Durata automatica: appena non resta niente in arrivo si decide la fine,
    // due secondi dopo. Non prima dei tre secondi, perche' qualche motore
    // aspetta un'immagine prima di cominciare a muoversi.
    if (!fisso && t >= MINIMO * 1000 && ultimo === Math.round(TETTO * FPS)) {
      const attesa = await page.evaluate(() => window.__esportaSiMuove());
      if (attesa <= 0) ultimo = Math.min(ultimo, i + 1 + Math.round(FERMO * FPS));
    }
    if (i % 5 === 0) console.log("FOTOGRAMMI " + (i + 1));
  }
  ff.stdin.end();
  await fine;
  await browser.close();
  console.log("FATTO " + ultimo + " fotogrammi, " + (ultimo / FPS).toFixed(1) + " s, " +
              ((Date.now() - t0) / 1000).toFixed(1) + " s di lavoro");
})().catch((e) => { console.error("ERRORE " + e.message); process.exit(1); });
