/**
 * Bank Registry
 *
 * Central registry for all supported bank profiles.
 * Provides auto-detection based on generator signatures.
 */

import type { BankProfile } from '../types/bank-profile.js';
import type { PdfArtifacts } from '../artifacts/generator.js';
import { rshbProfile } from './rshb/profile.js';

/** All registered bank profiles */
const profiles: Map<string, BankProfile> = new Map();

// Register known banks
profiles.set('rshb', rshbProfile);

/**
 * Get a bank profile by ID
 */
export function getProfile(bankId: string): BankProfile | undefined {
  return profiles.get(bankId);
}

/**
 * Get all registered bank profiles
 */
export function getAllProfiles(): BankProfile[] {
  return Array.from(profiles.values());
}

/**
 * Register a new bank profile
 */
export function registerProfile(profile: BankProfile): void {
  profiles.set(profile.id, profile);
}

/**
 * Auto-detect bank from PDF artifacts
 *
 * Matches against generator signatures (binary marker, producer, etc.)
 * Returns the first matching profile, or undefined if no match.
 */
export function detectBank(artifacts: PdfArtifacts): BankProfile | undefined {
  for (const profile of profiles.values()) {
    if (matchesProfile(artifacts, profile)) {
      return profile;
    }
  }
  return undefined;
}

/**
 * Check if artifacts match a bank profile's generator signature
 */
function matchesProfile(artifacts: PdfArtifacts, profile: BankProfile): boolean {
  const sig = profile.generatorSignature;

  // Binary marker must match exactly
  if (artifacts.structure.binaryMarkerHex !== sig.binaryMarker) {
    return false;
  }

  // PDF version must match
  if (artifacts.structure.pdfVersion !== sig.pdfVersion) {
    return false;
  }

  // Producer must match (string or regex)
  if (sig.producer) {
    const producer = artifacts.metadata.producer ?? '';
    if (typeof sig.producer === 'string') {
      if (producer !== sig.producer) {
        return false;
      }
    } else if (!sig.producer.test(producer)) {
      return false;
    }
  }

  // Creator pattern (optional)
  if (sig.creator) {
    const creator = artifacts.metadata.creator ?? '';
    if (typeof sig.creator === 'string') {
      if (!creator.includes(sig.creator)) {
        return false;
      }
    } else if (!sig.creator.test(creator)) {
      return false;
    }
  }

  return true;
}

/**
 * Get detection summary for unknown bank
 */
export function getUnknownBankInfo(artifacts: PdfArtifacts): {
  binaryMarker: string;
  pdfVersion: string;
  producer?: string;
  creator?: string;
  suggestion: string;
} {
  return {
    binaryMarker: artifacts.structure.binaryMarkerHex,
    pdfVersion: artifacts.structure.pdfVersion,
    producer: artifacts.metadata.producer,
    creator: artifacts.metadata.creator,
    suggestion: 'This PDF does not match any known bank profile. ' +
      'You may need to create a new profile or the document may be from an unsupported bank.',
  };
}
