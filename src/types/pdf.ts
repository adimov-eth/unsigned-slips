/**
 * PDF Structure Types
 *
 * These types represent the internal structure of a PDF document
 * at the binary/structural level - not the rendered content.
 */

/** PDF file header information */
export interface PdfHeader {
  version: string;           // e.g., "1.5"
  binaryMarker: Uint8Array;  // bytes after %PDF-x.x (should be high-bit chars)
  headerOffset: number;      // byte offset where header starts (usually 0)
}

/** Cross-reference table entry */
export interface XrefEntry {
  objectNumber: number;
  generation: number;
  offset: number;            // byte offset in file (for 'n' entries)
  inUse: boolean;            // true for 'n', false for 'f'
}

/** Cross-reference table */
export interface XrefTable {
  entries: XrefEntry[];
  startOffset: number;       // byte offset where xref starts
  rawFormat: 'table' | 'stream';  // traditional table or xref stream
}

/** PDF trailer dictionary */
export interface PdfTrailer {
  size: number;              // total number of entries in xref
  root: PdfReference;        // reference to catalog
  info?: PdfReference;       // reference to info dict (optional)
  id?: [string, string];     // file identifiers (optional)
  prev?: number;             // offset of previous xref (for incremental updates)
  rawContent: string;        // raw trailer dictionary content
}

/** Reference to another object: "X Y R" */
export interface PdfReference {
  objectNumber: number;
  generation: number;
}

/** Base PDF object */
export interface PdfObject {
  objectNumber: number;
  generation: number;
  byteOffset: number;        // where object starts in file
  byteLength: number;        // total bytes including obj/endobj
  rawContent: Uint8Array;    // raw bytes of object content
}

/** PDF Dictionary object */
export interface PdfDictionary extends PdfObject {
  type: 'dictionary';
  entries: Map<string, PdfValue>;
  dictType?: string;         // /Type value if present
}

/** PDF Stream object */
export interface PdfStream extends PdfObject {
  type: 'stream';
  dictionary: Map<string, PdfValue>;
  rawStreamData: Uint8Array;
  decodedData?: Uint8Array;
  filters: string[];         // e.g., ['FlateDecode']
  declaredLength: number;
  actualLength: number;
}

/** PDF Array */
export interface PdfArray {
  type: 'array';
  elements: PdfValue[];
}

/** Union of all PDF value types */
export type PdfValue =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'integer'; value: number }
  | { type: 'real'; value: number }
  | { type: 'string'; value: string; encoding: 'literal' | 'hex' }
  | { type: 'name'; value: string }
  | { type: 'array'; elements: PdfValue[] }
  | { type: 'dictionary'; entries: Map<string, PdfValue> }
  | { type: 'reference'; objectNumber: number; generation: number }
  | { type: 'stream'; dictionary: Map<string, PdfValue>; data: Uint8Array };

/** Compression analysis for a stream */
export interface CompressionAnalysis {
  filter: string;
  zlibHeader: {
    cmf: number;             // compression method and flags
    flg: number;             // flags
    compressionMethod: number;  // should be 8 (deflate)
    compressionInfo: number;    // window size bits
    compressionLevel: 'fastest' | 'fast' | 'default' | 'best';
    windowSize: number;
    fcheck: number;
    fdict: boolean;
  };
  compressedSize: number;
  decompressedSize: number;
  compressionRatio: number;
  adler32: number;           // checksum at end of stream
}

/** Complete parsed PDF structure */
export interface ParsedPdf {
  header: PdfHeader;
  xref: XrefTable;
  trailer: PdfTrailer;
  objects: Map<string, PdfObject | PdfDictionary | PdfStream>;  // key: "objNum genNum"
  fileSize: number;
  filePath: string;
  sha256: string;
}

/** Font information extracted from PDF */
export interface PdfFont {
  objectNumber: number;
  subtype: string;           // Type0, Type1, CIDFontType2, etc.
  baseFont: string;          // font name
  encoding?: string;         // e.g., Identity-H
  toUnicodeRef?: PdfReference;
  descendantFonts?: PdfReference[];
  fontDescriptorRef?: PdfReference;
}

/** CMap glyph mapping */
export interface CMapEntry {
  glyphId: number;           // internal glyph ID
  unicodeValue: number;      // Unicode code point
  unicodeChar: string;       // the actual character
}

/** Parsed ToUnicode CMap */
export interface ToUnicodeCMap {
  registry: string;
  ordering: string;
  supplement: number;
  codespaceRange: [number, number];
  entries: CMapEntry[];
}

/** Producer/Creator metadata */
export interface PdfMetadata {
  producer?: string;
  creator?: string;
  creationDate?: Date;
  modDate?: Date;
  rawInfoDict: Map<string, PdfValue>;
}
