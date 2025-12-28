/**
 * Content Stream Parser
 *
 * Extracts text rendering operators (TJ, Tj, etc.) from PDF content streams.
 * This is where the actual document content lives.
 */

export interface TextOperator {
  type: 'Tj' | 'TJ' | "'" | '"';
  rawBytes: Uint8Array;       // Raw string bytes (for Tj)
  rawArray?: TJArrayElement[]; // Raw array elements (for TJ)
  position: {
    offset: number;           // Byte offset in decompressed stream
    line: number;             // Approximate line number
  };
}

export interface TJArrayElement {
  type: 'string' | 'number';
  rawBytes?: Uint8Array;      // For string elements
  value?: number;             // For number elements (kerning adjustments)
}

export interface TextState {
  font?: string;              // Current font name (from Tf)
  fontSize?: number;          // Current font size
  matrix?: number[];          // Text matrix (from Tm)
  position?: { x: number; y: number }; // From Td, TD
}

export interface ContentStreamAnalysis {
  textOperators: TextOperator[];
  fontUsage: Map<string, number>;  // font name -> usage count
  operatorSequence: string[];      // Sequence of all operators
  textBlocks: TextBlock[];         // BT...ET blocks
}

export interface TextBlock {
  startOffset: number;
  endOffset: number;
  operators: TextOperator[];
  fonts: string[];
}

export class ContentStreamParser {
  private data: Uint8Array;
  private pos: number = 0;
  private text: string;

  constructor(data: Uint8Array) {
    this.data = data;
    this.text = new TextDecoder('latin1').decode(data);
  }

  /**
   * Parse content stream and extract all text operators
   */
  parse(): ContentStreamAnalysis {
    const textOperators: TextOperator[] = [];
    const fontUsage = new Map<string, number>();
    const operatorSequence: string[] = [];
    const textBlocks: TextBlock[] = [];

    let currentBlock: TextBlock | null = null;
    let currentFont: string | undefined;
    let lineNumber = 1;

    this.pos = 0;

    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.pos >= this.text.length) break;

      const startPos = this.pos;

      // Track line numbers
      const newlines = this.text.slice(startPos, this.pos).split('\n').length - 1;
      lineNumber += newlines;

      // Try to parse an operand or operator
      const token = this.parseToken();
      if (!token) break;

      operatorSequence.push(token.type === 'operator' ? token.value : token.type);

      // Handle specific operators
      if (token.type === 'operator') {
        switch (token.value) {
          case 'BT':
            currentBlock = {
              startOffset: startPos,
              endOffset: -1,
              operators: [],
              fonts: [],
            };
            break;

          case 'ET':
            if (currentBlock) {
              currentBlock.endOffset = this.pos;
              textBlocks.push(currentBlock);
              currentBlock = null;
            }
            break;

          case 'Tf': {
            // Font selection: /FontName size Tf
            // We need to look back at the operands
            const match = this.text.slice(Math.max(0, startPos - 100), startPos).match(/\/(\S+)\s+([\d.]+)\s*$/);
            if (match) {
              currentFont = match[1];
              const count = fontUsage.get(currentFont!) ?? 0;
              fontUsage.set(currentFont!, count + 1);
              if (currentBlock && currentFont && !currentBlock.fonts.includes(currentFont)) {
                currentBlock.fonts.push(currentFont);
              }
            }
            break;
          }

          case 'Tj': {
            // Simple text string: (string) Tj
            const stringMatch = this.text.slice(Math.max(0, startPos - 500), startPos).match(/\(([^)]*)\)\s*$/);
            if (stringMatch) {
              const rawString = stringMatch[1]!;
              const rawBytes = this.parseStringBytes(rawString);
              const op: TextOperator = {
                type: 'Tj',
                rawBytes,
                position: { offset: startPos, line: lineNumber },
              };
              textOperators.push(op);
              if (currentBlock) currentBlock.operators.push(op);
            }
            break;
          }

          case 'TJ': {
            // Array of strings and numbers: [(string) num (string) ...] TJ
            const arrayMatch = this.text.slice(Math.max(0, startPos - 2000), startPos).match(/\[([^\]]*)\]\s*$/);
            if (arrayMatch) {
              const arrayContent = arrayMatch[1]!;
              const elements = this.parseTJArray(arrayContent);
              const op: TextOperator = {
                type: 'TJ',
                rawBytes: new Uint8Array(0), // Combine all string bytes
                rawArray: elements,
                position: { offset: startPos, line: lineNumber },
              };

              // Combine all string bytes
              const allBytes: number[] = [];
              for (const el of elements) {
                if (el.type === 'string' && el.rawBytes) {
                  for (const b of el.rawBytes) allBytes.push(b);
                }
              }
              op.rawBytes = new Uint8Array(allBytes);

              textOperators.push(op);
              if (currentBlock) currentBlock.operators.push(op);
            }
            break;
          }

