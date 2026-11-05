// Het dashboard weet alleen wat er geplakt is. Dat geeft twee vertekeningen in
// de duur per processtap, en deze test legt allebei de oplossingen vast.
//
// 1. HET WEEKEND. Er wordt op werkdagen geplakt, dus vrijdag -> maandag is
//    altijd een gat van drie kalenderdagen. Een stap die één werkdag duurt
//    mat daardoor als drie — en juist de korte stappen hebben een norm van
//    één dag. Oplossing: de duur per stap in werkdagen.
//
// 2. VAKANTIE EN VRIJE DAGEN. Loopt een statusperiode over een gat van
//    meerdere werkdagen, dan weet je niet wanneer de wissel plaatsvond; je
//    weet alleen dat het hooguit zoveel was. Zo'n bovengrens hoort niet als
//    feit in een boxplot. Oplossing: die metingen standaard weglaten, en
//    zeggen hoeveel het er zijn.
//
// Alle datums hieronder zijn met de hand nagelopen:
//   2026-10-15 do   2026-10-16 vr   2026-10-19 ma   2026-10-20 di
//   2026-10-21 wo   2026-10-30 vr
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

const A = '9990000001'; // wisselt over het weekend heen
const B = '9990000002'; // wisselt doordeweeks
const C = '9990000003'; // wisselt over een vakantiegat heen

