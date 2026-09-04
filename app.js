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

// Een losse regel "1" achter de naam van de uitvoerder komt in de bron voor,
// maar wordt niet betrouwbaar ingevuld — er is dus niets zinnigs uit af te
// leiden en er hangt nergens meer een telling aan. De regel wordt hier alleen
// nog overgeslagen bij het uitlezen van de namen: zonder dat zou bij een
// storing met alleen een uitvoerder die "1" als WV'er worden gelezen.
const LOSSE_EEN_RE = /^1$/;

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
  const flagLines = middleLines.filter(l => flagLineRe.test(l));
  const nameLines = middleLines.filter(l => !flagLineRe.test(l) && !LOSSE_EEN_RE.test(l));

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
];

// "LS storing/schade" stond hier alleen om de saneringen binnen te halen: het
// type telde mee, maar de regels zonder de markering "1" werden er daarna weer
// uitgefilterd. Nu die markering is vervallen zou het type in één klap volledig
// gaan meetellen — een stille sprong in de werkvoorraad met regels waarvan je
// eerder hebt gezegd dat ze er niet in horen.
//
// Daarom wordt hij één keer uit een bestaand type-filter gehaald. Dat is geen
// verstopte aftrek: het type verschijnt daarna bovenaan de Data-pagina in de
// melding "telt niet mee", mét het aantal en een plusknop om het alsnog te
// laten meetellen. De keuze ligt dus zichtbaar bij jou. De vlag zorgt dat het
// bij één keer blijft — zet je het type terug, dan blijft het staan.
const LS_TYPE = 'LS storing/schade';
const LS_TYPE_OPGERUIMD_KEY = 'nusdash_ls_type_opgeruimd_v1';
async function ruimLsTypeEenmaligOp(lijst) {
  try {
    if (await idbGet(LS_TYPE_OPGERUIMD_KEY)) return lijst;
    await idbSet(LS_TYPE_OPGERUIMD_KEY, true);
    if (!lijst.includes(LS_TYPE)) return lijst;
    const zonder = lijst.filter(t => t !== LS_TYPE);
    await idbSet(TYPE_WHITELIST_KEY, zonder);
    return zonder;
  } catch (e) { console.error(e); return lijst; }
}

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
  try {
    const v = await idbGet(TYPE_WHITELIST_KEY);
    if (!v) return DEFAULT_TYPE_WHITELIST.slice();
    return await ruimLsTypeEenmaligOp(v);
  }
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

// Streefwaarde per status: hoe lang een storing daar hóórt te staan.
//
// Waarom niet gewoon de gemeten mediaan als maatstaf? Omdat die meebeweegt met
// hoe het gaat. Duurt "Onderzoek controleren" structureel vier dagen, dan wordt
// vier dagen "normaal" en valt er niets meer op — precies de statussen waar je
// scherp op wilt zijn, meten zichzelf dan goed. Een streefwaarde is een norm
// die je zelf zet en die niet meeschuift.
//
// Alleen de twee statussen waarvoor de norm bekend is (binnen één dag door)
// staan er standaard in; voor de rest wordt teruggevallen op de gemeten
// mediaan tot er zelf een waarde is ingevuld. Losstaande sleutel in dezelfde
// kv-store: geen schemawijziging, en zonder de sleutel gedraagt alles zich
// zoals voorheen.
// Het uitgangspunt: een NUS doorloopt het héle traject in maximaal 12 dagen
// (10 werkdagen). Dat is de norm waar alles aan hangt — de streefwaarden per
// status hieronder zijn niets anders dan die 12 dagen verdeeld over de zes
// stappen. Vandaar dat ze standaard optellen tot precies 12: als elke stap
// binnen zijn deel blijft, haalt het traject het vanzelf.
const DOORLOOPTIJD_NORM_KEY = 'nusdash_doorlooptijd_norm_v1';
const DEFAULT_DOORLOOPTIJD_NORM = 12;
async function loadDoorlooptijdNorm() {
  try { const v = await idbGet(DOORLOOPTIJD_NORM_KEY); return Number.isFinite(v) && v > 0 ? v : DEFAULT_DOORLOOPTIJD_NORM; }
  catch (e) { console.error(e); return DEFAULT_DOORLOOPTIJD_NORM; }
}
async function saveDoorlooptijdNorm(n) {
  try { await idbSet(DOORLOOPTIJD_NORM_KEY, n); }
  catch (e) { showErrorToast('Opslaan van de doorlooptijd-norm is mislukt: ' + e.message); }
}

