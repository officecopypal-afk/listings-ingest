/**
 * OLX — FAZA 2: revealer SAMOZASIEWAJĄCY. PURE reveal przez API (bez cookie/logowania),
 * ale fingerprint ŁAPIE SAM na runnerze (świeża, niewypalona tożsamość sprzętowa) —
 * pasywnie z page-load requestów OLX (żaden klik). Potem odsłania kolejkę czystym API
 * (challenge → exchange → limited-phones) rotując proxy IP. Numer → leads_ingest_offer (auto-SMS).
 *
 * Model 12.07: throttle keyowany na fingerprincie (część sprzętowa) — dlatego capture MUSI być
 * na tej maszynie co reveal-batch; różne runnery/VM = różne fingerprinty = świeże buckety.
 * ad_id = base62 '0-9a-zA-Z' z sufiksu; friction JWT wiąże username+IP+ad_id (15s) → 1 IP / reveal.
 *
 * Env: IPROYAL_PROXY, OLX_FP(json fallback), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      MAX(50), REVEALS_PER_IP(5), DELAY_MS(9000), FETCH_TIMEOUT_MS(20000).
 */
import { chromium } from 'patchright';
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX = Number(process.env.MAX || 50);
const REVEALS_PER_IP = Number(process.env.REVEALS_PER_IP || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 9000);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 20000);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SEARCH = 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const decodeAd = (url) => { const s = suffix(url); if (!s) return null; let n = 0n; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
if (!pm) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
const [, PU, PP, PH, PT] = pm;
const sid = () => crypto.randomBytes(6).toString('hex');
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${sid()}_lifetime-5m`).toString('base64') });
const pwProxy = () => ({ server: `http://${PH}:${PT}`, username: PU, password: `${PP}_session-${sid()}_lifetime-10m` });

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 150)}`);
  return t ? JSON.parse(t) : null;
}

// FINGERPRINT CAPTURE — pasywnie z page-load requestów OLX (bez klika, bez logowania)
async function captureFingerprint() {
  const browser = await chromium.launch({ headless: true, proxy: pwProxy(), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    let cap = null;
    page.on('request', (r) => { const h = r.headers(); if (h['x-fingerprint'] && !cap) cap = { fp: h['x-fingerprint'], dev: h['x-device-id'] || crypto.randomUUID() }; });
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
async function reveal(adId, fp, dispatcher) {
  try {
    const username = crypto.randomUUID();
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null);
    if (!chj?.context) return { status: 'error', detail: 'ch ' + ch.status };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return { status: 'error', detail: 'ex ' + ex.status };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { 'friction-token': exj.token, 'x-fingerprint': fp.fp, 'x-device-id': fp.dev, 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => '');
    let j = null; try { j = JSON.parse(b); } catch {}
    const phone = j?.data?.phones?.[0];
    if (phone) return { status: 'ok', phones: j.data.phones };
    const detail = j?.error?.detail || (lp.status + ':' + b.slice(0, 60));
    if (/not active|not found/i.test(detail)) return { status: 'inactive', detail };
    if (/disallowed/i.test(detail)) return { status: 'throttle', detail };
    if (Array.isArray(j?.data?.phones) && j.data.phones.length === 0) return { status: 'nophone', detail: 'empty' };
    return { status: 'error', detail };
  } catch (e) {
    return { status: 'neterr', detail: String(e.cause?.code || e.name || e.message || 'net').slice(0, 50) };
  }
}

// ---- main
console.log('łapię świeży fingerprint na runnerze...');
let FP = await captureFingerprint();
if (FP) console.log(`fingerprint OK: len=${FP.fp.length} prefiks=${FP.fp.slice(0, 16)} (mój wypalony Mac = fbdc4f53959cdb4a)`);
else { FP = JSON.parse(process.env.OLX_FP); console.log('capture nieudany → fallback OLX_FP (wypalony)'); }

const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
console.log(`kolejka: ${queue?.length || 0} | REVEALS_PER_IP=${REVEALS_PER_IP} delay=${DELAY_MS}ms\n`);
let agent = newAgent(), sinceRotate = 0, ipCount = 1;
const stat = { ok: 0, inactive: 0, throttle: 0, nophone: 0, error: 0, neterr: 0, noid: 0 };

for (let i = 0; i < (queue?.length || 0); i++) {
  const row = queue[i];
  const adId = decodeAd(row.url);
  if (!adId) { stat.noid++; continue; }
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 || sinceRotate >= REVEALS_PER_IP) { agent = newAgent(); sinceRotate = 0; ipCount++; }
    r = await reveal(adId, FP, agent);
    sinceRotate++;
    if (r.status === 'neterr' || r.status === 'throttle') { await sleep(1200); continue; }
    break;
  }
  if (r.status === 'ok') {
    stat.ok++;
    const phoneNorm = normPhone(r.phones[0]);
    try {
      const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: phoneNorm, raw: { source: 'olx-revealer' } } });
      console.log(`  ${i + 1}/${queue.length} ✅ ${r.phones[0]} → ${phoneNorm} (sms:${res?.sms_status || '?'})`);
    } catch (e) { console.error(`  ${i + 1} ingest err`, String(e.message).slice(0, 100)); }
  } else if (r.status === 'inactive') { stat.inactive++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ⊘ martwe`); }
  else if (r.status === 'nophone') { stat.nophone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'nophone' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ∅ brak numeru w ofercie`); }
  else if (r.status === 'throttle') { stat.throttle++; console.log(`  ${i + 1}/${queue.length} ⏳ throttle (fingerprint wyczerpany)`); }
  else if (r.status === 'neterr') { stat.neterr++; console.log(`  ${i + 1}/${queue.length} 🌐 proxy flaky (${r.detail})`); }
  else { stat.error++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'error' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ✗ ${r.detail}`); }
  await sleep(DELAY_MS + Math.random() * 2000);
}
console.log(`\n=== PODSUMOWANIE === IP: ${ipCount} | ✅ ${stat.ok} | ⊘ ${stat.inactive} | ∅ ${stat.nophone} | ⏳ throttle ${stat.throttle} | 🌐 ${stat.neterr} | ✗ ${stat.error}`);
process.exit(0);
