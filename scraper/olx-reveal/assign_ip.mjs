/** Przypisanie/odświeżenie IP kont POZA runem — sprawdza IP przez proxy (ipify) i zapisuje do DB (leads_olx_ip_seen).
 *  Można odpalać KIEDYKOLWIEK, też w trakcie runu reveala (nie koliduje). Naprawia konta bez IP (np. świeżo dodane).
 *  Env: IPROYAL_PROXY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Użycie: node assign_ip.mjs [konto13 konto14 ...]  (bez arg = wszystkie z DB) */
import crypto from 'crypto';
import { ProxyAgent } from 'undici';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const LIFETIME = process.env.PROXY_LIFETIME || '24h';
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const keyFor = (acc) => crypto.createHash('md5').update(acc).digest('hex').slice(0, 8);
const passFor = (key) => `${pm[2]}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const ipVia = async (key) => { try { const a = new ProxyAgent(`http://${pm[1]}:${passFor(key)}@${pm[3]}:${pm[4]}`); const r = await fetch('https://api.ipify.org?format=json', { dispatcher: a, signal: AbortSignal.timeout(20000) }); return (await r.json()).ip; } catch { return null; } };
async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }

const arg = process.argv.slice(2);
const accs = arg.length ? arg : Object.keys(await rpc('leads_get_olx_sessions').catch(() => ({})));
console.log(`przypisuję IP dla: ${accs.join(', ') || 'BRAK'}`);
for (const acc of accs) {
  // 2 próby — gdyby proxy chwilowo nie odpowiedziało (nie znaczy że IP martwe na stałe)
  let ip = await ipVia(keyFor(acc));
  if (!ip) { await new Promise((r) => setTimeout(r, 3000)); ip = await ipVia(keyFor(acc)); }
  if (ip) { try { await rpc('leads_olx_ip_seen', { p_name: acc, p_ip: ip }); } catch {} console.log(`✅ ${acc} → ${ip}`); }
  else console.log(`⚠️ ${acc} → proxy nie zwrócił IP (2 próby) — możliwy martwy IP tej sesji`);
}
console.log('gotowe');
process.exit(0);
