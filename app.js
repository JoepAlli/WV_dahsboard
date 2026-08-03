'use strict';

// Een geëxporteerd "interactief dashboard" (zie buildStandaloneExport) bakt de
// data van dat moment in als window.__DASHBOARD_DATA__ i.p.v. dat er uit
// IndexedDB gelezen wordt. In die modus is het dashboard bekijk-alleen: geen
// nieuwe week verwerken, geen instellingen, geen blokkade-reden bewerken —
// dat blijft voorbehouden aan het originele dashboard waar de data vandaan komt.
const STATIC_DATA = window.__DASHBOARD_DATA__ || null;
const isStaticExport = !!STATIC_DATA;

/* ---------- Parsing ---------- */

const MONTHS = { jan:0, feb:1, mrt:2, apr:3, mei:4, jun:5, jul:6, aug:7, sep:8, okt:9, nov:10, dec:11 };
const FLAG_CODES = ['LS', 'B', 'K', 'W'];
const FLAG_LABELS = { B: 'Bodemonderzoek', K: 'KLIC-melding', W: 'WOW-melding', LS: 'Werkplan LS' };

function parseDutchDate(str) {
  const m = str.match(/(\d{1,2})\s+([a-z]{3})\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})/i);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  return new Date(parseInt(m[3], 10), month, parseInt(m[1], 10), parseInt(m[4], 10), parseInt(m[5], 10)).toISOString();
}

function decodeFlags(line) {
  const found = [];
  let i = 0;
  while (i < line.length) {
    let matched = false;
    for (const code of FLAG_CODES) {
      if (line.startsWith(code, i)) {
        if (!found.includes(code)) found.push(code);
        i += code.length;
        matched = true;
        break;
      }
    }
    if (!matched) i++;
  }
  return found;
}

const ON_TIME_RE = /^Nog\s+(\d+)\s+dagen$/i;
const OVERDUE_RE = /^(\d+)\s+dagen\s+verlopen$/i;
const TODAY_RE = /^Verloopt\s+vandaag$/i;
const ORDER_LABEL_RE = /^order:?$/i;
const ASSET_LABEL_RE = /^asset:?$/i;
const COORDS_LABEL_RE = /^coords:?$/i;
const MAX_MIDDLE_LINES = 12; // veiligheidsgrens tegen een ontbrekende "Nog X dagen"-regel

// Een gebiedscode-regel (bv. "ZZE10A") staat los vóór een reeks storingen en geldt
// voor alle storingen erna, tot de volgende gebiedscode-regel verschijnt. Herkenning:
// alleen hoofdletters/cijfers, geen spaties — dat onderscheidt hem van een type-regel
// (die altijd kleine letters/spaties bevat).
const GEBIEDSCODE_RE = /^[A-Z]+[0-9]+[A-Z]*$/;

// De Instandhoudingsapp heeft ook een "status"-weergave die, op precies dezelfde
// plek als de gebiedscode, één van deze 5 stadia toont i.p.v. het gebied — nooit
// allebei tegelijk. Om toch beide te kennen wordt de andere waarde bij het
// verwerken teruggehaald uit de vorige keer dat 'm wél bekend was (zie
// enrichWithCarriedForwardFields), zodat je gebied en status bij elkaar ziet ook
// al kwamen ze uit twee losse plakacties.
const OV_STATUS_ORDER = ['Nieuw', 'In onderzoek', 'Onderzoek controleren', 'In voorbereiding', 'Planning', 'In uitvoering'];
// Case-insensitief: de Instandhoudingsapp schrijft dit soms met net andere
// hoofdletters (bv. "In Uitvoering" i.p.v. "In uitvoering"). Herkenning mag
// daar niet op struikelen — normalizeOvStatus hieronder zet elke match terug
// naar de canonieke schrijfwijze uit OV_STATUS_ORDER, zodat kleuren/tegels/
// filters (die exact op die schrijfwijze vergelijken) altijd blijven werken.
const OV_STATUS_RE = /^(Nieuw|In onderzoek|Onderzoek controleren|In voorbereiding|Planning|In uitvoering)$/i;
function normalizeOvStatus(raw) {
  return OV_STATUS_ORDER.find(s => s.toLowerCase() === raw.toLowerCase()) || raw;
}

// Titel-/tellingregels zoals "24 Te controleren onderzoeken" bovenaan een paste:
// beginnen met een getal + spatie + tekst. Ordernummers zijn puur cijfers (geen
// spatie), dus dit kan nooit een ordernummer raken.
const COUNT_HEADER_RE = /^\d+\s+\S.*$/;

// Parseert precies één storing vanaf lines[start] en geeft { storing, next } terug,
// waarbij `next` de regel-index is waar de volgende storing begint. Er wordt geen
// lege regel tussen storingen verondersteld: veel paste-bronnen plakken alles
// direct achter elkaar, dus we lopen de regels aan één stuk door.
function parseOneEntry(lines, start) {
  let i = start;
  const type = lines[i++];
  if (type === undefined) throw new Error('Onverwacht einde van de tekst');

  const locLine = lines[i++];
  if (!locLine) throw new Error('Locatieregel ontbreekt na: ' + type);
  const locParts = locLine.split('|').map(s => s.trim());
  if (locParts.length < 3) throw new Error('Locatieregel kon niet worden gesplitst op "|": ' + locLine);
  const [city, street, postcode] = locParts;

  if (!lines[i] || !ORDER_LABEL_RE.test(lines[i])) throw new Error('Verwachtte "Order:" label, kreeg: ' + lines[i]);
  i++;
  const order = lines[i++];
  if (!order || !/^\d{6,12}$/.test(order)) throw new Error('Ordernummer onherkenbaar: ' + order);

  // Meestal "Asset:" + assetnummer (+ evt. MSR/LSKN/LSKOV op de regel erna).
  // Is het assetnummer onbekend, dan staat er in plaats daarvan "Coords:" met
  // de coördinaten als waarde — zonder MSR/LSKN/LSKOV-regel erna.
  let asset, assetType = null;
  if (lines[i] && ASSET_LABEL_RE.test(lines[i])) {
    i++;
    asset = lines[i++];
    if (!asset) throw new Error('Assetnummer ontbreekt');
    if (lines[i] && /^(MSR|LSKN|LSKOV)$/i.test(lines[i])) {
      assetType = lines[i++].toUpperCase();
    }
  } else if (lines[i] && COORDS_LABEL_RE.test(lines[i])) {
    i++;
    asset = lines[i++];
    if (!asset) throw new Error('Coördinaten ontbreken na "Coords:"');
  } else {
    throw new Error('Verwachtte "Asset:" of "Coords:" label, kreeg: ' + lines[i]);
  }

  const middleLines = [];
  const middleStart = i;
  while (i < lines.length && !ON_TIME_RE.test(lines[i]) && !OVERDUE_RE.test(lines[i]) && !TODAY_RE.test(lines[i])) {
    if (i - middleStart >= MAX_MIDDLE_LINES) {
      throw new Error(`Geen dagen-regel gevonden binnen ${MAX_MIDDLE_LINES} regels na order ${order}`);
    }
    middleLines.push(lines[i++]);
  }
  if (i >= lines.length) throw new Error(`Geen dagen-regel gevonden voor order ${order}`);
  let daysLeft, overdue;
  const mOn = lines[i].match(ON_TIME_RE);
  if (mOn) { daysLeft = parseInt(mOn[1], 10); overdue = false; }
  else if (TODAY_RE.test(lines[i])) { daysLeft = 0; overdue = false; }
  else { const mOff = lines[i].match(OVERDUE_RE); daysLeft = -parseInt(mOff[1], 10); overdue = true; }
  i++;

  // De uitvoeringsdatum-regel wordt alleen geconsumeerd als hij ook echt op een
  // datum/"onbekend" lijkt — anders is het de type-regel van de vólgende storing.
  let executionDate = null;
  let executionDateRaw = null;
  if (i < lines.length && (/onbekend/i.test(lines[i]) || parseDutchDate(lines[i]))) {
    executionDateRaw = lines[i];
    if (!/onbekend/i.test(lines[i])) executionDate = parseDutchDate(lines[i]);
    i++;
  }

  const flagLineRe = /^[A-Z]+$/;
  const flagLines = middleLines.filter(l => flagLineRe.test(l));
  const nameLines = middleLines.filter(l => !flagLineRe.test(l));

  let wvNaam = null;
  if (nameLines.length >= 2) wvNaam = nameLines[0]; // 1e naam = WV'er; 2e = uitvoerder (genegeerd)

  let flags = [];
  flagLines.forEach(fl => { flags = flags.concat(decodeFlags(fl)); });
  flags = [...new Set(flags)];

  const storing = {
    type, city, street, postcode, order, asset, assetType,
    wvNaam, names: nameLines, flags, daysLeft, overdue, executionDate, executionDateRaw,
  };
  return { storing, next: i };
}

function findNextOrderLabel(lines, from) {
  for (let j = from; j < lines.length; j++) {
    if (ORDER_LABEL_RE.test(lines[j])) return j;
  }
  return -1;
}

function parseText(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const storingen = [];
  const errors = [];
  let i = 0;
  let currentGebiedscode = null;
  let currentOvStatus = null;
  while (i < lines.length) {
    // Combineer alle skip-checks in één lus: een gebiedscode/status kan vlak na
    // een titel-/tellingregel staan (of andersom), dus we blijven controleren tot
    // geen van de patronen meer matcht. Gebiedscode en status staan nooit
    // tegelijk in dezelfde paste (zie OV_STATUS_RE hierboven), maar allebei
    // blijven ook los van elkaar "sticky" gelden tot de volgende regel van dat
    // type verschijnt.
    while (i < lines.length && (GEBIEDSCODE_RE.test(lines[i]) || OV_STATUS_RE.test(lines[i]) || COUNT_HEADER_RE.test(lines[i]))) {
      if (GEBIEDSCODE_RE.test(lines[i])) currentGebiedscode = lines[i];
      else if (OV_STATUS_RE.test(lines[i])) currentOvStatus = normalizeOvStatus(lines[i]);
      i++;
    }
    if (i >= lines.length) break;
    const start = i;
    try {
      const { storing, next } = parseOneEntry(lines, i);
      storing.gebiedscode = currentGebiedscode;
      storing.ovStatus = currentOvStatus;
      storingen.push(storing);
      i = next;
    } catch (e) {
      errors.push({ message: e.message, raw: lines.slice(start, start + 8).join('\n') });
      // Herstel: zoek de eerstvolgende "Order:"-regel en begin twee regels
      // daarvoor (type + locatie) opnieuw, zodat één kapot blok niet de rest
      // van de plak-tekst laat verdwijnen.
      const nextOrder = findNextOrderLabel(lines, start + 1);
      if (nextOrder === -1) break;
      i = Math.max(nextOrder - 2, start + 1);
    }
  }
  return { storingen, errors };
}

/* ---------- Storage (IndexedDB) ----------
   Alles staat lokaal in IndexedDB — geen server, niets wordt verzonden.
   IndexedDB heeft een veel hoger opslagplafond dan localStorage (waar de
   eerdere versie van dit dashboard gebruik van maakte), belangrijk omdat
   er over tijd makkelijk 500+ storingen per week bij kunnen komen. */

const DB_NAME = 'nusdash';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE_NAME); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
function idbSet(key, value) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}
function idbDelete(key) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

// Eenmalige migratie: data die nog in localStorage stond van vóór de
// overstap naar IndexedDB wordt automatisch overgenomen zodra er nog geen
// IndexedDB-waarde voor die sleutel bestaat. De oude localStorage-waarde
// blijft ongemoeid staan (geen dataverlies als dit twee keer draait).
async function migrateLegacyKey(key) {
  try {
    const existing = await idbGet(key);
    if (existing !== undefined) return;
    const legacyRaw = localStorage.getItem(key);
    if (!legacyRaw) return;
    await idbSet(key, JSON.parse(legacyRaw));
  } catch (e) { console.error('Migratie mislukt voor', key, e); }
}

/* ---------- Optioneel: gedeelde status via SharePoint ---------- */
//
// Blokkade-reden (OV NUSsen) kan — als je dit expliciet instelt in
// Instellingen — via één gedeeld JSON-bestand in de
// standaard documentbibliotheek van een SharePoint-site gedeeld worden i.p.v.
// alleen lokaal in IndexedDB te leven, zodat collega's die hetzelfde
// dashboard vanaf dezelfde SharePoint-site openen elkaars wijzigingen zien.
// Staat dit uit (standaard), dan verandert er niets aan het bestaande,
// volledig lokale gedrag.
//
// Bewust géén SharePoint-lijsten (die moet je zelf met de juiste kolommen
// aanmaken — te veel gedoe) maar één bestand in een bibliotheek die elke
// site al standaard heeft. Om te voorkomen dat twee mensen die vlak na
// elkaar iets aanpassen elkaars wijziging overschrijven, wordt bij elke
// opslag eerst de laatste versie opnieuw opgehaald en samengevoegd, met
// SharePoint's ETag-mechanisme als extra vangnet (een duidelijke melding +
// automatische herhaalpoging bij een echt gelijktijdig conflict).
//
// Vereist dat de pagina zelf vanaf de SharePoint-site wordt geopend (niet als
// lokaal bestand), zodat de browser de bestaande SharePoint-sessie/cookie kan
// hergebruiken voor authenticatie — er wordt hier bewust geen apart
// inlogscherm of app-registratie gebouwd.
const SHAREPOINT_CONFIG_KEY = 'nusdash_sharepoint_config_v1';
const DEFAULT_SHAREPOINT_LIBRARY = 'Shared Documents';
const SHAREPOINT_STATUS_FILE_NAME = 'nusdash-gedeelde-status.json';

async function loadSharePointConfig() {
  const fallback = { siteUrl: '', enabled: false, libraryName: '' };
  try { return Object.assign({}, fallback, (await idbGet(SHAREPOINT_CONFIG_KEY)) || {}); }
  catch (e) { console.error(e); return fallback; }
}
async function saveSharePointConfig(cfg) {
  try { await idbSet(SHAREPOINT_CONFIG_KEY, cfg); }
  catch (e) { showErrorToast('Opslaan van de SharePoint-instelling is mislukt: ' + e.message); throw e; }
}

function sharePointActive() {
  return !!(state.sharePointConfig && state.sharePointConfig.enabled && state.sharePointConfig.siteUrl);
}
function sharePointLibraryName() {
  return (state.sharePointConfig && state.sharePointConfig.libraryName) || DEFAULT_SHAREPOINT_LIBRARY;
}
// Geeft een duidelijke melding i.p.v. een cryptische netwerkfout ("Failed to
// fetch") wanneer gedeelde status wél aanstaat maar de pagina nog steeds als
// lokaal bestand is geopend — een fetch() naar een https-SharePoint-site
// werkt dan sowieso niet vanaf een file://-oorsprong.
function spAssertHostedProperly() {
  if (location.protocol === 'file:') {
    throw new Error('open het dashboard via de SharePoint-URL (niet als lokaal bestand) om gedeelde status te gebruiken');
  }
}

function spApiUrl(siteUrl, path) {
  return siteUrl.replace(/\/$/, '') + '/_api/' + path;
}
// Server-relatief pad naar het gedeelde bestand, bv. "/sites/NUSTeam/Shared
// Documents/nusdash-gedeelde-status.json" — afgeleid van de site-URL zelf,
// zodat je alleen de site-URL hoeft in te vullen en niets hoeft te kopiëren
// vanuit de bibliotheek.
function spStatusFileServerRelativeUrl(siteUrl) {
  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  return `${sitePath}/${sharePointLibraryName()}/${SHAREPOINT_STATUS_FILE_NAME}`;
}

// Vraagt een "form digest" op — SharePoint eist dit anti-CSRF-token bij elke
// schrijfactie via de REST API.
async function spGetDigest(siteUrl) {
  const res = await fetch(spApiUrl(siteUrl, 'contextinfo'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json;odata=verbose' },
  });
  if (!res.ok) throw new Error(`kon geen SharePoint-formulierdigest ophalen (status ${res.status})`);
  const data = await res.json();
  return data.d.GetContextWebInformation.FormDigestValue;
}

