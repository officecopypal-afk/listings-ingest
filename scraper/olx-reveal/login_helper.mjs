/** LOKALNY helper (odpal na Macu): zaloguj się RĘCZNIE, złap sesję + sprawdź reveal zalogowanego.
 *  Użycie:  node login_helper.mjs konto1
 *  Zapisuje session_<konto>.json (NIE commituj — to token). */
import { chromium } from 'patchright';
import readline from 'readline';
import fs from 'fs';

const ACC = process.argv[2] || 'konto1';
const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw', viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

// podsłuch flow reveala — TYLKO nazwy nagłówków auth (bez wartości, żeby token nie wyciekł)
const revealFlow = [];
page.on('request', (r) => {
  const u = r.url();
  if (/friction\.olxgroup|limited-phones/i.test(u)) {
    const h = r.headers();
    const authKeys = Object.keys(h).filter(k => /auth|cookie|token|fingerprint|bearer/i.test(k));
    revealFlow.push(`${r.method()} ${u.replace(/https?:\/\//, '').split('?')[0].slice(0, 48)} | auth-nagłówki: ${authKeys.join(', ') || 'BRAK'}`);
  }
});
page.on('response', async (r) => { if (/limited-phones/i.test(r.url())) { let b = ''; try { b = await r.text(); } catch {} console.log(`  >>> limited-phones: HTTP ${r.status()} ${b.slice(0, 90)}`); } });

await page.goto('https://www.olx.pl/', { waitUntil: 'domcontentloaded' }).catch(() => {});
console.log('\n════════════════ ZALOGUJ SIĘ ════════════════');
console.log('W otwartym oknie: kliknij "Zaloguj się", wpisz dane, rozwiąż captchę jeśli jest.');
console.log('Jak będziesz ZALOGOWANY (widzisz swoje konto) → wróć tu i naciśnij ENTER.\n');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((res) => rl.question('ENTER gdy zalogowany... ', () => res()));

// zapisz sesję
const state = await ctx.storageState();
fs.writeFileSync(`session_${ACC}.json`, JSON.stringify(state));
const olxCookies = state.cookies.filter(c => /olx/i.test(c.domain));
console.log(`\n✅ Sesja zapisana: session_${ACC}.json  (${state.cookies.length} cookies, ${olxCookies.length} olx)`);

// TEST: reveal na zalogowanej sesji
console.log('\nTestuję reveal (zalogowany)...');
try {
  const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=15&category_id=14&sort_by=created_at%3Adesc', { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
  const off = ((await lr.json())?.data || []).find(o => o.business === false && o.contact?.phone === true);
  await page.goto(off.url.split('?')[0], { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 3000));
  const btns = page.locator('[data-testid="show-phone"]'); const n = await btns.count();
  for (let i = 0; i < n; i++) { const x = btns.nth(i); if (await x.isVisible().catch(() => false)) { await x.scrollIntoViewIfNeeded().catch(() => {}); await x.click({ timeout: 3000 }).catch(() => {}); break; } }
  await new Promise((r) => setTimeout(r, 6000));
  const cont = await page.locator('[data-testid="phones-container"]').first().innerText().catch(() => '');
  console.log('\n════════════════ WYNIK ════════════════');
  console.log('  numer po kliknięciu:', cont.replace(/\s+/g, ' ').slice(0, 50), (/\d{3}/.test(cont) && !/xxx/i.test(cont)) ? '  ✅ DZIAŁA (zalogowany widzi numer)' : '  (nadal zamaskowany?)');
  console.log('  jak działa auth reveala:'); revealFlow.forEach((l) => console.log('    ' + l));
} catch (e) { console.log('  błąd testu:', e.message.slice(0, 80)); }

console.log(`\n👉 Jak numer się pokazał → login odblokowuje reveal. Wgraj CAŁĄ zawartość session_${ACC}.json do sekretu GitHub "OLX_SESSION" i napisz mi — zbuduję szybki reveal HTTP na tej sesji.`);
rl.close();
await browser.close();
