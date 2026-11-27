---
description: Set up Forja in this repo: detect, ask, write .forja/config.json, check
allowed-tools: Bash(node:*)
---

Set up Forja for the repo in the current directory. Work through the steps in order.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" detect --project "$PWD"`. Read its output.
2. Show the user what was found: repo, gh login and scopes, optional CLIs on PATH, package scripts, and any existing `.forja/config.json`. Keep it short.
3. Ask the questions below, one question at a time. Wait for the answer before asking the next. Every question shows its default; the user can press enter or type "default" to accept it.
   - Repo: the detected `owner/name`. Default: detected value.
   - Approvers: GitHub logins allowed to label issues and run `/approve` or `/redo`. Default: the current gh login.
   - Language: `en` or `pt-BR`. Default: `en`.
   - Vendors: for each detected CLI (`codex`, `gemini`, `opencode`, `ollama`), enable it or not. Default: all off, Claude only. Say that a different vendor reviews the builder's work when it is enabled.
   - Models: keep the defaults, or change them role by role. Defaults: spec `claude:sonnet`; specStrong `claude:opus`; build ladder exact, then `claude:haiku`, `claude:sonnet`, `claude:opus`; review code, ui and ponytail `claude:sonnet`; review security `claude:opus`; goldfish, approver and advisor `claude:sonnet`; approverStrong `claude:opus`.
   - Checks: propose commands from `package.json` scripts (for example `npm ci`, `npm run -s typecheck`, `npm test`, `npm run -s build`). Ask the user to accept, edit or skip each one. Default: the proposal.
   - Tiers: show the three default tiers (A, B, C) with their paths, reviews and approval. Ask whether to keep them or change them.
   - Auto-merge: explain that every tier starts at owner approval, so a person approves each change. Auto-merge (`approval: "auto"`) is allowed only on a tier that has `paths`, and the default tier A does. Ask whether to enable it on tier A. Default: no.
   - Auto deploy: ask whether a merged change deploys without an owner click. Default: no. It is allowed only on a tier with `paths`.
   - Deploy commands: `checks.deployTest` and `checks.deploy`. Default: none, which means `merged` is the final state.
4. Show the final config as a short summary and ask for confirmation once. Then write the answers as one JSON object with the keys above (`repo`, `approvers`, `language`, `vendors`, `models`, `checks`, `tiers`, `deployTest`, `deploy`) to a temp file, and run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" init --project "$PWD" --answers-file <path>`. Use the file, not inline JSON in quotes. Add `--no-gh` if gh is not authenticated.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" doctor --project "$PWD"` and show its result. If a check fails, say what to fix and do not write the config again unless the user asks.

Finish by telling the user that `.forja/config.json` must be committed and merged to main by them before the runner uses it, because the runner reads config only from `forja-main`. Claude never commits or pushes during setup. Then the next step is `/forja:start`, after that merge.
