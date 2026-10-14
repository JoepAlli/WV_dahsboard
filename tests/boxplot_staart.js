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
  check('geen paginafouten', errs.join(' ') || 'geen', 'geen');
  console.log(fouten === 0 ? '\nALLES GOED' : `\n${fouten} controle(s) mislukt`);
  await b.close();
  process.exit(fouten === 0 ? 0 : 1);
})();
