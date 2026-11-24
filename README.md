# why-did-this-break — Git Stack Trace Root-Cause Finder

Stop running `git blame` and `git bisect` by hand across crash logs.
**`why-did-this-break`** parses any stack trace, traces every frame through Git history (`git blame` + `git log -L`), and ranks the most likely breaking commits in seconds — with zero external dependencies.

![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

## Installation & Quickstart

Run instantly with `npx`, install globally (exposes both `why-did-this-break` and `why-broke`), or pipe failing test/process output straight in:

```bash
# Run immediately without installing
npx why-did-this-break crash.log

# Install globally
npm install -g why-did-this-break

# Pipe failing tests or server output directly
npm test 2>&1 | why-broke
node app.js 2>&1 | why-did-this-break

# Pass a saved stack trace file
why-broke crash.log

# Pass an inline stack trace string
why-did-this-break "TypeError: Boom\n    at verifyToken (src/auth.js:6:26)"
```

## Why `why-did-this-break`?

| Capability | `why-did-this-break` | `git blame` | `git bisect` | `git log -L` |
| :--- | :---: | :---: | :---: | :---: |
| Accepts raw stack traces directly (file, pipe, string) | ✅ | ❌ | ❌ | ❌ |
| Multi-frame scoring across crash origin & callers | ✅ | ❌ (1 line) | ❌ | ❌ (1 range) |
| Zero repo checkouts or test re-runs required | ✅ | ✅ | ❌ (slow) | ✅ |
| Ranked diff hunks + copy-pasteable quick actions | ✅ | ❌ | ❌ | Partial |
| Zero external dependencies (`npx`-ready) | ✅ | Built-in | Built-in | Built-in |

## Usage

### Flags

| Flag | Description |
| :--- | :--- |
| `--all`, `-a` | Show full details (reasons, touched frames, and diff hunks) for every suspect instead of compacting runner-ups beyond #1 (default displays top 3). |
| `--json` | Output structured JSON of parsed frames and ranked suspects for CI or scripts. |
| `--debug` | Show diff hunks for all displayed suspects. |
| `--help`, `-h` | Print CLI usage instructions. |
| `--version`, `-v` | Print installed version. |

Colors automatically respect `NO_COLOR`, `FORCE_COLOR`, and TTY detection.

## Sample Output

```text
====================================================================
 WHY DID THIS BREAK? (Git Line Tracer & Suspect Scoring Engine)
====================================================================
Git Repository: /workspace/my-app
Parsed Stack Frames: 3

STACK TRACE FRAMES:
  Frame #0 [CRASH ORIGIN]: src/auth.js:6 (verifyToken)
  Frame #1: src/auth.js:3 (authenticateUser)
  Frame #2: src/server.js:42 (handleRequest)

--------------------------------------------------------------------
RANKED SUSPECT COMMITS (4 suspects identified):
--------------------------------------------------------------------

#1 PRIME SUSPECT [SUSPICION SCORE: 85/100 - CRITICAL]
   Commit:  3a99677 (3a99677c4128f9a1030b8d721f0e83ab9e4012d1)
   Author:  Jane Doe <jane@example.com>
   Date:    Tue Nov 24 06:15:19 2026 -0500 (12m ago)
   Message: refactor: optimize token signature matching
   Why Suspect:
     • Frame 0 proximity: active commit on exact crash origin line (+40 pts)
     • Direct blame: authored the current code at crash site (+15 pts)
     • High recency: committed within last 24h (12m ago) (+30 pts)
   Locations Touched:
     - Frame #0: src/auth.js:6 (active blame)
   Diff Hunk:
     | diff --git a/src/auth.js b/src/auth.js
     | --- a/src/auth.js
     | +++ b/src/auth.js
     | @@ -6,1 +6,1 @@
     | -  return token === "valid-secret";
     | +  return token.signatures.match(/secret/);

#2 [73/100 HIGH] 764cfb6 - feat: initial auth module
   Jane Doe <jane@example.com> (2h ago) | F0:src/auth.js:6, F1:src/auth.js:3*

#3 [37/100 MEDIUM] 19d4a02 - chore: wire auth middleware in server
   Alex Smith <alex@example.com> (9d ago) | F2:src/server.js:42*

... and 1 more suspect. Run with --all to show full details for all suspects.

┌─ QUICK ACTIONS (Top Suspect) ────────────────────────────────────┐
│  Inspect full commit:       git show 3a99677                     │
│  Safe revert:               git revert 3a99677                   │
│  Open crash site in editor: code -g src/auth.js:6                │
└──────────────────────────────────────────────────────────────────┘
```

## How Suspicion Scoring Works

Each commit found via `git log -L` and `git blame` across the parsed stack trace is deduplicated by commit hash and scored from **0 to 100**:

1. **Frame Proximity (0–40 pts)**:
   - **Frame 0 (crash origin)**: `+40 pts` if it is the active blamed commit on that line (`+20 pts` for superseded ancestor commits).
   - **Frame 1 (direct caller)**: `+28 pts` (`+15 pts` historical).
   - **Frame 2**: `+18 pts` (`+10 pts` historical).
   - **Frame 3+**: decays progressively with stack depth.
2. **Direct Blame Bonus (0–15 pts)**:
   - `+15 pts` if the commit authored the current code at Frame 0 (`+5 pts` if active blame on any deeper frame).
3. **Recency (0–30 pts)**:
   - Within last 24 hours: `+30 pts`
   - Within last 7 days: `+20 pts`
   - Within last 30 days: `+10 pts`
   - Older than 30 days: `+2 pts`
4. **Multi-Frame Overlap (0–15 pts)**:
   - Modified 3+ distinct stack frames: `+15 pts`
   - Modified 2 distinct stack frames: `+10 pts`
   - Modified multiple lines within a single frame: `+5 pts`