// Haalt de inhoud van het gedeelde statusbestand op. exists:false betekent
// "bestaat nog niet" (nog niets opgeslagen) — geen fout, gewoon leeg beginnen.
async function spGetFileContent(siteUrl) {
  const fileUrl = spStatusFileServerRelativeUrl(siteUrl);
  const res = await fetch(spApiUrl(siteUrl, `web/GetFileByServerRelativeUrl('${encodeURIComponent(fileUrl)}')/$value`), {
    credentials: 'same-origin',
  });
  if (res.status === 404) return { exists: false, data: { ovBlockStatus: {} }, etag: null };
  if (!res.ok) throw new Error(`ophalen van gedeeld statusbestand mislukt (status ${res.status}) — bestaat de bibliotheek "${sharePointLibraryName()}" op deze site?`);
  const etag = res.headers.get('ETag');
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch (e) { throw new Error('het gedeelde statusbestand bevat geen geldige data (kapotte JSON)'); }
  if (!data.ovBlockStatus) data.ovBlockStatus = {};
  return { exists: true, data, etag };
}

// Schrijft de inhoud van het gedeelde statusbestand weg. Bij een bestaand
// bestand met IF-MATCH op de eerder opgehaalde ETag, zodat een gelijktijdige
// wijziging door iemand anders wordt gedetecteerd (SharePoint geeft dan 412
// terug) i.p.v. stilzwijgend overschreven te worden.
async function spPutFileContent(siteUrl, exists, etag, data) {
  const digest = await spGetDigest(siteUrl);
  const body = JSON.stringify(data);
  if (!exists) {
    const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
    const folderUrl = `${sitePath}/${sharePointLibraryName()}`;
    const res = await fetch(spApiUrl(siteUrl, `web/GetFolderByServerRelativeUrl('${encodeURIComponent(folderUrl)}')/Files/add(url='${encodeURIComponent(SHAREPOINT_STATUS_FILE_NAME)}',overwrite=true)`), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json;odata=verbose', 'X-RequestDigest': digest },
      body,
    });
    if (!res.ok) throw new Error(`aanmaken van gedeeld statusbestand mislukt (status ${res.status}) — bestaat de bibliotheek "${sharePointLibraryName()}" op deze site?`);
    return;
  }
  const fileUrl = spStatusFileServerRelativeUrl(siteUrl);
  const res = await fetch(spApiUrl(siteUrl, `web/GetFileByServerRelativeUrl('${encodeURIComponent(fileUrl)}')/$value`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-RequestDigest': digest,
      'X-HTTP-Method': 'PUT',
      'IF-MATCH': etag,
    },
    body,
  });
  if (res.status === 412) throw new Error('CONFLICT');
  if (!res.ok) throw new Error(`opslaan van gedeeld statusbestand mislukt (status ${res.status})`);
}

// Haalt de laatste versie op, past 'm aan via mutateFn, en schrijft 'm terug
// — bij een gelijktijdig-conflict (412) wordt dit automatisch nog 2x
// opnieuw geprobeerd (met een verse ophaal + hersamenvoeging), zodat een
// toevallige botsing met een collega's wijziging vanzelf oplost i.p.v. stil
// data te verliezen of meteen een foutmelding te tonen.
async function spUpdateSharedFile(siteUrl, mutateFn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await spGetFileContent(siteUrl);
    mutateFn(current.data);
    try {
      await spPutFileContent(siteUrl, current.exists, current.etag, current.data);
      return current.data;
    } catch (e) {
      if (e.message !== 'CONFLICT') throw e;
      lastErr = e;
    }
  }
  throw new Error('iemand anders wijzigde het gedeelde statusbestand precies tegelijk — probeer het nog eens');
}

// Test-knop in Instellingen: probeert het gedeelde statusbestand te lezen
// (of bevestigt dat de bibliotheek in elk geval bestaat als het bestand er
// nog niet is) zonder iets te wijzigen.
async function spTestConnection(siteUrl, libraryName) {
  spAssertHostedProperly();
  libraryName = libraryName || DEFAULT_SHAREPOINT_LIBRARY;
  const sitePath = new URL(siteUrl).pathname.replace(/\/$/, '');
  const folderUrl = `${sitePath}/${libraryName}`;
  const res = await fetch(spApiUrl(siteUrl, `web/GetFolderByServerRelativeUrl('${encodeURIComponent(folderUrl)}')?$select=Exists`), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json;odata=verbose' },
  });
  if (!res.ok) throw new Error(`bibliotheek "${libraryName}" niet gevonden op deze site (status ${res.status})`);
  const data = await res.json();
  if (!data.d.Exists) throw new Error(`bibliotheek "${libraryName}" bestaat niet op deze site`);
}

const STORAGE_KEY = 'nusdash_snapshots_v1';
const TYPE_WHITELIST_KEY = 'nusdash_type_whitelist_v1';

const DEFAULT_TYPE_WHITELIST = [
  'Stra[a]t[en] zonder OV Infra',
  'OV aansluitkabel',
  'Onveilige situatie/gehele wijk',
  'Mast geen spanning Infra',
  'OV Mof',
  'Branden overdag Infra',
];

async function loadSnapshots() {
  await migrateLegacyKey(STORAGE_KEY);
  try { return (await idbGet(STORAGE_KEY)) || []; }
  catch (e) { console.error(e); return []; }
}
async function saveSnapshots(snaps) {
  snaps.sort((a, b) => a.week.localeCompare(b.week));
  try { await idbSet(STORAGE_KEY, snaps); }
  catch (e) { showErrorToast('Opslaan is mislukt: ' + e.message); throw new Error('Opslaan is mislukt: ' + e.message); }
}
async function clearSnapshots() { await idbDelete(STORAGE_KEY); }

async function loadTypeWhitelist() {
  await migrateLegacyKey(TYPE_WHITELIST_KEY);
  try { const v = await idbGet(TYPE_WHITELIST_KEY); return v || DEFAULT_TYPE_WHITELIST.slice(); }
  catch (e) { console.error(e); return DEFAULT_TYPE_WHITELIST.slice(); }
}
async function saveTypeWhitelist(list) {
  try { await idbSet(TYPE_WHITELIST_KEY, list); }
  catch (e) { showErrorToast('Opslaan van het type-filter is mislukt: ' + e.message); throw e; }
}

const BIJNA_VERLOPEN_THRESHOLD_KEY = 'nusdash_bijna_verlopen_threshold_v1';
const DEFAULT_BIJNA_VERLOPEN_THRESHOLD = 2;
async function loadBijnaVerlopenThreshold() {
  try { const v = await idbGet(BIJNA_VERLOPEN_THRESHOLD_KEY); return Number.isFinite(v) && v > 0 ? v : DEFAULT_BIJNA_VERLOPEN_THRESHOLD; }
  catch (e) { console.error(e); return DEFAULT_BIJNA_VERLOPEN_THRESHOLD; }
}
async function saveBijnaVerlopenThreshold(n) {
  try { await idbSet(BIJNA_VERLOPEN_THRESHOLD_KEY, n); }
  catch (e) { showErrorToast('Opslaan van de drempel is mislukt: ' + e.message); throw e; }
}

// Handmatige blokkade-reden voor OV NUSsen-storingen die open moeten blijven
// maar waar wij niets mee kunnen (bv. "Aannemerij" of "Naar Aanleg").
// Ook op ordernummer bijgehouden, zodat je een lang openstaande storing niet
// elke week opnieuw hoeft te beoordelen — eenmaal gezet blijft de reden staan
// en verdwijnt de "actie nodig"-markering voor die storing.
const OV_BLOCK_STATUS_KEY = 'nusdash_ov_block_status_v1';
async function loadOvBlockStatusMap() {
  if (sharePointActive()) {
    try {
      spAssertHostedProperly();
      const current = await spGetFileContent(state.sharePointConfig.siteUrl);
      return current.data.ovBlockStatus;
    } catch (e) {
      showErrorToast('Ophalen van gedeelde blokkade-status (SharePoint) is mislukt, lokale versie gebruikt: ' + e.message);
      // val terug op de lokale kopie zodat een mislukte sync niet de hele
      // blokkade-lijst leegtrekt
    }
  }
  try { return (await idbGet(OV_BLOCK_STATUS_KEY)) || {}; }
  catch (e) { console.error(e); return {}; }
}
// orders: het ordernummer (of een array van ordernummers) dat net gewijzigd
// is — alleen relevant wanneer SharePoint actief is, om gericht precies dat
// deel van het gedeelde bestand bij te werken i.p.v. het hele bestand met
// mogelijk verouderde lokale data te overschrijven.
async function saveOvBlockStatusMap(map, orders) {
  if (sharePointActive()) {
    try {
      spAssertHostedProperly();
      const list = orders == null ? [] : (Array.isArray(orders) ? orders : [orders]);
      await spUpdateSharedFile(state.sharePointConfig.siteUrl, (data) => {
        list.forEach(order => {
          const entry = map[order];
          if (entry && entry.reason) data.ovBlockStatus[order] = { reason: entry.reason, note: entry.note || '', since: entry.since || undefined };
          else delete data.ovBlockStatus[order];
        });
      });
      return;
    } catch (e) {
      showErrorToast('Delen via SharePoint is mislukt, wijziging lokaal opgeslagen: ' + e.message);
      // val terug op lokaal opslaan zodat de wijziging niet verloren gaat
    }
  }
  try { await idbSet(OV_BLOCK_STATUS_KEY, map); }
  catch (e) { showErrorToast('Opslaan van de blokkade-reden is mislukt: ' + e.message); throw e; }
}

async function getStorageEstimate() {
  if (navigator.storage && navigator.storage.estimate) {
    try { return await navigator.storage.estimate(); }
    catch (e) { return null; }
  }
  return null;
}

