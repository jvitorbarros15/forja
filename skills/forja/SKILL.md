---
name: forja
description: How to use and customize Forja, the issue-to-PR software factory. Use when the user asks how to change Forja's tiers, model chains, reviewers, agent or prompt overrides, privacy rules, or config.
---

# Forja

Forja turns a labeled GitHub issue into a spec, a build in its own worktree, reviews by a different model than the builder, an owner approval, a PR and a merge. The owner works from a local dashboard and PR comments (`/approve`, `/redo`).

The engine never touches the user's working copy. It works in `<worktreeRoot>/forja-main` and `<worktreeRoot>/forja-<issue>`. Config and overrides load from `forja-main`, so only merged changes apply. Edit `.forja/config.json` in the repo, merge it to main, then run `/forja:doctor`.

## Config file

`<repo>/.forja/config.json`. Required keys are `repo` and a non-empty `approvers` list. Every other key is optional. Missing keys come from the defaults in `engine/config.mjs`. Only the keys you change need to appear. Objects merge key by key, but arrays (`tiers`, `paths`, chains, `approvers`) replace the default completely, so copy the whole array when you change one.

## Tiers

Each tier sets the path rule, the reviews and the approval.

```json
{
  "tiers": [
    { "id": "A", "describe": "docs and tests only",
      "paths": ["test/**", "docs/**", "**/*.md"],
      "reviews": ["code"], "approval": "auto", "autoDeploy": false },
    { "id": "B", "describe": "app logic and UI",
      "reviews": ["code", "ui?", "ponytail"], "approval": "owner", "autoDeploy": false },
    { "id": "C", "describe": "auth, payments, migrations, deploy or CI",
      "reviews": ["code", "ponytail", "security"], "approval": "owner", "autoDeploy": false,
      "strongSpec": true, "strongApprover": true }
  ]
}
```

- Every default tier starts at `approval: "owner"`, so a person approves each change.
- `approval: "auto"` and `autoDeploy: true` are valid only on a tier with a non-empty `paths`. Validation rejects them otherwise.
- `paths` is a hard limit. A build whose diff touches a file outside its tier's `paths` fails.
- Tiers are ordered. The highest tier is the last one in the array.
- `describe` text is shown to the spec agent and on the dashboard.
- A review name ending in `?` (`ui?`) runs only when the builder reports UI changes.
- `strongSpec` and `strongApprover` switch the spec and approver to the `specStrong` and `approverStrong` chains.

## Model chains

Chains are ordered lists of `vendor:model`. The first usable entry wins. Other vendors need `vendors.<name>.enabled: true`.

```json
{
  "models": {
    "spec": ["claude:sonnet"],
    "specStrong": ["claude:opus"],
    "build": { "exact": ["local:exact"], "small": ["claude:haiku"], "medium": ["claude:sonnet"], "hard": ["claude:opus"] },
    "buildEscalation": ["exact", "small", "medium", "hard"],
    "review": { "code": ["claude:sonnet"], "ui": ["claude:sonnet"], "ponytail": ["claude:sonnet"], "security": ["claude:opus"] },
    "goldfish": ["claude:sonnet"],
    "approver": ["claude:sonnet"],
    "approverStrong": ["claude:opus"],
    "advisor": ["claude:sonnet"]
  }
}
```

- `build` is a ladder. A failed build escalates one rung through `buildEscalation`.
- Reviews prefer a different vendor from the builder. With Claude only, a review uses a different model from the builder, or the builder's model in a fresh context when the chain runs out.
- `spec`, `specStrong`, `approver`, `approverStrong` and `advisor` must use `claude:` entries because they run as Claude agents.

## Vendors

```json
{
  "vendors": {
    "codex": { "enabled": true, "bin": "codex" },
    "ollama": { "enabled": true, "url": "http://127.0.0.1:11434", "triageModel": "qwen2.5-coder" }
  }
}
```

All vendors are off by default. Ollama triage can only raise a tier, never lower it.

## Reviewers (custom review kinds)

Add a review kind with its own agent, skills and allowed commands. Then name it in a tier's `reviews`.

