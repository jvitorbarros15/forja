# Security policy

## Supported versions

Security fixes are provided for Forja 0.1.x.

## Reporting a vulnerability

Open the repository's [Security tab](https://github.com/jvitorbarros15/forja/security/advisories) and select **Report a vulnerability** to submit a private report. Include the affected version, steps to reproduce, and the impact.

## Scope

Forja runs agent CLIs and check commands in job worktrees with your user rights, environment, and GitHub CLI credentials. Check commands can execute code the builder wrote, and Forja cannot sandbox them.

The trust boundary is the `approvers` list and owner approval. Only logins on that list can label issues or run `/approve` and `/redo`. Every tier requires owner approval by default. Auto approval is opt-in and path-bound, and changes to protected paths always require owner approval. See the [README safety model](README.md#safety-model).
