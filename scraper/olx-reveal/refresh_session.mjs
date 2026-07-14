/** Auto-refresh sesji: otwiera sesję w przeglądarce, SDK odświeża token (rozwiązuje WAF), zapisuje z powrotem.
 *  HTTP refresh jest blokowany WAF-em, więc musi iść przez browser. Użycie: node refresh_session.mjs konto1 */
import { chromium } from 'patchright';
import fs from 'fs';
const ACC = process.argv[2] || 'konto1';
const F = `session_${ACC}.json`;
const HEADLESS = process.env.HEADLESS !== '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expOf = (state) => { for (const o of state.origins || []) for (const it of (o.localStorage || [])) if (/auth0spajs/i.test(it.name) && /default/i.test(it.name)) { try { return JSON.parse(it.value).expiresAt; } catch {} } return null; };

const state = JSON.parse(fs.readFileSync(F, 'utf8'));
const before = expOf(state);
const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
try {
  const ctx = await browser.newContext({ storageState: state, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await sleep(9000); // SDK odświeża token w tle
  const logged = await page.evaluate(() => Object.keys(localStorage).some((k) => /auth0spajs.*@@user@@/i.test(k))).catch(() => false);
  const ns = await ctx.storageState();
  const after = expOf(ns);
  if (logged) {
    fs.writeFileSync(F, JSON.stringify(ns));
    // sync do DB (leads.olx_sessions) — żeby baza była świeża, nie tylko lokalny plik (revealer czyta z DB)
    try {
      const env = fs.readFileSync(`${process.env.HOME}/Desktop/Audyteko/.env.local`, 'utf8');
      const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
      const U = get('NEXT_PUBLIC_SUPABASE_URL') || get('SUPABASE_URL'), K = get('SUPABASE_SERVICE_ROLE_KEY');
      if (U && K) await fetch(`${U}/rest/v1/rpc/leads_upsert_olx_session`, { method: 'POST', headers: { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_name: ACC, p_state: ns }) });
    } catch {}
  }
  const now = Math.floor(Date.now() / 1000);
  console.log(`[${ACC}] zalogowany=${logged} | exp przed=${before ? Math.round((before - now) / 60) + 'min' : '?'} → po=${after ? Math.round((after - now) / 60) + 'min' : '?'} | ${after > before ? '✅ ODŚWIEŻONE' : (logged ? 'bez zmiany' : '🔴 SESJA PADŁA')}`);
  await ctx.close();
} catch (e) { console.log(`[${ACC}] błąd: ${String(e.message).slice(0, 80)}`); } finally { await browser.close(); }
process.exit(0);
