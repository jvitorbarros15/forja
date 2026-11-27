---
description: Stop the Forja runner and dashboard for this repo
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" stop --project "$PWD"`.

Show the result in one line per process stopped. Jobs that were mid-build stay on the board and resume on the next `/forja:start`.
