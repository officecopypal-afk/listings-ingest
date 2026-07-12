/** Test geo-targetingu IPRoyal: czy celowanie w miasta PL działa i daje RÓŻNORODNE świeże IP. */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const [, PU, PP, PH, PT] = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const sid = () => crypto.randomBytes(5).toString('hex');
const agent = (suf) => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${PP}${suf}`).toString('base64') });
async function getIp(a) { try { const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(15000) }); return (await r.json()).ip; } catch (e) { return 'ERR:' + String(e.cause?.code || e.message).slice(0, 25); } }
const sub16 = (ip) => ip.startsWith('ERR') ? ip : ip.split('.').slice(0, 2).join('.');

console.log('=== SKŁADNIA (który wariant zwraca poprawny IP) ===');
const variants = {
  'baza _session': `_session-${sid()}_lifetime-5m`,
  '_country-pl': `_country-pl_session-${sid()}_lifetime-5m`,
  '_country-pl_city-warszawa': `_country-pl_city-warszawa_session-${sid()}_lifetime-5m`,
  '_country-pl_city-krakow': `_country-pl_city-krakow_session-${sid()}_lifetime-5m`,
  '_country-pl_state-mazowieckie': `_country-pl_state-mazowieckie_session-${sid()}_lifetime-5m`,
  '_city-warszawa (bez country)': `_city-warszawa_session-${sid()}_lifetime-5m`,
};
for (const [name, suf] of Object.entries(variants)) console.log('  ' + name.padEnd(34), '→', await getIp(agent(suf)));

const cities = ['warszawa', 'krakow', 'wroclaw', 'poznan', 'gdansk', 'lodz', 'szczecin', 'lublin', 'bydgoszcz', 'katowice', 'bialystok', 'gdynia'];
console.log('\n=== RÓŻNORODNOŚĆ: 12 miast (geo) ===');
const geo = new Set();
for (const c of cities) { const ip = await getIp(agent(`_country-pl_city-${c}_session-${sid()}_lifetime-5m`)); if (!ip.startsWith('ERR')) geo.add(sub16(ip)); console.log('  ' + c.padEnd(11), ip); }
console.log('  >>> unikalnych /16 podsieci:', geo.size, '/', cities.length);

console.log('\n=== RÓŻNORODNOŚĆ: 12 bez geo (dla porównania) ===');
const base = new Set();
for (let i = 0; i < 12; i++) { const ip = await getIp(agent(`_session-${sid()}_lifetime-5m`)); if (!ip.startsWith('ERR')) base.add(sub16(ip)); process.stdout.write('  ' + ip); }
console.log('\n  >>> unikalnych /16 podsieci:', base.size, '/ 12');
console.log('\nWNIOSEK: jeśli geo daje >= tyle co baza i różne podsiecie → wpinam rotację miast do workera.');
