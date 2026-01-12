<!-- EXTEND: pack-constitution -->
## Happy Stacks orchestration rules (MANDATORY)

- **Edison must be invoked through Happy Stacks**:
  - Do **not** run `edison ...` directly in this repo.
  - Always run:
    - `happys edison -- <edison args...>`
    - `happys edison --stack=<stack> -- <edison args...>` (recommended)
  - See: `.edison/guidelines/agents/HAPPY_STACKS_EDISON_WRAPPER.md`
  - Useful reads:
    - `happys edison -- read START_PLAN_FEATURE --type start`
    - `happys edison -- read START_VALIDATE_TASK --type start`
    - `happys edison -- read START_HAPPY_STACKS_NEW_SESSION --type start`

- **Task decomposition is mandatory**:
  - Create a **parent** task first (`hs_kind: parent`) that declares the overall `components: [...]`.
  - Create **one track task per track** (`hs_kind: track`) linked under the parent:
    - One stack per track: `stack: <name>`
    - `track: upstream|fork|integration`
    - `components: [...]` (the exact set pinned into that stack)
    - `base_task: <parent-task-id>`
  - Create **one component task per component** (`hs_kind: component`) linked under the track:
    - `stack` must match the track’s stack
    - `component: <one>`
    - `base_task: <parent-task-id>`
    - `base_worktree: edison/<task-id>`
  - Prefer assigning/claiming work at the **component task** level; validate at the **track task** level.
  - Recommended: use `happys edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`.

- **Upstream-first workflow**:
  - Implement in an upstream-based worktree (`--from=upstream`) when the change should be upstreamed.
  - Keep upstream PR branches clean and upstream-acceptable.
  - Validate on our fork via test-merge / cherry-pick workflow.

- **Do not repoint main stack by accident**:
  - Prefer creating a new stack for PR testing and repointing components there.
  - Use `--force` only when explicitly intended.

- **Evidence is stack-scoped by default**:
  - Run: `happys edison --stack=<stack> -- evidence capture <task-id>`
  - This ensures evidence reflects the exact component repos/worktrees the stack uses.
<!-- /EXTEND -->

