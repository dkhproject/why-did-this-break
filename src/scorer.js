/**
 * src/scorer.js
 * Suspect Scoring Engine for why-did-this-break using zero external dependencies.
 */

/**
 * Formats a unix timestamp (in seconds) to human-readable relative time.
 * @param {number} timestamp 
 * @param {number} [now=Math.floor(Date.now() / 1000)]
 * @returns {string}
 */
function formatRelativeTime(timestamp, now = Math.floor(Date.now() / 1000)) {
  if (!timestamp || isNaN(timestamp)) return 'unknown time';
  const diffSec = Math.max(0, now - timestamp);

  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffMin / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y ago`;
}

/**
 * Calculates the suspicion score (0-100) and rationale for a deduplicated commit.
 * @param {Object} commitData
 * @param {number} [now=Math.floor(Date.now() / 1000)]
 * @returns {{ score: number, reasons: Array<string>, scoreBreakdown: Object }}
 */
function calculateCommitScore(commitData, now = Math.floor(Date.now() / 1000)) {
  const reasons = [];
  let proximityScore = 0;
  let recencyScore = 0;
  let overlapScore = 0;
  let blameScore = 0;

  const minFrame = commitData.minFrameIndex;
  const distinctFramesCount = commitData.distinctFrames.size;
  const isBlameFrame0 = commitData.isBlameFrame0;
  const isBlameAny = commitData.isBlameAny;

  // 1. Frame Proximity (0 - 40 points)
  // Commits that are the active blamed version of a line receive full proximity score.
  // Historical commits (which were superseded by later commits on that line) receive reduced proximity.
  if (minFrame === 0) {
    if (isBlameFrame0) {
      proximityScore = 40;
      reasons.push('Frame 0 proximity: active commit on exact crash origin line (+40 pts)');
    } else {
      proximityScore = 20;
      reasons.push('Frame 0 proximity: ancestor commit in crash origin line history (+20 pts)');
    }
  } else if (minFrame === 1) {
    proximityScore = isBlameAny ? 28 : 15;
    reasons.push(`Frame 1 proximity: direct caller of crash site (+${proximityScore} pts)`);
  } else if (minFrame === 2) {
    proximityScore = isBlameAny ? 18 : 10;
    reasons.push(`Frame 2 proximity: caller frame (+${proximityScore} pts)`);
  } else if (minFrame === 3) {
    proximityScore = isBlameAny ? 12 : 6;
    reasons.push(`Frame 3 proximity: mid-depth frame (+${proximityScore} pts)`);
  } else {
    proximityScore = Math.max(3, (isBlameAny ? 10 : 5) - (minFrame - 3));
    reasons.push(`Frame ${minFrame} proximity: deep frame (+${proximityScore} pts)`);
  }

  // 2. Active Blame Bonus (0 - 15 points)
  // If this commit currently wrote the exact line at the crash origin, it is the primary suspect
  if (isBlameFrame0) {
    blameScore = 15;
    reasons.push('Direct blame: authored the current code at crash site (+15 pts)');
  } else if (isBlameAny) {
    blameScore = 5;
    reasons.push('Active blame: authored current code on caller stack line (+5 pts)');
  }

  // 3. Recency (0 - 30 points)
  const ageSec = Math.max(0, now - commitData.timestamp);
  const oneDay = 24 * 3600;
  const sevenDays = 7 * oneDay;
  const thirtyDays = 30 * oneDay;

  const relTime = formatRelativeTime(commitData.timestamp, now);

  if (ageSec <= oneDay) {
    recencyScore = 30;
    reasons.push(`High recency: committed within last 24h (${relTime}) (+30 pts)`);
  } else if (ageSec <= sevenDays) {
    recencyScore = 20;
    reasons.push(`Medium recency: committed within last 7 days (${relTime}) (+20 pts)`);
  } else if (ageSec <= thirtyDays) {
    recencyScore = 10;
    reasons.push(`Moderate recency: committed within last 30 days (${relTime}) (+10 pts)`);
  } else {
    recencyScore = 2;
    reasons.push(`Low recency: committed over 30 days ago (${relTime}) (+2 pts)`);
  }

  // 4. Multi-frame Overlap (0 - 15 points)
  // If the same commit modified multiple files or frames across the stack trace
  if (distinctFramesCount >= 3) {
    overlapScore = 15;
    reasons.push(`High multi-frame overlap: modified ${distinctFramesCount} distinct stack frames (+15 pts)`);
  } else if (distinctFramesCount === 2) {
    overlapScore = 10;
    reasons.push('Multi-frame overlap: modified 2 distinct stack frames (+10 pts)');
  } else if (commitData.frames.length >= 2) {
    overlapScore = 5;
    reasons.push(`Multi-line modification: touched ${commitData.frames.length} locations in stack trace (+5 pts)`);
  }

  const rawScore = proximityScore + recencyScore + overlapScore + blameScore;
  const score = Math.min(100, Math.max(0, Math.round(rawScore)));

  return {
    score,
    reasons,
    scoreBreakdown: {
      proximityScore,
      blameScore,
      recencyScore,
      overlapScore,
      rawScore,
    },
  };
}

/**
 * Deduplicates commits across all stack trace frame traces, scores them,
 * and returns ranked suspects sorted by suspicion score.
 * @param {Array<Object>|{ traces: Array<Object> }} traceResult - Output from gitTracer
 * @param {Object} [options={}]
 * @param {number} [options.now] - Current unix timestamp in seconds (defaults to now)
 * @returns {Array<Object>} Sorted list of ranked suspects
 */
function scoreCommits(traceResult, options = {}) {
  const traces = Array.isArray(traceResult) ? traceResult : (traceResult && traceResult.traces ? traceResult.traces : []);
  const now = options.now || Math.floor(Date.now() / 1000);

  // Group and deduplicate commits by hash
  const commitMap = new Map();

  for (const trace of traces) {
    const frameIndex = trace.frameIndex;
    const file = trace.file;
    const line = trace.line;
    const commits = trace.commits || [];

    for (const commit of commits) {
      if (!commit || !commit.hash) continue;
      const key = commit.hash.toLowerCase();

      if (!commitMap.has(key)) {
        commitMap.set(key, {
          hash: commit.hash,
          shortHash: commit.shortHash || commit.hash.slice(0, 7),
          author: commit.author,
          date: commit.date,
          timestamp: commit.timestamp || 0,
          message: commit.message,
          diff: commit.diff || '',
          frames: [],
          distinctFrames: new Set(),
          distinctFiles: new Set(),
          minFrameIndex: frameIndex,
          isBlameFrame0: false,
          isBlameAny: false,
        });
      }

      const item = commitMap.get(key);

      // Record frame details
      item.frames.push({
        frameIndex,
        file,
        line,
        isBlame: Boolean(commit.isBlame),
      });

      item.distinctFrames.add(frameIndex);
      item.distinctFiles.add(file);

      if (frameIndex < item.minFrameIndex) {
        item.minFrameIndex = frameIndex;
      }

      if (commit.isBlame) {
        item.isBlameAny = true;
        if (frameIndex === 0) {
          item.isBlameFrame0 = true;
        }
      }

      // Preserve diff if current is empty and incoming has diff
      if (!item.diff && commit.diff) {
        item.diff = commit.diff;
      }
    }
  }

  // Calculate scores for all unique suspects
  const rankedSuspects = [];

  for (const item of commitMap.values()) {
    const { score, reasons, scoreBreakdown } = calculateCommitScore(item, now);

    rankedSuspects.push({
      hash: item.hash,
      shortHash: item.shortHash,
      score,
      author: item.author,
      date: item.date,
      timestamp: item.timestamp,
      relativeTime: formatRelativeTime(item.timestamp, now),
      message: item.message,
      diff: item.diff,
      reasons,
      scoreBreakdown,
      framesTouched: item.frames.map(f => ({
        frameIndex: f.frameIndex,
        file: f.file,
        line: f.line,
        isBlame: f.isBlame,
      })),
      filesCount: item.distinctFiles.size,
      framesCount: item.distinctFrames.size,
      minFrameIndex: item.minFrameIndex,
    });
  }

  // Sort commits from highest to lowest suspicion score
  rankedSuspects.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    // Tie-break by timestamp (more recent commit first)
    if (b.timestamp !== a.timestamp) {
      return b.timestamp - a.timestamp;
    }
    // Tie-break by frame proximity
    return a.minFrameIndex - b.minFrameIndex;
  });

  return rankedSuspects;
}

module.exports = {
  scoreCommits,
  calculateCommitScore,
  formatRelativeTime,
};
