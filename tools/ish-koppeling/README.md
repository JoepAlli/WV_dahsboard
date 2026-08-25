# Rechtstreeks gegevens ophalen uit de InstandhoudingsApp

Onderzoek naar de vraag of het dashboard de OData-service van de
InstandhoudingsApp rechtstreeks kan aanroepen in plaats van dat jij de lijst
handmatig plakt.

Service: `/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/`

**Voorbehoud:** dit onderzoek is gedaan zonder toegang tot het
Alliander-netwerk. Wat hieronder over browsergedrag staat is niet uit de losse
pols: het is nagemeten in Chromium tegen een nagebouwde SAP-OData-service, en de
meetuitkomsten staan er letterlijk bij. Wat jullie server precies terugstuurt is
niet nagemeten — dat meet je zelf in een minuut met `cors-test.js`.

## Korte antwoord

Vanuit je `file://`-dashboard: vrijwel zeker niet. Vanuit de
InstandhoudingsApp-pagina zelf: probleemloos, want daar is het geen
cross-origin-verzoek en gaan je cookies vanzelf mee.

De werkbare route is daarom: een klein script dat je op de app draait haalt de
gegevens op als JSON; het dashboard leest dat JSON in. Dat vervangt het
handmatige knip- en plakwerk zonder dat er ook maar iets aan de eis "geen
server, werkt offline" verandert.

## 1. Kan de browser deze verzoeken hergebruiken?

De verzoeken zelf niet — er valt geen bestaand verzoek "opnieuw af te spelen"
vanuit een andere pagina. Wat wél kan is hetzelfde verzoek opnieuw doen. Of dat
lukt hangt volledig af van vanaf welke pagina je het doet:

| Vanaf | Cookies gaan mee | CORS van toepassing | Werkt |
|---|---|---|---|
| De InstandhoudingsApp zelf (console/bookmarklet) | ja, automatisch | nee (same-origin) | **ja** |
| Je dashboard via `file://` | nee (zie 3) | ja, en streng | vrijwel zeker niet |
| Een browserextensie met host-rechten | ja | nee (extensies mogen dit) | ja, mits IT het toestaat |
| Een lokaal proxy-scriptje | nee — moet zelf inloggen | n.v.t. | nee, SSO staat in de weg |

## 2. CORS-beperkingen

Een pagina die via `file://` is geopend heeft geen echte herkomst; de browser
stuurt `Origin: null` mee. Elk verzoek naar `https://…` is daarmee
cross-origin, en dan gelden er twee horden:

1. De server moet `Access-Control-Allow-Origin` terugsturen met daarin `null`
   of `*`. Doet hij dat niet, dan blokkeert de browser het antwoord — het
   verzoek is dan wel verstuurd, maar je mag de inhoud niet zien.
2. Wil je er cookies bij (nodig, zie 3), dan moet daar `Access-Control-Allow-
   Credentials: true` bij, én mag `Access-Control-Allow-Origin` **niet** `*`
   zijn. Het moet dan letterlijk `null` zijn — een combinatie die als
   veiligheidslek geldt en die je in de praktijk niet tegenkomt.

SAP Gateway stuurt standaard helemaal geen CORS-headers: die diensten zijn
bedoeld om vanaf het Fiori-launchpad te worden aangeroepen, dus same-origin. Dat
er bovendien een reverse proxy (`UVAGateway`) voor staat maakt het niet
waarschijnlijker.

### Nagemeten

Een `file://`-pagina in Chromium, tegen een server die vier houdingen kan
aannemen. De herkomst van die pagina is letterlijk `null`.

| Server stuurt | Cookies gevraagd | Uitkomst |
|---|---|---|
| geen CORS-headers (SAP-standaard) | nee | geblokkeerd |
| geen CORS-headers | ja | geblokkeerd |
| `Access-Control-Allow-Origin: *` | nee | **gelukt** |
| `Access-Control-Allow-Origin: *` | ja | geblokkeerd |
| `ACAO: *` + `Allow-Credentials: true` | ja | geblokkeerd — `*` mág niet samen met cookies |
| `ACAO: null` + `Allow-Credentials: true` | ja | **gelukt** |
| `mode: 'no-cors'` | ja | verstuurd, antwoord onleesbaar |

En de doorslaggevende meting: van de tien verzoeken die de server bereikten,
kwamen er **nul** met de sessiecookie aan — ook de twee geslaagde niet. Zie 3.

`mode: 'no-cors'` lijkt een uitweg maar is het niet: je krijgt een "opaque"
antwoord terug waar geen enkel gegeven uit te lezen valt.

