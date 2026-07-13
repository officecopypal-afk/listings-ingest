/** Wgrywa lokalne session_konto*.json do Supabase (leads.olx_sessions) — DB = źródło prawdy dla Track 2.
 *  Creds z ~/Desktop/Audyteko/.env.local. Użycie: node upload_sessions.mjs [konto1 konto2 ...] (bez arg = wszystkie) */
import fs from 'fs';
import os from 'os';

const env = fs.readFileSync(`${os.homedir()}/Desktop/Audyteko/.env.local`, 'utf8');
const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
const URL = get('NEXT_PUBLIC_SUPABASE_URL');
const KEY = get('SUPABASE_SERVICE_ROLE_KEY');
if (!URL || !KEY) { console.error('brak creds w .env.local'); process.exit(1); }

const only = process.argv.slice(2);
const accs = (only.length ? only : Array.from({ length: 12 }, (_, i) => `konto${i + 1}`)).filter((a) => fs.existsSync(`session_${a}.json`));

for (const a of accs) {
  const state = JSON.parse(fs.readFileSync(`session_${a}.json`, 'utf8'));
  const r = await fetch(`${URL}/rest/v1/rpc/leads_upsert_olx_session`, {
    method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_name: a, p_state: state }),
  });
  console.log(`${r.ok ? '✅' : '❌ ' + r.status} ${a} (${state.cookies.length} cookies)`);
}
console.log('gotowe');
