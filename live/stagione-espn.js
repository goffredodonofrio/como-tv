/**
 * STAGIONE ESPN — presenze, gol e assist di un giocatore, per competizione.
 *
 * ESPN ha anche un riepilogo stagionale gia' fatto, ma e' in ritardo:
 * il 21/09/2026 dava a Kean 2 presenze in Serie A quando erano 3 (la
 * partita del giorno prima non c'era ancora). Quindi qui si contano dalle
 * partite vere: il calendario della squadra (tutte le competizioni, senza
 * le amichevoli) e, di ogni partita finita, la rosa con chi e' partito
 * titolare, chi e' entrato, i gol, gli assist e i cartellini.
 *
 * Una partita finita non cambia piu': il suo riassunto resta nel browser e
 * non si chiede una seconda volta. La prima apertura legge tutta la
 * stagione; dalle volte dopo arrivano solo le partite nuove.
 *
 * La CARRIERA invece si prende dal registro ESPN del giocatore, stagione
 * per stagione e competizione per competizione: per le stagioni finite quei
 * numeri sono definitivi, e contarli partita per partita vorrebbe dire
 * centinaia di partite. La stagione in corso resta quella contata qui.
 *
 * Uso:
 *   StagioneEspn.carriera(pid)           // -> Promise([{ anno, slug, nome, tid, squadra,
 *                                        //      presenze, titolare, gol, assist, gialli, rossi }])
 *   StagioneEspn.squadra(tid)            // la prepara in anticipo
 *   StagioneEspn.giocatore(tid, pid)     // -> Promise([{ slug, nome, presenze,
 *                                        //      titolare, gol, assist, gialli, rossi }])
 */
