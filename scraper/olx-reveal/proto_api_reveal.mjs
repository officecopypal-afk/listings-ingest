/** PROTOTYP reverse-engineeringu reveala — LOKALNY (Mac, home IP, BEZ proxy = zero transferu proxy).
 *  Cel: przechwycić DOKŁADNY flow (friction challenge/exchange + limited-phones): URL-e, nagłówki, odpowiedzi.
 *  Żeby zaprojektować Poziom 1 (numer bez ładowania pełnych stron) + zobaczyć numer vs blank vs captcha.
 *  BEZPIECZEŃSTWO: MAX 2 reveale (grubo pod progiem captchy), stop jak nie zalogowany. Użycie: node proto_api_reveal.mjs [konto1] */
import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';

const ACC = process.argv[2] || 'konto1';
const MAX_REVEAL = 2;
const HOME = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = fs.readFileSync(`${HOME}/Desktop/Audyteko/.env.local`, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const SB = get('NEXT_PUBLIC_SUPABASE_URL'), KEY = get('SUPABASE_SERVICE_ROLE_KEY');
async function rpc(fn, body) { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }

const state = JSON.parse(fs.readFileSync(`${HOME}/Desktop/listings-ingest/scraper/olx-reveal/session_${ACC}.json`, 'utf8'));
const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: MAX_REVEAL, p_claim_min: 3 });
console.log(`konto: ${ACC} | ogłoszenia do testu: ${queue.length} | home IP, bez proxy`);
if (!queue.length) { console.log('brak ogłoszeń w kolejce'); process.exit(1); }

const RE = /friction|limited-phones|phones|contact|reveal/i;
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

let cap = [];
page.on('request', (req) => { const u = req.url(); if (RE.test(u)) cap.push({ d: 'REQ', m: req.method(), u, h: req.headers(), b: req.postData() }); });
page.on('response', async (resp) => { const u = resp.url(); if (RE.test(u)) { let b = ''; try { b = await resp.text(); } catch {} cap.push({ d: 'RESP', s: resp.status(), u, b: (b || '').slice(0, 600) }); } });

await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);
const logged = await page.locator('[data-testid="my-account-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 3000 }).catch(() => false);
console.log(`zalogowany: ${logged}`);
if (!logged) { console.log('❌ NIE zalogowany — przerywam (nie palę konta)'); await browser.close(); process.exit(1); }

const trunc = (h) => { const o = {}; for (const [k, v] of Object.entries(h)) { if (/friction|fingerprint|^x-/i.test(k)) o[k] = v; else if (/^authorization$/i.test(k)) o[k] = 'Bearer<' + v.length + 'ch>'; else if (/^cookie$/i.test(k)) o[k] = '<cookie ' + v.length + 'ch>'; } return o; };

for (let i = 0; i < queue.length; i++) {
  const row = queue[i];
  console.log(`\n═══════ REVEAL ${i + 1}/${queue.length}: ...${row.url.slice(-42)} ═══════`);
  cap = [];
  await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(4000);
  const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
  let clicked = false;
  for (let j = 0; j < n; j++) { const b = btns.nth(j); if (await b.isVisible().catch(() => false)) { await b.scrollIntoViewIfNeeded().catch(() => {}); await b.click({ timeout: 3000 }).catch(() => {}); clicked = true; break; } }
  await sleep(7000);
  console.log(`kliknięto: ${clicked} | przechwycono ${cap.length} calli:\n`);
  for (const c of cap) {
    if (c.d === 'REQ') console.log(`  →  ${c.m} ${c.u}\n     nagłówki: ${JSON.stringify(trunc(c.h))}${c.b ? '\n     body: ' + c.b.slice(0, 200) : ''}`);
    else console.log(`  ←  ${c.s}  ${c.u}\n     ODPOWIEDŹ: ${c.b}`);
  }
  await sleep(1500);
}
console.log('\n═══════ KONIEC — analiza flow powyżej (URL limited-phones + nagłówki + typ challenge) ═══════');
await browser.close();
process.exit(0);
