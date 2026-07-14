/** Track 2 — SILNIK FALOWY: co WAVE_INTERVAL puszcza falę WAVE_SIZE kont RÓWNOLEGLE, cooldown 8min per konto.
 *  Każde konto: 5 REALNYCH kliknięć/sekwencję (bez-numeru pomijamy, nie liczą się). Reveal przez przeglądarkę na sesji.
 *  Sesje z DB (leads.olx_sessions). Każde konto = własne stałe IP (md5) → równoległość bez kolizji.
 *  Env: IPROYAL_PROXY, SUPABASE_*, PER_ACCOUNT(5), SCAN_CAP(15), COOLDOWN_MIN(8), WAVE_SIZE(3), WAVE_INTERVAL_MIN(2), BUDGET_MIN. */
import { chromium } from 'patchright';
import crypto from 'crypto';
import { ProxyAgent } from 'undici';

let accounts = {};
if (process.env.OLX_SESSIONS) accounts = JSON.parse(process.env.OLX_SESSIONS);
else if (process.env.OLX_SESSION) accounts = { konto1: JSON.parse(process.env.OLX_SESSION) };
let names = Object.keys(accounts); // jeśli puste — dociągniemy z DB niżej (po zdefiniowaniu rpc)

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PER_ACCOUNT = Number(process.env.PER_ACCOUNT || 5);        // liczba REALNYCH kliknięć „Pokaż numer" na sekwencję
const SCAN_CAP = Number(process.env.SCAN_CAP || 15);             // ile linków max przeskanować żeby znaleźć PER_ACCOUNT klikalnych (bez-numeru pomijamy)
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN || 8) * 60000;
const BUDGET_MS = Number(process.env.BUDGET_MIN || 300) * 60000; // minuty → ms
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const DEBUG = process.env.DEBUG === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const LIFETIME = process.env.PROXY_LIFETIME || '24h';           // 1 konto = 1 STAŁY IP na 24h (IPRoyal max 7d)
const keyFor = (acc, salt) => crypto.createHash('md5').update(salt ? `${acc}:${salt}` : acc).digest('hex').slice(0, 8); // session ID = dokładnie 8 znaków (spec IPRoyal); deterministyczny per konto → inny IP na każdy mail
const passFor = (key) => `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const proxyForKey = (key) => ({ server: `http://${pm[3]}:${pm[4]}`, username: pm[1], password: passFor(key) });
const ipVia = async (key) => { try { const a = new ProxyAgent(`http://${pm[1]}:${passFor(key)}@${pm[3]}:${pm[4]}`); const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(15000) }); return (await r.json()).ip; } catch { return null; } };
let ipSalts = {}; // nadpisania salta per konto (gdy domyślny IP martwy) — dociągane z DB na starcie
let cooledUntil = {}; // acc → ms do kiedy konto studzone po captchy (nie ruszamy go)

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

// 1 KONTO = 1 STAŁY IP (deterministyczny md5 z nazwy konta). ZERO re-rollingu — ten sam IP co zawsze. Log tylko dla pewności.
async function proxyKeyFor(acc) {
  const key = keyFor(acc, ipSalts[acc] || 0);                    // salt>0 = wymieniony martwy IP (nadal stały)
  const ip = await ipVia(key).catch(() => null);
  console.log(`  [${acc}] 🌐 stały IP: ${ip || '(nie sprawdzono)'} — ten sam co zawsze, trzymam ${LIFETIME}`);
  if (ip) { try { await rpc('leads_olx_ip_seen', { p_name: acc, p_ip: ip }); } catch {} } // zapis do śledzenia zmian IP
  return key;
}

