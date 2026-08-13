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
function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

/* ---------- State ---------- */

const state = {
  snapshots: [],
  typeWhitelist: [],
  activeFilter: 'Totaal',
  sortState: { key: 'daysLeft', dir: 1 },
  gebiedSortState: { key: 'regio', dir: 1 },
  wvSortState: { key: 'nuOpen', dir: -1 },
  lastBackupAt: null,
  capaciteit: { meetdienst: 0, mio: 0 },
  stagnatieSortState: { key: 'ratio', dir: -1 },
  historieQuery: '',
  historieSortState: { key: 'eerst', dir: -1 },
  recidiveMode: 'straat',
  clusterMode: 'pc4',
  mioLeeftijdFilter: 'alles',
  recidiveSortState: { key: 'aantal', dir: -1 },
  regioViewMode: 'chart',
  trendViewMode: 'chart',
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
const OV_DETAIL_LIST_KEYS = new Set([...Object.values(OV_STATUS_FILTER_KEYS), 'geblokkeerd', 'mastGeenSpanning']);
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
  let leeftijdBalk = '';
  let leeftijdNoot = '';

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
    ${leeftijdBalk}
    ${leeftijdNoot}
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
  pc4: { label: 'Postcodegebied', kolom: 'Postcode (4 cijfers)' },
  pc6: { label: 'Volledige postcode', kolom: 'Postcode' },
  straat: { label: 'Straat', kolom: 'Straat' },
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
  let zonderLocatie = 0;
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

  return { clusters, totaal: open.length, zonderLocatie };
}

