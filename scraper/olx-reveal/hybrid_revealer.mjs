/** HYBRID revealer — przeglądarka łapie nagłówki RAZ na sesję (fingerprint/auth/cookie), reveal = CZYSTE HTTP (grosze).
 *  Fale 3 kont co 2min, cooldown 8min/konto, 5 reveali/konto, captcha→studzenie 45min. ad_id dekodowane z URL (base62).
 *  Env: IPROYAL_PROXY, SUPABASE_*, PER_ACCOUNT(5), SCAN_CAP(15), COOLDOWN_MIN(8), WAVE_SIZE(3), WAVE_INTERVAL_MIN(2),
 *       BUDGET_MIN(720), HEADER_TTL_MIN(35), ONLY_ACCOUNTS, NO_PROXY(1=test lokalny bez proxy), DEBUG.
 *  Sesje z DB (leads.olx_sessions). */
import { chromium } from 'patchright';
import crypto from 'crypto';
import { ProxyAgent } from 'undici';

const PROXY = process.env.IPROYAL_PROXY || '';
const NO_PROXY = process.env.NO_PROXY === '1';
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PER_ACCOUNT = Number(process.env.PER_ACCOUNT || 5);
const SCAN_CAP = Number(process.env.SCAN_CAP || 15);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 8) * 60000;
const BUDGET_MS = Number(process.env.BUDGET_MIN || 720) * 60000;
const WAVE_SIZE = Number(process.env.WAVE_SIZE || 3);
const WAVE_INTERVAL_MS = Number(process.env.WAVE_INTERVAL_MIN || 2) * 60000;
const HEADER_TTL_MS = Number(process.env.HEADER_TTL_MIN || 35) * 60000;
const LIFETIME = process.env.PROXY_LIFETIME || '24h';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DEBUG = process.env.DEBUG === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Blokuj reklamy/tracking na capture (przeglądarka) — inaczej pełne strony żrą GB. HTTP reveale i tak omijają przeglądarkę.
const BLOCK_HOST = /doubleclick|googlesyndication|google-analytics|googletagmanager|googleadservices|adservice\.google|facebook\.net|facebook\.com|criteo|rubiconproject|pubmatic|casalemedia|adnxs|amazon-adsystem|openx|indexww|3lift|triplelift|sharethrough|taboola|outbrain|teads|tapad|stackadapt|seedtag|betweendigital|adition|richaudience|yieldmo|aniview|omnitagjs|blismedia|contextweb|scorecardresearch|adsrvr|adform|smartadserver|bidswitch|360yield|gumgum|media\.net|onetag|browsi|id5-sync|crwdcntrl|demdex|bluekai|rlcdn|agkn|adroll|quantserve|hotjar|clarity\.ms|permutive|yieldlab|improvedigital|smartclip|omtrdc|newrelic|sentry|segment\.|mixpanel|amplitude|appsflyer|adjust\.com|kochava|olx-st\.com|ninja\.data\.olxcdn|seedtag|onthe\.io/i;
const routeBlock = (r) => { const rt = r.request().resourceType(); if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'stylesheet') return r.abort(); let host = ''; try { host = new URL(r.request().url()).hostname; } catch {} if (host && BLOCK_HOST.test(host)) return r.abort(); return r.continue(); };

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decode62 = (s) => { let n = 0n; for (const c of s) { const i = B62.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const adIdFromUrl = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? decode62(m[1]) : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };

const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const keyFor = (acc, salt) => crypto.createHash('md5').update(salt ? `${acc}:${salt}` : acc).digest('hex').slice(0, 8);
const passFor = (key) => `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const proxyForKey = (key) => ({ server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: passFor(key) });
const proxyAgentFor = (key) => new ProxyAgent(`http://${pm[1]}:${passFor(key)}@${pm[3]}:${pm[4]}`);

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

let ipSalts = {};
const hdrCache = {}; // acc -> { hdr, uuid, at }  (nagłówki złapane z przeglądarki)

// ── Przeglądarka: warm-up (odśwież token) + złap nagłówki z 1 realnego reveala ──
async function captureHeaders(browser, acc, state) {
  const key = keyFor(acc, ipSalts[acc] || 0);
  const ctxOpts = { storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA };
  if (!NO_PROXY) ctxOpts.proxy = proxyForKey(key);
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.route('**/*', routeBlock); // ad-block — capture nie ładuje reklam/trackingu (główny żłop GB)
  const hdr = {}; let uuid = null;
  page.on('request', (req) => {
    const u = req.url(), h = req.headers();
    for (const k of ['authorization', 'x-client', 'x-device-id', 'x-fingerprint', 'x-platform-type', 'x-user-tests']) if (h[k] && !hdr[k]) hdr[k] = h[k]; // łap z DOWOLNEGO requesta (też warm-up)
    let host = ''; try { host = new URL(u).hostname; } catch {}
    if (/(^|\.)olx\.pl$/i.test(host) && h['cookie'] && !hdr['cookie']) hdr['cookie'] = h['cookie'];
    if (/friction\.olxgroup\.com\/challenge/i.test(u)) { try { const b = JSON.parse(req.postData() || '{}'); if (b?.actor?.username) uuid = b.actor.username; } catch {} }
  });
  let firstPhone = null, firstUrl = null;
  page.on('response', async (resp) => { if (/limited-phones/i.test(resp.url())) { try { const j = JSON.parse(await resp.text()); if (j?.data?.phones?.[0]) firstPhone = j.data.phones[0]; } catch {} } });

  await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(7000);
  const loggedIn = await page.locator('[data-testid="my-account-menu"], [data-testid="header-user-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 2500 }).catch(() => false);
  try { await rpc('leads_upsert_olx_session', { p_name: acc, p_state: await ctx.storageState() }); } catch {} // ZAWSZE zapisz odświeżony token
  if (!loggedIn) { await ctx.close().catch(() => {}); return { loggedIn: false }; }

  // jeśli WARM-UP już dał komplet nagłówków — NIE ładuj żadnej strony ogłoszenia (max oszczędność)
  const complete = () => hdr['x-fingerprint'] && hdr['authorization'] && hdr['x-device-id'] && hdr['x-user-tests'] && hdr['cookie'] && uuid;
  if (!complete()) {
    const q = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: 3 }).catch(() => []);
    let tries = 0;
    for (const row of (q || [])) {
      if (tries++ >= 2 || complete()) break;                       // MAX 2 strony na capture
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
      await sleep(4000);
      if (/login\.olx\.pl/i.test(page.url())) { await ctx.close().catch(() => {}); return { loggedIn: false }; }
      const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
      for (let j = 0; j < n; j++) { const b = btns.nth(j); if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } }
      await sleep(6000);
      if (firstPhone) firstUrl = row.url;
    }
  }
  console.log(`  [${acc}] capture: nagłówki=${Object.keys(hdr).length}/6 uuid=${uuid ? 'T' : 'N'} ${firstPhone ? '(numer z warm-up/reveala)' : '(sam warm-up)'}`);
  const ipUsed = hdr['x-fingerprint'] ? await ipVia(key).catch(() => null) : null;
  await ctx.close().catch(() => {});
  return { loggedIn: true, hdr, uuid, firstPhone, firstUrl, ipUsed };
}
const ipVia = async (key) => { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: NO_PROXY ? undefined : proxyAgentFor(key), signal: AbortSignal.timeout(12000) }); return (await r.json()).ip; } catch { return null; } };

