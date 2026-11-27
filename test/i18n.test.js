// Tests for the translation layer and for the catalogues in public/locales. Run with: npm test
//
// These checks keep every language complete: when you add a message to en.json, the test tells you
// which other languages still need it, and a typo in a key used by the code fails here, not in the browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, createTranslator, pickLanguage } from '../public/js/i18n.js';
import { COLOR_KEYS, HELP_SECTIONS } from '../public/js/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const catalogues = Object.fromEntries(LANGUAGES.map((l) => [l.code, readJson(`locales/${l.code}.json`)]));
const en = catalogues.en;

// ---------------------------------------------------------------- the translator

test('pickLanguage: a saved choice wins, otherwise the first supported browser language, otherwise English', () => {
  assert.equal(pickLanguage('vi', ['en-US']), 'vi');
  assert.equal(pickLanguage('auto', ['fr-FR', 'vi-VN', 'en']), 'vi');
  assert.equal(pickLanguage(undefined, ['de']), 'en');
  assert.equal(pickLanguage('xx', []), 'en', 'an unknown saved choice is ignored');
});

test('translator: placeholders, plurals, exact numbers and fallbacks', () => {
  const english = {
    hello: 'Hello {name}',
    files: { one: '{count} file', other: '{count} files' },
    onlyEnglish: 'Only in English',
  };
  const vietnamese = {
    hello: 'Xin chào {name}',
    files: { 1: 'Một tệp', other: '{count} tệp' },
  };
  const t = createTranslator(vietnamese, english, 'vi');
  assert.equal(t('hello', { name: 'An' }), 'Xin chào An');
  assert.equal(t('files', { count: 1 }), 'Một tệp');
  assert.equal(t('files', { count: 5 }), '5 tệp');
  assert.equal(t('onlyEnglish'), 'Only in English', 'a missing key falls back to English');
  assert.equal(t('nowhere'), 'nowhere', 'an unknown key shows the key itself');
  assert.equal(t('hello'), 'Xin chào {name}', 'an unfilled placeholder is left visible');

  const e = createTranslator(english, english, 'en');
  assert.equal(e('files', { count: 1 }), '1 file');
  assert.equal(e('files', { count: 2 }), '2 files');
  assert.equal(e('files', { count: 0 }), '0 files');
});

// ---------------------------------------------------------------- the catalogues

const placeholders = (msg) => {
  const text = typeof msg === 'object' ? Object.values(msg).join(' ') : String(msg);
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
};

test('every language has exactly the same messages as English', () => {
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    const missing = Object.keys(en).filter((k) => !(k in catalogues[code]));
    const extra = Object.keys(catalogues[code]).filter((k) => !(k in en));
    assert.deepEqual(missing, [], `${code}.json is missing messages`);
    assert.deepEqual(extra, [], `${code}.json has messages English does not have`);
  }
});

test('translations keep the same {placeholders} as English and every plural has an "other" form', () => {
  for (const { code } of LANGUAGES) {
    for (const [key, msg] of Object.entries(catalogues[code])) {
      if (typeof msg === 'object') assert.ok('other' in msg, `${code}: ${key} needs an "other" form`);
      if (code !== 'en' && key in en) {
        assert.deepEqual(placeholders(msg), placeholders(en[key]), `${code}: placeholders of ${key} differ from English`);
      }
    }
  }
});

// ---------------------------------------------------------------- keys used by the code

function sourceFiles(dir, extension) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full, extension);
    return full.endsWith(extension) ? [full] : [];
  });
}

test('every message key used in the code and in index.html exists in en.json', () => {
  const used = new Map(); // key -> where
  const prefixes = new Set(Object.keys(en).map((k) => k.split('.')[0]));
  // Help rows are named by a prefix; their real keys are "<prefix>.k" and "<prefix>.d" (checked below).
  const helpRows = new Set(HELP_SECTIONS.flatMap((s) => s.rows));

  for (const file of sourceFiles(path.join(ROOT, 'js'), '.js')) {
    const text = fs.readFileSync(file, 'utf8');
    // t('key') and tNode('key')
    for (const m of text.matchAll(/\bt(?:Node)?\(\s*(['"])([\w.]+)\1/g)) used.set(m[2], path.basename(file));
    // string literals that look like keys, e.g. STATUS_KEYS = { saved: 'status.saved' }
    for (const m of text.matchAll(/(['"])([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)+)\1/g)) {
      if (prefixes.has(m[2].split('.')[0]) && !helpRows.has(m[2])) used.set(m[2], path.basename(file));
    }
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.set(m[1], 'index.html');

  // Keys built at run time.
  for (const c of COLOR_KEYS) used.set(`color.${c}`, 'color palette');
  for (const theme of ['auto', 'light', 'dark']) used.set(`theme.${theme}`, 'theme menu');
  for (const s of HELP_SECTIONS) {
    used.set(s.title, 'help dialog');
    for (const row of s.rows) { used.set(`${row}.k`, 'help dialog'); used.set(`${row}.d`, 'help dialog'); }
  }

  const unknown = [...used].filter(([key]) => !(key in en)).map(([key, where]) => `${key} (${where})`);
  assert.deepEqual(unknown, [], 'these keys are used but missing from public/locales/en.json');
});
