/**
 * OLX MOBILE KEEP-ALIVE — trzyma konta ŻYWE bez skanowania.
 * Tylko odświeża token (grant=refresh_token, przez proxy konta) — zero reveali, zero ryzyka limitu.
 * Robi to co apka co 20 min; tu 2×/dobę wystarcza, żeby refresh_token nie wygasł z bezczynności.
 * Alert Slack jeśli któryś refresh_token PADŁ (wtedy dopiero potrzebny re-login).
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PROXY_USER, PROXY_PASS, PROXY_PORT
 */
import { fetch, ProxyAgent } from 'undici';

const CLIENT_ID = '2tmi4nl6rt49qtvippambh0kej';
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY_USER = (process.env.PROXY_USER || '').trim();
const PROXY_PASS = (process.env.PROXY_PASS || '').trim();
const PROXY_PORT = (process.env.PROXY_PORT || '12323').trim();

async function rpc(fn, body) { const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}`); return t ? JSON.parse(t) : null; }
async function slack(text) { try { await fetch(`${SB_URL}/functions/v1/scraper-alert`, { method: 'POST', headers: { authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch {} }

const ptoken = 'Basic ' + Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64');
const agentFor = (ip) => new ProxyAgent({ uri: `http://${ip}:${PROXY_PORT}`, token: ptoken });

const rows = await rpc('leads_get_mobile_tokens', {});
let ok = 0, dead = 0, neterr = 0;
for (const a of rows || []) {
  try {
    const r = await fetch('https://login.olx.pl/oauth2/token', { method: 'POST', dispatcher: agentFor(a.ip), headers: { 'content-type': 'application/json', 'user-agent': 'OLX.pl/883 CFNetwork/3860.600.12 Darwin/25.5.0', accept: '*/*' }, body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: CLIENT_ID }), signal: AbortSignal.timeout(25000) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 200 && j.access_token) {
      if (j.refresh_token && j.refresh_token !== a.refresh_token) await rpc('leads_set_mobile_token_value', { p_label: a.label, p_refresh_token: j.refresh_token }).catch(() => {});
      await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'ok' }).catch(() => {});
      ok++; console.log(`  [${a.label}] ✅ żywy (${a.ip})`);
    } else if (String(j.error) === 'invalid_grant') {
      await rpc('leads_set_mobile_status', { p_label: a.label, p_status: 'dead' }).catch(() => {});
      dead++; console.log(`  [${a.label}] 🔴 refresh_token PADŁ`);
      await slack(`🔴 OLX mobile keep-alive: konto ${a.label} — refresh_token wygasł, potrzebny re-login (przycisk w panelu)`);
    } else { neterr++; console.log(`  [${a.label}] ⚠ ${r.status} ${j.error || ''}`); }
  } catch (e) { neterr++; console.log(`  [${a.label}] ⚠ ${String(e.message).slice(0, 40)}`); }
}
console.log(`=== keep-alive: żywe ${ok}, padłe ${dead}, błędy ${neterr} ===`);
if (dead > 0 || (neterr >= (rows || []).length && rows?.length)) process.exit(1);
