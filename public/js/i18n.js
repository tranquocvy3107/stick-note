// A tiny internationalisation layer with no dependencies.
//
//  - Messages live in /locales/<code>.json as a flat { "key": "text" } object.
//  - Placeholders: "Saved at {time}"  ->  t('status.savedAt', { time })
//  - Plurals: a message can be { "one": "...", "other": "..." } (CLDR categories) and/or exact numbers such as
//    { "1": "...", "other": "..." }; pass { count } to pick the form.
//  - Mini markup inside messages (turned into DOM nodes, never into HTML):
//        [[Ctrl]]  ->  <kbd>Ctrl</kbd>        **bold**  ->  <b>bold</b>
//  - Static HTML: data-i18n="key" sets the text, data-i18n-title / -placeholder / -aria-label set attributes.
//
// To add a language: copy public/locales/en.json to <code>.json, translate it, and add it to LANGUAGES.
// English is always loaded as the fallback, so a missing key never shows up as a blank.
// This file does not touch the DOM when imported, so it can be tested in Node.

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'vi', name: 'Tiếng Việt' },
];
export const FALLBACK_LANGUAGE = 'en';

const STORAGE_KEY = 'stick-note:lang'; // 'auto' or a language code

let current = FALLBACK_LANGUAGE;
let translate = (key) => key;

/** Pick a supported language from the user's saved choice and the browser's preferred languages. */
export function pickLanguage(choice, preferred = []) {
  const supported = LANGUAGES.map((l) => l.code);
  if (choice && choice !== 'auto' && supported.includes(choice)) return choice;
  for (const tag of preferred) {
    const primary = String(tag).toLowerCase().split('-')[0];
    if (supported.includes(primary)) return primary;
  }
  return FALLBACK_LANGUAGE;
}

/**
 * Build a translate function. A key missing from `messages` falls back to `fallbackMessages`
 * (English), then to the key itself. Plural forms follow the rules of the language the text came from.
 */
export function createTranslator(messages, fallbackMessages, lang) {
  const rules = new Map();
  const pluralRules = (code) => {
    if (!rules.has(code)) rules.set(code, new Intl.PluralRules(code));
    return rules.get(code);
  };
  return (key, params) => {
    let code = lang;
    let msg = messages[key];
    if (msg === undefined) {
      msg = fallbackMessages[key];
      code = FALLBACK_LANGUAGE;
    }
    if (msg === undefined) return key;
    if (typeof msg === 'object' && msg !== null) {
      // An exact number ("1") wins over the language's plural category ("one", "other"...).
      const count = params && typeof params.count === 'number' ? params.count : null;
      const category = count === null ? 'other' : String(count) in msg ? String(count) : pluralRules(code).select(count);
      msg = msg[category] ?? msg.other ?? Object.values(msg)[0];
    }
    return String(msg).replace(/\{(\w+)\}/g, (whole, name) => (params && name in params ? String(params[name]) : whole));
  };
}

/** Translate a key. Safe to call before initI18n (returns the key). */
export const t = (key, params) => translate(key, params);

export const getLanguage = () => current;

export function getChoice() {
  try {
    return localStorage.getItem(STORAGE_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

/** Remember a language choice ('auto' or a code) and reload so the whole interface switches. */
export function setChoice(choice) {
  try { localStorage.setItem(STORAGE_KEY, choice); } catch { /* storage unavailable: the choice just won't stick */ }
  location.reload();
}

/** The name shown for a choice, in its own language ("Auto" is translated). */
export function choiceLabel(choice) {
  if (choice === 'auto') return t('lang.auto');
  return LANGUAGES.find((l) => l.code === choice)?.name || choice;
}

async function loadCatalogue(code) {
  const res = await fetch(`/locales/${code}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load the ${code} translations (${res.status})`);
  return res.json();
}

/** Load the catalogues and set <html lang>. Call once, before building any interface. */
export async function initI18n() {
  const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  const wanted = pickLanguage(getChoice(), preferred);
  const fallback = await loadCatalogue(FALLBACK_LANGUAGE);
  let messages = fallback;
  current = FALLBACK_LANGUAGE;
  if (wanted !== FALLBACK_LANGUAGE) {
    try {
      messages = await loadCatalogue(wanted);
      current = wanted;
    } catch (err) {
      console.warn(err);
    }
  }
  translate = createTranslator(messages, fallback, current);
  document.documentElement.lang = current;
}

// ---------------------------------------------------------------- DOM helpers

const MARKUP = /(\[\[[^\]]+\]\]|\*\*[^*]+\*\*)/;

/** Turn a message with [[kbd]] and **bold** markup into DOM nodes. */
export function formatNodes(text) {
  const frag = document.createDocumentFragment();
  for (const part of String(text).split(MARKUP)) {
    if (!part) continue;
    if (part.startsWith('[[')) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part.slice(2, -2);
      frag.append(kbd);
    } else if (part.startsWith('**')) {
      const b = document.createElement('b');
      b.textContent = part.slice(2, -2);
      frag.append(b);
    } else {
      frag.append(part);
    }
  }
  return frag;
}

/** Translate a key into DOM nodes (supports the mini markup). */
export const tNode = (key, params) => formatNodes(t(key, params));

const ATTRIBUTES = {
  'data-i18n-title': 'title',
  'data-i18n-placeholder': 'placeholder',
  'data-i18n-aria-label': 'aria-label',
};

/** Translate everything marked with data-i18n* inside `root`, then reveal the page. */
export function applyStaticTranslations(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.replaceChildren(tNode(el.dataset.i18n));
  for (const [attribute, target] of Object.entries(ATTRIBUTES)) {
    for (const el of root.querySelectorAll(`[${attribute}]`)) el.setAttribute(target, t(el.getAttribute(attribute)));
  }
  document.documentElement.removeAttribute('data-i18n-pending');
}
