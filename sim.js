'use strict';
/* ------------------------------------------------------------------
   FridgeLink simulation engine
   Models the system in the project slides:
     LM35 + LDR -> Arduino Uno -> relay -> refrigerator
                       |-> SIM800L (AT commands over serial) <-> GSM network <-> owner's phone
   Physics runs in simulated seconds (speed-up factor); GSM latency runs in real time.
------------------------------------------------------------------- */
const Sim = (() => {
  const NUM = { owner: '+234 803 555 0142', fridge: '+234 809 555 0187' };
  const AUTH = [NUM.owner];

  // Thermal constants (seconds). Tuned so the cabinet cycles ~every 15 min and
  // takes roughly 20-30 min of power cut before the air reaches 8 C at 30 C ambient.
  const P = { tauWall: 6200, tauAL: 1800, tauLoad: 7200, tauDoor: 600, tauComp: 1000,
              tEvap: -10, cutIn: 5.5, cutOut: 2.5, lockSec: 180,
              debounceSec: 300, realertSec: 1800, doorAlertSec: 180 };

  const S = {
    simMs: 0, speed: 10, paused: false, ambient: 30,
    mains: true, door: false,
    Ta: 4.2, Tl: 4.5,                    // cabinet air / food load temperature (deg C)
    compOn: false, compLock: 0,
    unsafeSec: 0,                        // seconds food spent above 8 C
    mcu: { alive: false, booting: false, cmdOff: false, limit: 8,
           tempC: 4.2, adc: 0, adcAvg: 0, volts: 0, ldr: 20, battery: 100,
           aboveSec: 0, alertActive: false, lastAlertMs: 0, doorSec: 0, doorAlerted: false,
           reportedMains: true, mainsDiffSec: 0, lcd: ['', ''], flash: null, activity: 0 },
    gsm: { netUp: true, registered: false, csq: 19, outQ: [], inQ: [], smsIdx: 0 },
    history: [],                         // {t, T, c, m}
  };

  const L = { serial: [], phone: [], result: [], relay: [] };
  const on = (k, fn) => L[k].push(fn);
  const emit = (k, v) => L[k].forEach(fn => fn(v));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rnd = (a, b) => a + Math.random() * (b - a);
  const later = (ms, fn) => setTimeout(fn, ms);

  let msgId = 0;
  const log = (dir, text) => emit('serial', { t: S.simMs, dir, text });

  /* -------------------------- physics -------------------------- */
  function physics(dt) {
    const powered = S.mains && !(S.mcu.alive && S.mcu.cmdOff);
    if (!powered) { S.compOn = false; S.compLock = Math.max(S.compLock, P.lockSec); }
    else if (S.compLock > 0) S.compLock = Math.max(0, S.compLock - dt);
    else if (!S.compOn && S.Ta >= P.cutIn) S.compOn = true;
    if (S.compOn && S.Ta <= P.cutOut) { S.compOn = false; S.compLock = P.lockSec; }

    let dTa = (S.ambient - S.Ta) / P.tauWall + (S.Tl - S.Ta) / P.tauAL;
    if (S.door) dTa += (S.ambient - S.Ta) / P.tauDoor;
    if (S.compOn) dTa += (P.tEvap - S.Ta) / P.tauComp;
    const dTl = (S.Ta - S.Tl) / P.tauLoad;
    S.Ta += dTa * dt;
    S.Tl += dTl * dt;
    if (S.Tl > 8) S.unsafeSec += dt;
  }

  /* ---------------------- Arduino firmware ---------------------- */
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);

  function mcuLoop(dt) {
    const m = S.mcu;
    // backup battery (powers Arduino + SIM800L during a mains cut)
    if (!S.mains) m.battery = Math.max(0, m.battery - dt * 100 / (10 * 3600));
    else if (m.battery < 100) m.battery = Math.min(100, m.battery + dt * 100 / (3 * 3600));
    const powered = S.mains || m.battery > 0;
    if (powered && !m.alive && !m.booting) boot();
    if (!powered && (m.alive || m.booting)) shutdown();
    if (!m.alive) return;

    // LM35: 10 mV/degC, 10-bit ADC on 5 V reference, averaged over 10 samples
    const volts = Math.max(0, S.Ta) * 0.01;
    let sum = 0, last = 0;
    for (let i = 0; i < 10; i++) {
      last = clamp(Math.round(volts / 5 * 1023 + rnd(-1, 1)), 0, 1023);
      sum += last;
    }
    m.adc = last; m.adcAvg = sum / 10; m.volts = m.adcAvg / 1023 * 5; m.tempC = m.adcAvg * 500 / 1023;
    m.ldr = S.door ? Math.round(rnd(860, 910)) : Math.round(rnd(14, 30));   // LDR on A1 senses interior light
    const doorOpen = m.ldr > 500;

    // --- alert logic ---
    if (m.tempC > m.limit) m.aboveSec += dt;
    else if (m.tempC < m.limit - 1) {
      m.aboveSec = 0;
      if (m.alertActive) {
        m.alertActive = false;
        send(NUM.owner, `NORMAL: fridge temp back to ${m.tempC.toFixed(1)}C (limit ${m.limit}C).`, { kind: 'info', label: 'Temperature normal' });
      }
    }
    if (m.aboveSec >= P.debounceSec && (!m.alertActive || S.simMs - m.lastAlertMs >= P.realertSec * 1000)) {
      m.alertActive = true; m.lastAlertMs = S.simMs;
      send(NUM.owner, `ALERT: fridge temp ${m.tempC.toFixed(1)}C exceeds limit ${m.limit}C.${S.mains ? '' : ' Mains is OFF.'} Reply STATUS for details.`,
        { kind: 'alert', label: 'High temperature' });
    }

    if (S.mains !== m.reportedMains) {
      m.mainsDiffSec += dt;
      if (m.mainsDiffSec >= 2) {
        m.reportedMains = S.mains; m.mainsDiffSec = 0;
        if (!S.mains) send(NUM.owner, `POWER FAILURE: mains lost. Fridge is OFF, controller on backup battery (${Math.round(m.battery)}%). Temp ${m.tempC.toFixed(1)}C.`,
          { kind: 'alert', label: 'Power failure' });
        else send(NUM.owner, `POWER RESTORED: mains is back. Fridge restarting (compressor delay 3 min). Temp ${m.tempC.toFixed(1)}C.`,
          { kind: 'info', label: 'Power restored' });
      }
    } else m.mainsDiffSec = 0;

    if (doorOpen) {
      m.doorSec += dt;
      if (m.doorSec >= P.doorAlertSec && !m.doorAlerted) {
        m.doorAlerted = true;
        send(NUM.owner, `WARNING: fridge door open for over ${Math.round(P.doorAlertSec / 60)} min. Temp ${m.tempC.toFixed(1)}C.`, { kind: 'alert', label: 'Door left open' });
      }
    } else { m.doorSec = 0; m.doorAlerted = false; }

    // --- 16x2 LCD ---
    m.lcd[0] = pad(`T:${m.tempC.toFixed(1).padStart(4)}C RLY:${m.cmdOff ? 'OFF' : 'ON'}`, 16);
    m.lcd[1] = m.flash && m.flash.until > performance.now() ? pad(m.flash.text, 16)
      : pad(`GSM:${S.gsm.registered ? 'OK' : '--'} PWR:${S.mains ? 'OK' : 'BAT'}${doorOpen ? ' DOOR' : ''}`, 16);
  }

  const flash = text => { S.mcu.flash = { text, until: performance.now() + 3500 }; };

  let bootTok = 0;
  function boot() {
    const m = S.mcu, tok = ++bootTok;
    m.booting = true;
    m.lcd = ['  FRIDGELINK v1 ', 'INITIALISING... '];
    const step = (ms, fn) => later(ms, () => { if (tok === bootTok) fn(); });
    log('sys', 'Arduino reset. Firmware FridgeLink v1.0');
    step(500, () => { log('tx', 'AT'); step(250, () => { log('rx', 'OK');
      step(300, () => { log('tx', 'AT+CMGF=1'); step(250, () => { log('rx', 'OK');
        step(300, () => { log('tx', 'AT+CNMI=2,1,0,0,0'); step(250, () => { log('rx', 'OK'); registerLoop(); }); }); }); }); }); });

    function registerLoop() {
      m.lcd[1] = pad('GSM REGISTERING', 16);
      log('tx', 'AT+CREG?');
      step(900, () => {
        if (S.gsm.netUp) {
          S.gsm.registered = true;
          log('rx', '+CREG: 0,1'); log('rx', 'OK');
          m.alive = true; m.booting = false; m.reportedMains = S.mains;
          m.lcd = ['  SYSTEM READY  ', pad('GSM:OK', 16)];
          log('sys', 'System ready. Authorised: ' + AUTH.join(', '));
          flushModem();
        } else { log('rx', '+CREG: 0,2'); step(2000, registerLoop); }
      });
    }
  }

  function shutdown() {
    const m = S.mcu;
    bootTok++; m.alive = false; m.booting = false; S.gsm.registered = false;
    m.lcd = ['', ''];
    log('sys', 'Supply lost: controller and GSM module offline (battery empty)');
  }

  /* ----------------------- GSM / SMS layer ----------------------- */
  const netDelay = () => rnd(1100, 2600) * (S.gsm.csq < 14 ? 1.6 : 1);

  // SIM800L -> network -> phone
  function send(to, text, meta = {}) {
    const msg = { id: ++msgId, dir: 'in', kind: meta.kind || 'reply', from: NUM.fridge, to, text, simMs: S.simMs,
                  status: 'delivered', t0: performance.now(), label: meta.label, cause: meta.cause };
    if (!S.gsm.registered) {
      log('tx', `AT+CMGS="${to}"`); log('rx', '+CMS ERROR: 331 (no network service) - queued');
      S.mcu.lcd[1] = pad('NO NETWORK', 16); flash('NO NETWORK'); S.gsm.outQ.push(msg); return;
    }
    transmit(msg);
  }
  function transmit(msg) {
    const m = S.mcu;
    m.activity = performance.now();
    log('tx', `AT+CMGS="${msg.to}"`);
    later(250, () => { log('rx', '> '); log('tx', msg.text.replace(/\n/g, '\\n') + ' <Ctrl-Z>'); });
    later(800, () => { log('rx', `+CMGS: ${msg.id}`); log('rx', 'OK'); flash('SMS SENT'); });
    later(800 + netDelay(), () => {
      msg.simMs = S.simMs;
      emit('phone', { type: 'add', msg });
      const dt = (performance.now() - (msg.cause ? msg.cause.t0 : msg.t0)) / 1000;
      emit('result', { time: S.simMs, kind: msg.cause ? 'Command' : 'Alert', event: msg.cause ? msg.cause.text.trim().toUpperCase() : msg.label,
                       source: msg.cause ? 'Owner' : 'Controller', outcome: 'Delivered', seconds: dt });
    });
  }

  // phone -> SMSC -> SIM800L
  function phoneSend(text) {
    text = text.trim(); if (!text) return;
    const msg = { id: ++msgId, dir: 'out', from: NUM.owner, to: NUM.fridge, text, simMs: S.simMs, status: 'sending', t0: performance.now() };
    emit('phone', { type: 'add', msg });
    later(rnd(500, 1000), () => {
      msg.status = 'sent'; emit('phone', { type: 'update', msg });
      later(netDelay() * 0.6, () => routeToModem(msg));
    });
  }
  function routeToModem(msg) {
    if (S.mcu.alive && S.gsm.registered) modemReceive(msg); else S.gsm.inQ.push(msg);
  }
  function flushModem() {
    const out = S.gsm.outQ.splice(0), inn = S.gsm.inQ.splice(0);
    out.forEach((m, i) => later(i * 1500, () => transmit(m)));
    inn.forEach((m, i) => later(600 + i * 1200, () => routeToModem(m)));
  }

  function modemReceive(msg) {
    const idx = ++S.gsm.smsIdx, m = S.mcu;
    m.activity = performance.now();
    msg.status = 'delivered'; emit('phone', { type: 'update', msg });
    log('rx', `+CMTI: "SM",${idx}`); flash('SMS RECEIVED');
    later(250, () => {
      log('tx', `AT+CMGR=${idx}`);
      log('rx', `+CMGR: "REC UNREAD","${msg.from.replace(/ /g, '')}",,"${stamp()}"`);
      log('rx', msg.text); log('rx', 'OK');
    });
    later(500, () => { log('tx', `AT+CMGD=${idx}`); log('rx', 'OK'); });
    later(650, () => handle(msg));
  }

  const stamp = () => { const d = new Date(S.simMs), p = n => String(n).padStart(2, '0');
    return `${String(d.getFullYear()).slice(2)}/${p(d.getMonth() + 1)}/${p(d.getDate())},${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+04`; };

  function handle(msg) {
    const m = S.mcu;
    if (!AUTH.includes(msg.from)) {
      log('sys', `Rejected SMS from ${msg.from}: number not authorised (ignored, no reply)`);
      emit('result', { time: S.simMs, kind: 'Security', event: msg.text.trim().toUpperCase(), source: msg.from, outcome: 'Ignored (unauthorised)', seconds: null });
      return;
    }
    const cmd = msg.text.trim().toUpperCase().replace(/\s+/g, ' ');
    const t = m.tempC.toFixed(1);
    let reply, ok = true;
    let mm;
    if (cmd === 'STATUS' || cmd === 'TEMP' || cmd === 'STAT') {
      const comp = !S.mains || m.cmdOff ? 'OFF' : S.compOn ? 'RUNNING' : S.compLock > 0 ? 'WAITING' : 'IDLE';
      reply = `FRIDGE STATUS\nTemp: ${t}C (limit ${m.limit}C)\nFridge: ${m.cmdOff ? 'OFF' : 'ON'}\nMains: ${S.mains ? 'OK' : 'FAILED, battery ' + Math.round(m.battery) + '%'}\nCompressor: ${comp}\nDoor: ${m.ldr > 500 ? 'OPEN' : 'CLOSED'}`;
    } else if (cmd === 'ON' || cmd === 'FRIDGE ON') {
      reply = m.cmdOff ? `Fridge switched ON. Temp ${t}C.${S.mains ? '' : ' Note: mains is currently OFF.'}` : 'Fridge is already ON.';
      m.cmdOff = false; emit('relay', true);
    } else if (cmd === 'OFF' || cmd === 'FRIDGE OFF') {
      reply = m.cmdOff ? 'Fridge is already OFF.' : 'Fridge switched OFF. Send ON to restore.';
      m.cmdOff = true; emit('relay', false);
    } else if ((mm = cmd.match(/^LIMIT (\d{1,2})$/)) && +mm[1] >= 2 && +mm[1] <= 15) {
      m.limit = +mm[1]; m.aboveSec = 0; reply = `Alert limit set to ${m.limit}C.`; emit('relay', null);
    } else if (cmd === 'HELP') {
      reply = 'Commands: STATUS, ON, OFF, LIMIT <2-15>, HELP';
    } else { reply = `Unknown command "${msg.text.trim().slice(0, 20)}". Send HELP.`; ok = false; }
    log('sys', `Command "${cmd}" ${ok ? 'executed' : 'not recognised'}`);
    send(msg.from, reply, { kind: 'reply', cause: msg });
  }

  /* ------------------------- main loop ------------------------- */
  let histAcc = 0;
  function advance(sec) {
    while (sec > 0) {
      const dt = Math.min(1, sec);
      physics(dt); mcuLoop(dt);
      S.simMs += dt * 1000; sec -= dt;
      histAcc += dt;
      if (histAcc >= 10) { histAcc = 0; S.history.push({ t: S.simMs, T: S.Ta, c: S.compOn, m: S.mains });
        if (S.history.length > 4400) S.history.shift(); }
    }
    // signal strength random walk
    if (S.gsm.netUp && Math.random() < 0.05) S.gsm.csq = clamp(S.gsm.csq + (Math.random() < 0.5 ? -1 : 1), 9, 27);
  }

  function start() {
    S.simMs = Date.now() - 4 * 3600e3;
    S.mcu.booting = true;                 // hold the controller off during the silent warm-up
    advance(4 * 3600);                    // settled history so the chart isn't empty
    S.mcu.booting = false;
    S.unsafeSec = 0;
    S.mcu.tempC = S.Ta;
    let last = performance.now();
    setInterval(() => {
      const now = performance.now(), real = Math.min(1, (now - last) / 1000); last = now;
      if (!S.paused) advance(real * S.speed);
    }, 100);
  }

  /* --------------------------- controls -------------------------- */
  const setMains = v => { S.mains = v; };
  const setDoor = v => { S.door = v; };
  const setNet = up => {
    if (up === S.gsm.netUp) return;
    S.gsm.netUp = up;
    if (!up) { if (S.mcu.alive) { S.gsm.registered = false; log('rx', '+CREG: 0,0'); log('sys', 'GSM network lost'); } }
    else if (S.mcu.alive) later(2000, () => { if (!S.gsm.netUp) return; S.gsm.registered = true; log('rx', '+CREG: 0,1'); log('sys', 'GSM network restored'); flushModem(); });
  };

  return { S, P, NUM, on, start, phoneSend, setMains, setDoor, setNet,
           setSpeed: v => { S.speed = v; }, setPaused: v => { S.paused = v; },
           setAmbient: v => { S.ambient = v; }, setLimit: v => { S.mcu.limit = v; S.mcu.aboveSec = 0; },
           restock: () => { S.unsafeSec = 0; S.Tl = Math.min(S.Tl, 5); } };
})();
