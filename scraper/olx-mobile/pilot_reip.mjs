/**
 * PILOT re-IP kont mobilnych (31.07-03.08.2026 — CloudFront zablokował 28 stałych IP).
 *
 * Dla każdego wskazanego konta bierze ŚWIEŻY exit ze STICKY SESJI IPRoyal (ta sama pula,
 * na której jedzie hybryda i która przechodzi CloudFront) i sprawdza po kolei:
 *   1. czy proxy w ogóle odpowiada (ipify)
 *   2. czy nowy adres przechodzi CloudFront (publiczny endpoint, bez konta)
 *   3. czy token konta odświeża się przez ten adres
 *   4. czy REALNY reveal wraca z numerem
 *
 * Zapis do bazy TYLKO przy APPLY=1 i TYLKO dla kont, które przeszły wszystkie 4 kroki.
 * Bez APPLY nie dotyka niczego — czysta diagnostyka.
 *
 * Uwaga: rotujący gateway wymaga, żeby to ON był hostem proxy, więc przy zapisie do kolumny
 * `ip` ląduje adres gatewaya, a nie exit. Realny exit jest w logu. Jeśli pilot wypali,
 * właściwym krokiem jest rozdzielenie w silniku `proxy_host` (połączenie) od `ip` (podgląd).
 */
import { fetch, ProxyAgent } from 'undici';
import crypto from 'crypto';

const CLIENT_ID = '2tmi4nl6rt49qtvippambh0kej';
const SB_URL = (process.env.SUPABASE_URL || '').trim();
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PROXY = (process.env.IPROYAL_PROXY || '').trim();
const LIFETIME = process.env.PROXY_LIFETIME || '24h';
const APPLY = process.env.APPLY === '1';

