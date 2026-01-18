# Isolated Linux VM (Apple Silicon) for `review-pr`

If you want to validate `happys review-pr` on a **fresh system** (no existing `~/.happy-stacks`, no host tooling), the simplest repeatable approach on Apple Silicon is a Linux VM managed by **Lima** (it uses Apple’s Virtualization.framework).

This avoids Docker/container UX issues (browser opening, Expo networking, file watching) while still being truly “clean”.

## Option A (recommended): Lima + Ubuntu ARM64

### 1) Install Lima (macOS host)

```bash
brew install lima
```

### 2) Create a VM

```bash
limactl create --name happy-pr --tty=false template://ubuntu-24.04
limactl start happy-pr
```

### 3) Provision the VM (Node + build deps)

```bash
limactl shell happy-pr
```

Inside the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/leeroybrun/happy-local/main/scripts/provision/linux-ubuntu-review-pr.sh -o /tmp/linux-ubuntu-review-pr.sh && chmod +x /tmp/linux-ubuntu-review-pr.sh && /tmp/linux-ubuntu-review-pr.sh
```

### 4) Run `review-pr` via `npx` (published package)

Inside the VM:

```bash
npx --yes happy-stacks@latest review-pr \
  --happy=https://github.com/leeroybrun/happy/pull/10 \
  --happy-cli=https://github.com/leeroybrun/happy-cli/pull/12 \
  --no-mobile \
  --verbose
```

Notes:
- `--no-mobile` keeps the validation focused (Expo mobile dev-client adds more host requirements).
- You can also add `--keep-sandbox` if you want to inspect the sandbox contents after a failure.
- For full reproducibility, pin the version: `npx --yes happy-stacks@0.3.0 review-pr ...`

### Optional: test **unreleased local changes**

If you need to test changes that aren’t published to npm yet:

1) On your Mac (repo checkout):

```bash
npm pack
```

2) Copy the generated `happy-stacks-*.tgz` into the VM (any method you like), then inside the VM:

```bash
npx --yes ./happy-stacks-*.tgz review-pr ...
```

## Option B: GUI VM (UTM) – simplest when you want a “real desktop”

If you want the most realistic “reviewer” experience (open browser, etc.), a GUI VM is great:

1. Install UTM (macOS host): `brew install --cask utm`
2. Create an Ubuntu 24.04 ARM64 VM (UTM wizard).
3. Run the same provisioning + `node bin/happys.mjs review-pr ...` inside the VM.

## Option C: Apple “container” / Docker

Containers are excellent for server-only validation, but are usually **not** the best fit for end-to-end `review-pr` UX because:
- opening the host browser from inside the container is awkward
- Expo/dev-server workflows and networking tend to require extra port mapping and host interaction

Use containers only if you explicitly want “CLI-only” checks and are okay opening URLs manually.

