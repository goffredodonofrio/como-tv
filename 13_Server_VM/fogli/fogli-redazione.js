#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════
 *  FOGLI DELLA REDAZIONE — il database dei fogli partita dei giornalisti
 * ═══════════════════════════════════════════════════════════════════
 *
 *  I giornalisti preparano un foglio per ogni partita (arbitro, precedenti,
 *  allenatori, storia, curiosita') e lo pubblicano su Slack, nel canale
 *  #como-tv-assegnazioni-appunti, di solito il giorno prima. Alcuni lo
 *  mettono anche nel Drive, cartella ARCHIVIO APPUNTI. Questo script li
 *  raccoglie tutti e due, ne tira fuori il testo e li mette in una cartella
 *  che nginx serve cosi' com'e' (/fogli-redazione/): la lavagna dei
 *  telecronisti li legge da li'. Niente va in onda.
 *
 *  Gira da solo ogni 15 minuti (comotv-fogli.timer), a parte: non e' il
 *  ponte delle grafiche, e cambiarlo non riavvia niente che sia in onda.
 *
 *  Cosa scrive in FOGLI_DIR/pub:
 *    indice.json          tutti i fogli: squadre, data, autore, fonte, link
 *    fogli/<id>.json      un foglio, col suo testo
 *    nomi/<parola>.json   per ogni nome proprio, le frasi che lo contengono
 *                         (la scheda del giocatore chiede nomi/<cognome>.json)
 *
 *  Le chiavi stanno in /etc/comotv-fogli.env, non qui:
 *    SLACK_TOKEN          token dell'app Slack di sola lettura
 *                         (channels:history, groups:history, files:read, users:read)
 *    SLACK_CANALI         C0AG3PSDTAR (piu' canali separati da virgola)
 *    GOOGLE_SA_FILE       il JSON dell'account di servizio che legge il Drive
 *    DRIVE_CARTELLE       1n_2D6_d8wYd2Oqzimjzou0oQLoxS63br (ARCHIVIO APPUNTI)
 *  Senza una delle due chiavi, quella fonte si salta e l'altra lavora.
 *
 *  LE PARTITE CHE COMMENTIAMO (partite.json): da Airtable, base dei Live
 *  Events, le partite da ieri a fra tre settimane coi loro telecronisti
 *  (Commento 1 e 2). A ognuna si aggancia la partita ESPN (per prendere la
 *  formazione) e il foglio CURIOSITA' del giornalista. Il token di Airtable e'
 *  quello del ponte: arriva con un rimando alla sua configurazione
 *  (comotv-fogli.service.d/airtable.conf -> comotv.service.d/airtable.conf),
 *  non e' copiato da nessuna parte.
 *
 *  A mano:
 *    node fogli-redazione.js                 un giro (Slack + Drive)
 *    node fogli-redazione.js --file f.docx [--autore "Nome"] [--data 2026-09-20]
 *    node fogli-redazione.js --rifai         ricostruisce indice e nomi dai fogli salvati
 */
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const DIR = process.env.FOGLI_DIR || "/var/lib/comotv-fogli";
const PUB = path.join(DIR, "pub");
const TMP = path.join(DIR, "tmp");
const STATO = path.join(DIR, "stato.json");
const ESTENSIONI = /\.(docx|pdf|txt|md)$/i;
[PUB, path.join(PUB, "fogli"), path.join(PUB, "nomi"), TMP].forEach((d) => fs.mkdirSync(d, { recursive: true }));

function arg(n) { const i = process.argv.indexOf("--" + n); return i >= 0 ? (process.argv[i + 1] || true) : null; }
function leggiJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } }
function scriviJson(f, v) { const t = f + ".tmp"; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); }
function piano(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

// ── la rete ─────────────────────────────────────────────────────────
// ESPN (Akamai), da questa macchina, rifiuta (403) chi si presenta come
// browser o come node, e lascia passare curl: come la sonda del MAM (clip.js)
const UA = "curl/8.5.0 comotv-fogli";
function chiedi(url, opz, corpo) {
  opz = Object.assign({}, opz || {});
  opz.headers = Object.assign({ "User-Agent": UA }, opz.headers || {});
  return new Promise((ok, no) => {
    const r = https.request(url, opz, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return chiedi(new URL(res.headers.location, url).toString(), { headers: (opz || {}).headers }).then(ok, no);
      }
      const pezzi = [];
      res.on("data", (b) => pezzi.push(b));
      res.on("end", () => ok({ codice: res.statusCode, corpo: Buffer.concat(pezzi), tipo: res.headers["content-type"] || "" }));
    });
    r.on("error", no);
    r.setTimeout(60000, () => r.destroy(new Error("tempo scaduto")));
    if (corpo) r.write(corpo);
    r.end();
  });
}
async function json(url, opz, corpo) {
  const r = await chiedi(url, opz, corpo);
  try { return JSON.parse(r.corpo.toString("utf8")); } catch (e) { throw new Error("risposta non JSON da " + url.split("?")[0] + " (" + r.codice + ")"); }
}

