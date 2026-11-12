# BAMIGO.

**Quizzen & spelavonden — Maak er een avond van.**

Een eigen tv-spelshow: de tv toont de show, spelers antwoorden op hun telefoon (geen app nodig), quizmasters beheren inhoud en verloop. Eerste editie: *Muchacho’s — Vriendenweekend 2027*.

## Wat er nu werkt (fase 1–4)

- Avond aanmaken (beschermd met beheerwachtwoord), demo-editie met fictieve namen.
- Rollen per avond via geheime links: eigenaar, inhoudsbeheerder, live host, spoilervrije organisator, tv-scherm. Links intrekbaar.
- Teams en spelers beheren, captain (overdraagbaar), persoonlijke herstel-links.
- Spelers doen mee via QR of 6-tekencode, sessie hervat na herladen.
- Vraagtypes: meerkeuze, waar/niet waar, open (met varianten + typfoutsignalering voor de host), getal (marge of dichtstbij 5-4-3-2-1), volgorde.
- Teamvragen (alleen captain stuurt in) en individuele vragen; bliksemronde met snelheidsscore op servertijd.
- Inzetten (1–3 punten) per vraag, minimum totaal 0.
- State-machine per vraag (klaar → open → gesloten → onthuld → gescoord), pauze met bevroren tijd, servertimer sluit automatisch.
- Dubbelklik-beveiliging op hostacties, idempotente inzendingen, scorelogboek met correcties/bonussen en reden, ongeldig verklaren.
- TV-scherm (lobby met QR, ronde-intro, vraag, onthulling met verdeling, scorebord, finale), host-bediening, quiz-editor met duurbewaking.
- Spelvormen: Ranking de Boys, Shot in het duister, BAMIGO Dragons, Ken je kompaan, Buitentas met BAMIGO Douane; voorbereidingsportaal op de telefoon.
- Gereedheidsoverzicht (alleen tellingen), vraagpakket export/import, uitslag-export, printbaar noodpakket, dupliceren zonder privédata, archiveren.

Nog niet gebouwd: zie [docs/OPEN-PUNTEN.md](docs/OPEN-PUNTEN.md).

## Lokaal draaien

Vereist Node.js 22.13 of nieuwer (gebruikt de ingebouwde SQLite).

```bash
npm install
BAMIGO_ADMIN_PASSWORD=kies-iets npm start       # http://localhost:3000
npm run demo                                     # maakt een demo-avond en print de links
npm test                                         # 25 geautomatiseerde tests
npm run load                                     # belastingtest: 100 deelnemers
```

Open `/beheer` om een avond te maken. Je krijgt een beheerlink (`/beheer#k=…`); bewaar die goed. Via *Avond & links* maak je de tv-link en links voor je medequizmaster.

Spelers op hetzelfde wifi-netwerk kunnen meedoen via het IP-adres van de laptop (bijv. `http://192.168.1.20:3000`). Zet dan `PUBLIC_URL` zodat de QR-code klopt.

## Online zetten

Eén kleine server met blijvende opslag is genoeg. Advies: **Fly.io** (zie `fly.toml.example` en `Dockerfile`) of Railway / een eigen VPS. Vercel past niet: dat ondersteunt geen langlopende realtime verbindingen.

```bash
fly launch --no-deploy        # gebruik fly.toml.example als basis
fly volumes create bamigo_data --size 1 --region ams
fly secrets set BAMIGO_ADMIN_PASSWORD=...
fly deploy
```

Back-up: het bestand `/data/bamigo.db` (+ map `/data/media`).

## Architectuur

- `server/` — Fastify (HTTP) + Socket.IO (realtime) + SQLite (`node:sqlite`). Eén proces; alle regels en tijden op de server.
- `server/live.js` — spelmotor: state-machine, inzendingen, scoring, scorebord.
- `server/views.js` — per rol gefilterde views. Antwoorden gaan nooit vóór onthulling naar spelers of tv.
- `server/migrations/` — databaseschema.
- `public/` — HTML/CSS/JS zonder buildstap: `speel` (telefoon), `tv`, `beheer`.
- `docs/` — review, beheerhandleiding, testresultaten, open punten.
