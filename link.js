'use strict';
/* Transport between the fridge page and the phone page.
   - Served by server.js (http): Server-Sent Events + POST relay, works across devices.
   - Otherwise (file:// or static hosting): BroadcastChannel, works between tabs of the same browser. */
const Link = (() => {
  function open(room, role, onMsg, onState) {
    const cid = Math.random().toString(36).slice(2, 12);
    let mode = 'none', bc = null;

    function useLocal() {
      mode = 'local';
      bc = new BroadcastChannel('fridgelink-' + room);
      bc.onmessage = e => { if (e.data.cid !== cid) onMsg(e.data.m); };
      onState({ mode, up: true });
    }

    function send(m) {
      if (mode === 'relay') {
        fetch(`send?room=${encodeURIComponent(room)}&cid=${cid}`, { method: 'POST', body: JSON.stringify(m), headers: { 'Content-Type': 'text/plain' }, keepalive: true })
          .catch(() => onState({ mode, up: false }));
      } else if (bc) bc.postMessage({ cid, m });
    }

    if (location.protocol === 'http:' || location.protocol === 'https:') {
      const es = new EventSource(`events?room=${encodeURIComponent(room)}&role=${role}&cid=${cid}`);
      const giveUp = setTimeout(() => { if (mode === 'none') { es.close(); useLocal(); } }, 3000);
      es.addEventListener('hello', () => { clearTimeout(giveUp); mode = 'relay'; onState({ mode, up: true }); });
      es.onmessage = e => { try { onMsg(JSON.parse(e.data)); } catch (err) {} };
      es.onerror = () => { if (mode === 'relay') onState({ mode, up: false }); };
    } else useLocal();

    return { send, get mode() { return mode; } };
  }
  return { open };
})();
