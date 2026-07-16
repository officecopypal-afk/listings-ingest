/**
 * OLX MOBILE ENGINE (produkcja/CI) — czysty HTTP, bez przeglądarki/frictiona/captchy.
 * HARMONOGRAM „staggered": każde konto robi SERIĘ ~8-12 reveali, potem ~2h chłodzenia (losowo),
 * konta POPRZESUWANE w fazie (jedno bursuje naraz, nigdy wszystkie razem). Ludzkie przerwy w serii.
 * Stan harmonogramu w Supabase (next_reveal_at per konto) — przeżywa restarty.
 * Ściana „podejrzana aktywność" (400) → długie chłodzenie 5-6h + blokada + alert.
 * Proxy + device (iOS/build) per konto. Lock (singleton). ENV: SUPABASE_URL/KEY, PROXY_* (fallback), BUDGET_MIN.
 */
import { fetch, ProxyAgent } from 'undici';
import crypto from 'crypto';

const CLIENT_ID = '2tmi4nl6rt49qtvippambh0kej';
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY_USER = (process.env.PROXY_USER || '').trim();
const PROXY_PASS = (process.env.PROXY_PASS || '').trim();
const PROXY_PORT = (process.env.PROXY_PORT || '12323').trim();

const BURST_MIN = Number(process.env.BURST_MIN || 6);
const BURST_MAX = Number(process.env.BURST_MAX || 8);
const COOL_MIN = Number(process.env.COOL_MIN || 110);   // min chłodzenia (min)
const COOL_MAX = Number(process.env.COOL_MAX || 140);
const BLOCK_COOL_MIN = Number(process.env.BLOCK_COOL_MIN || 300); // po ścianie: 5-6h
const BLOCK_COOL_MAX = Number(process.env.BLOCK_COOL_MAX || 360);
const GAP_MIN_MS = Number(process.env.GAP_MIN_MS || 20000);   // przerwa w serii 20s-2min
const GAP_MAX_MS = Number(process.env.GAP_MAX_MS || 120000);
const INTER_BURST_MIN = Number(process.env.INTER_BURST_MIN || 2); // odstęp między seriami różnych kont (min)
const INTER_BURST_MAX = Number(process.env.INTER_BURST_MAX || 6);
const LOOP_MIN = Number(process.env.LOOP_MIN || 5);          // sprawdzanie „kto due" gdy nic nie ma
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);    // ile kont naraz (równolegle, każde niezależne)
const CLAIM_MIN = Number(process.env.CLAIM_MIN || 20);       // na ile min „rezerwujemy" claim (> czas serii, bo równolegle)
const BUDGET_MIN = Number(process.env.BUDGET_MIN || 330);
const DRY = process.env.DRY === '1';                        // tryb testowy: nie rewelu, tylko pokaż harmonogram

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randI = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const randMs = (a, b) => a + Math.floor(Math.random() * (b - a));
const t0 = Date.now();
const overBudget = () => (Date.now() - t0) / 60000 >= BUDGET_MIN;

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status} ${t.slice(0, 90)}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }
// Wyłącznik z panelu (flaga w Supabase). Błąd odczytu → true (nie ubijaj silnika na chwilowym błędzie sieci).
async function revealEnabled() { try { return (await rpc('leads_reveal_control_get', {})) !== false; } catch { return true; } }

const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decode62 = (s) => { let n = 0n; for (const c of s) { const i = B62.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const adIdFromUrl = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? decode62(m[1]) : null; };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };

// Profil urządzenia per konto (iOS + build różny → UA nie identyczne). Model tylko dla ewidencji (nie ma go w UA).
const DEVICES = [
  { m: 'iPhone 12', ios: '26.4.1', app: '4.149.0' },
  { m: 'iPhone 13', ios: '26.5.1', app: '4.150.0' },
  { m: 'iPhone 14', ios: '26.5.2', app: '4.150.0' },
  { m: 'iPhone 15', ios: '26.6', app: '4.150.0' },
  { m: 'iPhone 16', ios: '26.5.2', app: '4.150.0' },
  { m: 'iPhone 13', ios: '26.3.1', app: '4.149.0' },
  { m: 'iPhone 14', ios: '26.6.1', app: '4.150.0' },
  { m: 'iPhone 15', ios: '26.5', app: '4.150.0' },
];
const devFor = (label) => DEVICES[parseInt(crypto.createHash('md5').update('dev:' + label).digest('hex').slice(0, 8), 16) % DEVICES.length];

