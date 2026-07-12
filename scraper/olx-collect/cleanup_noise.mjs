/**
 * CZYSZCZENIE: weryfikuje zaległe listingi (z kolektora-przeglądarki/xlsx) po kategorii OLX.
 * Kat 14/15/18 + prywatny → 're_ok' (zostaje w kolejce). Inna kat / firmowy → 'noise' (poza kolejką).
 * Usunięte (404) → 'inactive'. Bez zwiększania reveal_attempts. Resumowalne (znaczy status).
 *
 * Env: IPROYAL_PROXY(opcj), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';

const PROXY = process.env.IPROYAL_PROXY;
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const RE_CATS = new Set([14, 15, 18]);
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decode = (url) => { const m = url.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) { const i = ALPHA.indexOf(c); if (i < 0) return null; n = n * 62n + BigInt(i); } return n.toString(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let agent, reqOnAgent = 0;
const rotate = () => { if (PROXY) { const m = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/); agent = new ProxyAgent({ uri: `http://${m[3]}:${m[4]}`, token: 'Basic ' + Buffer.from(`${m[1]}:${m[2]}_session-${crypto.randomBytes(5).toString('hex')}_lifetime-10m`).toString('base64') }); } reqOnAgent = 0; };
rotate();
const apiH = { 'user-agent': UA, accept: 'application/json', 'accept-language': 'pl', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' };

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const t = await r.text(); if (!r.ok) throw new Error(`${fn} ${r.status}: ${t.slice(0, 120)}`); return t ? JSON.parse(t) : null;
}

// zwraca status do ustawienia dla jednego listingu
async function classify(row) {
  const num = decode(row.url);
  if (!num) return 'noise'; // nie-oferta
  try {
    if (++reqOnAgent > 120) rotate();
    const r = await fetch('https://www.olx.pl/api/v1/offers/' + num + '/', { headers: apiH, dispatcher: agent, signal: AbortSignal.timeout(20000) });
    if (r.status === 404 || r.status === 410) return 'inactive';
    if (!r.ok) return null; // przejściowy błąd — nie znacz, sprawdzimy później
    const o = (await r.json())?.data;
    if (!o) return 'inactive';
    if (o.business === true) return 'noise';               // firmowy — nie nasz target
    if (!RE_CATS.has(o.category?.id)) return 'noise';       // nie nieruchomość (śmieć z full-text)
    return 're_ok';                                        // prawdziwa prywatna nieruchomość
  } catch { return null; }                                  // sieć — pomiń w tej turze
}

const stat = { re_ok: 0, noise: 0, inactive: 0, err: 0, checked: 0 };
const CONC = 6;
let round = 0;
while (true) {
  const rows = await rpc('leads_get_unverified', { p_limit: 300 });
  if (!rows || !rows.length) break;
  round++;
  for (let i = 0; i < rows.length; i += CONC) {
    const batch = rows.slice(i, i + CONC);
    const results = await Promise.all(batch.map((row) => classify(row).then((s) => ({ row, s }))));
    for (const { row, s } of results) {
      stat.checked++;
      if (!s) { stat.err++; continue; }               // przejściowy — zostaje null, następny run sprawdzi
      stat[s]++;
      await rpc('leads_set_reveal_status', { p_id: row.id, p_status: s }).catch(() => {});
    }
    await sleep(150);
  }
  console.log(`runda ${round}: sprawdzono ${stat.checked} | ✅ re_ok ${stat.re_ok} | 🗑 noise ${stat.noise} | ⊘ inactive ${stat.inactive} | err ${stat.err}`);
  if (round > 20) break; // bezpiecznik
}
console.log(`\n=== KONIEC === sprawdzono ${stat.checked} | nieruchomości ${stat.re_ok} | ŚMIECI ${stat.noise} | usunięte ${stat.inactive} | błędy(do ponowienia) ${stat.err}`);
process.exit(0);
