// Compatibility barrel for Happy Stacks CLI utilities.
//
// Many utils import `./paths.mjs` historically. The canonical implementations now live under
// `./paths/paths.mjs` (and related modules under `./paths/`).
//
// Keep this file as the single re-export so callers stay stable.
export * from './paths/paths.mjs';

