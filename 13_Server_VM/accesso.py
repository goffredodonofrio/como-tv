#!/usr/bin/env python3
"""
ACCESSO — il cancello di projects-cloud.it: si entra con Google, solo con un
account @sent.tv o @comofootball.com (o un indirizzo autorizzato a mano), e da
li' in poi tutto e' tracciato con quella mail. (Goffredo e Davide, 27/09/2026)

Dietro nginx su 127.0.0.1:8098:
  GET /auth/entra?torna=/percorso   la pagina "Accedi con Google"
  GET /auth/google?torna=…          manda a Google (flusso col codice, lato server)
  GET /auth/google/fatto            ritorno da Google: controlla dominio, apre la sessione
  GET /auth/verifica                per nginx (auth_request): 200 + X-Utente, oppure 401
  GET /auth/chi                     {"email": …} per le pagine
  GET /auth/esci                    chiude la sessione
La sessione e' un cookie firmato (HMAC): finisce chiudendo il browser, o dopo 12 ore. Gli accessi finiscono
in /var/lib/comotv-accesso/accessi.jsonl (chi, quando, da dove).

Configurazione in /etc/comotv/accesso.env (mai nel repo):
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   dal client OAuth "Applicazione web"
  ACCESSO_DOMINI=sent.tv,comofootball.com
La chiave delle sessioni si crea da sola in /etc/comotv/accesso.chiave.
Gli indirizzi singoli ammessi (collaboratori con la mail personale) stanno in
/etc/comotv/accesso-autorizzati.txt, uno per riga.
"""
import base64, hashlib, hmac, html, json, os, re, secrets, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/comotv/accesso.env"
CHIAVE = "/etc/comotv/accesso.chiave"
AUTORIZZATI = "/etc/comotv/accesso-autorizzati.txt"
REGISTRO = "/var/lib/comotv-accesso/accessi.jsonl"
SITO = os.environ.get("ACCESSO_SITO", "https://projects-cloud.it")
RITORNO = SITO + "/auth/google/fatto"
COOKIE = "comotv_sessione"
# LA SESSIONE SI CHIUDE QUANDO SI ESCE (Goffredo, 27/09/2026): cookie di sessione
# (chiuso il browser non vale piu') e in ogni caso scadenza dopo una giornata di lavoro
DURATA = 12 * 3600
LOG_NGINX = "/var/log/nginx/comotv-chi.log"


def conf():
    c = {}
    try:
        for r in open(CONF):
            r = r.strip()
            if r and not r.startswith("#") and "=" in r:
                k, v = r.split("=", 1); c[k.strip()] = v.strip()
    except OSError:
        pass
    return c


