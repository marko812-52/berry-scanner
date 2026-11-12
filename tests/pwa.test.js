/* Перевірки, що офлайн-режим не зламається: версії збігаються, усі файли з кешу існують. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const BS = require('../js/core/defaults.js');

const root = path.join(__dirname, '..');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const assets = sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));

test('версія в sw.js збігається з версією програми', () => {
  assert.equal(sw.match(/const VERSION = '([^']+)'/)[1], BS.APP_VERSION);
});

test('усі файли зі списку кешу існують', () => {
  for (const a of assets) if (a !== './') assert.ok(fs.existsSync(path.join(root, a)), 'немає файлу ' + a);
});

test('усе, що підключає index.html, є в кеші і лежить локально (без CDN)', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    assert.ok(!/^(https?:)?\/\//.test(r), 'зовнішнє посилання: ' + r);
    assert.ok(assets.includes(r), 'немає в ASSETS: ' + r);
  }
});

test('на сторінці немає модулів: вона має відкриватися як локальний файл', () => {
  assert.ok(!/type="module"/.test(html));
});

test('manifest посилається на наявні іконки', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, i.src)), 'немає ' + i.src);
});
