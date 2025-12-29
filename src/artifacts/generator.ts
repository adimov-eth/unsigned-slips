/**
 * Artifact Generator
 *
 * Generates comprehensive JSON artifacts from PDF analysis
 * for forensic comparison and baseline building.
 */

import { PdfParser } from '../core/pdf-parser.js';
import { StreamDecoder } from '../core/stream-decoder.js';
import { CMapParser, type CMapAnalysis } from '../extractors/cmap-parser.js';
import { ContentStreamParser, analyzeTextOperators, type TextOperatorAnalysis } from '../extractors/content-stream.js';
import type { ParsedPdf, PdfStream, PdfDictionary, ToUnicodeCMap, CompressionAnalysis, PdfValue } from '../types/pdf.js';

export interface PositioningArtifacts {
  tmCount: number;           // Absolute positioning operations
  tdCount: number;           // Relative positioning operations
  maxTdPrecision: number;    // Max decimal places in Td values
  avgTdPrecision: number;    // Avg decimal places in Td values
  tmXValues: number[];       // X coordinates from Tm operations
  tmYValues: number[];       // Y coordinates from Tm operations
}

export interface PdfArtifacts {
  // Identification
  filePath: string;
  sha256: string;
  fileSize: number;
  analyzedAt: string;

  // Structure
  structure: StructureArtifacts;

  // Compression forensics
  compression: CompressionArtifacts;

  // Font analysis
  fonts: FontArtifacts;

  // Text content
  text: TextArtifacts;

  // Metadata
  metadata: MetadataArtifacts;

  // Text decoded from content streams via CMaps (glyph escapes left as [xxxx])
  streamText: string[];

  // Text positioning (operator pattern fingerprint)
  positioning?: PositioningArtifacts;
}

export interface StructureArtifacts {
  pdfVersion: string;
  binaryMarkerHex: string;
  objectCount: number;
  streamCount: number;
  xrefFormat: 'table' | 'stream';
  xrefEntryCount: number;
  xrefForensics: {
    startOffset: number;
    newlineStyle: 'LF' | 'CRLF' | 'CR' | 'mixed';
    entryFormat: string;  // e.g., "10d 5d n" for standard format
  };
  objectTypes: Record<string, number>;
  objectNumberSequence: number[];
}

export interface CompressionArtifacts {
  streams: StreamCompressionInfo[];
  summary: {
    totalStreams: number;
    uniqueZlibHeaders: string[];
    avgCompressionRatio: number;
    allRecompressionMatches: boolean;
    lengthMismatches: number;
  };
}

export interface StreamCompressionInfo {
  objectNumber: number;
  filter: string;
  zlibHeader?: {
    cmf: number;
    flg: number;
    compressionLevel: string;
    windowSize: number;
  };
  compressedSize: number;
  decompressedSize: number;
  compressionRatio: number;
  declaredLength: number;
  actualLength: number;
  lengthMismatch: boolean;
}

export interface FontArtifacts {
  fonts: FontInfo[];
  cmaps: CMapInfo[];
  summary: {
    totalFonts: number;
    fontTypes: Record<string, number>;
    totalCMapEntries: number;
    glyphIdRange: { min: number; max: number };
    characterCoverage: {
      hasDigits: boolean;
      hasCyrillic: boolean;
      hasLatin: boolean;
      hasRubleSign: boolean;
      digitCoverage: boolean[];
    };
  };
}

export interface FontInfo {
  objectNumber: number;
  subtype: string;
  baseFont: string;
  encoding?: string;
}

export interface CMapInfo {
  objectNumber: number;
  registry: string;
  ordering: string;
  entryCount: number;
  glyphIdRange: { min: number; max: number };
  analysis: CMapAnalysis;
}

export interface TextArtifacts {
  operators: TextOperatorAnalysis;
  textBlocks: number;
  fontUsage: Record<string, number>;
  totalTextBytes: number;
}

export interface MetadataArtifacts {
  producer?: string;
  creator?: string;
  creationDate?: string;
  modDate?: string;
  jasperReportsVersion?: string;
  openPdfVersion?: string;
}

