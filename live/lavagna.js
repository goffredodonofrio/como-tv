/**
 * ═══════════════════════════════════════════════════════════════════
 *  LAVAGNA — il campetto del giornalista, con le rose vere
 * ═══════════════════════════════════════════════════════════════════
 *
 *  E' l'attrezzo della telecronaca, non una grafica: i giocatori sono
 *  pedine da trascinare, sopra si disegna, e ogni pedina porta le note di
 *  chi racconta la partita. Non parla col ponte e non va in onda.
 *
 *  Vive in due case:
 *   · dentro le Formazioni (il tasto "Lavagna"), gia' piena delle squadre
 *     che si stanno preparando — undici, panchina e modulo;
 *   · da sola, in lavagna.html, dove le squadre si scelgono da ESPN.
 *
 *  Tre cose che TacticalPad non fa e a noi servono:
 *   · le rose sono quelle vere (ESPN, e il database giovanili del Como);
 *   · i CAMBI: entra chi esce dalla panchina, al posto di chi esce, e resta
 *     scritto sotto il campo;
 *   · le CURIOSITA': doppio clic su un giocatore e ci si scrive quello che
 *     si vuole dire in telecronaca. Chi ha una nota ha un puntino d'oro, e
 *     le note finiscono nel foglio stampato.
 *
 *  Uso:
 *    var L = Lavagna.monta(box, { salva: true });
 *    L.carica({ A:{nome,col,rosa,titolari,panchina,mod}, B:{...} });
 */