window.StagioneEspn = (function () {
  "use strict";

  var API = "https://site.api.espn.com/apis/site/v2/sports/soccer";
  var SQUADRE = {};                         // tid -> Promise dei conti di tutta la rosa
  var LS = "comotv.stagione.ev.";

  // la stagione cambia d'estate: a luglio si comincia a contare la nuova
  function stagione() {
    var d = new Date();
    return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  }
  function amichevole(lega) {
    return /friendly/i.test((lega || {}).slug || "") || /friendly|amichev/i.test((lega || {}).name || "");
  }
  function nomeLega(lega) {
    var info = window.CompetizioniEspn && lega.slug ? CompetizioniEspn.info(lega.slug) : null;
    return (info && info.nome) || lega.shortName || lega.name || lega.slug || "";
  }

  // il riassunto di una partita: per ogni giocatore delle due rose
  function riassunto(ev) {
    var chiave = LS + ev.id;
    try {
      var s = localStorage.getItem(chiave);
      if (s) return Promise.resolve(JSON.parse(s));
    } catch (e) {}
    return fetch(API + "/all/summary?event=" + encodeURIComponent(ev.id))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var g = {};
        (j.rosters || []).forEach(function (r) {
          var tid = String((r.team || {}).id || "");
          (r.roster || []).forEach(function (x) {
            var pid = String((x.athlete || {}).id || "");
            if (!pid) return;
            var st = {};
            (x.stats || []).forEach(function (s) { st[s.name] = parseFloat(s.value != null ? s.value : s.displayValue) || 0; });
            // a lista: titolare, entrato, gol, assist, gialli, rossi
            g[pid] = [tid, x.starter ? 1 : 0, x.subbedIn ? 1 : 0,
                      st.totalGoals || 0, st.goalAssists || 0, st.yellowCards || 0, st.redCards || 0];
          });
        });
        var fatto = { lega: ev.lega, g: g };
        // si tiene solo se la partita e' davvero finita e le rose c'erano
        if (ev.finita && Object.keys(g).length) {
          try { localStorage.setItem(chiave, JSON.stringify(fatto)); } catch (e) {}
        }
        return fatto;
      })
      .catch(function () { return null; });
  }

  function squadra(tid) {
    tid = String(tid || "");
    if (!tid) return Promise.resolve({});
    if (SQUADRE[tid]) return SQUADRE[tid];
    SQUADRE[tid] = fetch(API + "/all/teams/" + encodeURIComponent(tid) + "/schedule?season=" + stagione())
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var giocate = (j.events || []).filter(function (e) {
          var st = ((((e.competitions || [])[0] || {}).status || {}).type || {});
          return st.state === "post" && !amichevole(e.league);
        }).map(function (e) {
          var l = e.league || {};
          return { id: String(e.id), finita: true, lega: { slug: l.slug || "", nome: nomeLega(l) } };
        });
        // a gruppi di sei, per non sommergere ESPN
        var tutte = [];
        function giro(i) {
          if (i >= giocate.length) return Promise.resolve(tutte);
          return Promise.all(giocate.slice(i, i + 6).map(riassunto))
            .then(function (v) { tutte = tutte.concat(v.filter(Boolean)); return giro(i + 6); });
        }
        return giro(0);
      })
      .then(function (partite) {
        var conti = {};                     // pid -> slug -> numeri
        partite.forEach(function (p) {
          Object.keys(p.g).forEach(function (pid) {
            var x = p.g[pid];
            if (x[0] !== tid) return;       // solo chi giocava per questa squadra
            if (!x[1] && !x[2]) return;     // in panchina senza entrare: non e' una presenza
            var c = (conti[pid] = conti[pid] || {});
            var k = p.lega.slug || p.lega.nome;
            var r = (c[k] = c[k] || { slug: p.lega.slug, nome: p.lega.nome, presenze: 0, titolare: 0,
                                      gol: 0, assist: 0, gialli: 0, rossi: 0 });
            r.presenze++; r.titolare += x[1]; r.gol += x[3]; r.assist += x[4]; r.gialli += x[5]; r.rossi += x[6];
          });
        });
        return conti;
      })
      .catch(function () { delete SQUADRE[tid]; return {}; });
    return SQUADRE[tid];
  }

  // il campionato per primo, poi le coppe nazionali, poi quelle europee
  function peso(slug) {
    if (/\.\d$/.test(slug || "")) return 0;
    if (/^(uefa|conmebol|fifa|concacaf|afc|caf)\./.test(slug || "")) return 2;
    return 1;
  }
  function giocatore(tid, pid) {
    return squadra(tid).then(function (conti) {
      var c = conti[String(pid || "")] || {};
      return Object.keys(c).map(function (k) { return c[k]; })
        .sort(function (a, b) { return peso(a.slug) - peso(b.slug) || b.presenze - a.presenze; });
    });
  }

  // ── la carriera ────────────────────────────────────────────────────
  var CORE = "https://sports.core.api.espn.com/v2/sports/soccer";
  var LSC = "comotv.carriera2.";
  var NOMI_SQ = {};                           // tid -> nome, una richiesta per squadra
  // le competizioni che l'elenco delle nostre tendine non ha
  var ALTRE = { "fifa.world": "Mondiali", "fifa.worldq.uefa": "Qualificazioni Mondiali",
                "uefa.euro": "Europei", "uefa.euroq": "Qualificazioni Europei", "uefa.nations": "Nations League",
                "fifa.friendly": "Amichevoli nazionali", "uefa.europa.conf": "Conference League",
                "uefa.europa": "Europa League", "uefa.champions": "Champions League", "uefa.super_cup": "Supercoppa UEFA",
                "fifa.cwc": "Mondiale per club", "fifa.world.u20": "Mondiali U20", "uefa.euro_u21": "Europei U21" };
  function nomeSlug(slug) {
    slug = String(slug || "");
    // le qualificazioni: "uefa.europa.conf_qual" -> Qualificazioni Conference League
    var q = slug.match(/^(.*?)[._]qual(ifying)?$/);
    if (q) return "Qualificazioni " + nomeSlug(q[1]);
    var info = window.CompetizioniEspn ? CompetizioniEspn.info(slug) : null;
    return (info && info.nome) || ALTRE[slug] || slug.toUpperCase();
  }
  // le nazionali ESPN le scrive in inglese: "Italy U21" -> "Italia U21"
  var PAESI = { "Italy": "Italia", "France": "Francia", "Spain": "Spagna", "Germany": "Germania",
    "England": "Inghilterra", "Portugal": "Portogallo", "Netherlands": "Paesi Bassi", "Belgium": "Belgio",
    "Brazil": "Brasile", "Argentina": "Argentina", "Croatia": "Croazia", "Switzerland": "Svizzera",
    "Austria": "Austria", "Denmark": "Danimarca", "Sweden": "Svezia", "Norway": "Norvegia",
    "Poland": "Polonia", "Serbia": "Serbia", "Scotland": "Scozia", "Wales": "Galles", "Ireland": "Irlanda",
    "Republic of Ireland": "Irlanda", "Northern Ireland": "Irlanda del Nord", "Turkey": "Turchia", "Türkiye": "Turchia",
    "Greece": "Grecia", "Ukraine": "Ucraina", "Czechia": "Cechia", "Czech Republic": "Cechia", "Slovakia": "Slovacchia",
    "Slovenia": "Slovenia", "Hungary": "Ungheria", "Romania": "Romania", "Albania": "Albania", "Georgia": "Georgia",
    "Uruguay": "Uruguay", "Colombia": "Colombia", "Chile": "Cile", "Mexico": "Messico", "United States": "Stati Uniti",
    "Morocco": "Marocco", "Senegal": "Senegal", "Nigeria": "Nigeria", "Ghana": "Ghana", "Ivory Coast": "Costa d'Avorio",
    "Cote d'Ivoire": "Costa d'Avorio", "Cameroon": "Camerun", "Algeria": "Algeria", "Tunisia": "Tunisia",
    "Egypt": "Egitto", "Japan": "Giappone", "South Korea": "Corea del Sud", "Australia": "Australia",
    "Canada": "Canada", "Finland": "Finlandia", "Iceland": "Islanda", "Bosnia-Herzegovina": "Bosnia",
    "Montenegro": "Montenegro", "North Macedonia": "Macedonia del Nord", "Kosovo": "Kosovo", "Paraguay": "Paraguay",
    "Venezuela": "Venezuela", "Ecuador": "Ecuador", "Peru": "Perù" };
  function italiano(nome) {
    var m = String(nome || "").match(/^(.+?)(\s+(U\d{2}|Olympic|B))?$/);
    if (!m || !PAESI[m[1]]) return nome;
    return PAESI[m[1]] + (m[2] || "");
  }
  function https(u) { return String(u || "").replace(/^http:/, "https:"); }
  function json(u) { return fetch(https(u)).then(function (r) { return r.json(); }); }
  function nomeSquadra(ref, tid) {
    if (NOMI_SQ[tid]) return NOMI_SQ[tid];
    try {
      var s = localStorage.getItem("comotv.squadra2." + tid);
      if (s) return (NOMI_SQ[tid] = Promise.resolve(s));
    } catch (e) {}
    NOMI_SQ[tid] = json(ref).then(function (t) {
      var lungo = t.displayName || t.name || "";
      var n = /\bU\d{2}\b/.test(lungo) ? lungo : (t.shortDisplayName || lungo);
      n = italiano(n);
      try { if (n) localStorage.setItem("comotv.squadra2." + tid, n); } catch (e) {}
      return n;
    }).catch(function () { return ""; });
    return NOMI_SQ[tid];
  }
  function carriera(pid) {
    pid = String(pid || "");
    if (!pid) return Promise.resolve([]);
    var corrente = stagione();
    // le stagioni finite non cambiano: si tengono nel browser
    var salvato = null;
    try { salvato = JSON.parse(localStorage.getItem(LSC + pid) || "null"); } catch (e) {}
    if (salvato && salvato.fino === corrente) return Promise.resolve(salvato.righe);
    return json(CORE + "/athletes/" + pid + "/statisticslog")
      .then(function (j) {
        var voci = [];
        (j.entries || []).forEach(function (e) {
          var ma = ((e.season || {}).$ref || "").match(/seasons\/(\d{4})/);
          var anno = ma ? parseInt(ma[1], 10) : 0;
          if (!anno || anno >= corrente) return;       // la stagione in corso si conta dalle partite
          (e.statistics || []).forEach(function (st) {
            if (st.type && st.type !== "total") return;
            var slug = ((st.league || {}).$ref || "").match(/leagues\/([^/?]+)/);
            var tid = ((st.team || {}).$ref || "").match(/teams\/(\d+)/);
            voci.push({ anno: anno, slug: slug ? slug[1] : "", tid: tid ? tid[1] : "",
                        teamRef: (st.team || {}).$ref, statRef: (st.statistics || {}).$ref });
          });
        });
        var righe = [];
        function giro(i) {
          if (i >= voci.length) return Promise.resolve();
          return Promise.all(voci.slice(i, i + 8).map(function (v) {
            return Promise.all([
              v.statRef ? json(v.statRef).catch(function () { return {}; }) : Promise.resolve({}),
              v.tid ? nomeSquadra(v.teamRef, v.tid) : Promise.resolve("")
            ]).then(function (r) {
              var n = {};
              (((r[0] || {}).splits || {}).categories || []).forEach(function (c) {
                (c.stats || []).forEach(function (x) { n[x.name] = parseFloat(x.value != null ? x.value : x.displayValue) || 0; });
              });
              if (!n.appearances) return;              // in rosa ma mai in campo: non e' una presenza
              righe.push({ anno: v.anno, slug: v.slug, nome: nomeSlug(v.slug), tid: v.tid, squadra: r[1],
                           presenze: n.appearances || 0, titolare: n.starts || 0, gol: n.totalGoals || 0,
                           assist: n.goalAssists || 0, gialli: n.yellowCards || 0, rossi: n.redCards || 0 });
            });
          })).then(function () { return giro(i + 8); });
        }
        return giro(0).then(function () {
          righe.sort(function (a, b) { return b.anno - a.anno || peso(a.slug) - peso(b.slug); });
          try { localStorage.setItem(LSC + pid, JSON.stringify({ fino: corrente, righe: righe })); } catch (e) {}
          return righe;
        });
      })
      .catch(function () { return []; });
  }

  return { squadra: squadra, giocatore: giocatore, stagione: stagione, carriera: carriera };
})();
