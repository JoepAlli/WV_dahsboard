# Tests

Playwright-tests die het dashboard in een echte browser openen, data plakken en
de getallen narekenen. Ze horen in de repo en niet in een tijdelijke map: een
eerdere suite stond buiten de repo en is verloren gegaan bij het opschonen van
de werkmap.

Draaien:

    NODE_PATH=/opt/node22/lib/node_modules node tests/<bestand>.js

Chromium staat op `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Elke
test opent `file:///home/user/WV_dahsboard/index.html`, werkt met een eigen
IndexedDB en sluit af met `ALLES GOED` of het aantal mislukte controles.

| Bestand | Wat het bewaakt |
|---|---|
| `smoke.js` | Elk tabblad tekent zonder fouten, met data erin |
| `maand_tempo.js` | Instroom per maand en de betrouwbaarheid van het benodigd tempo |
| `tempo_twee_tekorten.js` | Dat de gemeten achterstand en het tekort op capaciteit als twee verschillende dingen worden gepresenteerd |
| `zelfde_adres_en_ritlijst.js` | De melding bij meerdere orders op één adres, en de printklare ritlijst |
| `boxplot_staart.js` | Dat de staart-conclusie boven de boxplot de juiste status kiest en zwijgt bij te weinig of vlakke metingen |
| `blokkade_uitsluiten.js` | Dat geblokkeerde storingen buiten de gemeten doorlooptijd blijven, dat weggelaten metingen gemeld worden, en dat de periodekaart ook blokkades meeneemt die inmiddels zijn opgeheven |
| `liggenblijvers.js` | Dat voorbijgestreefde storingen, de lichtingen per instroommaand en de wachtrij-discipline kloppen — inclusief gelijke instroomdatums, waar een mediaanvergelijking de mist in gaat |