window.Lavagna = (function () {
  "use strict";

  var W = 1600, H = 900;
  var MODULI = {
    "4-3-3":   [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.52,.26],[.50,.5],[.52,.74],[.80,.16],[.86,.5],[.80,.84]],
    "4-2-3-1": [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.46,.36],[.46,.64],[.70,.18],[.70,.5],[.70,.82],[.90,.5]],
    "4-4-2":   [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.54,.14],[.50,.40],[.50,.60],[.54,.86],[.84,.38],[.84,.62]],
    "3-5-2":   [[.06,.5],[.24,.28],[.22,.5],[.24,.72],[.50,.10],[.48,.34],[.46,.5],[.48,.66],[.50,.90],[.84,.38],[.84,.62]],
    "3-4-2-1": [[.06,.5],[.24,.28],[.22,.5],[.24,.72],[.50,.12],[.48,.40],[.48,.60],[.50,.88],[.74,.34],[.74,.66],[.90,.5]],
    "5-3-2":   [[.06,.5],[.26,.10],[.22,.32],[.20,.5],[.22,.68],[.26,.90],[.52,.30],[.50,.5],[.52,.70],[.84,.38],[.84,.62]],
    "4-3-1-2": [[.06,.5],[.28,.14],[.24,.38],[.24,.62],[.28,.86],[.50,.24],[.48,.5],[.50,.76],[.70,.5],[.88,.38],[.88,.62]]
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ns(nome, attr, dentro) {
    var e = document.createElementNS("http://www.w3.org/2000/svg", nome);
    for (var k in attr) if (attr[k] !== undefined && attr[k] !== null) e.setAttribute(k, attr[k]);
    if (dentro) dentro.appendChild(e);
    return e;
  }
  function stile() {
    if (document.getElementById("lav-stile")) return;
    var s = document.createElement("style");
    s.id = "lav-stile";
    s.textContent =
      ".lav{--lav-oro:#C9A24B;--lav-oroB:#E3C271;--lav-avorio:#F5F1E6;--lav-fg3:#8A8B96;color:var(--lav-avorio);font-family:'DM Sans',system-ui,sans-serif;}" +
      ".lav .barra{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:10px;}" +
      ".lav button{font-family:'Mazzard',sans-serif;font-weight:700;font-size:10.5px;letter-spacing:.1em;" +
      "  text-transform:uppercase;padding:8px 11px;border-radius:7px;cursor:pointer;" +
      "  background:rgba(245,241,230,.06);color:#D8D2C2;border:1px solid rgba(245,241,230,.08);}" +
      ".lav button:hover{color:var(--lav-oroB);border-color:rgba(201,162,75,.28);}" +
      ".lav button.on{background:rgba(201,162,75,.16);border-color:var(--lav-oro);color:var(--lav-oroB);}" +
      ".lav button.via{color:#FF6B6E;border-color:rgba(229,27,32,.4);}" +
      ".lav .sep{width:1px;height:24px;background:rgba(245,241,230,.08);margin:0 2px;}" +
      ".lav .colore{width:24px;height:24px;border-radius:50%;padding:0;border:2px solid rgba(245,241,230,.25);}" +
      ".lav .colore.on{border-color:#fff;box-shadow:0 0 0 2px rgba(201,162,75,.5);}" +
      ".lav .fianco{display:flex;gap:12px;align-items:stretch;}" +
      ".lav .fianco .campoBox{flex:1 1 640px;min-width:0;}" +
      ".lav .lato{flex:0 0 300px;display:flex;flex-direction:column;gap:10px;min-width:0;}" +
      ".lav .lato .col{flex:1 1 0;overflow:auto;}" +
      "@media (max-width:1100px){.lav .fianco{flex-wrap:wrap}.lav .lato{flex:1 1 100%;flex-direction:row}}" +
      ".lav .segui{align-items:center;}" +
      ".lav .segui select{padding:7px 9px;border-radius:7px;background:rgba(245,241,230,.06);" +
      "  border:1px solid rgba(245,241,230,.16);color:var(--lav-avorio);font-family:'DM Sans',sans-serif;" +
      "  font-size:12.5px;max-width:260px;}" +
      ".lav .segui select option{background:#141B3C;color:var(--lav-avorio);}" +
      ".lav .segui b{font-family:'Mazzard',sans-serif;font-size:10.5px;letter-spacing:.16em;" +
      "  text-transform:uppercase;color:#FF8A8C;}" +
      ".lav .segui .nota{flex:1 1 220px;font-size:11.5px;}" +
      ".lav .diretta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:8px;padding:8px 12px;" +
      "  border-radius:9px;background:rgba(229,27,32,.10);border:1px solid rgba(229,27,32,.45);font-size:13px;}" +
      ".lav .diretta b{font-family:'Mazzard',sans-serif;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#FF8A8C;}" +
      ".lav .diretta .punteggio{font-family:'Mazzard',sans-serif;font-weight:800;font-size:17px;color:var(--lav-avorio);}" +
      ".lav .diretta .azione{color:#D8D2C2;flex:1 1 220px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}" +
      ".lav .campoBox{position:relative;width:100%;aspect-ratio:16/9;border-radius:12px;overflow:hidden;" +
      "  border:1px solid rgba(201,162,75,.28);background:#0B5A2E;touch-action:none;}" +
      ".lav .campoBox svg{position:absolute;inset:0;width:100%;height:100%;display:block;}" +
      ".lav .sotto{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px;}" +
      ".lav .col{flex:1 1 330px;min-width:0;background:rgba(16,22,48,.66);border:1px solid rgba(245,241,230,.08);" +
      "  border-radius:10px;padding:11px;}" +
      ".lav .col h4{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;letter-spacing:.2em;" +
      "  text-transform:uppercase;color:var(--lav-oro);margin-bottom:7px;display:flex;align-items:center;gap:7px;}" +
      ".lav .col h4 i{width:11px;height:11px;border-radius:50%;display:inline-block;font-style:normal;}" +
      /* il pallino della squadra si clicca: e' il colore delle pedine */
      ".lav .col h4 .colsq{position:relative;display:inline-flex;cursor:pointer;padding:3px;margin:-3px;border-radius:50%;}" +
      ".lav .col h4 .colsq:hover i{box-shadow:0 0 0 2px var(--lav-oro);}" +
      ".lav .col h4 .colsq input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:0;padding:0;}" +
      ".lav .col h4 .magsq{margin-left:auto;font-family:'DM Sans',sans-serif;font-size:11.5px;font-weight:600;letter-spacing:0;" +
      "text-transform:none;padding:3px 6px;border-radius:6px;background:rgba(6,10,26,.6);color:var(--lav-avorio);" +
      "border:1px solid rgba(245,241,230,.16);max-width:130px;}" +
      ".lav.chiara .col h4 .magsq{background:#FFFFFF;border-color:#CFC7B4;color:#0A0F24;}" +
      ".lav .gioc{display:flex;flex-wrap:wrap;gap:5px;}" +
      ".lav .gioc button{font-family:'DM Sans',sans-serif;font-weight:600;font-size:13px;letter-spacing:.01em;" +
      "  text-transform:none;padding:6px 9px;}" +
      ".lav .gioc button.dentro{opacity:.42;}" +
      ".lav .gioc button.scelto{border-color:var(--lav-oro);color:var(--lav-oroB);background:rgba(201,162,75,.14);}" +
      ".lav .gioc button b{font-family:'Mazzard',sans-serif;color:var(--lav-oroB);margin-right:5px;}" +
      ".lav .gioc button em{font-style:normal;color:var(--lav-oro);margin-left:5px;}" +
      ".lav .nota{font-size:12.5px;color:var(--lav-fg3);margin-top:8px;line-height:1.5;}" +
      ".lav .nota.ok{color:#7BDCAA;}.lav .nota.err{color:#FF8A8C;}" +
      ".lav .cambi{font-size:12.5px;color:#D8D2C2;line-height:1.7;}" +
      ".lav .cambi span{color:var(--lav-fg3);}" +
      ".lav .curio{font-size:12.5px;color:#D8D2C2;line-height:1.6;}" +
      ".lav .curio div{padding:4px 0;border-bottom:1px solid rgba(245,241,230,.05);}" +
      ".lav .curio b{font-family:'Mazzard',sans-serif;color:var(--lav-oroB);}" +
      /* il foglietto delle curiosita': sta attaccato al giocatore, sul campo */
      ".lav .campoBox .foglietto{position:absolute;z-index:8;width:420px;max-width:94%;" +
      "  background:linear-gradient(180deg,#141B3C,#0E1430);box-shadow:0 12px 30px rgba(0,0,0,.55);" +
      "  border:1px solid rgba(201,162,75,.5);border-radius:10px;padding:12px;}" +
      ".lav .foglietto .testa{display:flex;gap:12px;align-items:flex-end;margin-bottom:2px;}" +
      ".lav .foglietto .testadx{flex:1;min-width:0;}" +
      ".lav .foglietto .faccia{flex:0 0 96px;height:108px;border-radius:9px;overflow:hidden;margin-bottom:8px;" +
      "background:radial-gradient(120% 90% at 50% 100%,color-mix(in srgb,var(--sq) 55%,transparent),transparent 70%),rgba(6,10,26,.55);" +
      "border:1px solid rgba(201,162,75,.35);}" +
      ".lav .foglietto .faccia img{width:100%;height:100%;object-fit:cover;object-position:50% 8%;display:block;}" +
      ".lav.chiara .foglietto .faccia{background:radial-gradient(120% 90% at 50% 100%,color-mix(in srgb,var(--sq) 45%,transparent),transparent 70%),#EFEAE0;border-color:#DCD5C4;}" +
      ".lav .foglietto .bio{font-family:'DM Sans',sans-serif;font-size:13.5px;line-height:1.5;white-space:nowrap;color:var(--lav-fg3);" +
      "margin-bottom:8px;min-height:19px;}" +
      ".lav .foglietto .bio b{color:var(--lav-avorio);font-weight:700;}" +
      ".lav .foglietto .bio i{font-style:normal;margin:0 7px;color:var(--lav-oro);}" +
      ".lav .foglietto h3{font-family:'Mazzard',sans-serif;font-size:11px;font-weight:700;letter-spacing:.16em;" +
      "  text-transform:uppercase;color:var(--lav-oro);margin-bottom:8px;}" +
      /* i contatori della partita: calci d'angolo, gialli, rossi. Il clic
         sul contatore aggiunge uno (in telecronaca si va di fretta), il
         meno piccolo corregge. */
      ".lav .conta{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:0 0 10px;}" +
      ".lav .conta .ct{display:flex;flex-direction:column;align-items:center;gap:3px;position:relative;" +
      "padding:7px 4px 6px;border-radius:9px;background:rgba(6,10,26,.55);border:1px solid rgba(245,241,230,.1);" +
      "cursor:pointer;user-select:none;transition:border-color .15s ease,background .15s ease;}" +
      ".lav .conta .ct:hover{border-color:rgba(201,162,75,.5);background:rgba(201,162,75,.08);}" +
      ".lav .conta .ct b{font-family:'Mazzard',sans-serif;font-weight:800;font-size:24px;line-height:1;color:var(--lav-avorio);" +
      "font-variant-numeric:tabular-nums;}" +
      ".lav .conta .ct em{font-style:normal;font-family:'Mazzard',sans-serif;font-size:9.5px;font-weight:700;" +
      "letter-spacing:.12em;text-transform:uppercase;color:var(--lav-fg3);}" +
      ".lav .conta .ct .ic{height:15px;display:flex;align-items:center;}" +
      ".lav .conta .ct .ic.gia i,.lav .conta .ct .ic.ros i{display:block;width:10px;height:14px;border-radius:2px;}" +
      ".lav .conta .ct .ic.gia i{background:#F2C230;} .lav .conta .ct .ic.ros i{background:#E5342B;}" +
      ".lav .conta .ct .meno{position:absolute;top:3px;right:3px;width:18px;height:18px;padding:0;border-radius:5px;" +
      "font-size:13px;line-height:16px;letter-spacing:0;color:var(--lav-fg3);background:transparent;" +
      "border:1px solid rgba(245,241,230,.14);cursor:pointer;}" +
      ".lav .conta .ct .meno:hover{color:#FF8A8C;border-color:rgba(229,52,43,.5);}" +
      ".lav .conta .ct.su b{color:#E3C271;}" +
      ".lav .conta .ct.chiedo{border-color:#E3C271;background:rgba(201,162,75,.18);animation:lavChiedo 1s ease-in-out infinite;}" +
      "@keyframes lavChiedo{50%{box-shadow:0 0 0 3px rgba(227,194,113,.35);}}" +
      /* mentre si chiede "chi?", le pedine della squadra si accendono */
      ".lav.chiedo-A .gioc button[data-lato=\"A\"],.lav.chiedo-B .gioc button[data-lato=\"B\"]{outline:2px solid rgba(227,194,113,.6);}" +
      ".lav g.cand .disco{stroke:#E3C271;stroke-width:5;}" +
      ".lav .gioc .crt{display:inline-block;width:8px;height:11px;border-radius:1.5px;margin-left:6px;vertical-align:-1px;}" +
      ".lav .gioc .crt.g{background:#F2C230;} .lav .gioc .crt.r{background:#E5342B;}" +
      ".lav .gioc .crt.dd{box-shadow:-3px -2px 0 #F2C230;}" +
      /* i cartellini nella scheda del giocatore */
      ".lav .foglietto .cartriga{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px;}" +
      ".lav .foglietto .cartriga .cl{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;letter-spacing:.14em;" +
      "text-transform:uppercase;color:#C9A24B;margin-right:2px;}" +
      ".lav .foglietto .cartriga .stc{font-size:13px;color:var(--lav-avorio);margin-right:auto;}" +
      ".lav .foglietto .cartriga .stc.vuoto{color:var(--lav-fg3);}" +
      ".lav .foglietto .cartriga button{padding:5px 8px;font-size:10px;display:inline-flex;align-items:center;gap:5px;}" +
      ".lav .foglietto .cartriga button i{display:inline-block;width:8px;height:11px;border-radius:1.5px;}" +
      ".lav .foglietto .cartriga button i.g{background:#F2C230;} .lav .foglietto .cartriga button i.r{background:#E5342B;}" +
      /* presenze e gol della stagione: in cima, come una scheda da tabellino */
      ".lav .foglietto .stagione{margin:0 0 10px;padding:9px 10px 8px;border-radius:8px;" +
      "background:rgba(6,10,26,.55);border:1px solid rgba(201,162,75,.22);}" +
      /* il foglio partita del giornalista: sotto la barra, si legge e si chiude */
      ".lav .fogliobox{margin:0 0 10px;padding:14px 16px;border-radius:10px;max-height:60vh;overflow:auto;" +
      "background:rgba(16,22,48,.9);border:1px solid rgba(201,162,75,.4);}" +
      ".lav .fogliobox .ftesta{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:8px;}" +
      ".lav .fogliobox .ftesta b{font-family:'Mazzard',sans-serif;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--lav-oroB);}" +
      ".lav .fogliobox .ftesta span{font-size:12.5px;color:var(--lav-fg3);}" +
      ".lav .fogliobox .ftesta a{font-size:12.5px;color:var(--lav-oro);}" +
      ".lav .fogliobox .fscegli{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}" +
      ".lav .fogliobox .ftesto{max-width:900px;}" +
      ".lav .fogliobox .ftesto p{font-size:14.5px;line-height:1.55;margin:0 0 7px;color:var(--lav-avorio);white-space:pre-wrap;}" +
      ".lav.chiara .fogliobox{background:#FFFFFF;border-color:#DCD5C4;}" +
      /* nella scheda: le frasi dei fogli che nominano il giocatore */
      ".lav .foglietto .dafogli{margin:0 0 10px;padding:9px 10px 8px;border-radius:8px;" +
      "background:rgba(6,10,26,.45);border:1px solid rgba(245,241,230,.12);}" +
      ".lav .foglietto .dafogli .fr{font-size:13px;line-height:1.45;padding:4px 0;border-top:1px solid rgba(245,241,230,.07);color:var(--lav-avorio);}" +
      ".lav .foglietto .dafogli .fr:first-of-type{border-top:0;}" +
      ".lav .foglietto .dafogli .fr small{display:block;color:var(--lav-fg3);font-size:11.5px;margin-top:2px;}" +
      ".lav .foglietto .dafogli .fr small a{color:var(--lav-oro);cursor:pointer;text-decoration:underline;}" +
      ".lav.chiara .foglietto .dafogli{background:#F6F2E9;border-color:#E2D6B6;}" +
      ".lav.chiara .foglietto .dafogli .fr{border-top-color:rgba(10,15,36,.08);}" +
      /* da sapere: poche righe di fatti, sopra la stagione */
      ".lav .foglietto .dasapere{margin:0 0 10px;padding:9px 10px 8px;border-radius:8px;" +
      "background:rgba(201,162,75,.10);border:1px solid rgba(201,162,75,.30);}" +
      ".lav .foglietto .dasapere ul{list-style:none;margin:0;padding:0;}" +
      ".lav .foglietto .dasapere li{font-size:13.5px;line-height:1.45;padding:2px 0 2px 14px;position:relative;color:var(--lav-avorio);}" +
      ".lav .foglietto .dasapere li::before{content:'';position:absolute;left:2px;top:9px;width:5px;height:5px;border-radius:50%;background:var(--lav-oro);}" +
      ".lav .foglietto .dasapere li b{font-weight:700;}" +
      ".lav.chiara .foglietto .dasapere{background:#FBF4DF;border-color:#E2D6B6;}" +
      ".lav .foglietto .sttit{font-family:'Mazzard',sans-serif;font-size:10.5px;font-weight:700;" +
      "letter-spacing:.16em;text-transform:uppercase;color:#C9A24B;margin-bottom:6px;}" +
      /* il menu' della stagione: sta al posto del titolo */
      ".lav .foglietto .sttesta{margin-bottom:6px;}" +
      ".lav .foglietto .sttesta select{font-family:'Mazzard',sans-serif;font-size:11px;font-weight:700;" +
      "letter-spacing:.12em;text-transform:uppercase;color:#E3C271;background:rgba(6,10,26,.8);" +
      "border:1px solid rgba(201,162,75,.35);border-radius:6px;padding:5px 8px;cursor:pointer;}" +
      ".lav .foglietto .sttesta select option,.lav .foglietto .sttesta select optgroup{background:#141B3C;color:#F5F1E6;text-transform:none;letter-spacing:0;}" +
      ".lav .foglietto .sttab{max-height:168px;overflow-y:auto;}" +
      ".lav .foglietto .stvuoto{font-size:13px;color:var(--lav-fg3);}" +
      ".lav .foglietto table{width:100%;border-collapse:collapse;font-family:'DM Sans',sans-serif;font-size:14px;}" +
      ".lav .foglietto th{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;" +
      "color:var(--lav-fg3);text-align:center;padding:0 4px 4px;}" +
      ".lav .foglietto td{padding:4px;text-align:center;color:var(--lav-avorio);font-weight:700;" +
      "font-variant-numeric:tabular-nums;border-top:1px solid rgba(245,241,230,.07);}" +
      ".lav .foglietto td:first-child{text-align:left;font-weight:600;color:#E8E3D3;}" +
      ".lav .foglietto td small{font-weight:500;color:var(--lav-fg3);font-size:11.5px;}" +
      ".lav .foglietto tr.tot td{color:#E3C271;border-top:1px solid rgba(201,162,75,.35);}" +
      ".lav .foglietto th i.giallo{display:inline-block;width:8px;height:11px;border-radius:1.5px;background:#F2C230;vertical-align:-1px;}" +
      ".lav .foglietto .rosso{display:inline-block;min-width:14px;padding:0 3px;border-radius:2px;background:#E5342B;color:#fff;font-size:11px;}" +
      ".lav .foglietto textarea{width:100%;height:118px;padding:11px 12px;border-radius:7px;resize:vertical;" +
      "  background:rgba(245,241,230,.06);border:1px solid rgba(245,241,230,.16);color:var(--lav-avorio);" +
      "  font-family:'DM Sans',sans-serif;font-size:15px;line-height:1.5;}" +
      ".lav .foglietto textarea:focus{outline:none;border-color:rgba(201,162,75,.4);}" +
      ".lav .foglietto .piede{display:flex;gap:6px;justify-content:flex-end;margin-top:9px;}" +
      ".lav .foglietto .piede button{padding:6px 9px;font-size:10px;}" +
      ".lav .foglietto .via{color:#FF6B6E;border-color:rgba(229,27,32,.4);}" +
      /* numero e cognome si scrivono qui: servono alle squadre che su ESPN non ci sono */
      ".lav .foglietto .chi{display:flex;gap:7px;margin-bottom:8px;}" +
      ".lav .foglietto .chi input{padding:8px 10px;border-radius:7px;background:rgba(6,10,26,.75);" +
      "border:1px solid rgba(245,241,230,.14);color:var(--lav-avorio);font-family:'DM Sans',sans-serif;font-size:14px;}" +
      ".lav .foglietto .chi input[data-f='num']{width:62px;text-align:center;font-weight:700;}" +
      ".lav .foglietto .chi input[data-f='nome']{flex:1;min-width:0;}" +
      ".lav .foglietto .chi input:focus{outline:none;border-color:rgba(201,162,75,.45);}" +
      /* IL TEMA CHIARO: la lavagna bianca. Blu notte e grigino si leggevano
         male: qui il testo e' blu notte pieno su avorio, e l'oro e' piu'
         scuro, perche' quello del marchio sul chiaro sparisce. E' il tema
         di partenza; il tasto nella barra torna allo scuro. */
      ".lav.chiara{--lav-oro:#8A6A1E;--lav-oroB:#6E520F;--lav-avorio:#0A0F24;--lav-fg3:#4A5068;" +
      "color:#0A0F24;background:#F3EFE6;padding:14px;border-radius:14px;color-scheme:light;}" +
      ".lav.chiara button{background:#FFFFFF;color:#1B2140;border-color:#CFC7B4;}" +
      ".lav.chiara button:hover{color:#6E520F;border-color:#8A6A1E;}" +
      ".lav.chiara button.on{background:#F1E3BE;border-color:#8A6A1E;color:#4A370A;}" +
      ".lav.chiara button.via,.lav.chiara .foglietto .via{color:#B3171C;border-color:rgba(179,23,28,.45);}" +
      ".lav.chiara .sep{background:#D8D1C0;}" +
      ".lav.chiara .colore{border-color:rgba(10,15,36,.3);}.lav.chiara .colore.on{border-color:#0A0F24;box-shadow:0 0 0 2px rgba(138,106,30,.45);}" +
      ".lav.chiara .campoBox{border-color:rgba(10,15,36,.22);}" +
      ".lav.chiara .col{background:#FFFFFF;border-color:#DCD5C4;box-shadow:0 1px 2px rgba(10,15,36,.06);}" +
      ".lav.chiara .gioc button{background:#F6F2E9;border-color:#DCD5C4;color:#0A0F24;}" +
      /* chi e' gia' in campo non si sbiadisce (sul chiaro diventava grigino):
         resta leggibile, col bordo tratteggiato e senza fondo */
      ".lav.chiara .gioc button.dentro{opacity:1;background:transparent;border-style:dashed;color:#4A5068;}" +
      ".lav.chiara .gioc button.dentro b{color:#8A8FA3;}" +
      ".lav.chiara .conta .ct svg path:first-child{stroke:#0A0F24;}" +
      ".lav.chiara .lato{flex-basis:330px;}" +
      ".lav.chiara .gioc button.scelto{background:#F1E3BE;border-color:#8A6A1E;color:#0A0F24;}" +
      ".lav.chiara .nota{color:#4A5068;}.lav.chiara .nota.ok{color:#1C7A4A;}.lav.chiara .nota.err{color:#B3171C;}" +
      ".lav.chiara .cambi,.lav.chiara .curio{color:#1B2140;}" +
      ".lav.chiara .curio div{border-bottom-color:rgba(10,15,36,.08);}" +
      ".lav.chiara .segui select{background:#FFFFFF;border-color:#CFC7B4;color:#0A0F24;}" +
      ".lav.chiara .segui select option{background:#FFFFFF;color:#0A0F24;}" +
      ".lav.chiara .segui b,.lav.chiara .diretta b{color:#B3171C;}" +
      ".lav.chiara .diretta{background:#FCEDEC;border-color:rgba(179,23,28,.4);}" +
      ".lav.chiara .diretta .azione{color:#1B2140;}" +
      ".lav.chiara .conta .ct{background:#F6F2E9;border-color:#DCD5C4;}" +
      ".lav.chiara .conta .ct:hover,.lav.chiara .conta .ct.chiedo{background:#F1E3BE;border-color:#8A6A1E;}" +
      ".lav.chiara .conta .ct .meno{background:#FFFFFF;border-color:#CFC7B4;color:#4A5068;}" +
      ".lav.chiara .conta .ct.su b{color:#8A6A1E;}" +
      ".lav.chiara.chiedo-A .gioc button[data-lato=\"A\"],.lav.chiara.chiedo-B .gioc button[data-lato=\"B\"]{outline-color:#8A6A1E;}" +
      ".lav.chiara .campoBox .foglietto{background:#FFFFFF;border-color:#8A6A1E;box-shadow:0 12px 30px rgba(10,15,36,.35);}" +
      ".lav.chiara .foglietto .stagione{background:#F6F2E9;border-color:#E2D6B6;}" +
      ".lav.chiara .foglietto .sttit,.lav.chiara .foglietto .cartriga .cl{color:#8A6A1E;}" +
      ".lav.chiara .foglietto .sttesta select{background:#FFFFFF;color:#6E520F;border-color:#CFC7B4;}" +
      ".lav.chiara .foglietto .sttesta select option,.lav.chiara .foglietto .sttesta select optgroup{background:#FFFFFF;color:#0A0F24;}" +
      ".lav.chiara .foglietto td{border-top-color:rgba(10,15,36,.09);}" +
      ".lav.chiara .foglietto td:first-child{color:#1B2140;}" +
      ".lav.chiara .foglietto tr.tot td{color:#6E520F;border-top-color:rgba(138,106,30,.45);}" +
      ".lav.chiara .foglietto textarea,.lav.chiara .foglietto .chi input{background:#FBF9F3;border-color:#CFC7B4;color:#0A0F24;}" +
      ".lav.chiara .foglietto textarea:focus,.lav.chiara .foglietto .chi input:focus{border-color:#8A6A1E;}";
    document.head.appendChild(s);
  }

  var quante = 0;
  function monta(box, opz) {
    opz = opz || {};
    var IO = "lav" + (++quante);   // il nome di questa lavagna: gli id non si scontrano
    stile();
    box.classList.add("lav");
    // chiara (la lavagna bianca) o scura: si ricorda la scelta, e la
    // pagina della lavagna la segue tutta, non solo il riquadro
    function tema(chiaro, ricordalo) {
      box.classList.toggle("chiara", chiaro);
      if (opz.salva) document.documentElement.classList.toggle("lav-chiara", chiaro);
      var t = box.querySelector('[data-az="tema"]');
      if (t) t.textContent = chiaro ? "Tema scuro" : "Tema chiaro";
      if (ricordalo) { try { localStorage.setItem("comotv.lavagna.tema", chiaro ? "chiara" : "scura"); } catch (e) {} }
    }
    box.innerHTML =
      '<div class="barra">' +
        '<button type="button" class="on" data-arnese="muovi">&#10021; Muovi</button>' +
        '<button type="button" data-arnese="penna">&#9998; Penna</button>' +
        '<button type="button" data-arnese="freccia">&#10230; Freccia</button>' +
        '<button type="button" data-arnese="linea">&#9472; Linea</button>' +
        '<button type="button" data-arnese="tratteggio">&#8943; Tratteggio</button>' +
        '<button type="button" data-arnese="zona">&#9647; Zona</button>' +
        '<span class="sep"></span>' +
        ['#F5F1E6', '#F5B91E', '#E0312B', '#4FA3E8', '#0A0F24'].map(function (c, i) {
          return '<button type="button" class="colore' + (i ? "" : " on") + '" data-colore="' + c + '" style="background:' + c + '"></button>';
        }).join("") +
        '<span class="sep"></span>' +
        '<button type="button" data-az="schiera">&#9917; Schiera</button>' +
        '<button type="button" data-az="indietro" title="Annulla l\'ultima mossa (Cmd/Ctrl+Z)">&#8630; Annulla</button>' +
        '<button type="button" class="via" data-az="pulisci">Cancella i disegni</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-az="png">&#11015; Immagine</button>' +
        '<button type="button" data-az="stampa">&#128424; Stampa</button>' +
        '<button type="button" data-az="tema"></button>' +
        // il foglio partita del giornalista, quando c'e' (fogli della redazione)
        '<button type="button" data-az="foglio" hidden>&#128196; Foglio partita</button>' +
        (opz.salva ? '<span class="sep"></span><span data-salva="1"></span>' : "") +
      '</div>' +
      // seguire una partita vera: la scelta sta qui dentro, cosi' vale in
      // tutte le case della lavagna (pagina, Formazioni, banco partita)
      // la riga della diretta esce solo dove serve (il banco partita): la
      // lavagna della telecronaca resta un attrezzo a mano
      (!opz.diretta ? "" :
      '<div class="barra segui">' +
        '<b>Diretta</b>' +
        '<select data-d="comp"><option value="">— competizione —</option></select>' +
        '<select data-d="part" disabled><option value="">— partita —</option></select>' +
        '<button type="button" data-az="segui" disabled>&#128308; Segui</button>' +
        '<button type="button" data-az="fermaDiretta">Stacca</button>' +
        '<span class="nota" data-dnota="1" style="margin:0">Il pallone segue le giocate di ESPN, col suo ritardo (circa un minuto). Le giovanili ESPN non le ha.</span>' +
      '</div>') +
      // il campo e, DI FIANCO, le due rose: si pesca da li' mentre si guarda
      // il campo, senza scorrere la pagina
      '<div class="diretta" data-diretta="1" style="display:none"></div>' +
      '<div class="fogliobox" data-fogliobox="1" hidden></div>' +
      '<div class="fianco">' +
        '<div class="campoBox"><svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
        '<div class="lato">' +
          '<div class="col" data-col="A"><h4><label class="colsq" title="Il colore delle pedine"><i></i><input type="color" data-colsq="A"></label><span data-nome="A">Casa</span><select class="magsq" data-maglia="A" title="Le pedine con la divisa vera del magazzino" hidden></select></h4><div class="conta" data-conta="A"></div><div class="gioc" data-rosa="A"></div></div>' +
          '<div class="col" data-col="B"><h4><label class="colsq" title="Il colore delle pedine"><i></i><input type="color" data-colsq="B"></label><span data-nome="B">Ospite</span><select class="magsq" data-maglia="B" title="Le pedine con la divisa vera del magazzino" hidden></select></h4><div class="conta" data-conta="B"></div><div class="gioc" data-rosa="B"></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="nota" data-nota="1">Trascina i giocatori. <b>Doppio clic</b> su un giocatore: ci scrivi le tue curiosità. ' +
        'Per un cambio: clicca chi esce sul campo, poi chi entra dalla panchina.</div>' +
      '<div class="sotto">' +
        // in diretta i cambi si vedono gia' sul campo, la lista e' rumore
        (opz.diretta ? "" :
          '<div class="col"><h4>Cambi</h4><div class="cambi" data-cambi="1"><span>Nessun cambio.</span></div></div>') +
        '<div class="col"><h4>Curiosità</h4><div class="curio" data-curio="1"><span style="color:var(--lav-fg3)">Doppio clic su un giocatore per scriverci sopra.</span></div></div>' +
      '</div>';
    var temaSalvato = null;
    try { temaSalvato = localStorage.getItem("comotv.lavagna.tema"); } catch (e) {}
    tema(temaSalvato !== "scura");

    var svg = box.querySelector("svg");
    var gCampo = ns("g", {}, svg), gDis = ns("g", {}, svg), gPedine = ns("g", {}, svg);
    var SQ = { A: { nome: "Casa", col: "#2E6BE6", rosa: [], mod: "4-3-3" },
               B: { nome: "Ospite", col: "#E0312B", rosa: [], mod: "4-4-2" } };
    var PEDINE = [], CAMBI = [], NOTE = {}, SCELTO = null;
    // LE DIVISE: SQ[lato].dove = "casa" | "trasferta" | "terza" | "quarta" |
    // "" (il pallino colorato) | undefined (si sceglie da sola: casa per chi
    // gioca in casa, trasferta per l'ospite). L'immagine si tiene come dati
    // (MG_DATI), cosi' finisce anche nell'Immagine e nella Stampa.
    var MG_DATI = {};
    function bordo(p) { return MG_DATI[SQ[p.lato].mg || ""] ? "none" : "#F5F1E6"; }
    function rivesti() {
      PEDINE.forEach(function (p) {
        var vecchia = p.g;
        pedina(p);
        if (vecchia && vecchia.parentNode) vecchia.parentNode.removeChild(vecchia);
      });
      evidenzia();
    }
    function vesti() {
      if (!window.Maglie) return;
      Maglie.carica(function () {
        ["A", "B"].forEach(function (lato) {
          var S = SQ[lato], ci = Maglie.quali(S.nome);
          if (S.dove === undefined) S.dove = ci.indexOf(lato === "A" ? "casa" : "trasferta") >= 0
            ? (lato === "A" ? "casa" : "trasferta") : (ci[0] || "");
          S.mg = S.mgFisso || (S.dove ? Maglie.url(S.nome, S.dove) : "");
          if (S.mg && !MG_DATI[S.mg]) {
            fetch(S.mg).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) {
              var fr = new FileReader();
              fr.onload = function () { MG_DATI[S.mg] = fr.result; rivesti(); };
              fr.readAsDataURL(b);
            }).catch(function () {});
          }
        });
        disegnaMaglie(); rivesti();
      });
    }
    function disegnaMaglie() {
      ["A", "B"].forEach(function (lato) {
        var sel = box.querySelector('[data-maglia="' + lato + '"]'), S = SQ[lato];
        var col = box.querySelector('[data-colsq="' + lato + '"]');
        if (col) col.value = /^#[0-9a-f]{6}$/i.test(S.col || "") ? S.col : "#2E6BE6";
        if (!sel) return;
        var ci = window.Maglie ? Maglie.quali(S.nome) : [];
        if (S.mgFisso && S.dove && ci.indexOf(S.dove) < 0) ci.push(S.dove);
        if (!ci.length) { sel.hidden = true; return; }
        var NOMI = { casa: "Maglia casa", trasferta: "Maglia trasferta", terza: "Terza maglia", quarta: "Quarta maglia" };
        sel.innerHTML = '<option value="">Pallino colorato</option>' + ci.map(function (d) {
          return '<option value="' + d + '"' + (S.dove === d ? " selected" : "") + ">" + NOMI[d] + "</option>";
        }).join("");
        if (!S.dove) sel.value = "";
        sel.hidden = false;
      });
    }
    // i contatori della partita, per squadra: calci d'angolo, gialli, rossi
    var CONTA = { A: { ang: 0, gia: 0, ros: 0 }, B: { ang: 0, gia: 0, ros: 0 } };
    var VOCI_CONTA = [["ang", "Angoli"], ["gia", "Gialli"], ["ros", "Rossi"]];
    // I CARTELLINI hanno un nome: ognuno sa di che squadra e' e, se lo si sa,
    // di chi (pid). Quelli senza nome contano lo stesso. Il contatore dei
    // gialli e dei rossi e' il loro conto, quello degli angoli resta un numero.
    // Il secondo giallo porta con se' il rosso (doppio: true).
    var CART = [];                      // { lato, pid|null, tipo: "gia"|"ros", doppio?, k? (evento ESPN) }
    var CHI = null;                     // { lato, tipo }: si aspetta il clic sul giocatore ammonito
    function quanti(lato, tipo) {
      return CART.filter(function (c) { return c.lato === lato && c.tipo === tipo; }).length;
    }
    function cartDi(lato, pid) {
      var v = CART.filter(function (c) { return c.lato === lato && pid != null && String(c.pid) === String(pid); });
      return { gialli: v.filter(function (c) { return c.tipo === "gia"; }).length,
               rosso: v.some(function (c) { return c.tipo === "ros"; }),
               doppio: v.some(function (c) { return c.doppio; }) };
    }
    function nuovoCart(lato, pid, tipo, k) {
      CART.push({ lato: lato, pid: pid, tipo: tipo, k: k || null });
      // il secondo giallo alla stessa persona e' un rosso
      if (tipo === "gia" && pid != null && cartDi(lato, pid).gialli === 2 && !cartDi(lato, pid).rosso) {
        CART.push({ lato: lato, pid: pid, tipo: "ros", doppio: true, k: null });
      }
    }
    function togliCart(lato, tipo, pid) {
      for (var i = CART.length - 1; i >= 0; i--) {
        var c = CART[i];
        if (c.lato !== lato || c.tipo !== tipo || (pid !== undefined && String(c.pid) !== String(pid))) continue;
        CART.splice(i, 1);
        // tolto un giallo, se c'era il rosso della doppia ammonizione va via anche lui
        if (tipo === "gia" && c.pid != null) {
          for (var j = CART.length - 1; j >= 0; j--) {
            if (CART[j].doppio && CART[j].lato === lato && String(CART[j].pid) === String(c.pid)) { CART.splice(j, 1); break; }
          }
        }
        return true;
      }
      return false;
    }
    function chiediFine() {
      box.classList.remove("chiedo-A", "chiedo-B");
      PEDINE.forEach(function (q) { if (q.g) q.g.classList.remove("cand"); });
    }
    // il giocatore scelto (o nessuno): il cartellino e' suo
    function assegna(g) {
      if (!CHI) return;
      var c = CHI; CHI = null;
      ricorda();
      nuovoCart(c.lato, g ? g.pid : null, c.tipo);
      chiediFine();
      disegnaConta([c.lato, c.tipo]); disegnaRose();
      var d = g ? cartDi(c.lato, g.pid) : null;
      nota(g ? ((c.tipo === "gia" ? (d.doppio ? "Secondo giallo: <b>espulso</b> " : "Ammonito ") : "Espulso ") +
                "<b>" + esc(((g.num ? g.num + " " : "") + (g.cognome || g.nome || "")).trim()) + "</b>.")
             : (c.tipo === "gia" ? "Giallo senza nome." : "Rosso senza nome.") + " Si puo' dare il nome dalla scheda del giocatore.", "ok");
    }
    function disegnaConta(acceso) {
      ["A", "B"].forEach(function (lato) {
        var dove = box.querySelector('[data-conta="' + lato + '"]');
        if (!dove) return;
        dove.innerHTML = VOCI_CONTA.map(function (v) {
          var ic = v[0] === "ang"
            ? '<svg width="14" height="15" viewBox="0 0 14 15"><path d="M2 1v13" stroke="#F5F1E6" stroke-width="1.6"/>' +
              '<path d="M2.8 1.5h9l-2.6 3 2.6 3h-9z" fill="#E3C271"/></svg>'
            : "<i></i>";
          var chiedo = CHI && CHI.lato === lato && CHI.tipo === v[0];
          return '<div class="ct' + (acceso && acceso[0] === lato && acceso[1] === v[0] ? " su" : "") +
                 (chiedo ? " chiedo" : "") + '" data-lato="' + lato + '" data-k="' + v[0] + '" title="' +
                 (v[0] === "ang" ? "Clic: +1" : "Clic, poi il giocatore: il cartellino e' suo") + '">' +
                 '<span class="ic ' + v[0] + '">' + ic + "</span><b>" +
                 (v[0] === "ang" ? CONTA[lato].ang : quanti(lato, v[0])) + "</b><em>" + v[1] + "</em>" +
                 '<button type="button" class="meno" title="Togli uno">&minus;</button></div>';
        }).join("");
      });
      PEDINE.forEach(segnaCart);
    }
    // La pila dei passi: prima di ogni mossa si mette da parte com'era.
    // Cmd/Ctrl+Z torna indietro, Cmd/Ctrl+Maiusc+Z rifa'. Trenta passi
    // bastano: e' una lavagna, non un programma di montaggio.
    var PASSI = [], RIFAI = [], PASSI_MAX = 30;
    var ARNESE = "muovi", COLORE = "#F5F1E6";

    function ricorda() {
      try { PASSI.push(JSON.stringify(stato())); } catch (e) { return; }
      if (PASSI.length > PASSI_MAX) PASSI.shift();
      RIFAI.length = 0;
    }
    function annulla() {
      if (!PASSI.length) { nota("Non c'è più niente da annullare.", ""); return; }
      try { RIFAI.push(JSON.stringify(stato())); } catch (e) {}
      riapri(JSON.parse(PASSI.pop()));
      nota("Annullato. <b>Cmd/Ctrl+Maiusc+Z</b> per rifare.", "");
    }
    function rifai() {
      if (!RIFAI.length) return;
      try { PASSI.push(JSON.stringify(stato())); } catch (e) {}
      riapri(JSON.parse(RIFAI.pop()));
      nota("Rifatto.", "");
    }
    function nota(t, cls) {
      var n = box.querySelector("[data-nota]");
      n.className = "nota" + (cls ? " " + cls : "");
      n.innerHTML = t;
    }

    // ── il campo ────────────────────────────────────────────────────────
    (function campo() {
      ns("defs", {}, gCampo);
      ns("rect", { width: W, height: H, fill: "#0E7A3E" }, gCampo);
      // Le righe dell'erba sono rettangoli, non un "motivo" richiamato per
      // nome: un altro elemento con lo stesso nome nella pagina — e nelle
      // Formazioni ce ne sono tanti — faceva sparire il disegno del campo
      // appena si toccava qualcosa. Cosi' il campo non dipende da nessuno.
      for (var r = 0; r < 16; r += 2) {
        ns("rect", { x: r * (W / 16), y: 0, width: W / 16, height: H, fill: "#ffffff", opacity: .035 }, gCampo);
      }
      var L = ns("g", { fill: "none", stroke: "#F5F1E6", "stroke-opacity": .75, "stroke-width": 3 }, gCampo);
      var m = 40;
      ns("rect", { x: m, y: m, width: W - 2 * m, height: H - 2 * m }, L);
      ns("path", { d: "M" + (W / 2) + " " + m + "V" + (H - m) }, L);
      ns("circle", { cx: W / 2, cy: H / 2, r: 110 }, L);
      ns("circle", { cx: W / 2, cy: H / 2, r: 5, fill: "#F5F1E6", stroke: "none" }, L);
      [0, 1].forEach(function (lato) {
        var x0 = lato ? W - m : m, s = lato ? -1 : 1;
        ns("rect", { x: Math.min(x0, x0 + s * 200), y: H / 2 - 200, width: 200, height: 400 }, L);
        ns("rect", { x: Math.min(x0, x0 + s * 75), y: H / 2 - 100, width: 75, height: 200 }, L);
        ns("circle", { cx: x0 + s * 130, cy: H / 2, r: 4, fill: "#F5F1E6", stroke: "none" }, L);
        ns("path", { d: "M" + (x0 + s * 200) + " " + (H / 2 - 55) + "A 75 75 0 0 " + (lato ? 0 : 1) +
                        " " + (x0 + s * 200) + " " + (H / 2 + 55) }, L);
      });
    })();

    // ── le pedine ───────────────────────────────────────────────────────
    function chiave(p) { return p.lato + ":" + p.pid; }
    function pedina(p) {
      var g = ns("g", { "data-pid": chiave(p), style: "cursor:grab" }, gPedine);
      if (p.mister) {
        // l'allenatore non e' un giocatore: gettone quadrato, bordo d'oro, e
        // sta a bordo campo. Si sposta e si clicca come gli altri.
        ns("rect", { x: -27, y: -27, width: 54, height: 54, rx: 10, fill: SQ[p.lato].col,
                     stroke: "#E3C271", "stroke-width": 3, "class": "disco" }, g);
        var m = ns("text", { x: 0, y: 7, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800,
                             "font-size": 17, fill: "#F5F1E6", "letter-spacing": 1 }, g);
        m.textContent = "ALL";
      } else {
        var kit = MG_DATI[SQ[p.lato].mg || ""];
        if (kit) {
          // la divisa vera: il cerchio resta, vuoto, per la selezione e il "chi?"
          ns("circle", { cx: 0, cy: 0, r: 34, fill: "rgba(0,0,0,0)", stroke: "none", "stroke-width": 3, "class": "disco" }, g);
          ns("image", { href: kit, x: -36, y: -38, width: 72, height: 72, preserveAspectRatio: "xMidYMid meet" }, g);
        } else {
          ns("circle", { cx: 0, cy: 0, r: 26, fill: SQ[p.lato].col, stroke: "#F5F1E6", "stroke-width": 3, "class": "disco" }, g);
        }
        var t = ns("text", kit
          ? { x: 0, y: 8, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800, "font-size": 23,
              fill: "#FFFFFF", stroke: "#06101F", "stroke-width": 4, "paint-order": "stroke", "stroke-linejoin": "round" }
          : { x: 0, y: 9, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 800,
              "font-size": 24, fill: "#F5F1E6" }, g);
        t.textContent = p.num || "";
        p.tNum = t;
      }
      var n = ns("text", { x: 0, y: kit ? 56 : 48, "text-anchor": "middle", "font-family": "Mazzard", "font-weight": 700,
                           "font-size": 19, fill: "#F5F1E6", stroke: "#06301A", "stroke-width": 4,
                           "paint-order": "stroke", "stroke-linejoin": "round" }, g);
      n.textContent = (p.cognome || "").toUpperCase();
      p.tNome = n;
      // il puntino d'oro: questo giocatore ha una curiosita' scritta
      ns("circle", { cx: 20, cy: -20, r: 7, fill: "#E3C271", stroke: "#06301A", "stroke-width": 2,
                     "class": "bollo", style: "display:none" }, g);
      p.g = g;
      posa(p); segnaNota(p); segnaCart(p);
      return p;
    }
    // numero e cognome cambiati a mano: la pedina si riscrive sul posto
    function ribattezza(p) {
      if (p.tNum) p.tNum.textContent = p.num || "";
      if (p.tNome) p.tNome.textContent = (p.cognome || "").toUpperCase();
    }
    function posa(p) { p.g.setAttribute("transform", "translate(" + Math.round(p.x) + " " + Math.round(p.y) + ")"); }
    // il cartellino sulla pedina: giallo, rosso, o il rosso della doppia
    // ammonizione (giallo dietro, rosso davanti). In alto a sinistra: a
    // destra c'e' gia' il puntino d'oro delle curiosita'.
    function segnaCart(p) {
      if (!p.g) return;
      var v = p.g.querySelector(".cartellino");
      if (v) v.remove();
      var c = cartDi(p.lato, p.pid);
      if (!c.gialli && !c.rosso) return;
      var g = ns("g", { "class": "cartellino", transform: "translate(-24 -30) rotate(-12)" }, p.g);
      if (c.doppio) ns("rect", { x: -9, y: -2, width: 12, height: 17, rx: 2, fill: "#F2C230", stroke: "#06301A", "stroke-width": 1.8 }, g);
      ns("rect", { x: -4, y: 0, width: 12, height: 17, rx: 2, fill: c.rosso ? "#E5342B" : "#F2C230",
                   stroke: "#06301A", "stroke-width": 1.8 }, g);
    }
    function segnaNota(p) {
      var b = p.g.querySelector(".bollo");
      if (b) b.style.display = NOTE[chiave(p)] ? "" : "none";
    }
    function inCampo(lato, pid) {
      for (var i = 0; i < PEDINE.length; i++) if (PEDINE[i].lato === lato && PEDINE[i].pid === pid) return PEDINE[i];
      return null;
    }
    function metti(lato, g, x, y) {
      var gia = inCampo(lato, g.pid);
      if (gia) { gia.x = x; gia.y = y; posa(gia); return gia; }
      var p = pedina({ lato: lato, pid: g.pid, num: g.num, cognome: g.cognome || g.nome || "",
                       mister: !!g.mister, x: x, y: y });
      PEDINE.push(p);
      return p;
    }
    function togli(p) {
      PEDINE = PEDINE.filter(function (x) { return x !== p; });
      if (p.g && p.g.parentNode) p.g.parentNode.removeChild(p.g);
      if (SCELTO === p) SCELTO = null;
    }
    function evidenzia() {
      PEDINE.forEach(function (p) {
        var c = p.g.querySelector(".disco");
        c.setAttribute("stroke", p === SCELTO ? "#E3C271" : (p.mister ? "#E3C271" : bordo(p)));
        c.setAttribute("stroke-width", p === SCELTO ? 6 : 3);
      });
    }

    function punto(ev) {
      var r = svg.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width * W, y: (ev.clientY - r.top) / r.height * H };
    }
    // Chi e' stato colpito: NON si guarda l'elemento sotto il puntatore.
    // Appena si comincia a trascinare, il campo cattura il puntatore e da
    // quel momento clic e doppio clic arrivano al campo, non alla pedina —
    // il doppio clic delle curiosita' non scattava mai. Si guarda quindi la
    // POSIZIONE: la pedina piu' vicina, se e' abbastanza vicina.
    function pedinaDi(ev) {
      var pt = punto(ev), vicina = null, dist = 46 * 46;
      PEDINE.forEach(function (p) {
        var dx = p.x - pt.x, dy = p.y - pt.y, d = dx * dx + dy * dy;
        if (d < dist) { dist = d; vicina = p; }
      });
      return vicina;
    }

    // ── arnesi e disegno ────────────────────────────────────────────────
    box.querySelectorAll("[data-arnese]").forEach(function (b) {
      b.addEventListener("click", function () {
        ARNESE = b.dataset.arnese;
        box.querySelectorAll("[data-arnese]").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    box.querySelectorAll("[data-colore]").forEach(function (b) {
      b.addEventListener("click", function () {
        COLORE = b.dataset.colore;
        box.querySelectorAll("[data-colore]").forEach(function (x) { x.classList.toggle("on", x === b); });
      });
    });
    function punta(col) {
      var id = IO + "punta" + col.replace("#", "");
      if (svg.querySelector("#" + id)) return;
      var defs = svg.querySelector("defs");
      var m = ns("marker", { id: id, viewBox: "0 0 10 10", refX: 7, refY: 5, markerWidth: 5, markerHeight: 5,
                             orient: "auto-start-reverse" }, defs);
      ns("path", { d: "M0 0L10 5L0 10z", fill: col }, m);
    }

    var trascino = null, disegno = null, mosso = false;
    svg.addEventListener("pointerdown", function (ev) {
      chiudiNota();
      if (CHI) {
        var pc = pedinaDi(ev);
        if (pc && pc.lato === CHI.lato) { assegna(pc); ev.preventDefault(); return; }
        if (pc) { nota("Quel giocatore e' dell'altra squadra: clicca uno " + (CHI.lato === "A" ? "di casa" : "ospite") + ".", "err"); return; }
        assegna(null); return;                        // clic sul prato: senza nome
      }
      var pt = punto(ev);
      if (ARNESE === "muovi") {
        var p = pedinaDi(ev);
        if (!p) return;
        ricorda();
        trascino = { p: p, dx: p.x - pt.x, dy: p.y - pt.y };
        mosso = false;
        svg.setPointerCapture(ev.pointerId);
        return;
      }
      ricorda();
      var d = { tipo: ARNESE, punti: [pt], el: null };
      if (ARNESE === "penna") d.el = ns("path", { fill: "none", stroke: COLORE, "stroke-width": 5,
                                                  "stroke-linecap": "round", "stroke-linejoin": "round" }, gDis);
      else if (ARNESE === "zona") d.el = ns("rect", { fill: COLORE, "fill-opacity": .18, stroke: COLORE, "stroke-width": 3 }, gDis);
      else {
        if (ARNESE === "freccia") punta(COLORE);
        d.el = ns("path", { fill: "none", stroke: COLORE, "stroke-width": 5, "stroke-linecap": "round",
                            "stroke-dasharray": ARNESE === "tratteggio" ? "16 12" : null,
                            "marker-end": ARNESE === "freccia" ? "url(#" + IO + "punta" + COLORE.replace("#", "") + ")" : null }, gDis);
      }
      disegno = d;
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener("pointermove", function (ev) {
      var pt = punto(ev);
      if (trascino) {
        mosso = true;
        trascino.p.x = Math.max(20, Math.min(W - 20, pt.x + trascino.dx));
        trascino.p.y = Math.max(20, Math.min(H - 30, pt.y + trascino.dy));
        posa(trascino.p);
        return;
      }
      if (!disegno) return;
      var d = disegno;
      if (d.tipo === "penna") {
        d.punti.push(pt);
        d.el.setAttribute("d", d.punti.map(function (q, i) { return (i ? "L" : "M") + Math.round(q.x) + " " + Math.round(q.y); }).join(""));
      } else if (d.tipo === "zona") {
        var a = d.punti[0];
        d.el.setAttribute("x", Math.min(a.x, pt.x)); d.el.setAttribute("y", Math.min(a.y, pt.y));
        d.el.setAttribute("width", Math.abs(pt.x - a.x)); d.el.setAttribute("height", Math.abs(pt.y - a.y));
      } else {
        var b0 = d.punti[0];
        d.el.setAttribute("d", "M" + Math.round(b0.x) + " " + Math.round(b0.y) + "L" + Math.round(pt.x) + " " + Math.round(pt.y));
      }
    });
    function fine() {
      if (trascino) {
        // un clic senza trascinamento sceglie il giocatore: e' il primo passo
        // del cambio (chi esce)
        if (!mosso) { SCELTO = SCELTO === trascino.p ? null : trascino.p; evidenzia(); disegnaRose(); }
        trascino = null;
        return;
      }
      if (disegno) {
        if (disegno.tipo !== "zona" && !disegno.el.getAttribute("d")) disegno.el.remove();
        disegno = null;
      }
    }
    svg.addEventListener("pointerup", fine);
    svg.addEventListener("pointercancel", fine);
    // DOPPIO CLIC: le curiosita' del giornalista su quel giocatore
    svg.addEventListener("dblclick", function (ev) {
      var p = pedinaDi(ev);
      if (p) apriNota(p);
    });

    // ── la finestrella delle curiosita' ─────────────────────────────────
    // IL FOGLIETTO: si apre attaccato al giocatore, sul campo, non in mezzo
    // allo schermo — in telecronaca si guarda il campo, non una finestra che
    // lo copre. Se il giocatore sta a destra, il foglietto si apre a sinistra.
    function conStagione(fai) {
      if (window.StagioneEspn) return fai();
      var gia = document.querySelector('script[data-stagione]');
      if (!gia) {
        gia = document.createElement("script");
        gia.src = "stagione-espn.js"; gia.dataset.stagione = "1";
        document.head.appendChild(gia);
      }
      gia.addEventListener("load", function () { fai(); });
    }
    // Presenze e gol della stagione, per competizione, in cima al foglietto:
    // quello che il giornalista va sempre a cercare prima di dire un nome.
    // Si contano dalle partite vere (stagione-espn.js), non dal riepilogo
    // ESPN, che arriva con un giorno di ritardo.
    function stagioneSu(p, dove) {
      var tid = (SQ[p.lato] || {}).tid;
      var pid = String(p.pid || "");
      if (p.mister || !/^\d+$/.test(pid)) {
        dove.style.display = "none";                 // giovanili, rose a mano: si scrive e basta
        return;
      }
      var anno = new Date().getMonth() >= 6 ? new Date().getFullYear() : new Date().getFullYear() - 1;
      function etichetta(a) { return a + "-" + String(a + 1).slice(2); }
      // il menu': la stagione in corso di serie, poi le passate e la carriera
      dove.innerHTML = '<div class="sttesta"><select data-st="scelta">' +
        (tid ? '<option value="ora">Stagione ' + etichetta(anno) + "</option>" : "") +
        '<option value="car">Carriera · carico&hellip;</option></select></div>' +
        '<div data-st="corpo"><div class="stvuoto">Conto presenze e gol&hellip;</div></div>';
      var sel = dove.querySelector('[data-st="scelta"]'), corpo = dove.querySelector('[data-st="corpo"]');
      var ora = null, car = null;                     // i dati, quando arrivano
      // IL PORTIERE: al posto di gol e assist, i gol subiti e le partite senza
      // subirne; le parate solo se ci sono (ESPN le conta per le partite di
      // questa stagione, nelle stagioni passate no)
      var CAMPI = ["presenze", "titolare", "gol", "assist", "gialli", "rossi", "subiti", "parate", "inviolate"];
      var ruolo = String(((SQ[p.lato].rosa || []).filter(function (g) { return String(g.pid) === pid; })[0] || {}).ruolo || "");
      var POR = /^(G|GK|P|POR)$/i.test(ruolo), conParate = false;
      function cella(c) {
        var pres = "<td>" + c.presenze + (c.titolare !== c.presenze && c.titolare != null ?
               '<small> (' + c.titolare + " tit.)</small>" : "") + "</td>";
        var cart = "<td>" + (c.gialli || "") + (c.rossi ? ' <span class="rosso">' + c.rossi + "</span>" : "") + "</td>";
        if (POR) return pres + "<td>" + (c.subiti || 0) + "</td><td>" + (c.inviolate || 0) + "</td>" +
                        (conParate ? "<td>" + (c.parate || 0) + "</td>" : "") + cart;
        return pres + "<td>" + c.gol + "</td><td>" + c.assist + "</td>" + cart;
      }
      function tabella(righe, primaTh, totale) {
        var th = POR ? '<th>Subiti</th><th title="Partite senza subire gol">Imbattuto</th>' + (conParate ? "<th>Parate</th>" : "")
                     : "<th>Gol</th><th>Assist</th>";
        return '<div class="sttab"><table><thead><tr><th>' + (primaTh || "") + '</th><th>Pres.</th>' + th +
               '<th><i class="giallo"></i></th></tr></thead><tbody>' + righe + (totale || "") + "</tbody></table></div>";
      }
      function somma(v) {
        var t = {}; CAMPI.forEach(function (k) { t[k] = 0; });
        v.forEach(function (c) { for (var k in t) t[k] += c[k] || 0; });
        return t;
      }
      function mostra() {
        var q = sel.value;
        // il ruolo lo dice la rosa; se manca, le partite di questa stagione
        // (li' ESPN segna chi stava in porta). La carriera no: da' i gol
        // subiti anche a chi gioca in attacco.
        if (!POR) POR = (ora || []).some(function (c) { return c.portiere; });
        conParate = POR && q === "ora" && (ora || []).some(function (c) { return c.parate > 0; });
        if (q === "ora") {
          if (!ora) { corpo.innerHTML = '<div class="stvuoto">Conto presenze e gol&hellip;</div>'; return; }
          if (!ora.length) { corpo.innerHTML = '<div class="stvuoto">Nessuna presenza in partite ufficiali.</div>'; return; }
          var t = somma(ora);
          corpo.innerHTML = tabella(ora.map(function (c) { return "<tr><td>" + esc(c.nome) + "</td>" + cella(c) + "</tr>"; }).join(""),
            "", ora.length > 1 ? '<tr class="tot"><td>Totale</td>' + cella(t) + "</tr>" : "");
          return;
        }
        if (!car) { corpo.innerHTML = '<div class="stvuoto">Carico la carriera da ESPN&hellip;</div>'; return; }
        if (q === "car") {
          // la carriera: una riga per stagione e squadra, tutte le competizioni sommate
          var gruppi = {}, ordine = [];
          if (ora && ora.length) {
            var so = somma(ora); so.anno = anno; so.squadra = SQ[p.lato].nome;
            gruppi[anno + "|ora"] = so; ordine.push(anno + "|ora");
          }
          car.forEach(function (c) {
            var k = c.anno + "|" + c.tid;
            if (!gruppi[k]) { gruppi[k] = { anno: c.anno, squadra: c.squadra }; CAMPI.forEach(function (x) { gruppi[k][x] = 0; }); ordine.push(k); }
            var g = gruppi[k];
            CAMPI.forEach(function (x) { g[x] += c[x] || 0; });
          });
          var righe = ordine.map(function (k) { return gruppi[k]; });
          if (!righe.length) { corpo.innerHTML = '<div class="stvuoto">ESPN non ha la carriera di questo giocatore.</div>'; return; }
          var tt = somma(righe);
          corpo.innerHTML = tabella(righe.map(function (g) {
            return '<tr><td>' + etichetta(g.anno) + ' <small>' + esc(g.squadra || "") + "</small></td>" + cella(g) + "</tr>";
          }).join(""), "", '<tr class="tot"><td>Carriera</td>' + cella(tt) + "</tr>");
          return;
        }
        // una stagione passata: per competizione, con la squadra se l'ha cambiata
        var a = parseInt(q, 10);
        var v = car.filter(function (c) { return c.anno === a; });
        var squadre = {}; v.forEach(function (c) { squadre[c.tid] = 1; });
        var piu = Object.keys(squadre).length > 1;
        var t2 = somma(v);
        corpo.innerHTML = tabella(v.map(function (c) {
          return "<tr><td>" + esc(c.nome) + (piu ? " <small>" + esc(c.squadra) + "</small>" : "") + "</td>" + cella(c) + "</tr>";
        }).join(""), piu ? "" : esc(v[0] ? v[0].squadra : ""), v.length > 1 ? '<tr class="tot"><td>Totale</td>' + cella(t2) + "</tr>" : "");
      }
      sel.addEventListener("change", mostra);
      sel.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      if (!tid) sel.value = "car";
      mostra();
      conStagione(function () {
        if (tid) StagioneEspn.giocatore(tid, pid).then(function (v) { ora = v; if (dove.isConnected) mostra(); });
        StagioneEspn.carriera(pid).then(function (v) {
          car = v;
          if (!dove.isConnected) return;
          // le stagioni passate nel menu', dalla piu' recente
          var anni = [];
          v.forEach(function (c) { if (anni.indexOf(c.anno) < 0) anni.push(c.anno); });
          var scelto = sel.value;
          sel.innerHTML = (tid ? '<option value="ora">Stagione ' + etichetta(anno) + "</option>" : "") +
            (anni.length ? '<optgroup label="Stagioni passate">' + anni.map(function (a) {
              return '<option value="' + a + '">' + etichetta(a) + "</option>"; }).join("") + "</optgroup>" : "") +
            '<option value="car">Carriera · tutte le stagioni</option>';
          sel.value = scelto === "car" || !tid ? "car" : scelto;
          mostra();
        });
      });
    }
    // nella scheda: i cartellini che ha, e i tasti per darne o toglierne
    function cartSu(p, dove) {
      function disegna() {
        var c = cartDi(p.lato, p.pid);
        dove.innerHTML = '<span class="cl">Cartellini</span>' +
          (c.doppio ? '<span class="stc">doppio giallo, espulso</span>' :
           c.rosso ? '<span class="stc">espulso</span>' :
           c.gialli ? '<span class="stc">ammonito</span>' : '<span class="stc vuoto">nessuno</span>') +
          '<button type="button" data-c="gia"><i class="g"></i>+ Giallo</button>' +
          '<button type="button" data-c="ros"><i class="r"></i>+ Rosso</button>' +
          (c.gialli || c.rosso ? '<button type="button" data-c="via">Togli</button>' : "");
      }
      dove.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("button[data-c]") : null;
        if (!b) return;
        ricorda();
        var c = cartDi(p.lato, p.pid);
        if (b.dataset.c === "via") {
          // si toglie prima il rosso diretto, poi i gialli
          if (c.rosso && !c.doppio) togliCart(p.lato, "ros", p.pid); else togliCart(p.lato, "gia", p.pid);
        } else {
          // un cartellino gia' dato senza nome a questa squadra prende questo nome
          var anonimo = CART.filter(function (x) { return x.lato === p.lato && x.tipo === b.dataset.c && x.pid == null; })[0];
          if (anonimo) { anonimo.pid = p.pid; var x2 = cartDi(p.lato, p.pid);
                         if (b.dataset.c === "gia" && x2.gialli === 2 && !x2.rosso) CART.push({ lato: p.lato, pid: p.pid, tipo: "ros", doppio: true }); }
          else nuovoCart(p.lato, p.pid, b.dataset.c);
        }
        disegna(); disegnaConta(); disegnaRose();
      });
      disegna();
    }
    // LA FOTO del giocatore: la chiede al ponte, come le card del campetto
    // in onda (magazzino scontornati, per id ESPN, cognome e squadra). Se
    // non c'e', la scheda resta com'era: niente sagome vuote.
    var FACCE = {};
    function ponte() {
      return location.pathname.indexOf("/como-tv-dev/") === 0 ? "/como-tv-dev/api" : "/api";
    }
    function facciaSu(p, dove) {
      if (!dove || p.mister || !(p.cognome || "").trim()) return;
      var chiave = String(p.pid) + "|" + p.cognome;
      function metti(url) {
        if (!url || !dove.isConnected) return;
        var im = new Image();
        im.alt = "";
        im.onload = function () { dove.innerHTML = ""; dove.appendChild(im); dove.hidden = false; };
        im.src = url;
      }
      if (FACCE[chiave] !== undefined) return metti(FACCE[chiave]);
      var tid = SQ[p.lato].tid, finto = /^b[AB]\d+$/.test(String(p.pid));
      fetch(ponte() + "?foto=" + encodeURIComponent(p.cognome) +
            (finto ? "" : "&id=" + encodeURIComponent(p.pid)) +
            (tid ? "&squadra=" + encodeURIComponent(tid) : ""), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) { FACCE[chiave] = (j && j.url) || ""; metti(FACCE[chiave]); })
        .catch(function () {});
    }
    // CHI E': nome intero, nascita, altezza e peso dall'anagrafe di ESPN.
    // Solo per gli id veri di ESPN (numeri): le giovanili e i giocatori
    // scritti a mano hanno id finti, e prenderebbero i dati di un altro.
    // ESPN da' pollici e libbre, arrotondati: qui metri e chili.
    var ANAG = {};
    var MESI = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
    function bioSu(p, dove, iNome) {
      if (!dove || !/^\d+$/.test(String(p.pid))) return;
      function metti(a) {
        if (!a || !dove.isConnected) return;
        // due righe fisse: quando e' nato, poi quanto e' alto e quanto pesa
        var riga1 = "", fisico = [];
        var d = /^(\d{4})-(\d{2})-(\d{2})/.exec(a.dateOfBirth || "");
        if (d) riga1 = "Nato il " + (+d[3]) + " " + MESI[+d[2] - 1] + " " + d[1] + (a.age ? '<i>·</i><b>' + a.age + " anni</b>" : "");
        if (a.height) fisico.push("<b>" + (a.height * 0.0254).toFixed(2).replace(".", ",") + " m</b>");
        if (a.weight) fisico.push("<b>" + Math.round(a.weight * 0.4536) + " kg</b>");
        dove.innerHTML = (riga1 ? "<div>" + riga1 + "</div>" : "") +
                         (fisico.length ? "<div>" + fisico.join("<i>·</i>") + "</div>" : "");
        var intero = (a.fullName || a.displayName || "").trim();
        // il nome intero va nella casella solo se nessuno ci ha gia' scritto
        if (iNome && intero && iNome.value.trim() === (p.cognome || "").trim() && document.activeElement !== iNome) {
          iNome.value = intero; iNome.dataset.intero = intero;
        }
      }
      anag(p.pid).then(metti);
    }
    // l'anagrafe ESPN di un giocatore, chiesta una volta sola
    var ANAG_IN = {};
    function anag(pid) {
      pid = String(pid || "");
      if (!/^\d+$/.test(pid)) return Promise.resolve(null);
      if (ANAG[pid]) return Promise.resolve(ANAG[pid]);
      if (!ANAG_IN[pid]) {
        ANAG_IN[pid] = fetch("https://sports.core.api.espn.com/v2/sports/soccer/athletes/" + pid)
          .then(function (r) { return r.json(); })
          .then(function (a) { if (a && (a.fullName || a.dateOfBirth)) { ANAG[pid] = a; return a; } return null; })
          .catch(function () { delete ANAG_IN[pid]; return null; });
      }
      return ANAG_IN[pid];
    }

    // DA SAPERE: poche righe di fatti, calcolate, per chi racconta la
    // partita. Niente di inventato: dai numeri ESPN (carriera, stagione
    // partita per partita, anagrafe) e da Wikidata quando c'e' qualcosa.
    // Una riga compare solo se e' vera; se non c'e' niente, la casella non
    // c'e'.
    function dasapereSu(p, dove) {
      var pid = String(p.pid || "");
      if (!dove) return;
      dove.hidden = true;
      if (p.mister || !/^\d+$/.test(pid)) return;
      var altro = p.lato === "A" ? "B" : "A", avv = SQ[altro] || {}, tid = SQ[p.lato].tid;
      var voci = {}, ORDINE = ["ex", "compleanno", "eta", "forma", "porta", "wd"];
      function scrivi() {
        if (!dove.isConnected) return;
        var h = ORDINE.filter(function (k) { return voci[k]; })
          .map(function (k) { return "<li>" + voci[k] + "</li>"; }).join("");
        dove.innerHTML = h ? '<div class="sttit">Da sapere</div><ul>' + h + "</ul>" : "";
        dove.hidden = !h;
      }
      // il compleanno, se cade nei giorni della partita
      anag(pid).then(function (a) {
        var d = a && /^(\d{4})-(\d{2})-(\d{2})/.exec(a.dateOfBirth || "");
        if (!d) return;
        var oggi = new Date(); oggi.setHours(0, 0, 0, 0);
        var diff = null, anni = 0;
        [-1, 0, 1].forEach(function (o) {
          var c = new Date(oggi.getFullYear() + o, +d[2] - 1, +d[3]);
          var g = Math.round((c - oggi) / 864e5);
          if (diff === null || Math.abs(g) < Math.abs(diff)) { diff = g; anni = oggi.getFullYear() + o - (+d[1]); }
        });
        if (Math.abs(diff) > 3) return;
        voci.compleanno = diff === 0 ? "<b>Oggi compie " + anni + " anni</b>"
          : diff === 1 ? "Domani compie <b>" + anni + " anni</b>"
          : diff > 0 ? "Fra " + diff + " giorni compie <b>" + anni + " anni</b>"
          : diff === -1 ? "Ieri ha compiuto <b>" + anni + " anni</b>"
          : "Ha compiuto <b>" + anni + " anni</b> " + (-diff) + " giorni fa";
        scrivi();
      });
      // il piu' giovane o il piu' esperto fra quelli in campo (se ESPN ha la
      // data di quasi tutti: se no il confronto non vale)
      var campo = PEDINE.filter(function (q) { return !q.mister && /^\d+$/.test(String(q.pid)); })
        .map(function (q) { return String(q.pid); });
      if (campo.indexOf(pid) >= 0 && campo.length >= 12) {
        Promise.all(campo.map(anag)).then(function (v) {
          var nati = v.map(function (a, i) { return { pid: campo[i], d: a && a.dateOfBirth }; })
            .filter(function (x) { return x.d; });
          if (nati.length < campo.length * 0.8) return;
          nati.sort(function (x, y) { return String(x.d).localeCompare(String(y.d)); });
          if (nati[nati.length - 1].pid === pid) voci.eta = "Il <b>pi&ugrave; giovane</b> in campo";
          else if (nati[0].pid === pid) voci.eta = "Il <b>pi&ugrave; esperto</b> in campo";
          scrivi();
        });
      }
      conStagione(function () {
        // ex di turno: ha giocato nella squadra di fronte
        if (avv.tid) StagioneEspn.carriera(pid).then(function (car) {
          var anni = [];
          car.forEach(function (c) { if (String(c.tid) === String(avv.tid) && anni.indexOf(c.anno) < 0) anni.push(c.anno); });
          if (!anni.length) return;
          anni.sort();
          voci.ex = "<b>Ex</b> di turno: ha giocato nel " + esc(avv.nome) + " (" +
            anni.map(function (a) { return a + "-" + String(a + 1).slice(2); }).join(", ") + ")";
          scrivi();
        });
        // il momento: le presenze di questa stagione, dalla piu' recente
        if (tid) StagioneEspn.partite(tid, pid).then(function (v) {
          if (!v.length) { voci.forma = "Nessuna presenza ufficiale in stagione: sarebbe la <b>prima</b>"; scrivi(); return; }
          if (v[0].portiere) {
            var k = 0;
            while (k < v.length && v[k].titolare && !v[k].subiti) k++;
            if (k >= 2) voci.porta = "Porta inviolata nelle ultime <b>" + k + " partite</b>";
            else if (k === 1) voci.porta = "Porta inviolata nell'ultima partita";
          } else {
            var tot = 0; v.forEach(function (x) { tot += x.gol; });
            var cinque = v.slice(0, 5), g5 = 0; cinque.forEach(function (x) { g5 += x.gol; });
            var fr = [];
            if (v[0].gol) fr.push("a segno nell'ultima partita" + (v[0].gol > 1 ? " (<b>" + v[0].gol + " gol</b>)" : ""));
            if (g5 >= 2) fr.push("<b>" + g5 + " gol</b> nelle ultime " + cinque.length + " presenze");
            if (tot > 0 && !v[0].gol) {
              var n = 0; while (n < v.length && !v[n].gol) n++;
              if (n >= 3) fr.push("non segna da <b>" + n + " presenze</b>");
            }
            if (fr.length) voci.forma = fr[0].charAt(0).toUpperCase() + fr[0].slice(1) + (fr[1] ? ", " + fr[1] : "");
          }
          scrivi();
        });
      });
      wikidataSu(pid, function (t) { if (t) { voci.wd = t; scrivi(); } });
    }

    // ── I FOGLI DELLA REDAZIONE ─────────────────────────────────────────
    // Il foglio partita che il giornalista pubblica su Slack (o nel Drive):
    // li raccoglie il lettore sulla VM (13_Server_VM/fogli) e nginx li serve
    // su /fogli-redazione/. Sono gli stessi per prod e dev.
    var FOGLI = "/fogli-redazione/", INDICE = null, INDICE_T = 0;
    // i nomi corti dei giornalisti contro quelli di ESPN
    var ALIAS_SQ = { "wolves": "wolverhampton", "wba": "west bromwich", "west brom": "west bromwich", "spurs": "tottenham",
                     "boro": "middlesbrough", "man utd": "manchester united", "man united": "manchester united",
                     "man city": "manchester city", "psv": "psv eindhoven", "inter": "internazionale", "qpr": "queens park rangers",
                     "sheffield wed": "sheffield wednesday", "sheffield utd": "sheffield united", "forest": "nottingham forest" };
    function pianoF(t) {
      return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    }
    function stessaSquadra(chiave, nome) {
      var a = pianoF(nome), k = pianoF(ALIAS_SQ[chiave] || chiave);
      if (!a || !k) return false;
      return (" " + a + " ").indexOf(" " + k + " ") >= 0 || (" " + k + " ").indexOf(" " + a + " ") >= 0;
    }
    function indice() {
      if (INDICE && Date.now() - INDICE_T < 300000) return Promise.resolve(INDICE);
      return fetch(FOGLI + "indice.json", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (j) { INDICE = j.fogli || []; INDICE_T = Date.now(); return INDICE; })
        .catch(function () { return INDICE || []; });
    }
    // i fogli di questa partita, dal piu' recente (anche di sfide passate fra le due)
    function fogliPartita(v) {
      return v.filter(function (f) {
        var k = f.chiavi || [];
        if (k.length !== 2) return false;
        return (stessaSquadra(k[0], SQ.A.nome) && stessaSquadra(k[1], SQ.B.nome)) ||
               (stessaSquadra(k[0], SQ.B.nome) && stessaSquadra(k[1], SQ.A.nome));
      });
    }
    function tastoFoglio() {
      var t = box.querySelector('[data-az="foglio"]');
      if (!t) return;
      indice().then(function (v) {
        var mie = fogliPartita(v);
        t.hidden = !mie.length;
        if (mie.length) t.title = "Il foglio di " + (mie[0].autore || "redazione") + (mie[0].data ? " del " + dataIt(mie[0].data) : "");
      });
    }
    function dataIt(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ""); return m ? (+m[3]) + "/" + (+m[2]) + "/" + m[1] : (d || ""); }
    function apriFoglio(id) {
      var fb = box.querySelector("[data-fogliobox]");
      indice().then(function (v) {
        var mie = fogliPartita(v);
        var qui = id || (mie[0] || {}).id;
        if (!qui) return;
        var meta = v.filter(function (f) { return f.id === qui; })[0] || {};
        fb.hidden = false;
        fb.innerHTML = '<div class="ftesta"><b>' + esc(meta.titolo || "Foglio partita") + "</b><span>" +
          esc([meta.autore, dataIt(meta.data)].filter(Boolean).join(" · ")) + "</span>" +
          (meta.link ? '<a href="' + esc(meta.link) + '" target="_blank" rel="noopener">apri l\'originale</a>' : "") +
          '<button type="button" data-az="foglio" style="margin-left:auto">Chiudi</button></div>' +
          (mie.length > 1 ? '<div class="fscegli">' + mie.map(function (f) {
            return '<button type="button" data-foglio="' + esc(f.id) + '"' + (f.id === qui ? ' class="on"' : "") + ">" +
                   esc((f.autore || "?") + " · " + dataIt(f.data)) + "</button>";
          }).join("") + "</div>" : "") +
          '<div class="ftesto">Carico il foglio&hellip;</div>';
        fetch(FOGLI + "fogli/" + encodeURIComponent(qui) + ".json", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (f) {
            var d = fb.querySelector(".ftesto");
            if (d) d.innerHTML = String(f.testo || "").split(/\n+/).map(function (r) { return "<p>" + esc(r) + "</p>"; }).join("");
          }).catch(function () { var d = fb.querySelector(".ftesto"); if (d) d.textContent = "Foglio non raggiungibile."; });
      });
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("[data-foglio]") : null;
      if (b) { ev.preventDefault(); apriFoglio(b.dataset.foglio); }
    });
    // nella scheda: le frasi dei fogli che nominano questo giocatore. Prima
    // quelle delle partite della sua squadra; il cognome deve esserci tutto
    // (per "Da Cunha" non basta "Cunha")
    function dafogliSu(p, dove) {
      if (!dove || p.bianca) return;
      var cog = pianoF(p.cognome || "");
      if (cog.length < 3) return;
      var chiave = cog.split(" ").filter(function (x) { return x.length >= 3; }).pop();
      if (!chiave) return;
      Promise.all([indice(), fetch(FOGLI + "nomi/" + encodeURIComponent(chiave) + ".json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })])
        .then(function (r) {
          var per = {}; r[0].forEach(function (f) { per[f.id] = f; });
          var suoi = r[1].filter(function (x) { return per[x.id] && (" " + pianoF(x.frase) + " ").indexOf(" " + cog + " ") >= 0; });
          if (!suoi.length || !dove.isConnected) return;
          function mia(x) {
            var k = per[x.id].chiavi || [];
            return k.some(function (c) { return stessaSquadra(c, SQ[p.lato].nome); }) ? 0 : 1;
          }
          suoi.sort(function (a, b) { return mia(a) - mia(b) || String(per[b.id].data).localeCompare(String(per[a.id].data)); });
          var n = suoi.length;
          dove.innerHTML = '<div class="sttit">Dai fogli della redazione' + (n > 4 ? " · " + n + " frasi" : "") + "</div>" +
            suoi.slice(0, 4).map(function (x) {
              var f = per[x.id];
              return '<div class="fr">' + esc(x.frase) + "<small>" + esc((f.squadre || []).join(" - ") || f.titolo) +
                     " · " + esc(dataIt(f.data)) + (f.autore ? " · " + esc(f.autore) : "") +
                     ' · <a data-foglio="' + esc(f.id) + '">leggi il foglio</a></small></div>';
            }).join("");
          dove.hidden = false;
        });
    }

    // WIKIDATA: luogo di nascita, soprannome e parenti calciatori, quando ci
    // sono (per molti giocatori c'e' solo il luogo). Il giocatore si trova
    // per id ESPN (P3681), se no per nome + calciatore + anno di nascita
    // uguale a ESPN: un omonimo non passa. Si chiede una volta e si tiene.
    var LSW = "comotv.wikidata2.";
    var PARENTELA = { P22: "Figlio di", P25: "Figlio di", P3373: "Fratello di", P40: "Padre di", P1038: "Parente di" };
    function wikidataSu(pid, poi) {
      var c = null;
      try { c = JSON.parse(localStorage.getItem(LSW + pid) || "null"); } catch (e) {}
      if (c) return poi(c.t);
      var W = "https://www.wikidata.org/w/api.php?origin=*&format=json&";
      function j(u) { return fetch(W + u).then(function (r) { return r.json(); }); }
      function val(cl, p) {
        return (cl[p] || []).map(function (x) { return (x.mainsnak.datavalue || {}).value; }).filter(Boolean);
      }
      anag(pid).then(function (a) {
        if (!a) return null;
        var anno = String(a.dateOfBirth || "").slice(0, 4), nome = a.fullName || a.displayName || "";
        return j("action=query&list=search&srsearch=" + encodeURIComponent("haswbstatement:P3681=" + pid))
          .then(function (r) {
            var ids = ((r.query || {}).search || []).map(function (x) { return x.title; });
            if (ids.length) return { ids: ids.slice(0, 1), certo: true };
            return j("action=wbsearchentities&type=item&limit=7&language=en&search=" + encodeURIComponent(nome))
              .then(function (r2) { return { ids: (r2.search || []).map(function (x) { return x.id; }), certo: false }; });
          })
          .then(function (q) {
            if (!q.ids.length) return null;
            return j("action=wbgetentities&props=claims&ids=" + q.ids.join("|")).then(function (r) {
              for (var i = 0; i < q.ids.length; i++) {
                var cl = ((r.entities || {})[q.ids[i]] || {}).claims || {};
                var lavoro = val(cl, "P106").map(function (v) { return v.id; });
                var nato = val(cl, "P569").map(function (v) { return String(v.time || "").slice(1, 5); });
                if (q.certo || (lavoro.indexOf("Q937857") >= 0 && anno && nato.indexOf(anno) >= 0)) return cl;
              }
              return null;
            });
          });
      }).then(function (cl) {
        if (!cl) return "";
        var luogo = val(cl, "P19").map(function (v) { return v.id; })[0];
        var sopr = val(cl, "P1449").filter(function (v) { return v.language === "it"; })[0] ||
                   val(cl, "P1449").filter(function (v) { return v.language === "en"; })[0] || val(cl, "P1449")[0];
        var par = [];
        Object.keys(PARENTELA).forEach(function (p) {
          val(cl, p).forEach(function (v) { if (v.id) par.push({ p: p, id: v.id }); });
        });
        var ids = (luogo ? [luogo] : []).concat(par.map(function (x) { return x.id; })).slice(0, 40);
        var chiedi = ids.length ? j("action=wbgetentities&props=labels|claims&languages=it|en&ids=" + ids.join("|"))
                                : Promise.resolve({ entities: {} });
        return chiedi.then(function (r) {
          var E = r.entities || {};
          function nomeDi(id) { var l = (E[id] || {}).labels || {}; return (l.it || l.en || {}).value || ""; }
          var righe = [];
          if (luogo && nomeDi(luogo)) righe.push("Nato " + (/^[Aa]/.test(nomeDi(luogo)) ? "ad" : "a") + " <b>" + esc(nomeDi(luogo)) + "</b>");
          if (sopr && sopr.text) righe.push("Soprannome: <b>" + esc(sopr.text) + "</b>");
          // solo i parenti che hanno fatto calcio (calciatore o allenatore)
          par.forEach(function (x) {
            var cl2 = (E[x.id] || {}).claims || {};
            var lav = val(cl2, "P106").map(function (v) { return v.id; });
            if (lav.indexOf("Q937857") < 0 && lav.indexOf("Q628099") < 0) return;
            if (nomeDi(x.id)) righe.push(PARENTELA[x.p] + " <b>" + esc(nomeDi(x.id)) + "</b>" +
                                         (lav.indexOf("Q937857") >= 0 ? " (calciatore)" : " (allenatore)"));
          });
          return righe.join(" · ");
        });
      }).then(function (t) {
        if (t === undefined || t === null) return;
        try { localStorage.setItem(LSW + pid, JSON.stringify({ t: t })); } catch (e) {}
        poi(t);
      }).catch(function () {});
    }
    function apriNota(p) {
      chiudiNota();
      var k = chiave(p), cassa = box.querySelector(".campoBox");
      var f = document.createElement("div");
      f.className = "foglietto";
      f.innerHTML =
        // la faccia a sinistra, squadra e nome a destra: si riconosce il
        // giocatore prima ancora di leggere
        '<div class="testa"><div class="faccia" data-faccia="1" hidden style="--sq:' + esc(SQ[p.lato].col || "#1B2140") + '"></div><div class="testadx">' +
        // sopra il nome: nascita, altezza e peso da ESPN (per l'allenatore
        // la squadra, che li' dice qualcosa)
        (p.mister ? '<h3>' + esc(SQ[p.lato].nome) + ' · allenatore</h3>' : '<div class="bio" data-bio="1"></div>') +
        (p.mister ? "" :
          '<div class="chi"><input data-f="num" type="text" inputmode="numeric" maxlength="2" ' +
          'placeholder="N" value="' + esc(p.num || "") + '">' +
          '<input data-f="nome" type="text" placeholder="Cognome" value="' + esc(p.cognome || "") + '"></div>') +
        '</div></div>' +
        '<div class="cartriga" data-cart-box="1"></div>' +
        '<div class="dasapere" data-dasapere="1" hidden></div>' +
        '<div class="dafogli" data-dafogli="1" hidden></div>' +
        '<div class="stagione" data-stagione-box="1"></div>' +
        '<textarea placeholder="Le tue curiosità: precedenti, come si pronuncia il nome, cosa dire in telecronaca…"></textarea>' +
        '<div class="piede">' +
          '<button type="button" data-f="togli" class="via">Togli dal campo</button>' +
          '<button type="button" data-f="chiudi">Chiudi</button>' +
          '<button type="button" data-f="salva" class="on">Salva</button>' +
        '</div>';
      cassa.appendChild(f);
      facciaSu(p, f.querySelector("[data-faccia]"));
      bioSu(p, f.querySelector("[data-bio]"), f.querySelector('input[data-f="nome"]'));
      dasapereSu(p, f.querySelector("[data-dasapere]"));
      dafogliSu(p, f.querySelector("[data-dafogli]"));
      stagioneSu(p, f.querySelector("[data-stagione-box]"));
      cartSu(p, f.querySelector("[data-cart-box]"));
      // la tabella della stagione arriva dopo e allunga il foglietto: lo si
      // tiene dentro il campo anche quando cresce
      if (window.ResizeObserver) {
        new ResizeObserver(function () {
          if (!f.isConnected) return;
          var rr = cassa.getBoundingClientRect(), alto2 = f.offsetHeight;
          var top = parseFloat(f.style.top) || 0;
          if (top + alto2 > rr.height - 8) f.style.top = Math.max(8, rr.height - alto2 - 8) + "px";
        }).observe(f);
      }
      // dove: accanto alla pedina, in percentuale del campo, e sempre dentro
      var largo = f.offsetWidth || 420, alto = f.offsetHeight || 300;
      var r = cassa.getBoundingClientRect();
      var px = p.x / W * r.width, py = p.y / H * r.height;
      var x = px + 44, y = py - alto / 2;
      if (x + largo > r.width - 8) x = px - 44 - largo;
      f.style.left = Math.max(8, Math.min(r.width - largo - 8, x)) + "px";
      f.style.top = Math.max(8, Math.min(r.height - alto - 8, y)) + "px";
      var ta = f.querySelector("textarea");
      ta.value = NOTE[k] || "";
      ta.focus();
      f.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      f.addEventListener("dblclick", function (ev) { ev.stopPropagation(); });
      f.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest("button[data-f]") : null;
        if (!b) return;
        if (b.dataset.f === "salva") {
          ricorda();
          var t = ta.value.trim();
          if (t) NOTE[k] = t; else delete NOTE[k];
          var iNum = f.querySelector('input[data-f="num"]'), iNome = f.querySelector('input[data-f="nome"]');
          if (iNum || iNome) {
            var num = iNum ? iNum.value.trim() : p.num, cognome = iNome ? iNome.value.trim() : p.cognome;
            // nella casella c'e' nome e cognome per intero: se non e' stato
            // toccato, il cognome (quello della pedina) resta com'era
            if (iNome && iNome.dataset.intero && cognome === iNome.dataset.intero) cognome = p.cognome;
            if (num !== p.num || cognome !== p.cognome) {
              p.num = num; p.cognome = cognome;
              ribattezza(p);
              // la rosa deve dire la stessa cosa del campo
              (SQ[p.lato].rosa || []).forEach(function (g) {
                if (String(g.pid) === String(p.pid)) { g.num = num; g.cognome = cognome; g.nome = ""; }
              });
            }
          }
          segnaNota(p); disegnaCurio(); disegnaRose();
        }
        if (b.dataset.f === "togli") { ricorda(); togli(p); disegnaRose(); disegnaCurio(); }
        chiudiNota();
      });
      f.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") chiudiNota();
        // Cmd/Ctrl+Invio salva: in telecronaca non si cercano i pulsanti
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) f.querySelector('[data-f="salva"]').click();
      });
    }
    function chiudiNota() {
      var f = box.querySelector(".foglietto");
      if (f) f.remove();
    }

    function disegnaCurio() {
      var c = box.querySelector("[data-curio]");
      var righe = PEDINE.filter(function (p) { return NOTE[chiave(p)]; });
      // anche chi e' uscito dal campo tiene la sua nota: si mostra lo stesso
      Object.keys(NOTE).forEach(function (k) {
        if (!PEDINE.some(function (p) { return chiave(p) === k; })) {
          var pezzi = k.split(":");
          var g = (SQ[pezzi[0]] && SQ[pezzi[0]].rosa || []).filter(function (x) { return String(x.pid) === pezzi[1]; })[0];
          if (g) righe.push({ lato: pezzi[0], pid: pezzi[1], num: g.num, cognome: g.cognome, fuori: true });
        }
      });
      c.innerHTML = righe.length ? righe.map(function (p) {
        return '<div><b>' + esc((p.num ? p.num + " " : "") + (p.cognome || "")) + '</b> · ' +
               esc(SQ[p.lato].nome) + (p.fuori ? " (fuori)" : "") + '<br>' + esc(NOTE[p.lato + ":" + p.pid]) + '</div>';
      }).join("") : '<span style="color:var(--lav-fg3)">Doppio clic su un giocatore per scriverci sopra.</span>';
    }

    // ── le rose, la panchina e i cambi ──────────────────────────────────
    function segnoRosa(lato, pid) {
      var c = cartDi(lato, pid);
      if (!c.gialli && !c.rosso) return "";
      return '<span class="crt ' + (c.rosso ? "r" : "g") + (c.doppio ? " dd" : "") + '"></span>';
    }
    function disegnaRose() {
      ["A", "B"].forEach(function (lato) {
        var col = box.querySelector('[data-col="' + lato + '"]');
        col.querySelector("h4 i").style.background = SQ[lato].col;
        col.querySelector('[data-nome="' + lato + '"]').textContent = SQ[lato].nome;
        var box2 = box.querySelector('[data-rosa="' + lato + '"]');
        var mis = misterDi(lato);
        var testaAll = mis ? '<button type="button" data-lato="' + lato + '" data-mister="1"' +
            (inCampo(lato, "mister") ? ' class="dentro"' : "") + '><b>ALL</b>' + esc(mis.cognome) +
            (NOTE[lato + ":mister"] ? "<em>&#9733;</em>" : "") + "</button>" : "";
        box2.innerHTML = testaAll + (SQ[lato].rosa || []).map(function (g, i) {
          var dentro = !!inCampo(lato, g.pid);
          return '<button type="button" data-lato="' + lato + '" data-i="' + i + '"' +
                 (dentro ? ' class="dentro"' : "") + '>' +
                 (g.num ? "<b>" + esc(g.num) + "</b>" : "") + esc(g.cognome || g.nome) + segnoRosa(lato, g.pid) +
                 (NOTE[lato + ":" + g.pid] ? "<em>&#9733;</em>" : "") + "</button>";
        }).join("") || '<span style="color:var(--lav-fg3);font-size:12.5px">Nessuna rosa.</span>';
      });
      var ca = box.querySelector("[data-cambi]");
      if (ca) ca.innerHTML = CAMBI.length ? CAMBI.map(function (c) {
        return '<div><span>' + esc(SQ[c.lato].nome) + '</span> &nbsp; &#8593; ' + esc(c.dentro) +
               ' &nbsp; &#8595; ' + esc(c.fuori) + '</div>';
      }).join("") : '<span>Nessun cambio.</span>';
      // chi e' scelto sul campo si vede anche nella sua rosa
      if (SCELTO) {
        var b = box.querySelector('[data-rosa="' + SCELTO.lato + '"] button[data-i]');
        (SQ[SCELTO.lato].rosa || []).forEach(function (g, i) {
          if (g.pid === SCELTO.pid) {
            var e = box.querySelector('[data-rosa="' + SCELTO.lato + '"] button[data-i="' + i + '"]');
            if (e) e.classList.add("scelto");
          }
        });
      }
    }
    box.addEventListener("click", function (ev) {
      var ct = ev.target.closest ? ev.target.closest(".conta .ct") : null;
      if (ct) {
        var lt = ct.dataset.lato, k = ct.dataset.k, meno = !!(ev.target.closest && ev.target.closest(".meno"));
        if (k === "ang") {
          if (meno && !CONTA[lt].ang) return;
          ricorda();
          CONTA[lt].ang = Math.max(0, CONTA[lt].ang + (meno ? -1 : 1));
          disegnaConta(meno ? null : [lt, k]);
          return;
        }
        if (meno) {                                   // toglie l'ultimo, con o senza nome
          CHI = null;
          ricorda();
          if (togliCart(lt, k)) disegnaConta();
          chiediFine();
          return;
        }
        // il secondo clic sullo stesso contatore: senza nome
        if (CHI && CHI.lato === lt && CHI.tipo === k) { assegna(null); return; }
        CHI = { lato: lt, tipo: k };
        disegnaConta();
        box.classList.add("chiedo-" + lt);
        PEDINE.forEach(function (q) { if (q.lato === lt && q.g) q.g.classList.add("cand"); });
        nota("<b>Chi?</b> Clicca il giocatore " + (k === "gia" ? "ammonito" : "espulso") + " — in campo, in panchina o " +
             "l'allenatore. <b>Esc</b> o di nuovo il contatore: senza nome.", "");
        return;
      }
    });
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button[data-lato]") : null;
      if (!b) return;
      var lato = b.dataset.lato;
      var g = b.dataset.mister ? misterDi(lato) : SQ[lato].rosa[+b.dataset.i];
      if (!g) return;
      if (CHI) {
        if (CHI.lato === lato) assegna(b.dataset.mister ? { pid: "mister", cognome: g.cognome, nome: g.nome } : g);
        return;
      }
      var gia = inCampo(lato, g.pid);
      // IL CAMBIO: c'e' un giocatore scelto sul campo, della stessa squadra, e
      // si clicca uno che in campo non c'e'. Entra al posto suo, e resta scritto.
      if (SCELTO && SCELTO.lato === lato && !gia) {
        ricorda();
        var fuori = SCELTO, x = fuori.x, y = fuori.y;
        CAMBI.push({ lato: lato, dentro: (g.num ? g.num + " " : "") + (g.cognome || g.nome),
                     fuori: (fuori.num ? fuori.num + " " : "") + fuori.cognome });
        togli(fuori);
        metti(lato, g, x, y);
        SCELTO = null; evidenzia(); disegnaRose(); disegnaCurio();
        nota("Cambio segnato: <b>" + esc(g.cognome || g.nome) + "</b> per <b>" + esc(fuori.cognome) + "</b>.", "ok");
        return;
      }
      if (gia) { ricorda(); togli(gia); disegnaRose(); disegnaCurio(); return; }
      ricorda();
      var n = PEDINE.filter(function (p) { return p.lato === lato; }).length;
      var x2 = lato === "A" ? 180 + (n % 4) * 60 : W - 180 - (n % 4) * 60;
      metti(lato, g, x2, 120 + Math.floor(n / 4) * 80);
      disegnaRose();
    });

    // ── schiera ─────────────────────────────────────────────────────────
    // l'allenatore, se la squadra ce l'ha: una pedina come le altre, con un
    // suo nome finto (serve solo a riconoscerla fra le note)
    function misterDi(lato) {
      var a = SQ[lato].all;
      if (!a || !(a.cognome || a.nome)) return null;
      return { pid: "mister", num: "", nome: a.nome || "", cognome: a.cognome || a.nome, mister: true };
    }
    function ordinaPerRuolo(r) {
      var peso = { G: 0, GK: 0, P: 0, D: 1, CB: 1, LB: 1, RB: 1, M: 2, C: 2, CM: 2, DM: 2, AM: 2, LM: 2, RM: 2,
                   F: 3, A: 3, CF: 3, LW: 3, RW: 3, ST: 3 };
      return r.slice().sort(function (a, b) {
        var pa = peso[String(a.ruolo || "").toUpperCase()], pb = peso[String(b.ruolo || "").toUpperCase()];
        if (pa === undefined) pa = 2;
        if (pb === undefined) pb = 2;
        return pa - pb || (parseInt(a.num, 10) || 99) - (parseInt(b.num, 10) || 99);
      });
    }
    function schiera() {
      ricorda();
      ["A", "B"].forEach(function (lato) {
        var s = SQ[lato];
        var lista = (s.titolari && s.titolari.length) ? s.titolari : ordinaPerRuolo(s.rosa || []).slice(0, 11);
        if (!lista.length) return;
        var mod = MODULI[s.mod] || MODULI["4-3-3"];
        PEDINE.filter(function (p) { return p.lato === lato; }).forEach(togli);
        lista.slice(0, 11).forEach(function (g, i) {
          var q = mod[i] || [.5, .5];
          var x = lato === "A" ? q[0] * (W / 2) : W - q[0] * (W / 2);
          metti(lato, g, x, 60 + q[1] * (H - 120));
        });
        // l'allenatore in panchina: fuori dal campo, sulla sua meta'
        var mis = misterDi(lato);
        // non attaccato al bordo: sotto la pedina ci va il cognome
        if (mis) metti(lato, mis, lato === "A" ? 150 : W - 150, H - 78);
      });
      disegnaRose(); disegnaCurio();
      nota("Schierate. Clicca un giocatore per sceglierlo (poi uno dalla panchina per il cambio), " +
           "doppio clic per le curiosità.", "ok");
    }

    // ── immagine e stampa ───────────────────────────────────────────────
    function immagine(poi) {
      var copia = svg.cloneNode(true);
      copia.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copia.setAttribute("width", W); copia.setAttribute("height", H);
      var blob = new Blob([new XMLSerializer().serializeToString(copia)], { type: "image/svg+xml;charset=utf-8" });
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var c = document.createElement("canvas"); c.width = W; c.height = H;
        c.getContext("2d").drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        poi(c.toDataURL("image/png"));
      };
      img.onerror = function () { URL.revokeObjectURL(url); nota("Immagine non riuscita.", "err"); };
      img.src = url;
    }
    function titolo() { return (SQ.A.nome || "Casa") + " - " + (SQ.B.nome || "Ospite"); }
    function stampa() {
      immagine(function (dati) {
        var w = window.open("", "_blank");
        if (!w) { nota("Il browser ha bloccato la finestra di stampa.", "err"); return; }
        var note = Object.keys(NOTE).map(function (k) {
          var pezzi = k.split(":");
          var g = (SQ[pezzi[0]].rosa || []).filter(function (x) { return String(x.pid) === pezzi[1]; })[0] ||
                  PEDINE.filter(function (p) { return chiave(p) === k; })[0];
          var nome = g ? ((g.num ? g.num + " " : "") + (g.cognome || g.nome || "")) : k;
          return "<div><b>" + esc(nome) + "</b> · " + esc(SQ[pezzi[0]].nome) + " — " + esc(NOTE[k]) + "</div>";
        }).join("");
        var cambi = CAMBI.map(function (c) {
          return "<div>" + esc(SQ[c.lato].nome) + ": &#8593; " + esc(c.dentro) + " &#8595; " + esc(c.fuori) + "</div>";
        }).join("");
        w.document.write('<title>' + esc(titolo()) + '</title>' +
          '<style>@page{size:A4 landscape;margin:8mm}body{margin:0;font-family:system-ui,sans-serif;color:#14161C}' +
          'h1{font-size:16pt;margin:0 0 4mm}img{width:100%;border-radius:3mm}' +
          '.b{display:flex;gap:6mm;margin-top:4mm;font-size:9.5pt;line-height:1.5}' +
          '.b > div{flex:1}.b h2{font-size:10pt;margin-bottom:2mm}</style>' +
          '<h1>' + esc(titolo()) + '</h1><img src="' + dati + '" onload="window.print()">' +
          '<div class="b"><div><h2>Cambi</h2>' + (cambi || "—") + '</div>' +
          '<div><h2>Curiosità</h2>' + (note || "—") + '</div></div>');
        w.document.close();
      });
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest("button[data-az]") : null;
      if (!b) return;
      if (b.dataset.az === "schiera") schiera();
      if (b.dataset.az === "indietro") annulla();
      if (b.dataset.az === "pulisci") { ricorda(); gDis.innerHTML = ""; }
      if (b.dataset.az === "stampa") stampa();
      if (b.dataset.az === "tema") tema(!box.classList.contains("chiara"), true);
      if (b.dataset.az === "foglio") { var fb = box.querySelector("[data-fogliobox]"); if (fb.hidden) apriFoglio(); else fb.hidden = true; }
      if (b.dataset.az === "png") immagine(function (dati) {
        var a = document.createElement("a");
        a.href = dati; a.download = titolo().replace(/[^A-Za-z0-9-]+/g, "-") + ".png";
        document.body.appendChild(a); a.click(); a.remove();
      });
    });

    // ── quello che entra e quello che esce ──────────────────────────────
    // Le giovanili, i tornei e le amichevoli su ESPN non esistono: niente
    // rosa, e la lavagna resterebbe un campo vuoto. Allora le pedine se le
    // fa da sola - undici numerate piu' una panchina - e il giornalista ci
    // scrive sopra i nomi mentre le squadre scaldano.
    function rosaInBianco(lato, quanti) {
      var v = [];
      for (var n = 1; n <= (quanti || 18); n++) {
        v.push({ pid: "b" + lato + n, num: String(n), cognome: "", nome: "", bianca: true });
      }
      return v;
    }
    function carica(d) {
      var prima = SQ.A.nome + "|" + SQ.B.nome + "|" + (SQ.A.tid || "") + "|" + (SQ.B.tid || "");
      ["A", "B"].forEach(function (lato) {
        var s = d && d[lato];
        if (!s) return;
        var rosa = (s.rosa || []).slice(), titolari = (s.titolari || []).slice();
        // niente rosa (giovanili, tornei, amichevoli): undici numerate e via.
        // Formazione scritta a mano ma incompleta: si completa fino a undici,
        // cosi' il campo e' sempre tutto e i nomi gia' scritti restano.
        if (titolari.length < 11) {
          var usati = {};
          rosa.concat(titolari).forEach(function (g) { usati[String(g.num || "")] = 1; });
          var n = 1;
          while (titolari.length < 11) {
            while (usati[String(n)] && n < 40) n++;
            usati[String(n)] = 1;
            var vuoto = { pid: "b" + lato + n, num: String(n), cognome: "", nome: "", bianca: true };
            titolari.push(vuoto); rosa.push(vuoto); n++;
          }
        }
        if (rosa.length < titolari.length + 7) {
          var dentro = {};
          rosa.forEach(function (g) { dentro[String(g.num || "")] = 1; });
          var m = 12;
          while (rosa.length < titolari.length + 7) {
            while (dentro[String(m)] && m < 60) m++;
            dentro[String(m)] = 1;
            rosa.push({ pid: "b" + lato + m, num: String(m), cognome: "", nome: "", bianca: true });
            m++;
          }
        }
        var stessa = (s.nome || SQ[lato].nome) === SQ[lato].nome;
        SQ[lato] = { nome: s.nome || SQ[lato].nome, col: s.col || SQ[lato].col,
                     rosa: rosa, titolari: titolari, mod: s.mod || SQ[lato].mod,
                     all: s.all || null, tid: String(s.tid || ""),
                     // la divisa scelta nelle Formazioni; se no quella di prima
                     // (stessa squadra) o si sceglie da sola
                     dove: s.dove !== undefined ? s.dove : (stessa ? SQ[lato].dove : undefined),
                     mgFisso: s.mg || "", mg: s.mg || (stessa ? SQ[lato].mg : "") };
        // presenze e gol della stagione: si cominciano a contare subito, cosi'
        // al doppio clic sul giocatore sono gia' pronti
        if (SQ[lato].tid) conStagione(function () { StagioneEspn.squadra(SQ[lato].tid); });
      });
      PEDINE.slice().forEach(togli);
      CAMBI = [];
      if (prima !== SQ.A.nome + "|" + SQ.B.nome + "|" + (SQ.A.tid || "") + "|" + (SQ.B.tid || "")) {
        CONTA = { A: { ang: 0, gia: 0, ros: 0 }, B: { ang: 0, gia: 0, ros: 0 } };
        CART = []; CHI = null;
        disegnaConta();
      }
      disegnaRose(); disegnaCurio();
      if (d && d.schiera !== false) schiera();
      vesti();
      tastoFoglio();
    }
    function stato() {
      return { sq: { A: SQ.A, B: SQ.B }, note: NOTE, cambi: CAMBI, disegni: gDis.innerHTML,
               conta: JSON.parse(JSON.stringify(CONTA)), cart: JSON.parse(JSON.stringify(CART)),
               pedine: PEDINE.map(function (p) { return { lato: p.lato, pid: p.pid, num: p.num, cognome: p.cognome,
                                                          mister: !!p.mister, x: p.x, y: p.y }; }) };
    }
    function riapri(s) {
      if (!s) return;
      if (s.sq) { SQ.A = s.sq.A || SQ.A; SQ.B = s.sq.B || SQ.B; }
      NOTE = s.note || {}; CAMBI = s.cambi || [];
      CONTA = s.conta || { A: { ang: 0, gia: 0, ros: 0 }, B: { ang: 0, gia: 0, ros: 0 } };
      CART = s.cart || []; CHI = null;
      disegnaConta();
      PEDINE.slice().forEach(togli);
      (s.pedine || []).forEach(function (p) { PEDINE.push(pedina(p)); });
      gDis.innerHTML = s.disegni || "";
      disegnaRose(); disegnaCurio();
      vesti(); tastoFoglio();
    }

    // ── LA DIRETTA ──────────────────────────────────────────────────────
    // ESPN non pubblica il tracciamento dei giocatori: nessuno lo fa
    // gratis. Pubblica pero' ogni GIOCATA con le sue coordinate — passaggi,
    // contrasti, tiri — e da li' si ricava dove sta il pallone e chi lo sta
    // toccando. Il campetto quindi si muove davvero, col ritardo di ESPN
    // (circa un minuto) e a scatti di giocata, non a 25 fotogrammi.
    //
    // Le coordinate sono girate per chi attacca (x 100 = porta avversaria,
    // y 100 = la sua sinistra): qui si rimettono sul campo vero, dove la
    // squadra di casa attacca verso destra.
    var DIR = null, gPalla = null;
    function pallaEl() {
      if (gPalla && gPalla.parentNode) return gPalla;
      gPalla = ns("g", { "class": "palla", style: "transition:transform .45s cubic-bezier(.3,.8,.4,1)" }, gPedine);
      ns("circle", { cx: 0, cy: 0, r: 15, fill: "#F5F1E6", stroke: "#06301A", "stroke-width": 3 }, gPalla);
      ns("circle", { cx: 0, cy: 0, r: 5.5, fill: "#0A0F24" }, gPalla);
      return gPalla;
    }
    function postoDi(x, y, casa) {
      // casa attacca verso destra; l'ospite ha tutto specchiato
      var X = casa ? x / 100 * W : (1 - x / 100) * W;
      var Y = casa ? (1 - y / 100) * H : y / 100 * H;
      return { x: Math.max(12, Math.min(W - 12, X)), y: Math.max(12, Math.min(H - 12, Y)) };
    }
    function accendi(idAtleta) {
      PEDINE.forEach(function (p) {
        var c = p.g.querySelector(".disco");
        if (!c) return;
        var mio = idAtleta && String(p.pid) === String(idAtleta);
        c.setAttribute("stroke", mio ? "#F5B91E" : (p === SCELTO ? "#E3C271" : (p.mister ? "#E3C271" : bordo(p))));
        c.setAttribute("stroke-width", mio ? 7 : (p === SCELTO ? 6 : 3));
      });
    }
    function striscia(t) {
      var d = box.querySelector("[data-diretta]");
      if (!t) { d.style.display = "none"; d.innerHTML = ""; return; }
      d.style.display = "flex";
      d.innerHTML = t;
    }
    function giocateDi(lega, ev) {
      var base = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/" + lega +
                 "/events/" + ev + "/competitions/" + ev + "/plays?limit=1000";
      // tutte le pagine: i cartellini del primo tempo stanno nella prima
      return fetch(base).then(function (r) { return r.json(); }).then(function (j) {
        var pag = [];
        for (var n = 2; n <= (j.pageCount || 1); n++) {
          pag.push(fetch(base + "&page=" + n).then(function (r) { return r.json(); })
            .then(function (k) { return k.items || []; }));
        }
        return Promise.all(pag).then(function (resto) {
          return resto.reduce(function (a, b) { return a.concat(b); }, j.items || []);
        });
      });
    }
    function seguiPartita(opz) {
      fermaPartita();
      DIR = { lega: opz.lega, ev: opz.event, casa: opz.casa || "", visti: {}, coda: [], vistiEventi: {}, vistiCart: {} };
      striscia('<b>Diretta</b> <span class="azione">mi collego…</span>');
      giro();
      DIR.timer = setInterval(giro, 15000);
      // le giocate in coda si consumano piano, cosi' il pallone si muove
      DIR.passo = setInterval(function () {
        if (!DIR || !DIR.coda.length) return;
        var g = DIR.coda.shift();
        var q = postoDi(g.x, g.y, g.casa);
        pallaEl().style.transform = "translate(" + Math.round(q.x) + "px," + Math.round(q.y) + "px)";
        accendi(g.atleta);
        striscia('<b>Diretta</b> <span class="punteggio">' + esc(DIR.punteggio || "") + '</span>' +
                 '<span>' + esc(DIR.minuto || "") + "</span>" +
                 '<span class="azione">' + esc(g.testo || "") + "</span>" +
                 '<button type="button" data-az="fermaDiretta">Stacca</button>');
      }, 900);
    }
    function fermaPartita() {
      if (!DIR) return;
      clearInterval(DIR.timer); clearInterval(DIR.passo);
      DIR = null; striscia("");
      accendi(null);
      if (gPalla && gPalla.parentNode) { gPalla.parentNode.removeChild(gPalla); gPalla = null; }
    }
    function giro() {
      if (!DIR) return;
      var D = DIR;
      fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + D.lega + "/summary?event=" + D.ev)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (DIR !== D) return;
          var c = ((j.header || {}).competitions || [])[0] || {};
          var chi = c.competitors || [];
          var casa = chi.filter(function (x) { return x.homeAway === "home"; })[0] || {};
          var osp = chi.filter(function (x) { return x.homeAway === "away"; })[0] || {};
          D.casaId = String((casa.team || {}).id || "");
          D.punteggio = ((casa.team || {}).shortDisplayName || "") + " " + (casa.score || 0) + " - " +
                        (osp.score || 0) + " " + ((osp.team || {}).shortDisplayName || "");
          D.minuto = ((c.status || {}).type || {}).detail || "";
          // I calci d'angolo li conta anche ESPN: il contatore si
          // allinea da solo, ma solo in salita - ESPN arriva in ritardo, e un
          // conto fatto a mano piu' avanti non va abbassato.
          var su = false;
          ((j.boxscore || {}).teams || []).forEach(function (t) {
            var lato = String((t.team || {}).id || "") === D.casaId ? "A" : "B", m = {};
            (t.statistics || []).forEach(function (x) { m[x.name] = parseInt(x.displayValue, 10) || 0; });
            if ((m.wonCorners || 0) > CONTA[lato].ang) { CONTA[lato].ang = m.wonCorners; su = true; }
          });
          if (su) disegnaConta();
          // i cambi di ESPN diventano i nostri, una volta sola ciascuno
          (j.keyEvents || []).forEach(function (e) {
            var k = e.id || ((e.clock || {}).displayValue + (e.type || {}).text + ((e.athletesInvolved || [])[0] || {}).id);
            if (D.vistiEventi[k]) return;
            D.vistiEventi[k] = 1;
            if (!/substitution/i.test((e.type || {}).text || "")) return;
            var lato = String(((e.team || {}).id || "")) === D.casaId ? "A" : "B";
            var dentro = (e.athletesInvolved || [])[0], fuori = (e.athletesInvolved || [])[1];
            if (!dentro || !fuori) return;
            var p = inCampo(lato, String(fuori.id));
            var g = { pid: String(dentro.id), num: dentro.jersey || "", nome: "",
                      cognome: (dentro.displayName || "").split(" ").pop() };
            CAMBI.push({ lato: lato, dentro: (g.num ? g.num + " " : "") + g.cognome,
                         fuori: (fuori.jersey ? fuori.jersey + " " : "") + (fuori.displayName || "").split(" ").pop() });
            if (p) { var x = p.x, y = p.y; togli(p); metti(lato, g, x, y); }
            disegnaRose(); disegnaCurio();
          });
        })
        .catch(function () {});
      giocateDi(D.lega, D.ev).then(function (tutte) {
        if (DIR !== D) return;
        // I CARTELLINI li prendo dalle azioni: li' c'e' il giocatore (nei
        // keyEvents del riassunto no). Uno gia' messo a mano non si
        // raddoppia: se era suo si conferma, se era senza nome lo prende.
        var su = false;
        tutte.forEach(function (g) {
          var tc = /red card/i.test((g.type || {}).text || "") ? "ros"
                 : /yellow card/i.test((g.type || {}).text || "") ? "gia" : "";
          // senza la squadra di casa (il riassunto non e' ancora arrivato) si aspetta il giro dopo
          if (!tc || !g.id || !D.casaId || D.vistiCart[g.id]) return;
          D.vistiCart[g.id] = 1;
          var sq = ((g.team || {}).$ref || "").match(/teams\/(\d+)/);
          var at = ((((g.participants || [])[0] || {}).athlete || {}).$ref || "").match(/athletes\/(\d+)/);
          var lato = sq && sq[1] === D.casaId ? "A" : "B", pid = at ? at[1] : null, k = "p" + g.id;
          var mio = CART.filter(function (x) { return x.lato === lato && x.tipo === tc && !x.k && pid != null && String(x.pid) === pid; })[0] ||
                    CART.filter(function (x) { return x.lato === lato && x.tipo === tc && !x.k && x.pid == null; })[0];
          if (mio) { mio.k = k; if (mio.pid == null) mio.pid = pid; }
          // il rosso del secondo giallo l'ha gia' messo nuovoCart
          else if (!(tc === "ros" && pid != null && cartDi(lato, pid).doppio)) nuovoCart(lato, pid, tc, k);
          su = true;
        });
        if (su) { disegnaConta(); disegnaRose(); }
        var nuove = tutte.filter(function (g) {
          return g.id && !D.visti[g.id] && g.fieldPositionX != null && g.fieldPositionY != null;
        });
        nuove.forEach(function (g) { D.visti[g.id] = 1; });
        // al primo giro si parte dall'ultima, non da tutta la partita
        if (!D.partito) { D.partito = 1; nuove = nuove.slice(-1); }
        nuove.forEach(function (g) {
          var idSq = ((g.team || {}).$ref || "").match(/teams\/(\d+)/);
          var atl = ((((g.participants || [])[0] || {}).athlete || {}).$ref || "").match(/athletes\/(\d+)/);
          D.coda.push({ x: g.fieldPositionX, y: g.fieldPositionY,
                        casa: idSq ? idSq[1] === D.casaId : true,
                        atleta: atl ? atl[1] : "",
                        testo: ((g.clock || {}).displayValue || "") + " · " + (g.text || (g.type || {}).text || "") });
        });
        if (D.coda.length > 40) D.coda = D.coda.slice(-40);
      }).catch(function () {});
    }
    box.addEventListener("click", function (ev) {
      var b = ev.target.closest ? ev.target.closest('[data-az="fermaDiretta"]') : null;
      if (b) fermaPartita();
    });

    // ── scegliere la partita da seguire ─────────────────────────────────
    var selC = box.querySelector('[data-d="comp"]'), selP = box.querySelector('[data-d="part"]');
    function dnota(t) { var n = box.querySelector("[data-dnota]"); if (n) n.innerHTML = t; }
    if (selC) {
      if (window.CompetizioniEspn) CompetizioniEspn.riempi(selC);
      selC.addEventListener("change", function () {
        selP.innerHTML = '<option value="">—</option>'; selP.disabled = true;
        box.querySelector('[data-az="segui"]').disabled = true;
        if (!this.value) return;
        var d = new Date();
        var g = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
        dnota("Cerco le partite di oggi&hellip;");
        fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + this.value + "/scoreboard?dates=" + g)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var ev = (j.events || []).map(function (e) {
              var st = ((e.competitions[0] || {}).status || {}).type || {};
              return { id: e.id, nome: e.name, stato: st.detail || "", viva: st.state === "in" };
            });
            selP.innerHTML = ev.length
              ? '<option value="">— ' + ev.length + " oggi —</option>" + ev.map(function (x) {
                  return '<option value="' + esc(x.id) + '">' + (x.viva ? "\u25CF " : "") + esc(x.nome) + " · " + esc(x.stato) + "</option>";
                }).join("")
              : '<option value="">— oggi niente —</option>';
            selP.disabled = !ev.length;
            dnota(ev.length ? "Scegli la partita e premi <b>Segui</b>." : "Oggi in questa competizione non si gioca.");
          })
          .catch(function () { dnota("ESPN non risponde."); });
      });
      selP.addEventListener("change", function () {
        box.querySelector('[data-az="segui"]').disabled = !this.value;
      });
      box.addEventListener("click", function (ev) {
        var b = ev.target.closest ? ev.target.closest('[data-az="segui"]') : null;
        if (!b) return;
        var lega = selC.value, id = selP.value;
        if (!lega || !id) return;
        dnota("Prendo le formazioni&hellip;");
        fetch("https://site.api.espn.com/apis/site/v2/sports/soccer/" + lega + "/summary?event=" + id)
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var c = ((j.header || {}).competitions || [])[0] || {}, chi = c.competitors || [];
            var casa = chi.filter(function (x) { return x.homeAway === "home"; })[0] || {};
            var osp = chi.filter(function (x) { return x.homeAway === "away"; })[0] || {};
            function undici(idSq) {
              var r = (j.rosters || []).filter(function (x) { return String((x.team || {}).id) === String(idSq); })[0];
              return ((r || {}).roster || []).map(function (x) {
                var a = x.athlete || {};
                return { pid: String(a.id), num: x.jersey || a.jersey || "", nome: "",
                         cognome: (a.displayName || "").split(" ").pop(), titolare: !!x.starter };
              });
            }
            var rA = undici((casa.team || {}).id), rB = undici((osp.team || {}).id);
            // i colori delle due squadre li dice ESPN: se sono troppo simili
            // (due squadre in blu) al secondo si da' il suo colore di riserva
            function tinta(t, dif) {
              var c = "#" + String((t || {}).color || "").replace("#", "");
              if (c.length !== 7) c = dif;
              return c;
            }
            var cA = tinta(casa.team, "#2E6BE6"), cB = tinta(osp.team, "#E0312B");
            if (cA.toLowerCase() === cB.toLowerCase()) cB = "#" + (String((osp.team || {}).alternateColor || "").replace("#", "") || "E0312B");
            if (rA.length || rB.length) {
              ricorda();
              carica({
                A: { nome: (casa.team || {}).displayName || "Casa", col: cA, rosa: rA, tid: (casa.team || {}).id,
                     titolari: rA.filter(function (x) { return x.titolare; }), mod: SQ.A.mod, all: SQ.A.all },
                B: { nome: (osp.team || {}).displayName || "Ospite", col: cB, rosa: rB, tid: (osp.team || {}).id,
                     titolari: rB.filter(function (x) { return x.titolare; }), mod: SQ.B.mod, all: SQ.B.all }
              });
            }
            seguiPartita({ lega: lega, event: id });
            dnota("In diretta. <b>Stacca</b> per fermare.");
          })
          .catch(function () { dnota("Partita non caricata."); });
      });
    }

    // Cmd/Ctrl+Z ovunque nella pagina, ma non mentre si scrive una
    // curiosita': li' l'annullamento e' quello del testo.
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && CHI && box.isConnected) { assegna(null); return; }
      if (!(ev.metaKey || ev.ctrlKey) || String(ev.key).toLowerCase() !== "z") return;
      if (!box.isConnected || !box.offsetParent) return;
      var t = ev.target, tag = t && t.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || (t && t.isContentEditable)) return;
      ev.preventDefault();
      if (ev.shiftKey) rifai(); else annulla();
    });

    // la maglia e il colore delle pedine, dalla testata della rosa
    box.addEventListener("change", function (ev) {
      var t = ev.target;
      if (t.dataset && t.dataset.maglia) {
        var S = SQ[t.dataset.maglia];
        ricorda();
        S.dove = t.value; S.mgFisso = "";
        vesti();
        return;
      }
      if (t.dataset && t.dataset.colsq) {
        var S2 = SQ[t.dataset.colsq];
        ricorda();
        S2.col = t.value;
        // chi sceglie un colore vuole il pallino, non la divisa
        S2.dove = ""; S2.mg = ""; S2.mgFisso = "";
        disegnaRose(); disegnaMaglie(); rivesti();
      }
    });
    disegnaRose(); disegnaCurio(); disegnaConta();
    return { carica: carica, stato: stato, riapri: riapri, schiera: schiera, nota: nota,
             annulla: annulla, rifai: rifai, segui: seguiPartita, stacca: fermaPartita,
             barraSalva: box.querySelector("[data-salva]"), moduli: Object.keys(MODULI) };
  }

  return { monta: monta, moduli: Object.keys(MODULI) };
})();
