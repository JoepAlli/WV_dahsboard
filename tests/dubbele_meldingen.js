// "Hoe vaak komt het voor dat één storing twee keer wordt gemeld?" is een
// vraag die wordt doorgegeven aan de bouwers van de Instandhoudingsapp. Het
// getal moet dus kloppen, en vooral: het mag niet te hoog uitvallen doordat
// herhaling wordt meegeteld als dubbele melding.
//
// Dat onderscheid is waar deze test om draait:
//
//   DUBBEL     twee orders op hetzelfde adres die TEGELIJK openstonden
//   HERHALING  twee orders op hetzelfde adres NÁ elkaar
//
// De opzet, met de uitkomst vooraf vastgelegd:
//
//   Hooigracht 12  A+B tegelijk open, ZELFDE asset     -> dubbel, zeker
//   Breestraat 40  C+D tegelijk open, andere assets    -> dubbel, twee objecten
//   Zijlweg 3      E dicht, pas daarna F               -> HERHALING, telt niet
//   Zeeweg 1       G alleen                            -> telt niet
//   Zijlweg 9      H alleen (zelfde straat, ander nr)  -> telt niet
//
// Verwacht: 2 adressen, 4 betrokken orders, 1 daarvan op dezelfde asset.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const MIO = 'Mast geen spanning Infra';

const blok = (s) => `${s.type || OV}
${s.city} | ${s.street} | ${s.pc}
Order:
${s.order}
Asset:
${s.asset}
MSR
Piet Poot
Marc van Veen
Nog 90 dagen
Datum uitvoering onbekend`;

const S = {
  // zelfde adres, zelfde asset, overlappend in de tijd
  A: { order: '9970000001', city: 'Leiden', street: 'Hooigracht 12', pc: '2312 KR', asset: '3000001-EL' },
  B: { order: '9970000002', city: 'Leiden', street: 'Hooigracht 12', pc: '2312 KR', asset: '3000001-EL', type: MIO },
  // zelfde adres, verschillende assets, overlappend
  C: { order: '9970000003', city: 'Leiden', street: 'Breestraat 40', pc: '2311 CS', asset: '3000003-EL' },
  D: { order: '9970000004', city: 'Leiden', street: 'Breestraat 40', pc: '2311 CS', asset: '3000004-EL' },
  // zelfde adres maar ná elkaar: herhaling, geen dubbele melding
  E: { order: '9970000005', city: 'Haarlem', street: 'Zijlweg 3', pc: '2011 AA', asset: '3000005-EL' },
  F: { order: '9970000006', city: 'Haarlem', street: 'Zijlweg 3', pc: '2011 AA', asset: '3000005-EL' },
  // losse gevallen
  G: { order: '9970000007', city: 'Katwijk', street: 'Zeeweg 1', pc: '2225 AA', asset: '3000007-EL' },
  H: { order: '9970000008', city: 'Haarlem', street: 'Zijlweg 9', pc: '2011 AB', asset: '3000008-EL' },
};

// Per meetdag welke storingen openstaan. E verdwijnt vóórdat F verschijnt.
const DAGEN = [
  ['2026-06-01', ['A', 'C', 'E', 'G', 'H']],
  ['2026-06-15', ['A', 'B', 'C', 'D', 'E', 'G', 'H']],   // B en D erbij: overlap
  ['2026-07-01', ['A', 'B', 'C', 'D', 'G', 'H']],        // E weg
  ['2026-07-15', ['A', 'G', 'H']],                        // B, C, D weg
  ['2026-08-01', ['A', 'F', 'G', 'H']],                   // F pas nu: herhaling
];

