// Controleert alleen de nieuwe staart-regel op de boxplotkaart: die vuurt pas
// bij voldoende metingen én een scheve verdeling, en dat komt in de smoke-data
// niet voor. Hier voeren we de rijen direct in.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('file:///home/user/WV_dahsboard/index.html');
  const uit = await p.evaluate(() => {
    const scheef = [1, 1, 1, 1, 1, 1, 1, 1, 1, 30];   // p50 = 1, p90 ruim daarboven
    const vlak = [5, 5, 5, 5, 5, 5];                   // geen staart
    const rijen = [
      { key: 'Nieuw', label: 'Nieuw', waarden: vlak, box: boxplotVan(vlak) },
      { key: 'In onderzoek', label: 'In onderzoek', waarden: scheef, box: boxplotVan(scheef) },
      { key: 'Planning', label: 'Planning', waarden: [], box: null },
    ];
    return {
      metStaart: boxplotStaartKop(rijen),
      zonderStaart: boxplotStaartKop([rijen[0], rijen[2]]),
      teWeinig: boxplotStaartKop([{ key: 'X', label: 'X', waarden: [1, 1, 1, 30], box: boxplotVan([1, 1, 1, 30]) }]),
    };
  });
  let fouten = 0;
  const check = (l, g, v) => {
    const ok = String(g) === String(v);
    if (!ok) fouten++;
    console.log(`${ok ? 'OK ' : '!! '} ${l}: ${g}${ok ? '' : ` (verwacht ${v})`}`);
  };
  console.log('   ', uit.metStaart.replace(/<[^>]+>/g, ''));
  check('kiest de scheve status', /In onderzoek/.test(uit.metStaart), true);
  check('noemt de mediaan', /binnen 1 dag doorheen/.test(uit.metStaart), true);
  check('zwijgt bij een vlakke verdeling', uit.zonderStaart, '');
  check('zwijgt bij te weinig metingen', uit.teWeinig, '');
  // De eenheid op de grafiek zelf. Een as die "dagen" zegt boven werkdagen is
  // stille verwarring: iemand vergelijkt het dan met de trajectduur, die wél
  // in kalenderdagen staat.
  const asTeksten = await p.evaluate(() => {
    const waarden = [1, 2, 3, 4, 5, 6];
    const rijen = [{ key: 'Nieuw', label: 'Nieuw', waarden, box: boxplotVan(waarden), overgeslagen: 0, gatOvergeslagen: 0 }];
    const el = document.createElement('div');
    el.innerHTML = boxplotSvgHtml(rijen);
    return Array.from(el.querySelectorAll('text')).map(t => t.textContent);
  });
  check('de Y-as noemt werkdagen', asTeksten.includes('werkdagen'), true);
  check('en nergens een kale "dagen"-as', asTeksten.includes('dagen'), false);
  check('geen paginafouten', errs.join(' ') || 'geen', 'geen');
  console.log(fouten === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await b.close();
  process.exit(fouten === 0 ? 0 : 1);
})();
