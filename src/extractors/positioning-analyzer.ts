/**
 * Text Positioning Analysis
 *
 * Detects forgeries by analyzing text positioning inconsistencies.
 *
 * Key insight: Bank PDF generators calculate text positions based on content.
 * When attackers modify text but don't recalculate positions, the coordinates
 * don't match what the generator would have produced for that content.
 *
 * Detection approaches:
 * 1. X-coordinate variation analysis - content-dependent fields should have
 *    X values that correlate with text width
 * 2. Positioning precision fingerprint - different generators use different
 *    decimal precision patterns
 * 3. Operator emission patterns - Tm vs Td usage ratios are generator-specific
 */

import { inflate } from 'zlib';
import { promisify } from 'util';

const inflateAsync = promisify(inflate);

export interface TextPosition {
  x: number;
  y: number;
  rawText: string;
  font?: string;
  fontSize?: number;
}

export interface PositioningProfile {
  tmCount: number;           // Absolute positioning operations
  tdCount: number;           // Relative positioning operations
  tdPrecisions: number[];    // Decimal places in Td values
  tmXValues: number[];       // X coordinates from Tm operations
  tmYValues: number[];       // Y coordinates from Tm operations
  operatorRatio: number;     // Tm/Td ratio - generator fingerprint
  avgTdPrecision: number;
  maxTdPrecision: number;
}

export interface PositioningAnalysis {
  profile: PositioningProfile;
  variableXPositions: Array<{ y: number; x: number; }>; // Positions where X varies with content
  fixedYPositions: number[];   // Y values that are template-fixed
}

/**
 * Extract content stream from PDF buffer
 */
async function extractContentStream(pdfBuffer: Buffer): Promise<string | null> {
  const text = pdfBuffer.toString('latin1');
  const streamMatches = [...text.matchAll(/(\d+)\s+0\s+obj[\s\S]*?stream\r?\n/g)];

  for (const sm of streamMatches) {
    const streamKeyword = text.indexOf('stream', sm.index);
    let streamStart = streamKeyword + 6;
    if (pdfBuffer[streamStart] === 0x0d) streamStart++;
    if (pdfBuffer[streamStart] === 0x0a) streamStart++;

    const streamEnd = text.indexOf('endstream', streamStart);
    if (streamEnd < 0 || streamEnd - streamStart > 100000) continue;

    const compressed = pdfBuffer.slice(streamStart, streamEnd);

    try {
      const content = (await inflateAsync(compressed)).toString('latin1');
      if (content.includes('BT') && (content.includes('Tj') || content.includes('TJ'))) {
        return content;
      }
    } catch {
      // Not a valid compressed stream
    }
  }

  return null;
}

/**
 * Analyze text positioning in a PDF content stream
 */
export async function analyzePositioning(pdfBuffer: Buffer): Promise<PositioningAnalysis | null> {
  const content = await extractContentStream(pdfBuffer);
  if (!content) return null;

  // Extract Tm operations (absolute positioning)
  const tmMatches = [...content.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g)];

  // Extract Td operations (relative positioning)
  const tdMatches = [...content.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+Td/g)];

  // Analyze Td precision
  const tdPrecisions: number[] = [];
  for (const td of tdMatches) {
    const x = td[1];
    const y = td[2];
    const xDec = x.includes('.') ? x.split('.')[1].replace(/0+$/, '').length : 0;
    const yDec = y.includes('.') ? y.split('.')[1].replace(/0+$/, '').length : 0;
    tdPrecisions.push(Math.max(xDec, yDec));
  }

  // Extract Tm coordinates
  const tmXValues = tmMatches.map(m => parseFloat(m[5]));
  const tmYValues = tmMatches.map(m => parseFloat(m[6]));

  // Find fixed vs variable Y positions
  const yValueCounts = new Map<number, number>();
  for (const y of tmYValues) {
    const rounded = Math.round(y * 100) / 100;
    yValueCounts.set(rounded, (yValueCounts.get(rounded) || 0) + 1);
  }
  const fixedYPositions = [...yValueCounts.entries()]
    .filter(([_, count]) => count === 1) // Y values that appear exactly once
    .map(([y]) => y);

  // Identify variable X positions (where X changes between documents)
  const variableXPositions: Array<{ y: number; x: number }> = [];
  for (let i = 0; i < tmMatches.length; i++) {
    const x = parseFloat(tmMatches[i][5]);
    const y = parseFloat(tmMatches[i][6]);
    // X positions with decimal values are more likely to be content-dependent
    if (x !== Math.floor(x)) {
      variableXPositions.push({ y: Math.round(y * 100) / 100, x });
    }
  }

  const profile: PositioningProfile = {
    tmCount: tmMatches.length,
    tdCount: tdMatches.length,
    tdPrecisions,
    tmXValues,
    tmYValues,
    operatorRatio: tdMatches.length > 0 ? tmMatches.length / tdMatches.length : Infinity,
    avgTdPrecision: tdPrecisions.length > 0
      ? tdPrecisions.reduce((a, b) => a + b, 0) / tdPrecisions.length
      : 0,
    maxTdPrecision: tdPrecisions.length > 0 ? Math.max(...tdPrecisions) : 0,
  };

  return {
    profile,
    variableXPositions,
    fixedYPositions,
  };
}

