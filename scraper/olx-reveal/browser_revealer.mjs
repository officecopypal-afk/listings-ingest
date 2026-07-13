/** Track 2 — SILNIK ROTACYJNY: konta w kółko, 5 reveali/konto, cooldown 8min per konto od startu sekwencji.
 *  Reveal przez przeglądarkę na zalogowanej sesji (rozwiązuje "blank"). Najświeższe ogłoszenia najpierw (RPC).
 *  Sesje: OLX_SESSIONS = {"konto1":<storageState>,...}  albo pojedynczy OLX_SESSION (=konto1).
 *  Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PER_ACCOUNT(5), COOLDOWN_MIN(8), BUDGET_MS. */
import { chromium } from 'patchright';
import crypto from 'crypto';

let accounts = {};
if (process.env.OLX_SESSIONS) accounts = JSON.parse(process.env.OLX_SESSIONS);
else if (process.env.OLX_SESSION) accounts = { konto1: JSON.parse(process.env.OLX_SESSION) };
const names = Object.keys(accounts);

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PER_ACCOUNT = Number(process.env.PER_ACCOUNT || 5);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 8) * 60000;
const BUDGET_MS = Number(process.env.BUDGET_MIN || 300) * 60000; // minuty → ms
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const proxyFor = (acc) => ({ server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: `${pm[2]}_country-pl_session-${crypto.createHash('md5').update(acc).digest('hex').slice(0, 10)}_lifetime-30m` });

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

async function revealBatch(browser, acc, state) {
  const res = { ok: 0, nophone: 0, expired: false, fetched: 0 };
  const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: PER_ACCOUNT }).catch(() => []);
  res.fetched = queue?.length || 0;
  if (!res.fetched) return res;
  const ctx = await browser.newContext({ proxy: proxyFor(acc), storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const DEBUG = process.env.DEBUG === '1';
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
      await sleep(2000);
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
