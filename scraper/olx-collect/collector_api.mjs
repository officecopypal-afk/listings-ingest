/**
 * OLX — FAZA 1: kolektor linków przez API JSON (bez przeglądarki — ~60× mniej transferu).
 * Woła https://www.olx.pl/api/v1/offers/?... (to samo API co frontend OLX), filtruje prywatne
 * (business===false), wrzuca do leads_ingest_offer BEZ numeru (phone:null) — identyczny output
 * co kolektor-przeglądarkowy, tylko taniej. Numer dochodzi w Fazie 2.
 *
 * Mapowanie (zmapowane 12.07 z API): mieszkanie/sprzedaz=14(+wtórny), mieszkanie/wynajem=15, dom/sprzedaz=18(+wtórny).
 * Sort: OLX honoruje `sort_by=created_at:desc` jako `last_refresh_time` malejąco (organiczne: 0 inwersji;
 * promowane top_ad wstrzykiwane w feed). `created_time` = prawdziwa data WYSTAWIENia (created<=refresh).
 * Tryb bieżący: stop po 2 pustych stronach (nakładka). Tryb backfill (SINCE_DATE): zbieraj created>=data,
 * stop gdy najnowszy organiczny refresh < data (bo created<=refresh → poza oknem nic już nie wystawiono).
 *
 * Env: IPROYAL_PROXY(opcj), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAX_PAGES(20), SINCE_DATE(ISO, backfill).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

// NO_PROXY_MODE=true → jedziemy z IP runnera (ścieżka awaryjna gdy proxy padnie).
// Uwaga na pułapkę GHA: pusty string jest falsy w `a && '' || b`, dlatego osobna zmienna.
const PROXY = process.env.NO_PROXY_MODE === 'true' ? '' : process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX_PAGES = Number(process.env.MAX_PAGES || 20); // sufit; realnie stop po 2 stronach bez nowych / na granicy okna
const SINCE_DATE = (process.env.SINCE_DATE || '').trim(); // ISO (backfill): zbieraj wystawione od tej daty; stop gdy organiczny refresh < data
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const CAT = {
  'mieszkanie|sprzedaz': { cat: 14, secondary: true },
  'mieszkanie|wynajem': { cat: 15, secondary: false },
  'dom|sprzedaz': { cat: 18, secondary: true },
  'dom|wynajem': { cat: 20, secondary: false }, // mały wolumen (~1405 total); wynajem = bez filtra rynku
};
const listingId = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const isPromo = (o) => !!(o.promotion && o.promotion.top_ad); // wyróżnione/przypięte — pomijamy przy wyznaczaniu granicy sortu
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pm = PROXY ? PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/) : null;
function makeDispatcher() {
  if (!pm) return undefined;
  return new ProxyAgent({ uri: `http://${pm[3]}:${pm[4]}`, token: 'Basic ' + Buffer.from(`${pm[1]}:${pm[2]}_session-${crypto.randomBytes(5).toString('hex')}_lifetime-10m`).toString('base64') });
}
let dispatcher = makeDispatcher();
const apiH = { 'user-agent': UA, accept: 'application/json', 'accept-language': 'pl', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' };

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 150)}`);
  return t ? JSON.parse(t) : null;
}
const LIMIT = 50;
async function apiPage(cat, secondary, offset) {
  let u = `https://www.olx.pl/api/v1/offers/?offset=${offset}&limit=${LIMIT}&category_id=${cat}&sort_by=created_at%3Adesc`;
  if (secondary) u += '&filter_enum_market%5B0%5D=secondary';
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(u, { headers: apiH, dispatcher, signal: AbortSignal.timeout(25000) });
      if (!r.ok) {
        // DIAGNOSTYKA (31.07.2026): wcześniej `return null` po cichu — kolektor przez 6 dni
        // raportował "success, 0 nowych" i nikt nie widział, że OLX/proxy odrzuca requesty.
        const body = await r.text().catch(() => '');
        console.error(`  API ${r.status} ${r.statusText} (offset=${offset}, cat=${cat}) :: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
        return null;                                   // cap paginacji / HTTP błąd → koniec scope
      }
      return (await r.json())?.data || [];
    } catch (e) {
      lastErr = String(e?.message || e).slice(0, 120);
      dispatcher = makeDispatcher(); await sleep(800);  // proxy padł → świeży agent + retry
    }
  }
  console.error(`  API nieosiągalne po 4 próbach (offset=${offset}, cat=${cat}) :: ${lastErr}`);
  return null;                                          // koniec scope (partial, bez crasha)
}

const jobs = await rpc('leads_get_active_jobs', { p_portal: 'olx' });
console.log(`aktywne joby OLX: ${jobs?.length || 0}${PROXY ? ' | przez proxy' : ' | IP maszyny'}`);

let jobOk = 0, jobErrors = 0;
for (const job of jobs || []) {
  const cfg = CAT[`${job.property_type}|${job.transaction_type}`];
  if (!cfg) { console.warn(`[${job.name}] brak mapowania category_id — pomijam`); continue; }
  const runId = await rpc('leads_start_run', { p_job_id: job.id });
  let pagesN = 0, found = 0, added = 0, skippedNoId = 0;
  const seen = new Set();
  try {
    // skanuj aż 2 strony Z RZĘDU bez NOWYCH = dogoniliśmy poprzedni zbiór (nakładka → zero luki).
    // sufit MAX_PAGES chroni przed runaway; przy skoku schodzi głębiej, normalnie stop po 2-3 str.
    let emptyStreak = 0, pastBoundary = 0;
    const cutoffMs = SINCE_DATE ? new Date(SINCE_DATE).getTime() : 0;
    for (let pg = 0; pg < MAX_PAGES; pg++) {
      const data = await apiPage(cfg.cat, cfg.secondary, pg * LIMIT);
      if (!data || !data.length) { console.log(`[${job.name}] koniec wyników API (str.${pg + 1})`); break; }
      pagesN++;
      let newThisPage = 0, maxOrgRefresh = 0;
      for (const o of data) {
        // granicę okna liczymy po ORGANICZNYCH (feed malejący po last_refresh_time; promowane mają chaotyczny refresh)
        if (cutoffMs && !isPromo(o) && o.last_refresh_time) { const rf = new Date(o.last_refresh_time).getTime(); if (rf > maxOrgRefresh) maxOrgRefresh = rf; }
        if (o.business !== false) continue;              // tylko prywatne
        if (cutoffMs && (!o.created_time || new Date(o.created_time).getTime() < cutoffMs)) continue; // backfill: tylko WYSTAWIONE od daty
        const url = (o.url || '').split('?')[0].split('#')[0];
        const pid = listingId(url);                       // base62 z URL — TYLKO do dedupu w obrębie runu
        if (!pid || seen.has(pid)) continue;
        // INCYDENT 21.07.2026: NIE rekonstruujemy ad_id z URL-a (base62 dekodował się błędnie dla części
        // znaków → reveal pobierał numer OBCEGO ogłoszenia). API podaje prawdziwe numeryczne id — bierzemy je.
        const adId = (o.id != null && /^\d+$/.test(String(o.id))) ? String(o.id) : null;
        if (!adId) { skippedNoId++; continue; }            // bez pewnego id nie zbieramy — lepiej stracić lead niż zadzwonić do obcej osoby
        seen.add(pid); found++;
        const offer = { url, portal: 'olx', portal_listing_id: adId, property_type: job.property_type, transaction_type: job.transaction_type, title: (o.title || '').replace(/\s+/g, ' ').trim().slice(0, 140), posted_at: o.created_time || null, phone: null, raw: { source: 'olx-collector-api' } };
        try {
          const res = await rpc('leads_ingest_offer', { p_offer: offer });
          if (res?.listing_is_new) { added++; newThisPage++; }
        } catch (e) { console.error('  ingest err', pid, String(e.message).slice(0, 100)); }
      }
      console.log(`[${job.name}] str.${pg + 1}: ${data.length} ofert, +${newThisPage} nowych${cutoffMs && maxOrgRefresh ? ` (dno refresh ${new Date(maxOrgRefresh).toISOString().slice(5, 16)})` : ''}`);
      if (cutoffMs) {                                    // backfill: stop gdy najnowszy organiczny refresh < okno (monotonicznie → dalej tylko starsze)
        if (maxOrgRefresh && maxOrgRefresh < cutoffMs) { if (++pastBoundary >= 2) { console.log(`[${job.name}] refresh < ${SINCE_DATE} — całe okno zebrane, stop`); break; } }
        else pastBoundary = 0;
      } else if (newThisPage === 0) { if (++emptyStreak >= 2) { console.log(`[${job.name}] dogoniłem (2 str. bez nowych) — stop`); break; } } // steady: stop na nakładce
      else emptyStreak = 0;
      await sleep(300 + Math.random() * 500);
    }
    await rpc('leads_finalize_run', { p_run_id: runId, p_job_id: job.id, p_status: 'success', p_pages: pagesN, p_listings_found: found, p_listings_new: added, p_phones_new: 0, p_error: null });
    console.log(`[${job.name}] ✓ pages=${pagesN} found=${found} new=${added}${skippedNoId ? ` (pominięte bez id: ${skippedNoId})` : ''}`);
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
