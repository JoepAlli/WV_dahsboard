'use strict';

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
const ORDER_LABEL_RE = /^order:?$/i;
const ASSET_LABEL_RE = /^asset:?$/i;
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

  if (!lines[i] || !ASSET_LABEL_RE.test(lines[i])) throw new Error('Verwachtte "Asset:" label, kreeg: ' + lines[i]);
  i++;
  const asset = lines[i++];
  if (!asset) throw new Error('Assetnummer ontbreekt');
  let assetType = null;
  if (lines[i] && /^(MSR|LSKN|LSKOV)$/i.test(lines[i])) {
    assetType = lines[i++].toUpperCase();
  }

  const middleLines = [];
  const middleStart = i;
  while (i < lines.length && !ON_TIME_RE.test(lines[i]) && !OVERDUE_RE.test(lines[i])) {
    if (i - middleStart >= MAX_MIDDLE_LINES) {
      throw new Error(`Geen "Nog X dagen" / "X dagen verlopen" regel gevonden binnen ${MAX_MIDDLE_LINES} regels na order ${order}`);
    }
    middleLines.push(lines[i++]);
  }
  if (i >= lines.length) throw new Error(`Geen "Nog X dagen" / "X dagen verlopen" regel gevonden voor order ${order}`);
  let daysLeft, overdue;
  const mOn = lines[i].match(ON_TIME_RE);
  if (mOn) { daysLeft = parseInt(mOn[1], 10); overdue = false; }
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

/* ---------- Storage ---------- */

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

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { console.error(e); return []; }
}
function saveSnapshots(snaps) {
  snaps.sort((a, b) => a.week.localeCompare(b.week));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snaps));
  } catch (e) {
    throw new Error('Opslag van de browser zit vol. Verwijder een oudere week (onderaan de pagina) en probeer het opnieuw.');
  }
}

function loadTypeWhitelist() {
  try {
    const raw = localStorage.getItem(TYPE_WHITELIST_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_TYPE_WHITELIST.slice();
  } catch (e) { console.error(e); return DEFAULT_TYPE_WHITELIST.slice(); }
}
function saveTypeWhitelist(list) {
  try { localStorage.setItem(TYPE_WHITELIST_KEY, JSON.stringify(list)); }
  catch (e) { console.error(e); }
}

const TO_STORAGE_KEY = 'nusdash_snapshots_teonderzoeken_v1';
const MEETDIENST_LIST_KEY = 'nusdash_meetdienst_namen_v1';
const HANDOFF_LIST_KEY = 'nusdash_handoff_namen_v1';
const DEFAULT_MEETDIENST_NAMEN = ['Kees Smit', 'Bas M. Oudshoorn'];
const DEFAULT_HANDOFF_NAMEN = ['Conor', 'Patricia', 'Dulani'];

function loadToSnapshots() {
  try {
    const raw = localStorage.getItem(TO_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { console.error(e); return []; }
}
function saveToSnapshots(snaps) {
  snaps.sort((a, b) => a.week.localeCompare(b.week));
  try {
    localStorage.setItem(TO_STORAGE_KEY, JSON.stringify(snaps));
  } catch (e) {
    throw new Error('Opslag van de browser zit vol. Verwijder een oudere week (onderaan de pagina) en probeer het opnieuw.');
  }
}
function loadNameList(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback.slice();
  } catch (e) { console.error(e); return fallback.slice(); }
}
function saveNameList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); }
  catch (e) { console.error(e); }
}

