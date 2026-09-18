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
