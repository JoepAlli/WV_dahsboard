// Gaan er storingen terug naar een eerdere status? Dat is werk dat opnieuw
// gedaan wordt, en het is in geen enkele duurmeting te zien: elke stap op zich
// kan prima binnen de norm blijven terwijl een storing drie keer heen en weer
// gaat.
//
// De procesvolgorde is:
//   Nieuw > In onderzoek > Onderzoek controleren > In voorbereiding >
//   Planning > In uitvoering
//
// Drie storingen met een vooraf uitgerekend verloop:
//
//   A  Nieuw -> In onderzoek -> Onderzoek controleren -> In voorbereiding
//      netjes op volgorde: 3 vooruit, 0 terug
//   B  Nieuw -> In onderzoek -> Planning -> In onderzoek -> Planning
//      Nieuw->In onderzoek, In onderzoek->Planning (2 overgeslagen),
//      Planning->In onderzoek (TERUG, 3 stappen), In onderzoek->Planning
//      = 3 vooruit, 1 terug
//   C  Nieuw -> In voorbereiding -> Onderzoek controleren
//      Nieuw->In voorbereiding (2 overgeslagen), dan TERUG (1 stap)
//      = 1 vooruit, 1 terug
//
// Verwacht: 2 van de 3 storingen met minstens één terugstap (67%),
// 2 terugstappen en 7 stappen vooruit, 9 overgangen in totaal.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const blok = (o) => `${OV}
Leiden | Teststraat ${o.slice(-2)} | 2312 KR
Order:
${o}
Asset:
${o.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
Nog 90 dagen
Datum uitvoering onbekend`;

const A = '9810000001', B = '9810000002', C = '9810000003';

// Opeenvolgende werkdagen, zodat er geen meetgaten ontstaan die de telling
// zouden vertroebelen. 2026-11-02 is een maandag.
const DAGEN = [
  ['2026-11-02', { 'Nieuw': [A, B, C] }],
  ['2026-11-03', { 'In onderzoek': [A, B], 'In voorbereiding': [C] }],
  ['2026-11-04', { 'Onderzoek controleren': [A, C], 'Planning': [B] }],
  ['2026-11-05', { 'In voorbereiding': [A], 'In onderzoek': [B], 'Onderzoek controleren': [C] }],
  ['2026-11-06', { 'In voorbereiding': [A], 'Planning': [B], 'Onderzoek controleren': [C] }],
];

const VERWACHT = { terug: 2, vooruit: 7, ordersMetTerug: 2, orders: 3 };

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('file:///home/user/WV_dahsboard/index.html');
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(200);

  for (const [datum, groepen] of DAGEN) {
    const tekst = Object.entries(groepen)
      .map(([status, orders]) => status + '\n' + orders.map(blok).join('\n'))
      .join('\n');
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', tekst);
    await page.waitForTimeout(300);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(260);
  }

  console.log('--- de overgangen, tegen de handberekening ---');
  const o = await page.evaluate(() => buildStatusOvergangen());
  o.overgangen.forEach(t => console.log(
    `    ${(t.van + ' -> ' + t.naar).padEnd(48)} ${t.terug ? 'TERUG' : 'vooruit'}${t.overgeslagen ? ' (overgeslagen)' : ''}  ${t.aantal}x`));
  check('twee terugstappen', o.terugTotaal, VERWACHT.terug);
  check('zeven stappen vooruit', o.vooruitTotaal, VERWACHT.vooruit);
  check('negen overgangen in totaal', o.terugTotaal + o.vooruitTotaal, 9);
  check('twee van de drie storingen gingen terug', o.ordersMetTerug, VERWACHT.ordersMetTerug);
  check('op drie storingen met een status', o.ordersMetStatus, VERWACHT.orders);
  check('dus 67%', Math.round(o.aandeel * 100), 67);

  console.log('\n--- de richting per overgang klopt ---');
  const vind = (van, naar) => o.overgangen.find(t => t.van === van && t.naar === naar);
  check('Planning -> In onderzoek is terug', vind('Planning', 'In onderzoek').terug, true);
  check('en overbrugt drie stappen', Math.abs(vind('Planning', 'In onderzoek').stappen), 3);
  check('In voorbereiding -> Onderzoek controleren is terug', vind('In voorbereiding', 'Onderzoek controleren').terug, true);
  check('Nieuw -> In onderzoek is vooruit', vind('Nieuw', 'In onderzoek').terug, false);
  check('In onderzoek -> Planning slaat stappen over', vind('In onderzoek', 'Planning').overgeslagen, true);
  check('en is twee keer gebeurd', vind('In onderzoek', 'Planning').aantal, 2);
  check('door één storing', vind('In onderzoek', 'Planning').orders, 1);
  check('terugstappen staan vooraan', o.overgangen[0].terug, true);

  console.log('\n--- op het scherm ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(800);
  const body = await page.$eval('#overgangen-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', body.slice(0, 190));
  check('de kop noemt het aandeel', /2 van de 3 storingen \(67%\)/.test(body), true);
  check('en het aantal terugstappen', /Samen 2 terugstappen, tegen 7 stappen vooruit/.test(body), true);
  check('de tabel toont elke overgang', await page.$$eval('#overgangen-body tbody tr', e => e.length), o.overgangen.length);
  check('en waarschuwt dat het een ondergrens is', /dit is een ondergrens/.test(body), true);

  console.log('\n--- zonder terugloop zegt de kaart dat ook ---');
  // Een tweede, schone browser met alleen storing A: die loopt netjes door.
  const schoon = await browser.newPage();
  const errsS = [];
  schoon.on('pageerror', e => errsS.push('pageerror: ' + e.message));
  schoon.on('dialog', d => d.accept());
  await schoon.goto('file:///home/user/WV_dahsboard/index.html');
  await schoon.click('.tab-btn[data-tab="settings"]');
  await schoon.fill('#new-type-input', OV);
  await schoon.click('#add-type-btn');
  await schoon.waitForTimeout(200);
  for (const [datum, groepen] of DAGEN) {
    const alleenA = Object.entries(groepen).filter(([, orders]) => orders.includes(A));
    if (alleenA.length === 0) continue;
    await schoon.click('.tab-btn[data-tab="invoer"]');
    await schoon.fill('#paste-input', alleenA.map(([st]) => st + '\n' + blok(A)).join('\n'));
    await schoon.waitForTimeout(280);
    await schoon.fill('#week-date', datum);
    await schoon.click('#process-btn');
    await schoon.waitForTimeout(240);
  }
  const o2 = await schoon.evaluate(() => buildStatusOvergangen());
  check('geen terugstappen', o2.terugTotaal, 0);
  check('wel drie stappen vooruit', o2.vooruitTotaal, 3);
  await schoon.click('.tab-btn[data-tab="prognose"]');
  await schoon.waitForTimeout(700);
  const body2 = await schoon.$eval('#overgangen-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('en de kaart zegt dat met zoveel woorden', /Geen enkele storing is teruggegaan naar een eerdere status/.test(body2), true);
  check('zonder paginafouten', errsS.join(' ') || 'geen', 'geen');
  if (errsS.length) fouten++;
  await schoon.close();

  console.log('\n--- in de gedeelde export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-overgangen.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(600);
  await exp.click('.tab-btn[data-tab="prognose"]');
  await exp.waitForTimeout(500);
  check('export: dezelfde telling', await exp.evaluate(() => buildStatusOvergangen().terugTotaal), VERWACHT.terug);
  check('export: de kaart is getekend', await exp.$$eval('#overgangen-body tbody tr', e => e.length > 0), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-0/overgangen.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
