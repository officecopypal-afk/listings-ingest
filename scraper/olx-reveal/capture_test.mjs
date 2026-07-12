/** Diagnostyka capture fingerprintu na runnerze: proxy vs bezpośrednio, pełny log. */
import { chromium } from 'patchright';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const proxy = () => ({ server: `http://${PH}:${PT}`, username: PU, password: `${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m` });
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SEARCH = 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/?search%5Bprivate_business%5D=private&search%5Border%5D=created_at:desc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const useProxy of [true, false]) {
  console.log(`\n===== capture ${useProxy ? 'PRZEZ PROXY' : 'BEZPOŚREDNIO (runner IP)'} =====`);
  const browser = await chromium.launch({ headless: true, ...(useProxy ? { proxy: proxy() } : {}), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
    const page = await ctx.newPage();
    let fp = null, reqCount = 0; const apiUrls = [], fpUrls = [];
    page.on('request', (r) => { reqCount++; const u = r.url(); const h = r.headers(); if (/olx\.pl\/api|friction|trader\.olx|css\.olx/i.test(u)) apiUrls.push(u.replace(/https?:\/\//, '').slice(0, 50)); if (h['x-fingerprint']) { if (!fp) fp = { fp: h['x-fingerprint'], dev: h['x-device-id'] }; fpUrls.push(u.slice(0, 40)); } });
    await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('  goto search err:', e.message.slice(0, 60)));
    console.log('  po search: url=', page.url().slice(0, 48), '| title=', (await page.title().catch(() => '')).slice(0, 45));
    await sleep(7000);
    const url = await page.evaluate(() => ([...document.querySelectorAll('a[href*="/d/oferta/"]')].map((x) => x.href).find((h) => /organic/.test(h)) || '')).catch(() => '');
    console.log('  offer znaleziony?', !!url, url.slice(-22));
    if (url) { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => console.log('  goto offer err:', e.message.slice(0, 60))); await sleep(7000); }
    console.log('  requests:', reqCount, '| API-calls:', apiUrls.length, '| x-fingerprint widziany:', fpUrls.length, 'razy');
    console.log('  API urls:', apiUrls.slice(0, 7).join(' | ') || '(brak)');
    console.log('  >>> fp?', fp ? 'TAK len=' + fp.fp.length + ' prefiks=' + fp.fp.slice(0, 16) : 'NIE');
  } catch (e) { console.log('  BŁĄD:', e.message.slice(0, 100)); } finally { await browser.close(); }
}
console.log('\n(mój wypalony Mac fingerprint = prefiks fbdc4f53959cdb4a)');
