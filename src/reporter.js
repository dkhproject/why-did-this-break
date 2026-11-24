/**
 * src/reporter.js
 * Terminal UI Polish & Quick-Action Reporter using zero external dependencies.
 */

const ANSI_CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  bgRed: '\x1b[41m',
};

/**
 * Determines whether ANSI colors should be used for output.
 * Respects explicit `options.color`, `NO_COLOR`, `FORCE_COLOR`, and TTY status.
 * @param {Object} [options={}]
 * @param {boolean} [options.color]
 * @returns {boolean}
 */
function shouldUseColor(options = {}) {
  if (typeof options.color === 'boolean') {
    return options.color;
  }
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

/**
 * Applies one or more ANSI styles to text when color output is enabled.
 * @param {string|Array<string>} styles
 * @param {string} text
 * @param {boolean} useColor
 * @returns {string}
 */
function style(styles, text, useColor) {
  if (!useColor || !text) {
    return text;
  }
  const styleList = Array.isArray(styles) ? styles : [styles];
  const prefix = styleList.map((name) => ANSI_CODES[name] || '').join('');
  if (!prefix) {
    return text;
  }
  return `${prefix}${text}${ANSI_CODES.reset}`;
}

/**
 * Colorizes a git diff hunk string (+ green, - red, @@ cyan, headers gray/dim).
 * @param {string} diff
 * @param {boolean} useColor
 * @param {number} [maxLines=12]
 * @returns {Array<string>}
 */
function colorizeDiff(diff, useColor, maxLines = 12) {
  if (!diff || typeof diff !== 'string') {
    return [];
  }

  const allLines = diff.split('\n');
  const visibleLines = allLines.slice(0, maxLines);
  const formatted = visibleLines.map((line) => {
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++')
    ) {
      return style('gray', line, useColor);
    }
    if (line.startsWith('@@')) {
      return style('cyan', line, useColor);
    }
    if (line.startsWith('+')) {
      return style('green', line, useColor);
    }
    if (line.startsWith('-')) {
      return style('red', line, useColor);
    }
    return style('dim', line, useColor);
  });

  if (allLines.length > maxLines) {
    const remaining = allLines.length - maxLines;
    formatted.push(style('dim', `... (${remaining} more line${remaining === 1 ? '' : 's'} omitted)`, useColor));
  }

  return formatted;
}

/**
 * Maps a numeric score to a severity badge label and style.
 * @param {number} score
 * @returns {{ label: string, color: string }}
 */
function getSeverityMeta(score) {
  if (score >= 70) {
    return { label: 'CRITICAL', color: 'red' };
  }
  if (score >= 40) {
    return { label: 'HIGH', color: 'yellow' };
  }
  return { label: 'MEDIUM', color: 'cyan' };
}

/**
 * Formats a suspect entry in full detail (used for #1 Prime Suspect and --all).
 * @param {Object} suspect
 * @param {number} rank
 * @param {boolean} useColor
 * @param {boolean} showDiff
 * @returns {Array<string>}
 */
