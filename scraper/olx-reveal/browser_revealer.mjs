/** Track 2 — reveal przez PRZEGLĄDARKĘ na zalogowanej sesji (rozwiązuje "blank" którego HTTP nie umie).
 *  v1: jedno konto (OLX_SESSION), MAX reveali, zapis do bazy, wykrycie wygaśnięcia sesji + Slack alert.
 *  Env: OLX_SESSION(storageState), IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAX(5), ACC_NAME(konto1). */
import { chromium } from 'patchright';
import crypto from 'crypto';

const SESSION = JSON.parse(process.env.OLX_SESSION);
const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX = Number(process.env.MAX || 5);
const ACC = process.env.ACC_NAME || 'konto1';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 120)}`); return t ? JSON.parse(t) : null;
}
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

// proxy PL sticky — STAŁE IP dla tego konta (nie rotujące pod loginem)
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const stableSess = crypto.createHash('md5').update(ACC).digest('hex').slice(0, 10);
const proxy = { server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: `${pm[2]}_country-pl_session-${stableSess}_lifetime-30m` };

const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
console.log(`[${ACC}] kolejka: ${queue?.length || 0} | sticky IP sess=${stableSess}`);
if (!queue?.length) { console.log('pusto'); process.exit(0); }

const browser = await chromium.launch({ headless: true, proxy, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
let ok = 0, nophone = 0, expired = false;
try {
  const ctx = await browser.newContext({ storageState: SESSION, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

  for (const row of queue) {
    let phone = null;
    const onResp = async (resp) => { if (/limited-phones/i.test(resp.url())) { try { const j = await resp.json(); if (j?.data?.phones?.[0]) phone = j.data.phones[0]; } catch {} } };
    page.on('response', onResp);
    try {
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await sleep(2000);
      if (/login\.olx\.pl/i.test(page.url())) { expired = true; }
      else {
        const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
        for (let i = 0; i < n; i++) { const b = btns.nth(i); if (await b.isVisible().catch(() => false)) { await b.scrollIntoViewIfNeeded().catch(() => {}); await b.click({ timeout: 3000 }).catch(() => {}); break; } }
        await sleep(4500);
        if (/login\.olx\.pl/i.test(page.url())) expired = true;
      }
    } catch (e) { console.log('  nav err', String(e.message).slice(0, 50)); }
    page.off('response', onResp);

    if (expired) { console.log('  🔴 SESJA WYGASŁA (redirect na login)'); break; }
    if (phone) {
      const norm = normPhone(phone);
      try { const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: norm, raw: { source: 'olx-browser' } } }); console.log(`  ✅ ${phone} (sms:${res?.sms_status || '?'})`); ok++; } catch (e) { console.log('  ingest err', String(e.message).slice(0, 60)); }
    } else { nophone++; await rpc('leads_defer_reveal', { p_id: row.id, p_minutes: 30 }).catch(() => {}); console.log('  ∅ brak numeru (maska/inactive) — odroczone'); }
    await sleep(2500 + Math.random() * 2500);
  }
} catch (e) { console.log('BŁĄD:', String(e.message).slice(0, 120)); } finally { await browser.close(); }

console.log(`\n[${ACC}] koniec: ✅ ${ok} numerów | ∅ ${nophone}${expired ? ' | 🔴 SESJA PADŁA' : ''}`);
if (expired) await slack(`:warning: *OLX konta* — sesja *${ACC}* wygasła, zaloguj ponownie (helper: node login_helper.mjs ${ACC})`);
process.exit(0);