const agentFor = (r) => {
  const u = r.proxy_user || PROXY_USER, p = r.proxy_pass || PROXY_PASS, port = r.proxy_port || PROXY_PORT;
  return new ProxyAgent({ uri: `http://${r.ip}:${port}`, token: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
};

async function loadAccounts() {
  const rows = await rpc('leads_get_mobile_tokens', {});
  return (rows || []).filter((r) => r.status !== 'dead').map((r) => ({
    label: r.label, ip: r.ip, refresh_token: r.refresh_token, blocked_at: r.blocked_at, next_reveal_at: r.next_reveal_at,
    agent: agentFor(r), access: null, accessExp: 0, deviceId: crypto.createHash('sha1').update('dev:' + r.label).digest('hex'), dev: devFor(r.label), dead: false, netFails: 0,
  }));
}

async function refresh(a) {
  let r;
  try { r = await fetch('https://login.olx.pl/oauth2/token', { method: 'POST', dispatcher: a.agent, headers: { 'content-type': 'application/json', 'user-agent': 'OLX.pl/883 CFNetwork/3860.600.12 Darwin/25.5.0', accept: '*/*' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: CLIENT_ID }), signal: AbortSignal.timeout(25000) }); }
  catch (e) { a.netFails++; if (a.netFails >= 2) await slack(`🟠 OLX mobile: proxy konta ${a.label} (${a.ip}) nie odpowiada`); throw new Error('net ' + String(e.message).slice(0, 40)); }
  a.netFails = 0;
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || !j.access_token) { if (String(j.error) === 'invalid_grant') { a.dead = true; await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'dead' }).catch(() => {}); await slack(`🔴 OLX mobile: konto ${a.label} — refresh_token PADŁ, re-login (przycisk w panelu)`); } throw new Error(`refresh ${r.status} ${j.error || ''}`); }
  if (j.refresh_token && j.refresh_token !== a.refresh_token) { a.refresh_token = j.refresh_token; await rpc('leads_set_mobile_token_value', { p_label: a.label, p_refresh_token: j.refresh_token }).catch(() => {}); }
  a.access = j.access_token; a.accessExp = Date.now() + (j.expires_in - 120) * 1000;
}
async function ensureToken(a) { if (!a.access || Date.now() > a.accessExp) await refresh(a); }
const H = (a) => ({ authorization: `Bearer ${a.access}`, accept: '*/*', version: 'v1.17', 'x-platform-type': 'ios', 'user-agent': `iPhone App Ver ${a.dev.app} (iOS ${a.dev.ios})`, 'x-device-id': a.deviceId, 'accept-language': 'pl' });

async function reveal(a, adId) {
  await fetch(`https://www.olx.pl/api/v1/ads/${adId}/phone-view`, { method: 'POST', dispatcher: a.agent, headers: H(a), body: '', signal: AbortSignal.timeout(20000) }).catch(() => {});
  let r = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones`, { dispatcher: a.agent, headers: H(a), signal: AbortSignal.timeout(20000) });
  if (r.status === 401) { await refresh(a); r = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones`, { dispatcher: a.agent, headers: H(a), signal: AbortSignal.timeout(20000) }); }
  const st = r.status;
  if (st === 403 || st === 429) return { kind: 'wall', status: st };
  if (st === 400 || st === 404) {
    const j = await r.json().catch(() => ({})); const d = String(j?.error?.detail || '');
    if (/podejrzan|kontynuowa/i.test(d)) return { kind: 'wall', status: st, detail: d };   // limit/flaga, NIE usunięte
    return { kind: 'gone', status: st };                                                    // ogłoszenie usunięte
  }
  if (st !== 200) return { kind: 'err', status: st };
  const j = await r.json().catch(() => ({})); const ph = j?.data?.phones?.[0];
  return ph ? { kind: 'ok', phone: ph } : { kind: 'empty' };
}

