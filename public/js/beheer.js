// Organisatie, backstage en live bediening. Wat je ziet hangt af van je rol (de server filtert).
import { $, $$, esc, LETTERS, prefs, tokenFromHash, api, connect, toast, connBanner, fmtTime, mediaUrl, ROUND_LABEL, TYPE_LABEL } from './common.js';

const main = $('#main');
const token = tokenFromHash('k', 'staffToken');
let A, conn, view, tab = prefs.get('beheerTab2', 'home');
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
  main.innerHTML = `<div class="wrap"><h1>Beheer</h1>
    <div class="card"><div class="field"><label for="pw">Beheerwachtwoord van deze server</label><input id="pw" type="password" required autocomplete="current-password"></div>
      <div class="row"><button class="btn primary" id="listEv">Mijn avonden openen</button></div>
      <div id="evList"></div><p id="err" class="notice bad" hidden></p></div>
    <details class="card" style="margin-top:14px"><summary><b>Nieuwe avond aanmaken</b></summary>
      <form id="newEv" style="margin-top:12px">
        <div class="field"><label for="nm">Naam van de avond</label><input id="nm" required value="Muchacho’s — Vriendenweekend 2027"></div>
        <div class="field"><label for="dt">Datum en aanvang (mag later)</label><input id="dt" type="datetime-local"></div>
        <div class="row"><button class="btn ghost" name="real">Avond aanmaken</button><button class="btn ghost" name="demo" type="submit">Demo-editie starten</button></div>
      </form></details>
    <p class="small muted" style="margin-top:14px">Heb je al een beheerlink? Open die link; hij bevat je toegang.</p></div>`;
  const err = m => { $('#err').hidden = !m; $('#err').textContent = m || ''; };
  const go = r => { prefs.set('displayToken', r.displayToken); prefs.set('tvToken.' + r.eventId, r.displayToken); location.href = '/beheer#k=' + r.ownerToken; location.reload(); };
  const P = () => api({ 'x-admin-password': $('#pw').value });
  $('#pw').onkeydown = e => { if (e.key === 'Enter') $('#listEv').click(); };
  $('#listEv').onclick = async () => {
    if (!$('#pw').value) return err('Vul eerst het beheerwachtwoord in.');
    try {
      const list = await P().post('/api/admin/events'); err('');
      $('#evList').innerHTML = list.length ? `<ul class="list" style="margin-top:12px">${list.map(e => `<li class="row" style="justify-content:space-between;align-items:center">
        <span><b>${esc(e.name)}</b>${e.isDemo ? ' <span class="demo-badge">Demo</span>' : ''}<br><span class="small muted">${e.questions} vragen · ${e.participants} spelers${e.startsAt ? ' · ' + esc(e.startsAt.replace('T', ' ')) : ''}</span></span>
        <button class="btn ${e.isDemo ? 'ghost' : 'primary'}" data-open="${e.id}">Openen</button></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:12px">Nog geen avonden. Maak er hieronder een aan.</p>';
      $$('[data-open]').forEach(b => b.onclick = async () => { try { go(await P().post(`/api/admin/events/${b.dataset.open}/open`)); } catch (e) { err(e.message); } });
    } catch (e) { err(e.message); }
  };
  $('#newEv').onsubmit = async e => {
    e.preventDefault();
    if (!$('#pw').value) return err('Vul eerst het beheerwachtwoord in.');
    const demo = e.submitter?.name === 'demo';
    try { go(demo ? await P().post('/api/demo') : await P().post('/api/events', { name: $('#nm').value, startsAt: $('#dt').value || null })); }
    catch (x) { err(x.message); }
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
  const t = [['home', 'Start']];
  if (v.perms.people) t.push(['people', 'Teams']);
  t.push(['plan', v.perms.content ? 'Vragen' : 'Programma']);
  if (v.missions || v.shots) t.push(['extra', 'Shots & opdrachten']);
  if (v.messages && v.perms.content) t.push(['msgs', 'Berichten']);
  t.push(['ready', 'Check']);
  if (v.perms.live) t.push(['live', '▶ Quiz spelen']);
  if (v.perms.scores) t.push(['scores', 'Scores']);
  if (v.perms.roles) t.push(['event', 'Instellingen']);
  return t;
}

let lastTabs = '';
const openDetails = new Set();
function goTab(k) { tab = k; prefs.set('beheerTab2', tab); editing = null; lastTabs = ''; render(); window.scrollTo(0, 0); }
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
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; prefs.set('beheerTab2', tab); editing = null; lastTabs = ''; render(); });
  }
  if (editing && (tab === 'plan' || tab === 'extra' || tab === 'msgs')) return; // formulier niet overschrijven tijdens bewerken
  const qf = document.getElementById('qmForm');
  if (tab === 'home' && qf && (qf.contains(document.activeElement) || $('#qmTitle').value || $('#qmBody').value)) return; // bericht in de maak
  const scrollY = window.scrollY;
  const focusId = document.activeElement?.id;
  ({ home: homeTab, live: liveTab, plan: planTab, people: peopleTab, ready: readyTab, scores: scoresTab, event: eventTab, extra: extraTab, msgs: msgsTab }[tab])(v);
  $$('details[data-keep]').forEach(d => { if (openDetails.has(d.dataset.keep)) d.open = true; d.ontoggle = () => { d.open ? openDetails.add(d.dataset.keep) : openDetails.delete(d.dataset.keep); }; });
  $$('[data-goto]').forEach(b => b.onclick = () => goTab(b.dataset.goto));
  if (tab === 'home' && v.perms.roles) bindTodo(v);
  if (tab === 'home' || tab === 'ready') bindJongens(v);
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

