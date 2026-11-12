// TV-/presentatiescherm. Krijgt alleen de display-view: nooit antwoorden vóór de onthulling.
import { $, esc, LETTERS, tokenFromHash, connect, connBanner, fmtTime, mascot, sound, mediaUrl, ROUND_LABEL } from './common.js';
import { rouletteDriver } from './roulette.js';
import { envelopeKey, envelopeHtml, envelopeSound } from './envelope.js';

const stage = $('#stage');
const token = tokenFromHash('k', 'displayToken');
let conn, view, lastKey = '', prevScreen = null;
const roul = rouletteDriver({ now: () => conn.now(), kind: 'tv' });

if (!token) stage.innerHTML = `<div class="stage-body center"><div class="brand xl">BAMIGO</div><p>Open dit scherm via de tv-link uit het beheer.</p></div>`;
else conn = connect({ kind: 'staff', token, onState: v => { if (v.kind !== 'display') { stage.innerHTML = '<p>Deze link is geen tv-link.</p>'; return; } view = v; roul.set(v.live.roulette); render(); }, onStatus: s => connBanner(s === 'synced' ? 'online' : s) });

$('#startBtn').onclick = async () => {
  sound.unlock();
  try { await document.documentElement.requestFullscreen?.(); } catch { }
  $('#tvControls').hidden = true;
};
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('#tvControls').hidden = false; });

const head = v => `<div class="stage-head"><span class="brand">BAMIGO</span><span class="counter">${v.event.isDemo ? '<span class="demo-badge">Demo</span> ' : ''}${esc(v.event.name)}</span></div>`;
const foot = v => `<div class="stage-foot">${v.teams.length} teams. Alles op het spel.</div>`;

function render() {
  const v = view; const L = v.live; const q = v.question;
  const key = JSON.stringify([L.screen, L.phase, L.paused, L.seq, q?.visible, v.counts, v.result?.total, v.teams, v.scoreboard, q?.career?.clues?.length]);
  if (key === lastKey) return; lastKey = key;
  let body = '';
  if (L.screen === 'lobby') body = lobby(v);
  else if (L.screen === 'round_intro') body = intro(v);
  else if (L.screen === 'question' && q) body = question(v, q);
  else if (L.screen === 'scoreboard' || L.screen === 'finale') body = board(v);
  else if (L.screen === 'shots_reveal') body = shotsReveal(v);
  else if (L.screen === 'envelopes') { body = '<div class="stage-body env-stage" data-env></div>'; envKey = ''; }
  else if (L.screen === 'break') body = `<div class="stage-body center fade-in"><div class="tag">Pauze</div><h1 class="intro-title">Even bijtanken.</h1><p class="intro-sub" style="margin:0 auto">${esc(L.message || 'Daarna gaan we verder. VAMOSSS!')}</p></div>`;
  else body = `<div class="stage-body center"><div class="brand xl">BAMIGO</div></div>`;
  const banner = L.banner?.type === 'captain' && L.screen === 'question' ? `<div class="tv-banner fade-in">${L.banner.changes.map(c => `<div><span class="tag">Kapitein overboord!</span><h2>${esc(c.to)} neemt het roer over</h2><p>${esc(c.team)} · ${esc(c.from)} had 3x op rij fout</p></div>`).join('')}</div>` : '';
  stage.innerHTML = head(v) + body + banner + foot(v) + (L.paused ? '<div class="tv-paused"><div class="center"><h1>Gepauzeerd</h1><p class="intro-sub" style="margin:0 auto">De tijd staat stil.</p></div></div>' : '');
  if (L.screen !== prevScreen && L.screen === 'question' && L.phase === 'open') sound.open();
  prevScreen = L.screen;
  const md = $('[data-media]'); if (md) mediaUrl(md.dataset.media, { 'x-staff-token': token }).then(u => { if (u) md.innerHTML = `<img src="${u}" alt="" style="max-height:40vh;max-width:100%;border-radius:6px">`; });
  tick();
}

