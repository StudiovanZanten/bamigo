// Spelersomgeving: aanmelden via code/QR, sessie hervatten, antwoorden met echte ontvangstbevestiging.
import { $, $$, esc, LETTERS, prefs, tokenFromHash, api, connect, toast, connBanner, fmtTime, mascot, sound, mediaUrl, ROUND_LABEL } from './common.js';

const app = $('#app');
let token = tokenFromHash('t', 'playerToken');
let conn = null, view = null;
let draft = { qid: null, choice: null, text: '', bet: null, order: null };
let sending = null;       // { qid, status: 'pending'|'error', error }
let lastKey = '';

const ONELINERS = ['Antwoord ontvangen. Je zelfvertrouwen helaas ook.', 'Bewijsmateriaal. Geen verdere vragen.', 'Vastgelegd. Spijt komt later.', 'Genoteerd. De jury fronst alvast.'];

// ---------- menu ----------
$('#menuBtn').onclick = () => { const m = $('#menu'); m.hidden = !m.hidden; $('#menuBtn').setAttribute('aria-expanded', String(!m.hidden)); };
$('#prefFx').checked = prefs.get('fx', true);
$('#prefFx').onchange = e => { prefs.set('fx', e.target.checked); if (e.target.checked) sound.unlock(); };
$('#prefMotion').checked = prefs.get('reduceMotion', false);
$('#prefMotion').onchange = e => { prefs.set('reduceMotion', e.target.checked); document.documentElement.classList.toggle('reduce-motion', e.target.checked); };
$('#logout').onclick = () => {
  if (!confirm('Afmelden op dit apparaat? Je kunt alleen terug met een nieuwe link van de host.')) return;
  prefs.del('playerToken'); location.href = '/speel';
};
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });

// ---------- aanmelden ----------
async function joinScreen(errMsg) {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').toUpperCase();
  app.innerHTML = `
    <div class="center stack" style="margin-top:12px">
      <div class="brand xl" aria-hidden="true" style="font-size:4.5rem">BAMIGO</div>
      <div class="tagline copper">Quizzen &amp; spelavonden</div>
      <div class="tagline">Maak er een avond van.</div>
    </div>
    <form id="codeForm" class="card" style="margin-top:28px">
      ${errMsg ? `<p class="notice bad" role="alert">${esc(errMsg)}</p>` : ''}
      <div class="field"><label for="code">Spelcode</label><input id="code" class="code" autocomplete="off" autocapitalize="characters" maxlength="8" required value="${esc(code)}" inputmode="text"></div>
      <button class="btn primary block big">Verder</button>
    </form>`;
  $('#codeForm').onsubmit = async e => { e.preventDefault(); await lookup($('#code').value.trim()); };
  if (code) lookup(code);
}

