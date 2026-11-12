// BAMIGO Shot-roulette: hetzelfde schouwspel op tv en telefoons, gesynchroniseerd op de serverklok.
import { esc, sound } from './common.js';

const INTRO = 2600, SPIN = 7000, END = INTRO + SPIN, HIDE = END + 30000, STEPS = 36, COUNT = 5;

export function rouletteDriver({ now, meId = () => null, kind = 'phone' }) {
  let r = null, el = null, raf = 0, lastStep = -1, lastCount = -1, lastPhase = '';

  function mount() {
    if (el) return;
    el = document.createElement('div');
    el.className = 'roulette ' + kind; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-label', 'BAMIGO Shot-roulette');
    document.body.appendChild(el);
  }
  function unmount() { cancelAnimationFrame(raf); raf = 0; el?.remove(); el = null; lastPhase = ''; lastStep = -1; lastCount = -1; }

  function frame() {
    raf = 0;
    if (!r) return unmount();
    const e = now() - r.at;
    if (e > HIDE) return unmount();
    mount();
    const names = r.names.length ? r.names : [r.winner.name];
    if (e < INTRO) {
      if (lastPhase !== 'intro') {
        lastPhase = 'intro';
        el.innerHTML = `<div class="rl-in"><div class="rl-kicker">BAMIGOOO</div><div class="rl-title">SHOTSS</div><div class="rl-sub">Wie is de Lul!?</div></div>`;
        sound.open();
      }
    } else if (e < END) {
      const x = (e - INTRO) / SPIN, p = 1 - Math.pow(1 - x, 3), step = Math.min(STEPS, Math.floor(p * STEPS));
      const w = Math.max(0, names.indexOf(r.winner.name));
      const name = names[(((w - STEPS + step) % names.length) + names.length) % names.length];
      const count = Math.max(1, Math.ceil((END - e) / (SPIN / COUNT)));
      if (lastPhase !== 'spin') {
        lastPhase = 'spin';
        el.innerHTML = `<div class="rl-in"><div class="rl-kicker">Wie is de Lul!?</div><div class="rl-name" data-n></div><div class="rl-count" data-c></div></div>`;
      }
      if (step !== lastStep) { lastStep = step; el.querySelector('[data-n]').textContent = name; sound.tick(); }
      if (count !== lastCount) { lastCount = count; const c = el.querySelector('[data-c]'); c.textContent = count; c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
    } else if (lastPhase !== 'win') {
      lastPhase = 'win';
      const mine = meId() && meId() === r.winner.id;
      el.innerHTML = `<div class="rl-in win"><div class="rl-kicker">${mine ? 'JIJ BENT HET!' : 'Gefeliciteerd'}</div>
        <div class="rl-name">${esc(r.winner.name)}</div>${r.winner.team && kind === 'tv' ? `<div class="rl-team">${esc(r.winner.team)}</div>` : ''}
        <div class="rl-sub">${mine ? 'Gefeliciteerd, je bent de winnaar van de shots!' : 'Je bent de winnaar van de shots!'}</div>
        <div class="rl-task">${esc(r.task)}</div><div class="rl-vamos">VAMOSSS!</div></div>`;
      if (mine && navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
      sound.good(); setTimeout(() => sound.good(), 260);
    }
    raf = requestAnimationFrame(frame);
  }

  return {
    set(next) {
      if (!next) { r = null; unmount(); return; }
      if (r?.id !== next.id) { unmount(); r = next; }
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
}
