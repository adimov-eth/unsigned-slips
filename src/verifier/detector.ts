/**
 * Forgery Detection Engine
 *
 * Implements a hybrid detection system:
 * 1. Common checks - parameterized by bank profile values
 * 2. Custom checks - bank-specific logic that can't be parameterized
 *
 * The engine auto-detects the bank from PDF artifacts, loads the
 * appropriate profile, and runs both common and custom checks.
 */

import type { PdfArtifacts } from '../artifacts/generator.js';
import type { BankProfile } from '../types/bank-profile.js';
import type { DetectionResult, Severity, VerificationReport } from '../types/detection.js';
import { detectBank, getUnknownBankInfo } from '../banks/index.js';

// Re-export types for backwards compatibility
export type { Severity, DetectionResult, VerificationReport } from '../types/detection.js';

// ============================================================================
// COMMON CHECKS (parameterized by profile values)
// ============================================================================

/**
 * Check binary marker against profile
 */
function checkBinaryMarker(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.generatorSignature.binaryMarker;
  const actual = artifacts.structure.binaryMarkerHex;

  if (actual !== expected) {
    return {
      passed: false,
      ruleId: 'BINARY_MARKER',
      ruleName: 'PDF Generator Binary Marker',
      severity: 'critical',
      message: 'Binary marker does not match bank generator signature',
      details: { expected, actual },
    };
  }

  return {
    passed: true,
    ruleId: 'BINARY_MARKER',
    ruleName: 'PDF Generator Binary Marker',
    severity: 'info',
    message: 'Binary marker matches bank generator signature',
  };
}

/**
 * Check PDF version against profile
 */
function checkPdfVersion(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.generatorSignature.pdfVersion;
  const actual = artifacts.structure.pdfVersion;

  if (actual !== expected) {
    return {
      passed: false,
      ruleId: 'PDF_VERSION',
      ruleName: 'PDF Version',
      severity: 'critical',
      message: `PDF version ${actual} does not match expected ${expected}`,
      details: { expected, actual },
    };
  }

  return {
    passed: true,
    ruleId: 'PDF_VERSION',
    ruleName: 'PDF Version',
    severity: 'info',
    message: `PDF version ${actual} matches expected`,
  };
}

/**
 * Check XRef format against profile
 */
function checkXrefFormat(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.structuralInvariants.xrefFormat;
  const actual = artifacts.structure.xrefFormat;

  if (actual !== expected) {
    return {
      passed: false,
      ruleId: 'XREF_FORMAT',
      ruleName: 'XRef Table Format',
      severity: 'critical',
      message: `XRef format '${actual}' does not match expected '${expected}'`,
      details: { expected, actual },
    };
  }

  return {
    passed: true,
    ruleId: 'XREF_FORMAT',
    ruleName: 'XRef Table Format',
    severity: 'info',
    message: 'XRef format matches expected',
  };
}

/**
 * Check zlib compression headers against profile
 */
function checkZlibHeaders(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.structuralInvariants.zlibHeader;
  const actual = artifacts.compression.summary.uniqueZlibHeaders;

  const unexpected = actual.filter(h => h !== expected);

  if (unexpected.length > 0) {
    return {
      passed: false,
      ruleId: 'ZLIB_HEADERS',
      ruleName: 'Compression Headers',
      severity: 'critical',
      message: 'Unexpected zlib compression headers detected',
      details: { expected, actual, unexpected },
    };
  }

  return {
    passed: true,
    ruleId: 'ZLIB_HEADERS',
    ruleName: 'Compression Headers',
    severity: 'info',
    message: 'All compression headers match expected pattern',
  };
}

/**
 * Check font type distribution against profile
 */
function checkFontTypeDistribution(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.structuralInvariants.fontDistribution;
  const actual = artifacts.fonts.summary.fontTypes;

  const mismatches: string[] = [];

  for (const [fontType, count] of Object.entries(expected)) {
    const actualCount = actual[fontType] ?? 0;
    if (actualCount !== count) {
      mismatches.push(`${fontType}: expected ${count}, got ${actualCount}`);
    }
  }

  for (const [fontType, count] of Object.entries(actual)) {
    if (!(fontType in expected)) {
      mismatches.push(`${fontType}: unexpected font type with count ${count}`);
    }
  }

  if (mismatches.length > 0) {
    return {
      passed: false,
      ruleId: 'FONT_DISTRIBUTION',
      ruleName: 'Font Type Distribution',
      severity: 'critical',
      message: 'Font type distribution does not match bank generator pattern',
      details: { expected, actual, mismatches },
    };
  }

  return {
    passed: true,
    ruleId: 'FONT_DISTRIBUTION',
    ruleName: 'Font Type Distribution',
    severity: 'info',
    message: 'Font type distribution matches expected pattern',
  };
}

