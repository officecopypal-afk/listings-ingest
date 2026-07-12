/**
 * OLX — FAZA 2: revealer. CZYSTY FETCH, throttle PER-IP (potwierdzone). Bez cookie/kont/przeglądarki.
 *
 * Pamięć wypalonych IP (leads.olx_ip_burned): freshAgent sprawdza exit-IP (ipify) i bierze tylko świeże.
 * Odraczanie: na „Disallowed" listing wypada z kolejki na DEFER_MIN (worker idzie dalej, wraca gdy IP odżyją).
 * Tryb ciągły (LOOP_UNTIL_EMPTY=1): mieli całą bazę w pętli aż kolejka pusta i brak odroczonych.
 *
 * Env: IPROYAL_PROXY, OLX_FP(json), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MAX(50), CAP_PER_IP(4),
 *      MAX_IP_TRIES(4), DELAY_MS(1500), FETCH_TIMEOUT_MS(20000), IP_COOLDOWN_HOURS(6), FRESH_IP_TRIES(8),
 *      LOOP_UNTIL_EMPTY(0/1), RUN_BUDGET_MS(19min), DEFER_MIN(25).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const FP = JSON.parse(process.env.OLX_FP);
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX = Number(process.env.MAX || 50);
const CAP_PER_IP = Number(process.env.CAP_PER_IP || 4);
const MAX_IP_TRIES = Number(process.env.MAX_IP_TRIES || 4);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 20000);
const COOLDOWN_H = Number(process.env.IP_COOLDOWN_HOURS || 6);
const FRESH_TRIES = Number(process.env.FRESH_IP_TRIES || 8);
const LOOP = process.env.LOOP_UNTIL_EMPTY === '1';
const BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 19 * 60 * 1000);
const DEFER_MIN = Number(process.env.DEFER_MIN || 25);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const decodeAd = (url) => { const s = suffix(url); if (!s) return null; let n = 0n; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
if (!pm) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
const [, PU, PP, PH, PT] = pm;
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 150)}`);
  return t ? JSON.parse(t) : null;
}

const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
async function reveal(adId, dispatcher) {
  try {
    const username = crypto.randomUUID();
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null);
    if (!chj?.context) return { status: 'neterr', detail: 'ch ' + ch.status };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return { status: 'neterr', detail: 'ex ' + ex.status };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { 'friction-token': exj.token, 'x-fingerprint': FP.x_fingerprint, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => '');
    let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { status: 'ok', phones: j.data.phones };
    const detail = j?.error?.detail || (lp.status + ':' + b.slice(0, 50));
    if (/not active|not found/i.test(detail)) return { status: 'inactive', detail };
    if (/disallowed/i.test(detail)) return { status: 'throttle', detail };
    if (Array.isArray(j?.data?.phones)) return { status: 'nophone', detail: 'empty' };
    return { status: 'error', detail };
  } catch (e) {
    return { status: 'neterr', detail: String(e.cause?.code || e.name || e.message || 'net').slice(0, 40) };
  }
}

// ---- pamięć wypalonych IP + świeże sesje
const burnedSet = new Set((await rpc('leads_ip_burned_recent', { p_cooldown_hours: COOLDOWN_H }).catch(() => [])) || []);
const toBurn = new Set();
async function ipOf(dispatcher) {
  try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher, signal: AbortSignal.timeout(8000) }); return (await r.json())?.ip || null; } catch { return null; }
}
async function freshAgent() {
  for (let t = 0; t < FRESH_TRIES; t++) {
    const agent = newAgent();
    const ip = await ipOf(agent);
    if (!ip || burnedSet.has(ip)) continue;
    return { agent, ip };
  }
  const agent = newAgent();
  return { agent, ip: await ipOf(agent) };
}

const grand = { ok: 0, inactive: 0, nophone: 0, throttle: 0, error: 0, noid: 0, ip: 0 };

async function processBatch() {
  const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
  if (!queue?.length) return { fetched: 0, ok: 0 };
  let cur = await freshAgent(), onThisIp = 0; grand.ip++;
  const burnCurrent = () => { if (cur.ip) { toBurn.add(cur.ip); burnedSet.add(cur.ip); } };
  let batchOk = 0;
  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    const adId = decodeAd(row.url);
    if (!adId) { grand.noid++; continue; }
    let r, resolved = false;
    for (let tryIp = 0; tryIp < MAX_IP_TRIES && !resolved; tryIp++) {
      if (onThisIp >= CAP_PER_IP) { cur = await freshAgent(); onThisIp = 0; grand.ip++; }
      r = await reveal(adId, cur.agent);
      onThisIp++;
      if (r.status === 'throttle') { burnCurrent(); cur = await freshAgent(); onThisIp = 0; grand.ip++; await sleep(400); continue; }
      if (r.status === 'neterr') { cur = await freshAgent(); onThisIp = 0; grand.ip++; await sleep(400); continue; }
      resolved = true;
    }
    if (r.status === 'ok') {
      grand.ok++; batchOk++;
      const phoneNorm = normPhone(r.phones[0]);
      try {
        const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: phoneNorm, raw: { source: 'olx-revealer' } } });
        console.log(`  ✅ ${r.phones[0]} → ${phoneNorm} (sms:${res?.sms_status || '?'})`);
      } catch (e) { console.error('  ingest err', String(e.message).slice(0, 100)); }
    } else if (r.status === 'inactive') { grand.inactive++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); }
    else if (r.status === 'nophone') { grand.nophone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'nophone' }).catch(() => {}); }
    else if (r.status === 'throttle') { grand.throttle++; await rpc('leads_defer_reveal', { p_id: row.id, p_minutes: DEFER_MIN }).catch(() => {}); } // odrocz — wróci gdy IP odżyją
    else { grand.error++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'error' }).catch(() => {}); }
    await sleep(DELAY_MS + Math.random() * 800);
  }
  if (toBurn.size) { await rpc('leads_ip_burn', { p_ips: [...toBurn] }).catch(() => {}); toBurn.clear(); }
  return { fetched: queue.length, ok: batchOk };
}

// ---- główna pętla
console.log(`start | LOOP=${LOOP} MAX=${MAX} CAP_PER_IP=${CAP_PER_IP} DEFER=${DEFER_MIN}m | wypalonych IP: ${burnedSet.size}`);
const start = Date.now();
let dryStreak = 0, batches = 0;
while (true) {
  const res = await processBatch();
  batches++;
  console.log(`batch #${batches}: pobrano ${res.fetched}, numerów ${res.ok} | RAZEM ✅ ${grand.ok} | ⊘ ${grand.inactive} | ∅ ${grand.nophone} | ⏳ odroczono ${grand.throttle} | ✗ ${grand.error} | IP ${grand.ip}`);
  if (!LOOP) break;
  if (Date.now() - start > BUDGET_MS) { console.log('budżet czasu wyczerpany — koniec runu (cron/kolejny run dokończy)'); break; }
  if (res.fetched === 0) {
    const deferred = Number(await rpc('leads_count_deferred', { p_portal: 'olx' }).catch(() => 0)) || 0;
    if (!deferred) { console.log('🎉 KONIEC — cała baza ogarnięta (kolejka pusta, brak odroczonych)'); break; }
    console.log(`kolejka pusta, ${deferred} odroczonych czeka na regenerację IP — śpię 4 min...`);
    await sleep(4 * 60 * 1000);
  } else if (res.ok === 0) {
    dryStreak++; const wait = Math.min(4 * 60_000, 45_000 * dryStreak);
    console.log(`batch bez numeru (streak ${dryStreak}) — śpię ${Math.round(wait / 1000)}s na świeże IP...`);
    await sleep(wait);
  } else { dryStreak = 0; }
}
console.log(`\n=== KONIEC RUNU === ✅ ${grand.ok} | ⊘ ${grand.inactive} | ∅ ${grand.nophone} | ⏳ odroczono ${grand.throttle} | ✗ ${grand.error} | IP użytych ${grand.ip}`);
process.exit(grand.ok === 0 && grand.error >= 15 ? 1 : 0);
