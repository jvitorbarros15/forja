# Acceptance test

End-to-end run of Forja on a real GitHub repository, 2026-11-27.

## Setup

- Sandbox: private repo `forja-sandbox`, a minimal Node project (one function, one `node:test` test, GitHub Actions CI on push and pull request).
- Install: `claude plugin marketplace add jvitorbarros15/forja`, then `claude plugin install forja@forja`. Version 0.1.0.
- Setup: Quick setup answers (Claude only, owner approval on every tier, `checks.test: npm test`) through `cli.mjs init`, then `doctor`. All required checks passed. The config was committed and pushed to `main` before start.
- Start: `cli.mjs start` brought up the runner and the dashboard (port 4318; 4317 was taken by another instance, so the port moved up by one).
- Host: Windows 11, Node 25.1.0.

## Run

Issue #1, "Add a sum function", labeled `forja`.

| Time (UTC) | Event |
|---|---|
| 23:27:53 | Issue received |
| 23:28:12 | Spec ready: tier B, executor small. Blind check skipped (Claude-only config) |
| 23:28:31 | Building (small) |
| 23:28:46 | Builder finished; checks running |
| 23:29:02 | Checks passed; code review |
| 23:29:19 | ponytail review |
| 23:29:35 | Reviews passed; final approval |
| 23:29:55 | PR #2 opened; tier B waits for the owner |
| 23:30:12 | CI passed; card moves to Needs you |
| 23:30:47 | Advisor recommends Approve (re-ran tests: 4 pass, 0 fail) |
| 23:36:56 | Owner clicked Approve on the dashboard |
| 23:37:18 | PR #2 squash-merged with `--match-head-commit`; issue #1 closed |
| 23:37:35 | Job worktree removed (no deploy configured) |

Issue to merge-ready PR: 2 min 19 s. The diff added `export const sum = (a, b) => a + b` and three tests (positive, negative, zero), with commit subject "Add sum function".

## Result

Pass. Every stage ran in order, the owner gate held until Approve, the merge was pinned to the reviewed commit, and the worktree was cleaned up afterwards.

## Findings

- `doctor` warned about goldfish on the default Claude-only config. That is expected behaviour shown as a warning, so new users see noise. Fixed: the warning now appears only when an external vendor is enabled but the goldfish chain has no non-Claude entry.
- The dashboard header still showed the previous logo mark. Updated to the new anvil mark.
