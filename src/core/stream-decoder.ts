/**
 * Stream Decoder with Compression Forensics
 *
 * Decodes PDF streams and extracts compression metadata
 * for forensic analysis.
 */

import type { PdfStream, CompressionAnalysis } from '../types/pdf.js';

// Bun has built-in zlib via Bun.inflateSync/deflateSync
// but we need more control for forensics, so we'll implement manually

const COMPRESSION_LEVELS = ['fastest', 'fast', 'default', 'best'] as const;

export interface DecodedStream {
  data: Uint8Array;
  compressionAnalysis?: CompressionAnalysis;
}

export class StreamDecoder {
  /**
   * Decode a PDF stream, returning both data and compression forensics
   */
  static decode(stream: PdfStream): DecodedStream {
    const filters = stream.filters;

    if (filters.length === 0) {
      return { data: stream.rawStreamData };
    }

    let data = stream.rawStreamData;
    let compressionAnalysis: CompressionAnalysis | undefined;

    for (const filter of filters) {
      switch (filter) {
        case 'FlateDecode':
          const result = this.decodeFlateDecode(data);
          data = result.data;
          compressionAnalysis = result.analysis;
          break;

        case 'ASCII85Decode':
          data = this.decodeASCII85(data);
          break;

        case 'ASCIIHexDecode':
          data = this.decodeASCIIHex(data);
          break;

        case 'LZWDecode':
          data = this.decodeLZW(data);
          break;

        case 'RunLengthDecode':
          data = this.decodeRunLength(data);
          break;

        default:
          throw new Error(`Unsupported filter: ${filter}`);
      }
    }

    return { data, compressionAnalysis };
  }

  /**
   * Decode FlateDecode (zlib) with forensic analysis
   */
  private static decodeFlateDecode(data: Uint8Array): { data: Uint8Array; analysis: CompressionAnalysis } {
    // Parse zlib header for forensics
    if (data.length < 2) {
      throw new Error('FlateDecode stream too short');
    }

    const cmf = data[0]!;
    const flg = data[1]!;

    // CMF byte
    const compressionMethod = cmf & 0x0f;       // should be 8 (deflate)
    const compressionInfo = (cmf >> 4) & 0x0f;  // log2(window size) - 8

    // FLG byte
    const fcheck = flg & 0x1f;
    const fdict = ((flg >> 5) & 0x01) === 1;
    const flevel = (flg >> 6) & 0x03;

    // Validate header checksum
    if ((cmf * 256 + flg) % 31 !== 0) {
      throw new Error('Invalid zlib header checksum');
    }

    if (compressionMethod !== 8) {
      throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }

    const windowSize = Math.pow(2, compressionInfo + 8);

    // Extract Adler-32 checksum from end of stream
    const adler32 =
      (data[data.length - 4]! << 24) |
      (data[data.length - 3]! << 16) |
      (data[data.length - 2]! << 8) |
      data[data.length - 1]!;

    // Decompress using Bun's built-in gunzip (which handles zlib)
    // The data is zlib-wrapped, so we use Bun.inflateSync
    let decompressed: Uint8Array;
    try {
      // Bun.inflateSync expects raw deflate, but our data is zlib-wrapped
      // We need to strip the 2-byte header and 4-byte trailer
      const deflateData = data.slice(2, data.length - 4);
      decompressed = this.inflateRaw(deflateData);
    } catch (e) {
      // Fallback: try Bun.gunzipSync which handles zlib
      try {
        decompressed = Bun.gunzipSync(data);
      } catch (e2) {
        throw new Error(`FlateDecode decompression failed: ${e}`);
      }
    }

    const analysis: CompressionAnalysis = {
      filter: 'FlateDecode',
      zlibHeader: {
        cmf,
        flg,
        compressionMethod,
        compressionInfo,
        compressionLevel: COMPRESSION_LEVELS[flevel]!,
        windowSize,
        fcheck,
        fdict,
      },
      compressedSize: data.length,
      decompressedSize: decompressed.length,
      compressionRatio: data.length / decompressed.length,
      adler32,
    };

    return { data: decompressed, analysis };
  }

  /**
   * Raw deflate decompression using Bun
   */
  private static inflateRaw(data: Uint8Array): Uint8Array {
    // Bun.inflateSync handles zlib-wrapped data
    // For raw deflate, we need to add zlib wrapper
    const zlibWrapped = new Uint8Array(data.length + 6);
    zlibWrapped[0] = 0x78; // CMF: deflate, 32K window
    zlibWrapped[1] = 0x9c; // FLG: default compression, no dict
    zlibWrapped.set(data, 2);

    // We need to add Adler-32 at the end - compute it
    // For now, try decompression without checksum validation
    try {
      return Bun.inflateSync(data);
    } catch {
      // Try with wrapper
      return Bun.gunzipSync(zlibWrapped);
    }
  }

