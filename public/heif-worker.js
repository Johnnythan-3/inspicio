/* Inspicio HEIC worker: decodes HEIC/HEIF photos for browsers that can't (Chrome, Firefox),
   using libheif (vendor/libheif-1.19.8.js, LGPL; see vendor/libheif-NOTICE.txt). Receives the
   file's bytes, returns the primary image as RGBA, upright (libheif applies the HEIF rotation
   and mirroring). For the Film tool it also reads an iPhone photo's HDR gain map, in every
   browser. Nothing here makes a network request. */
'use strict';

importScripts('vendor/libheif-1.19.8.js');

let lib = null;
const heifLib = () => (lib ||= typeof self.libheif === 'function' ? self.libheif() : self.libheif);

// libheif's C API, called directly (the JS wrapper only decodes the primary image). Functions that
// return a struct heif_error take a pointer to it as their first argument; pointers and size_t
// are 32-bit. Enum values are from libheif's headers.
const COLORSPACE_MONOCHROME = 2;
const CHROMA_MONOCHROME = 0;
const CHANNEL_Y = 0;
const APPLE_GAIN_MAP = 'urn:com:apple:photo:2020:aux:hdrgainmap';
const TMAP = 0x746d6170; // 'tmap'

// ISO 21496-1 gain map metadata, as stored in a 'tmap' item: the base and alternate (HDR)
// headrooms in stops, and per channel the gain range in stops, its gamma and two small offsets.
// Returns null for anything this can't use.
function parseGainMapMetadata(b) {
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

// An iPhone photo's HDR gain map (iOS 18 on): Apple's gain map image, an auxiliary image of the
// primary, with its ISO 21496-1 metadata in the 'tmap' item. Returns null when there is none.
// libheif rotates the gain map like the photo, so it comes out upright.
function readGainMap(bytes) {
  const L = heifLib();
  const view = () => new DataView(L.HEAPU8.buffer);
  const alloc = (n) => { const ptr = L._malloc(n); L.HEAPU8.fill(0, ptr, ptr + n); return ptr; };
  const ptrs = [];
  const temp = (n) => { const ptr = alloc(n); ptrs.push(ptr); return ptr; };
  const err = temp(16);
  const ok = () => view().getInt32(err, true) === 0;
  const u32 = (ptr) => view().getUint32(ptr, true);
  const cstr = (ptr) => { let s = ''; for (let i = ptr; L.HEAPU8[i]; i++) s += String.fromCharCode(L.HEAPU8[i]); return s; };

  const data = temp(bytes.length);
  L.HEAPU8.set(bytes, data);
  const ctx = L._heif_context_alloc();
  const handles = [];
  let image = 0;
  try {
    L._heif_context_read_from_memory(err, ctx, data, bytes.length, 0);
    if (!ok()) return null;

    // The metadata, from the 'tmap' item.
    let meta = null;
    const count = L._heif_context_get_number_of_items(ctx);
    const ids = temp(Math.max(1, count) * 4);
    L._heif_context_get_list_of_item_IDs(ctx, ids, count);
    for (let i = 0; i < count && !meta; i++) {
      const item = u32(ids + i * 4);
      if (L._heif_item_get_item_type(ctx, item) >>> 0 !== TMAP) continue;
      const compression = temp(4);
      const dataPtr = temp(4);
      const size = temp(4);
      L._heif_item_get_item_data(err, ctx, item, compression, dataPtr, size);
      if (!ok() || u32(compression) > 1) continue; // 0 undefined, 1 none
      const at = u32(dataPtr);
      meta = parseGainMapMetadata(L.HEAPU8.slice(at, at + u32(size)));
      L._heif_release_item_data(ctx, dataPtr);
    }
    if (!meta) return null;

    // The gain map image: the primary image's auxiliary image of Apple's gain map type.
    const handleOut = temp(4);
    L._heif_context_get_primary_image_handle(err, ctx, handleOut);
    if (!ok()) return null;
    const primary = u32(handleOut);
    handles.push(primary);
    const auxCount = L._heif_image_handle_get_number_of_auxiliary_images(primary, 0);
    const auxIds = temp(Math.max(1, auxCount) * 4);
    L._heif_image_handle_get_list_of_auxiliary_image_IDs(primary, 0, auxIds, auxCount);
    let gainHandle = 0;
    for (let i = 0; i < auxCount && !gainHandle; i++) {
      L._heif_image_handle_get_auxiliary_image_handle(err, primary, u32(auxIds + i * 4), handleOut);
      if (!ok()) continue;
      const aux = u32(handleOut);
      handles.push(aux);
      const typeOut = temp(4);
      L._heif_image_handle_get_auxiliary_type(err, aux, typeOut);
      if (!ok()) continue;
      if (cstr(u32(typeOut)) === APPLE_GAIN_MAP) gainHandle = aux;
      L._heif_image_handle_release_auxiliary_type(aux, typeOut);
    }
    if (!gainHandle) return null;

    const imageOut = temp(4);
    L._heif_decode_image(err, gainHandle, imageOut, COLORSPACE_MONOCHROME, CHROMA_MONOCHROME, 0);
    if (!ok()) return null;
    image = u32(imageOut);
    const width = L._heif_image_get_width(image, CHANNEL_Y);
    const height = L._heif_image_get_height(image, CHANNEL_Y);
    const bits = L._heif_image_get_bits_per_pixel_range(image, CHANNEL_Y);
    const strideOut = temp(4);
    const plane = L._heif_image_get_plane_readonly(image, CHANNEL_Y, strideOut);
    const stride = u32(strideOut);
    if (!plane || width <= 0 || height <= 0) return null;
    // The gain map's values from 0 to 1, as bytes.
    const gain = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      if (bits <= 8) {
        gain.set(L.HEAPU8.subarray(plane + y * stride, plane + y * stride + width), y * width);
      } else {
        const row = view();
        for (let x = 0; x < width; x++) gain[y * width + x] = row.getUint16(plane + y * stride + x * 2, true) >> (bits - 8);
      }
    }
    return { gain, width, height, meta };
  } finally {
    if (image) L._heif_image_release(image);
    for (const h of handles) L._heif_image_handle_release(h);
    L._heif_context_free(ctx);
    for (const ptr of ptrs) L._free(ptr);
  }
}

self.onmessage = (e) => {
  const { id, buffer, kind } = e.data;
  if (kind === 'gainmap') {
    try {
      const map = readGainMap(new Uint8Array(buffer));
      if (!map) self.postMessage({ id, none: true });
      else self.postMessage({ id, ...map }, [map.gain.buffer]);
    } catch (err) {
      self.postMessage({ id, error: String((err && err.message) || err) });
    }
    return;
  }
  let images = null;
  try {
    images = new (heifLib().HeifDecoder)().decode(new Uint8Array(buffer));
    if (!images || !images.length) throw new Error('There is no image in this HEIC file.');
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    const rgba = new Uint8ClampedArray(width * height * 4);
    image.display({ data: rgba, width, height }, (done) => {
      for (const im of images) im.free?.();
      if (!done) self.postMessage({ id, error: 'This HEIC photo couldn’t be decoded.' });
      else self.postMessage({ id, rgba, width, height }, [rgba.buffer]);
    });
  } catch (err) {
    for (const im of images || []) im.free?.();
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
