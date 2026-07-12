/**
 * PoC reveala numeru OLX — SPIKE. v5: agresywne zamknięcie zgody cookies (overlay blokował
 * formularz logowania i widoczność show-phone), dump /account/, DOM-click fallback na reveal.
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
await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
page.on('response', async (res) => {
  const u = res.url();
  try {
    if (u.includes('friction.olxgroup.com/challenge')) cap.challengeType = (await res.json().catch(() => null))?.challenge?.type ?? '(nieznany)';
    else if (u.includes('/limited-phones/')) { cap.phonesStatus = res.status(); cap.phones = await res.json().catch(() => null); }
  } catch {}
});
const isVis = (loc, t = 1500) => loc.isVisible({ timeout: t }).catch(() => false);

// Agresywna zgoda: skanujemy TEKST wszystkich buttonów (main + iframes) — trafia niezależnie od selektora.
async function acceptConsent() {
  for (const fr of [page.mainFrame(), ...page.frames()]) {
    try {
      const btns = fr.locator('button');
      const n = Math.min(await btns.count(), 40);
      for (let i = 0; i < n; i++) {
        const txt = ((await btns.nth(i).innerText().catch(() => '')) || '').trim();
        if (/^(akceptuj|akceptuję|zaakceptuj|zgadzam|akceptuj wszystk|zaakceptuj wszystk|przejdź do serwisu|accept all|zezwól na wszystk)/i.test(txt)) {
          await btns.nth(i).click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(1200);
          return txt.slice(0, 30);
        }
      }
    } catch {}
  }
  return null;
}

const t0 = Date.now();

// ---- LOGIN ----
let loggedIn = false;
if (EMAIL && PASSWORD) {
  console.log('→ logowanie:', EMAIL);
  await page.goto('https://www.olx.pl/account/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('consent:', await acceptConsent());
  await page.waitForTimeout(3500);
  console.log('/account/ url:', page.url().slice(0, 55));
  const st = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll('input')].map((i) => ({ n: i.name, t: i.type, tid: i.getAttribute('data-testid'), ph: (i.placeholder || '').slice(0, 15) })).slice(0, 8),
    buttons: [...document.querySelectorAll('button')].map((b) => ({ tid: b.getAttribute('data-testid'), text: (b.innerText || '').replace(/\s+/g, ' ').slice(0, 18) })).filter((b) => b.text || b.tid).slice(0, 12),
  }));
  console.log('/account/ state:', JSON.stringify(st));
  try {
    const email = page.locator('input[name="username"], input[type="email"], input[data-testid="username-input"], #username').first();
    if (await isVis(email, 8000)) {
      await email.fill(EMAIL);
      let pass = page.locator('input[type="password"], input[name="password"]').first();
      if (!(await isVis(pass, 1500))) { await page.getByRole('button', { name: /dalej|kontynuuj|continue/i }).first().click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(1500); pass = page.locator('input[type="password"]').first(); }
      await pass.fill(PASSWORD);
      await page.getByRole('button', { name: /^zaloguj|log in|sign in/i }).first().click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(6000);
      const captcha = await isVis(page.getByText(/captcha|nie jestem robotem|weryfikacj|potwierdź, że/i).first());
      const stillForm = await isVis(page.locator('input[type="password"]').first());
      loggedIn = !captcha && !stillForm;
      console.log('po logowaniu:', page.url().slice(0, 45), '|', captcha ? '⚠ CAPTCHA' : stillForm ? '⚠ nadal formularz' : '✓ OK');
    } else console.log('⚠ brak pola email (patrz /account/ state)');
  } catch (e) { console.log('⚠ login error:', String(e.message).slice(0, 110)); }
}

// ---- SEARCH -> ORGANICZNA ----
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
  await page.waitForTimeout(2500);
  const adLogin = await isVis(page.getByTestId('ad-login-dialog').first(), 2000);
  const hasBtn = await page.locator('[data-testid="show-phone"]').count().catch(() => 0);
  console.log('show-phone w DOM:', hasBtn);

  let clicked = false;
  try { await page.getByTestId('show-phone').first().click({ timeout: 8000 }); clicked = true; console.log('→ klik show-phone'); } catch {}
  if (!clicked && hasBtn) { // fallback: klik przez DOM (omija "visibility")
    await page.evaluate(() => document.querySelector('[data-testid="show-phone"]')?.click());
    clicked = true; console.log('→ klik show-phone (DOM fallback)');
  }

  for (let i = 0; i < 24 && cap.phonesStatus === null; i++) await page.waitForTimeout(500);
  const gotPhone = cap.phonesStatus === 200 && Array.isArray(cap.phones?.data?.phones) && cap.phones.data.phones.length > 0;
  console.log('\n===== DIAGNOZA =====');
  console.log('zalogowany              :', loggedIn ? 'TAK' : 'nie/niepewne');
  console.log('ad-login-dialog         :', adLogin ? 'TAK (NIEzalogowany)' : 'nie');
  console.log('friction challenge.type :', cap.challengeType ?? '(brak)');
  console.log('limited-phones status   :', cap.phonesStatus ?? '(brak)');
  console.log('numer                   :', gotPhone ? cap.phones.data.phones.join(', ') : '(brak)');
  console.log('czas                    :', (Date.now() - t0) + 'ms');
  console.log('\nWNIOSEK:', gotPhone ? '✅ ZALOGOWANY REVEAL DZIAŁA end-to-end.' : adLogin ? '🔒 Niezalogowany (login nie przeszedł).' : cap.challengeType && cap.challengeType !== 'blank' ? `⚠ friction "${cap.challengeType}".` : '❓ Patrz logi.');
  await browser.close();
  process.exit(gotPhone ? 0 : 1);
}
await browser.close();
process.exit(1);
