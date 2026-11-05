'use strict';
(() => {
  const S = Sim.S;
  const $ = id => document.getElementById(id);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const p2 = n => String(n).padStart(2, '0');
  const hms = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
  const hm = ms => hms(ms).slice(0, 5);

  /* ---------------------------- sound ---------------------------- */
  let actx = null, muted = false;
  const unlock = () => { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } };
  addEventListener('pointerdown', unlock, { once: true });
  function tone(f, d, type = 'sine', v = .05, at = 0) {
    if (muted || !actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
  }
  const click = () => { tone(180, .05, 'square', .04); tone(90, .09, 'square', .03, .04); };

  /* ------------------------- phone link (separate page) ------------------------- */
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let room = (new URLSearchParams(location.search).get('room') || localStorage.getItem('fl-room') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  if (!room) room = Array.from({ length: 5 }, () => ALPHA[Math.random() * ALPHA.length | 0]).join('');
  localStorage.setItem('fl-room', room);

  const ACCESS_CODE = '209173';          // demo code the phone must enter
  const sms = [];                       // every message so far, so a phone that joins late gets the whole thread
  const wire = m => ({ id: m.id, dir: m.dir, kind: m.kind, text: m.text, simMs: m.simMs, status: m.status, label: m.label });
  let lastPing = 0, linkState = { up: false, mode: 'none' };
  const link = Link.open(room, 'fridge', m => {
    if (m.t === 'join' && m.pin !== ACCESS_CODE) { link.send({ t: 'denied' }); return; }
    if (m.pin !== ACCESS_CODE) return;                       // anything without the access code is ignored
    if (m.t === 'sms') Sim.phoneSend(m.text);
    else if (m.t === 'ping' || m.t === 'join') { lastPing = Date.now(); if (m.t === 'join') link.send({ t: 'sync', msgs: sms.map(wire) }); }
  }, s => { linkState = s; });
  Sim.on('phone', ev => { if (ev.type === 'add') sms.push(ev.msg); link.send({ t: ev.type, msg: wire(ev.msg) }); });
  setInterval(() => link.send({ t: 'hello', simMs: S.simMs, speed: S.paused ? 0 : S.speed }), 1000);

  let phoneUrl = '';
  async function setupUrl() {
    let base;
    if (location.protocol === 'file:') base = new URL('phone.html', location.href).href;
    else {
      let origin = location.origin;
      if (/^(localhost|127\.|\[::1\])/.test(location.hostname)) {
        try { const i = await (await fetch('info')).json(); if (i.ips[0]) origin = `http://${i.ips[0]}:${i.port}`; } catch (e) {}
      }
      base = origin + '/phone.html';
    }
    phoneUrl = `${base}?room=${room}`;
    $('phoneUrl').textContent = phoneUrl;
    $('openPhone').href = `phone.html?room=${room}`;
    try { const qr = qrcode(0, 'M'); qr.addData(phoneUrl); qr.make(); $('qr').innerHTML = qr.createSvgTag({ scalable: true, margin: 0 }); } catch (e) { $('qr').hidden = true; }
  }
  setupUrl();
  $('copyUrl').addEventListener('click', e => {
    const done = () => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy link'; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(phoneUrl).then(done);
    else { const t = document.createElement('textarea'); t.value = phoneUrl; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); done(); }
  });
  function renderLink() {
    const ok = Date.now() - lastPing < 7000, pill = $('linkPill');
    pill.className = 'pill ' + (ok ? 'ok' : 'wait');
    set('linkText', ok ? 'Phone connected' : linkState.mode === 'relay' && !linkState.up ? 'Relay offline' : 'Waiting for phone…');
    set('linkNote', linkState.mode === 'local'
      ? 'No relay server detected, so the phone page only works in this same browser. Run start.bat to pair a real phone.'
      : /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname)
        ? `Room ${room}. Scan with the phone camera (phone must be on the same Wi-Fi), or open the link.`
        : `Room ${room}. Scan with any phone on any network, or open the link.`);
  }


  /* ---------------------------- serial --------------------------- */
  const term = $('term');
  Sim.on('serial', l => {
    const near = term.scrollHeight - term.scrollTop - term.clientHeight < 40;
    const d = document.createElement('div');
    d.className = l.dir;
    const pre = l.dir === 'tx' ? '→ ' : l.dir === 'rx' ? '← ' : '# ';
    d.innerHTML = `<span class="ts">${hms(l.t)}</span>`;
    d.append(pre + l.text);
    term.append(d);
    while (term.children.length > 400) term.firstChild.remove();
    if (near) term.scrollTop = term.scrollHeight;
    if (l.dir !== 'sys') { blink[l.dir] = performance.now(); }
  });
  $('clearSerial').addEventListener('click', () => { term.textContent = ''; });
  const blink = { tx: 0, rx: 0 };

  /* ---------------------------- results -------------------------- */
  const results = [];
  Sim.on('result', r => {
    results.push(r);
    $('resEmpty').hidden = true;
    const tr = document.createElement('tr');
    const cells = [results.length, hms(r.time), `<span class="tag ${r.kind}">${r.kind}</span>`, null, null, null, r.seconds == null ? '—' : r.seconds.toFixed(1)];
    tr.innerHTML = cells.map(c => `<td>${c ?? ''}</td>`).join('');
    tr.children[3].textContent = r.event; tr.children[4].textContent = r.source; tr.children[5].textContent = r.outcome;
    $('resBody').prepend(tr);
    const timed = results.filter(x => x.seconds != null), del = results.filter(x => x.kind !== 'Security');
    $('stN').textContent = results.length;
    $('stAvg').textContent = timed.length ? (timed.reduce((a, x) => a + x.seconds, 0) / timed.length).toFixed(1) + 's' : '—';
    $('stMax').textContent = timed.length ? Math.max(...timed.map(x => x.seconds)).toFixed(1) + 's' : '—';
    $('stOk').textContent = del.length ? `${del.filter(x => x.outcome.startsWith('Delivered')).length}/${del.length}` : '—';
  });
  const resetResults = () => { results.length = 0; $('resBody').textContent = ''; $('resEmpty').hidden = false;
    ['stN', 'stAvg', 'stMax', 'stOk'].forEach((k, i) => $(k).textContent = i ? '—' : '0'); };
  $('clearRes').addEventListener('click', resetResults);
  $('csvBtn').addEventListener('click', () => {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['No', 'Sim time', 'Type', 'Event', 'Source', 'Outcome', 'Response (s)'].join(',')]
      .concat(results.map((r, i) => [i + 1, hms(r.time), r.kind, q(r.event), q(r.source), q(r.outcome), r.seconds == null ? '' : r.seconds.toFixed(2)].join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }));
    a.download = 'fridgelink-test-results.csv'; a.click(); URL.revokeObjectURL(a.href);
  });

  /* ---------------------------- controls ------------------------- */
  function setTab(t) {
    document.body.dataset.tab = t;
    $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'lab') requestAnimationFrame(drawChart);
  }
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  $$('.seg [data-speed]').forEach(b => b.addEventListener('click', () => {
    Sim.setSpeed(+b.dataset.speed);
    $$('.seg [data-speed]').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('pauseBtn').addEventListener('click', e => { Sim.setPaused(!S.paused); e.currentTarget.classList.toggle('on', S.paused); });
  $('soundBtn').addEventListener('click', e => { muted = !muted; e.currentTarget.classList.toggle('muted', muted); });

  const fridge = $('fridge'), door = $('doorBtn');
  const toggleDoor = () => Sim.setDoor(!S.door);
  door.addEventListener('click', toggleDoor);
  door.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleDoor(); } });

  $$('[data-act]').forEach(b => b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'door') toggleDoor();
    else if (a === 'mains') Sim.setMains(!S.mains);
    else if (a === 'net') Sim.setNet(!S.gsm.netUp);
    else if (a === 'xray') fridge.dataset.xray = fridge.dataset.xray === 'on' ? 'off' : 'on';
  }));
  $('restockBtn').addEventListener('click', Sim.restock);

  $('ambient').addEventListener('input', e => { Sim.setAmbient(+e.target.value); $('ambOut').textContent = e.target.value + ' °C'; });
  $('limit').addEventListener('input', e => { Sim.setLimit(+e.target.value); $('limOut').textContent = e.target.value + ' °C'; });
  Sim.on('relay', ev => { click(); $('limit').value = S.mcu.limit; $('limOut').textContent = S.mcu.limit + ' °C'; });

  $$('.tabs button').forEach(b => b.addEventListener('click', () => {
    $$('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.lt').forEach(x => x.classList.toggle('on', x.id === 'lt-' + b.dataset.lt));
    if (b.dataset.lt === 'serial') term.scrollTop = term.scrollHeight;
  }));
  let win = 120;
  $$('#winSeg button').forEach(b => b.addEventListener('click', () => {
    win = +b.dataset.win; $$('#winSeg button').forEach(x => x.classList.toggle('on', x === b)); drawChart();
  }));

  /* ----------------------------- chart --------------------------- */
  function drawChart() {
    const c = $('chart'), box = c.parentElement, w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const L = 32, R = 8, T = 8, B = 22, pw = w - L - R, ph = h - T - B;
    const t1 = S.simMs, t0 = t1 - win * 60e3;
    const pts = S.history.filter(p => p.t >= t0 - 20000); pts.push({ t: t1, T: S.Ta, c: S.compOn, m: S.mains });
    const lim = S.mcu.limit;
    const yMin = 0, yMax = Math.max(14, Math.ceil(Math.max(...pts.map(p => p.T), lim) + 2));
    const X = t => L + (t - t0) / (t1 - t0) * pw, Y = v => T + ph - (v - yMin) / (yMax - yMin) * ph;

    g.font = '11px ui-monospace,Consolas,monospace'; g.fillStyle = '#7d8aa5'; g.strokeStyle = '#ffffff12'; g.lineWidth = 1;
    const step = yMax > 22 ? 5 : 2;
    for (let v = yMin; v <= yMax; v += step) { const y = Math.round(Y(v)) + .5; g.beginPath(); g.moveTo(L, y); g.lineTo(w - R, y); g.stroke(); g.textAlign = 'right'; g.fillText(v, L - 6, y + 4); }
    const ticks = 5; g.textAlign = 'center';
    for (let i = 0; i <= ticks; i++) { const t = t0 + (t1 - t0) * i / ticks; g.fillText(hm(t), clamp(X(t), L + 14, w - R - 14), h - 6); }

    // shading: mains off (full height) and compressor on (bottom strip)
    const seg = (key, fn) => { let s = null; for (let i = 0; i < pts.length; i++) { const on = key(pts[i]);
      if (on && s === null) s = pts[i].t; if ((!on || i === pts.length - 1) && s !== null) { fn(Math.max(s, t0), pts[i].t); s = null; } } };
    g.fillStyle = '#fb5a5a2e'; seg(p => !p.m, (a, b) => g.fillRect(X(a), T, Math.max(1, X(b) - X(a)), ph));
    g.fillStyle = '#5ad1ff40'; seg(p => p.c, (a, b) => g.fillRect(X(a), T + ph - 7, Math.max(1, X(b) - X(a)), 7));

    // limit line
    g.setLineDash([5, 5]); g.strokeStyle = '#fbbf24'; g.beginPath(); g.moveTo(L, Y(lim)); g.lineTo(w - R, Y(lim)); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#fbbf24'; g.textAlign = 'left'; g.fillText(`limit ${lim}°`, L + 6, Y(lim) - 5);

    // temperature line + area
    const path = () => { g.beginPath(); pts.forEach((p, i) => { const x = clamp(X(p.t), L, L + pw), y = Y(p.T); i ? g.lineTo(x, y) : g.moveTo(x, y); }); };
    path(); g.lineTo(X(t1), T + ph); g.lineTo(clamp(X(pts[0].t), L, L + pw), T + ph); g.closePath();
    const grad = g.createLinearGradient(0, T, 0, T + ph); grad.addColorStop(0, '#5ad1ff40'); grad.addColorStop(1, '#5ad1ff00'); g.fillStyle = grad; g.fill();
    g.lineWidth = 2; g.lineJoin = 'round'; g.strokeStyle = '#5ad1ff'; path(); g.stroke();
    g.save(); g.beginPath(); g.rect(L, 0, pw, Y(lim)); g.clip(); g.strokeStyle = '#ff6b6b'; path(); g.stroke(); g.restore();
    const hot = S.Ta > lim; g.fillStyle = hot ? '#ff6b6b' : '#5ad1ff';
    g.beginPath(); g.arc(X(t1), Y(S.Ta), 4, 0, 7); g.fill();
    $('chartNow').textContent = S.Ta.toFixed(1) + ' °C';
  }
  new ResizeObserver(drawChart).observe($('chart').parentElement);

  /* ----------------------------- render -------------------------- */
  const set = (id, v) => { const e = $(id); if (e.textContent !== v) e.textContent = v; };
  const chip = (id, s, text) => { const e = $(id); e.dataset.s = s; e.querySelector('b').textContent = text; };
