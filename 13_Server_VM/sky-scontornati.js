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
 *  con rosa e numeri dalle sue API.
 *  EFL (Championship, League One, League Two — quindi anche la Carabao Cup):
 *  la lega non pubblica foto, i club si'. Quelli sulla piattaforma digitale
 *  della EFL hanno la rosa aperta (teams.football.web.gc.<dominio>) con le
 *  immagini dei giocatori su images.gc.<dominio>; solo alcuni caricano lo
 *  scontornato trasparente, e solo quelli stanno in EFL_CLUB. Le foto a figura
 *  intera o piu' alte che larghe si ritagliano a mezzo busto, come Sky.
 *  Siti dei club (ex Premier fuori dalla piattaforma EFL): Southampton e
 *  Leicester, ognuno letto a modo suo (CLUB_SITI).
 *  Foto gia' scontornate a mano o sul Mac: --pacchetto <elenco.json> (vedi sotto).
 *  Con --fonte sky|pl|efl|club|pacchetto se ne usa una sola.
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

// I club EFL con lo scontornato trasparente per (quasi) tutta la rosa,
// controllati a occhio il 16/09/2026: dominio della piattaforma, squadra Opta
// della prima squadra, nome ESPN. Il campionato non si scrive: il club si
// cerca nelle classifiche ESPN di Championship, League One e League Two, cosi'
// promozioni e retrocessioni non cambiano niente.
// Fuori, per ora: Luton (pose a figura intera tutte diverse), Northampton
// (2 foto), e tutti i club che mettono foto col fondo o non stanno sulla
// piattaforma (West Ham, Wolves, Southampton, Leicester, Burnley...).
const EFL_CLUB = [
  { d: "qprfcservices.co.uk", t: "t52", re: /queens park|\bqpr\b/ },
  { d: "stokecityfcservices.co.uk", t: "t110", re: /stoke/ },
  { d: "portsmouthfcservices.co.uk", t: "t47", re: /portsmouth/ },
  { d: "prestonnorthendfcservices.co.uk", t: "t107", re: /preston/ },
  { d: "huddersfieldtownafcservices.co.uk", t: "t38", re: /huddersfield/, sempre: true },  // pose con le braccia: si ritaglia sempre
  { d: "afcwimbledonservices.co.uk", t: "t2623", re: /wimbledon/ },
  { d: "stockportcountyfcservices.co.uk", t: "t48", re: /stockport/ },
  { d: "blackpoolfcservices.co.uk", t: "t92", re: /blackpool/ },
  { d: "bromleyfcservices.co.uk", t: "t2050", re: /bromley/ },
  { d: "yorkcityfcservices.co.uk", t: "t78", re: /york city/ },
  { d: "cheltenhamfcservices.co.uk", t: "t87", re: /cheltenham/ },
  { d: "accringtonstanleyfcservices.co.uk", t: "t888", re: /accrington/ }
];
// dove il club mette lo scontornato: il primo campo PNG che c'e', nell'ordine
const EFL_CAMPI = ["squadImageKey", "playerHeadshotKey", "playerProfileForegroundKey", "appProfileImageKey"];

