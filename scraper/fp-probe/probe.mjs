/** CZYSTY TEST (aktywacja STOP): czy to fingerprint? Łap świeży patchright fp, porównaj na świeżych IP:
 *  OLX_FP(walony dziś) vs patchright-świeży vs losowy-784. Każdy na osobnym świeżym IP (1 reveal). */
import { chromium } from 'patchright';
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const OLXFP = JSON.parse(process.env.OLX_FP).x_fingerprint;
const PROXY = process.env.IPROYAL_PROXY;
const [, PU, PP, PH, PT] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const b62 = (s) => { let n = 0n; for (const c of s) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const ads = '1b3trF,1aCSae,1bqIpP,1bqJhT,F6ZkE,1bqLfJ,1b0M5y,1bk5zl,1aU2dQ,19kB0P,1b3rkn,1aRTnI'.split(',').map(b62);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });
const randHex = (n) => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[(Math.random() * 16) | 0]; return s; };
async function ipOf(a) { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(10000) }); return (await r.json()).ip; } catch { return null; } }
async function reveal(adId, agent, fp) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null); if (!chj?.context) return { s: 'net' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null); if (!exj?.token) return { s: 'net' };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher: agent, signal: AbortSignal.timeout(15000), headers: { 'friction-token': exj.token, 'x-fingerprint': fp, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => ''); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { s: 'ok', phone: j.data.phones[0] };
    const d = j?.error?.detail || (lp.status + '');
    if (/not active|not found/i.test(d)) return { s: 'dead' };
    if (/disallowed/i.test(d)) return { s: 'throttle' };
    return { s: 'other', d };
  } catch { return { s: 'net' }; }
}
async function capture() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
    const page = await ctx.newPage(); let fp = null;
    page.on('request', (r) => { const h = r.headers(); if (h['x-fingerprint'] && !fp) fp = h['x-fingerprint']; });
    await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    await page.goto('https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Border%5D=created_at:desc', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 15000 }).catch(() => {});
    const url = await page.evaluate(() => ([...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).find((h) => /organic/.test(h)) || ''));
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 30 && !fp; i++) await sleep(500);
    return fp;
  } finally { await browser.close().catch(() => {}); }
}

const CAP = await capture();
console.log('OLX_FP     :', OLXFP.slice(0, 16), '...', OLXFP.slice(-12));
console.log('patchright :', CAP ? CAP.slice(0, 16) + ' ... ' + CAP.slice(-12) : 'BRAK', '| różny od OLX_FP?', CAP !== OLXFP);
console.log('');
const tests = [['OLX_FP (walony dziś)', OLXFP], ['patchright świeży', CAP], ['losowy-784', randHex(784)]];
let adi = 0;
for (const [name, fp] of tests) {
  if (!fp) { console.log(name, '— brak fp, pomijam'); continue; }
  let ok = 0, thr = 0, dead = 0, oth = 0; const marks = [];
  for (let i = 0; i < 4; i++) {
    const agent = newAgent(); await ipOf(agent);
    const r = await reveal(ads[adi++ % ads.length], agent, fp);
    if (r.s === 'ok') { ok++; marks.push('✅'); } else if (r.s === 'throttle') { thr++; marks.push('⏳'); } else if (r.s === 'dead') { dead++; marks.push('⊘'); } else { oth++; marks.push('·'); }
    await sleep(1500);
  }
  console.log(`${name.padEnd(22)} ${marks.join('')} → ✅${ok} ⏳${thr} ⊘${dead} inne${oth} (4 świeże IP)`);
}
console.log('\nWERDYKT:');
console.log('  patchright/losowy dają ✅ a OLX_FP ⏳ → FINGERPRINT oflagowany → rotacja fingerprintów = fix ✅');
console.log('  wszystkie ⏳ → to NIE fingerprint (globalny/konto/pula) → rotacja nie pomoże');
console.log('  wszystkie ✅ → to był tylko ruch aktywacji (rate) → wystarczy wolniej/mniej równolegle');
