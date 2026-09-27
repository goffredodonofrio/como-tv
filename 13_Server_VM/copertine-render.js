// COPERTINE-RENDER — compone le locandine 600x900 del MAM Como 1907 nello stile Como TV:
// fotogramma (da copertine-1907.py), sfumatura, logo, titolo, format. Gira sulla VM di
// notte con il Chrome dell'export grafiche; fa solo quelle che mancano. (Goffredo, 27/09/2026)
// node copertine-render.js <copertine.json> <cartella src> <cartella out>
const puppeteer = require('/opt/comotv-esporta/node_modules/puppeteer-core');
const CHROME = process.env.COMOTV_CHROME || '/opt/comotv-esporta/chrome/chrome-headless-shell/linux-153.0.8010.47/chrome-headless-shell-linux64/chrome-headless-shell';
const FONT = process.env.COMOTV_1907_FONT || '/opt/comotv/copertine-font';
const fs = require('fs'), path = require('path');
const [, , JSONF, SRC, OUT] = process.argv;
const logo = 'data:image/png;base64,' + fs.readFileSync('/var/lib/comotv/loghi/como-tv-logo.png').toString('base64');
const allura = 'data:font/woff2;base64,' + fs.readFileSync(path.join(FONT, 'Allura.woff2')).toString('base64');
const oswald = 'data:font/woff2;base64,' + fs.readFileSync(path.join(FONT, 'Oswald.woff2')).toString('base64');
const maz = 'data:font/ttf;base64,' + fs.readFileSync('/var/www/comotv/assets/fonts/MazzardM-ExtraBold.ttf').toString('base64');
const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function etichetta(v) {
  const coll = v.p.split('/')[0];
  const m = /(20\d\d)\s*-\s*(20)?(\d\d)/.exec(coll) || /(\d\d)\s*-\s*(\d\d)/.exec(coll);
  if (/pre-season/i.test(coll) && m) return 'Pre-season 20' + (m[1].length === 2 ? m[1] : m[1].slice(2)) + '/' + (m[3] || m[2]);
  if (/season/i.test(v.formato) && m) return 'Season ' + (m[1].length === 4 ? m[1] : '20' + m[1]) + '/' + (m[3] || m[2]);
  if (/academy/i.test(v.formato) && m) return 'Academy ' + m[1] + '/' + (m[3] || m[2]);
  return v.formato;
}
function pagina(v, img) {
  v = Object.assign({}, v, { formato: etichetta(v) });
  const t = v.titolo.toUpperCase(), lung = t.length;
  const fs = lung > 34 ? 38 : lung > 24 ? 46 : lung > 14 ? 54 : 64;
  const btt = /behind the team/i.test(v.formato);
  return `<!doctype html><html><head><meta charset="utf-8">
<style>@font-face{font-family:M;src:url(${maz})}@font-face{font-family:Allura;src:url(${allura})}@font-face{font-family:Oswald;src:url(${oswald})}
*{margin:0;padding:0;box-sizing:border-box}html,body{width:600px;height:900px;overflow:hidden;background:#0A0F24}
.bg{position:absolute;inset:0;background:url(${img}) center 40%/cover no-repeat}
.sf{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25) 0%,rgba(0,0,0,0) 22%,rgba(0,0,0,0) 48%,rgba(0,0,0,.72) 72%,#000 88%)}
.logo{position:absolute;top:26px;left:50%;transform:translateX(-50%);width:40px}
.giu{position:absolute;left:36px;right:36px;bottom:${btt ? 58 : 62}px;text-align:center;color:#fff}
h1{font:800 ${fs}px/1.02 M,sans-serif;letter-spacing:-.01em;text-wrap:balance}
.sotto{font:500 20px/1.3 Oswald,sans-serif;margin-top:10px;opacity:.9}
.f{margin-top:18px;font:400 38px/1 Allura,cursive}
.f.btt{font:500 22px/1 Oswald,sans-serif;letter-spacing:.02em}
</style></head><body><div class="bg"></div><div class="sf"></div><img class="logo" src="${logo}">
<div class="giu"><h1>${esc(t)}</h1>${v.sotto ? `<div class="sotto">${esc(v.sotto)}</div>` : ''}<div class="f${btt ? ' btt' : ''}">${btt ? '— ' + esc(v.formato) + ' —' : esc(v.formato)}</div></div></body></html>`;
}
(async () => {
  const J = JSON.parse(fs.readFileSync(JSONF, 'utf8')).copertine;
  // solo quelle che mancano: una locandina gia' composta non si rifa'
  const da = J.filter(v => !v.pronta && v.src && fs.existsSync(path.join(SRC, v.k + '.jpg')) && !fs.existsSync(path.join(OUT, v.k + '.jpg')));
  fs.mkdirSync(OUT, { recursive: true });
  if (!da.length) { console.log('composte 0 di 0'); return; }
  const br = await puppeteer.launch({ executablePath: CHROME, headless: 'shell', args: ['--no-sandbox'] });
  const p = await br.newPage(); await p.setViewport({ width: 600, height: 900 });
  let n = 0;
  for (const v of da) {
    const img = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(SRC, v.k + '.jpg')).toString('base64');
    await p.setContent(pagina(v, img), { waitUntil: 'load', timeout: 60000 });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(OUT, v.k + '.jpg'), type: 'jpeg', quality: 82 });
    n++;
  }
  console.log('composte', n, 'di', da.length);
  await br.close();
})();
