'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const p2 = n => String(n).padStart(2, '0');
  const hm = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
  const STATUS = { sending: 'Sending…', sent: 'Sent', delivered: 'Delivered' };

  const room = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');

  /* ------------ sound ------------ */
  let actx = null;
  addEventListener('pointerdown', () => { if (!actx) try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }, { once: true });
  function tone(f, d, v, at = 0) {
    if (!actx) return;
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
    o.frequency.value = f; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.0001, t + d);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
  }
  const ding = () => { tone(1046, .22, .07); tone(1568, .3, .06, .12); };

  /* ------------ thread ------------ */
  const thread = $('thread'), refs = new Map();
  function setMeta(msg) {
    const r = refs.get(msg.id); if (!r) return;
    r.m.innerHTML = msg.dir === 'out' ? `${hm(msg.simMs)} · <b>${STATUS[msg.status] || ''}</b>` : `${hm(msg.simMs)}${msg.label ? ' · ' + msg.label : ''}`;
  }
  function render(msg) {
    if (refs.has(msg.id)) { setMeta(msg); return false; }
    $('threadEmpty')?.remove();
    const b = document.createElement('div');
    b.className = `bub ${msg.dir}${msg.dir === 'in' && msg.kind !== 'reply' ? ' ' + msg.kind : ''}`;
    b.textContent = msg.text;
    const m = document.createElement('div'); m.className = `meta ${msg.dir}`;
    thread.append(b, m);
    refs.set(msg.id, { b, m });
    setMeta(msg);
    thread.scrollTop = thread.scrollHeight;
    return true;
  }
  function reset() { refs.clear(); thread.querySelectorAll('.bub,.meta').forEach(e => e.remove()); }

  /* ------------ connection + access code ------------ */
  let link = null, linkUp = false, lastHello = 0, simBase = null, collapseT;
  let pin = '', authed = false, checking = false, checkT;
  const conn = $('conn'), connText = $('connText');
  const showConn = (cls, text, autoHide) => {
    conn.hidden = false; conn.className = 'conn ' + cls; connText.textContent = text;
    clearTimeout(collapseT); if (autoHide) collapseT = setTimeout(() => { conn.hidden = true; }, 2500);
  };
  const online = () => linkUp && Date.now() - lastHello < 5000;
  const setEnabled = v => { $('smsInput').disabled = !v; document.querySelectorAll('#cmds button').forEach(b => b.disabled = !v); };
  const post = m => link && link.send({ ...m, pin });

  function onMsg(m) {
    if (m.t === 'hello') {
      simBase = { ms: m.simMs, at: Date.now(), speed: m.speed };
      const was = online(); lastHello = Date.now();
      if (authed && !was) { showConn('ok', 'Connected to fridge', true); setEnabled(true); post({ t: 'join' }); }
      return;
    }
    if (m.t === 'denied') { if (checking) lockError('Wrong code. Try again.'); return; }
    if (m.t === 'sync') {
      if (checking) { checking = false; clearTimeout(checkT); authed = true; sessionStorage.setItem('fl-pin', pin); unlock(); }
      if (authed) { reset(); m.msgs.forEach(render); }
      return;
    }
    if (!authed) return;
    if (m.t === 'add') { if (render(m.msg) && m.msg.dir === 'in') { ding(); if (m.msg.kind === 'alert' && navigator.vibrate) navigator.vibrate([200, 80, 200]); } }
    else if (m.t === 'update') render(m.msg);
  }
  function onState(s) {
    linkUp = s.up;
    if (!authed) return;
    if (!s.up) { showConn('off', 'Connection lost. Retrying…'); setEnabled(false); }
    else if (!online()) { showConn('', s.mode === 'local' ? 'Waiting for fridge page (same browser only)…' : 'Looking for the fridge…'); setEnabled(false); }
  }

  /* ------------ lock screen ------------ */
  const lock = $('lock'), dots = [...$('dots').children];
  function paint() { dots.forEach((d, i) => d.classList.toggle('on', i < pin.length)); }
  function lockError(msg) {
    checking = false; clearTimeout(checkT);
    $('lockMsg').textContent = msg; lock.classList.add('bad');
    $('dots').classList.add('shake'); if (navigator.vibrate) navigator.vibrate(120);
    setTimeout(() => { $('dots').classList.remove('shake'); lock.classList.remove('bad'); pin = ''; paint(); }, 600);
  }
  function unlock() {
    lock.classList.add('gone'); setTimeout(() => { lock.hidden = true; }, 350);
    setEnabled(online());
    showConn('ok', 'Connected to fridge', true);
    setInterval(() => {
      post({ t: 'ping' });
      if (linkUp && lastHello && Date.now() - lastHello > 5000 && !conn.classList.contains('off')) { showConn('off', 'Fridge page not responding. Is it open?'); setEnabled(false); }
    }, 2500);
  }
  function submit() {
    if (checking) return;
    checking = true; $('lockMsg').textContent = 'Checking…';
    post({ t: 'join' });
    checkT = setTimeout(() => { if (checking) lockError("Can't reach the fridge. Is its page open?"); }, 6000);
  }
  function key(k) {
    if (!room || checking || authed) return;
    if (k === 'del') pin = pin.slice(0, -1); else if (pin.length < 6) pin += k;
    paint();
    if (pin.length === 6) setTimeout(submit, 120);
  }
  $('pad').addEventListener('click', e => { const b = e.target.closest('button'); if (b) key(b.dataset.k); });
  addEventListener('keydown', e => {
    if (!lock.hidden && /^\d$/.test(e.key)) key(e.key);
    else if (!lock.hidden && e.key === 'Backspace') key('del');
  });

  /* ------------ clock ------------ */
  setInterval(() => {
    const ms = simBase ? simBase.ms + (Date.now() - simBase.at) * simBase.speed : Date.now();
    $('phTime').textContent = hm(ms).replace(/^0/, '');
  }, 1000);

  /* ------------ input ------------ */
  const send = text => { text = text.trim(); if (text && authed) post({ t: 'sms', text }); };
  $('composer').addEventListener('submit', e => { e.preventDefault(); const i = $('smsInput'); send(i.value); i.value = ''; });
  document.querySelectorAll('#cmds button').forEach(b => b.addEventListener('click', () => send(b.dataset.cmd)));

  /* ------------ start ------------ */
  setEnabled(false);
  if (!room) {
    $('lockMsg').textContent = 'Open this page from the QR code or link on the fridge screen.';
    $('pad').classList.add('disabled');
  } else {
    link = Link.open(room, 'phone', onMsg, onState);
    const saved = sessionStorage.getItem('fl-pin');      // same tab, e.g. after a refresh
    if (saved) { pin = saved; paint(); setTimeout(submit, 600); }
  }
})();
