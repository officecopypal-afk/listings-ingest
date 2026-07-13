// Dokładnie CO OLX zwraca na krajach lekko tkniętych (UA/RO) — surowe odpowiedzi + rate-limit headers.
import { ProxyAgent } from 'undici';
import crypto from 'crypto';
const PROXY = process.env.IPROYAL_PROXY;
const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
const [, PU, PP, PH, PT] = pm;
const swap = (pp, c) => /_country-[a-z]{2}/i.test(pp) ? pp.replace(/_country-[a-z]{2}/i, `_country-${c}`) : `${pp}_country-${c}`;
const agentFor = (c) => new ProxyAgent({ uri: `http://${PH}:${PT}`, token: 'Basic ' + Buffer.from(`${PU}:${swap(PP, c)}_session-${crypto.randomBytes(6).toString('hex')}_lifetime-10m`).toString('base64') });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const decodeAd = (u) => { const m = u.match(/-ID([0-9A-Za-z]+)\.html/i); if (!m) return null; let n = 0n; for (const c of m[1]) n = n * 62n + BigInt(ALPHA.indexOf(c)); return n.toString(); };
const FH = { 'content-type': 'application/json', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/', 'user-agent': UA, accept: 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fullReveal(adId, d, tag) {
  const fp = crypto.randomBytes(392).toString('hex');
  const ch = await fetch('https://friction.olxgroup.com/challenge', { method: 'POST', headers: FH, dispatcher: d, signal: AbortSignal.timeout(15000), body: JSON.stringify({ action: 'reveal_phone_number', aud: 'atlas', actor: { username: crypto.randomUUID() }, scene: { origin: 'www.olx.pl', sitecode: 'olxpl', ad_id: String(adId) } }) }).catch(e => ({ err: e }));
  if (ch.err) { console.log(`${tag} CHALLENGE neterr: ${ch.err.cause?.code || ch.err.name}`); return; }
  const chBody = await ch.text(); let chj; try { chj = JSON.parse(chBody); } catch {}
  if (chj?.challenge) { console.log(`${tag} CHALLENGE typ=${chj.challenge.type} → ${JSON.stringify(chj.challenge.config || {})}`); return; }
  if (!chj?.context) { console.log(`${tag} CHALLENGE http=${ch.status} bez-context: ${chBody.slice(0, 120)}`); return; }
  const ex = await fetch('https://friction.olxgroup.com/exchange', { method: 'POST', headers: FH, dispatcher: d, signal: AbortSignal.timeout(15000), body: JSON.stringify({ context: chj.context }) });
  const exj = await ex.json().catch(() => null);
  if (!exj?.token) { console.log(`${tag} EXCHANGE http=${ex.status} bez-token`); return; }
  const lp = await fetch('https://www.olx.pl/api/v1/offers/' + adId + '/limited-phones/', { dispatcher: d, signal: AbortSignal.timeout(15000), headers: { 'friction-token': exj.token, 'x-fingerprint': fp, 'x-device-id': crypto.randomUUID(), 'x-client': 'DESKTOP', 'x-platform-type': 'mobile-html5', version: 'v1.19', accept: 'application/json', 'accept-language': 'pl', 'user-agent': UA, origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/' } });
  const lpBody = await lp.text();
  const rl = ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'ratelimit-remaining', 'ratelimit-limit'].map(h => lp.headers.get(h) ? `${h}=${lp.headers.get(h)}` : null).filter(Boolean).join(' ');
  console.log(`${tag} LIMITED-PHONES http=${lp.status}${rl ? ' [' + rl + ']' : ''} → ${lpBody.slice(0, 130)}`);
}

const r = await fetch('https://www.olx.pl/api/v1/offers/?offset=0&limit=20&category_id=14&sort_by=created_at%3Adesc', { headers: FH });
const ads = ((await r.json())?.data || []).filter(o => o.business === false).map(o => decodeAd(o.url.split('?')[0])).filter(Boolean);

for (const c of ['ua', 'ro', 'pl']) {
  console.log(`\n===== ${c.toUpperCase()} =====`);
  for (let i = 0; i < 6; i++) { const a = agentFor(c); await fullReveal(ads[i % ads.length], a, `[${c}#${i}]`); a.close?.().catch(() => {}); await sleep(1200); }
}
