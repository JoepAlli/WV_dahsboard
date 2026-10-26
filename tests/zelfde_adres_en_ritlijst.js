// Twee dingen die bij elkaar horen maar iets anders doen:
//
//  - Meerdere orders op één adres: twee redenen in de werklijst, met
//    onderscheid tussen dezelfde asset (mogelijk twee keer dezelfde melding,
//    de zwaarste reden die er is) en verschillende assets (twee masten op één
//    adres, alleen handig om samen in te plannen).
//  - De ritlijst: dezelfde clusters als op het scherm, maar als printklaar
//    bestand zodat er niet handmatig doorheen gelopen hoeft te worden.
//
// De fixture is zo gebouwd dat de uitkomst vooraf vaststaat:
//   Hooigracht 12, Leiden  -> 2 orders, ZELFDE asset   (verdacht)
//   Breestraat 40, Leiden  -> 2 orders, andere assets  (twee masten)
//   Zijlweg 3, Haarlem     -> 1 order                  (geen melding)
//   Zijlweg 9, Haarlem     -> 1 order                  (zelfde straat, ander adres)
// Dus 2 adresgroepen, 4 storingen daarin, waarvan 1 groep op dezelfde asset.
// Op straatniveau vormt Zijlweg wél een cluster van 2.
const { chromium } = require('playwright');
const fs = require('fs');

const OV = 'Stra[a]t[en] zonder OV Infra';
const MIO = 'Mast geen spanning Infra';

const blok = (s) => `${s.type}
${s.city} | ${s.street} | ${s.pc}
Order:
${s.order}
Asset:
${s.asset}
MSR
Piet Poot
Marc van Veen
Nog ${s.days} dagen
Datum uitvoering onbekend`;

