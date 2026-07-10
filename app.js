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

function parseBlock(lines) {
  let i = 0;
  const type = lines[i++];
  if (type === undefined) throw new Error('Leeg blok');

  const locLine = lines[i++];
  if (!locLine) throw new Error('Locatieregel ontbreekt');
  const locParts = locLine.split('|').map(s => s.trim());
  if (locParts.length < 3) throw new Error('Locatieregel kon niet worden gesplitst op "|": ' + locLine);
  const [city, street, postcode] = locParts;

  if (!lines[i] || !/^order:?$/i.test(lines[i])) throw new Error('Verwachtte "Order:" label, kreeg: ' + lines[i]);
  i++;
  const order = lines[i++];
  if (!order || !/^\d{6,12}$/.test(order)) throw new Error('Ordernummer onherkenbaar: ' + order);

  if (!lines[i] || !/^asset:?$/i.test(lines[i])) throw new Error('Verwachtte "Asset:" label, kreeg: ' + lines[i]);
  i++;
  const asset = lines[i++];
  if (!asset) throw new Error('Assetnummer ontbreekt');
  let assetType = null;
  if (lines[i] && /^(MSR|LSKN|LSKOV)$/i.test(lines[i])) {
    assetType = lines[i++].toUpperCase();
  }

  const onTimeRe = /^Nog\s+(\d+)\s+dagen$/i;
  const overdueRe = /^(\d+)\s+dagen\s+verlopen$/i;
  const middleLines = [];
  while (i < lines.length && !onTimeRe.test(lines[i]) && !overdueRe.test(lines[i])) {
    middleLines.push(lines[i++]);
  }
  if (i >= lines.length) throw new Error('Geen "Nog X dagen" / "X dagen verlopen" regel gevonden');
  let daysLeft, overdue;
  const mOn = lines[i].match(onTimeRe);
  if (mOn) { daysLeft = parseInt(mOn[1], 10); overdue = false; }
  else { const mOff = lines[i].match(overdueRe); daysLeft = -parseInt(mOff[1], 10); overdue = true; }
  i++;

  let executionDate = null;
  let executionDateRaw = null;
  if (i < lines.length) {
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

  return {
    type, city, street, postcode, order, asset, assetType,
    wvNaam, flags, daysLeft, overdue, executionDate, executionDateRaw,
    raw: lines.join('\n'),
  };
}

function parseText(raw) {
  const blocks = raw.split(/\r?\n\s*\r?\n+/).map(b => b.trim()).filter(b => b.length > 0);
  const storingen = [];
  const errors = [];
  blocks.forEach(block => {
    const lines = block.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    try { storingen.push(parseBlock(lines)); }
    catch (e) { errors.push({ message: e.message, raw: block }); }
  });
  return { storingen, errors };
}

/* ---------- Storage ---------- */

const STORAGE_KEY = 'nusdash_snapshots_v1';

function loadSnapshots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { console.error(e); return []; }
}
function saveSnapshots(snaps) {
  snaps.sort((a, b) => a.week.localeCompare(b.week));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snaps));
}

/* ---------- Derived helpers ---------- */

function regioOf(s) { return s.city || 'Onbekend'; }

function statusOf(s) {
  if (s.overdue) return 'critical';
  if (s.daysLeft <= 2) return 'serious';
  if (s.daysLeft <= 5) return 'warning';
  return 'good';
}
const STATUS_LABELS = { good: 'Op tijd', warning: 'Aandacht', serious: 'Bijna verlopen', critical: 'Verlopen' };
const STATUS_ICONS = { good: '✓', warning: '!', serious: '⚠', critical: '✕' };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];

