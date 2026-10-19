// Geblokkeerde storingen staan stil om een reden die buiten het team ligt. Die
// wachttijd telt wél in kalenderdagen maar zegt niets over het eigen tempo, dus
// hoort niet in de gemeten doorlooptijd. Deze test bouwt een geval waarin het
// verschil groot en met de hand na te rekenen is.
//
// Zes storingen, allemaal op 1 juni in "In onderzoek":
//   A..E  ->  3 juni naar "In voorbereiding"   = 2 dagen per storing
//   F     ->  blijft staan, raakt geblokkeerd (Naar Aanleg) en gaat pas
//             15 juli naar "In voorbereiding"  = 44 dagen (30-1 + 15)
//
// Verwacht voor status "In onderzoek":
//   met uitsluiting   : 5 metingen, allemaal 2 dagen, 1 meting overgeslagen
//   zonder uitsluiting: 6 metingen, langste 44 dagen
//
// Dat is precies het scheve beeld waar het om gaat: één blokkade verdubbelt de
// langste meting ruim twintig keer.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const ORDERS = { A: '9870000001', B: '9870000002', C: '9870000003', D: '9870000004', E: '9870000005', F: '9870000006' };
const GEBLOKKEERD = ORDERS.F;

const blok = (order) => `${OV}
Leiden | Teststraat ${order.slice(-2)} | 2312 KR
Order:
${order}
Asset:
${order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
Nog 60 dagen
Datum uitvoering onbekend`;

// Per meetdag: welke orders in welke status staan.
const DAGEN = [
  ['2026-06-01', { 'In onderzoek': ['A', 'B', 'C', 'D', 'E', 'F'] }],
  ['2026-06-03', { 'In voorbereiding': ['A', 'B', 'C', 'D', 'E'], 'In onderzoek': ['F'] }],
  // hierna wordt de blokkade gezet
  ['2026-06-05', { 'In voorbereiding': ['A', 'B', 'C', 'D', 'E'], 'In onderzoek': ['F'] }],
  ['2026-07-15', { 'In voorbereiding': ['A', 'B', 'C', 'D', 'E', 'F'] }],
];

const statusLijst = (groepen) => Object.entries(groepen)
  .map(([st, ks]) => st + '\n' + ks.map(k => blok(ORDERS[k])).join('\n')).join('\n');
