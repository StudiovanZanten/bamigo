// TV-/presentatiescherm. Krijgt alleen de display-view: nooit antwoorden vóór de onthulling.
import { $, esc, LETTERS, tokenFromHash, connect, connBanner, fmtTime, mascot, sound, mediaUrl, ROUND_LABEL } from './common.js';

const stage = $('#stage');
const token = tokenFromHash('k', 'displayToken');
let conn, view, lastKey = '', prevScreen = null;

if (!token) stage.innerHTML = `<div class="stage-body center"><div class="brand xl">BAMIGO</div><p>Open dit scherm via de tv-link uit het beheer.</p></div>`;
else conn = connect({ kind: 'staff', token, onState: v => { if (v.kind !== 'display') { stage.innerHTML = '<p>Deze link is geen tv-link.</p>'; return; } view = v; render(); }, onStatus: s => connBanner(s === 'synced' ? 'online' : s) });

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
  const key = JSON.stringify([L.screen, L.phase, L.paused, L.seq, q?.visible, v.counts, v.result?.total, v.teams, v.scoreboard]);
  if (key === lastKey) return; lastKey = key;
  let body = '';
  if (L.screen === 'lobby') body = lobby(v);
  else if (L.screen === 'round_intro') body = intro(v);
  else if (L.screen === 'question' && q) body = question(v, q);
  else if (L.screen === 'scoreboard' || L.screen === 'finale') body = board(v);
  else if (L.screen === 'break') body = `<div class="stage-body center fade-in"><div class="tag">Pauze</div><h1 class="intro-title">Even bijtanken.</h1><p class="intro-sub" style="margin:0 auto">${esc(L.message || 'Daarna gaan we verder. VAMOSSS!')}</p></div>`;
  else body = `<div class="stage-body center"><div class="brand xl">BAMIGO</div></div>`;
  stage.innerHTML = head(v) + body + foot(v) + (L.paused ? '<div class="tv-paused"><div class="center"><h1>Gepauzeerd</h1><p class="intro-sub" style="margin:0 auto">De tijd staat stil.</p></div></div>' : '');
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
  if (revealed) {
    const r = v.result || {};
    const ans = q.type === 'open' || q.type === 'number' ? `<div class="quote" style="max-width:none;display:inline-block">Antwoord: ${esc(r.correct)}</div>` : q.type === 'order' ? `<div class="quote" style="max-width:none">${[].concat(r.correct).map(i => esc(q.options[i])).join(' → ')}</div>` : '';
    reveal = `<div class="q-row" style="margin-top:1.4vw">${ans}<div class="counter">${r.correctCount}/${r.total} goed</div>
      ${r.fastest?.length ? `<div class="counter">Snelst: ${r.fastest.map(f => `${esc(f.name)} ${f.seconds.toFixed(2)}s`).join(' · ')}</div>` : ''}
      ${r.answers ? `<div class="counter">${r.answers.map(a => `${esc(a.name)}: ${esc(a.value)}`).join(' · ')}</div>` : ''}</div>
      ${r.explanation ? `<p class="intro-sub" style="font-size:1.5vw;margin-top:1vw">${esc(r.explanation)}</p>` : ''}`;
  }
  const len = (q.prompt || '').length;
  return `<div class="stage-body ${revealed ? 'revealed' : ''}">${tag}
    <div class="q-row"><div style="flex:1"><h1 class="q ${len > 90 ? 'xlong' : len > 50 ? 'long' : ''}">${esc(q.prompt)}</h1>${q.quote ? `<div class="quote">${esc(q.quote)}</div>` : ''}${q.media ? `<div data-media="${q.media.id}"></div>` : ''}</div>${right}
    ${revealed ? `<div class="host-mascot">${mascot(v.result?.correctCount ? 'goed' : 'verrast')}</div>` : ''}</div>
    ${opts}${reveal}${dots}</div>`;
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
function tick() {
  if (!view || !conn) return;
  const L = view.live; const now = conn.now();
  const cd = $('[data-countdown]'); if (cd && L.openAt) { const s = Math.ceil((L.openAt - now) / 1000); cd.textContent = s > 0 ? s : '!'; }
  const t = $('[data-timer]');
  if (t && L.deadline) { const left = L.deadline - (L.paused ? L.pausedAt : now); t.textContent = fmtTime(left); const s = Math.ceil(left / 1000); if (s !== lastSec && s <= 5 && s > 0 && !L.paused) sound.tick(); lastSec = s; }
}
setInterval(tick, 200);
