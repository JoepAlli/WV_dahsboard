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

/* --- Sleep-pagina ---
   Een bookmarklet met de hand aanmaken is gepriegel: je moet één enorme regel
   uit een tekstbestand vissen en in het juiste veld plakken. Slepen is een
   stuk eenvoudiger, en levert precies dezelfde bladwijzer op. */
const html = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><title>ISH-tap installeren</title>
<style>
  body { font: 15px/1.6 Arial, Helvetica, sans-serif; max-width: 640px; margin: 40px auto;
         padding: 0 20px; color: #1A1A1A; background: #F2F2F2; }
  .kaart { background: #fff; border-radius: 14px; padding: 26px 30px; box-shadow: 0 2px 4px rgba(0,0,0,.05), 0 10px 26px rgba(0,0,0,.07); }
  h1 { font-size: 1.3rem; margin-top: 0; }
  .knop { display: inline-block; background: #4C6E23; color: #fff; text-decoration: none;
          padding: 12px 22px; border-radius: 10px; font-weight: bold; font-size: 1.05rem;
          cursor: grab; margin: 6px 0 10px; }
  .knop:hover { background: #64902F; }
  ol { padding-left: 20px; } li { margin-bottom: 8px; }
  .let { background: #FDF1E3; border-left: 4px solid #E66E00; padding: 12px 16px; border-radius: 6px; margin-top: 22px; }
  code { background: #eee; padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }
</style></head><body><div class="kaart">
<h1>ISH-tap als bladwijzer installeren</h1>
<ol>
  <li>Zorg dat je favorietenbalk zichtbaar is: <code>Ctrl</code> + <code>Shift</code> + <code>B</code>.</li>
  <li><strong>Sleep de groene knop hieronder naar die balk.</strong> Klikken doet niets — het gaat om slepen.</li>
  <li>Klaar. Ga naar de InstandhoudingsApp en klik de bladwijzer aan.</li>
</ol>
<p><a class="knop" href="${bookmarklet.replace(/"/g, '&quot;')}">ISH-tap</a></p>
<p>Daarna in de app: <strong>ververs de lijst</strong> (de bladwijzer luistert pas mee vanaf
je klik), en druk dan op <code>Alt</code> + <code>Shift</code> + <code>D</code> om het
JSON-bestand te downloaden. Rechtsonder verschijnt ook een paneel met knoppen.</p>
<div class="let"><strong>Lukt slepen niet?</strong> Maak dan zelf een bladwijzer aan
(<code>Ctrl</code> + <code>Shift</code> + <code>O</code> → de drie puntjes → een favoriet
toevoegen) en plak als adres de lange regel uit <code>ish-tap-bookmarklet.txt</code>.</div>
</div></body></html>`;
fs.writeFileSync(path.join(map, 'ish-tap-installeren.html'), html);

console.log('ish-tap-installeren.html geschreven (sleep-pagina)');
console.log('ish-tap.user.js geschreven (' + (kop + kern).length + ' tekens)');
console.log('ish-tap-bookmarklet.txt geschreven (' + bookmarklet.length + ' tekens in de URL)');
