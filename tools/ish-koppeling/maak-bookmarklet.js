#!/usr/bin/env node
// Bouwt uit ish-tap.core.js de twee vormen waarin je hem kunt gebruiken:
//   - ish-tap.user.js          voor Tampermonkey/Violentmonkey
//   - ish-tap-bookmarklet.txt  om als bladwijzer te plakken
// Draai opnieuw na elke wijziging aan de kern: node tools/ish-koppeling/maak-bookmarklet.js
const fs = require('fs');
const path = require('path');

const map = __dirname;
const kern = fs.readFileSync(path.join(map, 'ish-tap.core.js'), 'utf8');

/* --- Userscript --- */
const kop = `// ==UserScript==
// @name         ISH-tap — NUS-gegevens uit de InstandhoudingsApp
// @namespace    nus-dashboard
// @version      1.0.0
// @description  Vangt de OData-antwoorden op die de InstandhoudingsApp zelf ophaalt en zet ze klaar als JSON-bestand. Leest alleen mee; verandert niets aan de app.
// @author       NUS-dashboard
// @run-at       document-start
// @grant        none
//
// LET OP: pas de regel hieronder aan naar de hostnaam van de
// InstandhoudingsApp, zoals die in je adresbalk staat. Zolang daar
// VUL-HOSTNAAM-IN staat doet het script niets.
// @match        *://VUL-HOSTNAAM-IN/*
// ==/UserScript==

// @run-at document-start zorgt dat er wordt meegeluisterd vóórdat de app zijn
// eerste gegevens ophaalt. @grant none is nodig: alleen dan draait dit in de
// pagina zelf en kan het meeluisteren met fetch/XMLHttpRequest van de app.

`;
fs.writeFileSync(path.join(map, 'ish-tap.user.js'), kop + kern);

/* --- Bookmarklet ---
   Bewust niet verkleind: een bladwijzer mag lang zijn, en leesbaar blijven
   weegt hier zwaarder dan een paar kilobyte. */
const bookmarklet = 'javascript:' + encodeURIComponent(kern.replace(/\r\n/g, '\n')) + '%0A';
fs.writeFileSync(path.join(map, 'ish-tap-bookmarklet.txt'),
  `Bookmarklet: maak een nieuwe bladwijzer en plak onderstaande regel als URL.
Werkt op de pagina van de InstandhoudingsApp; klik erop en ververs daarna de
lijst in de app, want een bookmarklet gaat pas meeluisteren vanaf het moment
dat je hem aanklikt.

${bookmarklet}
`);

console.log('ish-tap.user.js geschreven (' + (kop + kern).length + ' tekens)');
console.log('ish-tap-bookmarklet.txt geschreven (' + bookmarklet.length + ' tekens in de URL)');
