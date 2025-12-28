/**
 * RSHB Custom Checks
 *
 * Bank-specific detection rules for Rosselhozbank receipts.
 * These checks capture patterns specific to RSHB's JasperReports + OpenPDF
 * generator that can't be expressed as simple parameterized values.
 */

import type { CustomCheck } from '../../types/bank-profile.js';
import type { PdfArtifacts } from '../../artifacts/generator.js';
import type { DetectionResult } from '../../types/detection.js';

/**
 * Check for glyph escapes in decoded text
 *
 * Key insight: RSHB's JasperReports template renders ALL text through
 * embedded fonts, including punctuation (periods, asterisks, colons).
 * Characters without CMap entries show as [XXXX] escapes in decoded text.
 *
 * Fake documents that edit content directly inject raw ASCII/Unicode,
 * bypassing the glyph system entirely. They have ZERO glyph escapes.
 *
 * Pattern:
 * - Authentic: "27[01ac]12[01ac]2025" (periods as glyphs)
 * - Fake: "21.12.2025" (periods as ASCII)
 */
function checkGlyphEscapes(artifacts: PdfArtifacts): DetectionResult {
  let escapeCount = 0;

  for (const text of artifacts.streamText) {
    const matches = text.match(/\[0[0-9a-f]+\]/gi);
    if (matches) {
      escapeCount += matches.length;
    }
  }

  if (escapeCount === 0) {
    return {
      passed: false,
      ruleId: 'RSHB_GLYPH_ESCAPES',
      ruleName: 'RSHB Font Glyph Encoding',
      severity: 'high',
      message: 'No glyph escapes found - text may have been injected directly',
      details: {
        escapeCount,
        explanation: 'Authentic RSHB documents render punctuation through embedded fonts, ' +
          'resulting in unmapped glyph IDs (shown as [XXXX]). ' +
          'Documents with zero glyph escapes likely had content edited directly.',
      },
    };
  }

  return {
    passed: true,
    ruleId: 'RSHB_GLYPH_ESCAPES',
    ruleName: 'RSHB Font Glyph Encoding',
    severity: 'info',
    message: `Found ${escapeCount} glyph escapes - consistent with authentic font rendering`,
  };
}

/**
 * Check for date consistency
 *
 * PDF creation date should be <= content dates displayed in document.
 * If document shows a date AFTER its creation, the content was edited
 * without updating the metadata.
 */
function checkDateConsistency(artifacts: PdfArtifacts): DetectionResult {
  const creationDateStr = artifacts.metadata.creationDate;
  if (!creationDateStr) {
    return {
      passed: true,
      ruleId: 'RSHB_DATE_CONSISTENCY',
      ruleName: 'RSHB Date Consistency',
      severity: 'info',
      message: 'No creation date in metadata to verify',
    };
  }

  // Parse PDF date format: D:YYYYMMDDHHmmssZ
  const pdfDateMatch = creationDateStr.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!pdfDateMatch) {
    return {
      passed: true,
      ruleId: 'RSHB_DATE_CONSISTENCY',
      ruleName: 'RSHB Date Consistency',
      severity: 'info',
      message: 'Could not parse creation date format',
    };
  }

  const creationDate = new Date(
    parseInt(pdfDateMatch[1]),
    parseInt(pdfDateMatch[2]) - 1, // Month is 0-indexed
    parseInt(pdfDateMatch[3]),
    parseInt(pdfDateMatch[4]),
    parseInt(pdfDateMatch[5]),
    parseInt(pdfDateMatch[6])
  );

  // Look for dates in content (formats: DD.MM.YYYY, DD/MM/YYYY, etc.)
  const contentDates: { text: string; date: Date }[] = [];

  for (const text of artifacts.streamText) {
    // Match various date formats, accounting for glyph escapes
    // DD.MM.YYYY or DD/MM/YYYY or DD[XXXX]MM[XXXX]YYYY
    const dateMatches = text.matchAll(/(\d{2})(?:[.\/-]|\[0[0-9a-f]+\])(\d{2})(?:[.\/-]|\[0[0-9a-f]+\])(\d{4})/gi);
    for (const match of dateMatches) {
      const day = parseInt(match[1]);
      const month = parseInt(match[2]);
      const year = parseInt(match[3]);

      if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2020 && year <= 2030) {
        const date = new Date(year, month - 1, day);
        contentDates.push({ text: match[0], date });
      }
    }
  }

  // Check if any content date is AFTER creation date
  const futureContent = contentDates.filter(cd => cd.date > creationDate);

  if (futureContent.length > 0) {
    return {
      passed: false,
      ruleId: 'RSHB_DATE_CONSISTENCY',
      ruleName: 'RSHB Date Consistency',
      severity: 'critical',
      message: 'Document shows dates AFTER its creation date - temporal impossibility',
      details: {
        creationDate: creationDate.toISOString().split('T')[0],
        creationDateRaw: creationDateStr,
        contentDatesAfterCreation: futureContent.map(fc => ({
          text: fc.text,
          date: fc.date.toISOString().split('T')[0],
        })),
        explanation: 'A PDF cannot display a transaction date that is after the PDF was created. ' +
          'This indicates the content was edited without updating the metadata.',
      },
    };
  }

  return {
    passed: true,
    ruleId: 'RSHB_DATE_CONSISTENCY',
    ruleName: 'RSHB Date Consistency',
    severity: 'info',
    message: 'All content dates are on or before creation date',
  };
}

