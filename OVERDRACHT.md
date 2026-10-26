# NUS-dashboard — overdracht

Dit document is bedoeld voor degene die dit dashboard overneemt. Lees het één
keer helemaal door voordat je iets doet; vooral het hoofdstuk over de data, want
daar kun je onherstelbare schade aanrichten.

---

## 1. Wat is dit

Een hulpmiddel voor het sturen van de NUS-bak (niet-urgente storingen) in de
regio's Leiden en Haarlem. Het leest geen systemen uit: je plakt er twee keer
per dag een lijst in uit de Instandhoudingsapp, en het dashboard bewaart die
momentopname. Door die momentopnamen met elkaar te vergelijken ontstaat
informatie die **in geen enkel ander systeem bestaat**:

- hoe lang een storing in elke processtap blijft staan
- hoeveel werk er per week bij komt en af gaat
- welke storingen blijven liggen terwijl jongere worden afgehandeld
- hoeveel werk er stilstaat op iets buiten het team (aannemerij, Aanleg)

De Instandhoudingsapp weet alleen wat de stand van *nu* is. Dat een storing elf
dagen in "In onderzoek" stond, weet alleen dit dashboard — omdat het het
verschil tussen de dagen bewaart. **Dat is de reden dat de historie waardevol
is, en dat je 'm niet moet kwijtraken.**

---

## 2. Hoe je het start

Dubbelklik op `index.html`. Dat is alles. Er is geen installatie, geen server,
geen inlog en geen netwerkverbinding nodig.

Gebruik **Chrome of Edge**. In Firefox en Safari werkt een deel niet.

> **Belangrijk:** de data hangt aan de browser én aan de map waar je het bestand
> vandaan opent. Verplaats de map niet zomaar, en gebruik steeds dezelfde
> browser op dezelfde computer. Zie hoofdstuk 4.

---

## 3. De dagelijkse routine

Twee keer per dag, uit de Instandhoudingsapp:

1. Open het tabblad **Invoer**.
2. Plak de **gebiedsweergave** (de lijst met gebiedscodes ZZE…). Kies de datum
   van vandaag en klik op verwerken.
3. Plak de **statusweergave** (dezelfde storingen, gegroepeerd op OV-status).
   Zelfde datum, nogmaals verwerken.

De twee weergaven vullen elkaar aan: de gebiedslijst mist de status, de
statuslijst mist de gebiedscode. Het dashboard voegt ze samen op ordernummer.

**Klantaanvragen** plak je apart, met de knop "Klantaanvragen" boven het
plakveld. Die tellen bewust niet mee in de storingscijfers: hun termijn loopt
over maanden en zou elk getal scheeftrekken.

### De regel die alles draagt

**Verdwenen uit de lijst = opgelost.** Het dashboard krijgt nooit te horen dat
een storing is afgehandeld; het concludeert dat uit het feit dat een ordernummer
er de ene dag wel in staat en de volgende keer niet meer.

Daar volgt één ding uit dat je moet weten: **als je een keer vergeet te plakken,
gaat er niets kapot, maar als je een onvolledige lijst plakt, lijken alle
ontbrekende storingen opgelost.** Plak dus altijd de hele lijst, nooit een
gefilterd deel.

---

## 4. De data — lees dit

### Waar het staat

In de IndexedDB van je browser, onder de naam `nusdash`. Dat is lokale opslag
die bij jouw browserprofiel op deze computer hoort. Het staat **niet** in de
map, **niet** op een netwerkschijf en **niet** in de cloud.

Dat betekent dat de volledige historie verdwijnt bij:

- "Browsergegevens wissen" in Chrome/Edge
- een nieuw browserprofiel of een nieuwe gebruiker op de computer
- een herinstallatie of vervanging van de laptop door IT
- opschoning door de browser als de schijf vol raakt

### Wat je daartegen doet

**Maak regelmatig een back-up en bewaar die in een map die door Alliander wordt
geback-upt** (OneDrive, Teams, SharePoint — een map die synchroniseert).

Instellingen → Back-up → *Exporteer back-up*. Dat levert één JSON-bestand met
alles erin: alle momentopnamen, alle instellingen, alle markeringen.

Het dashboard houdt zelf bij hoeveel plakacties er nog niet in een back-up
zitten en waarschuwt vanaf vier. Vanaf twintig wordt die waarschuwing rood.
**Negeer die niet** — er is geen tweede kopie.

### Terugzetten

Instellingen → Back-up → *Importeer back-up…*

Voordat er iets gebeurt, krijg je te zien hoeveel opgeslagen updates je nu hebt
en hoeveel er in het bestand zitten. Staat er **LET OP: dit bestand is ouder of
kleiner**, stop dan en denk na: je staat op het punt historie weg te gooien die
je niet terugkrijgt. Maak eerst een back-up van de huidige stand.

### Hoe groot wordt het

Ongeveer 28 MB per jaar bij 150 storingen en twee plakacties per werkdag. De
momentopnamen worden nooit automatisch opgeruimd, en dat is met opzet: de
historie ís de waarde.

---

## 5. De overdracht zelf

1. Maak een verse back-up (`Exporteer back-up`).
2. Zet die in de gedeelde map van het team, met de datum in de naam.
3. Geef de hele projectmap door (of wijs de opvolger de map in Git aan).
4. Laat de opvolger `index.html` openen en de back-up importeren via
   Instellingen → Back-up.
5. Loop samen één keer de dagelijkse routine door. Dat is belangrijker dan dit
   document: de valkuil zit in het plakken, niet in de techniek.