De browser starten met `--disable-web-security` omzeilt dit, maar dat zet de
beveiliging voor *al* je browsen uit en hoort niet thuis op een werklaptop. Doe
dat niet.

## 3. Kunnen de bestaande authenticatiecookies gebruikt worden?

Vanaf de app zelf: ja, automatisch — dat is precies wat `credentials:
'same-origin'` doet.

Vanaf het dashboard: nee, en wel om drie onafhankelijke redenen, waarvan er al
één genoeg is:

- **SameSite.** SAP-sessiecookies (`SAP_SESSIONID_*`, `MYSAPSSO2`) staan
  vrijwel altijd op `SameSite=Lax`. Die gaan bij een cross-site `fetch` niet
  mee, ook niet met `credentials: 'include'`. Dat is hierboven gemeten: zelfs in
  de enige CORS-opstelling die wél een leesbaar antwoord gaf, kwam de cookie
  niet mee. Stond hij op `SameSite=None; Secure`, dan zou hij wel meegaan — maar
  dat is niet hoe SAP dit standaard neerzet.
- **CORS.** Zelfs als de cookie meegaat, mag je het antwoord niet lezen zonder
  de headers uit punt 2.
- **HttpOnly.** JavaScript kan die cookies niet uitlezen, dus zelf meesturen in
  een header kan ook niet.

Kortom: het dashboard kan niet meeliften op je sessie. Het script dat op de app
draait heeft die sessie gewoon al.

## 4. Welk fetch-verzoek is nodig?

Uitgevoerd op de InstandhoudingsApp-pagina, met relatieve URL's:

```js
// Welke entiteitensets bestaan er?
await fetch('/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/?$format=json',
  { credentials: 'same-origin', headers: { Accept: 'application/json' } });

// Welke velden zitten erin?
await fetch('/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/$metadata',
  { credentials: 'same-origin' });

// De gegevens zelf, per set, met paginering
await fetch('/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/<EntitySet>'
  + '?$format=json&$top=500&$skip=0',
  { credentials: 'same-origin', headers: { Accept: 'application/json' } });
```

Aandachtspunten:

- **Geen X-CSRF-Token nodig.** Dat vraagt SAP alleen bij schrijfacties. Voor
  lezen (GET) niet, en schrijven doen we hier bewust nergens.
- **`sap-client`.** Staat die in de URL van de app, neem hem dan over als
  queryparameter, anders krijg je een andere mandant of een 401.
- **Paginering.** SAP levert doorgaans 100–1000 rijen per verzoek; `$top` en
  `$skip` doorlopen tot je minder terugkrijgt dan je vroeg.
- **OData v2 of v4.** v2 zet de rijen in `d.results`, v4 in `value`. `ish-tap`
  vangt beide af.
- **Filteren kan aan de bron**, bijvoorbeeld `$filter=Status eq 'X'`. Zinvol
  zodra we weten hoe de velden heten.

## 5. Proof of concept

Twee scripts, allebei alleen-lezen. `ish-tap` is de route die je gebruikt.

### `ish-tap` — meeluisteren met wat de app zelf ophaalt

Vraagt niets zelf op, maar haakt in op de verzoeken die de InstandhoudingsApp
toch al doet. Daardoor krijg je precies wat de app opvraagt, mét de filters die
erin zitten — je hoeft niet te weten hoe de entiteitensets heten of hoe de app
filtert. Er verandert niets aan de app: het draait in jouw tabblad en leest
alleen mee.

Twee vormen, uit dezelfde kern (`ish-tap.core.js`, herbouwen met
`node tools/ish-koppeling/maak-bookmarklet.js`):

**Userscript — `ish-tap.user.js`** (aanbevolen, mits Tampermonkey of
Violentmonkey mag van IT). Installeren, en dan **de regel `@match` aanpassen**
naar de hostnaam uit je adresbalk; zolang daar `VUL-HOSTNAAM-IN` staat doet het
script niets. Het luistert dan mee vanaf het moment dat de pagina laadt, dus
ook naar de allereerste lading gegevens.

**Bookmarklet — `ish-tap-bookmarklet.txt`**. Nieuwe bladwijzer, de regel die met
`javascript:` begint als URL plakken. Werkt zonder dat je iets hoeft te
installeren, maar met één beperking die in de aard van een bookmarklet zit: hij
gaat pas meeluisteren op het moment dat je hem aanklikt. **Ververs daarna dus de
lijst in de app** (of blader naar een ander overzicht), anders vangt hij niets
op — de gegevens waren immers al binnen.

