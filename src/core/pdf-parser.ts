/**
 * PDF Binary Parser
 *
 * Low-level PDF structure parser. Extracts raw structure, not rendered content.
 */

import type {
  PdfHeader,
  XrefTable,
  XrefEntry,
  PdfTrailer,
  PdfObject,
  PdfStream,
  PdfDictionary,
  PdfReference,
  PdfValue,
  ParsedPdf,
} from '../types/pdf.js';

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([
  0x28, 0x29, // ( )
  0x3c, 0x3e, // < >
  0x5b, 0x5d, // [ ]
  0x7b, 0x7d, // { }
  0x2f,       // /
  0x25,       // %
]);

export class PdfParser {
  private data: Uint8Array;
  private pos: number = 0;
  private filePath: string;

  constructor(data: Uint8Array, filePath: string) {
    this.data = data;
    this.filePath = filePath;
  }

  /**
   * Parse PDF from file path
   */
  static async fromFile(filePath: string): Promise<PdfParser> {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    return new PdfParser(new Uint8Array(buffer), filePath);
  }

  /**
   * Parse the complete PDF structure
   */
  async parse(): Promise<ParsedPdf> {
    const header = this.parseHeader();
    const { xref, trailer } = this.parseXrefAndTrailer();
    const objects = this.parseAllObjects(xref);

    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(this.data);
    const sha256 = hasher.digest('hex');

    return {
      header,
      xref,
      trailer,
      objects,
      fileSize: this.data.length,
      filePath: this.filePath,
      sha256,
    };
  }

  /**
   * Parse PDF header: %PDF-x.x followed by binary marker
   */
  private parseHeader(): PdfHeader {
    this.pos = 0;

    // Find %PDF-
    const pdfMarker = this.findSequence(new TextEncoder().encode('%PDF-'));
    if (pdfMarker === -1) {
      throw new Error('Invalid PDF: missing %PDF- header');
    }

    this.pos = pdfMarker + 5;

    // Read version (e.g., "1.5")
    let version = '';
    while (this.pos < this.data.length && this.data[this.pos] !== 0x0a && this.data[this.pos] !== 0x0d) {
      version += String.fromCharCode(this.data[this.pos]!);
      this.pos++;
    }

    // Skip ONLY the newline after version (not using skipWhitespace which treats % as comment)
    if (this.data[this.pos] === 0x0d) this.pos++; // CR
    if (this.data[this.pos] === 0x0a) this.pos++; // LF

    // Read binary marker line (should be % followed by high-bit bytes)
    // This is NOT a comment - it's a required binary file indicator
    if (this.data[this.pos] === 0x25) { // %
      this.pos++;
      const markerBytes: number[] = [];
      while (this.pos < this.data.length && this.data[this.pos] !== 0x0a && this.data[this.pos] !== 0x0d) {
        markerBytes.push(this.data[this.pos]!);
        this.pos++;
      }
      return {
        version,
        binaryMarker: new Uint8Array(markerBytes),
        headerOffset: pdfMarker,
      };
    }

    return {
      version,
      binaryMarker: new Uint8Array(0),
      headerOffset: pdfMarker,
    };
  }

  /**
   * Parse xref table and trailer from end of file
   */
  private parseXrefAndTrailer(): { xref: XrefTable; trailer: PdfTrailer } {
    // Find startxref from end of file
    const startxrefPos = this.findSequenceFromEnd(new TextEncoder().encode('startxref'));
    if (startxrefPos === -1) {
      throw new Error('Invalid PDF: missing startxref');
    }

    this.pos = startxrefPos + 9; // skip "startxref"
    this.skipWhitespace();

    const xrefOffset = this.parseInteger();

    // Go to xref
    this.pos = xrefOffset;
    this.skipWhitespace();

    // Check if it's traditional xref table or xref stream
    const nextBytes = this.peekString(4);

    if (nextBytes === 'xref') {
      return this.parseTraditionalXref();
    } else {
      // xref stream (PDF 1.5+)
      return this.parseXrefStream(xrefOffset);
    }
  }

