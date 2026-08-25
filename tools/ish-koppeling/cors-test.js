/* ===================================================================
   CORS-meting — controleert wat er gebeurt als het dashboard zélf
   probeert de OData-service aan te roepen.

   WAAR DRAAI JE DIT?
   Op je dashboard (de file://-pagina). F12 → Console → plakken → Enter.
   Je hebt de volledige URL van de service nodig, dus inclusief
   https://<hostnaam>/UVAGateway/… — die zie je in de adresbalk van de
   InstandhoudingsApp.

   WAT MEET HET?
   Drie dingen, want ze falen elk om een andere reden:
     1. zonder cookies  — zegt of de server CORS überhaupt toestaat;
     2. met cookies     — zegt of je sessie meegaat;
     3. no-cors         — bewijst dat het verzoek de deur wel uit gaat,
                          maar dat je het antwoord niet mag lezen.
   Er wordt alleen gelezen (GET); er verandert niets.
   =================================================================== */

(async () => {
  'use strict';

  const url = window.prompt(
    'Volledige URL van de OData-service (inclusief https:// en hostnaam):',
    'https://VUL-HOSTNAAM-IN/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/?$format=json'
  );
  if (!url) { console.log('Afgebroken.'); return; }

  console.log('%cHerkomst van deze pagina (origin):', 'font-weight:bold', window.origin,
    window.origin === 'null' ? '— een file://-pagina heeft geen echte herkomst, dus élk verzoek is cross-origin.' : '');

  const proef = async (naam, opties) => {
    const start = performance.now();
    try {
      const res = await fetch(url, Object.assign({ method: 'GET' }, opties));
      const ms = Math.round(performance.now() - start);
      const uitkomst = {
        proef: naam,
        resultaat: res.type === 'opaque' ? 'verstuurd, maar antwoord niet leesbaar (opaque)' : `HTTP ${res.status}`,
        type: res.type,
        ms,
      };
      if (res.type !== 'opaque') {
        try {
          const tekst = await res.text();
          uitkomst.eersteTekens = tekst.slice(0, 120);
          uitkomst.lengte = tekst.length;
        } catch (e) { uitkomst.leesfout = e.message; }
      }
      return uitkomst;
    } catch (e) {
      return {
        proef: naam,
        resultaat: 'GEBLOKKEERD',
        fout: e.message,
        ms: Math.round(performance.now() - start),
      };
    }
  };

  const uitkomsten = [];
  uitkomsten.push(await proef('1. zonder cookies (mode: cors)', { credentials: 'omit', headers: { Accept: 'application/json' } }));
  uitkomsten.push(await proef('2. met cookies (credentials: include)', { credentials: 'include', headers: { Accept: 'application/json' } }));
  uitkomsten.push(await proef('3. mode: no-cors', { mode: 'no-cors', credentials: 'include' }));

  console.table(uitkomsten);
  console.log('%cHoe lees je dit?', 'font-weight:bold');
  console.log([
    '• Proef 1 en 2 GEBLOKKEERD  → de server stuurt geen CORS-headers. Dit is de verwachte uitkomst;',
    '  rechtstreeks ophalen vanuit het dashboard kan dan niet. Gebruik ish-export.js op de app zelf.',
    '• Proef 1 werkt, 2 niet      → CORS staat open maar zonder je sessie krijg je geen gegevens.',
    '  Dan levert het nog niets op: de service geeft alleen data aan een ingelogde gebruiker.',
    '• Proef 1 en 2 werken beide  → bijzonder: dan kan het dashboard er rechtstreeks bij.',
    '  Stuur de uitkomst door, dan bouw ik de koppeling in.',
    '• Proef 3 lukt altijd, en zegt niets: het verzoek gaat de deur uit maar je mag het antwoord',
    '  niet inzien. Daar kun je geen gegevens uit halen.',
  ].join('\n'));

  window.__CORS_TEST__ = uitkomsten;
})();
