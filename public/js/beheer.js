// Organisatie, backstage en live bediening. Wat je ziet hangt af van je rol (de server filtert).
import { $, $$, esc, LETTERS, prefs, tokenFromHash, api, connect, toast, connBanner, fmtTime, ROUND_LABEL, TYPE_LABEL } from './common.js';

const main = $('#main');
const token = tokenFromHash('k', 'staffToken');
let A, conn, view, tab = prefs.get('beheerTab', 'live');
let editing = null;      // { kind: 'question'|'round', data }
let busy = false;

// ---------- zonder link: avond aanmaken ----------
if (!token) setupScreen();
else {
  A = api({ 'x-staff-token': token });
  conn = connect({ kind: 'staff', token, onState: v => { if (v.kind === 'display') { location.href = '/tv'; return; } view = v; render(); }, onStatus: status });
}

function setupScreen() {
  $('#tabs').hidden = true;
  main.innerHTML = `<div class="wrap"><h1>Nieuwe avond</h1>
    <form id="newEv" class="card">
      <div class="field"><label for="pw">Beheerwachtwoord van deze server</label><input id="pw" type="password" required autocomplete="current-password"></div>
      <div class="field"><label for="nm">Naam van de avond</label><input id="nm" required value="Muchacho’s — Vriendenweekend 2027"></div>
      <div class="field"><label for="dt">Datum en aanvang (mag later)</label><input id="dt" type="datetime-local"></div>
      <div class="row"><button class="btn primary" name="real">Avond aanmaken</button><button class="btn ghost" name="demo" type="submit">Demo-editie starten</button></div>
      <p id="err" class="notice bad" hidden></p>
    </form>
    <p class="small muted" style="margin-top:14px">Heb je al een beheerlink? Open die link; hij bevat je toegang.</p></div>`;
  $('#newEv').onsubmit = async e => {
    e.preventDefault();
    const demo = e.submitter?.name === 'demo';
    const P = api({ 'x-admin-password': $('#pw').value });
    try {
      const r = demo ? await P.post('/api/demo') : await P.post('/api/events', { name: $('#nm').value, startsAt: $('#dt').value || null });
      prefs.set('displayToken', r.displayToken);
      location.href = '/beheer#k=' + r.ownerToken; location.reload();
    } catch (err) { $('#err').hidden = false; $('#err').textContent = err.message; }
  };
}

function status(s, clock) {
  const map = { online: ['ok', 'Verbonden'], synced: ['ok', `Verbonden · ${Math.round(clock.rtt)} ms`], offline: ['bad', 'Verbinding weg'], reconnecting: ['warn', 'Opnieuw verbinden'], unauthorized: ['bad', 'Link ongeldig'] };
  const [c, t] = map[s] || ['', s];
  $('#status').className = 'pill ' + c; $('#status').innerHTML = `<span class="dot"></span>${t}`;
  connBanner(s === 'synced' ? 'online' : s);
  if (s === 'unauthorized') { prefs.del('staffToken'); main.innerHTML = '<div class="wrap"><p class="notice bad">Deze beheerlink is niet (meer) geldig.</p><a class="btn ghost" href="/beheer">Nieuwe avond</a></div>'; }
}

// ---------- tabs ----------
function tabsFor(v) {
  const t = [];
  if (v.perms.live) t.push(['live', 'Live']);
  t.push(['plan', v.perms.content ? 'Inhoud' : 'Planning']);
  if (v.perms.people) t.push(['people', 'Teams & spelers']);
  t.push(['ready', 'Gereedheid']);
  if (v.perms.scores) t.push(['scores', 'Scores']);
  if (v.perms.roles) t.push(['event', 'Avond & links']);
  return t;
}

let lastTabs = '';
function render() {
  const v = view;
  $('#evName').innerHTML = `${esc(v.event.name)} ${v.event.isDemo ? '<span class="demo-badge">Demo</span>' : ''}`;
  $('#roleBadge').textContent = v.roleLabel;
  const tabs = tabsFor(v);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const tk = JSON.stringify(tabs) + tab;
  if (tk !== lastTabs) {
    lastTabs = tk;
    $('#tabs').innerHTML = tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('');
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; prefs.set('beheerTab', tab); editing = null; lastTabs = ''; render(); });
  }
  if (editing && tab === 'plan') return; // formulier niet overschrijven tijdens bewerken
  const scrollY = window.scrollY;
  const focusId = document.activeElement?.id;
  ({ live: liveTab, plan: planTab, people: peopleTab, ready: readyTab, scores: scoresTab, event: eventTab }[tab])(v);
  if (focusId && document.getElementById(focusId)) document.getElementById(focusId).focus();
  window.scrollTo(0, scrollY);
}

/** Voer een actie uit met knopbeveiliging tegen dubbel klikken. */
async function act(btn, fn, okMsg) {
  if (busy) return; busy = true;
  if (btn) btn.disabled = true;
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { toast(e.message, 'bad'); }
  finally { busy = false; if (btn) btn.disabled = false; }
}
const live = (action, extra = {}) => A.post('/api/staff/live', { action, seq: view.live.seq, ...extra });

// ---------- LIVE ----------
const PHASE_LABEL = { idle: 'Geen vraag actief', ready: 'Klaar om te openen', open: 'Open', closed: 'Gesloten', revealed: 'Onthuld', scored: 'Gescoord' };
const SCREEN_LABEL = { lobby: 'Lobby', round_intro: 'Ronde-intro', question: 'Vraag', scoreboard: 'Scorebord', break: 'Pauze', finale: 'Finale' };

