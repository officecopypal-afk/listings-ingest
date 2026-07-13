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
  if (logged) { fs.writeFileSync(F, JSON.stringify(ns)); }
  const now = Math.floor(Date.now() / 1000);
  console.log(`[${ACC}] zalogowany=${logged} | exp przed=${before ? Math.round((before - now) / 60) + 'min' : '?'} → po=${after ? Math.round((after - now) / 60) + 'min' : '?'} | ${after > before ? '✅ ODŚWIEŻONE' : (logged ? 'bez zmiany' : '🔴 SESJA PADŁA')}`);
  await ctx.close();
} catch (e) { console.log(`[${ACC}] błąd: ${String(e.message).slice(0, 80)}`); } finally { await browser.close(); }
process.exit(0);
