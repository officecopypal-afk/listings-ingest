/** Gruntowna diagnostyka: czemu klik "Pokaż" nie odpala reveala. Konsola + HTML + wszystkie requesty + URL. */
import { chromium } from 'patchright';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const COUNTRY = (process.env.PROXY_COUNTRY || 'pl').trim().toLowerCase();
const swap = (pp, c) => /_country-[a-z]{2}/i.test(pp) ? pp.replace(/_country-[a-z]{2}/i, `_country-${c}`) : `${pp}_country-${c}`;
const proxyCfg = () => ({ server: `http://${PH}:${PT}`, username: PU, password: `${swap(PP, COUNTRY)}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m` });
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=25&category_id=14&sort_by=created_at%3Adesc', { headers: { 'user-agent': UA, accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
const off = ((await lr.json())?.data || []).find(o => o.business === false && o.contact?.phone === true);
const url = off.url.split('?')[0];
console.log('oferta:', url.slice(-40));

const browser = await chromium.launch({ headless: true, proxy: proxyCfg(), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  const reqAfterClick = []; let clickedAt = 0;
  page.on('request', (r) => { if (clickedAt && Date.now() - clickedAt < 12000) { const u = r.url(); if (/friction|limited-phones|api\/v1|login|auth|captcha|datadome|challenge/i.test(u)) reqAfterClick.push(r.method() + ' ' + u.replace(/https?:\/\//, '').split('?')[0].slice(0, 50)); } });
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 90)); });
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(3000);
  // zgoda — czekaj i próbuj (też w iframe)
  let consent = false;
  for (let t = 0; t < 6 && !consent; t++) {
    for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Akceptuję")', 'button:has-text("Zaakceptuj wszystko")', '[data-testid="cookies-accept"]']) {
      try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 500 })) { await b.click({ timeout: 2000 }); consent = true; console.log('  ZGODA:', sel); break; } } catch {}
    }
    if (!consent) await sleep(1000);
  }
  console.log('  zgoda przyjęta?', consent);
  await sleep(2500);

  // stan PRZED klikiem
  console.log('  URL przed:', page.url().slice(0, 50));
  const htmlBefore = await page.locator('[data-testid="phones-container"]').first().evaluate(e => e.outerHTML).catch(() => '(brak kontenera)');
  console.log('  HTML kontenera PRZED:', htmlBefore.replace(/\s+/g, ' ').slice(0, 200));

  // klik
  clickedAt = Date.now();
  let clicked = false;
  const loc = page.locator('[data-testid="show-phone"]'); const cnt = await loc.count();
  for (let i = 0; i < cnt && !clicked; i++) {
    try { const b = loc.nth(i); await b.scrollIntoViewIfNeeded({ timeout: 2000 }); if (await b.isVisible()) { await b.click({ timeout: 3000 }); console.log('  KLIK #' + i); clicked = true; } } catch (e) { console.log('  klik#' + i + ' err:', e.message.slice(0, 40)); }
  }
  // fallback: klik przez JS
  if (clicked) { try { await loc.first().evaluate(e => e.click()).catch(() => {}); } catch {} }

  await sleep(11000);
  console.log('\n=== PO KLIKU ===');
  console.log('  requesty po kliku:', reqAfterClick.length ? reqAfterClick.join(' | ') : 'ŻADNYCH');
  console.log('  URL po:', page.url().slice(0, 50));
  const htmlAfter = await page.locator('[data-testid="phones-container"]').first().evaluate(e => e.outerHTML).catch(() => '(brak)');
  console.log('  HTML kontenera PO:', htmlAfter.replace(/\s+/g, ' ').slice(0, 200));
} catch (e) { console.log('BŁĄD:', e.message.slice(0, 150)); } finally { await browser.close(); }