function lobby(v) {
  const n = v.teams.reduce((a, t) => a + t.joined, 0), total = v.teams.reduce((a, t) => a + t.size, 0);
  return `<div class="stage-body"><div class="lobby fade-in">
    <div><div class="brand xl">BAMIGO</div><div class="tagline copper" style="font-size:1.6vw;margin-top:1vw">Quizzen &amp; spelavonden</div>
      <div class="tagline" style="font-size:1.6vw;margin-top:.6vw">Maak er een avond van.</div>
      <div class="teams-grid">${v.teams.map(t => `<div class="team-card"><h3>${esc(t.name)}</h3><div class="m">${t.members.map(m => m.online ? `<b>${esc(m.name)}</b>` : esc(m.name)).join(' · ') || 'nog leeg'}</div></div>`).join('')}</div>
      <p class="counter" style="margin-top:1.4vw">${n} van ${total || '?'} spelers aangemeld</p></div>
    <div class="center"><div class="qr" style="margin:0 auto"><img src="/api/qr.svg?code=${encodeURIComponent(v.joinCode)}" alt="QR-code om mee te doen"></div>
      <p class="url" style="margin-top:1.4vw">Scan of ga naar <b>${esc(v.joinUrl.replace(/^https?:\/\//, '').replace(/\?code=.*/, ''))}</b> met code</p>
      <div class="code">${esc(v.joinCode)}</div></div>
  </div></div>`;
}

function intro(v) {
  const r = v.live.round || {};
  const vamos = r.kind === 'intro' || r.kind === 'final' || prevScreen === 'break';
  return `<div class="stage-body fade-in"><div class="q-row" style="justify-content:space-between">
    <div><span class="tag">${esc(ROUND_LABEL[r.kind] || 'Ronde')}</span><h1 class="intro-title">${esc(r.title || '')}</h1>
    <p class="intro-sub">${esc(r.instructions || '')}</p>${r.supplies ? `<p class="counter">Nodig: ${esc(r.supplies)}</p>` : ''}</div>
    <div class="center"><div class="host-mascot">${mascot(vamos ? 'feest' : 'welkom')}</div>${vamos ? '<div class="speech">VAMOSSS!</div>' : ''}</div></div></div>`;
}