          case "'":
          case '"': {
            // ' and " are text-showing operators with positioning
            // Similar to Tj but with leading/word spacing
            const stringMatch = this.text.slice(Math.max(0, startPos - 500), startPos).match(/\(([^)]*)\)\s*$/);
            if (stringMatch) {
              const rawString = stringMatch[1]!;
              const rawBytes = this.parseStringBytes(rawString);
              const op: TextOperator = {
                type: token.value as "'" | '"',
                rawBytes,
                position: { offset: startPos, line: lineNumber },
              };
              textOperators.push(op);
              if (currentBlock) currentBlock.operators.push(op);
            }
            break;
          }
        }
      }
    }

    return {
      textOperators,
      fontUsage,
      operatorSequence,
      textBlocks,
    };
  }

  /**
   * Parse a single token (operator or operand)
   */
  private parseToken(): { type: 'operator' | 'string' | 'number' | 'name' | 'array'; value: string } | null {
    this.skipWhitespace();
    if (this.pos >= this.text.length) return null;

    const char = this.text[this.pos]!;

    // String
    if (char === '(') {
      const start = this.pos;
      this.skipString();
      return { type: 'string', value: this.text.slice(start, this.pos) };
    }

    // Hex string
    if (char === '<' && this.text[this.pos + 1] !== '<') {
      const start = this.pos;
      this.pos++;
      while (this.pos < this.text.length && this.text[this.pos] !== '>') this.pos++;
      this.pos++;
      return { type: 'string', value: this.text.slice(start, this.pos) };
    }

    // Array
    if (char === '[') {
      const start = this.pos;
      this.skipArray();
      return { type: 'array', value: this.text.slice(start, this.pos) };
    }

    // Name
    if (char === '/') {
      const start = this.pos;
      this.pos++;
      while (this.pos < this.text.length && !this.isWhitespace(this.text[this.pos]!) && !this.isDelimiter(this.text[this.pos]!)) {
        this.pos++;
      }
      return { type: 'name', value: this.text.slice(start, this.pos) };
    }

    // Number
    if (this.isDigit(char) || char === '-' || char === '+' || char === '.') {
      const start = this.pos;
      if (char === '-' || char === '+') this.pos++;
      while (this.pos < this.text.length && (this.isDigit(this.text[this.pos]!) || this.text[this.pos] === '.')) {
        this.pos++;
      }
      return { type: 'number', value: this.text.slice(start, this.pos) };
    }

    // Operator (keyword)
    if (this.isLetter(char)) {
      const start = this.pos;
      while (this.pos < this.text.length && (this.isLetter(this.text[this.pos]!) || this.isDigit(this.text[this.pos]!) || this.text[this.pos] === '*' || this.text[this.pos] === "'")) {
        this.pos++;
      }
      return { type: 'operator', value: this.text.slice(start, this.pos) };
    }

    // Dictionary
    if (char === '<' && this.text[this.pos + 1] === '<') {
      const start = this.pos;
      this.skipDictionary();
      return { type: 'array', value: this.text.slice(start, this.pos) };
    }

    // Unknown - skip
    this.pos++;
    return null;
  }

  /**
   * Parse string bytes from a literal string representation
   */
  private parseStringBytes(str: string): Uint8Array {
    const bytes: number[] = [];
    let i = 0;

    while (i < str.length) {
      if (str[i] === '\\') {
        i++;
        if (i >= str.length) break;

        switch (str[i]) {
          case 'n': bytes.push(0x0a); i++; break;
          case 'r': bytes.push(0x0d); i++; break;
          case 't': bytes.push(0x09); i++; break;
          case 'b': bytes.push(0x08); i++; break;
          case 'f': bytes.push(0x0c); i++; break;
          case '(': bytes.push(0x28); i++; break;
          case ')': bytes.push(0x29); i++; break;
          case '\\': bytes.push(0x5c); i++; break;
          default:
            // Octal escape
            if (str[i]! >= '0' && str[i]! <= '7') {
              let octal = str[i]!;
              i++;
              if (i < str.length && str[i]! >= '0' && str[i]! <= '7') {
                octal += str[i]!;
                i++;
                if (i < str.length && str[i]! >= '0' && str[i]! <= '7') {
                  octal += str[i]!;
                  i++;
                }
              }
              bytes.push(parseInt(octal, 8));
            } else {
              bytes.push(str.charCodeAt(i));
              i++;
            }
        }
      } else {
        bytes.push(str.charCodeAt(i));
        i++;
      }
    }

    return new Uint8Array(bytes);
  }

  /**
   * Parse TJ array elements
   */
  private parseTJArray(content: string): TJArrayElement[] {
    const elements: TJArrayElement[] = [];
    let i = 0;

    while (i < content.length) {
      // Skip whitespace
      while (i < content.length && /\s/.test(content[i]!)) i++;
      if (i >= content.length) break;

      // String
      if (content[i] === '(') {
        const start = i + 1;
        i++;
        let depth = 1;
        while (i < content.length && depth > 0) {
          if (content[i] === '\\') {
            i += 2;
          } else if (content[i] === '(') {
            depth++;
            i++;
          } else if (content[i] === ')') {
            depth--;
            i++;
          } else {
            i++;
          }
        }
        const strContent = content.slice(start, i - 1);
        elements.push({
          type: 'string',
          rawBytes: this.parseStringBytes(strContent),
        });
      }
      // Hex string
      else if (content[i] === '<') {
        const start = i + 1;
        i++;
        while (i < content.length && content[i] !== '>') i++;
        const hex = content.slice(start, i).replace(/\s/g, '');
        const bytes: number[] = [];
        for (let j = 0; j < hex.length; j += 2) {
          bytes.push(parseInt(hex.slice(j, j + 2), 16));
        }
        elements.push({
          type: 'string',
          rawBytes: new Uint8Array(bytes),
        });
        i++;
      }
      // Number
      else if (/[\d.\-+]/.test(content[i]!)) {
        const start = i;
        if (content[i] === '-' || content[i] === '+') i++;
        while (i < content.length && /[\d.]/.test(content[i]!)) i++;
        elements.push({
          type: 'number',
          value: parseFloat(content.slice(start, i)),
        });
      }
      else {
        i++;
      }
    }

    return elements;
  }

  // Helper methods

  private skipWhitespace(): void {
    while (this.pos < this.text.length && this.isWhitespace(this.text[this.pos]!)) {
      this.pos++;
    }
    // Skip comments
    if (this.pos < this.text.length && this.text[this.pos] === '%') {
      while (this.pos < this.text.length && this.text[this.pos] !== '\n' && this.text[this.pos] !== '\r') {
        this.pos++;
      }
      this.skipWhitespace();
    }
  }

  private skipString(): void {
    this.pos++; // skip (
    let depth = 1;
    while (this.pos < this.text.length && depth > 0) {
      if (this.text[this.pos] === '\\') {
        this.pos += 2;
      } else if (this.text[this.pos] === '(') {
        depth++;
        this.pos++;
      } else if (this.text[this.pos] === ')') {
        depth--;
        this.pos++;
      } else {
        this.pos++;
      }
    }
  }

  private skipArray(): void {
    this.pos++; // skip [
    let depth = 1;
    while (this.pos < this.text.length && depth > 0) {
      if (this.text[this.pos] === '[') {
        depth++;
      } else if (this.text[this.pos] === ']') {
        depth--;
      } else if (this.text[this.pos] === '(') {
        this.skipString();
        continue;
      }
      this.pos++;
    }
  }

  private skipDictionary(): void {
    this.pos += 2; // skip <<
    let depth = 1;
    while (this.pos < this.text.length - 1 && depth > 0) {
      if (this.text[this.pos] === '<' && this.text[this.pos + 1] === '<') {
        depth++;
        this.pos += 2;
      } else if (this.text[this.pos] === '>' && this.text[this.pos + 1] === '>') {
        depth--;
        this.pos += 2;
      } else if (this.text[this.pos] === '(') {
        this.skipString();
      } else {
        this.pos++;
      }
    }
  }

  private isWhitespace(c: string): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\0';
  }

  private isDelimiter(c: string): boolean {
    return '()<>[]{}/%'.includes(c);
  }

  private isDigit(c: string): boolean {
    return c >= '0' && c <= '9';
  }

  private isLetter(c: string): boolean {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }
}