// sharp sta nel ponte, non accanto a questo script
function prendiSharp() {
  for (const p of [__dirname, "/opt/comotv", "/opt/comotv-dev", path.join(__dirname, "..")]) {
    try { return require(require.resolve("sharp", { paths: [p] })); } catch (err) { /* il prossimo */ }
  }
  return null;
}
// Lo scontornato EFL come quelli Sky: quadrato, testa in alto, fino al petto.
// Se il soggetto e' piu' alto che largo (figura intera, o foto 2:3) si taglia
// (o se il club lo chiede: "sempre") un quadrato di lato 0,68 volte la sua
// altezza, centrato sulla testa; poi niente oltre i 1200 pixel.
// Una foto senza trasparenza non e' uno scontornato.
async function mezzoBusto(png, riga) {
  const sharp = prendiSharp();
  if (!sharp) throw new Error("sharp non trovato: serve per ritagliare le foto EFL");
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  let x0 = W, y0 = H, x1 = -1, y1 = -1, vuoti = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = data[(y * W + x) * ch + ch - 1];
    if (a < 10) vuoti++;
    if (a > 40) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  // (le foto di primo piano scontornate sul Mac hanno poco fondo: il pacchetto abbassa la soglia)
  if (vuoti < W * H * (riga && riga.vuoti != null ? riga.vuoti : 0.2) || x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  let img = sharp(png);
  if (bh / bw > 1.45 || (riga && riga.sempre)) {
    const lato = Math.min(W, H, Math.round(bh * ((riga && riga.lato) || 0.68)));
    // il centro e' quello della testa (il primo 12% del soggetto), non delle braccia
    let t0 = W, t1 = -1;
    for (let y = y0; y < y0 + Math.max(1, Math.round(bh * 0.12)); y++) for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * ch + ch - 1] > 40) { if (x < t0) t0 = x; if (x > t1) t1 = x; }
    }
    const cx = t1 >= 0 ? (t0 + t1) / 2 : (x0 + x1) / 2;
    const sx = Math.round(cx - lato / 2), sy = Math.round(y0 - lato * 0.04);
    // la parte che esce dall'immagine resta trasparente
    const ex = Math.max(0, sx), ey = Math.max(0, sy);
    const ew = Math.min(W, sx + lato) - ex, eh = Math.min(H, sy + lato) - ey;
    const pezzo = await sharp(png).extract({ left: ex, top: ey, width: ew, height: eh }).png().toBuffer();
    img = sharp({ create: { width: lato, height: lato, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: pezzo, left: ex - sx, top: ey - sy }]);
    img = sharp(await img.png().toBuffer());
  } else if (Math.max(W, H) <= 1200 && png.length < 1900000) {
    return Buffer.from(png);
  }
  // il ponte non accetta piu' di 2 MB: si comprime, e se non basta si rimpicciolisce
  const base = await img.png().toBuffer();
  for (const lato of [1200, 1000, 800]) {
    const out = await sharp(base).resize({ width: lato, height: lato, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, effort: 10 }).toBuffer();
    if (out.length < 1900000) return out;
  }
  return null;
}

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
// Le tre leghe EFL sono la stessa fonte: cambia solo la classifica ESPN
for (const [k, lega, nome] of [["efl-championship", "eng.2", "Championship"], ["efl-league-one", "eng.3", "League One"], ["efl-league-two", "eng.4", "League Two"]]) {
  FONTI[k] = {
    nome: "EFL " + nome, lega, gruppo: "efl", chiave: (id) => "efl:" + id, prepara: mezzoBusto,
    async squadre(espn) {
      const out = [];
      for (const c of EFL_CLUB) {
        const sq = espn.find((e) => c.re.test(e.nome.toLowerCase()));
        if (!sq) continue;                               // gioca in un'altra lega
        out.push({ slug: slug(sq.nome), sq, righe: async () => {
          const b = (await json("https://teams.football.web.gc." + c.d + "/v2/squads/opta?teamID=" + c.t)).body || {};
          const gioc = ["goalkeepers", "defenders", "midfielders", "forwards"].flatMap((r) => b[r] || []);
          // un'immagine usata da piu' giocatori e' un segnaposto, non una foto
          const quanti = {};
          for (const p of gioc) for (const v of new Set(Object.values(p.playerProfileData || {}))) if (typeof v === "string" && v) quanti[v] = (quanti[v] || 0) + 1;
          return gioc.filter((p) => p.playerID).map((p) => {
            const d = p.playerProfileData || {};
            const imgs = [...new Set(EFL_CAMPI.map((k) => d[k] || "").filter((v) => /\.png$/i.test(v) && quanti[v] === 1))]
              .map((v) => "https://images.gc." + c.d + "/" + v);
            const nome = p.knownName || ((p.firstName || "") + " " + (p.surname || "")).trim();
            return { num: p.shirtNumber != null ? String(p.shirtNumber) : "", nome, id: String(p.playerID).replace(/^p/, ""), cognome: slug(p.surname),
                     slug: slug((p.firstName || "") + " " + (p.surname || "") + " " + (p.knownName || "")), img: imgs[0] || "", imgs, sempre: !!c.sempre };
          });
        } });
      }
      return out;
    }
  };
}