function question(v, q) {
  const L = v.live; const revealed = ['revealed', 'scored'].includes(L.phase);
  const dots = `<div class="progress-dots" style="margin-top:1.5vw">${Array.from({ length: q.of }, (_, i) => `<i class="${i < q.number ? 'on' : ''}"></i>`).join('')}</div>`;
  const tag = `<div><span class="tag">${esc(ROUND_LABEL[L.round?.kind] || L.round?.title || '')}</span> ${q.isExample ? '<span class="example-badge">Voorbeeldvraag</span>' : ''}</div>`;
  if (L.phase === 'ready') return `<div class="stage-body fade-in">${tag}<h1 class="q">Vraag ${q.number}</h1><p class="intro-sub">${q.scoring === 'speed' ? 'Bliksemvraag — iedereen op eigen telefoon. Sneller goed = meer punten.' : q.scope === 'team' ? 'Teamvraag — de captain stuurt in.' : 'Iedereen antwoordt zelf.'}</p>${dots}</div>`;
  if (L.phase === 'open' && !q.visible) return `<div class="stage-body center">${tag}<div class="timer" data-countdown style="font-size:16vw">3</div><p class="intro-sub" style="margin:0 auto">Klaar voor de start…</p></div>`;
  const correct = revealed ? [].concat(v.result?.correct) : [];
  const dist = v.result?.distribution; const max = dist ? Math.max(1, ...dist) : 1;
  const opts = q.options && (q.type === 'mc' || q.type === 'tf') ? `<div class="tv-options">${q.options.map((o, i) => `<div class="tv-opt ${revealed ? (correct.includes(i) ? 'correct' : 'dim') : ''}">
      <span class="letter">${LETTERS[i]}.</span><span>${esc(o)}</span>${revealed && dist ? `<span class="cnt">${dist[i]}</span><span class="bar" style="width:${(dist[i] / max) * 100}%"></span>` : ''}</div>`).join('')}</div>` : '';
  const right = L.phase === 'open' ? `<div class="divider"></div><div class="center"><div class="timer" data-timer>--:--</div><div class="counter" style="margin-top:.6vw">${v.counts ? `${v.counts.submitted}/${v.counts.expected} ${q.scope === 'team' ? 'teams' : 'spelers'} ingestuurd` : ''}</div></div>`
    : L.phase === 'closed' ? `<div class="divider"></div><div class="center"><div class="timer">00:00</div><div class="counter">Tijd is om · ${v.counts?.submitted ?? 0} antwoorden</div></div>` : '';
  let reveal = '';
  const r0 = v.result || {};
  const eur = n => '€' + Number(n).toLocaleString('nl-NL');
  if (q.type === 'shot') reveal = `<p class="intro-sub">Allergenen shot ${q.shotNumber}: <b>${esc(q.allergens)}</b> · Proeven is vrijwillig.</p>${L.phase === 'closed' ? '<p class="counter">Vastgezet. De onthulling volgt na het laatste shot.</p>' : ''}`;
  if (q.type === 'ranking' && !revealed) reveal = `<p class="intro-sub">${q.top > 1 ? `Teams voorspellen op de telefoon de top ${q.top} van de groep.` : 'Teams voorspellen op de telefoon wie de groep het vaakst koos.'}</p>`;
  if (q.type === 'envelope') reveal = `<p class="intro-sub">Captains: op welke plek eindigt jullie team? Je voorspelling gaat verzegeld de envelop in. Pas bij de uitslag gaat hij open. Precies goed = bonuspunten.</p>${L.phase === 'closed' ? '<p class="counter">Verzegeld. Tot de uitslag!</p>' : ''}`;
  if (q.pitch && !revealed) reveal = `<p class="intro-sub">${q.pitch.team ? `Pitch door <b>${esc(q.pitch.team.name)}</b>. ` : ''}Alle andere teams${v.live ? '' : ''} bieden geheim uit hun resterende budget. De totalen blijven geheim tot na de laatste pitch.</p>`;
  else if (q.type === 'invest' && !revealed) reveal = `<p class="intro-sub">Verdeel ${eur(q.budget)} fictief over de andere teams. Alles blijft geheim tot de onthulling.</p>`;
  if (q.career) reveal = careerTv(q, L, r0, revealed);
  if (q.kompaan && !revealed) reveal = '<p class="intro-sub">Ken je kompaan: de aangewezen teamgenoten antwoorden ieder zelf. Niet overleggen!</p>';
  if (revealed && r0.pitchHidden) reveal = `<p class="intro-sub">Biedingen binnen. Nog ${r0.pitchesLeft} pitch${r0.pitchesLeft === 1 ? '' : 'es'} te gaan. Wie haalt het meeste op? Dat blijft nog even geheim.</p>`;
  else if (revealed && q.career) { /* al gezet */ }
  else if (revealed && (r0.ranking || r0.invest || r0.kompaan)) {
    if (r0.ranking?.topN) reveal = r0.ranking.skipped ? '<p class="intro-sub">Geen geldige stemmen: deze vraag vervalt.</p>' : `<div class="tv-podium">${r0.ranking.top.filter(x => x.winner).slice().reverse().map((x, i) => `<div class="pod pod-${x.rank}" style="animation-delay:${i * 0.9}s"><span class="r">${x.rank}</span><span class="n">${esc(x.name)}</span><span class="v">${x.votes} ${x.votes === 1 ? 'stem' : 'stemmen'}</span></div>`).join('')}</div>`;
    else if (r0.ranking) reveal = r0.ranking.skipped ? '<p class="intro-sub">Geen geldige stemmen: deze vraag vervalt.</p>' : bars(r0.ranking.top.map(x => ({ label: x.name + (x.winner ? '  🏆' : ''), value: x.votes, hl: x.winner })), x => x + (x === 1 ? ' stem' : ' stemmen'));
    if (r0.invest) reveal = bars(r0.invest.map((x, i) => ({ label: x.name, value: x.total, hl: i === 0 })), eur);
    if (r0.kompaan) reveal = `<table class="board" style="margin-top:1vw"><tbody>${r0.kompaan.map(k => `<tr><td>${esc(k.team)}</td>${k.answers.map(a => `<td>${esc(a.name)}: <b>${esc(a.answer == null ? '—' : (q.options && (q.type === 'mc' || q.type === 'tf')) ? q.options[a.answer] : a.answer)}</b></td>`).join('')}<td class="pts">${k.match ? '✓' : '✗'}</td></tr>`).join('')}</tbody></table>`;
  } else if (revealed) {
    const r = v.result || {};
    const ans = (q.type === 'open' || q.type === 'number') && r.correct != null ? `<div class="ans-box"><small>Antwoord</small><b>${esc(r.correct)}</b></div>` : q.type === 'order' ? `<div class="ans-box"><small>Goede volgorde</small><b class="seq">${[].concat(r.correct).map(i => esc(q.options[i])).join(' <i>→</i> ')}</b></div>` : '';
    reveal = `<div class="ans-row">${ans}<div class="ans-side"><div class="ans-score"><b>${r.correctCount}/${r.total}</b> goed</div>
      ${r.fastest?.length ? `<div class="ans-chips">${r.fastest.map(f => `<span>⚡ ${esc(f.name)} <b>${f.seconds.toFixed(2)}s</b></span>`).join('')}</div>` : ''}
      ${r.answers ? `<div class="ans-chips">${r.answers.map(a => `<span>${esc(a.name)} <b>${esc(a.value)}</b></span>`).join('')}</div>` : ''}</div></div>
      ${r.explanation ? `<p class="intro-sub" style="font-size:1.5vw;margin-top:1vw">${esc(r.explanation)}</p>` : ''}`;
  }
  const len = (q.prompt || '').length;
  return `<div class="stage-body ${revealed ? 'revealed' : ''}">${tag}
    <div class="q-row"><div style="flex:1"><h1 class="q ${len > 90 ? 'xlong' : len > 50 ? 'long' : ''}">${esc(q.prompt)}</h1>${q.quote ? `<div class="quote">${esc(q.quote)}</div>` : ''}${q.media ? `<div data-media="${q.media.id}"></div>` : ''}</div>${right}
    ${revealed && !q.career ? `<div class="host-mascot">${mascot(v.result?.correctCount ? 'goed' : 'verrast')}</div>` : ''}</div>
    ${opts}${reveal}${dots}</div>`;
}