/**
 * Compare positioning between two documents
 * Returns positions where coordinates match exactly but shouldn't
 */
export function comparePositioning(
  analysis1: PositioningAnalysis,
  analysis2: PositioningAnalysis
): {
  suspiciousMatches: Array<{ y: number; x: number; reason: string }>;
  operatorPatternMatch: boolean;
  precisionPatternMatch: boolean;
} {
  const suspiciousMatches: Array<{ y: number; x: number; reason: string }> = [];

  // Find Y positions that have different X values between documents
  const pos1Map = new Map(analysis1.variableXPositions.map(p => [p.y, p.x]));
  const pos2Map = new Map(analysis2.variableXPositions.map(p => [p.y, p.x]));

  for (const [y, x1] of pos1Map) {
    const x2 = pos2Map.get(y);
    if (x2 !== undefined && x1 === x2) {
      // Same Y, same X - but these are content-dependent positions
      // If content is different, X should differ
      suspiciousMatches.push({
        y,
        x: x1,
        reason: `X coordinate ${x1} at Y=${y} matches exactly - may indicate unchanged positioning after content edit`
      });
    }
  }

  // Compare operator patterns
  const operatorPatternMatch =
    Math.abs(analysis1.profile.operatorRatio - analysis2.profile.operatorRatio) < 0.1;

  // Compare precision patterns
  const precisionPatternMatch =
    analysis1.profile.maxTdPrecision === analysis2.profile.maxTdPrecision;

  return {
    suspiciousMatches,
    operatorPatternMatch,
    precisionPatternMatch,
  };
}

/**
 * Detect generator type from positioning patterns
 */
export function detectGeneratorPattern(analysis: PositioningAnalysis): {
  type: 'jasper-like' | 'per-glyph' | 'unknown';
  confidence: number;
  characteristics: string[];
} {
  const { profile } = analysis;
  const characteristics: string[] = [];

  // JasperReports-like: Many Tm operations, few Td, integer precision
  if (profile.tmCount > 20 && profile.tdCount < 15 && profile.avgTdPrecision < 1) {
    characteristics.push('High Tm count (' + profile.tmCount + ')');
    characteristics.push('Low Td count (' + profile.tdCount + ')');
    characteristics.push('Integer precision in Td values');
    return {
      type: 'jasper-like',
      confidence: 0.85,
      characteristics,
    };
  }

  // Per-glyph positioning: Many Td operations, high precision
  if (profile.tdCount > 100 && profile.maxTdPrecision >= 4) {
    characteristics.push('High Td count (' + profile.tdCount + ')');
    characteristics.push('High decimal precision (' + profile.maxTdPrecision + ' decimals)');
    return {
      type: 'per-glyph',
      confidence: 0.90,
      characteristics,
    };
  }

  return {
    type: 'unknown',
    confidence: 0.5,
    characteristics: ['No distinctive pattern detected'],
  };
}
