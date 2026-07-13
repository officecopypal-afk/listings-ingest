/** Walidacja: czy PRZEGLĄDARKA odsłoni numer mimo "blank"? Podsłuch friction+limited-phones + klik. */
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
console.log('oferta:', url.slice(-40), '| kraj:', COUNTRY);

const browser = await chromium.launch({ headless: true, proxy: proxyCfg(), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

  let phoneResult = null;
  page.on('response', async (resp) => {
    const u = resp.url();
    if (/friction\.olxgroup|limited-phones/i.test(u)) {
      let body = ''; try { body = await resp.text(); } catch {}
      console.log(`  >>> ${u.replace(/https?:\/\//, '').split('?')[0].slice(0, 42)} HTTP ${resp.status()} → ${body.slice(0, 110)}`);
      if (/limited-phones/i.test(u)) phoneResult = { status: resp.status(), body: body.slice(0, 200) };
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(2500);
  for (const sel of ['#onetrust-accept-btn-handler', 'button[id*="accept"]', 'button:has-text("Akceptuję")']) {
    try { const b = page.locator(sel).first(); if (await b.isVisible({ timeout: 1000 })) { await b.click({ timeout: 2000 }); console.log('  cookies ok'); break; } } catch {}
  }
  await sleep(2000);

  // klik "Pokaż" w kontenerze telefonu (a jak nie, dowolny show-phone)
  let clicked = false;
  for (const sel of ['[data-testid="phones-container"] [data-testid="show-phone"]', '[data-testid="show-phone"]']) {
    const loc = page.locator(sel); const cnt = await loc.count();
    for (let i = 0; i < cnt && !clicked; i++) {
      try { const b = loc.nth(i); await b.scrollIntoViewIfNeeded({ timeout: 2000 }); if (await b.isVisible()) { await b.hover().catch(() => {}); await sleep(300); await b.click({ timeout: 3000 }); console.log(`  KLIKNIĘTO ${sel} #${i}`); clicked = true; } } catch (e) { console.log('  klik err:', e.message.slice(0, 45)); }
    }
    if (clicked) break;
  }
  if (!clicked) console.log('  ⚠️ nie kliknąłem');

  await sleep(10000); // czas na challenge + request

  const containerTxt = await page.locator('[data-testid="phones-container"]').first().innerText().catch(() => '');
  console.log('\n=== WYNIK ===');
  console.log('  limited-phones:', phoneResult ? `HTTP ${phoneResult.status} ${phoneResult.body}` : 'BRAK requestu');
  console.log('  phones-container:', containerTxt.replace(/\s+/g, ' ').slice(0, 60) || 'pusto');
} catch (e) { console.log('BŁĄD:', e.message.slice(0, 150)); } finally { await browser.close(); }
