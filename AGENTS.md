# Codex Workflow

This file records the implementation process for Codex sessions in this repo.

## Workflow

- Work on one feature or one bug fix in a separate dedicated branch.
- Keep commits atomic and task-focused.
- Do not open or merge a PR until the changes are ready for review.
- Use PR descriptions with these sections:
  - `## Summary`
  - `## Key Changes`
- Example formatting can be taken from PR #17 and PR #18.
- Do not merge into `main` until explicitly instructed to `merge`.
- After merge, clean up the leftover branch locally and remotely.
- After cleanup, switch back to `main` and pull the latest changes.
- Use branch prefixes like `fix/...`, `feat/...`, `docs/...`, `chore/...`, or `revert/...` to cover the common scopes.

## Notes

- This file is intentionally ignored by Git so the workflow can stay local to this workspace.
