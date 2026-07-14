/** WALIDACJA HYBRYDY — przeglądarka łapie nagłówki RAZ, potem CZYSTE HTTP revealuje INNE ogłoszenia
 *  (ad_id dekodowane z base62 URL + REUŻYTE nagłówki). Potwierdza: (a) dekodowanie base62, (b) reużycie nagłówków dla wielu ogłoszeń.
 *  LOKALNY, home IP. Użycie: node proto_level2b.mjs [konto1] */
import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';

const ACC = process.argv[2] || 'konto1';
const HOME = os.homedir();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decode62 = (s) => { let n = 0n; for (const c of s) { const i = B62.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const adIdFromUrl = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? decode62(m[1]) : null; };
const env = fs.readFileSync(`${HOME}/Desktop/Audyteko/.env.local`, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const SB = get('NEXT_PUBLIC_SUPABASE_URL'), KEY = get('SUPABASE_SERVICE_ROLE_KEY');
async function rpc(fn, body) { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }

// reveal czystym HTTP (node) dla podanego ad_id + nagłówki
async function httpReveal(adId, hdr, userUuid) {
  const ch = await (await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-tests': hdr['ch_x-user-tests'] || '', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' }, body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: userUuid }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: adId } }) })).json().catch(() => ({}));
  if (ch?.challenge?.type !== 'blank' || !ch?.context) return { fail: 'challenge', type: ch?.challenge?.type };
  const ex = await (await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' }, body: JSON.stringify({ context: ch.context }) })).json().catch(() => ({}));
  if (!ex?.token) return { fail: 'exchange' };
  const lp = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones/`, { headers: { authorization: hdr['authorization'], cookie: hdr['cookie'], 'x-client': hdr['x-client'] || 'DESKTOP', 'x-device-id': hdr['x-device-id'], 'x-fingerprint': hdr['x-fingerprint'], 'x-platform-type': hdr['x-platform-type'] || 'mobile-html5', 'friction-token': ex.token, 'user-agent': UA } });
  const j = await lp.json().catch(() => ({}));
  return { status: lp.status, phone: j?.data?.phones?.[0], raw: JSON.stringify(j).slice(0, 120) };
}

const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: 6, p_claim_min: 3 });
if (!queue?.length) { console.log('brak ogłoszeń'); process.exit(1); }
console.log(`ogłoszeń: ${queue.length}`);
console.log('dekod ad_id z URL:'); for (const r of queue) console.log(`  ${r.url.match(/-ID([0-9A-Za-z]+)\./i)?.[1]} → ${adIdFromUrl(r.url)}`);

// FAZA A: przeglądarka łapie nagłówki z 1 reveala
const state = JSON.parse(fs.readFileSync(`${HOME}/Desktop/listings-ingest/scraper/olx-reveal/session_${ACC}.json`, 'utf8'));
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
const page = await ctx.newPage();
let hdr = {}, userUuid = null, gotRef = false;
page.on('request', (req) => { const u = req.url(), h = req.headers(); if (/friction\.olxgroup\.com\/challenge/i.test(u)) { try { userUuid = JSON.parse(req.postData() || '{}')?.actor?.username; } catch {} if (h['x-user-tests']) hdr['ch_x-user-tests'] = h['x-user-tests']; } if (/limited-phones/i.test(u)) for (const k of ['authorization', 'x-client', 'x-device-id', 'x-fingerprint', 'x-platform-type', 'cookie']) if (h[k]) hdr[k] = h[k]; });
page.on('response', async (resp) => { if (/limited-phones/i.test(resp.url())) { try { if (JSON.parse(await resp.text())?.data?.phones?.[0]) gotRef = true; } catch {} } });
await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);
if (!(await page.locator('[data-testid="my-account-menu"], a[href*="/mojolx"]').first().isVisible({ timeout: 3000 }).catch(() => false))) { console.log('❌ nie zalogowany'); await browser.close(); process.exit(1); }
let capUrl = null;
for (const row of queue) { await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {}); await sleep(4000); const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count(); for (let j = 0; j < n; j++) { const b = btns.nth(j); if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); break; } } await sleep(6000); if (gotRef && userUuid) { capUrl = row.url; break; } }
await browser.close();
console.log(`\nFAZA A: złapano nagłówki=${Object.keys(hdr).join(',')} | userUuid=${userUuid ? 'JEST' : 'BRAK'}`);
if (!userUuid || !hdr['x-fingerprint']) { console.log('❌ brak nagłówków'); process.exit(1); }

// FAZA B: reveal INNYCH ogłoszeń czystym HTTP (ad_id z dekodu, nagłówki reużyte)
console.log('\n─── FAZA B: reveal INNYCH ogłoszeń czystym HTTP (dekod + reużyte nagłówki) ───');
let ok = 0, tried = 0;
for (const row of queue) {
  if (row.url === capUrl) continue;
  if (tried >= 2) break;                       // MAX 2 dodatkowe (bezpieczeństwo)
  tried++;
  const adId = adIdFromUrl(row.url);
  const res = await httpReveal(adId, hdr, userUuid);
  console.log(`  ad_id=${adId} → ${res.phone ? '✅ ' + res.phone : '❌ ' + (res.fail || res.raw)}`);
  if (res.phone) ok++;
  await sleep(2000);
}
console.log(`\n═══ ${ok}/${tried} innych ogłoszeń zrevelowanych CZYSTYM HTTP z reużytymi nagłówkami ═══`);
console.log(ok > 0 ? '✅✅✅ HYBRYDA POTWIERDZONA — capture raz, reveal wiele po HTTP, ad_id z dekodu!' : '⚠️ do analizy');
process.exit(0);