const VERWACHT = { adressen: 2, orders: 4, zelfdeAsset: 1, totaal: 8 };

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
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

  for (const [datum, keys] of DAGEN) {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + keys.map(k => blok(S[k])).join('\n'));
    await page.waitForTimeout(300);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(260);
  }

  console.log('--- de kale telling, tegen de handberekening ---');
  const o = await page.evaluate(() => buildDubbeleMeldingen());
  o.groepen.forEach(g => console.log(`    ${g.street}, ${g.city}: ${g.aantal} orders, ${g.zelfdeAsset ? 'zelfde asset' : 'andere assets'}, ${g.langsteOverlap} dgn samen open`));
  check('twee adressen met een dubbele melding', o.adressen, VERWACHT.adressen);
  check('vier betrokken orders', o.betrokkenOrders, VERWACHT.orders);
  check('waarvan één groep op dezelfde asset', o.zelfdeAssetGroepen, VERWACHT.zelfdeAsset);
  check('over acht storingen in totaal', o.totaalGezien, VERWACHT.totaal);
  check('dus 50% van alles', Math.round(o.aandeel * 100), 50);

  console.log('\n--- en dit is wat er NIET in mag ---');
  const adressen = o.groepen.map(g => g.street);
  check('Zijlweg 3 is herhaling, geen dubbele melding', adressen.includes('Zijlweg 3'), false);
  check('een los geval telt niet mee', adressen.includes('Zeeweg 1'), false);
  check('zelfde straat ander huisnummer telt niet mee', adressen.includes('Zijlweg 9'), false);
  // Zijlweg 3 hoort wél in Herhaallocaties te staan: daar is het juist wel
  // interessant. Zo blijft zichtbaar dat de twee kaarten verschillende
  // vragen beantwoorden.
  const herhaal = await page.evaluate(() => buildRecidiveStats('straat').map(g => g.street));
  check('maar Zijlweg staat wél bij Herhaallocaties', herhaal.some(x => /Zijlweg/.test(x)), true);

  console.log('\n--- de zwaarste staat vooraan ---');
  check('het adres met dezelfde asset staat bovenaan', o.groepen[0].zelfdeAsset, true);
  check('en dat is Hooigracht 12', o.groepen[0].street, 'Hooigracht 12');
  check('met beide orders erbij', o.groepen[0].orders.map(x => x.order).sort().join(','), '9970000001,9970000002');
  // A liep van 1 juni tot nu, B van 15 juni tot 15 juli: 30 dagen overlap.
  check('dertig dagen tegelijk open', o.groepen[0].langsteOverlap, 30);

  console.log('\n--- op het scherm ---');
  await page.click('.tab-btn[data-tab="historie"]');
  await page.waitForTimeout(700);
  check('de teller staat op twee', await page.$eval('#dubbel-count', e => e.textContent.trim()), 2);
  const body = await page.$eval('#dubbel-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('   ', body.slice(0, 200));
  check('de kop noemt het aantal adressen', /zijn er 2 adressen geweest waar twee of meer storingen tegelijk openstonden/.test(body), true);
  check('en het aandeel', /50% van alle 8 storingen/.test(body), true);
  check('en meldt de zekere gevallen apart', /Bij 1 daarvan ging het om hetzelfde assetnummer/.test(body), true);
  check('twee regels in de tabel', await page.$$eval('#dubbel-body tbody tr', e => e.length), 2);

  console.log('\n--- de terugkoppeling ---');
  const tekst = await page.evaluate(() => buildDubbeleMeldingenText());
  console.log(tekst.split('\n').map(r => '    ' + r).join('\n'));
  check('noemt de periode', /periode 1 jun 2026 t\/m/.test(tekst), true);
  check('noemt het aandeel', /50% van alle 8 storingen/.test(tekst), true);
  check('noemt beide adressen', /Hooigracht 12/.test(tekst) && /Breestraat 40/.test(tekst), true);
  check('markeert de zelfde-asset-groep', /ZELFDE asset/.test(tekst), true);
  check('bevat de ordernummers', /9970000001/.test(tekst) && /9970000002/.test(tekst), true);
  check('en legt het onderscheid uit', /twee storingen ná elkaar op hetzelfde adres zijn geen dubbele melding/.test(tekst), true);
  check('bevat geen namen van collega\'s', /Piet Poot|Marc van Veen/.test(tekst), false);

  console.log('\n--- in de gedeelde export ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-dubbel.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(600);
  await exp.click('.tab-btn[data-tab="historie"]');
  await exp.waitForTimeout(500);
  check('export: dezelfde telling', await exp.evaluate(() => buildDubbeleMeldingen().adressen), VERWACHT.adressen);
  check('export: de kaart is getekend', await exp.$$eval('#dubbel-body tbody tr', e => e.length), 2);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  await page.click('.tab-btn[data-tab="historie"]');
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/claude-0/dubbel.png', fullPage: true });

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
