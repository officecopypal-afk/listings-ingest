/**
 * OLX MOBILE ENGINE (produkcja/CI) — czysty HTTP, bez przeglądarki/frictiona/captchy.
 * Tokeny + config z Supabase (leads.olx_mobile_tokens). Każde konto przez SWOJE stałe residential IP.
 * Keep-alive: co cykl refresh wszystkich kont (żyją, wcześnie wykrywa martwy token).
 * Sekwencja kont → pauza PAUSE_MIN → pętla do BUDGET_MIN → exit (workflow self-chainuje).
 * Alerty Slack (problem-first): martwy token, ściana 403/429, proxy padło, cały cykl 0.
 * Staty per cykl → leads.olx_mobile_stats (panel).
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PROXY_USER, PROXY_PASS, PROXY_PORT,
 *      PER_ACCOUNT, DELAY_MS, PAUSE_MIN, BUDGET_MIN
 */
import { fetch, ProxyAgent } from 'undici';
import crypto from 'crypto';

const CLIENT_ID = '2tmi4nl6rt49qtvippambh0kej';
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY_USER = (process.env.PROXY_USER || '').trim();
const PROXY_PASS = (process.env.PROXY_PASS || '').trim();
const PROXY_PORT = (process.env.PROXY_PORT || '12323').trim();
const PER_ACCOUNT = Number(process.env.PER_ACCOUNT || 25);
const DELAY_MS = Number(process.env.DELAY_MS || 2500);
const PAUSE_MIN = Number(process.env.PAUSE_MIN || 7);
const BUDGET_MIN = Number(process.env.BUDGET_MIN || 330); // ~5.5h, potem self-chain (GH job max 6h)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const overBudget = () => (Date.now() - t0) / 60000 >= BUDGET_MIN;

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status} ${t.slice(0, 90)}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decode62 = (s) => { let n = 0n; for (const c of s) { const i = B62.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const adIdFromUrl = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? decode62(m[1]) : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };

const ptoken = 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
const agentFor = (ip) => new ProxyAgent({ uri: `http://${ip}:${PROXY_PORT}`, token: ptoken });

async function loadAccounts() {
  const rows = await rpc('leads_get_mobile_tokens', {});
  return (rows || []).filter((r) => r.status !== 'dead').map((r) => ({ label: r.label, ip: r.ip, email: r.email, refresh_token: r.refresh_token, agent: agentFor(r.ip), access: null, accessExp: 0, deviceId: crypto.createHash('sha1').update('dev:' + r.label).digest('hex'), dead: false, netFails: 0, alertedProxy: false }));
}

async function refresh(a) {
  let r;
  try { r = await fetch('https://login.olx.pl/oauth2/token', { method: 'POST', dispatcher: a.agent, headers: { 'content-type': 'application/json', 'user-agent': 'OLX.pl/883 CFNetwork/3860.600.12 Darwin/25.5.0', accept: '*/*' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: CLIENT_ID }), signal: AbortSignal.timeout(25000) }); }
  catch (e) { a.netFails++; if (a.netFails >= 2 && !a.alertedProxy) { a.alertedProxy = true; await slack(`🟠 OLX mobile: proxy konta ${a.label} (${a.ip}) nie odpowiada — sprawdź proxy`); } throw new Error('net ' + String(e.message).slice(0, 40)); }
  a.netFails = 0;
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || !j.access_token) { if (String(j.error) === 'invalid_grant') { a.dead = true; await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'dead' }).catch(() => {}); await slack(`🔴 OLX mobile: konto ${a.label} — refresh_token PADŁ, potrzebny re-login (kliknij w panelu)`); } throw new Error(`refresh ${r.status} ${j.error || ''}`); }
  if (j.refresh_token && j.refresh_token !== a.refresh_token) { a.refresh_token = j.refresh_token; await rpc('leads_set_mobile_token_value', { p_label: a.label, p_refresh_token: j.refresh_token }).catch(() => {}); }
  a.access = j.access_token; a.accessExp = Date.now() + (j.expires_in - 120) * 1000;
}
async function ensureToken(a) { if (!a.access || Date.now() > a.accessExp) await refresh(a); }
const H = (a) => ({ authorization: `Bearer ${a.access}`, accept: '*/*', version: 'v1.17', 'x-platform-type': 'ios', 'user-agent': 'iPhone App Ver 4.150.0 (iOS 26.5.2)', 'x-device-id': a.deviceId, 'accept-language': 'pl' });

async function reveal(a, adId) {
  await fetch(`https://www.olx.pl/api/v1/ads/${adId}/phone-view`, { method: 'POST', dispatcher: a.agent, headers: H(a), body: '', signal: AbortSignal.timeout(20000) }).catch(() => {});
  let r = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones`, { dispatcher: a.agent, headers: H(a), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { await refresh(a); r = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones`, { dispatcher: a.agent, headers: H(a), signal: AbortSignal.timeout(20000) }); }
  const st = r.status;
  if (st === 403 || st === 429) return { kind: 'wall', status: st };
  if (st === 400 || st === 404) return { kind: 'gone', status: st };
  if (st !== 200) return { kind: 'err', status: st };
  const j = await r.json().catch(() => ({})); const ph = j?.data?.phones?.[0];
  return ph ? { kind: 'ok', phone: ph } : { kind: 'empty' };
}

