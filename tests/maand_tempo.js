const { chromium } = require('playwright');

// Instroom per maand, en de betrouwbaarheid van het benodigd tempo.
//
// De fixture is zo gebouwd dat de uitkomst vooraf vaststaat:
//   juni  (5 meetdagen, 2 t/m 30 juni, 28 dagen gemeten): 6 nieuw, 2 opgelost
//   juli  (5 meetdagen, 7 t/m 28 juli,  28 dagen gemeten): 2 nieuw, 1 opgelost,
//          plus 1 terugkeerder (order die in juni even weg was en terugkomt)
// Juni is dus de drukke maand, juli de rustige — met één instroom in juli die
// geen echt nieuw werk is.

const OV = 'Stra[a]t[en] zonder OV Infra';
const blok = (order, dagen) => `${OV}
Leiden | Teststraat ${order.slice(-2)} | 2312 KR
Order:
${order}
Asset:
${order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
Nog ${dagen} dagen
Datum uitvoering onbekend`;

const o = (n) => '9700000' + String(100 + n);

// Per meetdag welke ordernummers open staan.
const DAGEN = [
  ['2026-06-02', [1, 2]],
  ['2026-06-09', [1, 2, 3]],            // +3
  ['2026-06-16', [1, 3, 4, 5]],         // +4 +5, -2
  ['2026-06-23', [1, 3, 4, 5, 6]],      // +6
  ['2026-06-30', [1, 4, 5, 6, 7, 8]],   // +7 +8, -3
  ['2026-07-07', [1, 4, 5, 6, 7, 8, 9]],      // +9
  ['2026-07-14', [1, 4, 5, 6, 7, 8, 9]],
  ['2026-07-21', [1, 4, 5, 6, 7, 8, 9, 3]],   // 3 komt terug (was in juni weg)
  ['2026-07-28', [1, 4, 5, 6, 7, 8, 9]],      // -3 weer weg
];
// juni: instroom 3,4,5,6,7,8 = 6 (allemaal nieuw), uitstroom 2,3 = 2, 28 dagen
// juli: instroom 9 (nieuw) + 3 (terug) = 2, uitstroom 3 = 1, 28 dagen
const VERWACHT = {
  juni: { in: 6, nieuw: 6, uit: 2, dagen: 28 },
  juli: { in: 2, nieuw: 1, uit: 1, dagen: 28 },
};
const perWeek = (n, d) => ((n / d) * 7).toFixed(1);

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

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(150);

  for (const [datum, nrs] of DAGEN) {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + nrs.map(n => blok(o(n), 40)).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(200);
  }

  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(600);

  console.log('--- maandtabel ---');
  const rij = async (label) => page.$$eval('#maand-tempo-body tbody tr', (trs, l) => {
    const tr = trs.find(t => t.cells[0].textContent.trim().startsWith(l));
    return tr ? Array.from(tr.cells).map(c => c.textContent.replace(/\s+/g, ' ').trim()) : null;
  }, label);

  const juni = await rij('juni 2026');
  console.log('   juni:', juni && juni.join(' | '));
  check('juni instroom per week', juni && juni[2], perWeek(VERWACHT.juni.in, VERWACHT.juni.dagen));
  check('juni waarvan nieuw', juni && juni[3], perWeek(VERWACHT.juni.nieuw, VERWACHT.juni.dagen));
  check('juni opgelost per week', juni && juni[4], perWeek(VERWACHT.juni.uit, VERWACHT.juni.dagen));

  const juli = await rij('juli 2026');
  console.log('   juli:', juli && juli.join(' | '));
  check('juli instroom per week', juli && juli[2], perWeek(VERWACHT.juli.in, VERWACHT.juli.dagen));
  check('juli waarvan nieuw (terugkeerder telt niet mee)', juli && juli[3], perWeek(VERWACHT.juli.nieuw, VERWACHT.juli.dagen));
  check('juli opgelost per week', juli && juli[4], perWeek(VERWACHT.juli.uit, VERWACHT.juli.dagen));

  // Juni is 3x zo druk als juli; dat hoort in de kop te staan.
  const kop = await page.$eval('#maand-tempo-body .prognose-headline', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   kop:', kop);
  check('kop noemt de drukste maand', /juni 2026/.test(kop), true);
  check('kop noemt de rustigste maand', /juli 2026/.test(kop), true);
  check('kop waarschuwt dat één gemiddelde tekortschiet', /factor 3\.0/.test(kop), true);

  console.log('\n--- betrouwbaarheid van het benodigd tempo ---');
  const noot = await page.$eval('#tempo-body p.muted.small', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', noot);
  check('legt uit dat benodigd tempo de instroom is', /"Benodigd tempo" is de gemeten instroom/.test(noot), true);
  check('benoemt dat de achterstand er niet in zit', /achterstand die er al ligt zit er niet in/.test(noot), true);
  check('rekent de voorraadbeweging na', /Narekening/.test(noot), true);
  check('en die narekening klopt', /Dat klopt/.test(noot), true);

  // Het venster is 8 weken; daarin valt de terugkeerder, dus de waarschuwing
  // over terugkeerders hoort te verschijnen.
  check('waarschuwt over terugkeerders in de instroom', /bestaat uit ordernummers die er eerder al stonden/.test(noot), true);

  const instroomTegel = await page.$$eval('#tempo-body .tempo-stat', els => {
    const e = els.find(x => x.querySelector('.label').textContent.includes('instroom'));
    return e ? e.textContent.replace(/\s+/g, ' ').trim() : null;
  });
  console.log('   tegel:', instroomTegel);
  check('tegel splitst nieuw en terug', /nieuw,.*terug/.test(instroomTegel), true);

  await page.screenshot({ path: 'maand_tempo.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