```json
{
  "reviewers": {
    "data": {
      "agent": ".forja/agents/review-data.md",
      "skills": [],
      "allow": ["Bash(npm run -s build:full:*)"]
    }
  },
  "tiers": [
    { "id": "B", "describe": "app logic", "reviews": ["code", "data"], "approval": "owner" }
  ]
}
```

- A review kind must exist in `models.review` (built-in) or in `reviewers` (custom). Validation fails otherwise.
- `skills` lists installed skills by name. The bundled ones are `ponytail-review` and `security-audit`. Skills resolve from the plugin's `skills/` first, then from `~/.claude/skills`.
- `allow` adds to the read-only tools a reviewer gets.
- `deferredReviews` lists kinds whose reviews wait until the others pass. Default: `["ponytail", "security"]`.

## Agent and prompt overrides

Override a plugin agent with a file in the repo. Forja uses it only after it is merged to main.

- `<repo>/.forja/agents/<role>.md` replaces the agent template for one role: `spec`, `builder`, `approver`, `advisor`, `review-code`, `review-ui`, `review-ponytail`, `review-security`, or a custom reviewer's agent file.
- `<repo>/.forja/prompts/<code|ui|build|goldfish>.md` replaces the prompt that external vendors receive for that step.

Copy the plugin's template as a starting point, then change only what the project needs.

## Checks

```json
{
  "checks": {
    "install": "npm ci",
    "typecheck": "npm run -s typecheck",
    "test": "npm test",
    "build": null,
    "deployTest": null,
    "deploy": null
  }
}
```

Each command runs in the worktree. `null` skips the check. `deployTest` runs automatically after merge. `deploy` is optional; without it, `merged` is the final state.

## UI contract

```json
{
  "ui": {
    "paths": ["src/components/**", "**/*.css"],
    "serve": "npm run -s dev -- --port $PORT",
    "verify": "npm run -s screenshots -- $BASE_URL",
    "widths": [390, 1440]
  }
}
```

A diff that touches `ui.paths` counts as a UI change. Screenshots are taken with Playwright's chromium, which `/forja:doctor` checks for; `ui.verify` is the command that takes `$BASE_URL` and writes them. Without `ui`, or without Playwright, the `ui` review is skipped and the dashboard says why.

## Privacy

```json
{
  "privacy": {
    "denyRead": ["**/.env*", "data/**"],
    "promptRules": ["Never print customer tax IDs."]
  }
}
```

- `denyRead` becomes a `Read(...)` deny rule for every agent, so the agent cannot open those files.
- `promptRules` are added to every agent prompt as hard rules.
- `.forja/**`, `.github/workflows/**` and `.claude/**` are always protected. The builder cannot edit them, and any diff that touches them needs owner approval, whatever its tier.

## Commit and PR style

```json
{
  "commit": { "pattern": "^(Add|Fix|Update) .*[^.]$", "guidance": "Imperative verb, sentence case, no period." },
  "pr": { "bodyTemplate": "Closes #{issue}\n\n{summary}" }
}
```

`commit.pattern` is a regex the builder's commit subject must match. `pr.bodyTemplate` takes `{issue}` and `{summary}`.

## Other keys

- `approvers`: logins allowed to label issues and run `/approve` or `/redo`.
- `language`: `en` or `pt-BR`. Strings shown to people come from `engine/i18n/<lang>.json`.
- `intakeLabel`: the label that starts a job. Default `forja`.
- `queue.max`: how many jobs build at once. Default `3`.
- `limits.rounds`: review rounds before a job goes to `needs-you`. Default `3`.
- `goldfish`: boolean switch (default `true`) for a check where a model that sees only the spec and the repo tries to break it. Its model chain is `models.goldfish`. It runs only on tiers above the lowest, and never on the spec's own model.
- `notify.desktop`: desktop notifications when a job needs the owner.

## Workflow after a change

1. Edit `.forja/config.json` or an override file in the repo.
2. Commit the change and merge it to main yourself. Claude never commits or pushes for you. The runner reads config only from `forja-main`, so until the change is merged it has no effect.
3. Run `/forja:doctor`.
