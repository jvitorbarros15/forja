# Changelog

## 0.1.0 - 2026-11-27

### Added

- Claude Code commands to set up, start, diagnose, inspect, and stop Forja.
- Intake from labeled GitHub issues, with a queue for issues awaiting labels.
- A pipeline that turns an issue into a spec, builds in a dedicated Git worktree, reviews the change, and opens a pull request.
- Configurable risk tiers that set review requirements, approval rules, and allowed paths.
- A build model ladder and review model selection that prefers a different vendor from the builder.
- Claude-only operation with optional Codex, Gemini, and Antigravity CLI support and optional Ollama triage.
- A blind spec review for higher tiers when an external model is configured for goldfish.
- Code, UI, ponytail, and security reviews, with configurable reviewers and optional Playwright screenshots.
- Owner approval by default, with opt-in path-limited auto approval and required owner approval for protected paths.
- A local dashboard for tracking jobs and reviews, approving changes, requesting rework, and deploying. Owners can also approve or request rework with PR comments.
- Rework rounds for failing CI or owner feedback, with jobs handed back to the owner when they get stuck.
- Configurable merge methods, post-merge checks, and optional deployment.
- Configuration and agent overrides loaded from the merged default branch.
- A dependency-free Node.js 22+ engine and CI on Windows, macOS, and Linux.
