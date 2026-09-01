#!/usr/bin/env node
/*
 * Sonda formazioni ufficiali — Como TV
 * ------------------------------------
 * Serve a rispondere a una domanda sola: CON QUANTO ANTICIPO ESPN pubblica
 * le formazioni ufficiali, e se prima di quelle mette delle probabili che
 * poi cambiano. Finche' non lo sappiamo non possiamo fidarci a mandarle in
 * onda in automatico.
 *
 * Gira ogni 5 minuti dal cron. Per ogni partita che comincia entro 3 ore
 * (o cominciata da meno di 20 minuti) guarda il blocco "rosters" del
 * summary ESPN e annota SOLO i cambi di stato:
 *   - la prima volta che la vede vuota
 *   - l'istante in cui si riempie  → e quanti minuti mancano al fischio
 *   - se dopo la pubblicazione l'undici CAMBIA  → erano probabili
 *
 * Non tocca niente: legge da ESPN e scrive due file suoi.
 *   registro: /var/lib/comotv-dev/sonda-formazioni.log
 *   memoria:  /var/lib/comotv-dev/sonda-formazioni.json
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const CASA = "/var/lib/comotv-dev";
const REGISTRO = path.join(CASA, "sonda-formazioni.log");
const MEMORIA = path.join(CASA, "sonda-formazioni.json");

const LEGHE = [
  // campionati
  "ita.1", "ita.2", "eng.1", "eng.2", "esp.1", "ger.1", "ger.2", "fra.1", "ned.1", "por.1",
  // coppe: su ESPN hanno un codice loro, non stanno dentro il campionato
  "ita.coppa_italia", "esp.copa_del_rey", "ger.dfb_pokal", "eng.fa", "eng.league_cup",
  "fra.coupe_de_france",
  // europee
  "uefa.champions", "uefa.europa", "uefa.europa.conf"
];

const PRIMA = 3 * 60;      // minuti prima del fischio da cui cominciamo a guardare
const DOPO = 20;           // minuti dopo il fischio oltre i quali smettiamo

function prendi(url) {
  return new Promise((ok, no) => {
    // Il bordo di ESPN, viste dalla VM, respinge i client che non conosce
    // (403 anche a "Mozilla/5.0" e a chi non si presenta): questa forma passa
    // e dice comunque chi siamo.
    const req = https.get(url, { headers: { "User-Agent": "curl/8.5.0 comotv-sonda" } }, res => {
      if (res.statusCode !== 200) { res.resume(); return no(new Error("HTTP " + res.statusCode)); }
      let b = "";
      res.setEncoding("utf8");
      res.on("data", d => b += d);
      res.on("end", () => { try { ok(JSON.parse(b)); } catch (e) { no(e); } });
    });
    req.on("error", no);
    req.setTimeout(20000, () => { req.destroy(new Error("tempo scaduto")); });
  });
}

function iso(d) { return new Date(d).toISOString().replace(/\.\d+Z$/, "Z"); }
function giornoEspn(d) {
  return d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0");
}
function scrivi(riga) {
  fs.appendFileSync(REGISTRO, riga + "\n");
  console.log(riga);
}

// l'impronta dell'undici: se cambia, quella di prima era una probabile
function improntaUndici(blocchi) {
  return blocchi.map(t => {
    const tit = (t.roster || []).filter(x => x.starter)
      .map(x => String(x.jersey || "") + ":" + ((x.athlete || {}).lastName || "")).sort();
    return (t.formation || "?") + "|" + tit.join(",");
  }).join(" || ");
}

async function main() {
  fs.mkdirSync(CASA, { recursive: true });
  let memoria = {};
  try { memoria = JSON.parse(fs.readFileSync(MEMORIA, "utf8")); } catch (e) {}

  const adesso = new Date();
  const giorni = [giornoEspn(new Date(adesso.getTime() - 864e5)), giornoEspn(adesso), giornoEspn(new Date(adesso.getTime() + 864e5))];
  const visti = new Set();

  for (const lega of LEGHE) {
    let sb;
    try { sb = await prendi(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lega}/scoreboard?dates=${giorni[0]}-${giorni[2]}`); }
    catch (e) { continue; }

    for (const ev of (sb.events || [])) {
      const inizio = new Date(ev.date);
      const mancano = Math.round((inizio - adesso) / 60000);
      if (mancano > PRIMA || mancano < -DOPO) continue;

      visti.add(ev.id);
      let s;
      try { s = await prendi(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lega}/summary?event=${ev.id}`); }
      catch (e) { continue; }

      const blocchi = s.rosters || [];
      const piene = blocchi.filter(t => (t.roster || []).some(x => x.starter)).length >= 2;
      const impronta = piene ? improntaUndici(blocchi) : "";
      const prima = memoria[ev.id] || {};
      const eti = `${lega} ${ev.id} ${ev.shortName || ev.name}`;
      const quando = `fischio ${iso(ev.date)}`;

      if (!piene) {
        if (!prima.stato) {
          scrivi(`${iso(adesso)} ${eti} | ${quando} | t${mancano >= 0 ? "-" : "+"}${Math.abs(mancano)}min | ancora VUOTE`);
          memoria[ev.id] = { stato: "vuote", visto: iso(adesso) };
        }
        continue;
      }

      if (prima.stato !== "piene") {
        // se non l'avevamo mai vista vuota non sappiamo QUANDO sono uscite:
        // dirlo, altrimenti il registro sembra misurare un anticipo che non ha misurato
        const misurato = prima.stato === "vuote";
        const voce = misurato
          ? `PUBBLICATE fra t${mancano >= 0 ? "-" : "+"}${Math.abs(mancano)}min (vuote fino a poco fa)`
          : `gia' pubblicate al primo sguardo, t${mancano >= 0 ? "-" : "+"}${Math.abs(mancano)}min (anticipo non misurato)`;
        scrivi(`${iso(adesso)} ${eti} | ${quando} | ${voce} | ${blocchi.map(t => t.formation || "?").join(" / ")}`);
        memoria[ev.id] = { stato: "piene", pubblicate: iso(adesso), anticipo: misurato ? mancano : null, impronta: impronta };
        continue;
      }

      if (prima.impronta && prima.impronta !== impronta) {
        scrivi(`${iso(adesso)} ${eti} | ${quando} | t${mancano >= 0 ? "-" : "+"}${Math.abs(mancano)}min | CAMBIATE dopo la pubblicazione (erano probabili?) | ${blocchi.map(t => t.formation || "?").join(" / ")}`);
        memoria[ev.id].impronta = impronta;
        memoria[ev.id].cambiata = iso(adesso);
      }
    }
  }

  // la memoria non deve gonfiarsi: via le partite vecchie di piu' di 3 giorni
  const limite = Date.now() - 3 * 864e5;
  for (const id of Object.keys(memoria)) {
    const q = memoria[id].pubblicate || memoria[id].visto;
    if (q && new Date(q).getTime() < limite && !visti.has(id)) delete memoria[id];
  }
  fs.writeFileSync(MEMORIA, JSON.stringify(memoria));
}

main().catch(e => {
  try { fs.appendFileSync(REGISTRO, `${iso(new Date())} SONDA IN ERRORE: ${e.message}\n`); } catch (x) {}
  process.exit(1);
});