// Per meetdag per status welke orders erop staan. Tussen 21 en 30 oktober zit
// een gat van zes werkdagen: de vakantie.
const DAGEN = [
  ['2026-10-15', { 'Nieuw': [A, B, C] }],
  ['2026-10-16', { 'Nieuw': [A, C], 'In onderzoek': [B] }],          // B: do->vr = 1 werkdag
  ['2026-10-19', { 'In onderzoek': [A, B], 'Nieuw': [C] }],          // A: do->ma = 2 werkdagen, 4 kalenderdagen
  ['2026-10-20', { 'In onderzoek': [A, B], 'Nieuw': [C] }],
  ['2026-10-21', { 'In onderzoek': [A, B], 'Nieuw': [C] }],
  // --- vakantie: 22 okt t/m 29 okt niet geplakt ---
  ['2026-10-30', { 'In onderzoek': [A, B, C] }],                     // C: over het gat heen
];

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
  const metingen = (status) => page.evaluate((st) => {
    const r = buildStatusDuurStats();
    return {
      waarden: (r.metingenPerStatus[st] || []).slice().sort((a, b) => a - b),
      gatWeg: (r.gatOvergeslagen || {})[st] || 0,
    };
  }, status);

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(200);

  // Eén plakactie per meetdag met alle statusgroepen erin. Apart plakken per
  // status zou niet werken: binnen dezelfde dag vervangt de laatste plakactie
  // van dezelfde lijstsoort de vorige, dus alleen de laatste groep zou
  // overblijven.
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

  console.log('--- 1. het weekend telt niet meer mee ---');
  const nieuw = await metingen('Nieuw');
  console.log('    "Nieuw":', JSON.stringify(nieuw.waarden), '| weggelaten door een gat:', nieuw.gatWeg);
  // B stond donderdag op Nieuw en vrijdag op In onderzoek: 1 werkdag, en ook
  // 1 kalenderdag. A stond donderdag op Nieuw en maandag op In onderzoek:
  // 2 werkdagen (vrijdag en maandag), maar 4 kalenderdagen. Dat verschil is
  // precies het weekend, en dat telt nu niet meer mee.
  check('twee metingen', nieuw.waarden.length, 2);
  check('de doordeweekse overgang is 1 werkdag', nieuw.waarden[0], 1);
  check('en die over het weekend 2 in plaats van 4', nieuw.waarden[1], 2);
  check('in kalenderdagen zou dat 4 zijn geweest',
    await page.evaluate(() => dagenTussen('2026-10-15', '2026-10-19')), 4);

  console.log('\n--- 2. de meting over het vakantiegat valt weg ---');
  // C stond van 15 okt tot 30 okt op "Nieuw", met een gat van 22 t/m 29 okt.
  // Die meting is geen feit maar een bovengrens, dus telt niet mee.
  check('en die is als overgeslagen geteld', nieuw.gatWeg, 1);

  console.log('\n--- het gat is als zodanig herkend ---');
  const g = await page.evaluate(() => buildMeetGaten());
  g.gaten.forEach(x => console.log(`    ${x.van} → ${x.tot}: ${x.gemist} werkdagen gemist (${x.kalenderdagen} kalenderdagen)`));
  check('precies één gat', g.gaten.length, 1);
  check('van 21 naar 30 oktober', `${g.gaten[0].van} → ${g.gaten[0].tot}`, '2026-10-21 → 2026-10-30');
  // 22, 23, 26, 27, 28, 29 oktober zijn werkdagen; 30 oktober is de meetdag zelf.
  check('zes werkdagen gemist', g.gaten[0].gemist, 6);
  check('weekenden tellen niet als gat', g.gaten.some(x => x.van === '2026-10-16'), false);

  console.log('\n--- zet de uitsluiting uit: dan komt de onzekere meting terug ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  await page.uncheck('#gaten-uitsluiten');
  await page.waitForTimeout(700);
  const zonder = await metingen('Nieuw');
  console.log('    "Nieuw":', JSON.stringify(zonder.waarden), '| weggelaten:', zonder.gatWeg);
  check('nu drie metingen', zonder.waarden.length, 3);
  // 15 okt -> 30 okt: 16, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30 = 11 werkdagen.
  check('de onzekere meting is elf werkdagen', zonder.waarden[2], 11);
  check('niets meer overgeslagen', zonder.gatWeg, 0);
  check('en dat is precies de uitschieter die stagnatie lijkt', zonder.waarden[2] > zonder.waarden[1] * 5, true);
  await page.check('#gaten-uitsluiten');
  await page.waitForTimeout(700);
  check('weer aan: terug naar twee metingen', (await metingen('Nieuw')).waarden.length, 2);

  console.log('\n--- de kaart laat de gaten zien ---');
  const kaart = await page.$eval('#meetgaten-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', kaart.slice(0, 180));
  check('noemt het aantal gaten', /is er 1 gat in de metingen/.test(kaart), true);
  check('en hoeveel werkdagen er gemist zijn', /samen 6 werkdagen niet geplakt/.test(kaart), true);
  check('en de dekking', /Dekking: \d+%/.test(kaart), true);

  console.log('\n--- de boxplot meldt wat er is weggelaten ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(700);
  const noot = await page.$eval('#boxplot-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('meldt de weggelaten meting', /weggelaten omdat de periode over een meetgat liep/.test(noot), true);
  check('en legt uit waarom', /geen feit maar een bovengrens/.test(noot), true);
  check('met een weg naar de meetgaten', /Bekijk de meetgaten/.test(noot), true);

  console.log('\n--- de eenheid staat erbij ---');
  const kop = await page.$eval('#boxplot-card h2', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', kop);
  check('de boxplotkop noemt werkdagen', /in werkdagen/.test(kop), true);

  console.log('\n--- het hele traject blijft in kalenderdagen ---');
  // Dat is bewust: een klant staat in het weekend ook in het donker.
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const normTekst = await page.$eval('#status-streef-card', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('traject in kalenderdagen', /hele traject[^.]*in kalenderdagen/.test(normTekst), true);
  check('per status in werkdagen', /norm per status, in werkdagen/.test(normTekst), true);

  console.log('\n--- de instelling blijft bewaard en gaat mee in de export ---');
  await page.reload();
  await page.waitForTimeout(1000);
  check('na herladen nog aan', await page.evaluate(() => state.gatenUitsluiten), true);
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(400);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-meetgaten.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(700);
  check('export: dezelfde twee metingen',
    await exp.evaluate(() => (buildStatusDuurStats().metingenPerStatus['Nieuw'] || []).length), 2);
  check('export: verwijst niet naar een instelling die er niet is',
    await exp.evaluate(() => meetGatLink().includes('<button')), false);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