  /**
   * Parse traditional xref table
   */
  private parseTraditionalXref(): { xref: XrefTable; trailer: PdfTrailer } {
    const startOffset = this.pos;
    this.pos += 4; // skip "xref"
    this.skipWhitespace();

    const entries: XrefEntry[] = [];

    // Parse xref sections
    while (true) {
      const peek = this.peekString(7);
      if (peek.startsWith('trailer')) {
        break;
      }

      // Read first object number and count
      const firstObj = this.parseInteger();
      this.skipWhitespace();
      const count = this.parseInteger();
      this.skipWhitespace();

      // Read entries
      for (let i = 0; i < count; i++) {
        const offset = this.parseFixedInteger(10);
        this.skipWhitespace();
        const generation = this.parseFixedInteger(5);
        this.skipWhitespace();
        const flag = String.fromCharCode(this.data[this.pos]!);
        this.pos++;
        this.skipWhitespace();

        entries.push({
          objectNumber: firstObj + i,
          generation,
          offset,
          inUse: flag === 'n',
        });
      }
    }

    // Parse trailer
    this.pos += 7; // skip "trailer"
    this.skipWhitespace();

    const trailerDictStart = this.pos;
    const trailerDict = this.parseDictionary();
    const trailerDictEnd = this.pos;

    const trailer = this.extractTrailer(
      trailerDict,
      new TextDecoder().decode(this.data.slice(trailerDictStart, trailerDictEnd))
    );

    return {
      xref: {
        entries,
        startOffset,
        rawFormat: 'table',
      },
      trailer,
    };
  }

  /**
   * Parse xref stream (PDF 1.5+)
   */
  private parseXrefStream(offset: number): { xref: XrefTable; trailer: PdfTrailer } {
    // For now, we'll implement a basic version
    // Full implementation would decode the stream
    throw new Error('xref stream parsing not yet implemented - document uses PDF 1.5+ xref streams');
  }

  /**
   * Extract trailer information from parsed dictionary
   */
  private extractTrailer(dict: Map<string, PdfValue>, rawContent: string): PdfTrailer {
    const sizeVal = dict.get('Size');
    const rootVal = dict.get('Root');

    if (!sizeVal || sizeVal.type !== 'integer') {
      throw new Error('Invalid trailer: missing Size');
    }
    if (!rootVal || rootVal.type !== 'reference') {
      throw new Error('Invalid trailer: missing Root');
    }

    const trailer: PdfTrailer = {
      size: sizeVal.value,
      root: { objectNumber: rootVal.objectNumber, generation: rootVal.generation },
      rawContent,
    };

    const infoVal = dict.get('Info');
    if (infoVal && infoVal.type === 'reference') {
      trailer.info = { objectNumber: infoVal.objectNumber, generation: infoVal.generation };
    }

    const prevVal = dict.get('Prev');
    if (prevVal && prevVal.type === 'integer') {
      trailer.prev = prevVal.value;
    }

    return trailer;
  }

  /**
   * Parse all objects referenced in xref table
   */
  private parseAllObjects(xref: XrefTable): Map<string, PdfObject | PdfDictionary | PdfStream> {
    const objects = new Map<string, PdfObject | PdfDictionary | PdfStream>();

    for (const entry of xref.entries) {
      if (!entry.inUse || entry.offset === 0) continue;

      try {
        const obj = this.parseObjectAt(entry.offset, entry.objectNumber, entry.generation);
        const key = `${entry.objectNumber} ${entry.generation}`;
        objects.set(key, obj);
      } catch (e) {
        // Some objects may fail to parse - log but continue
        console.warn(`Failed to parse object ${entry.objectNumber} ${entry.generation} at offset ${entry.offset}:`, e);
      }
    }

    return objects;
  }

