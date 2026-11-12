// De BAMIGO Envelop: op tv één voor één openen, gesynchroniseerd op de serverklok.
import { esc, sound } from './common.js';

const START = 1500, D = 6500, OPEN = 2200, SHOW = 4200;
const ord = n => (n == null ? '?' : n + 'e');

/** Fase-sleutel voor een moment (alleen opnieuw tekenen als die verandert). */
export function envelopeKey(data, elapsed) {
  if (elapsed < START) return 'intro';
  let t = elapsed - START;
  for (const [i, r] of data.list.entries()) {
    const d = D + (r.last && r.pledge ? 6000 : 0); // belofte van de laatste plek krijgt extra leestijd
    if (t < d) return `${i}:${t < OPEN ? 0 : t < SHOW ? 1 : 2}`;
    t -= d;
  }
  return 'done';
}

export function envelopeHtml(data, key) {
  const list = data.list;
  if (key === 'intro') return `<div class="env-wrap"><div class="tag">Uitslag</div><h1 class="env-title">De BAMIGO Envelop</h1>
    <p class="intro-sub" style="margin:0 auto">Aan het begin van de avond voorspelde elk team zijn eindplek. Verzegeld. Tot nu.</p>${envelopeSvg(false)}</div>`;
  if (key === 'done') return `<div class="env-wrap"><h1 class="env-title">Bonus bijgeschreven</h1>
    <table class="board env-table"><thead><tr><th>Team</th><th>Voorspeld</th><th>Werd</th><th></th></tr></thead><tbody>${list.slice().reverse().map(r => `<tr class="${r.hit ? 'hit' : ''}">
      <td>${esc(r.name)}</td><td>${r.predicted ? ord(r.predicted) : '—'}</td><td>${ord(r.rank)}</td><td>${r.hit ? `+${r.bonus} bonus` : ''}</td></tr>`).join('')}</tbody></table>
    ${data.host ? `<p class="intro-sub env-host">${esc(data.host.name)} voorspelde: ${data.host.rows.map(r => `<b class="${r.rank === r.predicted ? 'ok' : ''}">${r.predicted}. ${esc(r.name)}</b>`).join(' · ')} <span>(${data.host.hits} van ${data.host.rows.length} goed)</span></p>` : ''}
    ${list.filter(r => r.last && r.pledge).map(r => `<p class="env-host"><b>Belofte van ${esc(r.name)}:</b> ${esc(r.pledge)}</p>`).join('')}
    <p class="env-next">Nu: de definitieve eindstand. VAMOSSS!</p></div>`;
  const [i, sub] = key.split(':').map(Number);
  const r = list[i];
  const done = list.slice(0, i);
  const line = sub === 0 ? `<p class="env-line">opent de envelop…</p>`
    : sub === 1 ? `<p class="env-line">voorspelde…</p><div class="env-big">${r.predicted ? `plek ${r.predicted}` : 'niks (geen envelop!)'}</div>`
    : `<p class="env-line">voorspelde plek ${r.predicted ?? '—'}… en werd</p><div class="env-big ${r.hit ? 'hit' : 'miss'}">${ord(r.rank)}!</div>
       <div class="env-verdict ${r.hit ? 'hit' : ''}">${r.hit ? `Precies goed: +${r.bonus} bonuspunten` : 'Mis. Helaas, pindakaas.'}</div>
       ${r.last && r.pledge ? `<div class="env-pledge"><span>Laatste plek. Jullie beloofden: “Als wij laatste worden, dan…”</span><b>${esc(r.pledge)}</b></div>` : ''}`;
  return `<div class="env-wrap"><div class="env-card ${sub ? 'open' : ''}">${envelopeSvg(sub > 0)}<h2 class="env-team">${esc(r.name)}</h2>${line}</div>
    ${done.length ? `<div class="env-done">${done.map(d => `<span class="${d.hit ? 'hit' : ''}">${esc(d.name)}: ${d.predicted ?? '—'} → ${ord(d.rank)}${d.hit ? ' ✓' : ''}</span>`).join('')}</div>` : ''}</div>`;
}

export function envelopeSound(key) {
  if (key.endsWith(':0')) sound.open();
  else if (key.endsWith(':1')) sound.tick();
  else if (key.endsWith(':2')) sound.good();
}

export function envelopeSvg(open) {
  return `<svg class="env-svg ${open ? 'open' : ''}" viewBox="0 0 120 80" aria-hidden="true">
    <rect x="2" y="2" width="116" height="76" rx="6" fill="#F4E8CF" stroke="#C4AD83" stroke-width="2"/>
    <path d="M2 8 L60 46 L118 8" fill="none" stroke="#C4AD83" stroke-width="2"/>
    <path class="flap" d="M2 4 L60 44 L118 4 Z" fill="#E9D9B6" stroke="#C4AD83" stroke-width="2"/>
    <circle class="seal" cx="60" cy="44" r="9" fill="#BF5B2C"/><text class="seal" x="60" y="48" text-anchor="middle" font-family="Anton, Impact, sans-serif" font-size="11" fill="#F4E8CF">B</text>
  </svg>`;
}
