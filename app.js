'use strict';

// Een geëxporteerd "interactief dashboard" (zie buildStandaloneExport) bakt de
// data van dat moment in als window.__DASHBOARD_DATA__ i.p.v. dat er uit
// IndexedDB gelezen wordt. In die modus is het dashboard bekijk-alleen: geen
// nieuwe week verwerken, geen instellingen, geen WV-status bewerken — dat blijft
// voorbehouden aan het originele dashboard waar de data vandaan komt.
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
  while (i < lines.length) {
    // Combineer beide skip-checks in één lus: een gebiedscode kan vlak na een
    // titel-/tellingregel staan (of andersom), dus we blijven controleren tot
    // geen van beide patronen meer matcht.
    while (i < lines.length && (GEBIEDSCODE_RE.test(lines[i]) || COUNT_HEADER_RE.test(lines[i]))) {
      if (GEBIEDSCODE_RE.test(lines[i])) currentGebiedscode = lines[i];
      i++;
    }
    if (i >= lines.length) break;
    const start = i;
    try {
      const { storing, next } = parseOneEntry(lines, i);
      storing.gebiedscode = currentGebiedscode;
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
  catch (e) { throw new Error('Opslaan is mislukt: ' + e.message); }
}
async function clearSnapshots() { await idbDelete(STORAGE_KEY); }

async function loadTypeWhitelist() {
  await migrateLegacyKey(TYPE_WHITELIST_KEY);
  try { const v = await idbGet(TYPE_WHITELIST_KEY); return v || DEFAULT_TYPE_WHITELIST.slice(); }
  catch (e) { console.error(e); return DEFAULT_TYPE_WHITELIST.slice(); }
}
async function saveTypeWhitelist(list) {
  try { await idbSet(TYPE_WHITELIST_KEY, list); }
  catch (e) { console.error(e); }
}

const TO_STORAGE_KEY = 'nusdash_snapshots_teonderzoeken_v1';
const MEETDIENST_LIST_KEY = 'nusdash_meetdienst_namen_v1';
const HANDOFF_LIST_KEY = 'nusdash_handoff_namen_v1';
const DEFAULT_MEETDIENST_NAMEN = ['Kees Smit', 'Bas M. Oudshoorn', 'Mark Rollenberg'];
const DEFAULT_HANDOFF_NAMEN = ['Conor', 'Patricia', 'Dulani'];

async function loadToSnapshots() {
  await migrateLegacyKey(TO_STORAGE_KEY);
  try { return (await idbGet(TO_STORAGE_KEY)) || []; }
  catch (e) { console.error(e); return []; }
}
async function saveToSnapshots(snaps) {
  snaps.sort((a, b) => a.week.localeCompare(b.week));
  try { await idbSet(TO_STORAGE_KEY, snaps); }
  catch (e) { throw new Error('Opslaan is mislukt: ' + e.message); }
}
async function clearToSnapshots() { await idbDelete(TO_STORAGE_KEY); }

async function loadNameList(key, fallback) {
  await migrateLegacyKey(key);
  try { const v = await idbGet(key); return v || fallback.slice(); }
  catch (e) { console.error(e); return fallback.slice(); }
}
async function saveNameList(key, list) {
  try { await idbSet(key, list); }
  catch (e) { console.error(e); }
}

// Handmatige WV-status ("Moet opgepakt worden" / "Wachtend op iets") per
// storing, bijgehouden op ordernummer zodat het meeloopt als dezelfde
// storing de week erna opnieuw wordt geplakt. Onafhankelijk van de
// wekelijkse snapshots zelf.
const WV_STATUS_KEY = 'nusdash_wv_status_v1';
async function loadWvStatusMap() {
  try { return (await idbGet(WV_STATUS_KEY)) || {}; }
  catch (e) { console.error(e); return {}; }
}
async function saveWvStatusMap(map) {
  try { await idbSet(WV_STATUS_KEY, map); }
  catch (e) { console.error(e); }
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
    teOnderzoekenSnapshots: await loadToSnapshots(),
    meetdienstNamen: await loadNameList(MEETDIENST_LIST_KEY, DEFAULT_MEETDIENST_NAMEN),
    handoffNamen: await loadNameList(HANDOFF_LIST_KEY, DEFAULT_HANDOFF_NAMEN),
    wvStatus: await loadWvStatusMap(),
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
    teOnderzoekenSnapshots: state.toSnapshots,
    meetdienstNamen: state.meetdienstNamen,
    handoffNamen: state.handoffNamen,
    wvStatus: state.wvStatus,
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
  if (Array.isArray(backup.teOnderzoekenSnapshots)) await saveToSnapshots(backup.teOnderzoekenSnapshots);
  if (Array.isArray(backup.meetdienstNamen)) await saveNameList(MEETDIENST_LIST_KEY, backup.meetdienstNamen);
  if (Array.isArray(backup.handoffNamen)) await saveNameList(HANDOFF_LIST_KEY, backup.handoffNamen);
  if (backup.wvStatus && typeof backup.wvStatus === 'object') await saveWvStatusMap(backup.wvStatus);
}

// Classificatie voor de "te onderzoeken storingen"-bak:
// - 1 naam: telt alleen mee als die naam een meetdienst-collega is (anders is
//   het een andere monteur, niet voor onze werkvoorbereiders).
// - 2 namen: telt alleen mee als de 2e naam een overdracht-naam is (dan is 'm
//   overgedragen aan de werkvoorbereiders om in te plannen).
// - 0 namen: standaard genegeerd, maar zichtbaar in het "genegeerd"-overzicht.
function classifyTeOnderzoeken(s) {
  const names = s.names || [];
  if (names.length === 1) {
    const isMeetdienst = state.meetdienstNamen.some(m => m.trim().toLowerCase() === names[0].trim().toLowerCase());
    return isMeetdienst
      ? { status: 'meetdienst', reden: null }
      : { status: 'genegeerd', reden: `andere monteur (${names[0]}), niet de meetdienst` };
  }
  if (names.length === 2) {
    const isHandoff = state.handoffNamen.some(h => names[1].toLowerCase().includes(h.trim().toLowerCase()));
    return isHandoff
      ? { status: 'werkvoorbereiders', reden: null }
      : { status: 'genegeerd', reden: `2e naam (${names[1]}) is geen overdracht naar ons` };
  }
  return { status: 'genegeerd', reden: 'geen naam vermeld' };
}

// Cross-referentie tussen de twee bakken. Beide zijn losse pastes uit dezelfde
// Instandhoudingsapp, dus hetzelfde ordernummer kan in allebei voorkomen —
// gelijktijdig (als de bakken elkaar overlappende filters zijn) of na elkaar
// (als een storing naar de meetdienst gaat en weer terugkomt). We doen geen
// aanname over welke van de twee het is, en signaleren alleen dat het
// ordernummer ook in de andere bak's laatste week staat.
function latestOvOrderSet() {
  if (state.snapshots.length === 0) return new Set();
  const latest = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week)).pop();
  return new Set(typeFiltered(latest.storingen).map(s => s.order));
}
function latestRelevantToOrderSet() {
  if (state.toSnapshots.length === 0) return new Set();
  const latest = state.toSnapshots.slice().sort((a, b) => a.week.localeCompare(b.week)).pop();
  return new Set(latest.storingen.filter(s => classifyTeOnderzoeken(s).status !== 'genegeerd').map(s => s.order));
}
function crossBucketBadge(order, orderSet, label, seriesVar) {
  if (!orderSet || !orderSet.has(order)) return '';
  return `<span class="cross-bucket-badge" style="--cb-color:var(${seriesVar})" title="${esc(label)}">⇄ ${esc(label)}</span>`;
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

// Alleen storingen met een type in de whitelist tellen mee (zie "Type-filter").
function isTypeIncluded(s) { return state.typeWhitelist.includes(s.type); }
function typeFiltered(list) { return list.filter(isTypeIncluded); }

function statusOf(s) {
  if (s.overdue) return 'critical';
  if (s.daysLeft <= 2) return 'serious';
  if (s.daysLeft <= 5) return 'warning';
  return 'good';
}
const STATUS_LABELS = { good: 'Op tijd', warning: 'Aandacht', serious: 'Bijna verlopen', critical: 'Verlopen' };
const STATUS_ICONS = { good: '✓', warning: '!', serious: '⚠', critical: '✕' };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];

