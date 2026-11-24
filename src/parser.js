/**
 * src/parser.js
 * Zero-dependency stack trace parser for Node.js/V8, Python, and generic stack traces.
 */

const fs = require('fs');
const path = require('path');

/**
 * Normalizes a file path (strips file:// protocol, removes query strings/hashes)
 * @param {string} rawPath 
 * @returns {string}
 */
function normalizeFilePath(rawPath) {
  if (!rawPath) return '';
  let cleaned = rawPath.trim();
  if (cleaned.startsWith('file://')) {
    cleaned = cleaned.slice(7);
  }
  // Strip url query/hash if any (e.g. file.js?v=1:10:5)
  const queryIdx = cleaned.indexOf('?');
  if (queryIdx !== -1) {
    cleaned = cleaned.slice(0, queryIdx);
  }
  return path.normalize(cleaned);
}

/**
 * Checks if a frame file should be ignored (e.g. Node.js built-ins)
 * @param {string} filePath 
 * @returns {boolean}
 */
function isInternalModule(filePath) {
  if (!filePath) return true;
  if (filePath.startsWith('node:') || filePath.startsWith('internal/')) {
    return true;
  }
  if (filePath === '<anonymous>' || filePath === '[native code]') {
    return true;
  }
  return false;
}

/**
 * Parses raw stack trace text into an array of structured frame objects.
 * @param {string} text - The raw stack trace or log string
 * @returns {Array<{ file: string, line: number, col: number|null, method: string|null, frameIndex: number, raw: string, isInternal: boolean }>}
 */
function parseStackTrace(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const lines = text.split(/\r?\n/);
  const frames = [];
  let frameIndex = 0;

  // Pattern 1: Node / V8: "    at method (path/to/file.js:12:34)" or "    at path/to/file.js:12:34"
  // Handles optional "async ", optional method name, Windows drives, node:internal, optional parens around file:line:col
  const nodePattern = /^\s*at\s+(?:async\s+)?(?:(?<method>.+?)\s+\((?<parenFile>.+?):(?<parenLine>\d+)(?::(?<parenCol>\d+))?\)|(?<bareFile>.+?):(?<bareLine>\d+)(?::(?<bareCol>\d+))?)\s*$/;

  // Pattern 2: Python traceback: '  File "/path/to/file.py", line 42, in my_func'
  const pythonPattern = /^\s*File\s+"(?<file>[^"\n\r]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<method>.+))?/;

  // Pattern 3: Generic file:line:col or file:line (e.g. Go, Rust, GCC, Jest)
  const genericPattern = /(?:^|[\s\(\[])(?<file>[a-zA-Z0-9_\-\.\/\\~@]+?\.[a-zA-Z0-9_]+):(?<line>\d+)(?::(?<col>\d+))?/;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let matched = false;

    // Try Node.js / V8 pattern
    const nodeMatch = trimmed.match(nodePattern);
    if (nodeMatch && nodeMatch.groups) {
      const file = normalizeFilePath(nodeMatch.groups.parenFile || nodeMatch.groups.bareFile);
      const line = parseInt(nodeMatch.groups.parenLine || nodeMatch.groups.bareLine, 10);
      const col = (nodeMatch.groups.parenCol || nodeMatch.groups.bareCol)
        ? parseInt(nodeMatch.groups.parenCol || nodeMatch.groups.bareCol, 10)
        : null;
      const method = (nodeMatch.groups.method || '').trim() || null;

      frames.push({
        file,
        line,
        col,
        method,
        frameIndex: frameIndex++,
        raw: trimmed,
        isInternal: isInternalModule(file),
      });
      matched = true;
    }

    // Try Python pattern
    if (!matched) {
      const pyMatch = trimmed.match(pythonPattern);
      if (pyMatch && pyMatch.groups) {
        const file = normalizeFilePath(pyMatch.groups.file);
        const line = parseInt(pyMatch.groups.line, 10);
        const method = (pyMatch.groups.method || '').trim() || null;

        frames.push({
          file,
          line,
          col: null,
          method,
          frameIndex: frameIndex++,
          raw: trimmed,
          isInternal: isInternalModule(file),
        });
        matched = true;
      }
    }

    // Try Generic pattern if not matched yet and line looks like a frame
    if (!matched) {
      const genMatch = trimmed.match(genericPattern);
      if (genMatch && genMatch.groups) {
        const file = normalizeFilePath(genMatch.groups.file);
        const line = parseInt(genMatch.groups.line, 10);
        const col = genMatch.groups.col ? parseInt(genMatch.groups.col, 10) : null;

        // Ensure it's not a false positive (file must have extension)
        if (path.extname(file)) {
          frames.push({
            file,
            line,
            col,
            method: null,
            frameIndex: frameIndex++,
            raw: trimmed,
            isInternal: isInternalModule(file),
          });
        }
      }
    }
  }

  return frames;
}

module.exports = {
  parseStackTrace,
  normalizeFilePath,
  isInternalModule,
};
