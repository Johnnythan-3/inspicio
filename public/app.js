/* Inspicio: reads photo metadata entirely in the browser with exifr. Nothing is uploaded. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const app = $('#app');
  const emptyView = $('#empty-view');
  const viewerView = $('#viewer-view');
  const dropzone = $('#dropzone');
  const fileInput = $('#file-input');
  const openAnother = $('#open-another');
  const panel = $('#panel');
  const stage = $('#stage');
  const errorBox = $('#error');

  // Less motion when the system asks for it or Motion is set to Calm in the display settings.
  const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduceMotion = { get matches() { return reduceQuery.matches || window.inspicioPrefs?.get('motion') === 'calm'; } };
  // The pixel effects (reveal, decoding numbers, data bits) belong to the Pixel look only.
  const pixelLook = () => window.inspicioPrefs?.get('look') === 'pixel';
  const isDark = () => (window.inspicioPrefs ? window.inspicioPrefs.isDark()
    : window.matchMedia('(prefers-color-scheme: dark)').matches);

  let currentUrl = null;
  let loadToken = 0;

  /* ---------- Mapbox (opt-in map) ---------- */

  // Public Mapbox token (pk.…). It is visible to anyone, so restrict it to this site's URLs in the
  // Mapbox account. Leave it empty to hide the "Show map" button entirely.
  // The map image is requested only when the user clicks "Show map"; that request sends the
  // photo's coordinates to Mapbox. Nothing else about the photo ever leaves the browser.
  const MAPBOX_TOKEN = 'pk.eyJ1Ijoiam9obm55dGhhbiIsImEiOiJjbXc0M3Z3OGIwMGxtMnlxOTBrbHp0NG5uIn0.-eNoje28G2ualpJeuOexnA';

  /* ---------- exifr ---------- */

  const EXIFR_OPTIONS = {
    tiff: true,
    exif: true,
    gps: true,
    interop: false,
    ifd1: false,
    makerNote: false,
    userComment: true,
    iptc: true,
    xmp: true,
    icc: true,
    jfif: true,
    ihdr: true,
    multiSegment: true,
    mergeOutput: false,
    translateKeys: true,
    translateValues: true,
    reviveValues: true,
    sanitize: true,
  };

  const SEGMENT_LABELS = {
    ifd0: 'TIFF / IFD0',
    exif: 'EXIF',
    gps: 'GPS',
    iptc: 'IPTC',
    xmp: 'XMP',
    icc: 'ICC profile',
    jfif: 'JFIF',
    ihdr: 'PNG header',
    dc: 'XMP · Dublin Core',
    photoshop: 'XMP · Photoshop',
    xmpMM: 'XMP · Media management',
    aux: 'XMP · Camera extras',
    exifEX: 'XMP · EXIF extras',
  };

  // Segments that only describe the file or its colors, not the photo. Screenshots and exported images often have these.
  const CONTAINER_SEGMENTS = new Set(['jfif', 'ihdr', 'icc']);
  // exifr puts a PNG's text chunks (Author, Comment, …) in the same segment as its header, so only
  // the header fields count as container data there.
  const PNG_HEADER = new Set(['ImageWidth', 'ImageHeight', 'BitDepth', 'ColorType', 'Compression', 'Filter', 'Interlace']);
  const isPhotoTag = (l) => !CONTAINER_SEGMENTS.has(l.segment) || (l.segment === 'ihdr' && !PNG_HEADER.has(l.key));

  async function readMetadata(file) {
    if (!window.exifr) return { segments: {}, error: 'The metadata reader failed to load. Reload the page and try again.' };
    try {
      const out = await window.exifr.parse(file, EXIFR_OPTIONS);
      return { segments: out || {}, error: null };
    } catch (err) {
      const msg = String((err && err.message) || err);
      const unsupported = /unknown file format|invalid input|not supported/i.test(msg);
      return {
        segments: {},
        error: unsupported ? 'Inspicio can’t read metadata from this file format yet.' : `Couldn’t read metadata: ${msg}`,
      };
    }
  }

  /* ---------- Metadata index ---------- */

  const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  const isLangValue = (v) => isPlainObject(v) && 'value' in v && Object.keys(v).length <= 2;

  // Flattens exifr's per-segment output into a list of leaf tags and a case-insensitive lookup.
  function indexMetadata(segments) {
    const leaves = [];
    const lookup = new Map();

    const walk = (obj, segment, prefix) => {
      for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null || value === '' || key === 'parseType') continue;
        if (isPlainObject(value) && !isLangValue(value)) {
          walk(value, segment, `${prefix}${key}.`);
          continue;
        }
        leaves.push({ segment, key: `${prefix}${key}`, value });
        const k = key.toLowerCase();
        if (!lookup.has(k)) lookup.set(k, value);
      }
    };

    const order = ['ifd0', 'exif', 'gps', 'iptc', 'xmp', 'icc', 'ihdr', 'jfif'];
    const names = [...order.filter((s) => segments[s]), ...Object.keys(segments).filter((s) => !order.includes(s))];
    for (const name of names) {
      const seg = segments[name];
      if (name !== 'errors' && isPlainObject(seg)) walk(seg, name, '');
    }

    const get = (...keys) => {
      for (const key of keys) {
        const v = lookup.get(key.toLowerCase());
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return undefined;
    };

    return { leaves, get };
  }

  /* ---------- Formatting ---------- */

  const toNum = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if ((Array.isArray(v) || ArrayBuffer.isView(v)) && typeof v[0] === 'number') return v[0];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };

  const round = (n, d = 1) => Number(n.toFixed(d));

  function toText(v) {
    if (v === undefined || v === null) return null;
    if (isLangValue(v)) return toText(v.value);
    if (Array.isArray(v)) {
      const parts = v.map(toText).filter(Boolean);
      return parts.length ? parts.join(', ') : null;
    }
    if (v instanceof Date) return fmtDate(v);
    const s = clean(String(v)).trim();
    return s || null;
  }

  function fmtBytes(n) {
    if (!Number.isFinite(n)) return null;
    const units = ['bytes', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return i === 0 ? `${n} bytes` : `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  function fmtShutter(v) {
    const t = toNum(v);
    if (t === null || t <= 0) return null;
    if (t >= 1) return `${round(t, 1)} s`;
    const denom = 1 / t;
    return `1/${denom >= 10 ? Math.round(denom) : round(denom, 1)} s`;
  }

  function fmtAperture(v) {
    const f = toNum(v);
    return f ? `f/${round(f, 1)}` : null;
  }

  function fmtFocal(v) {
    const mm = toNum(v);
    return mm ? `${round(mm, 1)} mm` : null;
  }

  function fmtEV(v) {
    const ev = toNum(v);
    if (ev === null) return null;
    if (ev === 0) return '0 EV';
    return `${ev > 0 ? '+' : '−'}${round(Math.abs(ev), 2)} EV`;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

  function fmtDate(v, offset) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return dateFmt.format(v) + (offset ? ` (UTC${offset})` : '');
    }
    return toText(v);
  }

  function fmtDMS(deg, pos, neg) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return `${d}° ${m}′ ${s.toFixed(1)}″ ${deg >= 0 ? pos : neg}`;
  }

  function coordinate(value, ref) {
    let deg = null;
    if (typeof value === 'number') deg = value;
    else if (Array.isArray(value) && value.length >= 1 && value.every((x) => typeof x === 'number')) {
      deg = value[0] + (value[1] || 0) / 60 + (value[2] || 0) / 3600;
    }
    if (deg === null || !Number.isFinite(deg)) return null;
    if (typeof ref === 'string' && /^[SW]/i.test(ref.trim()) && deg > 0) deg = -deg;
    return deg;
  }

  function fmtRaw(v) {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid date' : dateFmt.format(v);
    if (ArrayBuffer.isView(v) && v.byteLength <= 8 && 'length' in v) return Array.from(v).join(', ');
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `‹binary, ${v.byteLength} ${v.byteLength === 1 ? 'byte' : 'bytes'}›`;
    if (Array.isArray(v)) {
      const shown = v.slice(0, 40).map(fmtRaw).join(', ');
      return v.length > 40 ? `${shown}, … (${v.length} items)` : shown;
    }
    if (isLangValue(v)) return fmtRaw(v.value);
    if (typeof v === 'number') return String(Number.isInteger(v) ? v : round(v, 6));
    if (typeof v === 'object' && v !== null) {
      try { return truncate(JSON.stringify(v)); } catch { return String(v); }
    }
    return truncate(clean(String(v))) || '—';
  }

  // Strips control characters that some cameras pad strings with.
  const clean = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

  function flashText(flash, fired) {
    if (typeof flash === 'string' || typeof flash === 'number') return toText(flash);
    if (fired === true || fired === 'True') return 'Fired';
    if (fired === false || fired === 'False') return 'Did not fire';
    return null;
  }

  function colorSpaceText(v) {
    const n = toNum(v);
    if (n === 1) return 'sRGB';
    if (n === 2) return 'Adobe RGB';
    if (n === 65535) return 'Uncalibrated';
    return typeof v === 'string' ? toText(v) : null;
  }

  function stars(rating) {
    const r = Math.max(0, Math.min(5, Math.round(rating)));
    return '★'.repeat(r) + '☆'.repeat(5 - r);
  }

  const truncate = (s, max = 600) => (s.length > max ? `${s.slice(0, max)}…` : s);

  function cameraName(make, model) {
    const mk = toText(make);
    const md = toText(model);
    if (!mk) return md;
    if (!md) return mk;
    return md.toLowerCase().startsWith(mk.toLowerCase().split(' ')[0]) ? md : `${mk} ${md}`;
  }

  /* ---------- DOM helpers ---------- */

  // Metadata is untrusted input, so text always goes through textContent, never innerHTML.
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'vars') for (const [name, val] of Object.entries(v)) node.style.setProperty(name, val);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    camera: 'M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
    exposure: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3v18M3 12h18M5.6 5.6l12.8 12.8',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3.5 2',
    pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5',
    image: 'M5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13A1.5 1.5 0 0 1 5.5 4M4 16l5-5 4 4 2.5-2.5L20 17M15.5 8.5h.01',
    text: 'M5 5h14M5 10h14M5 15h9M5 20h6',
    file: 'M7 3h7l5 5v11.5A1.5 1.5 0 0 1 17.5 21h-10A1.5 1.5 0 0 1 6 19.5v-15A1.5 1.5 0 0 1 7.5 3M14 3v5h5',
    tags: 'M4 4h7l9 9-7 7-9-9zM8 8h.01',
    info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v6M12 7.5h.01',
    chevron: 'M6 9l6 6 6-6',
    external: 'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  };

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  /* ---------- Collapsed sections ---------- */

  // Which sections the viewer has collapsed, by title. This is a display preference only; it never
  // holds anything from a photo. Storage can be blocked (private mode), so every access is guarded.
  const COLLAPSED_KEY = 'inspicio.collapsed';
  const collapsed = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((t) => typeof t === 'string') : []);
    } catch {
      return new Set();
    }
  })();

  function saveCollapsed() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      // Not saved; the choice still applies until the page is closed.
    }
  }

  let groupSeq = 0;

  // rows: [label, value, note?, copyText?]; rows with no value are dropped. Returns null if nothing
  // is left. A row with copyText becomes a button that copies that text to the clipboard.
  // Clicking the header collapses or expands the section, and the choice is remembered.
  // Values that are measurements (1/250 s, f/2.8, ISO 400, 4032 × 3024, coordinates, 2.4 MB) get
  // the mono face; words like "Auto" or "Apple" stay in the text face.
  function isNumeric(value) {
    return typeof value === 'string' && /^(?:[-−+]?\d|f\/|ISO\s)/.test(value.trim());
  }

  function group(title, iconName, rows, index, extra) {
    const kept = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
    if (!kept.length && !extra) return null;

    const bodyId = `group-body-${++groupSeq}`;
    const isCollapsed = collapsed.has(title);
    const body = el('div', { class: 'group-body', id: bodyId, inert: isCollapsed },
      el('div', { class: 'group-inner' },
        kept.length ? el('dl', { class: 'rows' },
          kept.map(([label, value, note, copyText]) => el('div', { class: 'row' },
            el('dt', null, label),
            el('dd', { class: isNumeric(value) ? 'num' : null }, copyText
              ? copyButton(copyText, [value, note ? el('small', null, note) : null])
              : [value, note ? el('small', null, note) : null]),
          )),
        ) : null,
        extra || null,
      ),
    );
    const toggle = el('button', {
      class: 'group-toggle',
      type: 'button',
      'aria-expanded': String(!isCollapsed),
      'aria-controls': bodyId,
    }, icon(iconName), el('span', { class: 'group-title' }, title), icon('chevron', 'group-chevron'));
    const section = el('section', { class: `group${isCollapsed ? ' is-collapsed' : ''}`, vars: { '--i': index } },
      el('h2', { class: 'group-head' }, toggle),
      body,
    );

    toggle.addEventListener('click', () => {
      const nowCollapsed = !section.classList.contains('is-collapsed');
      section.classList.toggle('is-collapsed', nowCollapsed);
      toggle.setAttribute('aria-expanded', String(!nowCollapsed));
      body.inert = nowCollapsed;
      if (nowCollapsed) collapsed.add(title);
      else collapsed.delete(title);
      saveCollapsed();
    });

    return section;
  }

  // Shows `content`; on click, copies `text` and briefly says so in place of the content.
  function copyButton(text, content) {
    const button = el('button', {
      class: 'copy-value',
      type: 'button',
      title: `Copy ${text}`,
      'aria-label': `Copy coordinates ${text}`,
    }, content);
    let timer = null;
    const restore = () => {
      clearTimeout(timer);
      button.classList.remove('is-copied');
      button.replaceChildren(...content.filter(Boolean));
    };
    button.restoreCopy = restore;
    button.addEventListener('click', async () => {
      let ok = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        ok = false;
      }
      // Only the row that was just clicked shows the message.
      for (const other of document.querySelectorAll('.copy-value.is-copied')) {
        if (other !== button) other.restoreCopy?.();
      }
      clearTimeout(timer);
      button.classList.add('is-copied');
      button.replaceChildren(el('span', { class: 'copy-done', role: 'status' },
        ok ? 'Copied to clipboard' : 'Couldn’t copy'));
      timer = setTimeout(restore, 1600);
    });
    return button;
  }

  // A "Show map" button that swaps itself for a Mapbox static map with a pin. No request is made
  // until the user clicks.
  function mapPreview(lat, lon) {
    const box = el('div', { class: 'map-box' });
    const button = el('button', { class: 'map-link', type: 'button' }, icon('pin'), 'Show map');
    const note = el('p', { class: 'map-note' },
      'Loads a map from Mapbox, which receives the coordinates and, like any website, your IP address. '
      + 'Your photo stays here.');

    button.addEventListener('click', () => {
      const dark = isDark();
      const style = dark ? 'dark-v11' : 'streets-v12';
      const pinColor = dark ? '89ade6' : '19448a';
      const lo = lon.toFixed(6);
      const la = lat.toFixed(6);
      const src = `https://api.mapbox.com/styles/v1/mapbox/${style}/static/`
        + `pin-l+${pinColor}(${lo},${la})/${lo},${la},14,0/600x360@2x`
        + `?access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;

      const img = el('img', {
        class: 'map-img',
        alt: 'Map with a pin where the photo was taken',
        width: '600',
        height: '360',
      });
      // Mapbox checks URL-restricted tokens against the Referer, so send this site's origin
      // (and nothing more) for this one request. The rest of the site stays no-referrer.
      img.referrerPolicy = 'strict-origin';
      img.addEventListener('load', () => box.classList.add('is-loaded'));
      img.addEventListener('error', () => {
        box.replaceChildren(el('p', { class: 'map-note map-error' }, 'The map couldn’t load. Try the link below.'));
      });
      img.src = src;

      // Mapbox requires a text attribution near static maps (Product Terms §1.4); the credit drawn
      // into the image is too small to read or click at panel width.
      const credit = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
      box.replaceChildren(
        el('div', { class: 'map-frame' }, img),
        el('p', { class: 'map-credit' },
          credit('https://www.mapbox.com/about/maps/', '© Mapbox'), ' ',
          credit('https://www.openstreetmap.org/copyright', '© OpenStreetMap'), ' ',
          el('strong', null, credit('https://www.mapbox.com/map-feedback/', 'Improve this map')),
        ),
      );
    }, { once: true });

    box.append(button, note);
    return box;
  }

  /* ---------- Panel ---------- */

  function locationOf(get) {
    const lat = coordinate(get('latitude') ?? get('GPSLatitude'), toText(get('GPSLatitudeRef')));
    const lon = coordinate(get('longitude') ?? get('GPSLongitude'), toText(get('GPSLongitudeRef')));
    return { lat, lon, hasCoords: lat !== null && lon !== null && !(lat === 0 && lon === 0) };
  }

  function buildPanel(file, meta, img) {
    const { leaves, get } = indexMetadata(meta.segments);
    const photoTags = leaves.filter(isPhotoTag);
    const nodes = [];
    let i = 0;

    // Summary
    const camera = cameraName(get('Make'), get('Model'));
    const lens = toText(get('LensModel', 'Lens', 'LensInfo'));
    const chips = [
      fmtFocal(get('FocalLength')),
      fmtAperture(get('FNumber', 'ApertureValue')),
      fmtShutter(get('ExposureTime')),
      toNum(get('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity')) ? `ISO ${toNum(get('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity'))}` : null,
    ].filter(Boolean);

    nodes.push(el('div', { class: 'summary' },
      camera ? el('p', { class: 'summary-eyebrow', title: file.name }, file.name) : null,
      el('h1', { class: 'summary-title' }, camera || file.name),
      lens ? el('p', { class: 'summary-sub' }, lens) : null,
      chips.length ? el('ul', { class: 'chips' }, chips.map((c) => el('li', null, c))) : null,
    ));

    // A camera photo with few pixels is usually a shrunk copy, for example one dragged out of the
    // Photos app (the browser receives a small preview) or sent through a messaging app.
    const longSide = img.ok ? Math.max(img.width, img.height) : 0;
    if (longSide && longSide < 1200 && !img.rawPreview && (camera || get('DateTimeOriginal'))) {
      nodes.push(notice(
        `Small copy: ${img.width} × ${img.height} pixels`,
        'Photos and messaging apps often hand over a reduced preview. For full size, pick it from Photos '
        + 'in the window below, or drag it to your Desktop first.',
        { label: 'Choose full-size photo', onClick: () => fileInput.click() },
      ));
    }

    if (meta.error) {
      nodes.push(notice('Metadata couldn’t be read', meta.error));
    } else if (!photoTags.length) {
      nodes.push(notice(
        'No photo metadata found',
        'This is normal for screenshots and for images saved from social media or messaging apps, which usually strip it. Basic file details are below.',
      ));
    }

    // Camera
    nodes.push(group('Camera', 'camera', [
      ['Make', toText(get('Make'))],
      ['Model', toText(get('Model'))],
      ['Lens', lens],
      ['Lens make', toText(get('LensMake'))],
      ['Software', toText(get('Software', 'CreatorTool'))],
      ['Owner', toText(get('OwnerName', 'CameraOwnerName'))],
    ], i++));

    // Exposure
    const focal35 = toNum(get('FocalLengthIn35mmFormat'));
    const iso = toNum(get('ISO', 'ISOSpeedRatings', 'PhotographicSensitivity'));
    nodes.push(group('Exposure', 'exposure', [
      ['Shutter speed', fmtShutter(get('ExposureTime'))],
      ['Aperture', fmtAperture(get('FNumber', 'ApertureValue'))],
      ['ISO', iso ? String(iso) : null],
      ['Focal length', fmtFocal(get('FocalLength')), focal35 ? `${focal35} mm in 35 mm terms` : null],
      ['Exposure comp.', fmtEV(get('ExposureCompensation', 'ExposureBiasValue'))],
      ['Program', toText(get('ExposureProgram'))],
      ['Exposure mode', toText(get('ExposureMode'))],
      ['Metering', toText(get('MeteringMode'))],
      ['Flash', flashText(get('Flash'), get('Fired'))],
      ['White balance', toText(get('WhiteBalance'))],
      ['Scene', toText(get('SceneCaptureType'))],
    ], i++));

    // Date & time
    nodes.push(group('Date & time', 'clock', [
      ['Taken', fmtDate(get('DateTimeOriginal'), toText(get('OffsetTimeOriginal')))],
      ['Digitized', fmtDate(get('CreateDate', 'DateTimeDigitized'), toText(get('OffsetTimeDigitized')))],
      ['Modified', fmtDate(get('ModifyDate', 'DateTime'), toText(get('OffsetTime')))],
    ], i++));

    // Location
    const { lat, lon, hasCoords } = locationOf(get);
    let altitude = toNum(get('GPSAltitude'));
    const altRef = get('GPSAltitudeRef');
    if (altitude !== null && (toNum(altRef) === 1 || /below/i.test(String(altRef)))) altitude = -altitude;
    const direction = toNum(get('GPSImgDirection'));

    let mapLink = null;
    if (hasCoords) {
      const la = lat.toFixed(6);
      const lo = lon.toFixed(6);
      mapLink = [
        MAPBOX_TOKEN ? mapPreview(lat, lon) : null,
        el('a', {
          class: 'map-link',
          href: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`,
          target: '_blank',
          rel: 'noopener noreferrer',
        }, 'Open in OpenStreetMap', icon('external')),
      ];
    }

    const coords = hasCoords ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : null;
    nodes.push(group('Location', 'pin', [
      ['Latitude', hasCoords ? fmtDMS(lat, 'N', 'S') : null, hasCoords ? lat.toFixed(6) : null, coords],
      ['Longitude', hasCoords ? fmtDMS(lon, 'E', 'W') : null, hasCoords ? lon.toFixed(6) : null, coords],
      ['Altitude', altitude !== null ? `${round(altitude, 1)} m` : null],
      ['Facing', direction !== null ? `${Math.round(direction)}°` : null],
    ], i++, mapLink));

    // Description & rights
    const keywords = get('Keywords', 'subject');
    const rating = toNum(get('Rating'));
    nodes.push(group('Description', 'text', [
      ['Title', toText(get('title', 'ObjectName', 'Headline'))],
      ['Caption', toText(get('ImageDescription', 'description', 'Caption', 'Caption-Abstract'))],
      ['Keywords', toText(keywords)],
      ['Artist', toText(get('Artist', 'creator', 'Author', 'Byline', 'By-line'))],
      ['Copyright', toText(get('Copyright', 'rights', 'CopyrightNotice'))],
      ['Credit', toText(get('Credit'))],
      ['Rating', rating && rating > 0 ? stars(rating) : null],
      ['Comment', toText(get('UserComment'))],
    ], i++));

    // Image. Prefer the pixels actually in this file; EXIF may still describe the camera's original.
    const exifW = toNum(get('ExifImageWidth', 'PixelXDimension', 'ImageWidth'));
    const exifH = toNum(get('ExifImageHeight', 'PixelYDimension', 'ImageHeight'));
    const width = (img.ok ? img.width : null) || exifW;
    const height = (img.ok ? img.height : null) || exifH;
    const exifBigger = img.ok && exifW && exifH && Math.max(exifW, exifH) > Math.max(img.width, img.height);
    const xres = toNum(get('XResolution'));
    const resUnit = toText(get('ResolutionUnit'));
    nodes.push(group('Image', 'image', [
      ['Dimensions', width && height ? `${width} × ${height}` : null, width && height
        ? `${round((width * height) / 1e6, 1)} megapixels`
          + (img.rawPreview ? ' · embedded preview' : '')
          + (exifBigger ? ` · camera recorded ${exifW} × ${exifH}` : '')
        : null],
      ['Orientation', toText(get('Orientation'))],
      ['Color space', colorSpaceText(get('ColorSpace')) || toText(get('ColorSpaceData'))],
      ['Color profile', toText(get('ProfileDescription'))],
      ['Bit depth', toText(get('BitDepth', 'BitsPerSample'))],
      ['Color type', toText(get('ColorType'))],
      ['Resolution', xres && xres > 1 ? `${round(xres, 0)} ${/cm/i.test(resUnit || '') ? 'dpcm' : 'dpi'}` : null],
    ], i++));

    // File
    nodes.push(group('File', 'file', [
      ['Name', file.name],
      ['Size', fmtBytes(file.size), file.size >= 1000 ? `${file.size.toLocaleString()} bytes` : null],
      ['Type', file.type || extension(file.name)],
      ['Last modified', file.lastModified ? dateFmt.format(new Date(file.lastModified)) : null, 'On this computer'],
    ], i++));

    // Raw: every tag
    if (leaves.length) nodes.push(rawSection(leaves, i++));

    return nodes.filter(Boolean);
  }

  function notice(title, text, action) {
    let button = null;
    if (action) {
      button = el('button', { class: 'map-link notice-action', type: 'button' }, action.label);
      button.addEventListener('click', action.onClick);
    }
    return el('div', { class: 'notice', role: 'status' },
      icon('info'),
      el('div', null, el('strong', null, title), el('p', null, text), button),
    );
  }

  function rawSection(leaves, index) {
    const bySegment = new Map();
    for (const leaf of leaves) {
      if (!bySegment.has(leaf.segment)) bySegment.set(leaf.segment, []);
      bySegment.get(leaf.segment).push(leaf);
    }

    const body = el('div', { class: 'raw-body' });
    for (const [segment, items] of bySegment) {
      body.append(
        el('h3', { class: 'raw-segment' }, SEGMENT_LABELS[segment] || segment.toUpperCase()),
        el('dl', { class: 'rows' }, items.map((l) => el('div', { class: 'row' },
          el('dt', null, l.key),
          el('dd', null, fmtRaw(l.value)),
        ))),
      );
    }

    return el('details', { class: 'group raw', vars: { '--i': index } },
      el('summary', null, icon('tags'), 'All tags', el('span', { class: 'count' }, leaves.length), icon('chevron', 'chev')),
      body,
    );
  }

  const extension = (name) => {
    const m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toUpperCase() : 'Unknown';
  };

  /* ---------- Preview ---------- */

  /* ---------- RAW previews ---------- */

  // Browsers can't decode camera RAW data, but almost every RAW file (DNG, ARW, CR2, CR3, NEF, RAF,
  // ORF, RW2, …) carries one or more ordinary JPEG previews that the camera made. This finds them by
  // their start marker and reads only each one's frame header to learn its size; the picture data
  // is decoded by the browser as usual. Metadata still comes from exifr.
  const RAW_EXT = /\.(dng|arw|srf|sr2|cr2|cr3|crw|nef|nrw|orf|rw2|raf|pef|srw|3fr|iiq|erf|mef|mos|rwl|gpr)$/i;

  // Width and height from a JPEG's frame header, for the kinds of JPEG browsers can decode
  // (baseline, extended, progressive). Returns null for anything else, such as the lossless JPEG
  // that many RAW files use for the sensor data itself.
  function jpegSize(b, soi) {
    let p = soi + 2;
    for (let n = 0; n < 64 && p + 9 < b.length; n++) {
      if (b[p] !== 0xFF) return null;
      const m = b[p + 1];
      if (m === 0xFF) { p += 1; continue; }
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2) return null;
      if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
        const h = (b[p + 5] << 8) | b[p + 6];
        const w = (b[p + 7] << 8) | b[p + 8];
        return w && h ? { w, h } : null;
      }
      if ((m >= 0xC3 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) || m === 0xDA || m === 0xD9) return null;
      p += 2 + len;
    }
    return null;
  }

  // The largest decodable JPEG embedded in the file, as a Blob that starts at its first byte (the
  // browser stops reading at the JPEG's own end marker, so the rest of the file is ignored).
  async function rawPreview(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let best = null;
    let found = 0;
    for (let i = bytes.indexOf(0xFF); i !== -1 && i < bytes.length - 4; i = bytes.indexOf(0xFF, i + 1)) {
      if (bytes[i + 1] !== 0xD8 || bytes[i + 2] !== 0xFF) continue;
      const size = jpegSize(bytes, i);
      if (size && (!best || size.w * size.h > best.w * best.h)) best = { ...size, start: i };
      if (++found > 200) break;
    }
    return best ? { blob: file.slice(best.start, file.size, 'image/jpeg'), width: best.w, height: best.h } : null;
  }

  // RAW previews are often stored unrotated, with the rotation only in the RAW file's own EXIF.
  // If the preview has no orientation of its own, draw it upright on a canvas. The canvas is kept
  // under ~16 megapixels, which every browser (including iOS Safari) can handle.
  async function orientPreview(blob, orientation) {
    if (!orientation || orientation === 1) return blob;
    let own;
    try { own = await window.exifr.orientation(blob); } catch { own = undefined; }
    if (own) return blob;

    const bmp = await createImageBitmap(blob);
    const swap = orientation >= 5;
    const outW = swap ? bmp.height : bmp.width;
    const outH = swap ? bmp.width : bmp.height;
    const scale = Math.min(1, Math.sqrt(16e6 / (outW * outH)));
    const cw = Math.round(outW * scale);
    const ch = Math.round(outH * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    const t = {
      2: [-1, 0, 0, 1, cw, 0], 3: [-1, 0, 0, -1, cw, ch], 4: [1, 0, 0, -1, 0, ch],
      5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, cw, 0], 7: [0, -1, -1, 0, cw, ch], 8: [0, -1, 1, 0, 0, ch],
    }[orientation];
    if (t) ctx.transform(...t);
    ctx.drawImage(bmp, 0, 0, bmp.width * scale, bmp.height * scale);
    bmp.close();
    return new Promise((resolve) => canvas.toBlob((out) => resolve(out || blob), 'image/jpeg', 0.95));
  }

  // For a RAW file, returns { url, img } for its best embedded preview, or null.
  async function loadRawPreview(file) {
    try {
      const found = await rawPreview(file);
      if (!found) return null;
      let orientation;
      try { orientation = await window.exifr.orientation(file); } catch { orientation = undefined; }
      const blob = await orientPreview(found.blob, orientation);
      const url = URL.createObjectURL(blob);
      const img = await decodeImage(url);
      if (img.ok) return { url, img: { ...img, rawPreview: true } };
      URL.revokeObjectURL(url);
    } catch {
      // No usable preview; the placeholder is shown instead.
    }
    return null;
  }

  /* ---------- HEIC in browsers that can't show it ---------- */

  // Chrome and Firefox can't decode HEIC, the iPhone's default format. heif-worker.js decodes
  // it with libheif on this device; the result becomes a high-quality JPEG the page can use like
  // any other photo (preview, Wipe, Shot on, Film). Loaded only when a HEIC needs it.
  const isHeif = (file) => /\.(heic|heif|hif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
  let heifWorker = null;
  let heifSeq = 0;
  const heifJobs = new Map();

  // `kind` 'gainmap' reads the photo's HDR gain map instead (for the Film tool, in every browser).
  function decodeHeif(buffer, kind) {
    if (!heifWorker) {
      heifWorker = new Worker('heif-worker.js');
      heifWorker.onmessage = (e) => {
        const job = heifJobs.get(e.data.id);
        if (!job) return;
        heifJobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
      };
      heifWorker.onerror = (e) => {
        e.preventDefault?.();
        for (const job of heifJobs.values()) job.reject(new Error('The HEIC decoder couldn’t start.'));
        heifJobs.clear();
        heifWorker?.terminate();
        heifWorker = null;
      };
    }
    const id = ++heifSeq;
    return new Promise((resolve, reject) => {
      heifJobs.set(id, { resolve, reject });
      heifWorker.postMessage({ id, buffer, kind }, [buffer]);
    });
  }

  async function loadHeifPreview(file, meta) {
    try {
      const { rgba, width, height } = await decodeHeif(await file.arrayBuffer());
      // iPhone HEICs are Display P3; keep that where the browser can (Chrome), so colours
      // aren't squeezed into sRGB.
      const profile = String(toText(indexMetadata(meta.segments).get('ProfileDescription')) || '');
      const p3 = /p3/i.test(profile);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      let ctx = null;
      try { ctx = p3 ? canvas.getContext('2d', { colorSpace: 'display-p3' }) : null; } catch { ctx = null; }
      ctx ||= canvas.getContext('2d');
      let data;
      try { data = new ImageData(rgba, width, height, p3 ? { colorSpace: 'display-p3' } : undefined); } catch { data = new ImageData(rgba, width, height); }
      ctx.putImageData(data, 0, 0);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      canvas.width = 0;
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      const img = await decodeImage(url);
      if (img.ok) return { url, img: { ...img, heicDecoded: true } };
      URL.revokeObjectURL(url);
    } catch {
      // Not decodable; the placeholder explains.
    }
    return null;
  }

  function decodeImage(url) {
    const probe = new Image();
    probe.src = url;
    // The decoded probe is kept so the pixel reveal can draw from it straight away.
    return probe.decode().then(
      () => ({ ok: true, width: probe.naturalWidth, height: probe.naturalHeight, probe }),
      () => ({ ok: false }),
    );
  }

  function buildStage(file, img, url) {
    if (img.ok) {
      const caption = [img.rawPreview ? 'RAW preview' : img.heicDecoded ? 'HEIC' : null, `${img.width} × ${img.height}`, fmtBytes(file.size)]
        .filter(Boolean).join('  ·  ');
      // The <img> points at the original file (or a RAW file's embedded preview), so zooming in
      // shows its full resolution.
      const photo = el('img', {
        src: url,
        alt: `Preview of ${file.name}`,
        width: img.width,
        height: img.height,
        draggable: 'false',
      });
      photoZoom?.stop();
      const z = zoomable(photo, { ar: img.width / img.height, natW: img.width, label: `${file.name}.` });
      photoZoom = z.zoom;
      pixelReveal(z.frame, img);
      return el('figure', { class: 'photo' }, z.frame, el('figcaption', null, el('span', null, caption), z.controls));
    }
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    return el('figure', { class: 'photo' },
      el('div', { class: 'preview-fallback' },
        icon('image'),
        el('strong', null, 'Preview not available'),
        el('span', null, heic
          ? 'This HEIC photo couldn’t be decoded here. The metadata is still complete.'
          : RAW_EXT.test(file.name)
            ? 'This RAW file has no preview the browser can show. The metadata is still complete.'
            : 'This browser can’t display this file format. The metadata is still complete.'),
      ),
    );
  }

  /* ---------- Pixel reveal ---------- */

  // When a photo opens it starts as big square pixels in the photo's own colors and sharpens in
  // steps, the pixels getting smaller until the real photo shows. A canvas over the photo holds
  // each step at a tiny size; CSS scales it up without smoothing (image-rendering: pixelated).
  // Each step's colors are averages of that part of the photo, taken from a stack of
  // half-size copies made once at the start. Any zoom or pan input ends it at once.
  const REVEAL_BLOCKS = [44, 32, 24, 17, 12, 8.5, 6, 4, 2.5, 1.5]; // pixel size per step, CSS px
  const REVEAL_HOLD = 260; // ms on the first step, while the photo settles in
  const REVEAL_STEP = 85; // ms per later step

  function pixelReveal(frame, img) {
    if (reduceMotion.matches || !pixelLook() || !img.probe) return;
    const source = img.probe;
    const canvas = el('canvas', { class: 'pixel-reveal', 'aria-hidden': 'true' });
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Half-size copies down to a few pixels wide, starting at most 1024 px wide.
    const levels = [];
    let w = Math.min(img.width, 1024);
    let h = Math.max(1, Math.round((w * img.height) / img.width));
    let prev = source;
    while (w >= 4) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(prev, 0, 0, w, h);
      levels.push(c);
      prev = c;
      w = Math.round(w / 2);
      h = Math.max(1, Math.round(h / 2));
    }
    if (!levels.length) return;

    const timers = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      frame.classList.remove('is-revealing');
      canvas.classList.add('is-done');
      setTimeout(() => canvas.remove(), 250);
      for (const type of ['wheel', 'pointerdown', 'dblclick', 'keydown']) frame.removeEventListener(type, finish);
    };

    // Draw one step: the photo at "cols" pixels across, averaged from the nearest larger copy.
    const step = (block) => {
      const shown = frame.clientWidth || img.width;
      const cols = Math.max(1, Math.round(shown / block));
      const rows = Math.max(1, Math.round((cols * img.height) / img.width));
      const from = levels.slice().reverse().find((c) => c.width >= cols) || levels[0];
      canvas.width = cols;
      canvas.height = rows;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(from, 0, 0, cols, rows);
    };

    // The first step waits for the frame to be on the page so its width is known; that still
    // happens before the browser paints it.
    Promise.resolve().then(() => step(REVEAL_BLOCKS[0]));
    frame.append(canvas);
    frame.classList.add('is-revealing');
    REVEAL_BLOCKS.slice(1).forEach((block, i) => {
      timers.push(setTimeout(() => step(block), REVEAL_HOLD + i * REVEAL_STEP));
    });
    timers.push(setTimeout(finish, REVEAL_HOLD + (REVEAL_BLOCKS.length - 1) * REVEAL_STEP));
    for (const type of ['wheel', 'pointerdown', 'dblclick', 'keydown']) frame.addEventListener(type, finish);
  }

  /* ---------- Zoom ---------- */

  let photoZoom = null; // the open photo's zoom (Inspect and Wipe)
  let stageZoom = null; // the Shot on card's or the film's zoom
  const narrowLayout = window.matchMedia('(max-width: 860px)');

  // Zoom and pan inside the photo's frame: a mouse wheel or trackpad pinch zooms at the cursor,
  // two-finger trackpad scrolling pans, touch pinch zooms, double-click toggles, drag pans, and
  // + / − / 0 work when the frame has focus.
  //
  // Zooming resizes the <img> itself (width/height as a % of the frame) and only translates it,
  // instead of scaling it with a CSS transform. The browser then decodes and draws the photo at the
  // size it is shown, so it stays as sharp as the original at every zoom level; a scale transform
  // can stretch a smaller, already-decoded copy and look soft.
  //
  // `img` can also be a canvas, or a box holding one. `opts.pixels` is how many pixels wide its
  // content really is (how far it can usefully zoom); `opts.full` is the width that counts as
  // 100%: the photo's own width, or the size a card or film saves at.
  function attachZoom(frame, img, ui, opts = {}) {
    const pixels = opts.pixels || (() => img.naturalWidth || img.width || 1);
    const full = opts.full || pixels;
    let s = 1;
    let tx = 0;
    let ty = 0;
    const pointers = new Map();
    let pinch = null;
    let lastTrackpad = 0;

    const maxScale = () => {
      const shown = frame.clientWidth || 1;
      const toNative = pixels() / (shown * (window.devicePixelRatio || 1));
      return Math.max(3, toNative * 2); // up to 2× past one image pixel per screen pixel
    };

    const clamp = () => {
      const w = frame.clientWidth;
      const h = frame.clientHeight;
      tx = Math.min(0, Math.max(w - w * s, tx));
      ty = Math.min(0, Math.max(h - h * s, ty));
    };

    const render = (motion) => {
      img.classList.toggle('is-animating', motion === 'smooth');
      img.classList.toggle('is-gliding', motion === 'glide');
      const size = s === 1 ? '' : `${s * 100}%`;
      img.style.width = size;
      img.style.height = size;
      img.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px)`;
      frame.classList.toggle('is-zoomed', s > 1);
      // Always a percentage, in a box wide enough for any of them, so it never changes size.
      const pct = Math.max(1, Math.round(((frame.clientWidth * s) / (full() || 1)) * 100));
      ui.level.textContent = `${pct}%`;
      ui.level.setAttribute('aria-label', `${pct}%. Fit to view`);
      opts.onZoom?.(s);
      ui.out.disabled = s === 1;
      ui.zin.disabled = s >= maxScale() - 0.001;
    };

    const zoomTo = (next, px, py, motion) => {
      next = Math.min(maxScale(), Math.max(1, next));
      const k = next / s;
      tx = px - (px - tx) * k;
      ty = py - (py - ty) * k;
      s = next;
      if (s < 1.01) { s = 1; tx = 0; ty = 0; }
      clamp();
      render(motion);
    };

    const local = (x, y) => {
      const r = frame.getBoundingClientRect();
      return [x - r.left, y - r.top];
    };
    const middle = () => [frame.clientWidth / 2, frame.clientHeight / 2];

    // A mouse wheel reports lines (Firefox) or notches of 120 in the legacy wheelDelta (Chrome,
    // Safari). Trackpads report small pixel deltas, often with some sideways movement. Once a
    // trackpad is seen, its events keep counting as trackpad for a moment so a gesture never flips.
    const isMouseWheel = (e) => {
      if (e.deltaMode !== 0) return true;
      if (performance.now() - lastTrackpad < 400) return false;
      const legacy = e.wheelDeltaY;
      return e.deltaX === 0 && typeof legacy === 'number' && legacy !== 0 && legacy % 120 === 0;
    };

    frame.addEventListener('wheel', (e) => {
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;

      // Trackpad pinch (and ctrl + wheel) zooms at the cursor and follows the fingers.
      if (e.ctrlKey) {
        e.preventDefault();
        zoomTo(s * Math.exp(-dy * 0.01), ...local(e.clientX, e.clientY), null);
        return;
      }

      if (isMouseWheel(e)) {
        // In the stacked mobile layout the page scrolls, so a plain wheel only zooms once zoomed in.
        if (narrowLayout.matches && s === 1) return;
        e.preventDefault();
        // Wheel notches are big jumps, so glide between them.
        zoomTo(s * Math.exp(-dy * 0.0025), ...local(e.clientX, e.clientY), 'glide');
        return;
      }

      // Two-finger trackpad scroll moves around the zoomed photo. At fit size there is nothing to
      // move, so the event is left alone.
      lastTrackpad = performance.now();
      if (s === 1) return;
      e.preventDefault();
      tx -= dx;
      ty -= dy;
      clamp();
      render(null);
    }, { passive: false });

    frame.addEventListener('dblclick', (e) => {
      if (s > 1) zoomTo(1, 0, 0, 'smooth');
      else zoomTo(Math.min(2.5, maxScale()), ...local(e.clientX, e.clientY), 'smooth');
    });

    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2) {
        const [[ax, ay], [bx, by]] = [...pointers.values()];
        pinch = { d0: Math.hypot(bx - ax, by - ay) || 1, s0: s, mid: local((ax + bx) / 2, (ay + by) / 2) };
      }
      if (s > 1 || pointers.size === 2) {
        frame.setPointerCapture(e.pointerId);
        frame.classList.add('is-dragging');
      }
    });

    frame.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (pointers.size === 2 && pinch) {
        const [[ax, ay], [bx, by]] = [...pointers.values()];
        const mid = local((ax + bx) / 2, (ay + by) / 2);
        tx += mid[0] - pinch.mid[0];
        ty += mid[1] - pinch.mid[1];
        pinch.mid = mid;
        zoomTo(pinch.s0 * (Math.hypot(bx - ax, by - ay) / pinch.d0), mid[0], mid[1], null);
      } else if (pointers.size === 1 && s > 1) {
        tx += e.clientX - prev[0];
        ty += e.clientY - prev[1];
        clamp();
        render(null);
      }
    });

    const release = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) frame.classList.remove('is-dragging');
    };
    frame.addEventListener('pointerup', release);
    frame.addEventListener('pointercancel', release);

    frame.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') zoomTo(s * 1.6, ...middle(), 'smooth');
      else if (e.key === '-' || e.key === '_') zoomTo(s / 1.6, ...middle(), 'smooth');
      else if (e.key === '0') zoomTo(1, 0, 0, 'smooth');
      else return;
      e.preventDefault();
    });

    ui.zin.addEventListener('click', () => zoomTo(s * 1.6, ...middle(), 'smooth'));
    ui.out.addEventListener('click', () => zoomTo(s / 1.6, ...middle(), 'smooth'));
    ui.level.addEventListener('click', () => zoomTo(1, 0, 0, 'smooth'));

    // A new window size changes the fitted size, so go back to fit.
    let lastWidth = 0;
    const observer = new ResizeObserver(() => {
      const w = frame.clientWidth;
      if (lastWidth && w !== lastWidth && s !== 1) zoomTo(1, 0, 0, null);
      else render(null);
      lastWidth = w;
    });
    observer.observe(frame);
    if (img.tagName === 'IMG') img.addEventListener('load', () => render(null), { once: true });
    render(null);
    return {
      reset: () => zoomTo(1, 0, 0, null),
      refresh: () => render(null),
      stop: () => observer.disconnect(),
    };
  }

  // A zoomable frame around `content` (the photo, the Shot on card or the film), with its
  // − / % / + controls for the caption. `ar` is its aspect ratio and `natW` the widest it is shown
  // at fit, in CSS pixels.
  function zoomable(content, { ar, natW, label, pixels, full, onZoom }) {
    content.classList.add('zoom-img');
    const frame = el('div', {
      class: 'zoom-frame',
      vars: { '--ar': String(ar), '--nat-w': `${natW}px` },
      tabindex: '0',
      role: 'img',
      'aria-label': `${label} Scroll, pinch or double-click to zoom; drag to move.`,
    }, content);
    const out = el('button', { class: 'zoom-btn', type: 'button', 'aria-label': 'Zoom out' }, '−');
    const level = el('button', { class: 'zoom-level', type: 'button', title: 'Fit to view' }, '');
    const zin = el('button', { class: 'zoom-btn', type: 'button', 'aria-label': 'Zoom in' }, '+');
    const zoom = attachZoom(frame, content, { out, level, zin }, { pixels, full, onZoom });
    return { frame, zoom, controls: el('div', { class: 'zoom-controls' }, out, level, zin) };
  }

  // A new aspect ratio or size for a zoomable frame (the card changes shape); back to fit if so.
  function reshape(frame, zoom, ar, natW) {
    const before = frame.style.getPropertyValue('--ar');
    frame.style.setProperty('--ar', String(ar));
    frame.style.setProperty('--nat-w', `${natW}px`);
    if (before !== String(ar)) zoom.reset();
    else zoom.refresh();
  }

  /* ---------- Decode reveal ---------- */

  // When a photo opens, the summary chips and each metadata value in view "decode": each starts as
  // pixel-font glyphs and resolves left to right into its real text, one after another, while the
  // photo sharpens from big pixels (pixelReveal). The scrambled glyphs come from a fixed set, never from the
  // photo. Rows out of view or in collapsed sections are left as they are. Any click or key press in
  // the panel ends it at once, so it never gets in the way. Skipped entirely with reduced motion.
  const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+<>=';
  const DECODE_START = 140;  // ms before the first row starts, while the panel slides in
  const DECODE_SPREAD = 650; // the last row in view starts at most this long after the first
  const DECODE_MS = 320;     // one value, first glyph to last
  const SHUFFLE_MS = 60;     // how often the unresolved glyphs change
  let stopDecode = null;

  const scramble = (s) => s.replace(/\S/g, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]);

  function decodeValues(root) {
    stopDecode?.();
    if (reduceMotion.matches || !pixelLook()) return;

    const view = root.getBoundingClientRect();
    const top = Math.max(view.top, 0);
    const bottom = Math.min(view.bottom, window.innerHeight);
    const items = [];
    for (const dd of root.querySelectorAll('.chips li, .group:not(.is-collapsed) .row dd')) {
      const box = dd.getBoundingClientRect();
      if (!box.height || box.bottom < top || box.top > bottom) continue;
      const parts = [];
      const walker = document.createTreeWalker(dd, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.data.trim()) parts.push({ node: n, text: n.data, shown: -1, tail: null });
      }
      if (parts.length) items.push({ dd, parts, width: box.width, height: box.height, total: parts.reduce((a, p) => a + p.text.length, 0) });
    }
    if (!items.length) return;

    const gap = items.length > 1 ? Math.min(34, DECODE_SPREAD / (items.length - 1)) : 0;
    items.forEach((it, i) => {
      it.start = DECODE_START + i * gap;
      // Scrambled text is narrower than the real text, so hold the box's size to stop it jumping.
      it.dd.style.minWidth = `${it.width}px`;
      it.dd.style.minHeight = `${it.height}px`;
      for (const p of it.parts) {
        p.tail = el('span', { class: 'scramble', 'aria-hidden': 'true' }, scramble(p.text));
        p.node.data = '';
        p.node.after(p.tail);
      }
    });

    const settle = (it) => {
      if (it.done) return;
      it.done = true;
      for (const p of it.parts) {
        p.node.data = p.text;
        p.tail.remove();
      }
      it.dd.style.minWidth = '';
      it.dd.style.minHeight = '';
    };

    let frame = 0;
    let lastShuffle = -1;
    const t0 = performance.now();
    const tick = (now) => {
      const t = now - t0;
      const shuffle = Math.floor(t / SHUFFLE_MS);
      const reshuffle = shuffle !== lastShuffle;
      lastShuffle = shuffle;
      let busy = false;
      for (const it of items) {
        if (it.done) continue;
        const p = Math.max(0, (t - it.start) / DECODE_MS);
        if (p >= 1) {
          settle(it);
          continue;
        }
        busy = true;
        // Ease out: most characters resolve early, the last few settle in.
        let left = Math.floor((1 - (1 - p) ** 3) * it.total);
        for (const part of it.parts) {
          const k = Math.min(part.text.length, left);
          left -= k;
          if (k !== part.shown) {
            part.node.data = part.text.slice(0, k);
            part.shown = k;
            part.tail.textContent = scramble(part.text.slice(k));
          } else if (reshuffle && k < part.text.length) {
            part.tail.textContent = scramble(part.text.slice(k));
          }
        }
      }
      if (busy) frame = requestAnimationFrame(tick);
      else stop();
    };

    // A background tab pauses requestAnimationFrame; this makes sure no value stays scrambled.
    const safety = setTimeout(() => stop(), DECODE_START + DECODE_SPREAD + DECODE_MS + 600);
    const stop = () => {
      cancelAnimationFrame(frame);
      clearTimeout(safety);
      items.forEach(settle);
      root.removeAttribute('aria-busy');
      root.removeEventListener('pointerdown', stop);
      root.removeEventListener('keydown', stop);
      if (stopDecode === stop) stopDecode = null;
    };
    stopDecode = stop;
    root.setAttribute('aria-busy', 'true');
    root.addEventListener('pointerdown', stop);
    root.addEventListener('keydown', stop);
    frame = requestAnimationFrame(tick);
  }

  /* ---------- Wipe: a clean copy without the hidden data ---------- */

  // JPEG and PNG are cleaned by copying the file and leaving out the parts that hold
  // metadata, so the picture data itself is untouched (no re-compression, same quality). Anything
  // else the browser can display (HEIC in Safari, a RAW file's built-in preview, AVIF, TIFF, GIF)
  // is redrawn on a canvas and saved as a new JPEG or PNG, which carries no metadata at all.
  // Both happen on this device; the copy is saved straight back to it.

  const ascii = (b, at, text) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

  // An EXIF block holding only the rotation, so a cleaned photo still shows upright.
  function orientationSegment(o) {
    return new Uint8Array([
      0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // APP1, length 34, "Exif\0\0"
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // TIFF header, big-endian, IFD0 at 8
      0x00, 0x01, // one entry
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, o, 0x00, 0x00, // Orientation, SHORT, 1
      0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
  }

  // Keeps the picture data, the JFIF header, the color profile (unless `profile` is false) and
  // Adobe's color-transform flag. Drops EXIF, XMP, IPTC, comments, maker data and every image
  // stored after the main one (iPhone HDR gain maps and depth maps are separate JPEGs appended to
  // the file, each with its own EXIF).
  function stripJpeg(b, orientation, profile = true) {
    const parts = [b.subarray(0, 2)];
    let rotated = !(orientation > 1 && orientation <= 8);
    let p = 2;
    while (p + 1 < b.length) {
      if (b[p] !== 0xFF) throw new Error('JPEG structure not recognised');
      const m = b[p + 1];
      if (m === 0xFF) { p += 1; continue; }
      if (m === 0xD9) {
        parts.push(b.subarray(p, p + 2));
        return parts;
      }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { parts.push(b.subarray(p, p + 2)); p += 2; continue; }
      const end = p + 2 + ((b[p + 2] << 8) | b[p + 3]);
      if (end > b.length) throw new Error('JPEG ends early');
      const keep = m === 0xE0 ? ascii(b, p + 4, 'JFIF\0')
        : m === 0xE2 ? profile && ascii(b, p + 4, 'ICC_PROFILE\0')
          : m === 0xEE ? ascii(b, p + 4, 'Adobe')
            : !(m >= 0xE1 && m <= 0xEF) && m !== 0xFE;
      if (keep && !rotated && m !== 0xE0) {
        parts.push(orientationSegment(orientation));
        rotated = true;
      }
      if (keep) parts.push(b.subarray(p, end));
      p = end;
      if (m === 0xDA) {
        // Compressed picture data runs until the next real marker. 0xFF00 is an escaped byte and
        // 0xFFD0-D7 are restart markers, both part of the data.
        let q = p;
        for (;;) {
          q = b.indexOf(0xFF, q);
          if (q === -1 || q + 1 >= b.length) throw new Error('JPEG ends early');
          const n = b[q + 1];
          if (n === 0x00 || (n >= 0xD0 && n <= 0xD7)) q += 2;
          else if (n === 0xFF) q += 1;
          else break;
        }
        parts.push(b.subarray(p, q));
        p = q;
      }
    }
    throw new Error('JPEG ends early');
  }

  // Keeps the chunks that affect how the picture looks (and animation, for APNG). Drops text
  // chunks, EXIF, timestamps and anything unknown.
  const PNG_KEEP = new Set(['tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi',
    'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT']);

  function stripPng(b) {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const parts = [b.subarray(0, 8)];
    let p = 8;
    while (p + 12 <= b.length) {
      const end = p + 12 + view.getUint32(p);
      if (end > b.length) throw new Error('PNG ends early');
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      const critical = b[p + 4] < 0x61; // an uppercase first letter marks a chunk every reader needs
      if (critical || PNG_KEEP.has(type)) parts.push(b.subarray(p, end));
      if (type === 'IEND') return parts;
      p = end;
    }
    throw new Error('PNG ends early');
  }

  // Safari limits a canvas to about 16.7 megapixels; other browsers allow far more.
  const isWebKit = 'GestureEvent' in window;

  async function redraw(img, wantPng) {
    const max = isWebKit ? 16e6 : 120e6;
    const scale = Math.min(1, Math.sqrt(max / (img.width * img.height)));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    let ctx = null;
    try { ctx = canvas.getContext('2d', { colorSpace: 'display-p3' }); } catch { ctx = null; }
    ctx = ctx || canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.probe, 0, 0, w, h);
    const type = wantPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
    canvas.width = 0;
    if (!blob) throw new Error('could not save');
    return { blob, width: w, height: h, scaled: scale < 1 };
  }

  const baseName = (name) => name.replace(/\.[^.]+$/, '') || 'photo';

  // Returns { blob, name, lossless, width?, height?, scaled? } or throws with a message for people.
  async function makeCleanCopy(file, img) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = (/\.[^.]+$/.exec(file.name) || [''])[0];
    const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    const isPng = ascii(bytes, 0, '\x89PNG\r\n\x1A\n');

    if ((isJpeg || isPng) && !RAW_EXT.test(file.name)) {
      let parts;
      if (isJpeg) {
        let orientation;
        try { orientation = await window.exifr.orientation(file); } catch { orientation = undefined; }
        parts = stripJpeg(bytes, orientation);
      } else {
        parts = stripPng(bytes);
      }
      const type = isJpeg ? 'image/jpeg' : 'image/png';
      return { blob: new Blob(parts, { type }), name: `${baseName(file.name)}-clean${ext || (isJpeg ? '.jpg' : '.png')}`, lossless: true };
    }

    if (!img.ok || !img.probe) {
      const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
      throw new Error(heic
        ? 'This HEIC photo couldn’t be decoded here, so no clean copy was made. Save it as a JPEG and try again.'
        : 'This browser can’t open this file, so it can’t make a clean copy. Save it as a JPEG first.');
    }
    const png = /\.(gif|bmp)$/i.test(file.name);
    const out = await redraw(img, png);
    return { ...out, name: `${baseName(file.name)}-clean${png ? '.png' : '.jpg'}`, lossless: false };
  }

  // Reads the copy back with the same parser, so "nothing left" is checked, not assumed.
  async function leftoverTags(blob) {
    const meta = await readMetadata(blob);
    return indexMetadata(meta.segments).leaves
      .filter((l) => isPhotoTag(l) && l.key !== 'Orientation');
  }

  let cleanUrl = null;
  let cleanFor = null; // the file the current clean copy was made from

  function buildWipePanel(file, meta, img) {
    const { leaves, get } = indexMetadata(meta.segments);
    const photoTags = leaves.filter(isPhotoTag);
    const nodes = [];
    const { lat, lon, hasCoords } = locationOf(get);

    nodes.push(el('div', { class: 'summary' },
      el('p', { class: 'summary-eyebrow', title: file.name }, file.name),
      el('h1', { class: 'summary-title' }, photoTags.length ? 'Hidden data found' : 'Nothing hidden'),
      el('p', { class: 'summary-sub' }, photoTags.length
        ? `${photoTags.length} ${photoTags.length === 1 ? 'tag travels' : 'tags travel'} with this photo when you share it.`
        : 'This photo carries no location, date or camera details.'),
    ));

    if (meta.error) {
      nodes.push(notice('Metadata couldn’t be read', meta.error));
      return nodes;
    }

    if (!photoTags.length) {
      nodes.push(notice('Ready to share as it is', 'There is nothing to wipe. Screenshots and photos saved from social media or messaging apps are usually clean already.'));
      return nodes;
    }

    nodes.push(group('What it gives away', 'info', [
      ['Location', hasCoords ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : null, hasCoords ? 'Where it was taken, to a few meters' : null],
      ['Taken', fmtDate(get('DateTimeOriginal', 'CreateDate'), toText(get('OffsetTimeOriginal')))],
      ['Camera', cameraName(get('Make'), get('Model'))],
      ['Lens', toText(get('LensModel', 'Lens'))],
      ['Software', toText(get('Software', 'CreatorTool'))],
      ['Name', toText(get('OwnerName', 'CameraOwnerName', 'Artist', 'creator', 'Author', 'Byline', 'By-line'))],
      ['Caption', toText(get('ImageDescription', 'description', 'Caption', 'Caption-Abstract'))],
      ['Serial no.', toText(get('BodySerialNumber', 'SerialNumber', 'LensSerialNumber'))],
    ], 0));

    const box = el('div', { class: 'wipe-box', 'aria-live': 'polite' },
      el('p', { class: 'wipe-status' }, el('span', { class: 'spinner' }), 'Making a clean copy…'));
    nodes.push(box);
    fillWipeBox(box, file, img, photoTags.length);
    return nodes;
  }

  async function fillWipeBox(box, file, img, count) {
    await null; // let the panel put the box on the page first
    let copy;
    let left;
    try {
      if (cleanFor?.file !== file) {
        const made = await makeCleanCopy(file, img);
        left = await leftoverTags(made.blob);
        if (cleanUrl) URL.revokeObjectURL(cleanUrl);
        cleanUrl = URL.createObjectURL(made.blob);
        cleanFor = { file, made, left };
      }
      ({ made: copy, left } = cleanFor);
    } catch (err) {
      const msg = err && /^[A-Z]/.test(err.message) && err.message.endsWith('.') ? err.message
        : 'Something in this file wasn’t what Inspicio expected, so no copy was made.';
      box.replaceChildren(notice('Couldn’t make a clean copy', msg));
      return;
    }
    if (current?.file !== file || !box.isConnected) return;

    if (left.length) {
      box.replaceChildren(notice('Couldn’t wipe everything',
        `${left.length} ${left.length === 1 ? 'tag is' : 'tags are'} still in the copy, so it isn’t offered. Save the photo as a JPEG and try again.`));
      return;
    }

    const save = el('a', { class: 'map-link wipe-save', href: cleanUrl, download: copy.name },
      icon('file'), 'Save clean copy');
    // On a phone or tablet, the share sheet (Save Image puts it in Photos) instead of Files.
    save.addEventListener('click', (e) => {
      const shared = shareableFile(copy.blob, copy.name);
      if (!shared) return;
      e.preventDefault();
      navigator.share({ files: [shared] }).catch((err) => {
        if (!err || err.name !== 'AbortError') downloadUrl(cleanUrl, copy.name);
      });
    });
    const how = copy.lossless
      ? 'Same picture, same quality. Only the hidden data is gone. Rotation and colors are kept.'
      : `Saved as a new ${copy.blob.type === 'image/png' ? 'PNG' : 'JPEG'}, ${copy.width} × ${copy.height}`
        + (copy.scaled ? ' (this browser’s size limit)' : '')
        + (img.rawPreview ? ', from the RAW file’s built-in preview' : '') + '.';
    box.replaceChildren(
      save,
      el('dl', { class: 'rows wipe-result' },
        el('div', { class: 'row' }, el('dt', null, 'Removed'), el('dd', { class: 'num' }, `${count} ${count === 1 ? 'tag' : 'tags'}`)),
        el('div', { class: 'row' }, el('dt', null, 'Checked'), el('dd', null, 'Nothing left')),
        el('div', { class: 'row' }, el('dt', null, 'File'), el('dd', { class: 'num' }, copy.name)),
        el('div', { class: 'row' }, el('dt', null, 'Size'), el('dd', { class: 'num' }, `${fmtBytes(file.size)} → ${fmtBytes(copy.blob.size)}`)),
      ),
      el('p', { class: 'map-note' }, how),
    );
  }

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

  /* ---------- Saving: a dimmed screen with what is being added and a predicted progress bar ---------- */

  // Each step's name, what it adds, and about how long it takes per megapixel (ms) on a 10-core
  // Mac. Each full save teaches the page this device's speed (SPEED_KEY), so the bar's pace fits.
  const SAVE_STEPS = {
    prepare: ['Loading the photo', 'Reading its pixels at full size.', 12],
    reading: ['Reading the sensor data', 'The RAW file’s own light, before any of the camera’s processing.', 40],
    exposing: ['Exposing the film', 'The light lands on Portra’s three colour layers.', 3],
    halation: ['Adding halation', 'The red glow around bright lights, from light bouncing off the film base.', 24],
    sharpness: ['Scattering light', 'Light spreads a little in the emulsion: the soft edges of real film.', 54],
    curves: ['Developing the negative', 'Kodak’s measured curves turn the light into density.', 4],
    couplers: ['Adding couplers', 'The developer’s chemistry: crisper edges and purer colours.', 10],
    grain: ['Adding grain', 'Grain that follows the density, like clumps of real silver.', 24],
    printing: ['Printing', 'On Kodak Endura paper, the way a Noritsu lab prints.', 14],
    card: ['Drawing the card', 'The photo and its lines at full size.', 25],
    encoding: ['Saving the JPEG', 'Compressing it, on this device.', 30],
  };
  const SPEED_KEY = 'inspicio.speed';
  let saveSpeed = (() => {
    try {
      const v = Number(localStorage.getItem(SPEED_KEY));
      if (v > 0.2 && v < 10) return v;
    } catch { /* storage blocked; guess */ }
    const cores = navigator.hardwareConcurrency || 4;
    return cores >= 7 ? 1 : cores >= 4 ? 1.8 : 3;
  })();

  // Waits until the browser has painted (or a moment, in a hidden tab), so the overlay shows
  // before work that blocks the page.
  const painted = () => new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 80);
  });
  // The overlay's entrance takes about 0.3 s; heavy work waits most of it out so it stays smooth.
  const settled = () => painted().then(() => new Promise((resolve) => setTimeout(resolve, 220)));

  // A progress bar's fill driven through `steps` at their predicted pace (SAVE_STEPS, plus `base` ms
  // each). One animation from empty to full that never restarts: each step only changes its speed,
  // aiming to reach the step's end when the step is predicted to finish, and a step that runs long
  // slows it to a crawl before the next step's place. So it never jumps or goes back, and since it
  // runs on the compositor it keeps moving while the page is busy.
  function barController({ fill, steps, megapixels, base = 120 }) {
    const durations = steps.map((k) => SAVE_STEPS[k][2] * megapixels * saveSpeed + base);
    const total = durations.reduce((a, b) => a + b, 0);
    const starts = [];
    let sum = 0;
    for (const d of durations) { starts.push(sum / total); sum += d; }
    const anim = reduceMotion.matches ? null
      : fill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: total, easing: 'linear', fill: 'forwards' });
    let rate = 1;
    let index = -1;
    let done = false;
    const at = () => (anim ? Math.min(1, (anim.currentTime || 0) / total) : 0);
    const setRate = (r) => {
      if (!anim) return;
      rate = Math.min(12, Math.max(0.02, r));
      if (anim.updatePlaybackRate) anim.updatePlaybackRate(rate);
      else anim.playbackRate = rate;
    };
    const stepEnd = () => (index + 1 < steps.length ? starts[index + 1] : 1);
    const watch = setInterval(() => {
      if (!anim || done || index < 0) return;
      const room = stepEnd() - 0.008 - at();
      if (room <= 0) setRate(0.02);
      else if (room < 0.02 && rate > 0.1) setRate(rate / 2);
    }, 120);
    return {
      starts,
      total,
      // Returns the step's index, or -1 if it isn't ahead of the current one.
      step(name) {
        const i = steps.indexOf(name);
        if (done || i <= index) return -1;
        index = i;
        if (!anim) { fill.style.setProperty('--p', String(starts[i])); return i; }
        const target = starts[i] + (stepEnd() - starts[i]) * 0.95;
        setRate(((target - at()) * total) / durations[i]);
        return i;
      },
      finish(ms = 300) {
        done = true;
        clearInterval(watch);
        fill.style.setProperty('--p', '1');
        setRate(((1 - at()) * total) / ms);
      },
      stop() {
        done = true;
        clearInterval(watch);
        anim?.pause();
      },
    };
  }

  // The overlay. The bar is one animation from empty to full that never restarts: each step only
  // changes its speed (aiming to reach the step's end when the step is predicted to finish), and a
  // step that runs long slows it to a crawl before the next notch. So it never jumps or goes back,
  // and since it runs on the compositor it keeps moving while the page is busy.
  function saveProgress({ eyebrow, steps, megapixels, learn }) {
    const durations = steps.map((k) => SAVE_STEPS[k][2] * megapixels * saveSpeed + 120);
    const total = durations.reduce((a, b) => a + b, 0);
    const starts = [];
    let sum = 0;
    for (const d of durations) { starts.push(sum / total); sum += d; }

    const label = el('strong', { class: 'save-step', 'aria-live': 'polite' }, '');
    const detail = el('p', { class: 'save-detail' }, '');
    const fill = el('div', { class: 'save-fill' });
    const ticks = starts.slice(1).map((x) => el('span', { class: 'save-tick', vars: { '--x': String(x) } }));
    const bar = el('div', { class: 'save-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
      'aria-valuenow': '0', 'aria-label': 'Progress' }, fill, ...ticks);
    const actions = el('div', { class: 'save-actions' });
    const card = el('div', { class: 'save-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': eyebrow, tabindex: '-1' },
      el('p', { class: 'save-eyebrow' }, eyebrow), label, detail, bar, actions);
    const root = el('div', { class: 'save-overlay' }, card);
    const opener = document.activeElement;
    document.body.append(root);
    card.focus({ preventScroll: true });

    const t0 = performance.now();
    let index = -1;
    let closed = false;
    let cancel = null;

    const ctl = barController({ fill, steps, megapixels });

    // Step names change at most every 450 ms, so a burst of quick steps doesn't flicker; the
    // latest one shows when its turn comes.
    let textAt = 0;
    let textTimer = 0;
    const showText = (title, sub) => {
      label.textContent = title;
      detail.textContent = sub;
      textAt = performance.now();
      if (!reduceMotion.matches) {
        for (const n of [label, detail]) n.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      }
    };
    const text = (title, sub, now) => {
      clearTimeout(textTimer);
      const wait = now ? 0 : 450 - (performance.now() - textAt);
      if (wait <= 0) showText(title, sub);
      else textTimer = setTimeout(() => showText(title, sub), wait);
    };
    const setActions = (...nodes) => actions.replaceChildren(...nodes.filter(Boolean));
    const button = (labelText, primary, onClick) => {
      const b = el('button', { class: `map-link${primary ? ' wipe-save' : ''}`, type: 'button' }, labelText);
      b.addEventListener('click', onClick);
      return b;
    };

    const close = () => {
      if (closed) return;
      closed = true;
      ctl.stop();
      clearTimeout(textTimer);
      document.removeEventListener('keydown', onKey, true);
      root.classList.add('is-closing');
      setTimeout(() => root.remove(), reduceMotion.matches ? 0 : 200);
      if (opener && opener.isConnected) opener.focus?.({ preventScroll: true });
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (cancel) cancel();
      else if (index === Infinity) close();
    };
    document.addEventListener('keydown', onKey, true);

    const api = {
      step(name) {
        if (closed) return;
        const i = ctl.step(name);
        if (i < 0) return;
        index = i;
        const [title, sub] = SAVE_STEPS[name];
        text(title, sub);
        bar.setAttribute('aria-valuenow', String(Math.round(starts[i] * 100)));
      },
      cancellable(fn) {
        cancel = fn ? () => { cancel = null; fn(); } : null;
        setActions(cancel && button('Cancel', false, () => cancel && cancel()));
      },
      // The work is done: learn this device's speed, then fill the bar.
      finished() {
        if (learn) {
          const ratio = (performance.now() - t0) / total;
          if (ratio > 0.1 && ratio < 10) {
            saveSpeed = Math.min(8, Math.max(0.25, 0.6 * saveSpeed + 0.4 * saveSpeed * ratio));
            try { localStorage.setItem(SPEED_KEY, saveSpeed.toFixed(3)); } catch { /* fine */ }
          }
        }
        index = Infinity;
        cancel = null;
        bar.setAttribute('aria-valuenow', '100');
        ctl.finish();
      },
      done(sub) {
        api.finished();
        text('Saved', sub, true);
        setActions();
        setTimeout(close, reduceMotion.matches ? 1600 : 1100);
      },
      // On a phone or tablet: the share sheet, where Save Image puts the photo in Photos.
      ready(file, url, sub) {
        api.finished();
        text('Ready', `${sub}. Save Image in the share sheet puts it in Photos.`, true);
        const download = el('a', { class: 'map-link', href: url, download: file.name }, 'Download');
        setActions(
          button('Close', false, close),
          download,
          button('Save to Photos', true, () => {
            navigator.share({ files: [file] }).then(close, (err) => {
              if (err && err.name === 'AbortError') return;
              detail.textContent = 'The share sheet didn’t open. Use Download instead.';
            });
          }),
        );
        actions.classList.add('is-ready');
        actions.lastChild.focus({ preventScroll: true });
      },
      fail(message) {
        index = Infinity;
        cancel = null;
        ctl.stop();
        text('Couldn’t save', message, true);
        setActions(button('Close', true, close));
      },
      close,
    };
    return api;
  }

  // A file the person can be handed through the share sheet: on phones and tablets, where it is
  // the way into Photos.
  function shareableFile(blob, name) {
    if (!window.matchMedia('(pointer: coarse)').matches || typeof navigator.canShare !== 'function') return null;
    const file = new File([blob], name, { type: blob.type });
    try { return navigator.canShare({ files: [file] }) ? file : null; } catch { return null; }
  }

  function downloadUrl(url, name) {
    const a = el('a', { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }

  // Hands a saved image over: the share sheet on a phone or tablet, otherwise a download.
  function deliver(progress, blob, url, name, sub) {
    const file = shareableFile(blob, name);
    if (file) progress.ready(file, url, sub);
    else {
      downloadUrl(url, name);
      progress.done(sub);
    }
  }

  const toJpeg = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  /* ---------- Film: develop the photo like Kodak Portra 400 ---------- */

  // The rolls film engine (film.js) runs in a worker (film-worker.js), loaded the first time
  // this tab is used. A preview is developed at about 1.4 megapixels and re-developed as the
  // sliders move; saving develops the full photo. All of it on this device.
  const FILM_PREVIEW_PIXELS = 1.4e6;
  const FILM_SAVE_PIXELS = window.matchMedia('(pointer: coarse)').matches ? 8e6 : 16e6;

  let filmWorker = null;
  let filmSeq = 0;
  const filmJobs = new Map();

  let filmWorkerGen = 0; // which worker; a new one has to be sent a DNG's bytes again
  // On this computer (development), the worker and the engine files it loads are fetched fresh on
  // every page load: a reload doesn't refresh a worker's scripts, so an old engine could linger.
  const FILM_FRESH = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? `?t=${Date.now()}` : '';

  function filmWorkerReady() {
    if (!filmWorker) {
      filmWorkerGen++;
      filmWorker = new Worker(`film-worker.js${FILM_FRESH}`);
      filmWorker.onmessage = (e) => {
        const job = filmJobs.get(e.data.id);
        if (!job) return;
        if (!e.data.done && !e.data.error) {
          job.onStage?.(e.data.stage);
          return;
        }
        filmJobs.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error));
        else job.resolve(e.data);
      };
      filmWorker.onerror = (e) => {
        e.preventDefault?.();
        for (const job of filmJobs.values()) job.reject(new Error('The film engine couldn’t start.'));
        filmJobs.clear();
        filmWorker?.terminate();
        filmWorker = null;
      };
    }
    return filmWorker;
  }

  // Stops whatever the worker is doing (a full-detail develop nobody needs any more); the next job
  // starts a fresh worker.
  function filmRestartWorker() {
    if (!filmWorker) return;
    filmWorker.terminate();
    filmWorker = null;
    for (const job of filmJobs.values()) job.reject(new Error('cancelled'));
    filmJobs.clear();
  }

  function filmRun(message, transfer, onStage) {
    const worker = filmWorkerReady();
    const id = ++filmSeq;
    return new Promise((resolve, reject) => {
      filmJobs.set(id, { resolve, reject, onStage });
      worker.postMessage({ id, ...message }, transfer);
    });
  }

  // The photo's pixels at up to `maxPixels`, upright, in Display P3 where the browser can
  // read it (iPhone photos are P3), otherwise sRGB.
  function filmPixels(img, maxPixels) {
    const scale = Math.min(1, Math.sqrt(maxPixels / (img.width * img.height)));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    let ctx = null;
    try { ctx = canvas.getContext('2d', { colorSpace: 'display-p3', willReadFrequently: true }); } catch { ctx = null; }
    ctx ||= canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.probe, 0, 0, width, height);
    let data;
    try { data = ctx.getImageData(0, 0, width, height, { colorSpace: 'display-p3' }); } catch { data = ctx.getImageData(0, 0, width, height); }
    canvas.width = 0;
    return { pixels: data.data.buffer, width, height, primaries: data.colorSpace === 'display-p3' ? 'displayP3' : 'sRGB' };
  }

  let film = null; // the open photo's film settings and preview state
  let filmKeySeq = 0;

  function filmFor(file, img) {
    if (film?.file !== file) {
      film = { file, img, key: ++filmKeySeq, exposure: 0, brightness: 0, source: null,
        canvas: null, caption: null, original: null, busy: false, again: false, saving: false,
        // A DNG is developed from its sensor data when the worker can read it ('maybe' until
        // it has tried); everything else, and a DNG it can't read, from the finished picture.
        raw: /\.dng$/i.test(file.name) ? 'maybe' : 'no', rawGen: -1,
        // The photo's HDR gain map (iPhone HEIC, HDR JPEG), read once when first developed.
        gain: null, gainGen: -1, hdr: false };
    }
    return film;
  }

  // The photo's HDR gain map, or null. iPhone photos from iOS 18 on have one: it says how much
  // brighter each part of the photo is in its HDR version, which is the highlight detail the
  // finished picture had to give up.
  function filmGainMap(f) {
    const heif = isHeif(f.file);
    f.gain ||= (heif ? f.file.arrayBuffer().then((buffer) => decodeHeif(buffer, 'gainmap'))
      : RAW_EXT.test(f.file.name) ? Promise.resolve(null) : jpegGainMap(f.file))
      .then((r) => (r && !r.none ? { data: r.gain, width: r.width, height: r.height, meta: r.meta } : null))
      .catch(() => null)
      .then((map) => {
        if (map && !f.hdr) {
          f.hdr = true;
          filmShowSource(f);
        }
        return map;
      });
    return f.gain;
  }

  // A JPEG's HDR gain map (iPhone, Android Ultra HDR, Lightroom), as grey values from 0 to 255,
  // turned upright like the photo. The gain map is decoded without its color profile: its values
  // are gains, not colors. Null when there is none.
  async function jpegGainMap(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    const found = findJpegGainMap(bytes);
    if (!found) return null;
    let orientation = 1;
    try { orientation = (await window.exifr.orientation(file)) || 1; } catch { orientation = 1; }
    const bitmap = await createImageBitmap(new Blob(stripJpeg(found.jpeg, undefined, false), { type: 'image/jpeg' }));
    const sw = bitmap.width;
    const sh = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const rgba = ctx.getImageData(0, 0, sw, sh).data;
    canvas.width = 0;
    // EXIF orientation: 5 to 8 swap width and height. For each upright pixel, where it is stored.
    const swap = orientation >= 5 && orientation <= 8;
    const width = swap ? sh : sw;
    const height = swap ? sw : sh;
    const from = [null,
      (x, y) => [x, y], (x, y) => [sw - 1 - x, y], (x, y) => [sw - 1 - x, sh - 1 - y], (x, y) => [x, sh - 1 - y],
      (x, y) => [y, x], (x, y) => [y, sh - 1 - x], (x, y) => [sw - 1 - y, sh - 1 - x], (x, y) => [sw - 1 - y, x],
    ][orientation] || ((x, y) => [x, y]);
    const gain = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [u, v] = from(x, y);
        gain[y * width + x] = rgba[(v * sw + u) * 4];
      }
    }
    return { gain, width, height, meta: found.meta };
  }

  const fmtStops = (v) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`);

  // One develop, from the DNG's sensor data or from the finished picture.
  async function filmJob(f, maxPixels, keep, onStage) {
    const settings = { key: f.key, exposureStops: f.exposure, printStops: -f.brightness, look: filmPrefs.look / 100, keep };
    for (let attempt = 0; f.raw !== 'no' && attempt < 2; attempt++) {
      try {
        filmWorkerReady();
        const msg = { kind: 'raw', maxPixels, ...settings };
        const transfer = [];
        if (f.rawGen !== filmWorkerGen) {
          msg.file = await f.file.arrayBuffer();
          transfer.push(msg.file);
          f.rawGen = filmWorkerGen;
        }
        const res = await filmRun(msg, transfer, onStage);
        f.raw = 'yes';
        return res;
      } catch (err) {
        if (err.message === 'cancelled') throw err;
        if (err.message === 'need-file') { f.rawGen = -1; continue; }
        f.raw = 'no';
        filmShowSource(f);
      }
    }
    const gain = await filmGainMap(f);
    for (let attempt = 0; ; attempt++) {
      const src = keep ? (f.source ||= filmPixels(f.img, FILM_PREVIEW_PIXELS)) : filmPixels(f.img, maxPixels);
      const pixels = keep ? src.pixels.slice(0) : src.pixels;
      const msg = { ...settings, pixels, width: src.width, height: src.height, primaries: src.primaries, placement: 'photo' };
      if (gain) {
        // The worker keeps the gain map; a new worker is sent it again.
        filmWorkerReady();
        msg.useGain = true;
        if (f.gainGen !== filmWorkerGen) msg.gain = gain;
        f.gainGen = filmWorkerGen;
      }
      try {
        return await filmRun(msg, [pixels], onStage);
      } catch (err) {
        if (err.message !== 'need-gain' || attempt) throw err;
        f.gainGen = -1;
      }
    }
  }

  const FILM_STEPS = ['exposing', 'halation', 'sharpness', 'curves', 'couplers', 'grain', 'printing'];

  // The finished caption, guessed before the first develop, so the bar can take its width.
  function filmCaptionGuess(f) {
    if (f.captionText) return f.captionText;
    const raw = f.raw !== 'no';
    const full = Math.min(1, Math.sqrt(FILM_SAVE_PIXELS / (f.img.width * f.img.height)));
    const { width, height } = framedSize(Math.round(f.img.width * full), Math.round(f.img.height * full));
    return `Portra 400${raw ? ' from RAW' : isHeif(f.file) ? ' with HDR' : ''}  ·  saves at ${width} × ${height}`;
  }

  // Sizes the caption to `text`'s real width, measured with a hidden copy once it's on the page.
  function filmCaptionWidth(f, text) {
    const cap = f.caption;
    if (!cap) return;
    cap.style.setProperty('--cap-ch', String(text.length));
    const measure = () => {
      if (!cap.isConnected || !cap.parentNode) return false;
      const probe = el('span', { class: 'cap-measure', 'aria-hidden': 'true' }, text);
      cap.parentNode.append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      if (w > 0) cap.style.setProperty('--cap-w', `${w}px`);
      return true;
    };
    if (!measure()) requestAnimationFrame(measure);
  }

  // The caption while the film develops: a thin bar that fills, as wide as the finished caption,
  // so the box keeps its size and nothing in it moves.
  function filmCaptionBar(f, steps, megapixels, base) {
    f.capBar?.stop();
    f.capBar = null;
    if (!f.caption) return null;
    const fill = el('span', { class: 'cap-fill' });
    f.caption.replaceChildren(el('span', { class: 'cap-bar', role: 'progressbar', 'aria-label': 'Developing' }, fill));
    filmCaptionWidth(f, filmCaptionGuess(f));
    f.caption.classList.add('is-progress');
    f.capBar = barController({ fill, steps, megapixels, base });
    return f.capBar;
  }

  function filmCaptionDone(f, bar, text) {
    if (!bar || f.capBar !== bar) return;
    bar.finish(160);
    setTimeout(() => {
      if (f.capBar !== bar || !f.caption) return;
      f.capBar = null;
      bar.stop();
      f.caption.classList.remove('is-progress');
      f.caption.textContent = text;
    }, reduceMotion.matches ? 0 : 200);
  }

  async function filmPreview() {
    const f = film;
    if (!f || !f.canvas || !f.img.ok) return;
    if (f.busy) { f.again = true; return; }
    if (f.detail && f.detail.settings !== filmSettings(f)) {
      // The sliders moved: the full-detail film is out of date. Stop developing it, unless it is
      // being saved, so the preview doesn't wait behind it.
      if (f.detail.running && !f.saving) filmRestartWorker();
      f.detail = null;
      filmShowDetail(f);
    }
    f.busy = true;
    f.again = false;
    f.stage?.classList.add('is-developing');
    const bar = filmCaptionBar(f, [f.raw !== 'no' ? 'reading' : 'prepare', ...FILM_STEPS], FILM_PREVIEW_PIXELS / 1e6, 15);
    bar?.step(f.raw !== 'no' ? 'reading' : 'prepare');
    try {
      const res = await filmJob(f, FILM_PREVIEW_PIXELS, true, (stage) => bar?.step(stage));
      if (film !== f || !f.canvas) return;
      f.canvas.width = res.width;
      f.canvas.height = res.height;
      f.canvas.getContext('2d').putImageData(new ImageData(res.rgba, res.width, res.height), 0, 0);
      f.canvas.classList.add('is-ready');
      let saveW;
      let saveH;
      if (res.raw) {
        const ds = Math.max(1, Math.ceil(Math.sqrt((res.fullWidth * res.fullHeight) / FILM_SAVE_PIXELS)));
        [saveW, saveH] = [Math.floor(res.fullWidth / ds), Math.floor(res.fullHeight / ds)];
      } else {
        const full = Math.min(1, Math.sqrt(FILM_SAVE_PIXELS / (f.img.width * f.img.height)));
        [saveW, saveH] = [Math.round(f.img.width * full), Math.round(f.img.height * full)];
      }
      f.saveW = saveW;
      f.saveH = saveH;
      // A DNG developed from its sensor data can have a different shape than its preview.
      filmApplyFrame(f);
      f.captionBase = `Portra 400${res.raw ? ' from RAW' : f.hdr ? ' with HDR' : ''}`;
      filmCaption(f);
      filmCaptionDone(f, bar, f.captionText);
    } catch (err) {
      filmCaptionDone(f, bar, 'Couldn’t develop this photo');
      if (f.note) f.note.textContent = String(err.message || err);
    } finally {
      f.busy = false;
      f.stage?.classList.remove('is-developing');
      if (f.again && film === f) filmPreview();
      else filmWantDetail(f, true);
    }
  }

  const filmSettings = (f) => `${f.exposure}|${f.brightness}|${filmPrefs.look}`;

  // Full detail: the film developed at its saved size. The preview is about 1.4 megapixels, so
  // once it is zoomed in past its own pixels this is developed in the background and replaces it,
  // until a slider moves. Saving uses it too, so a save after zooming is instant.
  // `quiet`: no caption bar. The develop that follows a preview on its own is quiet, so a new photo
  // or a moved slider runs the bar once, not once for the preview and again for the detail.
  function filmDetail(f, quiet = false) {
    const settings = filmSettings(f);
    if (f.detail?.settings === settings) return f.detail.promise;
    const detail = { settings, canvas: null, running: true };
    f.detail = detail;
    const bar = quiet ? null : filmCaptionBar(f, [f.raw !== 'no' ? 'reading' : 'prepare', ...FILM_STEPS],
      (f.saveW && f.saveH ? f.saveW * f.saveH : FILM_SAVE_PIXELS) / 1e6, 60);
    bar?.step(f.raw !== 'no' ? 'reading' : 'prepare');
    const onStage = (stage) => {
      if (f.saving) f.saveStage?.(stage);
      if (f.detail === detail) bar?.step(stage);
    };
    detail.promise = filmJob(f, FILM_SAVE_PIXELS, false, onStage).then((res) => {
      const canvas = el('canvas', { class: 'film-canvas film-detail is-ready' });
      canvas.width = res.width;
      canvas.height = res.height;
      canvas.getContext('2d').putImageData(new ImageData(res.rgba, res.width, res.height), 0, 0);
      detail.canvas = canvas;
      return { canvas, width: res.width, height: res.height };
    }).finally(() => {
      detail.running = false;
      if (f.detail !== detail) return;
      if (!detail.canvas) f.detail = null;
      filmCaptionDone(f, bar, f.captionText || '');
      filmShowDetail(f);
    });
    return detail.promise;
  }

  // Puts the full-detail film over the preview when it matches the sliders; removes it otherwise.
  function filmShowDetail(f) {
    if (!f.stage) return;
    const d = f.detail;
    const on = d?.canvas && d.settings === filmSettings(f) ? d.canvas : null;
    for (const c of f.stage.querySelectorAll('.film-detail')) if (c !== on) c.remove();
    if (on && on.parentNode !== f.stage) f.canvas.after(on);
  }

  // Asks for full detail once zooming settles past the preview's own pixels.
  // `quiet` as in filmDetail. A zoom still waiting when a quiet request comes keeps its bar.
  function filmWantDetail(f, quiet = false) {
    clearTimeout(f.detailTimer);
    if (!quiet) f.detailLoud = true;
    f.detailTimer = setTimeout(() => {
      quiet = !f.detailLoud;
      f.detailLoud = false;
      if (film !== f || !f.frame || !f.canvas || f.busy || !f.saveW) return;
      const shown = f.frame.clientWidth * (f.zoomScale || 1) * (window.devicePixelRatio || 1);
      if (f.saveW > f.canvas.width * 1.1 && shown > f.canvas.width * 1.25) filmDetail(f, quiet).catch(() => {});
    }, 350);
  }

  // The Frame option: a plain white or black border around the print, as wide as a share of the
  // photo's shorter side. A display preference, so it is remembered.
  // Strength (look, 0 to 100): how far the develop leans into the film's look (FilmEngine.look).
  // 0 is the film as calibrated, which leaves a finished photo close to itself.
  const FILM_KEY = 'inspicio.film';
  const FRAME_COLORS = { white: '#ffffff', black: '#000000' };
  const FILM_LOOK_DEFAULT = 50;
  const fmtPercent = (v) => `${v}%`;
  const filmPrefs = (() => {
    const prefs = { frame: false, frameColor: 'white', frameSize: 5, look: FILM_LOOK_DEFAULT };
    try {
      const saved = JSON.parse(localStorage.getItem(FILM_KEY) || '{}');
      if (typeof saved.frame === 'boolean') prefs.frame = saved.frame;
      if (FRAME_COLORS[saved.frameColor]) prefs.frameColor = saved.frameColor;
      if (saved.frameSize >= 1 && saved.frameSize <= 20) prefs.frameSize = Number(saved.frameSize);
      if (saved.look >= 0 && saved.look <= 100) prefs.look = Math.round(Number(saved.look));
    } catch { /* storage blocked or bad value */ }
    return prefs;
  })();
  const saveFilmPrefs = () => {
    try { localStorage.setItem(FILM_KEY, JSON.stringify(filmPrefs)); } catch { /* fine */ }
  };
  const framePx = (w, h) => (filmPrefs.frame ? Math.round((Math.min(w, h) * filmPrefs.frameSize) / 100) : 0);
  // The saved size with the frame: scaled down as a whole if it would pass Safari's canvas limit.
  const FRAMED_MAX = 16e6;
  function framedSize(w, h) {
    const b = framePx(w, h);
    const k = Math.min(1, Math.sqrt(FRAMED_MAX / ((w + 2 * b) * (h + 2 * b))));
    return { b: b * k, k, width: Math.round((w + 2 * b) * k), height: Math.round((h + 2 * b) * k) };
  }

  function filmCaption(f) {
    if (!f.caption || !f.captionBase || !f.saveW) return;
    const { width, height } = framedSize(f.saveW, f.saveH);
    f.captionText = `${f.captionBase}  ·  saves at ${width} × ${height}`;
    if (!f.capBar) f.caption.textContent = f.captionText;
    else filmCaptionWidth(f, f.captionText);
  }

  // Shows the frame in the stage: the print sits inset in a box of the frame's colour, and the
  // zoom frame takes the framed shape.
  function filmApplyFrame(f) {
    if (!f.stage || !f.canvas) return;
    const w = f.canvas.width;
    const h = f.canvas.height;
    const b = filmPrefs.frame ? (Math.min(w, h) * filmPrefs.frameSize) / 100 : 0;
    f.stage.style.setProperty('--fx', String(b / (w + 2 * b)));
    f.stage.style.setProperty('--fy', String(b / (h + 2 * b)));
    f.stage.style.setProperty('--frame-color', FRAME_COLORS[filmPrefs.frameColor]);
    f.stage.classList.toggle('has-frame', b > 0);
    if (f.frame && stageZoom) reshape(f.frame, stageZoom, (w + 2 * b) / (h + 2 * b), f.saveW || f.img.width);
    filmCaption(f);
  }

  function buildFilmStage() {
    const f = film;
    f.canvas = el('canvas', { class: 'film-canvas' });
    // Sized like the preview from the start, so the frame doesn't jump when the film arrives.
    const scale = Math.min(1, Math.sqrt(FILM_PREVIEW_PIXELS / (f.img.width * f.img.height)));
    f.canvas.width = Math.max(1, Math.round(f.img.width * scale));
    f.canvas.height = Math.max(1, Math.round(f.img.height * scale));
    f.original = el('img', { class: 'film-original', src: currentUrl, alt: '', 'aria-hidden': 'true', draggable: 'false' });
    f.caption = el('span', null, '');
    f.capBar = null;
    f.stage = el('div', { class: 'film-frame' }, el('div', { class: 'film-print' }, f.canvas, f.original));
    stageZoom?.stop();
    f.zoomScale = 1;
    const z = zoomable(f.stage, { ar: f.canvas.width / f.canvas.height, natW: f.img.width,
      label: 'The photo developed on Portra 400.',
      pixels: () => Math.max(f.canvas?.width || 1, f.saveW || 0),
      full: () => {
        const w = f.saveW || f.img.width;
        return w + 2 * framePx(w, f.saveH || f.img.height);
      },
      // The zoom reports on every layout change too; only a real zoom shows the caption bar.
      onZoom: (scale) => {
        const zoomed = scale !== f.zoomScale;
        f.zoomScale = scale;
        filmWantDetail(f, !zoomed);
      } });
    f.frame = z.frame;
    stageZoom = z.zoom;
    filmApplyFrame(f);
    filmShowDetail(f);
    filmPreview();
    return el('figure', { class: 'photo film-stage' }, z.frame, el('figcaption', null, f.caption, z.controls));
  }

  function filmSourceNote(f, meta) {
    const { file } = f;
    const { get } = indexMetadata(meta.segments);
    const apple = /apple/i.test(String(toText(get('Make')) || ''));
    const model = toText(get('Model'));
    if (f.raw !== 'no') {
      return [`${model || 'DNG'} · ${apple ? 'ProRAW' : 'RAW'}`,
        'Developed from the sensor’s own light, before any of the camera’s processing, the way the rolls camera does it.'];
    }
    if (RAW_EXT.test(file.name)) {
      return [`${model || 'RAW file'} · built-in preview`, /\.dng$/i.test(file.name)
        ? 'This DNG’s sensor data is in a format the film can’t read yet, so this uses the JPEG preview inside the file.'
        : 'Browsers can’t read this camera’s RAW format, so this uses the JPEG preview inside the file.'];
    }
    if (f.hdr) {
      return [`${model || 'Photo'} · HDR photo`,
        apple
          ? 'Your iPhone already processed this photo, so the film goes on top of Apple’s look. Its HDR gain map gives the film back the highlights. Close, not exact.'
          : 'The camera already processed this photo, so the film goes on top of its look. Its HDR gain map gives the film back the highlights. Close, not exact.'];
    }
    return [`${model || 'Photo'} · finished photo`, apple
      ? 'Your iPhone already processed this photo, so the film goes on top of Apple’s look. Close, not exact.'
      : 'The camera already processed this photo, so the film goes on top of its look. Close, not exact.'];
  }

  function filmShowSource(f) {
    if (!f.sourceNode) return;
    const [title, text] = filmSourceNote(f, f.meta);
    f.sourceNode.replaceChildren(el('strong', null, title), el('p', null, text));
  }

  async function saveFilm(button, note) {
    const f = film;
    if (!f?.img.ok || f.saving) return;
    f.saving = true;
    button.disabled = true;
    // Already developed at full detail (zoomed in) for these settings: only the JPEG is left.
    const ready = Boolean(f.detail?.canvas) && f.detail.settings === filmSettings(f);
    const pixels = f.saveW && f.saveH ? f.saveW * f.saveH : Math.min(FILM_SAVE_PIXELS, f.img.width * f.img.height);
    const steps = ready ? ['encoding']
      : [f.raw !== 'no' ? 'reading' : 'prepare', 'exposing', 'halation', 'sharpness', 'curves', 'couplers', 'grain', 'printing', 'encoding'];
    let cancelled = false;
    const progress = saveProgress({ eyebrow: 'Developing · Portra 400', steps, megapixels: pixels / 1e6, learn: !ready });
    progress.cancellable(ready ? null : () => {
      cancelled = true;
      if (f.detail?.running) filmRestartWorker();
    });
    f.saveStage = (stage) => progress.step(stage);
    progress.step(steps[0]);
    try {
      await settled();
      const res = await filmDetail(f);
      if (cancelled) throw new Error('cancelled');
      progress.cancellable(null);
      progress.step('encoding');
      await painted();
      // The frame, if on, goes around the developed photo here.
      let out = res.canvas;
      const framed = framedSize(res.width, res.height);
      if (framed.b) {
        out = document.createElement('canvas');
        out.width = framed.width;
        out.height = framed.height;
        const ctx = out.getContext('2d');
        ctx.fillStyle = FRAME_COLORS[filmPrefs.frameColor];
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(res.canvas, framed.b, framed.b, res.width * framed.k, res.height * framed.k);
      }
      const { width, height } = out;
      const blob = await toJpeg(out, 0.92);
      if (out !== res.canvas) out.width = 0;
      if (!blob) throw new Error('This browser couldn’t save the photo.');
      if (f.url) URL.revokeObjectURL(f.url);
      f.url = URL.createObjectURL(blob);
      const name = `${baseName(f.file.name)}-portra400.jpg`;
      const size = `${width} × ${height}, ${fmtBytes(blob.size)}`;
      deliver(progress, blob, f.url, name, `${name} · ${size}`);
      note.textContent = `Saved ${name}, ${size}. Developed on this device.`;
    } catch (err) {
      if (cancelled || err.message === 'cancelled') {
        progress.close();
        note.textContent = 'Save cancelled.';
      } else {
        progress.fail(String(err.message || err));
        note.textContent = `Couldn’t save: ${String(err.message || err)}`;
      }
    }
    f.saveStage = null;
    f.saving = false;
    button.disabled = false;
  }

  /* ---------- Film on phones: a photo editor ---------- */

  // On narrow screens Film works like a phone photo editor: the photo stays put and fills the
  // screen, and a row of square tool buttons sits under it. Exposure, Brightness and Frame each
  // show their control in one fixed-height strip above the row (so the photo never resizes),
  // Original is held to compare, and Save develops at full size.
  const TOOL_ICONS = {
    look: ['........#', '........#', '......#.#', '......#.#', '....#.#.#', '....#.#.#', '..#.#.#.#', '..#.#.#.#', '#.#.#.#.#'],
    exposure: ['....#....', '.#.....#.', '...###...', '..#####..', '#.#####.#', '..#####..', '...###...', '.#.....#.', '....#....'],
    brightness: ['..#####..', '.#..####.', '#...#####', '#...#####', '#...#####', '#...#####', '#...#####', '.#..####.', '..#####..'],
    frame: ['#########', '#.......#', '#.#####.#', '#.#####.#', '#.#####.#', '#.#####.#', '#.#####.#', '#.......#', '#########'],
    original: ['.........', '..#####..', '.#.....#.', '#...#...#', '#..###..#', '#...#...#', '.#.....#.', '..#####..', '.........'],
    save: ['....#....', '....#....', '....#....', '..#.#.#..', '...###...', '....#....', '.........', '#.......#', '#########'],
    style: ['#########', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#####...#', '#########'],
    font: ['...###...', '..#...#..', '.#.....#.', '.#.....#.', '.#######.', '.#.....#.', '.#.....#.', '.#.....#.', '.........'],
    shape: ['..#......', '..#......', '#######..', '..#...#..', '..#...#..', '..#...#..', '..#######', '......#..', '......#..'],
    text: ['#########', '.........', '#######..', '.........', '#########', '.........', '#####....', '.........', '.........'],
  };

  function pixelIcon(rows) {
    const ns = 'http://www.w3.org/2000/svg';
    const w = rows[0].length;
    const h = rows.length;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w * 2));
    svg.setAttribute('height', String(h * 2));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('aria-hidden', 'true');
    let d = '';
    rows.forEach((row, y) => {
      for (let x = 0; x < w;) {
        if (row[x] !== '#') { x++; continue; }
        const x0 = x;
        while (row[x] === '#') x++;
        d += `M${x0} ${y}h${x - x0}v1H${x0}z`;
      }
    });
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'currentColor');
    svg.append(path);
    return svg;
  }

  const toolButton = (iconKey, label) => el('button', { class: 'tool', type: 'button' },
    pixelIcon(TOOL_ICONS[iconKey]), el('span', null, label));

  // The editor's frame, shared by Film and Shot on: the tool's name and value, one fixed-height
  // strip that shows the active tool's control, and the row of square buttons. `panes` maps each
  // tool to { tool (button label), label, icon, node, value(), disabled?() }; `extras` are more
  // buttons after the tools (hold to compare, save). `owner` remembers the active tool.
  function editorShell(owner, panes, extras) {
    const name = el('span', { class: 'editor-name' });
    const value = el('span', { class: 'editor-value' });
    const head = el('p', { class: 'editor-head', 'aria-live': 'polite' }, name, value);
    const controls = el('div', { class: 'editor-controls' }, Object.values(panes).map((p) => p.node));
    const tools = el('div', { class: 'editor-tools', role: 'toolbar', 'aria-label': 'Tools' });
    const keys = Object.keys(panes);
    let active = panes[owner.editorTool] ? owner.editorTool : keys[0];
    const buttons = {};
    function show() {
      if (panes[active].disabled?.()) active = keys.find((k) => !panes[k].disabled?.());
      const p = panes[active];
      name.textContent = p.label;
      value.textContent = p.value();
      for (const k of keys) {
        panes[k].node.hidden = k !== active;
        buttons[k].setAttribute('aria-pressed', String(k === active));
        buttons[k].disabled = Boolean(panes[k].disabled?.());
      }
      // Option rows measure their fill once they can be seen.
      requestAnimationFrame(() => { for (const g of p.node.querySelectorAll('.seg')) placeFill(g, true); });
    }
    for (const k of keys) {
      const b = toolButton(panes[k].icon, panes[k].tool);
      b.dataset.tool = k;
      b.addEventListener('click', () => { active = k; owner.editorTool = k; show(); });
      buttons[k] = b;
      tools.append(b);
    }
    tools.append(...extras);
    return { root: el('div', { class: 'tool-editor' }, head, controls, tools), show };
  }

  function buildFilmEditor(f, meta) {
    f.meta = meta;
    f.sourceNode = null;
    let shell = null;
    const refresh = () => shell?.show();

    // `pref`: the value is a remembered preference (filmPrefs) with its own double-click reset.
    const range = (key, min, max, step, label, pref = null) => {
      const target = pref ? filmPrefs : f;
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label });
      input.value = String(target[key]);
      input.addEventListener('input', () => {
        target[key] = Number(input.value);
        refresh();
        filmPreview();
      });
      if (pref) input.addEventListener('change', saveFilmPrefs);
      input.addEventListener('dblclick', () => {
        input.value = String(pref ? pref.reset : 0);
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
      return input;
    };

    // Frame: on/off and colour in one row, the width under it.
    const toggle = el('button', { class: 'editor-switch', type: 'button', role: 'switch', 'aria-checked': String(filmPrefs.frame) },
      el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })), 'Frame');
    const colors = el('div', { class: 'seg', role: 'group', 'aria-label': 'Frame colour' },
      Object.keys(FRAME_COLORS).map((v) => el('button', {
        type: 'button', 'data-value': v, 'aria-pressed': String(filmPrefs.frameColor === v),
      }, v === 'white' ? 'White' : 'Black')));
    const size = el('input', { type: 'range', min: '1', max: '20', step: '0.5', 'aria-label': 'Frame size' });
    size.value = String(filmPrefs.frameSize);
    const frameState = () => {
      toggle.setAttribute('aria-checked', String(filmPrefs.frame));
      colors.classList.toggle('is-off', !filmPrefs.frame);
      size.disabled = !filmPrefs.frame;
    };
    const frameChanged = () => {
      frameState();
      saveFilmPrefs();
      filmApplyFrame(f);
      refresh();
    };
    toggle.addEventListener('click', () => {
      filmPrefs.frame = !filmPrefs.frame;
      frameChanged();
    });
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      filmPrefs.frameColor = b.dataset.value;
      filmPrefs.frame = true;
      for (const other of colors.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(colors);
      frameChanged();
    });
    size.addEventListener('input', () => {
      filmPrefs.frameSize = Number(size.value);
      filmApplyFrame(f);
      refresh();
    });
    size.addEventListener('change', saveFilmPrefs);
    frameState();
    trackFill(colors);

    // Original: shows the photo as it came for as long as it is held.
    // Six buttons share the row, so each label is six letters at most.
    const hold = toolButton('original', 'Before');
    hold.classList.add('film-compare');
    hold.setAttribute('aria-label', 'Hold to see the original');
    const compare = (on) => {
      f.stage?.classList.toggle('show-original', on);
      document.documentElement.classList.toggle('is-comparing', on);
      hold.classList.toggle('is-held', on);
    };
    hold.addEventListener('pointerdown', () => compare(true));
    hold.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) hold.addEventListener(type, () => compare(false));
    hold.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') compare(true); });
    hold.addEventListener('keyup', () => compare(false));

    const note = el('p', { class: 'visually-hidden', role: 'status' });
    f.note = note;
    const save = toolButton('save', 'Save');
    save.classList.add('tool-save');
    save.addEventListener('click', () => saveFilm(save, note));

    shell = editorShell(f, {
      look: { tool: 'Look', label: 'Strength', icon: 'look', value: () => fmtPercent(filmPrefs.look),
        node: el('div', { class: 'editor-pane editor-ruler' }, range('look', 0, 100, 10, 'Strength', { reset: FILM_LOOK_DEFAULT })) },
      exposure: { tool: 'Expose', label: 'Exposure', icon: 'exposure', value: () => fmtStops(f.exposure),
        node: el('div', { class: 'editor-pane editor-ruler' }, range('exposure', -2, 3, 0.5, 'Exposure')) },
      brightness: { tool: 'Bright', label: 'Brightness', icon: 'brightness', value: () => fmtStops(f.brightness),
        node: el('div', { class: 'editor-pane editor-ruler' }, range('brightness', -1.5, 1.5, 0.1, 'Brightness')) },
      frame: { tool: 'Frame', label: 'Frame', icon: 'frame', value: () => (filmPrefs.frame ? `${filmPrefs.frameSize}%` : 'Off'),
        node: el('div', { class: 'editor-pane editor-stack' }, el('div', { class: 'editor-frame-row' }, toggle, colors), size) },
    }, [hold, save]);
    shell.show();
    return [shell.root, note];
  }

  function buildCardEditor(file, meta) {
    const stampy = () => cardPrefs.style !== 'pixel' && Boolean(CARD_FONTS[cardPrefs.font].glow);
    const autoSmall = () => {
      if (!card.smallEdited) card.small = stampy() ? card.stampSmall : card.plainSmall;
    };
    if (card?.file !== file) card = { file, smallEdited: false, ...cardDefaults(meta) };
    autoSmall();
    let shell = null;
    const refresh = () => shell?.show();

    // Text: pick a line, edit it in the one field.
    const LINES = [['title', 'Title', 'Camera'], ['details', 'Settings', '35 mm   f/1.8   1/250 s   ISO 100'], ['small', 'Small line', 'Lens, place or date']];
    let line = card.editorLine || 'title';
    const input = el('input', { type: 'text', maxlength: '80', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Line text' });
    const lineRow = el('div', { class: 'seg', role: 'group', 'aria-label': 'Line' },
      LINES.map(([key, label]) => el('button', { type: 'button', 'data-value': key, 'aria-pressed': String(key === line) },
        key === 'small' ? 'Small' : label)));
    const showLine = () => {
      const [, label, placeholder] = LINES.find(([key]) => key === line);
      input.value = card[line];
      input.placeholder = placeholder;
      input.setAttribute('aria-label', label);
    };
    lineRow.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      line = b.dataset.value;
      card.editorLine = line;
      for (const other of lineRow.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(lineRow);
      showLine();
      refresh();
    });
    input.addEventListener('input', () => {
      card[line] = input.value;
      if (line === 'small') card.smallEdited = true;
      drawPreview();
    });
    showLine();
    trackFill(lineRow);

    const seg = (key, options, cls) => {
      const box = el('div', { class: `seg${cls ? ` ${cls}` : ''}`, role: 'group', 'aria-label': key },
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
        autoSmall();
        showLine();
        drawPreview();
        refresh();
      });
      trackFill(box);
      return box;
    };
    const label = (key, options) => () => options.find(([v]) => v === cardPrefs[key])?.[1] || '';
    const STYLES = [['light', 'Light'], ['dark', 'Dark'], ['pixel', 'Pixel']];
    const FONTS = Object.entries(CARD_FONTS).map(([value, f]) => [value, f.label]);
    const SHAPES = [['original', 'Original'], ['square', 'Square'], ['portrait', '4:5']];

    const note = el('p', { class: 'visually-hidden', role: 'status' });
    const save = toolButton('save', 'Save');
    save.classList.add('tool-save');
    save.addEventListener('click', () => saveCard(save, note));

    shell = editorShell(card, {
      style: { tool: 'Style', label: 'Style', icon: 'style', value: label('style', STYLES),
        node: el('div', { class: 'editor-pane' }, seg('style', STYLES)) },
      font: { tool: 'Font', label: 'Font', icon: 'font', value: label('font', FONTS), disabled: () => cardPrefs.style === 'pixel',
        node: el('div', { class: 'editor-pane' }, seg('font', FONTS, 'seg-fonts')) },
      shape: { tool: 'Shape', label: 'Shape', icon: 'shape', value: label('shape', SHAPES),
        node: el('div', { class: 'editor-pane' }, seg('shape', SHAPES)) },
      text: { tool: 'Text', label: 'Text', icon: 'text', value: () => LINES.find(([key]) => key === line)[1],
        node: el('div', { class: 'editor-pane editor-stack' }, lineRow, input) },
    }, [save]);
    shell.show();
    return [shell.root, note];
  }

  // Phones get the editor in Film and Shot on; the class switches the page to its fixed, no-scroll layout.
  const editorWanted = () => Boolean(narrowLayout.matches && current?.img.ok && (mode === 'film' || mode === 'shot-on'));
  const syncEditor = () => viewerView.classList.toggle('is-editor', editorWanted());

  function buildFilmPanel(file, meta, img) {
    const f = filmFor(file, img);
    if (img.ok && narrowLayout.matches) return buildFilmEditor(f, meta);
    const nodes = [el('div', { class: 'summary' },
      el('p', { class: 'summary-eyebrow', title: file.name }, file.name),
      el('h1', { class: 'summary-title' }, 'Portra 400'),
      el('p', { class: 'summary-sub' }, 'Kodak’s film from its own datasheet, printed like a Noritsu lab print.'),
    )];
    if (!img.ok) {
      nodes.push(notice('Can’t develop this photo', /\.(heic|heif)$/i.test(file.name)
        ? 'This HEIC photo couldn’t be decoded here. Save it as a JPEG and try again.'
        : 'This browser can’t show this photo, so it can’t develop it.'));
      return nodes;
    }

    f.meta = meta;
    f.sourceNode = el('div', { class: 'film-source' });
    filmShowSource(f);
    nodes.push(f.sourceNode);

    // `pref`: the value is a remembered preference (filmPrefs), shown as a percentage, with its
    // own double-click reset.
    const slider = (label, key, min, max, step, help, pref = null) => {
      const target = pref ? filmPrefs : f;
      const fmt = pref ? fmtPercent : fmtStops;
      const value = el('span', { class: 'film-value' }, fmt(target[key]));
      const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), 'aria-label': label });
      input.value = String(target[key]);
      input.addEventListener('input', () => {
        target[key] = Number(input.value);
        value.textContent = fmt(target[key]);
        filmPreview();
      });
      if (pref) input.addEventListener('change', saveFilmPrefs);
      input.addEventListener('dblclick', () => {
        input.value = String(pref ? pref.reset : 0);
        input.dispatchEvent(new Event('input'));
        input.dispatchEvent(new Event('change'));
      });
      return el('label', { class: 'card-row film-slider' },
        el('span', { class: 'card-label' }, label, value), input, el('small', null, help));
    };

    const compare = el('button', { class: 'map-link film-compare', type: 'button' }, 'Hold to see the original');
    const show = (on) => {
      f.stage?.classList.toggle('show-original', on);
      document.documentElement.classList.toggle('is-comparing', on);
      compare.classList.toggle('is-held', on);
    };
    compare.addEventListener('pointerdown', () => show(true));
    // A long press on iOS would otherwise select text and open the callout menu.
    compare.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    compare.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) compare.addEventListener(type, () => show(false));
    compare.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') show(true); });
    compare.addEventListener('keyup', () => show(false));

    const save = el('button', { class: 'map-link wipe-save', type: 'button' }, icon('file'), 'Save photo');
    const note = el('p', { class: 'map-note' }, 'Developed on this device at up to '
      + `${Math.round(FILM_SAVE_PIXELS / 1e6)} megapixels. Takes a few seconds.`);
    f.note = note;
    save.addEventListener('click', () => saveFilm(save, note));

    nodes.push(
      el('div', { class: 'card-controls' },
        slider('Strength', 'look', 0, 100, 10, 'How much of the film look goes on: its colours, soft blacks, grain and glow. 0 stays closest to your photo.',
          { reset: FILM_LOOK_DEFAULT }),
        slider('Exposure', 'exposure', -2, 3, 0.5, 'Stops on the film. Portra loves extra light: + gives softer, airier colour.'),
        slider('Brightness', 'brightness', -1.5, 1.5, 0.1, 'Stops at the print, like a lab’s density button.'),
        compare,
      ),
      filmFrameControls(f),
      save,
      note,
    );
    return nodes;
  }

  // The Frame section: off, it is only its title and a square switch; on, it shows the colour
  // (white or black) and a slider for the frame's width.
  function filmFrameControls(f) {
    const toggle = el('button', { class: 'frame-toggle', type: 'button', role: 'switch',
      'aria-checked': String(filmPrefs.frame) },
    el('span', { class: 'card-label' }, 'Frame'),
    el('span', { class: 'switch', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })));

    const colors = el('div', { class: 'seg', role: 'group', 'aria-label': 'Frame colour' },
      Object.keys(FRAME_COLORS).map((value) => el('button', {
        type: 'button', 'data-value': value, 'aria-pressed': String(filmPrefs.frameColor === value),
      }, value === 'white' ? 'White' : 'Black')));
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      filmPrefs.frameColor = b.dataset.value;
      for (const other of colors.children) other.setAttribute('aria-pressed', String(other === b));
      placeFill(colors);
      saveFilmPrefs();
      filmApplyFrame(f);
    });
    trackFill(colors);

    const sizeValue = el('span', { class: 'film-value' }, `${filmPrefs.frameSize}%`);
    const size = el('input', { type: 'range', min: '1', max: '20', step: '0.5', 'aria-label': 'Frame size' });
    size.value = String(filmPrefs.frameSize);
    size.addEventListener('input', () => {
      filmPrefs.frameSize = Number(size.value);
      sizeValue.textContent = `${filmPrefs.frameSize}%`;
      filmApplyFrame(f);
    });
    size.addEventListener('change', saveFilmPrefs);

    const body = el('div', { class: 'frame-body' },
      el('div', { class: 'card-row' }, el('span', { class: 'card-label' }, 'Colour'), colors),
      el('label', { class: 'card-row film-slider' }, el('span', { class: 'card-label' }, 'Size', sizeValue), size,
        el('small', null, 'Width of the border, as a share of the photo’s shorter side.')));
    body.hidden = !filmPrefs.frame;

    toggle.addEventListener('click', () => {
      filmPrefs.frame = !filmPrefs.frame;
      toggle.setAttribute('aria-checked', String(filmPrefs.frame));
      body.hidden = !filmPrefs.frame;
      saveFilmPrefs();
      filmApplyFrame(f);
      if (filmPrefs.frame) placeFill(colors);
    });
    return el('div', { class: 'card-controls film-frame-controls' }, toggle, body);
  }

  /* ---------- Sliding fill for tabs and option rows ---------- */

  // Moves a group's blue fill (its ::before, see styles.css) under the pressed button. The first
  // placement happens without animation; after that the fill slides. The fill keeps one base width
  // and only its transform changes (move and stretch), which the browser animates off the main
  // thread, so the slide stays smooth even while the page is busy switching tools. The base is
  // re-measured when the group resizes (`resized`), so the stretch stays near 1.
  function placeFill(group, resized = false) {
    const on = group.querySelector('[aria-pressed="true"]');
    if (!on || !on.offsetWidth) return;
    if (resized || !group.dataset.fillBase || !group.classList.contains('has-fill')) {
      group.dataset.fillBase = String(on.offsetWidth);
      group.style.setProperty('--fill-base', `${on.offsetWidth}px`);
    }
    group.style.setProperty('--fill-x', `${on.offsetLeft}px`);
    group.style.setProperty('--fill-s', String(on.offsetWidth / Number(group.dataset.fillBase)));
    if (!group.classList.contains('has-fill')) {
      getComputedStyle(group, '::before').transform; // apply the position before transitions start
      group.classList.add('has-fill');
    }
  }

  // Widths change when fonts load, the window resizes, or the tabs move into the panel.
  const fillObserver = new ResizeObserver((entries) => entries.forEach((e) => placeFill(e.target, true)));
  const trackFill = (group) => {
    fillObserver.observe(group);
    placeFill(group);
    return group;
  };
  // A new look changes the tabs' fonts and padding; move the fills once it has applied.
  window.inspicioPrefs?.onChange(() => requestAnimationFrame(() => {
    for (const group of document.querySelectorAll('.modes, .seg')) placeFill(group, true);
  }));

  /* ---------- Modes ---------- */

  // The tabs above the drop zone. On the empty page they change the words; with a photo open they
  // sit at the top of the panel and switch what the panel shows for the same photo. The choice is
  // kept in the address (#wipe) so a link can open a tool directly. Nothing from a photo goes there.
  const MODES = {
    inspect: {
      title: ['See what your', 'photos say.'],
      sub: 'Camera, settings, date and location: every hidden tag, read in your browser.',
      dropSub: 'or click to choose one',
      overlay: 'Drop to inspect',
      doc: 'Inspicio · See and remove photo metadata, free in your browser',
    },
    wipe: {
      title: ['Wipe what your', 'photos say.'],
      sub: 'Remove the location, date and camera before you share. Done in your browser.',
      dropSub: 'to make a clean copy',
      overlay: 'Drop to wipe',
      doc: 'Inspicio · Remove photo metadata and location',
    },
    'shot-on': {
      title: ['Show how you', 'shot it.'],
      sub: 'Put the camera and settings under your photo, ready to post. Made in your browser.',
      dropSub: 'to make a card',
      overlay: 'Drop to make a card',
      doc: 'Inspicio · Shot on frame with your camera settings',
    },
    film: {
      title: ['Develop it', 'like film.'],
      sub: 'Kodak Portra 400 from its datasheet: halation, grain and a real print. Made in your browser.',
      dropSub: 'to develop it',
      overlay: 'Drop to develop',
      doc: 'Inspicio · Film filter based on Kodak Portra 400',
    },
  };

  const modesNav = $('#modes');
  // Each tool also has its own page (remove-metadata.html and so on, made by tools/pages/make-pages.js)
  // that opens on that tool and explains it below the fold. The explanation fits only its own tool.
  const homeMode = MODES[document.documentElement.dataset.tool] ? document.documentElement.dataset.tool : 'inspect';
  const toolAbout = $('#tool-about');
  let mode = homeMode;
  let current = null; // { file, meta, img } for the open photo
  let photoFigure = null; // the zoomable photo; the Shot on tool shows its card in its place

  function panelNodes() {
    const { file, meta, img } = current;
    const build = { wipe: buildWipePanel, 'shot-on': buildCardPanel, film: buildFilmPanel }[mode] || buildPanel;
    return [modesNav, ...build(file, meta, img)];
  }

  // What the stage shows: the zoomable photo, the Shot on card, or the developed film.
  const stageKind = () => (current?.img.ok && (mode === 'shot-on' || mode === 'film') ? mode : 'photo');

  function stageNode() {
    const kind = stageKind();
    stage.dataset.kind = kind;
    stageZoom?.stop();
    stageZoom = null;
    if (kind !== 'shot-on') { cardCanvas = null; cardFrame = null; }
    if (kind !== 'film' && film) film.canvas = null;
    if (kind === 'shot-on') return buildCardStage();
    if (kind === 'film') {
      filmFor(current.file, current.img);
      return buildFilmStage();
    }
    return photoFigure;
  }

  const ENTRANCE_ANIMATIONS = new Set(['rise', 'frame-in', 'caption-in', 'photo-in']);

  function setMode(next, fromUser) {
    if (!MODES[next]) next = homeMode;
    const changed = next !== mode;
    mode = next;
    const m = MODES[mode];
    for (const b of modesNav.querySelectorAll('.mode')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    placeFill(modesNav);
    if (fromUser) history.replaceState(null, '', mode === homeMode ? location.pathname + location.search : `#${mode}`);
    if (toolAbout) toolAbout.hidden = mode !== homeMode;
    $('#overlay-drop').textContent = m.overlay;

    if (current) {
      document.title = `${current.file.name} · Inspicio`;
      if (changed) {
        syncEditor();
        if (stageKind() !== stage.dataset.kind) stage.replaceChildren(stageNode());
        panel.replaceChildren(...panelNodes());
        panel.scrollTop = 0;
        // Same photo, other tool: skip the entrance animations (fade-ins, the decoding numbers),
        // which would make the photo and panel blink on every tab change.
        for (const a of viewerView.getAnimations({ subtree: true })) {
          if (a instanceof CSSAnimation && ENTRANCE_ANIMATIONS.has(a.animationName)) a.finish();
        }
      }
      return;
    }
    document.title = m.doc;
    const title = $('#hero-title');
    title.replaceChildren(m.title[0], el('br'), m.title[1]);
    let shown = null;
    for (const span of document.querySelectorAll('.line-stack > span')) {
      span.classList.toggle('is-on', span.dataset.line === mode);
      if (span.dataset.line === mode && span.parentElement.id === 'hero-sub') shown = span;
    }
    if (changed && !reduceMotion.matches) {
      for (const node of [title, shown]) {
        node.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
    }
  }

  // Every tool's line sits in the same grid cell and only the current one is visible, so the block
  // is always as tall as its longest line and the page doesn't shift when the tab changes.
  for (const [id, key] of [['#hero-sub', 'sub'], ['#dropzone-sub', 'dropSub']]) {
    const node = $(id);
    node.classList.add('line-stack');
    node.replaceChildren(...Object.entries(MODES).map(([name, m]) => el('span', { 'data-line': name }, m[key])));
  }

  modesNav.addEventListener('click', (e) => {
    const b = e.target.closest('.mode');
    if (b) setMode(b.dataset.mode, true);
  });

  window.addEventListener('hashchange', () => setMode(location.hash.slice(1)));

  // Turning a phone or resizing the window across the narrow width swaps Film's panel between
  // the editor and the full panel.
  narrowLayout.addEventListener('change', () => {
    if (!current || (mode !== 'film' && mode !== 'shot-on')) return;
    syncEditor();
    panel.replaceChildren(...panelNodes());
  });

  /* ---------- State ---------- */

  function withTransition(update) {
    if (!document.startViewTransition || reduceMotion.matches) {
      update();
      return Promise.resolve();
    }
    const transition = document.startViewTransition(update);
    // A transition can be skipped (for example when the tab is hidden); the DOM update still runs.
    transition.ready.catch(() => {});
    return transition.finished.catch(() => {});
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function looksLikeImage(file) {
    return (file.type && file.type.startsWith('image/')) ||
      /\.(jpe?g|heic|heif|avif|png|tiff?|webp|gif|bmp)$/i.test(file.name) || RAW_EXT.test(file.name);
  }

  // Loading overlay, for when opening takes a moment: a slow decode, or Safari waiting for the
  // Photos app to export a dragged photo (Safari fires `drop` only once the file is written).
  let slowTimer = 0;
  function setLoading(on) {
    document.body.classList.toggle('loading', on);
    app.setAttribute('aria-busy', String(on));
  }

  async function handleFile(file) {
    if (!file || !looksLikeImage(file)) setLoading(false);
    if (!file) return;
    if (!looksLikeImage(file)) {
      if (app.dataset.state === 'empty') showError(`“${file.name}” doesn’t look like an image. Try a JPEG, HEIC or PNG.`);
      else flashPanelError(`“${file.name}” doesn’t look like an image.`);
      return;
    }
    errorBox.hidden = true;

    const token = ++loadToken;
    document.body.classList.add('busy');
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => setLoading(true), 250);
    let url = URL.createObjectURL(file);

    const [meta, decoded] = await Promise.all([readMetadata(file), decodeImage(url)]);
    let img = decoded;

    // A RAW file the browser can't show: use the camera's embedded JPEG preview instead.
    if (!img.ok && RAW_EXT.test(file.name)) {
      const raw = await loadRawPreview(file);
      if (raw) {
        URL.revokeObjectURL(url);
        url = raw.url;
        img = raw.img;
      }
    }

    // A HEIC this browser can't show: decode it here.
    if (!img.ok && isHeif(file) && token === loadToken) {
      const heic = await loadHeifPreview(file, meta);
      if (heic) {
        URL.revokeObjectURL(url);
        url = heic.url;
        img = heic.img;
      }
    }

    if (token !== loadToken) {
      URL.revokeObjectURL(url);
      return;
    }
    document.body.classList.remove('busy');
    clearTimeout(slowTimer);
    setLoading(false);

    const previousUrl = currentUrl;
    currentUrl = url;

    current = { file, meta, img };
    if (cleanUrl) URL.revokeObjectURL(cleanUrl);
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    if (film?.url) URL.revokeObjectURL(film.url);
    cleanUrl = null;
    cardUrl = null;
    cleanFor = null;
    photoFigure = buildStage(file, img, url);

    await withTransition(() => {
      syncEditor();
      panel.replaceChildren(...panelNodes());
      stage.replaceChildren(stageNode());
      emptyView.hidden = true;
      viewerView.hidden = false;
      openAnother.hidden = false;
      app.dataset.state = 'viewer';
      document.body.dataset.state = 'viewer';
      panel.scrollTop = 0;
      document.title = `${file.name} · Inspicio`;
      decodeValues(panel);
    });

    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }

  function flashPanelError(message) {
    const n = notice('Can’t open that file', message);
    panel.prepend(n);
    setTimeout(() => n.remove(), 4000);
  }

  /* ---------- Events ---------- */

  dropzone.addEventListener('click', () => fileInput.click());
  openAnother.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    handleFile(file);
  });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  // Browsers fire `dragover` every few hundred ms while a drag is over the page, even when the
  // pointer is still. If it stops with no `dragleave` or `drop`, the user let go and the browser
  // is waiting for the file (Safari with a Photos drag), so show the loading overlay.
  let quietTimer = 0;
  let stuckTimer = 0;
  const isBusy = () => document.body.classList.contains('busy');

  function endDrag() {
    dragDepth = 0;
    document.body.classList.remove('dragging');
    clearTimeout(quietTimer);
    clearTimeout(stuckTimer);
  }

  function dragActivity() {
    clearTimeout(quietTimer);
    clearTimeout(stuckTimer);
    if (!isBusy()) setLoading(false);
    quietTimer = setTimeout(() => {
      setLoading(true);
      // Give up if no file ever arrives.
      stuckTimer = setTimeout(() => {
        endDrag();
        if (!isBusy()) setLoading(false);
      }, 30000);
    }, 600);
  }

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
    startBits();
    dragActivity();
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    dragActivity();
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth > 0) return;
    endDrag();
    if (!isBusy()) setLoading(false);
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    endDrag();
    handleFile(e.dataTransfer.files[0]);
  });

  /* ---------- Drop zone data scrambles ---------- */

  // While the photos are fanned out (pointer over the drop zone, or a file dragged over the page),
  // short scrambled bits of made-up metadata rise from them and fade. They move with Web
  // Animations (run by the browser's compositor); only the glyph shuffling runs on a timer.
  const photoStack = $('#photo-stack');
  const DATA_BITS = ['ISO 400', 'F/2.8', '1/250', '24 MM', 'GPS', 'EXIF', 'XMP', 'ICC', '0X9003', 'SRGB',
    'N 49°', 'W 123°', '8064', 'P3', 'RAW', 'IFD0', '-07:00', 'AUTO'];
  let bitTimer = null;
  const bits = new Set();

  const stackActive = () => !emptyView.hidden && !reduceMotion.matches && pixelLook()
    && (dropzone.matches(':hover') || document.body.classList.contains('dragging'));

  function startBits() {
    if (!photoStack || bitTimer || !stackActive()) return;
    let tick = 0;
    bitTimer = setInterval(() => {
      tick++;
      const active = stackActive();
      // A new bit every 6th tick (about 3 a second), once the photos have had time to fan out.
      if (active && tick > 6 && tick % 6 === 0 && bits.size < 7) addBit();
      // Each bit's glyphs reshuffle, then settle into its text left to right.
      for (const b of bits) {
        b.age++;
        const settled = Math.max(0, Math.floor((b.age - 6) / 2));
        b.node.textContent = b.text.slice(0, settled) + scramble(b.text.slice(settled));
      }
      if (!active && !bits.size) { clearInterval(bitTimer); bitTimer = null; }
    }, 55);
  }

  function addBit() {
    const text = DATA_BITS[(Math.random() * DATA_BITS.length) | 0];
    const node = el('span', { class: 'data-bit' }, scramble(text));
    photoStack.append(node);
    const bit = { node, text, age: 0 };
    bits.add(bit);
    // Start somewhere across the spread-out photos, rise 40 to 60 px with a little drift.
    const x = (Math.random() * 2 - 1) * 50;
    const rise = 40 + Math.random() * 20;
    const drift = (Math.random() * 2 - 1) * 8;
    const life = 1500 + Math.random() * 500;
    node.animate([
      { transform: `translate(calc(-50% + ${x}px), 0)`, opacity: 0 },
      { opacity: 0.85, offset: 0.15 },
      { opacity: 0.85, offset: 0.6 },
      { transform: `translate(calc(-50% + ${x + drift}px), ${-rise}px)`, opacity: 0 },
    ], { duration: life, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' })
      .finished.then(() => { node.remove(); bits.delete(bit); }, () => { node.remove(); bits.delete(bit); });
  }

  dropzone.addEventListener('pointerenter', startBits);

  /* ---------- Empty page ticker ---------- */

  // Faint rows of made-up example tags drift behind the headline. Purely decorative: these values
  // are invented and never come from a photo.
  const TICKER_TAGS = [
    'Make Apple', 'Model iPhone 15 Pro', 'LensModel 6.86 mm f/1.78', 'ISO 80', 'ExposureTime 1/120',
    'FNumber 1.78', 'FocalLength 24 mm', 'GPSLatitude 49.2827 N', 'GPSLongitude 123.1207 W',
    'GPSAltitude 12.4 m', 'DateTimeOriginal 2026:10:14 17:42:09', 'OffsetTime -07:00',
    'ColorSpace sRGB', 'ProfileDescription Display P3', 'PixelXDimension 8064', 'PixelYDimension 6048',
    'Flash Off', 'WhiteBalance Auto', 'Software 18.1', 'Orientation Horizontal', 'Make Sony',
    'Model ILCE-7CM2', 'LensModel FE 35mm F1.8', 'ExposureTime 1/250', 'ISO 400', 'FNumber 2.8',
    'MeteringMode Pattern', 'ExposureProgram Aperture priority', 'BitsPerSample 14',
    'SceneCaptureType Standard', 'ExposureBias -0.3 EV', 'SubjectDistance 3.2 m', 'Contrast Normal',
  ];
  const TICKER_ROWS = 7;
  const GRID = 22; // the empty page's grid cell, in px

  function buildTicker() {
    const ticker = $('#ticker');
    if (!ticker) return;
    for (let r = 0; r < TICKER_ROWS; r++) {
      // Each row starts at a different tag and is long enough to cover a wide screen twice over.
      const parts = [];
      let len = 0;
      for (let i = r * 7; len < 420; i++) {
        const tag = TICKER_TAGS[i % TICKER_TAGS.length];
        parts.push(tag);
        len += tag.length + 5;
      }
      const text = parts.join('  ·  ') + '  ·  ';
      // Two copies side by side; sliding by half the row loops without a seam.
      const speed = 9 + ((r * 5) % 7); // px per second, 9 to 15
      ticker.append(el('div', {
        class: 'ticker-row',
        vars: { '--dur': `${Math.round((len * 8) / speed)}s`, '--delay': `${-Math.round(Math.random() * 200)}s` },
      }, el('span', {}, text), el('span', {}, text)));
    }

    // Center the rows on the headline, snapped so each row sits between two grid lines.
    const hero = ticker.parentElement;
    const h1 = hero.querySelector('h1');
    const place = () => {
      const heroTop = hero.getBoundingClientRect().top - emptyView.getBoundingClientRect().top;
      const center = heroTop + h1.offsetTop + h1.offsetHeight / 2;
      const top = Math.round((center - (TICKER_ROWS * GRID) / 2) / GRID) * GRID;
      ticker.style.setProperty('--ticker-top', `${top - heroTop}px`);
    };
    // The headline moves when the page resizes, the fonts load, or the error line appears.
    place();
    const observer = new ResizeObserver(place);
    for (const node of [emptyView, hero, errorBox]) observer.observe(node);
  }

  buildTicker();

  setMode(location.hash.slice(1));
  trackFill(modesNav);
  document.body.dataset.state = 'empty';
})();