const STATUS_STREEF_KEY = 'nusdash_status_streef_v1';
// Samen 12. "Nieuw" en "Onderzoek controleren" zijn doorgeefstappen — daar
// hoort niets te blijven liggen, dus één dag. De ruimte zit in het onderzoek
// zelf; de rest krijgt twee dagen om te schakelen.
const DEFAULT_STATUS_STREEF = {
  'Nieuw': 1,
  'In onderzoek': 4,
  'Onderzoek controleren': 1,
  'In voorbereiding': 2,
  'Planning': 2,
  'In uitvoering': 2,
};
function schoonStatusStreef(v) {
  const uit = {};
  if (!v || typeof v !== 'object') return uit;
  OV_STATUS_ORDER.forEach(status => {
    const n = v[status];
    if (Number.isFinite(n) && n >= 0) uit[status] = n;
  });
  return uit;
}
async function loadStatusStreef() {
  try {
    const v = await idbGet(STATUS_STREEF_KEY);
    // Nooit opgeslagen = de standaardnorm. Wél opgeslagen maar leeg betekent
    // dat alles bewust is leeggemaakt; dat moet blijven staan.
    if (v === undefined || v === null) return Object.assign({}, DEFAULT_STATUS_STREEF);
    return schoonStatusStreef(v);
  } catch (e) { console.error(e); return Object.assign({}, DEFAULT_STATUS_STREEF); }
}
async function saveStatusStreef(streef) {
  try { await idbSet(STATUS_STREEF_KEY, streef); }
  catch (e) { showErrorToast('Opslaan van de streefwaarden is mislukt: ' + e.message); }
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
    statusStreef: await loadStatusStreef(),
    doorlooptijdNorm: await loadDoorlooptijdNorm(),
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
    statusStreef: state.statusStreef,
    doorlooptijdNorm: state.doorlooptijdNorm,
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
  if (backup.statusStreef && typeof backup.statusStreef === 'object') await saveStatusStreef(schoonStatusStreef(backup.statusStreef));
  if (Number.isFinite(backup.doorlooptijdNorm) && backup.doorlooptijdNorm > 0) await saveDoorlooptijdNorm(backup.doorlooptijdNorm);
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

// Wat meetelt in de werkvoorraad: geen klantaanvraag, en een type dat in het
// type-filter staat. Verder niets — er was een uitzondering voor
// "LS storing/schade" (die telde alleen mee met een losse "1" erbij, want dan
// was het een sanering), maar die "1" bleek in de bron niet betrouwbaar te
// worden ingevuld. Een telling die daarop leunt zegt dus niets, en een
// uitzondering die je niet kunt vertrouwen is erger dan geen uitzondering:
// hij haalt stilletjes regels uit je werkvoorraad.
function telAlsStoring(s) {
  return !isKlantaanvraag(s) && isTypeIncluded(s);
}
function typeFiltered(list) { return list.filter(telAlsStoring); }

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

// Een meetdag is een kalenderdag ('2026-08-17'), geen tijdstip. new Date()
// leest zo'n string als middernacht UTC, en de datum wordt daarna met lokale
// getters weer uitgelezen — ten westen van Greenwich levert dat een dag te
// vroeg op. Vandaar één plek die een kalenderdag als lokale datum opbouwt;
// alles met een echt tijdstip (een uitvoeringsdatum, een opslagmoment) blijft
// gewoon door new Date() gaan.
const KALENDERDAG_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dagBegin(waarde) {
  const m = typeof waarde === 'string' ? waarde.match(KALENDERDAG_RE) : null;
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  return new Date(waarde);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = dagBegin(iso);
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
  const d = dagBegin(iso);
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
  statusStreef: {},
  doorlooptijdNorm: DEFAULT_DOORLOOPTIJD_NORM,
  stagnatieFilter: null,
  boxplotSchaal: 'whisker',
  boxplotViewMode: 'chart',
  stagnatieSortState: { key: 'traject', dir: -1 },
  historieQuery: '',
  historieSortState: { key: 'eerst', dir: -1 },
  recidiveMode: 'straat',
  clusterMode: 'pc4',
  lijstSoort: 'nus',
  lijstHerkend: null,
  lijstHandmatig: false,
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
function isExpiredExecutionDate(s, peilDag) {
  if (!s.overdue || !s.executionDate) return false;
  const execDay = new Date(s.executionDate);
  execDay.setHours(0, 0, 0, 0);
  // Zonder peildag: vandaag. Mét: de dag waarop die momentopname is gemaakt —
  // nodig voor een terugblik, want anders wordt de stand van vorige week
  // beoordeeld met een datum die toen nog niet verstreken was.
  const grens = peilDag ? dagBegin(peilDag) : new Date();
  grens.setHours(0, 0, 0, 0);
  return execDay.getTime() < grens.getTime();
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
// Zonder peildag: de blokkade zoals die nu staat. Mét peildag: de blokkade
// zoals die in díé momentopname was vastgelegd (zie blokkadeReden, dat sinds
// begin af aan wordt meegeschreven bij elke plakactie). Een blokkade die je
// vandaag zet, hoort niet met terugwerkende kracht in de kolom van vorige week
// te verschijnen. Momentopnamen van vóór het meeschrijven hebben geen
// blokkadeReden; die gelden als "toen niet geblokkeerd", wat eerlijker is dan
// de blokkade van vandaag erop plakken.
function isOvBlocked(s, peilDag) {
  if (peilDag) return !!s.blokkadeReden;
  return !!ovBlockStatusOf(s.order).reason;
}
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
  // "Nog niet eerder gezien" is iets anders dan de status "Nieuw", en ze
  // stonden eerder op dezelfde tegel. Dat kostte de werkvoorraad zijn
  // sluitende telling: een storing die al weken op status "Nieuw" staat is
  // niet meer nieuw-gezien, en viel daardoor buiten élke statustegel — bij een
  // bak die vooral in "Nieuw" zit telden de zes tegels op tot bijna niets
  // terwijl er van alles openstond. Ze staan nu uit elkaar:
  //  - de zes statustegels volgen de status uit de Instandhoudingsapp en
  //    tellen samen met "geblokkeerd" op tot het totaal;
  //  - "nog niet eerder gezien" is een mutatie (instroom), en hoort dus bij
  //    "afgesloten/uitgegaan", niet bij de voorraad.
  // Dat "Nieuw" als status scheef kan staan (een storing die meteen wordt
  // opgepakt toont al bij de eerste keer zien "In onderzoek") blijft waar,
  // maar dat is een reden om de instroom apart te tellen — niet om een gat in
  // de voorraadtelling te laten vallen.
  const firstSeenMap = firstSeenWeekMap();
  const sortedSnaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  const latestWeek = sortedSnaps.length ? sortedSnaps[sortedSnaps.length - 1].week : null;
  filters.nieuwGezien = {
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
const OV_DETAIL_LIST_KEYS = new Set([...Object.values(OV_STATUS_FILTER_KEYS), 'nieuwGezien', 'geblokkeerd', 'mastGeenSpanning']);
const OV_TILE_TITLES = {
  totaal: 'Totaal open',
  verlopenDatum: 'Uitvoeringsdatum verstreken',
  unknown: 'Verlopen — uitvoering onbekend',
  afgesloten: 'Afgesloten / uitgegaan',
  geblokkeerd: 'Geblokkeerd (Aannemerij / Naar Aanleg / Uitvoerder / Onderzoek loopt)',
  mastGeenSpanning: 'Mast geen spanning',
};
OV_STATUS_ORDER.forEach(status => { OV_TILE_TITLES[OV_STATUS_FILTER_KEYS[status]] = `Status: ${status}`; });
OV_TILE_TITLES.nieuwGezien = 'Nieuw binnengekomen (nog niet eerder gezien)';

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
    { groep: 'mutatie', key: 'nieuwGezien', icon: '🆕', label: 'Nieuw binnengekomen', value: current.filter(filters.nieuwGezien.test).length,
      note: 'ordernummer nog nooit eerder gezien', filterKey: 'nieuwGezien' },
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
    // Geblokkeerd is uit de statustegels gehouden (daar gaat het om wat je kunt
    // oppakken), dus de zes statussen tellen op tot het totaal mínus de
    // geblokkeerde. Dat hoort er letterlijk bij te staan, anders lijkt een
    // sluitende telling niet te kloppen zodra er iets geblokkeerd is.
    { key: 'voorraad', label: 'Werkvoorraad', uitleg: 'De statussen tellen samen op tot het totaal; geblokkeerde storingen staan apart onder Signalen en zitten niet in een statustegel.' },
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

/* ---------- Verdeling: P50 en P90 ---------- */

// Eén gemiddelde verbergt precies wat je wilt weten. Duren de meeste storingen
// drie dagen en een handvol dertig, dan komt daar een getal uit dat voor géén
// enkele storing geldt: te hoog om de gewone gang van zaken te beschrijven, te
// laag om de uitschieters te laten zien.
//
// P50 en P90 splitsen dat uit elkaar. P50 (de mediaan) is de gewone gang van
// zaken: de helft is er sneller doorheen. P90 is de staart: negen van de tien
// blijven eronder, dus wat erboven zit zijn de uitzonderingen. Staan die twee
// ver uit elkaar, dan is dát het verhaal — niet het gemiddelde ertussenin.
//
// Lineaire interpolatie tussen de twee dichtstbijzijnde metingen, dezelfde
// definitie als PERCENTILE.INC in Excel. Zo is P50 exact de klassieke mediaan
// en komen de getallen overeen met wat je in een spreadsheet zou narekenen.
function percentiel(gesorteerd, p) {
  if (gesorteerd.length === 0) return null;
  if (gesorteerd.length === 1) return gesorteerd[0];
  const positie = (gesorteerd.length - 1) * p;
  const onder = Math.floor(positie);
  const rest = positie - onder;
  if (onder + 1 >= gesorteerd.length) return gesorteerd[gesorteerd.length - 1];
  return gesorteerd[onder] + (gesorteerd[onder + 1] - gesorteerd[onder]) * rest;
}

// P50 heeft weinig metingen nodig om iets te betekenen, P90 veel meer: met
// drie metingen is "de bovenste 10%" niet meer dan de hoogste meting met een
// andere naam. Vandaar twee drempels.
const MIN_METINGEN_P50 = 3;
const MIN_METINGEN_P90 = 5;

function verdelingVan(waarden) {
  if (!waarden || waarden.length === 0) return null;
  const a = waarden.slice().sort((x, y) => x - y);
  return {
    n: a.length,
    min: a[0],
    max: a[a.length - 1],
    gemiddeld: a.reduce((s, v) => s + v, 0) / a.length,
    p50: a.length >= MIN_METINGEN_P50 ? percentiel(a, 0.5) : null,
    p90: a.length >= MIN_METINGEN_P90 ? percentiel(a, 0.9) : null,
  };
}

function rondDag(v) { return Math.round(v * 10) / 10; }
// Afgerond op één decimaal, want een percentiel is bijna nooit een rond getal.
// Bewust een andere naam dan dagenTekst() verderop: die krijgt al een geheel
// getal binnen en hoort niet af te ronden.
function dagenAfgerond(v) { return v == null ? '—' : dagenTekst(rondDag(v)); }

// De zin die het gemiddelde niet kan geven: hoe ver de staart uitloopt op de
// gewone gang van zaken. Alleen tonen als er echt een staart is — anders is
// het een zin die zegt dat er niets aan de hand is, en die kost alleen ruimte.
const STAART_RATIO = 2;
function staartZin(v) {
  if (!v || v.p50 == null || v.p90 == null) return '';
  if (v.p50 > 0 && v.p90 / v.p50 < STAART_RATIO) return '';
  return `De helft is binnen ${dagenAfgerond(v.p50)} klaar, maar één op de tien doet er ${dagenAfgerond(v.p90)} of langer over — de uitschieters zitten in die staart, niet in de gewone gang van zaken.`;
}

function verdelingTegelsHtml(v, wat) {
  const tegels = [
    { label: 'P50 — de helft', value: dagenAfgerond(v.p50), note: v.p50 == null ? `nog geen ${MIN_METINGEN_P50} metingen` : 'de helft is hier binnen klaar' },
    { label: 'P90 — de staart', value: dagenAfgerond(v.p90), note: v.p90 == null ? `nog geen ${MIN_METINGEN_P90} metingen` : 'negen van de tien blijven eronder' },
    { label: 'Langste', value: dagenAfgerond(v.max), note: 'de uitschieter zelf' },
    { label: 'Gemiddeld', value: dagenAfgerond(v.gemiddeld), note: `over ${v.n} ${wat}` },
  ];
  return `<div class="stat-row verdeling-tegels">`
    + tegels.map(t => `<div class="stat-tile">
        <div class="label">${esc(t.label)}</div>
        <div class="value">${esc(t.value)}</div>
        <div class="delta">${esc(t.note)}</div>
      </div>`).join('')
    + `</div>`;
}

function renderDoorlooptijdCard() {
  const el = document.getElementById('doorlooptijd-card-body');
  if (!el) return;
  const durations = resolvedDurations();
  if (durations.length === 0) {
    el.innerHTML = '<p class="empty-note">Nog geen storingen uit de lijst verdwenen sinds we zijn gaan meten — kom hier later op terug.</p>';
    return;
  }
  const v = verdelingVan(durations.map(d => d.days));
  let trendHtml = '';
  if (durations.length >= 4) {
    // De trend blijft op de mediaan van beide helften: een gemiddelde zou hier
    // opnieuw door één uitschieter kunnen kantelen, en dan lijkt het langzamer
    // te gaan terwijl alleen de staart is uitgelopen.
    const half = Math.floor(durations.length / 2);
    const p50Van = (list) => percentiel(list.map(d => d.days).sort((a, b) => a - b), 0.5);
    const diff = p50Van(durations.slice(half)) - p50Van(durations.slice(0, half));
    if (Math.abs(diff) >= 0.5) {
      trendHtml = `<p class="delta ${diff < 0 ? 'good' : 'bad'}">${diff < 0 ? '↓' : '↑'} ${Math.abs(diff).toFixed(1)} dagen ${diff < 0 ? 'sneller' : 'langzamer'} dan de oudere helft van de metingen (P50 tegen P50).</p>`;
    }
  }
  const staart = staartZin(v);
  el.innerHTML = verdelingTegelsHtml(v, durations.length === 1 ? 'storing' : 'storingen')
    + (staart ? `<p class="prognose-headline">${esc(staart)}</p>` : '')
    + trendHtml
    + `<p class="muted small">Over ${durations.length} storing${durations.length === 1 ? '' : 'en'} die sinds het begin van de metingen uit de lijst zijn verdwenen (van eerst gezien tot niet meer aanwezig). Het gemiddelde staat er alleen ter vergelijking bij: zit dat ver boven P50, dan wordt het opgetrokken door een paar hele lange gevallen en beschrijft het geen enkele storing.</p>`;
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
// Elke test krijgt de dag mee waarop die momentopname is gemaakt. Voor de
// kolom "nu" is dat de laatste meetdag en gedraagt alles zich als altijd; voor
// de kolom van de peildag zorgt het ervoor dat er niet met de kennis van
// vandaag naar vorige week wordt gekeken (zie isOvBlocked en
// isExpiredExecutionDate). Zonder dat stond een blokkade die je vandaag zet
// ook al in de kolom van vorige week, en kwam het verschil op "gelijk" uit
// terwijl er wel degelijk iets veranderd was.
const OVERLEG_SIGNALEN = [
  { key: 'onderzoekControleren', label: 'Onderzoek controleren', test: s => s.ovStatus === 'Onderzoek controleren' },
  { key: 'verlopenOnbekend', label: 'Verlopen — uitvoering onbekend', test: (s, dag) => isUnplannedOverdue(s) && !isOvBlocked(s, dag) },
  { key: 'verlopenDatum', label: 'Uitvoeringsdatum verstreken', test: (s, dag) => isExpiredExecutionDate(s, dag) && !isOvBlocked(s, dag) },
  { key: 'bijnaVerlopen', label: 'Bijna verlopen', test: (s, dag) => statusOf(s) === 'serious' && !isOvBlocked(s, dag) },
  { key: 'geblokkeerd', label: 'Geblokkeerd', test: (s, dag) => isOvBlocked(s, dag) },
  { key: 'mastGeenSpanning', label: 'Mast geen spanning', test: s => isMastGeenSpanning(s) },
];

function signalenVergelijk(peilLijst, nuLijst, peilDag) {
  return OVERLEG_SIGNALEN.map(sig => {
    const toen = peilLijst.filter(s => sig.test(s, peilDag)).length;
    const nu = nuLijst.filter(s => sig.test(s, null)).length;
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
      signalen: signalenVergelijk(peilLijst.filter(inGroep), nuLijst.filter(inGroep), peil.week),
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
    signalen: signalenVergelijk(peilLijst, nuLijst, peil.week),
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
// "Totaal open 6" terwijl je er 11 had geplakt, en die regels waren nergens
// meer te vinden. Stil weglaten is voor een
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
          <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}</td>
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

// De Instandhoudingsapp heeft twee losse overzichten die elk apart worden
// geplakt: de NUS-storingen en de klantaanvragen. Een plakactie ververst dus
// maar één van die twee lijsten.
// Wat je kunt plakken. "Saneringen" was hier een derde keuze; die is vervallen
// omdat de markering waarop dat overzicht leunde niet betrouwbaar is.
const LIJST_SOORTEN = ['nus', 'klantaanvraag'];
// Wat er in oude momentopnamen kan staan. 'sanering' houdt daarom zijn eigen
// plek bij het samenvoegen: zonder dat zou zo'n oude plakactie op naam van
// 'nus' komen te staan en door de NUS-plakactie van diezelfde dag worden
// overschreven — dan verdwenen er met terugwerkende kracht storingen uit de
// historie.
const LIJST_SOORTEN_OPGESLAGEN = ['nus', 'sanering', 'klantaanvraag'];
const LIJST_LABELS = {
  nus: 'NUS-storingen',
  sanering: 'Saneringen',
  klantaanvraag: 'Klantaanvragen',
};

// Voor plakacties van vóór deze indeling (en als vangnet) wordt de soort uit
// de inhoud afgeleid. Bewust streng: alleen als ALLES in de lijst een
// klantaanvraag is, is het dat overzicht. Een gemengde lijst geldt als de
// NUS-lijst — dat is het oude gedrag, en dat mag niet stilletjes
// veranderen voor al opgeslagen data.
function afleidenLijstSoort(storingen) {
  if (!storingen || storingen.length === 0) return 'nus';
  if (storingen.every(isKlantaanvraag)) return 'klantaanvraag';
  return 'nus';
}
function lijstSoortVan(sn) {
  return LIJST_SOORTEN_OPGESLAGEN.includes(sn.lijst) ? sn.lijst : afleidenLijstSoort(sn.storingen);
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
    //
    // Carry-forward geldt alleen voor lijsten die je nog kúnt verversen. De
    // vervallen saneringenlijst telt daarom alleen mee op de dag dat 'ie
    // geplakt is: hij is nooit meer bij te werken, dus zou hij anders tot in
    // de eeuwigheid in de werkvoorraad blijven staan zonder dat er ooit iets
    // uit kan gaan. Op zijn eigen dag blijft hij gewoon staan, dus de historie
    // van toen verandert niet.
    const bronnen = LIJST_SOORTEN_OPGESLAGEN
      .map(soort => {
        const sn = laatstePerLijst[soort];
        if (!sn) return null;
        return (LIJST_SOORTEN.includes(soort) || sn.week === dag) ? sn : null;
      })
      .filter(Boolean)
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

// Wanneer is elk overzicht voor het laatst geplakt? Met twee lijsten die
// onafhankelijk worden ververst is dat geen detail: een klantaanvraag die
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
// Alles in dagen, net als de rest van het dashboard — weken als aparte eenheid
// maakte het onnodig lastig te vergelijken met de dagen-teller ernaast. Wat
// "te lang" is verschilt per status (zie statusNormVan hieronder): "In
// voorbereiding" duurt van nature langer dan "Nieuw", dus één vaste drempel
// zou de ene status overspoelen en de andere nooit raken.

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

  // De volledige verdeling per status, niet alleen het middelste getal: pas
  // met P50 én P90 ernaast is te zien of een lange gemiddelde duur komt door
  // de hele bak of door een paar gevallen die blijven hangen.
  const verdelingen = {};
  const medianen = {};
  const metingen = {};
  Object.keys(afgerond).forEach(st => {
    metingen[st] = afgerond[st].length;
    const v = verdelingVan(afgerond[st]);
    verdelingen[st] = v;
    // De norm valt terug op P50, en die is exact de klassieke mediaan.
    if (v && v.p50 != null) medianen[st] = v.p50;
  });
  // De losse metingen gaan mee naar buiten: een boxplot heeft de punten zelf
  // nodig, niet alleen de samenvatting ervan.
  return { lopend, medianen, metingen, verdelingen, metingenPerStatus: afgerond };
}

// De norm per status: waartegen wordt "te lang" afgemeten?
//
// Twee bronnen, en welke het is doet er wezenlijk toe:
//
//  - een STREEFWAARDE die je zelf zet (Instellingen). Dat is een norm: staat er
//    "Onderzoek controleren: 1 dag", dan is twee dagen te lang, punt. Alles
//    erboven komt in de lijst.
//  - is die er niet, dan de GEMETEN MEDIAAN van die status. Die zegt niet wat
//    goed is, alleen wat gebruikelijk is — en per definitie staat de helft van
//    alles daarboven. Daarom pas melden vanaf twee keer de mediaan, en nooit
//    onder een week: anders is de lijst elke maandag half zo lang als de
//    voorraad en zegt 'ie niets meer.
//
// Dat verschil is precies waarom "Nieuw" en "Onderzoek controleren" standaard
// een streefwaarde hebben. Zou je die op de mediaan afmeten, dan wordt traag
// doorzetten vanzelf "normaal" en valt er nooit meer iets op — de maatstaf
// schuift dan mee met de sloppigheid die je juist wilt zien.
const STAGNATIE_MEDIAAN_RATIO = 2;   // zonder streefwaarde: pas vanaf 2x de mediaan
const STAGNATIE_MEDIAAN_MIN = 7;     // en nooit onder een week

function statusNormVan(status, medianen) {
  const streef = state.statusStreef ? state.statusStreef[status] : undefined;
  if (Number.isFinite(streef) && streef >= 0) {
    return { norm: streef, bron: 'streef', drempel: streef };
  }
  const mediaan = medianen[status];
  if (mediaan == null) return null;
  return {
    norm: mediaan,
    bron: 'mediaan',
    drempel: Math.max(mediaan * STAGNATIE_MEDIAAN_RATIO, STAGNATIE_MEDIAAN_MIN),
  };
}

// Alles wat nu open staat, met twee metingen naast elkaar:
//
//  - hoe lang het al in zijn HUIDIGE STATUS zit. Dat wijst de stap aan waar het
//    blijft hangen, dus waar je moet duwen.
//  - hoe lang het al in TOTAAL onderweg is. Dat is de norm die telt: 12 dagen
//    voor het hele traject. Een storing kan in elke afzonderlijke status binnen
//    zijn deel blijven en tóch te lang onderweg zijn — dat mis je als je alleen
//    per status kijkt.
//
// De totale duur wordt geteld vanaf de dag dat het ordernummer voor het eerst
// in een plakactie voorkwam (zoals "Open sinds" elders). Voor storingen die er
// al stonden toen je begon met meten is dat te kort; die tellen dus mild.
function buildTeLangInStatus() {
  const snaps = chronoSnapshots();
  const leeg = { rijen: [], perStatus: [], traject: null, gemeten: false };
  if (snaps.length < 2) return leeg;
  const latest = snaps[snaps.length - 1];
  const { lopend, medianen, metingen } = buildStatusDuurStats();
  const eerstGezien = firstSeenWeekMap();
  const trajectNorm = state.doorlooptijdNorm || DEFAULT_DOORLOOPTIJD_NORM;

  const rijen = [];
  const perStatus = OV_STATUS_ORDER.map(status => ({
    status,
    normInfo: statusNormVan(status, medianen),
    metingen: metingen[status] || 0,
    aantal: 0,
    teLang: 0,
    langste: 0,
  }));
  const bijStatus = new Map(perStatus.map(p => [p.status, p]));
  const traject = { norm: trajectNorm, aantal: 0, teLang: 0, langste: 0 };

  filterByActive(typeFiltered(latest.storingen)).forEach(s => {
    const cur = lopend[s.order];
    if (!cur || !s.ovStatus) return;
    const dagen = dagenTussen(cur.sinds, latest.week);
    if (dagen < 0) return;
    const vak = bijStatus.get(s.ovStatus);
    if (vak) { vak.aantal++; vak.langste = Math.max(vak.langste, dagen); }

    const eerste = eerstGezien[s.order];
    const trajectDagen = eerste ? Math.max(dagenTussen(eerste, latest.week), dagen) : dagen;
    traject.aantal++;
    traject.langste = Math.max(traject.langste, trajectDagen);
    const teLangTraject = trajectDagen > trajectNorm;
    if (teLangTraject) traject.teLang++;

    const normInfo = statusNormVan(s.ovStatus, medianen);
    const teLangStatus = !!normInfo && dagen > normInfo.drempel;
    if (teLangStatus && vak) vak.teLang++;
    if (!teLangStatus && !teLangTraject) return;

    rijen.push({
      order: s.order,
      plaats: s.city || 'Onbekend',
      gebiedscode: s.gebiedscode || '—',
      ovStatus: s.ovStatus,
      sinds: cur.sinds,
      dagen,
      traject: trajectDagen,
      trajectOver: trajectDagen - trajectNorm,
      teLangStatus,
      teLangTraject,
      norm: normInfo ? normInfo.norm : null,
      bron: normInfo ? normInfo.bron : null,
      over: normInfo ? dagen - normInfo.norm : 0,
      // Bij een streefwaarde van 0 dagen is delen zinloos; dan is de
      // overschrijding in dagen het enige zinnige getal.
      ratio: normInfo && normInfo.norm > 0 ? dagen / normInfo.norm : null,
      geblokkeerd: isOvBlocked(s),
      daysLeft: typeof s.daysLeft === 'number' ? s.daysLeft : null,
      storing: s,
    });
  });

  return { rijen, perStatus, traject, gemeten: true };
}

// "Norm" toont er meteen bij wáár die vandaan komt. Zonder dat verschil kun je
// het getal niet lezen: 1 dag als streefwaarde is een afspraak, 12 dagen als
// mediaan is alleen een constatering dat het meestal zo lang duurt.
function normCelHtml(r) {
  if (r.norm == null) return '<td class="num muted">—</td>';
  const waarde = Math.round(r.norm * 10) / 10;
  const label = r.bron === 'streef' ? 'streef' : 'P50';
  return `<td class="num">${waarde} dgn <span class="muted small">${label}</span></td>`;
}

const STAGNATIE_COLUMNS = [
  { key: 'order', label: 'Order', cell: r => `<td>${orderLinkHtml(r.order)}</td>` },
  { key: 'plaats', label: 'Plaats', cell: r => `<td>${esc(r.plaats)}</td>` },
  { key: 'gebiedscode', label: 'Gebied', cell: r => `<td>${esc(r.gebiedscode)}</td>` },
  { key: 'ovStatus', label: 'Status', cell: r => `<td>${esc(r.ovStatus)}</td>` },
  { key: 'dagen', label: 'Dagen in status', num: true, cell: r => `<td class="num${r.teLangStatus ? ' prognose-bad' : ''}"><strong>${r.dagen}</strong></td>` },
  { key: 'norm', label: 'Norm status', num: true, cell: normCelHtml },
  { key: 'over', label: 'Te lang in status', num: true, cell: r => `<td class="num">${r.teLangStatus ? `<span class="prognose-bad">+${Math.round(r.over)}</span>` : '<span class="muted">binnen norm</span>'}</td>` },
  // Het traject is de norm die er echt toe doet; die staat daarom naast de
  // status-kolommen en niet ergens achteraan.
  { key: 'traject', label: 'Traject totaal', num: true, cell: r => `<td class="num${r.teLangTraject ? ' prognose-bad' : ''}"><strong>${r.traject}</strong></td>` },
  { key: 'trajectOver', label: 'Te lang traject', num: true, cell: r => `<td class="num">${r.teLangTraject ? `<span class="prognose-bad">+${r.trajectOver}</span>` : '<span class="muted">binnen norm</span>'}</td>` },
  { key: 'daysLeft', label: 'Deadline', num: true, cell: r => `<td class="num">${r.daysLeft == null ? '—' : renderDaysPill(r.storing)}</td>` },
  { key: 'geblokkeerd', label: 'Geblokkeerd', cell: r => `<td>${r.geblokkeerd ? '🚧 ja' : '—'}</td>` },
];

// Waar hoopt het werk zich op? Het stagnatiesignaal wijst individuele
// storingen aan; deze kaart kijkt naar de stap in het proces. Twee getallen
// die iets anders zeggen:
//  - P50/P90: hoe lang een storing normaal in die status blijft, en hoe ver
//    de staart daarboven uitloopt;
//  - opgehoopt: alle wachttijd van wie er nu in zit, bij elkaar opgeteld.
// Een status kan een korte P50 hebben en toch de grootste ophoping zijn
// (veel storingen), of andersom (weinig storingen die er heel lang liggen).
// Alleen op de mediaan sturen zou dat eerste geval missen.
function buildDoorstroomStats() {
  const snaps = chronoSnapshots();
  if (snaps.length === 0) return [];
  const latest = snaps[snaps.length - 1];
  const { lopend, verdelingen, medianen } = buildStatusDuurStats();
  const huidig = filterByActive(typeFiltered(latest.storingen));

  return OV_STATUS_ORDER.map(status => {
    const inStatus = huidig.filter(s => s.ovStatus === status);
    const wachttijden = inStatus.map(s => {
      const cur = lopend[s.order];
      return cur ? dagenTussen(cur.sinds, latest.week) : 0;
    });
    const v = verdelingen[status] || null;
    const normInfo = statusNormVan(status, medianen);
    return {
      status,
      aantal: inStatus.length,
      verdeling: v,
      norm: normInfo ? normInfo.norm : null,
      normBron: normInfo ? normInfo.bron : null,
      p50: v ? v.p50 : null,
      p90: v ? v.p90 : null,
      metingen: v ? v.n : 0,
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

  // Alle spreidingsbalken op dezelfde schaal, anders lijkt een status met een
  // korte staart net zo scheef als een met een lange.
  const schaal = Math.max(1, ...rijen.map(r => (r.verdeling ? r.verdeling.p90 || r.verdeling.p50 || 0 : 0)), ...rijen.map(r => r.norm || 0));

  const body = rijen.map(r => `<tr>
      <td>${esc(r.status)}</td>
      <td class="num">${r.aantal}</td>
      <td class="num">${dagenAfgerond(r.p50)}</td>
      <td class="num">${dagenAfgerond(r.p90)}</td>
      <td>${spreidingBalkHtml(r, schaal)}</td>
      <td class="num">${r.opgehoopt}</td>
      <td class="num">${r.langste || '—'}</td>
    </tr>`).join('');

  const scheef = rijen.filter(r => r.p50 != null && r.p90 != null && r.p50 > 0 && r.p90 / r.p50 >= STAART_RATIO)
    .sort((a, b) => (b.p90 / b.p50) - (a.p90 / a.p50))[0];
  const staart = scheef
    ? `<p class="prognose-headline">Bij <strong>${esc(scheef.status)}</strong> zit het verschil vooral in de staart: de helft is er binnen ${dagenAfgerond(scheef.p50)} doorheen, maar één op de tien doet er ${dagenAfgerond(scheef.p90)} of langer over.</p>`
    : '';

  container.innerHTML = `${kop}${staart}
    <div class="table-scroll">
      <table>
        <thead><tr>
          <th>Status</th><th class="num">Nu in deze status</th><th class="num">P50</th><th class="num">P90</th>
          <th class="spreiding-kop">Spreiding <span class="muted small">(P50 · P90 · norm)</span></th>
          <th class="num">Opgehoopt</th><th class="num">Langst wachtend</th>
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted small">P50 is hoe lang een storing normaal in die status blijft: de helft is er sneller doorheen. P90 is de staart: negen van de tien blijven eronder. Staan die twee ver uit elkaar, dan zit het probleem bij een paar gevallen en niet bij de hele bak — dat is precies wat een gemiddelde onzichtbaar maakt. P50 vanaf ${MIN_METINGEN_P50} afgeronde metingen, P90 vanaf ${MIN_METINGEN_P90}. "Opgehoopt" is alle wachttijd van de storingen die nu in die status staan bij elkaar opgeteld, in dagen.</p>`;
}

// De verdeling als balkje: massief tot P50, lichter tot P90, met een streepje
// op de norm. Zo zie je in één blik of de norm ergens tussen P50 en P90 ligt
// (dan haalt een deel het niet) of voorbij P90 (dan is het echt uitzondering).
function spreidingBalkHtml(r, schaal) {
  const v = r.verdeling;
  if (!v || v.p50 == null) return '<span class="muted small">te weinig metingen</span>';
  const pct = (waarde) => Math.max(0, Math.min(100, (waarde / schaal) * 100));
  const p50Pct = pct(v.p50);
  const p90Pct = v.p90 == null ? p50Pct : pct(v.p90);
  const normMerk = r.norm != null
    ? `<span class="spreiding-norm" style="left:${pct(r.norm)}%" title="Norm ${dagenAfgerond(r.norm)}"></span>`
    : '';
  const titel = `P50 ${dagenAfgerond(v.p50)}${v.p90 == null ? '' : ` · P90 ${dagenAfgerond(v.p90)}`} · langste ${dagenAfgerond(v.max)} · ${v.n} metingen`;
  return `<div class="spreiding-balk" title="${esc(titel)}">
      <span class="spreiding-staart" style="width:${p90Pct}%"></span>
      <span class="spreiding-kern" style="width:${p50Pct}%"></span>
      ${normMerk}
    </div>`;
}

// Boven de lijst een vak per norm: het hele traject voorop, daarna elke status.
// Elk vak zegt hoeveel er in staan, hoeveel daarvan te lang, en waartegen dat
// is afgemeten — en is een knop die de tabel eronder daarop filtert. Zonder die
// vakken is de lijst een hoop ordernummers; mét die vakken weet je eerst of het
// aan één storing ligt of aan de hele stap, en klik je daarna pas door.
function normVakHtml(opts) {
  const actief = state.stagnatieFilter === opts.filter;
  const klassen = ['norm-vak'];
  if (opts.alarm) klassen.push('norm-vak-alarm');
  if (actief) klassen.push('norm-vak-actief');
  if (opts.breed) klassen.push('norm-vak-breed');
  return `<button type="button" class="${klassen.join(' ')}" data-stagnatie-filter="${esc(opts.filter)}"
      aria-pressed="${actief}" title="${actief ? 'Klik om het filter weer weg te halen' : 'Klik om alleen deze te tonen'}">
    <span class="norm-status">${esc(opts.titel)}</span>
    <span class="norm-cijfer ${opts.cijferKlasse || ''}">${opts.cijfer}</span>
    <span class="muted small">${opts.onder}</span>
  </button>`;
}

function normBalkHtml(perStatus, traject) {
  const vakken = [];
  if (traject && traject.aantal > 0) {
    vakken.push(normVakHtml({
      filter: 'traject',
      breed: true,
      alarm: traject.teLang > 0,
      titel: '🎯 Hele traject',
      cijfer: `<strong>${traject.teLang}</strong> van ${traject.aantal} te lang`,
      cijferKlasse: traject.teLang > 0 ? 'prognose-bad' : 'prognose-good',
      onder: `norm ${traject.norm} dagen van melding tot afsluiting · langst onderweg ${traject.langste} dgn`,
    }));
  }
  perStatus.filter(p => p.aantal > 0).forEach(p => {
    if (!p.normInfo) {
      vakken.push(normVakHtml({
        filter: p.status,
        titel: p.status,
        cijfer: `${p.aantal} open`,
        cijferKlasse: 'muted',
        onder: `nog geen norm — ${p.metingen} meting${p.metingen === 1 ? '' : 'en'}, er zijn er 3 nodig.${isStaticExport ? '' : ' Zet er zelf een streefwaarde voor in Instellingen.'}`,
      }));
      return;
    }
    const norm = Math.round(p.normInfo.norm * 10) / 10;
    const bronTekst = p.normInfo.bron === 'streef'
      ? `streefwaarde ${norm} ${norm === 1 ? 'dag' : 'dagen'}`
      : `P50 ${norm} ${norm === 1 ? 'dag' : 'dagen'} · melden vanaf ${Math.round(p.normInfo.drempel)}`;
    vakken.push(normVakHtml({
      filter: p.status,
      alarm: p.teLang > 0,
      titel: p.status,
      cijfer: `<strong>${p.teLang}</strong> van ${p.aantal} te lang`,
      cijferKlasse: p.teLang > 0 ? 'prognose-bad' : 'prognose-good',
      onder: `${esc(bronTekst)} · langst wachtend ${p.langste} dgn`,
    }));
  });
  if (vakken.length === 0) return '';
  return `<div class="norm-balk">${vakken.join('')}</div>`;
}

// Welke regels horen bij het actieve vak? Bij "hele traject" alles wat over de
// 12 dagen heen is; bij een status alleen wat in díé status te lang staat.
function stagnatieGefilterd(rijen) {
  const f = state.stagnatieFilter;
  if (!f) return rijen;
  if (f === 'traject') return rijen.filter(r => r.teLangTraject);
  return rijen.filter(r => r.ovStatus === f && r.teLangStatus);
}

function renderStagnatieCard() {
  const container = document.getElementById('stagnatie-body');
  if (!container) return;
  const { rijen, perStatus, traject, gemeten } = buildTeLangInStatus();
  if (!gemeten) {
    container.innerHTML = '<p class="empty-note">Er zijn minstens twee meetdagen nodig om te kunnen zien hoe lang iets ergens staat. Plak de lijst een tweede dag; daarna vult dit zich vanzelf.</p>';
    return;
  }

  const balk = normBalkHtml(perStatus, traject);
  const zichtbaar = stagnatieGefilterd(rijen);

  if (zichtbaar.length === 0) {
    const uitleg = state.stagnatieFilter
      ? `Niets te lang bij "${state.stagnatieFilter === 'traject' ? 'Hele traject' : state.stagnatieFilter}". Klik het vak nog eens aan om alles weer te zien.`
      // In de gedeelde export heeft de lezer geen Instellingen-tab; daar naar
      // verwijzen is dan een doodlopend spoor.
      : (isStaticExport
          ? 'Alles blijft binnen de norm — zowel per status als over het hele traject.'
          : 'Alles blijft binnen de norm — zowel per status als over het hele traject. Klopt dat niet met wat je ziet? Stel de normen bij in Instellingen.');
    container.innerHTML = balk + `<p class="empty-note">${esc(uitleg)}</p>`;
    return;
  }

  const overTraject = zichtbaar.filter(r => r.teLangTraject).length;
  const overStatus = zichtbaar.filter(r => r.teLangStatus).length;
  const kop = state.stagnatieFilter
    ? `<p class="prognose-headline">Gefilterd op <strong>${esc(state.stagnatieFilter === 'traject' ? 'Hele traject' : state.stagnatieFilter)}</strong>: ${zichtbaar.length} storing${zichtbaar.length === 1 ? '' : 'en'}. <button type="button" class="btn-link" data-stagnatie-filter="">Toon alles</button></p>`
    : `<p class="prognose-headline"><strong>${zichtbaar.length}</strong> ${zichtbaar.length === 1 ? 'storing zit' : 'storingen zitten'} boven een norm: <strong class="prognose-bad">${overTraject}</strong> langer dan ${traject.norm} dagen onderweg, <strong>${overStatus}</strong> te lang in hun huidige status.</p>`;

  const sorted = sortByState(zichtbaar, state.stagnatieSortState);
  const tabel = document.createElement('div');
  renderFullTable(tabel, sorted, STAGNATIE_COLUMNS, state.stagnatieSortState);
  container.innerHTML = balk + kop + `<div class="table-scroll">${tabel.innerHTML}</div>`;
}

/* ---------- Boxplot: de verdeling per stap ---------- */

// P50 en P90 zijn twee punten uit een verdeling; een boxplot is de verdeling
// zelf. Je ziet in één beeld waar het gros zit (de box), of dat scheef ligt
// (de streep zit niet in het midden), hoe ver het normale bereik loopt (de
// whiskers) en welke losse gevallen daarbuiten vallen (de punten). Precies het
// verschil tussen "het duurt hier lang" en "het duurt hier kort, op drie
// gevallen na" — en dat is een ander gesprek in het overleg.
//
// Alle afgeronde metingen tellen mee, en ze komen uit dezelfde bron als de
// getallen in de tabel erboven (buildStatusDuurStats), dus bij elke nieuwe
// plakactie schuift de plot mee zonder dat er iets bijgehouden hoeft te worden.
const MIN_METINGEN_BOX = 5;

// Whiskers volgens Tukey: tot de verste meting binnen anderhalve box-breedte.
// Wat daarbuiten ligt is geen meetfout maar een uitschieter, en die hoort
// zichtbaar te blijven als los punt — hem in de whisker meetrekken zou precies
// het beeld geven waar je vanaf wilde.
function boxplotVan(waarden) {
  if (!waarden || waarden.length < MIN_METINGEN_BOX) return null;
  const a = waarden.slice().sort((x, y) => x - y);
  const q1 = percentiel(a, 0.25);
  const mediaan = percentiel(a, 0.5);
  const q3 = percentiel(a, 0.75);
  const iqr = q3 - q1;
  const grensLaag = q1 - 1.5 * iqr;
  const grensHoog = q3 + 1.5 * iqr;
  const binnen = a.filter(x => x >= grensLaag && x <= grensHoog);
  return {
    n: a.length,
    q1, mediaan, q3,
    laag: binnen.length ? binnen[0] : a[0],
    hoog: binnen.length ? binnen[binnen.length - 1] : a[a.length - 1],
    uitschieters: a.filter(x => x < grensLaag || x > grensHoog),
    min: a[0],
    max: a[a.length - 1],
  };
}

function buildBoxplotRijen() {
  const { metingenPerStatus } = buildStatusDuurStats();
  return OV_STATUS_ORDER.map(status => {
    const waarden = (metingenPerStatus && metingenPerStatus[status]) || [];
    return { key: status, label: status, waarden, box: boxplotVan(waarden) };
  });
}

// Waar houdt de as op? Eén meting van zestig dagen naast negen van twee drukt
// alle boxen tot een streepje plat — dat is eerlijk en onleesbaar tegelijk.
// Vandaar de keuze: standaard tot het normale bereik (de whiskers), met de
// uitschieters daarbuiten als gemerkte punten op de rand zodat er niets
// stilletjes wegvalt, of de volledige schaal als je die wél wilt zien.
function boxplotAsMax(rijen, schaal) {
  let max = 1;
  rijen.forEach(r => {
    if (!r.box) return;
    max = Math.max(max, schaal === 'alles' ? r.box.max : r.box.hoog);
  });
  const ruim = max * 1.08;
  // Ronde stappen: onder de 10 per 1, daarboven per 5, 10 of 50.
  const stap = ruim <= 10 ? 1 : ruim <= 50 ? 5 : ruim <= 200 ? 10 : 50;
  return { max: Math.ceil(ruim / stap) * stap, stap };
}

// Staande boxen: dagen omhoog, de zes statussen naast elkaar in de volgorde
// van het werkproces. Dat leest als een tijdlijn van links naar rechts — je
// ziet meteen bij welke stap de boxen omhoog lopen — en de as heet gewoon
// "dagen", wat bij een liggende plot altijd even omdenken blijft.
const BOX_BREEDTE = 900;
const BOX_HOOGTE = 340;
const BOX_MARGE = { boven: 14, rechts: 16, onder: 52, links: 54 };
const BOX_MAX_BREEDTE = 64;

function renderBoxplotCard() {
  const container = document.getElementById('boxplot-body');
  if (!container) return;
  document.querySelectorAll('#boxplot-schaal button[data-boxplot-schaal]').forEach(b => {
    b.classList.toggle('active', b.dataset.boxplotSchaal === state.boxplotSchaal);
  });
  const knop = document.querySelector('.toggle-table[data-target="boxplot"]');
  if (knop) knop.textContent = state.boxplotViewMode === 'chart' ? 'Toon als tabel' : 'Toon als grafiek';

  const rijen = buildBoxplotRijen();
  if (rijen.every(r => !r.box)) {
    const meeste = Math.max(0, ...rijen.map(r => r.waarden.length));
    container.innerHTML = `<p class="empty-note">Nog te weinig afgeronde metingen voor een verdeling: er zijn er ${MIN_METINGEN_BOX} per stap nodig en de verste staat nu op ${meeste}. Elke keer dat een storing doorstroomt komt er een meting bij; deze plot vult zich vanzelf.</p>`;
    return;
  }
  container.innerHTML = state.boxplotViewMode === 'table'
    ? boxplotTabelHtml(rijen)
    : boxplotSvgHtml(rijen) + boxplotLegendaHtml() + boxplotNoteHtml(rijen);
}

function boxplotNoteHtml(rijen) {
  const zonder = rijen.filter(r => !r.box && r.waarden.length > 0);
  const leeg = rijen.filter(r => r.waarden.length === 0);
  const delen = [];
  if (zonder.length) delen.push(`${zonder.map(r => esc(r.label)).join(', ')} ${zonder.length === 1 ? 'heeft' : 'hebben'} nog minder dan ${MIN_METINGEN_BOX} afgeronde metingen — daar staan de losse punten getekend zonder box.`);
  if (leeg.length) delen.push(`${leeg.map(r => esc(r.label)).join(', ')} ${leeg.length === 1 ? 'heeft' : 'hebben'} nog geen enkele afgeronde meting.`);
  delen.push('Een meting ontstaat zodra een storing van status wisselt, dus de plot wordt vanzelf scherper naarmate je langer meet.');
  return `<p class="muted small">${delen.join(' ')}</p>`;
}

function boxplotLegendaHtml() {
  return `<div class="box-legenda">
    <span class="box-legenda-item"><svg width="18" height="30" aria-hidden="true"><rect x="2" y="6" width="14" height="18" rx="3" class="box-vlak"></rect><line x1="2" y1="15" x2="16" y2="15" class="box-mediaan"></line></svg> box = de middelste helft (P25–P75), streep = P50</span>
    <span class="box-legenda-item"><svg width="18" height="30" aria-hidden="true"><line x1="9" y1="3" x2="9" y2="27" class="box-whisker"></line><line x1="4" y1="3" x2="14" y2="3" class="box-whisker"></line><line x1="4" y1="27" x2="14" y2="27" class="box-whisker"></line></svg> normale bereik</span>
    <span class="box-legenda-item"><svg width="18" height="30" aria-hidden="true"><circle cx="9" cy="15" r="4" class="box-punt"></circle></svg> uitschieter</span>
  </div>`;
}

function boxplotSvgHtml(rijen) {
  const { max, stap } = boxplotAsMax(rijen, state.boxplotSchaal);
  const plotB = BOX_BREEDTE - BOX_MARGE.links - BOX_MARGE.rechts;
  const plotH = BOX_HOOGTE - BOX_MARGE.boven - BOX_MARGE.onder;
  const bodem = BOX_MARGE.boven + plotH;
  // Nul onderaan, meer dagen omhoog: hoger is langer, zoals je het leest.
  const y = (waarde) => bodem - Math.min(plotH, (waarde / max) * plotH);
  const bandB = plotB / rijen.length;
  const boxB = Math.min(BOX_MAX_BREEDTE, bandB * 0.44);
  const midden = (i) => BOX_MARGE.links + bandB * (i + 0.5);

  let grid = '';
  for (let v = 0; v <= max + 0.001; v += stap) {
    const py = y(v);
    grid += `<line x1="${BOX_MARGE.links}" y1="${py}" x2="${BOX_MARGE.links + plotB}" y2="${py}" class="box-grid"></line>`
      + `<text x="${BOX_MARGE.links - 10}" y="${py + 4}" class="box-as-label" text-anchor="end">${v}</text>`;
  }

  const kolommen = rijen.map((r, i) => {
    const cx = midden(i);
    const x1 = cx - boxB / 2;
    // Statusnamen zijn te lang om naast elkaar te passen; over twee regels
    // afbreken op de spatie leest beter dan schuin zetten.
    const woorden = r.label.split(' ');
    const regel1 = woorden.length > 1 ? woorden[0] : r.label;
    const regel2 = woorden.length > 1 ? woorden.slice(1).join(' ') : '';
    const leeg = r.waarden.length === 0;
    const label = `<text x="${cx}" y="${bodem + 20}" text-anchor="middle" class="box-kolom-label${leeg ? ' box-kolom-label-leeg' : ''}">${esc(regel1)}</text>`
      + (regel2 ? `<text x="${cx}" y="${bodem + 32}" text-anchor="middle" class="box-kolom-label${leeg ? ' box-kolom-label-leeg' : ''}">${esc(regel2)}</text>` : '')
      + (leeg ? '' : `<text x="${cx}" y="${bodem + (regel2 ? 44 : 32)}" text-anchor="middle" class="box-kolom-n">n=${r.waarden.length}</text>`);

    if (!r.box) {
      // Te weinig voor een box: alleen de losse metingen als punten, zodat je
      // ziet dát er iets gemeten is. Welke stappen nog leeg zijn staat onder
      // de plot; dat hoeft niet ook nog dwars door het vlak.
      const punten = r.waarden.map(w => `<circle cx="${cx}" cy="${y(w)}" r="3.5" class="box-punt box-punt-los"></circle>`).join('');
      const tekst = leeg ? 'nog geen afgeronde metingen' : `${r.waarden.length} van de ${MIN_METINGEN_BOX} metingen die een box nodig heeft`;
      return `<g class="box-rij"><title>${esc(r.label)} — ${tekst}</title>${label}${punten}</g>`;
    }

    const b = r.box;
    const boxTop = y(b.q3);
    const boxH = Math.max(2, y(b.q1) - y(b.q3));
    const buiten = b.uitschieters.filter(w => w > max);
    const binnenBeeld = b.uitschieters.filter(w => w <= max);
    const randMerk = buiten.length
      ? `<text x="${cx}" y="${BOX_MARGE.boven - 2}" text-anchor="middle" class="box-buiten-label"><title>${buiten.length} uitschieter${buiten.length === 1 ? '' : 's'} vallen buiten deze schaal, tot ${dagenAfgerond(b.max)} — kies "Inclusief uitschieters" om ze te zien</title>▲${buiten.length}</text>`
      : '';
    const titel = `${r.label} — ${b.n} metingen · P25 ${dagenAfgerond(b.q1)} · P50 ${dagenAfgerond(b.mediaan)} · P75 ${dagenAfgerond(b.q3)} · bereik ${dagenAfgerond(b.laag)}–${dagenAfgerond(b.hoog)}`
      + (b.uitschieters.length ? ` · ${b.uitschieters.length} uitschieter${b.uitschieters.length === 1 ? '' : 's'} tot ${dagenAfgerond(b.max)}` : '');

    return `<g class="box-rij"><title>${esc(titel)}</title>
      ${label}
      <line x1="${cx}" y1="${y(b.hoog)}" x2="${cx}" y2="${y(b.laag)}" class="box-whisker"></line>
      <line x1="${cx - boxB / 4}" y1="${y(b.hoog)}" x2="${cx + boxB / 4}" y2="${y(b.hoog)}" class="box-whisker"></line>
      <line x1="${cx - boxB / 4}" y1="${y(b.laag)}" x2="${cx + boxB / 4}" y2="${y(b.laag)}" class="box-whisker"></line>
      <rect x="${x1}" y="${boxTop}" width="${boxB}" height="${boxH}" rx="4" class="box-vlak"></rect>
      <line x1="${x1}" y1="${y(b.mediaan)}" x2="${x1 + boxB}" y2="${y(b.mediaan)}" class="box-mediaan"></line>
      ${binnenBeeld.map(w => `<circle cx="${cx}" cy="${y(w)}" r="4" class="box-punt"></circle>`).join('')}
      ${randMerk}
    </g>`;
  }).join('');

  return `<div class="box-scroll"><svg class="chart-svg boxplot-svg" viewBox="0 0 ${BOX_BREEDTE} ${BOX_HOOGTE}"
      style="width:100%;min-width:640px;height:${BOX_HOOGTE}px" role="img"
      aria-label="Boxplot van de doorlooptijd per status, in dagen">
    ${grid}
    <text x="14" y="${BOX_MARGE.boven + plotH / 2}" class="box-as-titel" text-anchor="middle"
          transform="rotate(-90 14 ${BOX_MARGE.boven + plotH / 2})">dagen</text>
    ${kolommen}
  </svg></div>`;
}

function boxplotTabelHtml(rijen) {
  const body = rijen.map(r => {
    if (!r.box) {
      return `<tr><td>${esc(r.label)}</td><td class="num">${r.waarden.length}</td>
        <td class="num muted" colspan="6">te weinig metingen (${MIN_METINGEN_BOX} nodig)</td></tr>`;
    }
    const b = r.box;
    return `<tr>
      <td>${esc(r.label)}</td>
      <td class="num">${b.n}</td>
      <td class="num">${dagenAfgerond(b.min)}</td>
      <td class="num">${dagenAfgerond(b.q1)}</td>
      <td class="num"><strong>${dagenAfgerond(b.mediaan)}</strong></td>
      <td class="num">${dagenAfgerond(b.q3)}</td>
      <td class="num">${dagenAfgerond(b.laag)}–${dagenAfgerond(b.hoog)}</td>
      <td class="num">${b.uitschieters.length === 0 ? '—' : `${b.uitschieters.length} tot ${dagenAfgerond(b.max)}`}</td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll"><table>
    <thead><tr>
      <th>Status</th><th class="num">Metingen</th><th class="num">Kortste</th><th class="num">P25</th>
      <th class="num">P50</th><th class="num">P75</th><th class="num">Normale bereik</th>
      <th class="num">Uitschieters</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// De regiotabs staan op de Data-tab, maar filteren ook alles op Prognose:
// doorlooptijden, verdeling, wat te lang onderweg is. Dat is bruikbaar — zo
// vergelijk je Leiden met Haarlem — maar het was onzichtbaar, en dan lijkt het
// alsof de cijfers zomaar veranderen. Nu staat erbij waar je naar kijkt.
function renderFilterNotitie() {
  const el = document.getElementById('prognose-filter-notitie');
  if (!el) return;
  const actief = state.activeFilter && state.activeFilter !== 'Totaal';
  el.classList.toggle('hidden', !actief);
  if (actief) {
    el.innerHTML = `Alles op deze pagina is gefilterd op <strong>${esc(regioGroupLabel(state.activeFilter))}</strong>, `
      + `volgens de regiokeuze op de Data-pagina. <button type="button" class="btn-link" id="prognose-filter-uit">Toon alle regio's</button>`;
    const knop = document.getElementById('prognose-filter-uit');
    if (knop) knop.addEventListener('click', () => { state.activeFilter = 'Totaal'; renderDashboardFromState(); });
  }
}

function renderPrognose(current) {
  renderFilterNotitie();
  renderTempoCard();
  renderDoorstroomCard();
  renderBoxplotCard();
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
// alles=true neemt óók de regels mee die nergens meetellen: klantaanvragen,
// types buiten het type-filter, en LS storing/schade zonder markering. Voor een
// telling zou dat fout zijn, maar de historie is geen telling — die moet de
// vraag "wat weten we over dit ordernummer" kunnen beantwoorden. Zonder deze
// optie was een geplakte regel die buiten het filter viel nergens meer terug te
// vinden, terwijl de gegevens gewoon bewaard waren.
function buildOrderIndex(alles) {
  const snaps = chronoSnapshots();
  const index = new Map();
  const kies = alles ? (lijst => lijst) : typeFiltered;
  snaps.forEach(sn => {
    const aanwezig = new Set();
    kies(sn.storingen).forEach(s => {
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
      // Telt deze regel mee in de werkvoorraad? In de historie staan ook
      // regels die dat niet doen (klantaanvraag, type buiten het filter, LS
      // zonder markering); die moeten vindbaar zijn, maar wel herkenbaar.
      telt: telAlsStoring(e.record),
      soort: e.record.soort || 'storing',
      looptijd: dagenTussen(e.eerst, open ? e.laatstGezien : e.opgelostOp),
    };
  });
}

// Waarom telt een regel niet mee? Precies benoemen is hier het punt: "staat er
// wel, telt niet mee" zonder reden zou net zo verwarrend zijn als hem weglaten.
function nietGeteldReden(r) {
  if (r.soort === 'klantaanvraag') return 'klantaanvraag';
  if (!state.typeWhitelist.includes(r.type)) return 'type buiten het filter';
  return 'telt niet mee';
}

const HISTORIE_COLUMNS = [
  { key: 'order', label: 'Order', cell: r => `<td>${orderLinkHtml(r.order)}${r.telt ? '' : ` <span class="badge badge-niet-geteld" title="Staat wel in de opgeslagen gegevens, maar telt niet mee in de werkvoorraad">${esc(nietGeteldReden(r))}</span>`}</td>` },
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

  const alle = buildOrderIndex(true);
  if (summary) {
    const opgelost = alle.filter(r => !r.open).length;
    const nietGeteld = alle.filter(r => !r.telt).length;
    summary.textContent = alle.length === 0
      ? ''
      : `${alle.length} regels in de historie, waarvan ${opgelost} opgelost en ${alle.length - opgelost} nu open.`
        + (nietGeteld ? ` Hiervan tellen er ${nietGeteld} niet mee in de werkvoorraad; die staan er met de reden bij.` : '');
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
    <td>${isMastGeenSpanning(s) ? '<span class="badge">mast geen spanning</span>' : esc(s.type)}</td>
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

// Eén invoerveld per status, met de gemeten mediaan als grijze hint ernaast.
// Die hint is het punt van deze kaart: je zet een streefwaarde pas zinnig als
// je weet wat het nu doet.
function renderStatusStreefCard() {
  const el = document.getElementById('status-streef-body');
  if (!el) return;
  const { verdelingen } = state.snapshots.length > 0
    ? buildStatusDuurStats()
    : { verdelingen: {} };
  el.innerHTML = OV_STATUS_ORDER.map((status, i) => {
    const waarde = state.statusStreef[status];
    const v = verdelingen[status] || null;
    const aantal = v ? v.n : 0;
    // P50 en P90 naast elkaar, zodat je een streefwaarde niet alleen op de
    // gewone gang van zaken zet maar ook ziet hoe ver de staart uitloopt.
    const hint = v && v.p50 != null
      ? `nu gemeten: P50 ${dagenAfgerond(v.p50)} · P90 ${v.p90 == null ? `nog niet (${aantal} van de ${MIN_METINGEN_P90} metingen)` : dagenAfgerond(v.p90)} · langste ${dagenAfgerond(v.max)} (${aantal} metingen)`
      : `nog niets gemeten (${aantal} van de ${MIN_METINGEN_P50} metingen)`;
    return `<div class="input-row streef-rij">
      <label for="streef-${i}">${esc(status)}</label>
      <input type="number" id="streef-${i}" data-streef-status="${esc(status)}" min="0" max="365" step="1"
             inputmode="numeric" placeholder="—" value="${Number.isFinite(waarde) ? waarde : ''}" style="width:80px;">
      <span class="muted small">dagen · ${esc(hint)}</span>
    </div>`;
  }).join('');

  const norm = document.getElementById('doorlooptijd-norm-input');
  if (norm && document.activeElement !== norm) norm.value = state.doorlooptijdNorm;
  // De gemeten waarden hiernaast volgen de regiokeuze op de Data-pagina; zonder
  // die vermelding lijkt het alsof er metingen ontbreken.
  const notitie = document.getElementById('status-streef-filter');
  if (notitie) {
    const actief = state.activeFilter && state.activeFilter !== 'Totaal';
    notitie.classList.toggle('hidden', !actief);
    if (actief) notitie.textContent = `Let op: de gemeten waarden hiernaast gaan alleen over ${regioGroupLabel(state.activeFilter)}, volgens de regiokeuze op de Data-pagina.`;
  }
  toonStreefSom();
}

// De optelsom is de hele reden dat deze twee instellingen op één kaart staan:
// zes streefwaarden die samen boven de trajectnorm uitkomen zijn onderling
// consistent maar als geheel onhaalbaar, en dat zie je alleen als het bij
// elkaar wordt opgeteld.
function toonStreefSom() {
  const el = document.getElementById('status-streef-som');
  if (!el) return;
  const velden = Array.from(document.querySelectorAll('#status-streef-body input[data-streef-status]'));
  const ingevuld = velden.map(i => parseInt(i.value, 10)).filter(n => Number.isFinite(n) && n >= 0);
  const normVeld = document.getElementById('doorlooptijd-norm-input');
  const trajectNorm = normVeld && Number.isFinite(parseInt(normVeld.value, 10))
    ? parseInt(normVeld.value, 10) : state.doorlooptijdNorm;
  const som = ingevuld.reduce((a, b) => a + b, 0);
  const leeg = velden.length - ingevuld.length;
  const staart = leeg > 0 ? ` (${leeg} status${leeg === 1 ? '' : 'sen'} zonder streefwaarde telt hier niet mee)` : '';
  el.className = 'muted small';
  if (som > trajectNorm) {
    el.className = 'small prognose-bad';
    el.textContent = `De statussen tellen op tot ${som} dagen, meer dan de ${trajectNorm} die het hele traject mag duren${staart}. Zo kan elke stap binnen zijn norm blijven terwijl het traject het niet haalt.`;
  } else {
    el.textContent = `De statussen tellen op tot ${som} van de ${trajectNorm} dagen${staart}.`;
  }
}

function renderFilterTabs(latestVisible) {
  const container = document.getElementById('filter-tabs');
  // Alleen de twee echte regio's als tab. "Overig" was in de praktijk het
  // restje zonder gebiedscode; die storingen zitten gewoon in Totaal, en waar
  // ze vandaan komen zie je aan de melding over onbekende gebiedscodes op de
  // Gebieden-pagina.
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
  renderStatusStreefCard();
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
  renderKlantaanvraagCard();
  renderGebiedPlaatsenCard();
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
    lines.push(`Status ${status}: ${count(OV_STATUS_FILTER_KEYS[status])}`);
  });
  lines.push(`Nog niet eerder gezien (écht nieuw): ${count('nieuwGezien')}`);
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
  state.statusStreef = await loadStatusStreef();
  state.doorlooptijdNorm = await loadDoorlooptijdNorm();
  if (state.snapshots.length > 0) renderDashboardFromState();
  else { setDashboardEmpty('dashboard', 'dashboard-empty', true); renderTypeWhitelist(); renderStatusStreefCard(); renderBackupReminder(); renderBackupStatus(); }
}

function wireEvents() {
  document.querySelectorAll('[data-goto-invoer]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab('invoer');
      const textarea = document.getElementById(btn.dataset.gotoInvoer);
      if (textarea) { textarea.scrollIntoView({ block: 'center' }); textarea.focus(); }
    });
  });

  // "De norm klopt niet" is de eerste gedachte bij een lijst die te lang of te
  // kort is. Vanuit de lijst moet je die dus kunnen bijstellen zonder eerst te
  // gaan zoeken waar dat ook alweer stond.
  document.querySelectorAll('[data-goto-normen]').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab('settings');
      const kaart = document.getElementById('status-streef-card');
      if (kaart) kaart.scrollIntoView({ block: 'center' });
      const veld = document.getElementById(btn.dataset.gotoNormen || 'doorlooptijd-norm-input');
      if (veld) veld.focus();
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
    // Eerste signaal: de tekst bestaat onmiskenbaar uit klantaanvragen terwijl
    // er iets anders gekozen staat. Bij een gemengde lijst valt de herkenning
    // terug op "nus" en is er niets zeker genoeg om over te waarschuwen.
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
    const delen = [`${storingen.length} regels verwerkt in "${LIJST_LABELS[lijst]}" voor week ${week}`];
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
        } else {
          const { storingen } = parseText(raw);
          state.lijstHerkend = storingen.length ? afleidenLijstSoort(storingen) : null;
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
      } else if (target === 'boxplot') {
        state.boxplotViewMode = state.boxplotViewMode === 'chart' ? 'table' : 'chart';
        renderBoxplotCard();
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
    // Een normvak aanklikken filtert de tabel; nog eens aanklikken haalt het
    // filter er weer af, zodat je er nooit in vast komt te zitten.
    const vak = e.target.closest('[data-stagnatie-filter]');
    if (vak) {
      const gekozen = vak.dataset.stagnatieFilter || null;
      state.stagnatieFilter = (gekozen && state.stagnatieFilter === gekozen) ? null : gekozen;
      renderStagnatieCard();
      return;
    }
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

  // Meetellen terwijl je typt: anders zie je pas na opslaan dat de zes
  // streefwaarden samen niet in het traject passen.
  document.getElementById('status-streef-card').addEventListener('input', e => {
    if (e.target.matches('input[data-streef-status], #doorlooptijd-norm-input')) toonStreefSom();
  });

  document.getElementById('status-streef-save-btn').addEventListener('click', async () => {
    const streef = {};
    document.querySelectorAll('#status-streef-body input[data-streef-status]').forEach(inp => {
      // Leeg laten is een keuze, geen fout: dan wordt er tegen de mediaan
      // afgemeten. Alleen ingevulde, geldige waarden worden bewaard.
      const v = parseInt(inp.value, 10);
      if (Number.isFinite(v) && v >= 0) streef[inp.dataset.streefStatus] = v;
    });
    const normVeld = document.getElementById('doorlooptijd-norm-input');
    const norm = parseInt(normVeld.value, 10);
    state.doorlooptijdNorm = Number.isFinite(norm) && norm > 0 ? norm : DEFAULT_DOORLOOPTIJD_NORM;
    normVeld.value = state.doorlooptijdNorm;
    state.statusStreef = streef;
    await saveStatusStreef(streef);
    await saveDoorlooptijdNorm(state.doorlooptijdNorm);
    const ingevuld = Object.keys(streef).length;
    document.getElementById('status-streef-status').textContent = ingevuld === 0
      ? `Opgeslagen — traject ${state.doorlooptijdNorm} dagen; per status wordt tegen de gemeten mediaan afgemeten.`
      : `Opgeslagen — traject ${state.doorlooptijdNorm} dagen, ${ingevuld} van de ${OV_STATUS_ORDER.length} statussen met een streefwaarde.`;
    if (state.snapshots.length > 0) renderDashboardFromState();
    else renderStatusStreefCard();
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
  document.querySelectorAll('#boxplot-schaal button[data-boxplot-schaal]').forEach(btn => {
    btn.addEventListener('click', () => { state.boxplotSchaal = btn.dataset.boxplotSchaal; renderBoxplotCard(); });
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
  state.bijnaVerlopenThreshold = STATIC_DATA.bijnaVerlopenThreshold || DEFAULT_BIJNA_VERLOPEN_THRESHOLD;
  state.statusStreef = schoonStatusStreef(STATIC_DATA.statusStreef);
  state.doorlooptijdNorm = Number.isFinite(STATIC_DATA.doorlooptijdNorm) && STATIC_DATA.doorlooptijdNorm > 0
    ? STATIC_DATA.doorlooptijdNorm : DEFAULT_DOORLOOPTIJD_NORM;

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
