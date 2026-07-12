/** Izolowany test proxy przez undici — 4 warianty auth. Znajdź który tuneluje (bez 504). */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
console.log('parse ok:', !!pm, '| host:', pm?.[3], '| port:', pm?.[4], '| user.len:', pm?.[1]?.length, '| pass.len:', pm?.[2]?.length, '| pass ma ":"?', pm?.[2]?.includes(':'));
const [, PU, PP, PH, PT] = pm;
const sid = () => crypto.randomBytes(5).toString('hex');

async function tryV(name, agent) {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { dispatcher: agent, signal: AbortSignal.timeout(25000) });
    const j = await r.json();
    console.log(`✅ ${name}  →  ip=${j.ip}`);
    return true;
  } catch (e) { console.log(`❌ ${name}  →  ${(e.cause?.code || e.cause?.message || e.message || String(e)).slice(0, 90)}`); return false; }
}

// wariant 1: creds w URI + sticky session (lifetime-30m jak collector)
await tryV('1 uri+session-30m ', new ProxyAgent(`http://${PU}:${PP}_session-${sid()}_lifetime-30m@${PH}:${PT}`));
// wariant 2: token(Proxy-Authorization) + sticky session
await tryV('2 token+session-30m', new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}_session-${sid()}_lifetime-30m`).toString('base64') }));
// wariant 3: creds w URI, BEZ session (rotujące)
await tryV('3 uri base         ', new ProxyAgent(`http://${PU}:${PP}@${PH}:${PT}`));
// wariant 4: token, BEZ session
await tryV('4 token base       ', new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}`).toString('base64') }));
// wariant 5: uri + session-5m (to co padło)
await tryV('5 uri+session-5m   ', new ProxyAgent(`http://${PU}:${PP}_session-${sid()}_lifetime-5m@${PH}:${PT}`));
console.log('koniec');
