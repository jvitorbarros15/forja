---
description: Start the Forja runner and the local dashboard for this repo
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" start --project "$PWD"`.

Show the output as it is, including the dashboard URL. If it reports that Forja is already running, say so and show the URL. If it fails, show the error and suggest `/forja:doctor`.
