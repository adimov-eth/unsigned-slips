/**
 * CMap Parser
 *
 * Parses ToUnicode CMaps to extract glyph-to-Unicode mappings.
 * This is critical for understanding how text is encoded in the PDF.
 */

import type { ToUnicodeCMap, CMapEntry } from '../types/pdf.js';

export class CMapParser {
  /**
   * Parse a ToUnicode CMap from decompressed stream data
   */
  static parse(data: Uint8Array): ToUnicodeCMap {
    const text = new TextDecoder('latin1').decode(data);

    // Extract registry info
    const registry = this.extractString(text, '/Registry', '(', ')') ?? 'Unknown';
    const ordering = this.extractString(text, '/Ordering', '(', ')') ?? 'Unknown';
    const supplementMatch = text.match(/\/Supplement\s+(\d+)/);
    const supplement = supplementMatch ? parseInt(supplementMatch[1]!, 10) : 0;

    // Extract codespace range
    const codespaceMatch = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/);
    const codespaceRange: [number, number] = codespaceMatch
      ? [parseInt(codespaceMatch[1]!, 16), parseInt(codespaceMatch[2]!, 16)]
      : [0, 0xFFFF];

    // Extract all mappings
    const entries: CMapEntry[] = [];

    // Parse bfchar entries (single character mappings)
    // Format: <glyph> <unicode>
    const bfcharBlocks = text.matchAll(/(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g);
    for (const block of bfcharBlocks) {
      const content = block[2]!;
      const mappings = content.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
      for (const mapping of mappings) {
        const glyphId = parseInt(mapping[1]!, 16);
        const unicodeValue = parseInt(mapping[2]!, 16);
        entries.push({
          glyphId,
          unicodeValue,
          unicodeChar: String.fromCodePoint(unicodeValue),
        });
      }
    }

    // Parse bfrange entries (range mappings)
    // Format: <startGlyph> <endGlyph> <startUnicode>
    // Or: <startGlyph> <endGlyph> [<unicode1> <unicode2> ...]
    const bfrangeBlocks = text.matchAll(/(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g);
    for (const block of bfrangeBlocks) {
      const content = block[2]!;

      // Single value ranges: <start> <end> <unicode>
      const singleRanges = content.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g);
      for (const range of singleRanges) {
        const startGlyph = parseInt(range[1]!, 16);
        const endGlyph = parseInt(range[2]!, 16);
        const startUnicode = parseInt(range[3]!, 16);

        for (let i = 0; i <= endGlyph - startGlyph; i++) {
          const glyphId = startGlyph + i;
          const unicodeValue = startUnicode + i;
          entries.push({
            glyphId,
            unicodeValue,
            unicodeChar: String.fromCodePoint(unicodeValue),
          });
        }
      }

      // Array ranges: <start> <end> [<u1> <u2> ...]
      const arrayRanges = content.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g);
      for (const range of arrayRanges) {
        const startGlyph = parseInt(range[1]!, 16);
        const endGlyph = parseInt(range[2]!, 16);
        const arrayContent = range[3]!;

        const unicodes = arrayContent.matchAll(/<([0-9A-Fa-f]+)>/g);
        let offset = 0;
        for (const unicode of unicodes) {
          if (startGlyph + offset > endGlyph) break;
          const glyphId = startGlyph + offset;
          const unicodeValue = parseInt(unicode[1]!, 16);
          entries.push({
            glyphId,
            unicodeValue,
            unicodeChar: String.fromCodePoint(unicodeValue),
          });
          offset++;
        }
      }
    }

    // Sort entries by glyph ID for consistent output
    entries.sort((a, b) => a.glyphId - b.glyphId);

