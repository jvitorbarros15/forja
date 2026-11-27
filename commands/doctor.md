---
description: Check that Forja's config, CLIs, gh auth and check commands are ready
allowed-tools: Bash(node:*)
---

Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" doctor --project "$PWD"`.

Show each check as one line with pass or fail. For every failure, give the fix in one sentence (for example, the missing scope for `gh auth refresh -s <scope>`, or the check command that is not on PATH). Do not change `.forja/config.json` unless the user asks. End with the overall result.
