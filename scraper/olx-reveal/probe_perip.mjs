/** DECYDUJĄCY TEST: czy naprawdę-świeże IP (zweryfikowane distinct) DZIAŁA teraz?
 *  4 świeże sesje × 12 ogłoszeń. Jeśli świeże IP daje numery → per-IP (trzeba świeżych).
 *  Jeśli świeże IP i tak throttluje → blok szerszy (fingerprint/globalny/współdzielone IP). */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const FP = JSON.parse(process.env.OLX_FP);
const PROXY = process.env.IPROYAL_PROXY;
const [, PU, PP, PH, PT] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const b62 = (s) => { let n = 0n; for (const c of s) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const ads = '1b3trF,1aCSae,1bqIpP,1bqJhT,F6ZkE,1bqLfJ,1b0M5y,1bk5zl,1aU2dQ,19kB0P,1b3rkn,1aRTnI'.split(',').map((s) => b62(s));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newAgent = () => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });
async function ipOf(a) { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(10000) }); return (await r.json()).ip; } catch { return null; } }
async function reveal(adId, agent, fp) {
  try {
    const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
    const chj = await ch.json().catch(() => null); if (!chj?.context) return { s: 'net' };
    const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher: agent, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
    const exj = await ex.json().catch(() => null); if (!exj?.token) return { s: 'net' };
    const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher: agent, signal: AbortSignal.timeout(15000), headers: { 'friction-token': exj.token, 'x-fingerprint': fp, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
    const b = await lp.text().catch(() => ''); let j = null; try { j = JSON.parse(b); } catch {}
    if (j?.data?.phones?.[0]) return { s: 'ok', phone: j.data.phones[0] };
    const d = j?.error?.detail || (lp.status + '');
    if (/not active|not found/i.test(d)) return { s: 'dead' };
    if (/disallowed/i.test(d)) return { s: 'throttle' };
    return { s: 'other', d };
  } catch { return { s: 'net' }; }
}

const usedIps = new Set();
for (let sess = 0; sess < 4; sess++) {
  let agent, ip;
  for (let t = 0; t < 5; t++) { agent = newAgent(); ip = await ipOf(agent); if (ip && !usedIps.has(ip)) break; }
  usedIps.add(ip);
  let ok = 0, thr = 0, dead = 0, oth = 0, net = 0;
  const marks = [];
  for (const ad of ads) {
    const r = await reveal(ad, agent, FP.x_fingerprint);
    if (r.s === 'ok') { ok++; marks.push('✅'); } else if (r.s === 'throttle') { thr++; marks.push('⏳'); } else if (r.s === 'dead') { dead++; marks.push('⊘'); } else if (r.s === 'net') { net++; marks.push('·'); } else { oth++; marks.push('?'); }
    await sleep(900);
  }
  console.log(`sesja ${sess + 1} | IP ${ip} | ${marks.join('')} | ✅${ok} ⏳throttle${thr} ⊘martwe${dead} net${net} inne${oth} (z ${ads.length})`);
}
console.log('\nINTERPRETACJA:');
console.log('  jeśli świeże IP dają po kilka ✅ → BLOK PER-IP (świeże IP działają, problem = zdobywanie świeżych)');
console.log('  jeśli świeże IP dają ~0 ✅ same ⏳ → BLOK SZERSZY (fingerprint/globalny/IP spalone przez innych) → więcej IP nie pomoże');