def chiave():
    try:
        return open(CHIAVE, "rb").read()
    except OSError:
        k = secrets.token_bytes(32)
        os.makedirs(os.path.dirname(CHIAVE), exist_ok=True)
        fd = os.open(CHIAVE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.write(fd, k); os.close(fd)
        return k


def firma(testo):
    return base64.urlsafe_b64encode(hmac.new(chiave(), testo.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def b64(s): return base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")


def deb64(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)).decode()


def sessione_nuova(email, durata=None):
    corpo = b64(json.dumps({"e": email, "s": int(time.time()) + (durata or DURATA)}))
    return corpo + "." + firma(corpo)


def sessione_valida(valore):
    try:
        corpo, f = valore.split(".", 1)
        if not hmac.compare_digest(f, firma(corpo)): return None
        d = json.loads(deb64(corpo))
        if d["s"] < time.time(): return None
        return d["e"] if ammesso(d["e"]) else None     # chi viene tolto dagli autorizzati esce subito
    except Exception:
        return None


def autorizzati():
    try:
        return {r.strip().lower() for r in open(AUTORIZZATI) if r.strip() and not r.startswith("#")}
    except OSError:
        return set()


# ── GLI UTENTI TECNICI (Goffredo, 28/09/2026: "un altro super user per sviluppo e
#    debug"). Nome + password, senza Google. Sulla VM c'e' solo l'impronta (PBKDF2),
#    in /etc/comotv/accesso-locali.json: {"admin": {"hash": "...", "admin": true}}.
#    Ogni ingresso finisce nel registro; 5 errori dallo stesso indirizzo = 15 minuti fermi.
LOCALI = "/etc/comotv/accesso-locali.json"
ERRORI_TECNICO = {}


def locali():
    try: return json.load(open(LOCALI))
    except Exception: return {}


def impronta(password, sale=None, giri=310000):
    sale = sale or secrets.token_hex(16)
    return "pbkdf2_sha256$%d$%s$%s" % (giri, sale, hashlib.pbkdf2_hmac("sha256", password.encode(), sale.encode(), giri).hex())


def password_giusta(password, salvata):
    try:
        _, giri, sale, h = salvata.split("$")
        return hmac.compare_digest(impronta(password, sale, int(giri)).split("$")[3], h)
    except Exception:
        return False


def ammesso(email, hd=None):
    email = (email or "").lower()
    if email in locali(): return True
    domini = [d.strip().lower() for d in conf().get("ACCESSO_DOMINI", "sent.tv,comofootball.com").split(",") if d.strip()]
    dominio = email.rsplit("@", 1)[-1]
    if email in autorizzati(): return True
    # per i domini aziendali Google mette "hd": deve tornare anche quello
    return dominio in domini and (hd is None or (hd or "").lower() == dominio)


# ── I FOGLI PRESENZE (Goffredo, 27/09/2026): niente piu' password. Ogni dipendente
#    (nome.cognome@sent.tv) apre solo il proprio foglio, il super utente tutti; le ore
#    si salvano qui sul server (prima restavano nel browser di chi le scriveva).
DIPENDENTI = "/etc/comotv/dipendenti.json"          # {slug: {"nome", "email"}}; mai nel repo
PRESENZE = "/var/lib/comotv-presenze"
TETTO_PRESENZE = 2 * 1024 * 1024


def dipendenti():
    try: return json.load(open(DIPENDENTI))
    except Exception: return {}


def fogli_di(email):
    """i fogli che questa persona puo' aprire: il suo; il super utente tutti"""
    d = dipendenti(); admin = email in super_utenti()
    return sorted([(k, v) for k, v in d.items() if admin or (v.get("email") or "").lower() == email], key=lambda x: x[1].get("nome", ""))


def pagina_permessa(email, percorso):
    """per il cancello della cartella HR: i fogli personali solo al titolare e al super utente"""
    p = urllib.parse.unquote(percorso.split("?", 1)[0])
    if "/presenze/" in p:
        slug = p.rsplit("/", 1)[-1].replace(".html", "")
        return any(k == slug for k, _ in fogli_di(email))
    return True


def super_utenti():
    su = {x.strip().lower() for x in conf().get("ACCESSO_ADMIN", "goffredo.donofrio@sent.tv").split(",") if x.strip()}
    return su | {k for k, v in locali().items() if v.get("admin")}


# ── IL CLUB VEDE SOLO IL SUO (Goffredo, 28/09/2026): le mail @comofootball.com
#    entrano solo in "MAM e Magazzino Como 1907" (home filtrata, MAM 1907, Raccolte
#    1907, Editing 1907 e i loro file) e in Guida e Palestra. Lo decide il server,
#    pagina per pagina.
def ruolo(email):
    email = (email or "").lower()
    if email in super_utenti(): return "admin"
    solo = [d.strip().lower() for d in conf().get("ACCESSO_SOLO_1907", "comofootball.com").split(",") if d.strip()]
    return "club" if email.rsplit("@", 1)[-1] in solo else "staff"


def club_puo(percorso):
    """le pagine del club: home, MAM Como 1907 (e i suoi dati), Editing 1907, Guida e Palestra"""
    p, _, q = urllib.parse.unquote(percorso or "").partition("?")
    rel = p
    for pre in ("/como-tv-dev/", "/como-tv/", "/"):
        if p.startswith(pre): rel = p[len(pre):]; break
    if rel in ("", "index.html"): return True
    if rel == "live/mam-1907.html" or rel.startswith("mam-1907/"): return True
    if rel.startswith("guida/"): return True              # Guida e Palestra (Goffredo, 28/09/2026)
    if rel == "live/mam2.html" and re.search(r"(^|&)ambito=1907(&|$)", q): return True
    return False


def torna_sicuro(t):
    t = t or "/como-tv/"
    return t if t.startswith("/") and not t.startswith("//") and "\\" not in t else "/como-tv/"


def registra(evento, email, ip, extra=None):
    try:
        os.makedirs(os.path.dirname(REGISTRO), exist_ok=True)
        with open(REGISTRO, "a") as f:
            f.write(json.dumps(dict({"quando": time.strftime("%Y-%m-%dT%H:%M:%S"), "evento": evento, "chi": email, "ip": ip}, **(extra or {})), ensure_ascii=False) + "\n")
    except OSError:
        pass


PAGINA = """<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accesso · Como TV</title><meta name="robots" content="noindex">
<style>
@font-face{font-family:'Mazzard';src:url('/como-tv/assets/fonts/MazzardM-ExtraBold.ttf') format('truetype');font-weight:800;}
@font-face{font-family:'DM Sans';src:url('/como-tv/assets/fonts/DMSans-Medium.ttf') format('truetype');font-weight:500;}
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;display:grid;place-items:center;background:#0A0F24;color:#EDEDEE;font:15px/1.5 'DM Sans',system-ui,sans-serif;padding:24px 16px}
.box{width:min(420px,100%);background:#141826;border:1px solid rgba(201,162,75,.35);border-radius:16px;padding:32px 28px;display:flex;flex-direction:column;gap:16px;align-items:center;text-align:center}
img{width:56px} h1{font:800 24px/1.1 'Mazzard',sans-serif} p{color:#9A9CA4;font-size:13.5px}
a.g{display:inline-flex;align-items:center;gap:10px;background:#fff;color:#1f1f1f;text-decoration:none;border-radius:999px;padding:11px 20px;font-weight:600;font-size:14px}
a.g:focus-visible{outline:3px solid #C9A24B;outline-offset:3px}
.err{color:#FF9A9C;background:rgba(229,27,32,.12);border-radius:8px;padding:10px 12px;font-size:13px}
.tec{width:100%;margin-top:8px;padding-top:16px;border-top:1px solid rgba(255,255,255,.08);display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center}
.tec-eti{grid-column:1/-1;text-align:left;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6B6E78}
.tec input{min-width:0;padding:9px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.04);color:#EDEDEE;font:inherit;font-size:13px}
.tec input:focus{outline:none;border-color:#C9A24B}
.tec button{padding:9px 14px;border-radius:8px;border:1px solid rgba(201,162,75,.5);background:transparent;color:#E3C271;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.tec button:hover{background:rgba(201,162,75,.12)}
@media (max-width:420px){.tec{grid-template-columns:1fr}}
</style></head><body><main class="box">
<img src="/loghi/como-tv-logo.png" alt="Como TV">
<h1>Accedi a Como TV</h1>
__ERRORE__
<p>Con il tuo account Google di lavoro: <b>@sent.tv</b> o <b>@comofootball.com</b>.</p>
<a class="g" id="vai" href="/auth/google?torna=__TORNA__"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.3 5.7c4.3-4 7-9.9 7-17.2z"/><path fill="#FBBC05" d="M10.6 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.2 1.5-5 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>Accedi con Google</a>
<p>Ogni azione viene registrata con la tua mail.</p>
<form class="tec" method="post" action="/auth/tecnico">
<div class="tec-eti">Accesso tecnico</div>
<input type="hidden" name="torna" id="tornaTec" value="__TORNA_TESTO__">
<input name="utente" placeholder="Utente" autocomplete="username" aria-label="Utente" required>
<input name="password" type="password" placeholder="Password" autocomplete="current-password" aria-label="Password" required>
<button type="submit">Entra</button>
</form>
</main><script>if(location.hash){var a=document.getElementById("vai");a.href+=encodeURIComponent(location.hash);var t=document.getElementById("tornaTec");t.value+=location.hash;}</script></body></html>"""


def azione_di(percorso, stato):
    """dalla riga di nginx a un'azione che si legge: None = rumore (miniature, indice)"""
    p = urllib.parse.unquote(percorso.split("?", 1)[0])
    if "/mam-1907/mini/" in p or "/mam-1907/provino/" in p or "/mam-1907/indice/" in p: return None
    if p.endswith("/live/mam-1907.html"): return ("apre la pagina", "MAM Como 1907")
    if "/presenze/" in p and p.endswith(".html"): return ("apre il foglio presenze", p.rsplit("/", 1)[-1].replace(".html", ""))
    if p.endswith("/foglio-presenze.html"): return ("apre l'elenco presenze", "")
    if "/mam-1907/file/" in p: return ("guarda / scarica l'originale", p.split("/mam-1907/file/", 1)[1])
    if "/mam-1907/copie/" in p: return ("guarda la copia leggera", p.rsplit("/", 1)[-1])
    if p.endswith("/mam-1907/copia"):
        v = urllib.parse.parse_qs(percorso.split("?", 1)[1] if "?" in percorso else "").get("v", [""])[0]
        return ("chiede la copia leggera", v) if "fai=1" in percorso else None
    return ("apre", p)


def registro(quante=4000):
    """accessi del servizio + righe del cancello di nginx; le richieste a pezzi dello
    stesso video (206) nello stesso quarto d'ora diventano una riga sola"""
    voci = []
    try:
        for r in open(REGISTRO).read().splitlines()[-quante:]:
            d = json.loads(r)
            voci.append({"q": d["quando"], "chi": d.get("chi") or "", "az": {"entra": "entra", "esce": "esce", "rifiutato": "accesso rifiutato"}.get(d["evento"], d["evento"]), "cosa": d.get("foglio", ""), "ip": d.get("ip", "")})
    except OSError:
        pass
    ultimo = {}
    try:
        righe = open(LOG_NGINX, errors="replace").read().splitlines()[-quante * 10:]
    except OSError:
        righe = []
    for r in righe:
        c = r.split("\t")
        if len(c) < 7 or not c[1].strip() or c[1].strip() == "-": continue
        a = azione_di(c[4].strip(), c[5].strip())
        if not a: continue
        q = c[0].strip()[:19]; chi = c[1].strip(); k = (chi, a[0], a[1])
        t = time.mktime(time.strptime(q, "%Y-%m-%dT%H:%M:%S"))
        if k in ultimo and t - ultimo[k] < 900: continue
        ultimo[k] = t
        voci.append({"q": q, "chi": chi, "az": a[0], "cosa": a[1], "ip": c[2].strip()})
    voci.sort(key=lambda v: v["q"], reverse=True)
    return voci[:quante]


REGISTRO_HTML = """<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registro di controllo · Como TV</title><meta name="robots" content="noindex">
<style>
@font-face{font-family:'Mazzard';src:url('/como-tv/assets/fonts/MazzardM-ExtraBold.ttf') format('truetype');font-weight:800;}
@font-face{font-family:'DM Sans';src:url('/como-tv/assets/fonts/DMSans-Medium.ttf') format('truetype');font-weight:500;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1B1C20;color:#EDEDEE;font:14px/1.45 'DM Sans',system-ui,sans-serif}
.pagina{padding:22px clamp(16px,3vw,40px) 60px}
a{color:#E3C271}
.testa{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.testa img{width:34px} .testa h1{font:800 26px/1 'Mazzard',sans-serif} .testa span{color:#8E9096;font-size:13px} .testa .dx{margin-left:auto;display:flex;gap:14px;font-size:13px}
.filtri{display:grid;grid-template-columns:minmax(220px,2fr) repeat(2,minmax(160px,1fr)) repeat(2,minmax(140px,1fr));gap:10px;margin-bottom:14px}
.filtri input,.filtri select{background:rgba(245,241,230,.06);border:1px solid rgba(255,255,255,.16);color:#EDEDEE;border-radius:8px;padding:9px 10px;font:inherit;color-scheme:dark;min-width:0}
.tab{width:100%;border-collapse:collapse;background:#2A2B30;border:1px solid rgba(255,255,255,.08);border-radius:12px;overflow:hidden;font-size:13px}
.tab th{font:700 9.5px/1 'Mazzard',sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#8E9096;text-align:left;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.08)}
.tab td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
.tab td.q,.tab td.ip{color:#8E9096;white-space:nowrap;font-variant-numeric:tabular-nums} .tab td.cosa{word-break:break-word;color:#C9CACF}
.az{font:700 10px/1 'Mazzard',sans-serif;letter-spacing:.06em;text-transform:uppercase;padding:4px 7px;border-radius:4px;background:rgba(245,241,230,.08);white-space:nowrap}
.az.entra{background:rgba(79,203,139,.16);color:#7FDCA9}.az.esce{background:rgba(142,144,150,.16)}.az.rif{background:rgba(229,72,77,.18);color:#FF9A9C}.az.file{background:rgba(90,167,232,.18);color:#8CC5F2}
.scroll{overflow-x:auto} .nota{color:#8E9096;font-size:12px;margin-top:10px}
@media (max-width:760px){.filtri{grid-template-columns:1fr 1fr}}
</style></head><body>
<nav class="ms-bar"></nav><script src="/como-tv/live/menu-sito.js"></script><script src="/como-tv/live/utente.js" async></script>
<div class="pagina">
<div class="testa"><h1>Registro di controllo</h1><span id="conto"></span></div>
<div class="filtri">
<input id="f" placeholder="Cerca per persona, azione, file o IP" type="search">
<select id="chi"><option value="">Tutte le persone</option></select>
<select id="az"><option value="">Tutte le azioni</option></select>
<input id="da" type="date" title="dal"><input id="a" type="date" title="al">
</div>
<div class="scroll"><table class="tab"><thead><tr><th>Quando</th><th>Chi</th><th>Azione</th><th>Oggetto</th><th>IP</th></tr></thead><tbody id="righe"><tr><td colspan="5">Carico…</td></tr></tbody></table></div>
</div>
<p class="nota" style="padding:0 clamp(16px,3vw,40px) 40px">Si registrano accessi e uscite, gli accessi rifiutati e, dietro il cancello, pagine e file aperti (oggi: MAM Como 1907). Le richieste a pezzi dello stesso video nello stesso quarto d'ora contano una volta. Miniature e anteprime non si registrano.</p>
<script>
var V=[],$=function(i){return document.getElementById(i)};
function esc(s){return String(s||"").replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function cl(a){return a==="entra"?"entra":a==="esce"?"esce":/rifiut/.test(a)?"rif":/originale|copia/.test(a)?"file":""}
function disegna(){
 var f=$("f").value.toLowerCase(),chi=$("chi").value,az=$("az").value,da=$("da").value,a=$("a").value;
 var r=V.filter(function(v){return(!chi||v.chi===chi)&&(!az||v.az===az)&&(!da||v.q.slice(0,10)>=da)&&(!a||v.q.slice(0,10)<=a)&&(!f||(v.chi+" "+v.az+" "+v.cosa+" "+v.ip).toLowerCase().indexOf(f)>=0)});
 $("conto").textContent=r.length+" eventi";
 $("righe").innerHTML=r.slice(0,1500).map(function(v){var d=v.q.replace("T"," ");return"<tr><td class=q>"+esc(d.slice(8,10)+"/"+d.slice(5,7)+"/"+d.slice(0,4)+" "+d.slice(11,16))+"</td><td>"+esc(v.chi)+"</td><td><span class='az "+cl(v.az)+"'>"+esc(v.az)+"</span></td><td class=cosa>"+esc(v.cosa)+"</td><td class=ip>"+esc(v.ip)+"</td></tr>"}).join("")||"<tr><td colspan=5>Nessun evento con questi filtri.</td></tr>";
}
fetch("/auth/registro.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
 V=j; var chi={},az={}; V.forEach(function(v){if(v.chi)chi[v.chi]=1;az[v.az]=1});
 $("chi").innerHTML+=Object.keys(chi).sort().map(function(x){return"<option>"+esc(x)+"</option>"}).join("");
 $("az").innerHTML+=Object.keys(az).sort().map(function(x){return"<option>"+esc(x)+"</option>"}).join("");
 disegna();
});
["f","chi","az","da","a"].forEach(function(i){$(i).addEventListener("input",disegna)});
</script></body></html>"""


TECNICO = """<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accesso tecnico · Como TV</title><meta name="robots" content="noindex">
<style>*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;display:grid;place-items:center;background:#0A0F24;color:#EDEDEE;font:15px/1.5 system-ui,sans-serif;padding:24px 16px}
form{width:min(380px,100%);background:#141826;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:26px;display:flex;flex-direction:column;gap:12px}
h1{font-size:19px}label{font-size:12px;color:#9A9CA4}input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:#EDEDEE;font:inherit}
button{padding:11px;border-radius:8px;border:0;background:#C9A24B;color:#10131c;font-weight:700;cursor:pointer}p{font-size:12.5px;color:#9A9CA4}.err{color:#FF9A9C}a{color:#E3C271}</style></head><body>
<form method="post" action="/auth/tecnico"><h1>Accesso tecnico</h1><p>Per sviluppo e debug. Ogni ingresso viene registrato.</p>__ERRORE__
<input type="hidden" name="torna" value="__TORNA__"><label for="u">Utente</label><input id="u" name="utente" autocomplete="username" required>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Entra</button><p><a href="/auth/entra">Torna all'accesso con Google</a></p></form></body></html>"""


PRIVACY = """<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy · Accesso Como TV</title><style>body{max-width:680px;margin:40px auto;padding:0 16px;font:15px/1.6 system-ui,sans-serif;color:#1d1d1f;background:#fff}h1{font-size:22px}h2{font-size:16px;margin-top:22px}</style></head><body>
<h1>Accesso a Como TV · informativa sui dati</h1>
<p>Gli strumenti di lavoro di Como TV su projects-cloud.it sono riservati al personale con un account Google aziendale <b>@sent.tv</b> o <b>@comofootball.com</b> e alle persone autorizzate singolarmente.</p>
<h2>Quali dati</h2><p>Dall'accesso con Google leggiamo soltanto l'<b>indirizzo email</b> e la conferma che l'account appartiene al dominio aziendale. Non leggiamo contatti, file, calendario o altri dati dell'account.</p>
<h2>A cosa servono</h2><p>A decidere chi può entrare e a registrare chi fa cosa negli strumenti (accessi, aperture, download, montaggi, invii), per sicurezza e per il lavoro della redazione.</p>
<h2>Dove restano</h2><p>Su un server usato solo da Como TV. Non vengono ceduti a terzi né usati per pubblicità.</p>
<h2>Uscire</h2><p>Si esce da <a href="/auth/esci">/auth/esci</a>. Per domande o per chiedere la cancellazione del proprio registro scrivere al responsabile degli strumenti Como TV.</p>
</body></html>"""


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def ip(self): return self.headers.get("X-Real-IP") or self.client_address[0]

    def cookie(self):
        for pezzo in (self.headers.get("Cookie") or "").split(";"):
            if "=" in pezzo:
                k, v = pezzo.strip().split("=", 1)
                if k == COOKIE: return v
        return ""

    def manda(self, codice, corpo=b"", tipo="text/plain; charset=utf-8", extra=None):
        b = corpo if isinstance(corpo, bytes) else corpo.encode()
        self.send_response(codice)
        self.send_header("Content-Type", tipo); self.send_header("Content-Length", str(len(b))); self.send_header("Cache-Control", "no-store")
        for k, v in (extra or []): self.send_header(k, v)
        self.end_headers(); self.wfile.write(b)

    def pagina(self, torna, errore=""):
        h = PAGINA.replace("__TORNA_TESTO__", html.escape(torna)).replace("__TORNA__", urllib.parse.quote(torna, safe="")).replace("__ERRORE__", '<p class="err">' + html.escape(errore) + "</p>" if errore else "")
        self.manda(200, h, "text/html; charset=utf-8")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        # torna e' tutto quello che segue "torna=": la pagina di prima con la sua ricerca
        torna = torna_sicuro(urllib.parse.unquote(u.query[6:]) if u.query.startswith("torna=") else "")
        if u.path == "/auth/verifica":
            email = sessione_valida(self.cookie())
            if not email: return self.manda(401)
            if ruolo(email) == "club" and not club_puo(self.headers.get("X-Pagina") or ""): return self.manda(403)
            return self.manda(200, b"", extra=[("X-Utente", email)])
        if u.path == "/auth/verifica-dip":
            email = sessione_valida(self.cookie())
            if not email: return self.manda(401)
            if ruolo(email) == "club":
                # nella cartella HR il club apre solo l'elenco (vuoto per lui, e lo rimanda al 1907):
                # un 403 sull'elenco farebbe girare in tondo il rinvio all'elenco
                ok = urllib.parse.unquote(self.headers.get("X-Pagina") or "").split("?")[0].endswith("/foglio-presenze.html")
                return self.manda(200, b"", extra=[("X-Utente", email)]) if ok else self.manda(403)
            return self.manda(200, b"", extra=[("X-Utente", email)]) if pagina_permessa(email, self.headers.get("X-Pagina") or "") else self.manda(403)
        if u.path == "/auth/dipendenti":
            email = sessione_valida(self.cookie())
            if not email: return self.manda(401, json.dumps({"errore": "serve l'accesso"}), "application/json")
            return self.manda(200, json.dumps({"email": email, "admin": email in super_utenti(), "ruolo": ruolo(email),
                                               "persone": [{"slug": k, "nome": v.get("nome", k)} for k, v in fogli_di(email)]}, ensure_ascii=False), "application/json; charset=utf-8")
        if u.path.startswith("/auth/presenze/"):
            email = sessione_valida(self.cookie()); slug = u.path.rsplit("/", 1)[-1]
            if not email: return self.manda(401, json.dumps({"errore": "serve l'accesso"}), "application/json")
            if not any(k == slug for k, _ in fogli_di(email)): return self.manda(403, json.dumps({"errore": "non e' il tuo foglio"}), "application/json")
            try: dati = open(os.path.join(PRESENZE, slug, "presenze.json")).read()
            except OSError: dati = json.dumps({"chiavi": {}, "aggiornato": 0})
            return self.manda(200, dati, "application/json; charset=utf-8")
        if u.path == "/auth/chi":
            email = sessione_valida(self.cookie())
            return self.manda(200, json.dumps({"email": email or "", "admin": bool(email and email in super_utenti()), "ruolo": ruolo(email) if email else ""}), "application/json")
        if u.path == "/auth/entra":
            return self.pagina(torna)
        if u.path in ("/auth/registro", "/auth/registro.json"):
            email = sessione_valida(self.cookie())
            if not email: return self.manda(302, extra=[("Location", "/auth/entra?torna=/auth/registro")])
            if email not in super_utenti(): return self.manda(403, "Il registro lo vede solo il super utente.")
            if u.path.endswith(".json"): return self.manda(200, json.dumps(registro(), ensure_ascii=False), "application/json; charset=utf-8")
            return self.manda(200, REGISTRO_HTML, "text/html; charset=utf-8")
        if u.path == "/auth/tecnico":
            return self.manda(200, TECNICO.replace("__TORNA__", html.escape(torna)).replace("__ERRORE__", ""), "text/html; charset=utf-8")
        if u.path == "/auth/privacy":
            return self.manda(200, PRIVACY, "text/html; charset=utf-8")
        if u.path == "/auth/esci":
            registra("esce", sessione_valida(self.cookie()), self.ip())
            return self.manda(302, extra=[("Location", "/auth/entra"), ("Set-Cookie", COOKIE + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax")])
        c = conf()
        if u.path == "/auth/google":
            if not c.get("GOOGLE_CLIENT_ID"): return self.pagina(torna, "L'accesso con Google non è ancora configurato.")
            stato = b64(json.dumps({"t": torna, "n": secrets.token_hex(8), "q": int(time.time())}))
            stato += "." + firma(stato)
            dove = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
                "client_id": c["GOOGLE_CLIENT_ID"], "redirect_uri": RITORNO, "response_type": "code",
                "scope": "openid email", "state": stato, "prompt": "select_account", "hd": "*"})
            return self.manda(302, extra=[("Location", dove)])
        if u.path == "/auth/google/fatto":
            try:
                stato = (q.get("state") or [""])[0]; corpo, f = stato.split(".", 1)
                if not hmac.compare_digest(f, firma(corpo)): raise ValueError("stato")
                s = json.loads(deb64(corpo))
                if time.time() - s["q"] > 900: raise ValueError("scaduto")
                torna = torna_sicuro(s["t"])
            except Exception:
                return self.pagina("/como-tv/", "Accesso scaduto o non valido: riprova.")
            if q.get("error"): return self.pagina(torna, "Accesso annullato.")
            try:
                dati = urllib.parse.urlencode({"code": (q.get("code") or [""])[0], "client_id": c["GOOGLE_CLIENT_ID"],
                                               "client_secret": c["GOOGLE_CLIENT_SECRET"], "redirect_uri": RITORNO, "grant_type": "authorization_code"}).encode()
                r = json.load(urllib.request.urlopen(urllib.request.Request("https://oauth2.googleapis.com/token", data=dati), timeout=15))
                # il token arriva direttamente da Google su TLS: basta controllarne i campi
                t = json.loads(deb64(r["id_token"].split(".")[1]))
                if t.get("aud") != c["GOOGLE_CLIENT_ID"] or t.get("iss") not in ("accounts.google.com", "https://accounts.google.com") or t.get("exp", 0) < time.time():
                    raise ValueError("token")
            except Exception:
                return self.pagina(torna, "Google non ha confermato l'accesso: riprova.")
            email = (t.get("email") or "").lower()
            if not t.get("email_verified") or not ammesso(email, t.get("hd")):
                registra("rifiutato", email, self.ip())
                return self.pagina(torna, "L'account " + email + " non è abilitato. Usa la mail @sent.tv o @comofootball.com, o chiedi di essere aggiunto.")
            registra("entra", email, self.ip())
            return self.manda(302, extra=[("Location", torna),
                                          ("Set-Cookie", COOKIE + "=" + sessione_nuova(email) + "; Path=/; Secure; HttpOnly; SameSite=Lax")])
        return self.manda(404)


def do_POST_tecnico(self):
    ip = self.ip(); ora = time.time()
    errori = [t for t in ERRORI_TECNICO.get(ip, []) if ora - t < 900]; ERRORI_TECNICO[ip] = errori
    n = int(self.headers.get("Content-Length") or 0)
    dati = urllib.parse.parse_qs(self.rfile.read(min(n, 4096)).decode(errors="replace")) if n > 0 else {}
    utente = (dati.get("utente") or [""])[0].strip().lower(); pw = (dati.get("password") or [""])[0]
    torna = torna_sicuro((dati.get("torna") or [""])[0])
    def pagina_err(msg):
        return self.manda(200, TECNICO.replace("__TORNA__", html.escape(torna)).replace("__ERRORE__", '<p class="err">' + html.escape(msg) + "</p>"), "text/html; charset=utf-8")
    if len(errori) >= 5:
        registra("accesso tecnico bloccato", utente, ip)
        return pagina_err("Troppi tentativi sbagliati: riprova tra 15 minuti.")
    u = locali().get(utente)
    if not u or not password_giusta(pw, u.get("hash", "")):
        ERRORI_TECNICO[ip] = errori + [ora]
        registra("accesso tecnico rifiutato", utente, ip)
        return pagina_err("Utente o password non corretti.")
    ERRORI_TECNICO.pop(ip, None)
    registra("entra (accesso tecnico)", utente, ip)
    return self.manda(302, extra=[("Location", torna), ("Set-Cookie", COOKIE + "=" + sessione_nuova(utente) + "; Path=/; Secure; HttpOnly; SameSite=Lax")])


def do_POST_presenze(self):
    u = urllib.parse.urlparse(self.path)
    if u.path == "/auth/tecnico": return do_POST_tecnico(self)
    if not u.path.startswith("/auth/presenze/"): return self.manda(404)
    email = sessione_valida(self.cookie()); slug = u.path.rsplit("/", 1)[-1]
    if not email: return self.manda(401, json.dumps({"errore": "serve l'accesso"}), "application/json")
    if not any(k == slug for k, _ in fogli_di(email)): return self.manda(403, json.dumps({"errore": "non e' il tuo foglio"}), "application/json")
    n = int(self.headers.get("Content-Length") or 0)
    if n <= 0 or n > TETTO_PRESENZE: return self.manda(413, json.dumps({"errore": "troppo grande"}), "application/json")
    try:
        chiavi = json.loads(self.rfile.read(n).decode()).get("chiavi") or {}
        # solo le chiavi di questo foglio, e solo testo
        chiavi = {k: v for k, v in chiavi.items() if isinstance(k, str) and k.startswith("presenze_" + slug) and isinstance(v, str)}
    except Exception:
        return self.manda(400, json.dumps({"errore": "dati non leggibili"}), "application/json")
    cart = os.path.join(PRESENZE, slug); os.makedirs(os.path.join(cart, "storico"), exist_ok=True)
    f = os.path.join(cart, "presenze.json")
    # la versione di prima va nello storico (se ne tengono 200): niente si perde per un errore
    if os.path.exists(f):
        os.replace(f, os.path.join(cart, "storico", time.strftime("%Y%m%d-%H%M%S") + ".json"))
        vecchie = sorted(os.listdir(os.path.join(cart, "storico")))
        for x in vecchie[:-200]: os.remove(os.path.join(cart, "storico", x))
    ora = int(time.time())
    with open(f + ".tmp", "w") as g: json.dump({"chiavi": chiavi, "aggiornato": ora, "chi": email}, g, ensure_ascii=False)
    os.replace(f + ".tmp", f)
    # nel registro una volta ogni quarto d'ora per persona e foglio
    k = (email, slug)
    if ora - ULTIMO_SALVA.get(k, 0) > 900:
        ULTIMO_SALVA[k] = ora; registra("salva presenze", email, self.ip(), {"foglio": slug})
    return self.manda(200, json.dumps({"ok": True, "aggiornato": ora}), "application/json")


ULTIMO_SALVA = {}
H.do_POST = do_POST_presenze


def sessione_debug(utente="admin", ore=2, perche=""):
    """per le prove automatiche (headless): una sessione a tempo, fatta sul server e
    scritta nel registro. Da riga di comando: python3 accesso.py debug [utente] [ore] [perche']"""
    if utente not in locali(): raise SystemExit("utente tecnico sconosciuto: " + utente)
    registra("sessione di debug", utente, "server", {"foglio": perche[:80]} if perche else None)
    return sessione_nuova(utente, int(float(ore) * 3600))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "debug":
        print(sessione_debug(*(sys.argv[2:5] or ["admin"]))); raise SystemExit(0)
    chiave()
    ThreadingHTTPServer(("127.0.0.1", 8098), H).serve_forever()