export class ArtifactGenerator {
  /**
   * Generate complete artifacts from a PDF file
   */
  static async generate(filePath: string): Promise<PdfArtifacts> {
    // Parse PDF structure
    const parser = await PdfParser.fromFile(filePath);
    const pdf = await parser.parse();

    // Generate each artifact section
    const structure = this.extractStructure(pdf);
    const compression = this.extractCompression(pdf);
    const fonts = this.extractFonts(pdf);
    const text = this.extractText(pdf);
    const metadata = this.extractMetadata(pdf);
    const streamText = this.decodeAllText(pdf, fonts.cmaps);
    const positioning = this.extractPositioning(pdf);

    return {
      filePath,
      sha256: pdf.sha256,
      fileSize: pdf.fileSize,
      analyzedAt: new Date().toISOString(),
      structure,
      compression,
      fonts,
      text,
      metadata,
      streamText,
      positioning,
    };
  }

  /**
   * Extract structural artifacts
   */
  private static extractStructure(pdf: ParsedPdf): StructureArtifacts {
    const objectTypes: Record<string, number> = {};
    const objectNumbers: number[] = [];
    let streamCount = 0;

    for (const [key, obj] of pdf.objects) {
      objectNumbers.push(obj.objectNumber);

      if ('type' in obj) {
        if (obj.type === 'stream') {
          streamCount++;
          const streamObj = obj as PdfStream;
          const typeVal = streamObj.dictionary.get('Type');
          const subTypeVal = streamObj.dictionary.get('Subtype');
          const typeName = typeVal?.type === 'name' ? typeVal.value :
                          subTypeVal?.type === 'name' ? `Stream:${subTypeVal.value}` : 'Stream';
          objectTypes[typeName] = (objectTypes[typeName] ?? 0) + 1;
        } else if (obj.type === 'dictionary') {
          const dictObj = obj as PdfDictionary;
          const typeName = dictObj.dictType ?? 'Dictionary';
          objectTypes[typeName] = (objectTypes[typeName] ?? 0) + 1;
        }
      } else {
        objectTypes['Other'] = (objectTypes['Other'] ?? 0) + 1;
      }
    }

    // Analyze xref newline style from entries
    // Standard xref entry: 10-digit offset, space, 5-digit gen, space, n/f, EOL
    let newlineStyle: 'LF' | 'CRLF' | 'CR' | 'mixed' = 'LF';
    const entries = pdf.xref.entries;
    if (entries.length > 1) {
      // Check spacing between entry offsets to infer newline style
      // Standard entry is 20 bytes with LF or 21 bytes with CRLF
      const firstInUse = entries.find(e => e.inUse && e.offset > 0);
      const secondInUse = entries.find((e, i) => e.inUse && e.offset > 0 && entries.indexOf(e) > entries.indexOf(firstInUse!));
      // For now, default to LF (most common in JasperReports output)
      newlineStyle = 'LF';
    }

    return {
      pdfVersion: pdf.header.version,
      binaryMarkerHex: Array.from(pdf.header.binaryMarker).map(b => b.toString(16).padStart(2, '0')).join(''),
      objectCount: pdf.objects.size,
      streamCount,
      xrefFormat: pdf.xref.rawFormat,
      xrefEntryCount: pdf.xref.entries.length,
      xrefForensics: {
        startOffset: pdf.xref.startOffset,
        newlineStyle,
        entryFormat: '10d 5d n',  // Standard PDF xref entry format
      },
      objectTypes,
      objectNumberSequence: objectNumbers.sort((a, b) => a - b),
    };
  }

