// Shot on: the card with camera and settings under the photo.
// Cut from public/app.js on 2026-11-26, when Inspicio went back to metadata only.
// These lines sat inside the app's one big function, so they do not run alone: to bring
// the tool back, paste them into app.js again (archived/shared/app.before.js shows where).

// ---- app.js lines 1180-1188 ----
  // A new aspect ratio or size for a zoomable frame (the card changes shape); back to fit if so.
  function reshape(frame, zoom, ar, natW) {
    const before = frame.style.getPropertyValue('--ar');
    frame.style.setProperty('--ar', String(ar));
    frame.style.setProperty('--nat-w', `${natW}px`);
    if (before !== String(ar)) zoom.reset();
    else zoom.refresh();
  }


// ---- app.js lines 1556-1948 ----
  /* ---------- Shot on: the photo with its camera and settings underneath ---------- */

  // A card drawn on a canvas: the photo inside a border, and up to three lines of text below it.
  // The text starts from the metadata but every line can be edited (a screenshot has none). The
  // card is drawn and saved on this device. Layout is worked out in units of 1/100 of the card's
  // width, so the preview and the saved file match exactly at different sizes.
  const CARD_STYLES = {
    light: { bg: '#ffffff', text: '#17171a', muted: '#6b6b73', font: 'Geist', mono: 'Geist Mono' },
    dark: { bg: '#0f0f11', text: '#f3f3f5', muted: '#9d9da6', font: 'Geist', mono: 'Geist Mono' },
    // Pixel sets everything in the logo's pixel font, so the title font choice doesn't apply.
    pixel: { bg: '#e9f0ee', text: '#19448a', muted: '#55555d', title: '{px} "Departure Mono"', font: 'Departure Mono', mono: 'Departure Mono', sizes: { title: 1.68, details: 1.22, small: 1.04 }, upper: true },
  };
  // Title and settings fonts for Light and Dark. k (title) and dk (settings) even out their sizes:
  // Michroma is very wide and an italic serif reads smaller than mono did. Digicam is the orange
  // segment-display date stamp of 2000s compact cameras: every line, always orange, with a soft glow.
  const CARD_FONTS = {
    fraunces: { label: 'Serif', css: 'italic 500 {px} "Fraunces"', k: 1, dk: 1.15 },
    michroma: { label: 'Wide', css: '400 {px} "Michroma"', k: 0.72, dk: 1 },
    digicam: { label: 'Digicam', css: '400 {px} "DSEG14 Classic"', k: 0.62, dk: 0.85, sk: 0.8, all: true, glow: '#ff5a1f' },
  };
  const CARD_SHAPES = { original: 0, square: 1, portrait: 1.25 }; // card height ÷ width; 0 = fit the photo
  const CARD_LINES = ['title', 'details', 'small'];
  const CARD_SIZE = { title: 2.75, details: 1.34, small: 1.4 };
  const PREVIEW_LONG = 1600;
  const SAVE_LONG = 3240; // long side of a saved card; under Safari's canvas limit at every shape

  // Style and shape are display preferences, so they are remembered. The text is not.
  const CARD_KEY = 'inspicio.card';
  const cardPrefs = (() => {
    const prefs = { style: 'light', font: 'fraunces', shape: 'original' };
    try {
      const saved = JSON.parse(localStorage.getItem(CARD_KEY) || '{}');
      if (Object.hasOwn(CARD_STYLES, saved.style)) prefs.style = saved.style;
      if (Object.hasOwn(CARD_FONTS, saved.font)) prefs.font = saved.font;
      if (Object.hasOwn(CARD_SHAPES, saved.shape)) prefs.shape = saved.shape;
    } catch {
      // Defaults.
    }
    return prefs;
  })();

  function saveCardPrefs() {
    try { localStorage.setItem(CARD_KEY, JSON.stringify(cardPrefs)); } catch { /* not saved */ }
  }

  let cardFonts = null;
  const loadCardFonts = () => (cardFonts ||= Promise.all(['italic 500 20px Fraunces', '20px Michroma', '20px "DSEG14 Classic"', '20px Geist', '20px "Geist Mono"', '20px "Departure Mono"']
    .map((f) => document.fonts.load(f).catch(() => null))));

  const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'long' });

  function cardDefaults(meta) {
    const { get } = indexMetadata(meta.segments);
    const f35 = toNum(get('FocalLengthIn35mmFormat'));
    const iso = toNum(get('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity'));
    const lens = toText(get('LensModel', 'Lens'));
    const taken = get('DateTimeOriginal', 'CreateDate');
    const date = taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null;
    const two = (n) => String(n).padStart(2, '0');
    const small = [lens && !/\b(back|front|camera)\b/i.test(lens) ? lens : null,
      date ? longDate.format(date) : null].filter(Boolean).join('  ·  ');
    return {
      title: toText(get('Model')) || toText(get('Make')) || '', // the model alone: "iPhone 15 Pro"
      // The 35 mm equivalent is the number people know (a phone's 6.86 mm lens is "24 mm").
      details: [f35 ? `${f35} mm` : fmtFocal(get('FocalLength')), fmtAperture(get('FNumber', 'ApertureValue')),
        fmtShutter(get('ExposureTime')), iso ? `ISO ${iso}` : null].filter(Boolean).join('   '),
      // Phones name their lenses like "iPhone 15 Pro back triple camera 6.86mm f/1.78"; those are left out.
      plainSmall: small,
      // A compact camera's date stamp: '26 11 01.
      stampSmall: date ? `'${two(date.getFullYear() % 100)} ${two(date.getMonth() + 1)} ${two(date.getDate())}` : small,
    };
  }

  // Light and Dark set the title and the settings in the chosen font; Pixel uses its own throughout.
  function cardFont(st, line, px, font) {
    const f = st.title ? null : CARD_FONTS[font];
    if (line === 'small' && !f?.all) return `${px}px "${st.font}"`;
    if (f) return f.css.replace('{px}', `${px}px`);
    return line === 'title' ? st.title.replace('{px}', `${px}px`) : `${px}px "${st.mono}"`;
  }

  function cardLayout(ctx, o, ar) {
    // Sizes are in % of the card's width, which is the short side of a tall card. Scale the text
    // and its spacing up there, so a portrait card reads like a landscape one of the same size.
    const tall = Math.min(1.5, Math.max(1, CARD_SHAPES[o.shape] || 1 / ar));
    const st = CARD_STYLES[o.style];
    const pixel = o.style === 'pixel';
    const side = pixel ? 5.5 : 3;
    const top = pixel ? 6 : 3;
    const pad = (pixel ? 2.2 : 1.9) * tall;
    const below = pixel ? 2.2 : 0; // room for the pixel frame under the photo
    const gap = 0.5 * tall;
    const text = {};
    const size = {};
    const width = {};
    const rowH = {};
    for (const k of CARD_LINES) {
      text[k] = String(o[k] || '').trim();
      const f = st.title ? null : CARD_FONTS[o.font];
      if (st.upper || f?.all) text[k] = text[k].toUpperCase();
      // A space in the segment font is a sliver; "!" is its full-width blank.
      if (f?.all) text[k] = text[k].replace(/ +/g, (run) => (run.length > 1 ? '!!' : '!'));
      size[k] = (st.sizes || CARD_SIZE)[k] * tall * (!f ? 1 : k === 'title' ? f.k : k === 'details' ? f.dk : f.sk || 1);
      rowH[k] = size[k] * (k === 'title' ? 1.15 : 1.35);
      ctx.font = cardFont(st, k, 100, o.font);
      width[k] = text[k] ? (ctx.measureText(text[k]).width / 100) * size[k] : 0;
    }
    const rows = CARD_LINES.filter((k) => text[k]);
    const left = ['title', 'small'].filter((k) => text[k]);
    const leftH = left.reduce((a, k) => a + rowH[k], 0) + (left.length > 1 ? gap : 0);

    // Camera on the left, settings on the right when both fit side by side; otherwise one per row.
    const solve = (avail) => {
      const two = Boolean(text.details && left.length
        && Math.max(width.title, width.small) + 5 + width.details <= avail);
      const contentH = two ? Math.max(leftH, rowH.details)
        : rows.reduce((a, k) => a + rowH[k], 0) + Math.max(0, rows.length - 1) * gap;
      return { two, contentH, barH: below + (rows.length ? contentH + 2 * pad : side) };
    };

    const ratio = CARD_SHAPES[o.shape];
    const availW = 100 - 2 * side;
    let lay = solve(availW);
    let pw = availW;
    let H;
    let y = top;
    if (!ratio) {
      H = top + pw / ar + lay.barH;
    } else {
      H = 100 * ratio;
      const fit = (l) => Math.min(availW, (H - top - l.barH) * ar);
      pw = fit(lay);
      const again = solve(pw);
      if (again.barH !== lay.barH) pw = fit(again);
      lay = again;
      y = top + (H - top - lay.barH - pw / ar) / 2;
    }
    const photo = { x: (100 - pw) / 2, y, w: pw, h: pw / ar };
    return { st, pixel, font: o.font, text, size, width, rowH, gap, pad, below, left, leftH, rows, H, photo, ...lay };
  }

  // Pixels per layout unit. A saved card is as sharp as the photo allows, up to SAVE_LONG, and
  // never smaller than the preview.
  function cardScale(L, sw, save) {
    const span = Math.max(100, L.H);
    if (!save) return PREVIEW_LONG / span;
    return Math.min(SAVE_LONG / span, Math.max(sw / L.photo.w, PREVIEW_LONG / span));
  }

  function renderCard(canvas, img, o, save) {
    const ctx = canvas.getContext('2d');
    const L = cardLayout(ctx, o, img.width / img.height);
    const u = cardScale(L, img.width, save);
    canvas.width = Math.round(100 * u);
    canvas.height = Math.round(L.H * u);
    const { st, photo: p } = L;

    ctx.fillStyle = st.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.probe, p.x * u, p.y * u, p.w * u, p.h * u);

    if (L.pixel) {
      // The logo's frame: a gap in the top edge with a square dot breaking out of it.
      const s = 0.7;
      const g = 1.5;
      const dot = 3.1;
      const gapW = 10.6;
      const x0 = p.x - g - s;
      const y0 = p.y - g - s;
      const w = p.w + 2 * (g + s);
      const h = p.h + 2 * (g + s);
      const half = (w - gapW) / 2;
      ctx.fillStyle = st.text;
      for (const [rx, ry, rw, rh] of [[x0, y0, s, h], [x0 + w - s, y0, s, h], [x0, y0 + h - s, w, s],
        [x0, y0, half, s], [x0 + w - half, y0, half, s], [x0 + w / 2 - dot / 2, y0 - 1.3, dot, dot]]) {
        ctx.fillRect(rx * u, ry * u, rw * u, rh * u);
      }
    }

    const glow = !st.title && CARD_FONTS[L.font].glow;
    const line = (k, x, yMid, align, avail) => {
      const fit = Math.min(1, avail / L.width[k]);
      const px = L.size[k] * fit * u;
      ctx.font = cardFont(st, k, px, L.font);
      ctx.textAlign = align;
      if (glow) {
        // A little halation (a wide red haze) and bloom (a tight bright glow) around the segments.
        ctx.fillStyle = glow;
        ctx.shadowColor = 'rgba(255, 40, 0, 0.45)';
        ctx.shadowBlur = px * 0.7;
        ctx.fillText(L.text[k], x * u, yMid * u);
        ctx.shadowColor = 'rgba(255, 150, 70, 0.7)';
        ctx.shadowBlur = px * 0.18;
        ctx.fillText(L.text[k], x * u, yMid * u);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        return;
      }
      ctx.fillStyle = k === 'small' ? st.muted : st.text;
      ctx.fillText(L.text[k], x * u, yMid * u);
    };
    ctx.textBaseline = 'middle';
    const textTop = p.y + p.h + L.below + L.pad;
    const right = p.x + p.w;
    if (L.two) {
      let yy = textTop + (L.contentH - L.leftH) / 2;
      for (const k of L.left) {
        line(k, p.x, yy + L.rowH[k] / 2, 'left', p.w - L.width.details - 5);
        yy += L.rowH[k] + L.gap;
      }
      line('details', right, textTop + L.contentH / 2, 'right', p.w - Math.max(L.width.title, L.width.small) - 5);
    } else {
      let yy = textTop;
      for (const k of L.rows) {
        line(k, p.x, yy + L.rowH[k] / 2, 'left', p.w);
        yy += L.rowH[k] + L.gap;
      }
    }
    return { L, u };
  }

  let card = null; // the open photo's card text, kept while switching tools
  let cardCanvas = null;
  let cardCaption = null;
  let cardFrame = null;
  let cardSaveW = 0; // width of the saved card, which counts as 100% zoom
  let cardZoom = 1; // the preview's zoom level
  let cardHi = false; // whether the preview is drawn at the saved size (when zoomed in)
  let cardHiTimer = 0;
  let cardUrl = null;
  let previewQueued = false;

  const cardOpts = () => ({ ...cardPrefs, title: card.title, details: card.details, small: card.small });

  function drawPreview() {
    if (previewQueued) return;
    previewQueued = true;
    loadCardFonts().then(() => {
      previewQueued = false;
      if (!cardCanvas || !current?.img.ok || !card) return;
      const { img } = current;
      // Zoomed in past the preview's own pixels, the preview is drawn at the saved size instead.
      cardHi = cardWantsHi();
      const { L } = renderCard(cardCanvas, img, cardOpts(), cardHi);
      const u = cardScale(L, img.width, true);
      cardSaveW = Math.round(100 * u);
      cardCaption.textContent = `Saves at ${cardSaveW} × ${Math.round(L.H * u)}`;
      if (cardFrame && stageZoom) reshape(cardFrame, stageZoom, 100 / L.H, cardSaveW);
    });
  }

  function cardWantsHi() {
    if (!cardFrame || cardZoom <= 1) return false;
    const shown = cardFrame.clientWidth * cardZoom * (window.devicePixelRatio || 1);
    return shown > (PREVIEW_LONG * cardFrame.clientWidth) / Math.max(cardFrame.clientWidth, cardFrame.clientHeight) * 1.1;
  }

  // Redraws the preview at the size the zoom needs, once zooming settles.
  function cardZoomed(scale) {
    cardZoom = scale;
    clearTimeout(cardHiTimer);
    cardHiTimer = setTimeout(() => { if (cardCanvas && cardWantsHi() !== cardHi) drawPreview(); }, 250);
  }

  function buildCardStage() {
    cardCanvas = el('canvas', { class: 'card-canvas' });
    cardCaption = el('span', null, 'Preview');
    // Until the fonts load and the card is drawn, the frame has the photo's shape.
    const { img } = current;
    stageZoom?.stop();
    const z = zoomable(cardCanvas, { ar: img.width / img.height, natW: PREVIEW_LONG, label: 'Preview of the card.',
      pixels: () => Math.max(cardSaveW, cardCanvas.width), full: () => cardSaveW || cardCanvas.width,
      onZoom: cardZoomed });
    cardFrame = z.frame;
    stageZoom = z.zoom;
    cardZoom = 1;
    cardHi = false;
    drawPreview();
    return el('figure', { class: 'photo card-stage' }, z.frame, el('figcaption', null, cardCaption, z.controls));
  }

  async function saveCard(button, note) {
    if (!current?.img.ok || !card) return;
    button.disabled = true;
    const aspect = cardCanvas?.width ? cardCanvas.height / cardCanvas.width : 1.3;
    const pixels = (cardSaveW || 2400) ** 2 * aspect;
    const progress = saveProgress({ eyebrow: 'Shot on card', steps: ['card', 'encoding'], megapixels: pixels / 1e6, learn: false });
    progress.step('card');
    try {
      await loadCardFonts();
      await settled();
      const canvas = document.createElement('canvas');
      renderCard(canvas, current.img, cardOpts(), true);
      const { width, height } = canvas;
      progress.step('encoding');
      await painted();
      const blob = await toJpeg(canvas, 0.92);
      canvas.width = 0;
      if (!blob) throw new Error('could not save');
      if (cardUrl) URL.revokeObjectURL(cardUrl);
      cardUrl = URL.createObjectURL(blob);
      const name = `${baseName(current.file.name)}-shot-on.jpg`;
      const size = `${width} × ${height}, ${fmtBytes(blob.size)}`;
      deliver(progress, blob, cardUrl, name, `${name} · ${size}`);
      note.textContent = `Saved ${name}, ${size}. Made on this device.`;
    } catch {
      const msg = 'Couldn’t save the card. This browser may not have enough memory for a photo this large.';
      progress.fail(msg);
      note.textContent = msg;
    }
    button.disabled = false;
  }

  function buildCardPanel(file, meta, img) {
    if (img.ok && narrowLayout.matches) return buildCardEditor(file, meta);
    // The small line follows the font (a date stamp for Digicam) until the viewer edits it.
    const stampy = () => cardPrefs.style !== 'pixel' && Boolean(CARD_FONTS[cardPrefs.font].glow);
    const autoSmall = () => {
      if (!card.smallEdited) card.small = stampy() ? card.stampSmall : card.plainSmall;
    };
    if (card?.file !== file) card = { file, smallEdited: false, ...cardDefaults(meta) };
    autoSmall();
    const inputs = {};
    const nodes = [el('div', { class: 'summary' },
      el('p', { class: 'summary-eyebrow', title: file.name }, file.name),
      el('h1', { class: 'summary-title' }, 'Shot on card'),
      el('p', { class: 'summary-sub' }, 'Your photo with its camera and settings underneath. Edit any line.'),
    )];
    if (!img.ok) {
      nodes.push(notice('Can’t make a card', /\.(heic|heif)$/i.test(file.name)
        ? 'This HEIC photo couldn’t be decoded here. Save it as a JPEG and try again.'
        : 'This browser can’t show this photo, so it can’t draw a card with it.'));
      return nodes;
    }

    const seg = (key, label, options, cls) => {
      const box = el('div', { class: `seg${cls ? ` ${cls}` : ''}`, role: 'group', 'aria-label': label },
        options.map(([value, text]) => el('button', {
          type: 'button', 'data-value': value, 'aria-pressed': String(cardPrefs[key] === value),
        }, text)));
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        cardPrefs[key] = b.dataset.value;
        for (const other of box.children) other.setAttribute('aria-pressed', String(other === b));
        placeFill(box);
        saveCardPrefs();
        if (key === 'style') fontRow.hidden = cardPrefs.style === 'pixel';
        autoSmall();
        inputs.small.value = card.small;
        drawPreview();
      });
      trackFill(box);
      return el('div', { class: 'card-row' }, el('span', { class: 'card-label' }, label), box);
    };

    // Each font button is set in its own font. Hidden for Pixel, which has its own font.
    const fontRow = seg('font', 'Font', Object.entries(CARD_FONTS).map(([value, f]) => [value, f.label]), 'seg-fonts');
    fontRow.hidden = cardPrefs.style === 'pixel';

    const field = (label, key, placeholder) => {
      const input = el('input', { type: 'text', maxlength: '80', placeholder, spellcheck: 'false', autocomplete: 'off' });
      input.value = card[key];
      inputs[key] = input;
      input.addEventListener('input', () => {
        card[key] = input.value;
        if (key === 'small') card.smallEdited = true;
        drawPreview();
      });
      return el('label', { class: 'card-row' }, el('span', { class: 'card-label' }, label), input);
    };

    const save = el('button', { class: 'map-link wipe-save', type: 'button' }, icon('file'), 'Save card');
    const note = el('p', { class: 'map-note' }, 'Saved as a JPEG on this device. Your original stays as it is.');
    save.addEventListener('click', () => saveCard(save, note));

    nodes.push(
      el('div', { class: 'card-controls' },
        seg('style', 'Style', [['light', 'Light'], ['dark', 'Dark'], ['pixel', 'Pixel']]),
        fontRow,
        seg('shape', 'Shape', [['original', 'Original'], ['square', 'Square'], ['portrait', '4:5']]),
        field('Title', 'title', 'Camera'),
        field('Settings', 'details', '35 mm   f/1.8   1/250 s   ISO 100'),
        field('Small line', 'small', 'Lens, place or date'),
      ),
      save,
      note,
    );
    return nodes;
  }