// Back-up: alle weken (beide bakken) en instellingen (types/namenlijsten) in
// één downloadbaar JSON-bestand, los van de browseropslag.
async function exportBackup() {
  const backup = {
    exportedAt: new Date().toISOString(),
    version: 1,
    ovSnapshots: await loadSnapshots(),
    typeWhitelist: await loadTypeWhitelist(),
    ovBlockStatus: await loadOvBlockStatusMap(),
    bijnaVerlopenThreshold: await loadBijnaVerlopenThreshold(),
    sharePointConfig: await loadSharePointConfig(),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nus-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Voorkomt dat de HTML-parser een ingebedde </script> of </style> als een
// vroegtijdig einde van de omringende tag interpreteert. Nodig omdat de
// ingebakken app.js-broncode zélf de tekst "</script>" bevat (in deze functie).
function escapeForInlineTag(str, tag) {
  const re = new RegExp('</(' + tag + ')', 'gi');
  return str.replace(re, '<\\/$1');
}

// Bouwt één zelfstandig .html-bestand met de huidige data erin gebakken:
// bekijk-alleen, maar met dezelfde tabbladen/filters/sortering/klikbare
// tegels als het echte dashboard. Bedoeld om in een gedeelde werkmap te
// zetten zodat teamleden 'm gewoon kunnen dubbelklikken.
function buildStandaloneExport() {
  if (!window.__EXPORT_CSS__ || !window.__EXPORT_APPJS__ || !window.__EXPORT_HTML_SHELL__) {
    throw new Error('export-template.js ontbreekt of is niet meegeladen — kan geen zelfstandig bestand genereren.');
  }
  const data = {
    ovSnapshots: state.snapshots,
    typeWhitelist: state.typeWhitelist,
    ovBlockStatus: state.ovBlockStatus,
    bijnaVerlopenThreshold: state.bijnaVerlopenThreshold,
    exportedAt: new Date().toISOString(),
  };
  const dataScript = escapeForInlineTag('window.__DASHBOARD_DATA__ = ' + JSON.stringify(data) + ';', 'script');
  const appJs = escapeForInlineTag(window.__EXPORT_APPJS__, 'script');
  const css = escapeForInlineTag(window.__EXPORT_CSS__, 'style');
  const dateLabel = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NUS Dashboard — Weekoverzicht (${dateLabel})</title>
<style>${css}</style>
</head>
<body>
${window.__EXPORT_HTML_SHELL__}
<script>${dataScript}</script>
<script>${appJs}</script>
</body>
</html>`;
}

async function importBackup(file) {
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (e) {
    throw new Error('bestand is geen geldig back-upbestand (JSON kon niet worden gelezen)');
  }
  if (!backup || typeof backup !== 'object') throw new Error('bestand is geen geldig back-upbestand');
  if (Array.isArray(backup.ovSnapshots)) await saveSnapshots(backup.ovSnapshots);
  if (Array.isArray(backup.typeWhitelist)) await saveTypeWhitelist(backup.typeWhitelist);
  // Blokkade-reden leeft ergens anders (in SharePoint, gedeeld met
  // collega's) zodra dat actief staat — een lokaal back-upbestand daar
  // overheen zetten zou voor iedereen tegelijk verrassend zijn, dus dat
  // slaan we dan bewust over. Herstel daarvan gebeurt via SharePoint zelf.
  if (backup.ovBlockStatus && typeof backup.ovBlockStatus === 'object' && !sharePointActive()) await saveOvBlockStatusMap(backup.ovBlockStatus);
  if (Number.isFinite(backup.bijnaVerlopenThreshold) && backup.bijnaVerlopenThreshold > 0) await saveBijnaVerlopenThreshold(backup.bijnaVerlopenThreshold);
  if (backup.sharePointConfig && typeof backup.sharePointConfig === 'object') await saveSharePointConfig(backup.sharePointConfig);
}

// Bouwt, in één keer over alle bestaande OV-snapshots (nieuwste eerst), een
// opzoektabel van de laatst bekende gebiedscode/status per ordernummer. Wordt
// gebruikt om net-verwerkte storingen aan te vullen met de waarde die deze
// paste zelf niet had (zie OV_STATUS_RE hierboven): een status-weergave-paste
// mist de gebiedscode, een gewone paste mist de status — allebei blijven ze
// zo bekend totdat een nieuwere paste een andere waarde meebrengt.
function buildLastKnownOvFieldMaps(snapshots) {
  const sorted = snapshots.slice().sort((a, b) => b.week.localeCompare(a.week) || b.savedAt.localeCompare(a.savedAt));
  const gebiedscodeByOrder = {};
  const statusByOrder = {};
  sorted.forEach(sn => {
    sn.storingen.forEach(s => {
      if (s.gebiedscode && !(s.order in gebiedscodeByOrder)) gebiedscodeByOrder[s.order] = s.gebiedscode;
      if (s.ovStatus && !(s.order in statusByOrder)) statusByOrder[s.order] = s.ovStatus;
    });
  });
  return { gebiedscodeByOrder, statusByOrder };
}
function enrichWithCarriedForwardOvFields(storingen, priorSnapshots) {
  const { gebiedscodeByOrder, statusByOrder } = buildLastKnownOvFieldMaps(priorSnapshots);
  storingen.forEach(s => {
    if (!s.gebiedscode && gebiedscodeByOrder[s.order]) s.gebiedscode = gebiedscodeByOrder[s.order];
    if (!s.ovStatus && statusByOrder[s.order]) s.ovStatus = statusByOrder[s.order];
  });
}

/* ---------- Derived helpers ---------- */

function regioOf(s) { return s.city || 'Onbekend'; }

// Regio wordt bepaald door de gebiedscode die voor de storing stond in de
// paste: ZZE9(A/B) en ZZE10(A/B) zijn Regio Haarlem, elke andere gebiedscode
// is Regio Leiden. Ontbreekt de gebiedscode (bv. oudere paste zonder codes),
// dan weten we het niet zeker en valt de storing onder "Overig".
const REGIO_GROUP_ORDER = ['Haarlem', 'Leiden', 'Overig'];
const REGIO_GROUP_COLOR = { Haarlem: 'var(--series-1)', Leiden: 'var(--series-2)', Overig: 'var(--series-other)' };

function regioGroupOf(s) {
  const code = (s.gebiedscode || '').toUpperCase();
  if (!code) return 'Overig';
  if (code.startsWith('ZZE9') || code.startsWith('ZZE10')) return 'Haarlem';
  return 'Leiden';
}
function regioGroupLabel(g) { return g === 'Overig' ? 'Overig' : `Regio ${g}`; }
function sortByGroupOrder(names) {
  return names.slice().sort((a, b) => REGIO_GROUP_ORDER.indexOf(a) - REGIO_GROUP_ORDER.indexOf(b));
}
function filterByActive(list) {
  if (state.activeFilter === 'Totaal') return list;
  return list.filter(s => regioGroupOf(s) === state.activeFilter);
}

// Zoeken op order of adres (plaats/straat/postcode) — case-insensitive,
// gedeeld tussen de drie volledige-lijst-tabellen.
function matchesSearch(s, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [s.order, s.city, s.street, s.postcode].some(v => (v || '').toLowerCase().includes(q));
}
function searchFiltered(list, query) { return list.filter(s => matchesSearch(s, query)); }

// Alleen storingen met een type in de whitelist tellen mee (zie "Type-filter").
function isTypeIncluded(s) { return state.typeWhitelist.includes(s.type); }
function typeFiltered(list) { return list.filter(isTypeIncluded); }

// De grens voor "Bijna verlopen" (serious) is instelbaar (zie Instellingen);
// "Aandacht" (warning) begint waar die grens ophoudt en loopt door tot 3
// dagen later, zodat die band evenredig meeschuift met de drempel.
function statusOf(s) {
  const t = state.bijnaVerlopenThreshold || DEFAULT_BIJNA_VERLOPEN_THRESHOLD;
  if (s.overdue) return 'critical';
  if (s.daysLeft <= t) return 'serious';
  if (s.daysLeft <= t + 3) return 'warning';
  return 'good';
}
const STATUS_LABELS = { good: 'Op tijd', warning: 'Aandacht', serious: 'Bijna verlopen', critical: 'Verlopen' };
const STATUS_ICONS = { good: '✓', warning: '!', serious: '⚠', critical: '✕' };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];

// Tabelweergave van de dagen-status-pill, met een apart icoon + accent voor
// verlopen storingen waar iets moet gebeuren: geen uitvoeringsdatum, óf een
// uitvoeringsdatum die zelf ook al verstreken is.
function renderDaysPill(s) {
  const status = statusOf(s);
  const daysText = s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen` : (s.daysLeft === 0 ? 'verloopt vandaag' : `nog ${s.daysLeft} dgn`);
  const unplanned = isActionableOverdue(s);
  const expiredPlan = !unplanned && isActionableExpiredDate(s);
  let icon = STATUS_ICONS[status];
  let cls = `status-pill ${status}`;
  let title = '';
  if (unplanned) {
    icon = '⛔'; cls += ' status-pill-unplanned'; title = 'Verlopen én nog geen uitvoeringsdatum — actie nodig';
  } else if (expiredPlan) {
    icon = '⏰'; cls += ' status-pill-expired-date'; title = 'De geplande uitvoeringsdatum is zelf ook al verstreken — controleer de planning';
  }
  return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${icon} ${esc(daysText)}</span>`;
}

function computeMutations(current, previous) {
  if (!previous) return { nieuw: [], uitgegaan: [], hasPrevious: false };
  const curOrders = new Set(current.map(s => s.order));
  const prevOrders = new Set(previous.storingen.map(s => s.order));
  const nieuw = current.filter(s => !prevOrders.has(s.order));
  const uitgegaan = previous.storingen.filter(s => !curOrders.has(s.order));
  return { nieuw, uitgegaan, hasPrevious: true };
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = ['zo','ma','di','wo','do','vr','za'];
  const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

/* ---------- State ---------- */

const state = {
  snapshots: [],
  typeWhitelist: [],
  activeFilter: 'Totaal',
  sortState: { key: 'daysLeft', dir: 1 },
  gebiedSortState: { key: 'regio', dir: 1 },
  wvSortState: { key: 'wvNaam', dir: 1 },
  regioViewMode: 'chart',
  trendViewMode: 'chart',
  statDetailFilter: null,
  statDetailOrders: null,
  ovBlockStatus: {},
  searchQuery: '',
  ovBulkSelected: new Set(),
  // Bevriest welke orders + categorie in "Aandacht deze week" staan, zodat
  // een rij niet meteen verdwijnt zodra je 'm daar blokkeert (zelfde reden als
  // state.statDetailOrders hierboven). Wordt op null gezet bij echte
  // datawijzigingen (nieuwe week verwerkt/verwijderd, back-up hersteld) zodat
  // de lijst dan opnieuw wordt opgebouwd.
  attentionOrders: null,
  bijnaVerlopenThreshold: DEFAULT_BIJNA_VERLOPEN_THRESHOLD,
  sharePointConfig: { siteUrl: '', enabled: false },
};

/* ---------- Tooltip ---------- */

const tooltipEl = document.getElementById('tooltip');
function showTooltip(evt, html) {
  tooltipEl.innerHTML = html;
  tooltipEl.classList.remove('hidden');
  moveTooltip(evt);
}
function moveTooltip(evt) {
  tooltipEl.style.left = (evt.clientX + 14) + 'px';
  tooltipEl.style.top = (evt.clientY + 14) + 'px';
}
function hideTooltip() { tooltipEl.classList.add('hidden'); }

/* ---------- Foutmeldingen (toasts) ---------- */

// Zichtbare melding voor mislukte opslagacties — zonder dit zou een fout bij
// het wegschrijven naar IndexedDB (schijf/opslaglimiet vol, IndexedDB
// geblokkeerd in bepaalde privénavigatie-modi, ...) alleen in de
// browserconsole belanden terwijl de UI gewoon doorgaat alsof het gelukt is.
function showErrorToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) { console.error(message); return; }
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">⚠️</span><span>${esc(message)}</span>`;
  toast.addEventListener('click', () => dismissToast(toast));
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => dismissToast(toast), 8000);
}
function dismissToast(toast) {
  if (!toast.isConnected) return;
  toast.classList.remove('toast-visible');
  setTimeout(() => toast.remove(), 200);
}

// Voor tegels zonder eigen uitklaplijst (de storingen erachter staan al
// zichtbaar elders op de pagina): springt ernaartoe en licht 'm even op,
// zodat "elke tegel is klikbaar" geldt zonder dezelfde lijst dubbel te tonen.
function scrollToAndHighlight(id) {
  const el = document.getElementById(id);
  if (!el) return;
  // Zit het doelwit in een ingeklapt <details>-blok (bv. "Trends, grafieken &
  // mutaties"), klap dat dan eerst open — anders scrollt dit naar een dichte
  // regel in plaats van naar de daadwerkelijke data.
  const details = el.closest('details');
  if (details && !details.open) details.open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash-highlight');
  void el.offsetWidth; // forceer reflow zodat de animatie herstart bij snel opnieuw klikken
  el.classList.add('flash-highlight');
  setTimeout(() => el.classList.remove('flash-highlight'), 1700);
}

/* ---------- Rendering: stat tiles ---------- */

// Een storing is "onbeheerd verlopen" als het target al gemist is én er nog
// geen uitvoeringsdatum gepland staat — dáár kunnen we nog op sturen door 'm
// alsnog in te plannen. Verlopen storingen die al wél een datum hebben, lopen
// gewoon (te laat, maar onderweg) — tenzij die datum zélf ook al voorbij is,
// zie isExpiredExecutionDate hieronder.
function isUnplannedOverdue(s) { return !!s.overdue && !s.executionDate; }

// Verlopen mét een geplande uitvoeringsdatum, maar die datum ligt zelf ook al
// in het verleden: de storing staat dus nog open terwijl de geplande
// uitvoering al had moeten zijn gebeurd. Dit oogt in de tabel "geregeld"
// (er staat een datum) maar is dat dus niet — precies het inzicht dat nodig
// is om hierop te kunnen sturen.
// Vergelijkt op kalenderdag (niet exacte tijd): een uitvoering die vandaag
// gepland staat telt nog niet als verstreken, ook al is het geplande tijdstip
// vandaag al gepasseerd — de dag is immers nog niet om.
function isExpiredExecutionDate(s) {
  if (!s.overdue || !s.executionDate) return false;
  const execDay = new Date(s.executionDate);
  execDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return execDay.getTime() < today.getTime();
}

// Sommige storingen moeten openblijven maar daar kunnen wij niets meer aan
// doen (bv. wachten op Aannemerij, of overgedragen aan Aanleg). Eenmaal zo
// gemarkeerd hoeft die storing niet meer als "actie nodig" op te vallen —
// dat is precies waarom dit bestaat: niet elke week opnieuw dezelfde lang
// openstaande storingen langslopen.
const OV_BLOCK_REASON_LABELS = { rezap: 'Aannemerij', aanleg: 'Naar Aanleg', uitvoerder: 'Uitvoerder', onderzoek: 'Onderzoek loopt' };
// Storingen die 4+ weken onafgebroken geblokkeerd staan zijn het waard om
// nog eens te checken — een tekort bij de aannemerij van 2 maanden geleden is misschien
// allang opgelost.
const OV_BLOCK_STALE_DAYS = 28;
function ovBlockStatusOf(order) { return state.ovBlockStatus[order] || {}; }
function isOvBlocked(s) { return !!ovBlockStatusOf(s.order).reason; }
function ovBlockDaysSince(order) {
  const since = ovBlockStatusOf(order).since;
  return since ? Math.round((Date.now() - new Date(since).getTime()) / 86400000) : null;
}
function isOvBlockStale(order) {
  const days = ovBlockDaysSince(order);
  return days !== null && days >= OV_BLOCK_STALE_DAYS;
}
// Zet de blokkade-reden en stempelt "since" alleen bij de overgang van
// niet-geblokkeerd naar geblokkeerd, zodat dit de duur van de HUIDIGE
// blokkade blijft — niet gereset door bv. een reden-wissel (rezap -> aanleg)
// of een toelichting bijwerken.
function setOvBlockReason(order, reason) {
  const cur = state.ovBlockStatus[order] || {};
  const since = reason ? (cur.reason ? cur.since : new Date().toISOString()) : undefined;
  state.ovBlockStatus[order] = { reason, note: cur.note || '', since };
}
function setOvBlockNote(order, note) {
  const cur = state.ovBlockStatus[order] || {};
  state.ovBlockStatus[order] = { reason: cur.reason, note, since: cur.since };
}
function blockSinceHtml(order) {
  const days = ovBlockDaysSince(order);
  if (days === null) return '';
  const stale = isOvBlockStale(order);
  return `<div class="ov-block-since${stale ? ' ov-block-since-stale' : ''}">sinds ${days} dag${days === 1 ? '' : 'en'}${stale ? ' — nog actueel?' : ''}</div>`;
}
function isActionableOverdue(s) { return isUnplannedOverdue(s) && !isOvBlocked(s); }
function isActionableExpiredDate(s) { return isExpiredExecutionDate(s) && !isOvBlocked(s); }
// Beide varianten van "verlopen én iets moet gebeuren" samen — gebruikt voor
// de rij-markering in de tabellen, die niet onderscheidt wélke reden het is.
function needsFollowUp(s) { return isActionableOverdue(s) || isActionableExpiredDate(s); }

// Elke klikbare OV NUS-tegel heeft een filterKey met een titel en een test-
// functie die bepaalt welke storingen erachter zitten — gebruikt door zowel
// de tegel zelf als door renderStatDetail() voor de uitklap-lijst.
// De workflow-stadia (OV_STATUS_ORDER) vervangen de oude "In onderzoek"/
// "Klaar voor inplannen"-kruisverwijzingstegels: die waren een gok op basis van
// of een order ook in de andere bak voorkwam, dit is de échte status uit de
// Instandhoudingsapp zelf.
const OV_STATUS_FILTER_KEYS = { 'Nieuw': 'statusNieuw', 'In onderzoek': 'statusOnderzoek', 'Onderzoek controleren': 'statusOnderzoekControleren', 'In voorbereiding': 'statusVoorbereiding', 'Planning': 'statusPlanning', 'In uitvoering': 'statusUitvoering' };
function statTileFilters() {
  const filters = {
    known: { title: 'Verlopen — uitvoering gepland', test: s => s.overdue && !!s.executionDate && !isExpiredExecutionDate(s) && !isOvBlocked(s) },
    verlopenDatum: { title: 'Uitvoeringsdatum verstreken', test: s => isActionableExpiredDate(s) },
    unknown: { title: 'Verlopen — uitvoering onbekend', test: s => isActionableOverdue(s) },
    bijnaVerlopen: { title: 'Bijna verlopen', test: s => statusOf(s) === 'serious' && !isOvBlocked(s) },
    geblokkeerd: { title: 'Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt)', test: s => isOvBlocked(s) },
  };
  OV_STATUS_ORDER.forEach(status => {
    filters[OV_STATUS_FILTER_KEYS[status]] = { title: `Status: ${status}`, test: s => s.ovStatus === status && !isOvBlocked(s) };
  });
  // "Nieuw" telt bewust NIET de zelf-gerapporteerde status van de Instand-
  // houdingsapp: een storing die meteen wordt opgepakt kan al bij de eerste
  // keer zien "In onderzoek" tonen, ook al is 'm vandaag pas binnengekomen —
  // dan geeft de status-telling een scheef beeld van de instroom. In plaats
  // daarvan: écht nieuw als het ordernummer nog nooit eerder is gezien, d.w.z.
  // de eerst-gezien-week (zie firstSeenWeekMap, ook gebruikt voor "Open
  // sinds") is gelijk aan de nieuwste verwerkte week. Meerdere updates op
  // dezelfde dag delen dezelfde week-datum, dus dit ververst per dag, niet
  // per status-wissel binnen die dag.
  const firstSeenMap = firstSeenWeekMap();
  const sortedSnaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  const latestWeek = sortedSnaps.length ? sortedSnaps[sortedSnaps.length - 1].week : null;
  filters[OV_STATUS_FILTER_KEYS['Nieuw']] = {
    title: 'Nieuw binnengekomen (nog niet eerder gezien)',
    test: s => firstSeenMap[s.order] === latestWeek && !isOvBlocked(s),
  };
  return filters;
}

const OV_STATUS_ICONS = { 'Nieuw': '🆕', 'In onderzoek': '🔍', 'Onderzoek controleren': '🧐', 'In voorbereiding': '🧰', 'Planning': '🗓️', 'In uitvoering': '🚧' };

// Elke OV-tegel is nu klikbaar en toont dan (in #overdue-detail) een verloop-
// grafiekje van hoe die tegel's waarde zich ontwikkelt over alle opgeslagen
// momenten heen — inclusief meerdere updates op één dag. Alleen deze
// tegels hebben er daarnaast ook een rij-per-storing-tabel bij (de rest
// duplicerde toch al wat "Aandacht deze week"/"Volledige lijst" al tonen).
const OV_DETAIL_LIST_KEYS = new Set([...Object.values(OV_STATUS_FILTER_KEYS), 'geblokkeerd']);
const OV_TILE_TITLES = {
  totaal: 'Totaal open',
  verlopenDatum: 'Uitvoeringsdatum verstreken',
  unknown: 'Verlopen — uitvoering onbekend',
  afgesloten: 'Afgesloten / uitgegaan',
  geblokkeerd: 'Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt)',
};
OV_STATUS_ORDER.forEach(status => { OV_TILE_TITLES[OV_STATUS_FILTER_KEYS[status]] = `Status: ${status}`; });
OV_TILE_TITLES[OV_STATUS_FILTER_KEYS['Nieuw']] = 'Nieuw binnengekomen (nog niet eerder gezien)';

// Berekent het verloop van één tegel over alle opgeslagen OV-momenten heen,
// mét de actieve regiotab (net als de tegel zelf). "afgesloten" is een
// uitzondering: dat is een verschil tússen opeenvolgende momenten (wat is
// verdwenen), geen standenmeting op één moment, dus dat telt per paar.
function ovTileTrendSeries(key) {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt));
  if (key === 'afgesloten') {
    const points = [];
    for (let i = 1; i < snaps.length; i++) {
      const cur = filterByActive(typeFiltered(snaps[i].storingen));
      const prev = filterByActive(typeFiltered(snaps[i - 1].storingen));
      points.push({ week: snaps[i].week, savedAt: snaps[i].savedAt, value: computeMutations(cur, { storingen: prev }).uitgegaan.length });
    }
    return points;
  }
  const test = key === 'totaal' ? (() => true) : statTileFilters()[key].test;
  return snaps.map(sn => ({
    week: sn.week,
    savedAt: sn.savedAt,
    value: filterByActive(typeFiltered(sn.storingen)).filter(test).length,
  }));
}

