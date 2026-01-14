<!-- EXTEND: pack-constitution -->
## Happy Stacks validation guardrails (MANDATORY)

- **Do not recommend killing all daemons**. Multiple daemons are expected (one per stack).
- **Do not recommend bypassing `happys`** (no direct `pnpm/yarn/expo/docker compose`).
- **Do not run `edison ...` directly**:
  - Use `happys edison --stack=<stack> -- <edison args...>`
- **Validate stack-scoped behavior**:
  - Evidence should come from `happys edison --stack=<stack> -- evidence capture <task-id>`.
  - If evidence is missing, instruct operators to rerun with the correct `--stack` (fail-closed).

## Happy Stacks scope discipline (CRITICAL)

- **Validate only the repos/worktrees targeted by the task** (the component repos pinned by the stack).
  - For `hs_kind=component` tasks, the scope is the single `component:` repo in the task frontmatter.
  - For `hs_kind=track` tasks, the scope is the `components:` list in the task frontmatter.
- **Do not validate the happy-local orchestration repo by default**.
  - In multi-session development, the happy-local root worktree may be `gitDirty` with unrelated, in-flight work.
  - Treat root `git status` / `git diff` as **non-blocking context** unless the task explicitly targets the orchestration repo.
- **Fail-closed only on targeted repos**:
  - Reject if the *target component worktree* is dirty (uncommitted diffs) or evidence is missing/failing.
  - Do **not** reject just because happy-local root is dirty when the task does not include `happy-local` / `happy-stacks` as a component.
- **How to review the right code**:
  - Use the stack-resolved component dirs printed by the wrapper (`[edison] component dirs (from stack env): ...`).
  - If you need git status/diff, run them inside the component worktree directory (or via `happys wt git <component> ...`).
  - If the validator prompt lists “Changed Files (Detected)” in happy-local root that are unrelated to the targeted component repos, **ignore them** for scope/risk decisions.
<!-- /EXTEND -->

