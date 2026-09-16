#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  SCONTORNATI DA SKY — le foto dei giocatori di Serie A nel magazzino
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Sky Sport pubblica per ogni giocatore di Serie A lo scontornato del
 *  servizio fotografico della stagione: PNG trasparente 512x512, allo
 *  stesso indirizzo del numero che compare nella sua pagina
 *  (sport.sky.it/calcio/atleti/<nome>/<numero>). Questo script lo porta nel
 *  magazzino delle Formazioni Premium.
 *
 *  Il magazzino riconosce le foto dall'id ESPN del giocatore, non dal
 *  cognome (vedi fotoDiChi in server.js): per ogni giocatore Sky si cerca lo
 *  stesso nella rosa ESPN della squadra — cognome e numero di maglia — e la
 *  foto si carica col suo id, attraverso il ponte (foto-carica), come se la
 *  caricasse la pagina del magazzino. Il nome del file lo sceglie il ponte.
 *
 *  Chi ha GIA' una foto non si tocca: sono quasi tutte da 1200 pixel, piu'
 *  definite di quelle Sky. Con --sostituisci si rimpiazzano anche quelle (il
 *  ponte tiene comunque una copia della vecchia nello storico).
 *  Chi non si riesce ad abbinare con certezza si salta e si elenca: meglio
 *  una foto in meno che la faccia di un altro.
 *
 *  Maglie vecchie: Sky non sempre rifa' la foto a chi ha cambiato squadra, e a
 *  volte e' ancora quella della stagione scorsa. Le foto controllate e scartate
 *  stanno in sky-maglie-scartate.json col loro sha1: si saltano finche' Sky non
 *  le sostituisce (il contenuto cambia e tornano buone da guardare). Con
 *  --pulisci --stato <cartella> si tolgono dal magazzino quelle gia' entrate,
 *  ma solo se sono foto Sky (512x512) caricate dall'import, mai le altre.
 *
 *  FONTI. Serie A: Sky Sport (sopra). Premier League: il sito ufficiale della
 *  lega, che pubblica per ogni giocatore della stagione lo scontornato 500x500
 *  (resources.premierleague.com/premierleague25/photos/players/500x500/<opta>.png)
 *  con rosa e numeri dalle sue API. Con --fonte sky|pl se ne usa una sola.
 *
 *  Uso, sulla VM (la chiave si legge dall'ambiente del servizio):
 *    node sky-scontornati.js --ponte http://127.0.0.1:8081/api [--squadra como] [--prova] [--sostituisci]
 *    (in produzione: --ponte http://127.0.0.1:8080/api)
 */
"use strict";

const A = process.argv.slice(2);
function arg(n, def) { const i = A.indexOf("--" + n); return i < 0 ? def : (A[i + 1] && !A[i + 1].startsWith("--") ? A[i + 1] : true); }
const PONTE = arg("ponte", "http://127.0.0.1:8081/api");
const SOLO = arg("squadra", "");
const FONTE = arg("fonte", "");
const PROVA = !!arg("prova", false);
const SOSTITUISCI = !!arg("sostituisci", false);
const PULISCI = !!arg("pulisci", false);
const STATO = arg("stato", "");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
let SCARTATE = {};
try {
  for (const x of JSON.parse(fs.readFileSync(path.join(__dirname, "sky-maglie-scartate.json"), "utf8")).scartate) SCARTATE[x.sky] = x;
} catch (err) { console.log("(nessun elenco di foto scartate: " + err.message + ")"); }
const CHIAVE = process.env.COMOTV_CHIAVE_CONTRIBUTO || process.env.COMOTV_CHIAVE_COMANDO || process.env.COMOTV_TOKEN || "";
const UA = { "User-Agent": "Mozilla/5.0 (ComoTV magazzino foto)" };
const SKY_FOTO = "https://static.sky.it/editorialstaticimages/bc29c89d1a3e47e0afbb38aed61e35b7/sport/headshots/calcio/club/";

// Le squadre come le chiama Sky negli indirizzi, e come si riconoscono nel
// nome ESPN. L'id ESPN non si scrive qui: si legge dalla classifica, cosi'
// promosse e retrocesse cambiano da sole a ogni stagione.
const SKY_SLUG = {
  "roma": /roma/, "inter": /internazionale|inter\b/, "como": /como/, "lazio": /lazio/, "cagliari": /cagliari/,
  "milan": /milan/, "frosinone": /frosinone/, "juventus": /juventus/, "sassuolo": /sassuolo/, "napoli": /napoli/,
  "atalanta": /atalanta/, "lecce": /lecce/, "udinese": /udinese/, "torino": /torino/, "fiorentina": /fiorentina/,
  "bologna": /bologna/, "parma": /parma/, "monza": /monza/, "genoa": /genoa/, "venezia": /venezia/,
  "cremonese": /cremonese/, "pisa": /pisa/, "empoli": /empoli/, "verona": /verona/, "salernitana": /salernitana/,
  "spezia": /spezia/, "sampdoria": /sampdoria/, "palermo": /palermo/, "bari": /bari/, "cesena": /cesena/
};

function slug(s) {
  // æ, ø, ß e compagnia non si scompongono in lettera + accento: vanno tradotte,
  // altrimenti Lærke e Østigard non si riconoscono piu'
  return String(s || "").toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a").replace(/ß/g, "ss").replace(/[đð]/g, "d").replace(/ł/g, "l").replace(/þ/g, "th")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
async function testo(u) { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(r.status + " " + u); return r.text(); }
async function json(u) { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(r.status + " " + u); return r.json(); }

async function squadreEspn(lega) {
  const d = await json("https://site.api.espn.com/apis/v2/sports/soccer/" + lega + "/standings");
  return d.children[0].standings.entries.map((e) => ({ id: String(e.team.id), nome: e.team.displayName }));
}
function rosaSky(html) {
  const righe = [];
  const re = /ftbl__team-row__number"><span[^>]*>([^<]*)<\/span>[\s\S]*?href="https:\/\/sport\.sky\.it\/calcio\/atleti\/([a-z0-9-]+)\/(\d+)">([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(html))) righe.push({ num: m[1].trim(), slug: m[2], id: m[3], nome: m[4].trim() });
  return righe;
}
async function rosaEspn(lega, teamId) {
  const d = await json("https://site.api.espn.com/apis/site/v2/sports/soccer/" + lega + "/teams/" + teamId + "/roster");
  return (d.athletes || []).map((a) => ({
    id: String(a.id), nome: a.firstName || "", cognome: a.lastName || "", completo: a.displayName || a.fullName || "",
    num: String(a.jersey || "").trim()
  }));
}

// ── le fonti ────────────────────────────────────────────────────────
// Ognuna restituisce le squadre del suo campionato, gia' abbinate a ESPN,
// con le righe { num, nome, slug, id, img }. "chiave" distingue gli id delle
// fonti nell'elenco delle foto scartate (Sky: il numero da solo, per
// compatibilita'; le altre: "pl:<numero>").
const FONTI = {
  sky: {
    nome: "Sky Sport (Serie A)", lega: "ita.1", chiave: (id) => id,
    async squadre(espn) {
      const out = [];
      for (const [skySlug, re] of Object.entries(SKY_SLUG)) {
        const sq = espn.find((t) => re.test(t.nome.toLowerCase()));
        if (!sq) continue;                               // non e' in Serie A quest'anno
        out.push({ slug: skySlug, sq, righe: async () =>
          rosaSky(await testo("https://sport.sky.it/calcio/squadre/" + skySlug + "/rosa"))
            .map((r) => Object.assign(r, { img: SKY_FOTO + r.id + ".png" })) });
      }
      return out;
    }
  },
  pl: {
    nome: "Premier League", lega: "eng.1", chiave: (id) => "pl:" + id,
    async squadre(espn) {
      const PL = "https://footballapi.pulselive.com/football";
      const h = { headers: Object.assign({ Origin: "https://www.premierleague.com" }, UA) };
      const cs = (await (await fetch(PL + "/competitions/1/compseasons?page=0&pageSize=1", h)).json()).content[0].id;
      const squadre = (await (await fetch(PL + "/teams?pageSize=40&compSeasons=" + cs + "&comps=1&altIds=true&page=0", h)).json()).content;
      const out = [];
      for (const t of squadre) {
        const s = slug(t.name);
        const sq = espn.find((e) => slug(e.nome) === s) ||
                   espn.find((e) => { const a = slug(e.nome).split("-"), b = s.split("-"); return b.every((x) => a.includes(x)) || a.every((x) => b.includes(x)); });
        if (!sq) continue;
        out.push({ slug: s, sq, righe: async () => {
          const d = await (await fetch(PL + "/teams/" + t.id + "/compseasons/" + cs + "/staff?pageSize=80&compSeasons=" + cs + "&altIds=true&page=0&type=player", h)).json();
          return (d.players || []).filter((p) => p.altIds && p.altIds.opta).map((p) => {
            const id = String(p.altIds.opta).replace(/^p/, "");
            const nome = (p.name && p.name.display) || "";
            return { num: p.info && p.info.shirtNum != null ? String(p.info.shirtNum) : "", nome,
                     slug: slug(((p.name && p.name.first) || "") + " " + ((p.name && p.name.last) || "") + " " + nome), id,
                     img: "https://resources.premierleague.com/premierleague25/photos/players/500x500/" + id + ".png" };
          });
        } });
      }
      return out;
    }
  }
};

// Chi e', nella rosa ESPN, il giocatore di questa riga Sky. Il cognome deve
// comparire nel nome Sky; il numero di maglia e il nome decidono fra pari.
// Due candidati ugualmente buoni = nessuno.
function abbina(s, espn) {
  const ts = s.slug.split("-").concat(slug(s.nome).split("-"));
  const punti = espn.map((e) => {
    const cog = slug(e.cognome || e.completo).split("-").filter(Boolean);
    const tutti = slug(e.completo).split("-").filter(Boolean);
    let p = 0, cognomeVisto = false;
    if (cog.length && cog.every((t) => ts.includes(t))) { p += 4; cognomeVisto = true; }
    else if (cog.length && cog.some((t) => t.length > 3 && ts.includes(t))) { p += 2; cognomeVisto = true; }
    // Senza il cognome non si abbina, nemmeno con numero e nome giusti:
    // "Lamine" col 8 puo' essere un altro Lamine. Quei casi vanno a mano.
    if (!cognomeVisto) return { e, p: 0 };
    if (s.num && e.num && s.num === e.num) p += 3;
    if (tutti.some((t) => t.length > 2 && ts.includes(t) && !cog.includes(t))) p += 1;
    return { e, p };
  }).sort((a, b) => b.p - a.p);
  const primo = punti[0], secondo = punti[1];
  if (!primo || primo.p < 4) return null;                // senza cognome (o maglia + mezzo nome) no
  if (secondo && secondo.p === primo.p) return null;     // due uguali: non si tira a indovinare
  return primo.e;
}

// Ha gia' una foto: si chiede al ponte, con le stesse regole che usano le
// grafiche (fotoDiChi in server.js) — cosi' conta anche la foto buona che
// risponde per cognome senza essere intestata all'id, com'e' per molte delle
// foto da 1200 pixel. La domanda si fa per TUTTI prima di caricare qualunque
// cosa: dopo, un omonimo appena caricato per un'altra squadra risponderebbe
// al posto suo.
// Il ponte risponde anche con l'eventuale foto "orfana": un file con quel
// cognome che c'e' ma non e' intestato a nessuno (succede coi cognomi che
// appartengono a piu' giocatori, come Paz o Martinez). Oggi per quel
// giocatore le grafiche non mostrano niente — meglio niente che la faccia di
// un altro — quindi la foto Sky, che e' sicuramente lui, si carica. L'orfana
// resta in magazzino e si elenca: se e' lui, intestarla a mano nel Magazzino
// foto riporta la foto da 1200 pixel.
async function cheFoto(e, teamId) {
  const q = "?foto=" + encodeURIComponent(e.cognome || e.completo) + "&id=" + encodeURIComponent(e.id) + "&squadra=" + encodeURIComponent(teamId);
  const d = await json(PONTE + q);
  return { sua: !!(d && d.url), orfana: (d && d.orfana) || "" };
}
// Toglie la foto di questo giocatore SOLO se e' una dell'import: intestata al
// suo id, PNG 512x512 (Sky) o 500x500 (Premier League). Una foto caricata a
// mano (1200 pixel) non si tocca.
function togliSeSky(e) {
  if (!STATO) throw new Error("--pulisci vuole --stato /var/lib/comotv (o comotv-dev)");
  const indice = path.join(STATO, "foto-intestazioni.json");
  const d = JSON.parse(fs.readFileSync(indice, "utf8"));
  const file = (d.perId || {})[e.id];
  if (!file) return false;
  const p = path.join(STATO, "loghi", file);
  if (!fs.existsSync(p)) return false;
  const h = fs.readFileSync(p).subarray(0, 24);
  const lato = h.readUInt32BE(16);
  if (h.toString("hex", 0, 8) !== "89504e470d0a1a0a" || (lato !== 512 && lato !== 500) || h.readUInt32BE(20) !== lato) return false;
  // e solo se e' entrata con l'import Sky, cominciato il 16/09/2026
  if (fs.statSync(p).mtime < new Date("2026-09-16T00:00:00+02:00")) return false;
  fs.unlinkSync(p);
  delete d.perId[e.id];
  for (const cog of Object.keys(d.perSq || {})) for (const k of Object.keys(d.perSq[cog])) if (d.perSq[cog][k] === file) delete d.perSq[cog][k];
  fs.writeFileSync(indice, JSON.stringify(d, null, 1));
  return true;
}
async function carica(e, teamId, png) {
  const corpo = { token: CHIAVE, tipo: "foto-carica", cognome: e.cognome || e.completo, id: e.id, squadra: teamId,
                  dati: "data:image/png;base64," + Buffer.from(png).toString("base64") };
  const r = await fetch(PONTE, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(corpo) });
  const d = await r.json();
  if (!d.ok) throw new Error(d.errore || "caricamento non riuscito");
  return d.file;
}

(async function () {
  if (!CHIAVE && !PROVA) { console.error("manca la chiave nell'ambiente (COMOTV_CHIAVE_CONTRIBUTO)"); process.exit(1); }
  const totale = { squadre: 0, sky: 0, gia: 0, caricate: 0, senzaFotoSky: 0, nonAbbinati: 0, orfane: 0, scartate: 0, tolte: 0, errori: 0 };
  const note = [];
  // ── prima fase: abbinare e guardare cosa c'e', senza caricare niente ──
  const lavoro = [];
  for (const [nomeFonte, F] of Object.entries(FONTI)) {
    if (FONTE && FONTE !== nomeFonte) continue;
    let elenco;
    try { elenco = await F.squadre(await squadreEspn(F.lega)); }
    catch (err) { note.push(F.nome + ": squadre non lette (" + err.message + ")"); continue; }
    for (const q of elenco) {
      if (SOLO && SOLO !== q.slug) continue;
      const sq = q.sq;
      totale.squadre++;
      let righe;
      try { righe = await q.righe(); }
      catch (err) { note.push(q.slug + ": rosa non letta (" + err.message + ")"); continue; }
      const rosa = await rosaEspn(F.lega, sq.id);
      const c = { F, sq: sq, sky: righe.length, gia: 0, caricate: 0, senzaFotoSky: 0, nonAbbinati: [], orfane: [], scartate: [], tolte: [], errori: 0, daFare: [] };
      for (const s of righe) {
        const e = abbina(s, rosa);
        if (!e) { c.nonAbbinati.push(s.nome + " (" + (s.num || "-") + ")"); continue; }
        if (arg("coppie", false) && slug(e.completo) !== s.slug) console.log("   " + sq.nome + ": " + s.nome + " #" + s.num + "  ->  ESPN " + e.completo + " #" + e.num + " (id " + e.id + ")");
        if (PULISCI && SCARTATE[F.chiave(s.id)]) {
          const via = togliSeSky(e);
          if (via) c.tolte.push(s.nome);
        }
        try {
          const f = SOSTITUISCI ? { sua: false, orfana: "" } : await cheFoto(e, sq.id);
          if (f.sua) c.gia++;
          else {
            if (f.orfana) c.orfane.push(s.nome);
            c.daFare.push({ s: s, e: e });
          }
        } catch (err) { c.errori++; note.push(q.slug + " · " + s.nome + ": " + err.message); }
      }
      lavoro.push(c);
    }
  }
  // ── seconda fase: caricare ──
  for (const c of lavoro) {
    for (const x of c.daFare) {
      try {
        const r = await fetch(x.s.img, { headers: UA });
        if (!r.ok) { c.senzaFotoSky++; continue; }
        const png = await r.arrayBuffer();
        // Quando la foto non c'e' Sky risponde spesso 200 con una pagina di
        // errore HTML: il codice non basta, si guarda che sia davvero un PNG.
        const firma = Buffer.from(png.slice(0, 8)).toString("hex");
        if (firma !== "89504e470d0a1a0a") { c.senzaFotoSky++; continue; }
        const sc = SCARTATE[c.F.chiave(x.s.id)];
        if (sc && sc.sha1 === crypto.createHash("sha1").update(Buffer.from(png)).digest("hex")) { c.scartate.push(x.s.nome); continue; }
        if (!PROVA) await carica(x.e, c.sq.id, png);
        c.caricate++;
      } catch (err) { c.errori++; note.push(c.sq.nome + " · " + x.s.nome + ": " + err.message); }
    }
    totale.sky += c.sky; totale.gia += c.gia; totale.caricate += c.caricate;
    totale.senzaFotoSky += c.senzaFotoSky; totale.nonAbbinati += c.nonAbbinati.length; totale.orfane += c.orfane.length; totale.scartate += c.scartate.length; totale.tolte += c.tolte.length; totale.errori += c.errori;
    console.log(`${c.sq.nome.padEnd(22)} rosa ${String(c.sky).padStart(2)} · gia' in magazzino ${String(c.gia).padStart(2)} · ${PROVA ? "da caricare" : "caricate"} ${String(c.caricate).padStart(2)} · senza foto ${c.senzaFotoSky}` +
                (c.nonAbbinati.length ? ` · non abbinati: ${c.nonAbbinati.join(", ")}` : "") +
                (c.scartate.length ? ` · scartate per la maglia: ${c.scartate.join(", ")}` : "") +
                (c.tolte.length ? ` · TOLTE dal magazzino: ${c.tolte.join(", ")}` : "") +
                (c.orfane.length ? ` · c'e' anche una foto orfana col cognome di: ${c.orfane.join(", ")}` : "") + (c.errori ? ` · errori ${c.errori}` : ""));
  }
  console.log("\nTOTALE " + JSON.stringify(totale) + (PROVA ? "  (prova: nessuna foto caricata)" : ""));
  if (note.length) console.log("\nNote:\n  " + note.join("\n  "));
})().catch((err) => { console.error("ERRORE: " + err.message); process.exit(1); });
