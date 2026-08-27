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

// Klantaanvragen (schakelverzoeken) staan in de Instandhoudingsapp onder hun
// eigen kopregel — "3 Nieuwe klantaanvragen", waarbij het getal per keer
// verschilt — en zijn verder identiek opgebouwd aan een storing: type,
// locatie, order, asset, dagen, gewenste datum. Ze horen niet bij de
// NUS-werkvoorraad (een aanvraag met nog 361 dagen zou elk cijfer scheeftrekken)
// maar moeten wel worden ingepland, dus ze worden apart bijgehouden.
//
// Twee onafhankelijke signalen, want een plakactie hoeft de kopregel niet mee
// te nemen: de kopregel zet alles erna op klantaanvraag, en een type dat met
// "Schakelen" begint is er altijd een — ook los geplakt.
const KLANTAANVRAAG_HEADER_RE = /klantaanvra/i;
const KLANTAANVRAAG_TYPE_RE = /^schakelen\b/i;

// Een losse regel "1" achter de naam van de uitvoerder is een markering, geen
// naam en geen vlaggetje. Wat die markering betekent hangt af van het type:
// bij "LS storing/schade" is het een sanering, bij elk ander type is het iets
// anders (aanleg bijvoorbeeld) en dat valt hier niet uit af te leiden. De
// parser legt daarom alleen het feit vast dat de markering er stond; de
// betekenis wordt verderop bepaald (zie isSanering).
const SANERING_MARKER_RE = /^1$/;

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
    if (lines[i] && /^(MSR|MSRG|LSKN|LSKOV)$/i.test(lines[i])) {
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
  const markering1 = middleLines.some(l => SANERING_MARKER_RE.test(l));
  const flagLines = middleLines.filter(l => flagLineRe.test(l));
  // De sanering-markering telt niet als naam: anders zou bij een storing met
  // alleen een uitvoerder ("Marc van Veen" + "1") die uitvoerder als WV'er
  // worden gelezen.
  const nameLines = middleLines.filter(l => !flagLineRe.test(l) && !SANERING_MARKER_RE.test(l));

  let wvNaam = null;
  if (nameLines.length >= 2) wvNaam = nameLines[0]; // 1e naam = WV'er; 2e = uitvoerder (genegeerd)

  let flags = [];
  flagLines.forEach(fl => { flags = flags.concat(decodeFlags(fl)); });
  flags = [...new Set(flags)];

  const storing = {
    type, city, street, postcode, order, asset, assetType,
    wvNaam, names: nameLines, flags, daysLeft, overdue, executionDate, executionDateRaw, markering1,
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
  let currentSoort = 'storing';
  while (i < lines.length) {
    // Combineer alle skip-checks in één lus: een gebiedscode/status kan vlak na
    // een titel-/tellingregel staan (of andersom), dus we blijven controleren tot
    // geen van de patronen meer matcht. Gebiedscode en status staan nooit
    // tegelijk in dezelfde paste (zie OV_STATUS_RE hierboven), maar allebei
    // blijven ook los van elkaar "sticky" gelden tot de volgende regel van dat
    // type verschijnt.
    while (i < lines.length && (GEBIEDSCODE_RE.test(lines[i]) || OV_STATUS_RE.test(lines[i]) || COUNT_HEADER_RE.test(lines[i]))) {
      if (GEBIEDSCODE_RE.test(lines[i])) { currentGebiedscode = lines[i]; currentSoort = 'storing'; }
      else if (OV_STATUS_RE.test(lines[i])) { currentOvStatus = normalizeOvStatus(lines[i]); currentSoort = 'storing'; }
      // Een gebiedscode of status komt alleen in de storingenlijst voor, dus
      // die zetten de soort terug; een tellingregel bepaalt welk blok volgt.
      else currentSoort = KLANTAANVRAAG_HEADER_RE.test(lines[i]) ? 'klantaanvraag' : 'storing';
      i++;
    }
    if (i >= lines.length) break;
    const start = i;
    try {
      const { storing, next } = parseOneEntry(lines, i);
      const aanvraag = currentSoort === 'klantaanvraag' || KLANTAANVRAAG_TYPE_RE.test(storing.type);
      storing.soort = aanvraag ? 'klantaanvraag' : 'storing';
      // Een klantaanvraag heeft geen OV-status en geen gebiedscode; die van de
      // storingen ervoor mogen er niet aan blijven plakken.
      storing.gebiedscode = aanvraag ? null : currentGebiedscode;
      storing.ovStatus = aanvraag ? null : currentOvStatus;
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

const STORAGE_KEY = 'nusdash_snapshots_v1';
const TYPE_WHITELIST_KEY = 'nusdash_type_whitelist_v1';

const DEFAULT_TYPE_WHITELIST = [
  'Stra[a]t[en] zonder OV Infra',
  'OV aansluitkabel',
  'Onveilige situatie/gehele wijk',
  'Mast geen spanning Infra',
  'OV Mof',
  'Branden overdag Infra',
  'LS storing/schade',
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
// Wanneer er voor het laatst een back-up is gedownload. Nieuwe, losstaande
// sleutel in dezelfde kv-store: geen versiewijziging, geen migratie, en oudere
// versies van de app negeren 'm gewoon. Ontbreekt de sleutel, dan gedraagt de
// app zich alsof er nog nooit een back-up is gemaakt — precies wat je wilt.
// Beschikbare capaciteit, om het benodigd tempo tegen af te kunnen zetten.
// Losstaande sleutel, net als de back-updatum: geen versiewijziging, en zonder
// ingevulde waarden gedraagt het dashboard zich precies als voorheen.
const CAPACITEIT_KEY = 'nusdash_capaciteit_v1';
const LEGE_CAPACITEIT = { meetdienst: 0, mio: 0 };
async function loadCapaciteit() {
  try {
    const v = await idbGet(CAPACITEIT_KEY);
    if (!v || typeof v !== 'object') return Object.assign({}, LEGE_CAPACITEIT);
    return {
      meetdienst: Number.isFinite(v.meetdienst) && v.meetdienst >= 0 ? v.meetdienst : 0,
      mio: Number.isFinite(v.mio) && v.mio >= 0 ? v.mio : 0,
    };
  } catch (e) { console.error(e); return Object.assign({}, LEGE_CAPACITEIT); }
}
async function saveCapaciteit(cap) {
  try { await idbSet(CAPACITEIT_KEY, cap); }
  catch (e) { showErrorToast('Opslaan van de capaciteit is mislukt: ' + e.message); }
}

const LAST_BACKUP_KEY = 'nusdash_last_backup_at_v1';
const BACKUP_HERINNERING_DAGEN = 7;
async function loadLastBackupAt() {
  try { return (await idbGet(LAST_BACKUP_KEY)) || null; }
  catch (e) { console.error(e); return null; }
}
async function saveLastBackupAt(iso) {
  try { await idbSet(LAST_BACKUP_KEY, iso); }
  catch (e) { console.error(e); }
}

// Handmatige classificatie van de "1"-markering bij een ander type dan
// LS storing/schade. Eigen sleutel, dus puur toevoegend: de momentopnamen
// blijven onaangeroerd, en zonder deze sleutel werkt alles gewoon door.
const MARKERING_KLASSE_KEY = 'nusdash_markering_klasse_v1';
const MARKERING_KLASSEN = { aanleg: 'Aanleg', sanering: 'Sanering', anders: 'Anders' };
async function loadMarkeringKlasseMap() {
  try { return (await idbGet(MARKERING_KLASSE_KEY)) || {}; }
  catch (e) { console.error(e); return {}; }
}
async function saveMarkeringKlasseMap(map) {
  try { await idbSet(MARKERING_KLASSE_KEY, map); }
  catch (e) { showErrorToast('Opslaan van de classificatie is mislukt: ' + e.message); throw e; }
}

const OV_BLOCK_STATUS_KEY = 'nusdash_ov_block_status_v1';
async function loadOvBlockStatusMap() {
  try { return (await idbGet(OV_BLOCK_STATUS_KEY)) || {}; }
  catch (e) { console.error(e); return {}; }
}
async function saveOvBlockStatusMap(map) {
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
    markeringKlasse: await loadMarkeringKlasseMap(),
    bijnaVerlopenThreshold: await loadBijnaVerlopenThreshold(),
    capaciteit: await loadCapaciteit(),
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
  await saveLastBackupAt(new Date().toISOString());
  state.lastBackupAt = await loadLastBackupAt();
  renderBackupReminder();
  renderBackupStatus();
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
    markeringKlasse: state.markeringKlasse,
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
  if (backup.ovBlockStatus && typeof backup.ovBlockStatus === 'object') await saveOvBlockStatusMap(backup.ovBlockStatus);
  if (backup.markeringKlasse && typeof backup.markeringKlasse === 'object') await saveMarkeringKlasseMap(backup.markeringKlasse);
  if (Number.isFinite(backup.bijnaVerlopenThreshold) && backup.bijnaVerlopenThreshold > 0) await saveBijnaVerlopenThreshold(backup.bijnaVerlopenThreshold);
  if (backup.capaciteit && typeof backup.capaciteit === 'object') await saveCapaciteit(backup.capaciteit);
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
// paste: ZZE9 en ZZE10 (A/B) zijn Regio Haarlem, ZZE5 t/m ZZE8 (A/B) zijn
// Regio Leiden. Alles wat daar niet in past — een ontbrekende code, een nieuw
// gebied, of een verschrijving — valt onder "Overig".
//
// Bewust twee opgesomde lijsten in plaats van "Haarlem, en al het andere is
// Leiden". Bij die catch-all belandde een onbekende of verkeerd overgenomen
// code geruisloos in Regio Leiden, waar 'm niemand als vreemde eend opmerkt;
// nu valt 'ie op als "Overig" (zie ook onbekendeGebiedscodes hieronder).
const REGIO_NUMMERS = { Haarlem: [9, 10], Leiden: [5, 6, 7, 8] };
const REGIO_GROUP_ORDER = ['Haarlem', 'Leiden', 'Overig'];
const REGIO_GROUP_COLOR = { Haarlem: 'var(--series-1)', Leiden: 'var(--series-2)', Overig: 'var(--series-other)' };

// Het nummer los uitlezen in plaats van op tekst vergelijken: met
// startsWith zou "ZZE1..." ook op "ZZE10" lijken en andersom.
function gebiedsNummerOf(gebiedscode) {
  const m = (gebiedscode || '').toUpperCase().match(/^ZZE\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
function regioGroupOf(s) {
  const nr = gebiedsNummerOf(s.gebiedscode);
  if (nr === null) return 'Overig';
  if (REGIO_NUMMERS.Haarlem.includes(nr)) return 'Haarlem';
  if (REGIO_NUMMERS.Leiden.includes(nr)) return 'Leiden';
  return 'Overig';
}

// Gebiedscodes die wél zijn ingevuld maar bij geen van beide regio's horen.
// Die wil je zien: het is óf een nieuw gebied dat in REGIO_NUMMERS moet, óf
// een typefout in de bron. Zonder signaal blijven ze onzichtbaar onder
// "Overig" hangen, samen met de storingen die helemaal geen code hebben.
function onbekendeGebiedscodes() {
  const codes = new Set();
  chronoSnapshots().forEach(sn => {
    typeFiltered(sn.storingen).forEach(s => {
      if (!s.gebiedscode) return;
      const nr = gebiedsNummerOf(s.gebiedscode);
      if (nr === null || (!REGIO_NUMMERS.Haarlem.includes(nr) && !REGIO_NUMMERS.Leiden.includes(nr))) {
        codes.add(s.gebiedscode);
      }
    });
  });
  return Array.from(codes).sort();
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

// Klantaanvragen zijn geen NUS-storingen: ze horen in geen enkel storingscijfer
// thuis (een schakelverzoek met nog 361 dagen zou elke telling, grafiek en
// prognose scheeftrekken). Ze worden hier op één plek buitengesloten, zodat
// alles wat via typeFiltered loopt automatisch klopt; ze krijgen hun eigen
// kaart op de Data-tab.
function isKlantaanvraag(s) { return s.soort === 'klantaanvraag'; }

// Alleen "LS storing/schade" mét de markering is een sanering. Eerder telde
// elke storing met een "1" mee, waardoor er saneringen verschenen die het niet
// konden zijn (straten zonder OV bijvoorbeeld).
//
// Het veld heette in oudere momentopnamen `sanering`, maar bevatte precies
// hetzelfde ruwe feit: er stond een "1" in de tekst. Beide worden gelezen,
// zodat al opgeslagen data meteen goed wordt geteld zonder opnieuw te plakken.
const LS_STORING_TYPE_RE = /ls\s+storing\s*\/\s*schade/i;
function heeftMarkering1(s) { return !!(s.markering1 || s.sanering); }
function isLsStoringSchade(s) { return LS_STORING_TYPE_RE.test(s.type || ''); }

function isSanering(s) {
  // Een handmatige classificatie gaat altijd voor: bij een ander type kan het
  // dashboard niet weten wat de markering betekent, dus dat oordeel is aan jou.
  const klasse = markeringKlasseVan(s.order);
  if (klasse) return klasse === 'sanering';
  return heeftMarkering1(s) && isLsStoringSchade(s);
}

// Een markering bij een ander type dan LS storing/schade: dat is geen sanering,
// maar wél iets bijzonders (meestal aanleg). Zolang er geen oordeel over is
// geveld blijft het zichtbaar staan, zodat het niet stilzwijgend als gewone
// storing wegzakt.
function vraagtClassificatie(s) {
  return heeftMarkering1(s) && !isLsStoringSchade(s) && !markeringKlasseVan(s.order);
}
// "LS storing/schade" staat alleen in de lijst om de saneringen eruit te
// halen; zonder de markering is het geen werk voor deze werkvoorraad. Het type
// moet daarom wél in het type-filter staan (anders komt de sanering niet
// binnen), maar de regels zonder markering tellen niet mee.
function telAlsStoring(s) {
  if (isKlantaanvraag(s) || !isTypeIncluded(s)) return false;
  if (isLsStoringSchade(s) && !isSanering(s)) return false;
  return true;
}
function typeFiltered(list) { return list.filter(telAlsStoring); }

// Hoeveel LS storing/schade-regels om die reden buiten beeld blijven — puur om
// het te kunnen benoemen, zodat het geen stille aftrek is.
function lsZonderMarkeringNu() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return 0;
  return snaps[snaps.length - 1].storingen
    .filter(s => !isKlantaanvraag(s) && isTypeIncluded(s) && isLsStoringSchade(s) && !isSanering(s)).length;
}

// Een sanering staat er hetzelfde in als elke andere "LS storing/schade", dus
// zonder merkteken zie je in een lijst niet welke het zijn. Hetzelfde geldt
// voor de markeringen die nog een oordeel nodig hebben.
function saneringBadgeHtml(s) {
  if (isSanering(s)) return ' <span class="badge badge-sanering">sanering</span>';
  const klasse = markeringKlasseVan(s.order);
  if (klasse) return ` <span class="badge">${esc(MARKERING_KLASSEN[klasse])}</span>`;
  if (vraagtClassificatie(s)) return ' <span class="badge badge-classificeren">1 · classificeren</span>';
  return '';
}

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
  if (!previous) return { nieuw: [], uitgegaan: [], hasPrevious: false, vorigeDag: null };
  const curOrders = new Set(current.map(s => s.order));
  const prevOrders = new Set(previous.storingen.map(s => s.order));
  const nieuw = current.filter(s => !prevOrders.has(s.order));
  const uitgegaan = previous.storingen.filter(s => !curOrders.has(s.order));
  return { nieuw, uitgegaan, hasPrevious: true, vorigeDag: previous.week || null };
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

// Alleen de dag. Een meetdag is een kalenderdag ('2026-08-17'); fmtDate zou
// daar een 00:00 achter plakken die er niet is en die suggereert dat het
// tijdstip iets betekent. Het jaartal alleen waar de ruimte het toelaat —
// in een kolomkop kost het alleen maar breedte.
function fmtDag(iso, metJaar) {
  if (!iso) return '—';
  const d = new Date(iso);
  const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  return `${d.getDate()} ${months[d.getMonth()]}${metJaar ? ' ' + d.getFullYear() : ''}`;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

/* ---------- State ---------- */

const state = {
  snapshots: [],
  typeWhitelist: [],
  activeFilter: 'Totaal',
  sortState: { key: 'daysLeft', dir: 1 },
  gebiedSortState: { key: 'nuOpen', dir: -1 },
  gebiedOpen: new Set(),
  wvSortState: { key: 'nuOpen', dir: -1 },
  lastBackupAt: null,
  capaciteit: { meetdienst: 0, mio: 0 },
  stagnatieSortState: { key: 'ratio', dir: -1 },
  historieQuery: '',
  historieSortState: { key: 'eerst', dir: -1 },
  recidiveMode: 'straat',
  clusterMode: 'pc4',
  kaartPlaats: null,
  lijstSoort: 'nus',
  markeringKlasse: {},
  lijstHerkend: null,
  lijstSaneringenInTekst: 0,
  lijstHandmatig: false,
  kaartView: null,
  inUitPeriode: '30',
  mioLeeftijdFilter: 'alles',
  recidiveSortState: { key: 'aantal', dir: -1 },
  recidiveOpen: new Set(),
  regioViewMode: 'chart',
  trendViewMode: 'chart',
  trendGroep: 'regio',
  trendPeriode: '30',
  statDetailFilter: null,
  statDetailOrders: null,
  ovBlockStatus: {},
  searchQuery: '',
  // Bevriest welke orders + categorie in "Aandacht deze week" staan, zodat
  // een rij niet meteen verdwijnt zodra je 'm daar blokkeert (zelfde reden als
  // state.statDetailOrders hierboven). Wordt op null gezet bij echte
  // datawijzigingen (nieuwe week verwerkt/verwijderd, back-up hersteld) zodat
  // de lijst dan opnieuw wordt opgebouwd.
  attentionOrders: null,
  bijnaVerlopenThreshold: DEFAULT_BIJNA_VERLOPEN_THRESHOLD,
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
function markeringKlasseVan(order) {
  const k = (state.markeringKlasse || {})[order];
  return MARKERING_KLASSEN[k] ? k : null;
}
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
// "Mast geen spanning Infra" is het type waarbij een MIO-ploeg er in veel
// gevallen alleen op af kan, zonder Meetdienst. Ruim gematcht (hoofdletters en
// extra spaties variëren in de bron) maar wel op de hele woordgroep, zodat
// alleen dit type meetelt.
const MIO_TYPE_RE = /mast\s+geen\s+spanning/i;
function isMastGeenSpanning(s) { return MIO_TYPE_RE.test(s.type || ''); }

function statTileFilters() {
  const filters = {
    known: { title: 'Verlopen — uitvoering gepland', test: s => s.overdue && !!s.executionDate && !isExpiredExecutionDate(s) && !isOvBlocked(s) },
    verlopenDatum: { title: 'Uitvoeringsdatum verstreken', test: s => isActionableExpiredDate(s) },
    unknown: { title: 'Verlopen — uitvoering onbekend', test: s => isActionableOverdue(s) },
    bijnaVerlopen: { title: 'Bijna verlopen', test: s => statusOf(s) === 'serious' && !isOvBlocked(s) },
    geblokkeerd: { title: 'Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt)', test: s => isOvBlocked(s) },
    mastGeenSpanning: { title: 'Mast geen spanning', test: s => isMastGeenSpanning(s) },
    sanering: { title: 'Sanering', test: s => isSanering(s) },
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
const OV_DETAIL_LIST_KEYS = new Set([...Object.values(OV_STATUS_FILTER_KEYS), 'geblokkeerd', 'mastGeenSpanning', 'sanering']);
const OV_TILE_TITLES = {
  totaal: 'Totaal open',
  verlopenDatum: 'Uitvoeringsdatum verstreken',
  unknown: 'Verlopen — uitvoering onbekend',
  afgesloten: 'Afgesloten / uitgegaan',
  geblokkeerd: 'Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt)',
  mastGeenSpanning: 'Mast geen spanning',
  sanering: 'Sanering',
};
OV_STATUS_ORDER.forEach(status => { OV_TILE_TITLES[OV_STATUS_FILTER_KEYS[status]] = `Status: ${status}`; });
OV_TILE_TITLES[OV_STATUS_FILTER_KEYS['Nieuw']] = 'Nieuw binnengekomen (nog niet eerder gezien)';

// Berekent het verloop van één tegel over alle opgeslagen OV-momenten heen,
// mét de actieve regiotab (net als de tegel zelf). "afgesloten" is een
// uitzondering: dat is een verschil tússen opeenvolgende momenten (wat is
// verdwenen), geen standenmeting op één moment, dus dat telt per paar.
function ovTileTrendSeries(key) {
  const snaps = chronoSnapshots();
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
  const mioCount = current.filter(filters.mastGeenSpanning.test).length;
  const saneringCount = current.filter(filters.sanering.test).length;
  // Drie soorten getallen die er eerder als één uniforme rij uitzagen, terwijl
  // ze niet bij elkaar optellen en niet hetzelfde betekenen:
  //  - werkvoorraad: het totaal en de statussen die samen dat totaal vormen;
  //  - signalen: risicocategorieën die dwars door die statussen heen lopen en
  //    elkaar ook onderling overlappen;
  //  - mutatie: "opgelost" is geen stand maar een verandering sinds gisteren.
  // Door ze te scheiden is meteen duidelijk wat wél en niet bij elkaar optelt.
  const tiles = [
    { groep: 'voorraad', key: 'totaal', icon: '📋', label: 'Totaal open', value: total, scrollTarget: 'ov-full-table-card' },
  ];
  OV_STATUS_ORDER.forEach(status => {
    const filterKey = OV_STATUS_FILTER_KEYS[status];
    const count = current.filter(filters[filterKey].test).length;
    tiles.push({ groep: 'voorraad', key: filterKey, icon: OV_STATUS_ICONS[status], label: status, value: count, filterKey });
  });
  tiles.push(
    { groep: 'signaal', key: 'verlopenDatum', icon: '⏰', label: 'Uitvoeringsdatum verstreken', value: expiredDateCount, deltaClass: expiredDateCount > 0 ? 'bad' : 'good',
      note: expiredDateCount > 0 ? 'geplande datum is zelf ook al voorbij — zie Vraagt om actie' : 'geen', alert: expiredDateCount > 0, scrollTarget: 'attention-card' },
    { groep: 'signaal', key: 'unknown', icon: '⛔', label: 'Verlopen — uitvoering onbekend', value: overdueUnknown, deltaClass: overdueUnknown > 0 ? 'bad' : 'good',
      note: overdueUnknown > 0 ? 'nog niets ingepland — zie Vraagt om actie' : 'geen', alert: overdueUnknown > 0, scrollTarget: 'attention-card' },
    { groep: 'mutatie', key: 'afgesloten', icon: '✅', label: 'Afgesloten / uitgegaan', value: mutations.hasPrevious ? mutations.uitgegaan.length : '—',
      note: mutations.hasPrevious ? `sinds ${mutations.vorigeDag || 'de vorige update'}` : 'nog geen eerdere dag' },
    { groep: 'inzet', key: 'mastGeenSpanning', icon: '🗼', label: 'Mast geen spanning', value: mioCount,
      note: total > 0 ? `${Math.round((mioCount / total) * 100)}% van alle open storingen` : 'geen open storingen', scrollTarget: 'cluster-card' },
    { groep: 'inzet', key: 'sanering', icon: '🧹', label: 'Sanering', value: saneringCount,
      note: total > 0 ? `${Math.round((saneringCount / total) * 100)}% van alle open storingen` : 'geen open storingen' },
    { groep: 'signaal', key: 'geblokkeerd', icon: '🔒', label: 'Geblokkeerd', value: geblokkeerdCount, note: 'Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt', filterKey: 'geblokkeerd' },
  );
  // Elke tegel is nu klikbaar: altijd voor het verloop-grafiekje in het
  // paneel hieronder, en (waar van toepassing) óók voor de rij-per-storing-
  // lijst of het wegscrollen naar het bijbehorende kaartje verderop.
  const tegelHtml = (t) => {
    const selected = state.statDetailFilter === t.key ? ' stat-tile-selected' : '';
    const hasList = OV_DETAIL_LIST_KEYS.has(t.key);
    const hint = (hasList ? 'Klik voor lijst + verloop' : 'Klik voor verloop') + (t.scrollTarget ? ' ↓' : '');
    const clickAttrs = ` data-stat-filter="${t.key}"${t.scrollTarget ? ` data-scroll-target="${t.scrollTarget}"` : ''} tabindex="0" role="button" aria-expanded="${state.statDetailFilter === t.key}"`;
    // Een tegel op nul is meestal goed nieuws en hoeft niet net zo hard te
    // roepen als een tegel met werk erin — hij blijft leesbaar, maar treedt
    // terug zodat je oog naar de aantallen gaat die er wél toe doen.
    const nul = t.value === 0 ? ' stat-tile-zero' : '';
    return `
    <div class="stat-tile stat-tile-clickable${t.alert ? ' stat-tile-alert' : ''}${nul}${selected}" data-stat-key="${t.key}"${clickAttrs}>
      <div class="stat-tile-icon${t.deltaClass ? ' stat-tile-icon-' + t.deltaClass : ''}" aria-hidden="true">${t.icon}</div>
      <div class="label">${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
      ${t.note ? `<div class="delta ${t.deltaClass || ''}">${esc(t.note)}</div>` : ''}
      <div class="stat-tile-hint">${hint}</div>
    </div>`;
  };
  const GROEPEN = [
    { key: 'voorraad', label: 'Werkvoorraad', uitleg: 'De statussen tellen samen op tot het totaal.' },
    { key: 'signaal', label: 'Signalen', uitleg: 'Lopen dwars door de statussen heen en kunnen elkaar overlappen.' },
    { key: 'inzet', label: 'Inzet', uitleg: 'Indeling op type, voor de planning — telt niet op bij de statussen.' },
    { key: 'mutatie', label: `Sinds ${mutations.vorigeDag || 'de vorige update'}`, uitleg: '' },
  ];
  el.innerHTML = GROEPEN.map(g => {
    const inGroep = tiles.filter(t => t.groep === g.key);
    if (inGroep.length === 0) return '';
    return `
      <div class="stat-group stat-group-${g.key}">
        <h3 class="stat-group-head">${esc(g.label)}${g.uitleg ? ` <span class="stat-group-note">${esc(g.uitleg)}</span>` : ''}</h3>
        <div class="stat-row">${inGroep.map(tegelHtml).join('')}</div>
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
      ? `Niets vraagt nu om actie — alle <strong>${total}</strong> open ${total === 1 ? 'storing ligt' : 'storingen liggen'} op schema.`
      : 'Niets vraagt nu om actie.';
  } else {
    mood = 'attention'; icon = '⚡';
    text = `<strong>${attentionCount}</strong> van de <strong>${total}</strong> open ${total === 1 ? 'storing' : 'storingen'} ${attentionCount === 1 ? 'vraagt' : 'vragen'} om actie — zie "Vraagt om actie" hieronder.`;
  }
  if (mutations.hasPrevious) {
    text += ` Sinds ${mutations.vorigeDag ? esc(mutations.vorigeDag) : 'de vorige update'}: <strong>${mutations.nieuw.length}</strong> nieuw binnengekomen, <strong>${mutations.uitgegaan.length}</strong> opgelost.`;
  }

  el.className = `week-summary-banner week-summary-${mood}`;
  el.innerHTML = `<span class="week-summary-icon" aria-hidden="true">${icon}</span><p>${text}</p>`;
}

// Toont (indien een klikbare tegel is aangeklikt) de exacte lijst van
// storingen daarachter, zodat je niet handmatig door de hele tabel hoeft te
// zoeken naar welke opdrachten het precies betreft.
// Sub-filter binnen de "Mast geen spanning"-lijst: hoe lang staat de storing
// al in beeld. Elke mast moet één keer in de ISH-app worden nagekeken om te
// bepalen of 'ie met of zonder Meetdienst kan; wie dat dagelijks bijhoudt wil
// alleen de storingen zien die er sinds de vorige keer bij zijn gekomen, niet
// telkens de hele lijst opnieuw.
//
// "Eerst gezien" is de dag waarop het ordernummer voor het eerst in een update
// stond — niet de datum waarop de storing in werkelijkheid is ontstaan. In de
// eerste dagen na het begin van de metingen lijkt daardoor alles nieuw.
const MIO_LEEFTIJD_FILTERS = [
  { key: 'alles', label: 'Alles', dagen: null },
  { key: 'vandaag', label: 'Vandaag nieuw', dagen: 0 },
  { key: '7', label: 'Laatste 7 dagen', dagen: 7 },
  { key: '14', label: 'Laatste 14 dagen', dagen: 14 },
  { key: '30', label: 'Laatste 30 dagen', dagen: 30 },
];

// Per maand hoeveel "mast geen spanning" er binnenkwamen, hoeveel er opgelost
// zijn en wat er aan het eind van die maand open stond. Dat laatste is geen
// optelsom van de eerste twee over de maanden heen: een storing die in maart
// binnenkomt en in mei wordt opgelost, staat in maart en april ook nog open.
//
// Let op de eerste maand: alles wat al liep toen de metingen begonnen krijgt
// die startdatum als "eerst gezien", dus die maand telt te veel instroom. Dat
// wordt bij de tabel ook vermeld in plaats van stilzwijgend meegerekend.
function buildMioPerMaand() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return [];
  const startMaand = snaps[0].week.slice(0, 7);

  const maanden = {};
  const ensure = (m) => {
    if (!maanden[m]) maanden[m] = { maand: m, nieuw: 0, opgelost: 0, eind: 0 };
    return maanden[m];
  };

  const gezien = new Set();
  snaps.forEach((sn, i) => {
    const maand = sn.week.slice(0, 7);
    const mio = typeFiltered(sn.storingen).filter(isMastGeenSpanning);
    const huidige = new Set(mio.map(s => s.order));
    mio.forEach(s => {
      if (!gezien.has(s.order)) { gezien.add(s.order); ensure(maand).nieuw++; }
    });
    if (i > 0) {
      typeFiltered(snaps[i - 1].storingen).filter(isMastGeenSpanning).forEach(s => {
        if (!huidige.has(s.order)) ensure(maand).opgelost++;
      });
    }
    // De laatste meetdag binnen een maand bepaalt de eindstand van die maand.
    ensure(maand).eind = huidige.size;
  });

  return Object.values(maanden)
    .sort((a, b) => a.maand.localeCompare(b.maand))
    .map(m => Object.assign({}, m, { onvolledig: m.maand === startMaand }));
}

const MAAND_NAMEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
function maandLabel(ym) {
  const [jaar, maand] = ym.split('-');
  return `${MAAND_NAMEN[parseInt(maand, 10) - 1]} ${jaar}`;
}

function mioPerMaandHtml() {
  const rijen = buildMioPerMaand();
  if (rijen.length === 0) return '';
  const body = rijen.map(m => `<tr>
    <td>${esc(maandLabel(m.maand))}${m.onvolledig ? ' <span class="muted small">(deels)</span>' : ''}</td>
    <td class="num">${m.nieuw}</td>
    <td class="num">${m.opgelost}</td>
    <td class="num">${m.eind}</td>
  </tr>`).join('');
  const totaalNieuw = rijen.reduce((sum, m) => sum + m.nieuw, 0);
  return `<details class="details-card mio-maand">
      <summary>📅 Per maand bekijken</summary>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Maand</th><th class="num">Nieuw</th><th class="num">Opgelost</th><th class="num">Open aan eind</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <p class="muted small">${totaalNieuw} masten sinds het begin van de metingen. "Open aan eind" is de stand op de laatste meetdag van die maand — dat is geen optelsom van nieuw en opgelost, want een mast die in de ene maand binnenkomt en in een latere wordt opgelost staat er tussendoor ook nog open.${rijen[0].onvolledig ? ` De eerste maand (${esc(maandLabel(rijen[0].maand))}) staat op "deels": alles wat al liep toen de metingen begonnen kreeg die startdatum, dus daar telt de instroom te hoog.` : ''}</p>
    </details>`;
}

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
  const toonLeeftijdFilter = filterKey === 'mastGeenSpanning';
  // Bij de saneringen hoort erbij wat er om die reden NIET in staat.
  const zonderMarkering = filterKey === 'sanering' ? lsZonderMarkeringNu() : 0;
  const saneringNoot = zonderMarkering === 0 ? '' :
    `<p class="muted small">${zonderMarkering} ${zonderMarkering === 1 ? 'regel' : 'regels'} "LS storing/schade" zonder de markering "1" ${zonderMarkering === 1 ? 'telt' : 'tellen'} niet mee — dat zijn geen saneringen.</p>`;
  let leeftijdBalk = '';
  let leeftijdNoot = '';
  let maandBlok = '';

  if (hasList) {
    const orderSet = new Set(state.statDetailOrders || []);
    let list = current.filter(s => orderSet.has(s.order));
    const firstSeenMap = firstSeenWeekMap();

    if (toonLeeftijdFilter) {
      const snaps = chronoSnapshots();
      const vandaag = snaps.length ? snaps[snaps.length - 1].week : null;
      const gekozen = MIO_LEEFTIJD_FILTERS.find(f => f.key === state.mioLeeftijdFilter) || MIO_LEEFTIJD_FILTERS[0];
      const totaalVoorFilter = list.length;
      if (gekozen.dagen !== null && vandaag) {
        list = list.filter(s => {
          const eerst = firstSeenMap[s.order];
          if (!eerst) return false;
          const leeftijd = dagenTussen(eerst, vandaag);
          return leeftijd >= 0 && leeftijd <= gekozen.dagen;
        });
      }
      leeftijdBalk = `<div class="filter-tabs mio-leeftijd" id="mio-leeftijd">`
        + MIO_LEEFTIJD_FILTERS.map(f => `<button type="button" class="filter-tab${f.key === gekozen.key ? ' active' : ''}" data-mio-leeftijd="${f.key}">${esc(f.label)}</button>`).join('')
        + `</div>`;
      maandBlok = mioPerMaandHtml();
      leeftijdNoot = `<p class="muted small">${list.length} van de ${totaalVoorFilter} openstaande masten`
        + `${gekozen.dagen === null ? '' : gekozen.dagen === 0 ? ' zijn vandaag voor het eerst gezien' : ` zijn in de laatste ${gekozen.dagen} dagen voor het eerst gezien`}.`
        + ` "Eerst gezien" is de dag waarop de storing in dit dashboard verscheen, niet de werkelijke meldingsdatum.`
        + `${list.length > 0 && !isStaticExport ? ' <button type="button" class="btn-link" id="copy-mio-orders">📋 Kopieer ordernummers</button>' : ''}</p>`;
    }

    badgeCount = list.length;
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
          <td>${esc(s.type)}${saneringBadgeHtml(s)}</td>
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
    ${leeftijdBalk}
    ${leeftijdNoot}
    ${saneringNoot}
    ${maandBlok}
    ${body}`;

  container.querySelectorAll('#mio-leeftijd button[data-mio-leeftijd]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.mioLeeftijdFilter = btn.dataset.mioLeeftijd;
      renderStatDetail(current, mutations);
    });
  });
  const copyMio = document.getElementById('copy-mio-orders');
  if (copyMio) {
    copyMio.addEventListener('click', async () => {
      const orders = Array.from(container.querySelectorAll('tbody tr td:first-child')).map(td => td.textContent.trim());
      const original = copyMio.textContent;
      try {
        await navigator.clipboard.writeText(orders.join('\n'));
        copyMio.textContent = '✅ Gekopieerd!';
      } catch (e) {
        copyMio.textContent = '⚠️ Kopiëren mislukt';
      }
      setTimeout(() => { copyMio.textContent = original; }, 2000);
    });
  }

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
    container.innerHTML = '<p class="all-clear"><span class="all-clear-icon" aria-hidden="true">🎉</span>Niets dat om actie vraagt — goed bezig!</p>';
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
  const snaps = chronoSnapshots();
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

/* ---------- Instroom en uitstroom per gebied ---------- */

// Waar groeit de voorraad en waar loopt 'ie leeg. Per gebied de beginstand, wat
// erbij kwam, wat eruit ging en de eindstand — het verloop van het gebied in
// één regel.
//
// Instroom en uitstroom staan links en rechts van een middenlijn in plaats van
// naast elkaar: zo zie je in één oogopslag of een gebied netto vol- of
// leegloopt, ook zonder de getallen te lezen. Richting is daarmee het
// hoofdsignaal en kleur alleen ondersteunend — de gebruikte paars/groen-
// combinatie is gecontroleerd met scripts/validate_palette.js uit de
// dataviz-skill (CVD-scheiding ruim voldoende).
const INUIT_PERIODES = [
  { key: '7', label: 'Laatste 7 dagen', dagen: 7 },
  { key: '30', label: 'Laatste 30 dagen', dagen: 30 },
  { key: '90', label: 'Laatste 90 dagen', dagen: 90 },
];

function buildInUitPerGebied() {
  const periode = INUIT_PERIODES.find(p => p.key === state.inUitPeriode) || INUIT_PERIODES[1];
  const snaps = chronoSnapshots();
  if (snaps.length < 2) return null;
  const laatsteDag = snaps[snaps.length - 1].week;
  const venster = snaps.filter(sn => dagenTussen(sn.week, laatsteDag) <= periode.dagen);
  if (venster.length < 2) return null;

  const gebiedVan = (s) => s.gebiedscode || 'Onbekend';
  const stats = {};
  const ensure = (g) => {
    if (!stats[g]) stats[g] = { gebied: g, begin: 0, in: 0, uit: 0, eind: 0 };
    return stats[g];
  };

  // Beginstand: de situatie op de eerste dag van het venster.
  typeFiltered(venster[0].storingen).forEach(s => { ensure(gebiedVan(s)).begin++; });

  // Instroom/uitstroom worden toegeschreven aan het gebied van de storing zelf,
  // gemeten over opeenvolgende meetdagen binnen het venster.
  for (let i = 1; i < venster.length; i++) {
    const vorige = new Map(typeFiltered(venster[i - 1].storingen).map(s => [s.order, s]));
    const huidige = new Map(typeFiltered(venster[i].storingen).map(s => [s.order, s]));
    huidige.forEach((s, order) => { if (!vorige.has(order)) ensure(gebiedVan(s)).in++; });
    vorige.forEach((s, order) => { if (!huidige.has(order)) ensure(gebiedVan(s)).uit++; });
  }

  typeFiltered(venster[venster.length - 1].storingen).forEach(s => { ensure(gebiedVan(s)).eind++; });

  const rijen = Object.values(stats)
    .map(r => Object.assign({}, r, { netto: r.in - r.uit, regio: regioGroupLabel(regioGroupOf({ gebiedscode: r.gebied })) }))
    .filter(r => r.begin > 0 || r.in > 0 || r.uit > 0 || r.eind > 0)
    .sort((a, b) => b.netto - a.netto || b.eind - a.eind);

  return { rijen, periode, van: venster[0].week, tot: laatsteDag };
}

function renderInUitCard() {
  const container = document.getElementById('inuit-body');
  if (!container) return;
  document.querySelectorAll('#inuit-periode button[data-inuit-periode]').forEach(b => b.classList.toggle('active', b.dataset.inuitPeriode === state.inUitPeriode));

  const data = buildInUitPerGebied();
  if (!data || data.rijen.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog te weinig meetdagen in deze periode om instroom en uitstroom te kunnen bepalen.</p>';
    return;
  }
  const { rijen, periode, van, tot } = data;
  const maxZij = Math.max(1, ...rijen.map(r => Math.max(r.in, r.uit)));
  const groeiers = rijen.filter(r => r.netto > 0);
  const krimpers = rijen.filter(r => r.netto < 0);

  const kop = `<p class="prognose-headline">`
    + (groeiers.length > 0
        ? `<strong class="prognose-bad">${esc(groeiers[0].gebied)}</strong> groeide het hardst: ${groeiers[0].in} erbij, ${groeiers[0].uit} eruit (netto +${groeiers[0].netto}).`
        : 'Geen enkel gebied is in deze periode gegroeid.')
    + (krimpers.length > 0
        ? ` <strong class="prognose-good">${esc(krimpers[krimpers.length - 1].gebied)}</strong> liep het meest leeg (netto ${krimpers[krimpers.length - 1].netto}).`
        : '')
    + `</p><p class="muted small">${esc(van)} t/m ${esc(tot)} — elke storing telt mee bij het gebied waar 'ie op dat moment onder viel.</p>`;

  const rows = rijen.map(r => {
    const inPct = Math.round((r.in / maxZij) * 100);
    const uitPct = Math.round((r.uit / maxZij) * 100);
    const nettoCls = r.netto > 0 ? 'prognose-bad' : r.netto < 0 ? 'prognose-good' : '';
    return `<tr>
      <td>${esc(r.gebied)}</td>
      <td class="muted small">${esc(r.regio)}</td>
      <td class="num">${r.begin}</td>
      <td class="inuit-cel">
        <div class="inuit-balk">
          <div class="inuit-uit"><span style="width:${uitPct}%" title="${r.uit} opgelost"></span></div>
          <div class="inuit-in"><span style="width:${inPct}%" title="${r.in} nieuw"></span></div>
        </div>
      </td>
      <td class="num">${r.uit}</td>
      <td class="num">${r.in}</td>
      <td class="num ${nettoCls}"><strong>${r.netto > 0 ? '+' : ''}${r.netto}</strong></td>
      <td class="num">${r.eind}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `${kop}
    <div class="table-scroll">
      <table class="inuit-tabel">
        <thead><tr>
          <th>Gebied</th><th>Regio</th><th class="num">Begin</th>
          <th class="inuit-kop"><div class="inuit-balk"><span class="inuit-kop-uit">← opgelost</span><span class="inuit-kop-in">nieuw →</span></div></th>
          <th class="num">Uit</th><th class="num">In</th><th class="num">Netto</th><th class="num">Eind</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ---------- Overleg: het weeklogboek ---------- */

// Wat er maandag op tafel moet liggen: de stand van vorige week naast die van
// nu, met daartussen wat erbij kwam en wat eruit ging. Bewust een eigen tab en
// geen extra kaartje op Data: de Data-tab beantwoordt "hoe staat het er nu
// voor", dit beantwoordt "wat is er sinds vorige week gebeurd" — dat zijn twee
// verschillende vragen, en in het overleg wordt alleen de tweede gesteld.
const OVERLEG_DOEL_DAGEN = 7;

// De peildag is de meetdag die het dichtst bij een week terug ligt. Niet
// "precies zeven dagen": er wordt niet elke dag geplakt, en een vaste
// terugblik van zeven dagen zou dan op een dag zonder meting vallen en niets
// opleveren. Bij een gelijkspel (zes én acht dagen terug) wint de oudste, dan
// valt er zeker geen week tussenuit.
function overlegVenster() {
  const snaps = chronoSnapshots();
  if (snaps.length < 2) return null;
  const laatste = snaps[snaps.length - 1];
  let peilIndex = 0;
  let besteAfwijking = Infinity;
  for (let i = 0; i < snaps.length - 1; i++) {
    const afwijking = Math.abs(dagenTussen(snaps[i].week, laatste.week) - OVERLEG_DOEL_DAGEN);
    if (afwijking < besteAfwijking) { besteAfwijking = afwijking; peilIndex = i; }
  }
  const dagen = snaps.slice(peilIndex);
  return { peil: dagen[0], laatste, dagen, dagenTerug: dagenTussen(dagen[0].week, laatste.week) };
}

// Beginstand, instroom, uitstroom en eindstand per groep over een reeks
// meetdagen.
//
// De vergelijking gaat per groep, niet eerst per order en dan pas per groep.
// Dat scheelt niet alleen code: verhuist een storing van de ene status naar de
// andere, dan telt dat als uit bij de oude en in bij de nieuwe — en dat is
// precies wat "hoeveel zijn er uit Onderzoek controleren gegaan" betekent.
// Bijkomend voordeel: begin + in − uit = eind klopt daardoor per groep, ook
// bij verhuizingen, dus de tabel is altijd na te rekenen.
function stroomPerGroep(dagen, sleutelFn, kies) {
  const selectie = kies || telAlsStoring;
  const perDag = dagen.map(sn => {
    const groepen = new Map();
    sn.storingen.filter(selectie).forEach(s => {
      const sleutel = sleutelFn(s);
      if (sleutel == null) return;
      if (!groepen.has(sleutel)) groepen.set(sleutel, new Set());
      groepen.get(sleutel).add(s.order);
    });
    return groepen;
  });

  const stats = new Map();
  const ensure = (sleutel) => {
    if (!stats.has(sleutel)) stats.set(sleutel, { sleutel, begin: 0, in: 0, uit: 0, eind: 0 });
    return stats.get(sleutel);
  };
  perDag[0].forEach((orders, sleutel) => { ensure(sleutel).begin = orders.size; });
  for (let i = 1; i < perDag.length; i++) {
    const vorige = perDag[i - 1];
    const huidige = perDag[i];
    huidige.forEach((orders, sleutel) => {
      const eerder = vorige.get(sleutel);
      orders.forEach(order => { if (!eerder || !eerder.has(order)) ensure(sleutel).in++; });
    });
    vorige.forEach((orders, sleutel) => {
      const nu = huidige.get(sleutel);
      orders.forEach(order => { if (!nu || !nu.has(order)) ensure(sleutel).uit++; });
    });
  }
  perDag[perDag.length - 1].forEach((orders, sleutel) => { ensure(sleutel).eind = orders.size; });
  stats.forEach(r => { r.netto = r.eind - r.begin; });
  return stats;
}

const LEGE_STROOM = { begin: 0, in: 0, uit: 0, eind: 0, netto: 0 };
function stroomVan(stats, sleutel) {
  return stats.get(sleutel) || Object.assign({ sleutel }, LEGE_STROOM);
}

// De signalen die in het overleg langskomen: niet als stroom maar als stand,
// vorige week naast nu. Voor een signaal is "hoeveel staan er nu" de vraag,
// niet "hoeveel zijn er doorheen gelopen".
const OVERLEG_SIGNALEN = [
  { key: 'onderzoekControleren', label: 'Onderzoek controleren', test: s => s.ovStatus === 'Onderzoek controleren' },
  { key: 'verlopenOnbekend', label: 'Verlopen — uitvoering onbekend', test: s => isActionableOverdue(s) },
  { key: 'verlopenDatum', label: 'Uitvoeringsdatum verstreken', test: s => isActionableExpiredDate(s) },
  { key: 'bijnaVerlopen', label: 'Bijna verlopen', test: s => statusOf(s) === 'serious' && !isOvBlocked(s) },
  { key: 'geblokkeerd', label: 'Geblokkeerd', test: s => isOvBlocked(s) },
  { key: 'mastGeenSpanning', label: 'Mast geen spanning', test: s => isMastGeenSpanning(s) },
];

function signalenVergelijk(peilLijst, nuLijst) {
  return OVERLEG_SIGNALEN.map(sig => {
    const toen = peilLijst.filter(sig.test).length;
    const nu = nuLijst.filter(sig.test).length;
    return { key: sig.key, label: sig.label, toen, nu, verschil: nu - toen };
  });
}

function buildWeekLogboek() {
  const venster = overlegVenster();
  if (!venster) return null;
  const { peil, laatste, dagen, dagenTerug } = venster;

  const peilLijst = typeFiltered(peil.storingen);
  const nuLijst = typeFiltered(laatste.storingen);

  const totaal = stroomVan(stroomPerGroep(dagen, () => 'totaal'), 'totaal');

  // Status: alleen de bekende workflow-stadia in de vaste volgorde, plus een
  // regel voor wat (nog) geen status heeft. Blokkades worden hier NIET
  // afgetrokken zoals bij de tegels op Data: daar gaat het om "wat kun je
  // oppakken", hier om "waar zit de voorraad" — en een geblokkeerde storing
  // zit nog steeds ergens. Geblokkeerd staat apart tussen de signalen.
  const statusStroom = stroomPerGroep(dagen, s => s.ovStatus || 'Zonder status');
  const statusRijen = OV_STATUS_ORDER.concat(['Zonder status'])
    .map(status => Object.assign({ status }, stroomVan(statusStroom, status)))
    .filter(r => r.begin > 0 || r.in > 0 || r.uit > 0 || r.eind > 0);

  const regioStroom = stroomPerGroep(dagen, s => regioGroupOf(s));
  const gebiedStroom = stroomPerGroep(dagen, s => s.gebiedscode || 'Onbekend');

  // Alleen Leiden en Haarlem: dat zijn de twee gebiedsupdates die gevraagd
  // worden. Staat er iets onder "Overig", dan hoort het bij geen van beide en
  // is dat een signaal op zich — dat staat al op de Gebieden-tab.
  const gebiedsupdates = ['Leiden', 'Haarlem'].map(groep => {
    const stroom = stroomVan(regioStroom, groep);
    const inGroep = (s) => regioGroupOf(s) === groep;
    const gebieden = Array.from(gebiedStroom.values())
      .filter(r => regioGroupOf({ gebiedscode: r.sleutel }) === groep)
      .filter(r => r.begin > 0 || r.in > 0 || r.uit > 0 || r.eind > 0)
      .sort((a, b) => b.eind - a.eind || a.sleutel.localeCompare(b.sleutel));
    return {
      groep,
      label: regioGroupLabel(groep),
      stroom,
      gebieden,
      signalen: signalenVergelijk(peilLijst.filter(inGroep), nuLijst.filter(inGroep)),
    };
  });

  // Klantaanvragen lopen buiten typeFiltered om (zie isKlantaanvraag), dus ze
  // krijgen hun eigen stroom over dezelfde meetdagen.
  const klantStroom = stroomVan(stroomPerGroep(dagen, () => 'klant', isKlantaanvraag), 'klant');
  const klantNu = laatste.storingen.filter(isKlantaanvraag);
  const peilKlantOrders = new Set(peil.storingen.filter(isKlantaanvraag).map(s => s.order));
  const klantNieuw = klantNu.filter(s => !peilKlantOrders.has(s.order))
    .sort((a, b) => (a.executionDate || '9999').localeCompare(b.executionDate || '9999'));
  const klantMetDatum = klantNu.filter(s => s.executionDate)
    .sort((a, b) => a.executionDate.localeCompare(b.executionDate));

  return {
    peil: peil.week,
    nu: laatste.week,
    dagenTerug,
    meetdagen: dagen.length,
    totaal,
    statusRijen,
    signalen: signalenVergelijk(peilLijst, nuLijst),
    gebiedsupdates,
    klant: { stroom: klantStroom, nieuw: klantNieuw, eerstvolgende: klantMetDatum[0] || null },
  };
}

// Een verschil zonder richting is een getal; met richting is het een bericht.
// Vandaar overal hetzelfde patroon: pijl, aantal, en kleur pas daarna — de
// pijl doet het werk, ook zonder kleurzicht.
//
// Niet elk verschil is goed of slecht nieuws. Bij een voorraad of een signaal
// is minder beter, maar bij een workflow-status niet: dat er méér in "In
// uitvoering" staat is juist voortgang. Die krijgen daarom bewust geen kleur;
// een gekleurde pijl die de verkeerde kant op oordeelt is erger dan geen kleur.
function verschilHtml(verschil, neutraal) {
  if (verschil === 0) return '<span class="overleg-gelijk">gelijk</span>';
  const omhoog = verschil > 0;
  const kleur = neutraal ? 'overleg-neutraal' : (omhoog ? 'prognose-bad' : 'prognose-good');
  return `<span class="${kleur}">${omhoog ? '▲' : '▼'} ${Math.abs(verschil)}</span>`;
}
function verschilTekst(verschil) {
  if (verschil === 0) return 'gelijk';
  return `${verschil > 0 ? '+' : '−'}${Math.abs(verschil)}`;
}

function stroomTegelsHtml(stroom, peil, nu) {
  const tegels = [
    { label: `Stand ${fmtDag(peil)}`, value: stroom.begin, note: 'vorige meting' },
    { label: 'Ingestroomd', value: stroom.in, note: 'nieuw in de bak', klasse: stroom.in > 0 ? 'bad' : '' },
    { label: 'Uitgestroomd', value: stroom.uit, note: 'uit de lijst verdwenen', klasse: stroom.uit > 0 ? 'good' : '' },
    { label: `Stand ${fmtDag(nu)}`, value: stroom.eind, note: `netto ${verschilTekst(stroom.netto)}` },
  ];
  return `<div class="stat-row overleg-tegels">`
    + tegels.map(t => `<div class="stat-tile">
        <div class="label">${esc(t.label)}</div>
        <div class="value">${t.value}</div>
        <div class="delta ${t.klasse || ''}">${esc(t.note)}</div>
      </div>`).join('')
    + `</div>`;
}

// Een signaal dat vorige week nul was en nu nog steeds nul is, is geen bericht
// maar ruis: zes regels "gelijk" onder elkaar duwen de twee regels die er wél
// toe doen uit beeld. Ze verdwijnen dus als er niets te melden valt, en dat
// staat er dan bij — anders lijkt het alsof er iets ontbreekt.
function signalenTabelHtml(alleSignalen, peil, nu) {
  const signalen = alleSignalen.filter(sig => sig.toen > 0 || sig.nu > 0);
  if (signalen.length === 0) {
    return `<p class="empty-note">Geen verlopen, bijna verlopen of geblokkeerde storingen, op geen van beide meetdagen.</p>`;
  }
  return `<div class="table-scroll"><table class="overleg-tabel overleg-signaal-tabel">
    <thead><tr><th>Signaal</th><th class="num">${esc(fmtDag(peil))}</th><th class="num">${esc(fmtDag(nu))}</th><th class="num">Verschil</th></tr></thead>
    <tbody>${signalen.map(sig => `<tr>
      <td>${esc(sig.label)}</td>
      <td class="num muted">${sig.toen}</td>
      <td class="num"><strong>${sig.nu}</strong></td>
      <td class="num">${verschilHtml(sig.verschil)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function renderOverleg() {
  const leeg = document.getElementById('overleg-empty');
  const paneel = document.getElementById('overleg');
  if (!paneel) return;
  const data = buildWeekLogboek();
  if (leeg) leeg.classList.toggle('hidden', !!data);
  paneel.classList.toggle('hidden', !data);
  if (!data) return;

  const kop = document.getElementById('overleg-kop');
  if (kop) {
    kop.innerHTML = `<p class="prognose-headline">Van <strong>${esc(fmtDag(data.peil))}</strong> naar <strong>${esc(fmtDag(data.nu))}</strong>: `
      + `${data.totaal.in} erbij, ${data.totaal.uit} eruit, netto <strong class="${data.totaal.netto > 0 ? 'prognose-bad' : data.totaal.netto < 0 ? 'prognose-good' : ''}">${verschilTekst(data.totaal.netto)}</strong>.</p>`
      + `<p class="muted small">${data.dagenTerug} dagen terug, over ${data.meetdagen} meetdagen. `
      + `Er wordt vergeleken met de meetdag die het dichtst bij een week terug ligt — niet met een vaste datum, want er wordt niet elke dag geplakt.</p>`;
  }

  const kpi = document.getElementById('overleg-kpi-body');
  if (kpi) {
    const statusRijen = data.statusRijen.map(r => `<tr${r.status === 'Onderzoek controleren' ? ' class="overleg-nadruk"' : ''}>
      <td>${esc(r.status)}</td>
      <td class="num muted">${r.begin}</td>
      <td class="num overleg-in">${r.in > 0 ? '+' + r.in : '—'}</td>
      <td class="num overleg-uit">${r.uit > 0 ? '−' + r.uit : '—'}</td>
      <td class="num"><strong>${r.eind}</strong></td>
      <td class="num">${verschilHtml(r.netto, true)}</td>
    </tr>`).join('');
    kpi.innerHTML = stroomTegelsHtml(data.totaal, data.peil, data.nu)
      + `<h3 class="overleg-subkop">Per status</h3>`
      + `<p class="muted small">Een storing die van de ene status naar de andere gaat, telt als uit bij de oude en in bij de nieuwe. Zo is "hoeveel zijn er uit Onderzoek controleren gegaan" een echt aantal, en klopt per regel begin + in − uit = eind.</p>`
      + `<div class="table-scroll"><table class="overleg-tabel overleg-status-tabel">
          <thead><tr><th>Status</th><th class="num">${esc(fmtDag(data.peil))}</th><th class="num">In</th><th class="num">Uit</th><th class="num">${esc(fmtDag(data.nu))}</th><th class="num">Verschil</th></tr></thead>
          <tbody>${statusRijen}</tbody>
        </table></div>`
      + `<h3 class="overleg-subkop">Signalen</h3>`
      + signalenTabelHtml(data.signalen, data.peil, data.nu);
  }

  const gebied = document.getElementById('overleg-gebied-body');
  if (gebied) {
    gebied.innerHTML = data.gebiedsupdates.map(upd => {
      const gebiedRijen = upd.gebieden.length === 0
        ? `<tr><td colspan="6" class="muted">Geen storingen in deze regio.</td></tr>`
        : upd.gebieden.map(g => `<tr>
            <td>${esc(g.sleutel)}</td>
            <td class="num muted">${g.begin}</td>
            <td class="num overleg-in">${g.in > 0 ? '+' + g.in : '—'}</td>
            <td class="num overleg-uit">${g.uit > 0 ? '−' + g.uit : '—'}</td>
            <td class="num"><strong>${g.eind}</strong></td>
            <td class="num">${verschilHtml(g.netto)}</td>
          </tr>`).join('');
      return `<section class="overleg-regio">
        <h3>${esc(upd.label)} <span class="badge">${upd.stroom.eind}</span></h3>
        ${stroomTegelsHtml(upd.stroom, data.peil, data.nu)}
        <h4 class="overleg-subkop">Per gebied</h4>
        <div class="table-scroll"><table class="overleg-tabel overleg-gebied-tabel">
          <thead><tr><th>Gebied</th><th class="num">${esc(fmtDag(data.peil))}</th><th class="num">In</th><th class="num">Uit</th><th class="num">${esc(fmtDag(data.nu))}</th><th class="num">Verschil</th></tr></thead>
          <tbody>${gebiedRijen}</tbody>
        </table></div>
        <h4 class="overleg-subkop">Signalen</h4>
        ${signalenTabelHtml(upd.signalen, data.peil, data.nu)}
      </section>`;
    }).join('');
  }

  const klant = document.getElementById('overleg-klant-body');
  if (klant) {
    const k = data.klant;
    const nieuweRijen = k.nieuw.length === 0
      ? '<p class="muted small">Geen nieuwe klantaanvragen sinds de vorige meting.</p>'
      : `<div class="table-scroll"><table class="overleg-tabel overleg-klant-tabel">
          <thead><tr><th>Order</th><th>Type</th><th>Plaats</th><th>Adres</th><th>Gewenste datum</th></tr></thead>
          <tbody>${k.nieuw.map(s => `<tr>
            <td>${orderLinkHtml(s.order)}</td>
            <td>${esc(s.type)}</td>
            <td>${esc(s.city)}</td>
            <td>${esc(s.street)}, ${esc(s.postcode)}</td>
            <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : '<span class="muted">onbekend</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>`;
    klant.innerHTML = stroomTegelsHtml(k.stroom, data.peil, data.nu)
      + (k.eerstvolgende
          ? `<p class="muted small">Eerstvolgende gewenste datum: <strong>${esc(fmtDate(k.eerstvolgende.executionDate))}</strong> in ${esc(k.eerstvolgende.city)}.</p>`
          : '<p class="muted small">Geen enkele openstaande aanvraag heeft een gewenste datum.</p>')
      + `<h3 class="overleg-subkop">Nieuw sinds ${esc(fmtDag(data.peil))}</h3>`
      + nieuweRijen;
  }
}

// Platte tekst voor in de notulen. Bewust dezelfde volgorde als op het scherm,
// zodat wie meeleest in het overleg dezelfde route volgt.
function buildOverlegText() {
  const data = buildWeekLogboek();
  if (!data) return 'Nog te weinig meetdagen om een week te kunnen vergelijken.';
  const r = [];
  const stroomRegels = (stroom) => [
    `Stand ${fmtDag(data.peil)}: ${stroom.begin}`,
    `Ingestroomd: ${stroom.in}`,
    `Uitgestroomd: ${stroom.uit}`,
    `Stand ${fmtDag(data.nu)}: ${stroom.eind} (netto ${verschilTekst(stroom.netto)})`,
  ];
  // Zelfde keuze als op het scherm: signalen die aan beide kanten nul zijn,
  // zijn geen nieuws en horen niet in de notulen.
  const signaalRegels = (signalen) => {
    const gevuld = signalen.filter(sig => sig.toen > 0 || sig.nu > 0);
    if (gevuld.length === 0) return ['Signalen: geen.'];
    return ['Signalen:'].concat(gevuld.map(sig => `- ${sig.label}: ${sig.toen} → ${sig.nu} (${verschilTekst(sig.verschil)})`));
  };

  r.push(`WEEKBERICHT NUS — ${fmtDag(data.peil, true)} t/m ${fmtDag(data.nu, true)} (${data.dagenTerug} dagen)`, '');
  r.push('NUS-BAK', ...stroomRegels(data.totaal), '');
  r.push('Per status (in / uit / stand nu):');
  data.statusRijen.forEach(s => {
    r.push(`- ${s.status}: ${s.begin} → ${s.eind} (${verschilTekst(s.netto)}); ${s.in} erbij, ${s.uit} eruit`);
  });
  r.push('', ...signaalRegels(data.signalen));

  data.gebiedsupdates.forEach(upd => {
    r.push('', `GEBIEDSUPDATE ${upd.label.toUpperCase()}`, ...stroomRegels(upd.stroom));
    if (upd.gebieden.length > 0) {
      r.push('Per gebied:');
      upd.gebieden.forEach(g => r.push(`- ${g.sleutel}: ${g.begin} → ${g.eind} (${verschilTekst(g.netto)}); ${g.in} erbij, ${g.uit} eruit`));
    }
    r.push(...signaalRegels(upd.signalen));
  });

  r.push('', 'KLANTAANVRAGEN', ...stroomRegels(data.klant.stroom));
  if (data.klant.eerstvolgende) {
    r.push(`Eerstvolgende gewenste datum: ${fmtDate(data.klant.eerstvolgende.executionDate)} in ${data.klant.eerstvolgende.city}`);
  }
  if (data.klant.nieuw.length > 0) {
    r.push(`Nieuw sinds ${fmtDag(data.peil)}:`);
    data.klant.nieuw.forEach(s => {
      r.push(`- ${s.order} — ${s.city}, ${s.street} — ${s.executionDate ? fmtDate(s.executionDate) : 'datum onbekend'}`);
    });
  }
  return r.join('\n');
}

/* ---------- Types die niet meetellen ---------- */

// Het type-filter bepaalt wat er meetelt. Staat een type er niet in, dan
// verdwenen die regels geruisloos uit elke telling, grafiek en lijst: je zag
// "Totaal open 6" terwijl je er 11 had geplakt, en een sanering waarvan het
// type niet meetelde was nergens meer te vinden. Stil weglaten is voor een
// werkvoorraad het gevaarlijkste wat een hulpmiddel kan doen — dus staat het
// er nu bij, met de knop om het meteen recht te zetten.
function onbekendeTypesNu() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return [];
  const per = new Map();
  snaps[snaps.length - 1].storingen.forEach(s => {
    if (isKlantaanvraag(s) || isTypeIncluded(s)) return;
    per.set(s.type, (per.get(s.type) || 0) + 1);
  });
  return Array.from(per.entries())
    .map(([type, aantal]) => ({ type, aantal }))
    .sort((a, b) => b.aantal - a.aantal || a.type.localeCompare(b.type));
}

function renderTypeOnbekendNotice() {
  const el = document.getElementById('type-onbekend');
  if (!el) return;
  const lijst = isStaticExport ? [] : onbekendeTypesNu();
  if (lijst.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const totaal = lijst.reduce((n, t) => n + t.aantal, 0);
  el.classList.remove('hidden');
  el.innerHTML = `<strong>${totaal} ${totaal === 1 ? 'regel telt' : 'regels tellen'} niet mee.</strong> `
    + `Dit type staat niet in het type-filter, dus het blijft buiten elke telling, grafiek en lijst: `
    + lijst.map(t => `<span class="type-chip">${esc(t.type)} (${t.aantal})<button class="add-type" data-type="${esc(t.type)}" title="Laten meetellen">+</button></span>`).join('')
    + ` <span class="muted small">Klik op + om het te laten meetellen; weghalen kan in Instellingen.</span>`;
  el.querySelectorAll('.add-type').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!state.typeWhitelist.includes(btn.dataset.type)) state.typeWhitelist.push(btn.dataset.type);
      await saveTypeWhitelist(state.typeWhitelist);
      renderDashboardFromState();
    });
  });
}

/* ---------- Markering "1" die nog een oordeel nodig heeft ---------- */

// Bij "LS storing/schade" betekent de markering een sanering. Bij elk ander
// type betekent hij iets anders — meestal aanleg — en dat is niet uit de tekst
// af te leiden. Zulke regels blijven hier staan tot er een keuze is gemaakt,
// zodat ze niet als gewone storing wegzakken en ook niet ten onrechte bij de
// saneringen worden opgeteld.
function buildTeClassificeren() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return [];
  return typeFiltered(snaps[snaps.length - 1].storingen)
    .filter(vraagtClassificatie)
    .sort((a, b) => (a.type || '').localeCompare(b.type || '') || (a.daysLeft ?? 999) - (b.daysLeft ?? 999));
}

function renderClassificatieCard() {
  const kaart = document.getElementById('classificatie-card');
  const container = document.getElementById('classificatie-body');
  if (!kaart || !container) return;
  // In de teamexport valt er niets te classificeren: dat is jouw oordeel, en
  // een WV'er kan het toch niet opslaan.
  const rijen = isStaticExport ? [] : buildTeClassificeren();
  kaart.classList.toggle('hidden', rijen.length === 0);
  const telling = document.getElementById('classificatie-count');
  if (telling) telling.textContent = rijen.length;
  if (rijen.length === 0) { container.innerHTML = ''; return; }

  const opties = (order) => {
    const huidig = markeringKlasseVan(order);
    return `<select class="markering-select" data-order="${esc(order)}">
        <option value="" ${!huidig ? 'selected' : ''}>— Nog niet —</option>
        ${Object.keys(MARKERING_KLASSEN).map(k => `<option value="${k}" ${huidig === k ? 'selected' : ''}>${esc(MARKERING_KLASSEN[k])}</option>`).join('')}
      </select>`;
  };

  container.innerHTML = `<p class="prognose-headline"><strong>${rijen.length}</strong> ${rijen.length === 1 ? 'openstaande storing heeft' : 'openstaande storingen hebben'} een "1" in de tekst bij een ander type dan LS storing/schade. Dat is geen sanering; kies hier wat het wel is.</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Order</th><th>Type</th><th>Plaats</th><th>Adres</th><th class="num">Dagen</th><th>Wat is het?</th></tr></thead>
        <tbody>${rijen.map(s => `
          <tr>
            <td>${orderLinkHtml(s.order)}</td>
            <td>${esc(s.type)}</td>
            <td>${esc(s.city)}</td>
            <td>${esc(s.street)}, ${esc(s.postcode)}</td>
            <td class="num">${renderDaysPill(s)}</td>
            <td>${opties(s.order)}</td>
          </tr>`).join('')}</tbody>
      </table>
    </div>`;

  container.querySelectorAll('.markering-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const order = sel.dataset.order;
      if (sel.value) state.markeringKlasse[order] = sel.value;
      else delete state.markeringKlasse[order];
      await saveMarkeringKlasseMap(state.markeringKlasse);
      renderDashboardFromState();
    });
  });
}

/* ---------- Invoer: welke lijst plak je? ---------- */

// Met drie losse overzichten is "welke lijst is dit" geen detail meer: kies je
// het verkeerde, dan lijkt de rest van die lijst opgelost. Daarom staat de
// keuze zichtbaar boven het plakvak, wordt hij automatisch voorgesteld op basis
// van wat er geplakt is, en zie je van elke lijst wanneer hij voor het laatst
// is bijgewerkt — want een lijst die je een week niet plakt, blijft een week
// lang onveranderd meetellen.
function renderLijstKeuze() {
  document.querySelectorAll('#lijst-soort button[data-lijst]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lijst === state.lijstSoort);
  });
  const el = document.getElementById('lijst-herkend');
  if (!el) return;

  const bijgewerkt = lijstBijgewerkt();
  const stand = LIJST_SOORTEN.map(soort => {
    const sn = bijgewerkt[soort];
    return `${LIJST_LABELS[soort]}: ${sn ? `${sn.storingen.length} regels van ${sn.week}` : 'nog niet geplakt'}`;
  }).join(' · ');

  let hint = '';
  if (state.lijstHerkend) {
    hint = state.lijstHerkend === state.lijstSoort
      ? `<strong>Herkend als ${esc(LIJST_LABELS[state.lijstHerkend])}.</strong> Klopt dat niet? Kies hierboven zelf. `
      : `<strong class="prognose-bad">Let op:</strong> deze tekst lijkt op ${esc(LIJST_LABELS[state.lijstHerkend])}, maar je hebt ${esc(LIJST_LABELS[state.lijstSoort])} gekozen. `;
  }
  if (state.lijstSaneringenInTekst > 0 && state.lijstHerkend === 'nus') {
    hint += `Er staan ${state.lijstSaneringenInTekst} saneringen in deze tekst — komt dit uit het saneringen-overzicht, kies dan Saneringen. `;
  }
  el.innerHTML = hint + esc(stand);
}

/* ---------- Klantaanvragen (schakelverzoeken) ---------- */

// Klantaanvragen lopen buiten de NUS-cijfers om (zie typeFiltered), maar ze
// moeten wél worden ingepland. Ze verschillen op één punt wezenlijk van een
// storing: er staat een gewenste datum bij, en die datum — niet de resterende
// dagen — bepaalt wanneer je aan de slag moet. Een aanvraag met nog 361 dagen
// maar een gewenste datum over drie weken is urgenter dan het getal suggereert.
// De lijst staat daarom op datum, dichtstbijzijnde eerst.
function buildKlantaanvragen() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return { open: [], nieuw: [], vorigeDag: null, eerstvolgende: null };
  const laatste = snaps[snaps.length - 1];
  const open = laatste.storingen.filter(isKlantaanvraag);

  const vorige = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const vorigeOrders = vorige ? new Set(vorige.storingen.filter(isKlantaanvraag).map(s => s.order)) : null;
  const nieuw = vorigeOrders ? open.filter(s => !vorigeOrders.has(s.order)) : [];

  const gesorteerd = open.slice().sort((a, b) => {
    // Aanvragen zonder datum achteraan: daar valt nog niets op te plannen.
    if (!a.executionDate && !b.executionDate) return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
    if (!a.executionDate) return 1;
    if (!b.executionDate) return -1;
    return a.executionDate.localeCompare(b.executionDate);
  });
  const metDatum = gesorteerd.filter(s => s.executionDate);
  return {
    open: gesorteerd,
    nieuw,
    vorigeDag: vorige ? vorige.week : null,
    eerstvolgende: metDatum.length ? metDatum[0] : null,
  };
}

function renderKlantaanvraagCard() {
  const kaart = document.getElementById('klantaanvraag-card');
  const container = document.getElementById('klantaanvraag-body');
  if (!kaart || !container) return;
  const { open, nieuw, vorigeDag, eerstvolgende } = buildKlantaanvragen();

  // Geen aanvragen = geen kaart. Wie er geen heeft hoeft er ook geen lege
  // kaart voor te zien staan.
  kaart.classList.toggle('hidden', open.length === 0);
  const telling = document.getElementById('klantaanvraag-count');
  if (telling) telling.textContent = open.length;
  if (open.length === 0) { container.innerHTML = ''; return; }

  const nieuweOrders = new Set(nieuw.map(s => s.order));
  const kop = `<p class="prognose-headline"><strong>${open.length}</strong> ${open.length === 1 ? 'openstaande klantaanvraag' : 'openstaande klantaanvragen'}`
    + (vorigeDag ? `, waarvan <strong>${nieuw.length}</strong> nieuw sinds ${esc(vorigeDag)}` : '')
    + (eerstvolgende ? `. Eerstvolgende gewenste datum: <strong>${esc(fmtDate(eerstvolgende.executionDate))}</strong> in ${esc(eerstvolgende.city)}` : '')
    + '.</p>';

  const rijen = open.map(s => `
    <tr${nieuweOrders.has(s.order) ? ' class="klant-nieuw"' : ''}>
      <td>${orderLinkHtml(s.order)}${nieuweOrders.has(s.order) ? ' <span class="badge">nieuw</span>' : ''}</td>
      <td>${esc(s.type)}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>
      <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : '<span class="muted">onbekend</span>'}</td>
      <td class="num klant-termijn">${typeof s.daysLeft === 'number' ? esc(s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen` : `nog ${s.daysLeft} dgn`) : '—'}</td>
    </tr>`).join('');

  container.innerHTML = kop + `
    <div class="table-scroll">
      <table>
        <thead><tr><th>Order</th><th>Type</th><th>Plaats</th><th>Adres</th><th>Asset</th><th>Gewenste datum</th><th class="num">Termijn</th></tr></thead>
        <tbody>${rijen}</tbody>
      </table>
    </div>`;
}

/* ---------- Kaart: openstaande storingen per plaats ---------- */

// Een echte kaart met tegels (OpenStreetMap en soortgelijke) kan niet: het
// dashboard moet het zonder internet doen, ook als statische export bij een
// WV'er op de laptop. Wat wel kan is de plaatsen zelf in het bestand bakken en
// die op ware geografische positie tekenen. Dat levert een stippenkaart op:
// geen straatbeeld, wel de juiste onderlinge ligging en afstanden, en dat is
// precies wat je nodig hebt om een rit van de Meetdienst te plannen.
//
// De lijst uit ISH geeft geen coordinaten, alleen een plaatsnaam. De kaart is
// daarom zo nauwkeurig als het plaatsniveau: alle storingen in Leiden staan op
// het centrum van Leiden. Voor "wat ligt bij elkaar in de regio" is dat genoeg;
// voor "wat ligt bij elkaar binnen een plaats" is de clusterkaart hieronder de
// juiste plek.
//
// De tabel bevat alle plaatsen in en rond het werkgebied (Noord- en
// Zuid-Holland ruim genomen) plus elke grotere plaats daarbuiten, met
// alternatieve schrijfwijzen. Formaat per plaats: naam:lat:lon, waarbij lat en
// lon gehele tienduizendsten van een graad zijn, verminderd met 500000
// respectievelijk 30000 om de tekst kort te houden.
// Bron: GeoNames (cities500), CC BY 4.0 — https://www.geonames.org/
const PLAATS_GEO_LAT0 = 500000;
const PLAATS_GEO_LON0 = 30000;
const PLAATS_GEO_RUW = `
aagtdorn:26900:17042;aagtdorp:26900:17042;aalsmeer:22592:17597;aalsmeerderbrug:22742:17500;abbenes:22350:15917;
abcoude:22725:19694;abkad:22725:19694;abkawdh:22725:19694;abkoude:22725:19694;adegeest:21362:14525;
aemstelredamme:23740:18897;aemsterdam:23740:18897;aimstardaima:23740:18897;akersloot:25608:17333;
alfen:21292:16555;alkeumaleu:26317:17486;alkmaar:26317:17486;alkmaer:26317:17486;alkmar:26317:17486;
alkmaras:26317:17486;almelo:23567:36625;almere duin:23418:21413;almere stad:23703:22141;alphen:21292:16555;
alphen aan de rijn:21292:16555;alphen aan den rijn:21292:16555;alphen aan der rijn:21292:16555;alsmer:22592:17597;
amasataradama:23740:18897;amastaradama:23740:18897;amastararyama:23740:18897;ameide:19550:19625;
amersfoort:21550:23875;amestelledamme:23740:18897;amesterda:23740:18897;amesterdam:23740:18897;
amesterdao:23740:18897;amistardam:23740:18897;ammerstol:19275:18083;ams:23740:18897;amseutelbein:23008:18639;
amseuteleudam:23740:18897;amseutereudam:23740:18897;amstadem:23740:18897;amstardam:23740:18897;
amstardama:23740:18897;amstartam:23740:18897;amstedam:23740:18897;amstehrdam:23740:18897;amsteladamum:23740:18897;
amstelhoek:22308:18333;amstelodamum:23740:18897;amstelodhamon:23740:18897;amstelveen:23008:18639;
amstelven:23008:18639;amstelveyn:23008:18639;amstelvin:23008:18639;amsterda:23740:18897;amsterdam:23740:18897;
amsterdam duivendrecht:23294:19396;amsterdam zuidoost:23075:19722;amsterdama:23740:18897;amsterdamas:23740:18897;
amsterdame:23740:18897;amsterdami:23740:18897;amsterdamo:23740:18897;amsterdams:23740:18897;
amsterdamu:23740:18897;amsterdan:23740:18897;amsterntam:23740:18897;amsterodam:23740:18897;amstrdam:23740:18897;
amstyerdam:23740:18897;amsut erudam:23740:18897;amszterdam:23740:18897;amusitedan:23740:18897;
amusuterudamu:23740:18897;amusuterufen:23008:18639;ankeveense rade:22589:21016;anstardyam:23740:18897;
apeldoorn:22100:29694;arnhem:19800:29111;arukumaru:26317:17486;askhrmrhwrn:26008:18917;askhydam:19192:13889;
askhyfnyngn:21046:12756;aspyrdyk:26508:19431;assen:29967:35625;assendelft:24683:17431;
astyn hlnd jnwby:20033:17819;aud losdrekht:22067:20806;auderkerk kaj amstel:22950:19075;
auderkerkas prie amstelio:22950:19075;authorn:22375:18264;autxeyst:25292:17097;avenhorn:26175:19514;
awdrkrk:22950:19075;awthwrn:22375:18264;awtkhyst:25292:17097;awtrkht:20908:21222;baambrugge:22458:19889;
baarn:22117:22875;badhoevedorp:23372:17852;bakkum:25595:16572;bakum:25595:16572;bakwm:25595:16572;
barendrecht:18567:15347;barneveld:21400:25847;beets:25883:19778;beinsdorp:22867:15958;bennebroek:23208:15986;
benthuizen:20775:15444;bentveld:23650:15722;berchen:26692:17042;bergen:26692:17042;bergen binnen:26692:17042;
bergen op zoom:14950:12917;bergschenhoek:19900:14986;bergsenkhuk:19900:14986;bergstoep:19225:17847;
berkel en rodenrijs:19931:14787;berkenwoude:19450:17069;berkhout:26408:20014;berverwyk:24833:16569;
berxen:26692:17042;best:15075:23903;beuloekeolleon:21742:20014;beuningen:18608:27667;bevervejk:24833:16569;
beverwijk:24833:16569;beverwyk:24833:16569;beyverveyk:24833:16569;bilthoven:21300:22014;binnenhof:21642:15364;
bjussjum:22733:21611;bleiswijk:20108:15319;bloemendaal:24025:16222;bloemendaalseweg:20288:16944;
bodegraven:20825:17500;borne:23014:37482;borssele:14233:7347;boskoop:20750:16556;boskop:20750:16556;
boxtel:15908:23292;breda:15866:17760;breukelen:21742:20014;broek:24342:19958;broek in waterland:24342:19958;
broek op langedijk:26742:18056;broek op langendijk:26742:18056;brummen:20900:31556;brunssum:9467:29708;
bunnik:20667:21986;bussum:22733:21611;busum:22733:21611;butterhuizen:26500:18167;bwrmyrand:25050:19597;
bwswm:22733:21611;byfyrfayk:24833:16569;byrkhn:26692:17042;cabauw:19642:18986;cadoelen:24175:19056;
capelle:19292:15778;capelle aan de ijssel:19292:15778;capelle aan de yssel:19292:15778;
capelle aan den ijssel:19292:15778;capelle aan den yssel:19292:15778;capelle west:19167:15667;
castricum:25483:16694;chaarlem:23808:16368;chage:20767:12986;chaounta:20167:17083;commandeurs:25090:16584;
cruquius:23358:16347;culemborg:19550:22278;dalfsen:25117:32569;damsko:23740:18897;dapperbuurt:23622:19280;
de bilt:21100:21806;de engel:22417:15375;de glip:23308:16111;de goorn:26258:19472;de haach:20767:12986;
de hagen:19938:21026;de kieviet:21233:13584;de kievit:21233:13584;de kvakelis:22392:17931;de kwakel:22392:17931;
de lier:19750:12486;de maer:25190:16817;de meern:20817:20361;de rijp:25567:18458;de uithof:20853:21746;
delfshaven:19049:14532;delft:20067:13556;delfzijl:33300:39181;den haag:20767:12986;den helder:29599:17593;
den ilp:24542:19069;derufuto shi:20067:13556;deventer:22550:31639;diemen:23396:19626;diemerbrug:23396:19626;
dijmen:23396:19626;dimen:23396:19626;dlpt:20067:13556;doetinchem:19650:32889;dongen:16267:19389;
dordrecht:18100:16736;drachten:31125:30989;driebruggen:20442:18000;driehuis:24467:16375;
driemanspolder:20518:14850;driemond:23058:20167;dronten:25250:27181;duindorp:20908:12604;duinzigt:21049:13249;
duiven:19467:30139;duivendrecht:23294:19396;dymyn:23396:19626;edam:25122:20481;edamu:25122:20481;ede:20333:26583;
egmond aan de hoef:26233:16528;egmond aan den hoef:26233:16528;egmond aan zee:26204:16271;
egmond binnen:25958:16556;egmond op den hoef:26233:16528;ehdam:25122:20481;ehjmjojden:24603:16105;
ehjtgest:25292:17097;ehjtkhorn:22375:18264;eindhoven:14408:24778;elburg:24475:28431;elst:19192:28417;
emmeloord:27108:27486;emmen:27792:39069;emstaradyama:23740:18897;engel:22417:15375;enschede:22183:38958;
epe:23475:29833;essesteijn:20853:13726;everdingen:19650:21556;feifuhaizen:23508:16778;feijenoord:19117:15065;
fijenoord:19117:15065;forubyurufu:20742:13597;forum hadriani:20742:13597;furotoserumeru:25825:18500;
fwrbrkh:20742:13597;fwrbwrkh:20742:13597;fysb:23075:20417;gaaga:20767:12986;garlem:23808:16368;gauda:20167:17083;
gaudanum:20167:17083;geertruidenberg:17017:18569;geldermalsen:18808:22889;geldrop:14217:25597;geleen:9742:28292;
gemeente loenen:22100:20222;gemeente utrecht:20908:21222;gemstede:23499:16230;ghwda:20167:17083;ghwdt:20167:17083;
glip:23308:16111;goda:20167:17083;goes:15042:8889;goirle:15208:20667;goorn:26258:19472;gorinchem:18365:19724;
gorn:26425:20597;gouda:20167:17083;gouderak:19842:16778;goudschesluis:21194:16690;gouse sluis:21194:16690;
gouwsche sluis:21194:16690;gouwsluis:21194:16690;graaf:19808:19792;graft:25608:18306;graftyk:25542:17958;
grauwaart:20969:20579;grocchermer:25825:18500;groenekan:21233:21528;groenswaard:20515:16454;groningen:32192:35667;
groot ammers:19233:18236;groot ijsselmonde:18826:15494;grootschermer:25825:18500;grotskhermer:25825:18500;
guda:20167:17083;haag:20767:12986;haaga:20767:12986;haaksbergen:21567:37389;haarlem:23808:16368;
haarlemi:23808:16368;haarlemo:23808:16368;haarlim:23808:16368;haastrecht:20007:17764;hag:20767:12986;
haga:20767:12986;hagestein:19808:21222;hago:20767:12986;hague:20767:12986;haleulleom:23808:16368;
halfweg:23825:17542;hao teng:20283:21681;haralema:23808:16368;hardenberg:25758:36194;harderwijk:23417:26208;
harlama:23808:16368;harlem:23808:16368;harlema:23808:16368;harlemas:23808:16368;harlemum:23808:16368;
harlm:23808:16368;harmelen:20900:19611;haruremu:23808:16368;hauda:20167:17083;hauten:20283:21681;
hauteon:20283:21681;hawtn:20283:21681;heemskerk:25111:16717;heemskerkerduin:25075:16319;heemstede:23499:16230;
heerenveen:29593:29185;heerhugowaard:26714:18486;heerlen:8837:29815;heeswijk:20517:19694;
hei en boeicop:19446:20820;heigeu:20767:12986;heilo:26025:16882;heiloo:26025:16882;heimseutedeo:23499:16230;
hellevoetsluis:18333:11333;helmond:14817:26611;hem:26608:21833;hemstede:23499:16230;hemusutede:23499:16230;
hendrik ido ambacht:18442:16389;hengelo:22658:37931;hensbroek:26583:18847;heymsteyde:23499:16230;
heyrhuxovard:26714:18486;hiemstee:23499:16230;hilfertsom:22233:21764;hillegom:22908:15833;hilversum:22233:21764;
hilversumse meent:22712:21373;hilvertsheim:22233:21764;hoarn:26425:20597;hoensbroek:9239:29253;
hofgeest:24433:16583;hoge mors:21562:14603;holeun:26425:20597;hollandsche rading:21750:21778;
hondshorledijk:20067:12244;honselerdijk:20067:12244;honselersdijk:20067:12244;hoofddorp:23025:16889;
hoogeveen:27225:34764;hoogezand:31617:37611;hoogmade:21692:15819;hoogmaden:21692:15819;hoogvliet:18633:13625;
hoorn:26425:20597;horn:26425:20597;horstermeer:22500:20778;horun:26425:20597;houten:20283:21681;
huizen:22992:22417;hwrn:26425:20597;hwrstrmyr:22500:20778;hwtn:20283:21681;hylfrswm:22233:21764;
hymstydh:23499:16230;ijmond:24603:16105;ijmuiden:24603:16105;ijselstein:20200:20431;ijsselstein:20200:20431;
ilp:24542:19069;ilpendam:24633:19500;imuiden:24603:16105;issel stejn:20200:20431;jandam:24385:18264;
kabauw:19642:18986;kadoelen:24175:19056;kampen:25550:29111;kapelle:19292:15778;kapelleoanden eiseol:19292:15778;
kastrikjum:25483:16694;kastrikum:25483:16694;kastrkwm:25483:16694;kasutorikumu:25483:16694;
katendrecht:19007:14825;katijk aan zee:22033:13986;katwijk:21942:14222;katwijk aan de rijn:21942:14222;
katwijk aan den rijn:21942:14222;katwijk aan zee:22033:13986;katwyk aan zee:22033:13986;kerkehout:21102:13796;
kerkelanden:22176:21358;kerkrade:8658:30625;khaarlem:23808:16368;khag:20767:12986;khaga:20767:12986;
khalveg:25242:19278;kharlem:23808:16368;khawda:20167:17083;kheemskerk:25111:16717;khemstede:23499:16230;
kherkhjugovard:26714:18486;khilversjum:22233:21764;khilversum:22233:21764;khogmade:21692:15819;khorn:26425:20597;
kievit:21233:13584;kijkduin:20677:12219;knollendam:25175:17917;kop van zuid:19055:14871;kop van zujd:19055:14871;
kortenhoef:22392:21069;kortenkhov:22392:21069;korteraar:21733:17319;krimpen:19167:16028;
krimpen aan de yssel:19167:16028;krimpen aan den ijssel:19167:16028;krimpen aan den yssel:19167:16028;
kudelstaart:22342:17514;kudelstart:22342:17514;kudelstartas:22342:17514;kwadijk:25283:19806;kwake:22392:17931;
kwakel:22392:17931;kwakl:22392:17931;kwintsheul:20133:12556;lahay:20767:12986;lahey:20767:12986;lahh:20767:12986;
lai dun:21583:14931;laitan:21583:14931;lajden:21583:14931;landsmeer:24308:19153;landsmer:24308:19153;
landsmeyr:24308:19153;landsmyr:24308:19153;landvoort:23713:15331;langeheit:24920:17585;langeraar:21933:17111;
lansmar:24308:19153;laydn:21583:14931;laydrdwrb:21583:15292;laydyn:21583:14931;leerdam:18933:20917;
leeuwarden:32027:28097;leida:21583:14931;leiden:21583:14931;leidenas:21583:14931;leidene:21583:14931;
leideni:21583:14931;leideon:21583:14931;leiderdorp:21583:15292;leidsche rijn:20950:20461;leie:21583:14931;
leien:21583:14931;leimuiden:22242:16694;leinten:21583:14931;lejda:21583:14931;lejdehn:21583:14931;
lejden:21583:14931;lejdeni:21583:14931;lejderdorp:21583:15292;lejderdorpe:21583:15292;lelystad:25083:24750;
leusden:21325:24319;leyde:21583:14931;leyden:21583:14931;leyderdorp:21583:15292;leymuiden:22242:16694;
lid:21800:14319;lier:19750:12486;liesveld:19325:18319;lijnden:23525:17569;limmen:25692:16944;
linschoten:20625:19153;liserbroek:22567:15722;liserbrukas:22567:15722;lisse:22600:15569;lisserbroek:22567:15722;
lisserbruk:22567:15722;loasdrecht:22172:20690;loenen:22100:20222;loenen aan de vecht:22100:20222;
loon op zand:16275:20750;loosdrecht:22172:20690;lopik:19725:19486;lopikerkapel:19917:20458;losser:22608:40042;
loteleudam:19225:14792;lugdunum:21583:14931;lugdunum batavorum:21583:14931;lunetten:20618:21347;
lusdrikht:22172:20690;lydn:21583:14931;lysrbrwk:22567:15722;lyydn:21583:14931;maarsen:21392:20417;
maarssen:21392:20417;maarsseveen:21409:20734;maartensdijk:21550:21750;maasdijk:19592:12139;maasland:19342:12722;
maassluis:19233:12500;maastricht:8483:26889;magaalada utrecht:20908:21222;marken:24583:21028;marsyn:21392:20417;
medemblik:27717:21056;meern:20817:20361;meppel:26958:31944;merenwijk:21766:15089;middelburg:15000:6139;
middelie:25323:20184;middenbeemster:25492:19125;mijdrecht:22067:18625;mokum:23740:18897;mokum aleph:23740:18897;
monnickendam:24583:20375;monnickenwerf:24583:21028;monnikendam:24583:20375;monnikenwerf:24583:21028;
monnikkendam:24583:20375;montfoort:20458:19528;mudrecht:22067:18625;muiden:23300:20694;muiderberg:23258:21208;
naaldwijk:19942:12097;naarden:22958:21625;naldvejk:19942:12097;nieuw loosdrecht:21992:21389;
nieuw maarseveen:21409:20734;nieuw vennep:22642:16306;nieuwe wetering:22075:16181;nieuwegein:20292:20806;
nieuwegein zuid:20109:20929;nieuwegen:20292:20806;nieuwer amstel:23008:18639;nieuwerbrug:20783:18139;
nieuwerbrug aan den rijn:20783:18139;nieuwerkerk:19683:16097;nieuwerkerk aan de ijssel:19683:16097;
nieuwerkerk aan de yssel:19683:16097;nieuwerkerk aan den ijssel:19683:16097;nieuwerkerk aan den yssel:19683:16097;
nieuwkoop:21508:17764;nieuwland:19017:20139;nieuwpoort:19358:18681;nieuwveen:21967:17569;nijkerk:22200:24861;
nijmegen:18425:28528;nijverdal:23600:34681;noord hofland:21406:14586;noord schalkwijk:23611:16548;
noord scharwoude:26983:18111;noordeinde:20167:14833;noordeloos:19033:19417;noordwijk:22340:14447;
noordwijk binnen:22340:14447;noordwijkerhout:22617:14931;nootdorp:20450:13958;nte bilt:21100:21806;
ntelpht:20067:13556;nuenen:14700:25528;nywbrbrwg:20817:18028;obdam:26758:19069;obdamas:26758:19069;
oegstgeest:21800:14694;oestgeest:21800:14694;oisterwijk:15792:21889;oldenzaal:23133:39292;ommoord:19595:15453;
oog in al:20864:20847;oostdorp:21499:13932;oosteinde:22792:17958;oosterblokker:26692:21181;oosterhout:16450:18597;
oosterzij:25850:17056;oosthuizen:25725:19958;oostknollendam:25175:17917;op buuren:21277:20585;
oranjewijk:20492:16537;oss:17650:25181;oterleek:26367:18347;oud beijerland:18242:14125;oud loosdrecht:22067:20806;
oud zuilen:21275:20681;oude wetering:22142:16444;ouder amstel:22950:19075;ouderkerk:22950:19075;
ouderkerk aan de amstel:22950:19075;ouderkerk aan de ijssel:19342:16361;ouderkerk aan de yssel:19342:16361;
ouderkerk aan den amstel:22950:19075;ouderkerk aan den ijsel:19342:16361;ouderkerk aan den ijssel:19342:16361;
ouderkerk aan den yssel:19342:16361;oudewater:20250:18681;outrechte:20908:21222;overschie:19386:14277;
overveen:23917:16139;owtrext:20908:21222;palenstein:20558:15087;pankras:26600:17833;papendrecht:18317:16875;
papenveer:21850:17250;phuraha uta:22217:14847;pijnacker:20195:14295;pjurmerend:25050:19597;
plaspoelpolder:20388:13315;poeldijk:20242:12194;pollendam:24950:20708;purmerein:25050:19597;purmerend:25050:19597;
purumerento:25050:19597;putten:22592:26069;pwileumeleonteu:25050:19597;pwrbwrk:20742:13597;pwrmrnd:25050:19597;
pynakker:20195:14295;qfa:22592:17597;qhz:23025:16889;quda:20167:17083;qyi:22233:21764;raalte:23858:32750;
raiden:21583:14931;raisenfuto:22583:17139;ratehrdam:19225:14792;rattartem:19225:14792;reeuwijk:20467:17250;
reinsburgum:21900:14417;reisenhautas:22583:17139;rejsenkhaut:22583:17139;ridderkerk:18725:16028;
rijnsaterwoude:21958:16708;rijnsburg:21900:14417;rijnxaterwoude:21958:16708;rijp:25567:18458;
rijpwetering:21925:15833;rijsenhout:22583:17139;rijssen:23067:35181;rijswijk:20363:13250;
roelofarendsveen:22033:16333;roermond:11942:29875;roosendaal:15308:14653;rotaradema:19225:14792;
roterdam:19225:14792;roterdama:19225:14792;roterdamas:19225:14792;roterdami:19225:14792;roterdamo:19225:14792;
roterdan:19225:14792;roterdao:19225:14792;roterntam:19225:14792;roterodamum:19225:14792;rotterdam:19225:14792;
rotterudamu:19225:14792;rozenburg:19042:12486;rtm:19225:14792;rtrdam:19225:14792;rwtrdam:19225:14792;
rwtrdm:19225:14792;rynsburch:21900:14417;ryznhl:22583:17139;s gravenhage:20767:12986;s gravenland:19234:15531;
s hertogenbosch:16992:23042;sassenheim:22250:15222;sassenkhejm:22250:15222;schalkwijk:23611:16548;
schellinkhout:26350:21208;schermerhorn:26008:18917;scheveningen:21046:12756;schidamas:19192:13889;
schiebroek:19584:14712;schiedam:19192:13889;schijndel:16225:24319;schipluiden:19758:13139;
schoonerwoerd:19208:21167;schoonhoven:19475:18486;schoonrewoerd:19208:21167;sconhouen:19475:18486;
seuhebening eon:21046:12756;sheveningen:21046:12756;shion:20142:13250;sint pancras:26600:17833;
sint pankras:26600:17833;sion:20142:13250;sionas:20142:13250;sittard:9983:28694;sjeveninge:21046:12756;
skeveningen:21046:12756;skhermergorn:26008:18917;skheveningen:21046:12756;skhidam:19192:13889;
skhipljojden:19758:13139;ski dam:19192:13889;skiedam:19192:13889;skwwnyngn:21046:12756;sliedrecht:18208:17764;
sneek:30330:26589;snelrewaard:20275:19083;soest:21733:22917;spaarndam:24125:16833;spangen:19169:14354;
spechtenkamp:21393:20176;spierdijk:26508:19431;spijkenisse:18450:13292;spoorwijk:20535:13134;
stadskanaal:29895:39504;statenkwartier:20931:12758;steenbergen:15842:13194;stein:20033:17819;stolwijk:19725:17736;
stompetoren:26133:18208;strijp:20308:13014;suhefeningen:21046:12756;sutain:20033:17819;sxidam:19192:13889;
sywn hlnd:20142:13250;tegelen:13442:31361;ter aar:21658:17069;terbregge:19533:15154;terneuzen:13358:8278;
the hague:20767:12986;tiel:18867:24292;tilburg:15555:20913;tubbergen:24075:37847;tuindorp:19303:13784;
uden:16608:26194;uitgeest:25292:17097;uithof:20853:21746;uithoorn:22375:18264;uitweg:19825:20167;urk:26625:26014;
utc:20908:21222;utert:20908:21222;utgeast:25292:17097;uthoarn:22375:18264;utrech:20908:21222;utrecht:20908:21222;
utrechtas:20908:21222;utrehkht:20908:21222;utreht:20908:21222;utrehta:20908:21222;utrehto:20908:21222;
utrei:20908:21222;utrekhata:20908:21222;utrekht:20908:21222;utrekht khot:20908:21222;utrekhta:20908:21222;
utreque:20908:21222;utrext:20908:21222;valkenburg:21800:14319;valkenswaard:13508:24597;varmond:21967:15028;
veendam:31067:38792;veenendaal:20286:25589;veghel:16167:25486;vejfgejzen:23508:16778;veldhuizen:20754:20123;
velsen:24600:16500;velsen zuid:24600:16500;velserbroek:24328:16616;velzen:24600:16500;venlo:13700:31681;
venneperdorp:22642:16306;venray:15250:29750;verden:20850:18833;vesp:23075:20417;vest graftdejk:25542:17958;
veysp:23075:20417;vianen:19925:20917;vijfheizenas:23508:16778;vijfhuizen:23508:16778;vinkeveen:22151:19337;
vlaardinge:19125:13417;vlaardingen:19125:13417;vleuten:21058:20153;vlietwijk:21244:14574;vlissingen:14425:5736;
vlist:19800:18194;vogelenzang:23192:15778;vogelwijk:20763:12479;volendam:24950:20708;volendamas:24950:20708;
vondelwijk:20550:16531;voorburg:20742:13597;voorhout:22217:14847;voorschoten:21275:14486;voorweg:20892:16208;
vorbiurgas:20742:13597;vorbjurg:20742:13597;vorburg:20742:13597;vorburga:20742:13597;vorkhaut:22217:14847;
vreeswijk:20109:20929;vught:16533:22875;vurden:20850:18833;waalwijk:16825:20708;waarder:20608:18208;
waddinxveen:20450:16514;wageningen:19700:26667;warden:25650:20264;warder:25650:20264;warmond:21967:15028;
wassenaar:21458:14028;waterakkers:25044:16561;weerestein:23038:15886;weert:12517:27069;weesp:23075:20417;
weijpoort:20817:18028;west graftdijk:25542:17958;west grastdijk:25542:17958;westbroek:21500:21250;
westwoud:26850:21347;wierden:23592:35931;wijchen:18092:27250;wijdenes:26350:21569;wijdewormer:25002:18924;
wijk aan zee:24936:15941;wilnis:21967:18972;winterswijk:19725:37194;witeuleheuteu:20908:21222;woerden:20850:18833;
woerdenscheverlaat:21550:18639;woerdenschverlaat:21550:18639;woerdense verlaat:21550:18639;
woerdsche verlaat:21550:18639;wormer:24950:18056;woubrugge:21700:16361;wwlndm:24950:20708;
wwrdnsh frlat:21550:18639;xamstexrdam:23740:18897;ymuiden:24603:16105;ypenburg:20410:13698;yutirekiti:20908:21222;
yutorehito:20908:21222;yutrekhata:20908:21222;yutrekhta:20908:21222;ywtrkht:20908:21222;ywtrykht:20908:21222;
zaandam:24385:18264;zaandijk:24749:18069;zaanstad:24531:18136;zaltbommel:18100:22444;zan dan:24385:18264;
zandam:24385:18264;zandamas:24385:18264;zandamu:24385:18264;zandvoort:23713:15331;zandweg oostwaard:21364:20520;
zaydskhrmr:25850:17792;zegveld:21150:18361;zeist:20900:22333;zejdskhermer:25850:17792;zeutermaer:20575:14931;
zevenaar:19300:30708;zevenhoven:21817:17792;zijderveld:19417:21403;zoetermeer:20575:14931;zoeterwoude:21200:14958;
zoeterwoude dorp:21200:14958;zuid scharwoude:26867:18083;zuidbakkum:25595:16572;zuidbuurt:21083:15042;
zuidschermer:25850:17792;zuidzijde:20800:17722;zuilen:21275:20681;zutphen:21383:32014;zvansguk:23125:16167;
zvanshukas:23125:16167;zwaagdijk west:26750:20542;zwaanshoek:23125:16167;zwagdayk wst:26750:20542;
zwanenburg:23800:17458;zwijndrecht:18175:16333;zwolle:25125:30944;zwtrmyyr:20575:14931
`;

function plaatsSleutel(naam) {
  return (naam || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

let plaatsGeoCache = null;
function plaatsGeoTabel() {
  if (plaatsGeoCache) return plaatsGeoCache;
  plaatsGeoCache = new Map();
  PLAATS_GEO_RUW.split(/[;\n]+/).forEach(regel => {
    const d = regel.split(':');
    if (d.length !== 3) return;
    plaatsGeoCache.set(d[0], {
      lat: (parseInt(d[1], 10) + PLAATS_GEO_LAT0) / 1e4,
      lon: (parseInt(d[2], 10) + PLAATS_GEO_LON0) / 1e4,
    });
  });
  return plaatsGeoCache;
}

function geoVanPlaats(plaats) {
  return plaatsGeoTabel().get(plaatsSleutel(plaats)) || null;
}

// Per plaats de openstaande storingen van de nieuwste dag, met positie erbij.
// Plaatsen die niet in de tabel staan gaan niet verloren maar komen als
// aparte melding onder de kaart te staan — anders zou je stilzwijgend werk
// kwijtraken, en dat is het laatste wat een planningshulpmiddel mag doen.
function buildKaartPunten() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return { punten: [], zonderPositie: [], totaal: 0, datum: '' };
  const open = typeFiltered(snaps[snaps.length - 1].storingen);

  const perPlaats = new Map();
  open.forEach(s => {
    const naam = (s.city || '').trim() || 'Onbekend';
    let p = perPlaats.get(naam);
    if (!p) { p = { plaats: naam, storingen: [] }; perPlaats.set(naam, p); }
    p.storingen.push(s);
  });

  const punten = [];
  const zonderPositie = [];
  perPlaats.forEach(p => {
    const dagen = p.storingen.map(s => (typeof s.daysLeft === 'number' ? s.daysLeft : null)).filter(d => d !== null);
    const rij = {
      plaats: p.plaats,
      aantal: p.storingen.length,
      mio: p.storingen.filter(isMastGeenSpanning).length,
      verlopen: p.storingen.filter(s => s.overdue).length,
      geblokkeerd: p.storingen.filter(isOvBlocked).length,
      vroegste: dagen.length ? Math.min(...dagen) : null,
      storingen: p.storingen.slice().sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999)),
    };
    const geo = geoVanPlaats(p.plaats);
    if (geo) { rij.lat = geo.lat; rij.lon = geo.lon; punten.push(rij); }
    else zonderPositie.push(rij);
  });

  punten.sort((a, b) => b.aantal - a.aantal || a.plaats.localeCompare(b.plaats));
  zonderPositie.sort((a, b) => b.aantal - a.aantal || a.plaats.localeCompare(b.plaats));
  return { punten, zonderPositie, totaal: open.length, datum: snaps[snaps.length - 1].week };
}

// Equirectangulaire projectie: op de schaal van een regio is dat nauwkeurig
// genoeg, mits de lengtegraden worden ingekort met de cosinus van de breedte —
// anders wordt de kaart in oost-westrichting uitgerekt en kloppen de afstanden
// die je er visueel van afleest niet meer.
const KAART_BREEDTE = 760;
const KAART_MARGE = 46;
const KAART_MAX_HOOGTE = 560;
const KM_PER_GRAAD = 111.32;

function kaartAutoView(punten) {
  const latMid = punten.reduce((s, p) => s + p.lat, 0) / punten.length;
  const kx = Math.cos(latMid * Math.PI / 180);
  const xs = punten.map(p => p.lon * kx);
  const ys = punten.map(p => -p.lat);
  // Bij een enkele plaats of een rijtje op één lijn is er geen spreiding om op
  // te schalen; dan een vaste marge van ruwweg 5 km aanhouden.
  const minSpan = 5 / KM_PER_GRAAD;
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 - x0 < minSpan) { const m = (x0 + x1) / 2; x0 = m - minSpan / 2; x1 = m + minSpan / 2; }
  if (y1 - y0 < minSpan) { const m = (y0 + y1) / 2; y0 = m - minSpan / 2; y1 = m + minSpan / 2; }

  const vlak = KAART_BREEDTE - 2 * KAART_MARGE;
  const schaal = vlak / (x1 - x0);
  const hoogte = Math.min(KAART_MAX_HOOGTE, Math.max(300, (y1 - y0) * schaal + 2 * KAART_MARGE));
  // Verticaal binnen de beschikbare hoogte passen zonder de verhouding te
  // verstoren: dezelfde schaal, alleen gecentreerd.
  const k = Math.min(schaal, (hoogte - 2 * KAART_MARGE) / (y1 - y0));
  return {
    kx,
    hoogte,
    k,
    // Linkerbovenhoek van het beeld in wereldcoordinaten, zo gekozen dat de
    // punten gecentreerd staan.
    viewX: x0 - (KAART_BREEDTE - (x1 - x0) * k) / 2 / k,
    viewY: y0 - (hoogte - (y1 - y0) * k) / 2 / k,
  };
}

// Het beeld dat nu getekend moet worden: de automatische uitsnede, tenzij er
// is gezoomd of gesleept. De hoogte en de kx-correctie komen altijd uit de
// automatische berekening, zodat het kaartvlak niet van formaat verspringt
// tijdens het zoomen.
function kaartView(punten) {
  const auto = kaartAutoView(punten);
  const v = state.kaartView;
  const actief = v && Object.assign({}, auto, { k: v.k, viewX: v.viewX, viewY: v.viewY });
  const view = actief || auto;
  return {
    auto,
    hoogte: auto.hoogte,
    k: view.k,
    viewX: view.viewX,
    viewY: view.viewY,
    kmPerPixel: KM_PER_GRAAD / view.k,
    zoom: view.k / auto.k,
    x: (p) => (p.lon * auto.kx - view.viewX) * view.k,
    y: (p) => (-p.lat - view.viewY) * view.k,
    // Terug van beeldpunt naar wereldcoordinaat, nodig om rond de muisaanwijzer
    // in te zoomen.
    wereldX: (sx) => sx / view.k + view.viewX,
    wereldY: (sy) => sy / view.k + view.viewY,
  };
}

// Het beeld mag nooit zo ver weg schuiven dat er niets meer te zien is: zowel
// bij zoomen als bij slepen wordt de uitsnede teruggeduwd binnen de plaatsen
// plus een marge. Anders kijk je na een paar keer scrollen naar een leeg vlak
// en is "Hele gebied" de enige weg terug.
function kaartKlem(k, viewX, viewY, punten, auto) {
  const xs = punten.map(p => p.lon * auto.kx);
  const ys = punten.map(p => -p.lat);
  const margeX = Math.max((Math.max(...xs) - Math.min(...xs)) * 0.15, 2 / KM_PER_GRAAD);
  const margeY = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.15, 2 / KM_PER_GRAAD);
  const bx0 = Math.min(...xs) - margeX, bx1 = Math.max(...xs) + margeX;
  const by0 = Math.min(...ys) - margeY, by1 = Math.max(...ys) + margeY;
  const zichtB = KAART_BREEDTE / k, zichtH = auto.hoogte / k;
  return {
    k,
    // Past het hele gebied in beeld, dan centreren; anders binnen de grenzen
    // houden.
    viewX: zichtB >= bx1 - bx0 ? (bx0 + bx1) / 2 - zichtB / 2 : Math.min(Math.max(viewX, bx0), bx1 - zichtB),
    viewY: zichtH >= by1 - by0 ? (by0 + by1) / 2 - zichtH / 2 : Math.min(Math.max(viewY, by0), by1 - zichtH),
  };
}

// Zoomen rond een vast punt: de wereldcoordinaat onder de muis moet na het
// zoomen nog steeds onder de muis liggen, anders schuift de kaart onder je
// handen weg.
const KAART_ZOOM_MIN = 1;
const KAART_ZOOM_MAX = 40;
function kaartZoomNaar(punten, factor, ankerX, ankerY) {
  const view = kaartView(punten);
  const nieuweK = Math.min(view.auto.k * KAART_ZOOM_MAX, Math.max(view.auto.k * KAART_ZOOM_MIN, view.k * factor));
  if (nieuweK === view.k) return false;
  const wx = view.wereldX(ankerX), wy = view.wereldY(ankerY);
  state.kaartView = kaartKlem(nieuweK, wx - ankerX / nieuweK, wy - ankerY / nieuweK, punten, view.auto);
  return true;
}

function kaartVerschuif(punten, dxPixels, dyPixels) {
  const view = kaartView(punten);
  state.kaartView = kaartKlem(view.k, view.viewX - dxPixels / view.k, view.viewY - dyPixels / view.k, punten, view.auto);
}

// Taartpunt voor het aandeel "mast geen spanning" binnen een plaats. Groen en
// paars zijn het al gevalideerde kleurenpaar uit de rest van het dashboard
// (scripts/validate_palette.js), dus ook onder kleurenblindheid te scheiden.
function kaartTaartPad(cx, cy, r, deel) {
  if (deel <= 0) return '';
  if (deel >= 1) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--series-2)"></circle>`;
  const hoek = deel * 2 * Math.PI;
  const x1 = cx + r * Math.sin(hoek);
  const y1 = cy - r * Math.cos(hoek);
  const groot = hoek > Math.PI ? 1 : 0;
  return `<path d="M ${cx} ${cy} L ${cx} ${cy - r} A ${r} ${r} 0 ${groot} 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="var(--series-2)"></path>`;
}

// Een raster van hele kilometers. Zonder ondergrond is een stippenkaart lastig
// te lezen — het raster geeft de lege ruimte betekenis: je ziet in één oogopslag
// hoe ver twee plaatsen uit elkaar liggen zonder de schaalbalk erbij te pakken.
function kaartRaster(kmPerPixel, hoogte) {
  const stap = kaartNetteAfstand(kmPerPixel) / kmPerPixel;
  if (!isFinite(stap) || stap < 20) return '';
  const lijnen = [];
  for (let x = stap; x < KAART_BREEDTE; x += stap) lijnen.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${hoogte}"></line>`);
  for (let y = stap; y < hoogte; y += stap) lijnen.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${KAART_BREEDTE}" y2="${y.toFixed(1)}"></line>`);
  return `<g class="kaart-raster">${lijnen.join('')}</g>`;
}

// Een "nette" afstand (1, 2, 5, 10 ... km) die ongeveer een vijfde van de kaart
// beslaat — zowel voor de schaalbalk als voor de rasterstap.
function kaartNetteAfstand(kmPerPixel) {
  const kandidaten = [1, 2, 5, 10, 20, 50];
  const doel = (KAART_BREEDTE - 2 * KAART_MARGE) * 0.22 * kmPerPixel;
  return kandidaten.reduce((b, k) => (Math.abs(k - doel) < Math.abs(b - doel) ? k : b), kandidaten[0]);
}

function kaartSchaalbalk(kmPerPixel, hoogte) {
  const km = kaartNetteAfstand(kmPerPixel);
  const px = km / kmPerPixel;
  const x = KAART_MARGE, y = hoogte - 18;
  return `<g class="kaart-schaal">
    <line x1="${x}" y1="${y}" x2="${x + px}" y2="${y}"></line>
    <line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}"></line>
    <line x1="${x + px}" y1="${y - 4}" x2="${x + px}" y2="${y + 4}"></line>
    <text x="${x + px + 8}" y="${y + 4}">${km} km</text>
  </g>`;
}

// Labels botsen zodra twee plaatsen dicht bij elkaar liggen — Leiden en
// Leiderdorp schelen maar 2,5 km. Daarom per plaats acht richtingen op drie
// afstanden proberen en de eerste nemen die helemaal vrij is; lukt dat
// nergens, dan de positie met de minste overlap. Een label weglaten is geen
// optie: dan raak je op de kaart een plaats kwijt.
const KAART_LETTER = 5.9; // gemiddelde breedte per teken bij 11px
const KAART_LABEL_HOEKEN = [90, 270, 0, 180, 45, 135, 315, 225];
const KAART_LABEL_AFSTANDEN = [8, 20, 34];

function kaartLabelPlaatsing(markers, hoogte) {
  const bezet = [];
  return markers.map(m => {
    const tekst = `${m.p.plaats} \u00b7 ${m.p.aantal}`;
    const breedte = tekst.length * KAART_LETTER;
    const opties = [];
    KAART_LABEL_AFSTANDEN.forEach(extra => {
      KAART_LABEL_HOEKEN.forEach(hoek => {
        const rad = hoek * Math.PI / 180;
        const d = m.r + extra;
        const px = m.cx + Math.cos(rad) * d;
        const py = m.cy + Math.sin(rad) * d;
        // Recht boven/onder komt het label gecentreerd; opzij hangt het aan de
        // buitenkant, zodat het van de cirkel af leest.
        const anker = Math.abs(Math.cos(rad)) < 0.3 ? 'middle' : (Math.cos(rad) > 0 ? 'start' : 'end');
        const y = Math.abs(Math.cos(rad)) < 0.3 ? (Math.sin(rad) > 0 ? py + 10 : py - 3) : py + 4;
        const bx = anker === 'middle' ? px - breedte / 2 : (anker === 'start' ? px : px - breedte);
        opties.push({ x: px, y, anker, bx });
      });
    });

    // Overlap in vierkante pixels: nul is vrij, en anders wint de positie die
    // het minste botst. Zo valt een label nooit stilzwijgend bovenop een ander.
    const overlap = (a, b) => Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
      * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const kosten = (o) => {
      const vak = { x1: o.bx, y1: o.y - 10, x2: o.bx + breedte, y2: o.y + 3 };
      let som = 0;
      if (vak.x1 < 2 || vak.x2 > KAART_BREEDTE - 2 || vak.y1 < 2 || vak.y2 > hoogte - 22) som += 4000;
      markers.forEach(a => {
        if (a === m) return;
        som += overlap(vak, { x1: a.cx - a.r, y1: a.cy - a.r, x2: a.cx + a.r, y2: a.cy + a.r });
      });
      bezet.forEach(b => { som += overlap(vak, b) * 2; });
      return som;
    };

    let beste = opties[0], besteKosten = Infinity;
    for (const o of opties) {
      const k = kosten(o);
      if (k === 0) { beste = o; besteKosten = 0; break; }
      if (k < besteKosten) { beste = o; besteKosten = k; }
    }
    bezet.push({ x1: beste.bx, y1: beste.y - 10, x2: beste.bx + breedte, y2: beste.y + 3 });
    return beste;
  });
}

function renderKaartCard() {
  const container = document.getElementById('kaart-body');
  if (!container) return;
  const { punten, zonderPositie, totaal } = buildKaartPunten();

  if (totaal === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen openstaande storingen om op de kaart te zetten.</p>';
    return;
  }
  if (punten.length === 0) {
    container.innerHTML = `<p class="empty-note">Geen van de plaatsen in de lijst staat in de plaatsentabel, dus er valt niets te tekenen. Het gaat om: ${esc(zonderPositie.map(p => p.plaats).join(', '))}.</p>`;
    return;
  }

  container.innerHTML = kaartKopHtml(punten, totaal)
    + kaartToolbarHtml()
    + `<div class="kaart-vlakje" id="kaart-vlakje">${kaartSvgHtml(punten)}</div>`
    + kaartLegendaHtml()
    + kaartDetailHtml(punten, zonderPositie)
    + kaartVoetHtml(zonderPositie);
}

// Alleen het kaartvlak opnieuw tekenen. Bij zoomen en slepen gebeurt dat tot
// tientallen keren per seconde; de lijst eronder en de koppen hoeven daar niet
// aan mee te doen (en zouden anders hun scrollpositie kwijtraken).
function renderKaartVlak() {
  const vlak = document.getElementById('kaart-vlakje');
  if (!vlak) return;
  const { punten } = buildKaartPunten();
  if (punten.length === 0) return;
  vlak.innerHTML = kaartSvgHtml(punten);
  const herstel = document.getElementById('kaart-herstel');
  if (herstel) herstel.disabled = !state.kaartView;
}

function kaartSvgHtml(punten) {
  const view = kaartView(punten);
  const maxAantal = Math.max(...punten.map(p => p.aantal));
  // De stippen groeien niet mee met de zoom: dan zou inzoomen op een dichte
  // groep niets oplossen. Ze worden juist iets kleiner naarmate je verder
  // inzoomt, zodat overlappende plaatsen uit elkaar komen.
  const krimp = 1 / Math.max(1, Math.pow(view.zoom, 0.25));
  const straal = (n) => Math.max(6, 28 * Math.sqrt(n / maxAantal) * krimp);

  // Grootste cirkels eerst, zodat kleine plaatsen er niet onder verdwijnen
  // wanneer twee dorpen dicht bij elkaar liggen. Wat buiten beeld valt wordt
  // overgeslagen: dat scheelt tekenwerk en houdt de labelplaatsing vrij.
  const geordend = punten.slice().sort((a, b) => b.aantal - a.aantal)
    .map(p => ({ p, cx: view.x(p), cy: view.y(p), r: straal(p.aantal) }))
    .filter(m => m.cx > -60 && m.cx < KAART_BREEDTE + 60 && m.cy > -40 && m.cy < view.hoogte + 40);
  const labels = kaartLabelPlaatsing(geordend, view.hoogte);

  const markers = geordend.map((m, i) => {
    const { p, cx, cy, r } = m;
    const lab = labels[i];
    const actief = state.kaartPlaats === p.plaats;
    const titel = `${p.plaats}: ${p.aantal} open${p.mio > 0 ? `, ${p.mio}x mast geen spanning` : ''}${p.verlopen > 0 ? `, ${p.verlopen}x verlopen` : ''}`;
    return `<g class="kaart-punt${actief ? ' actief' : ''}${p.verlopen > 0 ? ' heeft-verlopen' : ''}" data-kaart-plaats="${esc(p.plaats)}" tabindex="0" role="button" aria-label="${esc(titel)}">
      <title>${esc(titel)}</title>
      <circle class="kaart-bol" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"></circle>
      ${kaartTaartPad(cx, cy, r, p.mio / p.aantal)}
      <circle class="kaart-ring" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"></circle>
      <text class="kaart-label" x="${lab.x.toFixed(1)}" y="${lab.y.toFixed(1)}" text-anchor="${lab.anker}">${esc(p.plaats)} \u00b7 ${p.aantal}</text>
    </g>`;
  }).join('');

  const buiten = punten.length - geordend.length;
  // Je kunt inzoomen op een stuk land waar toevallig niets openstaat. Dan is
  // een lege kaart verwarrend, dus staat er wat er aan de hand is en hoe je
  // terugkomt.
  const buitenBeeld = buiten === 0 ? ''
    : geordend.length === 0
      ? `<text class="kaart-leeg" x="${KAART_BREEDTE / 2}" y="${(view.hoogte / 2).toFixed(0)}">Geen plaatsen in dit deel van de kaart \u2014 klik op "Hele gebied"</text>`
      : `<text class="kaart-buiten" x="${KAART_BREEDTE - 12}" y="18">${buiten} ${buiten === 1 ? 'plaats' : 'plaatsen'} buiten beeld</text>`;

  return `<svg class="kaart-svg" viewBox="0 0 ${KAART_BREEDTE} ${Math.round(view.hoogte)}" role="img" aria-label="Kaart met openstaande storingen per plaats">
    ${kaartRaster(view.kmPerPixel, view.hoogte)}
    ${kaartSchaalbalk(view.kmPerPixel, view.hoogte)}
    ${buitenBeeld}
    ${markers}
  </svg>`;
}

// Sleeptoestand en tekenverzoek staan buiten de renderfuncties, zodat zoomen
// en slepen niet meer werk doen dan één hertekening per beeldopbouw.
const kaartSleep = { actief: false, gesleept: false, x: 0, y: 0, schaal: 1 };
let kaartTekenVerzoek = null;
function kaartTeken() {
  if (kaartTekenVerzoek) return;
  kaartTekenVerzoek = requestAnimationFrame(() => {
    kaartTekenVerzoek = null;
    renderKaartVlak();
  });
}

// Muispositie omgerekend naar de coordinaten van de viewBox: de SVG wordt op
// schermbreedte geschaald, dus de pixels op het scherm zijn niet die van de
// tekening.
function kaartMuisPositie(svg, e) {
  const vak = svg.getBoundingClientRect();
  const schaal = KAART_BREEDTE / vak.width;
  return { x: (e.clientX - vak.left) * schaal, y: (e.clientY - vak.top) * schaal };
}

function kaartToolbarHtml() {
  return `<div class="kaart-knoppen">
    <button type="button" class="kaart-knop" data-kaart-zoom="in" aria-label="Inzoomen">+</button>
    <button type="button" class="kaart-knop" data-kaart-zoom="uit" aria-label="Uitzoomen">\u2212</button>
    <button type="button" class="btn-link" id="kaart-herstel"${state.kaartView ? '' : ' disabled'}>Hele gebied</button>
    <span class="muted small">Scrollen zoomt, slepen verschuift</span>
  </div>`;
}

function kaartKopHtml(punten, totaal) {
  const opKaart = punten.reduce((n, p) => n + p.aantal, 0);
  return `<p class="prognose-headline"><strong>${opKaart}</strong> van de ${totaal} openstaande storingen, verdeeld over <strong>${punten.length}</strong> ${punten.length === 1 ? 'plaats' : 'plaatsen'}. De grootte van een stip is het aantal storingen; klik een plaats aan voor de lijst.</p>`;
}

function kaartLegendaHtml() {
  return `<div class="kaart-legenda">
    <span><i class="kaart-vlak kaart-vlak-overig"></i>overige storingen</span>
    <span><i class="kaart-vlak kaart-vlak-mio"></i>mast geen spanning</span>
    <span><i class="kaart-vlak kaart-vlak-verlopen"></i>plaats met verlopen storingen</span>
  </div>`;
}

function kaartVoetHtml(zonderPositie) {
  const ontbreekt = zonderPositie.length === 0 ? '' :
    `<p class="muted small">Zonder positie op de kaart: ${esc(zonderPositie.map(p => `${p.plaats} (${p.aantal})`).join(', '))}. Deze plaatsnamen staan niet in de ingebouwde plaatsentabel.</p>`;
  return ontbreekt + '<p class="muted small">Stippen staan op het centrum van de plaats, niet op het adres van de storing — voor de precieze ligging binnen een plaats: zie de clusters hieronder. Plaatscoordinaten: GeoNames, CC BY 4.0.</p>';
}

// De lijst achter een aangeklikte plaats. Bewust in dezelfde kaart en niet als
// aparte pop-up: je klikt hier om te zien wat er in een plaats openstaat, en
// dan wil je de kaart ernaast houden om de volgende plaats te kunnen kiezen.
function kaartDetailHtml(punten, zonderPositie) {
  if (!state.kaartPlaats) return '';
  const p = punten.concat(zonderPositie).find(x => x.plaats === state.kaartPlaats);
  if (!p) return '';
  const merk = [];
  if (p.mio > 0) merk.push(`${p.mio}x mast geen spanning`);
  if (p.verlopen > 0) merk.push(`${p.verlopen}x verlopen`);
  if (p.geblokkeerd > 0) merk.push(`${p.geblokkeerd}x geblokkeerd`);
  const rijen = p.storingen.map(s => `
    <tr>
      <td>${orderLinkHtml(s.order)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}${saneringBadgeHtml(s)}</td>
      <td>${ovStatusPillHtml(s)}</td>
      <td class="num">${renderDaysPill(s)}</td>
    </tr>`).join('');
  return `<div class="kaart-detail">
    <div class="kaart-detail-kop">
      <strong>${esc(p.plaats)}</strong>
      <span class="cluster-aantal">${p.aantal} open</span>
      ${merk.length ? `<span class="cluster-meta">${esc(merk.join(' \u00b7 '))}</span>` : ''}
      <button type="button" class="btn-link" id="kaart-sluit">sluiten</button>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Order</th><th>Adres</th><th>Type</th><th>Status</th><th class="num">Dagen</th></tr></thead>
        <tbody>${rijen}</tbody>
      </table>
    </div>
  </div>`;
}

/* ---------- Clusters: openstaande storingen die dicht bij elkaar liggen ---------- */

// Meetdienst-capaciteit is schaars, dus één rit moet zoveel mogelijk opleveren.
// Deze kaart zoekt groepjes openstaande storingen die geografisch bij elkaar
// liggen, zodat ze in één keer kunnen worden ingepland.
//
// Drie niveaus van "dicht bij elkaar", omdat de juiste korrel per situatie
// verschilt: een postcodegebied (de vier cijfers) is ruwweg een buurt en levert
// de meeste combinaties op; een volledige postcode is een straatblok; en op
// straatnaam vang je ook de gevallen waar één straat meerdere postcodes heeft.
const CLUSTER_MODI = {
  pc4: { label: 'Postcodegebied', meervoud: 'postcodegebieden', kolom: 'Postcode (4 cijfers)' },
  pc6: { label: 'Volledige postcode', meervoud: 'volledige postcodes', kolom: 'Postcode' },
  straat: { label: 'Straat', meervoud: 'straten', kolom: 'Straat' },
};

function pc4Van(postcode) {
  const m = (postcode || '').match(/(\d{4})/);
  return m ? m[1] : null;
}

function buildClusters(mode) {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return { clusters: [], totaal: 0, zonderLocatie: 0 };
  const open = typeFiltered(snaps[snaps.length - 1].storingen);

  const groepen = new Map();
  // Alle openstaande storingen per plaats, dus inclusief de losse — anders kun
  // je bij een plaats niet zien hoeveel er buiten de clusters vallen.
  const openPerPlaats = new Map();
  let zonderLocatie = 0;
  open.forEach(s => {
    const plaats = s.city || 'Onbekend';
    openPerPlaats.set(plaats, (openPerPlaats.get(plaats) || 0) + 1);
  });
  open.forEach(s => {
    let sleutel = null;
    if (mode === 'pc4') sleutel = pc4Van(s.postcode);
    else if (mode === 'pc6') sleutel = (s.postcode || '').trim() || null;
    else sleutel = straatZonderHuisnummer(s.street);
    if (!sleutel || sleutel === 'Onbekend') { zonderLocatie++; return; }
    const key = `${s.city || 'Onbekend'}|||${sleutel}`;
    let g = groepen.get(key);
    if (!g) {
      g = { key, city: s.city || 'Onbekend', sleutel, storingen: [], straten: new Set() };
      groepen.set(key, g);
    }
    g.storingen.push(s);
    g.straten.add(straatZonderHuisnummer(s.street));
  });

  const clusters = Array.from(groepen.values())
    .filter(g => g.storingen.length >= 2)
    .map(g => {
      const mio = g.storingen.filter(isMastGeenSpanning).length;
      const dagen = g.storingen.map(s => (typeof s.daysLeft === 'number' ? s.daysLeft : null)).filter(d => d !== null);
      return {
        key: g.key,
        city: g.city,
        sleutel: g.sleutel,
        aantal: g.storingen.length,
        mio,
        overig: g.storingen.length - mio,
        straten: g.straten.size,
        // De krapste deadline bepaalt wanneer de hele groep uiterlijk moet.
        vroegste: dagen.length ? Math.min(...dagen) : null,
        verlopen: g.storingen.filter(s => s.overdue).length,
        geblokkeerd: g.storingen.filter(isOvBlocked).length,
        storingen: g.storingen.slice().sort((a, b) => (a.daysLeft ?? 999) - (b.daysLeft ?? 999)),
      };
    })
    .sort((a, b) => b.aantal - a.aantal || (a.vroegste ?? 999) - (b.vroegste ?? 999) || a.city.localeCompare(b.city));

  return { clusters, plaatsen: clustersPerPlaats(clusters, openPerPlaats), totaal: open.length, zonderLocatie };
}

// De clusters zelf staan op postcode-/straatniveau, en dat is precies de korrel
// waarop je inplant. Maar om te bepalen wáár je een ploeg heen stuurt denk je
// eerst in plaatsen: "Leiderdorp, daar staan er twaalf". Daarom liggen de
// clusters van dezelfde plaats bij elkaar, met de plaats als eerste niveau.
function clustersPerPlaats(clusters, openPerPlaats) {
  const perPlaats = new Map();
  clusters.forEach(c => {
    let p = perPlaats.get(c.city);
    if (!p) { p = { city: c.city, clusters: [] }; perPlaats.set(c.city, p); }
    p.clusters.push(c);
  });
  return Array.from(perPlaats.values())
    .map(p => {
      const som = (veld) => p.clusters.reduce((n, c) => n + c[veld], 0);
      const deadlines = p.clusters.map(c => c.vroegste).filter(d => d !== null);
      const open = openPerPlaats.get(p.city) || som('aantal');
      const inCluster = som('aantal');
      return {
        city: p.city,
        clusters: p.clusters,
        open,
        inCluster,
        los: Math.max(0, open - inCluster),
        mio: som('mio'),
        verlopen: som('verlopen'),
        geblokkeerd: som('geblokkeerd'),
        vroegste: deadlines.length ? Math.min(...deadlines) : null,
      };
    })
    .sort((a, b) => b.open - a.open || b.inCluster - a.inCluster || a.city.localeCompare(b.city));
}

// Platte tekst van de clusters, om in een mail of Teams-bericht te plakken.
// De interactieve versie zit al in de teamexport, maar voor "hier is je lijstje
// voor morgen" is een blok tekst praktischer dan een bestand.
function buildClusterText() {
  const { clusters, plaatsen, totaal, zonderLocatie } = buildClusters(state.clusterMode);
  const snaps = chronoSnapshots();
  const datum = snaps.length ? snaps[snaps.length - 1].week : '';
  const kop = `NUS-clusters — ${datum} (${CLUSTER_MODI[state.clusterMode].label.toLowerCase()})`;
  if (clusters.length === 0) return `${kop}\n\nGeen clusters van twee of meer op dit niveau.`;

  const inCluster = clusters.reduce((sum, c) => sum + c.aantal, 0);
  const regels = [
    kop,
    '',
    `${inCluster} van de ${totaal} openstaande storingen liggen in ${clusters.length} ${clusters.length === 1 ? 'cluster' : 'clusters'} van twee of meer, verspreid over ${plaatsen.length} ${plaatsen.length === 1 ? 'plaats' : 'plaatsen'}.`,
    `${totaal - inCluster} ${totaal - inCluster === 1 ? 'staat' : 'staan'} op zichzelf${zonderLocatie > 0 ? ` (${zonderLocatie} zonder bruikbare locatiegegevens)` : ''}.`,
    '',
    'Per plaats:',
  ];
  plaatsen.forEach(p => {
    regels.push(`  ${p.city}: ${p.open} open, ${p.inCluster} in ${p.clusters.length} ${p.clusters.length === 1 ? 'cluster' : 'clusters'}`);
  });
  regels.push('');

  plaatsen.forEach(p => {
    regels.push(`=== ${p.city.toUpperCase()} — ${p.inCluster} storingen in ${p.clusters.length} ${p.clusters.length === 1 ? 'cluster' : 'clusters'} ===`);
    p.clusters.forEach(c => {
      const merk = [];
      if (c.mio > 0) merk.push(`${c.mio}x mast geen spanning`);
      if (c.verlopen > 0) merk.push(`${c.verlopen}x verlopen`);
      if (c.geblokkeerd > 0) merk.push(`${c.geblokkeerd}x geblokkeerd`);
      regels.push(`  ${c.sleutel}  (${c.aantal} storingen${merk.length ? ', ' + merk.join(', ') : ''})`);
      c.storingen.forEach(s => {
        const dagen = typeof s.daysLeft !== 'number' ? 'dagen onbekend'
          : s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen`
          : s.daysLeft === 0 ? 'verloopt vandaag'
          : `nog ${s.daysLeft} dgn`;
        const extra = [isMastGeenSpanning(s) ? 'mast geen spanning' : s.type, s.ovStatus || 'status onbekend'];
        if (isOvBlocked(s)) extra.push('geblokkeerd');
        regels.push(`    ${s.order}  ${s.street}, ${s.postcode}  — ${dagen}  (${extra.join(', ')})`);
      });
      regels.push('');
    });
  });
  return regels.join('\n').trimEnd();
}

function renderClusterCard() {
  const container = document.getElementById('cluster-body');
  if (!container) return;
  document.querySelectorAll('#cluster-mode button[data-cluster-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.clusterMode === state.clusterMode);
  });

  const { clusters, plaatsen, totaal, zonderLocatie } = buildClusters(state.clusterMode);
  if (totaal === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen openstaande storingen om te clusteren.</p>';
    return;
  }
  if (clusters.length === 0) {
    container.innerHTML = `<p class="empty-note">Geen twee openstaande storingen die op dit niveau bij elkaar liggen. Probeer een ruimere indeling — ${esc(CLUSTER_MODI.pc4.label.toLowerCase())} vangt de meeste combinaties.</p>`;
    return;
  }

  const inCluster = clusters.reduce((sum, c) => sum + c.aantal, 0);
  const mioInCluster = clusters.reduce((sum, c) => sum + c.mio, 0);
  const kop = `<p class="prognose-headline"><strong>${inCluster}</strong> van de ${totaal} openstaande storingen liggen in <strong>${clusters.length}</strong> ${clusters.length === 1 ? 'cluster' : 'clusters'} van twee of meer, verspreid over <strong>${plaatsen.length}</strong> ${plaatsen.length === 1 ? 'plaats' : 'plaatsen'}`
    + `${mioInCluster > 0 ? `; ${mioInCluster} daarvan ${mioInCluster === 1 ? 'is' : 'zijn'} van het type "mast geen spanning"` : ''}. `
    + `De overige ${totaal - inCluster} ${totaal - inCluster === 1 ? 'staat' : 'staan'} op zichzelf${zonderLocatie > 0 ? ` (${zonderLocatie} zonder bruikbare locatiegegevens)` : ''}. `
    + `Klap een plaats uit voor de ${esc(CLUSTER_MODI[state.clusterMode].meervoud)} daarbinnen.</p>`;

  const deadlineHtml = (dagen) => dagen === null ? '—'
    : dagen < 0 ? `<span class="prognose-bad">${Math.abs(dagen)} dgn verlopen</span>`
    : dagen === 0 ? '<span class="prognose-bad">vandaag</span>'
    : `nog ${dagen} dgn`;
  const merkTekst = (o) => {
    const merk = [];
    if (o.mio > 0) merk.push(`${o.mio}× mast geen spanning`);
    if (o.verlopen > 0) merk.push(`${o.verlopen}× verlopen`);
    if (o.geblokkeerd > 0) merk.push(`${o.geblokkeerd}× geblokkeerd`);
    return merk;
  };

  const rijen = plaatsen.map(p => {
    const clusterBlokken = p.clusters.map(c => {
      const merk = merkTekst(c);
      const detailRijen = c.storingen.map(s => `
        <tr>
          <td>${orderLinkHtml(s.order)}</td>
          <td>${esc(s.street)}, ${esc(s.postcode)}</td>
          <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}${saneringBadgeHtml(s)}</td>
          <td>${ovStatusPillHtml(s)}</td>
          <td class="num">${renderDaysPill(s)}</td>
        </tr>`).join('');
      return `
        <details class="cluster-item">
          <summary>
            <span class="cluster-titel">${esc(c.sleutel)}</span>
            <span class="cluster-aantal">${c.aantal} storingen</span>
            <span class="cluster-meta">${merk.length ? esc(merk.join(' · ')) + ' · ' : ''}krapste deadline: ${deadlineHtml(c.vroegste)}${state.clusterMode !== 'straat' && c.straten > 1 ? ` · ${c.straten} straten` : ''}</span>
          </summary>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Order</th><th>Adres</th><th>Type</th><th>Status</th><th class="num">Dagen</th></tr></thead>
              <tbody>${detailRijen}</tbody>
            </table>
          </div>
        </details>`;
    }).join('');

    const merk = merkTekst(p);
    const clusterTekst = `${p.clusters.length} ${p.clusters.length === 1 ? 'cluster' : 'clusters'}`;
    const meta = p.los > 0
      ? `${p.inCluster} in ${clusterTekst} · ${p.los} los`
      : `allemaal in ${clusterTekst}`;
    return `
      <details class="cluster-plaats">
        <summary>
          <span class="cluster-titel">${esc(p.city)}</span>
          <span class="cluster-aantal">${p.open} ${p.open === 1 ? 'storing' : 'storingen'}</span>
          <span class="cluster-meta">${esc(meta)}${merk.length ? ' · ' + esc(merk.join(' · ')) : ''} · krapste deadline: ${deadlineHtml(p.vroegste)}</span>
        </summary>
        <div class="cluster-plaats-body">${clusterBlokken}</div>
      </details>`;
  }).join('');

  container.innerHTML = kop + rijen;
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
  const snaps = chronoSnapshots();
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

// De tabel stond per (gebiedscode, plaats)-combinatie, waardoor Leiden op drie
// regels kon staan en je zelf moest optellen om te weten hoeveel er in Leiden
// open staat. De plaats is nu de hoofdregel — dat is de eenheid waarin je denkt
// als je een rit plant — en de gebiedscodes eronder zijn één klik weg voor wie
// wil weten hoe het binnen die plaats verdeeld is.
function gebiedSleutelCel(r) {
  const open = state.gebiedOpen.has(r.plaats);
  const meer = r.gebieden.length > 1;
  const tekst = esc(r.plaats) + (meer ? ` <span class="muted small">(${r.gebieden.length} gebieden)</span>` : '');
  if (!meer) return `<td><span class="gebied-enkel">${tekst}</span></td>`;
  return `<td><button type="button" class="recidive-toggle${open ? ' open' : ''}" data-gebied-plaats="${esc(r.plaats)}"`
    + ` aria-expanded="${open}" title="${open ? 'Gebiedscodes verbergen' : 'Bekijk de verdeling over gebiedscodes'}">`
    + `<span class="recidive-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${tekst}</button></td>`;
}

const GEBIED_STATS_COLUMNS = [
  { key: 'plaats', label: 'Plaats', cell: r => gebiedSleutelCel(r) },
  { key: 'regio', label: 'Regio', cell: r => `<td>${esc(r.regioLabel)}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num"><strong>${r.nuOpen}</strong></td>` },
  { key: 'actieNodig', label: 'Actie nodig nu', num: true, cell: r => `<td class="num${r.actieNodig > 0 ? ' prognose-bad' : ''}">${r.actieNodig}</td>` },
  { key: 'geblokkeerd', label: 'Geblokkeerd nu', num: true, cell: r => `<td class="num">${r.geblokkeerd}</td>` },
  { key: 'totaal', label: 'Totaal ooit', num: true, cell: r => `<td class="num">${r.totaal}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(1) + ' dgn'}</td>` },
];

function gebiedDetailHtml(r) {
  const rijen = r.gebieden.slice().sort((a, b) => b.nuOpen - a.nuOpen || a.gebiedscode.localeCompare(b.gebiedscode)).map(g => `<tr>
    <td>${esc(g.gebiedscode)}</td>
    <td>${esc(regioGroupLabel(regioGroupOf({ gebiedscode: g.gebiedscode })))}</td>
    <td class="num">${g.nuOpen}</td>
    <td class="num">${g.actieNodig}</td>
    <td class="num">${g.geblokkeerd}</td>
    <td class="num">${g.totaal}</td>
    <td class="num">${g.doorlooptijd == null ? '—' : g.doorlooptijd.toFixed(1) + ' dgn'}</td>
  </tr>`).join('');
  return `<div class="recidive-detail">
      <p class="muted small">Verdeling binnen ${esc(r.plaats)} over de gebiedscodes.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Gebiedscode</th><th>Regio</th><th class="num">Nu open</th><th class="num">Actie nodig</th><th class="num">Geblokkeerd</th><th class="num">Totaal ooit</th><th class="num">Gem. doorlooptijd</th></tr></thead>
          <tbody>${rijen}</tbody>
        </table>
      </div>
    </div>`;
}

function renderGebiedOnbekendNotice() {
  const el = document.getElementById('gebied-onbekend');
  if (!el) return;
  const codes = onbekendeGebiedscodes();
  if (codes.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<strong>Onbekende gebiedscode${codes.length === 1 ? '' : 's'}:</strong> ${codes.map(c => esc(c)).join(', ')}. `
    + `Deze ${codes.length === 1 ? 'hoort' : 'horen'} bij geen van beide regio's (Haarlem = ZZE9/ZZE10, Leiden = ZZE5 t/m ZZE8) en `
    + `${codes.length === 1 ? 'valt' : 'vallen'} daardoor onder "Overig". Klopt de code, dan hoort er een regio bij; anders staat er een verschrijving in de bron.`;
}

function renderGebiedPlaatsenCard() {
  renderGebiedOnbekendNotice();
  const container = document.getElementById('gebied-plaatsen-body');
  if (!container) return;
  const stats = buildGebiedPlaatsenStats();
  if (stats.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen gebiedscodes bekend — deze verschijnen zodra je een paste met gebiedscodes verwerkt.</p>';
    return;
  }
  // Eerst per gebiedscode+plaats (zoals de berekening ze oplevert), daarna
  // opgeteld naar plaatsniveau. De doorlooptijd wordt gewogen op het aantal
  // metingen, niet als gemiddelde van gemiddelden — anders zou een gebiedscode
  // met één afgeronde storing even zwaar wegen als eentje met vijftig.
  const perPlaats = new Map();
  stats.forEach(s => {
    const gebied = {
      gebiedscode: s.gebiedscode,
      totaal: s.orders.size,
      nuOpen: s.nuOpen,
      geblokkeerd: s.geblokkeerd,
      actieNodig: s.actieNodig,
      doorlooptijden: s.doorlooptijden,
      doorlooptijd: s.doorlooptijden.length ? s.doorlooptijden.reduce((a, b) => a + b, 0) / s.doorlooptijden.length : null,
    };
    let p = perPlaats.get(s.plaats);
    if (!p) {
      p = { plaats: s.plaats, totaal: 0, nuOpen: 0, geblokkeerd: 0, actieNodig: 0, doorlooptijden: [], gebieden: [], regios: new Set() };
      perPlaats.set(s.plaats, p);
    }
    p.totaal += gebied.totaal;
    p.nuOpen += gebied.nuOpen;
    p.geblokkeerd += gebied.geblokkeerd;
    p.actieNodig += gebied.actieNodig;
    p.doorlooptijden = p.doorlooptijden.concat(s.doorlooptijden);
    p.gebieden.push(gebied);
    p.regios.add(regioGroupOf({ gebiedscode: s.gebiedscode }));
  });

  const rows = Array.from(perPlaats.values()).map(p => ({
    plaats: p.plaats,
    // Een plaats kan (zeldzaam) over twee regio's verdeeld zijn; dan tonen we
    // dat in plaats van er stilzwijgend één te kiezen.
    regioLabel: sortByGroupOrder(Array.from(p.regios)).map(regioGroupLabel).join(' + '),
    nuOpen: p.nuOpen,
    actieNodig: p.actieNodig,
    geblokkeerd: p.geblokkeerd,
    totaal: p.totaal,
    doorlooptijd: p.doorlooptijden.length ? p.doorlooptijden.reduce((a, b) => a + b, 0) / p.doorlooptijden.length : null,
    gebieden: p.gebieden,
  }));

  const sorted = sortByState(rows, state.gebiedSortState);
  renderFullTable(container, sorted, GEBIED_STATS_COLUMNS, state.gebiedSortState, {
    isExpanded: (r) => r.gebieden.length > 1 && state.gebiedOpen.has(r.plaats),
    detailCell: gebiedDetailHtml,
  });
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
// Werkverdeling per WV'er. De vraag is niet "wie is sneller" maar "krijgt
// iedereen een vergelijkbare hoeveelheid werk" — vandaar dat aantallen leidend
// zijn en de doorlooptijd achteraan bungelt.
//
// nuOpen is het stuurgetal: dat kun je vandaag nog rechttrekken. nieuw/opgelost
// over een venster laten zien of de verdeling scheefgroeit of juist bijtrekt;
// totaal is alleen context, want wie er langer zit heeft vanzelf meer.
const WV_VENSTER_DAGEN = 30;

function buildWvStats() {
  const snaps = chronoSnapshots();
  const stats = {};
  const ensure = (naam) => {
    if (!stats[naam]) stats[naam] = { wvNaam: naam, orders: new Set(), doorlooptijden: [], nuOpen: 0, nieuwVenster: 0, opgelostVenster: 0, perRegio: {} };
    return stats[naam];
  };
  if (snaps.length === 0) return { rijen: [], regios: [], openTotaal: 0, openMetWv: 0 };
  // Dezelfde types als de rest van het dashboard, zodat het aantal van een
  // WV'er optelt bij "Totaal open" en niet stiekem iets anders telt.
  const zichtbaar = (sn) => typeFiltered(sn.storingen);
  const laatsteDag = snaps[snaps.length - 1].week;
  const inVenster = (dag) => dagenTussen(dag, laatsteDag) <= WV_VENSTER_DAGEN;

  const firstSeen = {}; // order -> { week, wvNaam }
  snaps.forEach((sn, i) => {
    const curOrders = new Set();
    zichtbaar(sn).forEach(s => {
      const naam = findRelevantWvNaam(s);
      if (!naam) return;
      curOrders.add(s.order);
      const e = ensure(naam);
      e.orders.add(s.order);
      if (!(s.order in firstSeen)) {
        firstSeen[s.order] = { week: sn.week, wvNaam: naam };
        if (inVenster(sn.week)) e.nieuwVenster++;
      }
    });
    if (i > 0) {
      zichtbaar(snaps[i - 1]).forEach(s => {
        const naam = findRelevantWvNaam(s);
        if (!naam || curOrders.has(s.order)) return;
        const fs = firstSeen[s.order];
        if (!fs) return;
        const days = dagenTussen(fs.week, sn.week);
        if (days >= 0) ensure(fs.wvNaam).doorlooptijden.push(days);
        if (inVenster(sn.week)) ensure(fs.wvNaam).opgelostVenster++;
      });
    }
  });

  // De huidige werkvoorraad, met de regio-uitsplitsing van datzelfde moment.
  // Bewust de stand van vandaag en niet een optelling over alle dagen: iemand
  // die drie maanden geleden veel in Haarlem deed en nu alleen Leiden, moet
  // hier als "nu Leiden" te zien zijn.
  const nu = zichtbaar(snaps[snaps.length - 1]);
  const regiosAanwezig = new Set();
  let openMetWv = 0;
  nu.forEach(s => {
    const naam = findRelevantWvNaam(s);
    if (!naam) return;
    openMetWv++;
    const e = ensure(naam);
    e.nuOpen++;
    const regio = regioGroupLabel(regioGroupOf(s));
    regiosAanwezig.add(regio);
    e.perRegio[regio] = (e.perRegio[regio] || 0) + 1;
  });

  const rijen = Object.values(stats);
  return {
    rijen,
    regios: sortByGroupOrder(Array.from(regiosAanwezig).map(r => r.replace(/^Regio /, ''))).map(regioGroupLabel),
    openTotaal: nu.length,
    openMetWv,
  };
}

// De kolommen hangen af van de regio's waar op dit moment werk ligt: het gaat
// er juist om dat je ziet wat iemand in élke regio oppakt, niet alleen in de
// regio waar hij het meeste doet.
function buildWvColumns(regios) {
  const kolommen = [
    { key: 'wvNaam', label: "WV'er", cell: r => `<td>${esc(r.wvNaam)}</td>` },
    { key: 'nuOpen', label: 'Nu open (totaal)', num: true, cell: r => `<td class="num"><strong>${r.nuOpen}</strong></td>` },
  ];
  regios.forEach(regio => {
    const sleutel = 'regio_' + regio;
    kolommen.push({
      key: sleutel, label: regio, num: true,
      cell: r => `<td class="num${r[sleutel] ? '' : ' muted'}">${r[sleutel] || 0}</td>`,
    });
  });
  kolommen.push(
    { key: 'aandeel', label: 'Aandeel', num: true, cell: r => `<td class="num">${r.aandeel == null ? '—' : Math.round(r.aandeel * 100) + '%'}</td>` },
    { key: 'nieuwVenster', label: `Nieuw (${WV_VENSTER_DAGEN} dgn)`, num: true, cell: r => `<td class="num">${r.nieuwVenster}</td>` },
    { key: 'opgelostVenster', label: `Opgelost (${WV_VENSTER_DAGEN} dgn)`, num: true, cell: r => `<td class="num">${r.opgelostVenster}</td>` },
    { key: 'totaal', label: 'Totaal ooit', num: true, cell: r => `<td class="num">${r.totaal}</td>` },
    { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num muted">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(1) + ' dgn'}</td>` },
  );
  return kolommen;
}

// De data staat in de IndexedDB van één browser op één machine. Gaat dat
// profiel verloren, dan is alles weg — een gedownload bestand is het enige
// dat een kapotte laptop overleeft. Omdat het dashboard dagelijks open gaat,
// is een zichtbare herinnering effectiever dan hopen dat je eraan denkt.
// Bewust niet wegklikbaar: hij verdwijnt door een back-up te maken.
function renderBackupReminder() {
  const el = document.getElementById('backup-reminder');
  if (!el) return;
  if (isStaticExport || state.snapshots.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const laatste = state.lastBackupAt ? new Date(state.lastBackupAt) : null;
  const dagen = laatste ? Math.floor((Date.now() - laatste.getTime()) / DAG_MS) : null;
  if (dagen !== null && dagen < BACKUP_HERINNERING_DAGEN) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const tekst = laatste
    ? `De laatste back-up is van ${fmtDate(state.lastBackupAt)} — ${dagenTekst(dagen)} geleden.`
    : 'Er is nog nooit een back-up gedownload.';
  el.classList.remove('hidden');
  el.innerHTML = `<strong>Back-up maken?</strong> ${esc(tekst)} Alle ${state.snapshots.length} opgeslagen updates staan alleen in deze browser; `
    + `raakt dit profiel kwijt, dan is die historie weg. `
    + `<button type="button" id="backup-reminder-btn" class="btn-primary btn-inline">Download back-up</button>`;
  const btn = document.getElementById('backup-reminder-btn');
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await exportBackup(); }
    catch (e) { showErrorToast('Back-up maken is mislukt: ' + e.message); btn.disabled = false; }
  });
}

// Leesbare stand van zaken bij de back-upknop in Instellingen.
function renderBackupStatus() {
  const el = document.getElementById('backup-last');
  if (!el) return;
  el.textContent = state.lastBackupAt
    ? `Laatste back-up: ${fmtDate(state.lastBackupAt)}.`
    : 'Nog geen back-up gedownload.';
}

function renderWvGebiedCard() {
  const container = document.getElementById('wv-gebied-body');
  if (!container) return;
  // Nooit WV'er-namen in de gedeelde teamexport laten belanden — ook niet
  // verstopt in de broncode achter een dichtgeklapt <details>-blok. De kaart
  // zelf is in de export ook via CSS verborgen (zie .static-export
  // #wv-gebied-card), maar dit zorgt ervoor dat de namen sowieso nooit in de
  // HTML terechtkomen, ongeacht CSS.
  if (isStaticExport) { container.innerHTML = ''; return; }
  const { rijen, regios, openTotaal, openMetWv } = buildWvStats();
  if (rijen.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen storingen gevonden voor de gevolgde WV\'ers.</p>';
    return;
  }

  // Het aandeel is het aandeel in het werk dat bij de gevolgde WV'ers ligt,
  // over alle regio's heen. Eerder werd dit per regio berekend; dat maakte het
  // werk van iemand die in twee regio's actief is onzichtbaar in de ene helft.
  const samenOpen = rijen.reduce((n, r) => n + r.nuOpen, 0);
  const rows = rijen.map(r => {
    const rij = {
      wvNaam: r.wvNaam,
      nuOpen: r.nuOpen,
      aandeel: samenOpen > 0 ? r.nuOpen / samenOpen : null,
      nieuwVenster: r.nieuwVenster,
      opgelostVenster: r.opgelostVenster,
      totaal: r.orders.size,
      doorlooptijd: r.doorlooptijden.length ? r.doorlooptijden.reduce((a, b) => a + b, 0) / r.doorlooptijden.length : null,
    };
    regios.forEach(regio => { rij['regio_' + regio] = r.perRegio[regio] || 0; });
    return rij;
  }).sort((a, b) => b.nuOpen - a.nuOpen || a.wvNaam.localeCompare(b.wvNaam));

  // Twee dingen die je als teamleider wilt weten: hoeveel van de werkvoorraad
  // ligt überhaupt bij deze mensen, en is het eerlijk verdeeld.
  const zonderWv = openTotaal - openMetWv;
  const dekking = `<li>Samen ${samenOpen} van de ${openTotaal} openstaande storingen op naam`
    + (zonderWv > 0 ? ` — ${zonderWv} ${zonderWv === 1 ? 'staat' : 'staan'} op iemand buiten deze groep of hebben geen naam.` : '.')
    + '</li>';

  const gesorteerd = rows.slice().sort((a, b) => b.nuOpen - a.nuOpen);
  const hoog = gesorteerd[0], laag = gesorteerd[gesorteerd.length - 1];
  let verdeling;
  if (rows.length < 2) {
    verdeling = `<li>Alleen ${esc(hoog.wvNaam)} heeft werk op naam — geen vergelijking mogelijk.</li>`;
  } else if (hoog.nuOpen === laag.nuOpen) {
    verdeling = `<li>Gelijk verdeeld: ${hoog.nuOpen} elk.</li>`;
  } else {
    const verschil = hoog.nuOpen - laag.nuOpen;
    const factor = laag.nuOpen > 0 ? hoog.nuOpen / laag.nuOpen : null;
    const scheef = factor === null || factor >= 1.5;
    verdeling = `<li><strong class="${scheef ? 'prognose-bad' : ''}">${esc(hoog.wvNaam)} ${hoog.nuOpen}</strong> tegenover ${esc(laag.wvNaam)} ${laag.nuOpen}`
      + ` — ${verschil} storing${verschil === 1 ? '' : 'en'} verschil${factor !== null ? `, ${factor.toFixed(1)}×` : ''}.`
      + (scheef ? ' Dat is scheef genoeg om te herverdelen.' : '')
      + '</li>';
  }

  container.innerHTML = `<ul class="wv-oordeel">${dekking}${verdeling}</ul>`;
  const tabel = document.createElement('div');
  container.appendChild(tabel);
  const kolommen = buildWvColumns(regios);
  // Na een regiowissel kan er op een kolom gesorteerd staan die er niet meer is.
  if (!kolommen.some(k => k.key === state.wvSortState.key)) state.wvSortState = { key: 'nuOpen', dir: -1 };
  const sorted = sortByState(rows, state.wvSortState);
  renderFullTable(tabel, sorted, kolommen, state.wvSortState);
}

/* ---------- Historie-helpers ---------- */

// De Instandhoudingsapp heeft drie losse overzichten die elk apart worden
// geplakt: de NUS-storingen, de saneringen en de klantaanvragen. Elke
// plakactie ververst dus maar één van die drie lijsten.
const LIJST_SOORTEN = ['nus', 'sanering', 'klantaanvraag'];
const LIJST_LABELS = {
  nus: 'NUS-storingen',
  sanering: 'Saneringen',
  klantaanvraag: 'Klantaanvragen',
};

// Voor plakacties van vóór deze indeling (en als vangnet) wordt de soort uit
// de inhoud afgeleid. Bewust streng: alleen als ALLES in de lijst een
// klantaanvraag of een sanering is, is het dat overzicht. Een gemengde lijst
// geldt als de NUS-lijst — dat is het oude gedrag, en dat mag niet stilletjes
// veranderen voor al opgeslagen data.
function afleidenLijstSoort(storingen) {
  if (!storingen || storingen.length === 0) return 'nus';
  if (storingen.every(isKlantaanvraag)) return 'klantaanvraag';
  if (storingen.every(isSanering)) return 'sanering';
  return 'nus';
}
function lijstSoortVan(sn) {
  return LIJST_SOORTEN.includes(sn.lijst) ? sn.lijst : afleidenLijstSoort(sn.storingen);
}

// Eén beeld per kalenderdag, chronologisch, samengesteld uit de drie lijsten.
//
// Twee dingen komen hier samen:
//  - Op één dag staan meerdere plakacties van DEZELFDE lijst (eerst de
//    gebieds-weergave, daarna de status-weergave). Dat zijn twee blikken op
//    hetzelfde moment, geen twee momenten: de laatste van die dag wint.
//  - De drie lijsten zijn losse overzichten. Een plakactie ververst alleen de
//    lijst waar hij bij hoort; de andere twee blijven staan zoals ze het
//    laatst geplakt waren. Zonder dat zou het plakken van de klantaanvragen
//    de hele NUS-werkvoorraad op nul zetten — die storingen staan immers niet
//    in dat overzicht, en "verdwenen uit de lijst" betekent normaal "opgelost".
function chronoSnapshots(snapshots) {
  const bron = snapshots || state.snapshots;
  const eigenState = !snapshots;
  const sleutel = bron.length + '|' + (bron.length ? bron[bron.length - 1].savedAt : '');
  if (eigenState && chronoCacheSleutel === sleutel) return chronoCache;

  const list = bron.slice().sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt));
  const laatstePerLijst = {}; // soort -> de meest recente plakactie van dat overzicht
  const dagen = [];
  let i = 0;
  while (i < list.length) {
    const dag = list[i].week;
    let laatsteSavedAt = list[i].savedAt;
    while (i < list.length && list[i].week === dag) {
      laatstePerLijst[lijstSoortVan(list[i])] = list[i];
      laatsteSavedAt = list[i].savedAt;
      i++;
    }
    // Nieuwste plakactie eerst, zodat bij een ordernummer dat in twee lijsten
    // opduikt de meest recente informatie wint.
    const bronnen = LIJST_SOORTEN.map(soort => laatstePerLijst[soort]).filter(Boolean)
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    const gezien = new Set();
    const storingen = [];
    bronnen.forEach(sn => sn.storingen.forEach(st => {
      if (gezien.has(st.order)) return;
      gezien.add(st.order);
      storingen.push(st);
    }));
    dagen.push({ week: dag, savedAt: laatsteSavedAt, storingen });
  }

  if (eigenState) { chronoCache = dagen; chronoCacheSleutel = sleutel; }
  return dagen;
}
// chronoSnapshots wordt tientallen keren per hertekening aangeroepen; het
// samenvoegen hoeft maar één keer per verandering van de opgeslagen data.
let chronoCache = null;
let chronoCacheSleutel = null;

// Wanneer is elk overzicht voor het laatst geplakt? Met drie lijsten die
// onafhankelijk worden ververst is dat geen detail meer: een sanering die
// allang weg is blijft in beeld tot dat overzicht opnieuw wordt geplakt.
function lijstBijgewerkt() {
  const per = {};
  state.snapshots.slice()
    .sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt))
    .forEach(sn => { per[lijstSoortVan(sn)] = sn; });
  return per;
}

const DAG_MS = 86400000;
function dagenTussen(vanIso, totIso) {
  return Math.round((new Date(totIso) - new Date(vanIso)) / DAG_MS);
}

/* ---------- Prognose: verloopkalender ---------- */

// De verloopkalender is bewust géén voorspelling: daysLeft is een aftelling
// die al vastligt, dus "over 2 weken verlopen er 14" is een zekerheid zolang
// er niets gebeurt. Dat maakt 'm bruikbaar om capaciteit op te plannen, in
// tegenstelling tot een trendprojectie die altijd een slag om de arm houdt.
//
// De splitsing wel/geen uitvoeringsdatum is het punt van deze kaart: een
// storing die volgende week verloopt maar een geplande uitvoeringsdatum heeft
// is een heel ander soort werk dan eentje zonder plan. Geblokkeerde storingen
// worden apart geteld omdat daar per definitie iemand anders aan zet is —
// ze tellen niet mee als "zonder plan", want dan zou de actielijst vervuilen
// met werk waar je deze week niets aan kunt doen.
const VERLOOP_BUCKETS = [
  { key: 'verlopen', label: 'Al verlopen', short: 'Verlopen', test: d => d < 0 },
  { key: 'week0', label: 'Binnen 7 dagen', short: '0–7 dgn', test: d => d >= 0 && d < 7 },
  { key: 'week1', label: 'Over 7–14 dagen', short: '7–14 dgn', test: d => d >= 7 && d < 14 },
  { key: 'week2', label: 'Over 14–21 dagen', short: '14–21 dgn', test: d => d >= 14 && d < 21 },
  { key: 'week3', label: 'Over 21–28 dagen', short: '21–28 dgn', test: d => d >= 21 && d < 28 },
  { key: 'later', label: 'Over 28 dagen of later', short: '28+ dgn', test: d => d >= 28 },
];

// Drie elkaar uitsluitende categorieën, in oplopende urgentie voor jou als
// aanstuurder: geblokkeerd (iemand anders aan zet), gepland (datum staat er,
// datum is nog niet verstreken), zonder plan (niemand heeft het opgepakt).
function verloopCategorieOf(s) {
  if (isOvBlocked(s)) return 'geblokkeerd';
  if (s.executionDate && !isExpiredExecutionDate(s)) return 'gepland';
  return 'zonderPlan';
}
// Stapelvolgorde is bewust rood → grijs → groen: rood en groen zijn onder
// rood-groenblindheid nauwelijks te scheiden (ΔE 5.5 deutan), dus het neutrale
// grijs staat ertussen zodat geen enkel aangrenzend paar op kleur alleen hoeft
// te worden onderscheiden (gecontroleerd met scripts/validate_palette.js uit de
// dataviz-skill: CVD-scheiding slaagt in zowel licht als donker). Grijs voor
// "geblokkeerd" klopt ook inhoudelijk: dat werk ligt bij iemand anders, dus het
// hoort niet mee te schreeuwen om aandacht.
const VERLOOP_CATS = [
  { key: 'zonderPlan', label: 'Zonder plan', color: 'var(--status-critical)' },
  { key: 'geblokkeerd', label: 'Geblokkeerd', color: 'var(--series-other)' },
  { key: 'gepland', label: 'Gepland', color: 'var(--status-good)' },
];

function buildVerloopkalender(current) {
  return VERLOOP_BUCKETS.map(b => {
    const bucket = { key: b.key, label: b.label, short: b.short, zonderPlan: 0, gepland: 0, geblokkeerd: 0, total: 0 };
    current.forEach(s => {
      if (typeof s.daysLeft !== 'number' || !b.test(s.daysLeft)) return;
      bucket[verloopCategorieOf(s)]++;
      bucket.total++;
    });
    return bucket;
  });
}

function renderVerloopkalender(current) {
  const container = document.getElementById('verloopkalender-body');
  if (!container) return;
  const buckets = buildVerloopkalender(current);
  if (buckets.every(b => b.total === 0)) {
    container.innerHTML = '<p class="empty-note">Geen open storingen om vooruit te kijken.</p>';
    return;
  }

  const barW = 46, gap = 30, leftPad = 40, topPad = 16, plotH = 190, bottomPad = 38;
  const chartW = Math.max(420, buckets.length * (barW + gap) + leftPad);
  const chartH = topPad + plotH + bottomPad;
  const maxTotal = Math.max(...buckets.map(b => b.total), 1);
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
  buckets.forEach((b, idx) => {
    const x = leftPad + idx * (barW + gap) + gap / 2;
    let yCursor = topPad + plotH;
    VERLOOP_CATS.forEach(cat => {
      const val = b[cat.key];
      if (val <= 0) return;
      const h = val * scale;
      const yTop = yCursor - h;
      bars += `<rect class="seg" data-bucket="${esc(b.label)}" data-cat="${esc(cat.label)}" data-count="${val}"
        x="${x}" y="${yTop + 1}" width="${barW}" height="${Math.max(h - 2, 0)}" rx="3"
        fill="${cat.color}" />`;
      yCursor = yTop;
    });
    bars += `<text x="${x + barW / 2}" y="${topPad + plotH + 20}" text-anchor="middle">${esc(b.short)}</text>`;
    if (b.total > 0) {
      bars += `<text x="${x + barW / 2}" y="${topPad + plotH - b.total * scale - 6}" text-anchor="middle" style="fill:var(--text-primary);font-weight:600;">${b.total}</text>`;
    }
  });

  // De koptekst vat de kalender samen in de zin waar je iets aan hebt: wat
  // komt er de komende twee weken aan, en hoeveel daarvan heeft nog geen plan.
  const komende2 = buckets.filter(b => b.key === 'week0' || b.key === 'week1');
  const komendTotal = komende2.reduce((sum, b) => sum + b.total, 0);
  const komendZonderPlan = komende2.reduce((sum, b) => sum + b.zonderPlan, 0);

  // Koppeling met de clusterkaart: van de storingen die bijna verlopen liggen
  // er vaak een paar bij elkaar. Dat is de goedkoopste winst die er is — één
  // rit lost er dan meerdere tegelijk op — maar je ziet het niet als beide
  // kaarten los van elkaar staan.
  const komendeStoringen = current.filter(s => typeof s.daysLeft === 'number' && s.daysLeft >= 0 && s.daysLeft < 14);
  const perGebied = new Map();
  komendeStoringen.forEach(s => {
    const sleutel = pc4Van(s.postcode);
    if (!sleutel) return;
    const key = `${s.city || 'Onbekend'}|||${sleutel}`;
    perGebied.set(key, (perGebied.get(key) || 0) + 1);
  });
  const clusterGroepen = Array.from(perGebied.values()).filter(n => n >= 2);
  const inClusters = clusterGroepen.reduce((a, b) => a + b, 0);
  const clusterZin = clusterGroepen.length > 0
    ? `<p class="muted small">Daarvan liggen er <strong>${inClusters}</strong> in ${clusterGroepen.length} postcodegebied${clusterGroepen.length === 1 ? '' : 'en'} bij elkaar — zie <em>Slim inplannen</em> op Gebieden; één rit pakt daar meerdere tegelijk.</p>`
    : '';

  container.innerHTML = `
    <p class="prognose-headline">Komende 2 weken ${komendTotal === 1 ? 'bereikt' : 'bereiken'} <strong>${komendTotal}</strong> storing${komendTotal === 1 ? '' : 'en'} ${komendTotal === 1 ? 'zijn' : 'hun'} uiterste datum, waarvan <strong class="${komendZonderPlan > 0 ? 'prognose-bad' : ''}">${komendZonderPlan}</strong> zonder uitvoeringsdatum.</p>
    ${clusterZin}
    <svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" width="100%" height="${chartH}">
      <line class="axis-line" x1="${leftPad}" x2="${leftPad}" y1="${topPad}" y2="${topPad + plotH}" />
      ${gridSvg}
      ${bars}
    </svg>
    <div class="legend">
      ${VERLOOP_CATS.map(c => `<span class="legend-item"><span class="legend-swatch" style="background:${c.color}"></span>${esc(c.label)}</span>`).join('')}
    </div>`;

  container.querySelectorAll('.seg').forEach(rect => {
    rect.addEventListener('mouseenter', e => showTooltip(e, `<strong>${esc(rect.dataset.bucket)}</strong><br>${esc(rect.dataset.cat)}: ${rect.dataset.count}`));
    rect.addEventListener('mousemove', moveTooltip);
    rect.addEventListener('mouseleave', hideTooltip);
  });
}

/* ---------- Prognose: benodigd tempo ---------- */

// Instroom/uitstroom per week-overgang, over de laatste TEMPO_WEEKS overgangen.
// Bewust een kort venster: het tempo van een half jaar geleden zegt weinig over
// wat je nu moet halen, en een lang gemiddelde verbergt juist de omslag die je
// wilt zien. Alles loopt via dezelfde zichtbaarheidsfilters als de rest van het
// dashboard, zodat de aantallen aansluiten bij wat je in de tabellen ziet.
const TEMPO_VENSTER_DAGEN = 56; // 8 weken

function buildTempoStats() {
  const snaps = chronoSnapshots();
  const visibleOf = (list) => filterByActive(typeFiltered(list));
  if (snaps.length < 2) return null;

  // Elke overgang draagt zijn éigen lengte in dagen mee. Het dashboard wordt
  // dagelijks bijgewerkt, dus twee opeenvolgende updates liggen meestal één dag
  // uit elkaar — maar na een weekend of vakantie ineens drie of tien. Zou je
  // simpelweg over overgangen middelen, dan telt een gat van tien dagen even
  // zwaar als een gat van één en klopt het tempo niet meer.
  const transitions = [];
  for (let i = 1; i < snaps.length; i++) {
    const prevOrders = new Set(visibleOf(snaps[i - 1].storingen).map(s => s.order));
    const curOrders = new Set(visibleOf(snaps[i].storingen).map(s => s.order));
    let instroom = 0, opgelost = 0;
    curOrders.forEach(o => { if (!prevOrders.has(o)) instroom++; });
    prevOrders.forEach(o => { if (!curOrders.has(o)) opgelost++; });
    const dagen = Math.max(1, Math.round((new Date(snaps[i].week) - new Date(snaps[i - 1].week)) / 86400000));
    transitions.push({ week: snaps[i].week, vorigeWeek: snaps[i - 1].week, instroom, opgelost, dagen, open: curOrders.size });
  }

  const laatste = new Date(snaps[snaps.length - 1].week);
  const recent = transitions.filter(tr => (laatste - new Date(tr.week)) / 86400000 <= TEMPO_VENSTER_DAGEN);
  if (recent.length === 0) return null;

  const totaalDagen = recent.reduce((sum, tr) => sum + tr.dagen, 0);
  const totaalIn = recent.reduce((sum, tr) => sum + tr.instroom, 0);
  const totaalUit = recent.reduce((sum, tr) => sum + tr.opgelost, 0);
  if (totaalDagen === 0) return null;

  // Alles wordt uitgedrukt per week, ongeacht hoe vaak je bijwerkt: dat is de
  // eenheid waarin je plant, en 'm loskoppelen van de bijwerkfrequentie zorgt
  // dat de getallen niet veranderen als je een paar dagen overslaat.
  const perWeek = (totaal) => (totaal / totaalDagen) * 7;
  const avgIn = perWeek(totaalIn);
  const avgUit = perWeek(totaalUit);
  const open = visibleOf(snaps[snaps.length - 1].storingen).length;

  // Voor de tabel bundelen we tot blokken van 7 dagen terug vanaf de laatste
  // update — bij dagelijks bijwerken zouden losse overgangen anders 56 regels
  // opleveren waar je niets uit afleest.
  const buckets = [];
  for (let b = 0; b < Math.ceil(totaalDagen / 7) && b < 8; b++) {
    const tot = new Date(laatste.getTime() - b * 7 * 86400000);
    const van = new Date(laatste.getTime() - (b + 1) * 7 * 86400000);
    const inBucket = recent.filter(tr => {
      const d = new Date(tr.week);
      return d > van && d <= tot;
    });
    if (inBucket.length === 0) continue;
    buckets.push({
      van: van.toISOString().slice(0, 10),
      tot: tot.toISOString().slice(0, 10),
      instroom: inBucket.reduce((s, tr) => s + tr.instroom, 0),
      opgelost: inBucket.reduce((s, tr) => s + tr.opgelost, 0),
      open: inBucket[inBucket.length - 1].open,
    });
  }
  buckets.reverse();

  return { buckets, avgIn, avgUit, open, netto: avgIn - avgUit, dagen: totaalDagen, updates: recent.length };
}

// Aandeel "mast geen spanning" in de huidige werkvoorraad — gebruikt om de
// benodigde capaciteit ruwweg over Meetdienst en MIO te verdelen.
function mioAandeelVanOpen() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return null;
  const open = filterByActive(typeFiltered(snaps[snaps.length - 1].storingen));
  if (open.length === 0) return null;
  return open.filter(isMastGeenSpanning).length / open.length;
}

function renderTempoCard() {
  const container = document.getElementById('tempo-body');
  if (!container) return;
  const t = buildTempoStats();
  if (!t) {
    container.innerHTML = '<p class="empty-note">Verwerk minstens twee updates op verschillende dagen om instroom en oplostempo te kunnen vergelijken.</p>';
    return;
  }

  // Het netto-getal is de kern: positief = de voorraad groeit, en dan is
  // "hoeveel extra per week" een concreter stuurgetal dan een percentage.
  const groeit = t.netto > 0.05;
  const krimpt = t.netto < -0.05;
  const tekort = Math.abs(t.netto);

  let oordeel;
  if (groeit) {
    const over8 = Math.round(t.open + t.netto * 8);
    oordeel = `<p class="prognose-headline">Je loopt <strong class="prognose-bad">${tekort.toFixed(1)} storing${tekort.toFixed(1) === '1.0' ? '' : 'en'} per week achter</strong>. Blijft dit zo, dan staan er over 8 weken ongeveer <strong>${over8}</strong> open in plaats van ${t.open}.</p>`;
  } else if (krimpt) {
    const wekenLeeg = t.open / tekort;
    const extra = wekenLeeg <= 52 ? ` Bij dit tempo is de huidige voorraad over ongeveer ${Math.round(wekenLeeg)} weken weggewerkt.` : '';
    oordeel = `<p class="prognose-headline">Je werkt de voorraad in: <strong class="prognose-good">${tekort.toFixed(1)} storing${tekort.toFixed(1) === '1.0' ? '' : 'en'} per week minder</strong> dan er bijkomen.${extra}</p>`;
  } else {
    oordeel = `<p class="prognose-headline">Instroom en uitstroom zijn <strong>in evenwicht</strong> — de voorraad blijft rond de ${t.open} storingen hangen.</p>`;
  }

  const rows = t.buckets.map(b => {
    const netto = b.instroom - b.opgelost;
    const nettoCls = netto > 0 ? 'prognose-bad' : netto < 0 ? 'prognose-good' : '';
    return `<tr><td>${esc(b.van)} t/m ${esc(b.tot)}</td><td class="num">${b.instroom}</td><td class="num">${b.opgelost}</td><td class="num ${nettoCls}">${netto > 0 ? '+' : ''}${netto}</td><td class="num">${b.open}</td></tr>`;
  }).join('');

  // Benodigd tempo is pas een oordeel als je weet wat er beschikbaar is.
  // Zonder ingevulde capaciteit blijft dit blok weg, zodat de kaart precies
  // doet wat 'ie eerst deed.
  const cap = state.capaciteit || LEGE_CAPACITEIT;
  const capTotaal = (cap.meetdienst || 0) + (cap.mio || 0);
  let capBlok = '';
  if (capTotaal > 0) {
    const benodigd = t.avgIn;
    const gat = capTotaal - benodigd;
    const haalbaar = gat >= 0;
    const mioAandeel = mioAandeelVanOpen();
    const mioNodig = mioAandeel === null ? null : benodigd * mioAandeel;
    const meetNodig = mioNodig === null ? null : benodigd - mioNodig;
    capBlok = `
      <p class="prognose-headline">Beschikbaar is <strong>${capTotaal}</strong> per week tegenover <strong>${benodigd.toFixed(1)}</strong> nodig — `
      + `<strong class="${haalbaar ? 'prognose-good' : 'prognose-bad'}">${haalbaar ? `${gat.toFixed(1)} over` : `${Math.abs(gat).toFixed(1)} te kort`}</strong>`
      + `${haalbaar ? ' om de voorraad vlak te houden.' : ' om de voorraad vlak te houden; de achterstand loopt dus op.'}</p>`
      + (mioNodig !== null && cap.mio > 0 ? `<p class="muted small">Naar de huidige verhouding (${Math.round(mioAandeel * 100)}% mast geen spanning) `
        + `zou dat ruwweg ${meetNodig.toFixed(1)} Meetdienst en ${mioNodig.toFixed(1)} MIO per week zijn, tegenover ${cap.meetdienst} en ${cap.mio} beschikbaar. `
        + `Niet elke mast kan zonder Meetdienst, dus dit is een bovengrens voor MIO.</p>` : '');
  }

  container.innerHTML = `
    ${oordeel}
    ${capBlok}
    <div class="tempo-grid">
      <div class="tempo-stat"><div class="label">Gem. instroom</div><div class="value">${t.avgIn.toFixed(1)}</div><div class="muted small">per week</div></div>
      <div class="tempo-stat"><div class="label">Gem. opgelost</div><div class="value">${t.avgUit.toFixed(1)}</div><div class="muted small">per week</div></div>
      <div class="tempo-stat"><div class="label">Benodigd tempo</div><div class="value">${Math.ceil(t.avgIn)}</div><div class="muted small">per week om vlak te blijven</div></div>
      <div class="tempo-stat"><div class="label">Nu open</div><div class="value">${t.open}</div><div class="muted small">storingen</div></div>
    </div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Periode</th><th class="num">Nieuw</th><th class="num">Opgelost</th><th class="num">Netto</th><th class="num">Open aan eind</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="muted small">Gebaseerd op ${t.dagen} dag${t.dagen === 1 ? '' : 'en'} historie. Instroom en oplostempo worden omgerekend naar een weektempo, zodat de getallen niet verspringen als je een dag overslaat.</p>`;
}

/* ---------- Prognose: stagnatiesignaal ---------- */

// Hoeveel weken staat een storing al onafgebroken in dezelfde OV-status? Dat
// is iets anders dan leeftijd: een storing die netjes doorstroomt van Nieuw
// naar In onderzoek naar Planning is oud maar gezond. Eentje die al tien weken
// op "In onderzoek" staat, staat stil — ook als de uiterste datum nog ver weg
// ligt, waardoor 'ie nergens anders in het dashboard opvalt.
//
// De referentie is de mediaan per status, niet één vaste drempel: "In
// voorbereiding" duurt van nature langer dan "Nieuw", dus een vaste drempel
// zou de ene status overspoelen en de andere nooit raken. Alles in dagen,
// net als de rest van het dashboard — weken als aparte eenheid hier maakte
// het onnodig lastig te vergelijken met de dagen-teller ernaast. De mediaan is
// bovendien ongevoelig voor een handvol extreem lang liggende gevallen, die
// een gemiddelde juist zo optrekken dat er niets meer opvalt.
const STAGNATIE_MIN_DAGEN = 21;  // onder de drie weken is "stilstand" ruis
const STAGNATIE_RATIO = 2;       // pas melden vanaf 2x de mediaan van die status

function buildStatusDuurStats() {
  const snaps = chronoSnapshots();
  const visibleOf = (list) => filterByActive(typeFiltered(list));
  // Per order: sinds welke week staat 'ie onafgebroken op de huidige status.
  const lopend = {};
  // Per status: alle afgeronde "hoe lang stond het hierop"-metingen, in weken.
  const afgerond = {};

  snaps.forEach((sn, idx) => {
    const seen = new Set();
    visibleOf(sn.storingen).forEach(s => {
      if (!s.ovStatus) return;
      seen.add(s.order);
      const cur = lopend[s.order];
      if (!cur) {
        lopend[s.order] = { status: s.ovStatus, sinds: sn.week, index: idx };
      } else if (cur.status !== s.ovStatus) {
        const dagen = dagenTussen(cur.sinds, sn.week);
        if (dagen >= 0) (afgerond[cur.status] = afgerond[cur.status] || []).push(dagen);
        lopend[s.order] = { status: s.ovStatus, sinds: sn.week, index: idx };
      }
    });
    // Verdwenen storingen sluiten hun lopende status-periode af: ook dát is
    // een meting van hoe lang die status normaal duurt.
    Object.keys(lopend).forEach(order => {
      if (seen.has(order) || lopend[order].index >= idx) return;
      const cur = lopend[order];
      const dagen = dagenTussen(cur.sinds, sn.week);
      if (dagen >= 0) (afgerond[cur.status] = afgerond[cur.status] || []).push(dagen);
      delete lopend[order];
    });
  });

  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const medianen = {};
  Object.keys(afgerond).forEach(st => { if (afgerond[st].length >= 3) medianen[st] = median(afgerond[st]); });
  return { lopend, medianen };
}

function buildStagnatieRows() {
  const snaps = chronoSnapshots();
  if (snaps.length < 2) return [];
  const latest = snaps[snaps.length - 1];
  const { lopend, medianen } = buildStatusDuurStats();

  const rows = [];
  filterByActive(typeFiltered(latest.storingen)).forEach(s => {
    const cur = lopend[s.order];
    if (!cur || !s.ovStatus) return;
    const dagen = dagenTussen(cur.sinds, latest.week);
    if (dagen < STAGNATIE_MIN_DAGEN) return;
    // Zonder genoeg historie voor deze status valt er niets te vergelijken;
    // dan gebruiken we de minimumdrempel als referentie, zodat de kaart ook
    // in de eerste maanden al iets zinnigs laat zien in plaats van leeg te zijn.
    const mediaan = medianen[s.ovStatus] != null ? medianen[s.ovStatus] : null;
    const referentie = mediaan != null ? Math.max(mediaan, 1) : STAGNATIE_MIN_DAGEN;
    const ratio = dagen / referentie;
    if (mediaan != null ? ratio < STAGNATIE_RATIO : dagen < STAGNATIE_MIN_DAGEN * 2) return;
    rows.push({
      order: s.order,
      plaats: s.city || 'Onbekend',
      gebiedscode: s.gebiedscode || '—',
      ovStatus: s.ovStatus,
      dagen,
      mediaan,
      ratio,
      geblokkeerd: isOvBlocked(s),
      daysLeft: typeof s.daysLeft === 'number' ? s.daysLeft : null,
      storing: s,
    });
  });
  return rows;
}

const STAGNATIE_COLUMNS = [
  { key: 'order', label: 'Order', cell: r => `<td>${orderLinkHtml(r.order)}</td>` },
  { key: 'plaats', label: 'Plaats', cell: r => `<td>${esc(r.plaats)}</td>` },
  { key: 'gebiedscode', label: 'Gebied', cell: r => `<td>${esc(r.gebiedscode)}</td>` },
  { key: 'ovStatus', label: 'Status', cell: r => `<td>${esc(r.ovStatus)}</td>` },
  { key: 'dagen', label: 'Dagen in status', num: true, cell: r => `<td class="num">${r.dagen}</td>` },
  { key: 'mediaan', label: 'Normaal', num: true, cell: r => `<td class="num">${r.mediaan == null ? '—' : Math.round(r.mediaan) + ' dgn'}</td>` },
  { key: 'ratio', label: 'Verhouding', num: true, cell: r => `<td class="num prognose-bad">${r.ratio.toFixed(1)}×</td>` },
  { key: 'daysLeft', label: 'Deadline', num: true, cell: r => `<td class="num">${r.daysLeft == null ? '—' : renderDaysPill(r.storing)}</td>` },
  { key: 'geblokkeerd', label: 'Geblokkeerd', cell: r => `<td>${r.geblokkeerd ? '🚧 ja' : '—'}</td>` },
];

// Waar hoopt het werk zich op? Het stagnatiesignaal wijst individuele
// storingen aan; deze kaart kijkt naar de stap in het proces. Twee getallen
// die iets anders zeggen:
//  - mediane duur: hoe lang een storing normaal in die status blijft;
//  - opgehoopt: alle wachttijd van wie er nu in zit, bij elkaar opgeteld.
// Een status kan een korte mediaan hebben en toch de grootste ophoping zijn
// (veel storingen), of andersom (weinig storingen die er heel lang liggen).
// Alleen op de mediaan sturen zou dat eerste geval missen.
function buildDoorstroomStats() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return [];
  const latest = snaps[snaps.length - 1];
  const { lopend, medianen } = buildStatusDuurStats();
  const huidig = filterByActive(typeFiltered(latest.storingen));

  return OV_STATUS_ORDER.map(status => {
    const inStatus = huidig.filter(s => s.ovStatus === status);
    const wachttijden = inStatus.map(s => {
      const cur = lopend[s.order];
      return cur ? dagenTussen(cur.sinds, latest.week) : 0;
    });
    return {
      status,
      aantal: inStatus.length,
      mediaan: medianen[status] != null ? medianen[status] : null,
      opgehoopt: wachttijden.reduce((a, b) => a + b, 0),
      langste: wachttijden.length ? Math.max(...wachttijden) : 0,
    };
  });
}

function renderDoorstroomCard() {
  const container = document.getElementById('doorstroom-body');
  if (!container) return;
  const rijen = buildDoorstroomStats();
  const totaalOpen = rijen.reduce((sum, r) => sum + r.aantal, 0);
  if (totaalOpen === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen openstaande storingen met een status om door te rekenen.</p>';
    return;
  }

  const zwaarste = rijen.slice().sort((a, b) => b.opgehoopt - a.opgehoopt)[0];
  const kop = zwaarste && zwaarste.opgehoopt > 0
    ? `<p class="prognose-headline">De meeste tijd hoopt zich op bij <strong>${esc(zwaarste.status)}</strong>: ${zwaarste.aantal} storing${zwaarste.aantal === 1 ? '' : 'en'}, samen <strong>${zwaarste.opgehoopt}</strong> wachtdagen.</p>`
    : '';

  const body = rijen.map(r => {
    const aandeel = zwaarste.opgehoopt > 0 ? r.opgehoopt / zwaarste.opgehoopt : 0;
    return `<tr>
      <td>${esc(r.status)}</td>
      <td class="num">${r.aantal}</td>
      <td class="num">${r.mediaan == null ? '—' : Math.round(r.mediaan) + ' dgn'}</td>
      <td class="num">${r.opgehoopt}</td>
      <td><div class="doorstroom-balk"><span style="width:${Math.round(aandeel * 100)}%"></span></div></td>
      <td class="num">${r.langste || '—'}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `${kop}
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Status</th><th class="num">Nu in deze status</th><th class="num">Mediane duur</th>
          <th class="num">Opgehoopt</th><th></th><th class="num">Langst wachtend</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted small">"Opgehoopt" is alle wachttijd van de storingen die nu in die status staan bij elkaar opgeteld, in dagen. "Mediane duur" is hoe lang een storing normaal in die status blijft voordat 'ie doorstroomt — die wordt pas getoond bij minstens drie afgeronde metingen.</p>`;
}

function renderStagnatieCard() {
  const container = document.getElementById('stagnatie-body');
  if (!container) return;
  const rows = buildStagnatieRows();
  if (rows.length === 0) {
    container.innerHTML = '<p class="empty-note">Geen stilstaande storingen gevonden — of er is nog te weinig historie om "normaal" te bepalen. Deze kaart wordt scherper naarmate er meer dagen zijn vastgelegd.</p>';
    return;
  }
  const sorted = sortByState(rows, state.stagnatieSortState);
  renderFullTable(container, sorted, STAGNATIE_COLUMNS, state.stagnatieSortState);
}

function renderPrognose(current) {
  renderVerloopkalender(current);
  renderTempoCard();
  renderDoorstroomCard();
  renderStagnatieCard();
}

/* ---------- Historie: tijdlijn van één storing ---------- */

// Bouwt de levensloop van één storing uit alle snapshots. Bewust een lijst
// GEBEURTENISSEN en niet één regel per update: bij dagelijks bijwerken zou dat
// honderden identieke regels geven waarin de paar echte veranderingen wegvallen.
// Alleen wat er ánders is dan de vorige dag komt in de tijdlijn — dat is precies
// het verhaal dat de ISH-app niet kan vertellen.
function buildOrderTimeline(order) {
  const snaps = chronoSnapshots();
  const events = [];
  const statusDuur = {};
  let prev = null;
  let eersteDatum = null;
  let laatsteDatum = null;
  let opgelostOp = null;
  let statusSinds = null;
  let laatsteRecord = null;

  const sluitStatus = (tot) => {
    if (prev && prev.ovStatus && statusSinds) {
      const d = dagenTussen(statusSinds, tot);
      if (d > 0) statusDuur[prev.ovStatus] = (statusDuur[prev.ovStatus] || 0) + d;
    }
  };

  snaps.forEach(sn => {
    const s = sn.storingen.find(x => x.order === order);
    if (s) {
      if (!prev) {
        // Eerste keer gezien, of terug na eerder opgelost te zijn geweest.
        if (opgelostOp) {
          events.push({ datum: sn.week, kind: 'heropend', tekst: `Opnieuw in de lijst verschenen, ${dagenTekst(dagenTussen(opgelostOp, sn.week))} na het verdwijnen` });
          opgelostOp = null;
        } else {
          eersteDatum = sn.week;
          events.push({ datum: sn.week, kind: 'start', tekst: `Voor het eerst in de lijst${s.ovStatus ? ` — status ${s.ovStatus}` : ''}` });
        }
        statusSinds = sn.week;
      } else {
        if (s.ovStatus !== prev.ovStatus && (s.ovStatus || prev.ovStatus)) {
          const dagen = statusSinds ? dagenTussen(statusSinds, sn.week) : null;
          sluitStatus(sn.week);
          events.push({
            datum: sn.week, kind: 'status',
            tekst: `Status ${prev.ovStatus || 'onbekend'} → ${s.ovStatus || 'onbekend'}${dagen != null && prev.ovStatus ? ` (${dagenTekst(dagen)} op ${prev.ovStatus})` : ''}`,
          });
          statusSinds = sn.week;
        }
        if ((s.executionDateRaw || '') !== (prev.executionDateRaw || '')) {
          events.push({
            datum: sn.week, kind: 'datum',
            tekst: `Uitvoeringsdatum ${prev.executionDateRaw ? esc(prev.executionDateRaw) : 'onbekend'} → ${s.executionDateRaw ? esc(s.executionDateRaw) : 'onbekend'}`,
          });
        }
        if (s.overdue && !prev.overdue) {
          events.push({ datum: sn.week, kind: 'verlopen', tekst: 'Uiterste datum verstreken' });
        }
        if (s.gebiedscode && s.gebiedscode !== prev.gebiedscode) {
          events.push({ datum: sn.week, kind: 'gebied', tekst: `Gebiedscode ${prev.gebiedscode ? prev.gebiedscode + ' → ' : ''}${s.gebiedscode}` });
        }
      }
      laatsteDatum = sn.week;
      laatsteRecord = s;
      prev = s;
    } else if (prev) {
      sluitStatus(sn.week);
      opgelostOp = sn.week;
      events.push({
        datum: sn.week, kind: 'opgelost',
        tekst: `Niet meer in de lijst — opgelost na ${dagenTekst(dagenTussen(eersteDatum, sn.week))}`,
      });
      prev = null;
      statusSinds = null;
    }
  });

  // Nog open? Dan loopt de huidige status door tot vandaag/de laatste update.
  if (prev && statusSinds && laatsteDatum) sluitStatus(laatsteDatum);

  const open = !!prev;
  return {
    order,
    record: laatsteRecord,
    eersteDatum,
    laatsteDatum,
    opgelostOp: open ? null : opgelostOp,
    open,
    doorlooptijd: eersteDatum ? dagenTussen(eersteDatum, open ? laatsteDatum : opgelostOp) : null,
    statusDuur,
    events,
  };
}

// "1 dagen" leest als een tikfout en ondermijnt het vertrouwen in de rest van
// de getallen, dus enkelvoud/meervoud gaat overal via dit hulpje.
function dagenTekst(n) { return `${n} ${n === 1 ? 'dag' : 'dagen'}`; }

function orderLinkHtml(order) {
  return `<button type="button" class="order-link" data-order="${esc(order)}" title="Bekijk de tijdlijn van deze storing">${esc(order)}</button>`;
}

const TIMELINE_ICONS = {
  start: '📥', status: '🔄', datum: '📅', verlopen: '⚠️', gebied: '🗺️', opgelost: '✅', heropend: '🔁',
};

function openTimeline(order) {
  const modal = document.getElementById('timeline-modal');
  const body = document.getElementById('timeline-body');
  const title = document.getElementById('timeline-title');
  if (!modal || !body) return;

  const tl = buildOrderTimeline(order);
  // Een klantaanvraag komt ook in de tijdlijn terecht (hij staat immers in de
  // opgeslagen momenten), maar het is geen storing en heeft geen OV-status.
  const aanvraag = !!tl.record && isKlantaanvraag(tl.record);
  title.textContent = `${aanvraag ? 'Klantaanvraag' : 'Storing'} ${order}`;

  if (!tl.record) {
    body.innerHTML = '<p class="empty-note">Deze storing komt in geen enkele opgeslagen update voor.</p>';
  } else {
    const r = tl.record;
    const blok = ovBlockStatusOf(order);
    const statusRegels = Object.keys(tl.statusDuur)
      .sort((a, b) => tl.statusDuur[b] - tl.statusDuur[a])
      .map(st => `<li><span>${esc(st)}</span><strong>${tl.statusDuur[st]} dgn</strong></li>`)
      .join('');

    body.innerHTML = `
      <dl class="timeline-meta">
        <div><dt>Adres</dt><dd>${esc(r.street)}, ${esc(r.postcode)} ${esc(r.city)}</dd></div>
        <div><dt>Type</dt><dd>${esc(r.type)}</dd></div>
        <div><dt>Asset</dt><dd>${esc(r.asset)}${r.assetType ? ' ' + esc(r.assetType) : ''}</dd></div>
        <div><dt>Gebied</dt><dd>${r.gebiedscode ? esc(r.gebiedscode) : '—'}</dd></div>
        ${aanvraag ? '' : `<div><dt>Status</dt><dd>${tl.open ? ovStatusPillHtml(r) : '<span class="status-pill">Opgelost</span>'}</dd></div>`}
        <div><dt>Blokkade</dt><dd>${blok.reason ? esc(OV_BLOCK_REASON_LABELS[blok.reason]) + (blok.note ? ` — ${esc(blok.note)}` : '') : '—'}</dd></div>
        <div><dt>Eerst gezien</dt><dd>${esc(tl.eersteDatum)}</dd></div>
        <div><dt>${tl.open ? 'Open sinds' : 'Opgelost op'}</dt><dd>${tl.open ? `${dagenTekst(tl.doorlooptijd)}` : `${esc(tl.opgelostOp)} (${dagenTekst(tl.doorlooptijd)})`}</dd></div>
      </dl>
      ${statusRegels ? `<h3 class="timeline-subhead">Tijd per status</h3><ul class="timeline-statuslist">${statusRegels}</ul>` : ''}
      <h3 class="timeline-subhead">Verloop</h3>
      <ol class="timeline-list">
        ${tl.events.map(e => `
          <li class="timeline-event timeline-${e.kind}">
            <span class="timeline-icon" aria-hidden="true">${TIMELINE_ICONS[e.kind] || '•'}</span>
            <span class="timeline-date">${esc(e.datum)}</span>
            <span class="timeline-text">${e.tekst}</span>
          </li>`).join('')}
      </ol>
      ${tl.events.length <= 1 ? '<p class="muted small">Sinds deze storing in beeld kwam is er niets aan veranderd.</p>' : ''}`;
  }

  if (typeof modal.showModal === 'function') { if (!modal.open) modal.showModal(); }
  else modal.setAttribute('open', '');
}

/* ---------- Historie: zoeken over alle updates ---------- */

// Eén regel per ordernummer over de hele historie heen, inclusief storingen die
// allang opgelost zijn. Dit is waar de zoekbalk op het Data-tabblad niet bij kan:
// die filtert alleen de huidige lijst.
// Eén regel per ordernummer, gedeeld door de zoekfunctie én de herhaallocaties
// zodat die twee onmogelijk uit elkaar kunnen lopen.
//
// De looptijd van een opgeloste storing loopt tot de update waarin 'ie voor het
// eerst wég was, niet tot de laatste waarin 'ie er nog stond. Het oplossen
// gebeurde ergens tussen die twee updates in, en de eerste-keer-weg-datum is
// dezelfde keuze die de doorlooptijd-kaart al maakt (zie resolvedDurations) —
// zouden we hier de laatst-geziene datum nemen, dan noemden twee kaarten in
// hetzelfde dashboard een andere doorlooptijd voor dezelfde storing.
function buildOrderIndex() {
  const snaps = chronoSnapshots();
  const index = new Map();
  snaps.forEach(sn => {
    const aanwezig = new Set();
    typeFiltered(sn.storingen).forEach(s => {
      aanwezig.add(s.order);
      let e = index.get(s.order);
      if (!e) {
        e = { order: s.order, eerst: sn.week, laatstGezien: sn.week, opgelostOp: null, record: s };
        index.set(s.order, e);
      }
      // Terug na eerder verdwenen te zijn: dan telt 'ie weer als open.
      e.opgelostOp = null;
      e.laatstGezien = sn.week;
      e.record = s;
    });
    index.forEach(e => {
      if (!e.opgelostOp && !aanwezig.has(e.order) && e.laatstGezien < sn.week) e.opgelostOp = sn.week;
    });
  });

  return Array.from(index.values()).map(e => {
    const open = !e.opgelostOp;
    return {
      order: e.order,
      city: e.record.city,
      street: e.record.street,
      postcode: e.record.postcode,
      asset: e.record.asset,
      assetType: e.record.assetType,
      type: e.record.type,
      gebiedscode: e.record.gebiedscode || '',
      ovStatus: e.record.ovStatus || '',
      eerst: e.eerst,
      laatst: open ? e.laatstGezien : e.opgelostOp,
      open,
      looptijd: dagenTussen(e.eerst, open ? e.laatstGezien : e.opgelostOp),
    };
  });
}

const HISTORIE_COLUMNS = [
  { key: 'order', label: 'Order', cell: r => `<td>${orderLinkHtml(r.order)}</td>` },
  { key: 'city', label: 'Plaats', cell: r => `<td>${esc(r.city)}</td>` },
  { key: 'street', label: 'Adres', cell: r => `<td>${esc(r.street)}, ${esc(r.postcode)}</td>` },
  { key: 'asset', label: 'Asset', cell: r => `<td>${esc(r.asset)}${r.assetType ? ' ' + esc(r.assetType) : ''}</td>` },
  { key: 'gebiedscode', label: 'Gebied', cell: r => `<td>${r.gebiedscode ? esc(r.gebiedscode) : '—'}</td>` },
  { key: 'eerst', label: 'Eerst gezien', cell: r => `<td>${esc(r.eerst)}</td>` },
  { key: 'open', label: 'Stand', cell: r => `<td>${r.open ? '<span class="ov-status-pill ov-status-nieuw">Open</span>' : `<span class="status-pill">Opgelost ${esc(r.laatst)}</span>`}</td>` },
  { key: 'looptijd', label: 'Looptijd', num: true, cell: r => `<td class="num">${r.looptijd} dgn${r.open ? ' <span class="muted small">(loopt)</span>' : ''}</td>` },
];

function renderHistorieSearch() {
  const container = document.getElementById('historie-body');
  const summary = document.getElementById('historie-summary');
  if (!container) return;

  const alle = buildOrderIndex();
  if (summary) {
    const opgelost = alle.filter(r => !r.open).length;
    summary.textContent = alle.length === 0
      ? ''
      : `${alle.length} storingen in de historie, waarvan ${opgelost} opgelost en ${alle.length - opgelost} nu open.`;
  }

  const q = (state.historieQuery || '').trim().toLowerCase();
  if (q.length < 2) {
    // Zonder zoekterm was deze kaart leeg, en daarmee het hele tabblad bij
    // binnenkomst. Standaard tonen we daarom de laatst opgeloste storingen:
    // dat is meteen bruikbaar ("wat is er de afgelopen tijd afgerond") en het
    // laat zien welke vorm de zoekresultaten hebben.
    const recent = alle.filter(r => !r.open).sort((a, b) => b.laatst.localeCompare(a.laatst)).slice(0, 10);
    if (recent.length === 0) {
      container.innerHTML = '<p class="empty-note">Nog geen opgeloste storingen in de historie. Zoek hierboven op ordernummer, straat, plaats, postcode of assetnummer.</p>';
      return;
    }
    container.innerHTML = '<p class="muted small">Laatst opgeloste storingen — of zoek hierboven om iets specifieks terug te vinden.</p>';
    const tabel = document.createElement('div');
    container.appendChild(tabel);
    renderFullTable(tabel, recent, HISTORIE_COLUMNS, { key: 'laatst', dir: -1 });
    return;
  }
  const treffers = alle.filter(r => [r.order, r.city, r.street, r.postcode, r.asset].some(v => (v || '').toLowerCase().includes(q)));
  if (treffers.length === 0) {
    container.innerHTML = '<p class="empty-note">Niets gevonden in de opgeslagen historie.</p>';
    return;
  }
  const sorted = sortByState(treffers, state.historieSortState);
  renderFullTable(container, sorted, HISTORIE_COLUMNS, state.historieSortState);
}

/* ---------- Historie: recidive / herhaallocaties ---------- */

// Plekken waar het steeds opnieuw misgaat. Elke storing telt één keer mee (op
// zijn ordernummer), toegeschreven aan de plek waar 'ie het eerst gezien werd.
// De waarde zit niet in "waar komen veel storingen vandaan" — dat is vooral een
// functie van hoeveel netwerk er ligt — maar in herhaling op dezelfde plek: dat
// wijst op iets structureels in plaats van pech. Vandaar de gemiddelde tussentijd
// als aparte kolom: vier storingen in tien jaar is iets anders dan vier in een
// half jaar, en dat verschil zie je niet aan het aantal alleen.
// De adresregel uit de bron is "Breestraat 40" — straatnaam MET huisnummer.
// Op dat veld groeperen betekent dat twee storingen even verderop in dezelfde
// straat als twee losse locaties tellen, waardoor er praktisch nooit herhaling
// gevonden wordt. Daarom het huisnummer (met eventuele toevoeging of
// bis-nummer) van het eind af halen. Een leidend getal blijft staan, zodat
// "1e Binnenvestgracht 5" netjes "1e Binnenvestgracht" wordt.
function straatZonderHuisnummer(street) {
  if (!street) return 'Onbekend';
  const zonder = street.replace(/\s+\d+\s*[a-zA-Z]?(\s*[-\/]\s*\d+\s*[a-zA-Z]?)?\s*$/, '').trim();
  return zonder || street.trim();
}

// Samenvatting per plaats: hoeveel straten daar meer dan één storing hadden,
// hoeveel storingen daarmee gemoeid zijn, en welk deel van alle storingen in
// die plaats dat is. Dat laatste is het eigenlijke signaal — twintig
// herhaalstoringen in een grote plaats zegt iets anders dan twintig in een dorp.
// Gebaseerd op de straat-indeling, want dat is de plek waar een monteur naartoe
// gaat; per asset zou dezelfde straat met twee verschillende masten niet als
// herhaling tellen.
function buildRecidivePerPlaats() {
  const alle = buildOrderIndex();
  const totaalPerPlaats = {};
  alle.forEach(r => {
    const stad = r.city || 'Onbekend';
    totaalPerPlaats[stad] = (totaalPerPlaats[stad] || 0) + 1;
  });

  const perPlaats = new Map();
  buildRecidiveStats('straat').forEach(g => {
    let p = perPlaats.get(g.city);
    if (!p) {
      p = { key: g.city, plaats: g.city, regios: new Set(), plekken: 0, storingen: 0, nuOpen: 0, tussentijden: [], doorlooptijden: [], straten: [] };
      perPlaats.set(g.city, p);
    }
    p.plekken++;
    p.storingen += g.aantal;
    p.nuOpen += g.nuOpen;
    if (g.tussentijd != null) p.tussentijden.push(g.tussentijd);
    if (g.doorlooptijd != null) p.doorlooptijden.push(g.doorlooptijd);
    if (g.gebiedscode && g.gebiedscode !== '—') p.regios.add(regioGroupOf({ gebiedscode: g.gebiedscode }));
    p.straten.push(g);
  });

  const gem = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return Array.from(perPlaats.values()).map(p => ({
    key: p.key,
    plaats: p.plaats,
    regio: p.regios.size ? sortByGroupOrder(Array.from(p.regios)).map(regioGroupLabel).join(' + ') : '—',
    plekken: p.plekken,
    aantal: p.storingen,
    totaalPlaats: totaalPerPlaats[p.plaats] || p.storingen,
    aandeel: totaalPerPlaats[p.plaats] ? p.storingen / totaalPerPlaats[p.plaats] : null,
    nuOpen: p.nuOpen,
    tussentijd: gem(p.tussentijden),
    doorlooptijd: gem(p.doorlooptijden),
    straten: p.straten,
  }));
}

const RECIDIVE_COLUMNS_PLAATS = [
  { key: 'plaats', label: 'Plaats', cell: r => recidiveSleutelCel(r, r.plaats) },
  { key: 'regio', label: 'Regio', cell: r => `<td>${esc(r.regio)}</td>` },
  { key: 'plekken', label: 'Herhaalplekken', num: true, cell: r => `<td class="num"><strong>${r.plekken}</strong></td>` },
  { key: 'aantal', label: 'Storingen daarop', num: true, cell: r => `<td class="num">${r.aantal}</td>` },
  { key: 'aandeel', label: 'Aandeel in plaats', num: true, cell: r => `<td class="num">${r.aandeel == null ? '—' : Math.round(r.aandeel * 100) + '%'}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num">${r.nuOpen}</td>` },
  { key: 'tussentijd', label: 'Gem. tussentijd', num: true, cell: r => `<td class="num">${r.tussentijd == null ? '—' : Math.round(r.tussentijd) + ' dgn'}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(0) + ' dgn'}</td>` },
];

function recidivePlaatsDetailHtml(r) {
  const rijen = r.straten.slice().sort((a, b) => b.aantal - a.aantal || a.street.localeCompare(b.street)).map(g => `<tr>
    <td>${esc(g.street)}</td>
    <td>${esc(g.gebiedscode)}</td>
    <td class="num">${g.aantal}</td>
    <td class="num">${g.adressen}</td>
    <td class="num">${g.tussentijd == null ? '—' : Math.round(g.tussentijd) + ' dgn'}</td>
    <td>${esc(g.eerste)}</td>
    <td>${esc(g.laatste)}</td>
    <td class="num">${g.nuOpen}</td>
  </tr>`).join('');
  return `<div class="recidive-detail">
      <p class="muted small">Straten in ${esc(r.plaats)} met twee of meer storingen. Wissel naar "Per straat" voor de losse orders per plek.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Straat</th><th>Gebied</th><th class="num">Storingen</th><th class="num">Adressen</th><th class="num">Gem. tussentijd</th><th>Eerste</th><th>Laatste</th><th class="num">Nu open</th></tr></thead>
          <tbody>${rijen}</tbody>
        </table>
      </div>
    </div>`;
}

function buildRecidiveStats(mode) {
  const groepen = new Map();
  buildOrderIndex().forEach(r => {
    const straat = straatZonderHuisnummer(r.street);
    const key = mode === 'asset' ? (r.asset || '') : `${r.city || 'Onbekend'}|||${straat}`;
    if (!key || key === '|||') return;
    let g = groepen.get(key);
    if (!g) {
      g = { key, city: r.city || 'Onbekend', street: straat, asset: r.asset || '—', assetType: r.assetType || '', gebiedscode: r.gebiedscode || '', orders: [], adressen: new Set() };
      groepen.set(key, g);
    }
    g.orders.push(r);
    g.adressen.add(r.street || '');
    if (!g.gebiedscode && r.gebiedscode) g.gebiedscode = r.gebiedscode;
  });

  return Array.from(groepen.values())
    .filter(g => g.orders.length >= 2)
    .map(g => {
      const data = g.orders.slice().sort((a, b) => b.eerst.localeCompare(a.eerst));
      const opEerst = data.slice().sort((a, b) => a.eerst.localeCompare(b.eerst));
      const eerste = opEerst[0].eerst;
      const laatste = opEerst[opEerst.length - 1].eerst;
      const spanDagen = dagenTussen(eerste, laatste);
      const afgerond = data.filter(o => !o.open);
      return {
        key: g.key,
        city: g.city,
        street: g.street,
        asset: g.asset,
        assetType: g.assetType,
        gebiedscode: g.gebiedscode || '—',
        aantal: data.length,
        adressen: g.adressen.size,
        eerste,
        laatste,
        // Gemiddelde tijd tussen twee opeenvolgende storingen op deze plek.
        tussentijd: data.length > 1 ? spanDagen / (data.length - 1) : null,
        nuOpen: data.filter(o => o.open).length,
        doorlooptijd: afgerond.length ? afgerond.reduce((sum, o) => sum + o.looptijd, 0) / afgerond.length : null,
        storingen: data,
      };
    });
}

// De sleutelkolom is een knop: die klapt de onderliggende storingen uit. Zonder
// die lijst zie je wél dát een plek drie keer is gestoord, maar niet welke
// storingen dat waren — en juist dat bepaalt of er iets structureel aan de hand
// is of dat het drie losse toevalligheden zijn.
function recidiveSleutelCel(r, tekst) {
  const open = state.recidiveOpen.has(r.key);
  return `<td><button type="button" class="recidive-toggle${open ? ' open' : ''}" data-recidive-key="${esc(r.key)}"`
    + ` aria-expanded="${open}" title="${open ? 'Storingen verbergen' : 'Bekijk de storingen op deze plek'}">`
    + `<span class="recidive-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${esc(tekst)}</button></td>`;
}

function recidiveDetailHtml(r) {
  const rijen = r.storingen.map(s => `<tr>
    <td>${orderLinkHtml(s.order)}</td>
    <td>${esc(s.street)}, ${esc(s.postcode)}</td>
    <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}${saneringBadgeHtml(s)}</td>
    <td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>
    <td>${esc(s.eerst)}</td>
    <td>${s.open ? '<span class="ov-status-pill ov-status-nieuw">Nog open</span>' : `<span class="status-pill">Opgelost ${esc(s.laatst)}</span>`}</td>
    <td class="num">${s.looptijd} dgn</td>
  </tr>`).join('');
  return `<div class="recidive-detail">
      <p class="muted small">Alle storingen op deze plek, nieuwste eerst. Klik een ordernummer voor de volledige tijdlijn.</p>
      <div class="table-scroll">
        <table>
          <thead><tr><th>Order</th><th>Adres</th><th>Type</th><th>Asset</th><th>Eerst gezien</th><th>Stand</th><th class="num">Looptijd</th></tr></thead>
          <tbody>${rijen}</tbody>
        </table>
      </div>
    </div>`;
}

const RECIDIVE_COLUMNS_STRAAT = [
  { key: 'city', label: 'Plaats', cell: r => `<td>${esc(r.city)}</td>` },
  { key: 'street', label: 'Straat', cell: r => recidiveSleutelCel(r, r.street) },
  { key: 'gebiedscode', label: 'Gebied', cell: r => `<td>${esc(r.gebiedscode)}</td>` },
  { key: 'aantal', label: 'Storingen', num: true, cell: r => `<td class="num"><strong>${r.aantal}</strong></td>` },
  { key: 'adressen', label: 'Adressen', num: true, cell: r => `<td class="num">${r.adressen}</td>` },
  { key: 'tussentijd', label: 'Gem. tussentijd', num: true, cell: r => `<td class="num">${r.tussentijd == null ? '—' : Math.round(r.tussentijd) + ' dgn'}</td>` },
  { key: 'eerste', label: 'Eerste', cell: r => `<td>${esc(r.eerste)}</td>` },
  { key: 'laatste', label: 'Laatste', cell: r => `<td>${esc(r.laatste)}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num">${r.nuOpen}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(0) + ' dgn'}</td>` },
];

const RECIDIVE_COLUMNS_ASSET = [
  { key: 'asset', label: 'Asset', cell: r => recidiveSleutelCel(r, r.asset + (r.assetType ? ' ' + r.assetType : '')) },
  { key: 'city', label: 'Plaats', cell: r => `<td>${esc(r.city)}</td>` },
  { key: 'gebiedscode', label: 'Gebied', cell: r => `<td>${esc(r.gebiedscode)}</td>` },
  { key: 'aantal', label: 'Storingen', num: true, cell: r => `<td class="num"><strong>${r.aantal}</strong></td>` },
  { key: 'tussentijd', label: 'Gem. tussentijd', num: true, cell: r => `<td class="num">${r.tussentijd == null ? '—' : Math.round(r.tussentijd) + ' dgn'}</td>` },
  { key: 'eerste', label: 'Eerste', cell: r => `<td>${esc(r.eerste)}</td>` },
  { key: 'laatste', label: 'Laatste', cell: r => `<td>${esc(r.laatste)}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num">${r.nuOpen}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(0) + ' dgn'}</td>` },
];

function renderRecidiveCard() {
  const container = document.getElementById('recidive-body');
  if (!container) return;
  document.querySelectorAll('#recidive-mode button[data-recidive-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.recidiveMode === state.recidiveMode);
  });

  const perPlaats = state.recidiveMode === 'plaats';
  const stats = perPlaats ? buildRecidivePerPlaats() : buildRecidiveStats(state.recidiveMode);
  if (stats.length === 0) {
    const wat = state.recidiveMode === 'asset' ? 'asset' : state.recidiveMode === 'plaats' ? 'plaats met een straat' : 'straat';
    container.innerHTML = `<p class="empty-note">Nog geen ${wat} met twee of meer storingen in de opgeslagen historie. Deze kaart wordt sterker naarmate er meer maanden zijn vastgelegd.</p>`;
    return;
  }
  const kolommen = perPlaats ? RECIDIVE_COLUMNS_PLAATS
    : state.recidiveMode === 'asset' ? RECIDIVE_COLUMNS_ASSET : RECIDIVE_COLUMNS_STRAAT;
  const rows = sortByState(stats, state.recidiveSortState);
  renderFullTable(container, rows, kolommen, state.recidiveSortState, {
    isExpanded: (r) => state.recidiveOpen.has(r.key),
    detailCell: perPlaats ? recidivePlaatsDetailHtml : recidiveDetailHtml,
  });
}

function renderHistorie() {
  renderDoorlooptijdCard();
  renderHistorieSearch();
  renderRecidiveCard();
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

// Verloop van de openstaande werkvoorraad. Twee dingen die eerder misgingen:
//
// 1. De breedte groeide mee met het aantal meetdagen (dagen x 70px) terwijl de
//    SVG op width="100%" stond. Bij veertig dagen werd een canvas van ~2900px
//    in een halve kolom geperst, dus hoe meer historie je opbouwde, hoe kleiner
//    de grafiek werd. Nu staat er een minimumbreedte op en schuift de kaart
//    horizontaal mee als het niet past, zodat de schaal leesbaar blijft.
// 2. De grafiek volgde de regio-filtertabs van het Data-tabblad. Hier op
//    Gebieden staan die tabs niet, dus een filter dat je daar had staan zou
//    stilletjes doorwerken. Deze kaart toont daarom altijd alles.
const TREND_PERIODES = [
  { key: '30', label: 'Laatste 30 dagen', dagen: 30 },
  { key: '90', label: 'Laatste 90 dagen', dagen: 90 },
  { key: 'alles', label: 'Alles', dagen: null },
];
const TREND_GEBIED_KLEUREN = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];
const TREND_MAX_REEKSEN = 8;

// Beperkt de reeksen tot de acht drukste gebieden; de rest gaat samen in
// "Overig". Meer dan acht lijnen door elkaar is niet meer te volgen, en de
// dataviz-richtlijn schrijft ook voor dat een negende reeks wordt samengevat
// in plaats van dat er een nieuwe kleur bij wordt verzonnen.
function trendReeksen(perDag) {
  if (state.trendGroep === 'gebied') {
    const totalen = {};
    perDag.forEach(list => list.forEach(s => {
      const g = s.gebiedscode || 'Onbekend';
      totalen[g] = (totalen[g] || 0) + 1;
    }));
    const alle = Object.keys(totalen).sort((a, b) => totalen[b] - totalen[a]);
    const top = alle.slice(0, TREND_MAX_REEKSEN);
    const rest = new Set(alle.slice(TREND_MAX_REEKSEN));
    const namen = top.slice().sort();
    if (rest.size > 0) namen.push('Overig');
    const kleur = {};
    namen.forEach((n, i) => { kleur[n] = n === 'Overig' ? 'var(--series-other)' : TREND_GEBIED_KLEUREN[i % TREND_GEBIED_KLEUREN.length]; });
    return {
      namen,
      kleur,
      label: (n) => n,
      van: (s) => { const g = s.gebiedscode || 'Onbekend'; return rest.has(g) ? 'Overig' : g; },
    };
  }
  const namen = sortByGroupOrder(Array.from(new Set(perDag.flatMap(list => list.map(s => regioGroupOf(s))))));
  return { namen, kleur: REGIO_GROUP_COLOR, label: regioGroupLabel, van: regioGroupOf };
}

function renderTrendChart(snapshots) {
  const container = document.getElementById('trend-chart');
  if (!container) return;
  document.querySelectorAll('#trend-groep button[data-trend-groep]').forEach(b => b.classList.toggle('active', b.dataset.trendGroep === state.trendGroep));
  document.querySelectorAll('#trend-periode button[data-trend-periode]').forEach(b => b.classList.toggle('active', b.dataset.trendPeriode === state.trendPeriode));

  const periode = TREND_PERIODES.find(p => p.key === state.trendPeriode) || TREND_PERIODES[0];
  let snaps = snapshots;
  if (periode.dagen !== null && snaps.length > 0) {
    const laatste = snaps[snaps.length - 1].week;
    snaps = snaps.filter(sn => dagenTussen(sn.week, laatste) <= periode.dagen);
  }
  if (snaps.length < 2) {
    container.innerHTML = '<p class="empty-note">Verwerk minstens twee dagen binnen deze periode om een verloop te zien.</p>';
    return;
  }

  const perDag = snaps.map(sn => typeFiltered(sn.storingen));
  const { namen, kleur, label, van } = trendReeksen(perDag);
  const series = {};
  namen.forEach(n => { series[n] = perDag.map(list => list.filter(s => van(s) === n).length); });

  if (state.trendViewMode === 'table') {
    const head = `<th>Dag</th>` + namen.map(n => `<th class="num">${esc(label(n))}</th>`).join('');
    const rows = snaps.map((sn, i) => `<tr><td>${esc(sn.week)}</td>${namen.map(n => `<td class="num">${series[n][i]}</td>`).join('')}</tr>`).join('');
    container.innerHTML = `<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    return;
  }

  // Bij vier reeksen of minder krijgt elke lijn zijn naam aan het eind (dan
  // hoef je niet heen en weer te kijken naar de legenda); bij meer reeksen
  // zouden die labels over elkaar heen vallen en volstaat de legenda.
  const directLabels = namen.length <= 4;
  const leftPad = 44, rightPad = directLabels ? 116 : 24, topPad = 18, plotH = 300, bottomPad = 40;
  // Minstens 26px per meetpunt zodat de datumlabels niet op elkaar komen; past
  // het geheel niet, dan schuift de kaart horizontaal in plaats van in te
  // krimpen — dat laatste was juist het probleem.
  const stapX = Math.max(26, Math.min(70, 760 / Math.max(1, snaps.length - 1)));
  const plotW = Math.max(420, (snaps.length - 1) * stapX);
  const chartW = leftPad + plotW + rightPad;
  const chartH = topPad + plotH + bottomPad;
  const allValues = namen.flatMap(n => series[n]);
  const { min: axisMin, max: axisMax, step, ticks } = niceAxisRange(Math.min(...allValues), Math.max(1, ...allValues), 5);
  const scaleY = plotH / (axisMax - axisMin);
  const stepX = snaps.length > 1 ? plotW / (snaps.length - 1) : 0;
  const y = v => topPad + plotH - (v - axisMin) * scaleY;

  let gridSvg = '';
  for (let g = 0; g <= ticks; g++) {
    const val = axisMin + step * g;
    const gy = y(val);
    gridSvg += `<line class="grid-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${gy}" y2="${gy}" />`;
    gridSvg += `<text x="${leftPad - 8}" y="${gy + 4}" text-anchor="end">${Math.round(val)}</text>`;
  }
  // Niet elke dag een datumlabel als er veel dagen zijn — anders overlappen ze.
  const elkeN = Math.ceil(snaps.length / 14);
  const xLabels = snaps.map((sn, i) => (i % elkeN === 0 || i === snaps.length - 1)
    ? `<text x="${leftPad + i * stepX}" y="${topPad + plotH + 22}" text-anchor="middle">${esc(sn.week.slice(5))}</text>` : '').join('');

  let lines = '', markers = '';
  namen.forEach(n => {
    const color = kleur[n] || 'var(--series-other)';
    const pts = series[n].map((v, i) => `${leftPad + i * stepX},${y(v)}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
    series[n].forEach((v, i) => {
      markers += `<circle class="pt" data-reeks="${esc(label(n))}" data-week="${esc(snaps[i].week)}" data-val="${v}" cx="${leftPad + i * stepX}" cy="${y(v)}" r="4" fill="${color}" />`;
    });
    if (directLabels) {
      const lastY = y(series[n][series[n].length - 1]);
      lines += `<text x="${leftPad + plotW + 8}" y="${lastY + 4}" style="fill:${color};font-weight:700;">${esc(label(n))}</text>`;
    }
  });

  container.innerHTML = `
    <div class="chart-scroll">
      <svg class="chart-svg" viewBox="0 0 ${chartW} ${chartH}" style="width:100%;min-width:${Math.round(chartW)}px;height:${chartH}px">
        <line class="axis-line" x1="${leftPad}" x2="${leftPad}" y1="${topPad}" y2="${topPad + plotH}" />
        <line class="axis-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${topPad + plotH}" y2="${topPad + plotH}" />
        ${gridSvg}
        ${lines}
        ${markers}
        ${xLabels}
      </svg>
    </div>
    <div class="legend">
      ${namen.map(n => `<span class="legend-item"><span class="legend-swatch" style="background:${kleur[n] || 'var(--series-other)'}"></span>${esc(label(n))}</span>`).join('')}
    </div>`;

  container.querySelectorAll('.pt').forEach(pt => {
    pt.addEventListener('mouseenter', e => showTooltip(e, `<strong>${esc(pt.dataset.reeks)}</strong><br>${esc(pt.dataset.week)}: ${pt.dataset.val} open`));
    pt.addEventListener('mousemove', moveTooltip);
    pt.addEventListener('mouseleave', hideTooltip);
  });
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
  const kolomAantal = columns.length + (opts.leadHead ? 1 : 0);
  const body = rows.map(row => {
    const lead = opts.leadCell ? opts.leadCell(row) : '';
    const cells = columns.map(c => c.cell(row)).join('');
    const cls = opts.rowClass ? opts.rowClass(row) : '';
    const hoofdrij = `<tr${cls ? ` class="${cls}"` : ''}>${lead}${cells}</tr>`;
    // Uitgeklapte rij: één extra rij eronder die de volle tabelbreedte pakt.
    // Zo blijft de tabel sorteerbaar (dat zou verloren gaan als elke groep een
    // eigen <details>-blok werd) terwijl de details één klik weg zijn.
    if (opts.detailCell && opts.isExpanded && opts.isExpanded(row)) {
      return hoofdrij + `<tr class="detail-row"><td colspan="${kolomAantal}">${opts.detailCell(row)}</td></tr>`;
    }
    return hoofdrij;
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
    { key: 'order', label: 'Order', cell: s => `<td>${orderLinkHtml(s.order)}</td>` },
    { key: 'asset', label: 'Asset', cell: s => `<td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>` },
    { key: 'wvNaam', label: "WV'er", cell: s => `<td>${s.wvNaam ? esc(s.wvNaam) : '—'}</td>` },
    { key: 'daysLeft', label: 'Dagen', num: true, cell: s => `<td class="num">${renderDaysPill(s)}</td>` },
    { key: 'firstSeenWeek', label: 'Open sinds', cell: s => `<td>${s.firstSeenWeek ? esc(s.firstSeenWeek) : '—'}</td>` },
    { key: 'executionDate', label: 'Uitvoering', cell: s => `<td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>` },
    { key: 'flags', label: 'Aanvragen', cell: s => `<td>${s.flags.length ? s.flags.map(f => `<span class="badge" title="${esc(FLAG_LABELS[f])}">${esc(f)}</span>`).join(' ') : '—'}</td>` },
    { key: 'type', label: 'Type', cell: s => `<td>${esc(s.type)}${saneringBadgeHtml(s)}</td>` },
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
      <span>Week van <strong>${esc(sn.week)}</strong> — ${sn.storingen.length} regels in ${esc(LIJST_LABELS[lijstSoortVan(sn)])} (opgeslagen ${esc(fmtDate(sn.savedAt))})</span>
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
  // Alleen de twee echte regio's als tab. "Overig" was in de praktijk het
  // restje zonder gebiedscode; die storingen zitten gewoon in Totaal, en waar
  // ze vandaan komen zie je aan hun eigen tegel (saneringen) of aan de
  // melding over onbekende gebiedscodes op de Gebieden-pagina.
  const present = latestVisible
    ? sortByGroupOrder(Array.from(new Set(latestVisible.map(s => regioGroupOf(s))))).filter(g => g !== 'Overig')
    : [];
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
  if (snaps.length === 0) { renderLijstKeuze(); setDashboardEmpty('dashboard', 'dashboard-empty', true); return; }
  // "Wat is er veranderd" vergelijkt met de vorige DAG, niet met de vorige
  // plakactie. Er staan meestal twee plakacties op één dag (de gebieds- en de
  // statusweergave zijn twee blikken op dezelfde lijst); vergelijken met de
  // vorige plakactie zou dan de ene weergave met de andere vergelijken en
  // stelselmatig nul mutaties opleveren.
  const perDag = chronoSnapshots(snaps);
  const latest = perDag[perDag.length - 1];
  const previous = perDag.length > 1 ? perDag[perDag.length - 2] : null;

  const latestVisible = typeFiltered(latest.storingen);
  const previousVisible = previous ? typeFiltered(previous.storingen) : null;

  renderTypeWhitelist();
  renderFilterTabs(latestVisible);

  const latestFiltered = filterByActive(latestVisible);
  const previousFiltered = previousVisible ? { storingen: filterByActive(previousVisible), week: previous.week } : null;
  const mutations = computeMutations(latestFiltered, previousFiltered);

  setDashboardEmpty('dashboard', 'dashboard-empty', false);
  renderWeekSummaryBanner(latestFiltered, mutations);
  renderStatTiles(latestFiltered, mutations);
  renderAttentionList(latestFiltered, latestVisible);
  renderRegioChart(latestFiltered); // volgt de actieve filtertab (Totaal = alle regio's, anders alleen die regio)
  renderTrendChart(perDag); // idem, filtert zelf op state.activeFilter
  renderLijstKeuze();
  renderTypeOnbekendNotice();
  renderClassificatieCard();
  renderKlantaanvraagCard();
  renderGebiedPlaatsenCard();
  renderKaartCard();
  renderClusterCard();
  renderInUitCard();
  renderOverleg();
  renderWvGebiedCard();
  renderPrognose(latestFiltered);
  renderHistorie();
  renderBackupReminder();
  renderBackupStatus();
  renderTableAll(latestFiltered);
  renderWeeksList();
  updateStorageUsage();
}

// Platte-tekst overzicht (voor het "Kopieer overzicht"-knopje) — kijkt
// altijd naar alle regio's, ongeacht welke regio-filtertab net toevallig
// actief staat, zodat het gedeelde overzicht altijd het complete plaatje is.
function buildWeekSummaryText() {
  if (state.snapshots.length === 0) return 'Nog geen gegevens verwerkt.';
  const snaps = chronoSnapshots();
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  const latestVisible = typeFiltered(latest.storingen);
  const previousVisible = previous ? typeFiltered(previous.storingen) : null;
  const mutations = computeMutations(latestVisible, previousVisible ? { storingen: previousVisible, week: previous.week } : null);
  const filters = statTileFilters();
  const count = key => latestVisible.filter(filters[key].test).length;

  const lines = [
    `NUS-overzicht — ${latest.week}`,
    '',
    `Totaal open: ${latestVisible.length}`,
  ];
  if (mutations.hasPrevious) {
    lines.push(`Nieuw binnengekomen sinds ${mutations.vorigeDag || 'de vorige update'}: ${mutations.nieuw.length}`);
    lines.push(`Opgelost sinds ${mutations.vorigeDag || 'de vorige update'}: ${mutations.uitgegaan.length}`);
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
  state.snapshots = await loadSnapshots();
  state.typeWhitelist = await loadTypeWhitelist();
  state.ovBlockStatus = await loadOvBlockStatusMap();
  state.markeringKlasse = await loadMarkeringKlasseMap();
  state.bijnaVerlopenThreshold = await loadBijnaVerlopenThreshold();
  state.lastBackupAt = await loadLastBackupAt();
  state.capaciteit = await loadCapaciteit();
  if (state.snapshots.length > 0) renderDashboardFromState();
  else { setDashboardEmpty('dashboard', 'dashboard-empty', true); renderTypeWhitelist(); renderBackupReminder(); renderBackupStatus(); }
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
      renderBackupStatus();
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
  document.getElementById('cap-meetdienst').value = state.capaciteit.meetdienst;
  document.getElementById('cap-mio').value = state.capaciteit.mio;
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
    const lijst = state.lijstSoort;
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

    // Vangnet tegen de klassieke vergissing: een ander overzicht plakken maar
    // "NUS-storingen" laten staan. Dat zou de hele werkvoorraad wegvagen,
    // want wat niet in de lijst staat geldt als opgelost.
    //
    // Eerste signaal: de tekst is onmiskenbaar één soort (alles klantaanvraag
    // of alles sanering) en dat is niet wat er gekozen staat. Bij een gemengde
    // lijst valt de herkenning terug op "nus" en is er niets zeker genoeg om
    // over te waarschuwen.
    const herkend = afleidenLijstSoort(storingen);
    if (herkend !== 'nus' && herkend !== lijst) {
      const door = confirm(`Deze tekst bestaat volledig uit ${LIJST_LABELS[herkend].toLowerCase()}, maar je hebt "${LIJST_LABELS[lijst]}" gekozen.\n\nOpslaan als ${LIJST_LABELS[lijst]} betekent dat alles wat nu in die lijst staat als opgelost telt. Toch doorgaan?`);
      if (!door) { statusEl.textContent = 'Niets opgeslagen — kies hierboven de juiste lijst.'; return; }
    }

    const vorigeVanLijst = snaps.slice()
      .sort((a, b) => a.savedAt.localeCompare(b.savedAt))
      .filter(sn => lijstSoortVan(sn) === lijst).pop();
    if (vorigeVanLijst && vorigeVanLijst.storingen.length >= 5 && storingen.length < vorigeVanLijst.storingen.length * 0.4) {
      const door = confirm(`Deze plakactie bevat ${storingen.length} regels, terwijl "${LIJST_LABELS[lijst]}" er de vorige keer ${vorigeVanLijst.storingen.length} had.\n\nAlles wat niet in de lijst staat geldt als opgelost. Klopt het dat dit de volledige lijst is, en dat je de juiste lijstsoort hebt gekozen?`);
      if (!door) { statusEl.textContent = 'Niets opgeslagen — kies eventueel eerst de juiste lijst hierboven.'; return; }
    }

    enrichWithCarriedForwardOvFields(storingen, snaps);
    // De blokkade-reden staat in een aparte lijst die alleen de HUIDIGE stand
    // bewaart: hef je een blokkade op, dan is niet meer terug te zien dat 'ie
    // er ooit was. Door 'm bij elke update mee te schrijven in de momentopname
    // bouwt zich vanzelf een geschiedenis op, en kan over een paar maanden
    // worden uitgerekend hoeveel tijd elke blokkade-reden werkelijk kost.
    // Nu nog zonder zichtbaar effect — puur het vastleggen.
    storingen.forEach(s => {
      const reden = (state.ovBlockStatus[s.order] || {}).reason;
      if (reden) s.blokkadeReden = reden;
    });
    const snapshot = { week, savedAt: new Date().toISOString(), lijst, storingen };
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
    // Klantaanvragen apart benoemen, anders lijkt het alsof er meer storingen
    // in zitten dan er werkelijk zijn.
    const aantalAanvragen = storingen.filter(isKlantaanvraag).length;
    const aantalSaneringen = storingen.filter(isSanering).length;
    const delen = [`${storingen.length} regels verwerkt in "${LIJST_LABELS[lijst]}" voor week ${week}`];
    if (lijst === 'nus' && aantalSaneringen > 0) delen.push(`waarvan ${aantalSaneringen} ${aantalSaneringen === 1 ? 'sanering' : 'saneringen'}`);
    if (lijst === 'nus' && aantalAanvragen > 0) delen.push(`waarvan ${aantalAanvragen} ${aantalAanvragen === 1 ? 'klantaanvraag' : 'klantaanvragen'}`);
    if (errors.length) delen.push(`${errors.length} regels niet herkend`);
    // Types buiten het filter tellen nergens mee; dat moet je weten op het
    // moment dat je plakt, niet pas als een getal niet blijkt te kloppen.
    const buitenFilter = storingen.filter(st => !isKlantaanvraag(st) && !isTypeIncluded(st));
    if (buitenFilter.length > 0) {
      const types = Array.from(new Set(buitenFilter.map(st => st.type)));
      delen.push(`LET OP: ${buitenFilter.length} ${buitenFilter.length === 1 ? 'regel telt' : 'regels tellen'} niet mee (${types.join(', ')}) — zet het type aan op de Data-pagina`);
    }
    statusEl.textContent = delen.join(', ');
    textarea.value = '';
    state.lijstHerkend = null;
    state.lijstSaneringenInTekst = 0;
    state.lijstHandmatig = false;
    renderLijstKeuze();
  });

  document.querySelectorAll('#lijst-soort button[data-lijst]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.lijstSoort = btn.dataset.lijst;
      // Vanaf nu niet meer automatisch omzetten: de gebruiker weet zelf uit
      // welk overzicht hij kopieerde.
      state.lijstHandmatig = true;
      renderLijstKeuze();
    });
  });

  const pasteInput = document.getElementById('paste-input');
  if (pasteInput) {
    let herkenTimer = null;
    pasteInput.addEventListener('input', () => {
      clearTimeout(herkenTimer);
      herkenTimer = setTimeout(() => {
        const raw = pasteInput.value;
        if (!raw.trim()) {
          state.lijstHerkend = null;
          state.lijstSaneringenInTekst = 0;
        } else {
          const { storingen } = parseText(raw);
          state.lijstHerkend = storingen.length ? afleidenLijstSoort(storingen) : null;
          state.lijstSaneringenInTekst = storingen.filter(isSanering).length;
          if (state.lijstHerkend && !state.lijstHandmatig) state.lijstSoort = state.lijstHerkend;
        }
        renderLijstKeuze();
      }, 250);
    });
  }

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
        renderTrendChart(chronoSnapshots());
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
    const toggle = e.target.closest('.recidive-toggle[data-gebied-plaats]');
    if (toggle) {
      const plaats = toggle.dataset.gebiedPlaats;
      if (state.gebiedOpen.has(plaats)) state.gebiedOpen.delete(plaats);
      else state.gebiedOpen.add(plaats);
      renderGebiedPlaatsenCard();
      return;
    }
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

  document.getElementById('stagnatie-body').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.stagnatieSortState.key === th.dataset.key) state.stagnatieSortState.dir *= -1;
    else { state.stagnatieSortState.key = th.dataset.key; state.stagnatieSortState.dir = 1; }
    renderStagnatieCard();
  });

  // Eén gedelegeerde luisteraar voor álle ordernummers, waar ze ook staan:
  // de tabellen worden voortdurend opnieuw opgebouwd, dus per knop een eigen
  // luisteraar hangen zou ze bij elke render opnieuw moeten koppelen.
  document.addEventListener('click', e => {
    const link = e.target.closest('.order-link');
    if (!link) return;
    openTimeline(link.dataset.order);
  });

  const timelineModal = document.getElementById('timeline-modal');
  const timelineClose = document.getElementById('timeline-close');
  if (timelineClose && timelineModal) {
    timelineClose.addEventListener('click', () => {
      if (typeof timelineModal.close === 'function') timelineModal.close();
      else timelineModal.removeAttribute('open');
    });
  }
  // Klik op de achtergrond sluit ook — <dialog> vangt die klik zelf op, dus we
  // kijken of de klik buiten het inhoudsvlak viel.
  if (timelineModal) {
    timelineModal.addEventListener('click', e => {
      if (e.target !== timelineModal) return;
      const r = timelineModal.getBoundingClientRect();
      const buiten = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (buiten && typeof timelineModal.close === 'function') timelineModal.close();
    });
  }

  const historieSearch = document.getElementById('historie-search');
  if (historieSearch) {
    historieSearch.addEventListener('input', () => {
      state.historieQuery = historieSearch.value;
      renderHistorieSearch();
    });
  }

  document.getElementById('historie-body').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.historieSortState.key === th.dataset.key) state.historieSortState.dir *= -1;
    else { state.historieSortState.key = th.dataset.key; state.historieSortState.dir = 1; }
    renderHistorieSearch();
  });

  document.getElementById('recidive-body').addEventListener('click', e => {
    const toggle = e.target.closest('.recidive-toggle');
    if (toggle) {
      const key = toggle.dataset.recidiveKey;
      if (state.recidiveOpen.has(key)) state.recidiveOpen.delete(key);
      else state.recidiveOpen.add(key);
      renderRecidiveCard();
      return;
    }
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.recidiveSortState.key === th.dataset.key) state.recidiveSortState.dir *= -1;
    else { state.recidiveSortState.key = th.dataset.key; state.recidiveSortState.dir = 1; }
    renderRecidiveCard();
  });

  document.getElementById('cap-save-btn').addEventListener('click', async () => {
    const lees = (id) => {
      const v = parseInt(document.getElementById(id).value, 10);
      return Number.isFinite(v) && v >= 0 ? v : 0;
    };
    state.capaciteit = { meetdienst: lees('cap-meetdienst'), mio: lees('cap-mio') };
    await saveCapaciteit(state.capaciteit);
    document.getElementById('cap-meetdienst').value = state.capaciteit.meetdienst;
    document.getElementById('cap-mio').value = state.capaciteit.mio;
    document.getElementById('cap-status').textContent = 'Opgeslagen.';
    if (state.snapshots.length > 0) renderDashboardFromState();
  });

  document.getElementById('copy-overleg-btn').addEventListener('click', async () => {
    const btn = document.getElementById('copy-overleg-btn');
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(buildOverlegText());
      btn.textContent = '✅ Gekopieerd!';
    } catch (e) {
      btn.textContent = '⚠️ Kopiëren mislukt';
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  document.getElementById('copy-clusters-btn').addEventListener('click', async () => {
    const btn = document.getElementById('copy-clusters-btn');
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(buildClusterText());
      btn.textContent = '✅ Gekopieerd!';
    } catch (e) {
      btn.textContent = '⚠️ Kopiëren mislukt';
    }
    setTimeout(() => { btn.textContent = original; }, 2000);
  });

  document.querySelectorAll('#trend-groep button[data-trend-groep]').forEach(btn => {
    btn.addEventListener('click', () => { state.trendGroep = btn.dataset.trendGroep; renderTrendChart(chronoSnapshots()); });
  });
  document.querySelectorAll('#trend-periode button[data-trend-periode]').forEach(btn => {
    btn.addEventListener('click', () => { state.trendPeriode = btn.dataset.trendPeriode; renderTrendChart(chronoSnapshots()); });
  });
  document.querySelectorAll('#inuit-periode button[data-inuit-periode]').forEach(btn => {
    btn.addEventListener('click', () => { state.inUitPeriode = btn.dataset.inuitPeriode; renderInUitCard(); });
  });

  document.querySelectorAll('#cluster-mode button[data-cluster-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.clusterMode = btn.dataset.clusterMode;
      renderClusterCard();
    });
  });

  // Een plaats op de kaart aanklikken opent de lijst eronder; nog een keer
  // klikken sluit hem weer, zodat de kaart als schakelaar werkt.
  const kaartBody = document.getElementById('kaart-body');
  if (kaartBody) {
    const kies = (plaats) => {
      state.kaartPlaats = state.kaartPlaats === plaats ? null : plaats;
      renderKaartCard();
      const detail = document.querySelector('#kaart-body .kaart-detail');
      if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    kaartBody.addEventListener('click', (e) => {
      if (e.target.closest('#kaart-sluit')) { state.kaartPlaats = null; renderKaartCard(); return; }
      if (e.target.closest('#kaart-herstel')) { state.kaartView = null; renderKaartCard(); return; }
      const zoomKnop = e.target.closest('[data-kaart-zoom]');
      if (zoomKnop) {
        const { punten } = buildKaartPunten();
        if (punten.length) {
          // Vanuit een knop is er geen muispositie, dus rond het midden zoomen.
          kaartZoomNaar(punten, zoomKnop.dataset.kaartZoom === 'in' ? 1.5 : 1 / 1.5,
            KAART_BREEDTE / 2, kaartAutoView(punten).hoogte / 2);
          renderKaartVlak();
        }
        return;
      }
      // Na slepen mag de losgelaten muisknop geen plaats openen.
      if (kaartSleep.gesleept) { kaartSleep.gesleept = false; return; }
      const punt = e.target.closest('[data-kaart-plaats]');
      if (punt) kies(punt.dataset.kaartPlaats);
    });
    kaartBody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const punt = e.target.closest('[data-kaart-plaats]');
      if (!punt) return;
      e.preventDefault();
      kies(punt.dataset.kaartPlaats);
    });

    // Scrollen zoomt rond de muisaanwijzer. Het kaartvlak vangt dat af (dus de
    // pagina scrollt niet mee) — hetzelfde gedrag als elke andere kaart.
    kaartBody.addEventListener('wheel', (e) => {
      const svg = e.target.closest('.kaart-svg');
      if (!svg) return;
      e.preventDefault();
      const { punten } = buildKaartPunten();
      if (!punten.length) return;
      const p = kaartMuisPositie(svg, e);
      if (kaartZoomNaar(punten, e.deltaY < 0 ? 1.18 : 1 / 1.18, p.x, p.y)) kaartTeken();
    }, { passive: false });

    // Slepen verschuift het beeld. Via pointer-events, zodat het op een
    // aanraakscherm net zo werkt als met de muis.
    kaartBody.addEventListener('pointerdown', (e) => {
      const svg = e.target.closest('.kaart-svg');
      if (!svg || e.button !== 0) return;
      kaartSleep.actief = true;
      kaartSleep.gesleept = false;
      kaartSleep.x = e.clientX;
      kaartSleep.y = e.clientY;
      kaartSleep.schaal = KAART_BREEDTE / svg.getBoundingClientRect().width;
    });
    window.addEventListener('pointermove', (e) => {
      if (!kaartSleep.actief) return;
      const dx = (e.clientX - kaartSleep.x) * kaartSleep.schaal;
      const dy = (e.clientY - kaartSleep.y) * kaartSleep.schaal;
      if (!kaartSleep.gesleept && Math.hypot(dx, dy) < 4) return;
      kaartSleep.gesleept = true;
      kaartSleep.x = e.clientX;
      kaartSleep.y = e.clientY;
      const { punten } = buildKaartPunten();
      if (!punten.length) return;
      kaartVerschuif(punten, dx, dy);
      kaartTeken();
    });
    window.addEventListener('pointerup', () => { kaartSleep.actief = false; });
  }

  document.querySelectorAll('#recidive-mode button[data-recidive-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.recidiveMode = btn.dataset.recidiveMode;
      // De sleutels zijn per weergave anders, dus een uitgeklapte straat zou
      // in de assetweergave nergens meer op passen.
      state.recidiveOpen = new Set();
      // De sorteersleutels verschillen per weergave; terug naar de standaard
      // voorkomt dat er op een kolom gesorteerd blijft die er niet meer is.
      state.recidiveSortState = { key: state.recidiveMode === 'plaats' ? 'plekken' : 'aantal', dir: -1 };
      renderRecidiveCard();
    });
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

}

