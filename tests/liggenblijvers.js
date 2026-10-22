// De blinde vlek die deze kaart dicht: het dashboard meet tempo en normen, en
// beide kunnen er goed uitzien terwijl de bak van september onaangeroerd blijft
// staan. Tien nieuwe storingen afsluiten telt in elk tempo-cijfer net zo zwaar
// als tien oude.
//
// De opzet is zo gebouwd dat de uitkomst vooraf vaststaat. Drie lichtingen:
//
//   OUD   (3 storingen, binnen 1 sep) -> blijven alle drie staan
//   MID   (2 storingen, binnen 1 okt) -> blijven staan
//   NIEUW (8 storingen, binnen 5 okt) -> worden alle acht afgesloten
//
// Meetdagen: 1 sep, 1 okt, 5 okt, 10 okt, 15 okt, 20 okt.
// De acht nieuwe sluiten in twee porties van vier (op 15 okt en 20 okt).
//
// Verwacht:
//   voorbijgestreefd: de 3 oude en de 2 midden zijn elk door 8 jongere
//     afsluitingen voorbijgestreefd -> 5 rijen, allemaal voorbij = 8
//   lichtingen:
//     sep 2026:  3 ingestroomd, 3 nog open  -> 100%
//     okt 2026: 10 ingestroomd, 2 nog open  ->  20%  (2 MID + 8 NIEUW)
//   oudste open: een OUD-order, 1 sep -> 20 okt = 49 dagen
//   wordt de oudste bak geholpen: 8 afsluitingen in het venster van 30 dagen.
//     Middenrang van een afsluiting van 5 okt op 15 okt: 5 ouder, 8 gelijk van
//     13 open -> (5 + 4) / 13 = 0,69, dus uit de JONGSTE helft. Idem op 20 okt:
//     (5 + 2) / 9 = 0,78. Dus 0 van de 8 uit de oudste helft -> 0%.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const OUD = ['9880000001', '9880000002', '9880000003'];
const MID = ['9880000011', '9880000012'];
const NIEUW = ['9880000021', '9880000022', '9880000023', '9880000024',
               '9880000025', '9880000026', '9880000027', '9880000028'];

const blok = (order) => `${OV}
Leiden | Teststraat ${order.slice(-2)} | 2312 KR
Order:
${order}
Asset:
${order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
Nog 90 dagen
Datum uitvoering onbekend`;

// Per meetdag welke orders openstaan. Alles in "In onderzoek" houden, zodat
// alleen de leeftijd varieert en niets anders de uitkomst kan verklaren.
const DAGEN = [
  ['2026-09-01', [...OUD]],
  ['2026-10-01', [...OUD, ...MID]],
  ['2026-10-05', [...OUD, ...MID, ...NIEUW]],
  ['2026-10-10', [...OUD, ...MID, ...NIEUW]],
  ['2026-10-15', [...OUD, ...MID, ...NIEUW.slice(4)]],   // eerste 4 nieuwe weg
  ['2026-10-20', [...OUD, ...MID]],                       // laatste 4 nieuwe weg
];

