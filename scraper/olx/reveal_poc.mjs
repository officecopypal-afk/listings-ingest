/**
 * PoC reveala numeru OLX — SPIKE. v4: iframe-aware login + organiczna oferta + reveal.
 * Ustalone: reveal WYMAGA logowania; przycisk = data-testid="show-phone"; formularz logowania
 * NIE jest w top-frame /account/ (iframe / za zgodą cookies); pierwsza oferta z search bywa
 * PROMOWANA (inny layout) -> bierzemy organiczną.
 * Env: IPROYAL_PROXY, OLX_EMAIL, OLX_PASSWORD, OLX_SEARCH_URL (opcj).
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
await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue())); // css zostaje (layout)
page.on('response', async (res) => {
  const u = res.url();
  try {
    if (u.includes('friction.olxgroup.com/challenge')) cap.challengeType = (await res.json().catch(() => null))?.challenge?.type ?? '(nieznany)';
    else if (u.includes('/limited-phones/')) { cap.phonesStatus = res.status(); cap.phones = await res.json().catch(() => null); }
  } catch {}
});
const isVis = (loc, t = 1500) => loc.isVisible({ timeout: t }).catch(() => false);
async function acceptConsent() {
  const sels = ['#onetrust-accept-btn-handler', '[data-testid="cookies-accept-button"]', 'button:has-text("Akceptuj")', 'button:has-text("Akceptuję")', 'button:has-text("Zgadzam")'];
  for (const fr of [page.mainFrame(), ...page.frames()]) {
    for (const s of sels) { try { const b = fr.locator(s).first(); if (await b.isVisible({ timeout: 1200 })) { await b.click(); await page.waitForTimeout(1000); return true; } } catch {} }
  }
  return false;
}

const t0 = Date.now();

// ---- LOGIN (iframe-aware) ----
let loggedIn = false;
if (EMAIL && PASSWORD) {
  console.log('→ logowanie:', EMAIL);
  await page.goto('https://www.olx.pl/account/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('consent:', await acceptConsent());
  await page.waitForTimeout(3500);
  let lf = null;
  for (const fr of [page.mainFrame(), ...page.frames()]) {
    const n = await fr.locator('input[type="password"], input[name="password"], input[name="username"], input[type="email"]').count().catch(() => 0);
    if (n > 0) { lf = fr; break; }
  }
  if (!lf) {
    for (const fr of page.frames()) {
      const inp = await fr.evaluate(() => [...document.querySelectorAll('input')].map((i) => ({ n: i.name, t: i.type, tid: i.getAttribute('data-testid') }))).catch(() => []);
      if (inp.length) console.log('FRAME', fr.url().slice(0, 55), JSON.stringify(inp));
    }
    console.log('⚠ nie znalazłem formularza logowania w żadnej ramce');
  } else {
    console.log('login frame:', lf.url().slice(0, 60));
    try {
      const email = lf.locator('input[name="username"], input[type="email"], #username').first();
      await email.fill(EMAIL, { timeout: 8000 });
      let pass = lf.locator('input[type="password"], input[name="password"]').first();
      if (!(await isVis(pass, 1500))) { await lf.getByRole('button', { name: /dalej|kontynuuj|continue/i }).first().click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(1500); pass = lf.locator('input[type="password"]').first(); }
      await pass.fill(PASSWORD, { timeout: 8000 });
      await lf.getByRole('button', { name: /zaloguj|log in|sign in/i }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const captcha = await isVis(page.getByText(/captcha|nie jestem robotem|weryfikacj|potwierdź, że/i).first());
      const stillForm = await lf.locator('input[type="password"]').first().isVisible({ timeout: 1500 }).catch(() => false);
      loggedIn = !captcha && !stillForm;
      console.log('po logowaniu:', page.url().slice(0, 50), '|', captcha ? '⚠ CAPTCHA' : stillForm ? '⚠ nadal formularz' : '✓ OK');
    } catch (e) { console.log('⚠ login error:', String(e.message).slice(0, 120)); }
  }
}

// ---- SEARCH -> ORGANICZNA oferta ----
console.log('→ search');
await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await acceptConsent();
try { await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 15000 }); } catch {}
const LISTING_URL = await page.evaluate(() => {
  const links = [...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).filter((h) => h.includes('olx.pl'));
  return links.find((h) => /organic/.test(h)) || links.find((h) => !/promoted/.test(h)) || links[0] || '';
});
console.log('→ oferta:', LISTING_URL || '(brak)');

if (LISTING_URL) {
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await acceptConsent();
  console.log('title:', (await page.title()).slice(0, 60));
  const adLogin = await isVis(page.getByTestId('ad-login-dialog').first(), 2000);

  let clicked = false;
  const btn = page.getByTestId('show-phone').first();
  try {
    await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
    await btn.waitFor({ state: 'visible', timeout: 18000 });
    await btn.click();
    clicked = true;
    console.log('→ kliknięto show-phone');
  } catch (e) { console.log('⚠ show-phone:', String(e.message).slice(0, 70)); }

  for (let i = 0; i < 24 && cap.phonesStatus === null; i++) await page.waitForTimeout(500);

  const gotPhone = cap.phonesStatus === 200 && Array.isArray(cap.phones?.data?.phones) && cap.phones.data.phones.length > 0;
  console.log('\n===== DIAGNOZA =====');
  console.log('zalogowany              :', loggedIn ? 'TAK' : 'nie/niepewne');
  console.log('ad-login-dialog         :', adLogin ? 'TAK (NIEzalogowany)' : 'nie');
  console.log('kliknięto show-phone    :', clicked ? 'TAK' : 'nie');
  console.log('friction challenge.type :', cap.challengeType ?? '(brak)');
  console.log('limited-phones status   :', cap.phonesStatus ?? '(brak)');
  console.log('numer                   :', gotPhone ? cap.phones.data.phones.join(', ') : '(brak)');
  console.log('czas                    :', (Date.now() - t0) + 'ms');
  console.log('\nWNIOSEK:', gotPhone ? '✅ ZALOGOWANY REVEAL DZIAŁA end-to-end.' : adLogin ? '🔒 Nadal niezalogowany.' : cap.challengeType && cap.challengeType !== 'blank' ? `⚠ friction "${cap.challengeType}".` : '❓ Patrz logi.');
  await browser.close();
  process.exit(gotPhone ? 0 : 1);
}
await browser.close();
process.exit(1);
