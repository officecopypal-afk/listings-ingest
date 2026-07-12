/**
 * OLX — FAZA 2: revealer. CZYSTY FETCH — zero przeglądarki, zero cookie, zero kont, zero fingerprint-farm.
 * Model potwierdzony 12.07 (probe2/probe3): THROTTLE JEST PER-IP (~5-6 reveali/IP), fingerprint/konto/
 * device_id bez znaczenia (OLX nie waliduje treści fingerprintu — losowy działa tak samo).
 *
 * Logika adaptacyjna: używaj jednego proxy IP aż do „Disallowed"/limitu, wtedy rotuj na świeże IP
 * i ponów to samo ogłoszenie (ad jest OK, spalone jest IP). Numer → leads_ingest_offer (auto-SMS).
 * ad_id = base62 '0-9a-zA-Z' z URL-suffixu. friction JWT wiąże username+IP+ad_id (15s) → 1 IP/reveal.
 *
 * Env: IPROYAL_PROXY, OLX_FP(json — statyczny, dowolny poprawny 784-hex), SUPABASE_URL,
 *      SUPABASE_SERVICE_ROLE_KEY, MAX(60), CAP_PER_IP(4), MAX_IP_TRIES(6), DELAY_MS(2500), FETCH_TIMEOUT_MS(20000).
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const FP = JSON.parse(process.env.OLX_FP);
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const MAX = Number(process.env.MAX || 60);
const CAP_PER_IP = Number(process.env.CAP_PER_IP || 4);       // ile reveali na jedno IP zanim proaktywna rotacja
const MAX_IP_TRIES = Number(process.env.MAX_IP_TRIES || 6);    // ile świeżych IP próbować na 1 ogłoszenie
const DELAY_MS = Number(process.env.DELAY_MS || 2500);
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
    if (/disallowed/i.test(detail)) return { status: 'throttle', detail };        // to IP wyczerpane → rotuj
    if (Array.isArray(j?.data?.phones)) return { status: 'nophone', detail: 'empty' };
    return { status: 'error', detail };
  } catch (e) {
    return { status: 'neterr', detail: String(e.cause?.code || e.name || e.message || 'net').slice(0, 40) };
  }
}

const queue = await rpc('leads_get_reveal_queue', { p_portal: 'olx', p_limit: MAX });
console.log(`kolejka: ${queue?.length || 0} | CAP_PER_IP=${CAP_PER_IP} MAX_IP_TRIES=${MAX_IP_TRIES} delay=${DELAY_MS}ms\n`);
let agent = newAgent(), onThisIp = 0, ipCount = 1;
const stat = { ok: 0, inactive: 0, nophone: 0, throttle: 0, error: 0, noid: 0 };

for (let i = 0; i < (queue?.length || 0); i++) {
  const row = queue[i];
  const adId = decodeAd(row.url);
  if (!adId) { stat.noid++; continue; }
  let r, resolved = false;
  for (let tryIp = 0; tryIp < MAX_IP_TRIES && !resolved; tryIp++) {
    if (onThisIp >= CAP_PER_IP) { agent = newAgent(); onThisIp = 0; ipCount++; }  // proaktywna rotacja pod limitem
    r = await reveal(adId, agent);
    onThisIp++;
    if (r.status === 'throttle' || r.status === 'neterr') { agent = newAgent(); onThisIp = 0; ipCount++; await sleep(700); continue; } // spalone IP → świeże, ponów ad
    resolved = true;
  }
  if (r.status === 'ok') {
    stat.ok++;
    const phoneNorm = normPhone(r.phones[0]);
    try {
      const res = await rpc('leads_ingest_offer', { p_offer: { url: row.url, portal: 'olx', portal_listing_id: suffix(row.url), property_type: row.property_type, transaction_type: row.transaction_type, phone: phoneNorm, raw: { source: 'olx-revealer' } } });
      console.log(`  ${i + 1}/${queue.length} ✅ ${r.phones[0]} → ${phoneNorm} (sms:${res?.sms_status || '?'})`);
    } catch (e) { console.error(`  ${i + 1} ingest err`, String(e.message).slice(0, 100)); }
  } else if (r.status === 'inactive') { stat.inactive++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'inactive' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ⊘ martwe`); }
  else if (r.status === 'nophone') { stat.nophone++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'nophone' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ∅ brak numeru`); }
  else if (r.status === 'throttle') { stat.throttle++; console.log(`  ${i + 1}/${queue.length} ⏳ throttle na ${MAX_IP_TRIES} IP (pool spalony, zostaje w kolejce)`); }
  else { stat.error++; await rpc('leads_mark_reveal', { p_id: row.id, p_status: 'error' }).catch(() => {}); console.log(`  ${i + 1}/${queue.length} ✗ ${r.detail}`); }
  await sleep(DELAY_MS + Math.random() * 1500);
}
console.log(`\n=== PODSUMOWANIE === IP użytych: ${ipCount} | ✅ ${stat.ok} | ⊘ ${stat.inactive} | ∅ ${stat.nophone} | ⏳ throttle ${stat.throttle} | ✗ ${stat.error}`);
process.exit(0);
