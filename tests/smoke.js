// Brede controle: met echte data door elk tabblad heen, en nakijken dat de
// kernkaarten iets tonen en dat de browser nergens een fout gooit. Geen
// diepgaande narekening — daar zijn de losse tests voor — maar wel het vangnet
// dat afgaat als een wijziging een pagina stukmaakt.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const MIO = 'Mast geen spanning Infra';
const TYPES = [OV, MIO];

const blok = (o) => `${o.type}
${o.city} | Teststraat ${o.order.slice(-2)} | 2312 KR
Order:
${o.order}
Asset:
${o.order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
${o.days >= 0 ? `Nog ${o.days} dagen` : `${-o.days} dagen verlopen`}
${o.uitv || 'Datum uitvoering onbekend'}`;

const S = {};
'ABCDEFGH'.split('').forEach((k, i) => {
  S[k] = { type: i % 3 === 0 ? MIO : OV, city: i < 4 ? 'Leiden' : 'Haarlem', order: '9800000' + (100 + i), days: 30 - i * 3 };
});
const GEBIED = { A: 'ZZE5A', B: 'ZZE5A', C: 'ZZE6B', D: 'ZZE7A', E: 'ZZE9A', F: 'ZZE9B', G: 'ZZE10A', H: 'ZZE10A' };

// Zes meetdagen met verloop: storingen schuiven door de statussen, er komt
// werk bij en er gaat werk uit.
const DAGEN = [
  ['2026-06-01', { 'Nieuw': ['A', 'B'], 'In onderzoek': ['C', 'D'], 'Planning': ['E'] }],
  ['2026-06-08', { 'In onderzoek': ['A', 'B', 'C'], 'Onderzoek controleren': ['D'], 'Planning': ['E'], 'Nieuw': ['F'] }],
  ['2026-06-15', { 'Onderzoek controleren': ['A', 'C'], 'In voorbereiding': ['B', 'D'], 'In uitvoering': ['E'], 'In onderzoek': ['F'] }],
  ['2026-06-22', { 'In voorbereiding': ['A'], 'Planning': ['B', 'C'], 'In uitvoering': ['D'], 'In onderzoek': ['F'], 'Nieuw': ['G'] }],
  ['2026-06-29', { 'Planning': ['A'], 'In uitvoering': ['B', 'C'], 'In onderzoek': ['F', 'G'], 'Nieuw': ['H'] }],
  ['2026-07-06', { 'In uitvoering': ['A'], 'Planning': ['F'], 'In onderzoek': ['G', 'H'] }],
];
const KLANT = ['9850000001', '9850000002'];

const statusLijst = (groepen) => Object.entries(groepen)
  .map(([st, ks]) => st + '\n' + ks.map(k => blok(S[k])).join('\n')).join('\n');