/**
 * Analyze text operators for forensic patterns
 */
export function analyzeTextOperators(operators: TextOperator[]): TextOperatorAnalysis {
  // Count operator types
  const typeCounts: Record<string, number> = {};
  for (const op of operators) {
    typeCounts[op.type] = (typeCounts[op.type] ?? 0) + 1;
  }

  // Analyze TJ array patterns (for TJ operators)
  const tjArrayStats: TJArrayStats[] = [];
  for (const op of operators) {
    if (op.type === 'TJ' && op.rawArray) {
      const stringElements = op.rawArray.filter(e => e.type === 'string').length;
      const numberElements = op.rawArray.filter(e => e.type === 'number').length;
      const kerningValues = op.rawArray
        .filter(e => e.type === 'number')
        .map(e => e.value!);

      tjArrayStats.push({
        totalElements: op.rawArray.length,
        stringElements,
        numberElements,
        kerningValues,
        avgKerning: kerningValues.length > 0
          ? kerningValues.reduce((a, b) => a + b, 0) / kerningValues.length
          : 0,
      });
    }
  }

  // String length statistics
  const stringLengths = operators.map(op => op.rawBytes.length);
  const avgStringLength = stringLengths.length > 0
    ? stringLengths.reduce((a, b) => a + b, 0) / stringLengths.length
    : 0;

  return {
    totalOperators: operators.length,
    operatorTypeCounts: typeCounts,
    tjArrayStats,
    stringLengthStats: {
      min: Math.min(...stringLengths),
      max: Math.max(...stringLengths),
      avg: avgStringLength,
    },
  };
}

export interface TextOperatorAnalysis {
  totalOperators: number;
  operatorTypeCounts: Record<string, number>;
  tjArrayStats: TJArrayStats[];
  stringLengthStats: {
    min: number;
    max: number;
    avg: number;
  };
}

export interface TJArrayStats {
  totalElements: number;
  stringElements: number;
  numberElements: number;
  kerningValues: number[];
  avgKerning: number;
}