// ── il testo dei file ───────────────────────────────────────────────
function testoDocx(file) {
  // python c'e' sempre, unzip no: i paragrafi di Word, e le celle delle tabelle una per riga
  const py = "import zipfile,re,sys,html\n" +
    "x=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8')\n" +
    "out=[]\n" +
    "for p in re.findall(r'<w:p[ >].*?</w:p>',x,re.S):\n" +
    "  t=''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',p))\n" +
    "  t=html.unescape(t).strip()\n" +
    "  if t: out.append(t)\n" +
    "print('\\n'.join(out))\n";
  return execFileSync("python3", ["-c", py, file], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }).toString("utf8");
}
// LA STRUTTURA, uguale per tutti i fogli. Ogni giornalista scrive a modo suo
// (Word con titoli e tabelle, PDF, testo): qui diventano tutti una lista di
// blocchi, e la lavagna li mostra tutti allo stesso modo.
//   { t: "h1"|"h2"|"h3", x }     titoli di sezione e sottotitoli
//   { t: "p", x, lead? }         paragrafo (lead: l'attacco in grassetto)
//   { t: "li", x, lead? }        voce di elenco
//   { t: "kv", k, v }            voce e valore (le tabelle a due colonne)
//   { t: "tab", righe: [[...]] } tabella vera (classifiche)
// Il Word la dice da solo: stili dei titoli, elenchi numerati, tabelle,
// grassetti. Il PDF no: si ricostruisce dal testo (strutturaTesto).
function strutturaDocx(file) {
  const py = String.raw`
import zipfile,re,sys,json,html
x=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf8')
body=re.search(r'<w:body>(.*)</w:body>',x,re.S).group(1)
def testo(b):
  b=re.sub(r'<w:tab/>',' ',b); b=re.sub(r'<w:br[^>]*/>',' ',b)
  return re.sub(r'\s+',' ',html.unescape(''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>',b)))).strip()
def grassetto(r):
  m=re.search(r'<w:b(?: w:val="([^"]*)")?/>',r)
  return bool(m) and (m.group(1) or '1') not in ('0','false')
out=[]
for m in re.finditer(r'<w:tbl>.*?</w:tbl>|<w:p[ >].*?</w:p>|<w:p/>',body,re.S):
  b=m.group(0)
  if b.startswith('<w:tbl>'):
    righe=[[testo(c) for c in re.findall(r'<w:tc>.*?</w:tc>',r,re.S)] for r in re.findall(r'<w:tr[ >].*?</w:tr>',b,re.S)]
    righe=[r for r in righe if any(r)]
    if righe and all(len(r)==2 for r in righe): out+= [{'t':'kv','k':r[0],'v':r[1]} for r in righe]
    elif righe: out.append({'t':'tab','righe':righe})
    continue
  t=testo(b)
  if not t: continue
  st=re.search(r'<w:pStyle w:val="([^"]+)"',b); st=st.group(1) if st else ''
  lv=re.search(r'(\d)$',st)
  if re.search(r'(titolo|heading|title)',st,re.I):
    out.append({'t':'h'+str(min(3,int(lv.group(1)) if lv else 1)) if not re.search(r'^(title|titolo)$',st,re.I) else 'h0','x':t}); continue
  runs=[r for r in re.findall(r'<w:r[ >].*?</w:r>',b,re.S) if testo(r)]
  bold=[grassetto(r) for r in runs]
  li='<w:numPr>' in b or re.match(r'^[-•–▪·]\s',t)
  if li: t=re.sub(r'^[-•–▪·]\s*','',t)
  if bold and all(bold) and len(t)<=90 and not li:
    out.append({'t':'h3','x':t.rstrip(':')}); continue
  lead=''
  if bold and bold[0] and not all(bold):
    k=0
    while k<len(bold) and bold[k]: k+=1
    lead=' '.join(testo(r) for r in runs[:k]).strip()
    if lead and t.startswith(lead): t=t[len(lead):].strip()
    else: lead=''
  d={'t':'li' if li else 'p','x':t}
  if lead: d['lead']=lead
  out.append(d)
print(json.dumps(out,ensure_ascii=False))
`;
  return JSON.parse(execFileSync("python3", ["-c", py, file], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }).toString("utf8"));
}
// Dal testo nudo (PDF, documenti Google, txt). Le righe spezzate dal PDF si
// riuniscono; una riga corta, con la maiuscola e senza punto in fondo, e' un
// titolo; "Voce: valore" corto e' una voce; trattini e pallini sono elenchi.
function strutturaTesto(testo) {
  const righe = String(testo || "").replace(/\r/g, "").split("\n").map((x) => x.replace(/\s+/g, " ").trim());
  // 1. le righe spezzate dal PDF (anche con una riga vuota in mezzo): si
  //    attacca alla precedente chi comincia minuscolo o con un numero, se la
  //    precedente non finiva la frase
  const unite = [];
  righe.forEach((r) => {
    if (!r) { if (unite.length && unite[unite.length - 1] !== null) unite.push(null); return; }
    let k = unite.length - 1;
    if (unite[k] === null) k--;
    const u = unite[k];
    if (u && !/^[-•–▪·]\s/.test(r) && /^[a-zà-ÿ(0-9,;’']/.test(r) && !/[.!?:]$/.test(u)) {
      unite[k] = u + " " + r; unite.length = k + 1; return;
    }
    unite.push(r);
  });
  const out = [];
  // piu' voci sulla stessa riga: "Capocannoniere: X Piu' impiegato: Y"
  function voci(t) {
    const pezzi = t.split(/\s+(?=[A-ZÀ-Ý][A-Za-zà-ÿ'’-]+(?:\s[a-zà-ÿ'’-]+)?:\s)/);
    const kv = pezzi.map((p) => /^([A-ZÀ-Ý][^:]{1,28}):\s+(.+)$/.exec(p));
    return kv.every(Boolean) ? kv.map((m) => ({ t: "kv", k: m[1].trim(), v: m[2].trim() })) : null;
  }
  unite.forEach((t) => {
    if (!t) return;
    // l'intestazione: "Sabato 29 agosto | Ore 13.30 | Championship | Middlesbrough-WBA"
    if ((t.match(/\s\|\s/g) || []).length >= 2) { out.push({ t: "meta", parti: t.split(/\s\|\s/).map((x) => x.trim()).filter(Boolean) }); return; }
    const barra = /^([^|]{2,28})\s\|\s(.+)$/.exec(t);
    if (barra) { out.push({ t: "kv", k: barra[1].trim(), v: barra[2].trim() }); return; }
    if (/^[-•–▪·]\s*/.test(t) && t.length > 2) { out.push({ t: "li", x: t.replace(/^[-•–▪·]\s*/, "") }); return; }
    if (t.length <= 220) { const v = voci(t); if (v) { out.push.apply(out, v); return; } }
    const corta = t.length <= 70 && !/[.;,]$/.test(t) && /^[A-ZÀ-Ý0-9"“]/.test(t) && (t.match(/\s/g) || []).length <= 9;
    if (corta) {
      const maiuscole = t === t.toUpperCase() && /[A-Z]/.test(t);
      out.push({ t: maiuscole ? "h2" : "h1", x: t.replace(/[:\s-]+$/, "") });
      return;
    }
    // "SCORSA STAGIONE 5° in Championship...": l'attacco in maiuscolo e' il suo titolo
    const attacco = /^((?:[A-ZÀ-Ý]{2,}\s){1,4})(.+)$/.exec(t);
    if (attacco && attacco[2].length > 20) { out.push({ t: "p", lead: attacco[1].trim(), x: attacco[2] }); return; }
    out.push({ t: "p", x: t });
  });
  return out;
}
function testoPdf(file) {
  return execFileSync("pdftotext", ["-enc", "UTF-8", file, "-"], { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }).toString("utf8");
}
function strutturaDi(file, nome, testo) {
  if (/\.docx$/i.test(nome)) { try { return strutturaDocx(file); } catch (e) { console.log("[fogli] struttura Word non letta: " + e.message); } }
  return strutturaTesto(testo);
}
function testoEStruttura(file, nome) {
  const t = testoDi(file, nome);
  return [t, strutturaDi(file, nome, t)];
}
function testoDi(file, nome) {
  if (/\.docx$/i.test(nome)) return testoDocx(file);
  if (/\.pdf$/i.test(nome)) return testoPdf(file);
  return fs.readFileSync(file, "utf8");
}
function pulisci(t) {
  return String(t || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
    .replace(/\\-/g, "-").trim();
}

// ── chi gioca e quando: dal nome del file ────────────────────────────
//  "Wolves -WBA (20-09-2026).docx", "Celtic - Rangers 20-09-2026.pdf",
//  "Middlesbrough-WBA | 29-8-26.pdf", "20260905_5a Eredivisie_Ajax v PSV .pdf",
//  "Foglio_Partita_San_Lorenzo_Boca_Juniors 2.docx", "Curiosita' West Ham - Charlton.pdf"
function dataDa(s) {
  let m = /(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})/.exec(s);
  if (m) {
    const a = m[3].length === 2 ? "20" + m[3] : m[3];
    return a + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
  }
  m = /(20\d\d)(\d\d)(\d\d)/.exec(s);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return "";
}
// competizioni scritte davanti alle squadre, da togliere
const COMPETIZIONI = /^(?:king'?s\s+cup|(?:saudi\s+)?pro\s+league|premier\s+league|premiership|scottish\s+premiership|championship|eredivisie|2\.?\s*bundesliga|bundesliga|serie\s+[ab]|laliga|la\s+liga|liga(?:\s+profesional)?|ligue\s+1|libertadores|sudamericana|copa(?:\s+\w+)?|carabao(?:\s+cup)?|fa\s+cup|primera(?:\s+division)?|clausura|apertura|efl|hnl|mls)\s+/i;
// i documenti che non sono fogli di una partita o di una squadra: elenchi
// arbitri, Opta, running order, teamsheet, palinsesti. Restano nell'archivio
// (le frasi valgono per le schede dei giocatori) ma non fanno da foglio.
const NON_FOGLIO = /arbitri|opta|teamsheet|palinsesto|approfondimento|presentazione|^\s*ro\b|\bro\s+(delle|efl|supert)|efl\s.*carabao\s+cup\s*-\s*\d/i;
function tipoDi(nome, sq) {
  const n = String(nome || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (NON_FOGLIO.test(n)) return "altro";
  if (sq.length === 2) return "partita";
  // "Foglio partita Millwall West Ham": una partita scritta senza separatore
  if (sq.length === 1 && (/partita|intro|curiosita|gara|riserve|panchine/i.test(n) || sq[0].split(" ").length > 3)) return "partita";
  return sq.length === 1 ? "squadra" : "altro";
}
function squadreDa(nome, testo) {
  let s = String(nome || "").normalize("NFC");
  while (ESTENSIONI.test(s)) s = s.replace(ESTENSIONI, "");
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "")        // "Curiosità" scritto con l'accento staccato
    .replace(/\(.*?\)/g, " ").replace(/\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/g, " ").replace(/\b20\d{6}\b/g, " ")
    .replace(/\b\d{1,2}\s+\d{1,2}\s+20\d{2}\b/g, " ")                     // "1 03 2026"
    .replace(/([A-Za-zÀ-ÿ]{3,})\.([A-Za-zÀ-ÿ]{3,})/g, "$1 - $2")                 // "River.Bragantino"
    .replace(/\b(?:20)?\d{2}\s*[:/-]\s*(?:20)?\d{2}\b/g, " ")     // la stagione: 2026:27, 26-27
    .replace(/_/g, " ").replace(/\|/g, " ")
    .replace(/\b(foglio|partita|appunti|curiosita|note|scheda|giornata|rosa|intro|squadre|gara|riserve|panchine|semifinali?|quarti|ottavi|finale|playoff|po|round|\d+[aª°]|\d+)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  // prima i separatori con gli spazi ("Al-Hilal v Al-Faisaly"), poi il trattino attaccato
  let pezzi = s.split(/\s+(?:-|–|v|vs|x)\.?\s+/i).map((x) => x.trim()).filter(Boolean);
  if (pezzi.length !== 2) pezzi = s.split(/\s*[-–]\s*/).map((x) => x.trim()).filter(Boolean);
  // "Al-Ula FC", "Al-Hilal": un pezzo di una o due lettere non e' una squadra
  if (pezzi.length === 2 && pezzi[0].length <= 2) pezzi = [pezzi[0] + "-" + pezzi[1]];
  if (pezzi.length !== 2) {
    // nel testo: la prima riga del tipo "SAN LORENZO vs BOCA JUNIORS" o "... | Middlesbrough-WBA"
    const righe = String(testo || "").split("\n").slice(0, 6);
    for (const r of righe) {
      const m = /([A-Za-zÀ-ÿ'.& ]{3,40}?)\s+(?:vs|v|-|–)\s+([A-Za-zÀ-ÿ'.& ]{3,40})\s*$/i.exec(r.split("|").pop().trim());
      if (m) { pezzi = [m[1].trim(), m[2].trim()]; break; }
    }
  }
  if (pezzi.length > 2) pezzi = pezzi.slice(-2);
  pezzi = pezzi.map((x) => x.replace(COMPETIZIONI, "").replace(COMPETIZIONI, "").replace(/[.,;:\s]+$/, "").trim()).filter(Boolean);
  if (pezzi.length === 2) return pezzi;
  // un pezzo solo: la scheda di una squadra ("Liverpool 2026:27") o una
  // partita scritta senza separatore ("INTRO APPUNTI AL ITTIHAD AL FAYHA"):
  // lo decide tipoDi
  if (pezzi.length === 1 && !/arbitri|opta|palinsesto|approfondimento|presentazione/i.test(nome)) return pezzi;
  return [];
}
// ── salvare un foglio ───────────────────────────────────────────────
function salva(meta, testo, blocchi) {
  testo = pulisci(testo);
  if (testo.length < 200) return false;              // un file vuoto o un'immagine: non e' un foglio
  const id = meta.id;
  const squadre = squadreDa(meta.nomeFile, testo);
  const data = dataDa(meta.nomeFile) || (meta.quando || "").slice(0, 10);
  const f = {
    id, nomeFile: meta.nomeFile, titolo: meta.nomeFile.replace(ESTENSIONI, "").replace(/_/g, " ").trim(),
    squadre, chiavi: squadre.map(piano), data, autore: meta.autore || "",
    fonte: meta.fonte, link: meta.link || "", caricato: meta.quando || "", hash: crypto.createHash("sha1").update(testo).digest("hex").slice(0, 12),
    testo, blocchi: blocchi || strutturaTesto(testo)
  };
  scriviJson(path.join(PUB, "fogli", id + ".json"), f);
  return true;
}

// ── l'indice e i nomi, rifatti da capo da quello che c'e' ─────────────
//  Un nome proprio e' una parola con la maiuscola (anche tutta maiuscola nei
//  titoli). Le frasi si tengono corte: il giornalista ne legge poche righe.
function rifai() {
  const dir = path.join(PUB, "fogli");
  const tutti = fs.readdirSync(dir).filter((x) => x.endsWith(".json")).map((x) => leggiJson(path.join(dir, x), null)).filter(Boolean);
  // i fogli salvati prima della struttura: la si ricava dal testo
  tutti.forEach((f) => {
    // i fogli gia' salvati si rileggono con le regole di adesso (squadre, struttura)
    const sq = squadreDa(f.nomeFile || f.titolo + ".docx", f.testo);
    const cambia = !f.blocchi || JSON.stringify(sq) !== JSON.stringify(f.squadre);
    if (!f.blocchi) f.blocchi = strutturaTesto(f.testo);
    f.squadre = sq; f.chiavi = sq.map(piano);
    if (cambia) scriviJson(path.join(dir, f.id + ".json"), f);
  });
  // lo stesso foglio da Slack e da Drive: vale una volta sola (il testo e' uguale)
  const visti = {}, fogli = [];
  tutti.sort((a, b) => (a.fonte === "slack" ? 0 : 1) - (b.fonte === "slack" ? 0 : 1));
  tutti.forEach((f) => { if (visti[f.hash]) return; visti[f.hash] = 1; fogli.push(f); });
  fogli.sort((a, b) => String(b.data || b.caricato).localeCompare(String(a.data || a.caricato)));
  scriviJson(path.join(PUB, "indice.json"), {
    aggiornato: new Date().toISOString(),
    // tipo: partita (due squadre), squadra (una), altro. cerca: titolo e prime
    // righe, per agganciare anche "Millwall West Ham" senza separatore
    fogli: fogli.map((f) => ({ id: f.id, titolo: f.titolo, squadre: f.squadre, chiavi: f.chiavi, data: f.data,
                              tipo: tipoDi(f.nomeFile || f.titolo, f.squadre),
                              cerca: piano(f.titolo + " " + String(f.testo || "").slice(0, 300)),
                              autore: f.autore, fonte: f.fonte, link: f.link }))
  });
  // I NOMI si cercano sezione per sezione: la frase si porta dietro il titolo
  // della sua sezione. Le sezioni sull'arbitro restano fuori: li' un
  // giocatore compare solo come marcatore di una partita arbitrata da lui
  // (Merentiel nel foglio San Lorenzo-Boca), e non e' una curiosita' sua.
  const ARBITRO = /arbitr|\bvar\b|assistent|designat|direttore di gara|quarto uomo|4° uomo/i;
  const nomi = {};
  fogli.forEach((f) => {
    const B = f.blocchi && f.blocchi.length ? f.blocchi : strutturaTesto(f.testo);
    let sezione = "", sotto = "";
    B.forEach((b) => {
      if (b.t === "h0" || b.t === "h1") { sezione = b.x || ""; sotto = ""; return; }
      if (b.t === "h2" || b.t === "h3") { sotto = b.x || ""; return; }
      if (ARBITRO.test(sezione) || ARBITRO.test(sotto)) return;
      let testo = "";
      if (b.t === "p" || b.t === "li") testo = (b.lead ? b.lead + " " : "") + (b.x || "");
      else if (b.t === "kv") { if (ARBITRO.test(b.k || "")) return; testo = b.k + ": " + b.v; }
      else return;
      const frasi = testo.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý"“(])/).map((x) => x.trim()).filter((x) => x.length > 25);
      frasi.forEach((fr) => {
        const corta = fr.length > 420 ? fr.slice(0, 417) + "…" : fr;
        const parole = fr.match(/[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]{2,}/g) || [];
        const gia = {};
        parole.forEach((p) => {
          const k = piano(p).replace(/\s+/g, "-");
          if (k.length < 3 || gia[k]) return;
          gia[k] = 1;
          (nomi[k] = nomi[k] || []).push({ id: f.id, frase: corta, sezione: sotto || sezione });
        });
      });
    });
  });
  const dn = path.join(PUB, "nomi");
  fs.readdirSync(dn).forEach((x) => { try { fs.unlinkSync(path.join(dn, x)); } catch (e) {} });
  Object.keys(nomi).forEach((k) => {
    if (!/^[a-z0-9-]+$/.test(k)) return;
    fs.writeFileSync(path.join(dn, k + ".json"), JSON.stringify(nomi[k].slice(0, 60)));
  });
  console.log("[fogli] indice: " + fogli.length + " fogli, " + Object.keys(nomi).length + " nomi");
}

// ── Slack ───────────────────────────────────────────────────────────
async function giroSlack(stato) {
  const T = process.env.SLACK_TOKEN;
  if (!T) { console.log("[fogli] Slack: manca SLACK_TOKEN, salto"); return 0; }
  const H = { Authorization: "Bearer " + T };
  const utenti = stato.utenti || (stato.utenti = {});
  let nuovi = 0;
  for (const canale of String(process.env.SLACK_CANALI || "C0AG3PSDTAR").split(",").map((x) => x.trim()).filter(Boolean)) {
    const visti = stato.slack || (stato.slack = {});
    let cursore = "", pagine = 0;
    do {
      const j = await json("https://slack.com/api/conversations.history?limit=200&channel=" + canale +
                           (cursore ? "&cursor=" + encodeURIComponent(cursore) : ""), { headers: H });
      if (!j.ok) throw new Error("Slack: " + j.error);
      for (const m of j.messages || []) {
        for (const fl of m.files || []) {
          if (!ESTENSIONI.test(fl.name || "") || visti[fl.id]) continue;
          const url = fl.url_private_download || fl.url_private;
          if (!url) continue;
          const r = await chiedi(url, { headers: H });
          if (r.codice !== 200 || /text\/html/.test(r.tipo)) { console.log("[fogli] Slack: non scaricato " + fl.name + " (" + r.codice + ")"); continue; }
          const tmp = path.join(TMP, fl.id + path.extname(fl.name));
          fs.writeFileSync(tmp, r.corpo);
          if (m.user && !utenti[m.user]) {
            try {
              const u = await json("https://slack.com/api/users.info?user=" + m.user, { headers: H });
              utenti[m.user] = u.ok ? (u.user.real_name || u.user.name) : "";
            } catch (e) { utenti[m.user] = ""; }
          }
          try {
            const ok = salva({ id: "s-" + fl.id, nomeFile: fl.name, fonte: "slack", autore: utenti[m.user] || "",
                               quando: new Date(parseFloat(m.ts) * 1000).toISOString(),
                               link: "https://comotv.slack.com/archives/" + canale + "/p" + String(m.ts).replace(".", "") },
                             ...testoEStruttura(tmp, fl.name));
            if (ok) nuovi++;
            visti[fl.id] = 1;
          } catch (e) { console.log("[fogli] Slack: testo non letto da " + fl.name + ": " + e.message); visti[fl.id] = 1; }
          try { fs.unlinkSync(tmp); } catch (e) {}
        }
      }
      cursore = (j.response_metadata || {}).next_cursor || "";
    } while (cursore && ++pagine < 50);
  }
  return nuovi;
}

// ── Drive, con l'account di servizio ─────────────────────────────────
async function tokenGoogle() {
  const f = process.env.GOOGLE_SA_FILE;
  if (!f || !fs.existsSync(f)) return null;
  const sa = JSON.parse(fs.readFileSync(f, "utf8"));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const ora = Math.floor(Date.now() / 1000);
  const corpo = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
                                                                 aud: "https://oauth2.googleapis.com/token", iat: ora, exp: ora + 3500 });
  const firma = crypto.createSign("RSA-SHA256").update(corpo).sign(sa.private_key, "base64url");
  const q = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + corpo + "." + firma;
  const j = await json("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }, q);
  if (!j.access_token) throw new Error("Google: " + (j.error_description || j.error || "niente token"));
  return j.access_token;
}
// ARCHIVIO APPUNTI e' aperta a chi ha il link: senza account di servizio la
// si legge come la legge un browser (l'elenco di embeddedfolderview e lo
// scarico diretto), senza nessuna chiave. Con l'account si usa l'API.
const MESI_EN = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function dataElenco(t) {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(String(t || "").trim());
  if (!m || MESI_EN[m[1].toLowerCase()] === undefined) return "";
  const ora = new Date();
  let a = m[3] ? +m[3] : ora.getFullYear();
  const d = new Date(Date.UTC(a, MESI_EN[m[1].toLowerCase()], +m[2], 12));
  if (!m[3] && d > ora) d.setUTCFullYear(a - 1);     // "Dec 20" visto a gennaio e' dell'anno prima
  return d.toISOString();
}
async function giroDriveAperto(stato, cartelle) {
  const visti = stato.drive || (stato.drive = {});
  const coda = cartelle.slice(), giro = {};
  let nuovi = 0;
  const html = (t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  while (coda.length) {
    const c = coda.shift();
    if (giro[c]) continue;
    giro[c] = 1;
    let r;
    try { r = await chiedi("https://drive.google.com/embeddedfolderview?id=" + encodeURIComponent(c)); }
    catch (e) { console.log("[fogli] Drive: cartella " + c + " saltata (" + e.message + "), al prossimo giro"); continue; }
    if (r.codice !== 200) { console.log("[fogli] Drive: cartella " + c + " non leggibile (" + r.codice + ")"); continue; }
    const t = r.corpo.toString("utf8");
    const voci = t.split('<div class="flip-entry" id="entry-').slice(1);
    for (const v of voci) {
      const id = v.slice(0, v.indexOf('"'));
      const href = (/<a href="([^"]+)"/.exec(v) || [])[1] || "";
      const nome = html((/flip-entry-title">([^<]*)</.exec(v) || [])[1] || "").trim();
      const mod = ((/flip-entry-last-modified">\s*<div>([^<]*)</.exec(v) || [])[1] || "").trim();
      if (/\/drive\/folders\//.test(href)) { coda.push(id); continue; }
      const doc = /docs\.google\.com\/document\//.test(href);
      if (!doc && !ESTENSIONI.test(nome)) continue;
      if (visti[id] === (mod || "?")) continue;
      const url = doc ? "https://docs.google.com/document/d/" + id + "/export?format=txt"
                      : "https://drive.google.com/uc?export=download&id=" + id;
      // un file lento non ferma il giro: si salta e si riprova la prossima volta
      let f;
      try { f = await chiedi(url); }
      catch (e) { console.log("[fogli] Drive: " + nome + " saltato (" + e.message + "), al prossimo giro"); continue; }
      if (f.codice !== 200 || /text\/html/.test(f.tipo)) { console.log("[fogli] Drive: non scaricato " + nome + " (" + f.codice + ")"); continue; }
      const n2 = doc ? nome + ".txt" : nome;
      const tmp = path.join(TMP, id + path.extname(n2));
      fs.writeFileSync(tmp, f.corpo);
      try {
        if (salva({ id: "d-" + id, nomeFile: n2, fonte: "drive", autore: "",
                    quando: dataElenco(mod) || new Date().toISOString(),
                    link: doc ? "https://docs.google.com/document/d/" + id + "/view" : "https://drive.google.com/file/d/" + id + "/view" },
                  ...testoEStruttura(tmp, n2))) nuovi++;
      } catch (e) { console.log("[fogli] Drive: testo non letto da " + nome + ": " + e.message); }
      visti[id] = mod || "?";
      try { fs.unlinkSync(tmp); } catch (e) {}
      await new Promise((ok) => setTimeout(ok, 300));      // piano: e' Google, non casa nostra
    }
  }
  return nuovi;
}
async function giroDrive(stato) {
  const cartelle = String(process.env.DRIVE_CARTELLE || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!cartelle.length) { console.log("[fogli] Drive: nessuna cartella, salto"); return 0; }
  const tok = await tokenGoogle();
  if (!tok) return giroDriveAperto(stato, cartelle);
  const H = { Authorization: "Bearer " + tok };
  const visti = stato.drive || (stato.drive = {});
  const API = "https://www.googleapis.com/drive/v3/files";
  let nuovi = 0;
  const coda = cartelle.slice(), giro = {};
  while (coda.length) {
    const c = coda.shift();
    if (giro[c]) continue;
    giro[c] = 1;
    let pag = "";
    do {
      const j = await json(API + "?pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true" +
        "&fields=nextPageToken,files(id,name,mimeType,modifiedTime,createdTime,webViewLink,owners(displayName))" +
        "&q=" + encodeURIComponent("'" + c + "' in parents and trashed = false") + (pag ? "&pageToken=" + pag : ""), { headers: H });
      if (j.error) throw new Error("Drive: " + j.error.message);
      for (const fl of j.files || []) {
        if (fl.mimeType === "application/vnd.google-apps.folder") { coda.push(fl.id); continue; }
        const doc = fl.mimeType === "application/vnd.google-apps.document";
        if (!doc && !ESTENSIONI.test(fl.name)) continue;
        if (visti[fl.id] === fl.modifiedTime) continue;
        const url = doc ? API + "/" + fl.id + "/export?mimeType=text/plain" : API + "/" + fl.id + "?alt=media&supportsAllDrives=true";
        const r = await chiedi(url, { headers: H });
        if (r.codice !== 200) { console.log("[fogli] Drive: non scaricato " + fl.name + " (" + r.codice + ")"); continue; }
        const nome = doc ? fl.name + ".txt" : fl.name;
        const tmp = path.join(TMP, fl.id + path.extname(nome));
        fs.writeFileSync(tmp, r.corpo);
        try {
          if (salva({ id: "d-" + fl.id, nomeFile: nome, fonte: "drive", autore: ((fl.owners || [])[0] || {}).displayName || "",
                      quando: fl.createdTime, link: fl.webViewLink }, ...testoEStruttura(tmp, nome))) nuovi++;
        } catch (e) { console.log("[fogli] Drive: testo non letto da " + fl.name + ": " + e.message); }
        visti[fl.id] = fl.modifiedTime;
        try { fs.unlinkSync(tmp); } catch (e) {}
      }
      pag = j.nextPageToken || "";
    } while (pag);
  }
  return nuovi;
}

// ── LE PARTITE DA AIRTABLE ──────────────────────────────────────────
const AT_BASE = "appdDMcS8JQ4PTdLB", AT_TAB = "tblXKPRWFCLw5pVSt";
// le competizioni di Airtable e il loro codice ESPN ("" = ESPN non l'ha:
// giovanili, King's Cup, HNL... la formazione si mette a mano)
const AT_ESPN = {
  "Serie A": "ita.1", "Serie B": "ita.2", "Coppa Italia": "ita.coppa_italia", "seriea": "ita.1",
  "Clausura Liga Profesional": "arg.1", "Apertura Liga Profesional": "arg.1",
  "Copa Libertadores": "conmebol.libertadores", "Copa Sudamericana": "conmebol.sudamericana",
  "Recopa Sudamericana": "conmebol.recopa", "Coppa di Portogallo": "por.taca.portugal", "Eredivisie": "ned.1",
  "Saudi Pro League": "ksa.1", "Scottish Championship": "sco.2", "Scottish League Cup ": "sco.cis",
  "Scottish League Cup": "sco.cis", "Premier Sports Cup": "sco.cis", "Scottish Premiership": "sco.1",
  "Scottish Cup": "sco.tennents", "Coppa di Francia": "fra.coupe_de_france", "Carabao Cup": "eng.league_cup",
  "Championship": "eng.2", "Coppa di Germania": "ger.dfb_pokal", "Bundesliga Austria": "aut.1",
  "UEFA Champions League": "uefa.champions"
};
// non sono partite: studio, programmi, altri sport
const AT_NON_PARTITE = /^(Studio Live|Studio REC|PRER|EVENTO REC|Karate Combat|Cage Warriors|Maratona|Premiazione|Training Live|Kings League)$/;
// nelle colonne dei telecronisti c'e' anche altro: segni di lavoro, non persone
const AT_NON_NOMI = /^(NO TELECRONACA|\?+|TBC|TBD|OK|SOCIAL|RINVIATA|DA CAMBIARE|!+|\d+|NUOVA STAGIONE|RODSSDI|SOLARIOI)$/i;
function atLeggi(url) {
  return chiedi(url, { headers: { Authorization: "Bearer " + process.env.COMOTV_AIRTABLE_PAT } }).then((r) => {
    if (r.codice !== 200) throw new Error("Airtable risponde " + r.codice);
    return JSON.parse(r.corpo.toString("utf8"));
  });
}
// "GENOA-COMO [ITA]", "PARMA-COMO 3-4 (dcr)" -> casa, ospite, lingua
function atPartita(t) {
  let g = String(t || "");
  const et = g.match(/\[([^\]]+)\]/);
  g = g.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+RINVIATA.*$/i, "").replace(/\s*\(\d+-\d+.*?\).*$/i, "")
       .replace(/\s+\d+-\d+\s*(dcr)?.*$/i, "").replace(/\s{2,}/g, " ").trim();
  let p = g.split(/\s+-\s+/);
  if (p.length !== 2) p = g.split("-");
  if (p.length > 2) p = [p[0], p.slice(1).join("-")];
  return { casa: (p[0] || "").trim(), ospite: (p[1] || "").trim(), lingua: et ? et[1].trim().toUpperCase() : "" };
}
function pianoS(t) { return piano(t).replace(/\b(fc|cf|sc|ac|afc|cd|club|calcio|united|city|town|county|wanderers|albion|athletic|1907|de|la|del)\b/g, " ").replace(/\s+/g, " ").trim(); }
// i nomi corti dei giornalisti e quelli italiani di Airtable, contro ESPN
const ALIAS_NOMI = {
  "wolves": "wolverhampton", "wba": "west bromwich", "west brom": "west bromwich", "spurs": "tottenham",
  "boro": "middlesbrough", "man utd": "manchester united", "man city": "manchester city", "psv": "psv eindhoven",
  "qpr": "queens park rangers", "ind santa fe": "independiente santa fe", "ldu": "ldu quito",
  "salisburgo": "salzburg", "siviglia": "sevilla", "lipsia": "leipzig", "stoccarda": "stuttgart",
  "friburgo": "freiburg", "colonia": "koln", "magonza": "mainz", "norimberga": "nurnberg",
  "monaco di baviera": "bayern", "bayern monaco": "bayern", "lisbona": "lisbon", "porto": "fc porto"
};
function conAlias(t) { const k = piano(t); return ALIAS_NOMI[k] || k; }
function stessoNome(a, b) {
  const x = pianoS(conAlias(a)), y = pianoS(conAlias(b));
  if (!x || !y) return false;
  return (" " + x + " ").indexOf(" " + y + " ") >= 0 || (" " + y + " ").indexOf(" " + x + " ") >= 0 ||
         x.split(" ")[0] === y.split(" ")[0] && x.split(" ")[0].length >= 5;
}
const SCORE = {};
async function partitaEspn(lega, quando, casa, ospite) {
  // la data italiana e quella di prima: le partite sudamericane di notte per ESPN sono del giorno prima
  const d = new Date(quando), giorni = [];
  [0, -1, 1].forEach((k) => { const x = new Date(d.getTime() + k * 864e5); giorni.push(x.toISOString().slice(0, 10).replace(/-/g, "")); });
  for (const g of giorni) {
    const k = lega + "|" + g;
    if (!SCORE[k]) {
      try { SCORE[k] = await json("https://site.api.espn.com/apis/site/v2/sports/soccer/" + lega + "/scoreboard?dates=" + g); }
      catch (e) { SCORE[k] = {}; }
    }
    for (const e of SCORE[k].events || []) {
      const c = ((e.competitions || [])[0] || {}).competitors || [];
      const h = c.filter((x) => x.homeAway === "home")[0], a = c.filter((x) => x.homeAway === "away")[0];
      if (!h || !a) continue;
      const nh = [h.team.displayName, h.team.shortDisplayName, h.team.name], na = [a.team.displayName, a.team.shortDisplayName, a.team.name];
      const ok = (nomi, x) => nomi.some((n) => stessoNome(n, x));
      if ((ok(nh, casa) && ok(na, ospite)) || (ok(nh, ospite) && ok(na, casa)))
        return { lega, ev: String(e.id), nome: e.name, casa: h.team.displayName, ospite: a.team.displayName };
    }
  }
  return null;
}
async function giroPartite() {
  if (!process.env.COMOTV_AIRTABLE_PAT) { console.log("[fogli] Airtable: manca il token, salto le partite"); return; }
  const formula = "AND(IS_AFTER({Data | Orario}, DATEADD(TODAY(), -2, 'days')), IS_BEFORE({Data | Orario}, DATEADD(TODAY(), 22, 'days')), " +
                  "NOT({Partita} = BLANK()), NOT(FIND(\"RINVIATA\", UPPER({Partita}))), NOT(FIND(\"PRE SHOW\", UPPER({Partita}))))";
  let off = "", righe = [], giri = 0;
  do {
    const q = new URLSearchParams({ filterByFormula: formula, pageSize: "100", "sort[0][field]": "Data | Orario" });
    ["Partita", "Data | Orario", "Competizione", "Turno", "Commento 1", "Commento 2"].forEach((c, i) => q.append("fields[]", c));
    if (off) q.set("offset", off);
    const j = await atLeggi("https://api.airtable.com/v0/" + AT_BASE + "/" + AT_TAB + "?" + q.toString());
    righe = righe.concat(j.records || []);
    off = j.offset || "";
  } while (off && ++giri < 20);
  // una riga per feed (ITA, ENG, AUDIO): si uniscono per giorno e squadre
  const unite = new Map();
  righe.forEach((r) => {
    const f = r.fields || {}, comp = String(f["Competizione"] || "").trim();
    if (AT_NON_PARTITE.test(comp)) return;
    const p = atPartita(f["Partita"]);
    if (!p.casa || !p.ospite) return;
    const quando = f["Data | Orario"] || "";
    const chiave = quando.slice(0, 10) + "|" + piano(p.casa) + "|" + piano(p.ospite);
    const tel = [].concat(f["Commento 1"] || [], f["Commento 2"] || []).map((x) => String(x).trim())
      .filter((x) => x && !AT_NON_NOMI.test(x));
    const u = unite.get(chiave) || { id: r.id, quando, competizione: comp, turno: f["Turno"] || "", casa: p.casa, ospite: p.ospite,
                                    lega: AT_ESPN[comp] || AT_ESPN[comp.trim()] || "", telecronisti: [], lingue: [] };
    tel.forEach((n) => { if (!u.telecronisti.some((t) => t.nome === n)) u.telecronisti.push({ nome: n, lingua: p.lingua || "" }); });
    if (p.lingua && u.lingue.indexOf(p.lingua) < 0) u.lingue.push(p.lingua);
    unite.set(chiave, u);
  });
  const partite = Array.from(unite.values());
  // la partita ESPN e il foglio CURIOSITA' di ognuna
  const indice = leggiJson(path.join(PUB, "indice.json"), { fogli: [] }).fogli || [];
  for (const m of partite) {
    if (m.lega) { try { m.espn = await partitaEspn(m.lega, m.quando, m.casa, m.ospite); } catch (e) { m.espn = null; } }
    const giorno = m.quando.slice(0, 10), t0 = Date.parse(giorno);
    m.fogli = indice.filter((f) => {
      if (f.tipo !== "partita") return false;
      const dt = Math.abs(Date.parse(f.data) - t0) / 864e5;
      if (!(dt <= 5)) return false;
      const k = f.chiavi || [];
      // i nomi di Airtable e, se c'e', quelli di ESPN
      const C = [m.casa].concat(m.espn ? [m.espn.casa] : []), O = [m.ospite].concat(m.espn ? [m.espn.ospite] : []);
      const uno = (k1, lista) => lista.some((n) => stessoNome(k1, n));
      if (k.length === 2) return (uno(k[0], C) && uno(k[1], O)) || (uno(k[0], O) && uno(k[1], C));
      return stessoNome(f.cerca || "", m.casa) && stessoNome(f.cerca || "", m.ospite) ||
             (f.cerca || "").indexOf(pianoS(m.casa)) >= 0 && (f.cerca || "").indexOf(pianoS(m.ospite)) >= 0;
    }).map((f) => f.id);
  }
  scriviJson(path.join(PUB, "partite.json"), { aggiornato: new Date().toISOString(), partite });
  console.log("[fogli] partite: " + partite.length + " da Airtable, " + partite.filter((m) => m.espn).length +
              " con ESPN, " + partite.filter((m) => m.fogli.length).length + " con le curiosita'");
}

(async () => {
  const stato = leggiJson(STATO, {});
  if (arg("partite")) return giroPartite();
  if (arg("rifai")) return rifai();
  const f = arg("file");
  if (f) {
    const nome = path.basename(f);
    const ok = salva({ id: "m-" + crypto.createHash("sha1").update(nome).digest("hex").slice(0, 12), nomeFile: nome, fonte: "mano",
                       autore: arg("autore") || "", quando: arg("data") || new Date().toISOString() }, ...testoEStruttura(f, nome));
    console.log(ok ? "[fogli] salvato " + nome : "[fogli] " + nome + ": testo troppo corto");
    return rifai();
  }
  let nuovi = 0;
  const prima = fs.readdirSync(path.join(PUB, "fogli")).length;
  for (const [nome, giro] of [["Slack", giroSlack], ["Drive", giroDrive]]) {
    try { nuovi += await giro(stato); } catch (e) { console.log("[fogli] " + nome + ": " + e.message); }
    scriviJson(STATO, stato);
  }
  // anche un giro fermato a meta' puo' aver salvato dei fogli: si guarda la cartella
  const dopo = fs.readdirSync(path.join(PUB, "fogli")).length;
  if (nuovi || dopo !== prima || !fs.existsSync(path.join(PUB, "indice.json"))) rifai();
  console.log("[fogli] giro fatto: " + nuovi + " fogli nuovi");
  try { await giroPartite(); } catch (e) { console.log("[fogli] partite: " + e.message); }
})().catch((e) => { console.error("[fogli] ERRORE " + e.message); process.exit(1); });