// Platte tekst van de clusters, om in een mail of Teams-bericht te plakken.
// De interactieve versie zit al in de teamexport, maar voor "hier is je lijstje
// voor morgen" is een blok tekst praktischer dan een bestand.
function buildClusterText() {
  const { clusters, totaal, zonderLocatie } = buildClusters(state.clusterMode);
  const snaps = chronoSnapshots();
  const datum = snaps.length ? snaps[snaps.length - 1].week : '';
  const kop = `NUS-clusters — ${datum} (${CLUSTER_MODI[state.clusterMode].label.toLowerCase()})`;
  if (clusters.length === 0) return `${kop}\n\nGeen clusters van twee of meer op dit niveau.`;

  const inCluster = clusters.reduce((sum, c) => sum + c.aantal, 0);
  const regels = [
    kop,
    '',
    `${inCluster} van de ${totaal} openstaande storingen liggen in ${clusters.length} ${clusters.length === 1 ? 'cluster' : 'clusters'} van twee of meer.`,
    `${totaal - inCluster} ${totaal - inCluster === 1 ? 'staat' : 'staan'} op zichzelf${zonderLocatie > 0 ? ` (${zonderLocatie} zonder bruikbare locatiegegevens)` : ''}.`,
    '',
  ];
  clusters.forEach(c => {
    const merk = [];
    if (c.mio > 0) merk.push(`${c.mio}x mast geen spanning`);
    if (c.verlopen > 0) merk.push(`${c.verlopen}x verlopen`);
    if (c.geblokkeerd > 0) merk.push(`${c.geblokkeerd}x geblokkeerd`);
    regels.push(`${c.city} — ${c.sleutel}  (${c.aantal} storingen${merk.length ? ', ' + merk.join(', ') : ''})`);
    c.storingen.forEach(s => {
      const dagen = typeof s.daysLeft !== 'number' ? 'dagen onbekend'
        : s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen`
        : s.daysLeft === 0 ? 'verloopt vandaag'
        : `nog ${s.daysLeft} dgn`;
      const extra = [isMastGeenSpanning(s) ? 'mast geen spanning' : s.type, s.ovStatus || 'status onbekend'];
      if (isOvBlocked(s)) extra.push('geblokkeerd');
      regels.push(`  ${s.order}  ${s.street}, ${s.postcode}  — ${dagen}  (${extra.join(', ')})`);
    });
    regels.push('');
  });
  return regels.join('\n').trimEnd();
}

function renderClusterCard() {
  const container = document.getElementById('cluster-body');
  if (!container) return;
  document.querySelectorAll('#cluster-mode button[data-cluster-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.clusterMode === state.clusterMode);
  });

  const { clusters, totaal, zonderLocatie } = buildClusters(state.clusterMode);
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
  const kop = `<p class="prognose-headline"><strong>${inCluster}</strong> van de ${totaal} openstaande storingen liggen in <strong>${clusters.length}</strong> ${clusters.length === 1 ? 'cluster' : 'clusters'} van twee of meer`
    + `${mioInCluster > 0 ? `, waarvan ${mioInCluster} van het type "mast geen spanning"` : ''}. `
    + `De overige ${totaal - inCluster} ${totaal - inCluster === 1 ? 'staat' : 'staan'} op zichzelf${zonderLocatie > 0 ? ` (${zonderLocatie} zonder bruikbare locatiegegevens)` : ''}.</p>`;

  const rijen = clusters.map(c => {
    const deadline = c.vroegste === null ? '—'
      : c.vroegste < 0 ? `<span class="prognose-bad">${Math.abs(c.vroegste)} dgn verlopen</span>`
      : `nog ${c.vroegste} dgn`;
    const merk = [];
    if (c.mio > 0) merk.push(`${c.mio}× mast geen spanning`);
    if (c.verlopen > 0) merk.push(`${c.verlopen}× verlopen`);
    if (c.geblokkeerd > 0) merk.push(`${c.geblokkeerd}× geblokkeerd`);
    const detailRijen = c.storingen.map(s => `
      <tr>
        <td>${orderLinkHtml(s.order)}</td>
        <td>${esc(s.street)}, ${esc(s.postcode)}</td>
        <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}</td>
        <td>${ovStatusPillHtml(s)}</td>
        <td class="num">${renderDaysPill(s)}</td>
      </tr>`).join('');
    return `
      <details class="cluster-item">
        <summary>
          <span class="cluster-titel">${esc(c.city)} — ${esc(c.sleutel)}</span>
          <span class="cluster-aantal">${c.aantal} storingen</span>
          <span class="cluster-meta">${merk.length ? esc(merk.join(' · ')) + ' · ' : ''}krapste deadline: ${deadline}${state.clusterMode !== 'straat' && c.straten > 1 ? ` · ${c.straten} straten` : ''}</span>
        </summary>
        <div class="table-scroll">
          <table>
            <thead><tr><th>Order</th><th>Adres</th><th>Type</th><th>Status</th><th class="num">Dagen</th></tr></thead>
            <tbody>${detailRijen}</tbody>
          </table>
        </div>
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
    if (!stats[naam]) stats[naam] = { wvNaam: naam, orders: new Set(), doorlooptijden: [], nuOpen: 0, nieuwVenster: 0, opgelostVenster: 0, regios: {} };
    return stats[naam];
  };
  if (snaps.length === 0) return [];
  const laatsteDag = snaps[snaps.length - 1].week;
  const inVenster = (dag) => dagenTussen(dag, laatsteDag) <= WV_VENSTER_DAGEN;

  const firstSeen = {}; // order -> { week, wvNaam }
  snaps.forEach((sn, i) => {
    const curOrders = new Set();
    sn.storingen.forEach(s => {
      const naam = findRelevantWvNaam(s);
      if (!naam) return;
      curOrders.add(s.order);
      const e = ensure(naam);
      e.orders.add(s.order);
      if (!(s.order in firstSeen)) {
        firstSeen[s.order] = { week: sn.week, wvNaam: naam };
        if (inVenster(sn.week)) e.nieuwVenster++;
      }
      // In welke regio deze WV'er feitelijk werkt — nodig om te weten wie je
      // met wie mág vergelijken (zie renderWvGebiedCard).
      const regio = regioGroupOf(s);
      e.regios[regio] = (e.regios[regio] || 0) + 1;
    });
    if (i > 0) {
      snaps[i - 1].storingen.forEach(s => {
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

  // Huidige werkvoorraad uit de nieuwste dag.
  snaps[snaps.length - 1].storingen.forEach(s => {
    const naam = findRelevantWvNaam(s);
    if (naam) ensure(naam).nuOpen++;
  });

  return Object.values(stats);
}

const WV_STATS_COLUMNS = [
  { key: 'wvNaam', label: "WV'er", cell: r => `<td>${esc(r.wvNaam)}</td>` },
  { key: 'regio', label: 'Werkt in', cell: r => `<td>${esc(r.regio)}</td>` },
  { key: 'nuOpen', label: 'Nu open', num: true, cell: r => `<td class="num"><strong>${r.nuOpen}</strong></td>` },
  { key: 'aandeel', label: 'Aandeel in regio', num: true, cell: r => `<td class="num">${r.aandeel == null ? '—' : Math.round(r.aandeel * 100) + '%'}</td>` },
  { key: 'nieuwVenster', label: `Nieuw (${WV_VENSTER_DAGEN} dgn)`, num: true, cell: r => `<td class="num">${r.nieuwVenster}</td>` },
  { key: 'opgelostVenster', label: `Opgelost (${WV_VENSTER_DAGEN} dgn)`, num: true, cell: r => `<td class="num">${r.opgelostVenster}</td>` },
  { key: 'totaal', label: 'Totaal ooit', num: true, cell: r => `<td class="num">${r.totaal}</td>` },
  { key: 'doorlooptijd', label: 'Gem. doorlooptijd', num: true, cell: r => `<td class="num muted">${r.doorlooptijd == null ? '—' : r.doorlooptijd.toFixed(1) + ' dgn'}</td>` },
];

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
  const stats = buildWvStats();
  if (stats.length === 0) {
    container.innerHTML = '<p class="empty-note">Nog geen storingen gevonden voor de gevolgde WV\'ers.</p>';
    return;
  }

  const dominanteRegio = (regios) => {
    const namen = Object.keys(regios);
    if (namen.length === 0) return 'Onbekend';
    return regioGroupLabel(namen.sort((a, b) => regios[b] - regios[a])[0]);
  };
  const basis = stats.map(s => ({
    wvNaam: s.wvNaam,
    regio: dominanteRegio(s.regios),
    nuOpen: s.nuOpen,
    nieuwVenster: s.nieuwVenster,
    opgelostVenster: s.opgelostVenster,
    totaal: s.orders.size,
    doorlooptijd: s.doorlooptijden.length ? s.doorlooptijden.reduce((a, b) => a + b, 0) / s.doorlooptijden.length : null,
  }));

  // Het aandeel wordt bínnen de regio berekend. Iemand die in zijn eentje een
  // regio doet heeft per definitie 100% en is niet te vergelijken met een
  // regio die door twee mensen wordt gedeeld; door per regio te delen gaat de
  // vergelijking alleen over mensen die hetzelfde werkgebied delen.
  const openPerRegio = {};
  basis.forEach(r => { openPerRegio[r.regio] = (openPerRegio[r.regio] || 0) + r.nuOpen; });
  const rows = basis.map(r => Object.assign({}, r, {
    aandeel: openPerRegio[r.regio] > 0 ? r.nuOpen / openPerRegio[r.regio] : null,
  })).sort((a, b) => a.regio.localeCompare(b.regio) || b.nuOpen - a.nuOpen);

  // Kopregel: alleen zinvol waar meerdere mensen dezelfde regio delen.
  const gedeeld = {};
  rows.forEach(r => { (gedeeld[r.regio] = gedeeld[r.regio] || []).push(r); });
  const oordelen = Object.keys(gedeeld).sort().map(regio => {
    const groep = gedeeld[regio].slice().sort((a, b) => b.nuOpen - a.nuOpen);
    if (groep.length < 2) return `<li>${esc(regio)}: alleen ${esc(groep[0].wvNaam)} — geen vergelijking mogelijk.</li>`;
    const hoog = groep[0], laag = groep[groep.length - 1];
    if (hoog.nuOpen === laag.nuOpen) return `<li>${esc(regio)}: gelijk verdeeld (${hoog.nuOpen} elk).</li>`;
    const verschil = hoog.nuOpen - laag.nuOpen;
    const factor = laag.nuOpen > 0 ? (hoog.nuOpen / laag.nuOpen) : null;
    const scheef = factor === null || factor >= 1.5;
    return `<li>${esc(regio)}: <strong class="${scheef ? 'prognose-bad' : ''}">${esc(hoog.wvNaam)} ${hoog.nuOpen}</strong> tegenover ${esc(laag.wvNaam)} ${laag.nuOpen}`
      + ` — ${verschil} storing${verschil === 1 ? '' : 'en'} verschil${factor !== null ? `, ${factor.toFixed(1)}×` : ''}.</li>`;
  }).join('');

  container.innerHTML = `<ul class="wv-oordeel">${oordelen}</ul>`;
  const tabel = document.createElement('div');
  container.appendChild(tabel);
  const sorted = sortByState(rows, state.wvSortState);
  renderFullTable(tabel, sorted, WV_STATS_COLUMNS, state.wvSortState);
}

/* ---------- Historie-helpers ---------- */

// Eén snapshot per kalenderdag, chronologisch. Op één dag kunnen meerdere
// updates staan (bv. eerst de gebieds-weergave plakken en daarna de status-
// weergave); die zijn twee blikken op dezelfde dag, geen twee momenten. Zou je
// ze als losse stappen behandelen, dan zie je storingen "verdwijnen" en weer
// "verschijnen" tussen twee plakacties door, en dat vervuilt elke telling die
// naar verandering kijkt. De laatste update van een dag wint — dat is dezelfde
// regel die het dashboard al hanteert voor "de huidige stand".
function chronoSnapshots(snapshots) {
  const list = (snapshots || state.snapshots).slice()
    .sort((a, b) => a.week.localeCompare(b.week) || a.savedAt.localeCompare(b.savedAt));
  const perDag = new Map();
  list.forEach(sn => perDag.set(sn.week, sn));
  return Array.from(perDag.values());
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
  title.textContent = `Storing ${order}`;

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
        <div><dt>Status</dt><dd>${tl.open ? ovStatusPillHtml(r) : '<span class="status-pill">Opgelost</span>'}</dd></div>
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
    g.orders.push({ order: r.order, eerst: r.eerst, open: r.open, doorlooptijd: r.looptijd });
    g.adressen.add(r.street || '');
    if (!g.gebiedscode && r.gebiedscode) g.gebiedscode = r.gebiedscode;
  });

  return Array.from(groepen.values())
    .filter(g => g.orders.length >= 2)
    .map(g => {
      const data = g.orders.slice().sort((a, b) => a.eerst.localeCompare(b.eerst));
      const eerste = data[0].eerst;
      const laatste = data[data.length - 1].eerst;
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
        doorlooptijd: afgerond.length ? afgerond.reduce((sum, o) => sum + o.doorlooptijd, 0) / afgerond.length : null,
      };
    });
}

const RECIDIVE_COLUMNS_STRAAT = [
  { key: 'city', label: 'Plaats', cell: r => `<td>${esc(r.city)}</td>` },
  { key: 'street', label: 'Straat', cell: r => `<td>${esc(r.street)}</td>` },
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
  { key: 'asset', label: 'Asset', cell: r => `<td>${esc(r.asset)}${r.assetType ? ' ' + esc(r.assetType) : ''}</td>` },
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

  const stats = buildRecidiveStats(state.recidiveMode);
  if (stats.length === 0) {
    container.innerHTML = `<p class="empty-note">Nog geen ${state.recidiveMode === 'asset' ? 'asset' : 'straat'} met twee of meer storingen in de opgeslagen historie. Deze kaart wordt sterker naarmate er meer maanden zijn vastgelegd.</p>`;
    return;
  }
  const rows = sortByState(stats, state.recidiveSortState);
  renderFullTable(container, rows, state.recidiveMode === 'asset' ? RECIDIVE_COLUMNS_ASSET : RECIDIVE_COLUMNS_STRAAT, state.recidiveSortState);
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
    { key: 'order', label: 'Order', cell: s => `<td>${orderLinkHtml(s.order)}</td>` },
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
  renderGebiedPlaatsenCard();
  renderClusterCard();
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

  document.querySelectorAll('#cluster-mode button[data-cluster-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.clusterMode = btn.dataset.clusterMode;
      renderClusterCard();
    });
  });

  document.querySelectorAll('#recidive-mode button[data-recidive-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.recidiveMode = btn.dataset.recidiveMode;
      // De sorteersleutels verschillen per weergave; terug naar de standaard
      // voorkomt dat er op een kolom gesorteerd blijft die er niet meer is.
      state.recidiveSortState = { key: 'aantal', dir: -1 };
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
const TAB_HASH_ROUTES = { invoer: '#/invoer', data: '#/data', gebieden: '#/gebieden', prognose: '#/prognose', historie: '#/historie', settings: '#/instellingen' };
const HASH_TO_TAB = { '#/invoer': 'invoer', '#/data': 'data', '#/gebieden': 'gebieden', '#/prognose': 'prognose', '#/historie': 'historie', '#/instellingen': 'settings' };

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
  document.getElementById('cap-meetdienst').value = state.capaciteit.meetdienst;
  document.getElementById('cap-mio').value = state.capaciteit.mio;
  setupTabNav();
}

document.addEventListener('DOMContentLoaded', init);