  /**
   * Extract compression forensics
   */
  private static extractCompression(pdf: ParsedPdf): CompressionArtifacts {
    const streams: StreamCompressionInfo[] = [];
    const zlibHeaders = new Set<string>();
    let totalRatio = 0;
    let recompressionMatches = true;

    for (const [key, obj] of pdf.objects) {
      if ('type' in obj && obj.type === 'stream') {
        const stream = obj as PdfStream;
        const lengthMismatch = stream.declaredLength !== stream.actualLength;

        try {
          const decoded = StreamDecoder.decode(stream);

          if (decoded.compressionAnalysis) {
            const analysis = decoded.compressionAnalysis;
            const headerKey = `${analysis.zlibHeader.cmf.toString(16)}:${analysis.zlibHeader.flg.toString(16)}`;
            zlibHeaders.add(headerKey);

            streams.push({
              objectNumber: stream.objectNumber,
              filter: analysis.filter,
              zlibHeader: {
                cmf: analysis.zlibHeader.cmf,
                flg: analysis.zlibHeader.flg,
                compressionLevel: analysis.zlibHeader.compressionLevel,
                windowSize: analysis.zlibHeader.windowSize,
              },
              compressedSize: analysis.compressedSize,
              decompressedSize: analysis.decompressedSize,
              compressionRatio: analysis.compressionRatio,
              declaredLength: stream.declaredLength,
              actualLength: stream.actualLength,
              lengthMismatch,
            });

            totalRatio += analysis.compressionRatio;

            // Test recompression
            const recompTest = StreamDecoder.testRecompression(stream.rawStreamData, decoded.data);
            if (!recompTest.matches) {
              recompressionMatches = false;
            }
          }
        } catch (e) {
          // Stream decoding failed - note but continue
          streams.push({
            objectNumber: stream.objectNumber,
            filter: stream.filters.join(',') || 'none',
            compressedSize: stream.rawStreamData.length,
            decompressedSize: -1,
            compressionRatio: -1,
            declaredLength: stream.declaredLength,
            actualLength: stream.actualLength,
            lengthMismatch,
          });
        }
      }
    }

    return {
      streams,
      summary: {
        totalStreams: streams.length,
        uniqueZlibHeaders: Array.from(zlibHeaders),
        avgCompressionRatio: streams.length > 0 ? totalRatio / streams.length : 0,
        allRecompressionMatches: recompressionMatches,
        lengthMismatches: streams.filter(s => s.lengthMismatch).length,
      },
    };
  }

  /**
   * Extract font artifacts
   */
  private static extractFonts(pdf: ParsedPdf): FontArtifacts {
    const fonts: FontInfo[] = [];
    const cmaps: CMapInfo[] = [];
    const fontTypes: Record<string, number> = {};

    let totalCMapEntries = 0;
    let minGlyphId = Infinity;
    let maxGlyphId = -Infinity;
    let hasDigits = false;
    let hasCyrillic = false;
    let hasLatin = false;
    let hasRubleSign = false;
    const digitCoverage = [false, false, false, false, false, false, false, false, false, false];

    // Find font objects
    for (const [key, obj] of pdf.objects) {
      if ('type' in obj && obj.type === 'dictionary') {
        const dict = obj as PdfDictionary;
        const typeVal = dict.entries.get('Type');

        if (typeVal?.type === 'name' && typeVal.value === 'Font') {
          const subtypeVal = dict.entries.get('Subtype');
          const baseFontVal = dict.entries.get('BaseFont');
          const encodingVal = dict.entries.get('Encoding');

          const subtype = subtypeVal?.type === 'name' ? subtypeVal.value : 'Unknown';
          const baseFont = baseFontVal?.type === 'name' ? baseFontVal.value : 'Unknown';
          const encoding = encodingVal?.type === 'name' ? encodingVal.value : undefined;

          fonts.push({
            objectNumber: obj.objectNumber,
            subtype,
            baseFont,
            encoding,
          });

          fontTypes[subtype] = (fontTypes[subtype] ?? 0) + 1;

          // Check for ToUnicode stream
          const toUnicodeRef = dict.entries.get('ToUnicode');
          if (toUnicodeRef?.type === 'reference') {
            const toUnicodeKey = `${toUnicodeRef.objectNumber} ${toUnicodeRef.generation}`;
            const toUnicodeObj = pdf.objects.get(toUnicodeKey);

            if (toUnicodeObj && 'type' in toUnicodeObj && toUnicodeObj.type === 'stream') {
              try {
                const decoded = StreamDecoder.decode(toUnicodeObj as PdfStream);
                const cmap = CMapParser.parse(decoded.data);
                const analysis = CMapParser.analyze(cmap);

                cmaps.push({
                  objectNumber: toUnicodeObj.objectNumber,
                  registry: cmap.registry,
                  ordering: cmap.ordering,
                  entryCount: cmap.entries.length,
                  glyphIdRange: analysis.glyphIdRange,
                  analysis,
                });

                totalCMapEntries += cmap.entries.length;
                if (analysis.glyphIdRange.min < minGlyphId) minGlyphId = analysis.glyphIdRange.min;
                if (analysis.glyphIdRange.max > maxGlyphId) maxGlyphId = analysis.glyphIdRange.max;

                if (analysis.characterCoverage.hasDigits) hasDigits = true;
                if (analysis.characterCoverage.hasCyrillic) hasCyrillic = true;
                if (analysis.characterCoverage.hasLatin) hasLatin = true;
                if (analysis.characterCoverage.hasRubleSign) hasRubleSign = true;

                for (let i = 0; i < 10; i++) {
                  if (analysis.characterCoverage.digitCoverage[i]) {
                    digitCoverage[i] = true;
                  }
                }
              } catch (e) {
                // CMap parsing failed
              }
            }
          }
        }
      }
    }

    return {
      fonts,
      cmaps,
      summary: {
        totalFonts: fonts.length,
        fontTypes,
        totalCMapEntries,
        glyphIdRange: { min: minGlyphId === Infinity ? 0 : minGlyphId, max: maxGlyphId === -Infinity ? 0 : maxGlyphId },
        characterCoverage: {
          hasDigits,
          hasCyrillic,
          hasLatin,
          hasRubleSign,
          digitCoverage,
        },
      },
    };
  }