// Rond een waarde af tot een "nette" stap (1/2/5 × een macht van 10) — het
// klassieke "nice numbers"-algoritme voor as-schaalverdeling.
function niceNumber(range, round) {
  if (range <= 0) return 1;
  const exponent = Math.floor(Math.log10(range));
  const fraction = range / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}
// Bepaalt een leesbare as-range die niet per se bij 0 begint, maar bij een
// ronde waarde net onder de laagst gemeten waarde — zodat schommelingen in een
// reeks die hoog blijft liggen (bv. steeds tussen 63 en 84) zichtbaar blijven
// i.p.v. samengeperst tegen de bovenkant van een 0-tot-max-as. Dit mag alleen
// bij lijn-grafieken (positie codeert de waarde): een staafgrafiek (bv.
// renderRegioChart) moet wél bij 0 beginnen, anders vervormt de balklengte zelf.
function niceAxisRange(minVal, maxVal, targetTicks) {
  if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
  const range = niceNumber(maxVal - minVal, false);
  const step = niceNumber(range / targetTicks, true);
  const min = Math.max(0, Math.floor(minVal / step) * step);
  const max = Math.ceil(maxVal / step) * step;
  const ticks = Math.round((max - min) / step);
  return { min, max, step, ticks };
}

// Compacte lijn-grafiek voor in het detailpaneel — zelfde opzet als de grote
// "Trend over tijd"-grafiek, maar één lijn en zonder tabel-toggle (dat blijft
// voorbehouden aan de hoofdgrafiek).
function tileTrendChartHtml(points) {
  if (points.length < 2) {
    return '<p class="empty-note">Nog niet genoeg opgeslagen momenten voor een verloop — verwerk nog een update.</p>';
  }
  const leftPad = 36, rightPad = 12, topPad = 14, plotH = 110, bottomPad = 26;
  const plotW = Math.max(240, points.length * 46);
  const chartW = leftPad + plotW + rightPad;
  const chartH = topPad + plotH + bottomPad;
  const values = points.map(p => p.value);
  const { min: axisMin, max: axisMax, step, ticks } = niceAxisRange(Math.min(...values), Math.max(1, ...values), 4);
  const scaleY = plotH / (axisMax - axisMin);
  const stepX = plotW / (points.length - 1);
  const y = v => topPad + plotH - (v - axisMin) * scaleY;

  let gridSvg = '';
  for (let g = 0; g <= ticks; g++) {
    const val = axisMin + step * g;
    const gy = y(val);
    gridSvg += `<line class="grid-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${gy}" y2="${gy}" />`;
    gridSvg += `<text x="${leftPad - 8}" y="${gy + 3}" text-anchor="end">${Math.round(val)}</text>`;
  }
  // Meerdere updates op dezelfde dag -> label met tijd i.p.v. alleen datum,
  // anders staan er dubbele/onleesbare labels onder elkaar.
  const dateCounts = {};
  points.forEach(p => { dateCounts[p.week] = (dateCounts[p.week] || 0) + 1; });
  const xLabel = p => dateCounts[p.week] > 1 ? fmtDate(p.savedAt).split(', ')[1] : p.week.slice(5);
  const xLabels = points.map((p, i) => `<text x="${leftPad + i * stepX}" y="${topPad + plotH + 18}" text-anchor="middle">${esc(xLabel(p))}</text>`).join('');

  const linePts = points.map((p, i) => `${leftPad + i * stepX},${y(p.value)}`).join(' ');
  const markers = points.map((p, i) => {
    const cx = leftPad + i * stepX, cy = y(p.value);
    return `<circle class="tile-trend-pt" data-label="${esc(fmtDate(p.savedAt))}" data-val="${p.value}" cx="${cx}" cy="${cy}" r="3.5" fill="var(--series-1)" />`;
  }).join('');

  return `<svg class="chart-svg tile-trend-svg" viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}">
      <line class="axis-line" x1="${leftPad}" x2="${leftPad}" y1="${topPad}" y2="${topPad + plotH}" />
      <line class="axis-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${topPad + plotH}" y2="${topPad + plotH}" />
      ${gridSvg}
      <polyline points="${linePts}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      ${markers}
      ${xLabels}
    </svg>`;
}

function renderStatTiles(current, mutations) {
  const el = document.getElementById('stat-tiles');
  const total = current.length;
  const filters = statTileFilters();
  const expiredDateCount = current.filter(filters.verlopenDatum.test).length;
  const overdueUnknown = current.filter(filters.unknown.test).length;
  const geblokkeerdCount = current.filter(filters.geblokkeerd.test).length;
  const tiles = [
    { key: 'totaal', icon: '📋', label: 'Totaal open', value: total, scrollTarget: 'ov-full-table-card' },
  ];
  OV_STATUS_ORDER.forEach(status => {
    const filterKey = OV_STATUS_FILTER_KEYS[status];
    const count = current.filter(filters[filterKey].test).length;
    tiles.push({ key: filterKey, icon: OV_STATUS_ICONS[status], label: status, value: count, filterKey });
  });
  tiles.push(
    { key: 'verlopenDatum', icon: '⏰', label: 'Uitvoeringsdatum verstreken', value: expiredDateCount, deltaClass: expiredDateCount > 0 ? 'bad' : 'good',
      note: expiredDateCount > 0 ? 'geplande datum is zelf ook al voorbij — zie Aandacht deze week' : 'geen', alert: expiredDateCount > 0, scrollTarget: 'attention-card' },
    { key: 'unknown', icon: '⛔', label: 'Verlopen — uitvoering onbekend', value: overdueUnknown, deltaClass: overdueUnknown > 0 ? 'bad' : 'good',
      note: overdueUnknown > 0 ? 'nog niets ingepland — zie Aandacht deze week' : 'geen', alert: overdueUnknown > 0, scrollTarget: 'attention-card' },
    { key: 'afgesloten', icon: '✅', label: 'Afgesloten / uitgegaan', value: mutations.hasPrevious ? mutations.uitgegaan.length : '—',
      note: mutations.hasPrevious ? 'sinds vorige update' : 'nog geen vorige update', scrollTarget: 'mutations-out' },
    { key: 'geblokkeerd', icon: '🔒', label: 'Geblokkeerd', value: geblokkeerdCount, note: 'Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt', filterKey: 'geblokkeerd' },
  );
  // Elke tegel is nu klikbaar: altijd voor het verloop-grafiekje in het
  // paneel hieronder, en (waar van toepassing) óók voor de rij-per-storing-
  // lijst of het wegscrollen naar het bijbehorende kaartje verderop.
  el.innerHTML = tiles.map(t => {
    const selected = state.statDetailFilter === t.key ? ' stat-tile-selected' : '';
    const hasList = OV_DETAIL_LIST_KEYS.has(t.key);
    const hint = (hasList ? 'Klik voor lijst + verloop' : 'Klik voor verloop') + (t.scrollTarget ? ' ↓' : '');
    const clickAttrs = ` data-stat-filter="${t.key}"${t.scrollTarget ? ` data-scroll-target="${t.scrollTarget}"` : ''} tabindex="0" role="button" aria-expanded="${state.statDetailFilter === t.key}"`;
    return `
    <div class="stat-tile stat-tile-clickable${t.alert ? ' stat-tile-alert' : ''}${selected}" data-stat-key="${t.key}"${clickAttrs}>
      <div class="stat-tile-icon${t.deltaClass ? ' stat-tile-icon-' + t.deltaClass : ''}" aria-hidden="true">${t.icon}</div>
      <div class="label">${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
      ${t.note ? `<div class="delta ${t.deltaClass || ''}">${esc(t.note)}</div>` : ''}
      <div class="stat-tile-hint">${hint}</div>
    </div>`;
  }).join('');

  const activate = (key) => {
    const opening = state.statDetailFilter !== key;
    if (!opening) {
      state.statDetailFilter = null;
      state.statDetailOrders = null;
    } else {
      state.statDetailFilter = key;
      // Bevriest welke orders erin zitten op het moment van openen — anders
      // verdwijnt een rij meteen uit beeld zodra je 'm hier bewerkt (bv. een
      // blokkade-reden instellen bij "Verlopen — uitvoering onbekend" haalt
      // 'm per definitie uit die lijst). Alleen relevant voor tegels met een
      // eigen lijst — de rest toont straks alleen het verloop-grafiekje.
      state.statDetailOrders = OV_DETAIL_LIST_KEYS.has(key) ? current.filter(statTileFilters()[key].test).map(s => s.order) : null;
    }
    renderStatTiles(current, mutations);
    return opening;
  };
  el.querySelectorAll('[data-stat-filter]').forEach(tile => {
    const key = tile.dataset.statFilter;
    const scrollTarget = tile.dataset.scrollTarget;
    // Alleen scrollen bij het ÓPENEN van het paneel — anders spring je bij het
    // sluiten (nogmaals klikken) ineens weg van waar je net was.
    const handle = () => { if (activate(key) && scrollTarget) scrollToAndHighlight(scrollTarget); };
    tile.addEventListener('click', handle);
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handle(); }
    });
  });

  renderStatDetail(current, mutations);
}

// Eén korte, menselijke zin bovenaan die samenvat hoe de week ervoor staat —
// zodat je niet meteen 10 tegels hoeft door te rekenen om te weten of er iets
// te doen is. "Actie nodig" volgt dezelfde telling als "Aandacht deze week"
// hieronder (ATTENTION_CATEGORIES), zodat de twee nooit uit de pas lopen.
function renderWeekSummaryBanner(current, mutations) {
  const el = document.getElementById('week-summary-banner');
  if (!el) return;
  const total = current.length;
  const filters = statTileFilters();
  const attentionCount = current.filter(s => ATTENTION_CATEGORIES.some(cat => filters[cat.key].test(s))).length;

  let mood, icon, text;
  if (attentionCount === 0) {
    mood = 'good'; icon = '🎉';
    text = total > 0
      ? `Niets vraagt deze week om actie — alle <strong>${total}</strong> open ${total === 1 ? 'storing ligt' : 'storingen liggen'} op schema.`
      : 'Niets vraagt deze week om actie.';
  } else {
    mood = 'attention'; icon = '⚡';
    text = `<strong>${attentionCount}</strong> van de <strong>${total}</strong> open ${total === 1 ? 'storing' : 'storingen'} ${attentionCount === 1 ? 'vraagt' : 'vragen'} deze week om actie — zie "Aandacht deze week" hieronder.`;
  }
  if (mutations.hasPrevious) {
    text += ` Sinds vorige week: <strong>${mutations.nieuw.length}</strong> nieuw binnengekomen, <strong>${mutations.uitgegaan.length}</strong> afgesloten.`;
  }

  el.className = `week-summary-banner week-summary-${mood}`;
  el.innerHTML = `<span class="week-summary-icon" aria-hidden="true">${icon}</span><p>${text}</p>`;
}

// Toont (indien een klikbare tegel is aangeklikt) de exacte lijst van
// storingen daarachter, zodat je niet handmatig door de hele tabel hoeft te
// zoeken naar welke opdrachten het precies betreft.
function renderStatDetail(current, mutations) {
  const container = document.getElementById('overdue-detail');
  const filterKey = state.statDetailFilter;
  if (!filterKey) { container.classList.add('hidden'); container.innerHTML = ''; return; }

  const hasList = OV_DETAIL_LIST_KEYS.has(filterKey);
  container.classList.remove('hidden');

  // Bij "Geblokkeerd" kun je de blokkade-reden direct hier aanpassen. Tegels
  // zonder eigen lijst (Totaal, de 2 rode tegels, Afgesloten) tonen alleen het
  // verloop-grafiekje — hun storingen staan toch al in "Aandacht deze
  // week"/"Volledige lijst"/"Mutaties", een 2e tabel zou dat dubbelop tonen.
  const showBlock = filterKey === 'geblokkeerd' && !isStaticExport;

  let badgeCount, body;
  if (hasList) {
    const orderSet = new Set(state.statDetailOrders || []);
    const list = current.filter(s => orderSet.has(s.order));
    badgeCount = list.length;
    const firstSeenMap = firstSeenWeekMap();
    body = list.length === 0
      ? '<p class="empty-note">Geen storingen in deze lijst.</p>'
      : `<div class="table-scroll"><table><thead><tr>
          <th>Order</th><th>Regio</th><th>Gebied</th><th>Status</th><th>Adres</th><th class="num">Dagen</th><th>Open sinds</th><th>Type</th><th>Uitvoering</th>${showBlock ? '<th>Blokkade</th>' : ''}
        </tr></thead><tbody>${list.map(s => {
          const block = ovBlockStatusOf(s.order);
          const blockCell = `
            <select class="ov-block-select" data-order="${esc(s.order)}">
              <option value="" ${!block.reason ? 'selected' : ''}>— Geen —</option>
              <option value="rezap" ${block.reason === 'rezap' ? 'selected' : ''}>Aannemerij</option>
              <option value="aanleg" ${block.reason === 'aanleg' ? 'selected' : ''}>Naar Aanleg</option>
              <option value="uitvoerder" ${block.reason === 'uitvoerder' ? 'selected' : ''}>Uitvoerder</option>
              <option value="onderzoek" ${block.reason === 'onderzoek' ? 'selected' : ''}>Onderzoek loopt</option>
            </select>
            ${block.reason ? `<input type="text" class="ov-block-note" data-order="${esc(s.order)}" placeholder="Toelichting (optioneel)" value="${esc(block.note || '')}">` : ''}
            ${blockSinceHtml(s.order)}`;
          return `<tr>
          <td>${esc(s.order)}</td>
          <td>${esc(regioGroupLabel(regioGroupOf(s)))}</td>
          <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
          <td>${ovStatusPillHtml(s)}</td>
          <td>${esc(s.city)} — ${esc(s.street)}, ${esc(s.postcode)}</td>
          <td class="num">${renderDaysPill(s)}</td>
          <td>${firstSeenMap[s.order] ? esc(firstSeenMap[s.order]) : '—'}</td>
          <td>${esc(s.type)}</td>
          <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
          ${showBlock ? `<td class="ov-block-cell">${blockCell}</td>` : ''}
        </tr>`;
        }).join('')}</tbody></table></div>`;
  } else {
    badgeCount = filterKey === 'totaal' ? current.length
      : filterKey === 'afgesloten' ? (mutations.hasPrevious ? mutations.uitgegaan.length : 0)
      : current.filter(statTileFilters()[filterKey].test).length;
    body = '';
  }

  const chartHtml = tileTrendChartHtml(ovTileTrendSeries(filterKey));

  container.innerHTML = `
    <div class="card-header">
      <h3>${esc(OV_TILE_TITLES[filterKey])} <span class="badge">${badgeCount}</span></h3>
      <button class="btn-link" id="close-overdue-detail">Sluiten ✕</button>
    </div>
    <div class="tile-trend-chart">${chartHtml}</div>
    ${body}`;

  container.querySelectorAll('.tile-trend-pt').forEach(pt => {
    pt.addEventListener('mouseenter', e => showTooltip(e, `<strong>${esc(pt.dataset.label)}</strong><br>${esc(pt.dataset.val)}`));
    pt.addEventListener('mousemove', moveTooltip);
    pt.addEventListener('mouseleave', hideTooltip);
  });

  if (showBlock) {
    const refresh = async (order) => {
      await saveOvBlockStatusMap(state.ovBlockStatus, order);
      renderDashboardFromState();
    };
    container.querySelectorAll('.ov-block-select').forEach(sel => {
      sel.addEventListener('change', () => {
        setOvBlockReason(sel.dataset.order, sel.value);
        refresh(sel.dataset.order);
      });
    });
    container.querySelectorAll('.ov-block-note').forEach(inp => {
      inp.addEventListener('change', () => {
        setOvBlockNote(inp.dataset.order, inp.value);
        refresh(inp.dataset.order);
      });
    });
  }

  document.getElementById('close-overdue-detail').addEventListener('click', () => {
    state.statDetailFilter = null;
    state.statDetailOrders = null;
    renderStatTiles(current, mutations);
  });
}

