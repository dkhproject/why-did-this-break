/**
 * test/test.js
 * Comprehensive test suite for why-did-this-break using Node.js built-in assert.
 * Zero external dependencies.
 */

const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { parseStackTrace } = require('../src/parser');
const { isGitRepo, getGitRoot, verifyGitRepo, traceFrames } = require('../src/gitTracer');
const { scoreCommits, calculateCommitScore } = require('../src/scorer');
const { formatReport, colorizeDiff } = require('../src/reporter');

console.log('--- Starting why-did-this-break Test Suite ---');

// ==========================================
// Test 1: Parser Tests
// ==========================================
console.log('1. Testing Stack Trace Parser...');

const nodeTrace = `
TypeError: Cannot read properties of undefined (reading 'split')
    at processData (src/utils/data.js:42:15)
    at Object.handler (src/handlers/api.js:88:20)
    at async Server.onRequest (src/server.js:105:5)
    at node:internal/process/task_queues:95:5
`;

const parsedNode = parseStackTrace(nodeTrace);
assert.strictEqual(parsedNode.length, 4, 'Should parse 4 frames from Node trace');
assert.strictEqual(parsedNode[0].file, path.normalize('src/utils/data.js'));
assert.strictEqual(parsedNode[0].line, 42);
assert.strictEqual(parsedNode[0].col, 15);
assert.strictEqual(parsedNode[0].method, 'processData');
assert.strictEqual(parsedNode[0].frameIndex, 0);
assert.strictEqual(parsedNode[0].isInternal, false);

assert.strictEqual(parsedNode[3].isInternal, true, 'node:internal should be marked internal');

const pythonTrace = `
Traceback (most recent call last):
  File "app/main.py", line 12, in run
    do_calculation()
  File "app/calc.py", line 55, in do_calculation
    return 1 / 0
ZeroDivisionError: division by zero
`;

const parsedPy = parseStackTrace(pythonTrace);
assert.strictEqual(parsedPy.length, 2, 'Should parse 2 frames from Python trace');
assert.strictEqual(parsedPy[0].file, path.normalize('app/main.py'));
assert.strictEqual(parsedPy[0].line, 12);
assert.strictEqual(parsedPy[1].file, path.normalize('app/calc.py'));
assert.strictEqual(parsedPy[1].line, 55);

console.log('   ✓ Parser successfully handles Node.js and Python stack traces.');

// ==========================================
// Test 2: Scorer Tests (Unit)
// ==========================================
console.log('2. Testing Suspect Scorer Engine...');

const now = 1700000000;

// Test commit touching Frame 0, recent (<24h), with blame
const recentFrame0Commit = {
  hash: 'aaaa111122223333444455556666777788889999',
  shortHash: 'aaaa111',
  author: 'Alice <alice@test.com>',
  date: '2023-11-14T12:00:00Z',
  timestamp: now - 3600, // 1 hour ago
  message: 'refactor data parsing',
  frames: [{ frameIndex: 0, file: 'src/data.js', line: 10, isBlame: true }],
  distinctFrames: new Set([0]),
  distinctFiles: new Set(['src/data.js']),
  minFrameIndex: 0,
  isBlameFrame0: true,
  isBlameAny: true,
};

const scoreResult1 = calculateCommitScore(recentFrame0Commit, now);
assert(scoreResult1.score >= 80, `Frame 0 recent commit should score high (got ${scoreResult1.score})`);
assert.strictEqual(scoreResult1.scoreBreakdown.proximityScore, 40, 'Frame 0 blame should get 40 proximity points');
assert.strictEqual(scoreResult1.scoreBreakdown.blameScore, 15, 'Frame 0 blame should get 15 blame bonus points');
assert.strictEqual(scoreResult1.scoreBreakdown.recencyScore, 30, 'Within 24h should get 30 recency points');