function formatDetailedSuspect(suspect, rank, useColor, showDiff) {
  const lines = [];
  const { label, color } = getSeverityMeta(suspect.score);
  const subject = (suspect.message || '').split('\n')[0];

  if (rank === 1) {
    const header = `#1 PRIME SUSPECT [SUSPICION SCORE: ${suspect.score}/100 - ${label}]`;
    lines.push(style(['bold', 'red'], header, useColor));
  } else {
    const header = `#${rank} [SUSPICION SCORE: ${suspect.score}/100 - ${label}]`;
    lines.push(style(['bold', color], header, useColor));
  }

  const hashLine = `   Commit:  ${style(['bold', 'yellow'], suspect.shortHash, useColor)} ${style('dim', `(${suspect.hash})`, useColor)}`;
  lines.push(hashLine);
  lines.push(`   Author:  ${suspect.author || 'Unknown'}`);
  lines.push(`   Date:    ${suspect.date || 'Unknown'} ${style('dim', `(${suspect.relativeTime || 'unknown'})`, useColor)}`);
  lines.push(`   Message: ${style('bold', subject, useColor)}`);

  if (Array.isArray(suspect.reasons) && suspect.reasons.length > 0) {
    lines.push(style('dim', '   Why Suspect:', useColor));
    for (const reason of suspect.reasons) {
      lines.push(`     • ${reason}`);
    }
  }

  if (Array.isArray(suspect.framesTouched) && suspect.framesTouched.length > 0) {
    lines.push(style('dim', '   Locations Touched:', useColor));
    for (const frame of suspect.framesTouched) {
      const blameTag = frame.isBlame ? style('yellow', ' (active blame)', useColor) : '';
      lines.push(`     - Frame #${frame.frameIndex}: ${frame.file}:${frame.line}${blameTag}`);
    }
  }

  if (showDiff && suspect.diff) {
    lines.push(style('dim', '   Diff Hunk:', useColor));
    const diffLines = colorizeDiff(suspect.diff, useColor, 12);
    for (const dl of diffLines) {
      lines.push(`     ${style('gray', '|', useColor)} ${dl}`);
    }
  }

  return lines;
}

/**
 * Formats a runner-up suspect (#2+) in compact form.
 * @param {Object} suspect
 * @param {number} rank
 * @param {boolean} useColor
 * @returns {Array<string>}
 */
function formatCompactSuspect(suspect, rank, useColor) {
  const { label, color } = getSeverityMeta(suspect.score);
  const subject = (suspect.message || '').split('\n')[0];
  const scoreTag = style(['bold', color], `[${suspect.score}/100 ${label}]`, useColor);
  const hashTag = style('yellow', suspect.shortHash, useColor);

  const locations = (suspect.framesTouched || [])
    .map((f) => `F${f.frameIndex}:${f.file}:${f.line}${f.isBlame ? '*' : ''}`)
    .join(', ');

  return [
    `${style('bold', `#${rank}`, useColor)} ${scoreTag} ${hashTag} - ${subject}`,
    `   ${style('dim', `${suspect.author || 'Unknown'} (${suspect.relativeTime || 'unknown'})`, useColor)}${locations ? ` | ${locations}` : ''}`,
  ];
}

/**
 * Builds the bordered Quick Actions box for the #1 Prime Suspect.
 * @param {Object} topSuspect
 * @param {Array<Object>} frames
 * @param {boolean} useColor
 * @returns {Array<string>}
 */
function formatQuickActionsBox(topSuspect, frames, useColor) {
  const touched = Array.isArray(topSuspect.framesTouched) ? topSuspect.framesTouched : [];
  const crashSite = touched.find((f) => f.frameIndex === 0) || frames[0] || touched[0];
  const targetFile = crashSite && crashSite.file ? crashSite.file : '<file>';
  const targetLine = crashSite && crashSite.line ? crashSite.line : 1;

  const entries = [
    { label: 'Inspect full commit:', cmd: `git show ${topSuspect.shortHash}` },
    { label: 'Safe revert:', cmd: `git revert ${topSuspect.shortHash}` },
    { label: 'Open crash site in editor:', cmd: `code -g ${targetFile}:${targetLine}` },
  ];

  const maxLabelLen = Math.max(...entries.map((e) => e.label.length));
  const rawContentLines = entries.map(
    (e) => `  ${e.label.padEnd(maxLabelLen + 2)}${e.cmd}`
  );
  const titleText = 'QUICK ACTIONS (Top Suspect)';
  const innerWidth = Math.max(
    66,
    titleText.length + 4,
    ...rawContentLines.map((l) => l.length + 2)
  );

  const topBorder = `┌─ ${titleText} ${'─'.repeat(Math.max(1, innerWidth - titleText.length - 3))}┐`;
  const bottomBorder = `└${'─'.repeat(innerWidth)}┘`;

  const lines = [style(['bold', 'cyan'], topBorder, useColor)];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const paddingNeeded = innerWidth - rawContentLines[i].length;
    const paddedTrailing = ' '.repeat(Math.max(0, paddingNeeded));
    const styledLine = `  ${style('dim', entry.label.padEnd(maxLabelLen + 2), useColor)}${style(['bold', 'green'], entry.cmd, useColor)}${paddedTrailing}`;
    lines.push(`${style('cyan', '│', useColor)}${styledLine}${style('cyan', '│', useColor)}`);
  }
  lines.push(style('cyan', bottomBorder, useColor));

  return lines;
}