// ── CZYSTE HTTP reveal (przez proxy konta) ──
async function httpReveal(key, adId, hdr, uuid) {
  const disp = NO_PROXY ? undefined : proxyAgentFor(key);
  const common = { 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' };
  const ch = await (await fetch('https://friction.olxgroup.com/challenge', { dispatcher: disp, method: 'POST', headers: { 'content-type': 'application/json', 'x-user-tests': hdr['x-user-tests'] || '', ...common }, body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: uuid }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: adId } }), signal: AbortSignal.timeout(20000) })).json().catch(() => ({}));
  if (ch?.challenge?.type && ch.challenge.type !== 'blank') return { captcha: true, type: ch.challenge.type };
  if (!ch?.context) return { fail: 'challenge', type: ch?.challenge?.type };
  const ex = await (await fetch('https://friction.olxgroup.com/exchange', { dispatcher: disp, method: 'POST', headers: { 'content-type': 'application/json', ...common }, body: JSON.stringify({ context: ch.context }), signal: AbortSignal.timeout(20000) })).json().catch(() => ({}));
  if (!ex?.token) return { fail: 'exchange' };
  const lp = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones/`, { dispatcher: disp, headers: { authorization: hdr['authorization'], cookie: hdr['cookie'], 'x-client': hdr['x-client'] || 'DESKTOP', 'x-device-id': hdr['x-device-id'], 'x-fingerprint': hdr['x-fingerprint'], 'x-platform-type': hdr['x-platform-type'] || 'mobile-html5', 'friction-token': ex.token, ...common }, signal: AbortSignal.timeout(20000) });
  if (lp.status === 401 || lp.status === 403) return { fail: 'auth', status: lp.status };
  const j = await lp.json().catch(() => ({}));
  return { phone: j?.data?.phones?.[0], status: lp.status };
}

// ── Batch konta: zapewnij nagłówki (przeglądarka jeśli stare) + reveale HTTP ──
async function revealBatch(browser, acc, state) {
  const res = { ok: 0, nophone: 0, expired: false, captcha: false, loggedIn: true, fetched: 0 };
  const key = keyFor(acc, ipSalts[acc] || 0);
  let cache = hdrCache[acc];
  if (!cache || Date.now() - cache.at > HEADER_TTL_MS) {
    console.log(`  [${acc}] 🌐 przeglądarka: warm-up + capture nagłówków`);
    const cap = await captureHeaders(browser, acc, state);
    if (!cap.loggedIn) { res.loggedIn = false; return res; }
    if (!cap.hdr || !cap.hdr['x-fingerprint'] || !cap.uuid) { console.log(`  [${acc}] nie złapano nagłówków — pomijam`); return res; }
    if (cap.ipUsed) { try { await rpc('leads_olx_ip_seen', { p_name: acc, p_ip: cap.ipUsed }); } catch {} }
    cache = hdrCache[acc] = { hdr: cap.hdr, uuid: cap.uuid, at: Date.now() };
    // numer z reveala-capture też liczymy
    if (cap.firstPhone && cap.firstUrl) { const norm = normPhone(cap.firstPhone); try { const r = await rpc('leads_ingest_offer', { p_offer: { url: cap.firstUrl, portal: 'olx', portal_listing_id: adIdFromUrl(cap.firstUrl), phone: norm, raw: { source: 'olx-hybrid' } } }); console.log(`  [${acc}] ✅(capture) ${cap.firstPhone} (sms:${r?.sms_status || '?'})`); res.ok++; } catch {} }
  }

  const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: SCAN_CAP }).catch(() => []);
  res.fetched = queue?.length || 0;
  let clicks = res.ok; // capture-reveal już policzony do limitu
  for (const row of (queue || [])) {
    if (clicks >= PER_ACCOUNT) break;
    const adId = adIdFromUrl(row.url);
    if (!adId) continue;
    const r = await httpReveal(key, adId, cache.hdr, cache.uuid);
    if (DEBUG) console.log(`  [dbg] ...${row.url.slice(-24)} ad_id:${adId} → ${r.phone || r.fail || (r.captcha ? 'CAPTCHA:' + r.type : '?')} (st:${r.status || '—'})`);
    if (r.captcha) { res.captcha = true; break; }
    if (r.fail === 'auth') { delete hdrCache[acc]; console.log(`  [${acc}] auth wygasł — odświeżę nagłówki w następnym cyklu`); break; }
    clicks++;
    if (r.phone) { const norm = normPhone(r.phone); try { const ing = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: adIdFromUrl(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: norm, raw: { source: 'olx-hybrid' } } }); console.log(`  [${acc}] ✅ ${r.phone} (sms:${ing?.sms_status || '?'})`); res.ok++; } catch {} }
    else { res.nophone++; await rpc('leads_mark_reveal_fail', { p_id: row.id, p_minutes: 180, p_reason: r.fail === 'challenge' ? 'no_button' : 'no_reveal' }).catch(() => {}); }
    await sleep(1500 + Math.random() * 1500);
  }
  return res;
}

// ── Główna pętla falowa ──
let accounts = {};
if (process.env.OLX_SESSIONS) accounts = JSON.parse(process.env.OLX_SESSIONS);
let names = Object.keys(accounts);
if (!names.length) { accounts = await rpc('leads_get_olx_sessions').catch(() => ({})); names = Object.keys(accounts || {}); }
if (process.env.ONLY_ACCOUNTS) { const only = new Set(process.env.ONLY_ACCOUNTS.split(',').map((s) => s.trim())); names = names.filter((n) => only.has(n)); }
try { for (const r of (await rpc('leads_get_ip_salts').catch(() => []))) ipSalts[r.name] = r.salt; } catch {}
let cooledUntil = {};
try { for (const r of (await rpc('leads_olx_cooled').catch(() => []))) cooledUntil[r.name] = new Date(r.cooled_until).getTime(); } catch {}
console.log(`HYBRID | konta: ${names.length} | fale ${WAVE_SIZE}/${WAVE_INTERVAL_MS / 60000}min | cooldown ${COOLDOWN_MS / 60000}min | ${NO_PROXY ? 'BEZ PROXY (test)' : 'przez proxy'}`);
if (!names.length) { console.log('brak sesji'); process.exit(1); }

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const dead = new Set(), lastStart = {}, running = new Set(), expiredHits = {};
const start = Date.now(); let grandOk = 0;
async function runAcc(acc) {
  running.add(acc); lastStart[acc] = Date.now();
  try {
    const res = await Promise.race([
      revealBatch(browser, acc, accounts[acc]),
      sleep(150000).then(() => { throw new Error('batch timeout 150s — proxy zamula, zwalniam konto'); }),
    ]);
    grandOk += res.ok;
    if (res.ok > 0 || res.loggedIn) expiredHits[acc] = 0;
    if (!res.loggedIn) { cooledUntil[acc] = Date.now() + 25 * 60000; await slack(`:door: *OLX hybrid* — *${acc}* wylogowane, pauza 25min`); }
    if (res.captcha) { cooledUntil[acc] = Date.now() + 45 * 60000; try { await rpc('leads_olx_captcha_hit', { p_name: acc, p_minutes: 45 }); } catch {} await slack(`:snowflake: *OLX hybrid* — captcha *${acc}* → studzę 45min`); }
    console.log(`[${acc}] batch: ✅${res.ok} ∅${res.nophone}${res.captcha ? ' 🧊CAPTCHA' : ''}${!res.loggedIn ? ' 🚪wylog' : ''} | RAZEM ✅${grandOk}`);
  } catch (e) { console.log(`[${acc}] błąd: ${String(e.message).slice(0, 70)}`); }
  running.delete(acc);
}
try {
  while (Date.now() - start < BUDGET_MS) {
    if (names.every((n) => dead.has(n))) break;
    if (running.size < WAVE_SIZE * 2) {
      const pool = names.filter((acc) => !dead.has(acc) && !running.has(acc) && Date.now() - (lastStart[acc] || 0) >= COOLDOWN_MS && Date.now() >= (cooledUntil[acc] || 0)).sort((a, b) => (lastStart[a] || 0) - (lastStart[b] || 0)).slice(0, WAVE_SIZE);
      for (const acc of pool) runAcc(acc);
    }
    await sleep(WAVE_INTERVAL_MS);
  }
  while (running.size && Date.now() - start < BUDGET_MS + 300000) await sleep(3000);
} finally { await browser.close(); }
console.log(`\n=== KONIEC === ✅ ${grandOk} numerów`);
process.exit(0);
