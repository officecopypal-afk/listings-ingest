/** Który config IPRoyal daje NAJWIĘCEJ świeżych IP (spoza mojej listy 3457 spalonych)?
 *  Porównanie: sticky (obecny) vs randomize (bez session) vs geo-miasta vs krótki lifetime. */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const [, PU, PPraw, PH, PT] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const BASE = PPraw.split('_')[0]; // 16-znakowe hasło bez parametrów
const sid = () => crypto.randomBytes(5).toString('hex');
const agent = (pw) => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${pw}`).toString('base64') });
const ipOf = async (a) => { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(12000) }); return (await r.json()).ip; } catch { return null; } };
const cities = ['krakow', 'wroclaw', 'poznan', 'gdansk', 'lodz', 'szczecin', 'lublin', 'bydgoszcz', 'katowice', 'bialystok', 'gdynia', 'czestochowa', 'radom', 'torun', 'kielce', 'gliwice', 'zabrze', 'olsztyn', 'rzeszow', 'opole'];

// wczytaj listę spalonych
const rr = await fetch(`${SB_URL}/rest/v1/rpc/leads_ip_burned_recent`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_cooldown_hours: 12 }) });
const burned = new Set(await rr.json());
console.log(`lista spalonych (12h): ${burned.size} IP\n`);

const N = 20;
async function testConfig(name, pwFn) {
  const ips = [];
  for (let i = 0; i < N; i++) { const ip = await ipOf(agent(pwFn(i))); if (ip) ips.push(ip); await new Promise(r => setTimeout(r, 200)); }
  const uniq = new Set(ips);
  const fresh = ips.filter((ip) => !burned.has(ip)).length;
  const freshUniq = new Set(ips.filter((ip) => !burned.has(ip)));
  console.log(`${name.padEnd(26)} | ${ips.length}/${N} połączeń | unikalnych ${uniq.size} | ŚWIEŻYCH(spoza spalonych) ${fresh} | świeżych-unikalnych ${freshUniq.size}`);
}

await testConfig('sticky (obecny)', () => `${BASE}_country-pl_session-${sid()}_lifetime-10m`);
await testConfig('randomize (bez session)', () => `${BASE}_country-pl`);
await testConfig('sticky lifetime-1m', () => `${BASE}_country-pl_session-${sid()}_lifetime-1m`);
await testConfig('geo-miasta sticky', (i) => `${BASE}_country-pl_city-${cities[i % cities.length]}_session-${sid()}_lifetime-10m`);
console.log('\n>>> config z NAJWIĘCEJ „świeżych-unikalnych" wygrywa → tym rebuilduję workera.');
