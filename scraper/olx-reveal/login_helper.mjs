/** LOKALNY helper: otwiera Chrome z IZOLOWANYM trwałym profilem konta (NIE czyta Twojej przeglądarki),
 *  klika "Zaloguj się" (pokazuje formularz — Ty wpisujesz dane), czeka aż się zalogujesz, zapisuje sesję.
 *  Użycie: node login_helper.mjs konto1   (albo z panelu 8899) */
import { chromium } from 'patchright';
import fs from 'fs';
const ACC = process.argv[2] || 'konto1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// PEWNE wykrycie zalogowania: token użytkownika Auth0 w localStorage (jest tylko po realnym logowaniu)
const isLogged = (page) => page.evaluate(() => Object.keys(localStorage).some((k) => /auth0spajs.*@@user@@/i.test(k))).catch(() => false);

const ctx = await chromium.launchPersistentContext(`./profiles/${ACC}`, {
  headless: false, viewport: { width: 1400, height: 900 }, locale: 'pl-PL', timezoneId: 'Europe/Warsaw',
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await sleep(2000);

let logged = await isLogged(page);
if (!logged) {
  // zgoda cookies
  for (const s of ['#onetrust-accept-btn-handler', 'button:has-text("Akceptuję")', 'button:has-text("Zaakceptuj")']) {
    try { const b = page.locator(s).first(); if (await b.isVisible({ timeout: 800 })) { await b.click({ timeout: 1500 }); break; } } catch {}
  }
  await sleep(800);
  // otwórz FORMULARZ logowania (sam klik "Zaloguj się" — bez wpisywania danych, to robisz Ty)
  let opened = false;
  for (const s of ['[data-testid="header-login-button"]', 'a[data-testid="login-tab"]', 'a:has-text("Zaloguj się")', 'button:has-text("Zaloguj się")', 'a[href*="login.olx"]']) {
    try { const b = page.locator(s).first(); if (await b.isVisible({ timeout: 1500 })) { await b.click({ timeout: 2500 }); opened = true; break; } } catch {}
  }
  console.log(`\n[${ACC}] 👉 ${opened ? 'Formularz logowania otwarty.' : 'Kliknij "Zaloguj się" w oknie.'} Wpisz dane konta ${ACC} (login + hasło) i zaloguj się.`);
  console.log(`[${ACC}] Czekam aż wykryję zalogowanie (max 4 min)...`);
  for (let t = 0; t < 120 && !logged; t++) { await sleep(2000); logged = await isLogged(page); }
}
if (!logged) { console.log(`[${ACC}] nie wykryłem zalogowania — zamykam (spróbuj ponownie)`); await ctx.close(); process.exit(1); }

const state = await ctx.storageState();
fs.writeFileSync(`session_${ACC}.json`, JSON.stringify(state));
console.log(`✅ [${ACC}] ZALOGOWANY — sesja zapisana (session_${ACC}.json, ${state.cookies.length} cookies).`);
// wgraj też do DB (leads.olx_sessions) — żeby konto od razu weszło do rotacji reveala i panelu Audyteko
try {
  const env = fs.readFileSync(`${process.env.HOME}/Desktop/Audyteko/.env.local`, 'utf8');
  const get = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim().replace(/^["']|["']$/g, '');
  const URL = get('NEXT_PUBLIC_SUPABASE_URL') || get('SUPABASE_URL'), KEY = get('SUPABASE_SERVICE_ROLE_KEY');
  if (URL && KEY) {
    const r = await fetch(`${URL}/rest/v1/rpc/leads_upsert_olx_session`, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_name: ACC, p_state: state }) });
    console.log(r.ok ? `✅ [${ACC}] sesja wgrana do DB (rotacja + panel)` : `⚠️ [${ACC}] DB upload HTTP ${r.status}`);
  }
} catch (e) { console.log(`⚠️ [${ACC}] DB upload pominięty: ${String(e.message).slice(0, 60)}`); }
await ctx.close();
process.exit(0);