  /**
   * Extract text content artifacts
   */
  private static extractText(pdf: ParsedPdf): TextArtifacts {
    let totalTextBytes = 0;
    let allOperators: any[] = [];
    let textBlocks = 0;
    const fontUsage: Record<string, number> = {};

    // Find content streams (usually in page objects)
    for (const [key, obj] of pdf.objects) {
      if ('type' in obj && obj.type === 'stream') {
        const stream = obj as PdfStream;
        const typeVal = stream.dictionary.get('Type');

        // Content streams typically don't have a Type, or are part of a page
        // We look for streams that might contain text operators
        try {
          const decoded = StreamDecoder.decode(stream);
          const text = new TextDecoder('latin1').decode(decoded.data);

          // Check if this looks like a content stream (has BT/ET)
          if (text.includes('BT') && text.includes('ET')) {
            const parser = new ContentStreamParser(decoded.data);
            const analysis = parser.parse();

            allOperators.push(...analysis.textOperators);
            textBlocks += analysis.textBlocks.length;

            for (const [font, count] of analysis.fontUsage) {
              fontUsage[font] = (fontUsage[font] ?? 0) + count;
            }

            for (const op of analysis.textOperators) {
              totalTextBytes += op.rawBytes.length;
            }
          }
        } catch (e) {
          // Not a content stream or decoding failed
        }
      }
    }

    return {
      operators: analyzeTextOperators(allOperators),
      textBlocks,
      fontUsage,
      totalTextBytes,
    };
  }

  /**
   * Extract metadata
   */
  private static extractMetadata(pdf: ParsedPdf): MetadataArtifacts {
    const metadata: MetadataArtifacts = {};

    if (pdf.trailer.info) {
      const infoKey = `${pdf.trailer.info.objectNumber} ${pdf.trailer.info.generation}`;
      const infoObj = pdf.objects.get(infoKey);

      if (infoObj && 'type' in infoObj && infoObj.type === 'dictionary') {
        const dict = (infoObj as PdfDictionary).entries;

        const producer = dict.get('Producer');
        const creator = dict.get('Creator');
        const creationDate = dict.get('CreationDate');
        const modDate = dict.get('ModDate');

        if (producer?.type === 'string') {
          metadata.producer = producer.value;

          // Extract OpenPDF version
          const openPdfMatch = producer.value.match(/OpenPDF\s+([\d.]+)/);
          if (openPdfMatch) {
            metadata.openPdfVersion = openPdfMatch[1];
          }
        }

        if (creator?.type === 'string') {
          metadata.creator = creator.value;

          // Extract JasperReports version
          const jasperMatch = creator.value.match(/JasperReports Library version\s+([\d.]+(?:-[a-f0-9]+)?)/);
          if (jasperMatch) {
            metadata.jasperReportsVersion = jasperMatch[1];
          }
        }

        if (creationDate?.type === 'string') {
          metadata.creationDate = creationDate.value;
        }

        if (modDate?.type === 'string') {
          metadata.modDate = modDate.value;
        }
      }
    }

    return metadata;
  }