/**
 * Check font count against profile
 */
function checkFontCount(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.structuralInvariants.fontCount;
  const actual = artifacts.fonts.summary.totalFonts;

  if (actual !== expected) {
    return {
      passed: false,
      ruleId: 'FONT_COUNT',
      ruleName: 'Font Count',
      severity: 'high',
      message: `Font count ${actual} does not match expected ${expected}`,
      details: { expected, actual },
    };
  }

  return {
    passed: true,
    ruleId: 'FONT_COUNT',
    ruleName: 'Font Count',
    severity: 'info',
    message: `Font count ${actual} matches expected`,
  };
}

/**
 * Check object sequence for gaps (deleted objects)
 */
function checkObjectSequenceGaps(artifacts: PdfArtifacts): DetectionResult {
  const sequence = artifacts.structure.objectNumberSequence;
  const gaps: { expected: number; found: number }[] = [];

  for (let i = 1; i < sequence.length; i++) {
    const expected = sequence[i - 1] + 1;
    const found = sequence[i];

    if (found !== expected && found !== sequence[i - 1]) {
      for (let missing = expected; missing < found; missing++) {
        gaps.push({ expected: missing, found });
      }
    }
  }

  if (gaps.length > 0) {
    return {
      passed: false,
      ruleId: 'OBJECT_SEQUENCE',
      ruleName: 'Object Sequence Integrity',
      severity: 'high',
      message: `Object sequence has ${gaps.length} gap(s) - objects may have been deleted`,
      details: { missingObjects: gaps.map(g => g.expected), sequence },
    };
  }

  return {
    passed: true,
    ruleId: 'OBJECT_SEQUENCE',
    ruleName: 'Object Sequence Integrity',
    severity: 'info',
    message: 'Object number sequence is contiguous',
  };
}

/**
 * Check stream length integrity
 */
function checkStreamLengths(artifacts: PdfArtifacts): DetectionResult {
  const mismatches = artifacts.compression.summary.lengthMismatches;

  if (mismatches > 0) {
    return {
      passed: false,
      ruleId: 'STREAM_LENGTHS',
      ruleName: 'Stream Length Integrity',
      severity: 'high',
      message: `${mismatches} stream(s) have declared length != actual length`,
      details: {
        mismatchCount: mismatches,
        streams: artifacts.compression.streams
          .filter(s => s.lengthMismatch)
          .map(s => ({
            objectNumber: s.objectNumber,
            declared: s.declaredLength,
            actual: s.actualLength,
          })),
      },
    };
  }

  return {
    passed: true,
    ruleId: 'STREAM_LENGTHS',
    ruleName: 'Stream Length Integrity',
    severity: 'info',
    message: 'All stream lengths match their declarations',
  };
}

/**
 * Check producer against profile
 */
function checkProducer(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const expected = profile.generatorSignature.producer;
  const actual = artifacts.metadata.producer;

  if (!actual) {
    return {
      passed: false,
      ruleId: 'PRODUCER',
      ruleName: 'PDF Producer',
      severity: 'high',
      message: 'No producer metadata found',
    };
  }

  const matches = typeof expected === 'string'
    ? actual === expected
    : expected.test(actual);

  if (!matches) {
    return {
      passed: false,
      ruleId: 'PRODUCER',
      ruleName: 'PDF Producer',
      severity: 'high',
      message: `Producer '${actual}' does not match expected pattern`,
      details: { expected: String(expected), actual },
    };
  }

  return {
    passed: true,
    ruleId: 'PRODUCER',
    ruleName: 'PDF Producer',
    severity: 'info',
    message: 'Producer matches expected pattern',
  };
}

/**
 * Check object count is within expected range
 */
function checkObjectCount(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const [min, max] = profile.ranges.objectCount;
  const actual = artifacts.structure.objectCount;

  if (actual < min || actual > max) {
    return {
      passed: false,
      ruleId: 'OBJECT_COUNT',
      ruleName: 'Object Count Range',
      severity: 'medium',
      message: `Object count ${actual} is outside expected range [${min}-${max}]`,
      details: { expected: { min, max }, actual },
    };
  }

  return {
    passed: true,
    ruleId: 'OBJECT_COUNT',
    ruleName: 'Object Count Range',
    severity: 'info',
    message: `Object count ${actual} is within expected range`,
  };
}

/**
 * Check glyph ID minimum is within expected range
 */