// ── pacchetto: foto gia' scontornate altrove ─────────────────────────
// Per i club che pubblicano foto col fondo: si scaricano e si scontornano sul
// Mac (Vision, lo strumento "Scontorna foto"), si guardano a occhio, e arrivano
// qui come cartella di PNG con un elenco JSON:
//   { prefisso, cartella, squadre: [{ squadra, lega, righe: [{ num, nome,
//     cognome, id, slug, file, sempre, lato }] }] }
// --pacchetto <elenco.json>. "Ha gia' la foto" vale solo se e' intestata al suo
// id (--stato): le poche foto che quei giocatori "avevano" erano omonimi.
const PACCHETTO = arg("pacchetto", "");
let PAC = null;
if (PACCHETTO) PAC = JSON.parse(fs.readFileSync(PACCHETTO, "utf8"));

// ── club con un sito tutto loro ─────────────────────────────────────
// Le ex Premier scese in EFL. West Ham e Wolves non servono: in magazzino
// hanno gia' le foto da 1200 pixel. Burnley pubblica solo card grafiche
// (fondo, bandiera, scritte), niente scontornati.
function deHtml(s) {
  return s.replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&");
}
// l'oggetto JSON che comincia in quel punto del testo (parentesi contate, stringhe saltate)
function oggettoJson(t, da) {
  let prof = 0, str = false;
  for (let i = da; i < t.length; i++) {
    const ch = t[i];
    if (str) { if (ch === "\\") i++; else if (ch === "\"") str = false; continue; }
    if (ch === "\"") str = true;
    else if (ch === "{") prof++;
    else if (ch === "}" && --prof === 0) { try { return JSON.parse(t.slice(da, i + 1)); } catch (err) { return null; } }
  }
  return null;
}
const CLUB_SITI = [
  { nome: "southampton", re: /southampton/, sigla: "sou", async righe() {
      // la rosa sta nei dati della pagina, un oggetto per giocatore con "teams":["mensteam"]
      const t = deHtml(await testo("https://www.southamptonfc.com/en/first-team"));
      const out = [], visti = new Set(), re = /\{"index":\d+,/g;
      let m;
      while ((m = re.exec(t))) {
        const o = oggettoJson(t, m.index);
        if (!o || !(o.teams || []).includes("mensteam") || !o.image || !o.image.file || visti.has(o.id)) continue;
        visti.add(o.id);
        const u = String(o.image.file.url || "").replace(/^http:/, "https:").replace("/image/upload/", "/image/upload/c_limit,w_1200,h_1200/");
        out.push({ num: String(o.number || ""), nome: (o.firstName + " " + o.lastName).trim(), id: o.id, cognome: slug(o.lastName),
                   slug: slug(o.firstName + " " + o.lastName), img: u, sempre: true });
      }
      return out;
    } },
  { nome: "leicester", re: /leicester/, sigla: "lei", lato: 0.56, async righe() {
      // Scontornati con numero e nome stampati sotto il petto: il ritaglio piu'
      // stretto (lato) li lascia fuori. Il nome e' nel testo alternativo, ma si
      // prende solo se e' anche nel nome del file: una volta non lo era
      // (Choudhury sulla foto di Howell).
      const h = await testo("https://www.lcfc.com/teams-men");
      const out = [], visti = new Set(), re = /<img[^>]*?alt="([^"]+)"[^>]*?src="(https:\/\/cmscdnus\.yinzcam\.com\/Toolbox\/jsoneditor\/FA_LEI\/([^"?]+))/g;
      let m;
      while ((m = re.exec(h))) {
        const nome = deHtml(m[1]).trim(), file = slug(decodeURIComponent(m[3]).replace(/\.png$/i, ""));
        const toks = slug(nome).split("-").filter((x) => x.length > 2);
        if (!/\.png$/i.test(m[3]) || !toks.length || visti.has(slug(nome))) continue;
        const cog = toks[toks.length - 1];
        if (!file.split("-").includes(cog)) continue;
        visti.add(slug(nome));
        const parti = nome.split(/\s+/);
        out.push({ num: "", nome, id: slug(nome), cognome: slug(parti.slice(1).join(" ") || nome), slug: slug(nome), img: m[2], sempre: true });
      }
      return out;
    } }
];
for (const [k, lega] of [["club-eng2", "eng.2"], ["club-eng3", "eng.3"], ["club-eng4", "eng.4"]]) {
  FONTI[k] = {
    nome: "siti dei club (" + lega + ")", lega, gruppo: "club", prepara: mezzoBusto,
    chiave: (id) => "club:" + id,
    async squadre(espn) {
      const out = [];
      for (const c of CLUB_SITI) {
        const sq = espn.find((e) => c.re.test(e.nome.toLowerCase()));
        if (!sq) continue;
        out.push({ slug: slug(sq.nome), sq, righe: async () => (await c.righe()).map((r) => Object.assign(r, { lato: c.lato })) });
      }
      return out;
    }
  };
}

if (PAC) {
  for (const lega of [...new Set(PAC.squadre.map((q) => q.lega))]) {
    FONTI["pacchetto-" + lega] = {
      nome: "pacchetto " + PAC.prefisso + " (" + lega + ")", lega, gruppo: "pacchetto", soloId: true, prepara: (png, r) => mezzoBusto(png, Object.assign({ vuoti: 0.05 }, r)),
      chiave: (id) => PAC.prefisso + ":" + id,
      async squadre(espn) {
        const out = [];
        for (const q of PAC.squadre.filter((x) => x.lega === lega)) {
          const s = slug(q.squadra);
          const sq = espn.find((e) => slug(e.nome) === s) ||
                     espn.find((e) => { const a = slug(e.nome).split("-"), b = s.split("-"); return b.every((x) => a.includes(x)) || a.every((x) => b.includes(x)); });
          if (!sq) continue;
          const dir = path.resolve(path.dirname(PACCHETTO), PAC.cartella);
          out.push({ slug: s, sq, righe: async () => q.righe.map((r) => Object.assign({}, r, { img: path.join(dir, r.file) })) });
        }
        return out;
      }
    };
  }
}

// Chi e', nella rosa ESPN, il giocatore di questa riga Sky. Il cognome deve
// comparire nel nome Sky; il numero di maglia e il nome decidono fra pari.
// Due candidati ugualmente buoni = nessuno.
function abbina(s, espn) {
  const ts = s.slug.split("-").concat(slug(s.nome).split("-"));
  // Quando la fonte da' il cognome a parte (EFL) il cognome ESPN si cerca solo
  // li': "George Evans" non e' Shamal George.
  const tc = s.cognome ? s.cognome.split("-").concat(slug(s.nome).split("-")) : ts;
  const punti = espn.map((e) => {
    const cog = slug(e.cognome || e.completo).split("-").filter(Boolean);
    const tutti = slug(e.completo).split("-").filter(Boolean);
    let p = 0, cognomeVisto = false;
    if (cog.length && cog.every((t) => tc.includes(t))) { p += 4; cognomeVisto = true; }
    else if (cog.length && cog.some((t) => t.length > 3 && tc.includes(t))) { p += 2; cognomeVisto = true; }
    // Senza il cognome non si abbina, nemmeno con numero e nome giusti:
    // "Lamine" col 8 puo' essere un altro Lamine. Quei casi vanno a mano.
    if (!cognomeVisto) return { e, p: 0 };
    const nomeVisto = tutti.some((t) => t.length > 2 && ts.includes(t) && !cog.includes(t));
    // Con nome intero nella fonte, numero diverso e nome diverso e' un altro
    // giocatore con lo stesso cognome (Freddie Taylor non e' Richard Taylor)
    if (s.cognome && s.num && e.num && s.num !== e.num && !nomeVisto) return { e, p: 0 };
    // Senza numero di maglia nella fonte, il cognome da solo non basta: nella
    // Saudi Pro League "Al Ghamdi" o "Al Shanqiti" sono tre per squadra
    if (s.cognome && !s.num && !nomeVisto) return { e, p: 0 };
    if (s.num && e.num && s.num === e.num) p += 3;
    if (nomeVisto) p += 1;
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
let INDICE = null;
async function cheFoto(e, teamId, F) {
  if (F && F.soloId) {
    if (!STATO) throw new Error("--pacchetto vuole --stato /var/lib/comotv (o comotv-dev)");
    if (!INDICE) INDICE = JSON.parse(fs.readFileSync(path.join(STATO, "foto-intestazioni.json"), "utf8"));
    return { sua: !!(INDICE.perId || {})[e.id], orfana: "" };
  }
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
    if (FONTE && FONTE !== nomeFonte && FONTE !== F.gruppo) continue;
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
      // due righe della fonte sullo stesso giocatore ESPN: almeno una e' sbagliata,
      // e non si sa quale — fuori entrambe
      const visti = new Set();
      const coppie = righe.filter((s) => !visti.has(s.id) && visti.add(s.id)).map((s) => ({ s, e: abbina(s, rosa) }));
      const volte = {};
      for (const x of coppie) if (x.e) volte[x.e.id] = (volte[x.e.id] || 0) + 1;
      for (const { s, e: e0 } of coppie) {
        const e = e0 && volte[e0.id] === 1 ? e0 : null;
        if (!e) { c.nonAbbinati.push(s.nome + " (" + (s.num || "-") + ")"); continue; }
        if (arg("coppie", false) && slug(e.completo) !== s.slug) console.log("   " + sq.nome + ": " + s.nome + " #" + s.num + "  ->  ESPN " + e.completo + " #" + e.num + " (id " + e.id + ")");
        if (PULISCI && SCARTATE[F.chiave(s.id)]) {
          const via = togliSeSky(e);
          if (via) c.tolte.push(s.nome);
        }
        try {
          const f = SOSTITUISCI ? { sua: false, orfana: "" } : await cheFoto(e, sq.id, F);
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
        // la prima immagine buona fra quelle che la fonte propone
        let png = null, scartata = false;
        for (const u of (x.s.imgs || [x.s.img]).filter(Boolean)) {
          let dati;
          if (u.startsWith("/")) { if (!fs.existsSync(u)) continue; dati = fs.readFileSync(u); }
          else {
            const r = await fetch(u, { headers: UA });
            if (!r.ok) continue;
            dati = Buffer.from(await r.arrayBuffer());
          }
          // Quando la foto non c'e' Sky risponde spesso 200 con una pagina di
          // errore HTML: il codice non basta, si guarda che sia davvero un PNG.
          if (dati.toString("hex", 0, 8) !== "89504e470d0a1a0a") continue;
          const sc = SCARTATE[c.F.chiave(x.s.id)];
          if (sc && sc.sha1 === crypto.createHash("sha1").update(dati).digest("hex")) { scartata = true; continue; }
          if (c.F.prepara) { dati = await c.F.prepara(dati, x.s); if (!dati) continue; }
          png = dati; break;
        }
        if (!png) { if (scartata) c.scartate.push(x.s.nome); else c.senzaFotoSky++; continue; }
        if (arg("salva", false)) fs.writeFileSync(path.join(arg("salva"), slug(c.sq.nome) + "_" + slug(x.s.nome) + ".png"), png);
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
