/**
 * OLX — FAZA 1: kolektor linków przez API JSON (bez przeglądarki — ~60× mniej transferu).
 * Woła https://www.olx.pl/api/v1/offers/?... (to samo API co frontend OLX), filtruje prywatne
 * (business===false), wrzuca do leads_ingest_offer BEZ numeru (phone:null) — identyczny output
 * co kolektor-przeglądarkowy, tylko taniej. Numer dochodzi w Fazie 2.
 *
 * Mapowanie (zmapowane 12.07 z API): mieszkanie/sprzedaz=14(+wtórny), mieszkanie/wynajem=15, dom/sprzedaz=18(+wtórny).
 * Stop dopiero po 2 pustych stronach z rzędu (promowane przypięte na górze mimo sortowania).
 *
 * Env: IPROYAL_PROXY(opcj), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAX_PAGES(6).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX_PAGES = Number(process.env.MAX_PAGES || 20); // sufit; realnie stop po 2 stronach bez nowych
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const CAT = {
  'mieszkanie|sprzedaz': { cat: 14, secondary: true },
  'mieszkanie|wynajem': { cat: 15, secondary: false },
  'dom|sprzedaz': { cat: 18, secondary: true },
};
const listingId = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let dispatcher;
if (PROXY) {
  const m = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
  if (m) dispatcher = new ProxyAgent({ uri: `http://${m[3]}:${m[4]}`, token: 'Basic ' + Buffer.from(`${m[1]}:${m[2]}_session-${crypto.randomBytes(5).toString('hex')}_lifetime-10m`).toString('base64') });
}
const apiH = { 'user-agent': UA, accept: 'application/json', 'accept-language': 'pl', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' };

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 150)}`);
  return t ? JSON.parse(t) : null;
}
async function apiPage(cat, secondary, offset) {
  let u = `https://www.olx.pl/api/v1/offers/?offset=${offset}&limit=40&category_id=${cat}&sort_by=created_at%3Adesc`;
  if (secondary) u += '&filter_enum_market%5B0%5D=secondary';
  const r = await fetch(u, { headers: apiH, dispatcher, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error('API ' + r.status);
  return (await r.json())?.data || [];
}

const jobs = await rpc('leads_get_active_jobs', { p_portal: 'olx' });
console.log(`aktywne joby OLX: ${jobs?.length || 0}${PROXY ? ' | przez proxy' : ' | IP maszyny'}`);

let jobOk = 0, jobErrors = 0;
for (const job of jobs || []) {
  const cfg = CAT[`${job.property_type}|${job.transaction_type}`];
  if (!cfg) { console.warn(`[${job.name}] brak mapowania category_id — pomijam`); continue; }
  const runId = await rpc('leads_start_run', { p_job_id: job.id });
  let pagesN = 0, found = 0, added = 0;
  const seen = new Set();
  try {
    // skanuj aż 2 strony Z RZĘDU bez NOWYCH = dogoniliśmy poprzedni zbiór (nakładka → zero luki).
    // sufit MAX_PAGES chroni przed runaway; przy skoku schodzi głębiej, normalnie stop po 2-3 str.
    let emptyStreak = 0;
    for (let pg = 0; pg < MAX_PAGES; pg++) {
      const data = await apiPage(cfg.cat, cfg.secondary, pg * 40);
      if (!data.length) break;
      pagesN++;
      let newThisPage = 0;
      for (const o of data) {
        if (o.business !== false) continue;              // tylko prywatne
        const url = (o.url || '').split('?')[0].split('#')[0];
        const pid = listingId(url);
        if (!pid || seen.has(pid)) continue;
        seen.add(pid); found++;
        const offer = { url, portal: 'olx', portal_listing_id: pid, property_type: job.property_type, transaction_type: job.transaction_type, title: (o.title || '').replace(/\s+/g, ' ').trim().slice(0, 140), phone: null, raw: { source: 'olx-collector-api' } };
        try {
          const res = await rpc('leads_ingest_offer', { p_offer: offer });
          if (res?.listing_is_new) { added++; newThisPage++; }
        } catch (e) { console.error('  ingest err', pid, String(e.message).slice(0, 100)); }
      }
      console.log(`[${job.name}] str.${pg + 1}: ${data.length} ofert, +${newThisPage} nowych`);
      if (newThisPage === 0) { if (++emptyStreak >= 2) { console.log(`[${job.name}] dogoniłem (2 str. bez nowych) — stop`); break; } } else emptyStreak = 0;
      await sleep(300 + Math.random() * 500);
    }
    await rpc('leads_finalize_run', { p_run_id: runId, p_job_id: job.id, p_status: 'success', p_pages: pagesN, p_listings_found: found, p_listings_new: added, p_phones_new: 0, p_error: null });
    console.log(`[${job.name}] ✓ pages=${pagesN} found=${found} new=${added}`);
    jobOk++;
  } catch (e) {
    console.error(`[${job.name}] ✗`, String(e.message).slice(0, 200));
    jobErrors++;
    await rpc('leads_finalize_run', { p_run_id: runId, p_job_id: job.id, p_status: 'error', p_pages: pagesN, p_listings_found: found, p_listings_new: added, p_phones_new: 0, p_error: String(e.message).slice(0, 900) }).catch(() => {});
  }
}
console.log(`kolektor-API: koniec | ok=${jobOk} err=${jobErrors}`);
// exit 1 tylko gdy NIC się nie zebrało a były błędy (pełna awaria) → alert Slack; pojedynczy transient nie alarmuje
process.exit(jobOk === 0 && jobErrors > 0 ? 1 : 0);
