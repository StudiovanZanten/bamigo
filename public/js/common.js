// Gedeelde helpers voor speler, tv en beheer.
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const LETTERS = 'ABCDEFGHIJKL';

// ---------- voorkeuren (alleen lokaal; nooit scores of gedeelde data) ----------
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem('bamigo.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bamigo.' + k, JSON.stringify(v)); } catch { /* privémodus */ } },
  del(k) { try { localStorage.removeItem('bamigo.' + k); } catch { } },
};
if (prefs.get('reduceMotion', false)) document.documentElement.classList.add('reduce-motion');

/** Token uit #k=… of #t=… halen en uit de adresbalk verwijderen (komt niet in logs/geschiedenis). */
export function tokenFromHash(key, storeKey) {
  const m = location.hash.match(new RegExp('[#&]' + key + '=([^&]+)'));
  if (m) {
    const t = decodeURIComponent(m[1]);
    prefs.set(storeKey, t);
    history.replaceState(null, '', location.pathname + location.search);
    return t;
  }
  return prefs.get(storeKey, null);
}

// ---------- API ----------
export function api(headers) {
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) { const e = new Error(data?.error || 'Er ging iets mis'); e.status = res.status; e.code = data?.code; throw e; }
    return data;
  };
  return { get: u => call('GET', u), post: (u, b = {}) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
}

// ---------- realtime ----------
/**
 * Verbind met de server. Na elke (her)verbinding stuurt de server een volledige, actuele state.
 * Houdt ook de klokafwijking bij (servertijd − lokale tijd) via ping/pong met kleinste RTT.
 */
export function connect({ kind, token, onState, onStatus }) {
  const sock = window.io({ auth: { kind, token }, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 4000 });
  const clock = { offset: 0, rtt: Infinity, samples: [] };
  const sync = () => {
    for (let i = 0; i < 5; i++) setTimeout(() => {
      const t0 = Date.now();
      sock.timeout(3000).emit('time', t0, (err, r) => {
        if (err || !r) return;
        const t1 = Date.now(); const rtt = t1 - t0;
        clock.samples.push({ rtt, offset: r.now - (t0 + rtt / 2) });
        clock.samples = clock.samples.slice(-10);
        const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        clock.offset = best.offset; clock.rtt = best.rtt;
        onStatus?.('synced', clock);
      });
    }, i * 150);
  };
  sock.on('connect', () => { onStatus?.('online', clock); sync(); });
  sock.on('disconnect', () => onStatus?.('offline', clock));
  sock.on('connect_error', e => onStatus?.(e.message === 'unauthorized' ? 'unauthorized' : 'offline', clock));
  sock.io.on('reconnect_attempt', () => onStatus?.('reconnecting', clock));
  sock.on('state', v => { if (v.serverNow && clock.rtt === Infinity) clock.offset = v.serverNow - Date.now(); onState(v); });
  setInterval(sync, 30000);
  return { sock, clock, now: () => Date.now() + clock.offset };
}

// ---------- UI ----------
let toastEl;
export function toast(msg, kind = '') {
  toastEl ??= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts', role: 'status' });
  toastEl.setAttribute('aria-live', 'polite');
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
  toastEl.appendChild(t); setTimeout(() => t.remove(), 3500);
}

export function connBanner(status) {
  let el = $('#conn');
  if (!el) { el = document.createElement('div'); el.id = 'conn'; el.className = 'conn'; el.setAttribute('role', 'status'); document.body.prepend(el); }
  const msg = { offline: 'Verbinding weg — we proberen opnieuw…', reconnecting: 'Opnieuw verbinden…', unauthorized: 'Deze link is niet (meer) geldig.' }[status];
  el.hidden = !msg; if (msg) el.textContent = msg;
}

export const fmtTime = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

/** Haalt beveiligde media op met header-token en geeft een blob-URL terug. */
const mediaCache = new Map();
export async function mediaUrl(id, headers) {
  if (mediaCache.has(id)) return mediaCache.get(id);
  const r = await fetch('/api/media/' + id, { headers });
  if (!r.ok) return null;
  const u = URL.createObjectURL(await r.blob()); mediaCache.set(id, u); return u;
}

