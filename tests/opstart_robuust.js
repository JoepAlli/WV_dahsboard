// Het dashboard bevroor bij het opstarten: de pagina kwam op, maar er was
// niets te klikken en er stond geen data. Oorzaak: het aanzetten van de
// tabbladen gebeurde ná het laden van de gegevens, en dat laden wachtte op de
// datamap. Eén trage of onbereikbare OneDrive-map legde daarmee de hele tool
// plat — en juist dan kun je de koppeling niet meer losmaken, want daarvoor
// moet je kunnen klikken.
//
// Deze test bewaakt dat dat niet meer kan:
//   1. een map die blijft hangen mag het dashboard niet blokkeren
//   2. een fout tijdens het laden mag de navigatie niet meenemen
//   3. in beide gevallen moet er een zichtbare melding staan
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

// Een mapverwijzing die nooit antwoordt: precies wat een "alleen online"-
// bestand in OneDrive doet als de verbinding wegvalt.
const HANGENDE_MAP = `{
  name: 'Trage map',
  queryPermission: async () => 'granted',
  requestPermission: async () => 'granted',
  getFileHandle: () => new Promise(() => {}),
}`;

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  await page.goto('file:///home/user/WV_dahsboard/index.html');
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };
  const kanKlikken = async () => {
    await page.click('.tab-btn[data-tab="prognose"]');
    await page.waitForTimeout(350);
    const open = await page.$eval('#section-prognose', e => !e.classList.contains('hidden'));
    await page.click('.tab-btn[data-tab="data"]');
    await page.waitForTimeout(250);
    return open;
  };

  console.log('--- eerst gewoon data erin ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(200);
  for (const datum of ['2026-11-25', '2026-11-26']) {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + ['9820000001', '9820000002'].map(blok).join('\n'));
    await page.waitForTimeout(280);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(260);
  }
  check('twee updates opgeslagen', await page.evaluate(() => state.snapshots.length), 2);

  console.log('\n--- 1. een map die blijft hangen ---');
  // Een echte mapverwijzing is niet na te maken in de opslag (alleen
  // browserobjecten zijn op te slaan), dus wordt de laadfunctie vervangen.
  // Daarna wordt de synchronisatie gestart zoals bij het opstarten — en
  // bewust niet afgewacht: dit is precies de belofte die vroeger nooit
  // terugkwam en alles meenam.
  await page.evaluate((maker) => {
    window.loadMapHandle = async () => eval('(' + maker + ')');
    state.dataMap = { handle: null, naam: '', fout: null, laatstGeschreven: null, bronBijStart: null, bezig: false };
    synchroniseerDataMapBijStart();
  }, HANGENDE_MAP);
  await page.waitForTimeout(1200);

  check('de tabbladen werken gewoon', await kanKlikken(), true);
  check('en de data staat er', await page.$$eval('#table-all tbody tr', e => e.length), 2);
  check('de werklijst is getekend', await page.$eval('#werklijst-body', e => e.textContent.trim().length > 0), true);
  check('de mapkaart meldt de naam alvast', await page.evaluate(() => state.dataMap.naam), 'Trage map');

  console.log('\n--- de tijdslimiet die dat mogelijk maakt ---');
  const limiet = await page.evaluate(() => MAP_TIJDSLIMIET_MS);
  console.log('    tijdslimiet:', limiet / 1000, 'seconden');
  check('er is een tijdslimiet', limiet > 0 && limiet <= 60000, true);
  const afgebroken = await page.evaluate(async () => {
    try {
      await metTijdslimiet(new Promise(() => {}), 150, 'de map reageerde niet');
      return 'geen fout';
    } catch (e) { return e.message; }
  });
  check('een hangende belofte wordt afgebroken', afgebroken, 'de map reageerde niet');
  const klaar = await page.evaluate(async () => {
    try { return await metTijdslimiet(Promise.resolve('klaar'), 5000, 'x'); }
    catch (e) { return 'fout: ' + e.message; }
  });
  check('en een snelle belofte komt gewoon door', klaar, 'klaar');

  console.log('\n--- 2. een fout tijdens het laden ---');
  // Het laden laten mislukken en opnieuw door init() heen, zodat de echte
  // afhandeling wordt getest en niet een nagebouwde.
  await page.evaluate(async () => {
    document.getElementById('opstart-fout').classList.add('hidden');
    window.loadSnapshots = async () => { throw new Error('opslag onleesbaar'); };
    await init();
  });
  await page.waitForTimeout(400);
  check('de tabbladen werken nog steeds', await kanKlikken(), true);
  const melding = await page.$eval('#opstart-fout', e => ({
    zichtbaar: !e.classList.contains('hidden'),
    tekst: e.textContent.replace(/\s+/g, ' ').trim(),
  }));
  console.log('   ', melding.tekst);
  check('er staat een zichtbare melding', melding.zichtbaar, true);
  check('die zegt wat er mis is', /opslag onleesbaar/.test(melding.tekst), true);
  check('en waar je heen moet', /naar Instellingen/.test(melding.tekst), true);

  console.log('\n--- 3. normaal opstarten blijft schoon ---');
  const schoon = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errsS = [];
  schoon.on('pageerror', e => errsS.push('pageerror: ' + e.message));
  await schoon.goto('file:///home/user/WV_dahsboard/index.html');
  await schoon.waitForTimeout(800);
  check('geen foutbalk bij een gewone start',
    await schoon.$eval('#opstart-fout', e => e.classList.contains('hidden')), true);
  check('en de tabbladen werken', await (async () => {
    await schoon.click('.tab-btn[data-tab="historie"]');
    await schoon.waitForTimeout(300);
    return schoon.$eval('#section-historie', e => !e.classList.contains('hidden'));
  })(), true);
  check('zonder paginafouten', errsS.join(' ') || 'geen', 'geen');
  if (errsS.length) fouten++;
  await schoon.close();

  console.log(fouten === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 ? 0 : 1);
})();