function storageUsageBytes() {
  const keys = [STORAGE_KEY, TYPE_WHITELIST_KEY, TO_STORAGE_KEY, MEETDIENST_LIST_KEY, HANDOFF_LIST_KEY];
  const raw = keys.map(k => localStorage.getItem(k) || '').join('');
  return new Blob([raw]).size;
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

function renderStatTiles(current, mutations) {
  const el = document.getElementById('stat-tiles');
  const total = current.length;
  const overdueCount = current.filter(s => s.overdue).length;
  const tiles = [
    { label: 'Totaal open', value: total },
    { label: 'Nieuw binnengekomen', value: mutations.hasPrevious ? mutations.nieuw.length : '—',
      note: mutations.hasPrevious ? 'sinds vorige week' : 'nog geen vorige week' },
    { label: 'Afgesloten / uitgegaan', value: mutations.hasPrevious ? mutations.uitgegaan.length : '—',
      note: mutations.hasPrevious ? 'sinds vorige week' : 'nog geen vorige week' },
    { label: 'Verlopen', value: overdueCount, deltaClass: overdueCount > 0 ? 'bad' : 'good',
      note: overdueCount > 0 ? 'target niet gehaald' : 'alles binnen target' },
  ];
  el.innerHTML = tiles.map(t => `
    <div class="stat-tile">
      <div class="label">${esc(t.label)}</div>
      <div class="value">${esc(t.value)}</div>
      ${t.note ? `<div class="delta ${t.deltaClass || ''}">${esc(t.note)}</div>` : ''}
    </div>`).join('');
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

  const regios = sortByGroupOrder(Array.from(new Set(snapshots.flatMap(sn => typeFiltered(sn.storingen).map(s => regioGroupOf(s))))));
  const series = {};
  regios.forEach(r => { series[r] = snapshots.map(sn => typeFiltered(sn.storingen).filter(s => regioGroupOf(s) === r).length); });

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
  const head = COLUMNS.map(c => {
    const active = state.sortState.key === c.key ? (state.sortState.dir === 1 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${c.key}" class="${c.num ? 'num' : ''}">${esc(c.label)}${active}</th>`;
  }).join('');
  const body = rows.map(s => {
    const status = statusOf(s);
    const daysText = s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen` : `nog ${s.daysLeft} dgn`;
    const flagsHtml = s.flags.length
      ? s.flags.map(f => `<span class="badge" title="${esc(FLAG_LABELS[f])}">${esc(f)}</span>`).join(' ')
      : '—';
    return `<tr>
      <td>${esc(regioGroupLabel(s.regioGroup))}</td>
      <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${esc(s.order)}</td>
      <td>${esc(s.asset)}${s.assetType ? ' ' + esc(s.assetType) : ''}</td>
      <td>${s.wvNaam ? esc(s.wvNaam) : '—'}</td>
      <td class="num"><span class="status-pill ${status}">${STATUS_ICONS[status]} ${esc(daysText)}</span></td>
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
    btn.addEventListener('click', () => {
      if (!confirm(`Week ${btn.dataset.week} verwijderen?`)) return;
      const snaps = loadSnapshots().filter(s => s.week !== btn.dataset.week);
      saveSnapshots(snaps);
      state.snapshots = snaps;
      if (snaps.length === 0) document.getElementById('dashboard').classList.add('hidden');
      else renderDashboardFromState();
      renderWeeksList();
    });
  });
}

function updateStorageUsage() {
  const el = document.getElementById('storage-usage');
  if (!el) return;
  const bytes = storageUsageBytes();
  const kb = bytes / 1024;
  const text = kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(2)} MB`;
  el.textContent = `Huidige opslag: ${text} — browsers bieden meestal 5–10 MB per site.`;
}

/* ---------- Rendering: type-filter & regio-filters ---------- */

function renderTypeWhitelist() {
  const listEl = document.getElementById('type-whitelist');
  if (state.typeWhitelist.length === 0) {
    listEl.innerHTML = '<p class="empty-note">Geen types ingesteld — alle storingen worden genegeerd totdat je er een toevoegt.</p>';
  } else {
    listEl.innerHTML = state.typeWhitelist.map(t => `
      <span class="type-chip">${esc(t)}<button class="remove-type" data-type="${esc(t)}" title="Verwijderen">×</button></span>
    `).join('');
    listEl.querySelectorAll('.remove-type').forEach(btn => {
      btn.addEventListener('click', () => {
        state.typeWhitelist = state.typeWhitelist.filter(t => t !== btn.dataset.type);
        saveTypeWhitelist(state.typeWhitelist);
        renderDashboardFromState();
      });
    });
  }

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
    btn.addEventListener('click', () => {
      if (!state.typeWhitelist.includes(btn.dataset.type)) state.typeWhitelist.push(btn.dataset.type);
      saveTypeWhitelist(state.typeWhitelist);
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
  renderNameChipList('meetdienst-list', state.meetdienstNamen, (name) => {
    state.meetdienstNamen = state.meetdienstNamen.filter(n => n !== name);
    saveNameList(MEETDIENST_LIST_KEY, state.meetdienstNamen);
    renderToDashboardFromState();
  });
}
function renderHandoffList() {
  renderNameChipList('handoff-list', state.handoffNamen, (name) => {
    state.handoffNamen = state.handoffNamen.filter(n => n !== name);
    saveNameList(HANDOFF_LIST_KEY, state.handoffNamen);
    renderToDashboardFromState();
  });
}

function renderToStatTiles(classified) {
  const el = document.getElementById('to-stat-tiles');
  const meetdienstCount = classified.filter(c => c.status === 'meetdienst').length;
  const wvCount = classified.filter(c => c.status === 'werkvoorbereiders').length;
  const tiles = [
    { label: 'Totaal relevant', value: meetdienstCount + wvCount },
    { label: 'Bij meetdienst', value: meetdienstCount, note: 'nog niets aan te doen' },
    { label: 'Open voor werkvoorbereiders', value: wvCount, note: 'moet ingepland worden' },
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
];

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
  const annotated = relevant.map(c => Object.assign({}, c.storing, {
    regioGroup: regioGroupOf(c.storing),
    toStatusLabel: c.status === 'meetdienst' ? 'Bij meetdienst' : "Open voor WV'ers",
    namesLabel: (c.storing.names || []).join(' → ') || '—',
  }));
  const rows = sortToRows(annotated);
  const head = TO_COLUMNS.map(col => {
    const active = state.toSortState.key === col.key ? (state.toSortState.dir === 1 ? ' ↑' : ' ↓') : '';
    return `<th data-key="${col.key}" class="${col.num ? 'num' : ''}">${esc(col.label)}${active}</th>`;
  }).join('');
  const body = rows.map(s => {
    const status = statusOf(s);
    const daysText = s.overdue ? `${Math.abs(s.daysLeft)} dgn verlopen` : `nog ${s.daysLeft} dgn`;
    return `<tr>
      <td>${esc(regioGroupLabel(s.regioGroup))}</td>
      <td>${s.gebiedscode ? esc(s.gebiedscode) : '—'}</td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.street)}, ${esc(s.postcode)}</td>
      <td>${esc(s.order)}</td>
      <td>${esc(s.toStatusLabel)}</td>
      <td>${esc(s.namesLabel)}</td>
      <td class="num"><span class="status-pill ${status}">${STATUS_ICONS[status]} ${esc(daysText)}</span></td>
      <td>${s.executionDate ? esc(fmtDate(s.executionDate)) : 'onbekend'}</td>
      <td>${esc(s.type)}</td>
    </tr>`;
  }).join('');
  container.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
    btn.addEventListener('click', () => {
      if (!confirm(`Week ${btn.dataset.toWeek} verwijderen?`)) return;
      const snaps = loadToSnapshots().filter(s => s.week !== btn.dataset.toWeek);
      saveToSnapshots(snaps);
      state.toSnapshots = snaps;
      if (snaps.length === 0) document.getElementById('to-dashboard').classList.add('hidden');
      else renderToDashboardFromState();
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
  document.getElementById('to-dashboard').classList.remove('hidden');
  renderToStatTiles(classified);
  renderToIgnored(classified);
  renderToTableAll(classified);
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
  renderFilterTabs(latestVisible);

  const latestFiltered = filterByActive(latestVisible);
  const previousFiltered = previousVisible ? { storingen: filterByActive(previousVisible) } : null;
  const mutations = computeMutations(latestFiltered, previousFiltered);

  document.getElementById('dashboard').classList.remove('hidden');
  renderStatTiles(latestFiltered, mutations);
  renderRegioChart(latestVisible); // altijd volledige regio-vergelijking, los van de actieve filtertab
  renderTrendChart(snaps); // idem
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

function wireEvents() {
  document.getElementById('process-btn').addEventListener('click', () => {
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

    const snaps = loadSnapshots();
    const idx = snaps.findIndex(s => s.week === week);
    const snapshot = { week, savedAt: new Date().toISOString(), storingen };
    if (idx >= 0) snaps[idx] = snapshot; else snaps.push(snapshot);
    try {
      saveSnapshots(snaps);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    state.snapshots = snaps;

    renderDashboardFromState();
    showParseWarning(errors, storingen.length);
    statusEl.textContent = `${storingen.length} storingen verwerkt voor week ${week}` + (errors.length ? `, ${errors.length} regels niet herkend` : '');
    textarea.value = '';
  });

  document.getElementById('clear-all-btn').addEventListener('click', () => {
    if (!confirm('Alle opgeslagen weken verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    localStorage.removeItem(STORAGE_KEY);
    state.snapshots = [];
    document.getElementById('dashboard').classList.add('hidden');
  });

  document.querySelectorAll('.toggle-table').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target === 'regio-chart') {
        state.regioViewMode = state.regioViewMode === 'chart' ? 'table' : 'chart';
        btn.textContent = state.regioViewMode === 'chart' ? 'Toon als tabel' : 'Toon als grafiek';
        const latest = state.snapshots[state.snapshots.length - 1];
        if (latest) renderRegioChart(typeFiltered(latest.storingen));
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

  document.getElementById('add-type-btn').addEventListener('click', () => {
    const input = document.getElementById('new-type-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.typeWhitelist.includes(val)) state.typeWhitelist.push(val);
    saveTypeWhitelist(state.typeWhitelist);
    input.value = '';
    renderDashboardFromState();
  });

  document.getElementById('to-process-btn').addEventListener('click', () => {
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

    const snaps = loadToSnapshots();
    const idx = snaps.findIndex(s => s.week === week);
    const snapshot = { week, savedAt: new Date().toISOString(), storingen };
    if (idx >= 0) snaps[idx] = snapshot; else snaps.push(snapshot);
    try {
      saveToSnapshots(snaps);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    state.toSnapshots = snaps;

    renderToDashboardFromState();
    showToParseWarning(errors, storingen.length);
    statusEl.textContent = `${storingen.length} storingen verwerkt voor week ${week}` + (errors.length ? `, ${errors.length} regels niet herkend` : '');
    textarea.value = '';
  });

  document.getElementById('to-clear-all-btn').addEventListener('click', () => {
    if (!confirm('Alle opgeslagen weken (te onderzoeken storingen) verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    localStorage.removeItem(TO_STORAGE_KEY);
    state.toSnapshots = [];
    document.getElementById('to-dashboard').classList.add('hidden');
  });

  document.getElementById('add-meetdienst-btn').addEventListener('click', () => {
    const input = document.getElementById('new-meetdienst-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.meetdienstNamen.includes(val)) state.meetdienstNamen.push(val);
    saveNameList(MEETDIENST_LIST_KEY, state.meetdienstNamen);
    input.value = '';
    renderToDashboardFromState();
  });

  document.getElementById('add-handoff-btn').addEventListener('click', () => {
    const input = document.getElementById('new-handoff-input');
    const val = input.value.trim();
    if (!val) return;
    if (!state.handoffNamen.includes(val)) state.handoffNamen.push(val);
    saveNameList(HANDOFF_LIST_KEY, state.handoffNamen);
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
      renderToTableAll(classified);
    }
  });
}

function init() {
  document.getElementById('week-date').value = new Date().toISOString().slice(0, 10);
  document.getElementById('to-week-date').value = new Date().toISOString().slice(0, 10);
  state.snapshots = loadSnapshots();
  state.typeWhitelist = loadTypeWhitelist();
  state.toSnapshots = loadToSnapshots();
  state.meetdienstNamen = loadNameList(MEETDIENST_LIST_KEY, DEFAULT_MEETDIENST_NAMEN);
  state.handoffNamen = loadNameList(HANDOFF_LIST_KEY, DEFAULT_HANDOFF_NAMEN);
  wireEvents();
  if (state.snapshots.length > 0) renderDashboardFromState();
  else renderTypeWhitelist();
  if (state.toSnapshots.length > 0) renderToDashboardFromState();
  else { renderMeetdienstList(); renderHandoffList(); }
}

document.addEventListener('DOMContentLoaded', init);
