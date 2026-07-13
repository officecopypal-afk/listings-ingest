// Czy _session sticky trzyma to samo IP przez sekwencję (jak worker robi 6 reveali)?
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const COUNTRY = (process.env.PROXY_COUNTRY || '').trim().toLowerCase();
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const PPc = !COUNTRY ? PP : (/_country-[a-z]{2}/i.test(PP) ? PP.replace(/_country-[a-z]{2}/i, `_country-${COUNTRY}`) : `${PP}_country-${COUNTRY}`);
const agent = (sess, life) => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PPc}_session-${sess}_lifetime-${life}`).toString('base64') });
async function getIp(a) { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(15000) }); return (await r.json()).ip; } catch (e) { return 'ERR:' + (e.cause?.code || e.name); } }

console.log(`kraj: ${COUNTRY || 'pl'} | test stickiness (7 zapytań/sesję co 3s ≈ czas 6 reveali)\n`);

// 3 różne sesje sticky (jak 3 workery) — każda powinna trzymać JEDNO IP
for (const sess of [crypto.randomBytes(5).toString('hex'), crypto.randomBytes(5).toString('hex'), crypto.randomBytes(5).toString('hex')]) {
  const a = agent(sess, '10m');
  const ips = [];
  for (let i = 0; i < 7; i++) { ips.push(await getIp(a)); await new Promise(r => setTimeout(r, 3000)); }
  a.close?.().catch(() => {});
  const uniq = new Set(ips.filter(x => !x.startsWith('ERR')));
  console.log(`sesja ${sess}: ${ips.join(' | ')}`);
  console.log(`  → unikalnych IP: ${uniq.size} ${uniq.size === 1 ? '✅ STICKY OK' : '🔴 IP SIĘ ZMIENIA — LUKA!'}\n`);
}
