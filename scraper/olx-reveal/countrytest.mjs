// Porównanie skuteczności reveala per KRAJ (świeże IP, 1 reveal/IP). Który kraj ma najlepszą pulę dla OLX?
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const swap = (pp, c) => /_country-[a-z]{2}/i.test(pp) ? pp.replace(/_country-[a-z]{2}/i, `_country-${c}`) : `${pp}_country-${c}`;
const agentFor = (c) => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${swap(PP, c)}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FP_HEX = crypto.randomBytes(392).toString('hex');
const decodeAd = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
const TO = 12000;

async function reveal(adId, d) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher: d, signal: AbortSignal.timeout(TO), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null);
    if (chj?.challenge?.type === 'delay') return 'delay';
    if (!chj?.context) return 'neterr';
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher: d, signal: AbortSignal.timeout(TO), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null);
    if (!exj?.token) return 'neterr';
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher: d, signal: AbortSignal.timeout(TO), headers: { 'friction-token': exj.token, 'x-fingerprint': FP_HEX, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text(); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return 'ok';
    const dd = (j?.error?.detail || b).toLowerCase();
    if (/not active|not found/.test(dd)) return 'inactive';
    if (/disallowed/.test(dd)) return 'rate';
    return 'error';
  } catch { return 'neterr'; }
}

const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=40&category_id=14&sort_by=created_at%3Adesc', { headers: FH });
const ads = ((await lr.json())?.data || []).filter(o => o.business === false).map(o => decodeAd(o.url.split('?')[0])).filter(Boolean);
console.log(`ad_id: ${ads.length} | test 40 reveali/kraj, świeże IP\n`);

const N = 40, CONC = 15;
for (const c of ['pl', 'ua', 'ro', 'bg', 'pt']) {
  const res = { ok: 0, rate: 0, delay: 0, inactive: 0, neterr: 0, error: 0 };
  let i = 0;
  async function w() { while (i < N) { const adId = ads[i++ % ads.length]; const a = agentFor(c); const x = await reveal(adId, a); a.close?.().catch(() => {}); res[x] = (res[x] || 0) + 1; } }
  await Promise.all(Array.from({ length: CONC }, w));
  const okPct = (100 * res.ok / N).toFixed(0);
  console.log(`${c.toUpperCase()}: ✅ ${res.ok} (${okPct}%) | ⛔ rate ${res.rate} | 🔄 delay ${res.delay} | ⊘ ${res.inactive} | 💀 ${res.neterr} | ✗ ${res.error}`);
}