// ---------- START ----------
function tvHref(v) { const t = prefs.get('tvToken.' + v.event.id, null); return t ? '/tv#k=' + encodeURIComponent(t) : '/tv'; }
let jobLink = null;
const waHref = t => 'https://wa.me/?text=' + encodeURIComponent(t);
function todoCard(v) {
  const joined = (v.teams || []).flatMap(t => t.members).filter(m => m.joined).length + (v.unassigned || []).filter(m => m.joined).length;
  const total = (v.teams || []).flatMap(t => t.members).length;
  const job = (v.grants || []).filter(g => g.role === 'spoilerfree' && !g.revoked);
  if (total && joined >= total && job.length && !jobLink) return '';
  const pText = `BAMIGO 23 januari: meld je aan via ${v.event.joinUrl} en kies je naam. Zet de site daarna op je beginscherm en zet meldingen aan. VAMOSSS!`;
  return `<section class="card todo"><h2 style="margin:0 0 4px">Nog twee dingen</h2><p class="muted small" style="margin:0 0 14px">De vragen, het spelersdossier, de verzegelde ronde, de berichten en de duo's staan klaar.</p>
    <div class="todo-step ${joined ? 'done' : ''}"><span class="home-num">1</span><div class="grow"><b>Deel de spelerslink met de 10 spelers</b>
      <p class="small muted" style="margin:2px 0 8px">Privé of in een eigen groepje (niet in Brocode). Ze kiezen hun naam en komen vanzelf in hun duo. ${total ? `<b>${joined}/${total} aangemeld.</b>` : ''}</p>
      <div class="row" style="gap:8px"><input readonly value="${esc(v.event.joinUrl)}" style="flex:1;min-width:200px" aria-label="Spelerslink">
      <button class="btn ghost" data-copy="${esc(v.event.joinUrl)}">Kopieer</button><a class="btn primary" href="${waHref(pText)}" target="_blank" rel="noopener">Deel via WhatsApp</a></div></div></div>
    <div class="todo-step ${job.length ? 'done' : ''}"><span class="home-num">2</span><div class="grow"><b>Link voor Job (spoilervrij)</b>
      <p class="small muted" style="margin:2px 0 8px">Job ziet wie nog iets moet invullen, maar geen vragen, antwoorden of shots. Stuur hem de link privé.</p>
      ${jobLink ? `<div class="row" style="gap:8px"><input readonly value="${esc(jobLink)}" style="flex:1;min-width:200px" aria-label="Link voor Job"><button class="btn ghost" data-copy="${esc(jobLink)}">Kopieer</button>
        <a class="btn primary" href="${waHref('Job, hier is je BAMIGO-link als spoilervrije medequizmaster: ' + jobLink + ' . Je ziet wie nog iets moet invullen, maar geen vragen of antwoorden.')}" target="_blank" rel="noopener">Deel via WhatsApp</a></div>`
        : `<button class="btn ${job.length ? 'ghost' : 'primary'}" id="mkJob">${job.length ? 'Nieuwe link maken (oude stopt)' : 'Maak Job’s link'}</button>${job.length ? ' <span class="pill ok"><span class="dot"></span>al gemaakt</span>' : ''}`}</div></div></section>`;
}
function bindTodo(v) {
  $$('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('Gekopieerd.'); } catch { b.previousElementSibling?.select?.(); toast('Selecteer en kopieer de link.'); } });
  const mk = $('#mkJob'); if (mk) mk.onclick = () => act(mk, async () => {
    for (const g of (v.grants || []).filter(g => g.role === 'spoilerfree' && !g.revoked)) await A.post(`/api/staff/grants/${g.id}/revoke`);
    const r = await A.post('/api/staff/grants', { role: 'spoilerfree', label: 'Job' }); jobLink = r.url; render();
  }, 'Link voor Job gemaakt.');
}
function homeTab(v) {
  const r = v.readiness || {};
  const n = (x, one, many) => `${x ?? 0} ${x === 1 ? one : many}`;
  const qWarn = !v.perms.content ? '' : r.exampleQuestions ? `<span class="pill warn">${n(r.exampleQuestions, 'voorbeeldvraag', 'voorbeeldvragen')}</span>` : r.questionsWithoutAnswer ? `<span class="pill bad">${n(r.questionsWithoutAnswer, 'vraag', 'vragen')} zonder antwoord</span>` : '';
  const item = (go, title, sub, extra = '') => `<button class="home-item" data-goto="${go}"><span class="grow"><b>${title}</b><span class="small muted">${sub}</span></span>${extra}<span class="arrow" aria-hidden="true">›</span></button>`;
  main.innerHTML = `<div class="home">
    ${v.perms.roles ? todoCard(v) : ''}
    ${v.perms.people ? progressCard(v, { compact: true }) + quickMsgCard(v) : ''}
    <h1 class="home-title" style="margin-top:22px">Wat wil je doen?</h1>
    <div class="home-grid">
      <section class="home-step"><span class="home-num">1</span><h2>Voorbereiden</h2><p class="muted">Vooraf, rustig thuis.</p>
        ${v.perms.people ? item('people', 'Teams en spelers', `${n(r.teams, 'team', 'teams')} · ${n(r.participants, 'speler', 'spelers')}`) : ''}
        ${item('plan', v.perms.content ? 'Vragen en rondes' : 'Programma', `${n(v.rounds.length, 'ronde', 'rondes')} · ${n(r.questions, 'vraag', 'vragen')}`, qWarn)}
        ${v.missions || v.shots ? item('extra', 'Shots en opdrachten', `${n(r.shotsSubmitted, 'shot', 'shots')} ingevuld · ${n(r.missions, 'opdracht', 'opdrachten')}`) : ''}
        ${v.messages && v.perms.content ? item('msgs', 'Berichten aan spelers', `${n(v.messages.list.filter(m => !m.sentAt).length, 'bericht', 'berichten')} ingepland · ${n(v.messages.pushPlayers, 'speler', 'spelers')} met meldingen`) : ''}
        ${item('ready', 'Check: is alles klaar?', 'Overzicht van wat nog ontbreekt')}
      </section>
      ${v.perms.live ? `<section class="home-step main"><span class="home-num">2</span><h2>Quiz spelen</h2><p class="muted">Op de avond zelf.</p>
        <ol class="home-howto">
          <li><a class="btn ghost" href="${tvHref(v)}" target="_blank" rel="noopener">TV-scherm openen</a><span class="small muted">Zet dit venster op de tv.</span></li>
          <li><span>Spelers scannen de QR-code op de tv, of gaan naar <b>${esc(location.host)}/speel</b> met code <b class="code">${esc(v.event.joinCode)}</b>.</span></li>
          <li><button class="btn primary big" data-goto="live">Start de quiz</button></li>
        </ol></section>` : ''}
      ${v.perms.scores || v.perms.roles ? `<section class="home-step"><span class="home-num">3</span><h2>Na afloop</h2><p class="muted">Uitslag en bewaren.</p>
        ${v.perms.scores ? item('scores', 'Scores', 'Stand, correcties en uitslag downloaden') : ''}
        ${v.perms.roles ? item('event', 'Instellingen', 'Naam, links voor anderen, kopie maken') : ''}
      </section>` : ''}
    </div></div>`;
}

// ---------- LIVE ----------
const PHASE_LABEL = { idle: 'Geen vraag actief', ready: 'Klaar om te openen', open: 'Open', closed: 'Gesloten', revealed: 'Onthuld', scored: 'Gescoord' };
const SCREEN_LABEL = { lobby: 'Lobby', round_intro: 'Ronde-intro', question: 'Vraag', scoreboard: 'Scorebord', break: 'Pauze', finale: 'Finale', shots_reveal: 'Shotonthulling', envelopes: 'Enveloppen' };

const FLOW = ['Klaarzetten', 'Openen', 'Antwoorden', 'Onthullen', 'Punten'];
const FLOW_AT = { idle: 0, ready: 1, open: 2, closed: 3, revealed: 4, scored: 5 };
function explain(v) {
  const p = v.live.phase; const q = v.question;
  const idle = p === 'idle' || p === 'scored' || (p === 'closed' && ['shot', 'envelope'].includes(q?.type));
  if (idle && !v.nextQuestionId) return v.envelope?.filled && !v.envelope.opened ? 'Alle vragen zijn gespeeld! Nu de spanning: open de enveloppen op tv. Daarna de definitieve eindstand.'
    : v.live.screen !== 'finale' ? 'Klaar met de enveloppen? Zet de definitieve eindstand op tv. VAMOSSS!' : 'Dat was BAMIGO! De eindstand staat op tv. Uitslag bewaren kan bij Scores.';
  if (idle && nextRoundIntro(v)) return `Volgende ronde: de tv toont eerst de titel en uitleg. Lees hem voor, en druk daarna op “Volgende vraag klaarzetten”.${v.rounds.length ? ' Tussen de rondes kun je de Shot-roulette draaien (kaart hieronder).' : ''}`;
  if (p === 'ready' && q?.pitch && !q.pitch.team) return 'Dragons: wie pitcht dit ding? Laat BAMIGO loten met de knop, of kies zelf een team in de kaart hieronder.';
  if (p === 'ready' && q?.pitch) return `${q.pitch.team.name} pitcht. Open de vraag: het ding verschijnt op tv en de andere teams bieden. Jouw eigen bod als Dragon doe je in de kaart hieronder.`;
  if (p === 'open' && q?.career && !q.career.auto) return q.career.clues.length < q.career.total ? `Hint ${q.career.clues.length} van ${q.career.total} staat op tv. Geef de teams even, en zet dan de volgende hint op tv. Hoe eerder goed, hoe meer punten.` : 'Alle hints staan op tv. Sluit de vraag als iedereen gekozen heeft.';
  if (p === 'open' && q?.type === 'envelope') return 'De captains voorspellen hun eindplek (en hun belofte). Vul ook jouw eigen voorspelling in, in de kaart “De BAMIGO Envelop” hieronder.';
  if (p === 'open' && q?.pitch) return 'De andere teams bieden nu geheim. Vergeet jouw eigen bod als Dragon niet (kaart hieronder). Sluit als iedereen geboden heeft.';
  if (p === 'idle') return v.nextQuestionId ? 'Druk op de knop om de eerste vraag klaar te zetten. Spelers zien nog niets.' : 'Er staan nog geen vragen klaar.';
  if (p === 'ready') return 'De vraag staat klaar, maar is nog geheim. Druk op de knop: de tv telt af en de vraag verschijnt op tv en telefoons.';
  if (p === 'open') return 'Spelers antwoorden nu op hun telefoon. De vraag sluit vanzelf als de tijd op is. Iedereen klaar? Dan mag je zelf sluiten.';
  if (p === 'closed' && q?.type === 'envelope') return 'De enveloppen zijn verzegeld, ook voor jou. Ze gaan open bij de uitslag (kaart “De BAMIGO Envelop”). Ga door naar de volgende vraag.';
  if (p === 'closed' && q?.type === 'shot') return 'Shots worden pas aan het eind van de ronde samen onthuld. Ga door naar de volgende shot.';
  const review = (v.submissions || []).filter(s => s.verdict === 'review').length;
  if (['closed', 'revealed'].includes(p) && review) return `Beoordeel eerst ${review === 1 ? 'het antwoord' : `de ${review} antwoorden`} met twijfel: ✓ of ✗ in de kaart hieronder. Daarna ${p === 'closed' ? 'onthullen' : 'punten toekennen'}.`;
  if (p === 'closed') return 'De vraag is dicht. Druk op de knop om het goede antwoord op de tv te laten zien.';
  if (p === 'revealed') return 'Het antwoord staat op de tv. Druk op de knop om de punten bij te schrijven.';
  if (p === 'scored' && v.nextQuestionId && v.question?.played) return 'Je kijkt terug naar een gespeelde vraag. Het antwoord staat op de tv; de punten tellen al. Druk op de knop om verder te gaan.';
  return 'Klaar! Druk op de knop voor de volgende vraag. Tussendoor de stand laten zien? Kies “Scorebord” bij “Meer opties”.';
}
/** Welke ronde hoort bij de volgende vraag, en staat de intro daarvan al op tv? */
function nextRoundIntro(v) {
  if (!v.nextQuestionId) return null;
  const r = v.rounds.find(r => (r.questions || []).some(q => q.id === v.nextQuestionId));
  if (!r) return null;
  const curRound = v.question ? v.rounds.find(x => (x.questions || []).some(q => q.id === v.question.id))?.id : null;
  if (r.id === curRound) return null;
  if (v.live.screen === 'round_intro' && v.live.round?.id === r.id) return null;
  return r;
}
function endAction(v) {
  if (v.envelope?.filled && !v.envelope.opened) return ['envelopes_open', '✉️ Enveloppen openen op tv'];
  if (v.live.screen !== 'finale') return ['screen_finale', '🏆 Definitieve eindstand op tv'];
  return null;
}
function primaryAction(v) {
  const p = v.live.phase; const q = v.question;
  const idle = p === 'idle' || p === 'scored' || (p === 'closed' && ['shot', 'envelope'].includes(q?.type));
  if (idle && !v.nextQuestionId) return endAction(v);
  const ri = idle ? nextRoundIntro(v) : null;
  if (ri) return ['round_intro', `Ronde starten: ${ri.title}`, { roundId: ri.id }];
  if (p === 'ready' && q?.pitch && !q.pitch.team) return ['pitch_team', '🎲 Loot wie er pitcht', { message: 'random' }];
  if (p === 'open' && q?.career && !q.career.auto && q.career.clues.length < q.career.total) return ['clue_next', `Hint ${q.career.clues.length + 1} op tv`];
  if (p === 'closed' && v.question?.type === 'shot') return v.nextQuestionId ? ['next_question', 'Volgende shot klaarzetten'] : null;
  if (p === 'closed' && v.question?.type === 'envelope') return v.nextQuestionId ? ['next_question', 'Volgende vraag klaarzetten'] : null;
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
      <ol class="flow">${FLOW.map((f, i) => `<li class="${i < FLOW_AT[L.phase] ? 'done' : i === FLOW_AT[L.phase] ? 'now' : ''}">${f}</li>`).join('')}</ol>
      <p class="explain">${esc(explain(v))}</p>
      <div class="state-line"><span class="pill">Op tv: ${SCREEN_LABEL[L.screen]}</span>
        ${L.paused ? '<span class="pill warn"><span class="dot"></span>Gepauzeerd</span>' : ''}
        ${L.phase === 'open' && L.deadline ? `<span class="timer" style="font-size:1.8rem" data-timer>--:--</span>` : ''}
        ${v.counts ? `<span class="pill">${v.counts.submitted}/${v.counts.expected} ingestuurd</span>` : ''}</div>
      ${q ? `<p class="small muted" style="margin:0">${esc(L.round?.title || '')} · vraag ${q.number}/${q.of} · ${TYPE_LABEL[q.type]} · ${q.scope === 'team' ? 'team' : 'individueel'}${q.scoring === 'speed' ? ' · bliksem' : ''}</p>
        <h2 style="margin:6px 0">${esc(q.prompt ?? allQs.find(x => x.id === q.id)?.prompt ?? '(vraagtekst verborgen tot openen)')}</h2>
        ${qFull.options?.length ? `<ol type="A" class="small">${qFull.options.map(o => `<li>${esc(o)}</li>`).join('')}</ol>` : ''}` : ''}
      ${v.currentKey && (fmtKey(qFull, v.currentKey) || v.currentKey.explanation) ? `<p class="notice ok small">Antwoord: <b>${esc(fmtKey(qFull, v.currentKey))}</b>${v.currentKey.explanation ? ' — ' + esc(v.currentKey.explanation) : ''}</p>`
        : q && !v.currentKey && !['envelope', 'invest', 'ranking', 'shot'].includes(q.type) ? '<p class="small muted">Antwoordsleutel verschijnt na sluiten.</p>' : ''}
      ${L.message ? `<p class="notice warn small">${esc(L.message)}</p>` : ''}
      ${pa ? `<button id="primary" class="btn primary primary-action" data-act="${pa[0]}" data-extra="${esc(JSON.stringify(pa[2] || {}))}">${esc(pa[1])}</button>` : ''}
      <div class="row" style="margin-top:12px">
        ${v.prevQuestionId ? `<button class="btn ghost small" data-act="prev_question" ${L.phase === 'open' ? 'disabled' : ''}>← Vorige vraag</button>` : ''}
        <a class="btn ghost small" href="${tvHref(v)}" target="_blank" rel="noopener">TV-scherm openen</a>
        <span class="small muted">Spelcode <b class="code">${esc(v.event.joinCode)}</b></span>
      </div>
    </div>
    ${subs.some(x => x.verdict === 'review') ? `<div class="card" style="border-color:var(--warn)"><h3>Beoordelen (${subs.filter(x => x.verdict === 'review').length})</h3>${subsTable(v, qFull, subs)}</div>` : ''}
    ${pitchCard(v)}
    ${careerCard(v)}
    ${hostInvestCard(v)}
    ${envelopeCard(v)}
    ${rouletteCard(v)}
    <details class="card more" data-keep="liveMore"><summary>Meer opties (scorebord, pauze, vraag schrappen)</summary>
      <p class="small muted" style="margin:12px 0 6px">Wat staat er op de tv?</p><div class="row">
      <button class="btn ghost small" data-act="screen_scoreboard">Scorebord</button>
      <button class="btn ghost small" data-act="screen_lobby">Lobby (QR-code)</button>
      <button class="btn ghost small" data-act="screen_break">Pauze</button>
      <button class="btn ghost small" data-act="screen_finale">Finale</button>
      <select id="introSel" style="width:auto;min-width:200px"><option value="">Ronde-intro…</option>${v.rounds.map(r => `<option value="${r.id}">${esc(r.title)}</option>`).join('')}</select></div>
      <p class="small muted" style="margin:14px 0 6px">Deze vraag</p><div class="row">
        ${L.phase === 'scored' ? '<button class="btn ghost small" data-act="score">Opnieuw scoren</button>' : ''}
        <button class="btn ghost small" data-act="${L.paused ? 'resume' : 'pause'}">${L.paused ? 'Hervat' : 'Pauzeer'}</button>
        ${q ? '<button class="btn danger small" data-act="void">Vraag ongeldig verklaren…</button>' : ''}
      </div>
    </details>
    ${(v.shotRounds || []).filter(r => r.id === L.round?.id || (r.locked === r.total && !r.revealed)).map(r => `<div class="card"><h3>${esc(r.title)}</h3><p class="small">${r.locked}/${r.total} shots gespeeld${r.revealed ? ' · onthuld' : ''}.</p>
      <button class="btn copper" data-shotreveal="${r.id}" ${r.locked < r.total || L.phase === 'open' ? 'disabled' : ''}>Shotonthulling${r.revealed ? ' opnieuw tonen' : ''}</button>
      ${r.locked < r.total ? '<p class="small muted" style="margin:8px 0 0">Kan pas als alle shots gespeeld zijn.</p>' : ''}</div>`).join('')}
    ${(subs.length || q) && !subs.some(x => x.verdict === 'review') ? `<div class="card"><h3>Inzendingen (${subs.length})</h3>${subsTable(v, qFull, subs)}</div>` : ''}
  </section>
  <section>
    <details class="card more" data-keep="liveQs"><summary>Alle vragen (overslaan of terugspringen)</summary><ul class="list qlist">${allQs.map(x => `<li class="${x.id === q?.id ? 'current' : ''}">
      <span class="small muted">${esc(x.round.title.slice(0, 14))}</span><span class="t ${x.voided ? 'voided' : ''}">${esc(x.prompt || TYPE_LABEL[x.type])}</span>
      ${x.isExample ? '<span class="example-badge">vb</span>' : ''}
      ${x.voided ? '<span class="small muted">vervallen</span>' : `${x.played ? '<span class="pill ok">gespeeld</span>' : ''}<button class="btn ghost small" data-prepare="${x.id}" ${L.phase === 'open' ? 'disabled' : ''}>${x.played ? 'Terugkijken' : 'Klaarzetten'}</button>`}</li>`).join('') || '<li class="muted">Nog geen vragen.</li>'}</ul></details>
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
    if (b.dataset.extra) return act(b, () => live(a, JSON.parse(b.dataset.extra)));
    if (a === 'prev_question') return act(b, () => live('prev_question'));
    act(b, () => live(a));
  });
  $$('[data-shotreveal]').forEach(b => b.onclick = () => { if (confirm('Alle shots onthullen en punten toekennen?')) act(b, () => live('shots_reveal', { roundId: b.dataset.shotreveal }), 'VAMOSSS!'); });
  $('#introSel').onchange = e => { if (e.target.value) act(null, () => live('round_intro', { roundId: e.target.value })); };
  $$('[data-prepare]').forEach(b => b.onclick = () => act(b, () => live('goto', { questionId: b.dataset.prepare })));
  $$('[data-judge]').forEach(b => b.onclick = () => act(b, () => A.post('/api/staff/judge', { submissionId: b.dataset.judge, verdict: b.dataset.v })));
  bindAdjust();
  bindRoulette(v);
  bindHostInvest(v);
  bindEnvelope(v);
  tickLive();
}

