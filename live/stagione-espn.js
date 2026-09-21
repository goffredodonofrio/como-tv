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
 * Uso:
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

  return { squadra: squadra, giocatore: giocatore, stagione: stagione };
})();
