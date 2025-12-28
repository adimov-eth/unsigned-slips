#!/usr/bin/env bun
/**
 * PDF Extraction CLI
 *
 * Extracts forensic artifacts from a PDF file.
 *
 * Usage: bun run extract <pdf-file> [output-dir]
 */

import { ArtifactGenerator } from '../artifacts/generator.js';
import { resolve, basename } from 'path';

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: bun run extract <pdf-file> [output-dir]');
    console.log('');
    console.log('Extracts forensic artifacts from a PDF file.');
    console.log('');
    console.log('Arguments:');
    console.log('  pdf-file    Path to PDF file to analyze');
    console.log('  output-dir  Directory to save artifacts (default: ./artifacts)');
    process.exit(1);
  }

  const pdfPath = resolve(args[0]!);
  const outputDir = args[1] ? resolve(args[1]) : './artifacts';

  console.log(`\n📄 Analyzing: ${pdfPath}`);
  console.log(`📁 Output: ${outputDir}\n`);

  try {
    // Generate artifacts
    console.log('⏳ Parsing PDF structure...');
    const artifacts = await ArtifactGenerator.generate(pdfPath);

    console.log('✅ Extraction complete!\n');

    // Print summary
    console.log('=== SUMMARY ===\n');

    console.log(`File: ${artifacts.filePath}`);
    console.log(`SHA256: ${artifacts.sha256}`);
    console.log(`Size: ${artifacts.fileSize} bytes`);
    console.log(`PDF Version: ${artifacts.structure.pdfVersion}`);
    console.log('');

    console.log('--- Structure ---');
    console.log(`Objects: ${artifacts.structure.objectCount}`);
    console.log(`Streams: ${artifacts.structure.streamCount}`);
    console.log(`XRef format: ${artifacts.structure.xrefFormat}`);
    console.log('');

    console.log('--- Compression ---');
    console.log(`Streams analyzed: ${artifacts.compression.summary.totalStreams}`);
    console.log(`Unique zlib headers: ${artifacts.compression.summary.uniqueZlibHeaders.join(', ')}`);
    console.log(`Avg compression ratio: ${(artifacts.compression.summary.avgCompressionRatio * 100).toFixed(1)}%`);
    console.log(`Recompression matches: ${artifacts.compression.summary.allRecompressionMatches ? 'YES' : 'NO'}`);
    console.log('');

    console.log('--- Fonts ---');
    console.log(`Total fonts: ${artifacts.fonts.summary.totalFonts}`);
    console.log(`Font types: ${JSON.stringify(artifacts.fonts.summary.fontTypes)}`);
    console.log(`CMap entries: ${artifacts.fonts.summary.totalCMapEntries}`);
    console.log(`Glyph ID range: ${artifacts.fonts.summary.glyphIdRange.min}-${artifacts.fonts.summary.glyphIdRange.max}`);
    console.log(`Has digits: ${artifacts.fonts.summary.characterCoverage.hasDigits}`);
    console.log(`Has Cyrillic: ${artifacts.fonts.summary.characterCoverage.hasCyrillic}`);
    console.log(`Has Ruble sign: ${artifacts.fonts.summary.characterCoverage.hasRubleSign}`);
    console.log(`Digit coverage: ${artifacts.fonts.summary.characterCoverage.digitCoverage.map((d, i) => d ? i : '').filter(x => x !== '').join(', ')}`);
    console.log('');

    console.log('--- Metadata ---');
    if (artifacts.metadata.producer) console.log(`Producer: ${artifacts.metadata.producer}`);
    if (artifacts.metadata.creator) console.log(`Creator: ${artifacts.metadata.creator}`);
    if (artifacts.metadata.jasperReportsVersion) console.log(`JasperReports: ${artifacts.metadata.jasperReportsVersion}`);
    if (artifacts.metadata.openPdfVersion) console.log(`OpenPDF: ${artifacts.metadata.openPdfVersion}`);
    if (artifacts.metadata.creationDate) console.log(`Created: ${artifacts.metadata.creationDate}`);
    console.log('');

    console.log('--- Text Content ---');
    console.log(`Text operators: ${artifacts.text.operators.totalOperators}`);
    console.log(`Text blocks: ${artifacts.text.textBlocks}`);
    console.log(`Total text bytes: ${artifacts.text.totalTextBytes}`);
    console.log('');

    if (artifacts.streamText.length > 0) {
      console.log('--- Decoded Text ---');
      for (const text of artifacts.streamText.slice(0, 20)) {
        console.log(`  "${text}"`);
      }
      if (artifacts.streamText.length > 20) {
        console.log(`  ... and ${artifacts.streamText.length - 20} more`);
      }
      console.log('');
    }

    // Save artifacts
    await Bun.$`mkdir -p ${outputDir}`;

    const outputName = basename(pdfPath, '.pdf');
    const outputPath = `${outputDir}/${outputName}.json`;

    await ArtifactGenerator.save(artifacts, outputPath);
    console.log(`💾 Artifacts saved to: ${outputPath}\n`);

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
