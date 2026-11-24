/**
 * src/gitTracer.js
 * Smart Git Line Tracer using zero external dependencies.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Checks if a directory is inside a valid Git work tree.
 * @param {string} [dir=process.cwd()]
 * @returns {boolean}
 */
function isGitRepo(dir = process.cwd()) {
  try {
    const result = execSync('git rev-parse --is-inside-work-tree', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return result.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Gets the top-level root directory of the current Git repository.
 * @param {string} [dir=process.cwd()]
 * @returns {string|null}
 */
function getGitRoot(dir = process.cwd()) {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Verifies that the current directory is inside a valid Git repository.
 * If not, exits gracefully with a clear message.
 * @param {string} [dir=process.cwd()]
 * @param {boolean} [shouldExit=true]
 * @returns {string} Git repository root directory
 */
function verifyGitRepo(dir = process.cwd(), shouldExit = true) {
  if (!isGitRepo(dir)) {
    const message = 'Error: The current directory is not inside a valid Git repository.\nPlease run why-did-this-break inside a Git repository.';
    if (shouldExit) {
      console.error(message);
      process.exit(1);
    } else {
      throw new Error(message);
    }
  }
  return getGitRoot(dir);
}

/**
 * Runs git blame on a specific line with porcelain formatting.
 * @param {string} file - Path relative to git root
 * @param {number} line - Line number
 * @param {string} gitRoot - Git repository root
 * @returns {{ hash: string, author: string, authorMail: string, timestamp: number, summary: string }|null}
 */
function runGitBlame(file, line, gitRoot) {
  try {
    const cmd = `git blame -w -L ${line},${line} --porcelain ${file}`;
    const output = execSync(cmd, {
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    const lines = output.split('\n');
    if (lines.length === 0) return null;

    const firstLineParts = lines[0].split(' ');
    const hash = firstLineParts[0];

    let author = 'Unknown';
    let authorMail = '';
    let timestamp = 0;
    let summary = '';

    for (const l of lines.slice(1)) {
      if (l.startsWith('author ')) {
        author = l.slice(7).trim();
      } else if (l.startsWith('author-mail ')) {
        authorMail = l.slice(12).trim();
      } else if (l.startsWith('author-time ')) {
        timestamp = parseInt(l.slice(12).trim(), 10);
      } else if (l.startsWith('summary ')) {
        summary = l.slice(8).trim();
      }
    }

    return {
      hash,
      author: authorMail ? `${author} ${authorMail}` : author,
      timestamp,
      summary,
    };
  } catch {
    return null;
  }
}

/**
 * Parses git log -L output using formatted delimiters.
 * @param {string} rawLogOutput 
 * @param {string} file 
 * @param {number} line 
 * @param {number} frameIndex 
 * @param {string|null} blameHash 
 * @returns {Array<Object>}
 */
function parseGitLogL(rawLogOutput, file, line, frameIndex, blameHash) {
  const commits = [];
  if (!rawLogOutput || typeof rawLogOutput !== 'string') return commits;

  const blocks = rawLogOutput.split('___COMMIT_START___\n');

  for (const block of blocks) {
    if (!block.trim()) continue;

    const endMsgIdx = block.indexOf('___COMMIT_MSG_END___');
    if (endMsgIdx === -1) continue;

    const metaPart = block.slice(0, endMsgIdx).trim();
    const diffPart = block.slice(endMsgIdx + '___COMMIT_MSG_END___'.length).trim();

    const metaLines = metaPart.split('\n');
    if (metaLines.length < 5) continue;

    const hash = metaLines[0].trim();
    const shortHash = metaLines[1].trim() || hash.slice(0, 7);
    const author = metaLines[2].trim();
    const date = metaLines[3].trim();
    const timestamp = parseInt(metaLines[4].trim(), 10) || 0;
    const message = metaLines.slice(5).join('\n').trim();

    commits.push({
      hash,
      shortHash,
      author,
      date,
      timestamp,
      message,
      diff: diffPart,
      file,
      line,
      frameIndex,
      isBlame: blameHash ? (hash.toLowerCase() === blameHash.toLowerCase()) : false,
    });
  }

  return commits;
}

/**
 * Resolves a parsed frame's file path to an absolute path and a git-relative path.
 * Checks whether the file exists locally.
 * @param {string} rawFile 
 * @param {string} gitRoot 
 * @param {string} cwd 
 * @returns {{ exists: boolean, absolutePath: string, gitRelativePath: string }}
 */
function resolveFileInGit(rawFile, gitRoot, cwd) {
  let absolutePath;
  if (path.isAbsolute(rawFile)) {
    absolutePath = rawFile;
  } else {
    // Try resolving against cwd first, then gitRoot
    const fromCwd = path.resolve(cwd, rawFile);
    if (fs.existsSync(fromCwd)) {
      absolutePath = fromCwd;
    } else {
      absolutePath = path.resolve(gitRoot, rawFile);
    }
  }

  const exists = fs.existsSync(absolutePath);
  const gitRelativePath = path.relative(gitRoot, absolutePath);

  return {
    exists,
    absolutePath,
    gitRelativePath,
  };
}

/**
 * Runs git log -L and git blame for each parsed frame and extracts structured commit metadata.
 * @param {Array<{ file: string, line: number, frameIndex?: number }>} frames 
 * @param {Object} [options={}]
 * @param {string} [options.cwd=process.cwd()]
 * @param {number} [options.maxCommitsPerLine=5]
 * @returns {{ traces: Array<{ frameIndex: number, file: string, line: number, commits: Array<Object>, blame: Object|null }>, gitRoot: string }}
 */
function traceFrames(frames, options = {}) {
  const cwd = options.cwd || process.cwd();
  const maxCommitsPerLine = options.maxCommitsPerLine || 5;
  const gitRoot = verifyGitRepo(cwd, true);

  const traces = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const frameIndex = typeof frame.frameIndex === 'number' ? frame.frameIndex : i;
    const { file: rawFile, line } = frame;

    if (!rawFile || !line || typeof line !== 'number' || isNaN(line) || line <= 0) {
      continue;
    }

    const { exists, gitRelativePath } = resolveFileInGit(rawFile, gitRoot, cwd);
    if (!exists) {
      // File not found locally, skip
      continue;
    }

    // Run git blame to find the exact blaming commit for this line
    const blame = runGitBlame(gitRelativePath, line, gitRoot);
    const blameHash = blame ? blame.hash : null;

    // Run git log -L <line>,<line>:<file> -w -n <maxCommitsPerLine>
    let commits = [];
    try {
      const format = '___COMMIT_START___%n%H%n%h%n%an <%ae>%n%ad%n%at%n%B%n___COMMIT_MSG_END___';
      const cmd = `git log -L ${line},${line}:${gitRelativePath} -w -n ${maxCommitsPerLine} --format="${format}"`;
      const output = execSync(cmd, {
        cwd: gitRoot,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      commits = parseGitLogL(output, gitRelativePath, line, frameIndex, blameHash);
    } catch {
      // If git log -L fails (e.g. line uncommitted or invalid range), fallback to blame commit if available
      if (blame && blame.hash) {
        commits = [{
          hash: blame.hash,
          shortHash: blame.hash.slice(0, 7),
          author: blame.author,
          date: new Date(blame.timestamp * 1000).toISOString(),
          timestamp: blame.timestamp,
          message: blame.summary,
          diff: '',
          file: gitRelativePath,
          line,
          frameIndex,
          isBlame: true,
        }];
      }
    }

    // Ensure the blame commit is present in the commits list if it was not picked up
    if (blame && blame.hash && !commits.some(c => c.hash.toLowerCase() === blame.hash.toLowerCase())) {
      commits.unshift({
        hash: blame.hash,
        shortHash: blame.hash.slice(0, 7),
        author: blame.author,
        date: new Date(blame.timestamp * 1000).toISOString(),
        timestamp: blame.timestamp,
        message: blame.summary,
        diff: '',
        file: gitRelativePath,
        line,
        frameIndex,
        isBlame: true,
      });
    }

    traces.push({
      frameIndex,
      file: gitRelativePath,
      line,
      commits,
      blame,
    });
  }

  return {
    traces,
    gitRoot,
  };
}

module.exports = {
  isGitRepo,
  getGitRoot,
  verifyGitRepo,
  runGitBlame,
  traceFrames,
};
