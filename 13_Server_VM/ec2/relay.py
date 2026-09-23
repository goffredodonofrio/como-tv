#!/usr/bin/env python3
# Il ponte verso S3: legge il secchio a intervalli (in regione, gratis) e lo
# passa alla VM contando ogni byte. Sopra il tetto mensile dice di no.
import json, os, re, sys, time, threading, datetime, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import boto3
from botocore.exceptions import ClientError
BUCKET = os.environ.get('RELAY_BUCKET', 'mola-italy-como-archive')
REGIONE = os.environ.get('RELAY_REGIONE', 'eu-west-3')
TETTO_MESE = int(float(os.environ.get('RELAY_TETTO_GB', '80')) * 1e9)
TETTO_GIORNO = int(float(os.environ.get('RELAY_TETTO_GIORNO_GB', '4')) * 1e9)
CONTO = os.path.expanduser('~/relay/conto.json')
s3 = boto3.client('s3', region_name=REGIONE)
lock = threading.Lock()
def leggi_conto():
    try: return json.load(open(CONTO))
    except Exception: return {}
def segna(n):
    with lock:
        c = leggi_conto(); oggi = datetime.date.today().isoformat(); mese = oggi[:7]
        c.setdefault('mesi', {}); c.setdefault('giorni', {})
        c['mesi'][mese] = c['mesi'].get(mese, 0) + n
        c['giorni'][oggi] = c['giorni'].get(oggi, 0) + n
        c['giorni'] = dict(sorted(c['giorni'].items())[-40:])
        c['richieste'] = c.get('richieste', 0) + (1 if n == 0 else 0)
        json.dump(c, open(CONTO, 'w'))
def usato():
    c = leggi_conto(); oggi = datetime.date.today().isoformat()
    return c.get('mesi', {}).get(oggi[:7], 0), c.get('giorni', {}).get(oggi, 0)
