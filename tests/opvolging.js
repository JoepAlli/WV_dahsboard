// Het geheugen van je eigen beslissingen. Het dashboard kon alles zien behalve
// wat de gebruiker er al mee gedaan had, waardoor elke lijst elke week even
// lang bleef en je telkens opnieuw uit je hoofd moest filteren.
//
// Deze test bewaakt vooral de twee dingen die parkeren veilig maken. Zonder
// die twee is een markering hetzelfde als weggooien:
//
//   1. Parkeren LOOPT AF. Op de parkeerdatum komt de storing vanzelf terug.
//   2. Een markering VERVALT BIJ VERANDERING. Schuift de storing van status na
//      het markeren, dan klopt de beslissing niet meer en komt 'ie terug.
//
// De opzet: vier storingen die allemaal om actie vragen (verlopen zonder
// uitvoeringsdatum), zodat ze gegarandeerd in de werklijst staan.
const { chromium } = require('playwright');

const OV = 'Stra[a]t[en] zonder OV Infra';
const ORDERS = ['9890000001', '9890000002', '9890000003', '9890000004'];

const blok = (order, dagen, status) => `${OV}
Leiden | Teststraat ${order.slice(-2)} | 2312 KR
Order:
${order}
Asset:
${order.slice(-7)}-EL
MSR
Piet Poot
Marc van Veen
${dagen >= 0 ? `Nog ${dagen} dagen` : `${-dagen} dagen verlopen`}
Datum uitvoering onbekend`;

