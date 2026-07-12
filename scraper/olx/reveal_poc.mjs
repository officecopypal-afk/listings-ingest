/**
 * PoC reveala numeru OLX — SPIKE (nie produkcja).
 *
 * Cel: zweryfikować EMPIRYCZNIE w docelowym środowisku (GH Actions + IPRoyal PL residential):
 *   1) czy patchright + proxy przechodzi OLX "friction" bez CAPTCHy (challenge.type == "blank"),
 *   2) czy reveal DZIAŁA BEZ LOGOWANIA (limited-phones 200 + numer) czy wymaga konta,
 *   3) realny czas jednego reveala.
 *
 * Flow reveala (odtworzony z HAR):
 *   klik "Pokaż numer"
 *     -> POST friction.olxgroup.com/challenge  -> {context, challenge.type}
 *     -> POST friction.olxgroup.com/exchange   -> {token}  (JWT ~15s, przypięty do IP + ad_id)
 *     -> GET  www.olx.pl/api/v1/offers/{id}/limited-phones/  (nagłówek friction-token + x-fingerprint)
 *        -> {"data":{"phones":["NNN NNN NNN"]}}
 * OLX-owy JS robi to sam po kliknięciu — my tylko przechwytujemy odpowiedzi.
 *
 * Uruchomienie:
 *   IPROYAL_PROXY="http://USER:PASS_country-pl@geo.iproyal.com:12321" \
 *   OLX_LISTING_URL="https://www.olx.pl/d/oferta/...-IDxxxx.html" \
 *   node reveal_poc.mjs
 */
import { chromium } from 'patchright';

const LISTING_URL = process.env.OLX_LISTING_URL;
const RAW_PROXY = process.env.IPROYAL_PROXY;
if (!LISTING_URL || !RAW_PROXY) {
  console.error('Wymagane env: OLX_LISTING_URL, IPROYAL_PROXY');
  process.exit(1);
}

// IPRoyal sticky session: doklejamy _session-<rand>_lifetime-5m do hasła, żeby CAŁY reveal
// (challenge -> exchange -> limited-phones) leciał z JEDNEGO IP. friction-token jest IP-bound
// i żyje ~15s, więc rotacja per-request ("Randomize IP") by go unieważniła.
function toStickyProxy(raw) {
  const m = raw.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (!m) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
  const [, user, pass, host, port] = m;
  const sid = Math.random().toString(36).slice(2, 12);
  return { server: `http://${host}:${port}`, username: user, password: `${pass}_session-${sid}_lifetime-5m` };
}

const proxy = toStickyProxy(RAW_PROXY);
const cap = { challengeType: null, exchangeOk: null, phonesStatus: null, phones: null };

const browser = await chromium.launch({
  headless: true,
  proxy,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
  viewport: { width: 1366, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

// Oszczędzamy GB proxy: blokujemy grafikę/media/fonty/css. SKRYPTY MUSZĄ zostać — friction
// liczy fingerprint z JS. (~0,3-0,7 MB/ofertę zamiast kilku MB.)
await page.route('**/*', (route) => {
  const t = route.request().resourceType();
  return ['image', 'media', 'font', 'stylesheet'].includes(t) ? route.abort() : route.continue();
});

// Przechwytujemy odpowiedzi friction + reveal.
page.on('response', async (res) => {
  const u = res.url();
  try {
    if (u.includes('friction.olxgroup.com/challenge')) {
      const j = await res.json().catch(() => null);
      cap.challengeType = j?.challenge?.type ?? '(nieznany)';
    } else if (u.includes('friction.olxgroup.com/exchange')) {
      cap.exchangeOk = res.ok();
    } else if (u.includes('/limited-phones/')) {
      cap.phonesStatus = res.status();
      cap.phones = await res.json().catch(() => null);
    }
  } catch {}
});

const t0 = Date.now();
console.log('→ ładuję ofertę przez PL residential:', LISTING_URL);
await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });

// Baner cookies (best-effort, nie blokuje).
try {
  const c = page.getByRole('button', { name: /akceptuj|zgadzam|zaakceptuj/i }).first();
  if (await c.isVisible({ timeout: 3000 })) await c.click();
} catch {}

// Klik "Pokaż numer" — kilka fallbacków (OLX zmienia selektory).
let clicked = false;
const candidates = [
  page.getByTestId('show-phone'),
  page.getByRole('button', { name: /pokaż numer|wyświetl numer|zobacz numer/i }).first(),
  page.locator('[data-testid="contact-phone"]').first(),
  page.getByText(/pokaż numer/i).first(),
];
for (const loc of candidates) {
  try {
    if (await loc.isVisible({ timeout: 4000 })) {
      await loc.click();
      clicked = true;
      break;
    }
  } catch {}
}
console.log(clicked ? '→ kliknięto "Pokaż numer"' : '⚠ nie znalazłem przycisku (sprawdzę selektor po pierwszym runie)');

// Ściana logowania? (modal / redirect)
let loginWall = false;
try {
  const l = page.getByRole('button', { name: /zaloguj/i }).first();
  if (await l.isVisible({ timeout: 2500 })) loginWall = true;
} catch {}
if (/\/login|account\.olx/i.test(page.url())) loginWall = true;

// Czekamy na limited-phones do ~12s.
for (let i = 0; i < 24 && cap.phonesStatus === null; i++) await page.waitForTimeout(500);

const ms = Date.now() - t0;
const gotPhone = cap.phonesStatus === 200 && Array.isArray(cap.phones?.data?.phones) && cap.phones.data.phones.length > 0;

console.log('\n===== DIAGNOZA =====');
console.log('friction challenge.type :', cap.challengeType ?? '(brak — friction nie ruszył?)');
console.log('friction exchange ok    :', cap.exchangeOk ?? '(brak)');
console.log('limited-phones status   :', cap.phonesStatus ?? '(brak odpowiedzi)');
console.log('numer                   :', gotPhone ? cap.phones.data.phones.join(', ') : '(brak)');
console.log('ściana logowania?       :', loginWall ? 'TAK' : 'nie wykryto');
console.log('czas                    :', ms + 'ms');
console.log(
  '\nWNIOSEK:',
  gotPhone
    ? '✅ REVEAL BEZ LOGOWANIA DZIAŁA — konta zbędne, idziemy anonimowo + rotacja IP.'
    : loginWall
    ? '🔒 Wymaga logowania — wchodzą konta (logowanie przed revealem).'
    : cap.challengeType && cap.challengeType !== 'blank'
    ? `⚠ friction rzucił wyzwanie "${cap.challengeType}" — trzeba mocniejszy stealth (headful+xvfb / real Chrome) albo solver.`
    : cap.phonesStatus && cap.phonesStatus >= 400
    ? `⚠ limited-phones ${cap.phonesStatus} — limit/login/friction, patrz logi.`
    : '❓ Niejednoznaczne — przycisk mógł się nie znaleźć; podejrzę strukturę strony i poprawię selektor.'
);

await browser.close();
process.exit(gotPhone ? 0 : 1);
