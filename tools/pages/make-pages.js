// Makes one page per tool (public/remove-metadata.html) from public/index.html, so each
// tool can be found in search under its own address. The site itself has no build step: these
// pages are committed like any other file. Run this after every change to index.html, or to the
// tool titles and lines in MODES (app.js):
//
//   node tools/pages/make-pages.js          write the pages
//   node tools/pages/make-pages.js --check  only report whether they are up to date
//
// Each page is index.html with its own title, description, address and structured data, the tool
// already chosen (data-tool on <html>, read by app.js), and its own write-up below the first screen
// in place of the home page's.

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const SITE = 'https://inspicio.app';

const PAGES = [
  {
    tool: 'wipe',
    file: 'remove-metadata.html',
    url: `${SITE}/remove-metadata`,
    description: 'Remove EXIF data, GPS location, date and camera details from a photo before you share it. Free, works on iPhone, and your photo is never uploaded.',
    about: `
      <h2>Remove metadata from a photo</h2>
      <p class="doc-lead">Most photos carry more than the picture: where they were taken, when, and with which camera. Inspicio shows you all of it, then saves a clean copy without it.</p>
      <ul>
        <li><strong>Location.</strong> Phones save the GPS position of every photo. Anyone with the file can find the place, often to within a few meters.</li>
        <li><strong>Date and time.</strong> The exact moment the photo was taken, down to the second.</li>
        <li><strong>Camera and lens.</strong> The make, model, lens and settings, and on some cameras the serial number.</li>
        <li><strong>Software and edits.</strong> The apps the photo went through, and sometimes extra hidden images.</li>
      </ul>
      <h2>How it works</h2>
      <p>Drop a photo, see what it gives away, and save the clean copy. JPEG and PNG photos are cleaned without touching the picture itself, so there is no loss of quality; the color profile and the rotation are kept. Other formats, such as HEIC from an iPhone, are saved as a high quality JPEG. The copy is read again before you save it, to make sure nothing was left behind.</p>
      <h2>Questions</h2>
      <h3>Is my photo uploaded?</h3>
      <p>No. Everything runs in your browser. The photo never leaves your phone or computer, and there is no account.</p>
      <h3>Does it work on iPhone?</h3>
      <p>Yes. Open the page in Safari, choose a photo, and save the clean copy straight back to Photos.</p>
      <h3>Does it make the photo worse?</h3>
      <p>Not for JPEG and PNG, which keep every pixel. Other formats are saved once as a high quality JPEG.</p>`,
  },
];

const OTHER_LINKS = {
  inspect: ['./', 'See photo metadata'],
  wipe: ['remove-metadata', 'Remove photo metadata'],
};

// Tool titles and lines come from MODES in app.js, so the page shows what app.js would show.
function readModes() {
  const src = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const match = src.match(/const MODES = (\{[\s\S]*?\n  \});/);
  if (!match) throw new Error('MODES not found in app.js');
  return new Function(`return ${match[1]}`)();
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Each change must hit exactly once, so a change to index.html can't slip by unnoticed.
function replaceOnce(html, from, to, page) {
  const count = typeof from === 'string' ? html.split(from).length - 1 : (html.match(new RegExp(from.source, 'g')) || []).length;
  if (count !== 1) throw new Error(`${page.file}: expected one match for ${from}, found ${count}`);
  return html.replace(from, to);
}

// What the page is for search engines: the tool as a free web app, and its place under the home page.
function structuredData(page) {
  const name = OTHER_LINKS[page.tool][1];
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name,
        url: page.url,
        image: `${SITE}/og-image.png`,
        description: page.description,
        applicationCategory: 'MultimediaApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isPartOf: { '@id': `${SITE}/#website` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Inspicio', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name, item: page.url },
        ],
      },
    ],
  };
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c').replace(/^/gm, '  ');
  return `  <script type="application/ld+json">\n${json}\n  </script>\n`;
}

function makePage(index, modes, page) {
  const m = modes[page.tool];
  const title = escapeHtml(m.doc);
  const description = escapeHtml(page.description);
  const r = (html, from, to) => replaceOnce(html, from, to, page);
  let html = index;
  html = r(html, '<html lang="en" data-look="pixel">', `<html lang="en" data-look="pixel" data-tool="${page.tool}">`);
  html = r(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = r(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${description}">`);
  html = r(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${page.url}">`);
  html = r(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${title}">`);
  html = r(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${description}">`);
  html = r(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${page.url}">`);
  // The home page's structured data describes the whole site; each tool page describes itself instead.
  html = r(html, /  <script type="application\/ld\+json">[\s\S]*?<\/script>\n/, () => structuredData(page));
  html = r(html, /<h1 id="hero-title">[^<]*<br>[^<]*<\/h1>/, `<h1 id="hero-title">${escapeHtml(m.title[0])}<br>${escapeHtml(m.title[1])}</h1>`);
  html = r(html, /<p id="hero-sub">[^<]*<\/p>/, `<p id="hero-sub">${escapeHtml(m.sub)}</p>`);
  html = r(html, /(<span class="dropzone-sub" id="dropzone-sub">)[^<]*(<\/span>)/, `$1${escapeHtml(m.dropSub)}$2`);
  html = r(html, 'data-mode="inspect" aria-pressed="true"', 'data-mode="inspect" aria-pressed="false"');
  html = r(html, `data-mode="${page.tool}" aria-pressed="false"`, `data-mode="${page.tool}" aria-pressed="true"`);

  const links = Object.entries(OTHER_LINKS)
    .filter(([tool]) => tool !== page.tool)
    .map(([, [href, label]]) => `<a href="${href}">${label}</a>`)
    .join('\n        ');
  const about = `<section class="doc tool-about" id="tool-about">${page.about}
      <nav class="doc-links tool-links" aria-label="More tools">
        ${links}
      </nav>
    </section>`;
  // Replaces the home page's own write-up (the Inspect tool) with this tool's.
  html = r(html, /<section class="doc tool-about" id="tool-about">[\s\S]*?<\/section>/, () => about);
  // The note goes after the doctype: anything before it would put the page in quirks mode.
  return r(html, '<!doctype html>\n', "<!doctype html>\n<!-- Made by tools/pages/make-pages.js from index.html. Don't edit by hand. -->\n");
}

const check = process.argv.includes('--check');
const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const modes = readModes();
let stale = 0;
for (const page of PAGES) {
  const out = makePage(index, modes, page);
  const file = path.join(PUBLIC, page.file);
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === out) continue;
  stale++;
  if (check) console.log(`out of date: ${page.file}`);
  else { fs.writeFileSync(file, out); console.log(`wrote ${page.file}`); }
}
if (check) {
  console.log(stale ? `${stale} page(s) out of date; run node tools/pages/make-pages.js` : 'pages up to date');
  process.exitCode = stale ? 1 : 0;
}
