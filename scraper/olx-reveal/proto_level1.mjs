/** PROTOTYP POZIOM 1 — reveal przez SAME API calle (challenge→exchange→limited-phones), BEZ ładowania stron ogłoszeń.
 *  LOKALNY (Mac, home IP, bez proxy). 1 konto. Robi: 1 reveal NORMALNIE (łapie stałe nagłówki + numeryczne ad_id),
 *  potem TEN SAM reveal API-ONLY (page.evaluate fetch) — udowadnia że numer wchodzi bez ładowania strony.
 *  BEZPIECZEŃSTWO: 1 realny reveal + 1-2 API-only (te same/lekkie). Użycie: node proto_level1.mjs [konto1] */
import { chromium } from 'patchright';
import fs from 'fs';
import os from 'os';

const ACC = process.argv[2] || 'konto1';
const HOME = os.homedir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = fs.readFileSync(`${HOME}/Desktop/Audyteko/.env.local`, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
const SB = get('NEXT_PUBLIC_SUPABASE_URL'), KEY = get('SUPABASE_SERVICE_ROLE_KEY');
async function rpc(fn, body) { const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }

const state = JSON.parse(fs.readFileSync(`${HOME}/Desktop/listings-ingest/scraper/olx-reveal/session_${ACC}.json`, 'utf8'));
const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: 3, p_claim_min: 3 });
console.log(`konto: ${ACC} | ogłoszeń: ${queue?.length} | home IP, bez proxy`);
if (!queue?.length) { console.log('brak ogłoszeń'); process.exit(1); }

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

// przechwyć stałe nagłówki + numeryczne ad_id z pierwszego realnego reveala
let hdr = {}, userUuid = null, adId = null, realPhone = null;
page.on('request', (req) => {
  const u = req.url(), h = req.headers();
  if (/friction\.olxgroup\.com\/challenge/i.test(u)) { try { const b = JSON.parse(req.postData() || '{}'); userUuid = b?.actor?.username; adId = b?.scene?.ad_id; } catch {} if (h['x-user-tests']) hdr['x-user-tests'] = h['x-user-tests']; }
  if (/limited-phones/i.test(u)) { for (const k of ['authorization', 'x-client', 'x-device-id', 'x-fingerprint', 'x-platform-type']) if (h[k]) hdr[k] = h[k]; }
});
page.on('response', async (resp) => { if (/limited-phones/i.test(resp.url())) { try { const j = JSON.parse(await resp.text()); if (j?.data?.phones?.[0]) realPhone = j.data.phones[0]; } catch {} } });

await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
await sleep(6000);
const logged = await page.locator('[data-testid="my-account-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 3000 }).catch(() => false);
console.log(`zalogowany: ${logged}`);
if (!logged) { console.log('❌ nie zalogowany — stop'); await browser.close(); process.exit(1); }

// 1) REVEAL NORMALNY — na ogłoszeniu które MA numer (szukamy klikalnego)
console.log('\n─── KROK 1: reveal normalnie (łapię nagłówki + ad_id) ───');
let usedUrl = null;
for (const row of queue) {
  await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(4000);
  const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
  let clicked = false;
  for (let j = 0; j < n; j++) { const b = btns.nth(j); if (await b.isVisible().catch(() => false)) { await b.click({ timeout: 3000 }).catch(() => {}); clicked = true; break; } }
  await sleep(6000);
  if (realPhone && adId) { usedUrl = row.url; break; }
  console.log(`  ...${row.url.slice(-30)} klik:${clicked} numer:${realPhone || '—'} — próbuję kolejne`);
}
console.log(`normalny reveal: numer=${realPhone} | ad_id=${adId} | userUuid=${userUuid}`);
console.log(`złapane nagłówki: ${Object.keys(hdr).join(', ')}`);
if (!realPhone || !adId) { console.log('❌ nie udało się złapać referencyjnego reveala — stop'); await browser.close(); process.exit(1); }

// 2) TEN SAM reveal API-ONLY (bez ładowania strony) — z wnętrza obecnej strony
console.log('\n─── KROK 2: TEN SAM reveal API-ONLY (3 fetche, ZERO ładowania strony) ───');
const apiRes = await page.evaluate(async ({ adId, hdr, userUuid }) => {
  try {
    const ch = await (await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-user-tests': hdr['x-user-tests'] || '' }, body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: userUuid }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: adId } }) })).json();
    if (ch?.challenge?.type !== 'blank') return { captcha: true, type: ch?.challenge?.type, ch };
    const ex = await (await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ context: ch.context }) })).json();
    const lpResp = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones/`, { credentials: 'include', headers: { authorization: hdr['authorization'], 'x-client': hdr['x-client'] || 'DESKTOP', 'x-device-id': hdr['x-device-id'], 'x-fingerprint': hdr['x-fingerprint'], 'x-platform-type': hdr['x-platform-type'] || 'mobile-html5', 'friction-token': ex.token } });
    const lp = await lpResp.json();
    return { challengeType: ch?.challenge?.type, status: lpResp.status, phones: lp?.data?.phones, raw: JSON.stringify(lp).slice(0, 200) };
  } catch (e) { return { error: String(e.message) }; }
}, { adId, hdr, userUuid });

console.log('WYNIK API-ONLY:', JSON.stringify(apiRes));
console.log(`\n═══ PORÓWNANIE: normalnie="${realPhone}" vs API-only="${apiRes.phones?.[0] || apiRes.error || apiRes.type}" ═══`);
console.log(apiRes.phones?.[0] === realPhone ? '✅ POZIOM 1 DZIAŁA — numer wchodzi API-only, ZERO ładowania strony!' : '⚠️ różnica / do analizy');
await browser.close();
process.exit(0);
