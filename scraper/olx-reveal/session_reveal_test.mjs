/** Test: reveal HTTP z zalogowaną sesją (OLX_SESSION). Czy authorization+cookie przebija "blank"? */
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const SESSION = JSON.parse(process.env.OLX_SESSION);
const FP = JSON.parse(process.env.OLX_FP || '{"x_fingerprint":""}');
const PROXY = process.env.IPROYAL_PROXY;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decodeAd = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };

// proxy PL sticky (żeby IP pasowało do regionu logowania)
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const dispatcher = new ProxyAgent({ uri: `http://${pm[3]}:${pm[4]}`, token: 'Basic ' + Buffer.from(`${pm[1]}:${pm[2]}_country-pl_session-${crypto.randomBytes(5).toString('hex')}_lifetime-10m`).toString('base64') });

const cookieHeader = (SESSION.cookies || []).filter(c => /olx/i.test(c.domain)).map(c => `${c.name}=${c.value}`).join('; ');
// znajdź JWT (access token) w cookies / localStorage / zagnieżdżonych JSON-ach
function findTokens(state) {
  const out = []; const jwt = /ey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  for (const c of state.cookies || []) { const m = (c.value || '').match(jwt); if (m) out.push(['cookie:' + c.name, m[0]]); }
  for (const o of state.origins || []) for (const it of (o.localStorage || [])) { const m = (it.value || '').match(jwt); if (m) m.forEach((t, i) => out.push([`ls:${it.name}${i ? '#' + i : ''}`, t])); }
  return [...new Map(out.map(x => [x[1], x])).values()]; // dedup po wartości
}
const tokens = findTokens(SESSION);
console.log(`cookies olx: ${(SESSION.cookies || []).filter(c => /olx/i.test(c.domain)).length} | kandydaci-token: ${tokens.map(t => t[0]).join(', ') || 'BRAK'}`);

const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json', cookie: cookieHeader };
async function reveal(adId, bearer) {
  const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) });
  const chj = await ch.json().catch(() => null);
  if (chj?.challenge) return 'CHALLENGE:' + chj.challenge.type;
  if (!chj?.context) return 'brak-context';
  const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
  const exj = await ex.json().catch(() => null);
  if (!exj?.token) return 'brak-friction-token';
  const h = { 'friction-token': exj.token, 'x-fingerprint': FP.x_fingerprint || crypto.randomBytes(392).toString('hex'), 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', cookie: cookieHeader };
  if (bearer) h.authorization = 'Bearer ' + bearer;
  const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher, signal: AbortSignal.timeout(15000), headers: h });
  const b = await lp.text(); let j = null; try { j = JSON.parse(b); } catch {}
  if (j?.data?.phones?.[0]) return '✅ NUMER: ' + j.data.phones[0];
  return `HTTP ${lp.status}: ${(j?.error?.detail || b).slice(0, 60)}`;
}

const lr = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=15&category_id=14&sort_by=created_at%3Adesc', { headers: { 'user-agent': UA, accept: 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
const off = ((await lr.json())?.data || []).find(o => o.business === false && o.contact?.phone === true);
const adId = decodeAd(off.url.split('?')[0]);
console.log(`\ntest na ad ${adId}:`);
console.log('  bez tokenu (samo cookie):', await reveal(adId, null));
for (const [name, tok] of tokens) console.log(`  z tokenem [${name}]:`, await reveal(adId, tok));
