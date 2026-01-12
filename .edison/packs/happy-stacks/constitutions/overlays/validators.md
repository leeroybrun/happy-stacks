<!-- EXTEND: pack-constitution -->
## Happy Stacks validation guardrails (MANDATORY)

- **Do not recommend killing all daemons**. Multiple daemons are expected (one per stack).
- **Do not recommend bypassing `happys`** (no direct `pnpm/yarn/expo/docker compose`).
- **Do not run `edison ...` directly**:
  - Use `happys edison --stack=<stack> -- <edison args...>`
- **Validate stack-scoped behavior**:
  - Evidence should come from `happys edison --stack=<stack> -- evidence capture <task-id>`.
  - If evidence is missing, instruct operators to rerun with the correct `--stack` (fail-closed).
<!-- /EXTEND -->