// Test older commit touching deep frame
const oldDeepCommit = {
  hash: 'bbbb111122223333444455556666777788889999',
  shortHash: 'bbbb111',
  author: 'Bob <bob@test.com>',
  date: '2020-01-01T00:00:00Z',
  timestamp: now - (100 * 24 * 3600), // 100 days ago
  message: 'initial legacy setup',
  frames: [{ frameIndex: 4, file: 'src/server.js', line: 100, isBlame: false }],
  distinctFrames: new Set([4]),
  distinctFiles: new Set(['src/server.js']),
  minFrameIndex: 4,
  isBlameFrame0: false,
  isBlameAny: false,
};

const scoreResult2 = calculateCommitScore(oldDeepCommit, now);
assert(scoreResult2.score < 25, `Old deep commit should have low score (got ${scoreResult2.score})`);

// Test multi-frame overlap
const multiFrameCommit = {
  hash: 'cccc111122223333444455556666777788889999',
  shortHash: 'cccc111',
  author: 'Charlie <charlie@test.com>',
  date: '2023-11-14T10:00:00Z',
  timestamp: now - 7200,
  message: 'update signatures across multiple files',
  frames: [
    { frameIndex: 0, file: 'src/data.js', line: 10, isBlame: false },
    { frameIndex: 1, file: 'src/api.js', line: 20, isBlame: false },
    { frameIndex: 2, file: 'src/server.js', line: 30, isBlame: false },
  ],
  distinctFrames: new Set([0, 1, 2]),
  distinctFiles: new Set(['src/data.js', 'src/api.js', 'src/server.js']),
  minFrameIndex: 0,
  isBlameFrame0: false,
  isBlameAny: false,
};

const scoreResult3 = calculateCommitScore(multiFrameCommit, now);
assert.strictEqual(scoreResult3.scoreBreakdown.overlapScore, 15, '3+ frames overlap should get 15 points');

console.log('   ✓ Scorer correctly ranks proximity, recency, and multi-frame overlap.');

// ==========================================
// Test 3: Real Git Line Tracer & End-to-End CLI
// ==========================================
console.log('3. Testing Git Line Tracer with a live git repository...');

const tempDir = fs.mkdtempSync(path.join('/tmp', 'wdtb-test-'));

