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
    if rel == "live/doppioni-1907.html": return True       # i doppioni del FRAME: li giudica il club (29/09/2026)
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


# ── IL REGISTRO PER PERSONA (Goffredo, 28/09/2026: "cosi' e' una lista unica e non mi
#    piace; prima nome e cognome poi la mail, e la durata della sessione"). Dalle righe di
#    nginx e dagli accessi si fanno le SESSIONI di ogni persona (dall'entrata all'ultima
#    cosa fatta, o all'uscita; una pausa di piu' di mezz'ora ne apre un'altra) e per ogni
#    sessione COSA HA FATTO in parole: le pagine aperte e le azioni, contate. Miniature,
#    copertine e indici non contano: sono la pagina che si carica, non una scelta.
NOMI_PAGINE = {
    "index.html": "Home", "live/mam2.html": "MAM", "live/mam2.html?raccolte=1": "Raccolte / Macchie", "live/mam2.html?live=1": "MAM Live",
    "live/mam2.html?montaggio=1": "Editing", "live/mam2.html?ambito=1907": "Editing 1907", "live/mam-1907.html": "MAM Como 1907",
    "live/doppioni-1907.html": "Doppioni 1907", "live/magazzino.html": "Magazzino", "live/classifiche.html": "Catalogo grafiche", "live/redazione.html": "Controllo redazione",
    "live/regia.html": "Regia", "live/telecronaca.html": "Telecronaca", "guida/index.html": "Guida", "guida/en.html": "Guida (EN)",
    "guida/palestra.html": "Palestra", "guida/palestra-en.html": "Palestra (EN)", "1. contratti & hr/foglio-presenze.html": "Presenze dipendenti",
    "10_look&feel/como tv ott design/generatore.html": "Grafiche statiche", "uefa-club-channel.html": "UEFA Club Channel",
}
PAUSA = 1800


def nome_di(email, dip=None):
    email = (email or "").lower()
    if email in locali(): return email + " (accesso tecnico)"
    for v in (dip or {}).values():
        if (v.get("email") or "").lower() == email: return v.get("nome") or email
    parti = email.split("@")[0].replace("_", ".").split(".")
    return " ".join(x[:1].upper() + x[1:] for x in parti if x) or email


def azione_di(metodo, percorso):
    """una riga di nginx -> (voce, dettaglio) in parole; None = rumore"""
    p, _, q = urllib.parse.unquote(percorso).partition("?")
    rel = p
    for pre in ("/como-tv-dev/", "/como-tv/", "/"):
        if p.startswith(pre): rel = p[len(pre):]; break
    dev = " (dev)" if p.startswith("/como-tv-dev/") else ""
    if rel.startswith("api"): return ("lavora nel MAM" + dev, "") if metodo == "POST" else None
    if rel.startswith("mam-1907/file/"): return ("guarda o scarica un originale del 1907", rel.split("/", 2)[2])
    if rel.startswith("mam-1907/copie/"): return ("guarda una copia leggera del 1907", "")
    if rel == "mam-1907/copia": return ("chiede una copia leggera", urllib.parse.parse_qs(q).get("v", [""])[0]) if "fai=1" in q else None
    if rel.startswith("mam-1907/volti"): return ("lavora ai volti del 1907", "") if metodo == "POST" else None
    if rel == "mam-1907/doppioni": return ("segna i doppioni del 1907", "") if metodo == "POST" else None
    if rel.startswith("mam-1907/"): return None
    if metodo != "GET" or not (rel == "" or rel.endswith(".html")): return None
    k = (rel or "index.html").lower()
    if k.endswith("live/mam2.html"):
        for x in ("ambito=1907", "raccolte=1", "live=1", "montaggio=1"):
            if x in q: k = k + "?" + x; break
    if k.startswith("1. contratti & hr/presenze/"): return ("apre il foglio presenze", k.rsplit("/", 1)[-1].replace(".html", ""))
    nome = NOMI_PAGINE.get(k) or k.rsplit("/", 1)[-1].replace(".html", "").replace("-", " ").capitalize()
    return ("apre " + nome + dev, "")


