import { deflateSync } from 'node:zlib';
import {
  sanitiseBase64Image,
  sanitiseImage,
  UnsupportedImageError,
} from './image-sanitiser';

/**
 * Real container bytes, built by hand.
 *
 * Fixture image files would make this test about whether a checked-in binary
 * still has EXIF in it. Constructing the containers here means every assertion
 * names the exact segment it is about.
 */

// ── JPEG ────────────────────────────────────────────────────────────────────
function jpegSegment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

function jpegWith(segments: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    ...segments,
    Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0x00]), // SOS
    Buffer.from([0xaa, 0xbb, 0xcc]), // "pixels"
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

const EXIF_GPS = jpegSegment(
  0xe1,
  Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('GPS 53.4808 -2.2426')]),
);
const JFIF = jpegSegment(0xe0, Buffer.from('JFIF\0', 'latin1'));
const COMMENT = jpegSegment(0xfe, Buffer.from('taken by Joy on iPhone 15'));
const QUANT_TABLE = jpegSegment(0xdb, Buffer.alloc(65, 7));

// ── PNG ─────────────────────────────────────────────────────────────────────
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(0, 8 + data.length); // CRC not checked by the stripper
  return out;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngWith(extra: Buffer[]): Buffer {
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', Buffer.alloc(13)),
    ...extra,
    pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── WebP ────────────────────────────────────────────────────────────────────
function webpChunk(type: string, data: Buffer): Buffer {
  const padded = data.length % 2 === 1 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, padded]);
}

function webpWith(chunks: Buffer[]): Buffer {
  const body = Buffer.concat([webpChunk('VP8 ', Buffer.from([1, 2, 3, 4])), ...chunks]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'ascii');
  return Buffer.concat([header, body]);
}

describe('sanitiseImage', () => {
  describe('JPEG', () => {
    it('removes EXIF, including the GPS coordinates in it', () => {
      const input = jpegWith([EXIF_GPS, QUANT_TABLE]);
      expect(input.toString('latin1')).toContain('53.4808');

      const out = sanitiseImage(input, 'image/jpeg');
      expect(out.toString('latin1')).not.toContain('53.4808');
      expect(out.toString('latin1')).not.toContain('Exif');
    });

    it('removes every APPn segment, not just APP1', () => {
      // A blocklist of "the ones that matter" goes stale; the range does not.
      const out = sanitiseImage(jpegWith([JFIF, EXIF_GPS, QUANT_TABLE]), 'image/jpeg');
      expect(out.toString('latin1')).not.toContain('JFIF');
    });

    it('removes comment segments, a documented place to hide text', () => {
      const out = sanitiseImage(jpegWith([COMMENT, QUANT_TABLE]), 'image/jpeg');
      expect(out.toString('latin1')).not.toContain('iPhone');
    });

    it('keeps the tables and the scan, so the image still decodes', () => {
      const out = sanitiseImage(jpegWith([EXIF_GPS, QUANT_TABLE]), 'image/jpeg');

      // Quantisation table survives…
      expect(out.includes(Buffer.from([0xff, 0xdb]))).toBe(true);
      // …as do the start of scan, the entropy data and the end marker.
      expect(out.includes(Buffer.from([0xff, 0xda]))).toBe(true);
      expect(out.includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(true);
      expect(out.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    });

    it('does not re-encode — the scan data is byte-identical', () => {
      // Re-compressing would lose the small text the OCR has to read.
      const input = jpegWith([EXIF_GPS, QUANT_TABLE]);
      const out = sanitiseImage(input, 'image/jpeg');
      expect(out.includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(true);
    });
  });

  describe('PNG', () => {
    it('removes eXIf, tEXt, iTXt and zTXt', () => {
      const input = pngWith([
        pngChunk('eXIf', Buffer.from('GPS 53.4808')),
        pngChunk('tEXt', Buffer.from('Author\0Joy Emoredo')),
        pngChunk('iTXt', Buffer.from('Comment\0\0\0\0\0device serial ABC123')),
      ]);

      const out = sanitiseImage(input, 'image/png').toString('latin1');
      expect(out).not.toContain('53.4808');
      expect(out).not.toContain('Joy Emoredo');
      expect(out).not.toContain('ABC123');
    });

    it('drops an unknown chunk type by default', () => {
      // An allowlist, so a vendor's private chunk needs no code change here.
      const out = sanitiseImage(
        pngWith([pngChunk('xxXx', Buffer.from('vendor metadata'))]),
        'image/png',
      );
      expect(out.toString('latin1')).not.toContain('vendor metadata');
    });

    it('keeps the chunks needed to render', () => {
      const out = sanitiseImage(pngWith([pngChunk('tEXt', Buffer.from('x'))]), 'image/png');
      const text = out.toString('latin1');
      for (const chunk of ['IHDR', 'IDAT', 'IEND']) expect(text).toContain(chunk);
      expect(out.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });

    it('keeps transparency and colour-space chunks', () => {
      // Dropping these does not leak anything; it changes how the image looks.
      const out = sanitiseImage(
        pngWith([pngChunk('tRNS', Buffer.alloc(2)), pngChunk('sRGB', Buffer.alloc(1))]),
        'image/png',
      ).toString('latin1');
      expect(out).toContain('tRNS');
      expect(out).toContain('sRGB');
    });

    it('stops at a truncated chunk rather than over-reading', () => {
      const truncated = pngWith([]).subarray(0, 30);
      expect(() => sanitiseImage(truncated, 'image/png')).not.toThrow();
    });
  });

  describe('WebP', () => {
    it('removes EXIF and XMP', () => {
      const input = webpWith([
        webpChunk('EXIF', Buffer.from('GPS 53.4808')),
        webpChunk('XMP ', Buffer.from('<x:xmpmeta>Joy</x:xmpmeta>')),
      ]);

      const out = sanitiseImage(input, 'image/webp').toString('latin1');
      expect(out).not.toContain('53.4808');
      expect(out).not.toContain('xmpmeta');
      expect(out).toContain('VP8 ');
    });

    it('rewrites the RIFF length, or no decoder will open it', () => {
      const out = sanitiseImage(
        webpWith([webpChunk('EXIF', Buffer.from('metadata here'))]),
        'image/webp',
      );
      expect(out.readUInt32LE(4)).toBe(out.length - 8);
    });
  });

  describe('type verification', () => {
    it('rejects bytes that do not match the declared type', () => {
      // The DTO checks what the caller SAID. This checks what they sent.
      const png = pngWith([]);
      expect(() => sanitiseImage(png, 'image/jpeg')).toThrow(UnsupportedImageError);
    });

    it.each(['image/png', 'image/jpeg', 'image/webp'] as const)(
      'rejects something that is not an image at all, declared as %s',
      (declared) => {
        const notAnImage = Buffer.from('<?php system($_GET["c"]); ?>');
        expect(() => sanitiseImage(notAnImage, declared)).toThrow(UnsupportedImageError);
      },
    );

    it('rejects an empty payload', () => {
      expect(() => sanitiseImage(Buffer.alloc(0), 'image/png')).toThrow(/too short/);
    });
  });

  it('round-trips base64, which is how it arrives', () => {
    const input = jpegWith([EXIF_GPS, QUANT_TABLE]).toString('base64');
    const out = sanitiseBase64Image(input, 'image/jpeg');
    expect(Buffer.from(out, 'base64').toString('latin1')).not.toContain('53.4808');
  });
});
