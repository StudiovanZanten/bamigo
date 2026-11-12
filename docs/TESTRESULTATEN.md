# Testresultaten — fase 1–4 (12 november 2026)

Omgeving: cloud-container, Linux, 4 vCPU, Node.js 22.23, server en clients op dezelfde machine (loopback). **Geen echte wifi of echte telefoons**; zie beperkingen.

## Geautomatiseerd (`npm test`): 25/25 geslaagd

| # uit plan | Wat | Resultaat |
|---|---|---|
| 1, 14 | Rollen: speler/tv/host/spoilervrij krijgen geen antwoorden of inhoud; andere avond niet bewerkbaar; ingetrokken link werkt niet; eigenaar kan geen 2e eigenaar maken | ✔ |
| 14 | Privé-media: zonder token, andere avond of vóór de vraag geweigerd; bestandstype gecontroleerd op inhoud | ✔ |
| 2 | Sessie hervatten met token; naam niet te kapen; nieuwe link maakt oude ongeldig | ✔ |
| 3 | 5 teams / 11 spelers via echte sockets; alleen captain telt; captainoverdracht alleen door huidige captain | ✔ |
| 4 | Volledige ronde: openen, indienen, auto-sluiten door servertimer, onthullen, scoren; telefoon en tv tonen juiste data; verdeling op tv | ✔ |
| 5 | Te vroeg/te laat geweigerd, ongeldige keuze geweigerd, dubbele taps → één inzending, herscoren telt niet dubbel, correcties met reden, vervallen | ✔ |
| 6 | Bliksem: 2 s → 950 pt, 10 s → 750 pt, fout 0, te laat geweigerd, aparte individuele ranglijst | ✔ |
| — | Pauze bevriest tijd (speeltijd zonder pauze gemeten); deadline schuift op | ✔ |
| — | Dichtstbij met gelijke afwijking → 5,5,3,2,1 | ✔ |
| — | Inzet: goed +inzet, fout −inzet, totaal niet onder 0 | ✔ |
| — | Open antwoord met typfout → “twijfel” voor host; handmatig oordeel herscoort zonder dubbeling | ✔ |
| — | Dubbelklik/verouderde hostactie geweigerd; nieuwe vraag niet te starten terwijl er een openstaat; gespeelde vraag niet opnieuw | ✔ |
| 10 | Dupliceren: geen inzendingen, scores of sessies mee; nieuwe code | ✔ |
| 7 | Ranking: zelfstemmen geweigerd, gedeelde eerste plaats beide goed, 0 stemmen = vervalt, alleen totalen | ✔ |
| 8 | Shots: eigen shot geblokkeerd, onthulling geweigerd tot alle shots vastgezet, varianten, onafhankelijk raden | ✔ |
| 9 | Dragons: eigen team, niet-volledig budget en verkeerde stappen geweigerd; geheim tot onthulling; 5-4-3-2-1 met gelijke stand | ✔ |
| — | Ken je kompaan: trio roteert, niet-aangewezen geblokkeerd, punt bij gelijk antwoord | ✔ |
| — | Buitentas: 12:00 / 250 g dichtstbij, gedeelde plek, afgekeurd = 0, opnieuw scoren zonder dubbeling | ✔ |
| — | Code raden: na 30 foute codes per 10 min per IP geblokkeerd | ✔ |

## Belastingtest (`npm run load`): 100 deelnemers × 5 bliksemvragen

| Meting | Resultaat |
|---|---|
| Inzendingen | 500/500 bevestigd, 0 fouten (0,00 %) |
| Ontvangstbevestiging | p50 62 ms · p95 100 ms · p99 102 ms · max 102 ms |
| Vraag zichtbaar bij alle 100 na geplande start | gem. 45 ms, max 51 ms |
| Dubbele taps (500) | 500 correct afgevangen, 0 dubbele inzendingen, 0 dubbele scoreregels |
| Reconnects (10 % tijdens vraag 3) | geen ontbrekende inzendingen |

Doel “p95 onder 1 s” gehaald **in deze testomgeving**. Op echte wifi komt daar de netwerkvertraging van elke telefoon bij (typisch 10–150 ms, bij slechte wifi soms seconden). Status: *ontworpen* voor 100, *gevalideerd op loopback*; nog niet gevalideerd op echte wifi met echte telefoons.

## Browsercheck (Playwright, Chromium)
- iPhone 13- en Pixel 7-emulatie: aanmelden met code, team kiezen, antwoorden, ontvangstbevestiging, niet-captain-weergave, onthulling; herladen hervat de sessie. Geen consolefouten.
- TV 1920×1080: lobby met QR, vraag met timer, onthulling met verdeling, scorebord.
- Echte iPhone/Android-toestellen, Safari en echte tv: **nog niet getest** — doen tijdens de generale repetitie.

## Browsercheck fase 4
- Voorbereiding op telefoon (stemmen, verhaal, missie), rankingvraag, vijf shots + onthulling, Dragons-verdeling, Douane-scherm: zonder consolefouten.

## Nog niet getest
- Toetsenbord-only doorloop en schermlezer (componenten zijn native knoppen/inputs met labels; niet systematisch doorlopen).
- Minder-bewegen-modus visueel (CSS aanwezig, niet visueel gecontroleerd).
