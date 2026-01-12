<!-- EXTEND: pack-constitution -->
## Happy Stacks execution discipline (MANDATORY)

- **Task structure is mandatory (fail-closed via guards)**:
  - Create a **parent task** first (`hs_kind: parent`) that declares:
    - `components: [happy, happy-cli, ...]`
    - (Parent tasks can span multiple tracks/stacks and are **not claimable**.)
  - Create **one track task per track** (`hs_kind: track`) as a child of the parent:
    - **One stack per track**: `stack: <name>`
    - `track: upstream|fork|integration`
    - `components: [...]` (what this stack pins)
    - `base_task: <parent-task-id>`
  - Create **one component task per component** (`hs_kind: component`) as a child of a track task:
    - `stack` must match the track task stack
    - `component: happy` (exactly one)
    - `base_task: <parent-task-id>`
    - `base_worktree: edison/<task-id>`
  - **Never claim/finish the parent task**; claim a track or component task instead.

- **Only run project commands via `happys ...`**.
  - Do **not** run `pnpm/yarn/npm/expo/tsc/docker compose` directly inside component repos.
  - Route everything through `happys` so stacks/env/worktrees/ports stay isolated.
  - Do **not** run `edison ...` directly in this repo:
    - Use `happys edison -- <edison args...>`
    - Use `happys edison --stack=<stack> -- <edison args...>` for task/evidence/validation
    - See: `.edison/guidelines/agents/HAPPY_STACKS_EDISON_WRAPPER.md`
  - If any core Edison docs mention “worktree confinement” or `edison exec` workflows:
    - Treat them as **not applicable** to happy-local (Edison worktrees are disabled here).
    - Happy Stacks rules override.

- **Develop in component worktrees only**.
  - Do **not** edit `components/<component>` default checkouts.
  - Use `happys wt new ...` / `happys wt pr ...` and open/edit in the worktree directory under `components/.worktrees/...`.

- **Test changes inside an isolated stack** (not `main`).
  - Create a stack: `happys stack new <name> --interactive`
  - Point the stack at your worktree: `happys stack wt <name> -- use <component> <owner/branch>`
  - Recommended (one-shot): scaffold the whole structure + stacks + worktrees:
    - `happys edison task:scaffold <parent-task-id> --mode=upstream|fork|both --yes`
  - **Fail-closed**: Edison task transitions require running inside the correct stack context:
    - `happys edison --stack=<stack> -- <edison command>`
  - Helpful reads:
    - `happys edison -- read START_PLAN_FEATURE --type start`
    - `happys edison -- read START_VALIDATE_TASK --type start`
    - `happys edison -- read START_HAPPY_STACKS_NEW_SESSION --type start`

- **Auth failures: prefer copy-from main** (non-interactive, safe).
  - `happys stack auth <stack> copy-from main`

- **Multiple daemons are expected** with multiple stacks.
  - Do **not** kill all daemons. Diagnose per stack.

## Evidence (trusted runner)

- Capture required evidence via Edison:
  - `happys edison --stack=<stack> -- evidence capture <task-id>`
  - This runs stack-scoped `happys stack typecheck/lint/build/test` and fingerprints the *actual* component repos used by that stack.
<!-- /EXTEND -->

