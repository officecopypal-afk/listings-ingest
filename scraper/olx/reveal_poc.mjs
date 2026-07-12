/**
 * PoC reveala numeru OLX — SPIKE (nie produkcja). v2: bierze świeżą ofertę z search
 * (test Fazy 1 przy okazji), dłużej czeka na hydrację, i wypluwa strukturę przycisków
 * kontaktu gdy nie trafi selektorem.
 *
 * Weryfikuje: (1) friction bez CAPTCHy (challenge.type=="blank"), (2) czy reveal działa
 * BEZ logowania (limited-phones 200 + numer), (3) czas.
 * Flow (z HAR): klik "Pokaż numer" -> friction /challenge -> /exchange (JWT 15s, IP-bound)
 *   -> GET /api/v1/offers/{id}/limited-phones/ -> {"data":{"phones":["NNN NNN NNN"]}}.
 *
 * Env: IPROYAL_PROXY (wymagane). OLX_LISTING_URL (opcj. — konkretna oferta) LUB
 *      OLX_SEARCH_URL (opcj. — domyślnie mieszkania/sprzedaż prywatne najnowsze).
 */
import { chromium } from 'patchright';

const RAW_PROXY = process.env.IPROYAL_PROXY;
if (!RAW_PROXY) { console.error('Wymagane env: IPROYAL_PROXY'); process.exit(1); }
const SEARCH_URL = process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc&search%5Bfilter_enum_market%5D%5B0%5D=secondary';
let LISTING_URL = process.env.OLX_LISTING_URL || '';

// IPRoyal sticky session: ten sam IP na cały reveal (friction-token IP-bound, 15s).
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
  headless: true, proxy,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();

// Oszczędzamy GB: blokujemy grafikę/media/fonty/css (skrypty zostają — friction je liczy).
await page.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

page.on('response', async (res) => {
  const u = res.url();
  try {
    if (u.includes('friction.olxgroup.com/challenge')) cap.challengeType = (await res.json().catch(() => null))?.challenge?.type ?? '(nieznany)';
    else if (u.includes('friction.olxgroup.com/exchange')) cap.exchangeOk = res.ok();
    else if (u.includes('/limited-phones/')) { cap.phonesStatus = res.status(); cap.phones = await res.json().catch(() => null); }
  } catch {}
});

async function acceptCookies() {
  for (const name of [/akceptuj/i, /zgadzam/i, /zaakceptuj/i, /accept/i]) {
    try { const b = page.getByRole('button', { name }).first(); if (await b.isVisible({ timeout: 2000 })) { await b.click(); return; } } catch {}
  }
}

const t0 = Date.now();

// FAZA 1 mini: jak nie podano oferty, weź pierwszą świeżą z search.
if (!LISTING_URL) {
  console.log('→ search (świeża oferta):', SEARCH_URL);
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies();
  try { await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 15000 }); } catch {}
  LISTING_URL = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).find((h) => h.includes('olx.pl'));
    return a || '';
  });
  console.log(LISTING_URL ? '→ wybrana oferta: ' + LISTING_URL : '⚠ nie wyciągnąłem oferty z search (możliwy blok/friction na liście)');
}

if (LISTING_URL) {
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies();
  console.log('final URL :', page.url());
  console.log('title     :', await page.title());

  // Klik "Pokaż numer" — czekamy na hydrację (React) do 12s.
  let clicked = false;
  const btn = page.getByText(/poka[zż] numer/i).first();
  try { await btn.waitFor({ state: 'visible', timeout: 12000 }); await btn.click(); clicked = true; console.log('→ kliknięto "Pokaż numer"'); } catch {}
  if (!clicked) {
    for (const loc of [page.getByTestId('show-phone'), page.locator('[data-testid*="phone"]').first(), page.getByRole('button', { name: /numer|zadzwoń|kontakt/i }).first()]) {
      try { if (await loc.isVisible({ timeout: 2000 })) { await loc.click(); clicked = true; console.log('→ kliknięto (fallback)'); break; } } catch {}
    }
  }
  if (!clicked) {
    // DIAGNOSTYKA: wypluj kandydatów kontaktu, żeby poprawić selektor.
    const diag = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [data-testid], [data-cy]')];
      return els.filter((e) => /numer|telefon|pokaż|kontakt|zadzwoń|phone|contact/i.test(((e.innerText || '') + ' ' + (e.getAttribute('data-testid') || '') + ' ' + (e.getAttribute('data-cy') || ''))))
        .slice(0, 15).map((e) => ({ tag: e.tagName, testid: e.getAttribute('data-testid') || e.getAttribute('data-cy') || null, text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 45) }));
    });
    console.log('KANDYDACI kontaktu:', JSON.stringify(diag));
  }

  // Ściana logowania?
  let loginWall = false;
  try { if (await page.getByRole('button', { name: /zaloguj/i }).first().isVisible({ timeout: 2500 })) loginWall = true; } catch {}
  if (/\/login|account\.olx/i.test(page.url())) loginWall = true;

  for (let i = 0; i < 24 && cap.phonesStatus === null; i++) await page.waitForTimeout(500);

  const gotPhone = cap.phonesStatus === 200 && Array.isArray(cap.phones?.data?.phones) && cap.phones.data.phones.length > 0;
  console.log('\n===== DIAGNOZA =====');
  console.log('friction challenge.type :', cap.challengeType ?? '(brak — reveal nie ruszył)');
  console.log('limited-phones status   :', cap.phonesStatus ?? '(brak)');
  console.log('numer                   :', gotPhone ? cap.phones.data.phones.join(', ') : '(brak)');
  console.log('ściana logowania?       :', loginWall ? 'TAK' : 'nie');
  console.log('czas                    :', (Date.now() - t0) + 'ms');
  console.log('\nWNIOSEK:', gotPhone ? '✅ REVEAL BEZ LOGOWANIA DZIAŁA.' : loginWall ? '🔒 Wymaga logowania.' : cap.challengeType && cap.challengeType !== 'blank' ? `⚠ friction "${cap.challengeType}".` : '❓ Patrz KANDYDACI/final URL powyżej.');
  await browser.close();
  process.exit(gotPhone ? 0 : 1);
} else {
  await browser.close();
  process.exit(1);
}
