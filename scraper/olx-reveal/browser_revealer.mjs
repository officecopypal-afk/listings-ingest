/** Track 2 — SILNIK ROTACYJNY: konta w kółko, 5 reveali/konto, cooldown 8min per konto od startu sekwencji.
 *  Reveal przez przeglądarkę na zalogowanej sesji (rozwiązuje "blank"). Najświeższe ogłoszenia najpierw (RPC).
 *  Sesje: OLX_SESSIONS = {"konto1":<storageState>,...}  albo pojedynczy OLX_SESSION (=konto1).
 *  Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PER_ACCOUNT(5), COOLDOWN_MIN(8), BUDGET_MS. */
import { chromium } from 'patchright';
import crypto from 'crypto';
import { ProxyAgent } from 'undici';

let accounts = {};
if (process.env.OLX_SESSIONS) accounts = JSON.parse(process.env.OLX_SESSIONS);
else if (process.env.OLX_SESSION) accounts = { konto1: JSON.parse(process.env.OLX_SESSION) };
let names = Object.keys(accounts); // jeśli puste — dociągniemy z DB niżej (po zdefiniowaniu rpc)

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PER_ACCOUNT = Number(process.env.PER_ACCOUNT || 5);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 8) * 60000;
const BUDGET_MS = Number(process.env.BUDGET_MIN || 300) * 60000; // minuty → ms
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DEBUG = process.env.DEBUG === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const LIFETIME = process.env.PROXY_LIFETIME || '12h';           // 1 konto = 1 STAŁY IP na 12h (IPRoyal max 7d)
const keyFor = (acc, salt) => crypto.createHash('md5').update(salt ? `${acc}:${salt}` : acc).digest('hex').slice(0, 8); // session ID = dokładnie 8 znaków (spec IPRoyal); deterministyczny per konto → inny IP na każdy mail
const passFor = (key) => `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const proxyForKey = (key) => ({ server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: passFor(key) });
const ipVia = async (key) => { try { const a = new ProxyAgent(`http://${pm[1]}:${passFor(key)}@${pm[3]}:${pm[4]}`); const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(15000) }); return (await r.json()).ip; } catch { return null; } };
const chosenKey = {};                                           // acc → zablokowany klucz sesji = ten sam IP przez cały run

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

// Dobierz kontu ŚWIEŻE IP (spoza spalonych/wystudzonych z ostatnich 12h) i zablokuj na cały run (= ten sam IP 12h).
async function freshKeyFor(acc) {
  if (chosenKey[acc]) return chosenKey[acc];
  let burned = new Set();
  try { burned = new Set(await rpc('leads_ip_burned_recent', { p_cooldown_hours: 12 })); } catch {}
  let nulls = 0;
  for (let salt = 0; salt < 8; salt++) {
    const key = keyFor(acc, salt);
    const ip = await ipVia(key);
    if (!ip) { if (++nulls >= 2) { console.log(`  [${acc}] ⚠️ proxy nie zwraca IP — sprawdź IPROYAL_PROXY`); break; } continue; }
    if (!burned.has(ip)) { console.log(`  [${acc}] 🌐 IP ${ip} świeży${salt ? ` (salt=${salt})` : ''} — trzymam ${LIFETIME}`); chosenKey[acc] = key; return key; }
    console.log(`  [${acc}] IP ${ip} spalony/wystudzany (<12h) — biorę inny...`);
  }
  const key = keyFor(acc, 0); chosenKey[acc] = key; return key;
}