  /**
   * Extract text positioning artifacts
   */
  private static extractPositioning(pdf: ParsedPdf): PositioningArtifacts | undefined {
    // Find content streams and analyze positioning operators
    for (const [key, obj] of pdf.objects) {
      if ('type' in obj && obj.type === 'stream') {
        const stream = obj as PdfStream;

        try {
          const decoded = StreamDecoder.decode(stream);
          const text = new TextDecoder('latin1').decode(decoded.data);

          if (text.includes('BT') && (text.includes('Tj') || text.includes('TJ'))) {
            // Extract Tm operations (absolute positioning)
            const tmMatches = [...text.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g)];

            // Extract Td operations (relative positioning)
            const tdMatches = [...text.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)\s+Td/g)];

            // Analyze Td precision
            const tdPrecisions: number[] = [];
            for (const td of tdMatches) {
              const x = td[1];
              const y = td[2];
              const xDec = x.includes('.') ? x.split('.')[1].replace(/0+$/, '').length : 0;
              const yDec = y.includes('.') ? y.split('.')[1].replace(/0+$/, '').length : 0;
              tdPrecisions.push(Math.max(xDec, yDec));
            }

            const tmXValues = tmMatches.map(m => parseFloat(m[5]));
            const tmYValues = tmMatches.map(m => parseFloat(m[6]));

            return {
              tmCount: tmMatches.length,
              tdCount: tdMatches.length,
              maxTdPrecision: tdPrecisions.length > 0 ? Math.max(...tdPrecisions) : 0,
              avgTdPrecision: tdPrecisions.length > 0
                ? tdPrecisions.reduce((a, b) => a + b, 0) / tdPrecisions.length
                : 0,
              tmXValues,
              tmYValues,
            };
          }
        } catch {
          // Not a content stream or decoding failed
        }
      }
    }

    return undefined;
  }

  /**
   * Decode all text using CMaps
   */
  private static decodeAllText(pdf: ParsedPdf, cmaps: CMapInfo[]): string[] {
    const decodedStrings: string[] = [];

    // Build combined CMap
    const combinedCMap = new Map<number, string>();
    for (const cmapInfo of cmaps) {
      // Re-parse to get entries
      const cmapKey = `${cmapInfo.objectNumber} 0`;
      // We'd need to access the actual CMap data here
      // For now, we'll decode in the content stream pass
    }

    // Find and decode content streams
    for (const [key, obj] of pdf.objects) {
      if ('type' in obj && obj.type === 'stream') {
        const stream = obj as PdfStream;

        try {
          const decoded = StreamDecoder.decode(stream);
          const text = new TextDecoder('latin1').decode(decoded.data);

          if (text.includes('BT') && text.includes('ET')) {
            // Get CMap for this stream
            const allCMaps: ToUnicodeCMap[] = [];

            for (const [objKey, cmapObj] of pdf.objects) {
              if ('type' in cmapObj && cmapObj.type === 'stream') {
                const cmapStream = cmapObj as PdfStream;
                try {
                  const cmapDecoded = StreamDecoder.decode(cmapStream);
                  const cmapText = new TextDecoder('latin1').decode(cmapDecoded.data);
                  if (cmapText.includes('beginbfrange') || cmapText.includes('beginbfchar')) {
                    allCMaps.push(CMapParser.parse(cmapDecoded.data));
                  }
                } catch {}
              }
            }

            // Merge all CMaps
            const mergedCMap: ToUnicodeCMap = {
              registry: 'Merged',
              ordering: 'Merged',
              supplement: 0,
              codespaceRange: [0, 0xFFFF],
              entries: allCMaps.flatMap(c => c.entries),
            };

            // Parse content and decode
            const parser = new ContentStreamParser(decoded.data);
            const analysis = parser.parse();

            for (const op of analysis.textOperators) {
              const decodedStr = CMapParser.decodeText(op.rawBytes, mergedCMap, 'Identity-H');
              if (decodedStr && !decodedStr.startsWith('[')) {
                decodedStrings.push(decodedStr);
              }
            }
          }
        } catch {}
      }
    }

    return decodedStrings;
  }

  /**
   * Save artifacts to JSON file
   */
  static async save(artifacts: PdfArtifacts, outputPath: string): Promise<void> {
    const json = JSON.stringify(artifacts, null, 2);
    await Bun.write(outputPath, json);
  }

  /**
   * Load artifacts from JSON file
   */
  static async load(inputPath: string): Promise<PdfArtifacts> {
    const file = Bun.file(inputPath);
    const json = await file.text();
    return JSON.parse(json);
  }
}