// ---------- DE BAMIGO ENVELOP ----------
let envDraft = null; // { qid, order: [teamId|''] }
function envelopeCard(v) {
  const E = v.envelope; if (!E) return '';
  const q = v.question; const L = v.live;
  const playing = q?.id === E.id && ['open', 'closed'].includes(L.phase) && !E.opened && L.screen !== 'envelopes';
  if (!playing && !E.opened && v.nextQuestionId) return ''; // tussendoor niet tonen: dan open je ze niet per ongeluk te vroeg
  const hostName = v.event.settings?.rouletteHost?.name || 'Rinus';
  if (playing && envDraft?.qid !== E.id) envDraft = { qid: E.id, order: v.teams.map(() => '') };
  const hostForm = playing ? `<details data-keep="envHost" style="margin-top:10px" ${E.hostDone ? '' : 'open'}><summary class="small"><b>Jouw eigen envelop</b> (voor de lol, geen punten) ${E.hostDone ? '<span class="pill ok">ingevuld</span>' : ''}</summary>
      <p class="small muted">Jouw voorspelde top ${v.teams.length}. Wordt bij de uitslag als laatste getoond, als “${esc(hostName)} voorspelde…”.</p>
      <div class="hi-grid">${v.teams.map((_, i) => `<label class="field" style="margin:0"><span>${i + 1}e plek</span><select id="env_${i}" data-envpos="${i}"><option value="">— kies —</option>${v.teams.map(t => `<option value="${t.id}" ${envDraft.order[i] === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>`).join('')}</div>
      <button class="btn copper small" id="envHostGo" style="margin-top:10px">${E.hostDone ? 'Envelop vervangen' : 'Envelop dichtplakken'}</button></details>` : '';
  return `<div class="card roulette-card"><div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">✉️ De BAMIGO Envelop</h3>
      <span class="small muted">${E.opened ? 'geopend' : E.filled ? `${E.count} van ${v.teams.length} enveloppen verzegeld` : 'nog niet gespeeld'}</span></div>
    <p class="small muted" style="margin:6px 0 10px">${E.filled ? 'Bij de uitslag: open de enveloppen op tv. De bonus telt dan mee; laat daarna de Finale zien als definitieve eindstand.' : 'Speel de envelop-vraag aan het begin van de avond (staat in je vragenlijst). Teams voorspellen dan hun eigen eindplek.'}</p>
    <div class="row">${E.filled ? `<button class="btn copper" id="envOpen" ${L.phase === 'open' ? 'disabled' : ''}>${E.opened ? 'Enveloppen opnieuw tonen' : 'Enveloppen openen op tv'}</button>` : ''}
      ${E.opened ? '<button class="btn primary" data-act="screen_finale">Definitieve eindstand (Finale)</button>' : ''}</div>
    ${hostForm}</div>`;
}
function bindEnvelope(v) {
  if ($('#envOpen')) $('#envOpen').onclick = e => { if (v.envelope.opened || confirm('Enveloppen nu openen op tv? De stand wordt vastgezet en de bonus bijgeschreven.')) act(e.target, () => live('envelopes_open', { questionId: v.envelope.id }), 'De enveloppen gaan open!'); };
  $$('[data-envpos]').forEach(s => s.onchange = () => { envDraft.order[+s.dataset.envpos] = s.value; });
  if ($('#envHostGo')) $('#envHostGo').onclick = e => {
    const order = envDraft.order;
    if (order.some(x => !x) || new Set(order).size !== order.length) return toast('Zet elk team precies één keer op een plek.', 'bad');
    act(e.target, () => A.post('/api/staff/live', { action: 'host_envelope', answer: order }), 'Envelop dichtgeplakt.');
  };
}

// ---------- DRAGONS: QUIZMASTER INVESTEERT ----------
let hiDraft = null; // { qid, amounts }
function careerCard(v) {
  const q = v.question; if (!q?.career || !v.careerAll) return '';
  const shown = q.career.clues.length; const open = v.live.phase === 'open';
  return `<div class="card roulette-card"><div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">💼 Van wie is deze carrière?</h3>
    <span class="small muted">${open ? `hint ${shown} van ${q.career.total} op tv` : ''}</span></div>
    <ol class="qn-list" style="margin:8px 0 10px">${v.careerAll.map((t, i) => `<li style="${i < shown || !open ? '' : 'opacity:.5'}">${esc(t)} <span class="small muted">(${q.career.scale?.[i] ?? 0} pt)</span></li>`).join('')}</ol>
    ${open && !q.career.auto ? `<button class="btn copper" id="clueNext" ${shown >= q.career.total ? 'disabled' : ''}>Volgende hint op tv</button>` : ''}
    ${q.career.auto ? `<p class="small muted" style="margin:0">Automatisch: elke ${q.career.auto} s een nieuwe hint.</p>` : ''}</div>`;
}
function pitchCard(v) {
  const q = v.question; if (!q?.pitch || v.live.phase !== 'ready') return '';
  const done = new Set(v.pitchDone || []);
  return `<div class="card roulette-card"><h3 style="margin:0 0 6px">🎤 Wie pitcht dit ding?</h3>
    <p class="small muted" style="margin:0 0 10px">Het ding verschijnt pas op tv als je de vraag opent. Kies een team of laat BAMIGO loten (alleen teams die nog niet pitchten).</p>
    <div class="row" style="gap:6px">${v.teams.map(t => `<button class="btn ${q.pitch.team?.id === t.id ? 'primary' : 'ghost'} small" data-pitch="${t.id}" ${done.has(t.id) ? 'disabled title="Heeft al gepitcht"' : ''}>${esc(t.name)}</button>`).join('')}
      <button class="btn copper small" data-pitch="random">🎲 Loten</button></div>
    ${q.pitch.team ? `<p class="small" style="margin:10px 0 0">Gekozen: <b>${esc(q.pitch.team.name)}</b>. Open nu de vraag.</p>` : ''}</div>`;
}
function hostInvestCard(v) {
  const q = v.question;
  if (q?.pitch && ['open', 'closed'].includes(v.live.phase)) {
    const st = v.pitchStatus; const mine = (v.submissions || []).find(s => s.owner === 'host');
    if (!st) return '';
    const eur = n => '€' + Number(n).toLocaleString('nl-NL');
    return `<div class="card roulette-card"><div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Jouw bod als Dragon</h3>${mine ? '<span class="pill ok"><span class="dot"></span>ingestuurd</span>' : ''}</div>
      <p class="small muted" style="margin:6px 0 10px">Op ${esc(q.pitch.team?.name || '?')}. Je hebt nog <b>${eur(st.remaining)}</b>${st.mustAll ? ' en dit is je laatste kans: alles moet erin.' : `, nog ${st.later} pitch${st.later === 1 ? '' : 'es'} hierna.`}</p>
      <div class="row" style="align-items:center"><input id="hiBid" type="number" min="0" step="500" max="${st.remaining}" value="${st.mustAll ? st.remaining : (mine?.answer?.amount ?? '')}" ${st.mustAll ? 'readonly' : ''} placeholder="0" style="width:160px">
      <button class="btn copper" id="hiBidGo">${mine ? 'Bod bijwerken' : 'Bod insturen'}</button></div></div>`;
  }
  if (!q || q.type !== 'invest' || !['open', 'closed'].includes(v.live.phase)) return '';
  const mine = (v.submissions || []).find(s => s.owner === 'host');
  const budget = q.budget || 10000, step = q.step || 500;
  if (hiDraft?.qid !== q.id) hiDraft = { qid: q.id, amounts: { ...(mine?.answer || {}) } };
  const sum = Object.values(hiDraft.amounts).reduce((a, b) => a + (+b || 0), 0);
  const eur = n => '€' + n.toLocaleString('nl-NL');
  return `<div class="card roulette-card"><div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">Jouw investering als Dragon</h3>${mine ? '<span class="pill ok"><span class="dot"></span>ingestuurd</span>' : ''}</div>
    <p class="small muted" style="margin:6px 0 12px">Verdeel ${eur(budget)} over de teams, in stappen van ${eur(step)}. Telt mee in de totalen. Aanpassen kan tot je het antwoord onthult.</p>
    <div class="hi-grid">${v.teams.map(t => `<label class="field" style="margin:0"><span>${esc(t.name)}</span><input id="hi_${t.id}" type="number" min="0" step="${step}" max="${budget}" data-hi="${t.id}" value="${hiDraft.amounts[t.id] || ''}" placeholder="0" inputmode="numeric"></label>`).join('')}</div>
    <div class="row" style="margin-top:10px;align-items:center"><span id="hiSum" class="pill ${sum === budget ? 'ok' : ''}">${eur(sum)} van ${eur(budget)}</span>
      <button class="btn copper" id="hiGo">${mine ? 'Investering bijwerken' : 'Investering insturen'}</button></div></div>`;
}
function bindHostInvest(v) {
  if ($('#clueNext')) $('#clueNext').onclick = e => act(e.target, () => live('clue_next'), 'Hint op tv.');
  $$('[data-pitch]').forEach(b => b.onclick = () => act(b, () => live('pitch_team', { message: b.dataset.pitch }), b.dataset.pitch === 'random' ? 'Geloot!' : 'Gekozen.'));
  if ($('#hiBidGo')) $('#hiBidGo').onclick = e => act(e.target, () => A.post('/api/staff/live', { action: 'host_invest', answer: { amount: Number($('#hiBid').value) || 0 } }), 'Bod vastgelegd.');
  if (!$('#hiGo')) return;
  const q = v.question; const budget = q.budget || 10000;
  $$('[data-hi]').forEach(i => i.oninput = () => {
    hiDraft.amounts[i.dataset.hi] = +i.value || 0;
    const sum = Object.values(hiDraft.amounts).reduce((a, b) => a + (+b || 0), 0);
    $('#hiSum').textContent = `€${sum.toLocaleString('nl-NL')} van €${budget.toLocaleString('nl-NL')}`; $('#hiSum').className = 'pill ' + (sum === budget ? 'ok' : '');
  });
  $('#hiGo').onclick = e => {
    const answer = Object.fromEntries(Object.entries(hiDraft.amounts).filter(([, a]) => +a > 0).map(([k, a]) => [k, +a]));
    act(e.target, () => A.post('/api/staff/live', { action: 'host_invest', answer }), 'Investering vastgelegd. Dragon!');
  };
}

// ---------- SHOT-ROULETTE ----------
let rlEx = null, rlHost = null;
const QN_LABEL = { open: 'open', number: 'getal', scale: 'cijfer 1–10', time: 'tijd', muchacho: 'kies een Muchacho' }; // lokale keuze 'doet niet mee' (overleeft verversen van het scherm)
const RL_TASKS = ['Neem een shotje!', 'Neem 3 slokken!', 'Neem een 0.0-shotje!'];
function rouletteCard(v) {
  const r = v.live.roulette; const ex = rlEx ?? v.event.settings?.rouletteExclude ?? [];
  const people = [...v.teams.flatMap(t => t.members), ...(v.unassigned || [])].filter(m => m.joined).sort((a, b) => a.name.localeCompare(b.name));
  const pick = prefs.get('rlTask', RL_TASKS[0]);
  const custom = !RL_TASKS.includes(pick);
  const hs = rlHost ?? v.event.settings?.rouletteHost ?? { on: false, name: 'Rinus' };
  const active = r && v.serverNow - r.at < 40000;
  return `<div class="card roulette-card"><div class="row" style="justify-content:space-between;align-items:baseline"><h3 style="margin:0">BAMIGO Shot-roulette</h3><span class="small muted">tussen de rondes · geen punten</span></div>
    <p class="small muted" style="margin:6px 0 12px">BAMIGO kiest willekeurig één speler. Op tv en telefoons: “BAMIGOOO SHOTSS, wie is de Lul!?”, aftellen, en dan de winnaar.</p>
    <div class="row"><select id="rlTask" style="width:auto;min-width:200px">${RL_TASKS.map(t => `<option ${t === pick ? 'selected' : ''}>${t}</option>`).join('')}<option value="__eigen" ${custom ? 'selected' : ''}>Zelf typen…</option></select>
      <input id="rlCustom" maxlength="80" placeholder="Bijv. Zing het Wilhelmus" value="${custom ? esc(pick) : ''}" ${custom ? '' : 'hidden'} style="width:auto;flex:1;min-width:180px">
      <button class="btn copper" id="rlGo">Draai de shot-roulette!</button></div>
    ${r ? `<p class="small" style="margin:12px 0 0">${active ? 'Nu op tv' : 'Laatste winnaar'}: <b>${esc(r.winner.name)}</b> · ${esc(r.task)} ${active ? '<button class="btn ghost small" id="rlClose">Weghalen van tv</button>' : ''}</p>` : ''}
    <div class="row" style="margin-top:10px;align-items:center"><label class="check" style="margin:0"><input type="checkbox" id="rlHostOn" ${hs.on ? 'checked' : ''}> Quizmaster doet ook mee als</label>
      <input id="rlHostName" maxlength="40" value="${esc(hs.name)}" style="width:140px"><span class="small muted">(wint hij, dan een 0.0-shotje)</span></div>
    <details data-keep="rlEx" style="margin-top:10px"><summary class="small">Wie doet niet mee? ${ex.length ? `(${ex.length} uitgesloten)` : ''}</summary>
      ${people.length ? `<div class="rl-ex">${people.map(p => `<label class="check"><input type="checkbox" data-rlex="${p.id}" ${ex.includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('')}</div>
      <p class="small muted" style="margin:6px 0 0">Aangevinkt = wordt nooit gekozen (bijv. wie niet drinkt). Wordt bewaard bij de volgende draai.</p>` : '<p class="small muted">Nog niemand aangemeld.</p>'}</details>
  </div>`;
}
function bindRoulette(v) {
  const sel = $('#rlTask'); if (!sel) return;
  sel.onchange = () => { const c = sel.value === '__eigen'; $('#rlCustom').hidden = !c; if (c) $('#rlCustom').focus(); else prefs.set('rlTask', sel.value); };
  $('#rlCustom').onchange = e => prefs.set('rlTask', e.target.value.trim() || RL_TASKS[0]);
  const keepHost = () => { rlHost = { on: $('#rlHostOn').checked, name: $('#rlHostName').value }; };
  $('#rlHostOn').onchange = keepHost; $('#rlHostName').oninput = keepHost;
  $$('[data-rlex]').forEach(c => c.onchange = () => { rlEx = $$('[data-rlex]').filter(x => x.checked).map(x => x.dataset.rlex); });
  $('#rlGo').onclick = e => {
    const task = sel.value === '__eigen' ? ($('#rlCustom').value.trim() || RL_TASKS[0]) : sel.value;
    const exclude = $$('[data-rlex]').filter(c => c.checked).map(c => c.dataset.rlex);
    act(e.target, () => A.post('/api/staff/live', { action: 'roulette', task, exclude, host: { on: $('#rlHostOn').checked, name: $('#rlHostName').value } }), 'BAMIGOOO SHOTSS!');
  };
  if ($('#rlClose')) $('#rlClose').onclick = e => act(e.target, () => A.post('/api/staff/live', { action: 'roulette_close' }));
}

function fmtKey(q, k) {
  if (!q || k.correct == null) return q?.type === 'open' ? 'Geen vast antwoord: jij beoordeelt (✓/✗ bij de inzendingen)' : '';
  if ((q.type === 'mc' || q.type === 'tf') && q.options) return [].concat(k.correct).map(i => `${LETTERS[i]}. ${q.options[i]}`).join(' / ');
  if (q.type === 'open') return [k.correct, ...k.accepted].join(' / ');
  if (q.type === 'order' && q.options) return k.correct.map(i => q.options[i]).join(' → ');
  return String(k.correct) + (k.tolerance ? ` (±${k.tolerance})` : '');
}

function subsTable(v, q, subs) {
  if (!subs.length) return '<p class="muted small">Nog niets binnen.</p>';
  const showAns = subs.some(s => s.answer !== undefined);
  const nameOf = id => v.teams.flatMap(t => t.members).concat(v.unassigned || []).find(m => m.id === id)?.name || v.teams.find(t => t.id === id)?.name || id;
  const fmtA = a => q && (q.type === 'mc' || q.type === 'tf') && q.options ? `${LETTERS[a]}. ${q.options[a] ?? ''}`
    : q?.type === 'ranking' ? [].concat(a).map(nameOf).join(', ')
    : Array.isArray(a) ? (q?.type === 'envelope' ? a.map(nameOf).join(' > ') : q?.type === 'order' && q.options ? a.map(i => q.options[i]).join(' → ') : a.join(', '))
    : a && typeof a === 'object' ? (a.amount != null ? '€' + Number(a.amount).toLocaleString('nl-NL') : a.place != null ? `plek ${a.place + 1}${a.pledge ? ' · belofte: ' + a.pledge : ''}` : a.pick ? `${nameOf(a.pick)} (hint ${a.clue})` : JSON.stringify(a))
    : q?.type === 'envelope' && typeof a === 'number' ? `plek ${a + 1}` : a;
  return `<table class="subs"><thead><tr><th>Wie</th><th>Tijd</th>${showAns ? '<th>Antwoord</th><th>Oordeel</th><th></th>' : ''}</tr></thead><tbody>
  ${subs.map(s => `<tr><td>${esc(s.team ? s.team + (q?.scope === 'individual' ? ' · ' + s.by : '') : s.by)}</td><td>${(s.elapsedMs / 1000).toFixed(2)}s${s.bet ? ` · inzet ${s.bet}` : ''}</td>
    ${showAns ? `<td>${esc(fmtA(s.answer))}</td><td class="v-${s.verdict || ''}">${s.verdict === 'correct' ? 'Goed' : s.verdict === 'wrong' ? 'Fout' : s.verdict === 'review' ? 'Beoordelen' : '—'}${s.manual ? ' (hand)' : ''}</td>
    <td>${['closed', 'revealed', 'scored'].includes(v.live.phase) ? `<button class="btn ghost small" data-judge="${s.id}" data-v="correct" aria-label="Goed rekenen">✓</button> <button class="btn ghost small" data-judge="${s.id}" data-v="wrong" aria-label="Fout rekenen">✗</button>` : ''}</td>` : ''}</tr>`).join('')}
  </tbody></table>`;
}

function adjustForm(v) {
  return `<details class="card more" data-keep="liveAdj"><summary>Punten corrigeren of bonus geven</summary><form id="adjust" style="margin-top:12px">
    <div class="field"><label for="adjTarget">Voor</label><select id="adjTarget" required><option value="">Kies…</option>
      <optgroup label="Teams">${v.teams.map(t => `<option value="t:${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>
      <optgroup label="Individueel (Snelste Bamigo)">${v.teams.flatMap(t => t.members).concat(v.unassigned).map(p => `<option value="p:${p.id}">${esc(p.name)}</option>`).join('')}</optgroup></select></div>
    <div class="row"><div class="grow field"><label for="adjPts">Punten (+/−)</label><input id="adjPts" type="number" required step="1"></div>
      <div class="grow field"><label for="adjKind">Soort</label><select id="adjKind"><option value="correction">Correctie</option><option value="bonus">Bonus (bv. outfit)</option></select></div></div>
    <div class="field"><label for="adjReason">Reden (verplicht)</label><input id="adjReason" required maxlength="200"></div>
    <button class="btn copper">Vastleggen</button></form></details>`;
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
  ${v.questionnaire && (v.questionnaire.questions.length || v.questionnaire.stories.length) ? `<details class="card more" data-keep="qnAns" style="margin-bottom:14px"><summary>Antwoorden vragenlijst vooraf (${v.questionnaire.filled} van ${v.questionnaire.total} ingevuld)</summary>
    ${v.questionnaire.questions.map(q => `<h4 style="margin:16px 0 6px">${esc(q.q)}</h4>${q.tally?.length ? `<p class="small" style="margin:0 0 6px;color:var(--champagne)">${q.tally.map(t => `${esc(t.name)}: <b>${t.n}</b>`).join(' · ')}</p>` : ''}${q.answers.length ? `<table class="subs"><tbody>${q.answers.map(a => `<tr><td style="width:30%"><b>${esc(a.name)}</b>${a.team ? `<br><span class="small muted">${esc(a.team)}</span>` : ''}</td><td>${esc(a.answer)}</td></tr>`).join('')}</tbody></table>` : '<p class="small muted">Nog geen antwoorden.</p>'}`).join('')}
    ${v.questionnaire.stories.length ? `<h4 style="margin:16px 0 6px">Verhalen en humorgrenzen</h4><table class="subs"><tbody>${v.questionnaire.stories.map(p => `<tr><td style="width:30%"><b>${esc(p.name)}</b></td><td>${esc(p.story)}${p.limits ? `<br><span class="small" style="color:var(--warn)">Liever niet: ${esc(p.limits)}</span>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
  </details>` : ''}
  <div id="editorSlot"></div>
  ${v.rounds.map((r, i) => `<section class="round">
    <header><span class="pill">${esc(ROUND_LABEL[r.kind] || r.kind)}</span><h3>${esc(r.title)}</h3><span class="muted small">${r.minutes} min · ${r.questionCount} vragen</span>
      ${canEdit ? `<button class="btn ghost small" data-rup="${i}" aria-label="Ronde omhoog" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn ghost small" data-redit="${r.id}">Bewerken</button><button class="btn ghost small" data-qadd="${r.id}">+ Vraag</button>
      <button class="btn danger small" data-rdel="${r.id}" aria-label="Ronde verwijderen">Verwijder</button>` : ''}</header>
    ${r.instructions ? `<p class="small muted" style="padding:8px 14px 0;margin:0">${esc(r.instructions)}</p>` : ''}
    ${r.sealed ? `<p class="notice small" style="margin:10px 14px">🔒 Verzegeld: inhoud verborgen. Ook voor jou, zodat je zelf kunt meespelen. Starten gaat gewoon via ▶ Quiz spelen.</p>` : ''}
    ${r.questions ? `<ul>${r.questions.map((q, j) => `<li><span class="small muted">${j + 1}.</span><span class="t ${q.voided ? 'voided' : ''}">${q.sealed ? '🔒 Verzegelde vraag' : esc(q.prompt || '')}
        <span class="small muted"> · ${TYPE_LABEL[q.type]} · ${q.scope === 'team' ? 'team' : 'individueel'} · ${q.seconds}s · ${q.scoring === 'speed' ? 'bliksem' : q.scoring === 'closest' ? 'dichtstbij' : q.points + ' pt'}</span>
        ${q.isExample ? '<span class="example-badge">voorbeeld</span>' : ''}${v.perms.answers && !q.sealed && (!q.key || q.key.correct == null) && q.type !== 'ranking' ? ' <span class="pill bad">geen antwoord</span>' : ''}</span>
      ${canEdit && !q.sealed ? `<button class="btn ghost small" data-qup="${r.id}:${j}" aria-label="Vraag omhoog" ${j === 0 ? 'disabled' : ''}>↑</button><button class="btn ghost small" data-qedit="${q.id}">Bewerken</button>
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
      <div class="field"><label for="qType">Type</label><select id="qType">${Object.entries(TYPE_LABEL).filter(([t]) => t !== 'match').map(([t, l]) => `<option value="${t}" ${t === q.type ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label for="qScope">Wie antwoordt</label><select id="qScope"><option value="team" ${q.scope === 'team' ? 'selected' : ''}>Team (captain)</option><option value="individual" ${q.scope === 'individual' ? 'selected' : ''}>Iedereen zelf</option></select></div>
      <div class="field"><label for="qScoring">Scoring</label><select id="qScoring"><option value="fixed">Vaste punten</option><option value="speed" ${q.scoring === 'speed' ? 'selected' : ''}>Bliksem (sneller = meer)</option><option value="closest" ${q.scoring === 'closest' ? 'selected' : ''}>Dichtstbij (5-4-3-2-1)</option></select></div>
      <div class="field" style="width:110px"><label for="qSec">Seconden</label><input id="qSec" type="number" min="0" max="600" value="${q.seconds}"></div>
      <div class="field" style="width:100px"><label for="qPts">Punten</label><input id="qPts" type="number" min="0" max="100" value="${q.points}"></div></div>
    <div class="field"><label for="qPrompt">Vraag</label><input id="qPrompt" required maxlength="500" value="${esc(q.prompt || '')}"></div>
    <div class="row"><div class="grow field"><label for="qQuote">Citaat / app-bericht (optioneel)</label><input id="qQuote" value="${esc(q.quote || '')}"></div>
      <div class="grow field"><label for="qCtx">Context / bron (alleen beheer en onthulling)</label><input id="qCtx" value="${esc(q.context || '')}"></div></div>
    <div class="field" id="optWrap"><label for="qOpts" id="qOptsLbl">Keuzes (één per regel)</label><textarea id="qOpts">${esc((q.type === 'career' ? q.settings?.clues || [] : q.options || []).join('\n'))}</textarea></div>
    <div class="row">
      <div class="grow field"><label for="qCorrect" id="qCorrectLbl">Juiste antwoord</label><span id="qCorrectSlot"></span></div>
      <div class="grow field" id="accWrap"><label for="qAcc">Ook goed (varianten, één per regel)</label><textarea id="qAcc">${esc((k.accepted || []).join('\n'))}</textarea></div>
      <div class="field" id="tolWrap" style="width:140px"><label for="qTol">Marge (±)</label><input id="qTol" type="number" step="any" value="${k.tolerance ?? ''}"></div></div>
    <div class="field"><label for="qExpl">Uitleg bij onthulling</label><input id="qExpl" value="${esc(k.explanation || '')}"></div>
    <div class="row" id="modRow">
      <div class="field" id="shotNrWrap" style="width:160px"><label for="qShotNr">Shotnummer</label><input id="qShotNr" type="number" min="1" max="50" value="${q.settings?.shotNumber ?? ''}"></div>
      <label class="check" id="kompWrap" style="margin:0"><input type="checkbox" id="qKomp" ${q.settings?.kompaan ? 'checked' : ''}> Ken je kompaan (aangewezen teamgenoten antwoorden ieder zelf; zelfde antwoord = punten)</label>
      <label class="check" id="topWrap" style="margin:0"><input type="checkbox" id="qTop" ${(q.settings?.top || 1) > 1 ? 'checked' : ''}> Top 3 voorspellen (2 pt per goede plek, 1 pt als de naam wel in de top 3 staat)</label>
      <p class="small muted" id="modHelp" style="margin:0"></p></div>
    <div class="row"><label class="check" style="margin:0"><input type="checkbox" id="qBet" ${q.allowBet ? 'checked' : ''}> Inzetten toestaan (1–3)</label>
      <label class="check" style="margin:0"><input type="checkbox" id="qEx" ${q.isExample ? 'checked' : ''}> Voorbeeldvraag (markering)</label></div>
    <div class="field"><label for="qMedia">Afbeelding/audio (optioneel, max 15 MB)</label><input id="qMedia" type="file" accept="image/*,audio/*,video/mp4">
      ${q.mediaId ? '<p class="small muted">Er is al media gekoppeld; nieuw bestand vervangt het.</p>' : ''}</div>
    <div class="row"><button class="btn primary">Opslaan</button><button type="button" class="btn ghost" id="cancelEd">Annuleren</button></div></form>`;
  const sync = () => {
    const t = $('#qType').value;
    const special = ['ranking', 'shot', 'invest', 'envelope'].includes(t);
    $('#shotNrWrap').hidden = t !== 'shot';
    $('#kompWrap').hidden = !['mc', 'tf', 'open'].includes(t);
    $('#topWrap').hidden = t !== 'ranking';
    $('#qCorrectSlot').closest('.field').hidden = special || $('#qKomp').checked;
    if (special) $('#qScope').value = 'team';
    if ($('#qKomp').checked) $('#qScope').value = 'individual';
    $('#modHelp').textContent = { ranking: 'Teams voorspellen wie de groep het vaakst koos. Spelers stemmen vooraf in de voorbereiding. Standaard 2 punten.', shot: 'Per shot: 1 punt voor hoofdsmaak, basisdrank en team. Toegestane varianten stel je in bij Shots & Buitentas. Onthulling pas na het laatste shot.', invest: 'Elk team verdeelt €10.000 fictief over andere teams. Ontvangen bedrag → 5-4-3-2-1 punten.', envelope: 'Speel aan het begin: elk team voorspelt verzegeld zijn eindplek. Bij de uitslag open je de enveloppen; precies goed = 2 bonuspunten.', career: 'Hints van vaag naar duidelijk (één per regel). Jij zet ze één voor één op tv; teams kiezen één Muchacho. Goed bij hint 1 = meeste punten. Bij juiste antwoord: de naam van de Muchacho.' }[t] || '';
    $('#optWrap').hidden = !['mc', 'order', 'career'].includes(t);
    $('#qOptsLbl').textContent = t === 'career' ? 'Hints (één per regel, van vaag naar duidelijk)' : 'Keuzes (één per regel)';
    if (t === 'career') $('#qScope').value = 'team';
    $('#accWrap').hidden = t !== 'open';
    $('#tolWrap').hidden = t !== 'number';
    const opts = t === 'tf' ? ['Waar', 'Niet waar'] : $('#qOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
    const cur = $('#qCorrect')?.value ?? (k.correct ?? '');
    if (t === 'mc' || t === 'tf') $('#qCorrectSlot').innerHTML = `<select id="qCorrect"><option value="">— kies —</option>${opts.map((o, i) => `<option value="${i}" ${String(cur) === String(i) ? 'selected' : ''}>${LETTERS[i]}. ${esc(o)}</option>`).join('')}</select>`;
    else if (t === 'order') $('#qCorrectSlot').innerHTML = `<p class="small muted" id="qCorrect" data-order="1">De volgorde waarin je de keuzes invult is de juiste volgorde. Spelers krijgen ze ongesorteerd.</p>`;
    else $('#qCorrectSlot').innerHTML = `<input id="qCorrect" ${t === 'number' ? 'inputmode="decimal"' : ''} value="${esc(cur)}">`;
  };
  sync();
  $('#qType').onchange = sync; $('#qOpts').oninput = sync; $('#qKomp').onchange = sync;
  $('#cancelEd').onclick = closeEditor;
  $('#qPrompt').focus();
  $('#qForm').onsubmit = async e => {
    e.preventDefault();
    const t = $('#qType').value;
    let options = $('#qOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
    let correct = $('#qCorrect')?.value ?? null;
    let settings = { ...(q.settings || {}), kompaan: ['mc', 'tf', 'open'].includes(t) && $('#qKomp').checked };
    if (t === 'shot') settings.shotNumber = Number($('#qShotNr').value);
    if (t === 'ranking') settings.top = $('#qTop').checked ? 3 : 1;
    if (['ranking', 'shot', 'invest', 'envelope'].includes(t)) correct = null;
    if (t === 'mc' || t === 'tf') correct = correct === '' ? null : Number(correct);
    if (t === 'order') { correct = options.map((_, i) => i); const sh = shuffle(options.map((_, i) => i)); const shuffled = sh.map(i => options[i]); correct = options.map(o => shuffled.indexOf(o)); options = shuffled; }
    if (t === 'number') correct = correct === '' ? null : correct;
    if (t === 'career') { settings.clues = options; options = []; correct = correct?.trim() || null; }
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
// Voornaam; bij dubbele voornamen (twee Kevins) met de eerste letter van de achternaam erbij.
let _names = [];
const firstName = n => { const [f, l] = String(n || '').split(' '); return _names.filter(x => x.split(' ')[0] === f).length > 1 && l ? `${f} ${l[0]}` : f; };
const listNl = a => a.length > 1 ? a.slice(0, -1).join(', ') + ' en ' + a.at(-1) : a[0] || '';
function progressCard(v, { compact = false } = {}) {
  const P = v.progress; if (!P?.people?.length) return '';
  _names = P.people.map(p => p.name);
  const canAct = v.perms.people; const link = v.event.joinUrl;
  const mark = x => x == null ? '<span class="muted">—</span>' : x === true ? '<span class="ok-text" aria-label="klaar">✓</span>' : '<span class="copper-text">nog niet</span>';
  const lag = P.people.filter(p => p.missing.length);
  const showMis = P.people.some(p => p.missions != null);
  const groupText = `BAMIGO-check! Nog even regelen vóór 23 januari:\n${lag.map(p => `• ${firstName(p.name)}: ${listNl(p.missing.map(m => m.label))}`).join('\n')}\n\nLink: ${link}`;
  const personal = p => !p.joined ? `Hoi ${firstName(p.name)}! Meld je even aan voor BAMIGO (23 januari): ${link} en tik je naam aan. Duurt 10 seconden.`
    : `Hoi ${firstName(p.name)}! Voor BAMIGO moet je nog ${listNl(p.missing.map(m => m.label))}. Hier: ${link}`;
  return `<div class="card jongens" style="margin-top:16px"><div class="row" style="justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
      <div><h3 style="margin:0">De jongens</h3><p class="small muted" style="margin:2px 0 0">${lag.length ? `${lag.length} van de ${P.people.length} moeten nog iets doen.` : 'Iedereen is bij. Lekker!'} Alleen ja/nee, nooit antwoorden.</p></div>
      ${canAct && lag.length ? `<div class="row" style="gap:8px"><button class="btn primary" id="remindAll">📣 Herinner iedereen die nog iets moet</button>
        <a class="btn ghost" href="${waHref(groupText)}" target="_blank" rel="noopener">WhatsApp-lijstje</a></div>` : ''}</div>
    <div class="table-wrap"><table class="subs jongens-t"><thead><tr><th>Speler</th>${compact ? '' : '<th>Duo</th>'}<th>Aangemeld</th><th>Dossier</th><th>Ranking</th><th>Teamshot</th>${showMis ? '<th>Opdrachten</th>' : ''}${canAct ? '<th></th>' : ''}</tr></thead><tbody>
    ${P.people.map(p => `<tr><td><b>${esc(p.name)}</b></td>${compact ? '' : `<td class="small muted">${esc(p.team || '—')}</td>`}<td>${mark(p.joined)}</td><td>${mark(p.dossier)}</td><td>${mark(p.voted)}</td><td>${mark(p.shot)}</td>
      ${showMis ? `<td>${p.missions == null ? '<span class="muted">—</span>' : p.missionsDone ? `<span class="ok-text">${p.missions}</span>` : `<span class="copper-text">${p.missions}</span>`}</td>` : ''}
      ${canAct ? `<td class="nowrap">${p.missing.length ? `${p.joined ? `<button class="btn ghost small" data-remind="${p.id}" title="Melding op zijn telefoon">Seintje</button> ` : ''}<a class="btn ghost small" href="${waHref(personal(p))}" target="_blank" rel="noopener" title="WhatsApp-bericht klaarzetten">WhatsApp</a>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>
    ${canAct ? `<p class="small muted" style="margin:10px 0 0">“Seintje” stuurt een melding naar zijn telefoon (als hij meldingen aan heeft) en zet het in zijn berichten in de app. Nog niet aangemeld? Dan werkt alleen WhatsApp.</p>` : ''}
  </div>`;
}
function quickMsgCard(v) {
  if (!v.perms.content || !v.progress?.people) return '';
  const joined = v.progress.people.filter(p => p.joined);
  return `<details class="card" data-keep="quickMsg" style="margin-top:16px"><summary><b>✉️ Zelf een bericht sturen</b> <span class="small muted">aan iedereen of aan één speler, meteen</span></summary>
    <form id="qmForm" style="margin-top:12px">
      <div class="field"><label for="qmTo">Aan</label><select id="qmTo"><option value="">Iedereen</option>${joined.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="qmTitle">Titel</label><input id="qmTitle" maxlength="120" required placeholder="Bijv. Morgen laatste kans!"></div>
      <div class="field"><label for="qmBody">Bericht</label><textarea id="qmBody" maxlength="1500" rows="3" placeholder="Wat wil je zeggen?"></textarea></div>
      <div class="row"><button class="btn primary">Nu versturen</button><span class="small muted">Komt als melding op de telefoon en in de berichten in de app.</span></div></form></details>`;
}
function bindJongens(v) {
  const ra = $('#remindAll'); if (ra) ra.onclick = () => act(ra, async () => { const r = await A.post('/api/staff/remind', {}); toast(`${r.sent} ${r.sent === 1 ? 'seintje' : 'seintjes'} verstuurd.${r.notJoined.length ? ` Nog niet aangemeld: ${r.notJoined.map(firstName).join(', ')} (stuur die via WhatsApp).` : ''}`); });
  $$('[data-remind]').forEach(b => b.onclick = () => act(b, () => A.post('/api/staff/remind', { participantId: b.dataset.remind }), 'Seintje verstuurd.'));
  const f = $('#qmForm'); if (f) f.onsubmit = e => { e.preventDefault(); const to = $('#qmTo').value;
    act(e.submitter, async () => { await A.post('/api/staff/messages', { title: $('#qmTitle').value, body: $('#qmBody').value, to: to ? [to] : null }); f.reset(); }, 'Verstuurd!'); };
}
function readyTab(v) {
  const r = v.readiness;
  const card = (n, label, bad) => `<div class="card"><div class="n ${bad ? 'copper-text' : ''}">${n}</div><div class="small muted">${label}</div></div>`;
  main.innerHTML = `<h2>Gereedheid</h2>
  <div class="ready-grid">
    ${card(`${r.joined}/${r.participants}`, 'spelers aangemeld', r.joined < r.participants)}
    ${card(`${r.questionnaireDone}/${r.participants}`, 'vragenlijst voltooid', r.questionnaireDone < r.participants)}
    ${card(`${r.teams}`, 'teams' + (r.teamsWithoutCaptain ? ` · ${r.teamsWithoutCaptain} zonder captain` : ''), r.teamsWithoutCaptain)}
    ${card(`${r.rankingVotes}/${r.participants}`, 'spelers hebben rankingstemmen')}
    ${card(`${r.shotsSubmitted}/${r.teams}`, 'shots ingediend', r.shotsSubmitted < r.teams)}
    ${card(`${r.missionsDone}/${r.missions * r.teams || 0}`, 'missies afgevinkt')}
    ${card(r.questions, 'vragen' + (r.exampleQuestions ? ` · ${r.exampleQuestions} voorbeeld` : ''), r.exampleQuestions)}
    ${v.perms.content ? card(r.questionsWithoutAnswer, 'vragen zonder juist antwoord', r.questionsWithoutAnswer) : ''}
    ${card(r.missingMedia, 'ontbrekende media', r.missingMedia)}
  </div>
  <p class="small muted" style="margin-top:16px">Alleen tellingen: geen inhoud, antwoorden, stemmen of shotgegevens. Veilig voor wie zelf meespeelt.</p>
  ${progressCard(v)}
  <div class="card" style="margin-top:16px"><h3>Planning</h3><ul class="list">${v.rounds.map(x => `<li><span class="grow">${esc(x.title)}</span><span class="muted small">${x.minutes} min</span></li>`).join('')}</ul>
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
// Links die op dit apparaat bewaard zijn. De server kent alleen hashes, dus elders zijn ze niet terug te halen.
function myLinks(v) {
  const base = location.origin;
  const tv = prefs.get('tvToken.' + v.event.id, null);
  return `<details class="card" data-keep="myLinks" style="margin:0 0 16px"><summary><b>Jouw links</b> <span class="small muted">(beheer, tv en spelers; klik om te tonen)</span></summary>
    <p class="small" style="margin:10px 0 4px">Jouw beheerlink. Bewaar hem privé, bijv. in je wachtwoordmanager. Zonder deze link kom je op een ander apparaat niet binnen.</p>
    <div class="linkbox">${esc(base + '/beheer#k=' + token)}</div>
    ${tv ? `<p class="small" style="margin:10px 0 4px">TV-link (open op de laptop aan de tv):</p><div class="linkbox">${esc(base + '/tv#k=' + tv)}</div>`
      : '<p class="small muted" style="margin:10px 0 0">Geen TV-link op dit apparaat. Maak hieronder een nieuwe link met rol “TV-scherm”.</p>'}
    <p class="small" style="margin:10px 0 4px">Spelers: ${esc(base)}/speel met code <b>${esc(v.event.joinCode)}</b>.</p></details>`;
}
const ROLE_INFO = { content: 'Inhoudsbeheerder — maakt vragen en ziet antwoorden. Geef deze aan je medequizmaster.', host: 'Live host — bedient de avond; ziet antwoorden pas na sluiten.',
  spoilerfree: 'Spoilervrije organisator — ziet planning en voortgang, geen inhoud. Voor wie zelf meespeelt.', display: 'TV-scherm — alleen de show.' };
function eventTab(v) {
  const s = v.event.settings;
  main.innerHTML = `${myLinks(v)}<div class="grid2">
  <form id="evForm" class="card"><h3>Avond</h3>
    <div class="field"><label for="eName">Naam</label><input id="eName" value="${esc(v.event.name)}" required></div>
    <div class="field"><label for="eSub">Ondertitel</label><input id="eSub" value="${esc(v.event.subtitle || '')}"></div>
    <div class="field"><label for="eStart">Datum & aanvang</label><input id="eStart" type="datetime-local" value="${esc(v.event.startsAt || '')}"></div>
    <details data-keep="evMore"><summary>Meer instellingen</summary>
    <div class="row" style="margin-top:12px"><div class="grow field"><label for="eTarget">Doelduur (min)</label><input id="eTarget" type="number" value="${v.event.durationTarget}"></div>
      <div class="grow field"><label for="eMax">Maximum (min)</label><input id="eMax" type="number" value="${v.event.durationMax}"></div></div>
    <div class="field"><label for="eCd">Aftellen vóór elke vraag (sec)</label><input id="eCd" type="number" min="0" max="10" value="${(s.countdownMs ?? 3000) / 1000}"></div>
    <label class="check"><input type="checkbox" id="eSelfTeam" ${s.selfTeam !== false ? 'checked' : ''}> Spelers kiezen zelf hun team bij aanmelden</label>
    <label class="check"><input type="checkbox" id="eAutoCap" ${s.autoCaptain !== false ? 'checked' : ''}> Captain-wissel na 3x fout op rij</label>
    <label class="check"><input type="checkbox" id="eOne" ${s.oneliners !== false ? 'checked' : ''}> Oneliners tonen</label>
    <label class="check"><input type="checkbox" id="eDrinks" ${s.drinks !== false ? 'checked' : ''}> Drankonderdelen aan</label></details>
    <button class="btn primary" style="margin-top:10px">Opslaan</button></form>
  <section class="card"><h3>Spelersdossier (vragenlijst vooraf)</h3>
    <p class="small muted">Spelers vullen dit vooraf in op hun telefoon: één vraag per scherm, met delen en voortgang. Alles optioneel.</p>
    ${(s.questionnaire || []).length ? `<ol class="small qn-list">${s.questionnaire.map(x => x.type === 'section' ? `</ol><p class="small" style="margin:10px 0 4px"><b>${esc(x.q)}</b></p><ol class="small qn-list">` : `<li>${esc(x.q)} <span class="muted">· ${QN_LABEL[x.type] || 'open'}</span></li>`).join('')}</ol>` : '<p class="small muted">Nog geen vragen.</p>'}
    <details data-keep="qnEdit"><summary class="small">Dossier aanpassen of plakken</summary>
      <p class="small muted">Plak het dossier als lijst (JSON), bijvoorbeeld van de vragen-assistent. Typen: open, number, scale (1–10), time, muchacho (kies een Muchacho), section (kopje).</p>
      <form id="qnForm"><textarea id="qnText" rows="10" style="font-family:monospace;font-size:.8rem">${esc(JSON.stringify({ intro: s.dossier?.intro || undefined, outro: s.dossier?.outro || undefined, items: s.questionnaire || [] }, null, 1))}</textarea>
      <button class="btn copper" style="margin-top:10px">Dossier opslaan</button></form></details>
    ${v.questionnaire ? `<p class="small muted" style="margin:10px 0 0">${v.questionnaire.filled} van ${v.questionnaire.total} spelers hebben hem ingevuld. Antwoorden staan bij Vragen.</p>` : ''}</section>
  <section class="card"><h3>Anderen toegang geven</h3>
    <p class="small muted">Maak een link voor een medequizmaster of een extra tv. Deel hem privé.</p>
    <ul class="list">${(v.grants || []).map(g => `<li><span class="grow">${esc(g.label)} <span class="small muted">(${g.role})</span></span>${g.revoked ? '<span class="pill bad">ingetrokken</span>' : g.role === 'owner' ? '<span class="pill">jij</span>' : `<button class="btn danger small" data-revoke="${g.id}">Intrekken</button>`}</li>`).join('')}</ul>
    <form id="grantForm" style="margin-top:12px"><div class="row"><select id="gRole" class="grow">${Object.entries(ROLE_INFO).map(([r, t]) => `<option value="${r}">${t}</option>`).join('')}</select></div>
      <div class="row" style="margin-top:8px"><input id="gLabel" class="grow" placeholder="Naam, bijv. ‘Medequizmaster Sam’" maxlength="60"><button class="btn copper">Nieuwe link</button></div></form>
    <div id="grantOut"></div>
    <p class="small muted" style="margin-top:14px">Speel je zelf mee? Geef jezelf een spoilervrije link en laat een ander de vragen maken.</p>
  </section>
  <section class="card"><h3>Volgende keer</h3><details data-keep="evDup"><summary>Kopie maken voor een nieuwe avond</summary><p class="small muted">Scores en antwoorden van spelers gaan nooit mee.</p>
    <form id="dupForm"><div class="field"><label for="dName">Naam nieuwe avond</label><input id="dName" required value="${esc(v.event.name)} (kopie)"></div>
      <label class="check"><input type="checkbox" id="dQ" checked> Vragen en antwoordsleutels meenemen</label>
      <label class="check"><input type="checkbox" id="dT"> Teamnamen meenemen</label>
      <label class="check"><input type="checkbox" id="dP"> Namen van spelers meenemen</label>
      <button class="btn copper">Kopie maken</button></form><div id="dupOut"></div></details>
    <hr style="border-color:var(--line);margin:18px 0"><button class="btn ghost small" id="archive">${v.event.status === 'archived' ? 'Archivering opheffen' : 'Avond archiveren'}</button></section></div>`;
  $('#evForm').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.patch('/api/staff/event', { name: $('#eName').value, subtitle: $('#eSub').value, startsAt: $('#eStart').value, durationTarget: +$('#eTarget').value, durationMax: +$('#eMax').value,
    settings: { countdownMs: Math.round(+$('#eCd').value * 1000), selfTeam: $('#eSelfTeam').checked, autoCaptain: $('#eAutoCap').checked, oneliners: $('#eOne').checked, drinks: $('#eDrinks').checked } }), 'Opgeslagen.'); };
  $('#qnForm').onsubmit = e => { e.preventDefault();
    let d; try { d = JSON.parse($('#qnText').value); } catch { return toast('Dit is geen geldige lijst. Controleer haakjes en aanhalingstekens.', 'bad'); }
    const items = Array.isArray(d) ? d : d.items || [];
    const settings = { questionnaire: items, ...(Array.isArray(d) ? {} : { dossier: { intro: d.intro, outro: d.outro } }) };
    act(e.submitter, () => A.patch('/api/staff/event', { settings }), 'Dossier opgeslagen.'); };
  $('#grantForm').onsubmit = async e => { e.preventDefault(); const r = await act(e.submitter, () => A.post('/api/staff/grants', { role: $('#gRole').value, label: $('#gLabel').value })); if (r) $('#grantOut').innerHTML = `<p class="small" style="margin-top:10px">Kopieer deze link nu; hij wordt niet opnieuw getoond:</p><div class="linkbox">${esc(r.url)}</div>`; };
  $$('[data-revoke]').forEach(b => b.onclick = () => { if (confirm('Link intrekken? Wie hem gebruikt, verliest direct toegang.')) act(b, () => A.post(`/api/staff/grants/${b.dataset.revoke}/revoke`), 'Ingetrokken.'); });
  $('#dupForm').onsubmit = async e => { e.preventDefault(); const r = await act(e.submitter, () => A.post('/api/staff/duplicate', { name: $('#dName').value, includeQuestions: $('#dQ').checked, includeTeams: $('#dT').checked, includeParticipants: $('#dP').checked }));
    if (r) $('#dupOut').innerHTML = `<p class="small">Nieuwe beheerlink:</p><div class="linkbox">${esc(r.url)}</div><p class="small">TV-link:</p><div class="linkbox">${esc(r.tvUrl)}</div>`; };
  $('#archive').onclick = e => { if (confirm('Zeker weten?')) act(e.target, () => A.patch('/api/staff/event', { status: v.event.status === 'archived' ? 'draft' : 'archived' })); };
}

// ---------- SHOTS & BUITENTAS ----------
// ---------- BERICHTEN ----------
const MSG_LINKS = [['', 'Geen knop'], ['vragenlijst', 'Vragenlijst'], ['ranking', 'Ranking de Boys'], ['shot', 'Geheime shot'], ['buitentas', 'Buitentas']];
function fmtLocal(s) { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-'); return new Date(+y, +m - 1, +dd).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + t; }
function msgsTab(v) {
  const M = v.messages; const edit = editing?.kind === 'msg' ? editing.data : null;
  const planned = M.list.filter(m => !m.sentAt), sent = M.list.filter(m => m.sentAt).reverse();
  const linkName = l => MSG_LINKS.find(x => x[0] === (l || ''))?.[1] || '';
  const f = edit || { title: '', body: '', link: '', sendAt: '' };
  main.innerHTML = `<div class="wrap">
    <h1>Berichten aan spelers</h1>
    <p class="muted">BAMIGO verstuurt deze berichten zelf, op het tijdstip dat je kiest (Nederlandse tijd). Spelers zien ze in de app, en wie meldingen aan heeft krijgt ook een seintje op de telefoon.</p>
    <p><span class="pill ${M.pushPlayers ? 'ok' : ''}"><span class="dot"></span>${M.pushPlayers} van ${v.readiness?.participants ?? '?'} spelers hebben meldingen aan</span></p>
    <form id="msgForm" class="card">
      <h3>${edit?.id ? 'Bericht aanpassen' : 'Nieuw bericht'}</h3>
      <div class="field"><label for="mTitle">Titel</label><input id="mTitle" maxlength="120" required value="${esc(f.title)}"></div>
      <div class="field"><label for="mBody">Tekst</label><textarea id="mBody" maxlength="1500">${esc(f.body)}</textarea></div>
      <div class="row">
        <div class="field grow"><label for="mAt">Versturen op</label><input id="mAt" type="datetime-local" value="${esc(f.sendAt)}"><p class="small muted" style="margin:4px 0 0">Leeg laten = direct versturen.</p></div>
        <div class="field grow"><label for="mLink">Knop in het bericht</label><select id="mLink">${MSG_LINKS.map(([k, l]) => `<option value="${k}" ${k === (f.link || '') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="row"><button class="btn primary" id="mSave">${edit?.id ? 'Opslaan' : 'Inplannen'}</button>${edit ? '<button type="button" class="btn ghost" id="mCancel">Annuleren</button>' : ''}</div>
    </form>
    <section class="card"><h3>Ingepland (${planned.length})</h3>
      ${planned.length ? `<ul class="list msg-list">${planned.map(m => `<li><div class="grow"><b>${esc(m.title)}</b><div class="small muted">${fmtLocal(m.sendAt)}${m.link ? ' · knop: ' + linkName(m.link) : ''}</div>${m.body ? `<div class="small">${esc(m.body)}</div>` : ''}</div>
        <div class="row" style="gap:6px;flex:none"><button class="btn ghost small" data-medit="${m.id}">Bewerk</button><button class="btn copper small" data-msend="${m.id}">Nu versturen</button><button class="btn danger small" data-mdel="${m.id}">Verwijder</button></div></li>`).join('')}</ul>`
        : '<p class="small muted">Nog niets ingepland.</p>'}
    </section>
    <section class="card"><h3>Verstuurd (${sent.length})</h3>
      ${sent.length ? `<ul class="list msg-list">${sent.map(m => `<li><div class="grow"><b>${esc(m.title)}</b><div class="small muted">${new Date(m.sentAt).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${m.to ? 'aan ' + esc(m.to.join(', ')) + ' · ' : ''}${m.pushCount ?? 0} meldingen bezorgd</div></div></li>`).join('')}</ul>`
        : '<p class="small muted">Nog niets verstuurd.</p>'}
    </section>
    <details class="card" data-keep="msgImport"><summary><b>Meerdere berichten tegelijk toevoegen</b> <span class="small muted">(plak een lijst)</span></summary>
      <p class="small muted">Plak hier een lijst in JSON, bijvoorbeeld van de quizvragen-assistent. Elk bericht: <code>sendAt</code>, <code>title</code>, <code>body</code> en eventueel <code>link</code>.</p>
      <div class="field"><label for="mImport">Lijst</label><textarea id="mImport" style="min-height:140px;font-family:monospace" placeholder='[{"sendAt":"2026-11-20T17:00","title":"…","body":"…"}]'></textarea></div>
      <button class="btn copper" id="mImportBtn">Toevoegen</button>
    </details></div>`;
  const form = $('#msgForm');
  form.oninput = () => { if (!editing) editing = { kind: 'msg', data: { ...f } }; };
  form.onsubmit = async e => { e.preventDefault();
    const body = { id: edit?.id, title: $('#mTitle').value, body: $('#mBody').value, link: $('#mLink').value || null, sendAt: $('#mAt').value || null };
    const r = await act($('#mSave'), () => A.post('/api/staff/messages', body), body.sendAt ? 'Ingepland. BAMIGO verstuurt het vanzelf.' : 'Verstuurd.');
    if (r) { editing = null; render(); } };
  if ($('#mCancel')) $('#mCancel').onclick = () => { editing = null; render(); };
  $('#mImport').oninput = () => { if (!editing) editing = { kind: 'msg', data: null }; };
  $('#mImportBtn').onclick = async e => {
    let list; try { list = JSON.parse($('#mImport').value); } catch { return toast('Dit is geen geldige lijst. Controleer de haakjes en aanhalingstekens.', 'bad'); }
    const r = await act(e.target, () => A.post('/api/staff/messages/import', list));
    if (r) { toast(`${r.imported} berichten ingepland.`); editing = null; render(); }
  };
  $$('[data-medit]').forEach(b => b.onclick = () => { const m = M.list.find(x => x.id === b.dataset.medit); editing = { kind: 'msg', data: { ...m, link: m.link || '' } }; msgsTab(view); bindKeep(); window.scrollTo(0, 0); });
  $$('[data-msend]').forEach(b => b.onclick = () => { if (confirm('Dit bericht nu naar alle spelers sturen?')) act(b, () => A.post(`/api/staff/messages/${b.dataset.msend}/send`), 'Verstuurd.'); });
  $$('[data-mdel]').forEach(b => b.onclick = () => { if (confirm('Dit bericht verwijderen?')) act(b, () => A.del(`/api/staff/messages/${b.dataset.mdel}`), 'Verwijderd.'); });
}
function bindKeep() { $$('details[data-keep]').forEach(d => { if (openDetails.has(d.dataset.keep)) d.open = true; d.ontoggle = () => { d.open ? openDetails.add(d.dataset.keep) : openDetails.delete(d.dataset.keep); }; }); }

function extraTab(v) {
  const teams = v.teams;
  const shotsHtml = v.shots ? `<section class="card"><h3>Shot in het duister</h3>
    <p class="small muted">Alleen zichtbaar voor inhoudsbeheer. Nummer de flessen bij aankomst (buiten zicht) en leg toegestane varianten vast vóór het proeven.</p>
    ${v.shotWarnings.map(w => `<p class="notice warn small">${esc(w)}</p>`).join('')}
    ${teams.map(t => { const sh = v.shots.find(x => x.team_id === t.id); return `<form class="card" style="background:var(--bg)" data-shotform="${sh?.id || ''}" data-team="${t.id}">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(t.name)}</h3>${sh?.name ? `<span class="pill ok"><span class="dot"></span>ingediend</span>` : '<span class="pill bad"><span class="dot"></span>nog niet ingediend</span>'}</div>
      ${sh ? `<p class="small">${esc(sh.name || '')} · <b>${esc(sh.flavor || '?')}</b> · ${esc(sh.base || '?')} · allergenen: ${esc(sh.allergens || '—')} · ${esc(sh.amount || '')}</p>${sh.story ? `<p class="small muted">“${esc(sh.story)}”</p>` : ''}
      <div class="row"><div class="field" style="width:120px"><label for="sn_${sh.id}">Nummer</label><input id="sn_${sh.id}" name="number" type="number" min="1" value="${sh.number ?? ''}"></div>
        <div class="grow field"><label for="sf_${sh.id}">Ook goed: smaak (één per regel)</label><textarea id="sf_${sh.id}" name="acceptedFlavors" style="min-height:48px">${esc(sh.accepted_flavors.join('\n'))}</textarea></div>
        <div class="grow field"><label for="sb_${sh.id}">Ook goed: basis (één per regel)</label><textarea id="sb_${sh.id}" name="acceptedBases" style="min-height:48px">${esc(sh.accepted_bases.join('\n'))}</textarea></div></div>
      <button class="btn copper small">Opslaan</button>` : '<p class="small muted">Het team vult dit in via de telefoon (voorbereiding).</p>'}</form>`; }).join('')}</section>` : '';
  const missionsHtml = v.missions ? `<section class="card"><h3>BAMIGO Buitentas — Douane</h3>
    <p class="small muted">Vul per team de gecontroleerde waarde in (bijv. 11:58 of 247) en vink goedgekeurd aan. Niet ingeleverd of afgekeurd = 0 punten. Dichtstbij: ${teams.length}-…-1 met gedeelde plekken.</p>
    ${v.missions.map(m => `<div class="card" style="background:var(--bg)"><div class="row" style="justify-content:space-between"><h3 style="margin:0">${esc(m.title)}</h3>
      <span class="small muted">${m.kind === 'closest' ? `dichtst bij ${esc(m.target || '?')} ${esc(m.unit || '')}` : `goedgekeurd = ${m.max_points} pt`}${m.scored_at ? ' · gescoord' : ''}</span></div>
      <table class="subs"><thead><tr><th>Team</th><th>Opgegeven</th><th>Foto</th><th>Gemeten</th><th>OK</th></tr></thead><tbody>
      ${teams.map(t => { const e = m.evidence.find(x => x.team_id === t.id) || {}; return `<tr><td>${esc(t.name)}</td><td>${esc(e.value || '—')}${e.note ? `<br><span class="small muted">${esc(e.note)}</span>` : ''}</td>
        <td>${e.media_id ? `<button class="btn ghost small" data-photo="${e.media_id}">Bekijk</button>` : '—'}</td>
        <td><input style="min-height:40px;width:110px" data-measure="${m.id}:${t.id}" value="${esc(e.measured ?? '')}" aria-label="Gemeten waarde ${esc(t.name)}"></td>
        <td><input type="checkbox" style="width:24px;height:24px" data-ok="${m.id}:${t.id}" ${e.checked ? 'checked' : ''} aria-label="Goedgekeurd ${esc(t.name)}"></td></tr>`; }).join('')}</tbody></table>
      <div class="row" style="margin-top:10px">${v.perms.scores ? `<button class="btn copper small" data-mscore="${m.id}">${m.scored_at ? 'Opnieuw scoren' : 'Punten toekennen'}</button>` : ''}
        ${v.perms.content ? `<button class="btn ghost small" data-medit="${m.id}">Bewerken</button><button class="btn danger small" data-mdel="${m.id}">Verwijder</button>` : ''}</div></div>`).join('') || '<p class="muted">Nog geen missies.</p>'}
    ${v.perms.content ? `<button class="btn ghost" id="addMission">Missie toevoegen</button><div id="missionSlot"></div>` : ''}<div id="photoSlot"></div></section>` : '';
  main.innerHTML = `<div class="grid2">${shotsHtml}${missionsHtml}</div>`;
  $$('[data-shotform]').forEach(f => f.onsubmit = e => { e.preventDefault(); if (!f.dataset.shotform) return;
    act(e.submitter, () => A.post('/api/staff/shots/' + f.dataset.shotform, { number: f.elements.namedItem('number').value, acceptedFlavors: f.elements.namedItem('acceptedFlavors').value, acceptedBases: f.elements.namedItem('acceptedBases').value }), 'Shot opgeslagen.'); });
  const save = (mt) => { const [m, t] = mt.split(':'); return A.post('/api/staff/evidence/check', { missionId: m, teamId: t, measured: $(`[data-measure="${mt}"]`).value, checked: $(`[data-ok="${mt}"]`).checked }); };
  $$('[data-measure]').forEach(i => i.onchange = () => act(null, () => save(i.dataset.measure)));
  $$('[data-ok]').forEach(i => i.onchange = () => act(null, () => save(i.dataset.ok)));
  $$('[data-mscore]').forEach(b => b.onclick = () => { if (confirm('Punten voor deze missie toekennen?')) act(b, () => A.post(`/api/staff/missions/${b.dataset.mscore}/score`), 'Missie gescoord.'); });
  $$('[data-mdel]').forEach(b => b.onclick = () => { if (confirm('Missie verwijderen? Eventuele punten vervallen.')) act(b, () => A.del('/api/staff/missions/' + b.dataset.mdel)); });
  $$('[data-photo]').forEach(b => b.onclick = async () => { const u = await mediaUrl(b.dataset.photo, { 'x-staff-token': token }); $('#photoSlot').innerHTML = u ? `<img src="${u}" alt="Bewijsfoto" style="max-width:100%;border-radius:8px;margin-top:12px">` : '<p class="notice bad">Foto niet beschikbaar.</p>'; });
  const add = $('#addMission'); if (add) add.onclick = () => missionEditor({ kind: 'closest', max_points: 5 });
  $$('[data-medit]').forEach(b => b.onclick = () => missionEditor(v.missions.find(m => m.id === b.dataset.medit)));
}
function missionEditor(m) {
  editing = { kind: 'mission' };
  $('#missionSlot').innerHTML = `<form class="editor" id="mForm"><h3>${m.id ? 'Missie bewerken' : 'Nieuwe missie'}</h3>
    <div class="field"><label for="mT">Titel</label><input id="mT" required value="${esc(m.title || '')}"></div>
    <div class="field"><label for="mD">Omschrijving en regels</label><textarea id="mD">${esc(m.description || '')}</textarea></div>
    <div class="row"><div class="field"><label for="mK">Beoordeling</label><select id="mK"><option value="closest" ${m.kind === 'closest' ? 'selected' : ''}>Dichtstbij doel</option><option value="check" ${m.kind === 'check' ? 'selected' : ''}>Ingeleverd en goedgekeurd</option></select></div>
      <div class="field"><label for="mG">Doel (bijv. 12:00 of 250)</label><input id="mG" value="${esc(m.target || '')}"></div>
      <div class="field" style="width:100px"><label for="mU">Eenheid</label><input id="mU" value="${esc(m.unit || '')}"></div>
      <div class="field" style="width:100px"><label for="mP">Max punten</label><input id="mP" type="number" value="${m.max_points}"></div></div>
    <div class="row"><button class="btn primary">Opslaan</button><button type="button" class="btn ghost" id="mCancel">Annuleren</button></div></form>`;
  $('#mCancel').onclick = closeEditor;
  $('#mForm').onsubmit = e => { e.preventDefault(); act(e.submitter, () => A.post('/api/staff/missions', { id: m.id, title: $('#mT').value, description: $('#mD').value, kind: $('#mK').value, target: $('#mG').value, unit: $('#mU').value, maxPoints: +$('#mP').value }), 'Missie opgeslagen.').then(x => x && closeEditor()); };
}
