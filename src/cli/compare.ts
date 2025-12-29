#!/usr/bin/env bun
/**
 * PDF Comparison CLI
 *
 * Compares two PDF artifact files to identify invariants and variations.
 *
 * Usage: bun run compare <artifacts1.json> <artifacts2.json>
 */

import { ArtifactGenerator, type PdfArtifacts } from '../artifacts/generator.js';
import { resolve } from 'path';

interface ComparisonResult {
  invariants: Invariant[];
  variations: Variation[];
  summary: {
    totalInvariants: number;
    totalVariations: number;
    riskScore: number;
  };
}

interface Invariant {
  category: string;
  field: string;
  value: string | number | boolean;
  description: string;
}

interface Variation {
  category: string;
  field: string;
  value1: string | number | boolean;
  value2: string | number | boolean;
  significance: 'low' | 'medium' | 'high';
  description: string;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: bun run compare <artifacts1.json> <artifacts2.json>');
    console.log('');
    console.log('Compares two PDF artifact files to identify invariants and variations.');
    process.exit(1);
  }

  const file1 = resolve(args[0]!);
  const file2 = resolve(args[1]!);

  console.log(`\nComparing:`);
  console.log(`   File 1: ${file1}`);
  console.log(`   File 2: ${file2}\n`);

  try {
    const artifacts1 = await ArtifactGenerator.load(file1);
    const artifacts2 = await ArtifactGenerator.load(file2);

    const result = compare(artifacts1, artifacts2);

    // Print invariants
    console.log('=== INVARIANTS (Same in both files) ===\n');
    for (const inv of result.invariants) {
      console.log(`✓ [${inv.category}] ${inv.field}`);
      console.log(`  Value: ${inv.value}`);
      console.log(`  ${inv.description}\n`);
    }

    // Print variations
    console.log('\n=== VARIATIONS (Different between files) ===\n');
    for (const v of result.variations) {
      const icon = v.significance === 'high' ? '[high]' : v.significance === 'medium' ? '[med]' : '[low]';
      console.log(`${icon} [${v.category}] ${v.field} (${v.significance})`);
      console.log(`  File 1: ${v.value1}`);
      console.log(`  File 2: ${v.value2}`);
      console.log(`  ${v.description}\n`);
    }

    // Summary
    console.log('\n=== SUMMARY ===\n');
    console.log(`Total invariants: ${result.summary.totalInvariants}`);
    console.log(`Total variations: ${result.summary.totalVariations}`);
    console.log(`Risk indicators: ${result.variations.filter(v => v.significance === 'high').length} high, ${result.variations.filter(v => v.significance === 'medium').length} medium`);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

function compare(a1: PdfArtifacts, a2: PdfArtifacts): ComparisonResult {
  const invariants: Invariant[] = [];
  const variations: Variation[] = [];

  // === STRUCTURE ===

  // PDF Version
  if (a1.structure.pdfVersion === a2.structure.pdfVersion) {
    invariants.push({
      category: 'Structure',
      field: 'PDF Version',
      value: a1.structure.pdfVersion,
      description: 'Both files use the same PDF version',
    });
  } else {
    variations.push({
      category: 'Structure',
      field: 'PDF Version',
      value1: a1.structure.pdfVersion,
      value2: a2.structure.pdfVersion,
      significance: 'medium',
      description: 'Different PDF versions could indicate different generators',
    });
  }

  // XRef format
  if (a1.structure.xrefFormat === a2.structure.xrefFormat) {
    invariants.push({
      category: 'Structure',
      field: 'XRef Format',
      value: a1.structure.xrefFormat,
      description: 'Same cross-reference table format',
    });
  }

  // Binary marker - CRITICAL INVARIANT
  if (a1.structure.binaryMarkerHex === a2.structure.binaryMarkerHex) {
    invariants.push({
      category: 'Structure',
      field: 'Binary Marker',
      value: a1.structure.binaryMarkerHex || '(none)',
      description: 'Identical binary compatibility marker - generator fingerprint',
    });
  } else {
    variations.push({
      category: 'Structure',
      field: 'Binary Marker',
      value1: a1.structure.binaryMarkerHex || '(none)',
      value2: a2.structure.binaryMarkerHex || '(none)',
      significance: 'high',
      description: 'CRITICAL: Different binary markers indicate different PDF generators',
    });
  }

  // XRef newline style
  if (a1.structure.xrefForensics?.newlineStyle === a2.structure.xrefForensics?.newlineStyle) {
    invariants.push({
      category: 'Structure',
      field: 'XRef Newline Style',
      value: a1.structure.xrefForensics?.newlineStyle ?? 'unknown',
      description: 'Same line ending style in xref table',
    });
  }

  // Object count
  variations.push({
    category: 'Structure',
    field: 'Object Count',
    value1: a1.structure.objectCount,
    value2: a2.structure.objectCount,
    significance: 'low',
    description: 'Object count varies based on content',
  });

  // === COMPRESSION ===

  // Zlib headers
  const headers1 = a1.compression.summary.uniqueZlibHeaders.sort().join(',');
  const headers2 = a2.compression.summary.uniqueZlibHeaders.sort().join(',');
  if (headers1 === headers2) {
    invariants.push({
      category: 'Compression',
      field: 'Zlib Headers',
      value: headers1,
      description: 'Identical compression parameters (CMF:FLG)',
    });
  } else {
    variations.push({
      category: 'Compression',
      field: 'Zlib Headers',
      value1: headers1,
      value2: headers2,
      significance: 'high',
      description: 'Different compression parameters indicate different compressor',
    });
  }

  // Recompression matches
  if (a1.compression.summary.allRecompressionMatches === a2.compression.summary.allRecompressionMatches) {
    invariants.push({
      category: 'Compression',
      field: 'Recompression Behavior',
      value: a1.compression.summary.allRecompressionMatches,
      description: 'Same recompression characteristics',
    });
  }

  // Stream length mismatches - RED FLAG
  const mismatches1 = a1.compression.summary.lengthMismatches ?? 0;
  const mismatches2 = a2.compression.summary.lengthMismatches ?? 0;
  if (mismatches1 > 0 || mismatches2 > 0) {
    variations.push({
      category: 'Compression',
      field: 'Stream Length Mismatches',
      value1: mismatches1,
      value2: mismatches2,
      significance: 'high',
      description: 'WARNING: Stream length mismatches may indicate tampering',
    });
  }

  // === FONTS ===

  // Font types
  const fontTypes1 = JSON.stringify(a1.fonts.summary.fontTypes);
  const fontTypes2 = JSON.stringify(a2.fonts.summary.fontTypes);
  if (fontTypes1 === fontTypes2) {
    invariants.push({
      category: 'Fonts',
      field: 'Font Type Distribution',
      value: fontTypes1,
      description: 'Same types of fonts used',
    });
  } else {
    variations.push({
      category: 'Fonts',
      field: 'Font Type Distribution',
      value1: fontTypes1,
      value2: fontTypes2,
      significance: 'high',
      description: 'Different font types could indicate tampering',
    });
  }

  // CMap entries (expected to vary)
  variations.push({
    category: 'Fonts',
    field: 'CMap Entry Count',
    value1: a1.fonts.summary.totalCMapEntries,
    value2: a2.fonts.summary.totalCMapEntries,
    significance: 'low',
    description: 'CMap entries vary based on characters used in content',
  });

  // Glyph ID range
  const range1 = `${a1.fonts.summary.glyphIdRange.min}-${a1.fonts.summary.glyphIdRange.max}`;
  const range2 = `${a2.fonts.summary.glyphIdRange.min}-${a2.fonts.summary.glyphIdRange.max}`;
  variations.push({
    category: 'Fonts',
    field: 'Glyph ID Range',
    value1: range1,
    value2: range2,
    significance: 'medium',
    description: 'Glyph ID ranges should be similar for same font family',
  });

  // Character coverage
  if (a1.fonts.summary.characterCoverage.hasDigits === a2.fonts.summary.characterCoverage.hasDigits &&
      a1.fonts.summary.characterCoverage.hasCyrillic === a2.fonts.summary.characterCoverage.hasCyrillic) {
    invariants.push({
      category: 'Fonts',
      field: 'Character Type Coverage',
      value: `digits:${a1.fonts.summary.characterCoverage.hasDigits}, cyrillic:${a1.fonts.summary.characterCoverage.hasCyrillic}`,
      description: 'Same character types supported',
    });
  }

  // Ruble sign presence
  if (a1.fonts.summary.characterCoverage.hasRubleSign !== a2.fonts.summary.characterCoverage.hasRubleSign) {
    variations.push({
      category: 'Fonts',
      field: 'Ruble Sign Coverage',
      value1: a1.fonts.summary.characterCoverage.hasRubleSign,
      value2: a2.fonts.summary.characterCoverage.hasRubleSign,
      significance: 'medium',
      description: 'Different currency symbol usage',
    });
  }

  // === METADATA ===

  // OpenPDF version
  if (a1.metadata.openPdfVersion === a2.metadata.openPdfVersion) {
    invariants.push({
      category: 'Metadata',
      field: 'OpenPDF Version',
      value: a1.metadata.openPdfVersion ?? 'unknown',
      description: 'Same PDF library version',
    });
  } else {
    variations.push({
      category: 'Metadata',
      field: 'OpenPDF Version',
      value1: a1.metadata.openPdfVersion ?? 'unknown',
      value2: a2.metadata.openPdfVersion ?? 'unknown',
      significance: 'high',
      description: 'Different library versions could indicate different systems',
    });
  }

  // JasperReports version
  if (a1.metadata.jasperReportsVersion !== a2.metadata.jasperReportsVersion) {
    variations.push({
      category: 'Metadata',
      field: 'JasperReports Version',
      value1: a1.metadata.jasperReportsVersion ?? 'unknown',
      value2: a2.metadata.jasperReportsVersion ?? 'unknown',
      significance: 'medium',
      description: 'Different JasperReports versions - bank may have multiple deployments',
    });
  }

  return {
    invariants,
    variations,
    summary: {
      totalInvariants: invariants.length,
      totalVariations: variations.length,
      riskScore: variations.filter(v => v.significance === 'high').length * 10 +
                 variations.filter(v => v.significance === 'medium').length * 3,
    },
  };
}

main();