const gebiedLijst = (groepen) => 'ZZE5A\n' + Object.values(groepen).flat().map(k => blok(ORDERS[k])).join('\n');

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
  const plak = async (tekst, datum) => {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', tekst);
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(220);
  };
  // De metingen per status direct uit de app, zodat de narekening op dezelfde
  // getallen gaat als de boxplot tekent.
  const metingen = () => page.evaluate(() => {
    const { metingenPerStatus, overgeslagen } = buildStatusDuurStats();
    const w = (metingenPerStatus['In onderzoek'] || []).slice().sort((a, b) => a - b);
    return { waarden: w, overgeslagen: (overgeslagen || {})['In onderzoek'] || 0 };
  });

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(150);

  for (const [i, [datum, groepen]] of DAGEN.entries()) {
    await plak(gebiedLijst(groepen), datum);
    await plak(statusLijst(groepen), datum);
    // Na de tweede meetdag de blokkade zetten, via de echte UI: vanaf dat
    // moment wordt de reden meegeschreven in elke nieuwe momentopname.
    if (i === 1) {
      console.log('--- blokkade "Naar Aanleg" zetten op ' + GEBLOKKEERD + ' ---');
      await page.click('.tab-btn[data-tab="data"]');
      await page.waitForTimeout(500);
      const sel = `#table-all .ov-block-select[data-order="${GEBLOKKEERD}"]`;
      await page.waitForSelector(sel);
      await page.selectOption(sel, 'aanleg');
      await page.waitForTimeout(500);
      check('tegel Geblokkeerd staat op 1', await page.$eval('[data-stat-key="geblokkeerd"] .value', e => e.textContent.trim()), 1);
    }
  }

  console.log('\n--- metingen voor "In onderzoek" met uitsluiting (standaard) ---');
  const m1 = await metingen();
  console.log('    waarden:', JSON.stringify(m1.waarden), '| overgeslagen:', m1.overgeslagen);
  check('vijf metingen over', m1.waarden.length, 5);
  check('allemaal 2 dagen', m1.waarden.join(','), '2,2,2,2,2');
  check('de geblokkeerde meting is overgeslagen', m1.overgeslagen, 1);

  console.log('\n--- de boxplot meldt wat is weggelaten ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(700);
  const noot = await page.$eval('#boxplot-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('noemt de weggelaten meting', /Eén meting is weggelaten omdat de storing in die periode geblokkeerd stond/.test(noot), true);
  check('en noemt de uitgesloten redenen', /Naar Aanleg/.test(noot), true);

  console.log('\n--- "Te lang onderweg" laat de geblokkeerde storing weg ---');
  const stagnatie = await page.$eval('#stagnatie-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  const stagnatieOrders = await page.$$eval('#stagnatie-body tbody tr', trs => trs.map(t => t.textContent));
  check('de geblokkeerde order staat niet in de lijst', stagnatieOrders.some(t => t.includes(GEBLOKKEERD)), false);
  check('maar de kaart meldt dat die is weggelaten', /1 storing staat geblokkeerd en is hier weggelaten/.test(stagnatie), true);

  console.log('\n--- de voorraadkaart zet geblokkeerd in een eigen kolom ---');
  const koppen = await page.$$eval('#doorstroom-body thead th', ths => ths.map(t => t.textContent.trim()));
  check('kolom Geblokkeerd bestaat', koppen.includes('Geblokkeerd'), true);

  console.log('\n--- het blokkade-overzicht op Data ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(700);
  check('kaart is zichtbaar', await page.$eval('#blokkade-overzicht-card', e => !e.classList.contains('hidden')), true);
  check('teller staat op 1', await page.$eval('#blokkade-overzicht-count', e => e.textContent.trim()), 1);
  const bo = await page.$eval('#blokkade-overzicht-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', bo.slice(0, 160));
  check('noemt het aandeel van de werkvoorraad', /1 van de 6 openstaande storingen staat geblokkeerd/.test(bo), true);
  check('noemt de reden', /Naar Aanleg/.test(bo), true);
  check('en zegt dat die niet meetelt', /nee/.test(bo), true);

  const tekst = await page.evaluate(() => buildBlokkadeText());
  console.log('\n--- terugkoppeling voor de bouwers ---\n' + tekst.split('\n').map(r => '    ' + r).join('\n'));
  check('bericht noemt de order', tekst.includes(GEBLOKKEERD), true);
  check('bericht noemt de reden', /Naar Aanleg: 1x/.test(tekst), true);
  check('bericht bevat geen namen', /Piet Poot|Marc van Veen/.test(tekst), false);
  check('bericht bevat geen adressen', /Teststraat/.test(tekst), false);

  console.log('\n--- zet de uitsluiting uit: dan komt de scheve meting terug ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(400);
  await page.uncheck('#blokkade-uitsluiten-body input[data-blokkade-reden="aanleg"]');
  await page.click('#blokkade-save-btn');
  await page.waitForTimeout(700);
  const m2 = await metingen();
  console.log('    waarden:', JSON.stringify(m2.waarden), '| overgeslagen:', m2.overgeslagen);
  check('zes metingen', m2.waarden.length, 6);
  check('en de langste is 44 dagen', m2.waarden[m2.waarden.length - 1], 44);
  check('niets meer overgeslagen', m2.overgeslagen, 0);
  // Zonder uitsluiting volgt de voorraadkaart dezelfde regel: de storing telt
  // dan weer gewoon mee in de opgehoopte wachttijd in plaats van in de
  // aparte kolom.
  check('de voorraadkaart zet de blokkade nu niet meer apart',
    await page.evaluate(() => buildDoorstroomStats().reduce((n, r) => n + r.geblokkeerd, 0)), 0);
  check('en "Te lang onderweg" laat de storing weer meetellen',
    await page.evaluate(() => buildTeLangInStatus().geblokkeerdOvergeslagen), 0);

  console.log('\n--- en weer aan ---');
  await page.check('#blokkade-uitsluiten-body input[data-blokkade-reden="aanleg"]');
  await page.click('#blokkade-save-btn');
  await page.waitForTimeout(700);
  const m3 = await metingen();
  check('terug naar vijf metingen', m3.waarden.length, 5);
  check('instelling blijft bewaard na herladen', await (async () => {
    await page.reload();
    await page.waitForTimeout(900);
    return page.evaluate(() => (state.blokkadeUitsluiten || []).join(','));
  })(), 'rezap,aanleg,uitvoerder,onderzoek');

  console.log('\n--- de gedeelde export rekent met dezelfde uitsluiting ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(400);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-blokkade.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(600);
  check('export: dezelfde vijf metingen', await exp.evaluate(() => (buildStatusDuurStats().metingenPerStatus['In onderzoek'] || []).length), 5);
  check('export: blokkade-overzicht staat erin', await exp.$eval('#blokkade-overzicht-count', e => e.textContent.trim()), 1);
  await exp.click('.tab-btn[data-tab="prognose"]');
  await exp.waitForTimeout(400);
  const expNoot = await exp.$eval('#boxplot-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('export: verwijst niet naar een Instellingen-tab die er niet is',
    /Welke blokkade-redenen niet meetellen is een instelling bij degene die dit gedeeld heeft/.test(expNoot), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