  /**
   * Parse a single object at given offset
   */
  private parseObjectAt(offset: number, expectedObjNum: number, expectedGen: number): PdfObject | PdfDictionary | PdfStream {
    this.pos = offset;
    this.skipWhitespace();

    // Parse "X Y obj"
    const objNum = this.parseInteger();
    this.skipWhitespace();
    const genNum = this.parseInteger();
    this.skipWhitespace();

    const objKeyword = this.readToken();
    if (objKeyword !== 'obj') {
      throw new Error(`Expected 'obj' at offset ${offset}, got '${objKeyword}'`);
    }
    this.skipWhitespace();

    const contentStart = this.pos;

    // Parse the object content
    const value = this.parseValue();
    this.skipWhitespace();

    // Check if there's a stream
    const nextToken = this.peekString(6);

    if (nextToken === 'stream') {
      // It's a stream object
      if (value.type !== 'dictionary') {
        throw new Error('Stream must be preceded by dictionary');
      }

      this.pos += 6; // skip "stream"
      // Skip single newline (CR, LF, or CRLF)
      if (this.data[this.pos] === 0x0d) this.pos++;
      if (this.data[this.pos] === 0x0a) this.pos++;

      const lengthVal = value.entries.get('Length');
      let streamLength: number;

      if (lengthVal?.type === 'integer') {
        streamLength = lengthVal.value;
      } else if (lengthVal?.type === 'reference') {
        // Length is indirect - we need to look it up
        // For now, find endstream manually
        streamLength = this.findStreamEnd() - this.pos;
      } else {
        streamLength = this.findStreamEnd() - this.pos;
      }

      const streamData = this.data.slice(this.pos, this.pos + streamLength);
      this.pos += streamLength;

      // Skip to endstream
      this.skipWhitespace();
      const endstreamToken = this.readToken();
      if (endstreamToken !== 'endstream') {
        // Try to recover - find endstream
        const endstreamPos = this.findSequence(new TextEncoder().encode('endstream'), this.pos - 20);
        if (endstreamPos !== -1) {
          this.pos = endstreamPos + 9;
        }
      }

      this.skipWhitespace();
      const endobjToken = this.readToken();

      // Extract filters
      const filters: string[] = [];
      const filterVal = value.entries.get('Filter');
      if (filterVal?.type === 'name') {
        filters.push(filterVal.value);
      } else if (filterVal?.type === 'array') {
        for (const f of filterVal.elements) {
          if (f.type === 'name') filters.push(f.value);
        }
      }

      return {
        type: 'stream',
        objectNumber: objNum,
        generation: genNum,
        byteOffset: offset,
        byteLength: this.pos - offset,
        rawContent: this.data.slice(offset, this.pos),
        dictionary: value.entries,
        rawStreamData: streamData,
        filters,
        declaredLength: lengthVal?.type === 'integer' ? lengthVal.value : streamLength,
        actualLength: streamData.length,
      };
    }

    // Regular object (not stream)
    const endobjToken = this.readToken();
    const contentEnd = this.pos;

    if (value.type === 'dictionary') {
      return {
        type: 'dictionary',
        objectNumber: objNum,
        generation: genNum,
        byteOffset: offset,
        byteLength: contentEnd - offset,
        rawContent: this.data.slice(offset, contentEnd),
        entries: value.entries,
        dictType: value.entries.get('Type')?.type === 'name'
          ? value.entries.get('Type')?.value as string
          : undefined,
      };
    }

    return {
      objectNumber: objNum,
      generation: genNum,
      byteOffset: offset,
      byteLength: contentEnd - offset,
      rawContent: this.data.slice(offset, contentEnd),
    };
  }

  /**
   * Find end of stream by looking for 'endstream' keyword
   */
  private findStreamEnd(): number {
    const endstream = new TextEncoder().encode('endstream');
    const pos = this.findSequence(endstream, this.pos);
    if (pos === -1) {
      throw new Error('Could not find endstream');
    }
    // Back up over any whitespace before endstream
    let end = pos;
    while (end > this.pos && WHITESPACE.has(this.data[end - 1]!)) {
      end--;
    }
    return end;
  }

  /**
   * Parse a PDF value (any type)
   */
  private parseValue(): PdfValue {
    this.skipWhitespace();

    const byte = this.data[this.pos];
    if (byte === undefined) {
      throw new Error('Unexpected end of data');
    }

    // Dictionary or hex string
    if (byte === 0x3c) { // <
      if (this.data[this.pos + 1] === 0x3c) { // <<
        const entries = this.parseDictionary();
        return { type: 'dictionary', entries };
      } else {
        return this.parseHexString();
      }
    }

    // Literal string
    if (byte === 0x28) { // (
      return this.parseLiteralString();
    }

    // Array
    if (byte === 0x5b) { // [
      return this.parseArray();
    }

    // Name
    if (byte === 0x2f) { // /
      return this.parseName();
    }

    // Number or reference
    if (this.isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      return this.parseNumberOrReference();
    }

    // Keywords: true, false, null
    const token = this.peekToken();
    if (token === 'true') {
      this.pos += 4;
      return { type: 'boolean', value: true };
    }
    if (token === 'false') {
      this.pos += 5;
      return { type: 'boolean', value: false };
    }
    if (token === 'null') {
      this.pos += 4;
      return { type: 'null' };
    }

    throw new Error(`Unexpected character at position ${this.pos}: 0x${byte.toString(16)}`);
  }