// statusClass hergebruikt de bestaande status-pill-kleuren (geen nieuwe
// kleuren) zodat de ernst van elke categorie in één oogopslag te zien is:
// rood (critical) is het dringendst, geel (warning) het minst.
const ATTENTION_CATEGORIES = [
  { key: 'unknown', label: 'Geen uitvoeringsdatum', prio: 0, statusClass: 'critical' },
  { key: 'verlopenDatum', label: 'Uitvoeringsdatum verstreken', prio: 1, statusClass: 'serious' },
  { key: 'bijnaVerlopen', label: 'Bijna verlopen', prio: 2, statusClass: 'warning' },
];

// Voegt de drie losse "actie nodig"-categorieën (Bijna verlopen, Uitvoerings-
// datum verstreken, Verlopen zonder plan) samen tot één geprioriteerde lijst
// met bewerkbare blokkade-reden — dit is de plek om te zien én te bewerken
// wat er deze week om actie vraagt; de bijbehorende tegels hierboven zijn nu
// puur tellers, zonder eigen (dubbele) uitklaplijst.
//
// current: de lijst na de actieve regiotab-filter (bepaalt wélke rijen hier
// zichtbaar zijn — wissel je van regiotab, dan wisselt deze lijst gewoon mee).
// allVisible: de volledige, regio-ongefilterde lijst — hierop wordt de
// bevroren snapshot (state.attentionOrders) gebouwd/ververst, zodat storingen
// uit ándere regio's dan de net-actieve tab niet uit de bevriezing vallen
// (anders zou terugswitchen naar "Totaal" ze kwijt kunnen zijn).
function renderAttentionList(current, allVisible) {
  const container = document.getElementById('attention-list');
  const countEl = document.getElementById('attention-count');
  const filters = statTileFilters();
  const firstSeenMap = firstSeenWeekMap();

  // De teller telt altijd exact mee wat op dit moment actie vraagt (daalt
  // meteen zodra je iets blokkeert), maar welke rijen getoond worden ligt
  // vast (zie state.attentionOrders hierboven) zodat een rij niet middenin
  // het bewerken van de blokkade-reden ineens verdwijnt.
  const liveCount = current.filter(s => ATTENTION_CATEGORIES.some(cat => filters[cat.key].test(s))).length;
  countEl.textContent = liveCount ? String(liveCount) : '';

  if (!state.attentionOrders) {
    const fresh = [];
    allVisible.forEach(s => {
      for (const cat of ATTENTION_CATEGORIES) {
        if (filters[cat.key].test(s)) { fresh.push({ order: s.order, catKey: cat.key }); break; }
      }
    });
    state.attentionOrders = fresh;
  }
  // orderMap komt uit `current` (regio-gefilterd): een bevroren order die niet
  // in de actieve regiotab valt, wordt hier vanzelf weggefilterd.
  const orderMap = new Map(current.map(s => [s.order, s]));
  // Eenmaal geblokkeerd verdwijnt een storing meteen uit deze lijst (ook al
  // was hij deze week al bevroren opgenomen) — vanaf dat moment is hij alleen
  // nog te vinden via de "Geblokkeerd"-tegel. Wordt de blokkade weer
  // opgeheven, dan duikt hij hier vanzelf weer op (nog steeds bevroren op
  // dezelfde categorie van deze week).
  const items = state.attentionOrders
    .map(({ order, catKey }) => ({ s: orderMap.get(order), cat: ATTENTION_CATEGORIES.find(c => c.key === catKey) }))
    .filter(it => it.s && !isOvBlocked(it.s));
  items.sort((a, b) => a.cat.prio - b.cat.prio || a.s.daysLeft - b.s.daysLeft);

  // Voor het "Kopieer order + categorie"-knopje — precies de rijen die nu op
  // het scherm staan, tab-gescheiden zodat het als 2 kolommen in Excel/Sheets
  // plakt, zonder de rest van de tabel (adres, dagen, type, …) mee te kopiëren.
  container.dataset.copyText = items.map(({ s, cat }) => `${s.order}\t${cat.label}`).join('\n');

  if (items.length === 0) {
    container.innerHTML = '<p class="all-clear"><span class="all-clear-icon" aria-hidden="true">🎉</span>Niets dat om actie vraagt deze week — goed bezig!</p>';
    return;
  }

  container.innerHTML = `<table><thead><tr>
      <th>Categorie</th><th>Order</th><th>Regio</th><th>Gebied</th><th>Status</th><th>Adres</th><th class="num">Dagen</th><th>Open sinds</th><th>Type</th><th>Uitvoering</th>${isStaticExport ? '' : '<th>Blokkade</th>'}
    </tr></thead><tbody>${items.map(({ s, cat }) => {
      const block = ovBlockStatusOf(s.order);
      const blockCell = isStaticExport ? '' : `<td class="ov-block-cell">
          <select class="ov-block-select" data-order="${esc(s.order)}">
            <option value="" ${!block.reason ? 'selected' : ''}>— Geen —</option>
            <option value="rezap" ${block.reason === 'rezap' ? 'selected' : ''}>Aannemerij</option>
            <option value="aanleg" ${block.reason === 'aanleg' ? 'selected' : ''}>Naar Aanleg</option>
            <option value="uitvoerder" ${block.reason === 'uitvoerder' ? 'selected' : ''}>Uitvoerder</option>
            <option value="onderzoek" ${block.reason === 'onderzoek' ? 'selected' : ''}>Onderzoek loopt</option>
          </select>
          ${block.reason ? `<input type="text" class="ov-block-note" data-order="${esc(s.order)}" placeholder="Toelichting (optioneel)" value="${esc(block.note || '')}">` : ''}
          ${blockSinceHtml(s.order)}
        </td>`;
      return `<tr>
        <td><span class="status-pill ${cat.statusClass}">${esc(cat.label)}</span></td>
        <td>${esc(s.order)}</td>
        <td>${esc(regioGroupLabel(regioGroupOf(s)))}</td>
        <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
        <td>${ovStatusPillHtml(s)}</td>
        <td>${esc(s.city)} — ${esc(s.street)}, ${esc(s.postcode)}</td>
        <td class="num">${renderDaysPill(s)}</td>
        <td>${firstSeenMap[s.order] ? esc(firstSeenMap[s.order]) : '—'}</td>
        <td>${esc(s.type)}</td>
        <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
        ${blockCell}
      </tr>`;
    }).join('')}</tbody></table>`;

  if (!isStaticExport) {
    const refresh = (order) => {
      saveOvBlockStatusMap(state.ovBlockStatus, order).then(() => {
        renderDashboardFromState();
      });
    };
    container.querySelectorAll('.ov-block-select').forEach(sel => {
      sel.addEventListener('change', () => {
        setOvBlockReason(sel.dataset.order, sel.value);
        refresh(sel.dataset.order);
      });
    });
    container.querySelectorAll('.ov-block-note').forEach(inp => {
      inp.addEventListener('change', () => {
        setOvBlockNote(inp.dataset.order, inp.value);
        refresh(inp.dataset.order);
      });
    });
  }
}

// Gemiddelde doorlooptijd: voor elke storing die tussen twee opeenvolgende
// opgeslagen weken uit de (gefilterde) OV NUS-lijst verdween, de tijd tussen
// de eerst-geziene week en de week van verdwijnen. Geeft een beeld van of de
// achterstand structureel groeit of krimpt, los van de wekelijkse
// momentopname.
function resolvedDurations() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  const visibleOf = (list) => filterByActive(typeFiltered(list));
  const firstSeen = {};
  const results = [];
  snaps.forEach((sn, i) => {
    const curOrders = new Set(visibleOf(sn.storingen).map(s => s.order));
    if (i > 0) {
      const prevOrders = visibleOf(snaps[i - 1].storingen).map(s => s.order);
      prevOrders.forEach(order => {
        if (!curOrders.has(order) && firstSeen[order]) {
          const days = Math.round((new Date(sn.week) - new Date(firstSeen[order])) / 86400000);
          results.push({ week: sn.week, order, days });
        }
      });
    }
    visibleOf(sn.storingen).forEach(s => { if (!(s.order in firstSeen)) firstSeen[s.order] = sn.week; });
  });
  return results;
}

function renderDoorlooptijdCard() {
  const el = document.getElementById('doorlooptijd-card-body');
  if (!el) return;
  const durations = resolvedDurations();
  if (durations.length === 0) {
    el.innerHTML = '<p class="empty-note">Nog geen storingen uit de lijst verdwenen sinds we zijn gaan meten — kom hier later op terug.</p>';
    return;
  }
  const avg = durations.reduce((sum, d) => sum + d.days, 0) / durations.length;
  let trendHtml = '';
  if (durations.length >= 4) {
    const half = Math.floor(durations.length / 2);
    const avgOf = (list) => list.reduce((s, d) => s + d.days, 0) / list.length;
    const diff = avgOf(durations.slice(half)) - avgOf(durations.slice(0, half));
    if (Math.abs(diff) >= 0.5) {
      trendHtml = `<div class="delta ${diff < 0 ? 'good' : 'bad'}">${diff < 0 ? '↓' : '↑'} ${Math.abs(diff).toFixed(1)} dagen ${diff < 0 ? 'sneller' : 'langzamer'} dan de oudere helft van de metingen</div>`;
    }
  }
  el.innerHTML = `
    <div class="value">${avg.toFixed(1)} dagen</div>
    <div class="muted small">Gemiddelde doorlooptijd van ${durations.length} storing${durations.length === 1 ? '' : 'en'} die sinds het begin van de metingen uit de lijst zijn verdwenen (van eerst gezien tot niet meer aanwezig).</div>
    ${trendHtml}`;
}

/* ---------- Rendering: gebied → plaatsen overzicht ---------- */

// Per (gebiedscode, plaats)-combinatie een klein dashboard op zich, bedoeld
// om structurele probleemplekken op te sporen — niet alleen "waar komt veel
// vandaan", maar ook "waar blijft het structureel liggen":
// - totaal: unieke storingen ooit gezien (Set, dus een storing die meerdere
//   weken blijft openstaan telt maar één keer).
// - nuOpen/geblokkeerd/actieNodig: momentopname van de nieuwste week —
//   "actieNodig" is exact dezelfde definitie als "Aandacht deze week"
//   (bijna verlopen / verlopen zonder plan / uitvoeringsdatum verstreken).
// - doorlooptijden: voor elke storing die ooit uit de (gefilterde) lijst
//   verdween, de tijd tussen eerst gezien en verdwijnen — toegeschreven aan
//   het gebied/plaats waar 'm het EERST gezien werd (zelfde aanpak als
//   resolvedDurations(), maar dan per gebied/plaats i.p.v. per regiofilter).
//   Een plek met weinig storingen die stelselmatig lang blijven liggen is
//   een groter probleem dan een drukke plek die snel wordt opgelost — vandaar
//   dat dit los van "totaal" wordt getoond.
function buildGebiedPlaatsenStats() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt));
  const stats = {};
  const ensure = (gebiedscode, plaats) => {
    const k = gebiedscode + '|||' + plaats;
    if (!stats[k]) stats[k] = { gebiedscode, plaats, orders: new Set(), doorlooptijden: [], nuOpen: 0, geblokkeerd: 0, actieNodig: 0 };
    return stats[k];
  };
  const firstSeen = {}; // order -> { week, gebiedscode, plaats }
  snaps.forEach((sn, i) => {
    const curOrders = new Set();
    sn.storingen.forEach(s => {
      if (!s.gebiedscode) return;
      const plaats = s.city || 'Onbekend';
      curOrders.add(s.order);
      ensure(s.gebiedscode, plaats).orders.add(s.order);
      if (!(s.order in firstSeen)) firstSeen[s.order] = { week: sn.week, gebiedscode: s.gebiedscode, plaats };
    });
    if (i > 0) {
      snaps[i - 1].storingen.forEach(s => {
        if (!s.gebiedscode || curOrders.has(s.order)) return;
        const fs = firstSeen[s.order];
        if (!fs) return;
        const days = Math.round((new Date(sn.week) - new Date(fs.week)) / 86400000);
        if (days >= 0) ensure(fs.gebiedscode, fs.plaats).doorlooptijden.push(days);
      });
    }
  });
  const latest = snaps[snaps.length - 1];
  if (latest) {
    const filters = statTileFilters();
    latest.storingen.forEach(s => {
      if (!s.gebiedscode) return;
      const entry = ensure(s.gebiedscode, s.city || 'Onbekend');
      entry.nuOpen++;
      if (isOvBlocked(s)) entry.geblokkeerd++;
      if (filters.unknown.test(s) || filters.verlopenDatum.test(s) || filters.bijnaVerlopen.test(s)) entry.actieNodig++;
    });
  }
  return Object.values(stats);
}

const GEBIED_STATS_COLUMNS = [
  { key: 'regio', label: 'Regio', cell: r => `<td>${esc(regioGroupLabel(r.regio))}</td>` },
  { key: 'gebiedscode', label: 'Gebiedscode', cell: r => `<td>${esc(r.gebiedscode)}</td>` },
  { key: 'plaats', label: 'Plaats', cell: r => `<td>${esc(r.plaats)}</td>` },
  { key: 'totaal', label: 'Totaal ooit', num: true, cell: r => `<td class="num">${r.totaal}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num">${r.nuOpen}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(1) + ' dgn'}</td>` },
  { key: 'geblokkeerd', label: 'Geblokkeerd nu', num: true, cell: r => `<td class="num">${r.geblokkeerd}</td>` },
  { key: 'actieNodig', label: 'Actie nodig nu', num: true, cell: r => `<td class="num">${r.actieNodig}</td>` },
];

function renderGebiedPlaatsenCard() {
  const container = document.getElementById('gebied-plaatsen-body');
  if (!container) return;
  const stats = buildGebiedPlaatsenStats();
  if (stats.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen gebiedscodes bekend — deze verschijnen zodra je een paste met gebiedscodes verwerkt.</p>';
    return;
  }
  const rows = stats
    .map(s => ({
      gebiedscode: s.gebiedscode,
      plaats: s.plaats,
      regio: regioGroupOf({ gebiedscode: s.gebiedscode }),
      totaal: s.orders.size,
      nuOpen: s.nuOpen,
      geblokkeerd: s.geblokkeerd,
      actieNodig: s.actieNodig,
      doorlooptijd: s.doorlooptijden.length ? s.doorlooptijden.reduce((a, b) => a + b, 0) / s.doorlooptijden.length : null,
    }))
    .sort((a, b) => a.gebiedscode.localeCompare(b.gebiedscode) || a.plaats.localeCompare(b.plaats));
  const sorted = sortByState(rows, state.gebiedSortState);
  renderFullTable(container, sorted, GEBIED_STATS_COLUMNS, state.gebiedSortState);
}

