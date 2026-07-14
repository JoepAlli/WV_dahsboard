#!/usr/bin/env node
// Regenereert export-template.js vanuit app.js, style.css en de <body>-structuur
// van index.html. Draai dit opnieuw na elke wijziging aan een van die drie
// bestanden, zodat "Exporteer interactief dashboard" (in Instellingen) altijd
// een actuele, werkende kopie van het dashboard genereert.
//
// Waarom dit nodig is: een file://-pagina mag geen fetch() doen op buurbestanden
// (de browser blokkeert dat), dus kan de export-knop de inhoud van app.js/style.css
// niet ophalen op het moment van klikken. In plaats daarvan wordt die inhoud hier,
// tijdens het bouwen, al ingebakken als losse JS-stringconstanten die normaal
// gewoon via <script src="export-template.js"> worden meegeladen.
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(rootDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(rootDir, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');

const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
if (!bodyMatch) throw new Error('Kon <body>...</body> niet vinden in index.html');
const shell = bodyMatch[1].replace(/<script[^>]*\ssrc=["'][^"']*["'][^>]*><\/script>\s*/gi, '');

const out = `// Automatisch gegenereerd door scripts/build-export-template.js — niet handmatig bewerken.
// Bron: app.js, style.css, index.html. Regenereren met: node scripts/build-export-template.js
window.__EXPORT_CSS__ = ${JSON.stringify(css)};
window.__EXPORT_APPJS__ = ${JSON.stringify(appJs)};
window.__EXPORT_HTML_SHELL__ = ${JSON.stringify(shell)};
`;
fs.writeFileSync(path.join(rootDir, 'export-template.js'), out);
console.log('export-template.js geregenereerd (' + out.length + ' bytes).');
