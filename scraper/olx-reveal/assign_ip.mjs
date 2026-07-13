/** Przypisanie/odświeżenie IP kont POZA runem — szuka ŻYWEGO IP przez proxy (ipify) i zapisuje do DB.
 *  Jak domyślny sticky-IP konta jest martwy → próbuje kolejne salty (md5(konto:salt)) aż znajdzie żywy i zapisuje salt.
 *  Ten sam salt czyta revealer → konto dostaje NOWY STAŁY (żywy) IP. Można odpalać kiedykolwiek, też w trakcie runu.
 *  Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Użycie: node assign_ip.mjs [konto13 konto15 ...] (bez arg = wszystkie) */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const LIFETIME = process.env.PROXY_LIFETIME || '24h';
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (acc, salt) => crypto.createHash('md5').update(salt ? `${acc}:${salt}` : acc).digest('hex').slice(0, 8);
const passFor = (key) => `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const ipVia = async (key) => { try { const a = new ProxyAgent(`http://${pm[1]}:${passFor(key)}@${pm[3]}:${pm[4]}`); const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(20000) }); return (await r.json()).ip; } catch { return null; } };
async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }

const arg = process.argv.slice(2);
const accs = arg.length ? arg : Object.keys(await rpc('leads_get_olx_sessions').catch(() => ({})));
const saltMap = {};
try { for (const r of (await rpc('leads_get_ip_salts').catch(() => []))) saltMap[r.name] = r.salt; } catch {}
console.log(`przypisuję IP dla: ${accs.join(', ') || 'BRAK'}`);
for (const acc of accs) {
  const base = saltMap[acc] || 0;
  let found = null;
  for (let salt = base; salt < base + 8; salt++) {           // od obecnego salta w górę, aż żywy IP
    let ip = await ipVia(keyFor(acc, salt));
    if (!ip) { await sleep(2000); ip = await ipVia(keyFor(acc, salt)); } // 2. próba (chwilowy brak ≠ martwy)
    if (ip) { found = { salt, ip }; break; }
    console.log(`  ${acc} salt=${salt} → martwy IP, próbuję kolejny`);
  }
  if (found) {
    try {
      if (found.salt !== base) await rpc('leads_set_ip_salt', { p_name: acc, p_salt: found.salt, p_ip: found.ip });
      else await rpc('leads_olx_ip_seen', { p_name: acc, p_ip: found.ip });
    } catch {}
    console.log(`✅ ${acc} salt=${found.salt} → ${found.ip}${found.salt !== base ? ' (wymieniony martwy IP)' : ''}`);
  } else console.log(`⚠️ ${acc} → brak żywego IP w 8 próbach`);
}
console.log('gotowe');
process.exit(0);
