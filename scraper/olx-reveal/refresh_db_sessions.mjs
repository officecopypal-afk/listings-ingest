/** Odświeżacz sesji OLX — czyta sesje z DB, przez przeglądarkę odnawia token (auth0 SDK), zapisuje z powrotem do DB.
 *  Headless, przez proxy konta (spójny IP). Cron co 20min → tokeny nigdy nie wietrzeją; refresh token żyje długo → ożywia wygasłe.
 *  Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Użycie: node refresh_db_sessions.mjs [konto1 ...] (bez arg = wszystkie z DB) */
import { chromium } from 'patchright';
import crypto from 'crypto';

const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY = process.env.IPROYAL_PROXY;
const LIFETIME = process.env.PROXY_LIFETIME || '24h';
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (acc, salt) => crypto.createHash('md5').update(salt ? `${acc}:${salt}` : acc).digest('hex').slice(0, 8);
const proxyForKey = (key) => ({ server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}` });
async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
const expOf = (state) => { for (const o of state.origins || []) for (const it of (o.localStorage || [])) if (/auth0spajs/i.test(it.name) && /default/i.test(it.name)) { try { return JSON.parse(it.value).expiresAt; } catch {} } return null; };

const accountsObj = (await rpc('leads_get_olx_sessions').catch(() => ({}))) || {};
const salts = {}; try { for (const r of (await rpc('leads_get_ip_salts').catch(() => []))) salts[r.name] = r.salt; } catch {}
const arg = process.argv.slice(2);
const names = (arg.length ? arg : Object.keys(accountsObj)).filter((n) => accountsObj[n]);
console.log(`odświeżam ${names.length} sesji: ${names.join(', ')}`);

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
let ok = 0, bad = 0;
for (const acc of names) {
  const state = accountsObj[acc];
  const now = Math.floor(Date.now() / 1000);
  const before = expOf(state);
  try {
    const ctx = await browser.newContext({ proxy: proxyForKey(keyFor(acc, salts[acc] || 0)), storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 } });
    const page = await ctx.newPage();
    await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await sleep(9000); // SDK odnawia token
    const logged = await page.evaluate(() => Object.keys(localStorage).some((k) => /auth0spajs.*@@user@@/i.test(k))).catch(() => false);
    const ns = await ctx.storageState();
    const after = expOf(ns);
    // ZAWSZE zapisz jeśli mamy ważny token (świeży refresh token trafia do DB → nie zwietrzeje)
    if (logged && after && after > now) { try { await rpc('leads_upsert_olx_session', { p_name: acc, p_state: ns }); } catch {} ok++; console.log(`✅ ${acc} token ważny ${Math.round((after - now) / 60)}min (przed ${before ? Math.round((before - now) / 60) : '?'}min)`); }
    else { bad++; console.log(`🔴 ${acc} refresh nieudany (zalogowany=${logged}) — do PRZELOGOWANIA`); }
    await ctx.close().catch(() => {});
  } catch (e) { bad++; console.log(`⚠️ ${acc} błąd: ${String(e.message).slice(0, 50)}`); }
}
await browser.close();
console.log(`\n=== ${ok} ożywione / ${bad} do przelogowania ===`);
process.exit(0);
