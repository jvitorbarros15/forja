---
description: Show whether Forja is running and what its board holds
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" status --project "$PWD"`.

Present the result briefly: running or stopped, the runner heartbeat age, the dashboard URL, and the jobs grouped by stage (`spec`, `build`, `review`, `approve`, `pr`, `needs-you`, `failed`, `merged`, `deployed`). List jobs that need the owner first. Do not repeat the raw output.