    return {
      registry,
      ordering,
      supplement,
      codespaceRange,
      entries,
    };
  }

  /**
   * Extract a parenthesized string value
   */
  private static extractString(text: string, prefix: string, startDelim: string, endDelim: string): string | null {
    const prefixIndex = text.indexOf(prefix);
    if (prefixIndex === -1) return null;

    const startIndex = text.indexOf(startDelim, prefixIndex);
    if (startIndex === -1) return null;

    const endIndex = text.indexOf(endDelim, startIndex + 1);
    if (endIndex === -1) return null;

    return text.slice(startIndex + 1, endIndex);
  }

  /**
   * Decode text using a CMap
   * Input: raw bytes from a Tj/TJ string (2-byte big-endian glyph IDs for Identity-H)
   * Output: decoded Unicode string
   */
  static decodeText(rawBytes: Uint8Array, cmap: ToUnicodeCMap, encoding: string = 'Identity-H'): string {
    const glyphToUnicode = new Map<number, string>();
    for (const entry of cmap.entries) {
      glyphToUnicode.set(entry.glyphId, entry.unicodeChar);
    }

    let result = '';

    if (encoding === 'Identity-H' || encoding === 'Identity-V') {
      // 2-byte big-endian glyph IDs
      for (let i = 0; i < rawBytes.length; i += 2) {
        if (i + 1 >= rawBytes.length) break;
        const glyphId = (rawBytes[i]! << 8) | rawBytes[i + 1]!;
        const char = glyphToUnicode.get(glyphId);
        if (char) {
          result += char;
        } else {
          result += `[${glyphId.toString(16).padStart(4, '0')}]`;
        }
      }
    } else {
      // Single-byte encoding
      for (let i = 0; i < rawBytes.length; i++) {
        const glyphId = rawBytes[i]!;
        const char = glyphToUnicode.get(glyphId);
        if (char) {
          result += char;
        } else {
          result += `[${glyphId.toString(16).padStart(2, '0')}]`;
        }
      }
    }

    return result;
  }

  /**
   * Analyze CMap for forensic signals
   */
  static analyze(cmap: ToUnicodeCMap): CMapAnalysis {
    const entries = cmap.entries;

    // Glyph ID statistics
    const glyphIds = entries.map(e => e.glyphId);
    const minGlyphId = Math.min(...glyphIds);
    const maxGlyphId = Math.max(...glyphIds);
    const glyphIdRange = maxGlyphId - minGlyphId;

    // Unicode coverage
    const unicodeValues = entries.map(e => e.unicodeValue);
    const hasDigits = unicodeValues.some(u => u >= 0x30 && u <= 0x39);
    const hasCyrillic = unicodeValues.some(u => u >= 0x0400 && u <= 0x04FF);
    const hasLatin = unicodeValues.some(u => (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A));
    const hasRubleSign = unicodeValues.includes(0x20BD);

    // Digit coverage (which digits 0-9 are present)
    const digitCoverage: boolean[] = [];
    for (let d = 0; d <= 9; d++) {
      digitCoverage.push(unicodeValues.includes(0x30 + d));
    }

    // Check for gaps in glyph ID sequence (potential sign of modification)
    const sortedGlyphIds = [...glyphIds].sort((a, b) => a - b);
    const gaps: Array<{ after: number; before: number; size: number }> = [];
    for (let i = 1; i < sortedGlyphIds.length; i++) {
      const gap = sortedGlyphIds[i]! - sortedGlyphIds[i - 1]! - 1;
      if (gap > 0) {
        gaps.push({
          after: sortedGlyphIds[i - 1]!,
          before: sortedGlyphIds[i]!,
          size: gap,
        });
      }
    }

    // Check for out-of-range entries (potential injection)
    // Range is determined dynamically from the font's actual glyph coverage
    // Entries significantly outside the main cluster may indicate injection
    const sortedIds = [...glyphIds].sort((a, b) => a - b);
    const q1Index = Math.floor(sortedIds.length * 0.25);
    const q3Index = Math.floor(sortedIds.length * 0.75);
    const q1 = sortedIds[q1Index] ?? minGlyphId;
    const q3 = sortedIds[q3Index] ?? maxGlyphId;
    const iqr = q3 - q1;
    // Entries more than 1.5 * IQR beyond quartiles are potential outliers
    const lowerBound = Math.max(0, q1 - 1.5 * iqr);
    const upperBound = q3 + 1.5 * iqr;
    const outOfRangeEntries = entries.filter(
      e => e.glyphId < lowerBound || e.glyphId > upperBound
    );

    return {
      totalEntries: entries.length,
      glyphIdRange: { min: minGlyphId, max: maxGlyphId, span: glyphIdRange },
      characterCoverage: {
        hasDigits,
        hasCyrillic,
        hasLatin,
        hasRubleSign,
        digitCoverage,
      },
      gaps,
      outOfRangeEntries: outOfRangeEntries.length,
      registry: cmap.registry,
      ordering: cmap.ordering,
    };
  }
}

export interface CMapAnalysis {
  totalEntries: number;
  glyphIdRange: {
    min: number;
    max: number;
    span: number;
  };
  characterCoverage: {
    hasDigits: boolean;
    hasCyrillic: boolean;
    hasLatin: boolean;
    hasRubleSign: boolean;
    digitCoverage: boolean[]; // [has0, has1, ..., has9]
  };
  gaps: Array<{ after: number; before: number; size: number }>;
  outOfRangeEntries: number;
  registry: string;
  ordering: string;
}
