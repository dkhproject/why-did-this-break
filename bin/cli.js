#!/usr/bin/env node
/**
 * bin/cli.js
 * CLI runner for why-did-this-break.
 * Zero external dependencies.
 */

const fs = require('fs');
const path = require('path');
const { parseStackTrace } = require('../src/parser');
const { verifyGitRepo, traceFrames } = require('../src/gitTracer');
const { scoreCommits } = require('../src/scorer');
const { formatReport } = require('../src/reporter');

function printUsage() {
  console.log(`
why-did-this-break: Smart Git Line Tracer & Suspect Scoring Engine

Usage:
  why-did-this-break [options] [file-or-stacktrace]
  why-broke [options] [file-or-stacktrace]
  cat error.log | why-did-this-break [options]

Options:
  --all, -a      Show full details for all suspect commits (default: top 3)
  --json         Output raw JSON of ranked suspects
  --debug        Print detailed diff hunks for all displayed suspects
  --help, -h     Show this help message
  --version, -v  Show version

Examples:
  why-broke crash.log
  why-did-this-break --all crash.log
  why-did-this-break "Error: crash\\n at src/index.js:15:3"
  npm test 2>&1 | why-broke
  node app.js 2>&1 | why-did-this-break --json
`);
}

/**
 * Reads all content from stdin if available.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      resolve(data.trim());
    });

    // Timeout fallback if no input received
    setTimeout(() => {
      if (!data) resolve('');
    }, 1500);
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    const pkg = require('../package.json');
    console.log(`why-did-this-break v${pkg.version}`);
    process.exit(0);
  }

  const isJson = args.includes('--json');
  const isDebug = args.includes('--debug');
  const isAll = args.includes('--all') || args.includes('-a');

  const nonFlagArgs = args.filter(a => !a.startsWith('-'));

  let input = '';

  if (nonFlagArgs.length > 0) {
    const candidatePath = path.resolve(process.cwd(), nonFlagArgs[0]);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      input = fs.readFileSync(candidatePath, 'utf8');
    } else {
      input = nonFlagArgs.join('\n');
    }
  }

  // If no CLI argument, try reading from stdin
  if (!input) {
    input = await readStdin();
  }

  if (!input) {
    console.error('Error: No stack trace provided via stdin or argument.');
    printUsage();
    process.exit(1);
  }

  // 1. Verify Git Repository
  const gitRoot = verifyGitRepo(process.cwd(), true);

  // 2. Parse Stack Trace Frames
  const frames = parseStackTrace(input);

  if (frames.length === 0) {
    console.error('Warning: Could not parse any stack frames from the provided input.');
    if (isJson) {
      console.log(JSON.stringify({ frames: [], suspects: [] }, null, 2));
    }
    process.exit(0);
  }

  // 3. Trace Git Commits per Frame
  const { traces } = traceFrames(frames, { cwd: process.cwd() });

  // 4. Score Suspect Commits
  const suspects = scoreCommits(traces);

  // 5. Output
  if (isJson) {
    console.log(JSON.stringify({
      gitRoot,
      framesCount: frames.length,
      frames,
      suspectsCount: suspects.length,
      suspects,
    }, null, 2));
    return;
  }

  // Formatted Terminal Output
  console.log(
    formatReport(
      { gitRoot, frames, suspects },
      { showAll: isAll, debug: isDebug }
    )
  );
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
