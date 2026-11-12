// BAMIGO Spelersdossier: één vraag per scherm, met delen, voortgang en automatisch opslaan.
import { $, $$, esc, toast } from './common.js';

const DEFAULT_INTRO = { title: 'BAMIGO Spelersdossier', text: 'Vertrouwelijk. Alleen de quizmasters lezen mee. Je antwoorden worden pas op de avond gebruikt, en nooit met je naam erbij tot de onthulling.' };
const DEFAULT_OUTRO = { title: 'Dossier ontvangen', text: 'Je staat op de lijst. Tot op de avond.' };

/**
 * Open het dossier als volledig scherm.
 * @param {object} prof  v.prep.profile (questions, answers, dossier, limits, done)
 * @param {Array} people kandidaten (Muchacho's) [{id,name}]
 * @param {Function} save async (body) => void  — POST /api/player/dossier
 */
export function openDossier(prof, people, save) {
  const items = prof.questions;
  const answers = structuredClone(prof.answers || {});
  let limits = prof.limits || '';
  const intro = { ...DEFAULT_INTRO, ...(prof.dossier?.intro || {}) };
  const outro = { ...DEFAULT_OUTRO, ...(prof.dossier?.outro || {}) };
  // Schermen: intro, (deel-kop), vragen…, humorgrens, afsluiting
  const screens = [{ kind: 'intro' }];
  let section = null;
  for (const it of items) {
    if (it.type === 'section') { section = it; screens.push({ kind: 'section', it }); }
    else screens.push({ kind: 'q', it, section });
  }
  screens.push({ kind: 'limits', section: { q: 'Tot slot' } });
  screens.push({ kind: 'outro' });
  const qScreens = screens.filter(s => s.kind === 'q' || s.kind === 'limits');
  // Verder waar je was: eerste onbeantwoorde vraag (of intro als nog niets is ingevuld).
  let at = 0;
  if (Object.keys(answers).length && !prof.done) { const i = screens.findIndex(s => s.kind === 'q' && answers[s.it.id] == null); at = i > 0 ? i : 0; }

  const el = document.createElement('div');
  el.className = 'dossier'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', intro.title);
  document.body.appendChild(el); document.body.classList.add('no-scroll');
  const close = () => { el.remove(); document.body.classList.remove('no-scroll'); };

  function valueOf(s) {
    if (s.kind === 'limits') return $('#dzIn', el)?.value ?? '';
    const t = s.it.type;
    if (t === 'scale') return $('[data-scale][aria-pressed="true"]', el)?.dataset.scale ?? '';
    if (t === 'muchacho') { const pick = $('[data-pick][aria-pressed="true"]', el)?.dataset.pick || ''; return pick ? { pick, why: $('#dzWhy', el)?.value || '' } : ''; }
    return $('#dzIn', el)?.value ?? '';
  }

  async function go(delta) {
    const s = screens[at];
    if (s.kind === 'q' || s.kind === 'limits') {
      const v = valueOf(s);
      try {
        if (s.kind === 'limits') { limits = v; await save({ limits: v }); }
        else { await save({ answers: { [s.it.id]: v } }); if (v === '' || v == null) delete answers[s.it.id]; else answers[s.it.id] = v; }
      } catch (e) { toast(e.message, 'bad'); return; }
    }
    at = Math.max(0, Math.min(screens.length - 1, at + delta));
    if (screens[at].kind === 'outro') { try { await save({ done: true }); } catch (e) { toast(e.message, 'bad'); } }
    draw();
  }

  function input(it) {
    const a = answers[it.id];
    switch (it.type) {
      case 'number': return `<div class="dz-num">${it.unit ? `<span>${esc(it.unit)}</span>` : ''}<input id="dzIn" inputmode="decimal" autocomplete="off" value="${esc(a ?? '')}" placeholder="0"></div>`;
      case 'scale': return `<div class="dz-scale" role="group" aria-label="Cijfer van 1 tot 10">${Array.from({ length: 10 }, (_, i) => `<button type="button" data-scale="${i + 1}" aria-pressed="${String(a) === String(i + 1)}">${i + 1}</button>`).join('')}</div>
        <div class="dz-scale-legend"><span>Geen idee</span><span>Ik ben de groepsapp</span></div>`;
      case 'time': return `<input id="dzIn" class="dz-time" type="time" value="${esc(a ?? '')}">`;
      case 'muchacho': return `<div class="dz-people" role="group" aria-label="Kies een Muchacho">${people.map(p => `<button type="button" data-pick="${p.id}" aria-pressed="${a?.pick === p.id}"><span class="av">${esc(p.name.slice(0, 1).toUpperCase())}</span>${esc(p.name)}</button>`).join('')}</div>
        ${it.why ? `<label class="dz-why" for="dzWhy">${esc(it.why)}</label><textarea id="dzWhy" maxlength="300" rows="2">${esc(a?.why ?? '')}</textarea>` : ''}`;
      default: return `<textarea id="dzIn" maxlength="500" rows="4" placeholder="Typ je antwoord…">${esc(a ?? '')}</textarea>`;
    }
  }

  function draw() {
    const s = screens[at];
    const qi = qScreens.indexOf(s);
    const pct = s.kind === 'outro' ? 100 : qi >= 0 ? Math.round((qi / qScreens.length) * 100) : 0;
    const top = `<div class="dz-top"><span class="dz-brand">BAMIGO<i>.</i></span><span class="dz-conf">Vertrouwelijk</span><button class="dz-x" aria-label="Sluiten" data-close>×</button></div>
      <div class="dz-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>`;
    let body = '';
    if (s.kind === 'intro') body = `<div class="dz-center"><div class="dz-stamp">Dossier</div><h1 class="dz-h1">${esc(intro.title)}</h1><p class="dz-lead">${esc(intro.text)}</p>
      <p class="dz-meta">${qScreens.length - 1} vragen · ± ${Math.max(2, Math.round(qScreens.length / 3))} minuten · alles optioneel</p>
      <button class="btn primary big block" data-next>${Object.keys(answers).length ? 'Verder waar je was' : 'Start dossier'}</button></div>`;
    else if (s.kind === 'section') body = `<div class="dz-center"><div class="dz-kicker">${esc(s.it.q.split('·')[0].trim())}</div><h1 class="dz-h1">${esc(s.it.q.includes('·') ? s.it.q.split('·').slice(1).join('·').trim() : s.it.q)}</h1>
      ${s.it.help ? `<p class="dz-lead">${esc(s.it.help)}</p>` : ''}<button class="btn primary big block" data-next>Verder</button></div>`;
    else if (s.kind === 'outro') body = `<div class="dz-center"><div class="dz-check" aria-hidden="true">✓</div><h1 class="dz-h1">${esc(outro.title)}</h1><p class="dz-lead">${esc(outro.text)}</p>
      <button class="btn primary big block" data-close>Sluiten</button><button class="btn ghost block" data-back style="margin-top:8px">Antwoorden nakijken</button></div>`;
    else {
      const it = s.kind === 'limits' ? { q: 'Waar moet de humor bij jou wegblijven?', help: 'Optioneel. Alleen de quizmasters zien dit.' } : s.it;
      body = `<div class="dz-q"><div class="dz-kicker">${esc(s.section?.q || '')}<span>${qi + 1} / ${qScreens.length}</span></div>
        <h2 class="dz-question">${esc(it.q)}</h2>${it.help ? `<p class="dz-help">${esc(it.help)}</p>` : ''}
        ${s.kind === 'limits' ? `<textarea id="dzIn" maxlength="500" rows="3" placeholder="Bijv. mijn ex, mijn werk…">${esc(limits)}</textarea>` : input(it)}</div>
        <div class="dz-nav"><button class="btn ghost" data-back>Terug</button><button class="btn primary grow" data-next>${qi === qScreens.length - 1 ? 'Dossier insturen' : 'Volgende'}</button></div>
        <p class="dz-skip"><button class="linkbtn" data-skip>Overslaan</button></p>`;
    }
    el.innerHTML = `<div class="dz-inner">${top}${body}</div>`;
    $$('[data-close]', el).forEach(b => b.onclick = close);
    $$('[data-next]', el).forEach(b => b.onclick = () => { b.disabled = true; go(1); });
    $$('[data-back]', el).forEach(b => b.onclick = () => go(-1));
    $$('[data-skip]', el).forEach(b => b.onclick = () => { at++; draw(); });
    $$('[data-scale]', el).forEach(b => b.onclick = () => { $$('[data-scale]', el).forEach(x => x.setAttribute('aria-pressed', String(x === b))); });
    $$('[data-pick]', el).forEach(b => b.onclick = () => { const on = b.getAttribute('aria-pressed') !== 'true'; $$('[data-pick]', el).forEach(x => x.setAttribute('aria-pressed', String(on && x === b))); });
    const f = $('#dzIn', el); if (f && f.tagName !== 'TEXTAREA') f.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); go(1); } };
    el.scrollTop = 0;
  }
  draw();
}
