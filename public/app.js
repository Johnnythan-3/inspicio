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

  // rows: [label, value, note?]; rows with no value are dropped. Returns null if nothing is left.
  function group(title, iconName, rows, index, extra) {
    const kept = rows.filter((r) => r && r[1] !== null && r[1] !== undefined && r[1] !== '');
    if (!kept.length && !extra) return null;
    return el('section', { class: 'group', vars: { '--i': index } },
      el('h2', { class: 'group-head' }, icon(iconName), title),
      kept.length ? el('dl', { class: 'rows' },
        kept.map(([label, value, note]) => el('div', { class: 'row' },
          el('dt', null, label),
          el('dd', null, value, note ? el('small', null, note) : null),
        )),
      ) : null,
      extra || null,
    );
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

    nodes.push(group('Location', 'pin', [
      ['Latitude', hasCoords ? fmtDMS(lat, 'N', 'S') : null, hasCoords ? lat.toFixed(6) : null],
      ['Longitude', hasCoords ? fmtDMS(lon, 'E', 'W') : null, hasCoords ? lon.toFixed(6) : null],
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

    // Image
    const width = toNum(get('ExifImageWidth', 'PixelXDimension', 'ImageWidth')) || (img.ok ? img.width : null);
    const height = toNum(get('ExifImageHeight', 'PixelYDimension', 'ImageHeight')) || (img.ok ? img.height : null);
    const xres = toNum(get('XResolution'));
    const resUnit = toText(get('ResolutionUnit'));
    nodes.push(group('Image', 'image', [
      ['Dimensions', width && height ? `${width} × ${height}` : null, width && height ? `${round((width * height) / 1e6, 1)} megapixels` : null],
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
      const caption = [`${img.width} × ${img.height}`, fmtBytes(file.size)].filter(Boolean).join('  ·  ');
      return el('figure', { class: 'photo' },
        el('img', { src: url, alt: `Preview of ${file.name}`, width: img.width, height: img.height, decoding: 'async' }),
        el('figcaption', null, caption),
      );
    }
    const heic = /\.(heic|heif)$/i.test(file.name) || /hei[cf]/i.test(file.type);
    return el('figure', { class: 'photo' },
      el('div', { class: 'preview-fallback' },
        icon('image'),
        el('strong', null, 'Preview not available'),
        el('span', null, heic
          ? 'This browser can’t display HEIC photos. Safari can. The metadata on the left is complete.'
          : 'This browser can’t display this file format. The metadata on the left is still complete.'),
      ),
    );
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
      /\.(jpe?g|heic|heif|avif|png|tiff?|webp|gif|dng|bmp)$/i.test(file.name);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!looksLikeImage(file)) {
      if (app.dataset.state === 'empty') showError(`“${file.name}” doesn’t look like an image. Try a JPEG, HEIC or PNG.`);
      else flashPanelError(`“${file.name}” doesn’t look like an image.`);
      return;
    }
    errorBox.hidden = true;

    const token = ++loadToken;
    document.body.classList.add('busy');
    const url = URL.createObjectURL(file);

    const [meta, img] = await Promise.all([readMetadata(file), decodeImage(url)]);
    if (token !== loadToken) {
      URL.revokeObjectURL(url);
      return;
    }
    document.body.classList.remove('busy');

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

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });

  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    handleFile(e.dataTransfer.files[0]);
  });

  document.body.dataset.state = 'empty';
})();
