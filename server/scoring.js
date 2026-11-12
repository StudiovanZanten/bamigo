// Pure scorefuncties: geen database, makkelijk te testen.

/** Normaliseer een open antwoord: kleine letters, geen accenten/leestekens/lidwoorden. */
export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(de|het|een|the|a|an|'t)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/**
 * Beoordeel een open antwoord. Geeft 'correct', 'review' (twijfel: host beslist) of 'wrong'.
 * Geen AI: alleen opgeslagen varianten, normalisatie en een kleine typfoutmarge die naar de host gaat.
 */
export function judgeOpen(answer, variants) {
  const a = normalize(answer);
  if (!a) return 'wrong';
  const vs = variants.map(normalize).filter(Boolean);
  if (vs.includes(a)) return 'correct';
  for (const v of vs) {
    const d = levenshtein(a, v);
    if (v.length >= 5 && d <= Math.max(1, Math.floor(v.length / 6))) return 'review';
    if (v.length >= 4 && (a.includes(v) || v.includes(a)) && Math.abs(a.length - v.length) <= 6) return 'review';
  }
  return 'wrong';
}

/** Bliksemronde: 500 + floor(500 × max(0, 1 − t/T)). t en T in seconden; servertijd. */
export function speedScore(elapsedMs, seconds) {
  const t = Math.max(0, elapsedMs) / 1000;
  return 500 + Math.floor(500 * Math.max(0, 1 - t / seconds));
}

/**
 * Gedeelde competitierang: [10, 7, 7, 3] → [1, 2, 2, 4].
 * `better(a,b)` < 0 als a beter is.
 */
export function competitionRanks(items, value, higherIsBetter = true) {
  const sorted = [...items].sort((a, b) => higherIsBetter ? value(b) - value(a) : value(a) - value(b));
  const ranks = new Map();
  sorted.forEach((it, i) => {
    const prev = sorted[i - 1];
    ranks.set(it, prev && value(prev) === value(it) ? ranks.get(prev) : i + 1);
  });
  return ranks;
}

/** Punten volgens schaal per rang, bijv. [5,4,3,2,1]. Gelijke rang = gelijke punten (5,5,3,2,1). */
export const pointsForRank = (rank, scale) => scale[rank - 1] ?? 0;

export function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}