def registro(giorni=21):
    """{persone: [...], rifiuti: [...]} degli ultimi giorni"""
    da = time.time() - giorni * 86400
    eventi = []                      # (t, chi, voce, dettaglio, ip, tipo)
    rifiuti = []
    try:
        for r in open(REGISTRO).read().splitlines():
            d = json.loads(r); t = time.mktime(time.strptime(d["quando"], "%Y-%m-%dT%H:%M:%S"))
            if t < da: continue
            ev, chi = d.get("evento", ""), (d.get("chi") or "").lower()
            if "rifiutat" in ev or "bloccat" in ev:
                rifiuti.append({"q": d["quando"], "chi": chi, "az": ev, "ip": d.get("ip", "")}); continue
            tipo = "entra" if ev.startswith("entra") else "esce" if ev == "esce" else "evento"
            voce = {"entra": "entra", "entra (accesso tecnico)": "entra con l'accesso tecnico", "esce": "esce", "sessione di debug": "sessione di debug (prove automatiche)",
                    "salva presenze": "salva il foglio presenze"}.get(ev, ev)
            if chi: eventi.append((t, chi, voce, d.get("foglio", ""), d.get("ip", ""), tipo))
    except OSError:
        pass
    # anche i log ruotati la notte (comotv-chi.log.1, .2.gz, ...): se no "ieri" sparisce
    import glob, gzip as _gz
    righe = []
    for f in sorted(glob.glob(LOG_NGINX + "*")):
        try:
            if os.path.getmtime(f) < da: continue
            aperto = _gz.open(f, "rt", errors="replace") if f.endswith(".gz") else open(f, errors="replace")
            with aperto as g: righe.extend(g.read().splitlines())
        except OSError:
            continue
    for r in righe:
        c = r.split("\t")
        if len(c) < 7: continue
        chi = c[1].strip().lower()
        if not chi or chi == "-": continue
        try: t = time.mktime(time.strptime(c[0].strip()[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError: continue
        if t < da: continue
        a = azione_di(c[3].strip(), c[4].strip())
        if a: eventi.append((t, chi, a[0], a[1], c[2].strip(), "azione"))
    eventi.sort()
    dip = dipendenti(); ora = time.time()
    per = {}
    for t, chi, voce, det, ip, tipo in eventi:
        u = per.setdefault(chi, {"email": chi, "nome": nome_di(chi, dip), "ruolo": ruolo(chi), "sessioni": []})
        ss = u["sessioni"]; cur = ss[-1] if ss else None
        # un "entra" apre una sessione nuova solo dopo una pausa vera (se no e' la stessa)
        if cur is None or cur["chiusa"] or t - cur["fine"] > PAUSA or (tipo == "entra" and t - cur["fine"] > 120):
            cur = {"inizio": t, "fine": t, "ip": [], "azioni": [], "seq": [], "chiusa": False}; ss.append(cur)
        cur["fine"] = t
        if ip and ip not in cur["ip"] and ip != "server": cur["ip"].append(ip)
        # la stessa cosa nella stessa sessione si conta una volta, con il totale e l'ora della prima
        az = cur["azioni"]; gia = next((z for z in az if z["v"] == voce), None)
        if gia:
            gia["n"] += 1
            if det and det not in gia["d"] and len(gia["d"]) < 5: gia["d"].append(det)
        else:
            az.append({"v": voce, "n": 1, "q": t, "d": [det] if det else []})
        # il PASSO PASSO: in ordine di tempo, la stessa cosa di fila una volta sola col conto
        sq = cur["seq"]
        if sq and sq[-1]["v"] == voce and (not det or det in sq[-1]["d"] or len(sq[-1]["d"]) < 3):
            sq[-1]["n"] += 1
            if det and det not in sq[-1]["d"]: sq[-1]["d"].append(det)
        elif len(sq) < 400:
            sq.append({"v": voce, "n": 1, "q": t, "d": [det] if det else []})
        if tipo == "esce": cur["chiusa"] = True
    persone = []
    for u in per.values():
        for x in u["sessioni"]:
            x["durata"] = int(x["fine"] - x["inizio"])
            x["dentro"] = not x["chiusa"] and ora - x["fine"] < 900
            x["inizio"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(x["inizio"]))
            x["fine"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(x["fine"]))
            for a in x["azioni"] + x["seq"]: a["q"] = time.strftime("%H:%M", time.localtime(a["q"]))
        u["sessioni"].reverse()
        u["ultimo"] = u["sessioni"][0]["fine"] if u["sessioni"] else ""
        persone.append(u)
    persone.sort(key=lambda u: u["ultimo"], reverse=True)
    rifiuti.sort(key=lambda r: r["q"], reverse=True)
    return {"persone": persone, "rifiuti": rifiuti, "giorni": giorni}


# ── CHI E' DENTRO ORA (Goffredo, 29/09/2026: "cosi' vedo chi e' in questo momento
#    online"). Ogni pagina col menu' (utente.js) manda un segnale al minuto: quale
#    pagina, e se e' davanti o in un'altra scheda; chiudendola dice "via". Le pagine
#    senza menu' (Guida, Grafiche statiche, Palinsesto...) si vedono dal log di nginx:
#    chi ha fatto qualcosa negli ultimi 10 minuti. Solo in memoria: dopo un riavvio
#    l'elenco si riempie da solo entro un minuto.
PRESENTI = {}          # email -> {scheda: {p, t, v, q, dal, ip}}
FRESCO = 180           # un segnale vale 3 minuti (le schede in secondo piano battono piano)
DA_POCO = 600


def presente(email, ip, d):
    s = str(d.get("s") or "")[:40]
    if not s: return
    schede = PRESENTI.setdefault(email, {})
    if d.get("via"): schede.pop(s, None); return
    ora = time.time(); prima = schede.get(s)
    schede[s] = {"p": str(d.get("p") or "")[:400], "t": str(d.get("t") or "")[:120], "v": bool(d.get("v")),
                 "q": ora, "dal": prima["dal"] if prima else ora, "ip": ip}


def nome_pagina(p):
    if p.startswith("/auth/registro"): return "Registro di controllo"
    a = azione_di("GET", p)
    if not a: return p
    v = a[0][5:] if a[0].startswith("apre ") else a[0]
    return v[:1].upper() + v[1:] + (" · " + a[1] if a[1] else "")


def presenti():
    ora = time.time(); dip = dipendenti(); per = {}
    for email, schede in list(PRESENTI.items()):
        for k in [k for k, x in schede.items() if ora - x["q"] > FRESCO]: schede.pop(k, None)
        if not schede: PRESENTI.pop(email, None); continue
        u = per.setdefault(email, {"email": email, "schede": [], "log": None})
        for x in schede.values():
            u["schede"].append({"pagina": nome_pagina(x["p"]), "titolo": x["t"], "davanti": x["v"],
                                "dal": int(ora - x["dal"]), "fa": int(ora - x["q"]), "ip": x["ip"]})
    # l'ultima cosa fatta di ciascuno, dal log di nginx (anche per chi e' su pagine senza menu')
    try:
        with open(LOG_NGINX, errors="replace") as g:
            g.seek(0, 2); g.seek(max(0, g.tell() - 600000)); righe = g.read().splitlines()[1:]
    except OSError:
        righe = []
    for r in righe:
        c = r.split("\t")
        if len(c) < 7: continue
        chi = c[1].strip().lower()
        if not chi or chi == "-": continue
        try: t = time.mktime(time.strptime(c[0].strip()[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError: continue
        if ora - t > DA_POCO: continue
        a = azione_di(c[3].strip(), c[4].strip())
        if not a: continue
        u = per.setdefault(chi, {"email": chi, "schede": [], "log": None})
        u["log"] = {"cosa": a[0] + (" · " + a[1] if a[1] else ""), "fa": int(ora - t), "ip": c[2].strip()}
    out = []
    for u in per.values():
        u["nome"] = nome_di(u["email"], dip); u["ruolo"] = ruolo(u["email"])
        u["schede"].sort(key=lambda x: (not x["davanti"], x["fa"]))
        u["davanti"] = any(x["davanti"] for x in u["schede"])
        # "dentro" = una pagina aperta che batte; "da poco" = solo un'azione negli ultimi 10 minuti
        u["stato"] = "davanti" if u["davanti"] else "aperto" if u["schede"] else "da poco"
        u["dal"] = max([x["dal"] for x in u["schede"]] or [0])
        out.append(u)
    out.sort(key=lambda u: ({"davanti": 0, "aperto": 1, "da poco": 2}[u["stato"]], u["nome"].lower()))
    return {"presenti": out, "ora": time.strftime("%H:%M:%S")}


REGISTRO_HTML = r"""<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registro di controllo · Como TV</title><meta name="robots" content="noindex">
<style>
@font-face{font-family:'Mazzard';src:url('/como-tv/assets/fonts/MazzardM-ExtraBold.ttf') format('truetype');font-weight:800;}
@font-face{font-family:'DM Sans';src:url('/como-tv/assets/fonts/DMSans-Medium.ttf') format('truetype');font-weight:500;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#17181C;color:#F2F2F3;font:15px/1.5 'DM Sans',system-ui,sans-serif}
.pagina{padding:24px clamp(16px,3vw,44px) 70px;max-width:1320px}
.testa{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:18px}
.testa h1{font:800 28px/1 'Mazzard',sans-serif} .testa span{color:#A3A5AD;font-size:14px}
.viste{margin-left:auto;display:flex;gap:4px;background:#24262C;border-radius:10px;padding:4px}
.viste button{border:0;background:transparent;color:#C9CACF;padding:8px 14px;border-radius:7px;font:700 11px/1 'Mazzard',sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer}
.viste button.on{background:#C9A24B;color:#10131c}
/* LE DATE: tasti rapidi e striscia dei giorni con attivita' */
.periodo{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.periodo button,.giorno{border:1px solid rgba(255,255,255,.16);background:#24262C;color:#E6E6E8;border-radius:999px;padding:8px 14px;font:600 13.5px/1 'DM Sans',sans-serif;cursor:pointer}
.periodo button.on,.giorno.on{background:#C9A24B;border-color:#C9A24B;color:#10131c}
.periodo button:focus-visible,.giorno:focus-visible,.viste button:focus-visible{outline:2px solid #E3C271;outline-offset:2px}
.giorni{display:flex;gap:8px;overflow-x:auto;padding:4px 2px 10px;margin-bottom:14px;scrollbar-width:thin}
.giorno{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:74px;border-radius:12px;padding:9px 10px}
.giorno b{font:800 17px/1 'Mazzard',sans-serif} .giorno small{font-size:11.5px;opacity:.8} .giorno i{font-style:normal;font-size:11px;opacity:.75}
.cerca{width:100%;background:#24262C;border:1px solid rgba(255,255,255,.16);color:#F2F2F3;border-radius:10px;padding:12px 14px;font:inherit;margin-bottom:18px}
.cerca:focus{outline:none;border-color:#C9A24B}
/* le persone */
.persona{background:#24262C;border:1px solid rgba(255,255,255,.09);border-radius:14px;margin-bottom:12px;overflow:hidden}
.persona[open]{border-color:rgba(201,162,75,.45)}
.persona>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:16px;align-items:start;padding:16px 18px}
.persona>summary::-webkit-details-marker{display:none}
.av{width:46px;height:46px;border-radius:50%;background:#C9A24B;color:#10131c;display:grid;place-items:center;font:800 14px/1 'Mazzard',sans-serif}
.av.club{background:#5AA7E8} .av.tec{background:#8E9096}
.chi b{font-size:17px} .chi .mail{display:block;color:#B4B6BD;font-size:13.5px;margin-top:2px}
.ruolo{font:700 10px/1 'Mazzard',sans-serif;letter-spacing:.12em;text-transform:uppercase;border:1px solid rgba(255,255,255,.22);border-radius:4px;padding:3px 7px;margin-left:8px;color:#D8D9DD;vertical-align:2px;white-space:nowrap;display:inline-block}
.riass{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.stat{display:flex;gap:22px;text-align:right}
.stat div{font-size:12px;color:#A3A5AD;white-space:nowrap} .stat b{display:block;color:#F2F2F3;font-size:15px;font-variant-numeric:tabular-nums}
.dentro{color:#7FDCA9!important}
/* ONLINE ORA */
.periodo button.online{display:inline-flex;align-items:center;gap:8px;border-color:rgba(79,203,139,.55);color:#BFF0D5}
.periodo button.online b{background:rgba(79,203,139,.22);border-radius:999px;padding:2px 8px;font-size:12.5px;color:#DFF8EA}
.periodo button.online.on{background:#4FCB8B;border-color:#4FCB8B;color:#0E2418} .periodo button.online.on b{background:rgba(14,36,24,.18);color:#0E2418}
.pallino{width:9px;height:9px;border-radius:50%;background:#4FCB8B;box-shadow:0 0 0 0 rgba(79,203,139,.6);animation:batte 2s infinite}
.periodo button.online.on .pallino{background:#0E2418}
.sep{width:1px;height:22px;background:rgba(255,255,255,.14);margin:0 2px}
@keyframes batte{0%{box-shadow:0 0 0 0 rgba(79,203,139,.55)}70%{box-shadow:0 0 0 8px rgba(79,203,139,0)}100%{box-shadow:0 0 0 0 rgba(79,203,139,0)}}
@media (prefers-reduced-motion:reduce){.pallino{animation:none}}
.modo-online .viste{display:none}
.on-grup{font:700 12px/1 'Mazzard',sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#7FDCA9;margin:6px 0 12px}
.on-grup.poco{color:#A3A5AD;margin-top:26px}
.on-griglia{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,400px),1fr));gap:12px}
.on-pers{background:#24262C;border:1px solid rgba(79,203,139,.35);border-radius:14px;padding:16px 18px;display:grid;grid-template-columns:46px minmax(0,1fr);gap:4px 14px}
.on-pers.aperto{border-color:rgba(227,194,113,.35)} .on-pers.poco{border-color:rgba(255,255,255,.09)}
.on-pers .av{grid-row:span 2;position:relative} .on-pers .av::after{content:"";position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;background:#4FCB8B;border:3px solid #24262C}
.on-pers.aperto .av::after{background:#E3C271} .on-pers.poco .av::after{background:#8E9096}
.on-stato{font-size:13px;color:#B4B6BD;margin-top:4px} .on-stato b{color:#7FDCA9;font-weight:600} .on-pers.aperto .on-stato b{color:#E3C271} .on-pers.poco .on-stato b{color:#D8D9DD}
.on-schede{grid-column:1/-1;list-style:none;margin-top:10px;display:flex;flex-direction:column;gap:6px}
.on-schede li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline;background:#1D1F24;border-radius:9px;padding:9px 12px;font-size:14px}
.on-schede li small{display:block;color:#9EA0A8;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.on-schede .dove{font-size:12px;color:#A3A5AD;white-space:nowrap} .on-schede li.davanti .dove{color:#7FDCA9}
.on-ult{grid-column:1/-1;color:#A3A5AD;font-size:13px;margin-top:8px}
.on-vai{grid-column:1/-1;justify-self:start;margin-top:8px;background:none;border:0;color:#E3C271;font:inherit;font-size:13.5px;cursor:pointer;padding:0}
.on-vai:focus-visible{outline:2px solid #E3C271;outline-offset:3px}
.chip{display:inline-flex;align-items:center;gap:5px;background:rgba(245,241,230,.08);border-radius:999px;padding:5px 11px;font-size:13px;white-space:nowrap}
.chip b{color:#E3C271} .chip.file{background:rgba(90,167,232,.18)} .chip.entra{background:rgba(79,203,139,.16)} .chip.esce{background:rgba(142,144,150,.18)}
.sessioni{padding:4px 18px 16px 82px}
.sess{padding:14px 0;border-top:1px solid rgba(255,255,255,.07)}
.sess-t{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:10px}
.sess-t .d{font:800 18px/1 'Mazzard',sans-serif;color:#E3C271} .sess-t span{color:#B4B6BD;font-size:13.5px}
.passi{list-style:none;border-left:2px solid rgba(201,162,75,.35);margin-left:6px}
.passi li{position:relative;padding:5px 0 5px 18px;font-size:14px}
.passi li::before{content:"";position:absolute;left:-6px;top:12px;width:10px;height:10px;border-radius:50%;background:#2E3037;border:2px solid #C9A24B}
.passi li.file::before{border-color:#5AA7E8} .passi li.entra::before{border-color:#4FCB8B} .passi li.esce::before{border-color:#8E9096}
.passi .ora{display:inline-block;width:52px;color:#A3A5AD;font-variant-numeric:tabular-nums}
.passi b{color:#E3C271;margin-left:4px} .passi .det{display:block;margin-left:52px;color:#9EA0A8;font-size:12.5px;word-break:break-all}
.altri{background:none;border:0;color:#E3C271;font:inherit;font-size:13.5px;cursor:pointer;padding:6px 0 0 18px}
/* la cronologia */
.cron h3{font:700 12px/1 'Mazzard',sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#C9A24B;margin:22px 0 10px}
.riga{display:grid;grid-template-columns:60px 220px minmax(0,1fr);gap:14px;padding:9px 12px;border-radius:8px;align-items:baseline}
.riga:nth-child(odd){background:#1F2025}
.riga .ora{color:#A3A5AD;font-variant-numeric:tabular-nums} .riga .nome{font-weight:600} .riga .cosa b{color:#E3C271} .riga .cosa small{display:block;color:#9EA0A8;font-size:12.5px;word-break:break-all}
h2{font:700 12px/1 'Mazzard',sans-serif;letter-spacing:.2em;text-transform:uppercase;color:#C9A24B;margin:30px 0 12px}
.rif{width:100%;border-collapse:collapse;font-size:14px;background:#24262C;border-radius:12px;overflow:hidden}
.rif td{padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.06)} .rif td.q{color:#A3A5AD;white-space:nowrap}
.nota{color:#A3A5AD;font-size:13px;margin-top:16px;max-width:900px}
@media (max-width:820px){.persona>summary{grid-template-columns:44px 1fr}.stat{grid-column:1/-1;justify-content:flex-start;text-align:left}.sessioni{padding-left:18px}.riga{grid-template-columns:52px 1fr}.riga .cosa{grid-column:1/-1}}
</style></head><body>
<nav class="ms-bar"></nav><script src="/como-tv/live/menu-sito.js"></script><script src="/como-tv/live/utente.js" async></script>
<div class="pagina">
<div class="testa"><h1>Registro di controllo</h1><span id="conto"></span>
 <div class="viste" role="tablist"><button id="vPers" class="on" role="tab">Persone</button><button id="vCron" role="tab">Cronologia</button></div></div>
<div class="periodo" id="periodo">
 <button data-p="online" class="online"><span class="pallino" aria-hidden="true"></span>Online ora <b id="nOn">…</b></button><span class="sep" aria-hidden="true"></span>
 <button data-p="oggi">Oggi</button><button data-p="ieri">Ieri</button><button data-p="7">Ultimi 7 giorni</button><button data-p="30">Ultimi 30 giorni</button><button data-p="tutto">Tutto</button>
</div>
<div class="giorni" id="giorni" aria-label="Giorni con attività"></div>
<input class="cerca" id="f" type="search" placeholder="Cerca una persona, una mail, una pagina o un file">
<div id="corpo"><p class="nota">Carico…</p></div>
<h2>Accessi rifiutati e blocchi</h2><div id="rifiuti" style="overflow-x:auto"></div>
<p class="nota">Una sessione va dall'entrata all'ultima cosa fatta (o all'uscita); una pausa di più di mezz'ora ne apre un'altra. "Dentro adesso" = attivo negli ultimi 15 minuti senza essere uscito. Miniature, copertine e indici non si contano. "Online ora" = una pagina aperta che ha dato segno di vita negli ultimi 3 minuti (le pagine col menù lo mandano ogni minuto), più chi ha fatto qualcosa negli ultimi 10 minuti su pagine senza menù; si aggiorna da solo ogni 30 secondi. Ultimi <span id="gg"></span> giorni.</p>
</div>
<script>
var D=null,ON=null,ONLINE=false,VISTA="persone",DA="",A="",$=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function ini(n){return n.replace(/\(.*\)/,"").split(/\s+/).filter(Boolean).map(function(w){return w[0]}).slice(0,2).join("").toUpperCase()}
function dur(s){if(s<60)return"meno di 1 min";var h=Math.floor(s/3600),m=Math.round(s%3600/60);if(m===60){h++;m=0}return h?h+" h"+(m?" "+m+" min":""):m+" min"}
function dt(q){return q.slice(8,10)+"/"+q.slice(5,7)+"/"+q.slice(0,4)} function ora(q){return q.slice(11,16)}
function iso(d){return d.getFullYear()+"-"+("0"+(d.getMonth()+1)).slice(-2)+"-"+("0"+d.getDate()).slice(-2)}
var GG=["dom","lun","mar","mer","gio","ven","sab"],MM=["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
function giornoBello(g){var d=new Date(g+"T12:00:00"),oggi=iso(new Date()),ieri=iso(new Date(Date.now()-864e5));return g===oggi?"Oggi":g===ieri?"Ieri":GG[d.getDay()]+" "+d.getDate()+" "+MM[d.getMonth()]}
var RUOLI={admin:"super utente",staff:"Como TV",club:"Como 1907"};
function cl(v){return /originale|copia/.test(v)?"file":v.indexOf("entra")===0?"entra":v==="esce"?"esce":""}
function nel(x){var g=x.inizio.slice(0,10);return(!DA||g>=DA)&&(!A||g<=A)}
function periodo(p){
 ONLINE=p==="online";document.body.classList.toggle("modo-online",ONLINE);
 if(ONLINE){segnaTasti(p);if(ON)disegna();caricaOnline();return}
 var oggi=new Date();
 if(p==="oggi"){DA=A=iso(oggi)} else if(p==="ieri"){DA=A=iso(new Date(Date.now()-864e5))}
 else if(p==="tutto"){DA=A=""} else {DA=iso(new Date(Date.now()-(+p-1)*864e5));A=iso(oggi)}
 segnaTasti(p); disegna();
}
function segnaTasti(p){[].forEach.call(document.querySelectorAll("#periodo button"),function(b){b.classList.toggle("on",b.dataset.p===p)});
 [].forEach.call(document.querySelectorAll(".giorno"),function(b){b.classList.toggle("on",!p&&DA===b.dataset.g&&A===b.dataset.g)})}
function giorni(){
 var per={};D.persone.forEach(function(u){u.sessioni.forEach(function(x){var g=x.inizio.slice(0,10);(per[g]=per[g]||{})[u.email]=1})});
 $("giorni").innerHTML=Object.keys(per).sort().reverse().map(function(g){var n=Object.keys(per[g]).length;return'<button class="giorno" data-g="'+g+'"><small>'+esc(giornoBello(g))+'</small><b>'+g.slice(8,10)+'</b><i>'+n+(n===1?" persona":" persone")+'</i></button>'}).join("");
}
function testoDi(u,ss){return(u.nome+" "+u.email+" "+ss.map(function(x){return x.seq.map(function(z){return z.v+" "+z.d.join(" ")}).join(" ")}).join(" ")).toLowerCase()}
function passi(x,tutti){
 var s=x.seq,max=tutti?s.length:12;
 return'<ul class="passi">'+s.slice(0,max).map(function(z){return'<li class="'+cl(z.v)+'"><span class="ora">'+z.q+'</span>'+esc(z.v)+(z.n>1?'<b>×'+z.n+'</b>':'')+(z.d.length?'<span class="det">'+esc(z.d.slice(0,3).join(" · "))+'</span>':'')+'</li>'}).join("")+'</ul>'+
  (s.length>max?'<button class="altri" data-tutti="1">Mostra tutti i '+s.length+' passi</button>':'');
}
function disegnaPersone(f){
 var tot=0,h=D.persone.map(function(u,ui){
  var ss=u.sessioni.filter(nel); if(!ss.length)return"";
  if(f&&testoDi(u,ss).indexOf(f)<0)return""; tot++;
  var tempo=ss.reduce(function(t,x){return t+x.durata},0),dentro=ss.some(function(x){return x.dentro}),tec=/accesso tecnico/.test(u.nome);
  var som={};ss.forEach(function(x){x.azioni.forEach(function(z){if(z.v==="entra"||z.v==="esce")return;som[z.v]=(som[z.v]||0)+z.n})});
  var top=Object.keys(som).sort(function(a,b){return som[b]-som[a]}).slice(0,6);
  return'<details class="persona" data-u="'+ui+'"><summary><span class="av '+(tec?"tec":u.ruolo==="club"?"club":"")+'">'+esc(ini(u.nome))+'</span>'+
   '<span class="chi"><b>'+esc(u.nome)+'</b><span class="ruolo">'+esc(RUOLI[u.ruolo]||u.ruolo)+'</span><span class="mail">'+esc(u.email)+'</span>'+
   '<span class="riass">'+(top.length?top.map(function(v){return'<span class="chip '+cl(v)+'">'+esc(v)+(som[v]>1?'<b>×'+som[v]+'</b>':'')+'</span>'}).join(""):'<span class="chip">solo entrato</span>')+'</span></span>'+
   '<span class="stat"><div><b'+(dentro?' class="dentro"':'')+'>'+(dentro?"dentro adesso":dt(u.ultimo)+" "+ora(u.ultimo))+'</b>ultima attività</div><div><b>'+ss.length+'</b>'+(ss.length===1?"sessione":"sessioni")+'</div><div><b>'+dur(tempo)+'</b>tempo in tutto</div></span></summary>'+
   '<div class="sessioni">'+ss.map(function(x,xi){return'<div class="sess" data-x="'+xi+'"><div class="sess-t"><span class="d">'+(x.dentro?'<span class="dentro">in corso</span>':dur(x.durata))+'</span><span>'+dt(x.inizio)+' · dalle '+ora(x.inizio)+' alle '+ora(x.fine)+' · '+(x.chiusa?"uscito con Esci":x.dentro?"dentro adesso":"finita per inattività")+(x.ip.length?' · '+esc(x.ip.join(", ")):'')+'</span></div>'+passi(x,false)+'</div>'}).join("")+'</div></details>';
 }).join("");
 $("corpo").innerHTML=h||'<p class="nota">Nessuno in questo periodo.</p>'; return tot;
}
function disegnaCron(f){
 var righe=[];
 D.persone.forEach(function(u){u.sessioni.filter(nel).forEach(function(x){var g=x.inizio.slice(0,10);x.seq.forEach(function(z){righe.push({g:g,q:z.q,u:u,z:z})})})});
 if(f)righe=righe.filter(function(r){return(r.u.nome+" "+r.u.email+" "+r.z.v+" "+r.z.d.join(" ")).toLowerCase().indexOf(f)>=0});
 righe.sort(function(a,b){return(b.g+b.q).localeCompare(a.g+a.q)});
 var h="",ultimo="",pers={};
 righe.slice(0,1500).forEach(function(r){pers[r.u.email]=1;if(r.g!==ultimo){h+=(ultimo?"</div>":"")+'<h3>'+esc(giornoBello(r.g))+" · "+dt(r.g+"T")+'</h3><div>';ultimo=r.g}
  h+='<div class="riga"><span class="ora">'+r.q+'</span><span class="nome">'+esc(r.u.nome)+'</span><span class="cosa">'+esc(r.z.v)+(r.z.n>1?'<b> ×'+r.z.n+'</b>':'')+(r.z.d.length?'<small>'+esc(r.z.d.slice(0,3).join(" · "))+'</small>':'')+'</span></div>'});
 $("corpo").innerHTML=h?'<div class="cron">'+h+'</div></div>':'<p class="nota">Niente in questo periodo.</p>';
 return Object.keys(pers).length;
}
function fa(s){return s<60?"adesso":dur(s)+" fa"}
function schedaOn(u,ui){
 var cls=u.stato==="davanti"?"":u.stato==="aperto"?" aperto":" poco",tec=/accesso tecnico/.test(u.nome);
 var st=u.stato==="davanti"?"<b>Sta usando il sito</b>":u.stato==="aperto"?"<b>Pagina aperta in un'altra scheda</b>":"<b>Attivo da poco</b>";
 if(u.schede.length)st+=" · da "+dur(u.dal); else if(u.log)st+=" · ultima azione "+fa(u.log.fa);
 return'<div class="on-pers'+cls+'"><span class="av '+(tec?"tec":u.ruolo==="club"?"club":"")+'">'+esc(ini(u.nome))+'</span>'+
  '<span class="chi"><b>'+esc(u.nome)+'</b><span class="ruolo">'+esc(RUOLI[u.ruolo]||u.ruolo)+'</span><span class="mail">'+esc(u.email)+'</span></span>'+
  '<span class="on-stato">'+st+'</span>'+
  (u.schede.length?'<ul class="on-schede">'+u.schede.map(function(x){return'<li class="'+(x.davanti?"davanti":"")+'"><span>'+esc(x.pagina)+(x.titolo&&x.titolo!==x.pagina?'<small>'+esc(x.titolo)+'</small>':'')+'</span><span class="dove">'+(x.davanti?"davanti ora":"in secondo piano")+'</span></li>'}).join("")+'</ul>':'')+
  (u.log?'<span class="on-ult">Ultima azione: '+esc(u.log.cosa)+' · '+fa(u.log.fa)+'</span>':'')+
  '<button class="on-vai" data-mail="'+esc(u.email)+'">Cosa ha fatto oggi →</button></div>';
}
function disegnaOnline(f){
 var tutti=(ON?ON.presenti:[]).filter(function(u){return!f||(u.nome+" "+u.email+" "+u.schede.map(function(x){return x.pagina+" "+x.titolo}).join(" ")+" "+(u.log?u.log.cosa:"")).toLowerCase().indexOf(f)>=0});
 var den=tutti.filter(function(u){return u.stato!=="da poco"}),poco=tutti.filter(function(u){return u.stato==="da poco"});
 $("corpo").innerHTML=!ON?'<p class="nota">Carico…</p>':
  (den.length?'<div class="on-grup">Dentro adesso</div><div class="on-griglia">'+den.map(schedaOn).join("")+'</div>':'<p class="nota">In questo momento non c’è nessuno con una pagina aperta.</p>')+
  (poco.length?'<div class="on-grup poco">Attivi negli ultimi 10 minuti</div><div class="on-griglia">'+poco.map(schedaOn).join("")+'</div>':'');
 return den.length;
}
function caricaOnline(){
 return fetch("/auth/presenti.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
  ON=j;var n=j.presenti.filter(function(u){return u.stato!=="da poco"}).length;$("nOn").textContent=n;
  if(ONLINE)disegna();
 }).catch(function(){});
}
function disegna(){
 var f=$("f").value.toLowerCase();
 if(ONLINE){var k=disegnaOnline(f);$("conto").textContent=k+(k===1?" persona dentro":" persone dentro")+(ON?" · aggiornato alle "+ON.ora.slice(0,5):"");return}
 var n=VISTA==="persone"?disegnaPersone(f):disegnaCron(f);$("conto").textContent=n+(n===1?" persona":" persone")+(DA?(DA===A?" · "+giornoBello(DA):" · dal "+dt(DA+"T")+" al "+dt(A+"T")):" · tutto il periodo")}
$("periodo").addEventListener("click",function(e){var b=e.target.closest("button");if(b)periodo(b.dataset.p)});
$("giorni").addEventListener("click",function(e){var b=e.target.closest(".giorno");if(!b)return;ONLINE=false;document.body.classList.remove("modo-online");DA=A=b.dataset.g;segnaTasti("");disegna()});
$("corpo").addEventListener("click",function(e){var v=e.target.closest(".on-vai");if(v){$("f").value=v.dataset.mail;periodo("oggi");return}var b=e.target.closest(".altri");if(!b)return;var s=b.closest(".sess"),p=b.closest(".persona"),u=D.persone[+p.dataset.u],x=u.sessioni.filter(nel)[+s.dataset.x];b.previousElementSibling.outerHTML=passi(x,true).replace(/<button[\s\S]*$/,"");b.remove()});
$("vPers").onclick=function(){VISTA="persone";this.classList.add("on");$("vCron").classList.remove("on");disegna()};
$("vCron").onclick=function(){VISTA="cron";this.classList.add("on");$("vPers").classList.remove("on");disegna()};
$("f").addEventListener("input",disegna);
fetch("/auth/registro.json",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
 D=j;$("gg").textContent=j.giorni;giorni();
 $("rifiuti").innerHTML=j.rifiuti.length?'<table class="rif">'+j.rifiuti.map(function(r){return"<tr><td class=q>"+dt(r.q)+" "+ora(r.q)+"</td><td>"+esc(r.chi||"—")+"</td><td>"+esc(r.az)+"</td><td class=q>"+esc(r.ip)+"</td></tr>"}).join("")+"</table>":'<p class="nota">Nessuno.</p>';
 periodo("oggi");
});
caricaOnline();setInterval(caricaOnline,30000);
document.addEventListener("visibilitychange",function(){if(!document.hidden)caricaOnline()});
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
<h2>A cosa servono</h2><p>A decidere chi può entrare e a registrare chi fa cosa negli strumenti (accessi, aperture, download, montaggi, invii) e quali pagine sono aperte in quel momento, per sicurezza e per il lavoro della redazione.</p>
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
        if u.path in ("/auth/registro", "/auth/registro.json", "/auth/presenti.json"):
            email = sessione_valida(self.cookie())
            if not email: return self.manda(302, extra=[("Location", "/auth/entra?torna=/auth/registro")])
            if email not in super_utenti(): return self.manda(403, "Il registro lo vede solo il super utente.")
            if u.path == "/auth/presenti.json": return self.manda(200, json.dumps(presenti(), ensure_ascii=False), "application/json; charset=utf-8")
            if u.path.endswith(".json"): return self.manda(200, json.dumps(registro(), ensure_ascii=False), "application/json; charset=utf-8")
            return self.manda(200, REGISTRO_HTML, "text/html; charset=utf-8")
        if u.path == "/auth/tecnico":
            return self.manda(200, TECNICO.replace("__TORNA__", html.escape(torna)).replace("__ERRORE__", ""), "text/html; charset=utf-8")
        if u.path == "/auth/privacy":
            return self.manda(200, PRIVACY, "text/html; charset=utf-8")
        if u.path == "/auth/esci":
            chi = sessione_valida(self.cookie()); PRESENTI.pop(chi, None)
            registra("esce", chi, self.ip())
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
    if u.path == "/auth/presente":
        email = sessione_valida(self.cookie()); n = int(self.headers.get("Content-Length") or 0)
        if not email: return self.manda(401)
        try: presente(email, self.ip(), json.loads(self.rfile.read(min(n, 4096)).decode()) if 0 < n <= 4096 else {})
        except Exception: return self.manda(400)
        return self.manda(204)
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
