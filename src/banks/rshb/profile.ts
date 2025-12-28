/**
 * RSHB (Rosselhozbank) Bank Profile
 *
 * Reference implementation for bank profiles.
 * Based on analysis of 4+ authentic samples.
 */

import type { BankProfile } from '../../types/bank-profile.js';
import { rshbCustomChecks } from './checks.js';

export const rshbProfile: BankProfile = {
  id: 'rshb',
  name: 'RSHB',
  fullName: 'Rosselhozbank (Россельхозбанк)',

  generatorSignature: {
    binaryMarker: 'e2e3cfd3',
    pdfVersion: '1.5',
    producer: 'OpenPDF 1.3.32',
    creator: /JasperReports Library version/,
  },

  structuralInvariants: {
    xrefFormat: 'table',
    zlibHeader: '78:9c',
    fontDistribution: {
      Type1: 1,
      Type0: 2,
      CIDFontType2: 2,
    },
    fontCount: 5,
  },

  encodingProfile: {
    glyphEncodedPunctuation: ['.', ',', ':', '*', '-'],
    minGlyphEscapes: 1,
    escapePattern: /\[0[0-9a-f]+\]/gi,
  },

  ranges: {
    objectCount: [28, 40],
    streamCount: [15, 20],
    cmapEntries: [20, 120],
    glyphIdMin: [1, 20],
  },

  customChecks: rshbCustomChecks,

  sampleCount: 4,
  lastUpdated: '2025-12-28',
  version: '2.0',

  limitations: [
    'Cannot detect edits where attacker also updates creation date',
    'Cannot detect if original and edited amounts use same digits',
    'Template version changes may require profile updates',
  ],
};
