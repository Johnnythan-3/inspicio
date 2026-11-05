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

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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
            el('dd', null, copyText
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
      'Loads a map from Mapbox. This sends only the coordinates; your photo stays here.');

    button.addEventListener('click', () => {
      const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
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

      box.replaceChildren(el('div', { class: 'map-frame' }, img));
    }, { once: true });

    box.append(button, note);
    return box;
  }

  /* ---------- Panel ---------- */

  function buildPanel(file, meta, img) {
    const { leaves, get } = indexMetadata(meta.segments);
    const photoTags = leaves.filter((l) => !CONTAINER_SEGMENTS.has(l.segment));
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
        'This file is a reduced copy of the photo, so it looks soft when shown large. Dragging a photo '
        + 'straight out of the Photos app gives the browser only a small preview, and messaging apps often '
        + 'shrink photos too. For the full photo, click New photo, choose Photos in the sidebar of the window '
        + 'that opens, and pick it there. Or drag it from Photos to your Desktop first, then drop that file here. '
        + 'In Safari, dragging straight from Photos also works.',
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
    const lat = coordinate(get('latitude') ?? get('GPSLatitude'), toText(get('GPSLatitudeRef')));
    const lon = coordinate(get('longitude') ?? get('GPSLongitude'), toText(get('GPSLongitudeRef')));
    const hasCoords = lat !== null && lon !== null && !(lat === 0 && lon === 0);
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
      ['Artist', toText(get('Artist', 'creator', 'Byline', 'By-line'))],
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

  function notice(title, text) {
    return el('div', { class: 'notice', role: 'status' },
      icon('info'),
      el('div', null, el('strong', null, title), el('p', null, text)),
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

  function decodeImage(url) {
    const probe = new Image();
    probe.src = url;
    return probe.decode().then(
      () => ({ ok: true, width: probe.naturalWidth, height: probe.naturalHeight }),
      () => ({ ok: false }),
    );
  }

  function buildStage(file, img, url) {
    if (img.ok) {
      const caption = [img.rawPreview ? 'RAW preview' : null, `${img.width} × ${img.height}`, fmtBytes(file.size)]
        .filter(Boolean).join('  ·  ');
      // The <img> points at the original file (or a RAW file's embedded preview), so zooming in
      // shows its full resolution.
      const photo = el('img', {
        class: 'zoom-img',
        src: url,
        alt: `Preview of ${file.name}`,
        width: img.width,
        height: img.height,
        draggable: 'false',
      });
      const frame = el('div', {
        class: 'zoom-frame',
        vars: { '--ar': String(img.width / img.height), '--nat-w': `${img.width}px` },
        tabindex: '0',
        role: 'img',
        'aria-label': `${file.name}. Scroll, pinch or double-click to zoom; drag to move.`,
      }, photo);
      const out = el('button', { class: 'zoom-btn', type: 'button', 'aria-label': 'Zoom out' }, '−');
      const level = el('button', { class: 'zoom-level', type: 'button', title: 'Fit to view' }, 'Fit');
      const zin = el('button', { class: 'zoom-btn', type: 'button', 'aria-label': 'Zoom in' }, '+');
      attachZoom(frame, photo, { out, level, zin });
      return el('figure', { class: 'photo' },
        frame,
        el('figcaption', null,
          el('span', null, caption),
          el('div', { class: 'zoom-controls' }, out, level, zin),
        ),
      );
    }
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    return el('figure', { class: 'photo' },
      el('div', { class: 'preview-fallback' },
        icon('image'),
        el('strong', null, 'Preview not available'),
        el('span', null, heic
          ? 'This browser can’t display HEIC photos. Safari can. The metadata is still complete.'
          : RAW_EXT.test(file.name)
            ? 'This RAW file has no preview the browser can show. The metadata is still complete.'
            : 'This browser can’t display this file format. The metadata is still complete.'),
      ),
    );
  }

  /* ---------- Zoom ---------- */

  let zoomObserver = null;
  const narrowLayout = window.matchMedia('(max-width: 860px)');

  // Zoom and pan inside the photo's frame: a mouse wheel or trackpad pinch zooms at the cursor,
  // two-finger trackpad scrolling pans, touch pinch zooms, double-click toggles, drag pans, and
  // + / − / 0 work when the frame has focus.
  //
  // Zooming resizes the <img> itself (width/height as a % of the frame) and only translates it,
  // instead of scaling it with a CSS transform. The browser then decodes and draws the photo at the
  // size it is shown, so it stays as sharp as the original at every zoom level; a scale transform
  // can stretch a smaller, already-decoded copy and look soft.
  function attachZoom(frame, img, ui) {
    let s = 1;
    let tx = 0;
    let ty = 0;
    const pointers = new Map();
    let pinch = null;
    let lastTrackpad = 0;

    const maxScale = () => {
      const shown = frame.clientWidth || 1;
      const toNative = img.naturalWidth / (shown * (window.devicePixelRatio || 1));
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
      const pct = Math.round((frame.clientWidth * s / img.naturalWidth) * 100);
      ui.level.textContent = s === 1 ? 'Fit' : `${pct}%`;
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
    zoomObserver?.disconnect();
    let lastWidth = 0;
    zoomObserver = new ResizeObserver(() => {
      const w = frame.clientWidth;
      if (lastWidth && w !== lastWidth && s !== 1) zoomTo(1, 0, 0, null);
      lastWidth = w;
    });
    zoomObserver.observe(frame);
    img.addEventListener('load', () => render(null), { once: true });
    render(null);
  }

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

    if (token !== loadToken) {
      URL.revokeObjectURL(url);
      return;
    }
    document.body.classList.remove('busy');
    clearTimeout(slowTimer);
    setLoading(false);

    const previousUrl = currentUrl;
    currentUrl = url;

    await withTransition(() => {
      panel.replaceChildren(...buildPanel(file, meta, img));
      stage.replaceChildren(buildStage(file, img, url));
      emptyView.hidden = true;
      viewerView.hidden = false;
      openAnother.hidden = false;
      app.dataset.state = 'viewer';
      document.body.dataset.state = 'viewer';
      panel.scrollTop = 0;
      document.title = `${file.name} · Inspicio`;
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

  document.body.dataset.state = 'empty';
})();
