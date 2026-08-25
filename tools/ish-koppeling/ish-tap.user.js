// ==UserScript==
// @name         ISH-tap — NUS-gegevens uit de InstandhoudingsApp
// @namespace    nus-dashboard
// @version      1.0.0
// @description  Vangt de OData-antwoorden op die de InstandhoudingsApp zelf ophaalt en zet ze klaar als JSON-bestand. Leest alleen mee; verandert niets aan de app.
// @author       NUS-dashboard
// @run-at       document-start
// @grant        none
//
// LET OP: pas de regel hieronder aan naar de hostnaam van de
// InstandhoudingsApp, zoals die in je adresbalk staat. Zolang daar
// VUL-HOSTNAAM-IN staat doet het script niets.
// @match        *://VUL-HOSTNAAM-IN/*
// ==/UserScript==

// @run-at document-start zorgt dat er wordt meegeluisterd vóórdat de app zijn
// eerste gegevens ophaalt. @grant none is nodig: alleen dan draait dit in de
// pagina zelf en kan het meeluisteren met fetch/XMLHttpRequest van de app.

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

// Als benoemde functie, niet als naamloze haakjesconstructie: alleen zo kan
// de code van zichzelf de brontekst opvragen, en die is nodig om ook in
// iframes te kunnen meeluisteren (zie onderaan).
function ishTapInstalleer() {
  'use strict';

  // Alleen verzoeken naar deze dienst worden opgevangen. Ruim genomen: het
  // gatewaypad én de servicenaam, zodat het ook werkt als de app via een
  // ander pad naar dezelfde dienst gaat.
  const PATROON = /ZPM_UITVOERDER_APP_SRV|\/UVAGateway\//i;

  if (window.__ISH_TAP__) { window.__ISH_TAP__.toon(); return; }

  /** Opgevangen antwoorden, op URL zodat een herhaald verzoek de vorige
   *  vervangt in plaats van het bestand te laten opzwellen. */
  const opgevangen = new Map();

  /** Élk verzoek dat langskomt, ook de niet-passende: alleen de URL, de
   *  statuscode en het soort antwoord — nooit de inhoud. Zonder dit weet je
   *  bij een lege vangst niet of er niets langskwam of dat het filter niet
   *  klopt, en dat verschil bepaalt wat je eraan moet doen. Het gaat mee in
   *  het gedownloade bestand, zodat dat bestand zichzelf verklaart. */
  const gezien = [];
  function noteer(url, extra) {
    if (!url) return;
    const kort = String(url).slice(0, 300);
    if (extra) {
      // De afloop hoort bij het verzoek dat eerder werd genoteerd. Terugzoeken
      // in plaats van alleen naar de laatste kijken: er lopen meerdere
      // verzoeken tegelijk, dus de bijbehorende regel staat zelden achteraan.
      for (let i = gezien.length - 1; i >= 0; i--) {
        if (gezien[i].url === kort && gezien[i].status === undefined) {
          Object.assign(gezien[i], extra);
          return;
        }
      }
    } else if (gezien.some(g => g.url === kort && g.status === undefined)) {
      return;   // staat al open
    }
    gezien.push(Object.assign({ url: kort, past: PATROON.test(kort) }, extra || {}));
    if (gezien.length > 80) gezien.shift();
  }

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

  /* ---------- Eén paneel voor alle vensters ----------
     Staat de app in een iframe, dan draait er een installatie in het iframe
     én in het venster eromheen — maar de gegevens komen binnen in het iframe.
     Twee panelen naast elkaar, waarvan de zichtbare op nul staat, is precies
     zo verwarrend als het klinkt. Daarom haalt het paneel de vangst uit alle
     bereikbare vensters op, en toont alleen het buitenste venster er een. */

  function alleInstanties() {
    const uit = [];
    const loop = (win) => {
      try { if (win.__ISH_TAP__) uit.push(win.__ISH_TAP__); } catch (e) { return; }
      try { for (let i = 0; i < win.frames.length; i++) loop(win.frames[i]); } catch (e) { /* ander domein */ }
    };
    let start = window;
    try { if (window.top.__ISH_TAP__ !== undefined || window.top.document) start = window.top; }
    catch (e) { start = window; }   // buitenste venster is van een ander domein
    loop(start);
    if (uit.indexOf(window.__ISH_TAP__) === -1 && window.__ISH_TAP__) uit.push(window.__ISH_TAP__);
    return uit;
  }

  // Alle vangst bij elkaar, ontdubbeld op URL.
  function alleOpgevangen() {
    const samen = new Map();
    const eigen = alleInstanties();
    if (eigen.length === 0) return new Map(opgevangen);
    eigen.forEach(inst => {
      try { inst.opgevangen.forEach((v, k) => samen.set(k, v)); } catch (e) { /* niets */ }
    });
    opgevangen.forEach((v, k) => { if (!samen.has(k)) samen.set(k, v); });
    return samen;
  }

  // Toont dit venster zelf een paneel? Alleen het buitenste, tenzij dat van een
  // ander domein is en dus niet kan.
  function magPaneelTonen() {
    if (window.top === window.self) return true;
    try { return !window.top.__ISH_TAP__; } catch (e) { return true; }
  }

  // Nieuwe vangst in een iframe moet het paneel buiten bijwerken.
  function meldAanBuiten() {
    try {
      if (window.top !== window.self && window.top.__ISH_TAP__) window.top.__ISH_TAP__.ververs();
    } catch (e) { /* ander domein: dan toont dit venster zijn eigen paneel */ }
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
    meldAanBuiten();
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
      noteer(url);
      const belofte = origFetch.apply(this, arguments);
      if (!PATROON.test(url)) {
        // Niet passend: wel de afloop noteren, maar de inhoud niet aanraken.
        belofte.then(r => noteer(url, { status: r.status, soort: (r.headers.get('content-type') || '').split(';')[0] }))
          .catch(() => {});
        return belofte;
      }
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
    noteer(this.__ishUrl);
    this.addEventListener('load', function () {
      try {
        noteer(this.__ishUrl, {
          status: this.status,
          soort: (this.getResponseHeader('content-type') || '').split(';')[0],
        });
      } catch (e) { /* niets */ }
    });
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

  /* ---------- De app zelf laten verversen ----------
     Een SAPUI5-app haalt zijn gegevens bij het opstarten op en houdt ze
     daarna vast. Klik je de bookmarklet ná het opstarten aan, dan komt er
     niets meer langs om op te vangen, en heeft meeluisteren geen zin.

     Deze knop vraagt de app om zijn gegevens opnieuw op te halen, via zijn
     eigen refresh() — dezelfde weg die de verversknop in de app bewandelt.
     Er wordt dus niets zelf opgevraagd; de app doet het verzoek. */
  function verversApp() {
    const sap = window.sap;
    if (!sap || !sap.ui || !sap.ui.getCore) return { gelukt: false, reden: 'geen SAPUI5 gevonden in dit venster' };

    const modellen = [];
    const voegToe = (m) => {
      if (m && typeof m.refresh === 'function' && modellen.indexOf(m) === -1) modellen.push(m);
    };
    try { voegToe(sap.ui.getCore().getModel()); } catch (e) { /* niets */ }
    // Modellen hangen meestal aan de component, niet aan de core.
    try {
      const reg = sap.ui.core.Component && sap.ui.core.Component.registry;
      const comps = reg ? (reg.filter ? reg.filter(() => true) : []) : [];
      comps.forEach(c => {
        try {
          voegToe(c.getModel());
          const namen = (c.oModels && Object.keys(c.oModels)) || [];
          namen.forEach(n => voegToe(c.getModel(n)));
        } catch (e) { /* niets */ }
      });
    } catch (e) { /* niets */ }

    if (modellen.length === 0) return { gelukt: false, reden: 'geen model gevonden om te verversen' };

    // Alleen een OData-model haalt bij refresh() werkelijk iets op. Een
    // JSON- of resourcemodel ververst alleen zijn eigen weergave, en dan lijkt
    // het alsof er iets gebeurt terwijl er geen verzoek uitgaat. Dat
    // onderscheid hoort in de melding te staan.
    const isOData = (m) => !!(m.sServiceUrl || typeof m.getServiceMetadata === 'function' || typeof m.read === 'function');
    const odata = modellen.filter(isOData);
    let n = 0;
    odata.forEach(m => { try { m.refresh(true); n++; } catch (e) { /* niets */ } });
    if (n > 0) return { gelukt: true, reden: `${n} van de ${modellen.length} modellen is OData en is ververst` };
    // Geen OData gevonden: dan toch maar alles proberen, en dat eerlijk melden.
    modellen.forEach(m => { try { m.refresh(true); } catch (e) { /* niets */ } });
    return { gelukt: false, reden: `geen van de ${modellen.length} modellen is een OData-model — de app haalt zijn gegevens waarschijnlijk anders op` };
  }

  // Ook in de frames proberen: daar zit de app meestal.
  function verversOveral() {
    const uitkomsten = [];
    alleInstanties().forEach(inst => {
      try { uitkomsten.push(inst.verversApp()); } catch (e) { /* niets */ }
    });
    if (uitkomsten.length === 0) uitkomsten.push(verversApp());
    const gelukt = uitkomsten.filter(u => u && u.gelukt);
    return gelukt.length > 0
      ? { gelukt: true, reden: gelukt.map(u => u.reden).join(', ') }
      : { gelukt: false, reden: (uitkomsten[0] && uitkomsten[0].reden) || 'niets gevonden' };
  }

  /* ---------- Bestand samenstellen ---------- */

  function bouwBestand() {
    const samen = alleOpgevangen();
    // Het logboek gaat altijd mee. Is de vangst leeg, dan staat hierin het
    // antwoord op de vraag waarom — anders is er een extra ronde nodig om dat
    // uit te zoeken.
    const log = [];
    alleInstanties().forEach(inst => {
      try { inst.gezien.forEach(g => log.push(g)); } catch (e) { /* niets */ }
    });
    if (log.length === 0) gezien.forEach(g => log.push(g));
    return {
      opgehaaldOp: new Date().toISOString(),
      pagina: location.href,
      hoeveel: samen.size,
      totaalRijen: Array.from(samen.values()).reduce((n, v) => n + v.aantalRijen, 0),
      filter: String(PATROON),
      verzoekenGezien: log.length,
      verzoeklog: log,
      antwoorden: Array.from(samen.values()),
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
        <div class="knoppen">
          <button class="k grijs" id="ververs">Ververs in de app</button>
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
    wortel.getElementById('ververs').addEventListener('click', () => {
      const u = verversOveral();
      melding(u.gelukt ? 'Gevraagd om te verversen — ' + u.reden : 'Lukt niet: ' + u.reden);
    });
    wortel.getElementById('wis').addEventListener('click', () => {
      alleInstanties().forEach(inst => { try { inst.opgevangen.clear(); } catch (e) { /* niets */ } });
      opgevangen.clear();
      melding('Gewist.');
      tekenPaneel();
    });
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
    if (!magPaneelTonen()) return;           // het buitenste venster toont het overzicht
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
    const items = Array.from(alleOpgevangen().values());
    wortel.getElementById('tel').textContent = items.reduce((n, v) => n + v.aantalRijen, 0) + ' rijen';
    const totaalGezien = alleInstanties().reduce((n, inst) => {
      try { return n + inst.gezien.length; } catch (e) { return n; }
    }, 0) || gezien.length;
    lijst.innerHTML = items.length === 0
      ? `<div class="leeg">Nog niets opgevangen; er ${totaalGezien === 1 ? 'kwam 1 verzoek' : 'kwamen ' + totaalGezien + ' verzoeken'} langs.
          Klik "Ververs in de app" hieronder, of ververs de lijst in de app zelf.</div>`
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
    ververs: () => { try { tekenPaneel(); } catch (e) { /* niets */ } },
    gezien,
    verversApp,
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
        verzoekenGezien: gezien.length,
        laatsteVerzoeken: gezien.slice(-8),
        opgevangenHier: opgevangen.size,
        opgevangenTotaal: alleOpgevangen().size,
        aantalVensters: alleInstanties().length,
        toontPaneel: magPaneelTonen(),
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
}

ishTapInstalleer();

/* ---------- Ook in iframes meeluisteren ----------
   Een SAPUI5-app staat vaak in een iframe binnen een launchpad, en dan doet
   dat iframe de verzoeken. Een userscript wordt door Tampermonkey vanzelf in
   elk frame geladen, maar een bookmarklet draait alleen in het venster waar
   je hem aanklikt — daar zou hij dus niets opvangen.

   Vandaar dat de installatie hier zelf de frames langsgaat. Alleen frames van
   dezelfde herkomst zijn bereikbaar; bij een frame van een andere site werpt
   de browser een fout en slaan we hem over. Dat is geen omzeiling van iets:
   wat niet mag, lukt gewoon niet. */
function ishTapVerspreid() {
  const bron = '(' + ishTapInstalleer.toString() + ')(); (' + ishTapVerspreid.toString() + ')();';
  for (let i = 0; i < window.frames.length; i++) {
    try {
      const f = window.frames[i];
      // Al actief in dat frame? Dan niets doen; de installatie bewaakt dat
      // zelf ook nog eens.
      if (f.__ISH_TAP__) continue;
      f.eval(bron);
    } catch (e) { /* frame van een andere herkomst: onbereikbaar, en dat hoort zo */ }
  }
}

ishTapVerspreid();
// Blijven herhalen, om twee redenen. Een frame kan later pas verschijnen, en
// een frame dat opnieuw laadt — je gaat terug naar het launchpad en opent de
// tegel opnieuw — begint met een schone lei zonder haak. De controle is
// nagenoeg gratis: er wordt niets gedaan zodra een frame al meeluistert.
window.addEventListener('load', ishTapVerspreid);
setInterval(ishTapVerspreid, 2000);
