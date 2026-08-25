/* ===================================================================
   ISH-export — haalt de NUS-gegevens rechtstreeks uit de OData-service
   van de InstandhoudingsApp, in jouw eigen ingelogde sessie.

   WAAR DRAAI JE DIT?
   Op de pagina van de InstandhoudingsApp zelf. Open die pagina, druk op
   F12 (DevTools), ga naar het tabblad "Console", plak dit hele bestand en
   druk op Enter.

   WAAROM DAAR EN NIET IN HET DASHBOARD?
   Omdat het script daar in dezelfde herkomst (origin) draait als de app:
   de sessiecookies gaan automatisch mee en er komt geen CORS aan te pas.
   Vanuit een file://-pagina lukt dat niet — zie README.md.

   WAT DOET HET WEL EN NIET?
   Alleen GET-verzoeken, dus uitsluitend lezen; er wordt niets gewijzigd
   en niets verstuurd. Het resultaat blijft in je browser en komt als
   JSON-bestand in je Downloads terecht.
   =================================================================== */

(async () => {
  'use strict';

  const BASE = '/UVAGateway/sap/opu/odata/sap/ZPM_UITVOERDER_APP_SRV/';
  const MAX_PER_SET = 5000;   // veiligheidsgrens per entiteitenset
  const PAGINA = 500;         // SAP levert zelden meer dan dit in één keer

  // De sap-client staat vaak in de URL van de app; zonder de juiste client
  // krijg je gegevens uit een ander mandantnummer of een 401.
  const sapClient = new URLSearchParams(location.search).get('sap-client');
  const metClient = (url) => sapClient ? url + (url.includes('?') ? '&' : '?') + 'sap-client=' + sapClient : url;

  const diagnose = [];
  const log = (...a) => console.log('%c[ISH]', 'color:#64902F;font-weight:bold', ...a);

  async function haal(pad, alsTekst) {
    const url = metClient(BASE.replace(/\/$/, '/') + pad);
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        // same-origin is genoeg én veiliger dan 'include': we draaien immers
        // op de app zelf, dus de cookies horen bij deze herkomst.
        credentials: 'same-origin',
        headers: { 'Accept': alsTekst ? 'application/xml,text/xml,*/*' : 'application/json' },
      });
    } catch (e) {
      diagnose.push({ url, fout: 'netwerk/CORS: ' + e.message });
      throw new Error(`Verzoek mislukt (${url}): ${e.message}`);
    }
    diagnose.push({ url, status: res.status, contentType: res.headers.get('content-type') || '' });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Niet ingelogd of geen rechten (HTTP ${res.status}). Ververs eerst de InstandhoudingsApp en probeer opnieuw.`);
    }
    if (res.status === 404) {
      throw new Error(`Niet gevonden (HTTP 404) op ${url} — klopt het servicepad in BASE bovenaan dit bestand?`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} op ${url}`);
    return alsTekst ? res.text() : res.json();
  }

  // OData v2 zet de rijen in d.results, v4 in value. Beide afvangen, zodat
  // dit script niet afhangt van de versie die SAP hier draait.
  const rijenUit = (json) => {
    if (!json) return [];
    if (Array.isArray(json.value)) return json.value;                 // v4
    if (json.d && Array.isArray(json.d.results)) return json.d.results; // v2
    if (json.d && !Array.isArray(json.d)) return [json.d];             // v2, enkel record
    return [];
  };

  /* --- 1. Servicedocument: welke entiteitensets zijn er? ----------------
     Het servicedocument heeft een eigen vorm, anders dan die van de
     gegevens: v2 geeft { d: { EntitySets: ["NusSet", …] } }, v4 geeft
     { value: [{ name: "NusSet", … }] }. */
  log('Servicedocument ophalen…');
  const service = await haal('?$format=json');
  const sets = (service && service.d && Array.isArray(service.d.EntitySets))
    ? service.d.EntitySets.slice()
    : rijenUit(service).map(e => e.name || e.url || e.title).filter(Boolean);
  if (sets.length === 0) {
    console.warn('[ISH] Geen entiteitensets in het servicedocument gevonden. Ruwe inhoud:', service);
  }
  log('Gevonden entiteitensets:', sets);

  /* --- 2. Metadata: welke velden zitten er in? ------------------------- */
  let velden = {};
  try {
    log('$metadata ophalen…');
    const xml = await haal('$metadata', true);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const typen = {};
    doc.querySelectorAll('EntityType').forEach(t => {
      typen[t.getAttribute('Name')] = Array.from(t.querySelectorAll('Property'))
        .map(p => ({ naam: p.getAttribute('Name'), type: p.getAttribute('Type') }));
    });
    doc.querySelectorAll('EntitySet').forEach(es => {
      const naam = es.getAttribute('Name');
      const typeNaam = (es.getAttribute('EntityType') || '').split('.').pop();
      if (typen[typeNaam]) velden[naam] = typen[typeNaam];
    });
    log('Velden per set:', Object.fromEntries(Object.entries(velden).map(([k, v]) => [k, v.map(p => p.naam).join(', ')])));
  } catch (e) {
    console.warn('[ISH] $metadata lukte niet:', e.message, '— we gaan door zonder veldenlijst.');
  }

  /* --- 3. De gegevens zelf, met paginering ----------------------------- */
  const data = {};
  for (const set of sets) {
    const rijen = [];
    try {
      for (let skip = 0; skip < MAX_PER_SET; skip += PAGINA) {
        const json = await haal(`${set}?$format=json&$top=${PAGINA}&$skip=${skip}`);
        const deel = rijenUit(json) || [];
        rijen.push(...deel);
        if (deel.length < PAGINA) break;
      }
      data[set] = rijen;
      log(`${set}: ${rijen.length} rijen`);
    } catch (e) {
      data[set] = { fout: e.message };
      console.warn(`[ISH] ${set} overgeslagen:`, e.message);
    }
  }

  /* --- 4. Resultaat wegschrijven --------------------------------------- */
  const resultaat = {
    opgehaaldOp: new Date().toISOString(),
    service: BASE,
    sapClient,
    entiteitensets: sets,
    velden,
    diagnose,
    data,
  };

  // Ook op window, zodat je in de console kunt rondkijken zonder het
  // bestand te openen: rechtermuisknop op het object → "Copy object".
  window.__ISH_EXPORT__ = resultaat;

  const blob = new Blob([JSON.stringify(resultaat, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ish-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);

  const totaal = Object.values(data).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  log(`Klaar: ${totaal} rijen uit ${sets.length} sets. Het bestand staat in je Downloads, en het object staat op window.__ISH_EXPORT__.`);
  console.table(diagnose);
})().catch(e => console.error('[ISH] Gestopt:', e.message));
