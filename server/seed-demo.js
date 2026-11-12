// Demo-editie met fictieve namen en duidelijk gemarkeerde voorbeeldvragen.
// Gebruik: npm run demo  (maakt een demo-avond aan en print de links)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createEvent, upsertTeam, upsertParticipant, upsertRound, upsertQuestion } from './content.js';

export function seedDemo(db, { name = 'DEMO — Muchacho’s Vriendenweekend' } = {}) {
  const { event, ownerToken, displayToken } = createEvent(db, { name, subtitle: 'Demo-editie · fictieve namen', isDemo: true, startsAt: '2027-01-23T20:00' });
  const E = event.id;
  const teams = [
    ['De Lobbers', ['Bas', 'Joris']], ['Net Niet', ['Koen', 'Mark']], ['Padel Paleis', ['Ruben', 'Sander']],
    ['Buitenspel', ['Tim', 'Wouter']], ['De Drie Musketiers', ['Daan', 'Niels', 'Pim']],
  ];
  for (const [tn, people] of teams) {
    const tid = upsertTeam(db, E, { name: tn });
    for (const p of people) upsertParticipant(db, E, { name: p, teamId: tid });
  }
  const R = (kind, title, minutes, instructions) => upsertRound(db, E, { kind, title, minutes, instructions });
  const ex = { isExample: true };

  R('intro', 'Aanmelden, intro & oefenvraag', 8, 'Scan de QR-code, kies je team, en VAMOSSS.');
  const r1 = R('quiz', 'Algemene kennis', 10, 'De captain stuurt het teamantwoord in.');
  upsertQuestion(db, E, { ...ex, roundId: r1, type: 'mc', prompt: 'VOORBEELD — Welke stad is de hoofdstad van Nederland?', options: ['Den Haag', 'Amsterdam', 'Rotterdam', 'Utrecht'], seconds: 30, points: 1, key: { correct: 1, explanation: 'Grondwettelijk Amsterdam; de regering zit in Den Haag.' } });
  upsertQuestion(db, E, { ...ex, roundId: r1, type: 'tf', prompt: 'VOORBEELD — Een padelbaan is groter dan een tennisbaan.', seconds: 20, points: 1, key: { correct: 1, explanation: 'Padel: 20×10 m. Tennis (dubbel): 23,77×10,97 m.' } });
  upsertQuestion(db, E, { ...ex, roundId: r1, type: 'open', prompt: 'VOORBEELD — Welk gerecht staat symbool voor deze avond? (tip: het merk)', seconds: 30, points: 1, key: { correct: 'bami goreng', accepted: ['bami', 'bamigoreng'] } });
  upsertQuestion(db, E, { ...ex, roundId: r1, type: 'number', scoring: 'closest', prompt: 'VOORBEELD — Hoeveel kilometer is de Afsluitdijk lang?', seconds: 30, points: 0, key: { correct: 32 } });
  const r2 = R('brocode', 'De Bro Code', 12, 'Hoe goed lees jij de groepsapp?');
  upsertQuestion(db, E, { ...ex, roundId: r2, type: 'mc', prompt: 'Wie appte dit?', quote: 'Ik doe vanavond rustig aan.', context: 'VOORBEELD — fictief bericht', options: ['Bas', 'Koen', 'Ruben', 'Tim'], seconds: 25, points: 1, key: { correct: 1 } });
  R('ranking', 'Ranking de Boys', 10, 'Voorspel wie de groep het vaakst koos.');
  R('shots', 'Shot in het duister', 12, 'Proeven is vrijwillig. Allergenen staan op de kaart.');
  R('break', 'Pauze', 10, 'Even bijtanken. Daarna: VAMOSSS!');
  R('missions', 'Zoek, pak & bewijs + Buitentas', 12, 'Bewijsmateriaal. Geen verdere vragen.');
  R('dragons', 'BAMIGO Dragons', 12, '2 minuten voorbereiden, 45 seconden pitch.');
  const r8 = R('lightning', 'Bliksemronde', 8, 'Iedereen op eigen telefoon. Sneller goed = meer punten.');
  upsertQuestion(db, E, { ...ex, roundId: r8, type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'VOORBEELD — Hoeveel spelers staan er bij padel op de baan?', options: ['2', '3', '4', '6'], seconds: 20, key: { correct: 2 } });
  upsertQuestion(db, E, { ...ex, roundId: r8, type: 'mc', scope: 'individual', scoring: 'speed', prompt: 'VOORBEELD — Welke kleur heeft koper?', options: ['Zilvergrijs', 'Roodbruin', 'Groen', 'Goudgeel'], seconds: 20, key: { correct: 1 } });
  const r9 = R('final', 'Finale', 10, 'Mix van onderwerpen. Inzetten mag.');
  upsertQuestion(db, E, { ...ex, roundId: r9, type: 'mc', allowBet: true, prompt: 'VOORBEELD — In welk jaar werd Nederland Europees kampioen voetbal?', options: ['1974', '1988', '1998', '2000'], seconds: 30, points: 1, key: { correct: 1 } });
  R('intro', 'Uitslag en prijs', 4, 'De Bamigo-onderbroeken gaan naar…');
  return { eventId: E, joinCode: event.join_code, ownerToken, displayToken };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const db = openDb(process.env.BAMIGO_DB || path.join(here, '..', 'data', 'bamigo.db'));
  const r = seedDemo(db);
  const base = process.env.PUBLIC_URL || 'http://localhost:3000';
  console.log(`Demo aangemaakt.\n  Beheer: ${base}/beheer#k=${r.ownerToken}\n  TV:     ${base}/tv#k=${r.displayToken}\n  Spelers: ${base}/speel?code=${r.joinCode}`);
}
