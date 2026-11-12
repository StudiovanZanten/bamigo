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
  if (q?.id !== draft.qid) { draft = { qid: q?.id ?? null, choice: null, text: '', bet: null, order: q?.options ? q.options.map((_, i) => i) : null, shot: { flavor: '', base: '', teamId: '' }, invest: {} }; sending = null; }
  if (q?.options && !draft.order) draft.order = q.options.map((_, i) => i);
  // Structuursleutel: alleen opnieuw opbouwen als er echt iets verandert (behoudt focus en invoer).
  const key = JSON.stringify([L.screen, L.phase, L.paused, L.seq, q?.id, q?.visible, v.mine, v.me, v.team?.members, sending, v.result && v.result.total, v.scoreboard, L.message]);
  renderPrep(v);
  if (key === lastKey) return;
  const focusId = document.activeElement?.id;
  lastKey = key;

  const head = `<div class="who"><span class="avatar" aria-hidden="true">${esc((v.me.name || '?').slice(0, 1).toUpperCase())}</span>
    <div class="grow"><div class="name">${esc(v.me.name)}</div>
    <div class="small muted">${v.me.teamName ? esc(v.me.teamName) : 'Nog geen team'}</div></div>
    ${v.me.isCaptain ? '<span class="badge-captain">Captain</span>' : ''}${v.event.isDemo ? '<span class="demo-badge">Demo</span>' : ''}</div>`;
  let body = '';
  if (L.screen === 'question' && q) body = questionScreen(v, q);
  else if (L.screen === 'round_intro') body = `<div class="center stack"><span class="tag">${esc(ROUND_LABEL[L.round?.kind] || 'Ronde')}</span><h1>${esc(L.round?.title || '')}</h1>
    <p>${esc(L.round?.instructions || '')}</p><div class="host-mascot" style="margin:0 auto">${mascot('welkom')}</div></div>`;
  else if (L.screen === 'scoreboard' || L.screen === 'finale') body = boardScreen(v);
  else if (L.screen === 'shots_reveal') body = shotsRevealScreen(v);
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
    <h2>Je bent binnen</h2><p class="muted">Kijk naar de tv. De quiz begint zo.</p></div>
    ${t ? `<section class="card"><h3>${esc(t.name)}</h3><ul class="list team-list">${t.members.map(m => `<li><span class="dot ${m.online ? 'on' : ''}" aria-hidden="true"></span>
      <span>${esc(m.name)}</span>${m.isCaptain ? '<span class="badge-captain">Captain</span>' : ''}<span class="small muted" style="margin-left:auto">${m.online ? 'online' : 'offline'}</span>
      ${v.me.isCaptain && !m.isCaptain ? `<button class="btn ghost small" data-captain="${m.id}">Maak captain</button>` : ''}</li>`).join('')}</ul>
      <p class="small muted" style="margin:10px 0 0">Bij teamvragen tikt de captain het antwoord in.</p></section>` : `<p class="notice">Je bent nog niet ingedeeld. De host zet je in een team.</p>`}`;
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

  if (q.kompaan && v.kompaan) {
    const inPair = v.kompaan.pair.some(p => p.id === v.me.id);
    out += `<p class="notice small">${inPair ? `Ken je kompaan: antwoord zonder te overleggen. Daarna vergelijken we op tv.` : `Deze vraag zit jij over: <b>${v.kompaan.pair.map(p => esc(p.name)).join('</b> en <b>')}</b> antwoorden. Jij mag meekijken (en zwijgen).`}</p>`;
    if (!inPair) return out + (['revealed', 'scored'].includes(L.phase) ? revealExtra(v, q) : '');
  }
  if (q.type === 'shot') return out + shotQuestion(v, q, mine, canAnswer, notCaptain);
  if (q.type === 'invest') return out + investQuestion(v, q, mine, canAnswer, notCaptain);
  if (q.type === 'ranking') {
    const chosen = mine ? mine.answer : draft.choice;
    out += `<div class="choices" role="group" aria-label="Kies een naam">${q.candidates.map(c => `<button class="choice" data-cand="${c.id}" aria-pressed="${chosen === c.id}" ${canAnswer ? '' : 'disabled'}><span>${esc(c.name)}</span><span class="mark">${chosen === c.id ? (mine ? '✓ Ingestuurd' : '● Gekozen') : ''}</span></button>`).join('')}</div>`;
  } else if (q.type === 'mc' || q.type === 'tf') {
    const chosen = mine ? mine.answer : draft.choice;
    const correct = revealed ? [].concat(v.result?.correct) : [];
    out += `<div class="choices" role="group" aria-label="Antwoorden">${q.options.map((o, i) => {
      const cls = revealed ? (correct.includes(i) ? 'correct' : chosen === i ? 'wrong' : '') : '';
      const mark = revealed && correct.includes(i) ? '✓ Juist' : chosen === i ? (mine ? '✓ Ingestuurd' : '● Gekozen') : '';
      return `<button class="choice ${cls}" data-choice="${i}" aria-pressed="${chosen === i}" ${canAnswer ? '' : 'disabled'}><span class="letter">${LETTERS[i]}</span><span>${esc(o)}</span><span class="mark">${mark}</span></button>`;
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
      ${v.result?.explanation ? `<p class="muted small">${esc(v.result.explanation)}</p>` : ''}${revealExtra(v, q)}
      ${v.result?.fastest?.length ? `<p class="small">Snelst goed: ${v.result.fastest.map(f => `${esc(f.name)} (${f.seconds.toFixed(2)} s)`).join(', ')}</p>` : ''}</div>`;
  }
  return out;
}

const hasDraft = q => (['mc', 'tf', 'ranking'].includes(q.type)) ? draft.choice !== null : (q.type === 'order' ? true : String(draft.text).trim() !== '');

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
  $$('[data-cand]').forEach(b => b.onclick = () => { draft.choice = b.dataset.cand; lastKey = ''; render(); });
  bindShot(q); bindInvest(q);
  $$('[data-bet]').forEach(b => b.onclick = () => { draft.bet = Number(b.dataset.bet) || null; lastKey = ''; render(); });
  $$('[data-up]').forEach(b => b.onclick = () => { const p = Number(b.dataset.up); const o = draft.order; [o[p - 1], o[p]] = [o[p], o[p - 1]]; lastKey = ''; render(); });
  const ans = $('#ans'); if (ans) ans.oninput = () => { draft.text = ans.value; const sb = $('#submitBtn'); if (sb) sb.disabled = !ans.value.trim(); };
  if (ans) ans.onkeydown = e => { if (e.key === 'Enter' && ans.value.trim()) $('#submitBtn')?.click(); };
  const sb = $('#submitBtn'); if (sb) sb.onclick = () => {
    const a = ['mc', 'tf', 'ranking'].includes(q.type) ? draft.choice : q.type === 'order' ? draft.order : draft.text;
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


// ---------- spelvormen ----------
function shotQuestion(v, q, mine, canAnswer, notCaptain) {
  let out = `<p class="notice warn small">Allergenen shot ${q.shotNumber}: <b>${esc(q.allergens)}</b>. Proeven is vrijwillig.</p>`;
  if (v.ownShot) return out + `<div class="center stack" style="margin-top:20px"><h2>Dit is jullie shot.</h2><p class="muted">Proost. Op je eigen shot scoor je niet; houd je pokerface.</p></div>`;
  const a = mine ? mine.answer : draft.shot;
  const dis = canAnswer ? '' : 'disabled';
  out += `<div class="field"><label for="shF">Hoofdsmaak</label><input id="shF" maxlength="100" value="${esc(a.flavor || '')}" ${dis}></div>
    <div class="field"><label for="shB">Basisdrank (of “geen alcohol”)</label><input id="shB" maxlength="100" value="${esc(a.base || '')}" ${dis}></div>
    <div class="field"><label for="shT">Van welk team?</label><select id="shT" ${dis}><option value="">— kies —</option>${q.teams.filter(t => t.id !== v.me.teamId).map(t => `<option value="${t.id}" ${a.teamId === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    <p class="small muted">Elk onderdeel 1 punt. Je mag hetzelfde team vaker noemen. Herkomst en verhalen komen pas na het laatste shot.</p>`;
  if (v.live.phase === 'open' && !mine && !notCaptain) out += `<button id="shotSubmit" class="btn primary block big">Antwoord vastzetten</button>`;
  if (mine) out += `<div class="receipt" role="status">✓ Vastgezet en ontvangen. Onthulling na het laatste shot.</div>`;
  if (sending?.status === 'pending') out += `<div class="receipt pending" role="status">Versturen… nog niet bevestigd.</div>`;
  if (sending?.status === 'error') out += `<div class="receipt err" role="alert">${esc(sending.error)}</div>`;
  if (v.live.phase === 'open' && !mine && notCaptain) out += `<p class="notice">De captain zet jullie antwoord vast.</p>`;
  return out;
}
function bindShot(q) {
  const b = $('#shotSubmit'); if (!b) return;
  ['shF', 'shB'].forEach((id, i) => $('#' + id).oninput = e => { draft.shot[i ? 'base' : 'flavor'] = e.target.value; });
  $('#shT').onchange = e => { draft.shot.teamId = e.target.value; };
  b.onclick = () => send(q, { ...draft.shot });
}

function investQuestion(v, q, mine, canAnswer, notCaptain) {
  const alloc = mine ? mine.answer : draft.invest;
  const total = Object.values(alloc).reduce((a, b) => a + b, 0);
  const left = q.budget - total;
  const eur = n => '€' + Number(n).toLocaleString('nl-NL');
  let out = `<p class="muted small">Fictief geld. Niet in je eigen team. Precies ${eur(q.budget)} verdelen, in stappen van ${eur(q.step)}. Alles blijft geheim tot de onthulling.</p>
    <ul class="list">${q.teams.filter(t => t.id !== v.me.teamId).map(t => `<li><span class="grow" style="flex:1">${esc(t.name)}</span>
      ${canAnswer ? `<button class="btn ghost small" data-inv="${t.id}" data-d="-1" aria-label="Minder voor ${esc(t.name)}">−</button>` : ''}
      <b style="min-width:90px;text-align:right">${eur(alloc[t.id] || 0)}</b>
      ${canAnswer ? `<button class="btn ghost small" data-inv="${t.id}" data-d="1" aria-label="Meer voor ${esc(t.name)}">+</button>` : ''}</li>`).join('')}</ul>
    <p class="center" style="margin-top:10px">${mine ? '' : left === 0 ? '<b>Budget verdeeld.</b>' : `Nog te verdelen: <b>${eur(left)}</b>`}</p>`;
  if (v.live.phase === 'open' && !mine && !notCaptain) out += `<button id="investSubmit" class="btn primary block big" ${left === 0 ? '' : 'disabled'}>Investering vastzetten</button>`;
  if (mine) out += `<div class="receipt" role="status">✓ Investering vastgezet en ontvangen.</div>`;
  if (sending?.status === 'error') out += `<div class="receipt err" role="alert">${esc(sending.error)}</div>`;
  if (v.live.phase === 'open' && !mine && notCaptain) out += `<p class="notice">De captain verdeelt het budget.</p>`;
  if (['revealed', 'scored'].includes(v.live.phase)) out += revealExtra(v, q);
  return out;
}
function bindInvest(q) {
  $$('[data-inv]').forEach(b => b.onclick = () => {
    const t = b.dataset.inv, d = Number(b.dataset.d) * q.step;
    const total = Object.values(draft.invest).reduce((a, x) => a + x, 0);
    const nv = Math.max(0, (draft.invest[t] || 0) + d);
    if (d > 0 && total + d > q.budget) return;
    draft.invest[t] = nv; if (!nv) delete draft.invest[t];
    lastKey = ''; render();
  });
  const sb = $('#investSubmit'); if (sb) sb.onclick = () => send(q, { ...draft.invest });
}

function revealExtra(v, q) {
  const r = v.result || {};
  if (r.ranking) return r.ranking.skipped ? '<p class="notice">Geen geldige stemmen: deze vraag vervalt.</p>'
    : `<table class="board" style="margin-top:12px"><tbody>${r.ranking.top.map(x => `<tr class="${x.winner ? 'me' : ''}"><td>${esc(x.name)}${x.winner ? ' 🏆' : ''}</td><td class="pts">${x.votes}</td></tr>`).join('')}</tbody></table><p class="small muted">Alleen totalen; wie op wie stemde blijft geheim.</p>`;
  if (r.invest) return `<table class="board" style="margin-top:12px"><tbody>${r.invest.map(x => `<tr><td>${esc(x.name)}</td><td class="pts">€${x.total.toLocaleString('nl-NL')}</td></tr>`).join('')}</tbody></table>`;
  if (r.kompaan) { const mine = r.kompaan.find(k => k.team === v.me.teamName); return mine ? `<p class="small">${mine.answers.map(a => `${esc(a.name)}: <b>${esc(fmtAns(q, a.answer))}</b>`).join(' · ')} ${mine.match ? '— zelfde antwoord!' : '— niet hetzelfde'}</p>` : ''; }
  return '';
}
const fmtAns = (q, a) => a == null ? '—' : (q.type === 'mc' || q.type === 'tf') && q.options ? `${LETTERS[a]}. ${q.options[a]}` : a;

function shotsRevealScreen(v) {
  const d = v.shotsReveal; if (!d) return '';
  return `<div class="center"><span class="tag">Shot in het duister</span><h1 style="margin-top:12px">De onthulling</h1></div>
    ${d.shots.map(s => `<section class="card"><div class="row" style="justify-content:space-between"><h3 style="margin:0">Shot ${s.number}: ${esc(s.name || '')}</h3><span class="pill">${esc(s.team)}</span></div>
      <p class="small" style="margin:6px 0">${esc(s.flavor || '')} · ${esc(s.base || '')}</p>${s.story ? `<p class="muted small" style="margin:0">“${esc(s.story)}”</p>` : ''}</section>`).join('')}
    <h3 style="margin-top:20px">Punten deze ronde</h3><table class="board"><tbody>${d.points.map(p => `<tr class="${p.name === v.me.teamName ? 'me' : ''}"><td>${esc(p.name)}</td><td class="pts">${p.points}</td></tr>`).join('')}</tbody></table>`;
}

// ---------- voorbereiding: vragenlijst, ranking, teamshot, buitentas ----------
let prepKey = '', prepDirty = false;
const prepOpen = new Set();
function renderPrep(v) {
  const el = $('#prep');
  const show = ['lobby', 'break'].includes(v.live.screen) && v.prep;
  el.hidden = !show; if (!show) return;
  const k = JSON.stringify(v.prep) + v.me.teamId;
  if (k === prepKey) return;
  // Niet opnieuw opbouwen terwijl iemand in de voorbereiding bezig is; na verlaten van het blok bijwerken.
  if (el.contains(document.activeElement) || prepDirty) {
    el.onfocusout = () => setTimeout(() => { if (!el.contains(document.activeElement) && view) { prepDirty = false; renderPrep(view); } }, 50);
    return;
  }
  prepKey = k; prepDirty = false;
  const P = v.prep; const pr = P.profile;
  const openVotes = P.ranking.filter(r => !r.closed);
  const votesDone = openVotes.length && openVotes.every(r => r.voted);
  const shotDone = P.shot && P.shot.name && P.shot.allergens;
  const missDone = P.missions.filter(m => m.closed || m.mine?.value || m.mine?.hasPhoto).length;
  const tasks = [openVotes.length && votesDone, pr.done, P.shot && shotDone, P.missions.length && missDone === P.missions.length];
  const total = [openVotes.length, 1, P.shot, P.missions.length].filter(Boolean).length;
  const done = tasks.filter(Boolean).length;
  const task = (key, title, ok, sub, inner) => `<details class="task" data-task="${key}" ${prepOpen.has(key) ? 'open' : ''}><summary><span class="tick ${ok ? 'ok' : ''}" aria-hidden="true">${ok ? '✓' : ''}</span>
    <span class="grow"><b>${title}</b><span class="small muted">${sub}</span></span><span class="chev" aria-hidden="true">›</span></summary><div class="task-body">${inner}</div></details>`;
  el.innerHTML = `<div class="prep-head"><h2>Voor het weekend</h2><span class="pill ${done === total ? 'ok' : ''}">${done} van ${total} klaar</span></div>
  <p class="muted small" style="margin:0 0 12px">Een paar minuutjes. Alles mag je overslaan.</p>
  ${openVotes.length ? task('vote', 'Ranking de Boys', votesDone, votesDone ? 'Gestemd, geheim' : `${openVotes.length} korte stemmen`, `<p class="small muted">Je stem is anoniem. Alleen totalen worden getoond.</p>
    ${openVotes.map(r => `<div class="field"><label for="rv_${r.id}">${esc(r.prompt)}</label><select id="rv_${r.id}" data-vote="${r.id}">
      <option value="" ${!r.voted ? 'selected' : ''}>Kies…</option><option value="skip" ${r.voted && !r.choiceId ? 'selected' : ''}>Overslaan</option>
      ${P.candidates.map(c => `<option value="${c.id}" ${r.choiceId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>`).join('')}`) : ''}
  ${task('prof', 'Over jou', pr.done, pr.done ? 'Ingevuld' : 'Optioneel, voor de quizmasters', `<form id="profForm">
    <div class="field"><label for="pStory">Een verhaal dat we mogen gebruiken</label><textarea id="pStory" maxlength="1000">${esc(pr.story)}</textarea></div>
    <div class="field"><label for="pLim">Waar moet de humor bij jou wegblijven?</label><input id="pLim" maxlength="500" value="${esc(pr.limits)}"></div>
    <button class="btn copper">${pr.done ? 'Bijwerken' : 'Opslaan'}</button></form>`)}
  ${P.shot ? task('shot', 'Jullie geheime shot', shotDone, shotDone ? esc(P.shot.name) : 'Eén per team, alleen jullie zien dit', `<form id="shotForm">${P.shot.updated_by ? `<p class="small muted">Laatst bewerkt door ${esc(P.shot.updated_by)}.</p>` : ''}
    ${[['name', 'Naam of merk'], ['flavor', 'Hoofdsmaak'], ['base', 'Basisdrank (of “geen alcohol”)'], ['ingredients', 'Ingrediënten'], ['allergens', 'Allergenen (verplicht, “geen” mag)'], ['amount', 'Hoeveelheid (bijv. 1 fles 0,7 l)']]
      .map(([f, l]) => `<div class="field"><label for="sh_${f}">${l}</label><input id="sh_${f}" data-shot="${f}" maxlength="300" value="${esc(P.shot[f] || '')}"></div>`).join('')}
    <div class="field"><label for="sh_story">Kort verhaal (pas aan het eind onthuld)</label><textarea id="sh_story" data-shot="story" maxlength="500">${esc(P.shot.story || '')}</textarea></div>
    <button class="btn copper">Shot opslaan</button></form>`) : ''}
  ${P.missions.length ? task('miss', 'BAMIGO Buitentas', missDone === P.missions.length, `${missDone} van ${P.missions.length} opdrachten`, `<p class="small muted">Verzamel vooraf en lever de tas in bij de BAMIGO Douane.</p>
    ${P.missions.map(m => `<form class="mission" data-mission="${m.id}"><h4>${esc(m.title)}</h4>${m.description ? `<p class="small muted">${esc(m.description)}</p>` : ''}
      ${m.closed ? `<p class="pill ok"><span class="dot"></span>Beoordeeld</p>` : `<div class="field"><label for="mv_${m.id}">${m.kind === 'closest' ? `Jullie waarde${m.unit ? ' (' + esc(m.unit) + ')' : ''}` : 'Wat hebben jullie?'}</label><input id="mv_${m.id}" name="value" maxlength="100" value="${esc(m.mine?.value || '')}"></div>
      <div class="field"><label for="mn_${m.id}">Toelichting</label><input id="mn_${m.id}" name="note" maxlength="500" value="${esc(m.mine?.note || '')}"></div>
      <div class="row"><button class="btn copper small">Opslaan</button><label class="btn ghost small" style="margin:0;color:var(--ivory)">${m.mine?.hasPhoto ? 'Foto vervangen' : 'Foto toevoegen'}<input type="file" accept="image/*" capture="environment" data-photo="${m.id}" hidden></label>
      ${m.mine?.value || m.mine?.hasPhoto ? '<span class="pill ok"><span class="dot"></span>Ingeleverd</span>' : ''}</div>`}</form>`).join('')}`) : ''}`;
  $$('details[data-task]', el).forEach(d => d.ontoggle = () => { d.open ? prepOpen.add(d.dataset.task) : prepOpen.delete(d.dataset.task); });
  const A = api({ 'x-player-token': token });
  el.oninput = () => { prepDirty = true; };
  $$('[data-vote]', el).forEach(s => s.onchange = async () => {
    if (!s.value) return;
    try { await A.post('/api/player/vote', { questionId: s.dataset.vote, choiceId: s.value === 'skip' ? null : s.value }); toast('Stem opgeslagen. Geheim, uiteraard.'); prepDirty = false; } catch (e) { toast(e.message, 'bad'); }
  });
  const pf = $('#profForm', el); if (pf) pf.onsubmit = async e => { e.preventDefault(); try { await A.post('/api/player/profile', { story: $('#pStory').value, limits: $('#pLim').value, done: true }); prepDirty = false; toast('Opgeslagen.'); } catch (err) { toast(err.message, 'bad'); } };
  const sf = $('#shotForm', el); if (sf) sf.onsubmit = async e => { e.preventDefault(); const b = {}; $$('[data-shot]', sf).forEach(i => b[i.dataset.shot] = i.value);
    try { await A.post('/api/player/shot', b); prepDirty = false; toast('Shot opgeslagen. Mondje dicht.'); } catch (err) { toast(err.message, 'bad'); } };
  $$('[data-mission]', el).forEach(f => f.onsubmit = async e => { e.preventDefault();
    try { await A.post('/api/player/evidence', { missionId: f.dataset.mission, value: f.elements.namedItem('value').value, note: f.elements.namedItem('note').value }); prepDirty = false; toast('Bewijsmateriaal vastgelegd.'); } catch (err) { toast(err.message, 'bad'); } });
  $$('[data-photo]', el).forEach(inp => inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try { await api({ 'x-player-token': token }).post('/api/player/evidence/photo?missionId=' + encodeURIComponent(inp.dataset.photo), fd); toast('Foto geüpload.'); } catch (err) { toast(err.message, 'bad'); }
  });
}

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
