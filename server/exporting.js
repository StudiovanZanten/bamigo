// Export van uitslag, vraagpakket (import/export) en het printbare noodpakket.
import { json } from './db.js';
import { bad } from './auth.js';
import { upsertRound, upsertQuestion, QUESTION_TYPES, ROUND_KINDS } from './content.js';

export function exportResults(db, live, eventId) {
  const ev = db.get('SELECT name, subtitle, starts_at FROM events WHERE id = ?', eventId);
  const sb = live.scoreboard(eventId);
  const log = db.all(`SELECT e.points, e.reason, e.kind, e.board, e.created_at, e.voided_at, e.voided_reason, t.name AS team, p.name AS participant
    FROM score_events e LEFT JOIN teams t ON t.id = e.team_id LEFT JOIN participants p ON p.id = e.participant_id WHERE e.event_id = ? ORDER BY e.created_at`, eventId);
  return { format: 'bamigo-results@1', exportedAt: new Date().toISOString(), event: ev,
    teams: sb.teams.map(({ id, ...t }) => t), individuals: sb.individuals.map(({ id, ...p }) => p), log };
}

/** Vraagpakket: rondes + vragen + antwoordsleutels. Geen deelnemers, antwoorden of scores. */
export function exportPack(db, eventId) {
  const rounds = db.all('SELECT * FROM rounds WHERE event_id = ? ORDER BY sort', eventId);
  return {
    format: 'bamigo-pack@1', exportedAt: new Date().toISOString(),
    rounds: rounds.map(r => ({
      kind: r.kind, title: r.title, instructions: r.instructions, supplies: r.supplies, minutes: r.minutes, judging: r.judging, settings: json(r.settings, {}),
      questions: db.all('SELECT q.*, k.correct, k.accepted, k.explanation, k.tolerance FROM questions q LEFT JOIN answer_keys k ON k.question_id = q.id WHERE q.round_id = ? ORDER BY q.sort', r.id)
        .map(q => ({ type: q.type, scope: q.scope, scoring: q.scoring, prompt: q.prompt, quote: q.quote, context: q.context, options: json(q.options, []),
          points: q.points, seconds: q.seconds, allowBet: !!q.allow_bet, isExample: !!q.is_example, settings: json(q.settings, {}),
          key: { correct: json(q.correct), accepted: json(q.accepted, []), explanation: q.explanation, tolerance: q.tolerance } })),
    })),
  };
}

/** Importeer een gevalideerd pakket. Alles of niets. */
export function importPack(db, eventId, pack) {
  if (!pack || pack.format !== 'bamigo-pack@1' || !Array.isArray(pack.rounds)) bad('Geen geldig BAMIGO-vraagpakket (format bamigo-pack@1).');
  if (pack.rounds.length > 50) bad('Te veel rondes in pakket.');
  let rounds = 0, questions = 0;
  db.tx(() => {
    for (const [i, r] of pack.rounds.entries()) {
      if (!ROUND_KINDS.includes(r.kind)) bad(`Ronde ${i + 1}: onbekend type "${r.kind}".`);
      const rid = upsertRound(db, eventId, { ...r, sort: undefined });
      rounds++;
      for (const [j, q] of (r.questions || []).entries()) {
        if (!QUESTION_TYPES.includes(q.type)) bad(`Ronde ${i + 1}, vraag ${j + 1}: onbekend type "${q.type}".`);
        try { upsertQuestion(db, eventId, { ...q, id: undefined, roundId: rid }); }
        catch (e) { bad(`Ronde ${i + 1}, vraag ${j + 1}: ${e.message}`); }
        questions++;
      }
    }
  });
  return { rounds, questions };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Printbaar noodpakket: vragenblad voor de host + antwoordbladen per team + scoreformulier. */
export function emergencyPack(db, eventId) {
  const ev = db.get('SELECT * FROM events WHERE id = ?', eventId);
  const teams = db.all('SELECT name FROM teams WHERE event_id = ? ORDER BY sort, name', eventId);
  const rounds = db.all('SELECT * FROM rounds WHERE event_id = ? ORDER BY sort', eventId);
  const L = 'ABCDEFGHIJKL';
  let qn = 0;
  const body = rounds.map(r => {
    const qs = db.all('SELECT q.*, k.correct, k.accepted FROM questions q LEFT JOIN answer_keys k ON k.question_id = q.id WHERE q.round_id = ? AND q.voided_at IS NULL ORDER BY q.sort', r.id);
    return `<h2>${esc(r.title)} <small>${r.minutes} min</small></h2>${r.instructions ? `<p class="i">${esc(r.instructions)}</p>` : ''}
      <ol start="${qn + 1}">${qs.map(q => { qn++; const opts = json(q.options, []); const c = json(q.correct);
        const ans = q.type === 'mc' || q.type === 'tf' ? [].concat(c).map(i => `${L[i]}. ${opts[i] ?? ''}`).join(' / ') : q.type === 'open' ? [c, ...json(q.accepted, [])].filter(Boolean).join(' / ') : c != null ? JSON.stringify(c) : '—';
        return `<li><b>${esc(q.prompt)}</b>${q.quote ? `<blockquote>${esc(q.quote)}</blockquote>` : ''}${opts.length ? `<div>${opts.map((o, i) => `${L[i]}. ${esc(o)}`).join(' &nbsp; ')}</div>` : ''}
          <div class="a">Antwoord: ${esc(ans)} · ${q.points} pt${q.is_example ? ' · VOORBEELDVRAAG' : ''}</div></li>`; }).join('')}</ol>`;
  }).join('');
  const sheet = t => `<section class="sheet"><h2>Antwoordblad — ${esc(t.name)}</h2><table>${Array.from({ length: qn }, (_, i) => `<tr><td>${i + 1}</td><td></td></tr>`).join('')}</table></section>`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Noodpakket — ${esc(ev.name)}</title>
<style>body{font:12pt/1.4 Georgia,serif;margin:2cm;color:#111}h1{font:700 28pt Impact,sans-serif;margin:0}h2{border-bottom:2px solid #BF5B2C;padding-bottom:4px;margin-top:1.5em}
small{font-weight:normal;color:#666}.i{font-style:italic}.a{color:#7a3a1c;font-size:10pt}li{margin:.6em 0}blockquote{margin:.3em 0 .3em 1em;border-left:3px solid #ccc;padding-left:.5em}
.sheet{page-break-before:always}table{width:100%;border-collapse:collapse}td{border:1px solid #999;height:1.6em}td:first-child{width:3em;text-align:center}
.score td{text-align:center}@media print{.no{display:none}}</style></head><body>
<p class="no">Afdrukken: Ctrl/Cmd + P.</p>
<h1>BAMIGO. Noodpakket</h1><p>${esc(ev.name)} — vertrouwelijk: bevat antwoorden. Alleen voor de quizmaster.</p>${body}
<section class="sheet"><h2>Scoreformulier</h2><table class="score"><tr><td>Ronde</td>${teams.map(t => `<td>${esc(t.name)}</td>`).join('')}</tr>
${rounds.map(r => `<tr><td style="text-align:left;width:auto">${esc(r.title)}</td>${teams.map(() => '<td></td>').join('')}</tr>`).join('')}
<tr><td><b>Totaal</b></td>${teams.map(() => '<td></td>').join('')}</tr></table></section>
${teams.map(sheet).join('')}</body></html>`;
}
