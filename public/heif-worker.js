/* Inspicio HEIC worker: decodes HEIC/HEIF photos for browsers that can't (Chrome, Firefox),
   using libheif (vendor/libheif-1.19.8.js, LGPL; see vendor/libheif-NOTICE.txt). Receives the
   file's bytes, returns the primary image as RGBA, upright (libheif applies the HEIF rotation
   and mirroring). Nothing here makes a network request. */
'use strict';

importScripts('vendor/libheif-1.19.8.js');

let lib = null;

self.onmessage = (e) => {
  const { id, buffer } = e.data;
  let images = null;
  try {
    lib ||= typeof self.libheif === 'function' ? self.libheif() : self.libheif;
    images = new lib.HeifDecoder().decode(new Uint8Array(buffer));
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
