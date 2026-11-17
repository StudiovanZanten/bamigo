// Nep-spelers om de avond te oefenen: zodra een vraag open gaat, sturen ze vanzelf een (willekeurig) antwoord in.
// Alleen actief als de organisatie dit aanzet (event settings.bots). Echte telefoons gaan altijd voor: wie al antwoordde, wordt overgeslagen.
import * as M from './modules.js';

const rnd = n => Math.floor(Math.random() * n);
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = rnd(i + 1); [b[i], b[j]] = [b[j], b[i]]; } return b; };

/** Wie moet er bij deze vraag nog antwoorden? Per team de captain (of eerste lid), bij individuele vragen ieder teamlid. */
export function botTargets(db, eventId, q) {
  const people = db.all(`SELECT p.*, m.team_id, m.is_captain FROM participants p JOIN memberships m ON m.participant_id = p.id WHERE p.event_id = ? ORDER BY m.is_captain DESC, p.name`, eventId);
  if (q.scope !== 'team') return people;
  const byTeam = new Map();
  for (const p of people) if (!byTeam.has(p.team_id)) byTeam.set(p.team_id, p);
  return [...byTeam.values()];
}

/** Een plausibel antwoord: ongeveer de helft goed, de rest willekeurig. */
export function botAnswer(db, eventId, q, key, membership) {
  const good = Math.random() < 0.5;
  const n = q.options.length;
  const ids = () => db.all('SELECT p.id FROM participants p JOIN memberships m ON m.participant_id = p.id WHERE p.event_id = ?', eventId).map(r => r.id);
  switch (q.type) {
    case 'mc': return good && Number.isInteger(key.correct) ? key.correct : rnd(n);
    case 'tf': return good && Number.isInteger(key.correct) ? key.correct : rnd(2);
    case 'open': return good && key.correct != null ? String(key.correct) : ['Geen idee', 'Bami', 'Rinus', 'Iets met bier', 'Pas'][rnd(5)];
    case 'number': { const c = Number(key.correct); return Number.isFinite(c) ? Math.round(c + (Math.random() - 0.5) * Math.max(4, Math.abs(c) * (good ? 0.05 : 0.4))) : rnd(100); }
    case 'order': return good && Array.isArray(key.correct) && key.correct.length === n ? key.correct : shuffle([...Array(n).keys()]);
    case 'match': { const m = q.settings.right?.length ?? 0; return [...Array(n)].map(() => rnd(m)); }
    case 'ranking': { const top = q.settings.top || 1; const s = shuffle(ids()); return top > 1 ? s.slice(0, Math.min(top, s.length)) : s[0]; }
    case 'career': { const s = ids(); const hit = s.find(x => x === key.correct) || db.get('SELECT id FROM participants WHERE event_id = ? AND lower(name) = lower(?)', eventId, String(key.correct ?? ''))?.id; return good && hit ? hit : s[rnd(s.length)]; }
    case 'envelope': { const t = db.get('SELECT COUNT(*) AS n FROM teams WHERE event_id = ?', eventId).n; const place = rnd(Math.max(1, t)); return q.settings.pledge ? { place, pledge: ['10 push-ups', 'Een rondje zingen', 'Rinus een shot geven', 'Afwassen morgen'][rnd(4)] } : place; }
    case 'shot': { const teams = db.all('SELECT id FROM teams WHERE event_id = ? AND id != ?', eventId, membership?.team_id ?? ''); return { teamId: teams.length ? teams[rnd(teams.length)].id : null, flavor: ['Aardbei', 'Citroen', 'Drop', 'Koffie'][rnd(4)], base: ['Wodka', 'Rum', 'Likeur'][rnd(3)] }; }
    case 'invest': {
      if (q.settings.pitch) {
        const st = M.pitchStatus(db, q, 't:' + membership.team_id, membership.team_id);
        if (st.mustAll) return { amount: st.remaining };
        const steps = Math.floor(st.remaining / M.DRAGONS_STEP); return { amount: rnd(Math.min(steps, 8) + 1) * M.DRAGONS_STEP };
      }
      const teams = db.all('SELECT id FROM teams WHERE event_id = ? AND id != ?', eventId, membership?.team_id ?? '').map(r => r.id);
      const budget = q.settings.budget || M.DRAGONS_BUDGET; const alloc = {}; let left = budget;
      for (const t of shuffle(teams)) { const a = t === teams[teams.length - 1] ? left : rnd(Math.floor(left / M.DRAGONS_STEP) + 1) * M.DRAGONS_STEP; if (a) alloc[t] = a; left -= a; if (left <= 0) break; }
      if (left > 0 && teams.length) alloc[teams[0]] = (alloc[teams[0]] || 0) + left;
      return alloc;
    }
    default: return null;
  }
}
