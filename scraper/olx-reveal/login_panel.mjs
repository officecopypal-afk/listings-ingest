/** Panel logowania kont OLX — localhost:8899. Klik "Zaloguj" → Chrome z trwałym profilem (Ty wpisujesz hasło).
 *  Odpal z katalogu scraper/olx-reveal:  node login_panel.mjs   (Ctrl+C żeby zatrzymać) */
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';

const PORT = Number(process.env.PORT || 8899);
const N = Number(process.env.ACCOUNTS || 14);
const accounts = Array.from({ length: N }, (_, i) => `konto${i + 1}`);

const status = (acc) => { const f = `session_${acc}.json`; if (!fs.existsSync(f)) return { s: 'brak' }; const st = fs.statSync(f); const c = (() => { try { return JSON.parse(fs.readFileSync(f)).cookies.length; } catch { return '?'; } })(); return { s: 'ok', when: st.mtime, cookies: c }; };

function html() {
  const rows = accounts.map((acc) => {
    const st = status(acc);
    const badge = st.s === 'ok'
      ? `<span class="ok">✅ zalogowany</span> <small>${new Date(st.when).toLocaleString('pl-PL')} · ${st.cookies} cookies</small>`
      : `<span class="no">⬜ brak sesji</span>`;
    return `<tr><td><b>${acc}</b></td><td>${badge}</td><td><button onclick="login('${acc}')">${st.s === 'ok' ? 'Zaloguj ponownie' : 'Zaloguj'}</button></td></tr>`;
  }).join('');
  const done = accounts.filter((a) => status(a).s === 'ok').length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>OLX — logowanie kont</title>
<style>body{font-family:system-ui,-apple-system;max-width:680px;margin:28px auto;padding:0 16px;color:#222}h1{font-size:20px}table{width:100%;border-collapse:collapse;margin-top:10px}td{padding:9px 8px;border-bottom:1px solid #eee}button{padding:6px 14px;cursor:pointer;border:0;background:#0a7a55;color:#fff;border-radius:7px;font-size:13px}button:hover{background:#0c9268}.ok{color:#0a7a55;font-weight:600}.no{color:#aaa}#msg{margin:12px 0;color:#06c;min-height:18px}small{color:#999}.hdr{background:#f6f8f7;padding:12px 14px;border-radius:8px;margin-bottom:8px}</style></head>
<body><h1>OLX — logowanie kont</h1>
<div class="hdr"><b>${done}/${N}</b> kont zalogowanych. Klik „Zaloguj" → otworzy się Chrome. <b>Wpisz hasło</b> (Chrome zaproponuje zapis — zapisz, następnym razem wypełni sam), zaloguj się. Panel wykryje i zapisze sesję automatycznie.</div>
<div id="msg"></div>
<table>${rows}</table>
<script>
async function login(a){document.getElementById('msg').textContent='Otwieram Chrome dla '+a+' — zaloguj się w oknie (panel sam wykryje).';await fetch('/login/'+a,{method:'POST'});setTimeout(()=>location.reload(),1500);}
setInterval(()=>location.reload(),12000);
</script></body></html>`;
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/login/')) {
    const acc = req.url.slice(7).replace(/[^a-z0-9]/gi, '');
    if (/^konto\d+$/.test(acc)) { spawn('node', ['login_helper.mjs', acc], { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref(); }
    res.writeHead(200); res.end('ok'); return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html());
}).listen(PORT, () => console.log(`✅ Panel logowania: http://localhost:${PORT}  (${N} kont, Ctrl+C = stop)`));
