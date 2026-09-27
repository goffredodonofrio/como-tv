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
La sessione e' un cookie firmato (HMAC) che dura 30 giorni. Gli accessi finiscono
in /var/lib/comotv-accesso/accessi.jsonl (chi, quando, da dove).

Configurazione in /etc/comotv/accesso.env (mai nel repo):
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   dal client OAuth "Applicazione web"
  ACCESSO_DOMINI=sent.tv,comofootball.com
La chiave delle sessioni si crea da sola in /etc/comotv/accesso.chiave.
Gli indirizzi singoli ammessi (collaboratori con la mail personale) stanno in
/etc/comotv/accesso-autorizzati.txt, uno per riga.
"""
import base64, hashlib, hmac, html, json, os, secrets, time, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = "/etc/comotv/accesso.env"
CHIAVE = "/etc/comotv/accesso.chiave"
AUTORIZZATI = "/etc/comotv/accesso-autorizzati.txt"
REGISTRO = "/var/lib/comotv-accesso/accessi.jsonl"
SITO = os.environ.get("ACCESSO_SITO", "https://projects-cloud.it")
RITORNO = SITO + "/auth/google/fatto"
COOKIE = "comotv_sessione"
DURATA = 30 * 86400


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


def sessione_nuova(email):
    corpo = b64(json.dumps({"e": email, "s": int(time.time()) + DURATA}))
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


def ammesso(email, hd=None):
    email = (email or "").lower()
    domini = [d.strip().lower() for d in conf().get("ACCESSO_DOMINI", "sent.tv,comofootball.com").split(",") if d.strip()]
    dominio = email.rsplit("@", 1)[-1]
    if email in autorizzati(): return True
    # per i domini aziendali Google mette "hd": deve tornare anche quello
    return dominio in domini and (hd is None or (hd or "").lower() == dominio)


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
</style></head><body><main class="box">
<img src="/loghi/como-tv-logo.png" alt="Como TV">
<h1>Accedi a Como TV</h1>
__ERRORE__
<p>Con il tuo account Google di lavoro: <b>@sent.tv</b> o <b>@comofootball.com</b>.</p>
<a class="g" href="/auth/google?torna=__TORNA__"><svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.3 5.7c4.3-4 7-9.9 7-17.2z"/><path fill="#FBBC05" d="M10.6 28.5c-.5-1.4-.8-2.9-.8-4.5s.3-3.1.8-4.5l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2.2 1.5-5 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>Accedi con Google</a>
<p>Ogni azione viene registrata con la tua mail.</p>
</main></body></html>"""


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
        h = PAGINA.replace("__TORNA__", urllib.parse.quote(torna, safe="")).replace("__ERRORE__", '<p class="err">' + html.escape(errore) + "</p>" if errore else "")
        self.manda(200, h, "text/html; charset=utf-8")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        torna = torna_sicuro((q.get("torna") or [""])[0])
        if u.path == "/auth/verifica":
            email = sessione_valida(self.cookie())
            return self.manda(200, b"", extra=[("X-Utente", email)]) if email else self.manda(401)
        if u.path == "/auth/chi":
            email = sessione_valida(self.cookie())
            return self.manda(200, json.dumps({"email": email or ""}), "application/json")
        if u.path == "/auth/entra":
            return self.pagina(torna)
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
                                          ("Set-Cookie", COOKIE + "=" + sessione_nuova(email) + "; Path=/; Max-Age=%d; Secure; HttpOnly; SameSite=Lax" % DURATA)])
        return self.manda(404)


if __name__ == "__main__":
    chiave()
    ThreadingHTTPServer(("127.0.0.1", 8098), H).serve_forever()
