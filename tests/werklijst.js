// Het dashboard had vier lijsten die allemaal "hier moet iets gebeuren"
// zeiden, verspreid over twee tabbladen. Dezelfde storing kon in drie ervan
// staan zonder dat je wist welke het dringendst was. Nu is het één lijst met
// alle redenen per regel.
//
// Deze test bewaakt de twee dingen die daarbij mis kunnen gaan:
//
//   1. Een storing mag maar ÉÉN keer in de lijst staan, hoeveel redenen 'ie
//      ook heeft — anders is het samenvoegen niets waard.
//   2. De volgorde moet de zwaarste reden volgen, niet de volgorde waarin de
//      bronnen toevallig worden uitgelezen.
//
// De opzet is zo gebouwd dat de redenen zich stapelen:
//
//   DUBBEL (2 orders) - zelfde adres én zelfde asset -> mogelijk dubbele
//                       melding, de zwaarste reden die er is
//   VERLOPEN          - termijn voorbij, geen uitvoeringsdatum
//   OUD               - al sinds 1 juni open, wordt ingehaald door jongere
//                       afsluitingen én staat te lang in zijn status
//   SCHOON            - komt pas op de laatste meetdag binnen, dus geen enkele
//                       reden; hoort er niet in te staan
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const DUBBEL = ['9920000001', '9920000002'];
const VERLOPEN = '9920000011';
const OUD = '9920000021';
const SCHOON = '9920000031';
// Deze acht worden allemaal afgesloten, zodat OUD wordt voorbijgestreefd.
const JONG = ['9920000041', '9920000042', '9920000043', '9920000044',
              '9920000045', '9920000046', '9920000047', '9920000048'];

const blok = (order, dagen, asset, adres) => `${OV}
Leiden | ${adres || `Teststraat ${order.slice(-2)}`} | 2312 KR
Order:
${order}
Asset:
${asset || order.slice(-7) + '-EL'}
MSR
Piet Poot
Marc van Veen
${dagen >= 0 ? `Nog ${dagen} dagen` : `${-dagen} dagen verlopen`}
Datum uitvoering onbekend`;

