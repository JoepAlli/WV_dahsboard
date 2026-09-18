// Twee getallen op de kaart Benodigd tempo heten allebei "per week" maar
// worden tegen iets anders afgezet:
//   - "je loopt X per week achter"  = instroom versus wat je FEITELIJK afsluit
//   - "X te kort"                   = instroom versus de INGEVULDE capaciteit
// Verschillen die twee, dan lijken de tekorten elkaar tegen te spreken terwijl
// ze allebei kloppen. Deze test bouwt precies dat geval na en controleert dat
// de kaart het verschil benoemt in plaats van het te laten raden.
//
// De fixture: 4 meetdagen van 7 dagen, dus 3 overgangen over 21 dagen.
//   instroom 15 in 21 dagen -> 15/21*7 = 5.0 per week
//   opgelost  9 in 21 dagen ->  9/21*7 = 3.0 per week
//   netto                                 2.0 per week achter
// Capaciteit ingevuld: 1 per week. Dan is het tekort op papier 5.0 - 1 = 4.0,
// terwijl de gemeten achterstand 2.0 is — hetzelfde patroon als 8.0 naast 15.8.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const blok = (order) => `${OV}
Leiden | Teststraat ${order.slice(-2)} | 2312 KR
Order:
${order}
Asset:
${order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
Nog 40 dagen
Datum uitvoering onbekend`;
const o = (n) => '9900000' + String(100 + n);

// Per meetdag welke ordernummers open staan. Elke overgang: 5 erbij, 3 eraf.
const DAGEN = [
  ['2026-06-01', [1, 2, 3, 4, 5, 6]],
  ['2026-06-08', [4, 5, 6, 7, 8, 9, 10, 11]],        // +7..11 (5), -1..3 (3)
  ['2026-06-15', [7, 8, 9, 10, 11, 12, 13, 14, 15, 16]], // +12..16 (5), -4..6 (3)
  ['2026-06-22', [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]], // +17..21 (5), -7..9 (3)
];
const VERWACHT = { instroomPW: '5.0', opgelostPW: '3.0', achterPW: '2.0', capaciteit: 1, tekortPW: '4.0', open: 12 };

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
  await page.waitForTimeout(150);

  for (const [datum, nrs] of DAGEN) {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + nrs.map(n => blok(o(n))).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(200);
  }

  console.log('--- zonder ingevulde capaciteit ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(600);
  const kop = () => page.$eval('#tempo-body .prognose-headline', e => e.textContent.replace(/\s+/g, ' ').trim());
  const eerste = await kop();
  console.log('   ', eerste);
  check('kop noemt de instroom', eerste.includes(`${VERWACHT.instroomPW} storingen per week bij`), true);
  check('kop noemt wat je feitelijk afsluit', eerste.includes(`je sluit er ${VERWACHT.opgelostPW} af`), true);
  check('kop noemt de achterstand', eerste.includes(`${VERWACHT.achterPW} per week achter`), true);

  console.log('\n--- met een capaciteit die lager ligt dan wat je feitelijk haalt ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(250);
  await page.fill('#cap-meetdienst', String(VERWACHT.capaciteit));
  await page.click('#cap-save-btn');
  await page.waitForTimeout(500);
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(500);

  const koppen = await page.$$eval('#tempo-body .prognose-headline', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  console.log('   papier:', koppen[1]);
  check('tweede regel is als "op papier" gemarkeerd', /^Op papier:/.test(koppen[1]), true);
  check('en noemt het tekort tegen de capaciteit', koppen[1].includes(`${VERWACHT.tekortPW} te kort`), true);

  const uitleg = await page.$eval('#tempo-body .warning-box', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   uitleg:', uitleg);
  check('legt uit dat de twee tekorten iets anders meten', /gaan over verschillende dingen/.test(uitleg), true);
  check('noemt wat je feitelijk afsluit', uitleg.includes(`feitelijk afsluit (${VERWACHT.opgelostPW} per week)`), true);
  check('noemt de ingevulde capaciteit', uitleg.includes(`ingevuld (${VERWACHT.capaciteit} per week)`), true);
  check('noemt het verschil tussen beide', /2.0 per week méér af dan je capaciteit zegt/.test(uitleg), true);
  check('wijst aan welk getal je werkelijk ziet', uitleg.includes(`${VERWACHT.achterPW} per week`), true);
  check('en biedt een weg naar de instelling', /Capaciteit bijstellen/.test(uitleg), true);

  console.log('\n--- knop springt naar de capaciteitsinstelling ---');
  await page.click('#tempo-body .warning-box [data-goto-instelling="capaciteit-card"]');
  await page.waitForTimeout(400);
  check('opent Instellingen', await page.$eval('#section-settings', e => !e.classList.contains('hidden')), true);
  check('met de cursor in het capaciteitsveld', await page.evaluate(() => document.activeElement.id), 'cap-meetdienst');

  console.log('\n--- capaciteit gelijk aan wat je haalt: geen uitleg meer nodig ---');
  await page.fill('#cap-meetdienst', '3');
  await page.click('#cap-save-btn');
  await page.waitForTimeout(500);
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(500);
  check('waarschuwing verdwijnt als de getallen kloppen', await page.$$eval('#tempo-body .warning-box', e => e.length), 0);
  const koppen2 = await page.$$eval('#tempo-body .prognose-headline', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  check('en het papieren tekort is nu gelijk aan de gemeten achterstand',
    koppen2[1].includes(`${VERWACHT.achterPW} te kort`), true);

  await page.screenshot({ path: '/tmp/claude-0/tempo_uitleg.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
