/**
 * src/index.js
 * Main library entry point for why-did-this-break.
 */

const { parseStackTrace } = require('./parser');
const { verifyGitRepo, isGitRepo, getGitRoot, traceFrames } = require('./gitTracer');
const { scoreCommits } = require('./scorer');

/**
 * Full analysis pipeline: parses stack trace, traces git commits, and scores suspects.
 * @param {string} stackTraceText
 * @param {Object} [options={}]
 * @returns {{ frames: Array<Object>, traces: Array<Object>, suspects: Array<Object>, gitRoot: string }}
 */
function analyzeStackTrace(stackTraceText, options = {}) {
  const cwd = options.cwd || process.cwd();
  const gitRoot = verifyGitRepo(cwd, options.exitOnError !== false);

  const frames = parseStackTrace(stackTraceText);
  const { traces } = traceFrames(frames, { cwd, maxCommitsPerLine: options.maxCommitsPerLine || 5 });
  const suspects = scoreCommits(traces, { now: options.now });

  return {
    frames,
    traces,
    suspects,
    gitRoot,
  };
}

module.exports = {
  analyzeStackTrace,
  parseStackTrace,
  verifyGitRepo,
  isGitRepo,
  getGitRoot,
  traceFrames,
  scoreCommits,
};
