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
//
// Daarnaast de vraag waar de periodekaart over gaat: hoeveel heeft er over de
// HELE meetperiode stilgestaan? Daarvoor raakt A op 15 juli geblokkeerd op de
// Aannemerij en is dat op 20 juli weer opgeheven. Die blokkade is in geen enkele
// momentopname van nu meer te zien, maar heeft wel 5 dagen gekost.
//
//   A: Aannemerij,  15 jul -> 20 jul = 5 dagen,  opgeheven
//   F: Naar Aanleg,  5 jun -> (nu)   = 45 dagen, loopt nog (5 jun -> 20 jul)
//
// Verwacht op de periodekaart:
//   2 van de 6 storingen ooit geblokkeerd (33%), samen 50 wachtdagen
//   nu nog geblokkeerd: 1  |  weer vrijgegeven en nog open: 1
//   openstaande dagen: 6*2 + 6*2 + 6*40 + 6*5 = 294, dus 50/294 = 17%
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
const ALLE = ['A', 'B', 'C', 'D', 'E', 'F'];
// Per meetdag: de statussen, en welke blokkades VOORAF worden gezet of
// opgeheven — want de reden wordt meegeschreven op het moment van plakken.
// Zet je 'm erna, dan belandt 'ie pas in de volgende momentopname; dat is
// precies de fout die deze test in een eerdere opzet aan het licht bracht.
const DAGEN = [
  ['2026-06-01', { 'In onderzoek': ALLE }, []],
  ['2026-06-03', { 'In voorbereiding': ['A', 'B', 'C', 'D', 'E'], 'In onderzoek': ['F'] }, []],
  ['2026-06-05', { 'In voorbereiding': ['A', 'B', 'C', 'D', 'E'], 'In onderzoek': ['F'] }, [['F', 'aanleg']]],
  ['2026-07-15', { 'In voorbereiding': ALLE }, [['A', 'rezap']]],
  ['2026-07-20', { 'In voorbereiding': ALLE }, [['A', '']]],
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

  // Blokkades worden via de echte UI gezet (de keuzelijst in de volledige
  // lijst), niet door in de state te prikken: dan loopt de test door dezelfde
  // weg als Joep en wordt het meeschrijven in de momentopname echt getest.
  const zetBlokkade = async (order, reden) => {
    await page.click('.tab-btn[data-tab="data"]');
    await page.waitForTimeout(450);
    const sel = `#table-all .ov-block-select[data-order="${order}"]`;
    await page.waitForSelector(sel);
    await page.selectOption(sel, reden);
    await page.waitForTimeout(450);
    console.log(`    ${order}: ${reden ? 'blokkade "' + reden + '" gezet' : 'blokkade opgeheven'}`);
  };

  for (const [datum, groepen, acties] of DAGEN) {
    for (const [k, reden] of acties) await zetBlokkade(ORDERS[k], reden);
    await plak(gebiedLijst(groepen), datum);
    await plak(statusLijst(groepen), datum);
  }
  check('tegel Geblokkeerd staat op 1', await page.$eval('[data-stat-key="geblokkeerd"] .value', e => e.textContent.trim()), 1);

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

  console.log('\n--- de periodekaart op Data: niet de stand van nu, maar de hele periode ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(700);
  check('kaart is zichtbaar', await page.$eval('#blokkade-overzicht-card', e => !e.classList.contains('hidden')), true);
  check('teller staat op het aantal ooit geblokkeerd', await page.$eval('#blokkade-overzicht-count', e => e.textContent.trim()), 2);

  // Eerst de kale getallen narekenen tegen de hand-berekening in de kop van
  // dit bestand, daarna of de kaart ze ook zo opschrijft.
  const p = await page.evaluate(() => buildBlokkadePeriode());
  console.log('    ooit geblokkeerd:', p.ooitGeblokkeerd, '| gezien:', p.gezienTotaal,
    '| wachtdagen:', p.wachtdagen, '| openstaande dagen:', p.openDagen,
    '| nu:', p.nuGeblokkeerd, '| vrijgegeven:', p.inmiddelsVrij);
  check('twee storingen hebben ooit stilgestaan', p.ooitGeblokkeerd, 2);
  check('op zes storingen in totaal', p.gezienTotaal, 6);
  check('twee blokkades', p.episodes.length, 2);
  check('samen 50 wachtdagen (5 + 45)', p.wachtdagen, 50);
  check('294 openstaande dagen als noemer', p.openDagen, 294);
  check('nu nog geblokkeerd: 1', p.nuGeblokkeerd, 1);
  check('weer vrijgegeven en nog open: 1', p.inmiddelsVrij, 1);
  check('niets verdwenen terwijl geblokkeerd', p.verdwenenGeblokkeerd, 0);

  const aanleg = p.redenen.find(r => r.reden === 'aanleg');
  const rezap = p.redenen.find(r => r.reden === 'rezap');
  check('Naar Aanleg: 45 dagen', aanleg.wachtdagen, 45);
  check('Naar Aanleg loopt nog', aanleg.nuNog, 1);
  check('Aannemerij: 5 dagen', rezap.wachtdagen, 5);
  check('Aannemerij loopt niet meer', rezap.nuNog, 0);
  check('de opgeheven blokkade is nog steeds geteld', rezap.storingen, 1);
  check('zwaarste reden staat vooraan', p.redenen[0].reden, 'aanleg');

  const bo = await page.$eval('#blokkade-overzicht-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', bo.slice(0, 230));
  check('kop noemt het aandeel storingen', /hebben er 2 op een of ander moment stilgestaan/.test(bo), true);
  check('en het percentage', /33% van alles wat voorbijkwam/.test(bo), true);
  check('kop noemt de wachtdagen', /Samen 50 wachtdagen/.test(bo), true);
  check('en het aandeel van de openstaande tijd', /17% van alle tijd dat er werk open stond/.test(bo), true);
  check('de stand van nu staat er als bijzaak bij', /Stand nu: 1 storing staat er nu nog geblokkeerd, 1 is weer vrijgegeven en nog open/.test(bo), true);
  check('beide redenen staan in de tabel', /Aannemerij/.test(bo) && /Naar Aanleg/.test(bo), true);

  const tekst = await page.evaluate(() => buildBlokkadeText());
  console.log('\n--- terugkoppeling voor de bouwers ---\n' + tekst.split('\n').map(r => '    ' + r).join('\n'));
  check('bericht noemt de periode', /periode 1 jun 2026 t\/m 20 jul 2026/.test(tekst), true);
  check('bericht noemt het aandeel', /2 van de 6 storingen \(33%\)/.test(tekst), true);
  check('bericht noemt de wachtdagen met aandeel', /50 wachtdagen \(17% van alle tijd/.test(tekst), true);
  check('bericht noemt de opgeheven blokkade', /Aannemerij: 1 storingen, 1 blokkades, 5 wachtdagen/.test(tekst), true);
  check('bericht noemt de langste wachtperiodes', /Langste wachtperiodes/.test(tekst), true);
  check('en markeert wat nog loopt', /loopt nog/.test(tekst), true);
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
  check('export: periodekaart telt dezelfde twee storingen', await exp.$eval('#blokkade-overzicht-count', e => e.textContent.trim()), 2);
  check('export: en dezelfde 50 wachtdagen', await exp.evaluate(() => buildBlokkadePeriode().wachtdagen), 50);
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
