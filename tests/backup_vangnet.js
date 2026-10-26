// Alle data van dit dashboard staat in één browserprofiel. Eén "browsergegevens
// wissen" of één herinstallatie van de laptop en de hele meethistorie is weg —
// precies de data die nergens anders wordt verzameld. Daar horen twee
// beschermingen bij, en die bewaakt deze test:
//
//   1. De herinnering telt ONBEWAARDE PLAKACTIES, niet dagen. Dagen zeggen
//      niets: in een rustige week verlies je niets, in een drukke week twintig
//      updates.
//   2. Het terugzetten van een back-up zegt vooraf wát je kwijtraakt. Bij een
//      overdracht is dat het gevaarlijkste moment van de hele tool: één
//      verkeerd bestand en er verdwijnt stilletjes maanden historie.
const { chromium } = require('playwright');
const fs = require('fs');

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
const order = (n) => '9930000' + String(100 + n);

(async () => {
  const errs = [];
  let fouten = 0;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 }, acceptDownloads: true });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto('file:///home/user/WV_dahsboard/index.html');
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };
  // Elke plakactie is één opgeslagen update, ook op dezelfde dag.
  const plak = async (aantal, datum) => {
    await page.click('.tab-btn[data-tab="invoer"]');
    await page.fill('#paste-input', 'ZZE5A\n' + Array.from({ length: aantal }, (_, i) => blok(order(i))).join('\n'));
    await page.waitForTimeout(240);
    await page.fill('#week-date', datum);
    await page.click('#process-btn');
    await page.waitForTimeout(250);
  };
  const herinnering = () => page.$eval('#backup-reminder', e => ({
    zichtbaar: !e.classList.contains('hidden'),
    dringend: e.classList.contains('reminder-dringend'),
    tekst: e.textContent.replace(/\s+/g, ' ').trim(),
  }));

  let dialoog = null;
  page.on('dialog', async d => { dialoog = d.message(); await d.accept(); });

  await page.click('.tab-btn[data-tab="settings"]');
  await page.fill('#new-type-input', OV);
  await page.click('#add-type-btn');
  await page.waitForTimeout(150);

  console.log('--- de herinnering telt plakacties, niet dagen ---');
  for (let i = 0; i < 3; i++) await plak(5, `2026-10-0${i + 1}`);
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(400);
  check('bij 3 onbewaarde updates nog stil', (await herinnering()).zichtbaar, false);

  await plak(5, '2026-10-04');
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(400);
  const h4 = await herinnering();
  console.log('   ', h4.tekst);
  check('bij 4 komt de herinnering', h4.zichtbaar, true);
  check('en noemt het aantal onbewaarde updates', /zijn 4 updates verwerkt die in geen enkele back-up staan/.test(h4.tekst), true);
  check('nog niet dringend', h4.dringend, false);

  console.log('\n--- vanaf twintig is het een waarschuwing ---');
  for (let i = 5; i <= 20; i++) await plak(5, '2026-10-' + String(i).padStart(2, '0'));
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(400);
  const h20 = await herinnering();
  console.log('   ', h20.tekst.slice(0, 110));
  check('nu dringend opgemaakt', h20.dringend, true);
  check('met een stelligere kop', /Maak een back-up\./.test(h20.tekst), true);

  console.log('\n--- een back-up maken zet de teller terug ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [bu] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup-btn')]);
  const volledig = '/tmp/claude-0/vangnet-volledig.json';
  await bu.saveAs(volledig);
  await page.waitForTimeout(400);
  check('teller staat op nul', await page.evaluate(() => onbewaardeUpdates()), 0);
  check('en de stand meldt dat alles veilig is',
    /Alles is veiliggesteld/.test(await page.$eval('#backup-last', e => e.textContent)), true);
  await page.click('.tab-btn[data-tab="data"]');
  await page.waitForTimeout(400);
  check('de herinnering is weg', (await herinnering()).zichtbaar, false);

  const aantalVolledig = JSON.parse(fs.readFileSync(volledig, 'utf8')).ovSnapshots.length;
  console.log('    updates in de volledige back-up:', aantalVolledig);

  console.log('\n--- een oudere back-up maken om mee te testen ---');
  // Een bestand met minder updates en een eerdere einddatum: precies het geval
  // waarin iemand bij een overdracht per ongeluk historie weggooit.
  const oud = JSON.parse(fs.readFileSync(volledig, 'utf8'));
  oud.ovSnapshots = oud.ovSnapshots.filter(sn => sn.week <= '2026-10-10');
  const oudPad = '/tmp/claude-0/vangnet-oud.json';
  fs.writeFileSync(oudPad, JSON.stringify(oud));
  console.log('    updates in het oude bestand:', oud.ovSnapshots.length);

  console.log('\n--- importeren vertelt vooraf wat je kwijtraakt ---');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  dialoog = null;
  await page.setInputFiles('#import-backup-input', oudPad);
  await page.waitForTimeout(900);
  console.log('    melding:\n' + dialoog.split('\n').map(r => '      ' + r).join('\n'));
  check('noemt de huidige stand', new RegExp(`Nu in het dashboard: ${aantalVolledig} opgeslagen updates`).test(dialoog), true);
  check('noemt wat erin zit', new RegExp(`In dit bestand: +${oud.ovSnapshots.length} opgeslagen updates`).test(dialoog), true);
  check('waarschuwt dat het ouder is', /LET OP: dit bestand is ouder of kleiner/.test(dialoog), true);
  check('noemt hoeveel updates je verliest',
    new RegExp(`Je raakt ${aantalVolledig - oud.ovSnapshots.length} update\\(s\\) kwijt`).test(dialoog), true);
  check('en vanaf welke datum de historie verdwijnt', /Historie na 10 okt 2026 verdwijnt/.test(dialoog), true);
  check('en adviseert eerst een back-up', /Maak eerst een back-up van de huidige stand/.test(dialoog), true);

  console.log('\n--- een nieuwere back-up geeft die waarschuwing niet ---');
  await plak(5, '2026-10-21');
  await page.click('.tab-btn[data-tab="settings"]');
  await page.waitForTimeout(300);
  const [bu2] = await Promise.all([page.waitForEvent('download'), page.click('#export-backup-btn')]);
  const nieuwPad = '/tmp/claude-0/vangnet-nieuw.json';
  await bu2.saveAs(nieuwPad);
  dialoog = null;
  await page.setInputFiles('#import-backup-input', nieuwPad);
  await page.waitForTimeout(900);
  check('geen verliesmelding bij een gelijke of nieuwere back-up', /LET OP/.test(dialoog), false);
  check('maar wel de vergelijking', /Nu in het dashboard:/.test(dialoog), true);

  console.log('\n--- een bestand dat geen back-up is wordt netjes geweigerd ---');
  const rommel = '/tmp/claude-0/vangnet-rommel.json';
  fs.writeFileSync(rommel, JSON.stringify({ iets: 'anders' }));
  dialoog = null;
  await page.setInputFiles('#import-backup-input', rommel);
  await page.waitForTimeout(700);
  check('er wordt niets gevraagd', dialoog, null);
  const status = await page.$eval('#backup-status', e => e.textContent.trim());
  console.log('   ', status);
  check('en de reden staat erbij', /bevat geen opgeslagen updates/.test(status), true);
  check('de data staat er nog', await page.evaluate(() => state.snapshots.length) > 0, true);

  console.log(errs.length ? '\nFOUTEN IN DE PAGINA:\n' + errs.join('\n') : '\nGeen paginafouten.');
  console.log(fouten === 0 && errs.length === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await browser.close();
  process.exit(fouten === 0 && errs.length === 0 ? 0 : 1);
})();