// Alleen deze 4 WV'ers zijn relevant genoeg om apart te volgen — andere
// namen worden genegeerd. De brontekst bevat volledige namen (bv. "Jarda C.
// Duyff", "Patricia Winkels", "Dulani G.M. Polman"), dus matcht op het eerste
// woord van de naamregel. "Conor" komt in de brontekst voor als "C. D.
// Loughman" (geen letterlijke "Conor"), dus die matcht op de achternaam.
// Matcht ongeacht hoofd-/kleine letters, toont altijd deze nette schrijfwijze.
const WV_NAAM_MATCHERS = [
  { naam: 'Jarda', re: /^jarda\b/i },
  { naam: 'Patricia', re: /^patricia\b/i },
  { naam: 'Dulani', re: /^dulani\b/i },
  { naam: 'Conor', re: /\bloughman\b/i },
];
function normalizeWvNaam(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  const match = WV_NAAM_MATCHERS.find(m => m.re.test(trimmed));
  return match ? match.naam : null;
}
// Kijkt naar alle naamregels van een storing (s.names), niet alleen de 1e —
// een storing heeft niet altijd 2 namen (dan blijft s.wvNaam leeg terwijl de
// relevante naam wél als enige naamregel aanwezig is) en de positie van de
// WV'er-naam is niet gegarandeerd altijd dezelfde. Zo mist deze telling geen
// storingen puur omdat de naam op een andere plek staat dan verwacht.
function findRelevantWvNaam(s) {
  for (const raw of s.names || []) {
    const naam = normalizeWvNaam(raw);
    if (naam) return naam;
  }
  return null;
}

// Per relevante WV'er: hoeveel unieke storingen ooit gezien (Set, dus een
// storing die meerdere weken openstaat telt maar één keer) en de gemiddelde
// doorlooptijd (van eerst gezien tot niet meer aanwezig — zelfde aanpak als
// resolvedDurations()/buildGebiedPlaatsenStats(), nu gegroepeerd per
// persoon). Geen gebiedsuitsplitsing: de indeling wie welk gebied doet ligt
// al vast (Dulani/Patricia = Haarlem, Conor = Leiden), dus dat voegt hier
// niets toe.
function buildWvStats() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt));
  const stats = {};
  const ensure = (naam) => {
    if (!stats[naam]) stats[naam] = { wvNaam: naam, orders: new Set(), doorlooptijden: [] };
    return stats[naam];
  };
  const firstSeen = {}; // order -> { week, wvNaam }
  snaps.forEach((sn, i) => {
    const curOrders = new Set();
    sn.storingen.forEach(s => {
      const naam = findRelevantWvNaam(s);
      if (!naam) return;
      curOrders.add(s.order);
      ensure(naam).orders.add(s.order);
      if (!(s.order in firstSeen)) firstSeen[s.order] = { week: sn.week, wvNaam: naam };
    });
    if (i > 0) {
      snaps[i - 1].storingen.forEach(s => {
        const naam = findRelevantWvNaam(s);
        if (!naam || curOrders.has(s.order)) return;
        const fs = firstSeen[s.order];
        if (!fs) return;
        const days = Math.round((new Date(sn.week) - new Date(fs.week)) / 86400000);
        if (days >= 0) ensure(fs.wvNaam).doorlooptijden.push(days);
      });
    }
  });
  return Object.values(stats);
}

const WV_STATS_COLUMNS = [
  { key: 'wvNaam', label: "WV'er", cell: r => `<td>${esc(r.wvNaam)}</td>` },
  { key: 'totaal', label: 'Totaal aantal storingen', num: true, cell: r => `<td class="num">${r.totaal}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(1) + ' dgn'}</td>` },
];

function renderWvGebiedCard() {
  const container = document.getElementById('wv-gebied-body');
  if (!container) return;
  // Nooit WV'er-namen in de gedeelde teamexport laten belanden — ook niet
  // verstopt in de broncode achter een dichtgeklapt <details>-blok. De kaart
  // zelf is in de export ook via CSS verborgen (zie .static-export
  // #wv-gebied-card), maar dit zorgt ervoor dat de namen sowieso nooit in de
  // HTML terechtkomen, ongeacht CSS.
  if (isStaticExport) { container.innerHTML = ''; return; }
  const stats = buildWvStats();
  if (stats.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen storingen gevonden voor de gevolgde WV\'ers.</p>';
    return;
  }
  const rows = stats
    .map(s => ({
      wvNaam: s.wvNaam,
      totaal: s.orders.size,
      doorlooptijd: s.doorlooptijden.length ? s.doorlooptijden.reduce((a, b) => a + b, 0) / s.doorlooptijden.length : null,
    }))
    .sort((a, b) => a.wvNaam.localeCompare(b.wvNaam));
  const sorted = sortByState(rows, state.wvSortState);
  renderFullTable(container, sorted, WV_STATS_COLUMNS, state.wvSortState);
}

/* ---------- Rendering: regio chart ---------- */

function renderRegioChart(current) {
  const container = document.getElementById('regio-chart');
  const byRegio = {};
  current.forEach(s => {
    const r = regioGroupOf(s);
    if (!byRegio[r]) byRegio[r] = { good: 0, warning: 0, serious: 0, critical: 0, total: 0 };
    byRegio[r][statusOf(s)]++;
    byRegio[r].total++;
  });
  const regios = sortByGroupOrder(Object.keys(byRegio));

  if (regios.length === 0) { container.innerHTML = '<p class="empty-note">Geen data.</p>'; return; }

  if (state.regioViewMode === 'table') {
    let rows = regios.map(r => {
      const b = byRegio[r];
      return `<tr><td>${esc(regioGroupLabel(r))}</td><td class="num">${b.good}</td><td class="num">${b.warning}</td><td class="num">${b.serious}</td><td class="num">${b.critical}</td><td class="num">${b.total}</td></tr>`;
    }).join('');
    container.innerHTML = `<table><thead><tr><th>Regio</th><th class="num">Op tijd</th><th class="num">Aandacht</th><th class="num">Bijna verlopen</th><th class="num">Verlopen</th><th class="num">Totaal</th></tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }

  const barW = 44, gap = 36, leftPad = 40, topPad = 16, plotH = 200, bottomPad = 34;
  const chartW = Math.max(360, regios.length * (barW + gap) + leftPad);
  const chartH = topPad + plotH + bottomPad;
  const maxTotal = Math.max(...regios.map(r => byRegio[r].total), 1);
  const niceMax = Math.ceil(maxTotal / 5) * 5 || 5;
  const scale = plotH / niceMax;

  let gridSvg = '';
  for (let g = 0; g <= 5; g++) {
    const val = (niceMax / 5) * g;
    const y = topPad + plotH - val * scale;
    gridSvg += `<line class="grid-line" x1="${leftPad}" x2="${chartW}" y1="${y}" y2="${y}" />`;
    gridSvg += `<text x="${leftPad - 8}" y="${y + 3}" text-anchor="end">${Math.round(val)}</text>`;
  }

  let bars = '';
  regios.forEach((r, idx) => {
    const b = byRegio[r];
    const x = leftPad + idx * (barW + gap) + gap / 2;
    let yCursor = topPad + plotH;
    STATUS_ORDER.forEach(st => {
      const val = b[st];
      if (val <= 0) return;
      const h = val * scale;
      const yTop = yCursor - h;
      bars += `<rect class="seg" data-regio="${esc(regioGroupLabel(r))}" data-status="${st}" data-count="${val}"
        x="${x}" y="${yTop + 1}" width="${barW}" height="${Math.max(h - 2, 0)}" rx="3"
        fill="var(--status-${st})" />`;
      yCursor = yTop;
    });
    bars += `<text x="${x + barW / 2}" y="${topPad + plotH + 20}" text-anchor="middle">${esc(regioGroupLabel(r))}</text>`;
    bars += `<text x="${x + barW / 2}" y="${topPad + plotH - b.total * scale - 6}" text-anchor="middle" style="fill:var(--text-primary);font-weight:600;">${b.total}</text>`;
  });

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}">
      <line class="axis-line" x1="${leftPad}" x2="${leftPad}" y1="${topPad}" y2="${topPad + plotH}" />
      ${gridSvg}
      ${bars}
    </svg>
    <div class="legend">
      ${STATUS_ORDER.map(st => `<span class="legend-item"><span class="legend-swatch" style="background:var(--status-${st})"></span>${STATUS_ICONS[st]} ${STATUS_LABELS[st]}</span>`).join('')}
    </div>`;

  container.querySelectorAll('.seg').forEach(rect => {
    rect.addEventListener('mouseenter', e => showTooltip(e, `<strong>${esc(rect.dataset.regio)}</strong><br>${STATUS_LABELS[rect.dataset.status]}: ${rect.dataset.count}`));
    rect.addEventListener('mousemove', moveTooltip);
    rect.addEventListener('mouseleave', hideTooltip);
  });
}

/* ---------- Rendering: trend chart ---------- */

function renderTrendChart(snapshots) {
  const container = document.getElementById('trend-chart');
  if (snapshots.length < 2) {
    container.innerHTML = '<p class="empty-note">Verwerk minstens twee weken om een trend te zien.</p>';
    return;
  }

  // Volgt de actieve filtertab: bij "Totaal" alle regio's naast elkaar, bij een
  // gekozen regio alleen die ene lijn.
  const visiblePerSnapshot = snapshots.map(sn => filterByActive(typeFiltered(sn.storingen)));
  const regios = sortByGroupOrder(Array.from(new Set(visiblePerSnapshot.flatMap(list => list.map(s => regioGroupOf(s))))));
  const series = {};
  regios.forEach(r => { series[r] = visiblePerSnapshot.map(list => list.filter(s => regioGroupOf(s) === r).length); });

  if (state.trendViewMode === 'table') {
    let head = `<th>Week</th>` + regios.map(r => `<th class="num">${esc(regioGroupLabel(r))}</th>`).join('');
    let rows = snapshots.map((sn, wi) => `<tr><td>${esc(sn.week)}</td>${regios.map(r => `<td class="num">${series[r][wi]}</td>`).join('')}</tr>`).join('');
    container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
    return;
  }

  const leftPad = 40, rightPad = 100, topPad = 16, plotH = 200, bottomPad = 34;
  const plotW = Math.max(360, snapshots.length * 70);
  const chartW = leftPad + plotW + rightPad;
  const chartH = topPad + plotH + bottomPad;
  const allValues = regios.flatMap(r => series[r]);
  const { min: axisMin, max: axisMax, step, ticks } = niceAxisRange(Math.min(...allValues), Math.max(1, ...allValues), 5);
  const scaleY = plotH / (axisMax - axisMin);
  const stepX = snapshots.length > 1 ? plotW / (snapshots.length - 1) : 0;
  const y = v => topPad + plotH - (v - axisMin) * scaleY;

  let gridSvg = '';
  for (let g = 0; g <= ticks; g++) {
    const val = axisMin + step * g;
    const gy = y(val);
    gridSvg += `<line class="grid-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${gy}" y2="${gy}" />`;
    gridSvg += `<text x="${leftPad - 8}" y="${gy + 3}" text-anchor="end">${Math.round(val)}</text>`;
  }
  let xLabels = snapshots.map((sn, wi) => `<text x="${leftPad + wi * stepX}" y="${topPad + plotH + 20}" text-anchor="middle">${esc(sn.week.slice(5))}</text>`).join('');

  let lines = '';
  let markers = '';
  regios.forEach(r => {
    const color = REGIO_GROUP_COLOR[r];
    const pts = series[r].map((v, wi) => `${leftPad + wi * stepX},${y(v)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
    series[r].forEach((v, wi) => {
      const cx = leftPad + wi * stepX, cy = y(v);
      markers += `<circle class="pt" data-regio="${esc(regioGroupLabel(r))}" data-week="${esc(snapshots[wi].week)}" data-val="${v}" cx="${cx}" cy="${cy}" r="4" fill="${color}" />`;
    });
    const lastX = leftPad + (series[r].length - 1) * stepX;
    const lastY = y(series[r][series[r].length - 1]);
    lines += `<text x="${lastX + 8}" y="${lastY + 4}" style="fill:${color};font-weight:600;">${esc(regioGroupLabel(r))}</text>`;
  });

  container.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}">
      <line class="axis-line" x1="${leftPad}" x2="${leftPad}" y1="${topPad}" y2="${topPad + plotH}" />
      <line class="axis-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${topPad + plotH}" y2="${topPad + plotH}" />
      ${gridSvg}
      ${lines}
      ${markers}
      ${xLabels}
    </svg>
    <div class="legend">
      ${regios.map(r => `<span class="legend-item"><span class="legend-swatch" style="background:${REGIO_GROUP_COLOR[r]}"></span>${esc(regioGroupLabel(r))}</span>`).join('')}
    </div>`;

  container.querySelectorAll('.pt').forEach(pt => {
    pt.addEventListener('mouseenter', e => showTooltip(e, `<strong>${esc(pt.dataset.regio)}</strong><br>${esc(pt.dataset.week)}: ${pt.dataset.val} open`));
    pt.addEventListener('mousemove', moveTooltip);
    pt.addEventListener('mouseleave', hideTooltip);
  });
}

/* ---------- Rendering: mutation tables ---------- */

function miniTable(list) {
  if (list.length === 0) return '<p class="empty-note">Geen mutaties.</p>';
  const rows = list.map(s => `<tr><td>${esc(s.order)}</td><td>${esc(regioOf(s))} — ${esc(s.street)}</td><td>${esc(s.type)}</td></tr>`).join('');
  return `<table><thead><tr><th>Order</th><th>Adres</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMutationTables(mutations) {
  document.getElementById('count-in').textContent = mutations.hasPrevious ? mutations.nieuw.length : '—';
  document.getElementById('count-out').textContent = mutations.hasPrevious ? mutations.uitgegaan.length : '—';
  if (!mutations.hasPrevious) {
    document.getElementById('table-in').innerHTML = '<p class="empty-note">Nog geen vorige week om mee te vergelijken.</p>';
    document.getElementById('table-out').innerHTML = '<p class="empty-note">Nog geen vorige week om mee te vergelijken.</p>';
    return;
  }
  document.getElementById('table-in').innerHTML = miniTable(mutations.nieuw);
  document.getElementById('table-out').innerHTML = miniTable(mutations.uitgegaan);
}

/* ---------- Rendering: full table ---------- */

// Gedeeld door "Volledige lijst": kop-opbouw, sorteerlogica en rij-opbouw uit
// een kolommen-config.
function sortByState(rows, sortState) {
  const { key, dir } = sortState;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'flags') { va = (a.flags || []).length; vb = (b.flags || []).length; }
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}
function renderFullTable(container, rows, columns, sortState, opts) {
  opts = opts || {};
  const head = (opts.leadHead || '') + columns.map(c => {
    const active = sortState.key === c.key ? (sortState.dir === 1 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${active}</th>`;
  }).join('');
  const body = rows.map(row => {
    const lead = opts.leadCell ? opts.leadCell(row) : '';
    const cells = columns.map(c => c.cell(row)).join('');
    const cls = opts.rowClass ? opts.rowClass(row) : '';
    return `<tr${cls ? ` class="${cls}"` : ''}>${lead}${cells}</tr>`;
  }).join('');
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Zoekt per ordernummer de vroegste opgeslagen week waarin die storing al
// voorkwam, zodat je in één oogopslag ziet hoe lang iets al meeloopt — los
// van de dagen-teller, die alleen het (mogelijk verlengde) target toont.
// Eén keer over alle weken heen opgebouwd i.p.v. per rij, voor snelheid.
function firstSeenWeekMapFor(snapshots) {
  const map = {};
  snapshots.slice().sort((a, b) => a.week.localeCompare(b.week)).forEach(sn => {
    sn.storingen.forEach(s => { if (!(s.order in map)) map[s.order] = sn.week; });
  });
  return map;
}
function firstSeenWeekMap() { return firstSeenWeekMapFor(state.snapshots); }

function ovBlockCellHtml(s) {
  const block = ovBlockStatusOf(s.order);
  if (isStaticExport) {
    return block.reason
      ? `<span class="status-pill">${esc(OV_BLOCK_REASON_LABELS[block.reason])}</span>${block.note ? `<div class="muted small">${esc(block.note)}</div>` : ''}${blockSinceHtml(s.order)}`
      : '<span class="muted small">— Geen —</span>';
  }
  return `
      <select class="ov-block-select" data-order="${esc(s.order)}">
        <option value="" ${!block.reason ? 'selected' : ''}>— Geen —</option>
        <option value="rezap" ${block.reason === 'rezap' ? 'selected' : ''}>Aannemerij</option>
        <option value="aanleg" ${block.reason === 'aanleg' ? 'selected' : ''}>Naar Aanleg</option>
        <option value="uitvoerder" ${block.reason === 'uitvoerder' ? 'selected' : ''}>Uitvoerder</option>
        <option value="onderzoek" ${block.reason === 'onderzoek' ? 'selected' : ''}>Onderzoek loopt</option>
      </select>
      ${block.reason ? `<input type="text" class="ov-block-note" data-order="${esc(s.order)}" placeholder="Toelichting (optioneel)" value="${esc(block.note || '')}">` : ''}
      ${blockSinceHtml(s.order)}`;
}

const OV_STATUS_SLUGS = { 'Nieuw': 'nieuw', 'In onderzoek': 'onderzoek', 'Onderzoek controleren': 'onderzoek-controleren', 'In voorbereiding': 'voorbereiding', 'Planning': 'planning', 'In uitvoering': 'uitvoering' };
function ovStatusPillHtml(s) {
  if (!s.ovStatus) return '<span class="muted small">—</span>';
  return `<span class="ov-status-pill ov-status-${OV_STATUS_SLUGS[s.ovStatus] || 'onbekend'}">${esc(s.ovStatus)}</span>`;
}

function buildOvColumns() {
  return [
    { key: 'regioGroup', label: 'Regio', cell: s => `<td>${esc(regioGroupLabel(s.regioGroup))}</td>` },
    { key: 'gebiedscode', label: 'Gebied', cell: s => `<td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>` },
    { key: 'ovStatus', label: 'Status', cell: s => `<td>${ovStatusPillHtml(s)}</td>` },
    { key: 'city', label: 'Plaats', cell: s => `<td>${esc(s.city)}</td>` },
    { key: 'street', label: 'Adres', cell: s => `<td>${esc(s.street)}, ${esc(s.postcode)}</td>` },
    { key: 'order', label: 'Order', cell: s => `<td>${esc(s.order)}</td>` },
    { key: 'asset', label: 'Asset', cell: s => `<td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>` },
    { key: 'wvNaam', label: "WV'er", cell: s => `<td>${s.wvNaam ? esc(s.wvNaam) : '—'}</td>` },
    { key: 'daysLeft', label: 'Dagen', num: true, cell: s => `<td class="num">${renderDaysPill(s)}</td>` },
    { key: 'firstSeenWeek', label: 'Open sinds', cell: s => `<td>${s.firstSeenWeek ? esc(s.firstSeenWeek) : '—'}</td>` },
    { key: 'executionDate', label: 'Uitvoering', cell: s => `<td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>` },
    { key: 'flags', label: 'Aanvragen', cell: s => `<td>${s.flags.length ? s.flags.map(f => `<span class="badge" title="${esc(FLAG_LABELS[f])}">${esc(f)}</span>`).join(' ') : '—'}</td>` },
    { key: 'type', label: 'Type', cell: s => `<td>${esc(s.type)}</td>` },
    { key: 'blockReasonLabel', label: 'Blokkade', cell: s => `<td class="ov-block-cell">${ovBlockCellHtml(s)}</td>` },
  ];
}

function renderTableAll(current) {
  const container = document.getElementById('table-all');
  if (current.length === 0) { container.innerHTML = '<p class="empty-note">Geen storingen.</p>'; return; }
  current = searchFiltered(current, state.searchQuery);
  if (current.length === 0) { container.innerHTML = '<p class="empty-note">Geen storingen gevonden voor deze zoekopdracht.</p>'; return; }
  const firstSeenMap = firstSeenWeekMap();
  const annotated = current.map(s => Object.assign({}, s, {
    regioGroup: regioGroupOf(s),
    blockReasonLabel: OV_BLOCK_REASON_LABELS[ovBlockStatusOf(s.order).reason] || '',
    firstSeenWeek: firstSeenMap[s.order] || '',
  }));
  const rows = sortByState(annotated, state.sortState);
  const columns = buildOvColumns();
  renderFullTable(container, rows, columns, state.sortState, {
    leadHead: isStaticExport ? '' : '<th class="checkbox-col"><input type="checkbox" id="ov-select-all" title="Alles selecteren"></th>',
    leadCell: isStaticExport ? null : s => `<td class="checkbox-col"><input type="checkbox" class="ov-row-select" data-order="${esc(s.order)}"${state.ovBulkSelected.has(s.order) ? ' checked' : ''}></td>`,
    rowClass: s => needsFollowUp(s) ? 'row-alert' : '',
  });

  container.querySelectorAll('.ov-block-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      setOvBlockReason(sel.dataset.order, sel.value);
      await saveOvBlockStatusMap(state.ovBlockStatus, sel.dataset.order);
      renderDashboardFromState();
    });
  });
  container.querySelectorAll('.ov-block-note').forEach(inp => {
    inp.addEventListener('change', async () => {
      setOvBlockNote(inp.dataset.order, inp.value);
      await saveOvBlockStatusMap(state.ovBlockStatus, inp.dataset.order);
      renderDashboardFromState();
    });
  });

  // Bulkselectie: meerdere lang openstaande storingen in één keer dezelfde
  // blokkade-reden geven, zonder ze één voor één te hoeven aanklikken.
  if (!isStaticExport) {
    const visibleOrders = rows.map(s => s.order);
    const selectAll = document.getElementById('ov-select-all');
    if (selectAll) {
      selectAll.checked = visibleOrders.length > 0 && visibleOrders.every(o => state.ovBulkSelected.has(o));
      selectAll.addEventListener('change', () => {
        if (selectAll.checked) visibleOrders.forEach(o => state.ovBulkSelected.add(o));
        else visibleOrders.forEach(o => state.ovBulkSelected.delete(o));
        container.querySelectorAll('.ov-row-select').forEach(cb => { cb.checked = state.ovBulkSelected.has(cb.dataset.order); });
        renderOvBulkBar();
      });
    }
    container.querySelectorAll('.ov-row-select').forEach(cb => {
      cb.addEventListener('change', () => {
        const order = cb.dataset.order;
        if (cb.checked) state.ovBulkSelected.add(order); else state.ovBulkSelected.delete(order);
        if (selectAll) selectAll.checked = visibleOrders.length > 0 && visibleOrders.every(o => state.ovBulkSelected.has(o));
        renderOvBulkBar();
      });
    });
    renderOvBulkBar();
  }
}