const gebiedLijst = (groepen) => {
  const per = {};
  Object.values(groepen).flat().forEach(k => { (per[GEBIED[k]] = per[GEBIED[k]] || []).push(k); });
  return Object.entries(per).map(([g, ks]) => g + '\n' + ks.map(k => blok(S[k])).join('\n')).join('\n');
};
const klantLijst = () => `${KLANT.length} Nieuwe klantaanvragen\n` + KLANT.map((o, i) => blok({
  type: 'Schakelen bij LS werkzaamheden derden 2x', city: 'Leiden', order: o, days: 300 + i,
  uitv: `${11 + i} sep. 2026 08:00`,
})).join('\n');

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('file:///home/user/WV_dahsboard/index.html');
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };
  const plak = async (tekst, datum, soort = 'nus') => {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', tekst);
    await page.waitForTimeout(240);
    await page.click(`#lijst-soort button[data-lijst="${soort}"]`);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(210);
  };

  await page.click('.tab-btn[data-tab="settings"]');
  for (const t of TYPES) {
    await page.fill('#new-type-input', t);
    await page.click('#add-type-btn');
    await page.waitForTimeout(110);
  }

  for (const [datum, groepen] of DAGEN) {
    await plak(gebiedLijst(groepen), datum);
    await plak(statusLijst(groepen), datum);
  }
  await plak(klantLijst(), '2026-07-06', 'klantaanvraag');

  console.log('--- Data ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(600);
  const totaal = await page.$eval('[data-stat-key="totaal"] .value', e => +e.textContent.trim());
  check('totaal open', totaal, 4);
  const statusKeys = ['statusNieuw', 'statusOnderzoek', 'statusOnderzoekControleren', 'statusVoorbereiding', 'statusPlanning', 'statusUitvoering'];
  const som = await page.$$eval('#stat-tiles [data-stat-key]', (els, keys) => {
    const o = {}; els.forEach(e => { o[e.dataset.statKey] = +e.querySelector('.value').textContent.trim(); });
    return keys.reduce((n, k) => n + (o[k] || 0), 0) + (o.geblokkeerd || 0);
  }, statusKeys);
  check('statustegels tellen op tot het totaal', som, totaal);
  check('rijen in de volledige lijst', await page.$$eval('#table-all tbody tr', e => e.length), totaal);
  check('klantaanvragen apart', await page.$eval('#klantaanvraag-count', e => e.textContent.trim()), KLANT.length);

  console.log('\n--- Gebieden ---');
  await page.click('.tab-btn[data-tab="gebieden"]');
  await page.waitForTimeout(500);
  check('clusters of plaatsen getekend', await page.$$eval('#gebied-plaatsen-body tbody tr', e => e.length > 0), true);
  check('in- en uitstroom per gebied', await page.$$eval('#inuit-body tbody tr', e => e.length > 0), true);

  console.log('\n--- Overleg ---');
  await page.click('.tab-btn[data-tab="overleg"]');
  await page.waitForTimeout(500);
  check('weekbericht getekend', await page.$eval('#overleg', e => !e.classList.contains('hidden')), true);
  const tekst = await page.evaluate(() => buildOverlegText());
  const paren = [...tekst.matchAll(/Stand [^:]+: (\d+)\nIngestroomd: (\d+)\nUitgestroomd: (\d+)\nStand [^:]+: (\d+)/g)];
  check('stroomblokken rekenen kloppend', paren.length > 0 && paren.every(m => +m[1] + +m[2] - +m[3] === +m[4]), true);

  console.log('\n--- Prognose ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(600);
  check('benodigd tempo getekend', await page.$$eval('#tempo-body .tempo-stat', e => e.length), 4);
  check('instroom per maand getekend', await page.$$eval('#maand-tempo-body tbody tr', e => e.length > 0), true);
  check('doorstroom per status getekend', await page.$$eval('#doorstroom-body tbody tr', e => e.length), 6);
  check('boxplot of melding getekend', await page.$eval('#boxplot-body', e => e.textContent.trim().length > 0), true);
  check('te lang onderweg getekend', await page.$eval('#stagnatie-body', e => e.textContent.trim().length > 0), true);

  console.log('\n--- Historie ---');
  await page.click('.tab-btn[data-tab="historie"]');
  await page.waitForTimeout(500);
  check('doorlooptijd getekend', await page.$eval('#doorlooptijd-card-body', e => e.textContent.trim().length > 0), true);
  await page.fill('#historie-search', S.E.order);
  await page.waitForTimeout(400);
  check('een opgeloste storing is terug te vinden', await page.$$eval('#historie-body tbody tr', e => e.length), 1);

  console.log('\n--- Instellingen en export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(400);
  check('streefwaarden per status', await page.$$eval('#status-streef-body input', e => e.length), 6);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/smoke-export.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(500);
  for (const tab of ['data', 'gebieden', 'overleg', 'prognose', 'historie']) {
    await exp.click(`.tab-btn[data-tab="${tab}"]`);
    await exp.waitForTimeout(350);
  }
  check('export: totaal gelijk aan het origineel', await exp.$eval('[data-stat-key="totaal"] .value', e => +e.textContent.trim()), totaal);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