> **Privacy:** de data bevat namen van collega's en adressen van klanten. Die
> hoort binnen Alliander te blijven. OneDrive, Teams en SharePoint zijn prima;
> een privé-clouddienst, een externe host of een publieke repository niet — ook
> niet tijdelijk.

---

## 6. Beslissingen die niet vanzelf spreken

Dit zijn de keuzes waar iemand anders anders over kan denken. Ze staan hier
zodat je weet dát ze gemaakt zijn, en waarom.

**Geblokkeerde storingen tellen niet mee in de gemeten doorlooptijd.** Een
storing die wacht op Aanleg of de aannemerij staat stil om een reden buiten het
team. Die wachttijd telt wel in kalenderdagen maar zegt niets over het eigen
tempo. Erger: de gemeten mediaan is ook de terugvalnorm als je geen streefwaarde
invult, dus blokkades maakten de norm juist soepeler bij de stappen waar ze het
meest voorkomen. Welke blokkade-redenen meetellen stel je in bij
Instellingen → *Blokkades en meten*.

**"Onderzoek loopt" is een twijfelgeval.** Dat is het eigen proces; dat
uitsluiten poetst echte stilstand in het onderzoek weg. Kijk of de instelling
nog past bij hoe jij wilt sturen.

**De norm is 12 dagen voor het hele traject** (10 werkdagen), verdeeld over de
zes statussen. Die verdeling telt op tot 12: blijft elke stap binnen zijn deel,
dan haalt het traject het vanzelf. Aan te passen bij
Instellingen → *Doorlooptijd-normen*.

**Regio-indeling:** ZZE9A/B en ZZE10A/B zijn Haarlem, ZZE5 t/m ZZE8 zijn Leiden,
de rest is Overig.

**Het type-filter bepaalt wat meetelt.** Alleen types die in Instellingen →
*Type-filter* staan, tellen mee in de cijfers. Komt er een nieuw storingstype
bij in de Instandhoudingsapp, dan moet je het hier toevoegen, anders is het
onzichtbaar. Het dashboard meldt onbekende types.

**De werklijst is de voordeur.** Alles wat om actie vraagt staat op Data in één
lijst, met de reden erbij. Wat je hebt afgehandeld markeer je daar als gezien,
opgepakt of geparkeerd; dan verdwijnt het uit de lijst. Een parkering loopt
altijd af, en een markering vervalt automatisch als de storing van status
verandert — je kunt dus niets per ongeluk voorgoed wegstoppen.

---

## 7. Als je iets wilt veranderen

De code is gewoon JavaScript, HTML en CSS. Geen framework, geen buildstap, geen
pakketten. Je kunt een bestand openen, iets aanpassen en de pagina verversen.

**Twee dingen die je niet mag vergeten:**

1. **Na elke wijziging aan `index.html`, `style.css` of `app.js`:**
   ```
   node scripts/build-export-template.js
   ```
   Zonder die stap werkt de export voor de werkvoorbereiders nog met de oude
   versie. Dat merk je niet totdat iemand iets mist.

2. **Draai de tests.** Ze staan in `tests/` met een eigen README. Ze openen het
   dashboard in een echte browser, plakken data en rekenen de uitkomsten na met
   de hand. Verschillende echte fouten zijn hierdoor gevonden en niet door te
   lezen.

De code bevat ongebruikelijk veel commentaar, en dat is met opzet: het legt
steeds uit *waarom* iets zo is, niet wat de regel doet. Bij twijfel is dat
commentaar meestal het antwoord.

---

## 8. Open punten

Dingen die bekend zijn en nog niet opgelost:

- **De team-export groeit mee met de historie.** Het gedeelde HTML-bestand bakt
  alle momentopnamen in. Na een jaar is dat tientallen MB's. Op termijn moet de
  export beperkt worden tot een recent venster.
- **De data hangt nog aan de browser.** Er ligt een testpagina klaar
  (`tools/maptest.html`) die uitzoekt of deze computer het dashboard toestaat
  rechtstreeks naar een map te schrijven. Lukt dat, dan kan de data naar een
  OneDrive-map en vervalt het grootste deel van dit hoofdstuk 4.
---

## 9. Wat er eerder is geprobeerd

**SharePoint-synchronisatie heeft bestaan en is verwijderd.** Een eerdere versie
kon blokkade-redenen delen via een JSON-bestand in een SharePoint-bibliotheek:
lezen en schrijven via de REST API met `credentials: 'same-origin'`, inclusief
het form digest-token dat SharePoint bij schrijfacties eist, en per order
bijwerken zodat twee mensen elkaar niet overschreven.

Het is er in augustus 2026 uitgehaald (commit `5473995`), en de reden is
belangrijk als je ooit over delen nadenkt: **het kon niet werken zolang het
dashboard via `file://` wordt geopend.** Een `fetch()` naar een https-site
vanaf een lokaal bestand wordt door de browser geblokkeerd. De code zette
zichzelf daarom uit, en stond dus altijd uit.

Dat is iets anders dan "het werkte niet". Het is nooit geprobeerd. Wordt het
dashboard ooit *vanaf* de SharePoint-site geopend in plaats van als lokaal
bestand, dan vervalt dat bezwaar: dan klopt de oorsprong, stuurt de browser de
bestaande Alliander-aanmelding mee, en is er geen enkele inlogcode nodig.

De oude code is terug te vinden met:

```
git show 5473995^:app.js
```

Daar zitten de functies `spGetDigest`, `spGetFileContent`, `spUpdateSharedFile`
en de instellingenkaart die erbij hoorde.
