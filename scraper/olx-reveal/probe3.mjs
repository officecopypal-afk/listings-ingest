/** PROBE per-IP: 8 reveali przez JEDNO sticky IP. Jeśli throttle per-IP → ~6-7 OK potem "Disallowed".
 *  Potem świeże IP → znów działa. Loguje exit-IP każdej sesji. */
import { chromium } from 'patchright';
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SEARCH = 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decodeAd = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null;
}
async function captureFP() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
    const page = await ctx.newPage(); let cap = null;
    page.on('request', (r) => { const h = r.headers(); if (h['x-fingerprint'] && !cap) cap = { fp: h['x-fingerprint'], dev: h['x-device-id'] }; });
    await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 15000 }).catch(() => {});
    const url = await page.evaluate(() => ([...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).find((h) => /organic/.test(h)) || ''));
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    for (let i = 0; i < 30 && !cap; i++) await sleep(500);
    return cap;
  } finally { await browser.close().catch(() => {}); }
}
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
async function reveal(adId, fpStr, dev, dispatcher) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(20000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null); if (!chj?.context) return { status: 'ch-fail' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(20000), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null); if (!exj?.token) return { status: 'ex-fail' };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(20000), headers: { 'friction-token': exj.token, 'x-fingerprint': fpStr, 'x-device-id': dev, 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => ''); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { status: 'OK ✅', phone: j.data.phones[0] };
    if (Array.isArray(j?.data?.phones)) return { status: 'empty' };
    return { status: 'lp' + lp.status, detail: (j?.error?.detail || '').slice(0, 40) };
  } catch (e) { return { status: 'neterr', detail: String(e.cause?.code || e.message).slice(0, 30) }; }
}

const FP = await captureFP() || { fp: JSON.parse(process.env.OLX_FP || '{}').x_fingerprint, dev: crypto.randomUUID() };
const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: 40 });
const ads = (queue || []).map((r) => decodeAd(r.url)).filter(Boolean);
let idx = 0;
for (let s = 0; s < 3; s++) {
  const agent = newAgent();
  let ip = '?'; try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: agent, signal: AbortSignal.timeout(15000) }); ip = (await r.json()).ip; } catch (e) { ip = 'ip-err'; }
  console.log(`\n=== SESJA ${s + 1} — jedno IP ${ip}, 8 reveali pod rząd ===`);
  let ok = 0;
  for (let i = 0; i < 8; i++) {
    const ad = ads[idx++ % ads.length];
    const r = await reveal(ad, FP.fp, crypto.randomUUID(), agent);
    if (String(r.status).startsWith('OK')) ok++;
    console.log(`  ${i + 1}. ${r.status} ${r.detail || r.phone || ''}`);
    await sleep(2500);
  }
  console.log(`  >>> SESJA ${s + 1} (IP ${ip}): ${ok}/8 numerów`);
}
console.log('\nJeśli w sesji: kilka OK potem same Disallowed → PER-IP potwierdzone. Jeśli od razu same Disallowed → ten IP już spalony.');
process.exit(0);