const label = (a, on, onT, offT) => $$(`[data-act=${a}]`).forEach(b => { b.classList.toggle('active', on); b.querySelector('small').textContent = on ? onT : offT; });
  let prevPowered = null, frame = 0;

  function render() {
    const m = S.mcu, g = S.gsm;
    const d = new Date(S.simMs);
    renderLink();
    set('simClock', hms(S.simMs)); set('simDate', d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }));

    const powered = S.mains && !(m.alive && m.cmdOff);
    if (prevPowered !== null && prevPowered !== powered) click();
    prevPowered = powered;

    // fridge
    const comp = !powered ? 'off' : S.compOn ? 'on' : S.compLock > 0 ? 'wait' : 'idle';
    $('fridgeWrap').dataset.comp = S.compOn ? 'on' : 'off';
    fridge.dataset.door = S.door ? 'open' : 'closed'; door.setAttribute('aria-pressed', S.door);
    fridge.dataset.off = !m.alive;
    const power = !S.mains ? 'cut' : m.alive && m.cmdOff ? 'off' : 'on';
    fridge.dataset.power = power;
    $('frBadge').hidden = power === 'on';
    set('frBadge', power === 'cut' ? 'NO MAINS POWER' : 'FRIDGE SWITCHED OFF');
    const t = m.tempC;
    fridge.style.setProperty('--heat', clamp((S.Ta - 5) / 18, 0, 1).toFixed(3));
    fridge.style.setProperty('--cold', clamp((5.5 - S.Ta) / 4, 0, 1).toFixed(3));
    fridge.style.setProperty('--fog', clamp((S.Ta - 9) / 12, 0, .85).toFixed(3));
    fridge.style.setProperty('--tcol', !m.alive ? '#445066' : t > m.limit ? '#ff7b7b' : t > m.limit - 1.5 ? '#ffc857' : '#7fe3ff');
    set('dispTemp', m.alive ? t.toFixed(1) : '--.-');
    set('dispSub', !m.alive ? (m.booting ? 'STARTING' : 'OFFLINE') : S.door ? 'DOOR OPEN' : !S.mains ? 'POWER CUT' : m.cmdOff ? 'FRIDGE OFF' : S.compOn ? 'COOLING' : 'HOLDING');
    $('diGsm').className = 'di ' + (g.registered ? 'on' : m.alive ? 'bad' : '');
    $('diPwr').className = 'di ' + (S.mains ? 'on' : m.alive ? 'warn' : '');
    $('diCool').className = 'di ' + (S.compOn ? 'on' : '');

    chip('chComp', comp === 'on' ? 'ok' : !S.mains ? 'bad' : m.cmdOff ? 'warn' : 'ok',
      !S.mains ? 'No power' : m.cmdOff ? 'Switched off' : comp === 'on' ? 'Running' : comp === 'wait' ? `Wait ${Math.ceil(S.compLock)}s` : 'Idle');
    chip('chMains', S.mains ? 'ok' : 'bad', S.mains ? 'OK' : `Cut · bat ${Math.round(m.battery)}%`);
    chip('chDoor', S.door ? 'warn' : 'ok', S.door ? 'Open' : 'Closed');
    const unsafe = S.unsafeSec > 3600, risk = S.Tl > 8 || S.unsafeSec > 0;
    chip('chFood', unsafe ? 'bad' : risk ? 'warn' : 'ok', unsafe ? 'Unsafe' : risk ? 'At risk' : `Safe · ${S.Tl.toFixed(1)}°C`);
    $('restockBtn').hidden = !risk;
