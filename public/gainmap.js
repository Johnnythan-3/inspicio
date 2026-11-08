/* Inspicio gain maps: reads the metadata of a photo's HDR gain map, shared by the page (JPEG)
   and the HEIC worker. A gain map is a small grey picture saying how much brighter each part of
   the photo is in its HDR version. Byte work only; nothing here makes a network request. */
'use strict';

// ISO 21496-1 gain map metadata: the base and alternate (HDR) headrooms in stops, and per channel
// the gain range in stops, its gamma and two small offsets. A HEIC 'tmap' item starts with a
// version byte; a JPEG's APP2 segment doesn't (`versionByte` false). Returns null for anything
// this can't use, and for a JPEG primary image's segment, which holds only the version.
function parseGainMapMetadata(bytes, versionByte = true) {
  let b = bytes;
  if (!versionByte) {
    b = new Uint8Array(bytes.length + 1);
    b.set(bytes, 1);
  }
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 6 || b[0] !== 0 || v.getUint16(1) !== 0) return null;
  const flags = b[5];
  if (flags & 0x04) return null; // the HDR rendition is the base image; not an iPhone layout
  const channels = flags & 0x80 ? 3 : 1;
  const common = flags & 0x08; // one denominator for every value
  if (b.length < 6 + (common ? 12 + channels * 20 : 16 + channels * 40)) return null;
  let p = 6;
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const s32 = () => { const x = v.getInt32(p); p += 4; return x; };
  const d0 = common ? u32() : 0;
  const frac = (n) => { const d = common ? d0 : u32(); return d ? n / d : NaN; };
  const baseHeadroom = frac(u32());
  const alternateHeadroom = frac(u32());
  const ch = [];
  for (let c = 0; c < channels; c++) {
    ch.push({ min: frac(s32()), max: frac(s32()), gamma: frac(u32()), baseOffset: frac(s32()), altOffset: frac(s32()) });
  }
  const values = [baseHeadroom, alternateHeadroom, ...ch.flatMap((x) => Object.values(x))];
  if (!values.every(Number.isFinite) || alternateHeadroom <= baseHeadroom || ch.some((x) => x.gamma <= 0)) return null;
  return { baseHeadroom, alternateHeadroom, channels: ch };
}

// The same metadata from Adobe's XMP form (hdrgm:, used by Android Ultra HDR and Lightroom):
// gains and headrooms already in stops. A value can be one number or a list of three; the first
// is used.
function parseHdrgmXmp(xmp) {
  if (!/hdrgm:Version/.test(xmp)) return null;
  const num = (name, fallback) => {
    const m = new RegExp(`hdrgm:${name}(?:\\s*=\\s*"([^"]*)"|>\\s*(?:<rdf:Seq>\\s*<rdf:li>)?\\s*([^<\\s]+))`).exec(xmp);
    const x = m ? parseFloat(m[1] ?? m[2]) : fallback;
    return Number.isFinite(x) ? x : fallback;
  };
  if (/hdrgm:BaseRenditionIsHDR(?:\s*=\s*"|>\s*)True/i.test(xmp)) return null;
  const max = num('GainMapMax', NaN);
  const meta = {
    baseHeadroom: num('HDRCapacityMin', 0),
    alternateHeadroom: num('HDRCapacityMax', max),
    channels: [{ min: num('GainMapMin', 0), max, gamma: num('Gamma', 1),
      baseOffset: num('OffsetSDR', 1 / 64), altOffset: num('OffsetHDR', 1 / 64) }],
  };
  const c = meta.channels[0];
  if (!Number.isFinite(max) || !(c.gamma > 0) || !(max > c.min)) return null;
  return meta;
}

// Apple's own form (iPhone JPEGs from before ISO 21496-1): only the HDR headroom, as a factor.
function parseAppleXmp(xmp) {
  if (!/HDRGainMap:HDRGainMapVersion/.test(xmp)) return null;
  const m = /HDRGainMap:HDRGainMapHeadroom(?:\s*=\s*"([^"]*)"|>\s*([^<\s]+))/.exec(xmp);
  const headroom = m ? parseFloat(m[1] ?? m[2]) : NaN;
  return headroom > 1 ? { appleHeadroom: headroom } : null;
}

// Finds a JPEG's HDR gain map: a second JPEG stored after the photo and listed in its MPF
// (Multi-Picture Format) index. Returns { jpeg, meta } with the gain map's own bytes, or null.
function findJpegGainMap(b) {
  const isSoi = (p) => b[p] === 0xFF && b[p + 1] === 0xD8;
  const text = (p, s) => [...s].every((c, i) => b[p + i] === c.charCodeAt(0));
  // Calls `fn(marker, start, end)` for each segment before the picture data; `start` is where
  // its contents begin. Stops early when `fn` returns true.
  const segments = (p, fn) => {
    p += 2;
    while (p + 4 <= b.length && b[p] === 0xFF) {
      const m = b[p + 1];
      if (m === 0xFF) { p += 1; continue; }
      if (m === 0xDA || m === 0xD9) return;
      const end = p + 2 + ((b[p + 2] << 8) | b[p + 3]);
      if (end > b.length || fn(m, p + 4, end)) return;
      p = end;
    }
  };
  if (!isSoi(0)) return null;

  // The MPF index: a small TIFF structure; offsets in it count from its own header.
  const starts = [];
  segments(0, (m, s, end) => {
    if (m !== 0xE2 || !text(s, 'MPF\0')) return false;
    const t = s + 4;
    const v = new DataView(b.buffer, b.byteOffset + t, end - t);
    const le = v.getUint16(0) === 0x4949;
    const ifd = v.getUint32(4, le);
    const count = v.getUint16(ifd, le);
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (v.getUint16(e, le) !== 0xB002) continue; // MP Entry: 16 bytes per image
      const n = v.getUint32(e + 4, le) / 16;
      const at = v.getUint32(e + 8, le);
      for (let k = 1; k < n; k++) {
        const offset = v.getUint32(at + k * 16 + 8, le);
        if (offset) starts.push(t + offset);
      }
    }
    return true;
  });

  for (const start of starts) {
    if (start >= b.length || !isSoi(start)) continue;
    let iso = null;
    let xmp = '';
    segments(start, (m, s, end) => {
      if (m === 0xE2 && text(s, 'urn:iso:std:iso:ts:21496:-1\0')) {
        iso = parseGainMapMetadata(b.subarray(s + 28, end), false);
      } else if (m === 0xE1 && text(s, 'http://ns.adobe.com/xap/1.0/\0')) {
        xmp = new TextDecoder().decode(b.subarray(s + 29, end));
      }
      return false;
    });
    const meta = iso || parseHdrgmXmp(xmp) || parseAppleXmp(xmp);
    if (meta) return { jpeg: b.subarray(start), meta };
  }
  return null;
}