const STORINGEN = [
  // zelfde adres én zelfde asset
  { type: OV,  city: 'Leiden',  street: 'Hooigracht 12', pc: '2312 KR', order: '9910000001', asset: '3000001-EL', days: 12 },
  { type: MIO, city: 'Leiden',  street: 'Hooigracht 12', pc: '2312 KR', order: '9910000002', asset: '3000001-EL', days: 4 },
  // zelfde adres, verschillende assets
  { type: OV,  city: 'Leiden',  street: 'Breestraat 40', pc: '2311 CS', order: '9910000003', asset: '3000003-EL', days: 20 },
  { type: OV,  city: 'Leiden',  street: 'Breestraat 40', pc: '2311 CS', order: '9910000004', asset: '3000004-EL', days: 25 },
  // zelfde straat, verschillend adres -> geen adresmelding, wel een cluster
  { type: OV,  city: 'Haarlem', street: 'Zijlweg 3',     pc: '2011 AA', order: '9910000005', asset: '3000005-EL', days: 30 },
  { type: MIO, city: 'Haarlem', street: 'Zijlweg 9',     pc: '2011 AB', order: '9910000006', asset: '3000006-EL', days: 8 },
  // helemaal alleen
  { type: OV,  city: 'Katwijk', street: 'Zeeweg 1',      pc: '2225 AA', order: '9910000007', asset: '3000007-EL', days: 50 },
];

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1200 }, acceptDownloads: true });
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
  for (const t of [OV, MIO]) {
    await page.fill('#new-type-input', t);
    await page.click('#add-type-btn');
    await page.waitForTimeout(110);
  }
  await page.click('.tab-btn[data-tab="invoer"]');
  await page.fill('#paste-input', 'ZZE5A\n' + STORINGEN.map(blok).join('\n'));
  await page.waitForTimeout(300);
  await page.fill('#week-date', '2026-10-05');
  await page.click('#process-btn');
  await page.waitForTimeout(400);

  console.log('--- meerdere orders op één adres, nu als reden in de werklijst ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(700);

  // De adresmelding is geen eigen kaart meer: het is een reden in de
  // werklijst. Dezelfde asset is een ander signaal dan hetzelfde adres —
  // het eerste kan een dubbele melding zijn, het tweede scheelt alleen een rit.
  const w = await page.evaluate(() => buildWerklijst());
  const metReden = (key) => w.rijen.filter(r => r.redenen.includes(key)).map(r => r.order).sort();
  const dubbel = metReden('dubbeleMelding');
  const zelfde = metReden('zelfdeAdres');
  console.log('    mogelijk dubbele melding:', dubbel.join(', '));
  console.log('    zelfde adres, andere asset:', zelfde.join(', '));
  check('de twee orders op dezelfde asset zijn gemeld', dubbel.join(','), '9910000001,9910000002');
  check('en die op verschillende assets apart', zelfde.join(','), '9910000003,9910000004');

  // Zijlweg 3 en 9 zijn dezelfde straat maar niet hetzelfde adres: die horen
  // hier juist NIET in te staan.
  const alle = dubbel.concat(zelfde);
  check('zelfde straat maar ander huisnummer telt niet mee', alle.includes('9910000005'), false);
  check('en de losse storing ook niet', alle.includes('9910000007'), false);

  // De dubbele melding is het dringendst van alle redenen: als twee orders
  // hetzelfde object beschrijven, vervuilt dat elk cijfer in het dashboard.
  const eerste = w.rijen[0];
  check('een mogelijk dubbele melding staat bovenaan', eerste.redenen.includes('dubbeleMelding'), true);
  check('het label noemt de andere order',
    /met 991000000[12]/.test(await page.$eval('#werklijst-body tbody tr', e => e.textContent)), true);

  const kopieer = await page.$eval('#werklijst-body', e => e.dataset.copyText);
  const regel = kopieer.split('\n').find(r => r.startsWith('9910000001')).split('\t');
  console.log('    kopieerregel:', regel.join(' | '));
  check('kopieertekst noemt het type', /zonder OV Infra/.test(regel[1]), true);
  check('en de regio', regel[2], 'Regio Leiden');
  check('en de plaats', regel[3], 'Leiden');
  check('de adresreden staat bewust niet in de kopie', /Mogelijk dubbele melding/.test(kopieer), false);

  console.log('\n--- ritlijst downloaden ---');
  await page.click('.tab-btn[data-tab="gebieden"]');
  await page.waitForTimeout(500);
  await page.click('#cluster-mode button[data-cluster-mode="straat"]');
  await page.waitForTimeout(400);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ritlijst-btn')]);
  const pad = '/tmp/claude-0/ritlijst.html';
  await dl.saveAs(pad);
  check('bestandsnaam bevat de meetdatum', /ritlijst-nus-2026-10-05\.html$/.test(dl.suggestedFilename()), true);

  const html = fs.readFileSync(pad, 'utf8');
  check('ritlijst is zelfstandig (geen externe verwijzingen)', /<(script|link)\b/i.test(html), false);
  check('noemt de groepering', /Gegroepeerd op straat/.test(html), true);
  // Op straatniveau: Hooigracht (2), Breestraat (2), Zijlweg (2) = 6 in clusters,
  // Zeeweg staat alleen. Dus 3 clusters over 2 plaatsen.
  check('telt zes storingen in clusters', /6 van de 7 openstaande storingen liggen in 3 clusters/.test(html), true);
  check('over twee plaatsen', /verspreid over 2 plaatsen/.test(html), true);
  check('en meldt dat er één op zichzelf staat', /1 staat op zichzelf/.test(html), true);

  const exp = await browser.newPage();
  const errsRit = [];
  exp.on('pageerror', e => errsRit.push('pageerror: ' + e.message));
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(300);
  const plaatsen = await exp.$$eval('.plaats h2', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('   plaatsen in de ritlijst:', plaatsen.join(' | '));
  check('een blok per plaats', plaatsen.length, 2);
  const clusters = await exp.$$eval('.cluster h3', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('   clusters:', clusters.join(' | '));
  check('drie clusters', clusters.length, 3);
  check('elke order heeft een afvinkhokje', await exp.$$eval('tbody .vink', els => els.length), 6);
  check('order, adres en termijn staan erin', await exp.$$eval('tbody tr', trs =>
    trs.some(t => t.textContent.includes('9910000002') && t.textContent.includes('Hooigracht 12') && t.textContent.includes('nog 4 dgn'))), true);
  check('ritlijst opent zonder fouten', errsRit.join(' ') || 'geen', 'geen');
  if (errsRit.length) fouten++;
  await exp.close();

  console.log('\n--- beide werken ook in de gedeelde export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(250);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const expPad = '/tmp/claude-0/export-adres.html';
  await dl2.saveAs(expPad);
  const errsExp = [];
  const exp2 = await browser.newPage({ acceptDownloads: true });
  exp2.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp2.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp2.goto('file://' + expPad);
  await exp2.waitForTimeout(500);
  check('export: de adresredenen staan erin',
    await exp2.evaluate(() => buildWerklijst().rijen.filter(r => r.redenen.includes('dubbeleMelding')).length), 2);
  await exp2.click('.tab-btn[data-tab="gebieden"]');
  await exp2.waitForTimeout(400);
  const [dl3] = await Promise.all([exp2.waitForEvent('download'), exp2.click('#ritlijst-btn')]);
  check('export: ritlijst is ook daar te downloaden', /ritlijst-nus/.test(dl3.suggestedFilename()), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp2.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