/** Van wie is deze carrière? Hints als een cv dat zich regel voor regel vult; daarna de onthulling. */
function careerTv(q, L, r0, revealed) {
  const c = q.career; const all = revealed && r0.career ? r0.career.clues : c.clues;
  const rows = Array.from({ length: c.total }, (_, i) => {
    const txt = all[i]; const last = !revealed && i === c.clues.length - 1;
    return `<li class="cv-row ${txt ? 'on' : ''} ${last ? 'new' : ''}"><span class="cv-n">${i + 1}</span><span class="cv-t">${txt ? esc(txt) : 'Nog geheim'}</span><span class="cv-p">${c.scale?.[i] ?? ''} pt</span></li>`;
  }).join('');
  const who = revealed && r0.career ? `<div><div class="cv-who"><span>Dit is de carrière van</span><b>${esc(r0.career.name || '?')}</b></div>
    <table class="board cv-board"><tbody>${r0.career.teams.map(t => `<tr class="${t.correct && !t.own ? 'hit' : ''}"><td>${esc(t.team)}</td><td>${t.pick ? esc(t.pick) : '—'}</td><td>${t.clue ? `bij hint ${t.clue}` : ''}</td><td class="pts">${t.own ? '<span class="cv-own">eigen team</span>' : t.correct ? '+' + t.points : ''}</td></tr>`).join('')}</tbody></table></div>` : '';
  const sub = revealed ? '' : `<p class="counter">${c.auto ? `Elke ${c.auto} seconden een nieuwe hint.` : 'De quizmaster geeft de hints.'} Hoe eerder jullie vastzetten, hoe meer punten. Eén keer kiezen!</p>`;
  return `<div class="cv ${revealed ? 'done' : ''}"><ol class="cv-list">${rows}</ol>${who}</div>${sub}`;
}

