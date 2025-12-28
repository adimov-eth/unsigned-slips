#!/usr/bin/env bun
/**
 * PDF Verification CLI
 *
 * Analyzes a PDF against auto-detected bank profile and reports
 * detection results with verdicts.
 *
 * Usage:
 *   bun run verify <pdf-file> [--json] [--verbose] [--bank <id>]
 */

import { ArtifactGenerator } from '../artifacts/generator.js';
import { verify, type VerificationReport, type Severity } from '../verifier/detector.js';
import { getProfile, getAllProfiles } from '../banks/index.js';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function severityColor(severity: Severity): string {
  switch (severity) {
    case 'critical': return COLORS.red;
    case 'high': return COLORS.magenta;
    case 'medium': return COLORS.yellow;
    case 'low': return COLORS.cyan;
    case 'info': return COLORS.dim;
  }
}

function verdictDisplay(verdict: string): string {
  switch (verdict) {
    case 'authentic':
      return `${COLORS.green}${COLORS.bold}✓ AUTHENTIC${COLORS.reset}`;
    case 'suspicious':
      return `${COLORS.yellow}${COLORS.bold}⚠ SUSPICIOUS${COLORS.reset}`;
    case 'forged':
      return `${COLORS.red}${COLORS.bold}✗ FORGED${COLORS.reset}`;
    case 'unknown_bank':
      return `${COLORS.cyan}${COLORS.bold}? UNKNOWN BANK${COLORS.reset}`;
    default:
      return verdict;
  }
}

function printReport(report: VerificationReport, verbose: boolean): void {
  console.log('\n' + '═'.repeat(60));
  console.log(`${COLORS.bold}PDF VERIFICATION REPORT${COLORS.reset}`);
  console.log('═'.repeat(60));

  console.log(`\nFile: ${report.filePath}`);
  console.log(`SHA256: ${report.sha256.substring(0, 16)}...`);
  console.log(`Analyzed: ${report.timestamp}`);
  console.log(`Bank: ${COLORS.cyan}${report.bankName}${COLORS.reset} (${report.bankId})`);

  console.log('\n' + '─'.repeat(60));
  console.log(`\nVerdict: ${verdictDisplay(report.verdict)}`);
  console.log(`Score: ${report.score}/100`);
  console.log(`Confidence: ${report.confidence}%`);

  console.log('\n' + '─'.repeat(60));
  console.log(`${COLORS.bold}Detection Summary${COLORS.reset}`);
  console.log('─'.repeat(60));

  if (report.summary.critical > 0) {
    console.log(`  ${COLORS.red}● Critical: ${report.summary.critical}${COLORS.reset}`);
  }
  if (report.summary.high > 0) {
    console.log(`  ${COLORS.magenta}● High: ${report.summary.high}${COLORS.reset}`);
  }
  if (report.summary.medium > 0) {
    console.log(`  ${COLORS.yellow}● Medium: ${report.summary.medium}${COLORS.reset}`);
  }
  if (report.summary.low > 0) {
    console.log(`  ${COLORS.cyan}● Low: ${report.summary.low}${COLORS.reset}`);
  }
  console.log(`  ${COLORS.green}● Passed: ${report.summary.passed}${COLORS.reset}`);

  // Show failed checks
  const failures = report.results.filter(r => !r.passed);
  if (failures.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log(`${COLORS.bold}Failed Checks${COLORS.reset}`);
    console.log('─'.repeat(60));

    for (const result of failures) {
      const color = severityColor(result.severity);
      console.log(`\n  ${color}[${result.severity.toUpperCase()}]${COLORS.reset} ${result.ruleName}`);
      console.log(`    ${result.message}`);

      if (verbose && result.details) {
        console.log(`    ${COLORS.dim}Details: ${JSON.stringify(result.details, null, 2).replace(/\n/g, '\n    ')}${COLORS.reset}`);
      }
    }
  }

  // Show passed checks if verbose
  if (verbose) {
    const passed = report.results.filter(r => r.passed);
    if (passed.length > 0) {
      console.log('\n' + '─'.repeat(60));
      console.log(`${COLORS.bold}Passed Checks${COLORS.reset}`);
      console.log('─'.repeat(60));

      for (const result of passed) {
        console.log(`  ${COLORS.green}✓${COLORS.reset} ${result.ruleName}`);
      }
    }
  }

  console.log('\n' + '═'.repeat(60) + '\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    const banks = getAllProfiles();
    console.log(`
${COLORS.bold}PDF Verification Tool${COLORS.reset}

Analyzes PDF receipts against bank baselines to detect forgeries.
Auto-detects bank from PDF structure, or specify explicitly.

${COLORS.bold}Usage:${COLORS.reset}
  bun run verify <pdf-file> [options]

${COLORS.bold}Options:${COLORS.reset}
  --json          Output raw JSON report
  --verbose       Show all checks and details
  --bank <id>     Force specific bank profile
  --list-banks    List all supported banks
  --help          Show this help

${COLORS.bold}Supported Banks:${COLORS.reset}
${banks.map(b => `  ${b.id.padEnd(10)} ${b.fullName}`).join('\n')}

${COLORS.bold}Examples:${COLORS.reset}
  bun run verify ../input/receipt.pdf
  bun run verify ../input/receipt.pdf --verbose
  bun run verify ../input/receipt.pdf --json > report.json
  bun run verify ../input/receipt.pdf --bank rshb
`);
    process.exit(0);
  }

  if (args.includes('--list-banks')) {
    const banks = getAllProfiles();
    console.log(`\n${COLORS.bold}Supported Banks:${COLORS.reset}\n`);
    for (const bank of banks) {
      console.log(`  ${COLORS.cyan}${bank.id}${COLORS.reset}`);
      console.log(`    Name: ${bank.fullName}`);
      console.log(`    Version: ${bank.version}`);
      console.log(`    Samples: ${bank.sampleCount}`);
      if (bank.limitations?.length) {
        console.log(`    Limitations:`);
        for (const lim of bank.limitations) {
          console.log(`      - ${lim}`);
        }
      }
      console.log('');
    }
    process.exit(0);
  }

  const pdfPath = args.find(a => !a.startsWith('--'));
  const jsonOutput = args.includes('--json');
  const verbose = args.includes('--verbose');

  // Check for explicit bank
  const bankIndex = args.indexOf('--bank');
  const explicitBankId = bankIndex !== -1 ? args[bankIndex + 1] : undefined;

  if (!pdfPath) {
    console.error('Error: No PDF file specified');
    process.exit(1);
  }

  try {
    // Check if file exists
    const file = Bun.file(pdfPath);
    if (!await file.exists()) {
      console.error(`Error: File not found: ${pdfPath}`);
      process.exit(1);
    }

    if (!jsonOutput) {
      console.log(`\n⏳ Analyzing: ${pdfPath}`);
    }

    // Generate artifacts
    const artifacts = await ArtifactGenerator.generate(pdfPath);

    // Get explicit profile if specified
    let explicitProfile;
    if (explicitBankId) {
      explicitProfile = getProfile(explicitBankId);
      if (!explicitProfile) {
        console.error(`Error: Unknown bank profile: ${explicitBankId}`);
        console.error(`Use --list-banks to see available profiles`);
        process.exit(1);
      }
    }

    // Run verification
    const report = verify(artifacts, explicitProfile);

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report, verbose);
    }

    // Exit with appropriate code
    if (report.verdict === 'forged') {
      process.exit(2);
    } else if (report.verdict === 'suspicious') {
      process.exit(1);
    } else if (report.verdict === 'unknown_bank') {
      process.exit(3);
    } else {
      process.exit(0);
    }

  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

main();
