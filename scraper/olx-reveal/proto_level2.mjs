/** PROTOTYP POZIOM 2 — reveal CZYSTYM HTTP (node, BEZ przeglądarki, bez CORS).
 *  Przeglądarka służy TYLKO raz do złapania stałych nagłówków sesji (fingerprint/device-id/user-tests/auth/cookie).
 *  Potem reveal = 3 fetche z node (challenge→exchange→limited-phones). Jeśli numer wchodzi → to jest droga do groszy.
 *  LOKALNY, home IP (spójny z przeglądarką), bez proxy. Użycie: node proto_level2.mjs [konto1] */
import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';

const ACC = process.argv[2] || 'konto1';
const HOME = os.homedir();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = fs.readFileSync(`${HOME}/Desktop/Audyteko/.env.local`, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const SB = get('NEXT_PUBLIC_SUPABASE_URL'), KEY = get('SUPABASE_SERVICE_ROLE_KEY');
async function rpc(fn, body) { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }

const state = JSON.parse(fs.readFileSync(`${HOME}/Desktop/listings-ingest/scraper/olx-reveal/session_${ACC}.json`, 'utf8'));
const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: 4, p_claim_min: 3 });
if (!queue?.length) { console.log('brak ogłoszeń'); process.exit(1); }
console.log(`konto: ${ACC} | ogłoszeń: ${queue.length} | home IP`);

// ── FAZA A: przeglądarka łapie stałe nagłówki z JEDNEGO realnego reveala ──
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
const page = await ctx.newPage();
let hdr = {}, userUuid = null, adId = null, realPhone = null, chBody = null;
page.on('request', (req) => {
  const u = req.url(), h = req.headers();
  if (/friction\.olxgroup\.com\/challenge/i.test(u)) { chBody = req.postData(); try { const b = JSON.parse(chBody || '{}'); userUuid = b?.actor?.username; adId = b?.scene?.ad_id; } catch {} for (const k of ['x-user-tests', 'cookie', 'user-agent']) if (h[k]) hdr['ch_' + k] = h[k]; }
  if (/limited-phones/i.test(u)) { for (const k of ['authorization', 'x-client', 'x-device-id', 'x-fingerprint', 'x-platform-type', 'cookie', 'user-agent']) if (h[k]) hdr[k] = h[k]; }
});
page.on('response', async (resp) => { if (/limited-phones/i.test(resp.url())) { try { const j = JSON.parse(await resp.text()); if (j?.data?.phones?.[0]) realPhone = j.data.phones[0]; } catch {} } });

await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);
const logged = await page.locator('[data-testid="my-account-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 3000 }).catch(() => false);
if (!logged) { console.log('❌ nie zalogowany'); await browser.close(); process.exit(1); }

for (const row of queue) {
  await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(4000);
  const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
  for (let j = 0; j < n; j++) { const b = btns.nth(j); if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } }
  await sleep(6000);
  if (realPhone && adId) break;
}
await browser.close();
console.log(`FAZA A (przeglądarka): numer=${realPhone} | ad_id=${adId} | nagłówki: ${Object.keys(hdr).join(',')}`);
if (!realPhone || !adId) { console.log('❌ nie złapano referencji'); process.exit(1); }

// ── FAZA B: reveal CZYSTYM HTTP z node (bez przeglądarki, bez CORS) — ten sam ad_id ──
console.log('\n─── FAZA B: reveal CZYSTYM HTTP (node) ───');
const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-tests': hdr['ch_x-user-tests'] || '', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' }, body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: userUuid }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: adId } }) });
const chJson = await ch.json().catch(() => ({}));
console.log(`1) challenge: status=${ch.status} type=${chJson?.challenge?.type} context=${chJson?.context ? 'JEST(' + chJson.context.length + 'ch)' : 'BRAK'}`);
if (chJson?.challenge?.type !== 'blank' || !chJson?.context) { console.log(`   → typ ≠ blank lub brak context (${JSON.stringify(chJson).slice(0, 200)}) — HTTP nie przechodzi jak w Track 1`); process.exit(0); }

const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' }, body: JSON.stringify({ context: chJson.context }) });
const exJson = await ex.json().catch(() => ({}));
console.log(`2) exchange: status=${ex.status} token=${exJson?.token ? 'JEST' : 'BRAK'}`);
if (!exJson?.token) { console.log(`   → brak tokena (${JSON.stringify(exJson).slice(0, 150)})`); process.exit(0); }

const lp = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones/`, { headers: { authorization: hdr['authorization'], cookie: hdr['cookie'], 'x-client': hdr['x-client'] || 'DESKTOP', 'x-device-id': hdr['x-device-id'], 'x-fingerprint': hdr['x-fingerprint'], 'x-platform-type': hdr['x-platform-type'] || 'mobile-html5', 'friction-token': exJson.token, 'user-agent': UA } });
const lpJson = await lp.json().catch(() => ({}));
console.log(`3) limited-phones: status=${lp.status} → ${JSON.stringify(lpJson).slice(0, 200)}`);
const httpPhone = lpJson?.data?.phones?.[0];
console.log(`\n═══ normalnie="${realPhone}" vs CZYSTE HTTP="${httpPhone || 'brak'}" ═══`);
console.log(httpPhone === realPhone ? '✅✅✅ POZIOM 2 DZIAŁA — reveal CZYSTYM HTTP, bez przeglądarki! To jest droga do groszy.' : '⚠️ HTTP nie oddało numeru — analiza wyżej');
process.exit(0);