label('door', S.door, 'Open', 'Closed'); label('mains', !S.mains, 'Cut', 'On');    label('net', !g.netUp, 'Down', 'Online'); label('xray', fridge.dataset.xray === 'on', 'On', 'Off');

    // lab
    const lcd = $('lcd0').parentElement; lcd.classList.toggle('off', !m.alive);
    $('lcd0').textContent = m.alive || m.booting ? m.lcd[0] : ' '.repeat(16);
    $('lcd1').textContent = m.alive || m.booting ? m.lcd[1] : ' '.repeat(16);
    const now = performance.now();
    set('dPsu', S.mains ? '5 V DC · mains OK' : `battery ${Math.round(m.battery)}%`);
    set('dLm35', `${m.volts.toFixed(3)} V`); set('dLdr', `A1 = ${m.ldr}`);
    set('dA0', `A0 · ADC ${m.adc}`); set('dTemp', `${t.toFixed(1)} °C`);
    set('dD7', `D7 · relay ${m.cmdOff ? 'OPEN' : 'CLOSED'}`);
    set('dComp', comp === 'on' ? 'running' : comp === 'wait' ? 'start delay' : powered ? 'idle' : 'no supply');
    set('dGsm', g.registered ? `CSQ ${g.csq}` : 'no network');
    const bars = !g.registered ? 0 : clamp(Math.round((g.csq - 6) / 4) + 1, 1, 5);
    $$('#dBars rect').forEach((r, i) => r.classList.toggle('on', i < bars));
    $('ledPwr').classList.toggle('on', m.alive); $('ledTx').classList.toggle('on', now - blink.tx < 220); $('ledRx').classList.toggle('on', now - blink.rx < 220);
    const closed = powered; $('swBody').classList.toggle('closed', closed); $('swKnob').setAttribute('cx', closed ? 492 : 458);
    const live = (id, v) => $(id).classList.toggle('live', !!v);
    live('wPwr', S.mains || m.battery > 0); live('wTemp', m.alive); live('wLdr', m.alive); live('wLcd', m.alive);
    live('wRly', m.alive && !m.cmdOff); live('wLoad', powered); live('wGsm', g.registered && now - Math.max(blink.tx, blink.rx) < 1500);
    $('batFill').setAttribute('width', Math.max(0, m.battery));

    if (++frame % 5 === 0 && getComputedStyle($('pane-lab')).display !== 'none') drawChart();
  }
  setInterval(render, 100);

  Sim.start();
  const q = new URLSearchParams(location.search).get("tab");
  if (["fridge", "lab"].includes(q)) setTab(q);
  render();
})();
