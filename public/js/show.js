// BAMIGO tv-spelshow: lichtbundels, overgangen (stingers), confetti en trillen. Gedeeld door tv en telefoon.
// Alles respecteert "Minder beweging" (systeem of eigen instelling).
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('reduce-motion');

/** Achtergrond met bewegende spots (tv) of een rustige gloed (telefoon). */
export function initShow(kind = 'tv') {
  if (document.querySelector('.show-bg')) return;
  const bg = document.createElement('div');
  bg.className = 'show-bg show-' + kind; bg.setAttribute('aria-hidden', 'true');
  bg.innerHTML = kind === 'tv' ? '<i class="beam b1"></i><i class="beam b2"></i><i class="beam b3"></i><i class="floor"></i>' : '<i class="glow"></i>';
  document.body.prepend(bg); document.body.classList.add('has-show');
}

/** Lichtkleur van de spots: 'calm' | 'live' (vraag open) | 'hot' (laatste seconden) | 'party' (finale). */
export function showMood(mood) { document.body.dataset.mood = mood; }

/** Overgang: een koperen wipe met het B.-blokje. 'round' is groot (nieuwe ronde), 'q' kort (nieuwe vraag). */
export function stinger(type = 'q', label = '') {
  if (reduce()) return;
  document.querySelectorAll('.stinger').forEach(e => e.remove());
  const el = document.createElement('div');
  el.className = 'stinger st-' + type; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<i class="w1"></i><i class="w2"></i>${type === 'round' ? `<span class="st-mark">B<b></b></span>${label ? `<span class="st-label">${label}</span>` : ''}` : ''}`;
  document.body.append(el);
  setTimeout(() => el.remove(), type === 'round' ? 1700 : 900);
}

/** Confetti in huisstijlkleuren. amount ~ 80 (klein) tot 300 (finale). */
export function confetti(amount = 120, { duration = 2600 } = {}) {
  if (reduce()) return;
  const c = document.createElement('canvas'); c.className = 'confetti'; c.setAttribute('aria-hidden', 'true');
  document.body.append(c);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = c.width = innerWidth * dpr, H = c.height = innerHeight * dpr;
  const ctx = c.getContext('2d');
  const cols = ['#BF5B2C', '#E0814F', '#F4E8CF', '#C4AD83', '#7FB77E'];
  const ps = Array.from({ length: amount }, (_, i) => ({
    x: W * (i % 2 ? 0.15 : 0.85) + (Math.random() - .5) * W * .2, y: H * .55,
    vx: (i % 2 ? 1 : -1) * (2 + Math.random() * 9) * dpr, vy: -(10 + Math.random() * 14) * dpr,
    s: (5 + Math.random() * 7) * dpr, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[i % cols.length], sq: Math.random() < .5,
  }));
  const t0 = performance.now();
  const frame = t => {
    const k = (t - t0) / duration; ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.vy += .35 * dpr; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - Math.max(0, k - .7) / .3); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      if (p.sq) ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s); else ctx.fillRect(-p.s / 2, -p.s / 5, p.s, p.s / 2.5);
      ctx.restore();
    }
    if (k < 1) requestAnimationFrame(frame); else c.remove();
  };
  requestAnimationFrame(frame);
}

/** Korte tril op telefoons (Android; iPhone negeert dit). */
export function buzz(pattern = 30) { try { if (!reduce()) navigator.vibrate?.(pattern); } catch { } }
