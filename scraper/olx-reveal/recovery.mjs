/** POMIAR REGENERACJI: losuj IP, te spalone (z czarnej listy) odsłoń — czy starsze spalenia już wróciły?
 *  ✅ = IP wróciło do życia. Grupuje po wieku spalenia. Odpowiada: czy spalone IP regenerują się z czasem. */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const FP = JSON.parse(process.env.OLX_FP).x_fingerprint;
const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const [, PU, PP, PH, PT] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const b62 = (s) => { let n = 0n; for (const c of s) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const ads = '1b60Ds,16ZCdZ,VPdTj,18r6Rd,1bgjUZ,1a30C3,1bmp29,1b2vTm,17pVed,1bqM3K,1bdm2G,1bqNsm,18YOsO,1bqO3A,1bqOcB,1bqOBG,1bqOn7,1bqOLM,1bqOE3,1basLm'.split(',').map(b62);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });
const ipOf = async (a) => { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(10000) }); return (await r.json()).ip; } catch { return null; } };
async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json(); }
async function reveal(adId, agent) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null); if (!chj?.context) return { s: 'net' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null); if (!exj?.token) return { s: 'net' };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher: agent, signal: AbortSignal.timeout(15000), headers: { 'friction-token': exj.token, 'x-fingerprint': FP, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => ''); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { s: 'ok', phone: j.data.phones[0] };
    const d = j?.error?.detail || '';
    if (/not active|not found/i.test(d)) return { s: 'dead' };
    if (/disallowed/i.test(d)) return { s: 'throttle' };
    return { s: 'other' };
  } catch { return { s: 'net' }; }
}

const detail = await rpc('leads_ip_burned_detail', { p_hours: 12 });
console.log(`spalonych z wiekiem: ${Object.keys(detail).length}\n`);
const results = []; let adi = 0, tested = 0;
for (let i = 0; i < 80 && tested < 24; i++) {
  const agent = newAgent(); const ip = await ipOf(agent);
  if (!ip) continue;
  const age = detail[ip];
  if (age === undefined) continue;              // świeże (nie spalone) → w tym teście pomijam
  let r = await reveal(ads[adi++ % ads.length], agent);
  if (r.s === 'dead') r = await reveal(ads[adi++ % ads.length], agent); // martwe ogł. → druga próba na tym IP
  if (r.s === 'dead' || r.s === 'net' || r.s === 'other') continue;     // nierozstrzygające
  results.push({ ip, age, ok: r.s === 'ok' }); tested++;
  console.log(`  IP ${ip} spalone ${age} min temu → ${r.s === 'ok' ? '✅ WRÓCIŁ (' + r.phone + ')' : '⏳ dalej spalony'}`);
  await sleep(700);
}
const buckets = { '<60 min': [], '60-120 min': [], '>120 min': [] };
for (const r of results) { const b = r.age < 60 ? '<60 min' : r.age < 120 ? '60-120 min' : '>120 min'; buckets[b].push(r); }
console.log('\n=== REGENERACJA wg wieku spalenia ===');
for (const [b, arr] of Object.entries(buckets)) { if (!arr.length) { console.log(`  ${b}: brak próbek`); continue; } const ok = arr.filter((r) => r.ok).length; console.log(`  spalone ${b.padEnd(11)}: ${ok}/${arr.length} WRÓCIŁO (${Math.round(100 * ok / arr.length)}%)`); }
console.log('\nWERDYKT: jeśli starsze spalenia wracają (%↑ z wiekiem) → REGENERACJA POTWIERDZONA, to kwestia czasu.');
console.log('         jeśli wszystkie ⏳ nawet po 2-3h → regeneracja wolniejsza/wątpliwa, trzeba dłuższego pomiaru.');