function checkGlyphIdRange(artifacts: PdfArtifacts, profile: BankProfile): DetectionResult {
  const [expectedMin, expectedMax] = profile.ranges.glyphIdMin;
  const actualMin = artifacts.fonts.summary.glyphIdRange.min;

  if (actualMin < expectedMin) {
    return {
      passed: false,
      ruleId: 'GLYPH_ID_RANGE',
      ruleName: 'Glyph ID Range',
      severity: 'medium',
      message: `Minimum glyph ID ${actualMin} is unusually low (expected >= ${expectedMin})`,
      details: { expectedMinRange: { min: expectedMin, max: expectedMax }, actualMin },
    };
  }

  return {
    passed: true,
    ruleId: 'GLYPH_ID_RANGE',
    ruleName: 'Glyph ID Range',
    severity: 'info',
    message: `Glyph ID range starts at ${actualMin}, within expected bounds`,
  };
}

// ============================================================================
// MAIN VERIFICATION FUNCTION
// ============================================================================

/**
 * Verify PDF artifacts against auto-detected bank profile
 *
 * This is the main entry point. It:
 * 1. Auto-detects the bank from artifacts
 * 2. Loads the appropriate profile
 * 3. Runs common checks (parameterized by profile)
 * 4. Runs bank-specific custom checks
 * 5. Returns a comprehensive verification report
 */
export function verify(artifacts: PdfArtifacts, explicitProfile?: BankProfile): VerificationReport {
  // Detect or use explicit profile
  const profile = explicitProfile ?? detectBank(artifacts);

  if (!profile) {
    const unknownInfo = getUnknownBankInfo(artifacts);
    return {
      filePath: artifacts.filePath,
      sha256: artifacts.sha256,
      timestamp: new Date().toISOString(),
      bankId: 'unknown',
      bankName: 'Unknown Bank',
      verdict: 'unknown_bank',
      confidence: 0,
      score: 0,
      results: [{
        passed: false,
        ruleId: 'BANK_DETECTION',
        ruleName: 'Bank Detection',
        severity: 'critical',
        message: 'Could not identify bank from PDF structure',
        details: unknownInfo,
      }],
      summary: { critical: 1, high: 0, medium: 0, low: 0, passed: 0 },
    };
  }

  const results: DetectionResult[] = [];

  // === COMMON CHECKS (parameterized by profile) ===

  // Critical structural checks
  results.push(checkBinaryMarker(artifacts, profile));
  results.push(checkPdfVersion(artifacts, profile));
  results.push(checkXrefFormat(artifacts, profile));
  results.push(checkZlibHeaders(artifacts, profile));
  results.push(checkFontTypeDistribution(artifacts, profile));

  // High priority integrity checks
  results.push(checkFontCount(artifacts, profile));
  results.push(checkObjectSequenceGaps(artifacts));
  results.push(checkStreamLengths(artifacts));
  results.push(checkProducer(artifacts, profile));

  // Medium priority range checks
  results.push(checkObjectCount(artifacts, profile));
  results.push(checkGlyphIdRange(artifacts, profile));

  // === BANK-SPECIFIC CUSTOM CHECKS ===

  if (profile.customChecks) {
    for (const customCheck of profile.customChecks) {
      const result = customCheck.check(artifacts, profile);
      results.push(result);
    }
  }

  // === CALCULATE VERDICT ===

  const summary = {
    critical: results.filter(r => !r.passed && r.severity === 'critical').length,
    high: results.filter(r => !r.passed && r.severity === 'high').length,
    medium: results.filter(r => !r.passed && r.severity === 'medium').length,
    low: results.filter(r => !r.passed && r.severity === 'low').length,
    passed: results.filter(r => r.passed).length,
  };

  // Calculate score (higher = more likely authentic)
  let score = 100;
  score -= summary.critical * 30;
  score -= summary.high * 15;
  score -= summary.medium * 5;
  score -= summary.low * 2;
  score = Math.max(0, score);

  // Determine verdict
  let verdict: 'authentic' | 'suspicious' | 'forged';
  if (summary.critical > 0) {
    verdict = 'forged';
  } else if (summary.high > 0 || summary.medium >= 2) {
    verdict = 'suspicious';
  } else {
    verdict = 'authentic';
  }

  // Confidence based on how many checks passed
  const totalChecks = results.length;
  const confidence = Math.round((summary.passed / totalChecks) * 100);

  return {
    filePath: artifacts.filePath,
    sha256: artifacts.sha256,
    timestamp: new Date().toISOString(),
    bankId: profile.id,
    bankName: profile.fullName,
    verdict,
    confidence,
    score,
    results,
    summary,
  };
}

/**
 * Verify with explicit bank profile (for testing or when bank is known)
 */
export function verifyWithProfile(artifacts: PdfArtifacts, profile: BankProfile): VerificationReport {
  return verify(artifacts, profile);
}