  /**
   * Test if recompression produces identical output
   * This is a key forensic check
   */
  static testRecompression(original: Uint8Array, decompressed: Uint8Array): {
    matches: boolean;
    originalSize: number;
    recompressedSize: number;
    firstDiffByte: number | null;
  } {
    // Recompress with default settings
    const recompressed = Bun.deflateSync(decompressed);

    // Add zlib wrapper
    const zlibRecompressed = new Uint8Array(recompressed.length + 6);
    zlibRecompressed[0] = 0x78;
    zlibRecompressed[1] = 0x9c;
    zlibRecompressed.set(recompressed, 2);

    // Compute and add Adler-32
    const adler = this.computeAdler32(decompressed);
    zlibRecompressed[zlibRecompressed.length - 4] = (adler >> 24) & 0xff;
    zlibRecompressed[zlibRecompressed.length - 3] = (adler >> 16) & 0xff;
    zlibRecompressed[zlibRecompressed.length - 2] = (adler >> 8) & 0xff;
    zlibRecompressed[zlibRecompressed.length - 1] = adler & 0xff;

    // Compare
    const matches = this.arraysEqual(original, zlibRecompressed);
    let firstDiffByte: number | null = null;

    if (!matches) {
      for (let i = 0; i < Math.min(original.length, zlibRecompressed.length); i++) {
        if (original[i] !== zlibRecompressed[i]) {
          firstDiffByte = i;
          break;
        }
      }
      if (firstDiffByte === null && original.length !== zlibRecompressed.length) {
        firstDiffByte = Math.min(original.length, zlibRecompressed.length);
      }
    }

    return {
      matches,
      originalSize: original.length,
      recompressedSize: zlibRecompressed.length,
      firstDiffByte,
    };
  }

  /**
   * Compute Adler-32 checksum
   */
  private static computeAdler32(data: Uint8Array): number {
    const MOD_ADLER = 65521;
    let a = 1;
    let b = 0;

    for (let i = 0; i < data.length; i++) {
      a = (a + data[i]!) % MOD_ADLER;
      b = (b + a) % MOD_ADLER;
    }

    return (b << 16) | a;
  }

  /**
   * Decode ASCII85
   */
  private static decodeASCII85(data: Uint8Array): Uint8Array {
    const str = new TextDecoder().decode(data);
    const result: number[] = [];

    let i = 0;
    // Skip ~> at start if present
    if (str.startsWith('<~')) i = 2;

    while (i < str.length) {
      // Check for end marker
      if (str.slice(i, i + 2) === '~>') break;

      // Skip whitespace
      const char = str[i]!;
      if (/\s/.test(char)) {
        i++;
        continue;
      }

      // Handle 'z' special case (4 zero bytes)
      if (char === 'z') {
        result.push(0, 0, 0, 0);
        i++;
        continue;
      }

      // Decode 5 ASCII85 characters to 4 bytes
      const group: number[] = [];
      while (group.length < 5 && i < str.length) {
        const c = str[i]!;
        if (c === '~') break;
        if (!/\s/.test(c)) {
          group.push(c.charCodeAt(0) - 33);
        }
        i++;
      }

      // Pad if necessary
      const originalLength = group.length;
      while (group.length < 5) {
        group.push(84); // 'u' - 33
      }

      // Decode
      let value = 0;
      for (const n of group) {
        value = value * 85 + n;
      }

      // Extract bytes (only as many as we should have)
      const bytes = [
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
      ];

      for (let j = 0; j < originalLength - 1; j++) {
        result.push(bytes[j]!);
      }
    }

    return new Uint8Array(result);
  }

  /**
   * Decode ASCIIHex
   */
  private static decodeASCIIHex(data: Uint8Array): Uint8Array {
    const str = new TextDecoder().decode(data).replace(/\s/g, '');
    const result: number[] = [];

    for (let i = 0; i < str.length; i += 2) {
      if (str[i] === '>') break;
      let hex = str[i]!;
      if (i + 1 < str.length && str[i + 1] !== '>') {
        hex += str[i + 1];
      } else {
        hex += '0';
      }
      result.push(parseInt(hex, 16));
    }

    return new Uint8Array(result);
  }

  /**
   * Decode LZW (basic implementation)
   */
  private static decodeLZW(data: Uint8Array): Uint8Array {
    // LZW decoding is complex - basic implementation
    throw new Error('LZWDecode not yet implemented');
  }

  /**
   * Decode RunLength
   */
  private static decodeRunLength(data: Uint8Array): Uint8Array {
    const result: number[] = [];
    let i = 0;

    while (i < data.length) {
      const length = data[i]!;
      i++;

      if (length === 128) break; // EOD
      if (length < 128) {
        // Copy next length+1 bytes literally
        for (let j = 0; j <= length && i < data.length; j++) {
          result.push(data[i]!);
          i++;
        }
      } else {
        // Repeat next byte 257-length times
        const repeatCount = 257 - length;
        const byte = data[i]!;
        i++;
        for (let j = 0; j < repeatCount; j++) {
          result.push(byte);
        }
      }
    }

    return new Uint8Array(result);
  }

  /**
   * Compare two arrays for equality
   */
  private static arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