/**
 * Formats the complete terminal report for why-did-this-break.
 * @param {Object} data
 * @param {string} data.gitRoot
 * @param {Array<Object>} data.frames
 * @param {Array<Object>} data.suspects
 * @param {Object} [options={}]
 * @param {boolean} [options.showAll=false]
 * @param {boolean} [options.debug=false]
 * @param {boolean} [options.color]
 * @returns {string}
 */
function formatReport({ gitRoot, frames = [], suspects = [] }, options = {}) {
  const useColor = shouldUseColor(options);
  const showAll = Boolean(options.showAll);
  const debug = Boolean(options.debug);
  const out = [];

  const divider = '='.repeat(68);
  const subDivider = '-'.repeat(68);

  out.push('');
  out.push(style('cyan', divider, useColor));
  out.push(style(['bold', 'white'], ' WHY DID THIS BREAK? (Git Line Tracer & Suspect Scoring Engine)', useColor));
  out.push(style('cyan', divider, useColor));
  out.push(`${style('dim', 'Git Repository:', useColor)} ${gitRoot}`);
  out.push(`${style('dim', 'Parsed Stack Frames:', useColor)} ${frames.length}`);
  out.push('');

  out.push(style('bold', 'STACK TRACE FRAMES:', useColor));
  for (const frame of frames) {
    const originTag = frame.frameIndex === 0 ? style(['bold', 'red'], ' [CRASH ORIGIN]', useColor) : '';
    const methodTag = frame.method ? style('dim', ` (${frame.method})`, useColor) : '';
    out.push(`  Frame #${frame.frameIndex}${originTag}: ${frame.file}:${frame.line}${methodTag}`);
  }

  out.push('');
  out.push(style('gray', subDivider, useColor));
  out.push(
    style(
      'bold',
      `RANKED SUSPECT COMMITS (${suspects.length} suspect${suspects.length === 1 ? '' : 's'} identified):`,
      useColor
    )
  );
  out.push(style('gray', subDivider, useColor));

  if (suspects.length === 0) {
    out.push('  No matching git commits found for the parsed stack trace lines.');
    out.push('  (Ensure the stack trace files exist locally and are tracked in git)');
    out.push('');
    return out.join('\n');
  }

  const displayedSuspects = showAll ? suspects : suspects.slice(0, 3);

  displayedSuspects.forEach((suspect, index) => {
    const rank = index + 1;
    out.push('');

    if (rank === 1 || showAll) {
      const showDiff = rank === 1 || debug || showAll;
      out.push(...formatDetailedSuspect(suspect, rank, useColor, showDiff));
    } else {
      out.push(...formatCompactSuspect(suspect, rank, useColor));
    }
  });

  if (!showAll && suspects.length > 3) {
    const remaining = suspects.length - 3;
    out.push('');
    out.push(
      style(
        'dim',
        `... and ${remaining} more suspect${remaining === 1 ? '' : 's'}. Run with --all to show full details for all suspects.`,
        useColor
      )
    );
  }

  out.push('');
  out.push(...formatQuickActionsBox(suspects[0], frames, useColor));
  out.push('');

  return out.join('\n');
}

module.exports = {
  formatReport,
  colorizeDiff,
  shouldUseColor,
};
