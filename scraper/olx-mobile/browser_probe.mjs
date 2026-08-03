/**
 * PROBA: czy OLX blokuje nas po odcisku klienta (nie po IP)?
 *
 * Od 31.07.2026 każde zapytanie HTTP do www.olx.pl wraca z 403 CloudFronta — z KAŻDEGO IP
 * (łącze domowe, proxy IPRoyal, runner GitHuba) i KAŻDYM klientem (undici 6, undici 8, curl).
 * Ten test odpala prawdziwą przeglądarkę NA TYM SAMYM runnerze i pyta o ten sam adres.
 * Jedyna zmienna to klient. Bez kont, bez tokenów, bez reveala.
 *
 * 200 z przeglądarki + 403 ze skryptu → blokada po odcisku, droga powrotu = przeglądarka.
 * 403 z obu                          → blokada szersza, przeglądarka nas nie uratuje.
 */
import { chromium } from 'patchright';

const API = 'https://www.olx.pl/api/v1/offers/?offset=0&limit=1&category_id=14&sort_by=created_at%3Adesc';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// punkt odniesienia: ten sam adres, ten sam runner, zwykły fetch
try {
  const r = await fetch(API, { headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'pl', referer: 'https://www.olx.pl/' } });
  const t = await r.text();
  console.log(`[skrypt   ] HTTP ${r.status} ${r.status === 200 && t.startsWith('{') ? '✅ PRZECHODZI' : '⛔ BLOKADA'}`);
} catch (e) { console.log(`[skrypt   ] błąd: ${e.message}`); }

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
const page = await ctx.newPage();

// 1) strona główna — czy w ogóle wpuszczają przeglądarkę
try {
  const resp = await page.goto('https://www.olx.pl/nieruchomosci/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log(`[strona   ] HTTP ${resp?.status()} ${resp?.status() === 200 ? '✅ PRZECHODZI' : '⛔ BLOKADA'}`);
} catch (e) { console.log(`[strona   ] błąd: ${String(e.message).slice(0, 80)}`); }

// 2) to samo API, ale z KONTEKSTU przeglądarki (jej TLS, jej ciasteczka)
try {
  const out = await page.evaluate(async (u) => {
    const r = await fetch(u, { headers: { accept: 'application/json' } });
    const t = await r.text();
    return { status: r.status, json: t.startsWith('{'), head: t.slice(0, 100) };
  }, API);
  console.log(`[API z przegl.] HTTP ${out.status} ${out.status === 200 && out.json ? '✅ PRZECHODZI' : '⛔ BLOKADA'}`);
  if (!out.json) console.log(`               ${out.head.replace(/\s+/g, ' ')}`);
} catch (e) { console.log(`[API z przegl.] błąd: ${String(e.message).slice(0, 80)}`); }

await browser.close();
