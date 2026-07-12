/**
 * OLX — FAZA 1: kolektor linków. Czyta aktywne joby OLX z Supabase, chodzi po wyszukiwaniach
 * (organiczne, najnowsze), wyciąga oferty i wrzuca do leads_ingest_offer BEZ numeru
 * (phone:null → listing z phone_id=null, sms_status=skipped_no_phone). Numer dochodzi w Fazie 2.
 * Kolejka do odsłonięcia = listings WHERE portal='olx' AND phone_id IS NULL.
 *
 * NIE wymaga logowania (przeglądanie jest publiczne) — zero throttlingu kont. Przez proxy PL,
 * żeby OLX nie widział IP GitHub Actions.
 * Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAX_PAGES(opcj).
 */
import { chromium } from 'patchright';
import { createClient } from '@supabase/supabase-js';

const PROXY = process.env.IPROYAL_PROXY;
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const MAX_PAGES = Number(process.env.MAX_PAGES || 20);

function stickyProxy(raw) {
  const m = raw.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (!m) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
  const [, user, pass, host, port] = m;
  const sid = Math.random().toString(36).slice(2, 12);
  return { server: `http://${host}:${port}`, username: user, password: `${pass}_session-${sid}_lifetime-30m` };
}
const listingId = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { data: jobs, error: jobErr } = await sb.rpc('leads_get_active_jobs', { p_portal: 'olx' });
if (jobErr) { console.error('leads_get_active_jobs:', jobErr.message); process.exit(1); }
console.log(`aktywne joby OLX: ${jobs?.length || 0}`);

const browser = await chromium.launch({ headless: true, proxy: stickyProxy(PROXY), args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
await page.route('**/*', (r) => (['image', 'media', 'font', 'stylesheet'].includes(r.request().resourceType()) ? r.abort() : r.continue()));

for (const job of jobs || []) {
  const runId = (await sb.rpc('leads_start_run', { p_job_id: job.id })).data;
  let pagesN = 0, found = 0, added = 0;
  const seen = new Set();
  try {
    for (let pg = 1; pg <= MAX_PAGES; pg++) {
      const url = job.search_url + '&page=' + pg;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForSelector('a[href*="/d/oferta/"]', { timeout: 12000 }).catch(() => {});
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll('a[href*="/d/oferta/"]')]
          .filter((a) => a.href.includes('olx.pl') && /organic/.test(a.href))
          .map((a) => ({ url: a.href.split('?')[0], title: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140) })));
      pagesN++;
      let newThisPage = 0;
      for (const c of cards) {
        const pid = listingId(c.url);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        found++;
        const offer = {
          url: c.url, portal: 'olx', portal_listing_id: pid,
          property_type: job.property_type, transaction_type: job.transaction_type,
          title: c.title || null, phone: null,
          raw: { source: 'olx-collector' },
        };
        const { data: res, error } = await sb.rpc('leads_ingest_offer', { p_offer: offer });
        if (error) { console.error('  ingest err', pid, error.message); continue; }
        if (res?.listing_is_new) { added++; newThisPage++; }
      }
      console.log(`[${job.name}] str.${pg}: ${cards.length} kart organicznych, +${newThisPage} nowych`);
      if (cards.length === 0) break;         // koniec wyników
      if (newThisPage === 0) break;          // dogoniliśmy już zebrane (przyrostowo)
      await sleep(600 + Math.random() * 1400);
    }
    await sb.rpc('leads_finalize_run', { p_run_id: runId, p_job_id: job.id, p_status: 'success', p_pages: pagesN, p_listings_found: found, p_listings_new: added, p_phones_new: 0, p_error: null });
    console.log(`[${job.name}] ✓ pages=${pagesN} found=${found} new=${added}`);
  } catch (e) {
    console.error(`[${job.name}] ✗`, String(e.message).slice(0, 200));
    await sb.rpc('leads_finalize_run', { p_run_id: runId, p_job_id: job.id, p_status: 'error', p_pages: pagesN, p_listings_found: found, p_listings_new: added, p_phones_new: 0, p_error: String(e.message).slice(0, 900) });
  }
}
await browser.close();
console.log('kolektor: koniec');
process.exit(0);