async function runAccount(a) {
  const s = { ok: 0, empty: 0, gone: 0, wall: 0, err: 0, queued: 0, rows: 0 };
  try { await ensureToken(a); await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'ok' }).catch(() => {}); }
  catch (e) { console.log(`  [${a.label}] token pad: ${e.message}`); return s; } // alert już w refresh()
  const rows = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: PER_ACCOUNT }).catch(() => []);
  s.rows = (rows || []).length;
  let wallStreak = 0;
  for (const row of rows) {
    const adId = adIdFromUrl(row.url); if (!adId) continue;
    let res; try { res = await reveal(a, adId); } catch { s.err++; await sleep(DELAY_MS); continue; }
    if (res.kind === 'ok') { s.ok++; wallStreak = 0; try { const ing = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: adId, property_type: row.property_type, transaction_type: row.transaction_type, phone: normPhone(res.phone), raw: { source: 'olx-mobile', acct: a.label } } }); if (ing?.sms_status === 'queued') s.queued++; } catch {} }
    else if (res.kind === 'empty') { s.empty++; await rpc('leads_mark_reveal_fail', { p_id: row.id, p_minutes: 180, p_reason: 'no_phone' }).catch(() => {}); } // odłóż 3h, po 5 próbach wypada
    else if (res.kind === 'gone') { s.gone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); } // usunięte ogłoszenie → precz z kolejki
    else if (res.kind === 'wall') { s.wall++; if (++wallStreak >= 3) { await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'wall' }).catch(() => {}); await slack(`🟡 OLX mobile: konto ${a.label} trafiło ścianę ${res.status} (3×) — przerywam konto na ten cykl`); break; } }
    else s.err++;
    await sleep(DELAY_MS);
  }
  await rpc('leads_mobile_stats_insert', { p_label: a.label, p_ok: s.ok, p_empty: s.empty, p_gone: s.gone, p_wall: s.wall, p_err: s.err, p_queued: s.queued }).catch(() => {});
  console.log(`  [${a.label}] IP ${a.ip} → ✅${s.ok}(SMS ${s.queued}) ∅${s.empty} 🗑${s.gone} ⛔${s.wall} ⚠${s.err}`);
  return s;
}

async function oneCycle(accounts) {
  console.log(`\n=== CYKL | ${accounts.length} kont | ${new Date().toISOString()} ===`);
  const t = { ok: 0, queued: 0, rows: 0, err: 0 };
  for (const a of accounts) { const s = await runAccount(a); t.ok += s.ok; t.queued += s.queued; t.rows += s.rows; t.err += s.err; }
  console.log(`=== KONIEC: ✅ ${t.ok} numerów (SMS ${t.queued}), kolejka ${t.rows} ===`);
  // systemowy problem: były ogłoszenia, ale zero numerów i błędy
  if (t.rows >= accounts.length && t.ok === 0 && t.err > 0) await slack(`🔴 OLX mobile: cały cykl 0 numerów mimo ${t.rows} w kolejce (${t.err} błędów) — sprawdź silnik`);
  return t;
}

// ── main ──
if (!SB_URL || !SB_KEY || !PROXY_USER) { console.error('brak ENV (SUPABASE_URL/KEY/PROXY_USER)'); process.exit(1); }
const HOLDER = `${process.env.GITHUB_RUN_ID || 'local'}-${crypto.randomBytes(3).toString('hex')}`;
const LOCK_TTL = 1200; // 20 min
if (!(await rpc('leads_mobile_try_lock', { p_holder: HOLDER, p_ttl_sec: LOCK_TTL }).catch(() => false))) {
  console.log('inny run trzyma lock — wychodzę (dedup, to normalne)'); process.exit(0);
}
console.log(`MOBILE ENGINE (CI) | lock ${HOLDER} | PER_ACCOUNT=${PER_ACCOUNT} pauza ${PAUSE_MIN}min budżet ${BUDGET_MIN}min`);
let cycles = 0;
while (!overBudget()) {
  // heartbeat + weryfikacja że wciąż trzymamy lock (jak ktoś przejął → wychodzimy)
  if (!(await rpc('leads_mobile_try_lock', { p_holder: HOLDER, p_ttl_sec: LOCK_TTL }).catch(() => false))) { console.log('straciłem lock — wychodzę'); break; }
  const accounts = await loadAccounts().catch((e) => { console.error('loadAccounts:', e.message); return []; });
  if (!accounts.length) { console.log('brak żywych kont — czekam'); await sleep(PAUSE_MIN * 60000); continue; }
  await oneCycle(accounts);
  cycles++;
  if (overBudget()) break;
  await rpc('leads_mobile_heartbeat', { p_holder: HOLDER }).catch(() => {});
  console.log(`⏸ pauza ${PAUSE_MIN} min...`);
  await sleep(PAUSE_MIN * 60000);
}
await rpc('leads_mobile_release', { p_holder: HOLDER }).catch(() => {});
console.log(`=== BUDŻET ${BUDGET_MIN}min wyczerpany po ${cycles} cyklach — lock zwolniony, self-chain przejmie ===`);
