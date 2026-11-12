# BAMIGO — kritische review van de bouwopdracht

Versie 1 · 12 november 2026

Kort en concreet: wat ik verander, wat ik aanneem en waar het plan zichzelf tegenspreekt.

## Spelregels: tegenstrijdigheden en verbeteringen

1. **Shot in het duister: het laatste antwoord is nog steeds gratis.** Ook als de onthulling pas na shot vijf komt, kan een team via eliminatie raden: elk team proeft vier vreemde shots en moet die aan vier andere teams koppelen. Wie er drie heeft ingevuld, weet de vierde. **Voorstel (ingebouwd als standaard):** herkomstvoorspellingen zijn onafhankelijk; een team mag hetzelfde team meerdere keren noemen. Dan kost elk antwoord echt kennis.
2. **Dragons: niet-uitgegeven budget is een tactiek.** Een team dat €0 investeert, benadeelt de rest. **Voorstel:** het volledige budget van €10.000 moet worden verdeeld, in stappen van €500, over minimaal één ander team. De server weigert iets anders.
3. **Pokerface heeft geen puntentelling.** **Voorstel:** 2 punten voor het kiezen van het echte antwoord, 1 punt per team dat op jouw bluf stemt. Niemand kan op het eigen antwoord stemmen.
4. **Inzetten met minimum nul.** Omdat scores een logboek zijn, legt de server bij verlies de werkelijk afgetrokken punten vast (afgetopt zodat het totaal niet onder nul komt). Zo blijft het logboek herleidbaar.
5. **Ranking de Boys bij gedeelde eerste plaats:** elk gedeeld antwoord is goed (zoals het plan zegt). Zonder geldige stemmen vervalt de vraag automatisch.
6. **Ken je kompaan bij het trio:** de twee spelers per vraag worden vooraf vastgelegd en roteren zichtbaar in de editor.
7. **Bliksemronde:** ik volg de formule `500 + floor(500 × max(0, 1 − t/20))`. Er komt geen "netwerkcoulance": de server meet ontvangst. Dat bevoordeelt iets wie dichter bij de router zit; dat is eerlijk te benoemen maar niet volledig weg te werken.
8. **Krant van 27 december 2026: dat is een zondag.** De meeste Nederlandse dagbladen verschijnen niet op zondag. Kies een andere datum (bijvoorbeeld zaterdag 26 of maandag 28 december) of bevestig welke krant wel verschijnt.
9. **Speeldag:** 22–24 januari 2027 is vrijdag t/m zondag. Zaterdagavond 23 januari ligt het meest voor de hand (iedereen is er, nog geen vertrekstress).
10. **Planning van 110 minuten is krap maar haalbaar** zolang de host overgangen strak houdt. De editor toont de optelsom en waarschuwt boven de grens. Advies: blackjack niet in deze editie.

## Rollen en geheimhouding

- Reno wil meespelen. Dat werkt alleen als de **medequizmaster alle verrassende inhoud beheert**. Reno krijgt de rol "spoilervrije organisator": planning en voortgang, geen antwoorden, geen stemuitslagen, geen shotgegevens.
- De **live host** ziet de antwoordsleutel pas na het sluiten/onthullen van de vraag. Wie open antwoorden handmatig beoordeelt, ziet de antwoorden uiteraard bij het beoordelen.
- Alle filtering gebeurt op de server: spelers en het tv-scherm krijgen nooit een antwoordsleutel vóór de onthulling, ook niet verstopt in de netwerkdata.

## Techniek

- **Eén Node.js-server** (Fastify + Socket.IO) met **SQLite** als gedeelde database. Voor 10–100 telefoons is één proces ruim voldoende; geen losse database-dienst nodig, eenvoudig te back-uppen (één bestand).
- **Hosting:** een kleine server met blijvende opslag (bijv. Fly.io, Railway of een eigen VPS, ca. €0–5 per maand). Vercel past minder goed, omdat het geen langlopende realtime verbindingen ondersteunt.
- Geen buildstap voor de frontend: gewone HTML/CSS/JS-modules. Minder onderhoud, minder dat kapot kan gaan.
- Geen betaalde AI nodig; open antwoorden via varianten + normalisatie + handmatige beoordeling.

## Aannames die ik maak (omkeerbaar)

- Inloggen voor organisatoren gaat via geheime beheerlinks per rol (zoals een uitnodigingslink), niet via accounts met wachtwoord. Een instance-wachtwoord beschermt het aanmaken van nieuwe avonden.
- Spelers zijn per avond aangemeld; er zijn geen accounts over avonden heen.
- Teamvragen: alleen de captain verstuurt; teamgenoten zien live wat de captain heeft gekozen.

## Risico's

- **Wifi op locatie** is het grootste risico. Daarom: noodpakket (printbare vragen + antwoordbladen) en handmatige score-invoer.
- **Mascotte:** ik heb geen illustratie in zes toestanden; in fase 1 gebruik ik een eenvoudige vectorversie. Een echte illustratieset kan later via een beeldgenerator, met Reno's akkoord.
- De claim "100 deelnemers" geldt pas na de belastingtest (fase 6) en wordt daar met cijfers onderbouwd.