try {
  execSync('git init', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.name "Tester"', { cwd: tempDir, stdio: 'ignore' });
  execSync('git config user.email "tester@test.com"', { cwd: tempDir, stdio: 'ignore' });

  // Commit 1: Initial creation of auth.js
  const authCodeV1 = `function authenticateUser(token) {
  if (!token) return false;
  return verifyToken(token);
}
function verifyToken(token) {
  return token === "valid-secret";
}
module.exports = { authenticateUser };
`;
  fs.writeFileSync(path.join(tempDir, 'auth.js'), authCodeV1);
  execSync('git add auth.js', { cwd: tempDir, stdio: 'ignore' });
  execSync('git commit -m "feat: initial auth module"', { cwd: tempDir, stdio: 'ignore' });

  // Commit 2: Introduced a breaking bug in verifyToken (line 6)
  const authCodeV2 = `function authenticateUser(token) {
  if (!token) return false;
  return verifyToken(token);
}
function verifyToken(token) {
  return token.signatures.match(/secret/); // BUG: token.signatures is undefined!
}
module.exports = { authenticateUser };
`;
  fs.writeFileSync(path.join(tempDir, 'auth.js'), authCodeV2);
  execSync('git commit -am "refactor: optimize token signature matching"', { cwd: tempDir, stdio: 'ignore' });

  // Test gitTracer directly
  const framesToTest = [
    { file: 'auth.js', line: 6, frameIndex: 0 },
    { file: 'auth.js', line: 3, frameIndex: 1 },
  ];

  const traceOutput = traceFrames(framesToTest, { cwd: tempDir });
  assert.strictEqual(traceOutput.traces.length, 2, 'Should trace both frames');
  assert(traceOutput.traces[0].commits.length > 0, 'Frame 0 should have commit history');

  const culpritCommit = traceOutput.traces[0].commits.find(c => c.message.includes('optimize token signature matching'));
  assert(culpritCommit, 'Should identify the bug-introducing commit');
  assert.strictEqual(culpritCommit.isBlame, true, 'Culprit commit should be blamed for line 6');

  // Test scorer on traced output
  const ranked = scoreCommits(traceOutput, { now: Math.floor(Date.now() / 1000) });
  assert(ranked.length > 0, 'Should produce ranked suspects');
  assert.strictEqual(ranked[0].shortHash, culpritCommit.shortHash, 'Culprit commit should be #1 ranked suspect');
  assert(ranked[0].score >= 80, `Culprit score should be high (got ${ranked[0].score})`);

  // Test CLI with stdin and --json flag
  const cliPath = path.resolve(__dirname, '../bin/cli.js');
  const crashStackTrace = `
TypeError: Cannot read properties of undefined (reading 'match')
    at verifyToken (auth.js:6:26)
    at authenticateUser (auth.js:3:10)
    at Object.<anonymous> (server.js:15:1)
  `;

  const cliOutput = execSync(`node "${cliPath}" --json`, {
    cwd: tempDir,
    input: crashStackTrace,
    encoding: 'utf8',
  });

  const parsedJson = JSON.parse(cliOutput);
  assert.strictEqual(parsedJson.suspects[0].shortHash, culpritCommit.shortHash, 'CLI JSON should rank culprit #1');

  // Test CLI formatted output
  const cliFormattedOutput = execSync(`node "${cliPath}"`, {
    cwd: tempDir,
    input: crashStackTrace,
    encoding: 'utf8',
  });

  assert(cliFormattedOutput.includes('WHY DID THIS BREAK?'), 'CLI output should include header');
  assert(cliFormattedOutput.includes('RANKED SUSPECT COMMITS'), 'CLI output should include suspects');
  assert(cliFormattedOutput.includes(culpritCommit.shortHash), 'CLI output should display suspect hash');
  assert(cliFormattedOutput.includes('QUICK ACTIONS'), 'CLI output should include Quick Actions box');
  assert(cliFormattedOutput.includes(`git show ${culpritCommit.shortHash}`), 'Quick Actions should include git show');
  assert(cliFormattedOutput.includes(`git revert ${culpritCommit.shortHash}`), 'Quick Actions should include git revert');
  assert(cliFormattedOutput.includes('code -g auth.js:6'), 'Quick Actions should include code -g <file>:<line>');

  console.log('   ✓ Git Line Tracer and CLI successfully pinpointed the breaking commit.');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

// ==========================================
// Test 4: Terminal Reporter & CLI Flags
// ==========================================
console.log('4. Testing Terminal Reporter & CLI Flags...');

const sampleFrames = [
  { file: 'src/auth.js', line: 6, method: 'verifyToken', frameIndex: 0 },
  { file: 'src/auth.js', line: 3, method: 'authenticateUser', frameIndex: 1 },
];

const sampleSuspects = [1, 2, 3, 4].map((n) => ({
  hash: `${n}aaa111122223333444455556666777788889999`,
  shortHash: `${n}aaa111`,
  score: 100 - (n - 1) * 20,
  author: `Dev ${n} <dev${n}@test.com>`,
  date: '2026-11-24T06:15:19Z',
  relativeTime: `${n}h ago`,
  message: `commit message ${n}`,
  diff: `diff --git a/src/auth.js b/src/auth.js\n@@ -6,1 +6,1 @@\n-oldLine(${n})\n+newLine(${n})`,
  reasons: [`Reason for suspect ${n}`],
  framesTouched: [{ frameIndex: n === 1 ? 0 : 1, file: 'src/auth.js', line: n === 1 ? 6 : 3, isBlame: n === 1 }],
}));

const plainReport = formatReport(
  { gitRoot: '/repo', frames: sampleFrames, suspects: sampleSuspects },
  { color: false, showAll: false }
);
assert(!plainReport.includes('\x1b['), 'Plain report with color: false must not contain ANSI escapes');
assert(plainReport.includes('#1 PRIME SUSPECT'), 'Should highlight #1 PRIME SUSPECT');
assert(plainReport.includes('#2 [80/100 CRITICAL] 2aaa111'), 'Should show #2 in compact form');
assert(plainReport.includes('#3 [60/100 HIGH] 3aaa111'), 'Should show #3 in compact form');
assert(!plainReport.includes('4aaa111'), 'Default mode should hide suspect #4');
assert(plainReport.includes('... and 1 more suspect. Run with --all'), 'Should display truncation notice');
assert(plainReport.includes('git show 1aaa111'), 'Quick Actions should include git show');
assert(plainReport.includes('git revert 1aaa111'), 'Quick Actions should include git revert');
assert(plainReport.includes('code -g src/auth.js:6'), 'Quick Actions should include code -g');

const allReport = formatReport(
  { gitRoot: '/repo', frames: sampleFrames, suspects: sampleSuspects },
  { color: false, showAll: true }
);
assert(allReport.includes('4aaa111'), '--all mode should include suspect #4');
assert(allReport.includes('Reason for suspect 4'), '--all mode should show full details for suspect #4');
assert(!allReport.includes('Run with --all'), '--all mode should not show truncation hint');

const coloredReport = formatReport(
  { gitRoot: '/repo', frames: sampleFrames, suspects: sampleSuspects },
  { color: true, showAll: false }
);
assert(coloredReport.includes('\x1b[32m+newLine(1)'), 'Colored diff should style + lines green');
assert(coloredReport.includes('\x1b[31m-oldLine(1)'), 'Colored diff should style - lines red');
assert(coloredReport.includes('\x1b[1m\x1b[31m#1 PRIME SUSPECT'), 'Colored report should highlight #1 Prime Suspect in bold red');

const diffColoredLines = colorizeDiff('+added\n-removed', true);
assert(diffColoredLines[0].includes('\x1b[32m'), 'colorizeDiff should color + green');
assert(diffColoredLines[1].includes('\x1b[31m'), 'colorizeDiff should color - red');

// CLI flags checks (--help, --version, --all, FORCE_COLOR, NO_COLOR)
const cliBin = path.resolve(__dirname, '../bin/cli.js');
const helpOut = execSync(`node "${cliBin}" --help`, { encoding: 'utf8' });
assert(helpOut.includes('--all'), '--help should document --all');
assert(helpOut.includes('--json'), '--help should document --json');
assert(helpOut.includes('--version'), '--help should document --version');

const versionOut = execSync(`node "${cliBin}" --version`, { encoding: 'utf8' });
assert(versionOut.trim().startsWith('why-did-this-break v'), '--version should output version string');

const repoRoot = path.resolve(__dirname, '..');
const forceColorOut = execSync(
  `node "${cliBin}" --all "TypeError: Boom\n    at normalizeFilePath (src/parser.js:15:3)"`,
  { cwd: repoRoot, env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' }, encoding: 'utf8' }
);
assert(forceColorOut.includes('\x1b['), 'FORCE_COLOR=1 should emit ANSI color sequences');
assert(forceColorOut.includes('QUICK ACTIONS'), 'CLI --all should include Quick Actions box');

const noColorOut = execSync(
  `node "${cliBin}" --all "TypeError: Boom\n    at normalizeFilePath (src/parser.js:15:3)"`,
  { cwd: repoRoot, env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1' }, encoding: 'utf8' }
);
assert(!noColorOut.includes('\x1b['), 'NO_COLOR=1 should disable ANSI color sequences even when FORCE_COLOR is set');

console.log('   ✓ Terminal reporter, ANSI colors, Quick Actions, and CLI flags verified.');

console.log('\nAll tests passed successfully!');