async function lookup(code) {
  try {
    const info = await api().get('/api/join/' + encodeURIComponent(code));
    if (info.status === 'finished' || info.status === 'archived') return joinScreen('Deze avond is afgelopen.');
    app.innerHTML = `
      <div class="center"><div class="eyebrow">Welkom bij</div><h1 style="margin-top:8px">${esc(info.name)}</h1>
      ${info.isDemo ? '<span class="demo-badge">Demo</span>' : ''}<p class="muted">${esc(info.subtitle || '')}</p></div>
      <form id="joinForm" class="card">
        <div class="field"><label for="name">Je naam</label>
          <input id="name" required maxlength="40" autocomplete="given-name" list="names">
          <datalist id="names">${info.expectedNames.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
          ${info.expectedNames.length ? '<p class="small muted" style="margin:6px 0 0">Staat je naam al klaar? Kies hem uit de lijst.</p>' : ''}</div>
        ${info.mode === 'teams' && info.selfTeam && info.teams.length ? `<div class="field"><label for="team">Team</label>
          <select id="team"><option value="">Kies later / host deelt in</option>${info.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
          <p class="small muted" style="margin:6px 0 0">Al ingedeeld door de organisatie? Dan geldt die indeling.</p></div>` : ''}
        <p id="joinErr" class="notice bad" role="alert" hidden></p>
        <button class="btn primary block big">Meedoen</button>
      </form>`;
    $('#joinForm').onsubmit = async e => {
      e.preventDefault();
      const btn = e.submitter; btn.disabled = true; btn.textContent = 'Bezig…';
      try {
        const r = await api().post('/api/join', { code, name: $('#name').value, teamId: $('#team')?.value || null });
        token = r.token; prefs.set('playerToken', token);
        history.replaceState(null, '', '/speel');
        sound.unlock(); start();
      } catch (err) { $('#joinErr').hidden = false; $('#joinErr').textContent = err.message; btn.disabled = false; btn.textContent = 'Meedoen'; }
    };
    $('#name').focus();
  } catch (e) { joinScreen(e.message); }
}

// ---------- verbonden ----------
function start() {
  app.innerHTML = '<p class="center muted" style="margin-top:40px">Verbinden…</p>';
  conn = connect({
    kind: 'player', token,
    onState: v => { view = v; render(); },
    onStatus: (s, clock) => {
      const el = $('#status');
      const map = { online: ['ok', 'Verbonden'], synced: ['ok', 'Verbonden'], offline: ['bad', 'Verbinding weg'], reconnecting: ['warn', 'Opnieuw verbinden'], unauthorized: ['bad', 'Sessie ongeldig'] };
      const [cls, txt] = map[s] || ['', s];
      el.className = 'pill ' + cls; el.innerHTML = `<span class="dot"></span>${txt}`;
      connBanner(s === 'synced' ? 'online' : s);
      if (clock.rtt < Infinity) $('#clockInfo').textContent = `Tijd gesynchroniseerd met de server (vertraging ±${Math.round(clock.rtt / 2)} ms).`;
      if (s === 'unauthorized') { prefs.del('playerToken'); token = null; conn.sock.close(); joinScreen('Je sessie is niet meer geldig. Meld je opnieuw aan (of vraag de host om een nieuwe link).'); }
      if (s === 'synced' || s === 'online') retryPending();
    },
  });
}

function render() {
  const v = view; if (!v) return;
  const q = v.question; const L = v.live;
  if (q?.id !== draft.qid) { draft = { qid: q?.id ?? null, choice: null, text: '', bet: null, order: q?.options ? q.options.map((_, i) => i) : null }; sending = null; }
  if (q?.options && !draft.order) draft.order = q.options.map((_, i) => i);
  // Structuursleutel: alleen opnieuw opbouwen als er echt iets verandert (behoudt focus en invoer).
  const key = JSON.stringify([L.screen, L.phase, L.paused, L.seq, q?.id, q?.visible, v.mine, v.me, v.team?.members, sending, v.result && v.result.total, v.scoreboard, L.message]);
  if (key === lastKey) return;
  const focusId = document.activeElement?.id;
  lastKey = key;

  const head = `<div class="who"><div><div class="name">${esc(v.me.name)} ${v.me.isCaptain ? '<span class="badge-captain">Captain</span>' : ''}</div>
    <div class="small muted">${v.me.teamName ? 'Team ' + esc(v.me.teamName) : 'Nog geen team'}${v.event.isDemo ? ' · <span class="demo-badge">Demo</span>' : ''}</div></div>
    <div class="small muted" style="text-align:right">${esc(v.event.name)}</div></div>`;
  let body = '';
  if (L.screen === 'question' && q) body = questionScreen(v, q);
  else if (L.screen === 'round_intro') body = `<div class="center stack"><span class="tag">${esc(ROUND_LABEL[L.round?.kind] || 'Ronde')}</span><h1>${esc(L.round?.title || '')}</h1>
    <p>${esc(L.round?.instructions || '')}</p><div class="host-mascot" style="margin:0 auto">${mascot('welkom')}</div></div>`;
  else if (L.screen === 'scoreboard' || L.screen === 'finale') body = boardScreen(v);
  else if (L.screen === 'break') body = `<div class="center stack"><h1>Pauze</h1><p class="muted">${esc(L.message || 'Even bijtanken. Daarna: VAMOSSS!')}</p></div>`;
  else body = lobbyScreen(v);
  app.innerHTML = head + body + (L.paused ? `<div class="paused" role="alertdialog" aria-label="Gepauzeerd"><div><h1>Gepauzeerd</h1><p class="muted">De host heeft het spel even stilgezet. De tijd staat stil.</p></div></div>` : '');
  bind(v, q);
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  tick();
}

function lobbyScreen(v) {
  const t = v.team;
  return `<div class="center stack" style="margin:10px 0 20px"><div class="host-mascot" style="margin:0 auto">${mascot('welkom')}</div>
    <h2>Je bent binnen.</h2><p class="muted">Kijk naar de tv. De host start zo.</p></div>
    ${t ? `<section class="card"><h3>${esc(t.name)}</h3><ul class="list team-list">${t.members.map(m => `<li><span class="dot ${m.online ? 'on' : ''}" aria-hidden="true"></span>
      <span>${esc(m.name)}</span>${m.isCaptain ? '<span class="badge-captain">Captain</span>' : ''}<span class="small muted" style="margin-left:auto">${m.online ? 'online' : 'offline'}</span>
      ${v.me.isCaptain && !m.isCaptain ? `<button class="btn ghost small" data-captain="${m.id}">Maak captain</button>` : ''}</li>`).join('')}</ul>
      <p class="small muted" style="margin:10px 0 0">Bij teamvragen stuurt alleen de captain het definitieve antwoord in.</p></section>` : `<p class="notice">Je bent nog niet ingedeeld. De host zet je in een team.</p>`}`;
}

function timerHtml(L) {
  if (!L.deadline) return '';
  return `<div class="timer-row"><div class="timerbar" aria-hidden="true"><i data-bar></i></div><div class="timer" data-timer role="timer" aria-live="off">--:--</div></div>`;
}

function questionScreen(v, q) {
  const L = v.live;
  const tag = `<div class="row" style="justify-content:space-between"><span class="tag">${esc(ROUND_LABEL[L.round?.kind] || L.round?.title || 'Vraag')}</span>
    <span class="small muted">Vraag ${q.number}/${q.of} · ${q.scope === 'team' ? 'Teamvraag' : 'Individueel'}${q.isExample ? ' · <span class="example-badge">Voorbeeld</span>' : ''}</span></div>`;
  if (L.phase === 'ready') return `${tag}<div class="center stack" style="margin-top:30px"><h2>Maak je klaar</h2>
    <p class="muted">${q.scoring === 'speed' ? 'Bliksemvraag: sneller goed = meer punten. De eerste tik telt.' : q.scope === 'team' ? (v.me.isCaptain ? 'Jij stuurt het teamantwoord in.' : 'Overleg met je team; de captain stuurt in.') : 'Iedereen antwoordt zelf.'}</p></div>`;
  if (L.phase === 'open' && !q.visible) return `${tag}<div class="countdown" data-countdown aria-live="assertive">3</div><p class="center muted">De vraag verschijnt tegelijk voor iedereen.</p>`;

  let out = tag + `<div class="qprompt">${esc(q.prompt)}</div>`;
  if (q.quote) out += `<div class="quote" style="margin-bottom:16px">${esc(q.quote)}</div>`;
  if (q.media) out += `<div data-media="${q.media.id}" style="margin-bottom:16px"></div>`;
  if (L.phase === 'open') out += timerHtml(L) + '<div style="height:14px"></div>';

  const mine = v.mine;
  const revealed = ['revealed', 'scored'].includes(L.phase);
  const canAnswer = L.phase === 'open' && !mine && (q.scope === 'individual' || v.me.isCaptain) && !(sending?.status === 'pending');
  const notCaptain = q.scope === 'team' && !v.me.isCaptain;

  if (q.type === 'mc' || q.type === 'tf') {
    const chosen = mine ? mine.answer : draft.choice;
    const correct = revealed ? [].concat(v.result?.correct) : [];
    out += `<div class="choices" role="group" aria-label="Antwoorden">${q.options.map((o, i) => {
      const cls = revealed ? (correct.includes(i) ? 'correct' : chosen === i ? 'wrong' : '') : '';
      const mark = revealed && correct.includes(i) ? '✓ Juist' : chosen === i ? (mine ? '✓ Ingestuurd' : '● Gekozen') : '';
      return `<button class="choice ${cls}" data-choice="${i}" aria-pressed="${chosen === i}" ${canAnswer ? '' : 'disabled'}><span class="letter">${LETTERS[i]}.</span><span>${esc(o)}</span><span class="mark">${mark}</span></button>`;
    }).join('')}</div>`;
  } else if (q.type === 'open' || q.type === 'number') {
    const val = mine ? mine.answer : draft.text;
    out += `<div class="field"><label for="ans">${q.type === 'number' ? 'Jouw getal' : 'Jouw antwoord'}</label>
      <input id="ans" ${q.type === 'number' ? 'inputmode="decimal"' : 'autocomplete="off" maxlength="200"'} value="${esc(val ?? '')}" ${canAnswer ? '' : 'disabled'}></div>`;
    if (revealed) out += `<p class="notice ok">Juiste antwoord: <b>${esc(v.result?.correct)}</b></p>`;
  } else if (q.type === 'order') {
    const ord = mine ? mine.answer : draft.order;
    out += `<p class="small muted">Zet in de juiste volgorde (boven = eerst).</p><div class="choices">${ord.map((oi, pos) => `<div class="order-item">
      <button class="choice" disabled><span class="letter">${pos + 1}.</span><span>${esc(q.options[oi])}</span></button>
      ${canAnswer ? `<button class="btn ghost small mv" data-up="${pos}" aria-label="Omhoog: ${esc(q.options[oi])}" ${pos === 0 ? 'disabled' : ''}>↑</button>` : ''}</div>`).join('')}</div>`;
    if (revealed) out += `<p class="notice ok">Juiste volgorde: ${[].concat(v.result?.correct).map(i => esc(q.options[i])).join(' → ')}</p>`;
  }

  if (q.allowBet && canAnswer && q.scope === 'team') out += `<div style="margin-top:16px"><label>Inzet (optioneel): goed = erbij, fout = eraf</label>
    <div class="bets">${[0, 1, 2, 3].map(b => `<button class="choice" data-bet="${b}" aria-pressed="${(draft.bet ?? 0) === b}">${b === 0 ? 'Geen' : '+' + b}</button>`).join('')}</div></div>`;

  // status / ontvangstbevestiging
  if (mine) {
    out += `<div class="receipt" style="margin-top:16px" role="status"><span aria-hidden="true">✓</span><span>Ontvangen door de server${q.scoring === 'speed' ? ` na ${(mine.elapsedMs / 1000).toFixed(2)} s` : ''}${mine.by && q.scope === 'team' ? ` · door ${esc(mine.by)}` : ''}${mine.bet ? ` · inzet ${mine.bet}` : ''}.</span></div>`;
    if (!revealed && view.event && sending?.oneliner) out += `<p class="small muted" style="margin-top:8px">${esc(sending.oneliner)}</p>`;
  } else if (sending?.status === 'pending') out += `<div class="receipt pending" style="margin-top:16px" role="status">Versturen… nog niet bevestigd.</div>`;
  else if (sending?.status === 'error') out += `<div class="receipt err" style="margin-top:16px" role="alert">${esc(sending.error)}</div>`;

  if (L.phase === 'open' && !mine) {
    if (notCaptain) out += `<p class="notice" style="margin-top:16px">Captain <b>${esc(v.team?.members.find(m => m.isCaptain)?.name || '')}</b> stuurt jullie antwoord in.</p>`;
    else if (q.scoring !== 'speed' && sending?.status !== 'pending') out += `<button id="submitBtn" class="btn primary block big" style="margin-top:16px" ${hasDraft(q) ? '' : 'disabled'}>Antwoord insturen</button>`;
  }
  if (L.phase === 'closed') out += `<p class="center muted" style="margin-top:16px">${mine ? 'Tijd is om. Wachten op de onthulling…' : 'Tijd is om. Geen antwoord ontvangen.'}</p>`;
  if (revealed) {
    const verdict = mine?.verdict;
    out += `<div class="center" style="margin-top:20px"><div class="host-mascot" style="margin:0 auto 6px">${mascot(verdict === 'correct' ? 'goed' : mine ? 'fout' : 'denken')}</div>
      <div class="verdict ${verdict === 'correct' ? 'ok' : 'no'}">${!mine ? 'Geen antwoord' : verdict === 'correct' ? 'Goed!' : verdict === 'review' ? 'Host beoordeelt…' : verdict == null ? 'Beoordeling volgt' : 'Helaas'}</div>
      ${mine?.points != null ? `<p>${mine.points > 0 ? '+' : ''}${mine.points} punten</p>` : ''}
      ${v.result?.explanation ? `<p class="muted small">${esc(v.result.explanation)}</p>` : ''}
      ${v.result?.fastest?.length ? `<p class="small">Snelst goed: ${v.result.fastest.map(f => `${esc(f.name)} (${f.seconds.toFixed(2)} s)`).join(', ')}</p>` : ''}</div>`;
  }
  return out;
}

const hasDraft = q => (q.type === 'mc' || q.type === 'tf') ? draft.choice !== null : (q.type === 'order' ? true : String(draft.text).trim() !== '');

function boardScreen(v) {
  const sb = v.scoreboard; if (!sb) return '';
  return `<h1 class="center">${v.live.screen === 'finale' ? 'Eindstand' : 'Tussenstand'}</h1>
    <table class="board"><thead><tr><th>#</th><th>Team</th><th style="text-align:right">Punten</th></tr></thead><tbody>
    ${sb.teams.map(t => `<tr class="${t.id === v.me.teamId ? 'me' : ''}"><td class="pos">${t.rank}</td><td>${esc(t.name)}${t.id === v.me.teamId ? ' <span class="small muted">(jullie)</span>' : ''}</td><td class="pts">${t.points}</td></tr>`).join('')}
    </tbody></table>
    ${sb.me && sb.me.points > 0 ? `<p class="center" style="margin-top:16px">Snelste Bamigo: jij staat <b>#${sb.me.rank}</b> van ${sb.me.of} met ${sb.me.points} punten.</p>` : ''}`;
}

function bind(v, q) {
  $$('[data-captain]').forEach(b => b.onclick = async () => {
    if (!confirm('Captainrol overdragen? Daarna stuurt die speler de teamantwoorden in.')) return;
    try { await api({ 'x-player-token': token }).post('/api/player/captain', { participantId: b.dataset.captain }); toast('Captain overgedragen.'); }
    catch (e) { toast(e.message, 'bad'); }
  });
  if (!q) return;
  $$('[data-choice]').forEach(b => b.onclick = () => {
    const i = Number(b.dataset.choice);
    if (q.scoring === 'speed') { draft.choice = i; send(q, i); return; }
    draft.choice = i; lastKey = ''; render();
  });
  $$('[data-bet]').forEach(b => b.onclick = () => { draft.bet = Number(b.dataset.bet) || null; lastKey = ''; render(); });
  $$('[data-up]').forEach(b => b.onclick = () => { const p = Number(b.dataset.up); const o = draft.order; [o[p - 1], o[p]] = [o[p], o[p - 1]]; lastKey = ''; render(); });
  const ans = $('#ans'); if (ans) ans.oninput = () => { draft.text = ans.value; const sb = $('#submitBtn'); if (sb) sb.disabled = !ans.value.trim(); };
  if (ans) ans.onkeydown = e => { if (e.key === 'Enter' && ans.value.trim()) $('#submitBtn')?.click(); };
  const sb = $('#submitBtn'); if (sb) sb.onclick = () => {
    const a = q.type === 'mc' || q.type === 'tf' ? draft.choice : q.type === 'order' ? draft.order : draft.text;
    send(q, a);
  };
  const md = $('[data-media]'); if (md) mediaUrl(md.dataset.media, { 'x-player-token': token }).then(u => { if (u) md.innerHTML = `<img src="${u}" alt="Afbeelding bij de vraag" style="max-width:100%;border-radius:6px">`; });
}

/** Verstuur via socket met ack. Pas "ontvangen" tonen na bevestiging van de server. Bij time-out: opnieuw (server is idempotent). */
function send(q, answer) {
  if (sending?.status === 'pending') return;
  const payload = { questionId: q.id, answer, bet: draft.bet || undefined, clientId: Math.random().toString(36).slice(2) };
  sending = { qid: q.id, status: 'pending', payload, tries: 0 };
  lastKey = ''; render();
  attempt();
}
function attempt() {
  const s = sending; if (!s || s.status !== 'pending') return;
  s.tries++;
  conn.sock.timeout(4000).emit('submit', s.payload, (err, r) => {
    if (sending !== s) return;
    if (err) { if (s.tries < 4 && conn.sock.connected) return attempt(); s.status = 'error'; s.error = 'Nog geen bevestiging van de server. Controleer je verbinding; we proberen opnieuw zodra je weer online bent.'; s.retry = true; lastKey = ''; render(); return; }
    if (r.ok) {
      s.status = 'done'; s.oneliner = ONELINERS[Math.floor(Math.random() * ONELINERS.length)];
      if (view.event && !r.duplicate) sound.good();
      conn.sock.emit('refresh', null, v => { if (v) { view = v; lastKey = ''; render(); } });
    } else { s.status = 'error'; s.error = r.error; lastKey = ''; render(); }
  });
}
function retryPending() { if (sending?.retry && sending.status === 'error') { sending.status = 'pending'; sending.retry = false; sending.tries = 0; attempt(); } }

// ---------- timer ----------
let lastSec = null, cdRefreshed = null;
function tick() {
  const v = view; if (!v || !conn) return;
  const now = conn.now(); const L = v.live;
  const cd = $('[data-countdown]');
  if (cd && L.openAt) { const s = Math.ceil((L.openAt - now) / 1000); cd.textContent = s > 0 ? s : 'Nu!'; if (s <= 0 && !v.question?.visible && cdRefreshed !== v.question?.id) { cdRefreshed = v.question?.id; conn.sock.emit('refresh', null, nv => { if (nv) { view = nv; render(); } }); } }
  const tEl = $('[data-timer]'), bar = $('[data-bar]');
  if (tEl && L.deadline) {
    const ref = L.paused ? L.pausedAt : now;
    const left = L.deadline - ref; tEl.textContent = fmtTime(left);
    const total = L.deadline - L.openAt; if (bar) bar.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
    const sec = Math.ceil(left / 1000); if (sec !== lastSec && sec <= 5 && sec > 0 && !L.paused) sound.tick(); lastSec = sec;
  }
}
setInterval(tick, 200);

if (token) start(); else joinScreen();
