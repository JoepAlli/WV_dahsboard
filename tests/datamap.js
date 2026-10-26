// De datamap haalt de data uit dit ene browserprofiel. Daarmee verdwijnt het
// grootste risico (één keer "browsergegevens wissen" en de historie is weg) —
// maar er komt een nieuw risico voor terug: bij het opstarten moet worden
// gekozen welke kant de waarheid is, de map of de browser. Kiest die verkeerd,
// dan gooi je stilletjes historie weg.
//
// Deze test bewaakt precies die keuze. De mapkiezer zelf is een venster van
// Windows dat niet aan te sturen is; daarom wordt er een nepmap in de pagina
// gezet die zich gedraagt als de echte (getFileHandle / createWritable /
// getFile / queryPermission). Alles wat daarna gebeurt is de echte code.
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
Nog 60 dagen
Datum uitvoering onbekend`;
const order = (n) => '9940000' + String(100 + n);

// Een map die zich gedraagt als een echte, met instelbare toestemming.
const NEPMAP = `(naam, bestanden, toestemming) => {
  const store = Object.assign({}, bestanden || {});
  return {
    name: naam,
    _store: store,
    queryPermission: async () => toestemming || 'granted',
    requestPermission: async () => toestemming || 'granted',
    getFileHandle: async (n, opts) => {
      if (!(n in store)) {
        if (!opts || !opts.create) { const e = new Error('ontbreekt'); e.name = 'NotFoundError'; throw e; }
        store[n] = '';
      }
      return {
        getFile: async () => ({ text: async () => store[n] }),
        createWritable: async () => ({
          write: async (t) => { store[n] = t; },
          close: async () => {},
        }),
      };
    },
  };
}`;

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
  const plak = async (aantal, datum) => {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + Array.from({ length: aantal }, (_, i) => blok(order(i))).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(300);
  };
  // Een nepmap koppelen en de opstart-synchronisatie draaien, net als de app.
  const koppel = (bestanden, toestemming) => page.evaluate(async ([maker, best, perm]) => {
    const nep = eval(maker);
    state.dataMap.handle = nep('Testmap', best, perm);
    state.dataMap.naam = 'Testmap';
    state.dataMap.fout = null;
    const uitkomst = await mapSynchroniseerBijStart();
    state.dataMap.bronBijStart = uitkomst ? uitkomst.uitkomst : null;
    renderDataMapCard();
    return { uitkomst, snapshots: state.snapshots.length, fout: state.dataMap.fout };
  }, [NEPMAP, bestanden || {}, toestemming || 'granted']);
  const mapInhoud = () => page.evaluate(() => {
    const s = state.dataMap.handle._store;
    const lees = (n) => s[n] ? JSON.parse(s[n]) : null;
    return { data: lees('nusdash-data.json'), inst: lees('nusdash-instellingen.json') };
  });

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(200);

  console.log('--- zonder koppeling verandert er niets ---');
  await plak(5, '2026-10-01');
  await plak(5, '2026-10-02');
  check('twee updates lokaal', await page.evaluate(() => state.snapshots.length), 2);
  check('de kaart biedt een map aan', await page.$$eval('#datamap-koppel-btn', e => e.length), 1);

  console.log('\n--- lege map koppelen: de lokale stand vult de map ---');
  let r = await koppel({});
  console.log('    uitkomst:', r.uitkomst.uitkomst);
  check('uitkomst is "map gevuld"', r.uitkomst.uitkomst, 'map-gevuld');
  check('lokaal is niets veranderd', r.snapshots, 2);
  let inh = await mapInhoud();
  check('het databestand staat in de map', inh.data.ovSnapshots.length, 2);
  check('en het instellingenbestand ook', Array.isArray(inh.inst.typeWhitelist), true);
  check('met het type-filter erin', inh.inst.typeWhitelist.includes(OV), true);

  console.log('\n--- plakken schrijft door naar de map ---');
  await plak(5, '2026-10-03');
  await page.waitForTimeout(700);
  inh = await mapInhoud();
  check('de map heeft de nieuwe update', inh.data.ovSnapshots.length, 3);
  check('en de kaart meldt wanneer', await page.evaluate(() => !!state.dataMap.laatstGeschreven), true);

  console.log('\n--- een instelling wijzigen schrijft het kleine bestand ---');
  const voorInst = (await mapInhoud()).inst.doorlooptijdNorm;
  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#doorlooptijd-norm-input', '15');
  await page.click('#status-streef-save-btn');
  await page.waitForTimeout(1200);
  inh = await mapInhoud();
  console.log(`    norm in de map: ${voorInst} -> ${inh.inst.doorlooptijdNorm}`);
  check('de nieuwe norm staat in de map', inh.inst.doorlooptijdNorm, 15);
  check('en de momentopnamen zijn niet onnodig herschreven', inh.data.ovSnapshots.length, 3);

  console.log('\n--- de opvolger: lege browser, volle map ---');
  // Dit is het geval waar de overdracht op staat of valt.
  const mapBestanden = await page.evaluate(() => ({
    'nusdash-data.json': state.dataMap.handle._store['nusdash-data.json'],
    'nusdash-instellingen.json': state.dataMap.handle._store['nusdash-instellingen.json'],
  }));
  const page2 = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errs2 = [];
  page2.on('pageerror', e => errs2.push('pageerror: ' + e.message));
  await page2.goto('file:///home/user/WV_dahsboard/index.html');
  await page2.waitForTimeout(600);
  // Zelfde profiel, dus leegmaken om een verse laptop na te bootsen.
  await page2.evaluate(() => { state.snapshots = []; state.typeWhitelist = []; });
  const r2 = await page2.evaluate(async ([maker, best]) => {
    const nep = eval(maker);
    state.dataMap.handle = nep('Testmap', best, 'granted');
    const uitkomst = await mapSynchroniseerBijStart();
    return { uitkomst, snapshots: state.snapshots.length, norm: state.doorlooptijdNorm, types: state.typeWhitelist.length };
  }, [NEPMAP, mapBestanden]);
  console.log('    uitkomst:', r2.uitkomst.uitkomst);
  check('de map wint', r2.uitkomst.uitkomst, 'map-nieuwer');
  check('alle momentopnamen zijn overgenomen', r2.snapshots, 3);
  const inMap = JSON.parse(mapBestanden['nusdash-instellingen.json']);
  check('inclusief de instellingen', r2.norm, inMap.doorlooptijdNorm);
  check('en het type-filter precies zoals in de map', r2.types, inMap.typeWhitelist.length);
  check('dat is meer dan niets', inMap.typeWhitelist.length > 0, true);
  check('en lokaal vastgelegd als reservekopie',
    await page2.evaluate(async () => (await idbGet('nusdash_snapshots_v1') || []).length), 3);
  check('zonder paginafouten', errs2.join(' ') || 'geen', 'geen');
  if (errs2.length) fouten++;
  await page2.close();

  console.log('\n--- andersom: browser nieuwer dan de map ---');
  // De map bevat een oudere stand (2 updates); lokaal staan er 3.
  const ouderData = JSON.parse(mapBestanden['nusdash-data.json']);
  ouderData.ovSnapshots = ouderData.ovSnapshots.slice(0, 2);
  r = await koppel({
    'nusdash-data.json': JSON.stringify(ouderData),
    'nusdash-instellingen.json': mapBestanden['nusdash-instellingen.json'],
  });
  console.log('    uitkomst:', r.uitkomst.uitkomst);
  check('lokaal wint', r.uitkomst.uitkomst, 'lokaal-nieuwer');
  check('en er is lokaal niets verdwenen', r.snapshots, 3);
  inh = await mapInhoud();
  check('de map is bijgewerkt naar de volle stand', inh.data.ovSnapshots.length, 3);

  console.log('\n--- geen toestemming: niets kapot, wel gemeld ---');
  r = await koppel(mapBestanden, 'prompt');
  check('uitkomst is "geen toegang"', r.uitkomst.uitkomst, 'geen-toegang');
  check('de data staat er nog', r.snapshots, 3);
  check('en het wordt gemeld', r.fout, 'geen toegang');
  const kaart = await page.$eval('#datamap-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', kaart.slice(0, 120));
  check('met een knop om het te herstellen', /Map weer vrijgeven/.test(kaart), true);
  check('en de uitleg dat er niets kwijt is', /schrijft het dashboard alleen naar deze browser/.test(kaart), true);

  console.log('\n--- plakken blijft werken zonder toestemming ---');
  await plak(5, '2026-10-04');
  check('lokaal gewoon opgeslagen', await page.evaluate(() => state.snapshots.length), 4);
  check('en de melding staat er nog', await page.evaluate(() => state.dataMap.fout), 'geen toegang');

  console.log('\n--- ontkoppelen laat alles staan ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  await page.click('#datamap-ontkoppel-btn');
  await page.waitForTimeout(500);
  check('geen map meer gekoppeld', await page.evaluate(() => !!state.dataMap.handle), false);
  check('de data staat er nog', await page.evaluate(() => state.snapshots.length), 4);
  check('en de kaart biedt opnieuw een map aan', await page.$$eval('#datamap-koppel-btn', e => e.length), 1);

  console.log('\n--- in de gedeelde export is er niets te koppelen ---');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-datamap.html';
  await dl.saveAs(pad);
  const exp = await browser.newPage();
  const errsExp = [];
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(600);
  check('export: de kaart is verborgen', await exp.$eval('#datamap-card', e => e.classList.contains('hidden')), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
