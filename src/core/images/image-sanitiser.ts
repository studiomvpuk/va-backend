/**
 * Strips metadata from an uploaded image, and checks it is what it claims.
 *
 * PRD §7.2: "Uploaded images: type and size validated, stripped of EXIF."
 *
 * ── Why this matters more here than in most products ────────────────────────
 * The image is a screenshot of a job posting, taken by an assistant on their own
 * phone or laptop, and it is sent straight to a third-party model provider. A
 * phone screenshot's EXIF can carry GPS coordinates, the device serial, and the
 * owner's name. None of that is anything to do with the job posting, and the
 * assistant has no idea it is travelling.
 *
 * ── No image library ────────────────────────────────────────────────────────
 * Written against the container formats directly rather than pulling in sharp.
 * It is a native dependency with a build step, and the job here is not to decode
 * or re-encode anything — it is to drop the segments that carry metadata and
 * leave the pixels untouched. Doing it by hand also means the sanitiser cannot
 * silently re-compress an image and lose the small text the OCR has to read.
 */

export class UnsupportedImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedImageError';
  }
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

/** The first bytes each format must start with. */
const MAGIC: Record<ImageMediaType, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP',
};

/**
 * Verifies the declared type against the actual bytes, then strips metadata.
 *
 * The verification is not redundant with the DTO's `@IsIn`. That checks what the
 * caller SAID; this checks what they sent. A caller declaring `image/png` and
 * sending something else would otherwise have that something else forwarded to
 * a provider with a content type that invites it to be parsed as an image.
 */
export function sanitiseImage(input: Buffer, declared: ImageMediaType): Buffer {
  if (input.length < 12) throw new UnsupportedImageError('not an image: too short');

  if (!MAGIC[declared](input)) {
    throw new UnsupportedImageError(`image does not match its declared type (${declared})`);
  }

  switch (declared) {
    case 'image/jpeg':
      return stripJpeg(input);
    case 'image/png':
      return stripPng(input);
    case 'image/webp':
      return stripWebp(input);
  }
}

/**
 * JPEG: drop every APPn marker.
 *
 * EXIF lives in APP1, JFIF in APP0, XMP in APP1 too, Photoshop resources in
 * APP13. Dropping the whole APPn range (0xE0–0xEF) removes all of them and is
 * not a judgement call about which ones matter this year. It also drops COM
 * comment segments, which are a documented place to hide text.
 *
 * Everything else — quantisation tables, Huffman tables, the scan itself — is
 * copied through byte for byte, so the pixels are untouched.
 */
function stripJpeg(input: Buffer): Buffer {
  const out: Buffer[] = [input.subarray(0, 2)]; // SOI
  let i = 2;

  while (i < input.length - 1) {
    if (input[i] !== 0xff) {
      // Not at a marker boundary. Rather than guess, copy the rest verbatim —
      // a malformed file should come out unusable-but-unchanged, not silently
      // truncated into something a decoder will misread.
      out.push(input.subarray(i));
      break;
    }

    const marker = input[i + 1];

    // Start of scan: everything from here is entropy-coded data to the end.
    if (marker === 0xda) {
      out.push(input.subarray(i));
      break;
    }

    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(input.subarray(i, i + 2));
      i += 2;
      continue;
    }

    const length = input.readUInt16BE(i + 2);
    const isAppSegment = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;

    if (!isAppSegment && !isComment) out.push(input.subarray(i, i + 2 + length));
    i += 2 + length;
  }

  return Buffer.concat(out);
}

/**
 * PNG: keep only the chunks needed to render.
 *
 * An allowlist rather than a blocklist, because PNG's ancillary chunks are
 * open-ended: eXIf, tEXt, iTXt, zTXt, and any private chunk a camera vendor
 * invented. Keeping the critical chunks plus the handful that affect appearance
 * means a new metadata chunk type is dropped by default rather than needing this
 * list to be updated.
 */
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB', 'acTL', 'fcTL', 'fdAT']);

function stripPng(input: Buffer): Buffer {
  const out: Buffer[] = [input.subarray(0, 8)]; // signature
  let i = 8;

  while (i + 8 <= input.length) {
    const length = input.readUInt32BE(i);
    const type = input.subarray(i + 4, i + 8).toString('ascii');
    const end = i + 12 + length; // length + type + data + CRC

    if (end > input.length) break; // truncated file; stop rather than over-read
    if (PNG_KEEP.has(type)) out.push(input.subarray(i, end));

    i = end;
    if (type === 'IEND') break;
  }

  return Buffer.concat(out);
}

/**
 * WebP: drop the EXIF and XMP chunks, and fix up the RIFF length.
 *
 * The container's length field counts everything after it, so removing a chunk
 * without rewriting that field produces a file every decoder rejects.
 */
const WEBP_DROP = new Set(['EXIF', 'XMP ']);

function stripWebp(input: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12; // 'RIFF' + size + 'WEBP'

  while (i + 8 <= input.length) {
    const type = input.subarray(i, i + 4).toString('ascii');
    const size = input.readUInt32LE(i + 4);
    // Chunks are padded to an even length.
    const end = i + 8 + size + (size % 2);

    if (end > input.length) break;
    if (!WEBP_DROP.has(type)) chunks.push(input.subarray(i, end));

    i = end;
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4); // 'WEBP' + the chunks
  header.write('WEBP', 8, 'ascii');

  return Buffer.concat([header, body]);
}

/** The whole operation, for a base64 payload as it arrives from the API. */
export function sanitiseBase64Image(base64: string, declared: ImageMediaType): string {
  const input = Buffer.from(base64, 'base64');
  return sanitiseImage(input, declared).toString('base64');
}
