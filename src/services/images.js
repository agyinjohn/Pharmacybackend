const { bad } = require('../utils/http');

// Photos arrive as data URLs (the browser resizes them first). JPEG, PNG or WebP, at most 1.5 MB.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const parseImage = (dataUrl) => {
  const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m || !IMAGE_TYPES.includes(m[1])) throw bad('Upload a JPEG, PNG or WebP image');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > 1.5 * 1024 * 1024) throw bad('Image is too large (max 1.5 MB)');
  // Check the file really is the type it claims (magic bytes), not just the label.
  const sig = data.subarray(0, 12);
  const real = sig[0] === 0xff && sig[1] === 0xd8 ? 'image/jpeg' : sig.subarray(1, 4).toString() === 'PNG' ? 'image/png' : sig.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (real !== m[1]) throw bad('That file is not a valid image');
  return { contentType: real, data };
};

// Serves a stored image publicly. Ids are unguessable; versioned or single-use URLs can be cached for a year.
const sendImage = (res, img) => {
  res.set({ 'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
  res.end(img.data);
};

module.exports = { parseImage, sendImage };