// Toont/verbergt de bulkactie-balk boven de OV NUS-tabel en houdt de teller
// bij — los van de tabel zelf gerenderd, zodat 'm niet steeds herbouwd wordt.
function renderOvBulkBar() {
  const bar = document.getElementById('ov-bulk-bar');
  if (!bar) return;
  const n = state.ovBulkSelected.size;
  if (n === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  document.getElementById('ov-bulk-count').textContent = `${n} storing${n === 1 ? '' : 'en'} geselecteerd`;
}

/* ---------- Rendering: weeks list ---------- */

function renderWeeksList() {
  const container = document.getElementById('weeks-list');
  if (state.snapshots.length === 0) { container.innerHTML = '<p class="empty-note">Nog geen weken opgeslagen.</p>'; return; }
  // Meerdere updates op dezelfde datum kunnen naast elkaar bestaan (zie
  // "process-btn"-handler) — sorteren en verwijderen gebeurt daarom op het
  // exacte opslagmoment (savedAt), niet op de (mogelijk niet-unieke) datum.
  const rows = state.snapshots.slice().sort((a, b) => b.week.localeCompare(a.week) || b.savedAt.localeCompare(a.savedAt)).map(sn => `
    <div class="weeks-list-row">
      <span>Week van <strong>${esc(sn.week)}</strong> — ${sn.storingen.length} storingen (opgeslagen ${esc(fmtDate(sn.savedAt))})</span>
      <button class="btn-link danger" data-saved-at="${esc(sn.savedAt)}">Verwijderen</button>
    </div>`).join('');
  container.innerHTML = rows;
  container.querySelectorAll('button[data-saved-at]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Deze update verwijderen?')) return;
      const snaps = (await loadSnapshots()).filter(s => s.savedAt !== btn.dataset.savedAt);
      await saveSnapshots(snaps);
      state.snapshots = snaps;
      state.attentionOrders = null;
      if (snaps.length === 0) setDashboardEmpty('dashboard', 'dashboard-empty', true);
      else renderDashboardFromState();
      renderWeeksList();
    });
  });
}

async function updateStorageUsage() {
  const el = document.getElementById('storage-usage');
  if (!el) return;
  const estimate = await getStorageEstimate();
  if (!estimate || estimate.quota == null) {
    el.textContent = 'Opslag: kon het huidige gebruik niet opvragen in deze browser.';
    return;
  }
  const usedMb = estimate.usage / 1024 / 1024;
  const quotaMb = estimate.quota / 1024 / 1024;
  const pct = estimate.quota ? (estimate.usage / estimate.quota) * 100 : 0;
  const usedText = usedMb < 1 ? `${(estimate.usage / 1024).toFixed(0)} KB` : `${usedMb.toFixed(2)} MB`;
  el.textContent = `Huidige opslag: ${usedText} van ${quotaMb.toFixed(0)} MB beschikbaar (${pct.toFixed(2)}%).`;
}

/* ---------- Rendering: type-filter & regio-filters ---------- */

// Configuratie (in "Instellingen"): de lijst met meetellende types zelf.
function renderTypeWhitelist() {
  const listEl = document.getElementById('type-whitelist');
  if (state.typeWhitelist.length === 0) {
    listEl.innerHTML = '<p class="empty-note">Geen types ingesteld — alle storingen worden genegeerd totdat je er een toevoegt.</p>';
    return;
  }
  listEl.innerHTML = state.typeWhitelist.map(t => `
    <span class="type-chip">${esc(t)}<button class="remove-type" data-type="${esc(t)}" title="Verwijderen">×</button></span>
  `).join('');
  listEl.querySelectorAll('.remove-type').forEach(btn => {
    btn.addEventListener('click', async () => {
      state.typeWhitelist = state.typeWhitelist.filter(t => t !== btn.dataset.type);
      await saveTypeWhitelist(state.typeWhitelist);
      renderDashboardFromState();
    });
  });
}

function renderFilterTabs(latestVisible) {
  const container = document.getElementById('filter-tabs');
  const present = latestVisible ? sortByGroupOrder(Array.from(new Set(latestVisible.map(s => regioGroupOf(s))))) : [];
  if (!present.includes(state.activeFilter) && state.activeFilter !== 'Totaal') state.activeFilter = 'Totaal';
  const tabs = ['Totaal', ...present];
  container.innerHTML = tabs.map(t => {
    const active = state.activeFilter === t ? ' active' : '';
    return `<button class="filter-tab${active}" data-filter="${esc(t)}">${esc(t === 'Totaal' ? 'Totaal' : regioGroupLabel(t))}</button>`;
  }).join('');
  container.querySelectorAll('button[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.activeFilter = btn.dataset.filter;
      renderDashboardFromState();
    });
  });
}

/* ---------- Orchestration ---------- */

// Toont een vriendelijke "nog geen data"-kaart met knop naar Invoer i.p.v.
// een compleet leeg tabblad, voor wie voor het eerst op Data terechtkomt
// (of alle weken heeft verwijderd) vóórdat er iets geplakt is.
function setDashboardEmpty(dashboardId, emptyId, empty) {
  document.getElementById(dashboardId).classList.toggle('hidden', empty);
  const emptyEl = document.getElementById(emptyId);
  if (emptyEl) emptyEl.classList.toggle('hidden', !empty || isStaticExport);
}

function renderDashboardFromState() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  state.snapshots = snaps;
  if (snaps.length === 0) { setDashboardEmpty('dashboard', 'dashboard-empty', true); return; }
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;

  const latestVisible = typeFiltered(latest.storingen);
  const previousVisible = previous ? typeFiltered(previous.storingen) : null;

  renderTypeWhitelist();
  renderFilterTabs(latestVisible);

  const latestFiltered = filterByActive(latestVisible);
  const previousFiltered = previousVisible ? { storingen: filterByActive(previousVisible) } : null;
  const mutations = computeMutations(latestFiltered, previousFiltered);

  setDashboardEmpty('dashboard', 'dashboard-empty', false);
  renderWeekSummaryBanner(latestFiltered, mutations);
  renderStatTiles(latestFiltered, mutations);
  renderAttentionList(latestFiltered, latestVisible);
  renderDoorlooptijdCard();
  renderRegioChart(latestFiltered); // volgt de actieve filtertab (Totaal = alle regio's, anders alleen die regio)
  renderTrendChart(snaps); // idem, filtert zelf op state.activeFilter
  renderMutationTables(mutations);
  renderGebiedPlaatsenCard();
  renderWvGebiedCard();
  renderTableAll(latestFiltered);
  renderWeeksList();
  updateStorageUsage();
}

// Platte-tekst weekoverzicht (voor het "Kopieer weekoverzicht"-knopje) — kijkt
// altijd naar alle regio's, ongeacht welke regio-filtertab net toevallig
// actief staat, zodat het gedeelde overzicht altijd het complete plaatje is.
function buildWeekSummaryText() {
  if (state.snapshots.length === 0) return 'Nog geen gegevens verwerkt.';
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const latestVisible = typeFiltered(latest.storingen);
  const previousVisible = previous ? typeFiltered(previous.storingen) : null;
  const mutations = computeMutations(latestVisible, previousVisible ? { storingen: previousVisible } : null);
  const filters = statTileFilters();
  const count = key => latestVisible.filter(filters[key].test).length;

  const lines = [
    `NUS-weekoverzicht — ${fmtDate(latest.week)}`,
    '',
    `Totaal open: ${latestVisible.length}`,
  ];
  if (mutations.hasPrevious) {
    lines.push(`Nieuw binnengekomen: ${mutations.nieuw.length}`);
    lines.push(`Afgesloten / uitgegaan: ${mutations.uitgegaan.length}`);
  }
  lines.push(
    `Bijna verlopen: ${count('bijnaVerlopen')}`,
    `Verlopen — uitvoering gepland: ${count('known')}`,
    `Uitvoeringsdatum verstreken: ${count('verlopenDatum')}`,
    `Verlopen — uitvoering onbekend: ${count('unknown')}`,
  );
  OV_STATUS_ORDER.forEach(status => {
    const label = status === 'Nieuw' ? 'Nog niet eerder gezien (écht nieuw)' : `Status ${status}`;
    lines.push(`${label}: ${count(OV_STATUS_FILTER_KEYS[status])}`);
  });
  lines.push(`Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt): ${count('geblokkeerd')}`);
  return lines.join('\n');
}

// Verwijdert blokkade-reden-aantekeningen van orders die niet meer voorkomen
// in de meest recente week — voorkomt dat dit mapje onbeperkt blijft groeien
// met aantekeningen bij storingen die allang zijn afgesloten. De
// weekgegevens zelf blijven altijd bewaard.
function cleanupOldStatusData() {
  const latestOf = (snapshots) => {
    if (snapshots.length === 0) return [];
    return snapshots.slice().sort((a, b) => a.week.localeCompare(b.week)).pop().storingen;
  };
  const liveOrders = new Set(latestOf(state.snapshots).map(s => s.order));

  const blockRemoved = [];
  Object.keys(state.ovBlockStatus).forEach(order => {
    if (!liveOrders.has(order)) { delete state.ovBlockStatus[order]; blockRemoved.push(order); }
  });
  return { blockRemoved };
}