// Allemaal verlopen zonder plan: dat is categorie "Verlopen — uitvoering
// onbekend" en die staat altijd in Vraagt om actie.
const lijst = (orders, dagen) => orders.map(o => blok(o, dagen)).join('\n');

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
    await page.waitForTimeout(250);
  };
  const actieRijen = async () => {
    await page.click('.tab-btn[data-tab="data"]');
    await page.waitForTimeout(500);
    return page.$$eval('#werklijst-body tbody tr', trs => trs.length);
  };
  // De markering zetten gaat via de echte bediening. Standaard via de
  // volledige lijst; met bron 'actie' via de lijst Vraagt om actie, want dat
  // is waar je in de praktijk werkt.
  const markeer = async (order, soort, bron) => {
    await page.click('.tab-btn[data-tab="data"]');
    await page.waitForTimeout(400);
    const sel = `${bron === 'actie' ? '#werklijst-body' : '#table-all'} .opvolging-select[data-order="${order}"]`;
    await page.waitForSelector(sel);
    await page.selectOption(sel, soort);
    await page.waitForTimeout(450);
  };

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(150);

  await plak('ZZE5A\n' + lijst(ORDERS, -5), '2026-10-12');
  await plak('In onderzoek\n' + lijst(ORDERS, -5), '2026-10-12');
  await plak('ZZE5A\n' + lijst(ORDERS, -8), '2026-10-19');
  await plak('In onderzoek\n' + lijst(ORDERS, -8), '2026-10-19');

  console.log('--- uitgangspunt ---');
  check('vier storingen vragen om actie', await actieRijen(), 4);

  console.log('\n--- markeren maakt de lijst korter ---');
  // De eerste via de werklijst zelf, want daar werk je.
  await markeer(ORDERS[0], 'gezien', 'actie');
  await markeer(ORDERS[1], 'opgepakt');
  check('nog twee in de lijst', await actieRijen(), 2);
  check('en de teller op de kaart zegt hetzelfde',
    await page.$eval('#werklijst-count', e => e.textContent.trim()), 2);
  const na = await page.$eval('#werklijst-body', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('en de lijst meldt wat is weggelaten', /2 storingen zijn hier weggelaten omdat die als gezien, opgepakt of geparkeerd staan/.test(na), true);
  check('met de belofte dat ze terugkomen', /komen vanzelf terug zodra de parkeertijd om is of de status verandert/.test(na), true);

  console.log('\n--- parkeren met een datum in de toekomst ---');
  await markeer(ORDERS[2], 'geparkeerd');
  const tot = await page.$eval(`#table-all .opvolging-tot[data-order="${ORDERS[2]}"]`, e => e.value);
  console.log('    standaard parkeerdatum:', tot);
  check('krijgt vanzelf een einddatum', /^\d{4}-\d{2}-\d{2}$/.test(tot), true);
  check('die in de toekomst ligt', tot > new Date().toISOString().slice(0, 10), true);
  check('nog één in de lijst', await actieRijen(), 1);

  console.log('\n--- 1. parkeren loopt af: datum op gisteren zetten ---');
  const gisteren = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await page.fill(`#table-all .opvolging-tot[data-order="${ORDERS[2]}"]`, gisteren);
  await page.press(`#table-all .opvolging-tot[data-order="${ORDERS[2]}"]`, 'Enter');
  await page.waitForTimeout(600);
  check('de geparkeerde storing staat weer in de lijst', await actieRijen(), 2);
  const stand = await page.evaluate((o) => opvolgingStand({ order: o, ovStatus: 'In onderzoek' }), ORDERS[2]);
  check('markering geldt niet meer', stand.actief, false);
  check('en de reden is de verlopen parkeertijd', stand.verlopen, true);
  check('niet een statuswissel', stand.verschoven, false);

  console.log('\n--- en dat is zichtbaar als signaal, niet alleen stilletjes ---');
  const tegel = await page.$eval('[data-stat-key="opvolgingVervallen"] .value', e => e.textContent.trim());
  check('de tegel "Markering vervallen" telt er één', tegel, 1);
  const cel = await page.$eval(`#table-all .opvolging-cel:has(.opvolging-select[data-order="${ORDERS[2]}"]) .opvolging-wissel`,
    e => e.textContent.replace(/\s+/g, ' ').trim());
  console.log('    melding in de cel:', cel);
  check('de cel meldt de verlopen parkeertijd', /parkeertijd verlopen/.test(cel), true);

  console.log('\n--- 2. een markering vervalt als de storing van status verandert ---');
  // ORDERS[1] staat op "opgepakt" bij status In onderzoek. Die schuift nu door.
  await plak('Planning\n' + blok(ORDERS[1], -9), '2026-10-21');
  await plak('ZZE5A\n' + lijst(ORDERS, -9), '2026-10-21');
  await page.waitForTimeout(400);
  const stand2 = await page.evaluate((o) => {
    const s = chronoSnapshots().slice(-1)[0].storingen.find(x => x.order === o);
    return opvolgingStand(s);
  }, ORDERS[1]);
  console.log('    stand:', JSON.stringify(stand2));
  check('de markering geldt niet meer', stand2.actief, false);
  check('omdat de storing is opgeschoven', stand2.verschoven, true);
  check('en niet door een verlopen parkeertijd', stand2.verlopen, false);
  check('de status van toen is bewaard', stand2.bijStatus, 'In onderzoek');

  console.log('\n--- een markering blijft staan als er niets verandert ---');
  const stand3 = await page.evaluate((o) => {
    const s = chronoSnapshots().slice(-1)[0].storingen.find(x => x.order === o);
    return opvolgingStand(s);
  }, ORDERS[0]);
  check('"gezien" geldt nog steeds', stand3.actief, true);
  check('en verbergt nog steeds', await page.evaluate((o) => {
    const s = chronoSnapshots().slice(-1)[0].storingen.find(x => x.order === o);
    return opvolgingVerbergt(s);
  }, ORDERS[0]), true);

  console.log('\n--- de andere werklijsten doen hetzelfde ---');
  const telang = await page.evaluate(() => buildTeLangInStatus().opvolgingVerborgen);
  const liggen = await page.evaluate(() => buildLiggenblijvers().opvolgingVerborgen);
  console.log('    verborgen in "Te lang onderweg":', telang, '| in "Blijft liggen":', liggen);
  check('"Te lang onderweg" laat de gemarkeerde weg', telang >= 1, true);
  check('en meldt dat ook op de kaart', await (async () => {
    await page.click('.tab-btn[data-tab="prognose"]');
    await page.waitForTimeout(700);
    const t = await page.$eval('#stagnatie-body', e => e.textContent.replace(/\s+/g, ' ').trim());
    return /weggelaten omdat die als gezien, opgepakt of geparkeerd/.test(t);
  })(), true);

  console.log('\n--- markering weghalen zet alles terug ---');
  await markeer(ORDERS[0], '');
  // Alle vier staan nu weer in de lijst: [0] is niet meer gemarkeerd, [1] is
  // vervallen door de statuswissel en [2] door de verlopen parkeertijd. Alleen
  // [3] was nooit gemarkeerd. Precies het gedrag dat parkeren veilig maakt.
  check('alle vier staan weer in de lijst', await actieRijen(), 4);

  console.log('\n--- blijft bewaard na herladen ---');
  await page.reload();
  await page.waitForTimeout(1000);
  const bewaard = await page.evaluate(() => Object.keys(state.opvolging).length);
  check('de twee resterende markeringen staan er nog', bewaard, 2);
  check('inclusief de parkeerdatum', await page.evaluate((o) => (state.opvolging[o] || {}).tot, ORDERS[2]), gisteren);

  console.log('\n--- back-up en herstel ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(400);
  const [bu] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup-btn')]);
  const buPad = '/tmp/claude-0/opvolging-backup.json';
  await bu.saveAs(buPad);
  const json = JSON.parse(require('fs').readFileSync(buPad, 'utf8'));
  check('de back-up bevat de markeringen', Object.keys(json.opvolging || {}).length, 2);

  console.log('\n--- in de gedeelde export: zichtbaar maar niet bedienbaar ---');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#export-static-btn')]);
  const pad = '/tmp/claude-0/export-opvolging.html';
  await dl.saveAs(pad);
  const errsExp = [];
  const exp = await browser.newPage({ viewport: { width: 1700, height: 1200 } });
  exp.on('pageerror', e => errsExp.push('pageerror: ' + e.message));
  exp.on('console', m => { if (m.type() === 'error') errsExp.push('console: ' + m.text()); });
  await exp.goto('file://' + pad);
  await exp.waitForTimeout(700);
  check('export: de markeringen zijn meegegaan', await exp.evaluate(() => Object.keys(state.opvolging).length), 2);
  check('export: geen keuzelijsten om mee te bedienen', await exp.$$eval('.opvolging-select', e => e.length), 0);
  const expTekst = await exp.$eval('#table-all', e => e.textContent.replace(/\s+/g, ' ').trim());
  check('export: de markering staat er wel als tekst', /Opgepakt|Geparkeerd|Gezien/.test(expTekst), true);
  check('export: geen paginafouten', errsExp.join(' ') || 'geen', 'geen');
  if (errsExp.length) fouten++;
  await exp.close();

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
