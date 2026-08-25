/* ===================================================================
   ISH-tap — luistert mee met de gegevens die de InstandhoudingsApp zelf
   ophaalt, en zet ze klaar als JSON-bestand.

   Anders dan ish-export.js vraagt dit script niets zelf op: het haakt in
   op de verzoeken die de app toch al doet. Voordeel is dat je precies
   krijgt wat de app opvraagt, inclusief de filters die erin zitten — je
   hoeft dus niet te weten hoe de entiteitensets heten of hoe er gefilterd
   wordt.

   Er verandert niets aan de InstandhoudingsApp: het draait alleen in jouw
   browser, in jouw tabblad, en leest alleen mee. Verzoeken worden niet
   aangepast, niet tegengehouden en niet herhaald.

   Waarom zowel fetch als XMLHttpRequest, en waarom multipart:
   SAPUI5 gebruikt voor OData v2 doorgaans XMLHttpRequest, niet fetch, en
   bundelt meerdere verzoeken in één POST naar $batch. Het antwoord daarop
   is multipart/mixed met de losse JSON-antwoorden erin. Luister je alleen
   naar fetch, of parse je alleen JSON, dan vang je precies niets op.
   =================================================================== */

(function () {
  'use strict';

  // Alleen verzoeken naar deze dienst worden opgevangen. Ruim genomen: het
  // gatewaypad én de servicenaam, zodat het ook werkt als de app via een
  // ander pad naar dezelfde dienst gaat.
  const PATROON = /ZPM_UITVOERDER_APP_SRV|\/UVAGateway\//i;

  if (window.__ISH_TAP__) { window.__ISH_TAP__.toon(); return; }

  /** Opgevangen antwoorden, op URL zodat een herhaald verzoek de vorige
   *  vervangt in plaats van het bestand te laten opzwellen. */
  const opgevangen = new Map();

  const rijenUit = (json) => {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json.value)) return json.value;                   // OData v4
    if (json.d && Array.isArray(json.d.results)) return json.d.results; // OData v2
    if (json.d && typeof json.d === 'object') return [json.d];          // v2, één record
    return [];
  };

  // Uit een stuk tekst het eerste complete JSON-object vissen. Bewust
  // grofmazig: in een multipart-deel staan koppen, een lege regel en dan
  // pas de inhoud, en die koppen verschillen per systeem.
  function pakJson(tekst) {
    const van = tekst.indexOf('{');
    const tot = tekst.lastIndexOf('}');
    if (van === -1 || tot <= van) return null;
    try { return JSON.parse(tekst.slice(van, tot + 1)); } catch (e) { return null; }
  }

  // De URL's van de deelverzoeken staan NIET in het antwoord — alleen in het
  // verzoek dat de app verstuurde. Zonder die URL's weet je van een batchdeel
  // niet om welke lijst het gaat, dus lezen we ze uit de verzoekinhoud en
  // koppelen we ze op volgorde aan de antwoorddelen. Dat is precies hoe een
  // OData-client het zelf ook doet.
  function verzoekUrls(verzoekBody) {
    if (!verzoekBody || typeof verzoekBody !== 'string') return [];
    const uit = [];
    // Niet \S+ maar de hele rest van de regel: een $filter bevat spaties
    // ("Status eq 'In onderzoek'"), en daar liep de herkenning eerder op stuk.
    const re = /^\s*(GET|POST|PUT|MERGE|PATCH|DELETE)\s+(.+)$/gm;
    let m;
    while ((m = re.exec(verzoekBody)) !== null) {
      uit.push(m[2].trim().replace(/\s+HTTP\/[\d.]+$/i, ''));
    }
    return uit;
  }

  // Een multipart/mixed-antwoord ($batch) uit elkaar halen. Elk deel bevat een
  // eigen HTTP-antwoord.
  function splitsBatch(tekst, contentType, verzoekBody) {
    const m = /boundary=("?)([^";,\s]+)\1/i.exec(contentType || '');
    const delen = m ? tekst.split('--' + m[2]) : tekst.split(/^--[\w.-]+$/m);
    const uit = [];
    delen.forEach(deel => {
      if (!deel || /^--\s*$/.test(deel.trim())) return;
      const json = pakJson(deel);
      if (!json) return;
      // Sommige systemen echoën de verzoekregel wél in het antwoord.
      const echo = /^\s*(GET|POST|PUT|MERGE|DELETE)\s+(.+)$/m.exec(deel);
      uit.push({ verzoek: echo ? echo[2].trim().replace(/\s+HTTP\/[\d.]+$/i, '') : null, json });
    });

    // Koppelen op volgorde mag alleen als er precies evenveel verzoeken als
    // antwoorden zijn. Klopt dat aantal niet — bijvoorbeeld door een changeset
    // of een deel dat geen JSON bevat — dan liever geen naam dan de verkeerde
    // naam: een lijst met het label van een ándere lijst is erger dan een
    // lijst zonder label.
    const urls = verzoekUrls(verzoekBody);
    if (urls.length === uit.length) {
      uit.forEach((d, i) => { if (!d.verzoek) d.verzoek = urls[i]; });
    }
    return uit;
  }

  function bewaar(url, sleutel, json, viaBatch) {
    const rijen = rijenUit(json);
    opgevangen.set(sleutel, {
      url: sleutel,
      viaBatch: !!viaBatch,
      opgevangenOm: new Date().toISOString(),
      aantalRijen: rijen.length,
      json,
    });
    tekenPaneel();
  }

  function verwerk(url, contentType, tekst, verzoekBody) {
    if (!tekst) return;
    try {
      if (/multipart\/mixed/i.test(contentType || '') || /^--/.test(tekst.trim())) {
        const delen = splitsBatch(tekst, contentType, verzoekBody);
        if (delen.length === 0) return;
        delen.forEach((d, i) => {
          // De sleutel is het verzoek uit het batchdeel; valt dat niet af te
          // lezen, dan de batch-URL met een volgnummer.
          bewaar(url, d.verzoek || `${url}#deel${i + 1}`, d.json, true);
        });
        return;
      }
      const json = pakJson(tekst);
      if (json) bewaar(url, url, json, false);
    } catch (e) {
      console.warn('[ISH-tap] kon een antwoord niet verwerken:', e.message);
    }
  }

  /* ---------- Meeluisteren op fetch ---------- */

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const belofte = origFetch.apply(this, arguments);
      if (!PATROON.test(url)) return belofte;
      // De verzoekinhoud is nodig om batchdelen te kunnen benoemen. Bij een
      // Request-object moet dat via een kloon, anders leest de app straks een
      // al opgebruikte stroom.
      let verzoekBody = (init && typeof init.body === 'string') ? Promise.resolve(init.body) : null;
      if (!verzoekBody && input && typeof input === 'object' && typeof input.clone === 'function') {
        try { verzoekBody = input.clone().text().catch(() => ''); } catch (e) { verzoekBody = null; }
      }
      return belofte.then(res => {
        // Een antwoord kan maar één keer gelezen worden; met clone() laten
        // we het origineel ongemoeid voor de app zelf.
        try {
          Promise.all([res.clone().text(), verzoekBody || Promise.resolve('')])
            .then(([t, vb]) => verwerk(url, res.headers.get('content-type') || '', t, vb))
            .catch(() => {});
        } catch (e) { /* niets: de app gaat voor */ }
        return res;
      });
    };
  }

  /* ---------- Meeluisteren op XMLHttpRequest ---------- */

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (methode, url) {
    this.__ishUrl = String(url || '');
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.__ishBody = (typeof body === 'string') ? body : null;
    if (PATROON.test(this.__ishUrl || '')) {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          let tekst = '';
          // responseText werpt een fout bij responseType blob/arraybuffer;
          // vandaar deze volgorde en de try eromheen.
          if (this.responseType === 'json') tekst = JSON.stringify(this.response);
          else if (!this.responseType || this.responseType === 'text') tekst = this.responseText;
          if (tekst) verwerk(this.__ishUrl, ct, tekst, this.__ishBody);
        } catch (e) { /* stil: meeluisteren mag de app nooit hinderen */ }
      });
    }
    return origSend.apply(this, arguments);
  };

  /* ---------- Bestand samenstellen ---------- */

  function bouwBestand() {
    return {
      opgehaaldOp: new Date().toISOString(),
      pagina: location.href,
      hoeveel: opgevangen.size,
      totaalRijen: Array.from(opgevangen.values()).reduce((n, v) => n + v.aantalRijen, 0),
      antwoorden: Array.from(opgevangen.values()),
    };
  }

  function download() {
    const bestand = bouwBestand();
    window.__ISH_DATA__ = bestand;
    const tekst = JSON.stringify(bestand, null, 2);
    try {
      const blob = new Blob([tekst], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ish-tap-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      melding(`Bestand met ${bestand.totaalRijen} rijen gedownload.`);
    } catch (e) {
      // Sommige omgevingen blokkeren blob-downloads via het beveiligingsbeleid
      // van de pagina. Dan is het klembord de uitweg.
      console.log('[ISH-tap] download geblokkeerd, gebruik window.__ISH_DATA__ of de kopieerknop:', e.message);
      melding('Download geblokkeerd — gebruik "Kopieer".');
    }
  }

  function kopieer() {
    const tekst = JSON.stringify(bouwBestand(), null, 2);
    window.__ISH_DATA__ = bouwBestand();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tekst)
        .then(() => melding('Naar klembord gekopieerd.'))
        .catch(() => melding('Klembord geweigerd — zie window.__ISH_DATA__.'));
    } else {
      melding('Geen klembordtoegang — zie window.__ISH_DATA__.');
    }
  }

  /* ---------- Klein bedieningspaneel ----------
     In een shadow DOM, zodat de opmaak van de InstandhoudingsApp er niet
     doorheen komt en die van ons er niet in lekt. */

  let gastheer = null, wortel = null, meldingEl = null;
  // Onthouden of jij hem hebt weggeklikt, zodat een herbouw hem niet ongevraagd
  // terugzet.
  let verborgen = false;

  // De opmaak wordt met "important" gezet en bij elke tekenbeurt opnieuw
  // opgelegd. Reden: een SAPUI5-thema heeft opmaakregels die vreemde elementen
  // in de body kunnen verbergen, en dan zie je het paneel even oplichten en
  // meteen weer verdwijnen.
  function zetStijl() {
    if (!gastheer) return;
    [['position', 'fixed'], ['right', '16px'], ['bottom', '16px'], ['z-index', '2147483647'],
     ['display', verborgen ? 'none' : 'block'], ['visibility', 'visible'], ['opacity', '1'],
     ['width', 'auto'], ['height', 'auto'], ['max-width', 'none'], ['max-height', 'none'],
     ['margin', '0'], ['padding', '0'], ['transform', 'none'], ['clip-path', 'none'],
     ['pointer-events', 'auto']].forEach(([k, v]) => gastheer.style.setProperty(k, v, 'important'));
  }

  function maakPaneel() {
    gastheer = document.createElement('div');
    gastheer.id = '__ish_tap_paneel';
    wortel = gastheer.attachShadow({ mode: 'open' });
    wortel.innerHTML = `
      <style>
        .kader { font:12px/1.45 Arial,Helvetica,sans-serif; background:#1a1a19; color:#f2f2f2;
                 border:1px solid #4C6E23; border-radius:10px; width:330px; box-shadow:0 6px 24px rgba(0,0,0,.35); }
        .kop { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid #333; }
        .kop b { flex:1; font-size:12.5px; }
        .sluit { cursor:pointer; background:none; border:none; color:#b9b9b4; font-size:15px; line-height:1; }
        .lijst { max-height:190px; overflow:auto; padding:6px 12px; }
        .rij { display:flex; gap:8px; padding:3px 0; border-bottom:1px solid #262625; }
        .rij:last-child { border-bottom:none; }
        .naam { flex:1; word-break:break-all; color:#d8d8d4; }
        .n { color:#9BC96A; font-weight:bold; white-space:nowrap; }
        .leeg { padding:10px 12px; color:#b9b9b4; }
        .knoppen { display:flex; gap:6px; padding:9px 12px; border-top:1px solid #333; }
        button.k { flex:1; cursor:pointer; background:#4C6E23; color:#fff; border:none;
                   border-radius:6px; padding:6px 8px; font-weight:bold; font-size:12px; }
        button.k.grijs { background:#333; color:#d8d8d4; }
        .melding { padding:0 12px 9px; color:#9BC96A; min-height:14px; }
      </style>
      <div class="kader">
        <div class="kop"><b>ISH-tap</b><span class="n" id="tel">0</span>
          <button class="sluit" title="Verbergen">&times;</button></div>
        <div class="lijst" id="lijst"></div>
        <div class="knoppen">
          <button class="k" id="dl">Download JSON</button>
          <button class="k grijs" id="kop">Kopieer</button>
          <button class="k grijs" id="wis">Wis</button>
        </div>
        <div class="melding" id="melding"></div>
      </div>`;
    // Bewust aan <html> hangen en niet aan <body>: een app die zijn body
    // opnieuw opbouwt neemt alles wat erin staat mee, en dan is het paneel weg.
    document.documentElement.appendChild(gastheer);
    zetStijl();
    meldingEl = wortel.getElementById('melding');
    wortel.querySelector('.sluit').addEventListener('click', () => { verborgen = true; zetStijl(); });
    wortel.getElementById('dl').addEventListener('click', download);
    wortel.getElementById('kop').addEventListener('click', kopieer);
    wortel.getElementById('wis').addEventListener('click', () => { opgevangen.clear(); melding('Gewist.'); tekenPaneel(); });
  }

  function melding(t) { if (meldingEl) meldingEl.textContent = t; }

  // Het paneel moet tegen een app kunnen die zijn pagina opnieuw opbouwt.
  // SAPUI5 doet dat tijdens het opstarten, en dan gebeurt er iets vervelends:
  // wordt de body via innerHTML herbouwd, dan komt ons <div> wel terug in de
  // opmaak, maar de shadow DOM eronder niet — je houdt een lege huls over die
  // nergens meer op reageert. Vandaar dat hier niet alleen op "bestaat het nog"
  // wordt gekeken, maar ook of het nog een schaduwwortel heeft.
  function paneelOk() {
    return gastheer && gastheer.isConnected && gastheer.shadowRoot === wortel && wortel;
  }

  function tekenPaneel() {
    if (!document.body) return;              // nog te vroeg in de paginaopbouw
    if (!paneelOk()) {
      // Een achtergebleven huls van een eerdere opbouw eerst opruimen, anders
      // staan er straks twee elementen met dezelfde id.
      const huls = document.getElementById('__ish_tap_paneel');
      if (huls && huls !== gastheer) huls.remove();
      maakPaneel();
    } else {
      zetStijl();
    }
    const lijst = wortel.getElementById('lijst');
    const items = Array.from(opgevangen.values());
    wortel.getElementById('tel').textContent = items.reduce((n, v) => n + v.aantalRijen, 0) + ' rijen';
    lijst.innerHTML = items.length === 0
      ? '<div class="leeg">Nog niets opgevangen. Ververs de lijst in de app, of blader naar een ander overzicht.</div>'
      : items.map(v => {
          const kort = v.url.length > 58 ? '…' + v.url.slice(-57) : v.url;
          return `<div class="rij"><span class="naam">${kort.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</span><span class="n">${v.aantalRijen}</span></div>`;
        }).join('');
  }

  window.__ISH_TAP__ = {
    opgevangen,
    bestand: bouwBestand,
    download,
    toon: () => { verborgen = false; tekenPaneel(); zetStijl(); },
    // Voor als het paneel om welke reden dan ook onbereikbaar blijft.
    waarom: () => {
      const el = document.getElementById('__ish_tap_paneel');
      const r = el && el.getBoundingClientRect();
      return {
        inIframe: window.top !== window.self,
        paneelInDePagina: !!el,
        heeftSchaduw: !!(el && el.shadowRoot),
        afmeting: r ? Math.round(r.width) + 'x' + Math.round(r.height) : 'geen',
        zichtbaarheid: el ? getComputedStyle(el).display + '/' + getComputedStyle(el).visibility : 'geen',
        opgevangen: opgevangen.size,
        weggeklikt: verborgen,
      };
    },
  };

  // Het paneel kan pas als er een body is; bij @run-at document-start is die
  // er nog niet.
  if (document.body) tekenPaneel();
  else document.addEventListener('DOMContentLoaded', tekenPaneel);
  window.addEventListener('load', tekenPaneel);

  // Een app kan zijn pagina op elk moment opnieuw opbouwen, ook zonder dat er
  // gegevens binnenkomen. Een tijdklok alleen is te traag: dan sta je seconden
  // naar een lege huls te kijken. Daarom een waarnemer die meteen reageert,
  // met de klok als vangnet voor het geval de waarnemer iets mist.
  let herstelGepland = false;
  const herstelSnel = () => {
    if (herstelGepland || verborgen) return;
    herstelGepland = true;
    requestAnimationFrame(() => {
      herstelGepland = false;
      if (!paneelOk()) tekenPaneel();
    });
  };
  try {
    new MutationObserver(herstelSnel).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* dan doet de klok hieronder het werk */ }
  setInterval(() => { if (!verborgen) tekenPaneel(); }, 5000);

  // Twee noodgrepen die geen enkel element nodig hebben, voor het geval de app
  // het paneel hardnekkig blijft wegdrukken:
  //   Alt+Shift+T  paneel terughalen
  //   Alt+Shift+D  meteen downloaden, ook zonder paneel
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    const t = String(e.key || '').toLowerCase();
    if (t === 't') { e.preventDefault(); window.__ISH_TAP__.toon(); }
    else if (t === 'd') { e.preventDefault(); download(); }
  }, true);

  console.log('%c[ISH-tap] luistert mee', 'color:#9BC96A;font-weight:bold',
    '— ververs de lijst in de app om gegevens op te vangen.');
})();
