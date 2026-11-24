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

function printUsage() {
  console.log(`
why-did-this-break: Smart Git Line Tracer & Suspect Scoring Engine

Usage:
  why-did-this-break [options] [file-or-stacktrace]
  cat error.log | why-did-this-break [options]

Options:
  --json       Output raw JSON of ranked suspects
  --debug      Print detailed frame-by-frame debug tracing info
  --help, -h   Show this help message
  --version    Show version

Examples:
  why-did-this-break crash.log
  why-did-this-break "Error: crash\\n at src/index.js:15:3"
  git log -n 1 --stat | why-did-this-break
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
  console.log('\n' + '='.repeat(68));
  console.log(' WHY DID THIS BREAK? (Git Line Tracer & Suspect Scoring Engine)');
  console.log('='.repeat(68));
  console.log(`Git Repository: ${gitRoot}`);
  console.log(`Parsed Stack Frames: ${frames.length}\n`);

  console.log('STACK TRACE FRAMES:');
  frames.forEach((f) => {
    const originLabel = f.frameIndex === 0 ? ' [CRASH ORIGIN]' : '';
    console.log(`  Frame #${f.frameIndex}${originLabel}: ${f.file}:${f.line}${f.method ? ' (' + f.method + ')' : ''}`);
  });

  console.log('\n' + '-'.repeat(68));
  console.log(`RANKED SUSPECT COMMITS (${suspects.length} suspect${suspects.length === 1 ? '' : 's'} identified):`);
  console.log('-'.repeat(68));

  if (suspects.length === 0) {
    console.log('  No matching git commits found for the parsed stack trace lines.');
    console.log('  (Ensure the stack trace files exist locally and are tracked in git)\n');
    return;
  }

  suspects.forEach((suspect, idx) => {
    const rank = idx + 1;
    const scoreColor = suspect.score >= 70 ? 'CRITICAL' : (suspect.score >= 40 ? 'HIGH' : 'MEDIUM');
    console.log(`\n#${rank} [SUSPICION SCORE: ${suspect.score}/100 - ${scoreColor}]`);
    console.log(`   Commit:  ${suspect.shortHash} (${suspect.hash})`);
    console.log(`   Author:  ${suspect.author}`);
    console.log(`   Date:    ${suspect.date} (${suspect.relativeTime})`);
    console.log(`   Message: ${suspect.message.split('\n')[0]}`);

    console.log('   Why Suspect:');
    suspect.reasons.forEach(r => console.log(`     • ${r}`));

    console.log('   Locations Touched:');
    suspect.framesTouched.forEach(f => {
      const blameTag = f.isBlame ? ' (active blame)' : '';
      console.log(`     - Frame #${f.frameIndex}: ${f.file}:${f.line}${blameTag}`);
    });

    if (suspect.diff && (isDebug || rank === 1)) {
      console.log('   Diff Hunk:');
      const diffLines = suspect.diff.split('\n').slice(0, 8);
      diffLines.forEach(dl => console.log(`     | ${dl}`));
      if (suspect.diff.split('\n').length > 8) {
        console.log('     | ... (more lines omitted)');
      }
    }
  });

  console.log('\n' + '='.repeat(68) + '\n');
}

main().catch((err) => {
  console.error('Fatal Error:', err);
  process.exit(1);
});