  /**
   * Parse a dictionary << ... >>
   */
  private parseDictionary(): Map<string, PdfValue> {
    if (this.data[this.pos] !== 0x3c || this.data[this.pos + 1] !== 0x3c) {
      throw new Error('Expected dictionary start <<');
    }
    this.pos += 2;

    const entries = new Map<string, PdfValue>();

    while (true) {
      this.skipWhitespace();

      // Check for end of dictionary
      if (this.data[this.pos] === 0x3e && this.data[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }

      // Parse key (must be name)
      const key = this.parseName();
      if (key.type !== 'name') {
        throw new Error('Dictionary key must be a name');
      }

      this.skipWhitespace();

      // Parse value
      const value = this.parseValue();
      entries.set(key.value, value);
    }

    return entries;
  }

  /**
   * Parse an array [ ... ]
   */
  private parseArray(): PdfValue {
    if (this.data[this.pos] !== 0x5b) {
      throw new Error('Expected array start [');
    }
    this.pos++;

    const elements: PdfValue[] = [];

    while (true) {
      this.skipWhitespace();

      if (this.data[this.pos] === 0x5d) { // ]
        this.pos++;
        break;
      }

      elements.push(this.parseValue());
    }

    return { type: 'array', elements };
  }

  /**
   * Parse a name object /Name
   */
  private parseName(): PdfValue {
    if (this.data[this.pos] !== 0x2f) {
      throw new Error('Expected name start /');
    }
    this.pos++;

    let name = '';
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos]!;
      if (WHITESPACE.has(byte) || DELIMITERS.has(byte)) {
        break;
      }
      // Handle #XX escape sequences
      if (byte === 0x23 && this.pos + 2 < this.data.length) {
        const hex = String.fromCharCode(this.data[this.pos + 1]!, this.data[this.pos + 2]!);
        name += String.fromCharCode(parseInt(hex, 16));
        this.pos += 3;
      } else {
        name += String.fromCharCode(byte);
        this.pos++;
      }
    }

