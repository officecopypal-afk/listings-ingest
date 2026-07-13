/** LOKALNY test (odpal na Macu, Twój czysty IP): 1 reveal HTTP z zalogowaną sesją.
 *  Rozstrzyga: czy "blank" był od spalonego IPRoyala, czy HTTP w ogóle nie umie.
 *  Użycie: node session_http_local.mjs */
import crypto from 'crypto';
import fs from 'fs';
const S = JSON.parse(fs.readFileSync('session_konto1.json', 'utf8'));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decodeAd = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const FP = crypto.randomBytes(392).toString('hex');
const cookieHeader = (S.cookies || []).filter(c => /olx/i.test(c.domain)).map(c => `${c.name}=${c.value}`).join('; ');

// wyciągnij access_token z cache Auth0 (JSON: {body:{access_token,...}})
let accessToken = null;
for (const o of S.origins || []) for (const it of (o.localStorage || [])) {
  if (/auth0spajs/i.test(it.name)) { try { const j = JSON.parse(it.value); if (j?.body?.access_token) accessToken = j.body.access_token; } catch {} }
}
console.log('access_token:', accessToken ? accessToken.slice(0, 18) + '...(' + accessToken.length + ')' : 'BRAK', '| cookies olx:', (S.cookies || []).filter(c => /olx/i.test(c.domain)).length);

const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json', cookie: cookieHeader };
async function reveal(adId) {
  const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
  const chj = await ch.json().catch(() => null);
  if (chj?.challenge) return 'CHALLENGE:' + chj.challenge.type + ' (challenge nie przeszedł)';
  if (!chj?.context) return 'brak-context';
  const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
  const exj = await ex.json().catch(() => null);
  if (!exj?.token) return 'brak-friction-token';
  const h = { 'friction-token': exj.token, 'x-fingerprint': FP, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', cookie: cookieHeader };
  if (accessToken) h.authorization = 'Bearer ' + accessToken;
  const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { signal: AbortSignal.timeout(15000), headers: h });
  const b = await lp.text(); let j = null; try { j = JSON.parse(b); } catch {}
  if (j?.data?.phones?.[0]) return '✅✅✅ NUMER: ' + j.data.phones[0] + '  → HTTP-Z-SESJĄ DZIAŁA!';
  return `HTTP ${lp.status}: ${(j?.error?.detail || b).slice(0, 70)}`;
}

const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=15&category_id=14&sort_by=created_at%3Adesc', { headers: { 'user-agent': UA, accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
const off = ((await lr.json())?.data || []).find(o => o.business === false && o.contact?.phone === true);
console.log('\nreveal na ad', decodeAd(off.url.split('?')[0]), ':');
console.log(' ', await reveal(decodeAd(off.url.split('?')[0])));