// ---------- mascotte: de BAMIGO-host (eenvoudige vectorversie, 6 toestanden) ----------
export function mascot(state = 'welkom') {
  const mouth = {
    welkom: 'M38 70 Q50 80 64 68', denken: 'M40 72 L60 70', goed: 'M36 66 Q50 84 66 66 Z', fout: 'M40 74 Q50 66 62 74',
    verrast: 'M46 70 a5 6 0 1 0 10 0 a5 6 0 1 0 -10 0', feest: 'M34 64 Q50 88 68 64 Z',
  }[state] || 'M38 70 Q50 80 64 68';
  const brow = { denken: 'M32 44 L44 40 M56 42 L68 44', fout: 'M32 40 L44 44 M56 44 L68 40', verrast: 'M32 38 Q38 34 44 38 M56 38 Q62 34 68 38' }[state] || 'M32 42 Q38 38 44 41 M56 40 Q62 37 68 41';
  const fill = ['goed', 'feest'].includes(state) ? '#151515' : 'none';
  return `<svg viewBox="0 0 100 100" role="img" aria-label="BAMIGO-host: ${state}">
    <circle cx="50" cy="50" r="48" fill="#232323" stroke="#BF5B2C" stroke-width="2"/>
    <path d="M14 100 Q18 80 34 78 L50 92 L66 78 Q82 80 86 100 Z" fill="#1b1b1b" stroke="#3a3631"/>
    <path d="M40 80 L50 92 L60 80 L56 100 L44 100 Z" fill="#BF5B2C"/>
    <ellipse cx="50" cy="54" rx="22" ry="26" fill="#E8C9A6"/>
    <path d="M27 50 Q24 22 50 20 Q78 20 74 48 Q70 34 60 32 Q66 26 52 28 Q40 30 36 36 Q30 40 27 50 Z" fill="#2b211c"/>
    <path d="${brow}" stroke="#2b211c" stroke-width="2.5" fill="none" stroke-linecap="round"/>
    <circle cx="39" cy="50" r="2.6" fill="#151515"/><circle cx="61" cy="50" r="2.6" fill="#151515"/>
    <path d="${mouth}" stroke="#151515" stroke-width="2.5" fill="${fill}" stroke-linecap="round"/>
    ${state === 'feest' ? '<path d="M8 20 l6 4 M90 16 l-5 6 M6 60 l7 -2 M92 58 l-7 -1" stroke="#C4AD83" stroke-width="2"/>' : ''}
  </svg>`;
}

// ---------- geluid: alleen na bewuste actie, muziek en effecten apart ----------
export const sound = {
  ctx: null,
  enabled: () => prefs.get('fx', true),
  unlock() { try { this.ctx ??= new (window.AudioContext || window.webkitAudioContext)(); this.ctx.resume(); } catch { } },
  beep(freq = 660, ms = 120, type = 'sine', vol = 0.15) {
    if (!this.enabled() || !this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g).connect(this.ctx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + ms / 1000); o.stop(this.ctx.currentTime + ms / 1000 + 0.02);
  },
  tick() { this.beep(880, 60, 'square', 0.05); },
  good() { this.beep(660, 120); setTimeout(() => this.beep(990, 180), 120); },
  open() { this.beep(523, 90); setTimeout(() => this.beep(784, 140), 90); },
};

export const ROUND_LABEL = { quiz: 'Algemene kennis', brocode: 'De Bro Code', ranking: 'Ranking de Boys', kompaan: 'Ken je kompaan', shots: 'Shot in het duister', missions: 'Zoek, pak & bewijs',
  dragons: 'BAMIGO Dragons', search: 'Zoek, pak & bewijs', bluff: 'Bluffen & inzetten', lightning: 'Bliksemronde', final: 'Finale', break: 'Pauze', intro: 'BAMIGO' };
export const TYPE_LABEL = { mc: 'Meerkeuze', tf: 'Waar/niet waar', open: 'Open antwoord', number: 'Getal / schatting', order: 'Volgorde', match: 'Koppelen', ranking: 'Ranking de Boys (voorspel)', shot: 'Shot in het duister', invest: 'Dragons-investering', envelope: 'De BAMIGO Envelop' };
