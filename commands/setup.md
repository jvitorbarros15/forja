---
description: Set up Forja in this repo: detect, ask, write .forja/config.json, check
allowed-tools: Bash(node:*)
---

Set up Forja for the repo in the current directory. Work through the steps in order.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" detect --project "$PWD"`. Read its output.
2. Show the user what was found: repo, default branch, gh login and scopes, optional CLIs on PATH, package scripts, and any existing `.forja/config.json`. Keep it short.
3. Ask the questions below, one question at a time. Wait for the answer before asking the next. Every question shows its default; the user can press enter or type "default" to accept it.
   - Setup mode, always the first question: **Quick setup** or **Customize**. Quick setup uses Claude only, owner approval on every tier, the detected checks (the proposal from `package.json` scripts, none when there are none), the detected default branch, the detected repo, the current gh login as the only approver, language `en`, the default tiers and models, no auto-merge, no auto deploy and no deploy commands. If the user picks Quick setup, skip every question below (except the repo or approver when detect found none), show the summary and go to step 4 with the user's one confirmation. If they pick Customize, ask all of them.
   - Repo: the detected `owner/name`. Default: detected value.
   - Default branch: the branch every change merges into. Default: the detected `defaultBranch`, or `main` when none was detected.
   - Approvers: GitHub logins allowed to label issues and run `/approve` or `/redo`. Default: the current gh login.
   - Language: `en` or `pt-BR`. Default: `en`.
   - Vendors: for each detected CLI (`codex`, `gemini`, `agy`, `ollama`), enable it or not. Default: all off, Claude only. Say that a different vendor reviews the builder's work when it is enabled.
   - Models: keep the defaults, or change them role by role. Defaults: spec `claude:sonnet`; specStrong `claude:opus`; build ladder exact, then `claude:haiku`, `claude:sonnet`, `claude:opus`; review code, ui and ponytail `claude:sonnet`; review security `claude:opus`; approver and advisor `claude:sonnet`; goldfish `claude:sonnet` (goldfish only runs with a non-Claude entry such as `gemini:...` or `codex:...`, so offer one when that vendor is enabled); approverStrong `claude:opus`.
   - Checks: propose commands from `package.json` scripts (for example `npm ci`, `npm run -s typecheck`, `npm test`, `npm run -s build`). Ask the user to accept, edit or skip each one. Default: the proposal.
   - Tiers: show the three default tiers (A, B, C) with their paths, reviews and approval. Ask whether to keep them or change them.
   - Auto-merge: explain that every tier starts at owner approval, so a person approves each change. Auto-merge (`approval: "auto"`) is allowed only on a tier that has `paths`, and the default tier A does. Ask whether to enable it on tier A. Default: no.
   - Auto deploy: ask whether a merged change deploys without an owner click. Default: no. It is allowed only on a tier with `paths`.
   - Deploy commands: `checks.deployTest` and `checks.deploy`. Default: none, which means `merged` is the final state.
4. Show the final config as a short summary and ask for confirmation once. Then write the answers as one JSON object with the keys above (`repo`, `defaultBranch`, `approvers`, `language`, `vendors`, `models`, `checks`, `tiers`, `deployTest`, `deploy`) to a temp file, and run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" init --project "$PWD" --answers-file <path>`. Use the file, not inline JSON in quotes. Add `--no-gh` if gh is not authenticated.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/engine/cli.mjs" doctor --project "$PWD"` and show its result. If a check fails, say what to fix and do not write the config again unless the user asks.

Finish by telling the user that `.forja/config.json` must be committed and merged to the default branch by them before the runner uses it, because the runner reads config only from `forja-main`. Claude never commits or pushes during setup. Then the next step is `/forja:start`, after that merge.