// Tabelweergave van de dagen-status-pill, met een apart icoon + accent voor
// verlopen storingen zónder uitvoeringsdatum — dáár kunnen we nog op sturen.
function renderDaysPill(s) {
  const status = statusOf(s);
  const daysText = s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen` : (s.daysLeft === 0 ? 'verloopt vandaag' : `nog ${s.daysLeft} dgn`);
  const unplanned = isUnplannedOverdue(s);
  const icon = unplanned ? '⛔' : STATUS_ICONS[status];
  const cls = `status-pill ${status}${unplanned ? ' status-pill-unplanned' : ''}`;
  const title = unplanned ? 'Verlopen én nog geen uitvoeringsdatum — actie nodig' : '';
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
  regioViewMode: 'chart',
  trendViewMode: 'chart',
  toSnapshots: [],
  meetdienstNamen: [],
  handoffNamen: [],
  toSortState: { key: 'daysLeft', dir: 1 },
  toActiveFilter: 'Totaal',
  wvStatus: {},
  overdueDetailFilter: null,
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

/* ---------- Rendering: stat tiles ---------- */

// Een storing is "onbeheerd verlopen" als het target al gemist is én er nog
// geen uitvoeringsdatum gepland staat — dáár kunnen we nog op sturen door 'm
// alsnog in te plannen. Verlopen storingen die al wél een datum hebben, lopen
// gewoon (te laat, maar onderweg).
function isUnplannedOverdue(s) { return !!s.overdue && !s.executionDate; }

function renderStatTiles(current, mutations) {
  const el = document.getElementById('stat-tiles');
  const total = current.length;
  const overdueKnown = current.filter(s => s.overdue && s.executionDate).length;
  const overdueUnknown = current.filter(s => isUnplannedOverdue(s)).length;
  const tiles = [
    { label: 'Totaal open', value: total },
    { label: 'Nieuw binnengekomen', value: mutations.hasPrevious ? mutations.nieuw.length : '—',
      note: mutations.hasPrevious ? 'sinds vorige week' : 'nog geen vorige week' },
    { label: 'Afgesloten / uitgegaan', value: mutations.hasPrevious ? mutations.uitgegaan.length : '—',
      note: mutations.hasPrevious ? 'sinds vorige week' : 'nog geen vorige week' },
    { label: 'Verlopen — uitvoering bekend', value: overdueKnown, deltaClass: overdueKnown > 0 ? 'bad' : 'good',
      note: overdueKnown > 0 ? 'al wel ingepland' : 'geen', filterKey: 'known' },
    { label: 'Verlopen — uitvoering onbekend', value: overdueUnknown, deltaClass: overdueUnknown > 0 ? 'bad' : 'good',
      note: overdueUnknown > 0 ? 'nog niets ingepland — actie nodig' : 'geen', alert: overdueUnknown > 0, filterKey: 'unknown' },
  ];
  el.innerHTML = tiles.map(t => {
    const clickable = t.filterKey ? ' stat-tile-clickable' : '';
    const selected = t.filterKey && state.overdueDetailFilter === t.filterKey ? ' stat-tile-selected' : '';
    const attrs = t.filterKey ? ` data-stat-filter="${t.filterKey}" tabindex="0" role="button" aria-expanded="${state.overdueDetailFilter === t.filterKey}"` : '';
    return `
    <div class="stat-tile${t.alert ? ' stat-tile-alert' : ''}${clickable}${selected}"${attrs}>
      <div class="label">${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
      ${t.note ? `<div class="delta ${t.deltaClass || ''}">${esc(t.note)}</div>` : ''}
      ${t.filterKey ? '<div class="stat-tile-hint">Klik voor de lijst</div>' : ''}
    </div>`;
  }).join('');

  const activate = (key) => {
    state.overdueDetailFilter = state.overdueDetailFilter === key ? null : key;
    renderStatTiles(current, mutations);
  };
  el.querySelectorAll('[data-stat-filter]').forEach(tile => {
    tile.addEventListener('click', () => activate(tile.dataset.statFilter));
    tile.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(tile.dataset.statFilter); }
    });
  });

  renderOverdueDetail(current, mutations);
}

// Toont (indien een van de "Verlopen"-tegels is aangeklikt) de exacte lijst
// van storingen daarachter, zodat je niet handmatig door de hele tabel hoeft
// te zoeken naar welke opdrachten het precies betreft.
function renderOverdueDetail(current, mutations) {
  const container = document.getElementById('overdue-detail');
  const filterKey = state.overdueDetailFilter;
  if (!filterKey) { container.classList.add('hidden'); container.innerHTML = ''; return; }

  const list = current.filter(s => s.overdue && (filterKey === 'known' ? !!s.executionDate : !s.executionDate));
  const title = filterKey === 'known' ? 'Verlopen — uitvoering bekend' : 'Verlopen — uitvoering onbekend';
  container.classList.remove('hidden');

  const body = list.length === 0
    ? '<p class="empty-note">Geen storingen in deze lijst.</p>'
    : `<div class="table-scroll"><table><thead><tr>
        <th>Order</th><th>Regio</th><th>Adres</th><th class="num">Dagen</th><th>Type</th><th>Uitvoering</th>
      </tr></thead><tbody>${list.map(s => `<tr>
        <td>${esc(s.order)}</td>
        <td>${esc(regioGroupLabel(regioGroupOf(s)))}</td>
        <td>${esc(s.city)} — ${esc(s.street)}, ${esc(s.postcode)}</td>
        <td class="num">${renderDaysPill(s)}</td>
        <td>${esc(s.type)}</td>
        <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
      </tr>`).join('')}</tbody></table></div>`;

  container.innerHTML = `
    <div class="card-header">
      <h3>${esc(title)} <span class="badge">${list.length}</span></h3>
      <button class="btn-link" id="close-overdue-detail">Sluiten ✕</button>
    </div>
    ${body}`;
  document.getElementById('close-overdue-detail').addEventListener('click', () => {
    state.overdueDetailFilter = null;
    renderStatTiles(current, mutations);
  });
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

  const leftPad = 40, rightPad = 60, topPad = 16, plotH = 200, bottomPad = 34;
  const plotW = Math.max(360, snapshots.length * 70);
  const chartW = leftPad + plotW + rightPad;
  const chartH = topPad + plotH + bottomPad;
  const maxVal = Math.max(1, ...regios.flatMap(r => series[r]));
  const niceMax = Math.ceil(maxVal / 5) * 5 || 5;
  const scaleY = plotH / niceMax;
  const stepX = snapshots.length > 1 ? plotW / (snapshots.length - 1) : 0;

  let gridSvg = '';
  for (let g = 0; g <= 5; g++) {
    const val = (niceMax / 5) * g;
    const y = topPad + plotH - val * scaleY;
    gridSvg += `<line class="grid-line" x1="${leftPad}" x2="${leftPad + plotW}" y1="${y}" y2="${y}" />`;
    gridSvg += `<text x="${leftPad - 8}" y="${y + 3}" text-anchor="end">${Math.round(val)}</text>`;
  }
  let xLabels = snapshots.map((sn, wi) => `<text x="${leftPad + wi * stepX}" y="${topPad + plotH + 20}" text-anchor="middle">${esc(sn.week.slice(5))}</text>`).join('');

  let lines = '';
  let markers = '';
  regios.forEach(r => {
    const color = REGIO_GROUP_COLOR[r];
    const pts = series[r].map((v, wi) => `${leftPad + wi * stepX},${topPad + plotH - v * scaleY}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
    series[r].forEach((v, wi) => {
      const cx = leftPad + wi * stepX, cy = topPad + plotH - v * scaleY;
      markers += `<circle class="pt" data-regio="${esc(regioGroupLabel(r))}" data-week="${esc(snapshots[wi].week)}" data-val="${v}" cx="${cx}" cy="${cy}" r="4" fill="${color}" />`;
    });
    const lastX = leftPad + (series[r].length - 1) * stepX;
    const lastY = topPad + plotH - series[r][series[r].length - 1] * scaleY;
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

function miniTable(list, toOrderSet) {
  if (list.length === 0) return '<p class="empty-note">Geen mutaties.</p>';
  const rows = list.map(s => `<tr><td>${esc(s.order)} ${crossBucketBadge(s.order, toOrderSet, 'ook in te onderzoeken-bak', '--series-2')}</td><td>${esc(regioOf(s))} — ${esc(s.street)}</td><td>${esc(s.type)}</td></tr>`).join('');
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
  const toOrderSet = latestRelevantToOrderSet();
  document.getElementById('table-in').innerHTML = miniTable(mutations.nieuw, toOrderSet);
  document.getElementById('table-out').innerHTML = miniTable(mutations.uitgegaan, toOrderSet);
}

/* ---------- Rendering: full table ---------- */

const COLUMNS = [
  { key: 'regioGroup', label: 'Regio' },
  { key: 'gebiedscode', label: 'Gebied' },
  { key: 'city', label: 'Plaats' },
  { key: 'street', label: 'Adres' },
  { key: 'order', label: 'Order' },
  { key: 'asset', label: 'Asset' },
  { key: 'wvNaam', label: "WV'er" },
  { key: 'daysLeft', label: 'Dagen', num: true },
  { key: 'executionDate', label: 'Uitvoering' },
  { key: 'flags', label: 'Aanvragen' },
  { key: 'type', label: 'Type' },
];

function sortRows(rows) {
  const { key, dir } = state.sortState;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (key === 'flags') { va = a.flags.length; vb = b.flags.length; }
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function renderTableAll(current) {
  const container = document.getElementById('table-all');
  if (current.length === 0) { container.innerHTML = '<p class="empty-note">Geen storingen.</p>'; return; }
  const annotated = current.map(s => Object.assign({}, s, { regioGroup: regioGroupOf(s) }));
  const rows = sortRows(annotated);
  const toOrderSet = latestRelevantToOrderSet();
  const head = COLUMNS.map(c => {
    const active = state.sortState.key === c.key ? (state.sortState.dir === 1 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${active}</th>`;
  }).join('');
  const body = rows.map(s => {
    const flagsHtml = s.flags.length
      ? s.flags.map(f => `<span class="badge" title="${esc(FLAG_LABELS[f])}">${esc(f)}</span>`).join(' ')
      : '—';
    return `<tr${isUnplannedOverdue(s) ? ' class="row-alert"' : ''}>
      <td>${esc(regioGroupLabel(s.regioGroup))}</td>
      <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${esc(s.order)} ${crossBucketBadge(s.order, toOrderSet, 'ook in te onderzoeken-bak', '--series-2')}</td>
      <td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>
      <td>${s.wvNaam ? esc(s.wvNaam) : '—'}</td>
      <td class="num">${renderDaysPill(s)}</td>
      <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
      <td>${flagsHtml}</td>
      <td>${esc(s.type)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- Rendering: weeks list ---------- */

function renderWeeksList() {
  const container = document.getElementById('weeks-list');
  if (state.snapshots.length === 0) { container.innerHTML = '<p class="empty-note">Nog geen weken opgeslagen.</p>'; return; }
  const rows = state.snapshots.slice().sort((a, b) => b.week.localeCompare(a.week)).map(sn => `
    <div class="weeks-list-row">
      <span>Week van <strong>${esc(sn.week)}</strong> — ${sn.storingen.length} storingen (opgeslagen ${esc(fmtDate(sn.savedAt))})</span>
      <button class="btn-link danger" data-week="${esc(sn.week)}">Verwijderen</button>
    </div>`).join('');
  container.innerHTML = rows;
  container.querySelectorAll('button[data-week]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Week ${btn.dataset.week} verwijderen?`)) return;
      const snaps = (await loadSnapshots()).filter(s => s.week !== btn.dataset.week);
      await saveSnapshots(snaps);
      state.snapshots = snaps;
      if (snaps.length === 0) document.getElementById('dashboard').classList.add('hidden');
      else renderDashboardFromState();
      if (state.toSnapshots.length > 0) renderToDashboardFromState(); // cross-bak badges bijwerken
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

// Wekelijks signaal (in de OV NUSsen-sectie zelf, niet in Instellingen):
// welke types uit de laatst verwerkte week niet meetellen.
function renderTypeUnknownReview() {
  const unknownEl = document.getElementById('type-unknown');
  const latest = state.snapshots[state.snapshots.length - 1];
  if (!latest) { unknownEl.classList.add('hidden'); unknownEl.innerHTML = ''; return; }
  const unknownCounts = {};
  latest.storingen.forEach(s => {
    if (!isTypeIncluded(s)) unknownCounts[s.type] = (unknownCounts[s.type] || 0) + 1;
  });
  const unknownTypes = Object.keys(unknownCounts);
  if (unknownTypes.length === 0) { unknownEl.classList.add('hidden'); unknownEl.innerHTML = ''; return; }
  unknownEl.classList.remove('hidden');
  unknownEl.innerHTML = `<strong>${unknownTypes.length} onbekend(e) type(s) deze week — niet meegeteld:</strong>` +
    unknownTypes.map(t => `
      <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <span>${esc(t)} (${unknownCounts[t]}×)</span>
        <button class="btn-link add-type-btn" data-type="${esc(t)}">+ Meetellen</button>
      </div>`).join('');
  unknownEl.querySelectorAll('.add-type-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!state.typeWhitelist.includes(btn.dataset.type)) state.typeWhitelist.push(btn.dataset.type);
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

/* ---------- Te onderzoeken storingen (tweede bak) ---------- */

function renderNameChipList(containerId, list, onRemove) {
  const container = document.getElementById(containerId);
  if (list.length === 0) { container.innerHTML = '<p class="empty-note">Nog geen namen ingesteld.</p>'; return; }
  container.innerHTML = list.map(n => `<span class="type-chip">${esc(n)}<button class="remove-name" data-name="${esc(n)}" title="Verwijderen">×</button></span>`).join('');
  container.querySelectorAll('.remove-name').forEach(btn => {
    btn.addEventListener('click', () => onRemove(btn.dataset.name));
  });
}

function renderMeetdienstList() {
  renderNameChipList('meetdienst-list', state.meetdienstNamen, async (name) => {
    state.meetdienstNamen = state.meetdienstNamen.filter(n => n !== name);
    await saveNameList(MEETDIENST_LIST_KEY, state.meetdienstNamen);
    renderToDashboardFromState();
  });
}
function renderHandoffList() {
  renderNameChipList('handoff-list', state.handoffNamen, async (name) => {
    state.handoffNamen = state.handoffNamen.filter(n => n !== name);
    await saveNameList(HANDOFF_LIST_KEY, state.handoffNamen);
    renderToDashboardFromState();
  });
}

function filterToByActive(classified) {
  if (state.toActiveFilter === 'Totaal') return classified;
  return classified.filter(c => regioGroupOf(c.storing) === state.toActiveFilter);
}

function renderToFilterTabs(classifiedRelevant) {
  const container = document.getElementById('to-filter-tabs');
  const present = sortByGroupOrder(Array.from(new Set(classifiedRelevant.map(c => regioGroupOf(c.storing)))));
  if (!present.includes(state.toActiveFilter) && state.toActiveFilter !== 'Totaal') state.toActiveFilter = 'Totaal';
  const tabs = ['Totaal', ...present];
  container.innerHTML = tabs.map(t => {
    const active = state.toActiveFilter === t ? ' active' : '';
    return `<button class="filter-tab${active}" data-to-filter="${esc(t)}">${esc(t === 'Totaal' ? 'Totaal' : regioGroupLabel(t))}</button>`;
  }).join('');
  container.querySelectorAll('button[data-to-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.toActiveFilter = btn.dataset.toFilter;
      renderToDashboardFromState();
    });
  });
}

// Handmatige WV-status: instelbaar voor elke relevante storing (zowel "bij
// meetdienst" als "open voor werkvoorbereiders"), zodat je ook kan vastleggen
// dat een storing bij de meetdienst ligt te wachten op iets specifieks.
function wvStatusOf(order) { return state.wvStatus[order] || {}; }

function renderToStatTiles(classified) {
  const el = document.getElementById('to-stat-tiles');
  const meetdienstCount = classified.filter(c => c.status === 'meetdienst').length;
  const wvItems = classified.filter(c => c.status === 'werkvoorbereiders');
  const relevant = classified.filter(c => c.status !== 'genegeerd');
  const oppakkenCount = relevant.filter(c => wvStatusOf(c.storing.order).status === 'oppakken').length;
  const wachtendCount = relevant.filter(c => wvStatusOf(c.storing.order).status === 'wachtend').length;
  const onbepaaldCount = relevant.length - oppakkenCount - wachtendCount;
  const tiles = [
    { label: 'Totaal relevant', value: meetdienstCount + wvItems.length },
    { label: 'Bij meetdienst', value: meetdienstCount, note: 'nog niets aan te doen' },
    { label: 'Open voor werkvoorbereiders', value: wvItems.length, note: 'moet ingepland worden' },
    { label: 'Moet opgepakt worden', value: oppakkenCount },
    { label: 'Wachtend op iets', value: wachtendCount, note: onbepaaldCount > 0 ? `${onbepaaldCount} nog niet bepaald` : undefined },
  ];
  el.innerHTML = tiles.map(t => `
    <div class="stat-tile">
      <div class="label">${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
      ${t.note ? `<div class="delta muted">${esc(t.note)}</div>` : ''}
    </div>`).join('');
}

function renderToIgnored(classified) {
  const container = document.getElementById('to-ignored');
  const ignored = classified.filter(c => c.status === 'genegeerd');
  if (ignored.length === 0) { container.innerHTML = '<p class="empty-note">Niets genegeerd deze week.</p>'; return; }
  const rows = ignored.map(c => `<tr>
      <td>${esc(c.storing.order)}</td>
      <td>${esc(c.storing.city)} — ${esc(c.storing.street)}</td>
      <td>${esc((c.storing.names || []).join(' → ') || '—')}</td>
      <td>${esc(c.reden)}</td>
    </tr>`).join('');
  container.innerHTML = `<table><thead><tr><th>Order</th><th>Adres</th><th>Naam</th><th>Reden</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const TO_COLUMNS = [
  { key: 'regioGroup', label: 'Regio' },
  { key: 'gebiedscode', label: 'Gebied' },
  { key: 'city', label: 'Plaats' },
  { key: 'street', label: 'Adres' },
  { key: 'order', label: 'Order' },
  { key: 'toStatusLabel', label: 'Status' },
  { key: 'namesLabel', label: 'Naam' },
  { key: 'daysLeft', label: 'Dagen', num: true },
  { key: 'executionDate', label: 'Uitvoering' },
  { key: 'type', label: 'Type' },
  { key: 'wvStatusSort', label: 'WV-status' },
];

const WV_STATUS_LABELS = { oppakken: 'Moet opgepakt worden', wachtend: 'Wachtend op iets' };

function sortToRows(rows) {
  const { key, dir } = state.toSortState;
  return rows.slice().sort((a, b) => {
    let va = a[key], vb = b[key];
    if (va == null) va = '';
    if (vb == null) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}

function renderToTableAll(classified) {
  const container = document.getElementById('to-table-all');
  const relevant = classified.filter(c => c.status !== 'genegeerd');
  if (relevant.length === 0) { container.innerHTML = '<p class="empty-note">Geen relevante storingen.</p>'; return; }
  const annotated = relevant.map(c => {
    const wv = wvStatusOf(c.storing.order);
    return Object.assign({}, c.storing, {
      regioGroup: regioGroupOf(c.storing),
      toStatus: c.status,
      toStatusLabel: c.status === 'meetdienst' ? 'Bij meetdienst' : "Open voor WV'ers",
      namesLabel: (c.storing.names || []).join(' → ') || '—',
      wvStatusSort: c.status === 'werkvoorbereiders' ? (WV_STATUS_LABELS[wv.status] || '') : '',
    });
  });
  const rows = sortToRows(annotated);
  const ovOrderSet = latestOvOrderSet();
  const head = TO_COLUMNS.map(col => {
    const active = state.toSortState.key === col.key ? (state.toSortState.dir === 1 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${col.key}" class="${col.num ? 'num' : ''}">${esc(col.label)}${active}</th>`;
  }).join('');
  const body = rows.map(s => {
    const wv = wvStatusOf(s.order);
    const wvCell = isStaticExport
      ? (wv.status
          ? `<span class="status-pill">${esc(WV_STATUS_LABELS[wv.status])}</span>${wv.note ? `<div class="muted small">${esc(wv.note)}</div>` : ''}`
          : '<span class="muted small">— Nog te bepalen —</span>')
      : `
      <select class="wv-status-select" data-order="${esc(s.order)}">
        <option value="" ${!wv.status ? 'selected' : ''}>— Nog te bepalen —</option>
        <option value="oppakken" ${wv.status === 'oppakken' ? 'selected' : ''}>Moet opgepakt worden</option>
        <option value="wachtend" ${wv.status === 'wachtend' ? 'selected' : ''}>Wachtend op iets</option>
      </select>
      ${wv.status === 'wachtend' ? `<input type="text" class="wv-status-note" data-order="${esc(s.order)}" placeholder="Waarop wacht je?" value="${esc(wv.note || '')}">` : ''}`;
    return `<tr${isUnplannedOverdue(s) ? ' class="row-alert"' : ''}>
      <td>${esc(regioGroupLabel(s.regioGroup))}</td>
      <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${esc(s.order)} ${crossBucketBadge(s.order, ovOrderSet, 'ook in OV NUSsen-bak', '--series-1')}</td>
      <td>${esc(s.toStatusLabel)}</td>
      <td>${esc(s.namesLabel)}</td>
      <td class="num">${renderDaysPill(s)}</td>
      <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
      <td>${esc(s.type)}</td>
      <td class="wv-status-cell">${wvCell}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  container.querySelectorAll('.wv-status-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const order = sel.dataset.order;
      const current = state.wvStatus[order] || {};
      state.wvStatus[order] = { status: sel.value, note: current.note || '' };
      await saveWvStatusMap(state.wvStatus);
      renderToDashboardFromState();
    });
  });
  container.querySelectorAll('.wv-status-note').forEach(inp => {
    inp.addEventListener('change', async () => {
      const order = inp.dataset.order;
      const current = state.wvStatus[order] || {};
      state.wvStatus[order] = { status: current.status, note: inp.value };
      await saveWvStatusMap(state.wvStatus);
      renderToDashboardFromState();
    });
  });
}

function renderToWeeksList() {
  const container = document.getElementById('to-weeks-list');
  if (state.toSnapshots.length === 0) { container.innerHTML = '<p class="empty-note">Nog geen weken opgeslagen.</p>'; return; }
  const rows = state.toSnapshots.slice().sort((a, b) => b.week.localeCompare(a.week)).map(sn => `
    <div class="weeks-list-row">
      <span>Week van <strong>${esc(sn.week)}</strong> — ${sn.storingen.length} storingen (opgeslagen ${esc(fmtDate(sn.savedAt))})</span>
      <button class="btn-link danger" data-to-week="${esc(sn.week)}">Verwijderen</button>
    </div>`).join('');
  container.innerHTML = rows;
  container.querySelectorAll('button[data-to-week]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Week ${btn.dataset.toWeek} verwijderen?`)) return;
      const snaps = (await loadToSnapshots()).filter(s => s.week !== btn.dataset.toWeek);
      await saveToSnapshots(snaps);
      state.toSnapshots = snaps;
      if (snaps.length === 0) document.getElementById('to-dashboard').classList.add('hidden');
      else renderToDashboardFromState();
      if (state.snapshots.length > 0) renderDashboardFromState(); // cross-bak badges bijwerken
      renderToWeeksList();
    });
  });
}

function showToParseWarning(errors, okCount) {
  const el = document.getElementById('to-parse-warning');
  if (errors.length === 0) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<strong>${errors.length} van de ${errors.length + okCount} blokken kon niet worden herkend.</strong>
    <details><summary>Bekijk details</summary>
      ${errors.map(e => `<div style="margin-top:8px;"><em>${esc(e.message)}</em><pre style="white-space:pre-wrap;font-size:0.75rem;">${esc(e.raw)}</pre></div>`).join('')}
    </details>`;
}

function renderToDashboardFromState() {
  const snaps = state.toSnapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  state.toSnapshots = snaps;
  renderMeetdienstList();
  renderHandoffList();
  if (snaps.length === 0) { document.getElementById('to-dashboard').classList.add('hidden'); return; }
  const latest = snaps[snaps.length - 1];
  const classified = latest.storingen.map(s => Object.assign({ storing: s }, classifyTeOnderzoeken(s)));
  const relevantAll = classified.filter(c => c.status !== 'genegeerd');

  renderToFilterTabs(relevantAll);
  const classifiedFiltered = filterToByActive(classified);

  document.getElementById('to-dashboard').classList.remove('hidden');
  renderToStatTiles(classifiedFiltered);
  renderToIgnored(classifiedFiltered);
  renderToTableAll(classifiedFiltered);
  renderToWeeksList();
  updateStorageUsage();
}

/* ---------- Orchestration ---------- */

function renderDashboardFromState() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  state.snapshots = snaps;
  if (snaps.length === 0) { document.getElementById('dashboard').classList.add('hidden'); return; }
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;

  const latestVisible = typeFiltered(latest.storingen);
  const previousVisible = previous ? typeFiltered(previous.storingen) : null;

  renderTypeWhitelist();
  renderTypeUnknownReview();
  renderFilterTabs(latestVisible);

  const latestFiltered = filterByActive(latestVisible);
  const previousFiltered = previousVisible ? { storingen: filterByActive(previousVisible) } : null;
  const mutations = computeMutations(latestFiltered, previousFiltered);

  document.getElementById('dashboard').classList.remove('hidden');
  renderStatTiles(latestFiltered, mutations);
  renderRegioChart(latestFiltered); // volgt de actieve filtertab (Totaal = alle regio's, anders alleen die regio)
  renderTrendChart(snaps); // idem, filtert zelf op state.activeFilter
  renderMutationTables(mutations);
  renderTableAll(latestFiltered);
  renderWeeksList();
  updateStorageUsage();
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
  state.snapshots = await loadSnapshots();
  state.typeWhitelist = await loadTypeWhitelist();
  state.toSnapshots = await loadToSnapshots();
  state.meetdienstNamen = await loadNameList(MEETDIENST_LIST_KEY, DEFAULT_MEETDIENST_NAMEN);
  state.handoffNamen = await loadNameList(HANDOFF_LIST_KEY, DEFAULT_HANDOFF_NAMEN);
  state.wvStatus = await loadWvStatusMap();
  if (state.snapshots.length > 0) renderDashboardFromState();
  else { document.getElementById('dashboard').classList.add('hidden'); renderTypeWhitelist(); renderTypeUnknownReview(); }
  if (state.toSnapshots.length > 0) renderToDashboardFromState();
  else { document.getElementById('to-dashboard').classList.add('hidden'); renderMeetdienstList(); renderHandoffList(); }
}

function wireEvents() {
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

  document.getElementById('import-backup-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm('Dit overschrijft alle huidige opgeslagen weken en instellingen (beide bakken) met de inhoud van dit back-upbestand. Doorgaan?')) return;
    const statusEl = document.getElementById('backup-status');
    try {
      await importBackup(file);
      await reloadAllStateAndRender();
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

    const snaps = await loadSnapshots();
    const idx = snaps.findIndex(s => s.week === week);
    const snapshot = { week, savedAt: new Date().toISOString(), storingen };
    if (idx >= 0) snaps[idx] = snapshot; else snaps.push(snapshot);
    try {
      await saveSnapshots(snaps);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    state.snapshots = snaps;

    renderDashboardFromState();
    if (state.toSnapshots.length > 0) renderToDashboardFromState(); // cross-bak badges bijwerken
    showParseWarning(errors, storingen.length);
    statusEl.textContent = `${storingen.length} storingen verwerkt voor week ${week}` + (errors.length ? `, ${errors.length} regels niet herkend` : '');
    textarea.value = '';
  });

  document.getElementById('clear-all-btn').addEventListener('click', async () => {
    if (!confirm('Alle opgeslagen weken verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    await clearSnapshots();
    state.snapshots = [];
    document.getElementById('dashboard').classList.add('hidden');
    if (state.toSnapshots.length > 0) renderToDashboardFromState(); // cross-bak badges bijwerken
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

  document.getElementById('add-type-btn').addEventListener('click', async () => {
    const input = document.getElementById('new-type-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.typeWhitelist.includes(val)) state.typeWhitelist.push(val);
    await saveTypeWhitelist(state.typeWhitelist);
    input.value = '';
    renderDashboardFromState();
  });

  document.getElementById('to-process-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('to-paste-input');
    const raw = textarea.value;
    const statusEl = document.getElementById('to-process-status');
    const week = document.getElementById('to-week-date').value;
    if (!raw.trim()) { statusEl.textContent = 'Plak eerst tekst.'; return; }
    if (!week) { statusEl.textContent = 'Kies een weekdatum.'; return; }

    const { storingen, errors } = parseText(raw);
    if (storingen.length === 0) {
      statusEl.textContent = 'Geen storingen herkend — controleer het formaat hieronder.';
      showToParseWarning(errors, 0);
      return;
    }

    const snaps = await loadToSnapshots();
    const idx = snaps.findIndex(s => s.week === week);
    const snapshot = { week, savedAt: new Date().toISOString(), storingen };
    if (idx >= 0) snaps[idx] = snapshot; else snaps.push(snapshot);
    try {
      await saveToSnapshots(snaps);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    state.toSnapshots = snaps;

    renderToDashboardFromState();
    if (state.snapshots.length > 0) renderDashboardFromState(); // cross-bak badges bijwerken
    showToParseWarning(errors, storingen.length);
    statusEl.textContent = `${storingen.length} storingen verwerkt voor week ${week}` + (errors.length ? `, ${errors.length} regels niet herkend` : '');
    textarea.value = '';
  });

  document.getElementById('to-clear-all-btn').addEventListener('click', async () => {
    if (!confirm('Alle opgeslagen weken (te onderzoeken storingen) verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    await clearToSnapshots();
    state.toSnapshots = [];
    document.getElementById('to-dashboard').classList.add('hidden');
    if (state.snapshots.length > 0) renderDashboardFromState(); // cross-bak badges bijwerken
  });

  document.getElementById('add-meetdienst-btn').addEventListener('click', async () => {
    const input = document.getElementById('new-meetdienst-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.meetdienstNamen.includes(val)) state.meetdienstNamen.push(val);
    await saveNameList(MEETDIENST_LIST_KEY, state.meetdienstNamen);
    input.value = '';
    renderToDashboardFromState();
  });

  document.getElementById('add-handoff-btn').addEventListener('click', async () => {
    const input = document.getElementById('new-handoff-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.handoffNamen.includes(val)) state.handoffNamen.push(val);
    await saveNameList(HANDOFF_LIST_KEY, state.handoffNamen);
    input.value = '';
    renderToDashboardFromState();
  });

  document.getElementById('to-table-all').addEventListener('click', e => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    if (state.toSortState.key === th.dataset.key) state.toSortState.dir *= -1;
    else { state.toSortState.key = th.dataset.key; state.toSortState.dir = 1; }
    const latest = state.toSnapshots[state.toSnapshots.length - 1];
    if (latest) {
      const classified = latest.storingen.map(s => Object.assign({ storing: s }, classifyTeOnderzoeken(s)));
      renderToTableAll(filterToByActive(classified));
    }
  });
}

// Echte tabbladen: precies één paneel zichtbaar tegelijk, in plaats van één
// lange scrollpagina. Onthoudt de laatst gekozen tab binnen dit tabblad
// (sessionStorage) zodat een herlaad niet steeds terug naar OV NUSsen springt.
const TAB_SESSION_KEY = 'nusdash_active_tab';
function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('hidden', p.dataset.tabPanel !== tab);
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  try { sessionStorage.setItem(TAB_SESSION_KEY, tab); } catch (e) { /* privénavigatie o.i.d. */ }
}
function setupTabNav() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  let initial = 'ov';
  try { initial = sessionStorage.getItem(TAB_SESSION_KEY) || 'ov'; } catch (e) { /* privénavigatie o.i.d. */ }
  switchTab(initial);
}

function applyStaticExportData() {
  document.body.classList.add('static-export');
  const bannerEl = document.getElementById('static-export-banner');
  const exportedAt = STATIC_DATA.exportedAt ? fmtDate(STATIC_DATA.exportedAt) : null;
  bannerEl.textContent = 'Momentopname' + (exportedAt ? ` van ${exportedAt}` : '') + ' — bekijk-alleen. Voor de actuele versie of om iets aan te passen, ga naar degene die dit gedeeld heeft.';
  bannerEl.classList.remove('hidden');

  state.snapshots = STATIC_DATA.ovSnapshots || [];
  state.typeWhitelist = STATIC_DATA.typeWhitelist || [];
  state.toSnapshots = STATIC_DATA.teOnderzoekenSnapshots || [];
  state.meetdienstNamen = STATIC_DATA.meetdienstNamen || [];
  state.handoffNamen = STATIC_DATA.handoffNamen || [];
  state.wvStatus = STATIC_DATA.wvStatus || {};

  if (state.snapshots.length > 0) renderDashboardFromState();
  else document.getElementById('dashboard').classList.add('hidden');
  if (state.toSnapshots.length > 0) renderToDashboardFromState();
  else document.getElementById('to-dashboard').classList.add('hidden');

  // Instellingen-tab heeft niets te doen in een bekijk-alleen export: geen
  // back-up, geen type-filter, geen naamlijsten om te bewerken.
  const settingsBtn = document.querySelector('.tab-btn[data-tab="settings"]');
  if (settingsBtn) settingsBtn.classList.add('hidden');
}

async function init() {
  document.getElementById('week-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('to-week-date').value = new Date().toISOString().slice(0, 10);
  wireEvents();
  setupTabNav();
  if (isStaticExport) applyStaticExportData();
  else await reloadAllStateAndRender();
}

document.addEventListener('DOMContentLoaded', init);
