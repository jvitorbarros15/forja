# Contributing

Use Node.js 22 or newer and run `npm test` from the repository root. The suite uses `node:test` and needs no install step. Keep Forja free of npm dependencies and add a test for every fix.

CI runs on Windows, macOS, and Linux. Keep paths, shell commands, and process handling portable across all three.

To run the engine and local dashboard, follow the [README quick start](README.md#quick-start) in a GitHub repository with the plugin installed. Run `/forja:setup`, commit and merge `.forja/config.json` to the default branch, then run `/forja:start` and open the dashboard URL it prints. Run `/forja:stop` to stop both.

Start commit messages with an imperative verb and use sentence case, with no trailing period or Conventional Commits prefix. Example subjects are `Fix X` and `Add Y`.