    return { type: 'name', value: name };
  }

  /**
   * Parse a literal string (...)
   */
  private parseLiteralString(): PdfValue {
    if (this.data[this.pos] !== 0x28) {
      throw new Error('Expected literal string start (');
    }
    this.pos++;

    const bytes: number[] = [];
    let depth = 1;

    while (this.pos < this.data.length && depth > 0) {
      const byte = this.data[this.pos]!;

      if (byte === 0x5c) { // backslash escape
        this.pos++;
        const next = this.data[this.pos];
        if (next === undefined) break;

        switch (next) {
          case 0x6e: bytes.push(0x0a); break; // \n
          case 0x72: bytes.push(0x0d); break; // \r
          case 0x74: bytes.push(0x09); break; // \t
          case 0x62: bytes.push(0x08); break; // \b
          case 0x66: bytes.push(0x0c); break; // \f
          case 0x28: bytes.push(0x28); break; // \(
          case 0x29: bytes.push(0x29); break; // \)
          case 0x5c: bytes.push(0x5c); break; // \\
          case 0x0a: break; // line continuation (LF)
          case 0x0d: // line continuation (CR or CRLF)
            if (this.data[this.pos + 1] === 0x0a) this.pos++;
            break;
          default:
            // Octal escape
            if (this.isOctalDigit(next)) {
              let octal = String.fromCharCode(next);
              if (this.isOctalDigit(this.data[this.pos + 1])) {
                this.pos++;
                octal += String.fromCharCode(this.data[this.pos]!);
                if (this.isOctalDigit(this.data[this.pos + 1])) {
                  this.pos++;
                  octal += String.fromCharCode(this.data[this.pos]!);
                }
              }
              bytes.push(parseInt(octal, 8));
            } else {
              bytes.push(next);
            }
        }
        this.pos++;
      } else if (byte === 0x28) { // (
        depth++;
        bytes.push(byte);
        this.pos++;
      } else if (byte === 0x29) { // )
        depth--;
        if (depth > 0) bytes.push(byte);
        this.pos++;
      } else {
        bytes.push(byte);
        this.pos++;
      }
    }

    return {
      type: 'string',
      value: new TextDecoder('latin1').decode(new Uint8Array(bytes)),
      encoding: 'literal',
    };
  }

  /**
   * Parse a hex string <...>
   */
  private parseHexString(): PdfValue {
    if (this.data[this.pos] !== 0x3c) {
      throw new Error('Expected hex string start <');
    }
    this.pos++;

    let hex = '';
    while (this.pos < this.data.length && this.data[this.pos] !== 0x3e) {
      const byte = this.data[this.pos]!;
      if (!WHITESPACE.has(byte)) {
        hex += String.fromCharCode(byte);
      }
      this.pos++;
    }
    this.pos++; // skip >

    // Pad with 0 if odd length
    if (hex.length % 2 === 1) hex += '0';

    // Convert to bytes then to string
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.slice(i, i + 2), 16));
    }

    return {
      type: 'string',
      value: new TextDecoder('latin1').decode(new Uint8Array(bytes)),
      encoding: 'hex',
    };
  }

  /**
   * Parse a number (integer or real) or a reference (X Y R)
   */
  private parseNumberOrReference(): PdfValue {
    const startPos = this.pos;

    // Parse first number
    const num1 = this.parseNumber();
    const savedPos = this.pos;

    this.skipWhitespace();

    // Check if this could be a reference (X Y R)
    if (num1.type === 'integer' && this.isDigit(this.data[this.pos]!)) {
      const num2Pos = this.pos;
      const num2 = this.parseNumber();

      if (num2.type === 'integer') {
        this.skipWhitespace();
        if (this.data[this.pos] === 0x52) { // R
          this.pos++;
          return {
            type: 'reference',
            objectNumber: num1.value,
            generation: num2.value,
          };
        }
      }

      // Not a reference, restore position
      this.pos = savedPos;
    }

    return num1;
  }

  /**
   * Parse a number (integer or real)
   */
  private parseNumber(): { type: 'integer'; value: number } | { type: 'real'; value: number } {
    let str = '';
    let hasDecimal = false;

    // Sign
    if (this.data[this.pos] === 0x2b || this.data[this.pos] === 0x2d) {
      str += String.fromCharCode(this.data[this.pos]!);
      this.pos++;
    }

    // Digits and decimal point
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos]!;
      if (this.isDigit(byte)) {
        str += String.fromCharCode(byte);
        this.pos++;
      } else if (byte === 0x2e && !hasDecimal) {
        str += '.';
        hasDecimal = true;
        this.pos++;
      } else {
        break;
      }
    }

    if (hasDecimal) {
      return { type: 'real', value: parseFloat(str) };
    }
    return { type: 'integer', value: parseInt(str, 10) };
  }

  /**
   * Parse integer of fixed width (for xref table)
   */
  private parseFixedInteger(width: number): number {
    const str = new TextDecoder().decode(this.data.slice(this.pos, this.pos + width));
    this.pos += width;
    return parseInt(str.trim(), 10);
  }

  /**
   * Parse any integer
   */
  private parseInteger(): number {
    let str = '';
    while (this.pos < this.data.length && this.isDigit(this.data[this.pos]!)) {
      str += String.fromCharCode(this.data[this.pos]!);
      this.pos++;
    }
    return parseInt(str, 10);
  }

  // === Utility methods ===

  private skipWhitespace(): void {
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos]!;
      if (WHITESPACE.has(byte)) {
        this.pos++;
      } else if (byte === 0x25) { // % comment
        while (this.pos < this.data.length && this.data[this.pos] !== 0x0a && this.data[this.pos] !== 0x0d) {
          this.pos++;
        }
      } else {
        break;
      }
    }
  }

  private isDigit(byte: number): boolean {
    return byte >= 0x30 && byte <= 0x39;
  }

  private isOctalDigit(byte: number | undefined): boolean {
    return byte !== undefined && byte >= 0x30 && byte <= 0x37;
  }

  private readToken(): string {
    let token = '';
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos]!;
      if (WHITESPACE.has(byte) || DELIMITERS.has(byte)) {
        break;
      }
      token += String.fromCharCode(byte);
      this.pos++;
    }
    return token;
  }

  private peekToken(): string {
    const savedPos = this.pos;
    const token = this.readToken();
    this.pos = savedPos;
    return token;
  }

  private peekString(length: number): string {
    return new TextDecoder().decode(this.data.slice(this.pos, this.pos + length));
  }

  private findSequence(seq: Uint8Array, startFrom: number = 0): number {
    outer: for (let i = startFrom; i <= this.data.length - seq.length; i++) {
      for (let j = 0; j < seq.length; j++) {
        if (this.data[i + j] !== seq[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  private findSequenceFromEnd(seq: Uint8Array): number {
    outer: for (let i = this.data.length - seq.length; i >= 0; i--) {
      for (let j = 0; j < seq.length; j++) {
        if (this.data[i + j] !== seq[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}
