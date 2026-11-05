'use strict';
// FridgeLink relay: serves the pages and passes messages between the fridge page and phone pages.
// No dependencies. Run:  node server.js   (PORT env var optional, default 8080)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const PORT = +process.env.PORT || 8080;
const ROOT = __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const ROOM_RE = /^[A-Za-z0-9_-]{1,32}$/;
const rooms = new Map();          // room -> Set of { cid, role, res }

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out.sort((a, b) => (b.startsWith('192.168.') - a.startsWith('192.168.')));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (process.env.DEBUG) console.log(req.method, req.url.slice(0, 80));
  const room = url.searchParams.get('room') || '', cid = (url.searchParams.get('cid') || '').slice(0, 32);

  if (url.pathname === '/events') {
    if (!ROOM_RE.test(room)) { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\nevent: hello\ndata: {}\n\n');
    const client = { cid, role: url.searchParams.get('role') || '', res };
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room).add(client);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(beat); const s = rooms.get(room); if (s) { s.delete(client); if (!s.size) rooms.delete(room); } });
    return;
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    if (!ROOM_RE.test(room)) { res.writeHead(400).end(); return; }
    let body = '';
    req.on('data', d => { body += d; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try { JSON.parse(body); } catch (e) { res.writeHead(400).end(); return; }
      const line = 'data: ' + body.replace(/\n/g, ' ') + '\n\n';
      for (const c of rooms.get(room) || []) if (c.cid !== cid) c.res.write(line);
      res.writeHead(204).end();
    });
    return;
  }

  if (url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ips: lanIps(), port: PORT }));
    return;
  }

  // static files
  let p = decodeURIComponent(url.pathname); if (p === '/') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p));
  if (!file.startsWith(ROOT) || /server\.js$|\.pptx$/.test(file)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  FridgeLink is running\n');
  console.log(`  Fridge (open on your laptop):  http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  Same Wi-Fi (phones):           http://${ip}:${PORT}`);
  console.log('\n  The fridge page shows a QR code for the phone. Press Ctrl+C to stop.\n');
});