async function revealBatch(browser, acc, state) {
  const res = { ok: 0, nophone: 0, skipped: 0, expired: false, fetched: 0, loggedIn: false, captcha: false };
  const queue = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: SCAN_CAP }).catch(() => []); // atomowy claim (SKIP LOCKED) — równoległe workery nie biorą tych samych
  res.fetched = queue?.length || 0;
  if (!res.fetched) return res;
  const key = await proxyKeyFor(acc);
  const ctx = await browser.newContext({ proxy: proxyForKey(key), storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 }, userAgent: UA });
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  if (DEBUG) page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED|net::|status of 4|status of 5/i.test(m.text())) console.log('  [con.err]', m.text().slice(0, 85)); });
  // ROZGRZEWKA sesji: wejdź na home, daj Auth0 SDK zainicjować i odświeżyć token, zanim revealujesz
  await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await sleep(7000);
  res.loggedIn = await page.locator('[data-testid="my-account-menu"], [data-testid="header-user-menu"], a[href*="/mojolx"], a[href*="/konto"]').first().isVisible({ timeout: 2500 }).catch(() => false);
  console.log(`  [${acc}] rozgrzewka: zalogowany=${res.loggedIn}`);
  try { await rpc('leads_upsert_olx_session', { p_name: acc, p_state: await ctx.storageState() }); } catch {} // ZAWSZE zapisz (świeży refresh token → nie zwietrzeje, to był gwóźdź wczoraj)
  if (!res.loggedIn) { console.log(`  [${acc}] 🚪 WYLOGOWANY — nie reweluję (cron-odświeżacz to naprawi)`); await ctx.close().catch(() => {}); return res; } // NIE walić na wylogowanej sesji
  let clicks = 0;                                                          // liczą się TYLKO realne kliknięcia (do PER_ACCOUNT), nie ogłoszenia bez numeru
  for (const row of queue) {
    if (clicks >= PER_ACCOUNT) break;                                      // 5 realnych prób = koniec sekwencji (anti-captcha)
    let phone = null, lpStatus = null, lpBody = '', blank = false, clicked = false, noBtn = false, challengeType = '', captchaHit = false;
    const onResp = async (resp) => {
      const u = resp.url();
      if (/friction\.olxgroup/i.test(u)) { try { const j = await resp.json(); if (j?.challenge?.type) { blank = true; challengeType = j.challenge.type; } } catch {} }
      if (/limited-phones/i.test(u)) { lpStatus = resp.status(); try { lpBody = await resp.text(); const j = JSON.parse(lpBody); if (j?.data?.phones?.[0]) phone = j.data.phones[0]; } catch {} }
    };
    page.on('response', onResp);
    try {
      await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await sleep(4000); // daj stronie się wyrenderować
      if (/login\.olx\.pl/i.test(page.url())) res.expired = true;
      else {
        // znajdź PIERWSZY WIDOCZNY przycisk spośród wszystkich dopasowań (nie .first() — bywa ukryty)
        const findBtn = async () => { const bs = page.locator('[data-testid="show-phone"]'); const n = await bs.count(); for (let i = 0; i < n; i++) { const b = bs.nth(i); if (await b.isVisible().catch(() => false)) return b; } return null; };
        // klik + RETRY aż numer wejdzie — pierwszy klik bywa jałowy (friction SDK się dogrzewa)
        for (let attempt = 0; attempt < 4 && !phone && !res.expired; attempt++) {
          const btn = await findBtn();
          if (!btn) { await sleep(2500); continue; }                            // jeszcze się nie wyrenderował — poczekaj
          await btn.scrollIntoViewIfNeeded().catch(() => {});
          await btn.click({ timeout: 3000 }).catch(() => {});
          clicked = true;
          for (let w = 0; w < 13 && !phone; w++) { await sleep(600); if (/login\.olx\.pl/i.test(page.url())) { res.expired = true; break; } } // poll ~8s na odpowiedź
        }
        if (!clicked) noBtn = true;                                             // realnie brak przycisku = ogłoszenie bez numeru
        else if (!phone && !res.expired) {                                      // klik był, numeru brak → sprawdź CAPTCHA
          const capEl = await page.locator('iframe[src*="awswaf" i], iframe[src*="captcha" i], iframe[title*="challenge" i], [id*="captcha" i], [class*="captcha" i]').first().isVisible({ timeout: 1200 }).catch(() => false);
          if (capEl || (challengeType && !/^blank$/i.test(challengeType))) captchaHit = true; // widoczny widget lub typ challenge ≠ blank
        }
      }
    } catch {}
    page.off('response', onResp);
    if (DEBUG) { const cont = await page.locator('[data-testid="phones-container"]').first().innerText().catch(() => ''); console.log(`  [dbg] ...${row.url.slice(-28)} klik:${clicked} nobtn:${noBtn} login:${/login\.olx/i.test(page.url())} blank:${blank} chlg:${challengeType || '—'} cap:${captchaHit} lp:${lpStatus || '—'} cont:"${cont.replace(/\s+/g, ' ').slice(0, 20)}"`); }
    if (res.expired) break;
    if (captchaHit) { res.captcha = true; console.log(`  [${acc}] 🧊 CAPTCHA (${challengeType || 'widget'}) — przerywam batch, studzę konto 45min`); break; }
    if (noBtn) { res.skipped++; await rpc('leads_mark_reveal_fail', { p_id: row.id, p_minutes: 180, p_reason: 'no_button' }).catch(() => {}); continue; } // BEZ NUMERU (nie klikaliśmy) — NIE liczy się do PER_ACCOUNT, mijamy
    clicks++;                                                              // kliknęliśmy przycisk = realna próba, liczy się do 5
    if (phone) { const norm = normPhone(phone); try { const r = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: norm, raw: { source: 'olx-browser' } } }); console.log(`  [${acc}] ✅ ${phone} (sms:${r?.sms_status || '?'})`); res.ok++; } catch {} }
    else { res.nophone++; await rpc('leads_mark_reveal_fail', { p_id: row.id, p_minutes: 30, p_reason: 'no_reveal' }).catch(() => {}); }
    await sleep(2500 + Math.random() * 2500);
  }
  await ctx.close().catch(() => {});
  return res;
}