class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, f, *a): sys.stderr.write('%s %s\n' % (self.address_string(), f % a))
    def _json(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def _chiave(self):
        u = urllib.parse.urlparse(self.path)
        if not u.path.startswith('/o/'): return None, u
        return urllib.parse.unquote(u.path[3:]), u
    def do_GET(self): self._servi(False)
    def do_HEAD(self): self._servi(True)
    def _servi(self, solo_testa):
        chiave, u = self._chiave()
        if u.path == '/conto':
            m, g = usato(); return self._json(200, {'ok': True, 'mese_byte': m, 'giorno_byte': g, 'tetto_mese_byte': TETTO_MESE, 'tetto_giorno_byte': TETTO_GIORNO, 'bucket': BUCKET, 'regione': REGIONE})
        if u.path == '/rms':
            # IL LIVELLO DELL'AUDIO, SECONDO PER SECONDO, CALCOLATO QUI. Serve
            # a trovare il boato che inchioda il secondo del gol. Se lo
            # facesse la VM dovrebbe tirarsi giu' tre minuti di video, cioe'
            # centocinquanta mega per una sola azione; qui ffmpeg legge in
            # regione (gratis) e parte una lista di numeri: un kilobyte.
            q = urllib.parse.parse_qs(u.query)
            k = urllib.parse.unquote(q.get('k', [''])[0])
            da = float(q.get('da', ['0'])[0]); dur = float(q.get('dur', ['180'])[0])
            if not k: return self._json(400, {'ok': False, 'errore': 'manca la chiave'})
            if dur <= 0 or dur > 7200: return self._json(400, {'ok': False, 'errore': 'finestra fuori misura'})
            import subprocess, re as _re
            url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': k}, ExpiresIn=900)
            cmd = ['ffmpeg', '-hide_banner', '-nostdin', '-ss', '%.3f' % max(0.0, da), '-t', '%.3f' % dur,
                   '-i', url, '-vn', '-af',
                   'aresample=8000,asetnsamples=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
                   '-f', 'null', '-']
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=900)
            except subprocess.TimeoutExpired:
                return self._json(504, {'ok': False, 'errore': 'ffmpeg troppo lento'})
            testo = (r.stdout or b'').decode('utf8', 'ignore')
            db = [(-90.0 if x == '-inf' else float(x)) for x in _re.findall(r'RMS_level=(-?[0-9.]+|-inf)', testo)]
            if not db:
                return self._json(502, {'ok': False, 'errore': (r.stderr or b'')[-200:].decode('utf8', 'ignore')})
            segna(0)
            return self._json(200, {'ok': True, 'db': db})
        if u.path == '/dur':
            # LA DURATA, MISURATA QUI. ffprobe legge l'indice del file dentro
            # la regione del secchio (gratis) e alla VM parte un numero. Senza
            # la durata vera il riconoscimento tira a indovinare due ore e
            # guarda i fotogrammi nei posti sbagliati.
            q = urllib.parse.parse_qs(u.query)
            k = urllib.parse.unquote(q.get('k', [''])[0])
            if not k: return self._json(400, {'ok': False, 'errore': 'manca la chiave'})
            import subprocess
            url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': k}, ExpiresIn=600)
            try:
                r = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url], capture_output=True, timeout=180)
            except subprocess.TimeoutExpired:
                return self._json(504, {'ok': False, 'errore': 'ffprobe troppo lento'})
            try:
                sec = float((r.stdout or b'').decode().strip())
            except Exception:
                return self._json(502, {'ok': False, 'errore': (r.stderr or b'')[-200:].decode('utf8', 'ignore')})
            segna(0)
            return self._json(200, {'ok': True, 'secondi': round(sec, 2)})
        if u.path == '/f':
            # UN FOTOGRAMMA, ESTRATTO QUI. ffmpeg legge S3 nella stessa regione
            # (gratis) e alla VM parte solo il JPEG: cento kB invece dei sette
            # mega che costa leggere l'indice e il GOP da fuori.
            q = urllib.parse.parse_qs(u.query)
            k = urllib.parse.unquote(q.get('k', [''])[0]); t = float(q.get('t', ['0'])[0]); w = int(q.get('w', ['1280'])[0]); qual = int(q.get('q', ['4'])[0])
            if not k: return self._json(400, {'ok': False, 'errore': 'manca la chiave'})
            m2, g2 = usato()
            if m2 >= TETTO_MESE or g2 >= TETTO_GIORNO: return self._json(429, {'ok': False, 'errore': 'tetto raggiunto'})
            import subprocess
            url = s3.generate_presigned_url('get_object', Params={'Bucket': BUCKET, 'Key': k}, ExpiresIn=600)
            vf = 'scale=%d:-2' % w
            if q.get('c', [''])[0] == 'top': vf = 'crop=iw:ih*0.25:0:0'      # la fascia alta: dove sta il cronometro
            fmt = 'png' if q.get('fmt', [''])[0] == 'png' else 'image2'
            cmd = ['ffmpeg', '-v', 'error', '-ss', '%.3f' % max(0.0, t), '-i', url, '-frames:v', '1', '-vf', vf] + ([] if fmt == 'png' else ['-q:v', str(qual)]) + ['-f', 'image2', '-c:v', 'png' if fmt == 'png' else 'mjpeg', 'pipe:1']
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=120)
            except subprocess.TimeoutExpired:
                return self._json(504, {'ok': False, 'errore': 'ffmpeg troppo lento'})
            if r.returncode != 0 or not r.stdout:
                return self._json(502, {'ok': False, 'errore': (r.stderr or b'')[-200:].decode('utf8', 'ignore')})
            self.send_response(200); self.send_header('Content-Type', 'image/png' if fmt == 'png' else 'image/jpeg'); self.send_header('Content-Length', str(len(r.stdout))); self.end_headers()
            if not solo_testa: self.wfile.write(r.stdout)
            segna(len(r.stdout)); return
        if chiave is None: return self._json(404, {'ok': False, 'errore': 'via sconosciuta'})
        m, g = usato()
        if m >= TETTO_MESE or g >= TETTO_GIORNO:
            return self._json(429, {'ok': False, 'errore': 'tetto raggiunto: %.1f GB questo mese, %.2f GB oggi' % (m / 1e9, g / 1e9)})
        rng = self.headers.get('Range')
        try:
            if solo_testa:
                h = s3.head_object(Bucket=BUCKET, Key=chiave)
                self.send_response(200); self.send_header('Content-Length', str(h['ContentLength'])); self.send_header('Accept-Ranges', 'bytes'); self.send_header('Content-Type', h.get('ContentType', 'video/mp4')); self.end_headers(); segna(0); return
            # a ffmpeg (e al browser) piace chiedere "da qui in poi" e leggere
            # avanti quanto pare: ogni richiesta si chiude a un tratto corto,
            # e se serve altro si richiede. Sono byte contati. Senza Range si
            # risponde comunque a tratti: un file intero non parte mai.
            TRATTO = int(os.environ.get('RELAY_TRATTO_MB', '2')) * 1024 * 1024
            args = {'Bucket': BUCKET, 'Key': chiave}
            a0, b0 = 0, None
            if rng:
                mm = re.match(r'bytes=(\d+)-(\d*)$', rng.strip())
                if mm:
                    a0 = int(mm.group(1)); b0 = int(mm.group(2)) if mm.group(2) else None
            if b0 is None or b0 - a0 + 1 > TRATTO * 8: b0 = a0 + TRATTO - 1
            rng = 'bytes=%d-%d' % (a0, b0)
            args['Range'] = rng
            o = s3.get_object(**args)
            code = 206
            self.send_response(code)
            self.send_header('Content-Type', o.get('ContentType', 'video/mp4')); self.send_header('Accept-Ranges', 'bytes')
            if 'ContentRange' in o: self.send_header('Content-Range', o['ContentRange'])
            self.send_header('Content-Length', str(o['ContentLength'])); self.end_headers()
            n = 0; corpo = o['Body']
            while True:
                pezzo = corpo.read(1 << 20)
                if not pezzo: break
                try: self.wfile.write(pezzo)
                except (BrokenPipeError, ConnectionResetError): break
                n += len(pezzo)
                if n - getattr(self, '_segnato', 0) >= (8 << 20): segna(n - getattr(self, '_segnato', 0)); self._segnato = n
            segna(n - getattr(self, '_segnato', 0)); self._segnato = 0
        except ClientError as e:
            code = e.response.get('ResponseMetadata', {}).get('HTTPStatusCode', 500)
            self._json(404 if code == 404 else 502, {'ok': False, 'errore': str(e)[:200]})
if __name__ == '__main__':
    porta = int(os.environ.get('RELAY_PORTA', '8095'))
    print('relay S3 su 127.0.0.1:%d, tetto %.0f GB/mese %.0f GB/giorno' % (porta, TETTO_MESE / 1e9, TETTO_GIORNO / 1e9), flush=True)
    ThreadingHTTPServer(('127.0.0.1', porta), H).serve_forever()
