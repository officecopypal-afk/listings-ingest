/**
 * OLX — FAZA 2: revealer. PURE NODE — bez przeglądarki, bez cookie, bez logowania.
 * Czyta kolejkę (listings phone_id IS NULL), dekoduje ad_id z URL-suffixu (base62),
 * odsłania numer czystym API friction (challenge → exchange → limited-phones) z reużytym
 * fingerprintem (OLX_FP), wrzuca numer przez leads_ingest_offer (auto-enqueue SMS).
 * Rotuje proxy IP co REVEALS_PER_IP (friction throttle ~6-7 reveali / IP). Odporny na
 * flaky proxy: retry na świeżym IP przy błędzie sieci/throttle (do 3 prób / ogłoszenie).
 *
 * Model potwierdzony 12.07: limited-phones NIE wymaga cookie; throttle keyowany na IP(+fp);
 * ad_id = base62 '0-9a-zA-Z' z sufiksu -IDxxxx.html; friction JWT wiąże username+IP+ad_id (15s).
 *
 * Env: IPROYAL_PROXY, OLX_FP(json), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      MAX(50), REVEALS_PER_IP(5), DELAY_MS(9000), FETCH_TIMEOUT_MS(20000).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const FP = JSON.parse(process.env.OLX_FP);
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX = Number(process.env.MAX || 50);
const REVEALS_PER_IP = Number(process.env.REVEALS_PER_IP || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 9000);
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 20000);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const suffix = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); return m ? m[1] : null; };
const decodeAd = (url) => { const s = suffix(url); if (!s) return null; let n = 0n; for (const c of s) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const normPhone = (s) => { const d = String(s).replace(/\D/g, ''); if (d.length === 9) return '+48' + d; if (d.length === 11 && d.startsWith('48')) return '+' + d; return d.length >= 9 ? '+48' + d.slice(-9) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
if (!pm) throw new Error('IPROYAL_PROXY format: http://user:pass@host:port');
const [, PU, PP, PH, PT] = pm;
function newAgent() {
  const sid = crypto.randomBytes(6).toString('hex');
  return new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${sid}_lifetime-5m`).toString('base64') });
}

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
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
    if (!chj?.context) return { status: 'error', detail: 'ch ' + ch.status };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return { status: 'error', detail: 'ex ' + ex.status };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { 'friction-token': exj.token, 'x-fingerprint': FP.x_fingerprint, 'x-device-id': FP.x_device_id, 'x-client': FP.x_client, 'x-platform-type': FP.x_platform_type, version: FP.version, accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => '');
    let j = null; try { j = JSON.parse(b); } catch {}
    const phone = j?.data?.phones?.[0];
    if (phone) return { status: 'ok', phones: j.data.phones };
    const detail = j?.error?.detail || (lp.status + ':' + b.slice(0, 60));
    if (/not active|not found/i.test(detail)) return { status: 'inactive', detail };
    if (/disallowed/i.test(detail)) return { status: 'throttle', detail };
    return { status: 'error', detail };
  } catch (e) {
    return { status: 'neterr', detail: String(e.cause?.code || e.name || e.message || 'net').slice(0, 50) };
  }
}

const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
console.log(`kolejka: ${queue?.length || 0} ogłoszeń | REVEALS_PER_IP=${REVEALS_PER_IP} delay=${DELAY_MS}ms`);
let agent = newAgent(), sinceRotate = 0, ipCount = 1;
const stat = { ok: 0, inactive: 0, throttle: 0, error: 0, neterr: 0, noid: 0 };

for (let i = 0; i < (queue?.length || 0); i++) {
  const row = queue[i];
  const adId = decodeAd(row.url);
  if (!adId) { stat.noid++; continue; }
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 || sinceRotate >= REVEALS_PER_IP) { agent = newAgent(); sinceRotate = 0; ipCount++; }
    r = await reveal(adId, agent);
    sinceRotate++;
    if (r.status === 'neterr' || r.status === 'throttle') { await sleep(1200); continue; } // świeże IP w kolejnej próbie
    break;
  }
  if (r.status === 'ok') {
    stat.ok++;
    const phoneNorm = normPhone(r.phones[0]);
    try {
      const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: phoneNorm, raw: { source: 'olx-revealer' } } });
      console.log(`  ${i + 1}/${queue.length} ✅ ${r.phones[0]} → ${phoneNorm} (sms:${res?.sms_status || '?'})`);
    } catch (e) { console.error(`  ${i + 1} ingest err`, String(e.message).slice(0, 100)); }
  } else if (r.status === 'inactive') {
    stat.inactive++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {});
    console.log(`  ${i + 1}/${queue.length} ⊘ martwe (${suffix(row.url)})`);
  } else if (r.status === 'throttle') {
    stat.throttle++; console.log(`  ${i + 1}/${queue.length} ⏳ throttle mimo 3 świeżych IP`);
  } else if (r.status === 'neterr') {
    stat.neterr++; console.log(`  ${i + 1}/${queue.length} 🌐 proxy flaky (${r.detail}) — zostaje w kolejce`);
  } else {
    stat.error++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'error' }).catch(() => {});
    console.log(`  ${i + 1}/${queue.length} ✗ ${r.detail}`);
  }
  await sleep(DELAY_MS + Math.random() * 2000);
}
console.log(`\n=== PODSUMOWANIE === IP: ${ipCount} | ✅ ${stat.ok} | ⊘ martwe ${stat.inactive} | ⏳ throttle ${stat.throttle} | 🌐 neterr ${stat.neterr} | ✗ err ${stat.error} | bez-id ${stat.noid}`);
process.exit(0);