// Sesje z DB (leads.olx_sessions), gdy nie podano w env — DB = źródło prawdy (za duże na sekret GH: 64KB)
if (!names.length) { accounts = await rpc('leads_get_olx_sessions').catch(() => ({})); names = Object.keys(accounts || {}); console.log(`sesje z DB: ${names.length}`); }
if (process.env.ONLY_ACCOUNTS) { const only = new Set(process.env.ONLY_ACCOUNTS.split(',').map((s) => s.trim())); names = names.filter((n) => only.has(n)); }
try { for (const r of (await rpc('leads_get_ip_salts').catch(() => []))) ipSalts[r.name] = r.salt; if (Object.keys(ipSalts).length) console.log('salt-override IP:', JSON.stringify(ipSalts)); } catch {} // konta z wymienionym martwym IP
try { for (const r of (await rpc('leads_olx_cooled').catch(() => []))) cooledUntil[r.name] = new Date(r.cooled_until).getTime(); if (Object.keys(cooledUntil).length) console.log('studzone (captcha):', Object.keys(cooledUntil).join(',')); } catch {} // respektuj cooldowny po restarcie
console.log(`konta: ${names.join(', ') || 'BRAK'} | PER_ACCOUNT=${PER_ACCOUNT} | cooldown=${COOLDOWN_MS / 60000}min | budżet=${Math.round(BUDGET_MS / 60000)}min`);
if (!names.length) { console.log('brak sesji (OLX_SESSION/OLX_SESSIONS)'); process.exit(1); }
const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] }); // headful (przez xvfb) — headless wykrywany przez OLX
const WAVE_SIZE = Number(process.env.WAVE_SIZE || 3);            // ile kont ruszamy w jednej fali
const WAVE_INTERVAL_MS = Number(process.env.WAVE_INTERVAL_MIN || 2) * 60000; // co ile odpalamy następną falę
const MAX_CONCURRENT = WAVE_SIZE * 2;                           // bezpiecznik: nie rozjedź się gdy batche wolne
const dead = new Set(), lastStart = {}, running = new Set(), expiredHits = {};
const start = Date.now(); let grandOk = 0;
console.log(`FALE: ${WAVE_SIZE} kont co ${WAVE_INTERVAL_MS / 60000}min | cooldown ${COOLDOWN_MS / 60000}min/konto | max równolegle ${MAX_CONCURRENT} | inne IP = brak kolizji`);