function showParseWarning(errors, okCount) {
  const el = document.getElementById('parse-warning');
  if (errors.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<strong>${errors.length} van de ${errors.length + okCount} blokken kon niet worden herkend.</strong>
    <details><summary>Bekijk details</summary>
      ${errors.map(e => `<div style="margin-top:8px;"><em>${esc(e.message)}</em><pre style="white-space:pre-wrap;font-size:0.75rem;">${esc(e.raw)}</pre></div>`).join('')}
    </details>`;
}

async function reloadAllStateAndRender() {
  state.attentionOrders = null;
  // Vóór ovBlockStatus geladen wordt: die functie kijkt naar
  // state.sharePointConfig om te bepalen of ze uit SharePoint of IndexedDB
  // moet lezen.
  state.sharePointConfig = await loadSharePointConfig();
  if (state.sharePointConfig.enabled && location.protocol === 'file:') {
    // Kan sowieso nooit werken vanaf een lokaal geopend bestand (zie
    // spAssertHostedProperly) — automatisch uitzetten voorkomt dat bij elke
    // wijziging opnieuw dezelfde onvermijdelijke foutmelding verschijnt.
    state.sharePointConfig.enabled = false;
    await saveSharePointConfig(state.sharePointConfig);
    showErrorToast('Gedeelde status via SharePoint is uitgezet: dit dashboard is lokaal geopend, niet vanaf de SharePoint-site, dus delen kan hier niet werken.');
  }
  state.snapshots = await loadSnapshots();
  state.typeWhitelist = await loadTypeWhitelist();
  state.ovBlockStatus = await loadOvBlockStatusMap();
  state.bijnaVerlopenThreshold = await loadBijnaVerlopenThreshold();
  if (state.snapshots.length > 0) renderDashboardFromState();
  else { setDashboardEmpty('dashboard', 'dashboard-empty', true); renderTypeWhitelist(); }
}

function wireEvents() {
  document.querySelectorAll('[data-goto-invoer]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab('invoer');
      const textarea = document.getElementById(btn.dataset.gotoInvoer);
      if (textarea) { textarea.scrollIntoView({ block: 'center' }); textarea.focus(); }
    });
  });

  document.getElementById('export-backup-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('backup-status');
    try {
      await exportBackup();
      statusEl.textContent = 'Back-up gedownload.';
    } catch (e) {
      statusEl.textContent = 'Exporteren mislukt: ' + e.message;
    }
  });

  document.getElementById('import-backup-btn').addEventListener('click', () => {
    document.getElementById('import-backup-input').click();
  });

  document.getElementById('export-static-btn').addEventListener('click', () => {
    const statusEl = document.getElementById('export-static-status');
    try {
      const html = buildStandaloneExport();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nus-dashboard-${new Date().toISOString().slice(0, 10)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      statusEl.textContent = 'Interactief dashboard gedownload.';
    } catch (e) {
      statusEl.textContent = 'Exporteren mislukt: ' + e.message;
    }
  });

  document.getElementById('cleanup-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('cleanup-status');
    if (!confirm('Blokkade-redenen opschonen voor orders die niet meer in de actuele lijst voorkomen? Weekgegevens blijven bewaard.')) return;
    const { blockRemoved } = cleanupOldStatusData();
    if (blockRemoved.length === 0) { statusEl.textContent = 'Niets om op te schonen.'; return; }
    await saveOvBlockStatusMap(state.ovBlockStatus, blockRemoved);
    statusEl.textContent = `${blockRemoved.length} verouderde aantekening${blockRemoved.length === 1 ? '' : 'en'} verwijderd.`;
    renderDashboardFromState();
  });

  document.getElementById('copy-summary-btn').addEventListener('click', async () => {
    const btn = document.getElementById('copy-summary-btn');
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(buildWeekSummaryText());
      btn.textContent = '✅ Gekopieerd!';
    } catch (e) {
      btn.textContent = '⚠️ Kopiëren mislukt';
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  document.getElementById('copy-attention-btn').addEventListener('click', async () => {
    const btn = document.getElementById('copy-attention-btn');
    const original = btn.textContent;
    const text = document.getElementById('attention-list').dataset.copyText || '';
    if (!text) { btn.textContent = 'Niets om te kopiëren'; setTimeout(() => { btn.textContent = original; }, 2000); return; }
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = '✅ Gekopieerd!';
    } catch (e) {
      btn.textContent = '⚠️ Kopiëren mislukt';
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  document.getElementById('import-backup-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Dit overschrijft alle huidige opgeslagen weken en instellingen (beide bakken) met de inhoud van dit back-upbestand. Doorgaan?')) return;
    const statusEl = document.getElementById('backup-status');
    try {
      await importBackup(file);
      await reloadAllStateAndRender();
      document.getElementById('bijna-verlopen-threshold-input').value = state.bijnaVerlopenThreshold;
      document.getElementById('sharepoint-site-url').value = state.sharePointConfig.siteUrl;
      document.getElementById('sharepoint-library-name').value = state.sharePointConfig.libraryName;
      document.getElementById('sharepoint-enabled-checkbox').checked = state.sharePointConfig.enabled;
      statusEl.textContent = 'Back-up hersteld.';
    } catch (e) {
      statusEl.textContent = 'Importeren mislukt: ' + e.message;
    }
  });

  document.getElementById('process-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('paste-input');
    const raw = textarea.value;
    const statusEl = document.getElementById('process-status');
    const week = document.getElementById('week-date').value;
    if (!raw.trim()) { statusEl.textContent = 'Plak eerst tekst.'; return; }
    if (!week) { statusEl.textContent = 'Kies een weekdatum.'; return; }

    const { storingen, errors } = parseText(raw);
    if (storingen.length === 0) {
      statusEl.textContent = 'Geen storingen herkend — controleer het formaat hieronder.';
      showParseWarning(errors, 0);
      return;
    }

    // Elke keer verwerken voegt een nieuw punt in de tijd toe (ook meerdere
    // keren per dag) i.p.v. een eerdere update van dezelfde datum te
    // overschrijven — zo blijft "Nieuw binnengekomen"/"Afgesloten" en de
    // doorlooptijd altijd de vergelijking met je vórige update, niet met
    // gisteren, ook als je vandaag al eerder bijgewerkt hebt.
    const snaps = await loadSnapshots();
    enrichWithCarriedForwardOvFields(storingen, snaps);
    const snapshot = { week, savedAt: new Date().toISOString(), storingen };
    snaps.push(snapshot);
    try {
      await saveSnapshots(snaps);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    state.snapshots = snaps;
    state.attentionOrders = null;

    renderDashboardFromState();
    showParseWarning(errors, storingen.length);
    statusEl.textContent = `${storingen.length} storingen verwerkt voor week ${week}` + (errors.length ? `, ${errors.length} regels niet herkend` : '');
    textarea.value = '';
  });

  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    if (!confirm('Alle opgeslagen weken verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    await clearSnapshots();
    state.snapshots = [];
    state.attentionOrders = null;
    setDashboardEmpty('dashboard', 'dashboard-empty', true);
  });

  document.querySelectorAll('.toggle-table').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'regio-chart') {
        state.regioViewMode = state.regioViewMode === 'chart' ? 'table' : 'chart';
        btn.textContent = state.regioViewMode === 'chart' ? 'Toon als tabel' : 'Toon als grafiek';
        const latest = state.snapshots[state.snapshots.length - 1];
        if (latest) renderRegioChart(filterByActive(typeFiltered(latest.storingen)));
      } else if (target === 'trend-chart') {
        state.trendViewMode = state.trendViewMode === 'chart' ? 'table' : 'chart';
        btn.textContent = state.trendViewMode === 'chart' ? 'Toon als tabel' : 'Toon als grafiek';
        renderTrendChart(state.snapshots);
      }
    });
  });

  document.getElementById('table-all').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.sortState.key === th.dataset.key) state.sortState.dir *= -1;
    else { state.sortState.key = th.dataset.key; state.sortState.dir = 1; }
    const latest = state.snapshots[state.snapshots.length - 1];
    if (latest) renderTableAll(filterByActive(typeFiltered(latest.storingen)));
  });

  document.getElementById('table-search').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    const latest = state.snapshots[state.snapshots.length - 1];
    if (latest) renderTableAll(filterByActive(typeFiltered(latest.storingen)));
  });

  document.getElementById('gebied-plaatsen-body').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.gebiedSortState.key === th.dataset.key) state.gebiedSortState.dir *= -1;
    else { state.gebiedSortState.key = th.dataset.key; state.gebiedSortState.dir = 1; }
    renderGebiedPlaatsenCard();
  });

  document.getElementById('wv-gebied-body').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.wvSortState.key === th.dataset.key) state.wvSortState.dir *= -1;
    else { state.wvSortState.key = th.dataset.key; state.wvSortState.dir = 1; }
    renderWvGebiedCard();
  });

  document.getElementById('ov-bulk-apply-btn').addEventListener('click', async () => {
    if (state.ovBulkSelected.size === 0) return;
    const reason = document.getElementById('ov-bulk-reason').value;
    const changedOrders = Array.from(state.ovBulkSelected);
    changedOrders.forEach(order => setOvBlockReason(order, reason));
    await saveOvBlockStatusMap(state.ovBlockStatus, changedOrders);
    state.ovBulkSelected.clear();
    renderDashboardFromState();
  });

  document.getElementById('ov-bulk-clear-btn').addEventListener('click', () => {
    state.ovBulkSelected.clear();
    document.querySelectorAll('.ov-row-select').forEach(cb => { cb.checked = false; });
    const selectAll = document.getElementById('ov-select-all');
    if (selectAll) selectAll.checked = false;
    renderOvBulkBar();
  });

  document.getElementById('add-type-btn').addEventListener('click', async () => {
    const input = document.getElementById('new-type-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.typeWhitelist.includes(val)) state.typeWhitelist.push(val);
    await saveTypeWhitelist(state.typeWhitelist);
    input.value = '';
    renderDashboardFromState();
  });

  document.getElementById('bijna-verlopen-threshold-input').addEventListener('change', async e => {
    const statusEl = document.getElementById('bijna-verlopen-threshold-status');
    const n = Math.round(Number(e.target.value));
    if (!Number.isFinite(n) || n < 1 || n > 14) {
      e.target.value = state.bijnaVerlopenThreshold;
      statusEl.textContent = 'Kies een waarde tussen 1 en 14.';
      return;
    }
    e.target.value = n;
    state.bijnaVerlopenThreshold = n;
    await saveBijnaVerlopenThreshold(n);
    statusEl.textContent = 'Opgeslagen.';
    if (state.snapshots.length > 0) renderDashboardFromState();
  });

  document.getElementById('sharepoint-test-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('sharepoint-status');
    const siteUrl = document.getElementById('sharepoint-site-url').value.trim();
    const libraryName = document.getElementById('sharepoint-library-name').value.trim();
    if (!siteUrl) { statusEl.textContent = 'Vul eerst een site-URL in.'; return; }
    statusEl.textContent = 'Bezig met testen…';
    try {
      await spTestConnection(siteUrl, libraryName);
      statusEl.textContent = `✅ Verbinding gelukt — bibliotheek "${libraryName || DEFAULT_SHAREPOINT_LIBRARY}" gevonden.`;
    } catch (e) {
      statusEl.textContent = '⚠️ Verbinding mislukt: ' + e.message;
    }
  });

  document.getElementById('sharepoint-save-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('sharepoint-status');
    const siteUrl = document.getElementById('sharepoint-site-url').value.trim();
    const libraryName = document.getElementById('sharepoint-library-name').value.trim();
    const enabled = document.getElementById('sharepoint-enabled-checkbox').checked;
    if (enabled && !siteUrl) { statusEl.textContent = 'Vul een site-URL in om gedeelde status in te schakelen.'; return; }
    try {
      const cfg = { siteUrl, enabled, libraryName };
      await saveSharePointConfig(cfg);
      state.sharePointConfig = cfg;
      // Blokkade-reden komt vanaf nu uit een andere bron (SharePoint of weer
      // terug naar lokaal) — opnieuw inladen zodat het scherm meteen klopt.
      state.ovBlockStatus = await loadOvBlockStatusMap();
      statusEl.textContent = 'Opgeslagen.';
      if (state.snapshots.length > 0) renderDashboardFromState();
    } catch (e) {
      statusEl.textContent = 'Opslaan mislukt: ' + e.message;
    }
  });
}

// Echte tabbladen: precies één paneel zichtbaar tegelijk, in plaats van één
// lange scrollpagina. De hash in de adresbalk (#/invoer, #/data,
// #/instellingen) is de bron van waarheid — dat geeft "gratis" een werkende
// terug-knop en een herlaad die op hetzelfde tabblad blijft staan, zonder een
// eigen sessionStorage-bijhoudmechanisme nodig te hebben.
const TAB_HASH_ROUTES = { invoer: '#/invoer', data: '#/data', gebieden: '#/gebieden', settings: '#/instellingen' };
const HASH_TO_TAB = { '#/invoer': 'invoer', '#/data': 'data', '#/gebieden': 'gebieden', '#/instellingen': 'settings' };

// Past alleen de zichtbare panelen/knoppen aan — geen hash-manipulatie hier,
// zodat dit ook veilig als reactie op een hashchange-event aangeroepen kan
// worden zonder een tweede navigatie te triggeren.
function applyTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('hidden', p.dataset.tabPanel !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

// Aangeroepen bij een klik op een navigatie-knop: past het paneel meteen
// (synchroon) toe — anders zou een aanroeper die er direct op vertrouwt dat
// het doelpaneel al zichtbaar is (bv. scrollIntoView/focus op "Naar Invoer")
// nog een fractie te vroeg komen, omdat een hash-wijziging pas ASYNCHROON een
// hashchange-event vuurt — en werkt daarna de hash bij voor de terug-knop.
function switchTab(tab) {
  applyTab(tab);
  const hash = TAB_HASH_ROUTES[tab] || TAB_HASH_ROUTES.data;
  if (location.hash !== hash) location.hash = hash;
}

// Aangeroepen bij laden en bij elke hashchange (terug/vooruit-knop, handmatig
// aangepaste of gedeelde link). Onbekende of (in de bekijk-alleen export)
// verborgen tabbladen vallen terug op "data".
function resolveTabFromHash() {
  const tab = HASH_TO_TAB[location.hash] || 'data';
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  applyTab((!btn || btn.classList.contains('hidden')) ? 'data' : tab);
}
function setupTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  window.addEventListener('hashchange', resolveTabFromHash);
  resolveTabFromHash();
}

function applyStaticExportData() {
  document.body.classList.add('static-export');
  const bannerEl = document.getElementById('static-export-banner');
  const exportedAt = STATIC_DATA.exportedAt ? fmtDate(STATIC_DATA.exportedAt) : null;
  bannerEl.textContent = 'Momentopname' + (exportedAt ? ` van ${exportedAt}` : '') + ' — bekijk-alleen. Voor de actuele versie of om iets aan te passen, ga naar degene die dit gedeeld heeft.';
  bannerEl.classList.remove('hidden');

  state.snapshots = STATIC_DATA.ovSnapshots || [];
  state.typeWhitelist = STATIC_DATA.typeWhitelist || [];
  state.ovBlockStatus = STATIC_DATA.ovBlockStatus || {};
  state.bijnaVerlopenThreshold = STATIC_DATA.bijnaVerlopenThreshold || DEFAULT_BIJNA_VERLOPEN_THRESHOLD;

  if (state.snapshots.length > 0) renderDashboardFromState();
  else setDashboardEmpty('dashboard', 'dashboard-empty', true);

  // Instellingen en Invoer hebben niets te doen in een bekijk-alleen export:
  // geen back-up, geen type-filter, geen naamlijsten, en niets om te plakken.
  const settingsBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsBtn) settingsBtn.classList.add('hidden');
  const invoerBtn = document.querySelector('.tab-btn[data-tab="invoer"]');
  if (invoerBtn) invoerBtn.classList.add('hidden');
}

async function init() {
  document.getElementById('week-date').value = new Date().toISOString().slice(0, 10);
  wireEvents();
  if (isStaticExport) applyStaticExportData();
  else await reloadAllStateAndRender();
  document.getElementById('bijna-verlopen-threshold-input').value = state.bijnaVerlopenThreshold;
  document.getElementById('sharepoint-site-url').value = state.sharePointConfig.siteUrl;
  document.getElementById('sharepoint-library-name').value = state.sharePointConfig.libraryName;
  document.getElementById('sharepoint-enabled-checkbox').checked = state.sharePointConfig.enabled;
  setupTabNav();
}

document.addEventListener('DOMContentLoaded', init);
