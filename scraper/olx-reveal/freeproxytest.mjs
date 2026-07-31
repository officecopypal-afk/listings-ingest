// Jednorazowy test: czy na darmowych proxy OLX pozwoli odsłonić numer.
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
import fs from 'fs';

const CSV = '/Users/miloszgryszka/Downloads/proxies.csv';
const TIMEOUT = 9000, CONC = 40;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FP_HEX = crypto.randomBytes(392).toString('hex'); // 784 hex, treść i tak ignorowana
const decodeAd = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };

async function reveal(adId, dispatcher) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null);
    if (!chj?.context) return { status: 'neterr' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(TIMEOUT), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return { status: 'neterr' };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(TIMEOUT), headers: { 'friction-token': exj.token, 'x-fingerprint': FP_HEX, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => ''); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { status: 'ok', phone: j.data.phones[0] };
    const detail = j?.error?.detail || (lp.status + ':' + b.slice(0, 30));
    if (/not active|not found/i.test(detail)) return { status: 'inactive' };
    if (/disallowed/i.test(detail)) return { status: 'throttle' };
    if (Array.isArray(j?.data?.phones)) return { status: 'nophone' };
    return { status: 'error', detail };
  } catch (e) { return { status: 'neterr', detail: String(e.cause?.code || e.name || '').slice(0, 20) }; }
}

// 1) ad_id do testu — świeże z OLX (bez proxy)
async function getAdIds(n) {
  const ids = [];
  for (const off of [0, 40, 80]) {
    const r = await fetch(`https://www.olx.pl/api/v1/offers/?offset=${off}&limit=40&category_id=14&sort_by=created_at%3Adesc`, { headers: { 'user-agent': UA, accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' }, signal: AbortSignal.timeout(15000) });
    for (const o of ((await r.json())?.data || [])) { if (o.business === false && o.url) { const a = decodeAd(o.url.split('?')[0]); if (a) ids.push(a); } if (ids.length >= n) break; }
    if (ids.length >= n) break;
  }
  return ids;
}

const proxies = fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1).map(l => { const [ip, port] = l.split(','); return ip && port ? `http://${ip.trim()}:${port.trim()}` : null; }).filter(Boolean);
const adIds = await getAdIds(30);
console.log(`proxy: ${proxies.length} | ad_id do testu: ${adIds.length} | start...\n`);

const res = { ok: 0, throttle: 0, inactive: 0, nophone: 0, error: 0, neterr: 0 };
const okList = [];
let pi = 0;
async function worker() {
  while (pi < proxies.length) {
    const idx = pi++; const proxy = proxies[idx]; const adId = adIds[idx % adIds.length];
    let agent; try { agent = new ProxyAgent({ uri: proxy, requestTls: { timeout: TIMEOUT } }); } catch { res.neterr++; continue; }
    const r = await reveal(adId, agent).catch(() => ({ status: 'neterr' }));
    agent.close?.().catch(() => {});
    res[r.status] = (res[r.status] || 0) + 1;
    if (r.status === 'ok') { okList.push(`${proxy} -> ${r.phone}`); console.log(`  ✅ DZIAŁA ${proxy} -> ${r.phone}`); }
    else if (r.status === 'throttle') console.log(`  ⛔ throttle ${proxy}`);
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`\n=== WYNIK (${Math.round((Date.now() - t0) / 1000)}s) ===`);
console.log(`✅ numer: ${res.ok} | ⛔ throttle: ${res.throttle} | ⊘ inactive: ${res.inactive} | ∅ nophone: ${res.nophone} | ✗ error: ${res.error} | 💀 martwe/timeout: ${res.neterr}`);
if (okList.length) { console.log(`\nDZIAŁAJĄCE PROXY (${okList.length}):`); okList.forEach(x => console.log('  ' + x)); }