Beide tonen rechtsonder een klein paneel met wat er is opgevangen en drie
knoppen: Download JSON, Kopieer en Wis. Het paneel zit in een shadow DOM, dus de
opmaak van de app en die van het paneel raken elkaar niet.

Doet de bookmarklet niets, dan blokkeert het beveiligingsbeleid van de pagina
waarschijnlijk `javascript:`-bladwijzers. Plak de inhoud van `ish-tap.core.js`
dan in de console, of gebruik het userscript.



### `cors-test.js` — de meting

Draaien **op je dashboard** (`file://`). Het probeert de service drie keer aan
te roepen — zonder cookies, met cookies, en in `no-cors` — en zet in een tabel
wat er gebeurt. Daarmee weet je zeker of het bovenstaande in jouw omgeving ook
echt zo uitpakt, in plaats van dat je het van mij aanneemt.

### Wat er getest is

`ish-tap` is gedraaid tegen een nagebouwde SAPUI5-achtige app die op drie
manieren ophaalt: via `fetch`, via `XMLHttpRequest` en via een `$batch`-POST.
Alle vier de antwoorden werden opgevangen (16 rijen), de twee antwoorden in de
batch werden uit het multipart-bericht gepeuterd, en de app bleef gewoon zijn
eigen antwoorden lezen. Ook getest: een herhaald verzoek vervangt het vorige in
plaats van te stapelen, wissen werkt, en de bookmarklet-variant vangt na één
keer verversen alsnog alles op.

Twee dingen kwamen daarbij aan het licht die zonder die proef fout waren
gebleven. Een `$batch`-**antwoord** bevat de URL's van de deelverzoeken niet —
die staan alleen in het verzoek — dus die worden nu uit de verzoekinhoud
gelezen en op volgorde gekoppeld. En een URL met een spatie erin (een `$filter`
als `Status eq 'In onderzoek'`) brak die koppeling eerst, waardoor een lijst het
label van een ándere lijst kreeg. Er zit nu een grendel op: klopt het aantal
verzoeken niet met het aantal antwoorden, dan blijft een deel liever naamloos
dan verkeerd benoemd.

Ook nagespeeld: een launchpad met de app in een iframe. Een bookmarklet draait
normaal alleen in het venster waar je hem aanklikt en zou daar niets opvangen;
de installatie geeft zichzelf nu door aan frames van dezelfde herkomst, en ving
in die opstelling alle vier de antwoorden op in het iframe.

## Waarom alleen meeluisteren, en niet zelf opvragen

Er heeft hier een tweede script gestaan (`ish-export.js`) dat de OData-dienst
zelf bevroeg: servicedocument, `$metadata`, en daarna alle entiteitensets met
paginering. Het werkte, maar het is weggehaald.

De reden is niet technisch maar bestuurlijk. Zelf verzoeken versturen naar een
bedrijfssysteem is "geautomatiseerde toegang", en dat is een gesprek met
security dat je niet hoeft te voeren. Meeluisteren voegt nul verzoeken toe: de
belasting op SAP is exact gelijk aan gewoon gebruik van de app. Dat is veel
makkelijker te verantwoorden, en `ish-tap` levert dezelfde gegevens.

De uitleg in hoofdstuk 4 blijft staan als naslag — mocht het ooit nodig zijn,
dan staat er hoe het zou moeten. De code is uit de map, zodat niemand hem per
ongeluk gebruikt.

## Wat er daarna nog moet gebeuren

Het inlezen aan de dashboardkant kan ik pas bouwen als ik weet hoe de velden
heten. Draai `ish-tap`, download het bestand, en stuur me:

- de lijst met entiteitensets en veldnamen die het script logt, en
- **één** record, met de plaats-, straat- en persoonsgegevens erin veranderd.

Dan bouw ik de omzetting naar het bestaande storingsmodel (type, plaats, adres,
order, asset, dagen, uitvoeringsdatum, gebiedscode, status, WV'er) en een
importknop naast het plakvak. Het plakken blijft gewoon bestaan als terugval —
gaat er iets mis aan de SAP-kant, dan werk je door zoals nu.

## Nog even dit

Het gaat om jouw eigen sessie, jouw eigen rechten en uitsluitend lezen: het
script doet precies wat de app zelf al doet, alleen sla je het knippen en
plakken over. Techniek is echter niet hetzelfde als toestemming. Stem even af
met je IT- of security-contactpersoon of geautomatiseerd bevragen van deze
service is toegestaan voordat je het structureel gaat gebruiken, en houd het
opgehaalde bestand binnen Alliander.