function buildRegioColors(snapshots) {
  const names = new Set();
  snapshots.forEach(sn => sn.storingen.forEach(s => names.add(regioOf(s))));
  const sorted = Array.from(names).sort();
  const map = {};
  sorted.forEach((name, idx) => { map[name] = idx < 8 ? `var(--series-${idx + 1})` : 'var(--series-other)'; });
  return map;
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
  regioColors: {},
  sortState: { key: 'daysLeft', dir: 1 },
  regioViewMode: 'chart',
  trendViewMode: 'chart',
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
    const r = regioOf(s);
    if (!byRegio[r]) byRegio[r] = { good: 0, warning: 0, serious: 0, critical: 0, total: 0 };
    byRegio[r][statusOf(s)]++;
    byRegio[r].total++;
  });
  const regios = Object.keys(byRegio).sort();

  if (regios.length === 0) { container.innerHTML = '<p class="empty-note">Geen data.</p>'; return; }

  if (state.regioViewMode === 'table') {
    let rows = regios.map(r => {
      const b = byRegio[r];
      return `<tr><td>${esc(r)}</td><td class="num">${b.good}</td><td class="num">${b.warning}</td><td class="num">${b.serious}</td><td class="num">${b.critical}</td><td class="num">${b.total}</td></tr>`;
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
      bars += `<rect class="seg" data-regio="${esc(r)}" data-status="${st}" data-count="${val}"
        x="${x}" y="${yTop + 1}" width="${barW}" height="${Math.max(h - 2, 0)}" rx="3"
        fill="var(--status-${st})" />`;
      yCursor = yTop;
    });
    bars += `<text x="${x + barW / 2}" y="${topPad + plotH + 20}" text-anchor="middle">${esc(r)}</text>`;
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

  const regios = Object.keys(state.regioColors).sort();
  const series = {};
  regios.forEach(r => { series[r] = snapshots.map(sn => sn.storingen.filter(s => regioOf(s) === r).length); });

  if (state.trendViewMode === 'table') {
    let head = `<th>Week</th>` + regios.map(r => `<th class="num">${esc(r)}</th>`).join('');
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
    const color = state.regioColors[r];
    const pts = series[r].map((v, wi) => `${leftPad + wi * stepX},${topPad + plotH - v * scaleY}`).join(' ');
    lines += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />`;
    series[r].forEach((v, wi) => {
      const cx = leftPad + wi * stepX, cy = topPad + plotH - v * scaleY;
      markers += `<circle class="pt" data-regio="${esc(r)}" data-week="${esc(snapshots[wi].week)}" data-val="${v}" cx="${cx}" cy="${cy}" r="4" fill="${color}" />`;
    });
    const lastX = leftPad + (series[r].length - 1) * stepX;
    const lastY = topPad + plotH - series[r][series[r].length - 1] * scaleY;
    lines += `<text x="${lastX + 8}" y="${lastY + 4}" style="fill:${color};font-weight:600;">${esc(r)}</text>`;
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
      ${regios.map(r => `<span class="legend-item"><span class="legend-swatch" style="background:${state.regioColors[r]}"></span>${esc(r)}</span>`).join('')}
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
  { key: 'city', label: 'Regio' },
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
  const rows = sortRows(current);
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
      <td>${esc(regioOf(s))}</td>
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

/* ---------- Orchestration ---------- */

function renderDashboardFromState() {
  const snaps = state.snapshots.slice().sort((a, b) => a.week.localeCompare(b.week));
  state.snapshots = snaps;
  if (snaps.length === 0) { document.getElementById('dashboard').classList.add('hidden'); return; }
  const latest = snaps[snaps.length - 1];
  const previous = snaps.length > 1 ? snaps[snaps.length - 2] : null;
  state.regioColors = buildRegioColors(snaps);
  const mutations = computeMutations(latest.storingen, previous);
  document.getElementById('dashboard').classList.remove('hidden');
  renderStatTiles(latest.storingen, mutations);
  renderRegioChart(latest.storingen);
  renderTrendChart(snaps);
  renderMutationTables(mutations);
  renderTableAll(latest.storingen);
  renderWeeksList();
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
    saveSnapshots(snaps);
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
        if (latest) renderRegioChart(latest.storingen);
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
    if (latest) renderTableAll(latest.storingen);
  });
}

function init() {
  document.getElementById('week-date').value = new Date().toISOString().slice(0, 10);
  state.snapshots = loadSnapshots();
  wireEvents();
  if (state.snapshots.length > 0) renderDashboardFromState();
}

document.addEventListener('DOMContentLoaded', init);