const VERWACHT = {
  rijen: 5, voorbij: 8, oudsteLeeftijd: 49,
  afgesloten: 8, uitOudsteHelft: 0,
};

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
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

  for (const [datum, orders] of DAGEN) {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + orders.map(blok).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(200);
    // En dezelfde dag de statuslijst, zodat elke storing een OV-status heeft.
    await page.fill('#paste-input', 'In onderzoek\n' + orders.map(blok).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(200);
  }

  console.log('--- de kale getallen, tegen de handberekening ---');
  const o = await page.evaluate(() => buildLiggenblijvers());
  console.log('    rijen:', o.rijen.length, '| open:', o.totaalOpen,
    '| fifo:', JSON.stringify(o.fifo), '| oudste:', o.oudste && o.oudste.leeftijd);
  check('vijf storingen voorbijgestreefd', o.rijen.length, VERWACHT.rijen);
  check('elk door acht jongere afsluitingen', o.rijen.every(r => r.voorbij === VERWACHT.voorbij), true);
  check('de nieuwe lichting staat er niet in', o.rijen.some(r => NIEUW.includes(r.order)), false);
  check('vijf storingen staan nog open', o.totaalOpen, 5);
  check('acht afsluitingen in het venster', o.fifo.afgesloten, VERWACHT.afgesloten);
  check('geen daarvan uit de oudste helft', o.fifo.uitOudsteHelft, VERWACHT.uitOudsteHelft);
  // Expliciet: zonder deze controle zou een ontbrekend aandeel (null) als 0
  // doorrekenen en de test ten onrechte laten slagen.
  check('er is genoeg gemeten voor een oordeel', o.fifo.aandeel !== null, true);
  check('dus 0% wachtrij-discipline', Math.round(o.fifo.aandeel * 100), 0);
  check('oudste open storing is 49 dagen', o.oudste.leeftijd, VERWACHT.oudsteLeeftijd);
  check('en dat is een september-order', OUD.includes(o.oudste.order), true);

  console.log('\n--- lichtingen ---');
  o.lichtingen.forEach(l => console.log(`    ${l.label}: ${l.nogOpen}/${l.ingestroomd} nog open (${Math.round(l.aandeelOpen * 100)}%), mediane leeftijd ${l.p50Leeftijd}`));
  const sep = o.lichtingen.find(l => l.sleutel === '2026-09');
  const okt = o.lichtingen.find(l => l.sleutel === '2026-10');
  check('september: 3 ingestroomd', sep.ingestroomd, 3);
  check('september: alle 3 nog open', sep.nogOpen, 3);
  check('september: dus 100% blijft liggen', Math.round(sep.aandeelOpen * 100), 100);
  check('september: mediane leeftijd 49 dagen', sep.p50Leeftijd, 49);
  check('oktober: 10 ingestroomd', okt.ingestroomd, 10);
  check('oktober: 2 nog open', okt.nogOpen, 2);
  check('oktober: dus 20% blijft liggen', Math.round(okt.aandeelOpen * 100), 20);

  console.log('\n--- het oordeel op de kaart ---');
  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(800);
  const kop = await page.$eval('#liggen-body .prognose-headline', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', kop);
  check('kaart noemt het aantal afsluitingen', /van de 8 storingen die je de laatste 30 dagen hebt afgesloten/i.test(kop), true);
  check('en dat er geen uit de oudste helft kwam', /kwamen er 0 uit de oudste helft/.test(kop), true);
  check('en trekt de conclusie', /de oude bak blijft structureel liggen/.test(kop), true);

  const body = await page.$eval('#liggen-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('noemt de oudste storing', new RegExp(`${o.oudste.order}: 49 dagen`).test(body), true);
  check('noemt de lichting september', /sep\.? 2026|september 2026/i.test(body), true);
  check('en de ergst ingehaalde storing', /storingen die later binnenkwamen zijn al weg/.test(body), true);

  const rijenOpScherm = await page.$$eval('#liggen-tabel tbody tr', trs => trs.length);
  check('vijf rijen in de werklijst', rijenOpScherm, VERWACHT.rijen);
  const voorbijKolom = await page.$$eval('#liggen-tabel tbody tr', trs =>
    trs.map(t => t.querySelectorAll('td')[6].textContent.trim()));
  console.log('    kolom "jongere afgesloten":', voorbijKolom.join(', '));
  check('gesorteerd op meest ingehaald, aflopend',
    voorbijKolom.every((v, i, a) => i === 0 || +a[i - 1] >= +v), true);
  check('en de waarde is de verwachte 8', voorbijKolom[0], VERWACHT.voorbij);

  console.log('\n--- een eerlijke wachtrij geeft een ander oordeel ---');
  // Nu de oudste drie afsluiten: dan komt alles wat weggaat juist uit de
  // oudste helft en hoort het oordeel om te slaan.
  await page.click('.tab-btn[data-tab="invoer"]');
  await page.fill('#paste-input', 'In onderzoek\n' + MID.map(blok).join('\n'));
  await page.waitForTimeout(240);
  await page.fill('#week-date', '2026-10-25');
  await page.click('#process-btn');
  await page.waitForTimeout(400);
  const o2 = await page.evaluate(() => buildLiggenblijvers());
  console.log('    fifo nu:', JSON.stringify(o2.fifo));
  check('elf afsluitingen in het venster', o2.fifo.afgesloten, 11);
  // Middenrang van een afsluiting van 1 sep op 20 okt: 0 ouder, 3 gelijk van
  // 5 open -> (0 + 1,5) / 5 = 0,3, dus wel uit de oudste helft.
  check('drie daarvan uit de oudste helft', o2.fifo.uitOudsteHelft, 3);
  check('de september-lichting is leeg', o2.lichtingen.find(l => l.sleutel === '2026-09').nogOpen, 0);
  check('en de oudste open storing is nu een oktober-order', MID.includes(o2.oudste.order), true);

  console.log('\n--- geblokkeerde storingen horen hier niet in ---');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(600);
  const sel = `#table-all .ov-block-select[data-order="${MID[0]}"]`;
  await page.waitForSelector(sel);
  await page.selectOption(sel, 'aanleg');
  await page.waitForTimeout(600);
  const o3 = await page.evaluate(() => buildLiggenblijvers());
  check('de geblokkeerde storing is uit de werklijst', o3.rijen.some(r => r.order === MID[0]), false);
  check('en wordt als overgeslagen gemeld', o3.geblokkeerdOvergeslagen, 1);
  check('maar blijft wel in de lichting staan', o3.lichtingen.find(l => l.sleutel === '2026-10').nogOpen, 2);
  check('en wordt daar apart als geblokkeerd geteld', o3.lichtingen.find(l => l.sleutel === '2026-10').geblokkeerd, 1);

  console.log('\n--- en in de gedeelde export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-liggen.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(500);
  await exp.click('.tab-btn[data-tab="prognose"]');
  await exp.waitForTimeout(600);
  check('export: dezelfde getallen', await exp.evaluate(() => buildLiggenblijvers().fifo.uitOudsteHelft), 3);
  check('export: en hetzelfde aantal afsluitingen', await exp.evaluate(() => buildLiggenblijvers().fifo.afgesloten), 11);
  check('export: de kaart is getekend', await exp.$eval('#liggen-body', e => e.textContent.trim().length > 50), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  await page.click('.tab-btn[data-tab="prognose"]');
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/claude-0/liggenblijvers.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
