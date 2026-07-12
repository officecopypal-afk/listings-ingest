/** Czy port 51250 daje ŚWIEŻE IP (spoza naszej listy spalonych)? Bez OLX — tylko ipify + czarna lista. */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const [, PU, PPraw, PH] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const BASE = PPraw.split('_')[0];
const sid = () => crypto.randomBytes(5).toString('hex');
const agent = (port, pw) => new ProxyAgent({ uri: `http://${PH}:${port}`, token: 'Basic ' + Buffer.from(`${PU}:${pw}`).toString('base64') });
const ipOf = async (a) => { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(12000) }); return (await r.json()).ip; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rr = await fetch(`${SB_URL}/rest/v1/rpc/leads_ip_burned_recent`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_cooldown_hours: 12 }) });
const burned = new Set(await rr.json());
console.log(`czarna lista (12h): ${burned.size} IP\n`);

const N = 30;
async function test(name, port, pwFn) {
  const ips = [];
  for (let i = 0; i < N; i++) { const ip = await ipOf(agent(port, pwFn())); if (ip) ips.push(ip); await sleep(150); }
  const uniq = new Set(ips);
  const fresh = ips.filter((ip) => !burned.has(ip));
  const freshUniq = new Set(fresh);
  console.log(`${name.padEnd(30)} | ${ips.length}/${N} poł. | unik ${uniq.size} | ŚWIEŻYCH ${fresh.length} | świeżych-unik ${freshUniq.size} (${Math.round(100 * freshUniq.size / Math.max(1, ips.length))}%)`);
}
await test('port 12321 sticky (obecny)', 12321, () => `${BASE}_country-pl_session-${sid()}_lifetime-10m`);
await test('port 51250 sticky', 51250, () => `${BASE}_country-pl_session-${sid()}_lifetime-10m`);
await test('port 51250 bez session', 51250, () => `${BASE}_country-pl`);
console.log('\n>>> jeśli 51250 ma znacząco więcej „świeżych-unik" niż 12321 → przełączam workera na 51250.');
