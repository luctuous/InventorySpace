// Builds the self-contained manuals — two documents, three languages each:
//
//   docs/manual.css                shared design system (mirrors the app's own)
//   docs/content/<lang>.html       user manual body
//        → docs/manual.<lang>.html
//   docs/content/code.<lang>.html  architecture manual body
//        → docs/code.<lang>.html
//
// Each output is a complete, standalone HTML document: open it by
// double-clicking, email it, or drop it on any web server. There is not a
// single external request — the IBM Plex faces are inlined as data URIs — so
// the manuals work with no network at all.
//
//   node docs/build-manuals.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const docs = dirname(fileURLToPath(import.meta.url));
const root = join(docs, '..');

/**
 * Two documents. They share the stylesheet, the fonts and the chrome; only the
 * body, the titles and the file prefix differ. The user manual keeps the bare
 * `<lang>.html` content path it has always had, so nothing that references it
 * — the artifact builder, the in-app `/manual/:locale` route — has to move.
 */
const DOCS = [
  { slug: 'manual', content: (lang) => `${lang}.html` },
  { slug: 'code', content: (lang) => `code.${lang}.html` },
];

const LANGS = {
  ca: {
    title: "Manual d'Inventari",
    description:
      "Manual d'ús de l'aplicació d'inventari: model de dades, tutorial des de " +
      'zero, dia a dia, permisos i límits actuals.',
    codeTitle: "Inventari — el codi",
    codeDescription:
      "Manual d'arquitectura: què fa cada fitxer del codi i per què es va " +
      'escriure així.',
    theme: 'Canvia el tema clar/fosc',
  },
  en: {
    title: 'Inventory Manual',
    description:
      'User manual for the inventory app: data model, from-scratch tutorial, ' +
      'daily use, permissions and current limits.',
    codeTitle: 'Inventory — the code',
    codeDescription:
      'Architecture manual: what every file does and why it was written that ' +
      'way.',
    theme: 'Toggle light/dark theme',
  },
  de: {
    title: 'Inventar-Handbuch',
    description:
      'Handbuch der Inventar-App: Datenmodell, Tutorial von Grund auf, Alltag, ' +
      'Rechte und aktuelle Grenzen.',
    codeTitle: 'Inventar — der Code',
    codeDescription:
      'Architektur-Handbuch: was jede Datei tut und warum sie so geschrieben ' +
      'wurde.',
    theme: 'Helles/dunkles Theme umschalten',
  },
};

/**
 * Language switcher + theme toggle, injected once here instead of being
 * repeated in six content files. The links are relative, so they work straight
 * off the filesystem as long as the files sit together — and they stay inside
 * the document you are reading, so switching language never switches manual.
 */
function chrome(lang, labels, slug) {
  const links = Object.keys(LANGS)
    .map((code) =>
      code === lang
        ? `<span class="on">${code}</span>`
        : `<a href="${slug}.${code}.html">${code}</a>`,
    )
    .join('');
  return (
    `<div class="chrome">${links}` +
    `<button type="button" id="theme" title="${labels.theme}" aria-label="${labels.theme}">◐</button>` +
    `</div>`
  );
}

// Applied before first paint so a stored preference never flashes.
const THEME_JS = `
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('manual-theme'); } catch (e) {}
  if (saved) root.setAttribute('data-theme', saved);
  document.addEventListener('click', function (event) {
    if (!event.target.closest('#theme')) return;
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    var current = root.getAttribute('data-theme') || (dark ? 'dark' : 'light');
    var next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('manual-theme', next); } catch (e) {}
  });
})();`;

const FACES = [
  ['IBM Plex Sans', 400, 'ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2'],
  ['IBM Plex Sans', 600, 'ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2'],
  ['IBM Plex Mono', 400, 'ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
  ['IBM Plex Mono', 500, 'ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'],
];

const fontCss = FACES.map(([family, weight, file]) => {
  const b64 = readFileSync(join(root, 'node_modules/@fontsource', file)).toString('base64');
  return (
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};` +
    `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`
  );
}).join('\n');

const css = readFileSync(join(docs, 'manual.css'), 'utf8');

for (const doc of DOCS) {
  for (const [lang, labels] of Object.entries(LANGS)) {
    const body = readFileSync(join(docs, 'content', doc.content(lang)), 'utf8');
    const title = doc.slug === 'code' ? labels.codeTitle : labels.title;
    const description =
      doc.slug === 'code' ? labels.codeDescription : labels.description;

    const out = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<style>
${fontCss}

${css}</style>
<script>${THEME_JS}</script>
</head>
<body>

${chrome(lang, labels, doc.slug)}

${body}
</body>
</html>
`;

    const name = `${doc.slug}.${lang}.html`;
    writeFileSync(join(docs, name), out);
    console.log(`${name} — ${(out.length / 1024).toFixed(0)} KB`);
  }
}
