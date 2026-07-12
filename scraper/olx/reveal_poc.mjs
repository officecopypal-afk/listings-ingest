/**
 * PoC reveala numeru OLX — SPIKE. v3: login (konto) -> search (świeża oferta) -> reveal.
 * Ustalone w v2: reveal WYMAGA logowania (anon => data-testid="ad-login-dialog"),
 * przycisk = data-testid="show-phone". Teraz testujemy zalogowaną ścieżkę end-to-end.
 * Flow reveala (z HAR): klik show-phone -> friction /challenge -> /exchange (JWT 15s IP-bound)
 *   -> GET /api/v1/offers/{id}/limited-phones/ -> {"data":{"phones":["NNN NNN NNN"]}}.
 * Env: IPROYAL_PROXY (wymagane), OLX_EMAIL + OLX_PASSWORD (konto), OLX_SEARCH_URL (opcj).
 */
import { chromium } from 'patchright';

const RAW_PROXY = process.env.IPROYAL_PROXY;
if (!RAW_PROXY) { console.error('Wymagane: IPROYAL_PROXY'); process.exit(1); }
const EMAIL = process.env.OLX_EMAIL || '';
const PASSWORD = process.env.OLX_PASSWORD || '';
const SEARCH_URL = process.env.OLX_SEARCH_URL ||
  'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc&search%5Bfilter_enum_market%5D%5B0%5D=secondary';

function toStickyProxy(raw) {
  const m = raw.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (!m) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
  const [, user, pass, host, port] = m;
  const sid = Math.random().toString(36).slice(2, 12);
  return { server: `http://${host}:${port}`, username: user, password: `${pass}_session-${sid}_lifetime-10m` };
}

const proxy = toStickyProxy(RAW_PROXY);
const cap = { challengeType: null, phonesStatus: null, phones: null };

const browser = await chromium.launch({ headless: true, proxy, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
await page.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
page.on('response', async (res) => {
  const u = res.url();
  try {
    if (u.includes('friction.olxgroup.com/challenge')) cap.challengeType = (await res.json().catch(() => null))?.challenge?.type ?? '(nieznany)';
    else if (u.includes('/limited-phones/')) { cap.phonesStatus = res.status(); cap.phones = await res.json().catch(() => null); }
  } catch {}
});
async function acceptCookies() {
  for (const name of [/akceptuj/i, /zgadzam/i, /zaakceptuj/i, /accept/i]) {
    try { const b = page.getByRole('button', { name }).first(); if (await b.isVisible({ timeout: 2000 })) { await b.click(); return; } } catch {}
  }
}
const isVis = (loc, t = 1500) => loc.isVisible({ timeout: t }).catch(() => false);

const t0 = Date.now();

// ---- LOGIN ----
let loggedIn = false;
if (EMAIL && PASSWORD) {
  console.log('→ logowanie:', EMAIL);
  await page.goto('https://www.olx.pl/account/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies();
  await page.waitForTimeout(2000);
  const form = await page.evaluate(() => ({
    url: location.href,
    inputs: [...document.querySelectorAll('input')].slice(0, 8).map((i) => ({ name: i.name, type: i.type, testid: i.getAttribute('data-testid'), ph: i.placeholder })),
    buttons: [...document.querySelectorAll('button')].map((b) => ({ testid: b.getAttribute('data-testid'), text: (b.innerText || '').replace(/\s+/g, ' ').slice(0, 22) })).filter((b) => b.text || b.testid).slice(0, 10),
  }));
  console.log('LOGIN FORM:', JSON.stringify(form));
  try {
    const email = page.locator('input[name="username"], input[type="email"], input[data-testid="username-input"], #username').first();
    await email.waitFor({ state: 'visible', timeout: 10000 });
    await email.fill(EMAIL);
    let pass = page.locator('input[name="password"], input[type="password"], input[data-testid="password-input"], #password').first();
    if (!(await isVis(pass, 2000))) {
      await page.getByRole('button', { name: /dalej|kontynuuj|continue/i }).first().click().catch(() => {});
      await page.waitForTimeout(1500);
      pass = page.locator('input[type="password"], input[name="password"]').first();
    }
    await pass.fill(PASSWORD);
    await page.getByRole('button', { name: /zaloguj|log in|sign in/i }).first().click();
    await page.waitForTimeout(6000);
    const captcha = await isVis(page.getByText(/captcha|nie jestem robotem|weryfikacj|potwierdź, że/i).first());
    const stillForm = await isVis(page.locator('input[type="password"]').first());
    loggedIn = !captcha && !stillForm;
    console.log('po logowaniu URL:', page.url(), '| status:', captcha ? '⚠ CAPTCHA' : stillForm ? '⚠ nadal formularz (złe dane / 2-step / blok)' : '✓ OK');
  } catch (e) { console.log('⚠ login error:', String(e.message).slice(0, 140)); }
}

// ---- SEARCH -> LISTING ----
console.log('→ search:', SEARCH_URL);
await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await acceptCookies();
try { await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 15000 }); } catch {}
const LISTING_URL = await page.evaluate(() => ([...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).find((h) => h.includes('olx.pl')) || ''));
console.log('→ oferta:', LISTING_URL || '(brak)');

if (LISTING_URL) {
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptCookies();
  console.log('title:', await page.title());

  const adLogin = await isVis(page.getByTestId('ad-login-dialog').first(), 2000);
  let clicked = false;
  const btn = page.getByTestId('show-phone').first();
  try { await btn.waitFor({ state: 'visible', timeout: 12000 }); await btn.click(); clicked = true; console.log('→ kliknięto show-phone'); } catch (e) { console.log('⚠ show-phone:', String(e.message).slice(0, 80)); }

  for (let i = 0; i < 24 && cap.phonesStatus === null; i++) await page.waitForTimeout(500);

  const gotPhone = cap.phonesStatus === 200 && Array.isArray(cap.phones?.data?.phones) && cap.phones.data.phones.length > 0;
  console.log('\n===== DIAGNOZA =====');
  console.log('zalogowany              :', loggedIn ? 'TAK' : 'nie/niepewne');
  console.log('ad-login-dialog na str. :', adLogin ? 'TAK (czyli NIEzalogowany)' : 'nie');
  console.log('friction challenge.type :', cap.challengeType ?? '(brak)');
  console.log('limited-phones status   :', cap.phonesStatus ?? '(brak)');
  console.log('numer                   :', gotPhone ? cap.phones.data.phones.join(', ') : '(brak)');
  console.log('czas                    :', (Date.now() - t0) + 'ms');
  console.log('\nWNIOSEK:', gotPhone ? '✅ ZALOGOWANY REVEAL DZIAŁA end-to-end — droga potwierdzona.' : adLogin ? '🔒 Wciąż niezalogowany (login nie przeszedł).' : cap.challengeType && cap.challengeType !== 'blank' ? `⚠ friction "${cap.challengeType}".` : '❓ Patrz logi (login status / show-phone).');
  await browser.close();
  process.exit(gotPhone ? 0 : 1);
}
await browser.close();
process.exit(1);
