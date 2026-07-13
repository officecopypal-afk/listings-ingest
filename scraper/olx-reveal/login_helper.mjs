/** LOKALNY helper: otwiera Chrome z TRWAŁYM profilem konta, czeka aż się zalogujesz (auto-wykrycie),
 *  zapisuje sesję. Hasło wpisujesz/zapisujesz w Chrome (menedżer haseł), nie w kodzie.
 *  Użycie: node login_helper.mjs konto1   (albo odpalany z panelu na 8899) */
import { chromium } from 'patchright';
import fs from 'fs';
const ACC = process.argv[2] || 'konto1';
const LOGGED = '[data-testid="my-account-menu"], [data-testid="header-user-menu"], a[href*="/mojolx"], a[href*="/konto"], [data-testid="user-menu"]';

const ctx = await chromium.launchPersistentContext(`./profiles/${ACC}`, {
  headless: false, viewport: { width: 1400, height: 900 }, locale: 'pl-PL', timezoneId: 'Europe/Warsaw',
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded' }).catch(() => {});

// jak profil już zalogowany — od razu zapisz i zamknij
let logged = await page.locator(LOGGED).first().isVisible({ timeout: 2500 }).catch(() => false);
if (!logged) {
  console.log(`\n[${ACC}] Zaloguj się w oknie (Chrome podpowie/zapisze hasło). Czekam max 4 min...`);
  for (let t = 0; t < 120 && !logged; t++) { await new Promise((r) => setTimeout(r, 2000)); logged = await page.locator(LOGGED).first().isVisible({ timeout: 500 }).catch(() => false); }
}
if (!logged) { console.log(`[${ACC}] nie wykryłem zalogowania — zamykam (spróbuj ponownie)`); await ctx.close(); process.exit(1); }

const state = await ctx.storageState();
fs.writeFileSync(`session_${ACC}.json`, JSON.stringify(state));
console.log(`✅ [${ACC}] ZALOGOWANY — sesja zapisana (session_${ACC}.json, ${state.cookies.length} cookies). Profil trwały: profiles/${ACC}`);
await ctx.close();
process.exit(0);