async function burst(a) {
  const s = { ok: 0, empty: 0, gone: 0, wall: 0, err: 0, queued: 0 };
  let hitWall = false;
  try { await ensureToken(a); await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'ok' }).catch(() => {}); }
  catch (e) { console.log(`  [${a.label}] token pad: ${e.message}`); return { s, hitWall, tokenDead: a.dead }; }
  const N = randI(BURST_MIN, BURST_MAX);
  const rows = await rpc('leads_claim_reveal_queue', { p_portal: 'olx', p_limit: N, p_claim_min: CLAIM_MIN }).catch(() => []);
  console.log(`  [${a.label}] ${a.dev.m}/iOS${a.dev.ios} (${a.ip}) → seria ${rows.length}/${N}`);
  for (const row of rows) {
    if (!(await revealEnabled())) { console.log(`  [${a.label}] ⏹ flaga OFF — przerywam serię`); break; }
    const adId = adIdFromUrl(row.url); if (!adId) continue;
    let res; try { res = await reveal(a, adId); } catch { s.err++; await sleep(randMs(GAP_MIN_MS, GAP_MAX_MS)); continue; }
    if (res.kind === 'ok') { s.ok++; try { const ing = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: adId, property_type: row.property_type, transaction_type: row.transaction_type, phone: normPhone(res.phone), raw: { source: 'olx-mobile', acct: a.label } } }); if (ing?.sms_status === 'queued') s.queued++; } catch {} }
    else if (res.kind === 'empty') { s.empty++; await rpc('leads_mark_reveal_fail', { p_id: row.id, p_minutes: 180, p_reason: 'no_phone' }).catch(() => {}); }
    else if (res.kind === 'gone') { s.gone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); }
    else if (res.kind === 'wall') { s.wall++; hitWall = true; console.log(`  [${a.label}] ⛔ ŚCIANA (${res.detail ? 'podejrzana aktywność' : res.status}) — przerywam serię`); break; }
    else s.err++;
    await sleep(randMs(GAP_MIN_MS, GAP_MAX_MS));   // ludzka przerwa między numerami
  }
  await rpc('leads_mobile_stats_insert', { p_label: a.label, p_ok: s.ok, p_empty: s.empty, p_gone: s.gone, p_wall: s.wall, p_err: s.err, p_queued: s.queued }).catch(() => {});
  console.log(`  [${a.label}] → ✅${s.ok}(SMS ${s.queued}) ∅${s.empty} 🗑${s.gone} ⛔${s.wall} ⚠${s.err}`);
  return { s, hitWall };
}

// ── lock ──
const HOLDER = `${process.env.GITHUB_RUN_ID || 'local'}-${crypto.randomBytes(3).toString('hex')}`;
const LOCK_TTL = 1800; // 30 min — z zapasem na dłuższą iterację przy K=3 (partia 3 serii równolegle)
async function keepLock() { return rpc('leads_mobile_try_lock', { p_holder: HOLDER, p_ttl_sec: LOCK_TTL }).catch(() => false); }

// ── main ──
if (!SB_URL || !SB_KEY) { console.error('brak ENV SUPABASE'); process.exit(1); }
if (!(await keepLock())) { console.log('inny run trzyma lock — wychodzę (dedup)'); process.exit(0); }
if (!(await revealEnabled())) { console.log('⏹ reveal WYŁĄCZONY (flaga panelu) — wychodzę, zero reveli'); await rpc('leads_mobile_release', { p_holder: HOLDER }).catch(() => {}); process.exit(0); }
console.log(`MOBILE ENGINE (scheduler) | lock ${HOLDER} | seria ${BURST_MIN}-${BURST_MAX} | chłodzenie ${COOL_MIN}-${COOL_MAX}min | budżet ${BUDGET_MIN}min ${DRY ? '| DRY' : ''}`);