const pm = PROXY.match(/^https?:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
if (!pm) { console.error('IPROYAL_PROXY w złym formacie'); process.exit(1); }
const [, PUSER, PPASS, PHOST, PPORT] = pm;

// NO_PROXY=1 → jedziemy z IP runnera (ścieżka, którą kolektor przechodzi CloudFront).
// UWAGA: konto pokazuje się wtedy z adresu datacenter — testujemy na JEDNYM koncie.
const NO_PROXY = process.env.NO_PROXY === '1';
const passFor = (key) => `${PPASS}_country-pl_session-${key}_lifetime-${LIFETIME}`;
const agentFor = (key) => (NO_PROXY ? undefined : new ProxyAgent(`http://${PUSER}:${passFor(key)}@${PHOST}:${PPORT}`));

async function rpc(fn, body) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${fn} ${r.status} ${t.slice(0, 120)}`);
  return t ? JSON.parse(t) : null;
}

const DEVICES = [
  { ios: '26.4.1', app: '4.149.0' }, { ios: '26.5.1', app: '4.150.0' }, { ios: '26.5.2', app: '4.150.0' },
  { ios: '26.6', app: '4.150.0' }, { ios: '26.5.2', app: '4.150.0' }, { ios: '26.3.1', app: '4.149.0' },
  { ios: '26.5', app: '4.150.0' },
];
const devFor = (l) => DEVICES[parseInt(crypto.createHash('md5').update('dev:' + l).digest('hex').slice(0, 8), 16) % DEVICES.length];

const PUBLIC_URL = 'https://www.olx.pl/api/v1/offers/?offset=0&limit=1&category_id=14&sort_by=created_at%3Adesc';
const BROWSER_H = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  accept: 'application/json', 'accept-language': 'pl', origin: 'https://www.olx.pl', referer: 'https://www.olx.pl/',
};

async function pilot(acc, adId) {
  const key = `pilot-${acc.label}`;
  const agent = agentFor(key);
  const out = { label: acc.label, stary_ip: acc.ip, nowy_ip: null, cloudfront: null, token: null, reveal: null };

  // 1. proxy żyje?
  try {
    const r = await fetch('https://api.ipify.org?format=json', { dispatcher: agent, signal: AbortSignal.timeout(20000) });
    out.nowy_ip = (await r.json()).ip;
  } catch (e) {
    // `fetch failed` samo w sobie nic nie mówi — dopiero cause rozróżnia wygasły pakiet
    // (407/ECONNRESET) od martwego hosta (ENOTFOUND/ECONNREFUSED).
    const c = e.cause || {};
    out.nowy_ip = `BŁĄD: ${String(e.message).slice(0, 30)} | powód: ${c.code || c.message || 'brak'}`;
    return out;
  }

  // 2. czy nowy adres przechodzi CloudFront (bez konta, bez tokenu)
  try {
    const r = await fetch(PUBLIC_URL, { headers: BROWSER_H, dispatcher: agent, signal: AbortSignal.timeout(25000) });
    const t = await r.text();
    out.cloudfront = r.status === 200 && t.startsWith('{') ? 'OK' : `403/${r.status}`;
    if (out.cloudfront !== 'OK') return out;
  } catch (e) { out.cloudfront = `BŁĄD: ${String(e.message).slice(0, 30)}`; return out; }

  // 3. token konta przez nowy adres
  let access;
  try {
    const r = await fetch('https://login.olx.pl/oauth2/token', {
      method: 'POST', dispatcher: agent,
      headers: { 'content-type': 'application/json', 'user-agent': 'OLX.pl/883 CFNetwork/3860.600.12 Darwin/25.5.0', accept: '*/*' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: acc.refresh_token, client_id: CLIENT_ID }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) { out.token = `BŁĄD ${r.status} ${j.error || ''}`; return out; }
    access = j.access_token;
    out.token = 'OK';
    // IPRoyal potrafi zwrócić nowy refresh_token — zapisz, inaczej stary przestanie działać
    if (j.refresh_token && j.refresh_token !== acc.refresh_token) {
      await rpc('leads_set_mobile_token_value', { p_label: acc.label, p_refresh_token: j.refresh_token }).catch(() => {});
    }
  } catch (e) { out.token = `BŁĄD: ${String(e.message).slice(0, 30)}`; return out; }

  // 4. realny reveal
  const dev = devFor(acc.label);
  const H = {
    authorization: `Bearer ${access}`, accept: '*/*', version: 'v1.17', 'x-platform-type': 'ios',
    'user-agent': `iPhone App Ver ${dev.app} (iOS ${dev.ios})`,
    'x-device-id': crypto.createHash('sha1').update('dev:' + acc.label).digest('hex'), 'accept-language': 'pl',
  };
  try {
    await fetch(`https://www.olx.pl/api/v1/ads/${adId}/phone-view`, { method: 'POST', dispatcher: agent, headers: H, body: '', signal: AbortSignal.timeout(20000) }).catch(() => {});
    const r = await fetch(`https://www.olx.pl/api/v1/offers/${adId}/limited-phones`, { dispatcher: agent, headers: H, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    if (r.status === 403 || r.status === 429) out.reveal = `⛔ ŚCIANA ${r.status}`;
    else if (/podejrzan|kontynuowa/i.test(body)) out.reveal = '⛔ ŚCIANA (podejrzana aktywność)';
    else if (r.status === 200) {
      const j = JSON.parse(body);
      out.reveal = j?.data?.phones?.[0] ? '✅ NUMER WRÓCIŁ' : '∅ ogłoszenie bez numeru (ale przeszło)';
    } else if (r.status === 400 || r.status === 404) out.reveal = '🗑 ogłoszenie usunięte (ale przeszło)';
    else out.reveal = `⚠️ HTTP ${r.status}`;
  } catch (e) { out.reveal = `BŁĄD: ${String(e.message).slice(0, 30)}`; }

  return out;
}

// ---- start ----
const labels = process.argv.slice(2).filter(Boolean);
if (!labels.length) { console.error('podaj konta, np: node pilot_reip.mjs slot3 slot10 slot20'); process.exit(1); }

const rows = await rpc('leads_get_mobile_tokens', {});
const byLabel = new Map((rows || []).map((r) => [r.label, r]));

// ogłoszenia do testu — prawdziwe numeryczne id z API (NIE dekodowane z URL, patrz incydent 21.07)
const targets = await fetch(
  `${SB_URL}/rest/v1/listings?select=portal_listing_id&phone_id=is.null&portal=eq.olx&reveal_status=is.null&order=first_scraped_at.desc&limit=${labels.length}`,
  { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'leads' } },
).then((r) => r.json());

