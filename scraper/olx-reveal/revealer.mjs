/**
 * OLX — FAZA 2: revealer. SZCZUPŁY + RÓWNOLEGŁY. Czysty fetch, throttle PER-IP (potwierdzone).
 * Bez cookie/kont/przeglądarki/ipify. IP bierzemy z tokena friction (JWT actor.ip) — palimy spalone gratis.
 *
 * CONCURRENCY workerów naraz, każdy reużywa świeże IP do CAP_PER_IP reveali (potem rotacja albo throttle).
 * Odraczanie: „Disallowed" po MAX_IP_TRIES świeżych IP → listing wypada z kolejki na DEFER_MIN.
 * Tryb ciągły (LOOP_UNTIL_EMPTY=1): mieli całą bazę aż kolejka pusta i brak odroczonych.
 *
 * Env: IPROYAL_PROXY, OLX_FP(json), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CONCURRENCY(6), MAX(120),
 *      CAP_PER_IP(5), MAX_IP_TRIES(4), FETCH_TIMEOUT_MS(15000), IP_COOLDOWN_HOURS(6),
 *      LOOP_UNTIL_EMPTY(0/1), RUN_BUDGET_MS(19min), DEFER_MIN(25).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const FP = JSON.parse(process.env.OLX_FP);
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);
const MAX = Number(process.env.MAX || 120);
const CAP_PER_IP = Number(process.env.CAP_PER_IP || 5);
const MAX_IP_TRIES = Number(process.env.MAX_IP_TRIES || 4);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const COOLDOWN_H = Number(process.env.IP_COOLDOWN_HOURS || 6);
const LOOP = process.env.LOOP_UNTIL_EMPTY === '1';
const BUDGET_MS = Number(process.env.RUN_BUDGET_MS || 19 * 60 * 1000);
const DEFER_MIN = Number(process.env.DEFER_MIN || 25);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const decodeAd = (url) => { const s = suffix(url); if (!s) return null; let n = 0n; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const tokenIp = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString())?.actor?.ip || null; } catch { return null; } };
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

// pamięć wypalonych IP (cross-run) — do skipu bez ipify (IP z tokena) i persystencji
const burnedSet = new Set((await rpc('leads_ip_burned_recent', { p_cooldown_hours: COOLDOWN_H }).catch(() => [])) || []);
const toBurn = new Set();

const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
async function reveal(adId, dispatcher) {
  try {
    const username = crypto.randomUUID();
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null);
    if (!chj?.context) return { status: 'neterr' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return { status: 'neterr' };
    const ip = tokenIp(exj.token);
    if (ip && burnedSet.has(ip)) return { status: 'throttle', ip };          // znane spalone → rotuj bez limited-phones
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { 'friction-token': exj.token, 'x-fingerprint': FP.x_fingerprint, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => '');
    let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { status: 'ok', phones: j.data.phones, ip };
    const detail = j?.error?.detail || (lp.status + ':' + b.slice(0, 40));
    if (/not active|not found/i.test(detail)) return { status: 'inactive', ip };
    if (/disallowed/i.test(detail)) return { status: 'throttle', ip };
    if (Array.isArray(j?.data?.phones)) return { status: 'nophone', ip };
    return { status: 'error', ip, detail };
  } catch (e) { return { status: 'neterr', detail: String(e.cause?.code || e.name || '').slice(0, 30) }; }
}

const grand = { ok: 0, inactive: 0, nophone: 0, throttle: 0, error: 0, ip: 0 };
const burn = (ip) => { if (ip) { toBurn.add(ip); burnedSet.add(ip); } };

async function processBatch() {
  const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
  if (!queue?.length) return { fetched: 0, ok: 0 };
  let idx = 0, batchOk = 0;
  async function worker() {
    let agent = newAgent(), onIp = 0; grand.ip++;
    const rotate = () => { agent.close?.().catch(() => {}); agent = newAgent(); onIp = 0; grand.ip++; };
    while (idx < queue.length) {
      const row = queue[idx++];
      const adId = decodeAd(row.url);
      if (!adId) continue;
      if (onIp >= CAP_PER_IP) rotate();
      let r, done = false;
      for (let t = 0; t < MAX_IP_TRIES && !done; t++) {
        r = await reveal(adId, agent); onIp++;
        if (r.status === 'throttle') { burn(r.ip); rotate(); continue; }   // spalone IP → świeże, ponów ad
        if (r.status === 'neterr') { rotate(); continue; }
        done = true;
      }
      if (r.status === 'ok') {
        grand.ok++; batchOk++;
        const phoneNorm = normPhone(r.phones[0]);
        try { const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: phoneNorm, raw: { source: 'olx-revealer' } } });
          console.log(`  ✅ ${r.phones[0]} (sms:${res?.sms_status || '?'})`); } catch {}
      } else if (r.status === 'inactive') { grand.inactive++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); }
      else if (r.status === 'nophone') { grand.nophone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'nophone' }).catch(() => {}); }
      else if (r.status === 'error') { grand.error++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'error' }).catch(() => {}); }
      else { grand.throttle++; await rpc('leads_defer_reveal', { p_id: row.id, p_minutes: DEFER_MIN }).catch(() => {}); } // throttle/neterr po próbach → odrocz
    }
    agent.close?.().catch(() => {});
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (toBurn.size) { await rpc('leads_ip_burn', { p_ips: [...toBurn] }).catch(() => {}); toBurn.clear(); }
  return { fetched: queue.length, ok: batchOk };
}

console.log(`start | LOOP=${LOOP} CONC=${CONCURRENCY} MAX=${MAX} CAP_PER_IP=${CAP_PER_IP} | wypalonych IP: ${burnedSet.size}`);
const start = Date.now();
let dryStreak = 0, batches = 0;
while (true) {
  const res = await processBatch();
  batches++;
  console.log(`batch #${batches}: pobrano ${res.fetched}, numerów ${res.ok} | RAZEM ✅ ${grand.ok} | ⊘ ${grand.inactive} | ∅ ${grand.nophone} | ⏳ odroczono ${grand.throttle} | ✗ ${grand.error} | IP ${grand.ip}`);
  if (!LOOP) break;
  if (Date.now() - start > BUDGET_MS) { console.log('budżet czasu wyczerpany'); break; }
  if (res.fetched === 0) {
    const deferred = Number(await rpc('leads_count_deferred', { p_portal: 'olx' }).catch(() => 0)) || 0;
    if (!deferred) { console.log('🎉 KONIEC — cała baza ogarnięta'); break; }
    console.log(`kolejka pusta, ${deferred} odroczonych czeka — śpię 4 min na regenerację IP...`);
    await sleep(4 * 60 * 1000);
  } else if (res.ok === 0) { dryStreak++; const w = Math.min(3 * 60_000, 30_000 * dryStreak); console.log(`batch bez numeru (${dryStreak}) — śpię ${Math.round(w / 1000)}s...`); await sleep(w); }
  else dryStreak = 0;
}
console.log(`\n=== KONIEC RUNU === ✅ ${grand.ok} | ⊘ ${grand.inactive} | ∅ ${grand.nophone} | ⏳ odroczono ${grand.throttle} | ✗ ${grand.error} | IP użytych ${grand.ip}`);
process.exit(grand.ok === 0 && grand.error >= 15 ? 1 : 0);