function primaryAction(v) {
  const p = v.live.phase;
  if (p === 'ready') return ['open', 'Open vraag voor iedereen'];
  if (p === 'open') return ['close', 'Sluit vraag nu'];
  if (p === 'closed') return ['reveal', 'Onthul antwoord'];
  if (p === 'revealed') return ['score', 'Punten toekennen'];
  if (v.nextQuestionId) return ['next_question', 'Volgende vraag klaarzetten'];
  return null;
}

function liveTab(v) {
  const L = v.live; const q = v.question;
  const pa = primaryAction(v);
  const allQs = v.rounds.flatMap(r => (r.questions || []).map(x => ({ ...x, round: r })));
  const subs = v.submissions || [];
  const qFull = q ? { ...(allQs.find(x => x.id === q.id) || {}), ...Object.fromEntries(Object.entries(q).filter(([, val]) => val != null)) } : null;
  main.innerHTML = `<div class="live-grid">
  <section>
    <div class="card">
      <div class="state-line"><span class="pill">${SCREEN_LABEL[L.screen]}</span><span class="phase">${PHASE_LABEL[L.phase]}</span>
        ${L.paused ? '<span class="pill warn"><span class="dot"></span>Gepauzeerd</span>' : ''}
        ${L.phase === 'open' && L.deadline ? `<span class="timer" style="font-size:1.8rem" data-timer>--:--</span>` : ''}
        ${v.counts ? `<span class="pill">${v.counts.submitted}/${v.counts.expected} ingestuurd</span>` : ''}</div>
      ${q ? `<p class="small muted" style="margin:0">${esc(L.round?.title || '')} · vraag ${q.number}/${q.of} · ${TYPE_LABEL[q.type]} · ${q.scope === 'team' ? 'team' : 'individueel'}${q.scoring === 'speed' ? ' · bliksem' : ''}</p>
        <h2 style="margin:6px 0">${esc(q.prompt ?? allQs.find(x => x.id === q.id)?.prompt ?? '(vraagtekst verborgen tot openen)')}</h2>
        ${qFull.options?.length ? `<ol type="A" class="small">${qFull.options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : ''}` : ''}
      ${v.currentKey ? `<p class="notice ok small">Antwoord: <b>${esc(fmtKey(qFull, v.currentKey))}</b>${v.currentKey.explanation ? ' — ' + esc(v.currentKey.explanation) : ''}</p>`
        : q ? '<p class="small muted">Antwoordsleutel verschijnt na sluiten.</p>' : ''}
      ${L.message ? `<p class="notice warn small">${esc(L.message)}</p>` : ''}
      ${pa ? `<button id="primary" class="btn primary primary-action" data-act="${pa[0]}">${pa[1]}</button>` : '<p class="muted">Geen volgende vraag. Toon het scorebord of de finale.</p>'}
      <div class="row" style="margin-top:12px">
        ${L.phase === 'scored' ? '<button class="btn ghost small" data-act="score">Opnieuw scoren</button>' : ''}
        <button class="btn ghost small" data-act="${L.paused ? 'resume' : 'pause'}">${L.paused ? 'Hervat' : 'Pauzeer'}</button>
        ${q ? '<button class="btn danger small" data-act="void">Vraag ongeldig verklaren…</button>' : ''}
      </div>
    </div>
    <div class="card"><h3>Scherm op tv</h3><div class="row">
      <button class="btn ghost small" data-act="screen_lobby">Lobby</button>
      <button class="btn ghost small" data-act="screen_scoreboard">Scorebord</button>
      <button class="btn ghost small" data-act="screen_break">Pauze</button>
      <button class="btn ghost small" data-act="screen_finale">Finale</button>
      <select id="introSel" style="width:auto;min-width:200px"><option value="">Ronde-intro…</option>${v.rounds.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:10px 0 0">TV-link: open <b>/tv</b> met de tv-link uit “Avond & links”.</p></div>
    ${subs.length || q ? `<div class="card"><h3>Inzendingen (${subs.length})</h3>${subsTable(v, qFull, subs)}</div>` : ''}
  </section>
  <section>
    <div class="card"><h3>Vragen</h3><ul class="list qlist">${allQs.map(x => `<li class="${x.id === q?.id ? 'current' : ''}">
      <span class="small muted">${esc(x.round.title.slice(0, 14))}</span><span class="t ${x.voided ? 'voided' : ''}">${esc(x.prompt || TYPE_LABEL[x.type])}</span>
      ${x.isExample ? '<span class="example-badge">vb</span>' : ''}
      ${x.voided ? '<span class="small muted">vervallen</span>' : x.played ? '<span class="pill ok">gespeeld</span>' : `<button class="btn ghost small" data-prepare="${x.id}" ${L.phase === 'open' ? 'disabled' : ''}>Klaarzetten</button>`}</li>`).join('') || '<li class="muted">Nog geen vragen.</li>'}</ul></div>
    <div class="card"><h3>Stand</h3><table class="board"><tbody>${v.scoreboard.teams.map(t => `<tr><td class="pos">${t.rank}</td><td>${esc(t.name)}</td><td class="pts">${t.points}</td></tr>`).join('')}</tbody></table></div>
    ${v.perms.scores ? adjustForm(v) : ''}
  </section></div>`;
  $$('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'void') {
      const reason = prompt('Waarom vervalt deze vraag? (komt in het scorelogboek)'); if (!reason) return;
      if (!confirm('Vraag ongeldig verklaren? Alle punten voor deze vraag vervallen.')) return;
      return act(b, () => live('void', { reason }), 'Vraag vervallen.');
    }
    if (a === 'next_question') return act(b, () => live('next_question'));
    act(b, () => live(a));
  });
  $('#introSel').onchange = e => { if (e.target.value) act(null, () => live('round_intro', { roundId: e.target.value })); };
  $$('[data-prepare]').forEach(b => b.onclick = () => act(b, () => live('prepare', { questionId: b.dataset.prepare })));
  $$('[data-judge]').forEach(b => b.onclick = () => act(b, () => A.post('/api/staff/judge', { submissionId: b.dataset.judge, verdict: b.dataset.v })));
  bindAdjust();
  tickLive();
}

function fmtKey(q, k) {
  if (!q || k.correct == null) return '— (geen sleutel)';
  if ((q.type === 'mc' || q.type === 'tf') && q.options) return [].concat(k.correct).map(i => `${LETTERS[i]}. ${q.options[i]}`).join(' / ');
  if (q.type === 'open') return [k.correct, ...k.accepted].join(' / ');
  if (q.type === 'order' && q.options) return k.correct.map(i => q.options[i]).join(' → ');
  return String(k.correct) + (k.tolerance ? ` (±${k.tolerance})` : '');
}

function subsTable(v, q, subs) {
  if (!subs.length) return '<p class="muted small">Nog niets binnen.</p>';
  const showAns = subs.some(s => s.answer !== undefined);
  const fmtA = a => q && (q.type === 'mc' || q.type === 'tf') && q.options ? `${LETTERS[a]}. ${q.options[a] ?? ''}` : Array.isArray(a) ? a.join(', ') : a;
  return `<table class="subs"><thead><tr><th>Wie</th><th>Tijd</th>${showAns ? '<th>Antwoord</th><th>Oordeel</th><th></th>' : ''}</tr></thead><tbody>
  ${subs.map(s => `<tr><td>${esc(s.team ? s.team + (q?.scope === 'individual' ? ' · ' + s.by : '') : s.by)}</td><td>${(s.elapsedMs / 1000).toFixed(2)}s${s.bet ? ` · inzet ${s.bet}` : ''}</td>
    ${showAns ? `<td>${esc(fmtA(s.answer))}</td><td class="v-${s.verdict || ''}">${s.verdict === 'correct' ? 'Goed' : s.verdict === 'wrong' ? 'Fout' : s.verdict === 'review' ? 'Twijfel' : '—'}${s.manual ? ' (hand)' : ''}</td>
    <td>${['closed', 'revealed', 'scored'].includes(v.live.phase) ? `<button class="btn ghost small" data-judge="${s.id}" data-v="correct" aria-label="Goed rekenen">✓</button> <button class="btn ghost small" data-judge="${s.id}" data-v="wrong" aria-label="Fout rekenen">✗</button>` : ''}</td>` : ''}</tr>`).join('')}
  </tbody></table>`;
}

function adjustForm(v) {
  return `<form id="adjust" class="card"><h3>Scorecorrectie / bonus</h3>
    <div class="field"><label for="adjTarget">Voor</label><select id="adjTarget" required><option value="">Kies…</option>
      <optgroup label="Teams">${v.teams.map(t => `<option value="t:${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>
      <optgroup label="Individueel (Snelste Bamigo)">${v.teams.flatMap(t => t.members).concat(v.unassigned).map(p => `<option value="p:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup></select></div>
    <div class="row"><div class="grow field"><label for="adjPts">Punten (+/−)</label><input id="adjPts" type="number" required step="1"></div>
      <div class="grow field"><label for="adjKind">Soort</label><select id="adjKind"><option value="correction">Correctie</option><option value="bonus">Bonus (bv. outfit)</option></select></div></div>
    <div class="field"><label for="adjReason">Reden (verplicht)</label><input id="adjReason" required maxlength="200"></div>
    <button class="btn copper">Vastleggen</button></form>`;
}
function bindAdjust() {
  const f = $('#adjust'); if (!f) return;
  f.onsubmit = e => {
    e.preventDefault();
    const [k, idv] = $('#adjTarget').value.split(':');
    act(e.submitter, () => A.post('/api/staff/scores', { [k === 't' ? 'teamId' : 'participantId']: idv, points: Number($('#adjPts').value), reason: $('#adjReason').value, kind: $('#adjKind').value }), 'Vastgelegd in het scorelogboek.')
      .then(r => { if (r) f.reset(); });
  };
}

function tickLive() {
  const t = $('[data-timer]'); if (!t || !view?.live.deadline) return;
  const L = view.live; t.textContent = fmtTime(L.deadline - (L.paused ? L.pausedAt : conn.now()));
}
setInterval(() => { if (tab === 'live') tickLive(); }, 250);

// ---------- INHOUD / PLANNING ----------
function planTab(v) {
  const total = v.plannedMinutes; const over = total > v.event.durationMax; const warn = total > v.event.durationTarget;
  const canEdit = v.perms.content;
  main.innerHTML = `
  <div class="row" style="justify-content:space-between;margin-bottom:12px">
    <div><span class="time-total ${over ? 'over' : ''}">${total} min</span> <span class="muted">gepland · doel ${v.event.durationTarget}, max ${v.event.durationMax}</span>
      ${over ? '<p class="notice bad small">Boven de maximale duur. Schrap of verkort een blok.</p>' : warn ? '<p class="notice warn small">Boven de doelduur; je gebruikt uitloopruimte.</p>' : ''}</div>
    ${canEdit ? `<div class="row"><button class="btn copper" id="addRound">Ronde toevoegen</button>
      <button class="btn ghost small" id="exportPack">Vraagpakket exporteren</button>
      <label class="btn ghost small" style="margin:0;color:var(--ivory)">Importeren<input type="file" id="importPack" accept="application/json" hidden></label>
      <button class="btn ghost small" id="emergency">Noodpakket (print)</button></div>` : ''}
  </div>
  ${!v.perms.answers ? '<p class="notice small">Je ziet de planning zonder vragen of antwoorden. Zo blijft het een verrassing.</p>' : ''}
  <div id="editorSlot"></div>
  ${v.rounds.map((r, i) => `<section class="round">
    <header><span class="pill">${esc(ROUND_LABEL[r.kind] || r.kind)}</span><h3>${esc(r.title)}</h3><span class="muted small">${r.minutes} min · ${r.questionCount} vragen</span>
      ${canEdit ? `<button class="btn ghost small" data-rup="${i}" aria-label="Ronde omhoog" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn ghost small" data-redit="${r.id}">Bewerken</button><button class="btn ghost small" data-qadd="${r.id}">+ Vraag</button>
      <button class="btn danger small" data-rdel="${r.id}" aria-label="Ronde verwijderen">Verwijder</button>` : ''}</header>
    ${r.instructions ? `<p class="small muted" style="padding:8px 14px 0;margin:0">${esc(r.instructions)}</p>` : ''}
    ${r.questions ? `<ul>${r.questions.map((q, j) => `<li><span class="small muted">${j + 1}.</span><span class="t ${q.voided ? 'voided' : ''}">${esc(q.prompt || '')}
        <span class="small muted"> · ${TYPE_LABEL[q.type]} · ${q.scope === 'team' ? 'team' : 'individueel'} · ${q.seconds}s · ${q.scoring === 'speed' ? 'bliksem' : q.scoring === 'closest' ? 'dichtstbij' : q.points + ' pt'}</span>
        ${q.isExample ? '<span class="example-badge">voorbeeld</span>' : ''}${v.perms.answers && (!q.key || q.key.correct == null) && q.type !== 'ranking' ? ' <span class="pill bad">geen antwoord</span>' : ''}</span>
      ${canEdit ? `<button class="btn ghost small" data-qup="${r.id}:${j}" aria-label="Vraag omhoog" ${j === 0 ? 'disabled' : ''}>↑</button><button class="btn ghost small" data-qedit="${q.id}">Bewerken</button>
        <button class="btn danger small" data-qdel="${q.id}" aria-label="Vraag verwijderen">×</button>` : ''}</li>`).join('')}</ul>` : ''}
  </section>`).join('')}`;
  if (!canEdit) return;
  $('#addRound').onclick = () => openRoundEditor({ kind: 'quiz', title: '', minutes: 10 });
  $$('[data-redit]').forEach(b => b.onclick = () => openRoundEditor(v.rounds.find(r => r.id === b.dataset.redit)));
  $$('[data-rdel]').forEach(b => b.onclick = () => { const r = v.rounds.find(x => x.id === b.dataset.rdel); if (confirm(`Ronde "${r.title}" met ${r.questionCount} vragen definitief verwijderen?`)) act(b, () => A.del('/api/staff/rounds/' + r.id), 'Ronde verwijderd.'); });
  $$('[data-rup]').forEach(b => b.onclick = () => { const ids = v.rounds.map(r => r.id); const i = +b.dataset.rup; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; act(b, () => A.post('/api/staff/reorder', { table: 'rounds', ids })); });
  $$('[data-qadd]').forEach(b => b.onclick = () => openQuestionEditor({ roundId: b.dataset.qadd, type: 'mc', scope: 'team', scoring: 'fixed', options: ['', '', '', ''], seconds: 30, points: 1, key: { correct: null, accepted: [] } }));
  $$('[data-qedit]').forEach(b => b.onclick = () => { const q = v.rounds.flatMap(r => (r.questions || []).map(x => ({ ...x, roundId: r.id }))).find(x => x.id === b.dataset.qedit); openQuestionEditor(q); });
  $$('[data-qdel]').forEach(b => b.onclick = () => { if (confirm('Deze vraag definitief verwijderen?')) act(b, () => A.del('/api/staff/questions/' + b.dataset.qdel), 'Vraag verwijderd.'); });
  $$('[data-qup]').forEach(b => b.onclick = () => { const [rid, j] = b.dataset.qup.split(':'); const ids = v.rounds.find(r => r.id === rid).questions.map(q => q.id); const i = +j; [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; act(b, () => A.post('/api/staff/reorder', { table: 'questions', ids })); });
  $('#exportPack').onclick = async () => { const p = await A.get('/api/staff/export/pack'); download(`bamigo-vragen-${Date.now()}.json`, JSON.stringify(p, null, 2)); };
  $('#importPack').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await A.post('/api/staff/import/pack', JSON.parse(await f.text())); toast(`${r.rounds} rondes, ${r.questions} vragen geïmporteerd.`); } catch (err) { toast(err.message, 'bad'); } };
  $('#emergency').onclick = async () => { const html = await A.get('/api/staff/emergency'); const w = window.open('', '_blank'); if (w) { w.document.write(html); w.document.close(); } else download('bamigo-noodpakket.html', html); };
}

function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text])); a.download = name; a.click(); }

const KINDS = Object.entries(ROUND_LABEL);
function openRoundEditor(r) {
  editing = { kind: 'round' };
  $('#editorSlot').innerHTML = `<form class="editor" id="roundForm"><h3>${r.id ? 'Ronde bewerken' : 'Nieuwe ronde'}</h3>
    <div class="row"><div class="grow field"><label for="rTitle">Titel</label><input id="rTitle" required value="${esc(r.title)}"></div>
    <div class="field"><label for="rKind">Spelvorm</label><select id="rKind">${KINDS.map(([k, l]) => `<option value="${k}" ${k === r.kind ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="field" style="width:120px"><label for="rMin">Minuten</label><input id="rMin" type="number" min="0" max="300" value="${r.minutes}"></div></div>
    <div class="field"><label for="rInstr">Instructies (op tv en telefoon)</label><textarea id="rInstr">${esc(r.instructions || '')}</textarea></div>
    <div class="row"><div class="grow field"><label for="rSup">Benodigdheden</label><input id="rSup" value="${esc(r.supplies || '')}"></div>
    <div class="grow field"><label for="rJudge">Beoordeling</label><input id="rJudge" value="${esc(r.judging || '')}"></div></div>
    <div class="row"><button class="btn primary">Opslaan</button><button type="button" class="btn ghost" id="cancelEd">Annuleren</button></div></form>`;
  $('#cancelEd').onclick = closeEditor;
  $('#rTitle').focus();
  $('#roundForm').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.post('/api/staff/rounds', { id: r.id, title: $('#rTitle').value, kind: $('#rKind').value, minutes: +$('#rMin').value, instructions: $('#rInstr').value, supplies: $('#rSup').value, judging: $('#rJudge').value }), 'Opgeslagen.').then(x => x && closeEditor()); };
}
function closeEditor() { editing = null; render(); }

function openQuestionEditor(q) {
  editing = { kind: 'question' };
  const k = q.key || { correct: null, accepted: [] };
  if (q.type === 'order' && Array.isArray(k.correct) && q.options) q = { ...q, options: k.correct.map(i => q.options[i]) };
  $('#editorSlot').innerHTML = `<form class="editor" id="qForm"><h3>${q.id ? 'Vraag bewerken' : 'Nieuwe vraag'}</h3>
    <div class="row">
      <div class="field"><label for="qType">Type</label><select id="qType">${Object.entries(TYPE_LABEL).filter(([t]) => t !== 'ranking' && t !== 'match').map(([t, l]) => `<option value="${t}" ${t === q.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="qScope">Wie antwoordt</label><select id="qScope"><option value="team" ${q.scope === 'team' ? 'selected' : ''}>Team (captain)</option><option value="individual" ${q.scope === 'individual' ? 'selected' : ''}>Iedereen zelf</option></select></div>
      <div class="field"><label for="qScoring">Scoring</label><select id="qScoring"><option value="fixed">Vaste punten</option><option value="speed" ${q.scoring === 'speed' ? 'selected' : ''}>Bliksem (sneller = meer)</option><option value="closest" ${q.scoring === 'closest' ? 'selected' : ''}>Dichtstbij (5-4-3-2-1)</option></select></div>
      <div class="field" style="width:110px"><label for="qSec">Seconden</label><input id="qSec" type="number" min="0" max="600" value="${q.seconds}"></div>
      <div class="field" style="width:100px"><label for="qPts">Punten</label><input id="qPts" type="number" min="0" max="100" value="${q.points}"></div></div>
    <div class="field"><label for="qPrompt">Vraag</label><input id="qPrompt" required maxlength="500" value="${esc(q.prompt || '')}"></div>
    <div class="row"><div class="grow field"><label for="qQuote">Citaat / app-bericht (optioneel)</label><input id="qQuote" value="${esc(q.quote || '')}"></div>
      <div class="grow field"><label for="qCtx">Context / bron (alleen beheer en onthulling)</label><input id="qCtx" value="${esc(q.context || '')}"></div></div>
    <div class="field" id="optWrap"><label for="qOpts">Keuzes (één per regel)</label><textarea id="qOpts">${esc((q.options || []).join('\n'))}</textarea></div>
    <div class="row">
      <div class="grow field"><label for="qCorrect" id="qCorrectLbl">Juiste antwoord</label><span id="qCorrectSlot"></span></div>
      <div class="grow field" id="accWrap"><label for="qAcc">Ook goed (varianten, één per regel)</label><textarea id="qAcc">${esc((k.accepted || []).join('\n'))}</textarea></div>
      <div class="field" id="tolWrap" style="width:140px"><label for="qTol">Marge (±)</label><input id="qTol" type="number" step="any" value="${k.tolerance ?? ''}"></div></div>
    <div class="field"><label for="qExpl">Uitleg bij onthulling</label><input id="qExpl" value="${esc(k.explanation || '')}"></div>
    <div class="row"><label class="check" style="margin:0"><input type="checkbox" id="qBet" ${q.allowBet ? 'checked' : ''}> Inzetten toestaan (1–3)</label>
      <label class="check" style="margin:0"><input type="checkbox" id="qEx" ${q.isExample ? 'checked' : ''}> Voorbeeldvraag (markering)</label></div>
    <div class="field"><label for="qMedia">Afbeelding/audio (optioneel, max 15 MB)</label><input id="qMedia" type="file" accept="image/*,audio/*,video/mp4">
      ${q.mediaId ? '<p class="small muted">Er is al media gekoppeld; nieuw bestand vervangt het.</p>' : ''}</div>
    <div class="row"><button class="btn primary">Opslaan</button><button type="button" class="btn ghost" id="cancelEd">Annuleren</button></div></form>`;
  const sync = () => {
    const t = $('#qType').value;
    $('#optWrap').hidden = !['mc', 'order'].includes(t);
    $('#accWrap').hidden = t !== 'open';
    $('#tolWrap').hidden = t !== 'number';
    const opts = t === 'tf' ? ['Waar', 'Niet waar'] : $('#qOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
    const cur = $('#qCorrect')?.value ?? (k.correct ?? '');
    if (t === 'mc' || t === 'tf') $('#qCorrectSlot').innerHTML = `<select id="qCorrect"><option value="">— kies —</option>${opts.map((o, i) => `<option value="${i}" ${String(cur) === String(i) ? 'selected' : ''}>${LETTERS[i]}. ${esc(o)}</option>`).join('')}</select>`;
    else if (t === 'order') $('#qCorrectSlot').innerHTML = `<p class="small muted" id="qCorrect" data-order="1">De volgorde waarin je de keuzes invult is de juiste volgorde. Spelers krijgen ze ongesorteerd.</p>`;
    else $('#qCorrectSlot').innerHTML = `<input id="qCorrect" ${t === 'number' ? 'inputmode="decimal"' : ''} value="${esc(cur)}">`;
  };
  sync();
  $('#qType').onchange = sync; $('#qOpts').oninput = sync;
  $('#cancelEd').onclick = closeEditor;
  $('#qPrompt').focus();
  $('#qForm').onsubmit = async e => {
    e.preventDefault();
    const t = $('#qType').value;
    let options = $('#qOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
    let correct = $('#qCorrect')?.value ?? null;
    let settings = q.settings || {};
    if (t === 'mc' || t === 'tf') correct = correct === '' ? null : Number(correct);
    if (t === 'order') { correct = options.map((_, i) => i); const sh = shuffle(options.map((_, i) => i)); const shuffled = sh.map(i => options[i]); correct = options.map(o => shuffled.indexOf(o)); options = shuffled; }
    if (t === 'number') correct = correct === '' ? null : correct;
    let mediaId;
    const file = $('#qMedia').files[0];
    if (file) { const fd = new FormData(); fd.append('file', file); try { mediaId = (await A.post('/api/staff/media', fd)).id; } catch (err) { toast(err.message, 'bad'); return; } }
    act(e.submitter, () => A.post('/api/staff/questions', { id: q.id, roundId: q.roundId, type: t, scope: $('#qScope').value, scoring: $('#qScoring').value, seconds: +$('#qSec').value, points: +$('#qPts').value,
      prompt: $('#qPrompt').value, quote: $('#qQuote').value, context: $('#qCtx').value, options, allowBet: $('#qBet').checked, isExample: $('#qEx').checked, settings, mediaId,
      key: { correct, accepted: $('#qAcc').value.split('\n'), tolerance: $('#qTol').value, explanation: $('#qExpl').value } }), 'Vraag opgeslagen.').then(x => x && closeEditor());
  };
}
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ---------- TEAMS & SPELERS ----------
function peopleTab(v) {
  const all = v.teams.flatMap(t => t.members.map(m => ({ ...m, teamId: t.id }))).concat(v.unassigned);
  main.innerHTML = `<div class="grid2">
  <section class="card"><h3>Teams</h3>
    ${v.teams.map(t => `<div class="card" style="background:var(--bg)"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(t.name)}</h3>
      <div class="row"><button class="btn ghost small" data-trename="${t.id}">Hernoem</button><button class="btn danger small" data-tdel="${t.id}" aria-label="Team ${esc(t.name)} verwijderen">×</button></div></div>
      <ul class="list">${t.members.map(m => `<li><span class="pill ${m.online ? 'ok' : ''}"><span class="dot"></span>${m.online ? 'online' : m.joined ? 'offline' : 'niet aangemeld'}</span>
        <span>${esc(m.name)}</span>${m.isCaptain ? '<span class="pill warn">captain</span>' : `<button class="btn ghost small" data-cap="${m.id}">Maak captain</button>`}</li>`).join('') || '<li class="muted">Leeg</li>'}</ul>
      ${t.members.length === 3 ? '<p class="small muted">Trio: bij “Ken je kompaan” worden per vraag twee spelers aangewezen.</p>' : ''}</div>`).join('')}
    <form id="addTeam" class="row" style="margin-top:12px"><input id="teamName" class="grow" placeholder="Nieuwe teamnaam" required maxlength="60"><button class="btn copper">Team toevoegen</button></form>
  </section>
  <section class="card"><h3>Spelers (${all.length})</h3>
    <ul class="list">${all.map(p => `<li><span class="grow">${esc(p.name)}</span>
      <select data-pteam="${p.id}" aria-label="Team van ${esc(p.name)}" style="width:auto"><option value="">— geen team —</option>${v.teams.map(t => `<option value="${t.id}" ${t.id === p.teamId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
      <button class="btn ghost small" data-plink="${p.id}">Link</button><button class="btn danger small" data-pdel="${p.id}" aria-label="${esc(p.name)} verwijderen">×</button></li>`).join('')}</ul>
    <form id="addP" class="row" style="margin-top:12px"><input id="pName" class="grow" placeholder="Naam" required maxlength="40">
      <select id="pTeam" style="width:auto"><option value="">— team —</option>${v.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button class="btn copper">Toevoegen</button></form>
    <p class="small muted" style="margin-top:10px">Spelers melden zich aan met code <b>${esc(v.event.joinCode)}</b> en hun naam. “Link” maakt een persoonlijke link (bijv. als iemand een nieuwe telefoon pakt); de oude sessie vervalt.</p>
    <div id="linkOut"></div>
  </section></div>`;
  $('#addTeam').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.post('/api/staff/teams', { name: $('#teamName').value })); };
  $('#addP').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.post('/api/staff/participants', { name: $('#pName').value, teamId: $('#pTeam').value || null })); };
  $$('[data-trename]').forEach(b => b.onclick = () => { const n = prompt('Nieuwe teamnaam'); if (n) act(b, () => A.post('/api/staff/teams', { id: b.dataset.trename, name: n })); });
  $$('[data-tdel]').forEach(b => b.onclick = () => { if (confirm('Team verwijderen? Spelers blijven bestaan maar zonder team; teamscores vervallen.')) act(b, () => A.del('/api/staff/teams/' + b.dataset.tdel)); });
  $$('[data-cap]').forEach(b => b.onclick = () => act(b, () => A.post('/api/staff/captain', { participantId: b.dataset.cap }), 'Captain gewijzigd.'));
  $$('[data-pteam]').forEach(s => s.onchange = () => act(null, () => A.post('/api/staff/participants', { id: s.dataset.pteam, teamId: s.value || null })));
  $$('[data-pdel]').forEach(b => b.onclick = () => { if (confirm('Speler verwijderen? Zijn of haar inzendingen en individuele punten vervallen.')) act(b, () => A.del('/api/staff/participants/' + b.dataset.pdel)); });
  $$('[data-plink]').forEach(b => b.onclick = async () => { const r = await act(b, () => A.post(`/api/staff/participants/${b.dataset.plink}/link`)); if (r) $('#linkOut').innerHTML = `<p class="small">Persoonlijke link (deel alleen met deze speler):</p><div class="linkbox">${esc(r.url)}</div>`; });
}

// ---------- GEREEDHEID ----------
function readyTab(v) {
  const r = v.readiness;
  const card = (n, label, bad) => `<div class="card"><div class="n ${bad ? 'copper-text' : ''}">${n}</div><div class="small muted">${label}</div></div>`;
  main.innerHTML = `<h2>Gereedheid</h2>
  <div class="ready-grid">
    ${card(`${r.joined}/${r.participants}`, 'spelers aangemeld', r.joined < r.participants)}
    ${card(`${r.questionnaireDone}/${r.participants}`, 'vragenlijst voltooid', r.questionnaireDone < r.participants)}
    ${card(`${r.teams}`, 'teams' + (r.teamsWithoutCaptain ? ` · ${r.teamsWithoutCaptain} zonder captain` : ''), r.teamsWithoutCaptain)}
    ${card(`${r.shotsSubmitted}/${r.teams}`, 'shots ingediend', r.shotsSubmitted < r.teams)}
    ${card(`${r.missionsDone}/${r.missions * r.teams || 0}`, 'missies afgevinkt')}
    ${card(r.questions, 'vragen' + (r.exampleQuestions ? ` · ${r.exampleQuestions} voorbeeld` : ''), r.exampleQuestions)}
    ${card(r.questionsWithoutAnswer, 'vragen zonder juist antwoord', r.questionsWithoutAnswer)}
    ${card(r.missingMedia, 'ontbrekende media', r.missingMedia)}
  </div>
  <p class="small muted" style="margin-top:16px">Alleen tellingen: geen inhoud, antwoorden, stemmen of shotgegevens. Veilig voor wie zelf meespeelt.</p>
  <div class="card"><h3>Planning</h3><ul class="list">${v.rounds.map(x => `<li><span class="grow">${esc(x.title)}</span><span class="muted small">${x.minutes} min</span></li>`).join('')}</ul>
  <p>Totaal <b>${v.plannedMinutes} min</b> (doel ${v.event.durationTarget}, max ${v.event.durationMax}).</p></div>`;
}

// ---------- SCORES ----------
function scoresTab(v) {
  main.innerHTML = `<div class="grid2"><section class="card"><h3>Teams</h3><table class="board"><tbody>${v.scoreboard.teams.map(t => `<tr><td class="pos">${t.rank}</td><td>${esc(t.name)}</td><td class="pts">${t.points}</td></tr>`).join('')}</tbody></table>
    <h3 style="margin-top:20px">Snelste Bamigo (individueel)</h3><table class="board"><tbody>${v.scoreboard.individuals.filter(p => p.points).map(p => `<tr><td class="pos">${p.rank}</td><td>${esc(p.name)}</td><td class="pts">${p.points}</td></tr>`).join('') || '<tr><td class="muted">Nog geen punten</td></tr>'}</tbody></table>
    <button class="btn ghost small" id="expRes" style="margin-top:12px">Uitslag exporteren (JSON)</button></section>
  <section class="card"><h3>Scorelogboek</h3><table class="subs"><thead><tr><th>Voor</th><th>Pt</th><th>Reden</th><th></th></tr></thead><tbody>
    ${(v.scoreLog || []).map(e => `<tr class="${e.voided ? 'voided' : ''}"><td>${esc(e.team || e.participant || '')}</td><td>${e.points > 0 ? '+' : ''}${e.points}</td><td>${esc(e.reason)}${e.voided ? ` <span class="small">(vervallen: ${esc(e.voidedReason)})</span>` : ''}<br><span class="small muted">${e.kind} · ${new Date(e.at).toLocaleTimeString('nl-NL')}</span></td>
      <td>${e.voided ? '' : `<button class="btn ghost small" data-void="${e.id}">Laat vervallen</button>`}</td></tr>`).join('')}</tbody></table></section></div>`;
  $('#expRes').onclick = async () => download(`bamigo-uitslag-${Date.now()}.json`, JSON.stringify(await A.get('/api/staff/export/results'), null, 2));
  $$('[data-void]').forEach(b => b.onclick = () => { const r = prompt('Reden om deze regel te laten vervallen?'); if (r) act(b, () => A.post(`/api/staff/scores/${b.dataset.void}/void`, { reason: r }), 'Regel vervallen.'); });
}

// ---------- AVOND & LINKS ----------
const ROLE_INFO = { content: 'Inhoudsbeheerder — maakt vragen en ziet antwoorden. Geef deze aan je medequizmaster.', host: 'Live host — bedient de avond; ziet antwoorden pas na sluiten.',
  spoilerfree: 'Spoilervrije organisator — ziet planning en voortgang, geen inhoud. Voor wie zelf meespeelt.', display: 'TV-scherm — alleen de show.' };
function eventTab(v) {
  const s = v.event.settings;
  main.innerHTML = `<div class="grid2">
  <form id="evForm" class="card"><h3>Avond</h3>
    <div class="field"><label for="eName">Naam</label><input id="eName" value="${esc(v.event.name)}" required></div>
    <div class="field"><label for="eSub">Ondertitel</label><input id="eSub" value="${esc(v.event.subtitle || '')}"></div>
    <div class="field"><label for="eStart">Datum & aanvang</label><input id="eStart" type="datetime-local" value="${esc(v.event.startsAt || '')}"></div>
    <div class="row"><div class="grow field"><label for="eTarget">Doelduur (min)</label><input id="eTarget" type="number" value="${v.event.durationTarget}"></div>
      <div class="grow field"><label for="eMax">Maximum (min)</label><input id="eMax" type="number" value="${v.event.durationMax}"></div></div>
    <div class="field"><label for="eCd">Aftellen vóór elke vraag (sec)</label><input id="eCd" type="number" min="0" max="10" value="${(s.countdownMs ?? 3000) / 1000}"></div>
    <label class="check"><input type="checkbox" id="eSelfTeam" ${s.selfTeam !== false ? 'checked' : ''}> Spelers kiezen zelf hun team bij aanmelden</label>
    <label class="check"><input type="checkbox" id="eOne" ${s.oneliners !== false ? 'checked' : ''}> Oneliners tonen</label>
    <label class="check"><input type="checkbox" id="eDrinks" ${s.drinks !== false ? 'checked' : ''}> Drankonderdelen aan</label>
    <button class="btn primary" style="margin-top:10px">Opslaan</button></form>
  <section class="card"><h3>Toegangslinks</h3>
    <p class="small muted">Iedere link geeft precies één rol. Wie de link heeft, heeft toegang: deel ze privé. Een link intrekken werkt direct.</p>
    <ul class="list">${(v.grants || []).map(g => `<li><span class="grow">${esc(g.label)} <span class="small muted">(${g.role})</span></span>${g.revoked ? '<span class="pill bad">ingetrokken</span>' : g.role === 'owner' ? '<span class="pill">jij</span>' : `<button class="btn danger small" data-revoke="${g.id}">Intrekken</button>`}</li>`).join('')}</ul>
    <form id="grantForm" style="margin-top:12px"><div class="row"><select id="gRole" class="grow">${Object.entries(ROLE_INFO).map(([r, t]) => `<option value="${r}">${t}</option>`).join('')}</select></div>
      <div class="row" style="margin-top:8px"><input id="gLabel" class="grow" placeholder="Naam, bijv. ‘Medequizmaster Sam’" maxlength="60"><button class="btn copper">Nieuwe link</button></div></form>
    <div id="grantOut"></div>
    <p class="notice small" style="margin-top:14px">Zelf meespelen? Maak een spoilervrije link voor jezelf, geef de inhoudslink aan je medequizmaster en open deze eigenaarslink niet meer tijdens de voorbereiding. Wie vragen schrijft, kent ze — dat kan software niet wegnemen.</p>
  </section>
  <section class="card"><h3>Hergebruik</h3><p class="small muted">Dupliceer voor een volgende avond. Antwoorden, stemmen, shots, bewijs en scores gaan nooit mee.</p>
    <form id="dupForm"><div class="field"><label for="dName">Naam nieuwe avond</label><input id="dName" required value="${esc(v.event.name)} (kopie)"></div>
      <label class="check"><input type="checkbox" id="dQ" checked> Vragen en antwoordsleutels meenemen</label>
      <label class="check"><input type="checkbox" id="dT"> Teamnamen meenemen</label>
      <label class="check"><input type="checkbox" id="dP"> Namen van spelers meenemen</label>
      <button class="btn copper">Dupliceren</button></form><div id="dupOut"></div>
    <hr style="border-color:var(--line);margin:18px 0"><button class="btn ghost small" id="archive">${v.event.status === 'archived' ? 'Archivering opheffen' : 'Avond archiveren'}</button></section></div>`;
  $('#evForm').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.patch('/api/staff/event', { name: $('#eName').value, subtitle: $('#eSub').value, startsAt: $('#eStart').value, durationTarget: +$('#eTarget').value, durationMax: +$('#eMax').value,
    settings: { countdownMs: Math.round(+$('#eCd').value * 1000), selfTeam: $('#eSelfTeam').checked, oneliners: $('#eOne').checked, drinks: $('#eDrinks').checked } }), 'Opgeslagen.'); };
  $('#grantForm').onsubmit = async e => { e.preventDefault(); const r = await act(e.submitter, () => A.post('/api/staff/grants', { role: $('#gRole').value, label: $('#gLabel').value })); if (r) $('#grantOut').innerHTML = `<p class="small" style="margin-top:10px">Kopieer deze link nu; hij wordt niet opnieuw getoond:</p><div class="linkbox">${esc(r.url)}</div>`; };
  $$('[data-revoke]').forEach(b => b.onclick = () => { if (confirm('Link intrekken? Wie hem gebruikt, verliest direct toegang.')) act(b, () => A.post(`/api/staff/grants/${b.dataset.revoke}/revoke`), 'Ingetrokken.'); });
  $('#dupForm').onsubmit = async e => { e.preventDefault(); const r = await act(e.submitter, () => A.post('/api/staff/duplicate', { name: $('#dName').value, includeQuestions: $('#dQ').checked, includeTeams: $('#dT').checked, includeParticipants: $('#dP').checked }));
    if (r) $('#dupOut').innerHTML = `<p class="small">Nieuwe beheerlink:</p><div class="linkbox">${esc(r.url)}</div><p class="small">TV-link:</p><div class="linkbox">${esc(r.tvUrl)}</div>`; };
  $('#archive').onclick = e => { if (confirm('Zeker weten?')) act(e.target, () => A.patch('/api/staff/event', { status: v.event.status === 'archived' ? 'draft' : 'archived' })); };
}