while (!overBudget()) {
  if (!(await keepLock())) { console.log('straciłem lock — wychodzę'); break; }
  if (!(await revealEnabled())) { console.log('⏹ reveal wyłączony w trakcie (flaga panelu) — kończę run'); break; }
  let accounts = await loadAccounts().catch((e) => { console.error('load:', e.message); return []; });

  // przypisz losowy start (rozłożony na 2h) kontom bez harmonogramu → faza porozsuwana
  for (const a of accounts) {
    if (!a.next_reveal_at) {
      const off = randI(0, 120);
      await rpc('leads_set_mobile_next', { p_label: a.label, p_minutes: off }).catch(() => {});
      a.next_reveal_at = new Date(Date.now() + off * 60000).toISOString();
      console.log(`  [${a.label}] pierwszy start za ${off} min`);
    }
  }

  const now = Date.now();
  const due = accounts.filter((a) => a.next_reveal_at && new Date(a.next_reveal_at).getTime() <= now).sort((x, y) => new Date(x.next_reveal_at) - new Date(y.next_reveal_at));

  if (!due.length) {
    const soon = accounts.map((a) => a.next_reveal_at ? Math.round((new Date(a.next_reveal_at) - now) / 60000) : null).filter((x) => x != null).sort((p, q) => p - q)[0];
    console.log(`— nic due, najbliższe za ~${soon ?? '?'} min — czekam ${LOOP_MIN} min`);
    await sleep(LOOP_MIN * 60000);
    continue;
  }

  // Równolegle do CONCURRENCY kont naraz. Każde konto niezależne: własny token/proxy/device/gapy,
  // więc per-konto tempo (6-8/cooldown) się NIE zmienia → ryzyko ściany bez zmian. Claim jest
  // atomowy (FOR UPDATE SKIP LOCKED) → konta nie wyrwą tego samego ogłoszenia.
  const batch = due.slice(0, CONCURRENCY);
  console.log(`▶ partia równoległa (${batch.length}): ${batch.map((x) => x.label).join(', ')}`);
  await Promise.all(batch.map(async (a, i) => {
    await sleep(randMs(0, 8000) + i * 1500); // jitter startu — konta nie ruszają w tej samej milisekundzie
    if (DRY) { console.log(`  [${a.label}] DUE (DRY — nie rewelu)`); await rpc('leads_set_mobile_next', { p_label: a.label, p_minutes: randI(COOL_MIN, COOL_MAX) }).catch(() => {}); return; }
    let res;
    try { res = await burst(a); } catch (e) { console.log(`  [${a.label}] burst błąd: ${e.message}`); return; }
    const { s, hitWall } = res;
    if (hitWall) {
      const cool = randI(BLOCK_COOL_MIN, BLOCK_COOL_MAX);
      await rpc('leads_set_mobile_blocked', { p_label: a.label, p_blocked: true }).catch(() => {});
      await rpc('leads_set_mobile_next', { p_label: a.label, p_minutes: cool }).catch(() => {});
      await slack(`🟡 OLX mobile: konto ${a.label} trafiło ścianę (podejrzana aktywność) — chłodzę ${cool}min`);
    } else {
      if (a.blocked_at && s.ok > 0) await rpc('leads_set_mobile_blocked', { p_label: a.label, p_blocked: false }).catch(() => {}); // odwisło
      await rpc('leads_set_mobile_next', { p_label: a.label, p_minutes: randI(COOL_MIN, COOL_MAX) }).catch(() => {});
    }
  }));
  await keepLock().catch(() => {}); // odśwież heartbeat po partii — singleton pewny nawet przy dłuższej partii K=3
  await sleep(randMs(INTER_BURST_MIN * 60000, INTER_BURST_MAX * 60000)); // odstęp między partiami
}
await rpc('leads_mobile_release', { p_holder: HOLDER }).catch(() => {});
console.log('=== budżet wyczerpany — lock zwolniony, self-chain przejmie ===');