// Twee orders op exact hetzelfde adres én dezelfde asset.
const dubbelBlok = (o) => blok(o, 60, '3000999-EL', 'Hooigracht 12');

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto('file:///home/user/WV_dahsboard/index.html');
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };
  const plak = async (tekst, datum) => {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', tekst);
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(220);
  };

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(150);
  // Strakke norm, zodat OUD gegarandeerd over de statusnorm heen gaat.
  await page.fill('#doorlooptijd-norm-input', '12');
  await page.click('#status-streef-save-btn');
  await page.waitForTimeout(350);

  // 1 juni: alleen OUD komt binnen. SCHOON komt pas op de laatste dag — een
  // storing die sinds juni openstaat is per definitie niet schoon.
  const basis = [blok(OUD, 60)];
  await plak('ZZE5A\n' + basis.join('\n'), '2026-06-01');
  await plak('In onderzoek\n' + basis.join('\n'), '2026-06-01');

  // 5 juni: de jonge lichting komt erbij, plus de dubbele en de verlopene.
  const alles = basis.concat(JONG.map(o => blok(o, 60)), DUBBEL.map(dubbelBlok), [blok(VERLOPEN, -9)]);
  await plak('ZZE5A\n' + alles.join('\n'), '2026-06-05');
  await plak('In onderzoek\n' + alles.join('\n'), '2026-06-05');
  await plak('ZZE5A\n' + alles.join('\n'), '2026-06-20');
  await plak('In onderzoek\n' + alles.join('\n'), '2026-06-20');

  // 1 juli: alle acht jonge storingen zijn afgesloten.
  const rest = basis.concat(DUBBEL.map(dubbelBlok), [blok(VERLOPEN, -9), blok(SCHOON, 200)]);
  await plak('ZZE5A\n' + rest.join('\n'), '2026-07-01');
  await plak('In onderzoek\n' + rest.join('\n'), '2026-07-01');

  console.log('--- één regel per storing, ook met meerdere redenen ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(800);
  const w = await page.evaluate(() => buildWerklijst());
  w.rijen.forEach(r => console.log(`    ${r.order}  ${r.redenen.join(' + ')}`));

  const orders = w.rijen.map(r => r.order);
  check('geen enkele order staat er dubbel in', orders.length, new Set(orders).size);
  check('de schone storing staat er niet in', orders.includes(SCHOON), false);

  const regel = (o) => w.rijen.find(r => r.order === o);
  check('de oude storing heeft meerdere redenen', regel(OUD).redenen.length > 1, true);
  check('waaronder dat die wordt ingehaald', regel(OUD).redenen.includes('voorbijgestreefd'), true);
  check('de verlopen storing is als zodanig gemeld', regel(VERLOPEN).redenen.includes('unknown'), true);
  check('en de twee op dezelfde asset als mogelijk dubbel',
    DUBBEL.every(o => regel(o).redenen.includes('dubbeleMelding')), true);

  console.log('\n--- gesorteerd op de zwaarste reden ---');
  console.log('    volgorde:', w.rijen.map(r => r.zwaarste.label).join(' | '));
  check('de mogelijke dubbele melding staat bovenaan', w.rijen[0].redenen.includes('dubbeleMelding'), true);
  check('prioriteiten lopen oplopend', w.rijen.every((r, i, a) => i === 0 || a[i - 1].prio <= r.prio), true);
  // Binnen een regel staan de redenen ook op zwaarte, niet in de volgorde
  // waarin de bronnen toevallig zijn uitgelezen.
  const prioVan = await page.evaluate(() => Object.fromEntries(WERK_REDENEN.map(r => [r.key, r.prio])));
  const oudRedenen = regel(OUD).redenen;
  console.log('    redenen van de oude storing:', oudRedenen.join(' + '));
  check('redenen binnen een regel staan op zwaarte',
    oudRedenen.every((k, i, a) => i === 0 || prioVan[a[i - 1]] <= prioVan[k]), true);

  console.log('\n--- het scherm toont hetzelfde ---');
  const opScherm = await page.$$eval('#werklijst-body tbody tr', trs => trs.length);
  check('evenveel regels op het scherm', opScherm, w.rijen.length);
  check('de teller zegt hetzelfde', await page.$eval('#werklijst-count', e => e.textContent.trim()), w.rijen.length);

  console.log('\n--- filteren op reden ---');
  await page.click('#werklijst-body [data-werk-reden="voorbijgestreefd"]');
  await page.waitForTimeout(400);
  const gefilterd = await page.$$eval('#werklijst-body tbody tr', trs => trs.length);
  check('alleen de ingehaalde storingen', gefilterd, w.tellingen.voorbijgestreefd);
  const kopieer = await page.$eval('#werklijst-body', e => e.dataset.copyText);
  const regels = kopieer.split('\n');
  console.log('    koprij :', regels[0]);
  console.log('    regel 1:', regels[1]);
  check('de kopieerknop volgt het filter', regels.length - 1, gefilterd);
  check('met een koprij erboven', regels[0].split('\t')[0], 'Order');
  check('en zeven kolommen', regels[0].split('\t').length, 7);
  const kolom = (naam) => regels[0].split('\t').indexOf(naam);
  const cel = (regel, naam) => regel.split('\t')[kolom(naam)];
  check('type storing gaat mee', cel(regels[1], 'Type'), 'Stra[a]t[en] zonder OV Infra');
  // De regio is waar de verantwoordelijke op filtert; die moet erin.
  check('regio gaat mee', cel(regels[1], 'Regio'), 'Regio Leiden');
  check('plaats gaat mee', cel(regels[1], 'Plaats'), 'Leiden');
  // Straat en postcode zijn er bewust uit: wie de lijst krijgt werkt op regio
  // en plaats en zoekt het adres er zelf bij op ordernummer.
  check('straat staat er niet meer in', regels[0].includes('Adres'), false);
  check('postcode ook niet', regels[0].includes('Postcode'), false);
  check('en de reden staat er nog steeds in', /Wordt ingehaald/.test(cel(regels[1], 'Reden')), true);
  await page.click('#werklijst-body [data-werk-reden=""]');
  await page.waitForTimeout(400);
  check('filter weghalen toont alles weer', await page.$$eval('#werklijst-body tbody tr', e => e.length), w.rijen.length);

  // Een storing met drie redenen hoort ze alle drie in de kopie te hebben,
  // niet alleen de zwaarste — juist de combinatie is wat je doorgeeft.
  const alleRegels = (await page.$eval('#werklijst-body', e => e.dataset.copyText)).split('\n');
  const regelOud = alleRegels.find(r => r.startsWith(OUD));
  console.log('    de oude storing:', regelOud);
  const redenCel = regelOud.split('\t')[6];
  check('alle redenen staan in één cel', redenCel.split('; ').length, regel(OUD).redenen.length);
  check('met het detail erbij', /\+\d+d/.test(redenCel) && /\dx/.test(redenCel), true);

  console.log('\n--- markeren haalt de regel weg, met alle redenen tegelijk ---');
  await page.selectOption(`#werklijst-body .opvolging-select[data-order="${OUD}"]`, 'opgepakt');
  await page.waitForTimeout(600);
  const na = await page.evaluate(() => buildWerklijst());
  check('de regel is weg', na.rijen.some(r => r.order === OUD), false);
  check('en wordt als verborgen geteld', na.opvolgingVerborgen, 1);
  check('de tellingen per reden dalen mee',
    na.tellingen.voorbijgestreefd, w.tellingen.voorbijgestreefd - 1);

  console.log('\n--- blokkeren doet hetzelfde, maar telt apart ---');
  await page.selectOption(`#table-all .ov-block-select[data-order="${VERLOPEN}"]`, 'aanleg');
  await page.waitForTimeout(600);
  const na2 = await page.evaluate(() => buildWerklijst());
  check('ook die regel is weg', na2.rijen.some(r => r.order === VERLOPEN), false);
  check('geteld als geblokkeerd', na2.geblokkeerd, 1);
  check('en niet als gemarkeerd', na2.opvolgingVerborgen, 1);

  console.log('\n--- in de gedeelde export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-werklijst.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(700);
  check('export: dezelfde regels', await exp.evaluate(() => buildWerklijst().rijen.length), na2.rijen.length);
  check('export: wel te filteren', await exp.$$eval('#werklijst-body [data-werk-reden]', e => e.length > 0), true);
  check('export: geen bediening om te markeren', await exp.$$eval('#werklijst-body .opvolging-select', e => e.length), 0);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-0/werklijst.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