async function revealBatch(browser, acc, state) {
  const res = { ok: 0, nophone: 0, expired: false, fetched: 0 };
  const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: PER_ACCOUNT }).catch(() => []);
  res.fetched = queue?.length || 0;
  if (!res.fetched) return res;
  const key = await freshKeyFor(acc);
  const ctx = await browser.newContext({ proxy: proxyForKey(key), storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  if (DEBUG) page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|net::|status of 4|status of 5/i.test(m.text())) console.log('  [con.err]', m.text().slice(0, 85)); });
  // ROZGRZEWKA sesji: wejdź na home, daj Auth0 SDK zainicjować i odświeżyć token, zanim revealujesz
  await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(7000);
  const loggedIn = await page.locator('[data-testid="my-account-menu"], [data-testid="header-user-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 2500 }).catch(() => false);
  console.log(`  [${acc}] rozgrzewka: zalogowany=${loggedIn}`);
  if (loggedIn) { try { await rpc('leads_upsert_olx_session', { p_name: acc, p_state: await ctx.storageState() }); } catch {} } // zapisz odświeżone tokeny do DB
  for (const row of queue) {
    let phone = null, lpStatus = null, lpBody = '', blank = false, clicked = false;
    const onResp = async (resp) => {
      const u = resp.url();
      if (/friction\.olxgroup/i.test(u)) { try { const j = await resp.json(); if (j?.challenge?.type) blank = true; } catch {} }
      if (/limited-phones/i.test(u)) { lpStatus = resp.status(); try { lpBody = await resp.text(); const j = JSON.parse(lpBody); if (j?.data?.phones?.[0]) phone = j.data.phones[0]; } catch {} }
    };
    page.on('response', onResp);
    try {
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await sleep(5000);
      if (/login\.olx\.pl/i.test(page.url())) res.expired = true;
      else {
        const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
        for (let i = 0; i < n; i++) { const b = btns.nth(i); if (await b.isVisible().catch(() => false)) { await b.scrollIntoViewIfNeeded().catch(() => {}); await b.click({ timeout: 3000 }).catch(() => {}); clicked = true; break; } }
        await sleep(4500);
        if (/login\.olx\.pl/i.test(page.url())) res.expired = true;
      }
    } catch {}
    page.off('response', onResp);
    if (DEBUG) { const cont = await page.locator('[data-testid="phones-container"]').first().innerText().catch(() => ''); console.log(`  [dbg] ...${row.url.slice(-28)} klik:${clicked} login:${/login\.olx/i.test(page.url())} blank:${blank} lp:${lpStatus || '—'} cont:"${cont.replace(/\s+/g, ' ').slice(0, 22)}" ${lpBody ? lpBody.slice(0, 45) : ''}`); }
    if (res.expired) break;
    if (phone) { const norm = normPhone(phone); try { const r = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: norm, raw: { source: 'olx-browser' } } }); console.log(`  [${acc}] ✅ ${phone} (sms:${r?.sms_status || '?'})`); res.ok++; } catch {} }
    else { res.nophone++; await rpc('leads_defer_reveal', { p_id: row.id, p_minutes: 30 }).catch(() => {}); }
    await sleep(2500 + Math.random() * 2500);
  }
  await ctx.close().catch(() => {});
  return res;
}

// Sesje z DB (leads.olx_sessions), gdy nie podano w env — DB = źródło prawdy (za duże na sekret GH: 64KB)
if (!names.length) { accounts = await rpc('leads_get_olx_sessions').catch(() => ({})); names = Object.keys(accounts || {}); console.log(`sesje z DB: ${names.length}`); }
if (process.env.ONLY_ACCOUNTS) { const only = new Set(process.env.ONLY_ACCOUNTS.split(',').map((s) => s.trim())); names = names.filter((n) => only.has(n)); }
console.log(`konta: ${names.join(', ') || 'BRAK'} | PER_ACCOUNT=${PER_ACCOUNT} | cooldown=${COOLDOWN_MS / 60000}min | budżet=${Math.round(BUDGET_MS / 60000)}min`);
if (!names.length) { console.log('brak sesji (OLX_SESSION/OLX_SESSIONS)'); process.exit(1); }
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] }); // headful (przez xvfb) — headless wykrywany przez OLX
const dead = new Set(), lastStart = {}; const start = Date.now(); let grandOk = 0;
try {
  while (Date.now() - start < BUDGET_MS) {
    const live = names.filter((n) => !dead.has(n));
    if (!live.length) { console.log('wszystkie sesje padły'); break; }
    let anyFetched = false;
    for (const acc of live) {
      if (dead.has(acc)) continue;
      const wait = COOLDOWN_MS - (Date.now() - (lastStart[acc] || 0));
      if (wait > 0) {
        if (Date.now() - start + wait > BUDGET_MS) { console.log('budżet — koniec'); break; }
        console.log(`[${acc}] cooldown 8min — czekam ${Math.round(wait / 1000)}s...`); await sleep(wait);
      }
      lastStart[acc] = Date.now();                          // start sekwencji konta = teraz
      const res = await revealBatch(browser, acc, accounts[acc]);
      grandOk += res.ok; if (res.fetched > 0) anyFetched = true;
      console.log(`[${acc}] batch: ✅${res.ok} ∅${res.nophone}${res.expired ? ' 🔴WYGASŁA' : ''} | RAZEM ✅${grandOk}`);
      if (res.expired) { dead.add(acc); await slack(`:warning: *OLX konta* — sesja *${acc}* wygasła. Zaloguj: node login_helper.mjs ${acc}`); }
    }
    if (!anyFetched) { console.log('🎉 kolejka pusta — koniec'); break; }
  }
} finally { await browser.close(); }
console.log(`\n=== KONIEC === ✅ ${grandOk} numerów`);
process.exit(0);
