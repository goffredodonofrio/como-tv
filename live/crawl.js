/**
 * ═══════════════════════════════════════════════════════════════════
 *  CRAWL — il compositore della riga che scorre, dai dati ESPN
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Lo usano il Ticker orizzontale e la Barra verticale: una sola
 *  logica, così una correzione vale per entrambi (prima erano due
 *  copie destinate a divergere).
 *
 *  Uso:
 *      Crawl.monta(document.getElementById("crawlbox"));
 *      ... poi al momento dell'invio:  Crawl.testo()
 *
 *  Formato del testo prodotto:
 *      "ETICHETTA · voce · voce |||| ETICHETTA · voce · voce"
 *  "||||" separa i blocchi, "·" le voci. La prima voce di ogni blocco
 *  è l'etichetta che i motori scrivono in oro.
 */
window.Crawl = (function () {
  "use strict";

  var COMPS = [
    {b:"🇮🇹",n:"Serie A",code:"ita.1"},{b:"🇮🇹",n:"Serie B",code:"ita.2"},
    {b:"🇮🇹",n:"Primavera 1",code:"giovanili.primavera1"},{b:"🇮🇹",n:"Under 17",code:"giovanili.u17"},
    {b:"🇮🇹",n:"Under 18",code:"giovanili.u18"},{b:"🇸🇦",n:"Saudi Pro League",code:"ksa.1"},
    {b:"🇦🇷",n:"LPF Argentina",code:"arg.1"},{b:"🇦🇷",n:"Nacional B Argentina",code:"arg.2"},
    {b:"🇦🇹",n:"Bundesliga Austria",code:"aut.1"},{b:"🇧🇷",n:"Brasileirão",code:"bra.1"},
    {b:"🇫🇷",n:"Ligue 1",code:"fra.1"},{b:"🇫🇷",n:"Ligue 2",code:"fra.2"},
    {b:"🇩🇪",n:"Bundesliga",code:"ger.1"},{b:"🇩🇪",n:"2. Bundesliga",code:"ger.2"},
    {b:"🏴",n:"EFL Championship",code:"eng.2"},{b:"🏴",n:"Premier League",code:"eng.1"},
    {b:"🏴",n:"League One",code:"eng.3"},{b:"🏴",n:"League Two",code:"eng.4"},
    {b:"🇳🇱",n:"Eredivisie",code:"ned.1"},{b:"🇳🇱",n:"Eerste Divisie",code:"ned.2"},
    {b:"🇵🇹",n:"Primeira Liga",code:"por.1"},{b:"🏴",n:"Scottish Premiership",code:"sco.1"},
    {b:"🏴",n:"Scottish Championship",code:"sco.2"},{b:"🏴",n:"Premier Sports Cup",code:"sco.cis"},
    {b:"🇪🇸",n:"LaLiga",code:"esp.1"},{b:"🇪🇺",n:"Champions League",code:"uefa.champions"},
    {b:"🇪🇺",n:"Europa League",code:"uefa.europa"},{b:"🇪🇺",n:"Conference League",code:"uefa.europa.conf"},
    {b:"🌎",n:"CONMEBOL Libertadores",code:"conmebol.libertadores"},{b:"🌎",n:"CONMEBOL Sudamericana",code:"conmebol.sudamericana"}
  ];

  // i nomi come li scrive la redazione, non come li scrive ESPN
  var NOMI = {
    "inter milan":"Inter","internazionale":"Inter",
    "as roma":"Roma","ac milan":"Milan","hellas verona":"Verona",
    "rb leipzig":"Lipsia","leipzig":"Lipsia",
    "bayern munich":"Bayern","bayern münchen":"Bayern","borussia dortmund":"Dortmund",
    "bayer leverkusen":"Leverkusen","borussia mönchengladbach":"M'gladbach","eintracht frankfurt":"Francoforte",
    "paris saint-germain":"PSG","paris sg":"PSG","olympique de marseille":"Marsiglia","olympique lyonnais":"Lione",
    "manchester city":"Man City","manchester united":"Man Utd","tottenham hotspur":"Tottenham",
    "newcastle united":"Newcastle","nottingham forest":"Nottingham","wolverhampton wanderers":"Wolverhampton",
    "atlético madrid":"Atlético","atletico madrid":"Atlético","real madrid":"Real Madrid","real sociedad":"Real Sociedad",
    "athletic club":"Athletic","fc barcelona":"Barcellona","barcelona":"Barcellona","sevilla":"Siviglia",
    "aek athens":"AEK Atene","psv eindhoven":"PSV","sporting cp":"Sporting","fc porto":"Porto","sl benfica":"Benfica",
    "club brugge":"Bruges","celtic":"Celtic","rangers":"Rangers",
    "rapid vienna":"Rapid","sk rapid":"Rapid","rb salzburg":"Salzburg","red bull salzburg":"Salzburg","salzburg":"Salzburg",
    "lask linz":"LASK","sturm graz":"Sturm","austria vienna":"Austria Vienna","wolfsberger ac":"Wolfsberg"
  };
  function nomeSquadra(t){
    if(!t) return "";
    var cand=[t.shortDisplayName,t.displayName,t.name];
    for(var i=0;i<cand.length;i++){ var k=(cand[i]||"").toLowerCase().trim(); if(NOMI[k]) return NOMI[k]; }
    return t.shortDisplayName||t.abbreviation||t.displayName||t.name||"";
  }

  var anno = (function(){ var d=new Date(); return d.getMonth()>=6 ? d.getFullYear() : d.getFullYear()-1; })();
  var TIPO_NOME = {cls:"Classifica", ris:"Risultati", pro:"Prossime", mar:"Marcatori"};
  var DEFLABEL  = {cls:"CLASSIFICA", ris:"RISULTATI", pro:"PROSSIME", mar:"MARCATORI"};

  var voci = [{ci:0, tipo:"cls", et:""}];   // di partenza: Serie A · Classifica
  var ULTIMI = null;                        // dati ESPN in cache
  var crawlText = "";
  var box = null, quandoCambia = null;

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
  function el(id){ return box.querySelector("#"+id); }
  function autoHdr(v){ var c=COMPS[v.ci]||COMPS[0]; return DEFLABEL[v.tipo]+" "+c.n.toUpperCase(); }
  function hdrVoce(v){ var e=(v.et||"").trim();
    return e ? e.toUpperCase().replace(/[·|]/g," ").replace(/\s+/g," ").trim() : autoHdr(v); }

  function stile(){
    if (document.getElementById("crawl-stile")) return;
    var s=document.createElement("style"); s.id="crawl-stile";
    s.textContent =
      ".cr-barra{display:flex;gap:9px;align-items:flex-end;flex-wrap:wrap;margin-bottom:12px;}" +
      ".cr-campo{display:flex;flex-direction:column;gap:5px;}" +
      ".cr-campo label{font-family:'Mazzard',sans-serif;font-size:10px;font-weight:700;letter-spacing:.18em;" +
      "  text-transform:uppercase;color:#C9A24B;}" +
      ".cr-barra select{padding:9px 12px;border-radius:6px;background:rgba(16,22,48,.66);" +
      "  border:1px solid rgba(245,241,230,.08);color:#F5F1E6;font-family:'DM Sans',sans-serif;font-size:14px;}" +
      ".cr-barra button{font-family:'Mazzard',sans-serif;font-size:10px;font-weight:700;letter-spacing:.09em;" +
      "  text-transform:uppercase;padding:9px 13px;border-radius:6px;cursor:pointer;" +
      "  background:transparent;color:#D8D2C2;border:1px solid rgba(245,241,230,.08);}" +
      ".cr-barra button:hover{color:#E3C271;border-color:rgba(201,162,75,.4);}" +
      ".crvoci{display:flex;flex-direction:column;gap:7px;margin-bottom:12px;}" +
      ".crvoce{display:flex;align-items:center;gap:10px;background:rgba(16,22,48,.66);" +
      "  border:1px solid rgba(245,241,230,.08);border-radius:8px;padding:8px 10px;font-size:13px;}" +
      ".crvoce .cv-comp{font-weight:600;color:#F5F1E6;}" +
      ".crvoce .cv-tipo{color:#E3C271;font-family:'Mazzard',sans-serif;font-weight:700;font-size:11px;" +
      "  letter-spacing:.08em;text-transform:uppercase;background:rgba(201,162,75,.12);border-radius:5px;padding:3px 8px;}" +
      ".crvoce .cv-et{flex:1;min-width:120px;background:#0A0F24;border:1px solid rgba(245,241,230,.08);border-radius:6px;" +
      "  color:#E3C271;font-family:'Mazzard',sans-serif;font-weight:700;font-size:12px;letter-spacing:.05em;" +
      "  text-transform:uppercase;padding:6px 9px;}" +
      ".crvoce .cv-et:focus{outline:none;border-color:#C9A24B;}" +
      ".crvoce .cv-et::placeholder{color:#8A8B96;text-transform:uppercase;font-weight:600;opacity:.7;}" +
      ".crvoce .cv-n{flex:none;text-align:right;color:#8A8B96;font-size:11.5px;white-space:nowrap;}" +
      ".crvoce .cv-rm{flex:none;background:transparent;border:1px solid rgba(229,27,32,.4);color:#FF9A9C;" +
      "  padding:5px 8px;font-size:12px;border-radius:6px;cursor:pointer;}" +
      ".crvuoto{color:#8A8B96;font-size:12.5px;padding:6px 2px;}" +
      "#crawlprev{background:rgba(10,15,36,.7);border:1px solid rgba(245,241,230,.08);border-radius:8px;" +
      "  padding:12px 14px;font-size:13.5px;color:#EDE8DB;overflow:hidden;white-space:nowrap;" +
      "  text-overflow:ellipsis;}" +
      "#crawlprev .sep{color:#C9A24B;font-weight:800;padding:0 6px;}" +
      "#crawlnote{margin-top:7px;font-size:12px;color:#8A8B96;}";
    document.head.appendChild(s);
  }

  function pintaPrev(){
    var h = crawlText.split("||||").map(function(b){
      return b.split("·").map(function(v,i){ return (i?'<span class="sep">•</span>':'')+esc(v.trim()); }).join("");
    }).join('<span class="sep">•</span>');
    el("crawlprev").innerHTML = h || "—";
  }

  function renderVoci(){
    var c=el("crVoci");
    if(!voci.length){ c.innerHTML='<div class="crvuoto">Nessuna voce: aggiungine una qui sopra.</div>'; return; }
    c.innerHTML = voci.map(function(v,i){ var comp=COMPS[v.ci]||COMPS[0];
      return '<div class="crvoce"><span class="cv-comp">'+esc((comp.b?comp.b+" ":"")+comp.n)+'</span>'+
        '<span class="cv-tipo">'+esc(TIPO_NOME[v.tipo]||v.tipo)+'</span>'+
        '<input class="cv-et" type="text" data-i="'+i+'" value="'+esc(v.et||"")+'" placeholder="'+esc(autoHdr(v))+'" title="Titolo in oro nel crawl — vuoto = automatico" maxlength="42">'+
        '<span class="cv-n" id="cvn-'+i+'"></span>'+
        '<button class="cv-rm" type="button" data-i="'+i+'" title="Togli">&times;</button></div>';
    }).join("");
  }

  // il blocco di UNA voce → Promise di {data:[…], n} oppure null
  function bloccoVoce(v){
    var c=COMPS[v.ci]||COMPS[0], base="https://site.api.espn.com/apis/site/v2/sports/soccer/"+c.code;
    function J(u){ return fetch(u).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}); }
    if(v.tipo==="cls"){
      return J("https://site.api.espn.com/apis/v2/sports/soccer/"+c.code+"/standings").then(function(st){
        var cls=[];
        ((st&&st.children)||[]).forEach(function(ch){ (((ch.standings&&ch.standings.entries))||[]).forEach(function(en){
          var pos=null,pts=null; (en.stats||[]).forEach(function(s){ if(s.name==="rank"||s.type==="rank")pos=s.value; if(s.name==="points"||s.type==="points")pts=s.value; });
          cls.push({pos:pos,nm:nomeSquadra(en.team).toUpperCase(),pts:pts}); }); });
        cls.sort(function(a,b){return (a.pos||99)-(b.pos||99);});
        if(!cls.length)return null;
        return {data:cls.slice(0,10).map(function(r){return (r.pos!=null?r.pos+"° ":"")+r.nm+(r.pts!=null?" "+r.pts+"PT":"");}), n:cls.length};
      });
    }
    if(v.tipo==="mar"){
      return J(base+"/statistics?season="+anno).then(function(mk){
        var gl=((mk&&mk.stats)||[]).filter(function(x){return x.name==="goalsLeaders";})[0];
        var mar=((gl&&gl.leaders)||[]).slice(0,10).map(function(l){
          var a=l.athlete||{},dn=(a.displayName||a.shortName||"").trim();
          var cog=dn?dn.split(" ").slice(-1)[0].toUpperCase():"";
          var g=(l.value!=null?Math.round(l.value):"");
          return cog+(g!==""?" "+g:"");
        }).filter(Boolean);
        if(!mar.length)return null;
        return {data:mar, n:mar.length};
      });
    }
    // risultati / prossime dallo scoreboard, con finestra date allargata
    function ymd(d){ return ""+d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0"); }
    var oggi=new Date(), da=new Date(oggi), a=new Date(oggi);
    if(v.tipo==="pro"){ a.setDate(a.getDate()+16); } else { da.setDate(da.getDate()-6); }
    return J(base+"/scoreboard?dates="+ymd(da)+"-"+ymd(a)).then(function(sb){
      var out=[];
      ((sb&&sb.events)||[]).forEach(function(e){
        var cc=e.competitions&&e.competitions[0]; if(!cc||!cc.status||!cc.status.type)return;
        var done=cc.status.type.completed, live=cc.status.type.state==="in";
        if(v.tipo==="ris" && !done)return;
        if(v.tipo==="pro" && (done||live))return;
        var cs=cc.competitors||[]; if(cs.length<2)return;
        var h=cs.filter(function(x){return x.homeAway==="home";})[0]||cs[0];
        var w=cs.filter(function(x){return x.homeAway==="away";})[0]||cs[1];
        if(v.tipo==="ris"){ if(h.score!=null&&w.score!=null)
          out.push(nomeSquadra(h.team).toUpperCase()+"-"+nomeSquadra(w.team).toUpperCase()+" "+h.score+"-"+w.score); }
        else { var g=e.date?new Date(e.date).toLocaleDateString("it-IT",{day:"numeric",month:"short"}):"";
          out.push(nomeSquadra(h.team).toUpperCase()+"-"+nomeSquadra(w.team).toUpperCase()+(g?" "+g:"")); }
      });
      if(!out.length)return null;
      var tot=out.length; out=out.slice(0,12);   // il turno + margine: il crawl non è infinito
      return {data:out, n:tot};
    });
  }

  // compone dai dati in cache + le etichette correnti: cambiare un titolo
  // aggiorna subito, senza tornare a chiedere i dati a ESPN
  function componi(){
    var res=ULTIMI||[]; var blocchi=[], vuote=0;
    res.forEach(function(r,i){ var cvn=el("cvn-"+i); if(!voci[i])return;
      if(r&&r.data&&r.data.length){ blocchi.push(hdrVoce(voci[i])+" · "+r.data.join(" · ")); if(cvn)cvn.textContent=r.n+" voci"; }
      else { vuote++; if(cvn)cvn.textContent="nessun dato"; }
    });
    crawlText = blocchi.join(" |||| ");
    if(!crawlText){
      el("crawlprev").textContent="Nessun dato per le voci scelte (forse fuori dai giorni di gara).";
      el("crawlnote").textContent="";
    } else {
      el("crawlnote").textContent = blocchi.length+" blocchi nel crawl"+(vuote?" · "+vuote+" senza dati ora":"");
      pintaPrev();
    }
    if (quandoCambia) quandoCambia(crawlText);
  }

  function aggiorna(){
    if(!voci.length){ crawlText=""; ULTIMI=null;
      el("crawlprev").textContent="Aggiungi una o più voci qui sopra."; el("crawlnote").textContent="";
      if (quandoCambia) quandoCambia(""); return; }
    el("crawlprev").textContent="Carico i dati…"; el("crawlnote").textContent="";
    Promise.all(voci.map(bloccoVoce)).then(function(res){ ULTIMI=res; componi(); });
  }

  function monta(contenitore, opzioni){
    box = contenitore;
    quandoCambia = (opzioni && opzioni.onCambio) || null;
    stile();
    box.innerHTML =
      '<div class="cr-barra">' +
        '<div class="cr-campo" style="flex:1;min-width:150px"><label for="crComp">Competizione</label><select id="crComp"></select></div>' +
        '<div class="cr-campo"><label for="crTipo">Dato</label><select id="crTipo">' +
          '<option value="cls">Classifica</option><option value="ris">Risultati</option>' +
          '<option value="pro">Prossime</option><option value="mar">Marcatori</option></select></div>' +
        '<button id="btnAddVoce" type="button">+ Aggiungi</button>' +
        '<button id="btnCrawl" type="button">&#8635; Aggiorna</button>' +
      '</div>' +
      '<div id="crVoci" class="crvoci"></div>' +
      '<div id="crawlprev">Aggiungi una o più voci.</div>' +
      '<div id="crawlnote"></div>';

    el("crComp").innerHTML = COMPS.map(function(c,i){
      return '<option value="'+i+'">'+esc((c.b?c.b+" ":"")+c.n)+'</option>'; }).join("");

    el("btnAddVoce").addEventListener("click", function(){
      voci.push({ci:+el("crComp").value, tipo:el("crTipo").value, et:""}); renderVoci(); aggiorna();
    });
    el("btnCrawl").addEventListener("click", aggiorna);
    el("crVoci").addEventListener("click", function(e){
      var rm=e.target.closest ? e.target.closest(".cv-rm") : null; if(!rm)return;
      voci.splice(+rm.dataset.i,1); renderVoci(); aggiorna();
    });
    el("crVoci").addEventListener("input", function(e){
      var inp=e.target.closest ? e.target.closest(".cv-et") : null; if(!inp)return;
      var v=voci[+inp.dataset.i]; if(!v)return;
      v.et=inp.value; componi();
    });

    renderVoci();
    aggiorna();
  }

  return { monta: monta, testo: function(){ return crawlText; }, aggiorna: aggiorna };
})();