console.log(`PILOT re-IP — konta: ${labels.join(', ')} | zapis do bazy: ${APPLY ? 'TAK' : 'NIE (tylko test)'}\n`);

// Czy sam gateway w ogóle żyje (host zamaskowany — to sekret).
{
  const maskedHost = PHOST.replace(/^[^.]+/, '***');
  try {
    const { lookup } = await import('node:dns/promises');
    const a = await lookup(PHOST);
    console.log(`gateway ${maskedHost}:${PPORT} → DNS OK (${a.address})`);
  } catch (e) { console.log(`gateway ${maskedHost}:${PPORT} → DNS PADŁ: ${e.code || e.message}`); }
  try {
    const net = await import('node:net');
    await new Promise((res, rej) => {
      const s = net.connect({ host: PHOST, port: Number(PPORT), timeout: 10000 });
      s.on('connect', () => { s.end(); res(); });
      s.on('timeout', () => { s.destroy(); rej(new Error('TIMEOUT')); });
      s.on('error', rej);
    });
    console.log('gateway TCP → połączenie przyjęte (host żyje, problem jest w autoryzacji/pakiecie)');
  } catch (e) { console.log(`gateway TCP → ODRZUCONE: ${e.code || e.message}`); }
  console.log('');
}

const results = [];
for (let i = 0; i < labels.length; i++) {
  const acc = byLabel.get(labels[i]);
  if (!acc) { console.log(`[${labels[i]}] nie ma takiego konta w bazie — pomijam`); continue; }
  const adId = targets[i]?.portal_listing_id;
  if (!adId) { console.log(`[${labels[i]}] brak ogłoszenia do testu — pomijam`); continue; }
  console.log(`[${acc.label}] test na ad_id=${adId}…`);
  const r = await pilot(acc, adId);
  results.push(r);
  console.log(`   stare IP ${r.stary_ip} → nowe ${r.nowy_ip} | CloudFront ${r.cloudfront} | token ${r.token} | reveal ${r.reveal}`);
  await new Promise((s) => setTimeout(s, 8000)); // nie strzelaj seriami
}

console.log('\n=== PODSUMOWANIE ===');
for (const r of results) console.log(`${r.label.padEnd(11)} ${String(r.reveal ?? '—').padEnd(34)} (CF ${r.cloudfront ?? '—'}, exit ${r.nowy_ip})`);

const wins = results.filter((r) => String(r.reveal).startsWith('✅') || String(r.reveal).includes('przeszło'));
console.log(`\nprzeszło: ${wins.length}/${results.length}`);

if (APPLY && wins.length) {
  console.log('\n— zapisuję nowe proxy dla kont, które przeszły —');
  for (const r of wins) {
    const res = await fetch(`${SB_URL}/rest/v1/olx_mobile_tokens?label=eq.${encodeURIComponent(r.label)}`, {
      method: 'PATCH',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json',
        'Content-Profile': 'leads', Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        ip: PHOST, proxy_user: PUSER, proxy_pass: passFor(`pilot-${r.label}`), proxy_port: Number(PPORT),
        blocked_at: null, next_reveal_at: new Date().toISOString(),
      }),
    });
    console.log(`   ${r.label}: ${res.ok ? 'zapisane, odblokowane, wraca do kolejki' : 'BŁĄD ZAPISU ' + res.status}`);
  }
} else if (APPLY) {
  console.log('\nnic nie przeszło — NIE zapisuję niczego, konta zostają jak były');
}
