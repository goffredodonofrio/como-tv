/**
 * ═══════════════════════════════════════════════════════════════════
 *  DA COME LA CHIAMA AIRTABLE, A COME SI CHIAMA IL FILE NEL MASTER
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Le due liste non coincidono, e non per sciatteria: le maschere le ha
 *  nominate chi fa grafica, gli eventi li nomina chi fa palinsesto, e
 *  nessuno dei due sapeva che un giorno si sarebbero dovuti incontrare.
 *  "Coppa di Germania" e "dfb-pokal.png" sono la stessa cosa.
 *
 *  Questa tabella e' quell'incontro. Va tenuta a mano — e va bene cosi':
 *  sono venti righe che cambiano due volte l'anno, e indovinarle da un
 *  algoritmo produrrebbe errori silenziosi proprio dove non li vogliamo.
 *
 *  Ricavata leggendo 20260831_COMO TV_MASTER.prproj il 2026-09-04:
 *  29 maschere, tutte in ASSETS/PNG TRASP X MASCHERE SOCIAL/MSK 9-16.
 */
window.Maschere = (function () {
  "use strict";

  var TAVOLA = {
    // ── stesso nome da tutte e due le parti ──────────────────────────
    "carabao cup": "carabao cup.png",
    "copa libertadores": "copa libertadores.png",
    "copa sudamericana": "copa sudamericana.png",
    "eredivisie": "eredivisie.png",
    "saudi pro league": "saudi pro league.png",
    "scottish championship": "scottish championship.png",
    "scottish league cup": "scottish league cup.png",
    "scottish premiership": "scottish premiership.png",
    "scottish cup": "scottish cup.png",
    "saudi super cup": "saudi super cup.png",
    "coupe de france": "coupe de france.png",
    "coupe de france feminine": "coupe de france feminine.png",
    "recopa": "recopa.png",
    "recopa sudamericana": "recopa.png",
    "hnl": "hnl.png",
    "supersport hnl": "hnl.png",
    "friendly match": "friendly match.png",
    "amichevole": "friendly match.png",

    // ── stessa cosa, nome diverso ────────────────────────────────────
    "bundesliga austria": "bundesliga austriaca.png",
    "coppa di germania": "dfb-pokal.png",
    "dfb pokal": "dfb-pokal.png",
    "championship": "efl championship.png",          // quella INGLESE
    "efl championship": "efl championship.png",
    "apertura liga profesional": "liga profesional argentina.png",
    "clausura liga profesional": "liga profesional argentina.png",
    "lpf argentina": "liga profesional argentina.png",
    "taca de portugal": "taça de portugal.png",
    "supertaca portugal": "supertaca.png",
    "como 1907 prima squ": "como cup.png",

    // ── i programmi: la competizione e' "Studio Live" ────────────────
    "studio live": "football show.png"
  };

  // Quelle che negli eventi ci sono e nel master non c'e' la maschera.
  // Non e' una svista da correggere in codice: sono file che vanno fatti,
  // e finche' non ci sono il pannello deve dirlo invece di tacere.
  var ASSENTI = {
    "serie a": "Serie A",
    "uefa champions league": "UEFA Champions League",
    "uefa youth league": "UEFA Youth League",
    "under 17": "Under 17",
    "under 18": "Under 18",
    "evento rec": "EVENTO REC",
    "coppa italia": "Coppa Italia",
    "primavera 1": "Primavera 1"
  };

  // Accenti, maiuscole, doppi spazi e trattini: due liste scritte da
  // persone diverse non combaciano mai al carattere.
  function chiave(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // { file } se c'e', { manca } se sappiamo che non c'e',
  // { ignota } se e' una competizione che non abbiamo mai visto.
  function per(competizione) {
    var k = chiave(competizione);
    if (TAVOLA[k]) return { file: TAVOLA[k] };
    if (ASSENTI[k]) return { manca: ASSENTI[k] };
    return { ignota: competizione };
  }

  function tutte() { return TAVOLA; }

  return { per: per, tutte: tutte, chiave: chiave };
})();
