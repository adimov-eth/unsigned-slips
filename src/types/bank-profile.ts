/**
 * Bank Profile Types
 *
 * Defines the BankProfile interface for parameterized detection rules
 * and extension hooks for bank-specific custom checks.
 */

import type { PdfArtifacts } from '../artifacts/generator.js';
import type { DetectionResult, Severity } from './detection.js';

/**
 * Bank-specific custom check function
 *
 * Receives artifacts and profile, returns detection result.
 * Use this for checks that can't be parameterized (e.g., QR code validation,
 * specific encoding patterns, etc.)
 */
export type CustomCheck = {
  id: string;
  name: string;
  severity: Severity;
  description?: string;
  check: (artifacts: PdfArtifacts, profile: BankProfile) => DetectionResult;
};

/**
 * Bank-specific artifact extractor
 *
 * Use this to extract additional data from PDFs that common extraction
 * doesn't cover (e.g., QR code content, specific image analysis, etc.)
 */
export type CustomExtractor = {
  id: string;
  description?: string;
  extract: (rawPdf: Buffer, artifacts: PdfArtifacts) => Record<string, unknown>;
};

/**
 * Generator signature for bank identification
 */
export interface GeneratorSignature {
  /** Hex bytes after %PDF-X.X\n% (4 bytes) */
  binaryMarker: string;
  /** PDF version (e.g., "1.5") */
  pdfVersion: string;
  /** Producer string pattern (exact match or regex) */
  producer: string | RegExp;
  /** Creator string pattern (exact match or regex) */
  creator?: string | RegExp;
}

/**
 * Structural invariants that must match exactly
 */
export interface StructuralInvariants {
  /** XRef table format */
  xrefFormat: 'table' | 'stream';
  /** Zlib header bytes (e.g., "78:9c") */
  zlibHeader: string;
  /** Expected font type distribution */
  fontDistribution: Record<string, number>;
  /** Expected total font count */
  fontCount: number;
}

/**
 * Encoding profile for glyph-based forgery detection
 */
export interface EncodingProfile {
  /** Characters that should be rendered as glyph IDs (not direct Unicode) */
  glyphEncodedPunctuation?: string[];
  /** Minimum expected glyph escapes in decoded text */
  minGlyphEscapes: number;
  /** Regex pattern for glyph escapes (e.g., /\[0[0-9a-f]+\]/gi) */
  escapePattern: RegExp;
}

/**
 * Acceptable ranges for variable attributes
 */
export interface ProfileRanges {
  /** Object count range [min, max] */
  objectCount: [number, number];
  /** Stream count range [min, max] */
  streamCount: [number, number];
  /** CMap entries range [min, max] */
  cmapEntries: [number, number];
  /** Minimum glyph ID range [min, max] */
  glyphIdMin: [number, number];
}

/**
 * Complete bank profile for forgery detection
 *
 * Contains both parameterized values for common checks and
 * extension hooks for bank-specific custom checks.
 */
export interface BankProfile {
  /** Unique identifier (e.g., "rshb", "sber", "tinkoff") */
  id: string;
  /** Human-readable bank name */
  name: string;
  /** Full bank name for display */
  fullName: string;

  // === COMMON CHECKS (parameterized) ===

  /** Generator signature for bank identification */
  generatorSignature: GeneratorSignature;
  /** Structural invariants that must match exactly */
  structuralInvariants: StructuralInvariants;
  /** Encoding profile for glyph-based detection */
  encodingProfile: EncodingProfile;
  /** Acceptable ranges for variable attributes */
  ranges: ProfileRanges;

  // === BANK-SPECIFIC EXTENSION HOOKS ===

  /** Custom checks specific to this bank */
  customChecks?: CustomCheck[];
  /** Custom extractors for additional artifacts */
  customExtractors?: CustomExtractor[];

  // === METADATA ===

  /** Number of samples used to build this profile */
  sampleCount?: number;
  /** Last update date */
  lastUpdated?: string;
  /** Profile version */
  version?: string;
  /** Known limitations of this profile */
  limitations?: string[];
}

/**
 * Type guard to check if a value matches a string pattern
 */
export function matchesPattern(value: string | undefined, pattern: string | RegExp): boolean {
  if (!value) return false;
  if (typeof pattern === 'string') {
    return value === pattern;
  }
  return pattern.test(value);
}