// jedno konto: start (uruchamia jego cooldown) → batch → obsługa wyniku. Fałszywe „dead" dopiero po 2 redirectach.
async function runAcc(acc) {
  running.add(acc); lastStart[acc] = Date.now();               // start sekwencji = teraz (cooldown 8min liczy się stąd)
  try {
    const res = await revealBatch(browser, acc, accounts[acc]);
    grandOk += res.ok;
    if (res.ok > 0 || res.loggedIn) expiredHits[acc] = 0;      // konto ewidentnie żyje → zeruj licznik redirectów
    if (res.expired) {
      expiredHits[acc] = (expiredHits[acc] || 0) + 1;
      if (expiredHits[acc] >= 2) { dead.add(acc); await slack(`:warning: *OLX konta* — sesja *${acc}* padła (2× redirect na login). Zaloguj: node login_helper.mjs ${acc}`); }
      else console.log(`[${acc}] redirect na login (${expiredHits[acc]}/2) — NIE zabijam (może proxy), ponowię`);
    }
    if (res.captcha) { cooledUntil[acc] = Date.now() + 45 * 60000; try { await rpc('leads_olx_captcha_hit', { p_name: acc, p_minutes: 45 }); } catch {} await slack(`:snowflake: *OLX* — captcha na *${acc}* → studzę 45 min`); } // nie puszczamy w nieskończoność
    if (res.fetched > 0 && !res.loggedIn && !res.expired) { cooledUntil[acc] = Date.now() + 25 * 60000; await slack(`:door: *OLX* — *${acc}* wylogowane, pomijam (cron odświeży). Pauza 25min`); } // nie walić na wylogowanej sesji
    console.log(`[${acc}] batch: ${!res.loggedIn && res.fetched > 0 ? '🚪wylogowany' : '✅' + res.ok + ' ∅' + res.nophone + (res.skipped ? ' ⤳' + res.skipped + 'bez-num' : '') + (res.captcha ? ' 🧊CAPTCHA→45min' : '') + (res.expired ? ' 🔴' : '')} | RAZEM ✅${grandOk}`);
  } catch (e) { console.log(`[${acc}] błąd: ${String(e.message).slice(0, 60)}`); }
  running.delete(acc);
}

try {
  while (Date.now() - start < BUDGET_MS) {
    if (names.every((n) => dead.has(n))) { console.log('wszystkie konta padły'); break; }
    if (running.size < MAX_CONCURRENT) {
      const pool = names
        .filter((acc) => !dead.has(acc) && !running.has(acc) && Date.now() - (lastStart[acc] || 0) >= COOLDOWN_MS && Date.now() >= (cooledUntil[acc] || 0)) // żywe, po cooldownie, nie mielone, nie studzone po captchy
        .sort((a, b) => (lastStart[a] || 0) - (lastStart[b] || 0))    // najdawniej ruszane pierwsze
        .slice(0, WAVE_SIZE);
      for (const acc of pool) runAcc(acc);                            // FALA: fire-and-forget → konta jadą równolegle
    }
    await sleep(WAVE_INTERVAL_MS);                                    // następna fala za ~2 min (zazębia się)
  }
  while (running.size && Date.now() - start < BUDGET_MS + 300000) await sleep(3000); // dokończ trwające batche
} finally { await browser.close(); }
console.log(`\n=== KONIEC === ✅ ${grandOk} numerów`);
process.exit(0);
