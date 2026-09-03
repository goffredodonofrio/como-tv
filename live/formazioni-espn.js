/* Formazioni ufficiali da ESPN — modulo condiviso
 * ------------------------------------------------
 * Lo usano sia Formazioni sia Formazioni Premium: le due pagine hanno lo
 * stesso modello di squadra (roster, tit, pan, mod), quindi la logica sta
 * qui una volta sola e non puo' divergere.
 *
 * ESPN tiene le formazioni nel blocco "rosters" del summary della partita:
 * prima della pubblicazione c'e' ma e' VUOTO, e si riempie quando escono le
 * ufficiali. Da li' prendiamo modulo, undici e panchina.
 *
 *   FormazioniEspn.monta(contenitore, {
 *     comps:  COMPS,        // le competizioni dell'editor (per le rose)
 *     moduli: MODULI,       // i moduli che sappiamo disegnare
 *     nbench: NBENCH,
 *     sides:  sides,        // le due squadre da riempire
 *     dopo:   function (esito) { ... }   // ridisegna la pagina
 *   });
 */
(function () {
  "use strict";

  var API = "https://site.api.espn.com/apis/site/v2/sports/soccer";

  // Le partite si cercano nella competizione VERA: le coppe su ESPN hanno un
  // codice loro (la Coppa di Germania non sta dentro ger.1). "rose" dice da
  // quale campionato prendere le rose per la tendina delle squadre.
  var COMPETIZIONI = [
    { band: "🇮🇹", nome: "Serie A",               code: "ita.1",                 rose: "ita.1" },
    { band: "🇮🇹", nome: "Serie B",               code: "ita.2",                 rose: "ita.2" },
    { band: "🇮🇹", nome: "Coppa Italia",          code: "ita.coppa_italia",      rose: "ita.1" },
    { band: "🇮🇹", nome: "Supercoppa Italiana",   code: "ita.super_cup",         rose: "ita.1" },
    { band: "🇪🇸", nome: "LaLiga",                code: "esp.1",                 rose: "esp.1" },
    { band: "🇪🇸", nome: "Copa del Rey",          code: "esp.copa_del_rey",      rose: "esp.1" },
    { band: "🇩🇪", nome: "Bundesliga",            code: "ger.1",                 rose: "ger.1" },
    { band: "🇩🇪", nome: "2. Bundesliga",         code: "ger.2",                 rose: "ger.2" },
    { band: "🇩🇪", nome: "Coppa di Germania",     code: "ger.dfb_pokal",         rose: "ger.1" },
    { band: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", nome: "Premier League",        code: "eng.1",                 rose: "eng.1" },
    { band: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", nome: "EFL Championship",      code: "eng.2",                 rose: "eng.2" },
    { band: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", nome: "FA Cup",                code: "eng.fa",                rose: "eng.1" },
    { band: "🏴󠁧󠁢󠁥󠁮󠁧󠁿", nome: "Carabao Cup",           code: "eng.league_cup",        rose: "eng.1" },
    { band: "🇫🇷", nome: "Ligue 1",               code: "fra.1",                 rose: "fra.1" },
    { band: "🇫🇷", nome: "Coupe de France",       code: "fra.coupe_de_france",   rose: "fra.1" },
    { band: "🇳🇱", nome: "Eredivisie",            code: "ned.1",                 rose: "ned.1" },
    { band: "🇵🇹", nome: "Primeira Liga",         code: "por.1",                 rose: "por.1" },
    { band: "🏴󠁧󠁢󠁳󠁣󠁴󠁿", nome: "Scottish Premiership",  code: "sco.1",                 rose: "sco.1" },
    { band: "🇸🇦", nome: "Saudi Pro League",      code: "ksa.1",                 rose: "ksa.1" },
    { band: "🇦🇷", nome: "LPF Argentina",         code: "arg.1",                 rose: "arg.1" },
    { band: "🇧🇷", nome: "Brasileirão",           code: "bra.1",                 rose: "bra.1" },
    { band: "🇦🇹", nome: "Bundesliga Austria",    code: "aut.1",                 rose: "aut.1" },
    { band: "🇺🇸", nome: "MLS",                   code: "usa.1",                 rose: "usa.1" },
    { band: "🇪🇺", nome: "Champions League",      code: "uefa.champions",        rose: "" },
    { band: "🇪🇺", nome: "Europa League",         code: "uefa.europa",           rose: "" },
    { band: "🇪🇺", nome: "Conference League",     code: "uefa.europa.conf",      rose: "" },
    { band: "🇪🇺", nome: "Supercoppa UEFA",       code: "uefa.super_cup",        rose: "" },
    { band: "🌎", nome: "CONMEBOL Libertadores", code: "conmebol.libertadores", rose: "conmebol.libertadores" },
    { band: "🌎", nome: "CONMEBOL Sudamericana", code: "conmebol.sudamericana", rose: "conmebol.sudamericana" }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function iso(d) {
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function ora(x) {
    try { var d = new Date(x); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
    catch (e) { return ""; }
  }

  // ── da come ESPN chiama il ruolo a come lo trattiamo noi ──
  function reparto(ab) {
    var a = String(ab || "").toUpperCase();
    if (a === "G" || a === "GK") return "P";
    if (/B$/.test(a) || /^C?D/.test(a) || a === "D") return "D";      // LB, RB, WB, CD-L, D
    if (a.indexOf("M") >= 0) return "C";                              // DM, CM, AM, LM, RM
    return "A";                                                       // F, CF, SS, LF, RF, W
  }
  function lettera(ab) { return { P: "G", D: "D", C: "M", A: "F" }[reparto(ab)]; }
  // quanto e' arretrato un centrocampista: serve a spartirli fra due linee
  function profondita(ab) {
    var a = String(ab || "").toUpperCase();
    if (a.indexOf("DM") >= 0) return 0;
    if (a.indexOf("AM") >= 0) return 2;
    return 1;
  }
  // da che parte sta: nelle nostre linee il primo posto e' quello di DESTRA,
  // e un terzino e' piu' largo di un centrale
  function lato(ab) {
    var a = String(ab || "").toUpperCase();
    if (/^R/.test(a)) return -1;
    if (/^L/.test(a)) return 1;
    if (/-R$/.test(a)) return -0.5;
    if (/-L$/.test(a)) return 0.5;
    return 0;
  }
  function linee(mod) { return [1].concat(String(mod).split("-").map(Number)); }
  function repartoDiLinea(li, tot) {
    if (li === 0) return "P";
    if (li === 1) return "D";
    if (li === tot - 1) return "A";
    return "C";
  }

  // da un giocatore ESPN alla nostra terna [numero, nome, cognome]
  function terna(x) {
    var a = x.athlete || {};
    var cognome = a.lastName || (a.displayName || "").split(" ").slice(-1)[0] || "";
    var intero = a.fullName || a.displayName || cognome;
    var nome = intero.length > cognome.length ? intero.slice(0, intero.length - cognome.length).trim() : "";
    // la foto segue la regola del Premium: un archivio solo per tutte le grafiche
    var slug = cognome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return [x.jersey || "", nome, cognome, slug ? "/loghi/foto-premium-" + slug + ".png" : ""];
  }

  // I CAMBI: stanno nei keyEvents del summary, col minuto. Il primo
  // partecipante e' chi ENTRA, il secondo chi ESCE (cosi' li scrive ESPN).
  // I numeri di maglia si pescano dal roster della stessa squadra.
  function cambiDi(sommario, blocco) {
    var idT = String((blocco.team || {}).id || "");
    var anagrafe = {};
    (blocco.roster || []).forEach(function (x) {
      var id = ((x.athlete || {}).id);
      if (id != null) anagrafe[String(id)] = terna(x);
    });
    var lista = [];
    (sommario.keyEvents || []).forEach(function (e) {
      var t = String((e.type || {}).type || (e.type || {}).text || "").toLowerCase();
      if (t.indexOf("sub") < 0) return;
      if (String((e.team || {}).id || "") !== idT) return;
      var p = e.participants || [];
      var dentro = anagrafe[String(((p[0] || {}).athlete || {}).id)];
      var esce = anagrafe[String(((p[1] || {}).athlete || {}).id)];
      if (!dentro || !esce) return;
      lista.push({ m: (e.clock || {}).displayValue || "", o: esce, i: dentro,
                   ordine: (e.clock || {}).value || 0 });
    });
    lista.sort(function (a, b) { return a.ordine - b.ordine; });
    return lista.map(function (c) { return { m: c.m, o: c.o, i: c.i }; });
  }

  // mette gli undici nelle caselle del modulo, reparto per reparto
  function schiera(mod, undici) {
    var lines = linee(mod);
    var sacca = { P: [], D: [], C: [], A: [] };
    undici.forEach(function (g) { sacca[reparto(g.ab)].push(g); });
    sacca.C.sort(function (a, b) { return profondita(a.ab) - profondita(b.ab); });
    var scala = ["P", "D", "C", "A"];
    function prendi(role, n) {
      var out = [];
      while (out.length < n) {
        if (sacca[role].length) { out.push(sacca[role].shift()); continue; }
        // reparto scarico: si pesca da quello davanti, poi da quello dietro
        var dopo = scala[scala.indexOf(role) + 1], prima = scala[scala.indexOf(role) - 1];
        if (dopo && sacca[dopo].length) { out.push(sacca[dopo].shift()); continue; }
        if (prima && sacca[prima].length) { out.push(sacca[prima].shift()); continue; }
        break;
      }
      return out;
    }
    var tit = [];
    lines.forEach(function (n, li) {
      var gruppo = prendi(repartoDiLinea(li, lines.length), n);
      gruppo.sort(function (a, b) { return lato(a.ab) - lato(b.ab); });
      for (var k = 0; k < n; k++) tit.push(gruppo[k] ? { p: gruppo[k].idx } : null);
    });
    return tit;
  }

  function stile() {
    if (document.getElementById("fe-stile")) return;
    var s = document.createElement("style");
    s.id = "fe-stile";
    s.textContent =
      // Verde-acqua: e' l'unica cosa in pagina che porta dentro dati da fuori,
      // e si deve distinguere a colpo d'occhio dai pannelli delle squadre.
      // Il colore e' quello gia' in uso per il tasto CSV, non uno nuovo.
      ".ufbar{background:linear-gradient(180deg,rgba(45,212,191,.13),rgba(45,212,191,.06));" +
      "  border:1px solid rgba(45,212,191,.42);box-shadow:inset 3px 0 0 rgba(45,212,191,.75);" +
      "  border-radius:10px;padding:12px 14px;margin:10px 0 16px;}" +
      ".ufbar .uftitolo{font-family:'Mazzard',system-ui,sans-serif;font-size:11px;font-weight:700;" +
      "  letter-spacing:.2em;text-transform:uppercase;color:#6EE7D4;margin-bottom:10px;}" +
      ".ufbar .ufriga{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;}" +
      ".ufbar .field{display:flex;flex-direction:column;gap:5px;min-width:0;}" +
      ".ufbar label{font-family:'Mazzard',system-ui,sans-serif;font-size:10px;font-weight:700;" +
      "  letter-spacing:.18em;text-transform:uppercase;color:rgba(110,231,212,.85);}" +
      ".ufbar select,#ufbar input{padding:10px 12px;border-radius:7px;background:rgba(245,241,230,.05);" +
      "  border:1px solid var(--line-2,rgba(245,241,230,.08));color:var(--ivory,#F5F1E6);" +
      "  font-family:'DM Sans',sans-serif;font-size:14px;}" +
      ".ufbar select:focus,#ufbar input:focus{outline:none;border-color:rgba(45,212,191,.6);}" +
      ".ufbar button{font-family:'Mazzard',system-ui,sans-serif;font-weight:700;font-size:12px;letter-spacing:.12em;" +
      "  text-transform:uppercase;padding:11px 18px;border-radius:7px;cursor:pointer;" +
      "  background:rgba(45,212,191,.16);color:#6EE7D4;border:1px solid rgba(45,212,191,.55);}" +
      ".ufbar button:hover{background:rgba(45,212,191,.28);color:#8FF0DF;}" +
      ".ufbar .ufnota{flex:1 0 100%;font-size:12.5px;color:var(--fg-3,#8A8B96);line-height:1.5;margin-top:2px;}" +
      ".ufbar .ufnota.ok{color:#7BDCAA;} #ufbar .ufnota.err{color:#FF9A9C;}" +
      ".ufbar .ufnota b{color:var(--ivory,#F5F1E6);}";
    document.head.appendChild(s);
  }

  // ── IL PANNELLO "PRENDI DA ESPN" ───────────────────────────────────────
  // Competizione, giorno, partita e un tasto. Uguale in tutte le grafiche:
  // cambia solo il titolo, la scritta sul tasto e che cosa si fa del
  // pacchetto che ESPN restituisce (opz.prendi).
  function pannello(box, opz) {
    if (!box) return null;
    opz = opz || {};
    var titolo = opz.titolo || "Dati della partita da ESPN";
    var tasto = opz.tasto || "Prendi i dati";
    var prendi = opz.prendi || function () {};

    stile();
    box.classList.add("ufbar");
    box.innerHTML =
      '<div class="uftitolo">' + esc(titolo) + '</div>' +
      '<div class="ufriga">' +
        '<div class="field" style="flex:0 0 auto"><label>Competizione</label>' +
          '<select class="ufComp" style="width:230px"></select></div>' +
        '<div class="field" style="flex:0 0 auto"><label>Giorno</label>' +
          '<input type="date" class="ufData" style="width:160px"></div>' +
        '<div class="field" style="flex:1 1 260px;min-width:220px"><label>Partita</label>' +
          '<select class="ufMatch"></select></div>' +
        '<button class="ufCarica" type="button">&#8681; ' + esc(tasto) + '</button>' +
        '<div class="ufnota"></div>' +
      '</div>';

    var elComp = box.querySelector(".ufComp"), elData = box.querySelector(".ufData"),
        elMatch = box.querySelector(".ufMatch"), elNota = box.querySelector(".ufnota");
    var partite = [], giro = 0;

    function nota(html, cls) { elNota.className = "ufnota" + (cls ? " " + cls : ""); elNota.innerHTML = html; }

    function cercaPartite() {
      var comp = COMPETIZIONI[+elComp.value];
      var giorno = (elData.value || "").replace(/-/g, "");
      if (!comp || !giorno) return;
      elMatch.innerHTML = '<option value="">&hellip;</option>';
      nota("Cerco le partite del giorno&hellip;");
      // se cambio competizione e giorno di fila, la risposta vecchia puo'
      // arrivare dopo quella nuova: vale solo l'ultima richiesta partita
      var mio = ++giro;
      fetch(API + "/" + comp.code + "/scoreboard?dates=" + giorno)
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) {
          if (mio !== giro) return;
          partite = (d.events || []).map(function (e) {
            var c = (e.competitions || [{}])[0];
            // ESPN scrive "TRASFERTA @ CASA", all'americana: letto da noi
            // sembra il contrario. Qui si scrive CASA - TRASFERTA.
            var chi = c.competitors || [];
            function squadra(dove) {
              var t = chi.filter(function (x) { return x.homeAway === dove; })[0];
              if (!t) return "";
              var tm = t.team || {};
              return tm.shortDisplayName || tm.displayName || tm.abbreviation || "";
            }
            var casa = squadra("home"), fuori = squadra("away");
            return { id: e.id, data: e.date,
                     nome: (casa && fuori) ? (casa + " - " + fuori) : (e.shortName || e.name),
                     stato: ((c.status || {}).type || {}).description || "" };
          });
          if (!partite.length) {
            elMatch.innerHTML = '<option value="">nessuna partita</option>';
            nota("Nessuna partita di <b>" + esc(comp.nome) + "</b> in quel giorno.");
            return;
          }
          elMatch.innerHTML = partite.map(function (p) {
            return '<option value="' + p.id + '">' + ora(p.data) + " \u00b7 " + esc(p.nome) +
                   " (" + esc(p.stato) + ")</option>";
          }).join("");
          nota(partite.length + " partite. Scegline una e premi <b>" + esc(tasto) + "</b>.");
        })
        .catch(function (err) {
          if (mio !== giro) return;
          elMatch.innerHTML = '<option value="">&mdash;</option>';
          nota("<b>Elenco non caricato:</b> " + esc(err.message), "err");
        });
    }

    function carica() {
      var comp = COMPETIZIONI[+elComp.value];
      var id = elMatch.value;
      if (!comp || !id) { nota("Scegli prima una partita.", "err"); return; }
      var part = partite.filter(function (p) { return p.id === id; })[0] || {};
      nota("Chiedo i dati a ESPN&hellip;");
      fetch(API + "/" + comp.code + "/summary?event=" + encodeURIComponent(id))
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (d) { prendi(d, part, comp, nota); })
        .catch(function (err) { nota("<b>Non sono riuscito a leggerli:</b> " + esc(err.message), "err"); });
    }

    elComp.innerHTML = COMPETIZIONI.map(function (c, i) {
      return '<option value="' + i + '">' + c.band + " " + esc(c.nome) + "</option>";
    }).join("");
    elData.value = iso(new Date());
    elComp.addEventListener("change", cercaPartite);
    elData.addEventListener("change", cercaPartite);
    box.querySelector(".ufCarica").addEventListener("click", carica);
    cercaPartite();
    return { nota: nota, competizione: function () { return COMPETIZIONI[+elComp.value]; } };
  }

  function monta(box, opz) {
    if (!box) return;
    opz = opz || {};
    var COMPS = opz.comps || [];
    var MODULI = opz.moduli || [];
    var NBENCH = opz.nbench || 20;
    var sides = opz.sides || [];
    var dopo = opz.dopo || function () {};

    box.id = box.id || "ufbar";
    var comando = null;   // lo restituisce pannello(): serve per la competizione scelta

    // in quale competizione dell'editor stanno le rose di questa partita: per
    // le coppe e' il campionato di provenienza, per le europee non c'e' e
    // allora si lascia quella gia' scelta
    function indiceRose(comp) {
      if (!comp || !comp.rose) return sides[0] ? sides[0].comp : 0;
      for (var i = 0; i < COMPS.length; i++) if (COMPS[i].code === comp.rose) return i;
      return sides[0] ? sides[0].comp : 0;
    }

    function applica(side, blocco, iRose) {
      var lista = blocco.roster || [];
      side.comp = iRose;
      side.teamId = String((blocco.team || {}).id || "");
      side.teamName = (blocco.team || {}).displayName || side.teamName;
      side.manualMode = false;

      side.roster = lista.map(function (x, i) {
        var a = x.athlete || {};
        var cognome = a.lastName || (a.displayName || "").split(" ").slice(-1)[0] || "";
        var intero = a.fullName || a.displayName || cognome;
        var nome = intero.length > cognome.length ? intero.slice(0, intero.length - cognome.length).trim() : "";
        return { idx: i, num: x.jersey || "", nome: nome, cognome: cognome,
                 ruolo: lettera((x.position || {}).abbreviation) };
      });

      var m = String(blocco.formation || "").trim();
      var conosciuto = MODULI.indexOf(m) !== -1;
      if (conosciuto) side.mod = m;

      var undici = [];
      lista.forEach(function (x, i) {
        if (x.starter) undici.push({ idx: i, ab: (x.position || {}).abbreviation || "" });
      });
      side.custom = {};
      side.posGraf = null;                 // lo schieramento in campo si rifa'
      side.tit = schiera(side.mod, undici);

      side.pan = [];
      lista.forEach(function (x, i) {
        if (!x.starter && side.pan.length < NBENCH) side.pan.push({ p: i });
      });
      while (side.pan.length < NBENCH) side.pan.push(null);

      return { modulo: side.mod, moduloTenuto: !conosciuto, formazioneEspn: m, titolari: undici.length };
    }

    comando = pannello(box, {
      titolo: "Formazioni ufficiali dalla partita con dati ESPN",
      tasto: "Prendi le formazioni",
      prendi: function (d, part, comp, nota) {
        var blocchi = (d.rosters || []).filter(function (t) {
          return (t.roster || []).some(function (x) { return x.starter; });
        });
        if (blocchi.length < 2) {
          var quando = part.data ? " Il fischio d'inizio \u00e8 alle <b>" + ora(part.data) + "</b>." : "";
          nota("<b>Non ancora pubblicate.</b> ESPN tiene il posto ma \u00e8 vuoto: le formazioni " +
               "compaiono qui quando escono le ufficiali." + quando + " Riprova pi\u00f9 avanti.", "err");
          return;
        }
        // in casa e in trasferta come li chiama ESPN, non come capita
        var casa = blocchi.filter(function (t) { return t.homeAway === "home"; })[0] || blocchi[0];
        var fuori = blocchi.filter(function (t) { return t.homeAway === "away"; })[0] || blocchi[1];
        var iRose = indiceRose(comp);
        var a = applica(sides[0], casa, iRose);
        var b = applica(sides[1], fuori, iRose);
        // chi li vuole (la grafica Cambi) se li prende da qui; le altre
        // pagine semplicemente non li guardano
        a.cambi = cambiDi(d, casa);
        b.cambi = cambiDi(d, fuori);

        var avvisi = [];
        [[sides[0], a], [sides[1], b]].forEach(function (x) {
          if (x[1].moduloTenuto) avvisi.push("il modulo del " + esc(x[0].teamName) + " da ESPN \u00e8 <b>" +
            esc(x[1].formazioneEspn || "?") + "</b>, che non \u00e8 fra quelli che disegniamo: ho tenuto <b>" +
            esc(x[0].mod) + "</b>");
        });
        nota("<b>Formazioni caricate.</b> " +
             esc(sides[0].teamName) + " " + a.modulo + " \u00b7 " + esc(sides[1].teamName) + " " + b.modulo +
             ". Undici e panchina sono a posto; <b>allenatore, colori e foto restano i tuoi</b>. " +
             "Controlla lo schieramento prima di mandare in onda." +
             (avvisi.length ? "<br>Attenzione: " + avvisi.join("; ") + "." : ""), "ok");
        dopo({ partita: part, comp: comp, casa: a, fuori: b });
      }
    });
  }

  // stile(): lo stile del pannello verde-acqua, esposto. Prima veniva iniettato
  // solo costruendo il pannello di questo file, quindi una pagina che ne
  // costruisce uno proprio con le stesse classi non prendeva niente e i campi
  // le finivano impilati a piena larghezza. Meglio esporre l'iniezione che
  // copiare il CSS altrove: la faccia dei pannelli resta descritta in un posto.
  window.FormazioniEspn = { monta: monta, competizioni: COMPETIZIONI,
                            schiera: schiera, cambiDi: cambiDi, terna: terna,
                            stile: stile };
  // lo stesso pannello verde-acqua, per le grafiche che dei dati partita
  // fanno un altro uso: statistiche, tabellino, scheda squadra, focus
  window.PartitaEspn = { pannello: pannello, competizioni: COMPETIZIONI, terna: terna,
                         stile: stile };
})();