/**
 * Check for partial digit coverage in CMaps
 *
 * Template reuse attacks preserve the original document's digit mappings.
 * This creates CMaps with digits that don't appear anywhere in the document.
 */
function checkPartialDigitCoverage(artifacts: PdfArtifacts): DetectionResult {
  // Collect all digits used anywhere in the document
  const allDocDigits = new Set<number>();
  for (const text of artifacts.streamText) {
    for (const char of text) {
      if (char >= '0' && char <= '9') {
        allDocDigits.add(parseInt(char));
      }
    }
  }

  const anomalies: { objectNumber: number; digitCount: number; digits: number[]; unusedDigits: number[] }[] = [];

  for (const cmap of artifacts.fonts.cmaps) {
    const coverage = cmap.analysis.characterCoverage.digitCoverage;
    const digitCount = coverage.filter(Boolean).length;

    // Only check CMaps with partial digit coverage (1-9 digits)
    // 0 or 10 is normal, but partial requires justification
    if (digitCount >= 1 && digitCount <= 9) {
      const mappedDigits = coverage
        .map((has, i) => has ? i : -1)
        .filter(d => d >= 0);

      // Find digits in this CMap that don't appear ANYWHERE in the document
      const unusedDigits = mappedDigits.filter(d => !allDocDigits.has(d));

      if (unusedDigits.length > 0) {
        anomalies.push({
          objectNumber: cmap.objectNumber,
          digitCount,
          digits: mappedDigits,
          unusedDigits,
        });
      }
    }
  }

  if (anomalies.length > 0) {
    return {
      passed: false,
      ruleId: 'RSHB_PARTIAL_DIGIT_COVERAGE',
      ruleName: 'RSHB CMap Digit Coverage',
      severity: 'high',
      message: 'CMap contains digit mappings not used anywhere in document - possible template reuse',
      details: {
        anomalies,
        allDocumentDigits: [...allDocDigits].sort(),
        explanation: 'Font has glyph mappings for digits that never appear in the document. ' +
          'This suggests the document was edited from a template that originally displayed different digits.',
      },
    };
  }

  return {
    passed: true,
    ruleId: 'RSHB_PARTIAL_DIGIT_COVERAGE',
    ruleName: 'RSHB CMap Digit Coverage',
    severity: 'info',
    message: 'All CMap digit mappings are justified by document content',
  };
}

/**
 * All RSHB custom checks
 */
export const rshbCustomChecks: CustomCheck[] = [
  {
    id: 'RSHB_GLYPH_ESCAPES',
    name: 'RSHB Font Glyph Encoding',
    severity: 'high',
    description: 'Checks for glyph escapes that indicate authentic font rendering',
    check: checkGlyphEscapes,
  },
  {
    id: 'RSHB_DATE_CONSISTENCY',
    name: 'RSHB Date Consistency',
    severity: 'critical',
    description: 'Checks for temporal consistency between creation date and content dates',
    check: checkDateConsistency,
  },
  {
    id: 'RSHB_PARTIAL_DIGIT_COVERAGE',
    name: 'RSHB CMap Digit Coverage',
    severity: 'high',
    description: 'Checks for unused digit mappings that indicate template reuse',
    check: checkPartialDigitCoverage,
  },
];