// Echte tabbladen: precies één paneel zichtbaar tegelijk, in plaats van één
// lange scrollpagina. De hash in de adresbalk (#/invoer, #/data,
// #/instellingen) is de bron van waarheid — dat geeft "gratis" een werkende
// terug-knop en een herlaad die op hetzelfde tabblad blijft staan, zonder een
// eigen sessionStorage-bijhoudmechanisme nodig te hebben.
const TAB_HASH_ROUTES = { invoer: '#/invoer', data: '#/data', gebieden: '#/gebieden', overleg: '#/overleg', prognose: '#/prognose', historie: '#/historie', settings: '#/instellingen' };
const HASH_TO_TAB = { '#/invoer': 'invoer', '#/data': 'data', '#/gebieden': 'gebieden', '#/overleg': 'overleg', '#/prognose': 'prognose', '#/historie': 'historie', '#/instellingen': 'settings' };

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
  state.markeringKlasse = STATIC_DATA.markeringKlasse || {};
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
  renderLijstKeuze();
  if (isStaticExport) applyStaticExportData();
  else await reloadAllStateAndRender();
  document.getElementById('bijna-verlopen-threshold-input').value = state.bijnaVerlopenThreshold;
  document.getElementById('cap-meetdienst').value = state.capaciteit.meetdienst;
  document.getElementById('cap-mio').value = state.capaciteit.mio;
  setupTabNav();
}

document.addEventListener('DOMContentLoaded', init);