function board(v) {
  const sb = v.scoreboard; const fin = v.live.screen === 'finale';
  const ind = sb.individuals.filter(p => p.points > 0);
  return `<div class="stage-body fade-in"><div class="q-row" style="align-items:flex-start">
    <div style="flex:1.4"><span class="tag">${fin ? 'Eindstand' : 'Tussenstand'}</span>
      <table class="board" style="margin-top:1.4vw"><tbody>${sb.teams.map(t => `<tr><td class="pos">${t.rank}</td><td>${esc(t.name)}</td><td class="pts">${t.points}</td></tr>`).join('')}</tbody></table></div>
    ${ind.length ? `<div style="flex:1"><span class="tag">Snelste Bamigo</span><table class="board" style="margin-top:1.4vw"><tbody>${ind.slice(0, 5).map(p => `<tr><td class="pos">${p.rank}</td><td>${esc(p.name)}</td><td class="pts">${p.points}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${fin ? `<div class="center"><div class="host-mascot">${mascot('feest')}</div><div class="speech">VAMOSSS!</div></div>` : ''}</div></div>`;
}

let lastSec = null;
let envKey = '';
function envTick() {
  const v = view; const el = $('[data-env]');
  if (!v || !el || !v.live.envelopes) return;
  const k = envelopeKey(v.live.envelopes, conn.now() - v.live.envelopes.openedAt);
  if (k === envKey) return;
  if (envKey) envelopeSound(k);
  envKey = k; el.innerHTML = envelopeHtml(v.live.envelopes, k);
}
setInterval(envTick, 200);

function tick() {
  envTick();
  if (!view || !conn) return;
  const L = view.live; const now = conn.now();
  const cd = $('[data-countdown]'); if (cd && L.openAt) { const s = Math.ceil((L.openAt - now) / 1000); cd.textContent = s > 0 ? s : '!'; }
  const t = $('[data-timer]');
  if (t && L.deadline) { const left = L.deadline - (L.paused ? L.pausedAt : now); t.textContent = fmtTime(left); const s = Math.ceil(left / 1000); if (s !== lastSec && s <= 5 && s > 0 && !L.paused) sound.tick(); lastSec = s; }
}
setInterval(tick, 200);

function bars(items, fmt) {
  const max = Math.max(1, ...items.map(i => i.value));
  return `<div style="margin-top:1.4vw;display:grid;gap:.8vw">${items.map(i => `<div style="display:grid;grid-template-columns:22vw 1fr 10vw;align-items:center;gap:1vw;font-size:2vw">
    <span style="${i.hl ? 'color:var(--ivory);font-weight:700' : 'color:var(--champagne)'}">${esc(i.label)}</span>
    <span style="height:2vw;background:var(--raised-2);border-radius:3px;overflow:hidden"><i style="display:block;height:100%;width:${(i.value / max) * 100}%;background:${i.hl ? 'var(--copper)' : 'var(--champagne)'}"></i></span>
    <span class="display" style="text-align:right">${fmt(i.value)}</span></div>`).join('')}</div>`;
}

function shotsReveal(v) {
  const d = v.shotsReveal || { shots: [], points: [] };
  return `<div class="stage-body fade-in"><div class="q-row" style="justify-content:space-between"><div><span class="tag">Shot in het duister</span><h1 class="q" style="margin:1vw 0;white-space:nowrap;max-width:none">De onthulling</h1></div>
    <div class="center"><div class="host-mascot" style="width:10vw;height:10vw">${mascot('verrast')}</div><div class="speech">VAMOSSS!</div></div></div>
    <div style="display:grid;grid-template-columns:repeat(${Math.min(5, d.shots.length || 1)},1fr);gap:1vw">${d.shots.map(s => `<div class="team-card"><div class="counter">Shot ${s.number}</div><h3>${esc(s.team)}</h3>
      <div style="font-size:1.3vw;font-weight:600">${esc(s.name || '')}</div><div class="m">${esc(s.flavor || '')} · ${esc(s.base || '')}</div>${s.story ? `<p style="font-size:1.1vw;margin:.6vw 0 0;color:var(--champagne)">“${esc(s.story)}”</p>` : ''}</div>`).join('')}</div>
    <div class="counter" style="margin-top:1.6vw">Punten deze ronde</div>
    <div style="display:flex;gap:1vw;flex-wrap:wrap;margin-top:.6vw">${d.points.map(p => `<div class="team-card" style="padding:.6vw 1.2vw;display:flex;gap:1vw;align-items:baseline"><span style="font-size:1.5vw">${esc(p.name)}</span><span class="display copper-text" style="font-size:2.4vw">${p.points}</span></div>`).join('')}</div></div>`;
}
