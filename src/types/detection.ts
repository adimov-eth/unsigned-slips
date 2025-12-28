/**
 * Detection Types
 *
 * Types for the forgery detection system - results, reports, and severity levels.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface DetectionResult {
  passed: boolean;
  ruleId: string;
  ruleName: string;
  severity: Severity;
  message: string;
  details?: Record<string, unknown>;
}

export interface VerificationReport {
  filePath: string;
  sha256: string;
  timestamp: string;
  bankId: string;
  bankName: string;
  verdict: 'authentic' | 'suspicious' | 'forged' | 'unknown_bank';
  confidence: number; // 0-100
  score: number; // 0-100 (higher = more likely authentic)
  results: DetectionResult[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    passed: number;
  };
}
