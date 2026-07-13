/** Walidacja: czy PRZEGLĄDARKA (patchright) odsłoni numer mimo "blank challenge"? Diagnostyka na 1 ofercie. */
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

// świeża oferta prywatna
const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=25&category_id=14&sort_by=created_at%3Adesc', { headers: { 'user-agent': UA, accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
const off = ((await lr.json())?.data || []).find(o => o.business === false && o.contact?.phone === true);
const url = off.url.split('?')[0];
console.log('oferta:', url.slice(-40), '| kontakt.phone:', off.contact?.phone, '| kraj:', COUNTRY);

const browser = await chromium.launch({ headless: true, proxy: proxyCfg(), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

  // przechwyć odpowiedź limited-phones (to co przeglądarka dostanie po kliknięciu)
  let phoneResult = null;
  page.on('response', async (resp) => {
    if (/limited-phones/i.test(resp.url())) {
      const status = resp.status();
      let body = ''; try { body = await resp.text(); } catch {}
      phoneResult = { status, body: body.slice(0, 200) };
      console.log(`  >>> limited-phones przechwycone: HTTP ${status} → ${body.slice(0, 150)}`);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  console.log('  załadowano, title:', (await page.title().catch(() => '')).slice(0, 45));
  await sleep(2500);

  // zgoda na cookies (jak jest)
  for (const sel of ['button[id*="accept"]', 'button:has-text("Akceptuję")', 'button:has-text("Zaakceptuj")', '#onetrust-accept-btn-handler']) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1000 })) { await b.click({ timeout: 2000 }); console.log('  cookies zaakceptowane:', sel); break; } } catch {}
  }
  await sleep(1500);

  // znajdź przycisk odsłaniania numeru — loguj kandydatów
  const candidates = await page.evaluate(() => [...document.querySelectorAll('button, a, [data-testid], [data-cy]')]
    .filter(e => /numer|telefon|zadzwoń|pokaż/i.test(e.textContent || ''))
    .map(e => ({ tag: e.tagName, txt: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), testid: e.getAttribute('data-testid') || e.getAttribute('data-cy') || '' })).slice(0, 8));
  console.log('  kandydaci na przycisk numeru:', JSON.stringify(candidates));

  // spróbuj kliknąć najlepszego
  let clicked = false;
  for (const sel of ['[data-testid="show-phone"]', '[data-cy="ad-contact-phone"]', 'button:has-text("Pokaż numer")', 'button:has-text("numer")', 'a:has-text("Pokaż numer")']) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click({ timeout: 3000 }); console.log('  KLIKNIĘTO:', sel); clicked = true; break; } } catch {}
  }
  if (!clicked) console.log('  ⚠️ nie znalazłem przycisku do kliknięcia (patrz kandydaci wyżej)');

  await sleep(6000); // daj przeglądarce rozwiązać challenge + zrobić request

  // odczytaj numer z DOM też (fallback)
  const domPhone = await page.evaluate(() => { const m = (document.body.innerText || '').match(/(?:\+?48[\s-]?)?(?:\d[\s-]?){8}\d/g); return m ? m.filter(x => x.replace(/\D/g, '').length >= 9).slice(0, 3) : []; }).catch(() => []);
  console.log('\n=== WYNIK ===');
  console.log('  limited-phones:', phoneResult ? `HTTP ${phoneResult.status} ${phoneResult.body}` : 'BRAK (nie zrobił requestu / challenge nie przeszło)');
  console.log('  numer w DOM:', domPhone.length ? domPhone.join(', ') : 'brak');
} catch (e) { console.log('BŁĄD:', e.message.slice(0, 150)); } finally { await browser.close(); }
