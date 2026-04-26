---
name: dist-build-migration
description: Migrate an Nx package to build to a local dist/ directory with nodenext module resolution, exports map, and @nx/nx-source condition.
allowed-tools: Bash, Read, Glob, Grep, Agent, Edit, Write
---

# Migrate Package to Local Dist Build

You are migrating an Nx monorepo package from building to `../../dist/packages/<name>` to building locally to `packages/<name>/dist/`. This matches the pattern already used by `nx` and `devkit`.

## Argument

The user provides a package name (e.g., `js`, `webpack`, `angular`). The package lives at `packages/<name>/`.

## Steps

### 1. Read current state

Read these files for the target package:

- `packages/<name>/package.json`
- `packages/<name>/project.json`
- `packages/<name>/tsconfig.lib.json`
- `packages/<name>/tsconfig.spec.json` (if exists)
- `packages/<name>/eslint.config.mjs` (or `.cjs`/`.js`) — flat config
- `packages/<name>/assets.json` (if exists)
- `packages/<name>/.npmignore` (if exists)
- `packages/<name>/.gitignore` (if exists)

Also read the reference implementations (post-migration shape):

- `packages/devkit/tsconfig.lib.json`
- `packages/devkit/package.json` (note the `files` field replaces `.npmignore`, and `exports`/`typesVersions`/`main`/`types` are all rewritten)
- `packages/devkit/project.json`
- `packages/devkit/eslint.config.mjs`

Run `pnpm nx show target <name>:build-base` to see the inferred build target.
Run `pnpm nx show target <name>:build` to see the full build target.

Inventory consumers up front so you know the blast radius before editing anything:

```bash
grep -rn "@nx/<name>" packages/ e2e/ scripts/ tools/ astro-docs/ examples/ --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" -l | sort -u
```

This identifies every file that will need a sweep in Steps 15–17. A package with hundreds of consumers is a multi-PR effort; a package with a dozen is one PR.

### 2. Identify entry points

Look at the package's root `.ts` files and any existing `exports` field. Common entry points:

- `index.ts` (main)
- `testing.ts`
- `internal.ts`
- `internal-testing-utils.ts`
- `ngcli-adapter.ts`
- Any other `.ts` files at the package root that re-export from `src/`

Also check for `migrations.json` and `generators.json`/`executors.json` — these need exports entries too.

**Inventory private subpath consumers before writing the exports map.** Run:

```bash
grep -rn "from '@nx/<name>/src/" --include="*.ts" .
```

Each unique re-export target either lives behind an existing public entry point or needs to be added to a new/expanded `internal.ts`. Group these into `internal.ts` rather than expanding the main public API surface — `internal.ts` signals "supported within the workspace, not a public guarantee." See `packages/devkit/internal.ts` for the pattern. Step 16 will rewrite the call sites once `internal.ts` is in place.

### 3. Update `tsconfig.lib.json`

Transform from the old pattern to the new pattern:

**Before:**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "outDir": "../../dist/packages/<name>",
    "tsBuildInfoFile": "../../dist/packages/<name>/tsconfig.tsbuildinfo"
  }
}
```

**After:**

```json
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "declarationDir": "dist",
    "declarationMap": false,
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo",
    "types": ["node"],
    "composite": true,
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true
  },
  "exclude": ["node_modules", "dist", ...existing excludes, "eslint.config.mjs"],
  "include": ["*.ts", "src/**/*.ts"]
}
```

**Important**: Adjust `include` based on the package's actual structure. If the package has directories like `bin/`, `plugins/`, etc. at the root level (like `nx` does), include those too.

### 4. Update `tsconfig.spec.json` (if exists)

Change `outDir` from `../../dist/packages/<name>/spec` to `dist/spec`.

### 5. Update `package.json`

Key changes:

- Add `"type": "commonjs"` near the top (after `private`)
- Change `"main"` to `"./dist/index.js"`
- Change `"types"` to `"./dist/index.d.ts"`
- Add `"typesVersions"` for backwards compatibility with `moduleResolution: "node"` consumers
- Add `"exports"` map with entries for each entry point

Each export entry follows this pattern:

```json
"./entry-name": {
  "@nx/nx-source": "./entry-name.ts",
  "types": "./entry-name.d.ts",
  "default": "./dist/entry-name.js"
}
```

The main entry (`.`) uses `./index.ts`, `./index.d.ts`, `./dist/index.js`.

Always include:

```json
"./package.json": "./package.json"
```

Include `"./migrations.json": "./migrations.json"` if the package has migrations.

**Note**: The `@nx/nx-source` condition is a custom condition used for source-level resolution within the workspace (so other packages import from source, not dist).

Add a `typesVersions` field for consumers using `moduleResolution: "node"` (which doesn't read `exports`):

```json
"typesVersions": {
  "*": {
    "testing": ["dist/testing.d.ts"],
    "ngcli-adapter": ["dist/ngcli-adapter.d.ts"]
  }
}
```

Add an entry for each subpath export (excluding `.`, `./package.json`, and `./migrations.json`). Each `typesVersions` path must match the actual emitted `.d.ts` location under `dist/` — if `tsc` emits to a different relative path (e.g. `dist/src/foo.d.ts`), update the entry to match.

### 6. Update `project.json`

Add these sections:

```json
{
  "release": {
    "version": {
      "generator": "@nx/js:release-version",
      "preserveLocalDependencyProtocols": true,
      "manifestRootsToUpdate": ["packages/{projectName}"]
    }
  },
  "targets": {
    "nx-release-publish": {
      "options": {
        "packageRoot": "packages/{projectName}"
      }
    },
    "build-base": {
      "outputs": [
        "{projectRoot}/dist/**/*.{js,cjs,mjs,d.ts}",
        "{projectRoot}/*.d.ts",
        "{projectRoot}/src/**/*.d.ts"
      ]
    }
  }
}
```

Update the existing `build` target's `outputs` if they reference `{workspaceRoot}/dist/packages/<name>` — they should now reference `{projectRoot}/dist/`.

Ensure the `build` target's `dependsOn` lists `^build` and `build-base`.

### 7. Update `eslint.config.mjs`

The repo uses ESLint flat config. Add an `ignores` block near the top of the exported config array (right after `...baseConfig`) so the new build outputs aren't linted:

```js
export default [
  ...baseConfig,
  {
    ignores: ['dist', '**/*.d.ts'],
  },
  // ...rest of the config
];
```

Note: flat config uses `ignores`, not the old `.eslintrc.json` `ignorePatterns` field. If your package still has an `.eslintrc.json`, that means it hasn't been migrated to flat config yet — handle that conversion separately, not as part of the dist-build migration.

### 8. Update `assets.json` (if exists)

Change `outDir` from `"dist/packages/<name>"` to `"packages/<name>/dist"`.

### 9. Add `files` field to `package.json`

Instead of using `.npmignore`, add a `"files"` field to `package.json` (matching the `nx` package pattern). Remove `.npmignore` if it exists.

```json
"files": [
  "dist",
  "!dist/tsconfig.tsbuildinfo",
  "migrations.json"
]
```

Adjust based on the package's needs:

- Add `"executors.json"` and/or `"generators.json"` if the package has them
- Add any other non-TS files that need to be published
- npm always includes `package.json` and `README.md` automatically — no need to list them

### 10. Rename README.md and update build command

If the package has a `README.md` at its root and uses the `copy-readme.js` script in its build target:

1. Rename `README.md` to `readme-template.md` (`git mv`)
2. Update the build command to pass explicit paths:
   ```
   node ./scripts/copy-readme.js <name> packages/<name>/readme-template.md packages/<name>/README.md
   ```
3. Update the build target `outputs` to `["{projectRoot}/README.md"]`

The script's default behavior reads `packages/<name>/README.md` and writes to `dist/packages/<name>/README.md` — both wrong for the new layout. Passing explicit args fixes both.

### 11. Update root `.gitignore`

Add two entries to the workspace root `.gitignore`:

1. Under the section that lists generated README files (look for `packages/nx/README.md`), add:

   ```
   packages/<name>/README.md
   ```

2. Under the section that lists generated `.d.ts` files (look for `packages/nx/**/*.d.ts`), add:
   ```
   packages/<name>/**/*.d.ts
   ```

These are build outputs that shouldn't be committed.

### 12. Update docs generation paths

Sweep `astro-docs/src/plugins/utils/` for references to `<name>` and to the old layout:

```bash
grep -rn "<name>\|dist/packages" astro-docs/src/plugins/utils/
```

Expect hits in two files:

**`<name>-generation.ts`** (e.g. `devkit-generation.ts`): rewrite entry-point lookup paths. Move `'dist'` from before `'packages', '<name>'` to after, so the path becomes `packages/<name>/dist/index.d.ts`.

**`typedoc/typedoc.ts`** (only the packages that wire up TypeDoc; devkit is the current example):

- Set `buildDir` to a temp location (`join(tempDir, 'build')`) instead of `join(workspaceRoot, 'dist', 'packages', '<name>')`.
- Set `compilerOptions.baseUrl = workspaceRoot` so the `paths` entries resolve.
- Map `compilerOptions.paths` to local dists:
  ```jsonc
  {
    "nx/*": ["packages/nx/dist/*", "packages/nx/src/*"],
    "@nx/*": ["packages/*/dist/*", "packages/*/src/*"],
  }
  ```
  This is workspace-wide — once it's set, future packages are covered by the `@nx/*` glob.
- Append the package's `dist/**/*.d.ts` to `tsconfigObj.include` using an absolute path (the tsconfig is written to a temp dir, so relative paths break).
- Remove `'dist'` from `tsconfigObj.exclude` so the dist `.d.ts` files are visible to TypeDoc.

Without the include + exclude pair, TypeDoc picks up source `.ts` but can't see the dist `.d.ts` entry points and produces empty API pages — and `nx prepush` won't catch this. Verify by running `nx build astro-docs` (or whatever target produces the docs site) and inspecting the generated API page.

### 13. Update `scripts/nx-release.ts`

If the package has special release handling in `scripts/nx-release.ts` (like devkit's `hackFixForDevkitPeerDependencies`), update any paths from `./dist/packages/<name>/` to `./packages/<name>/`.

### 14. Update `scripts/patched-jest-resolver.js`

Two changes — one is workspace-wide (do once), one is per-package:

**Workspace-wide (one-time):** Add `'@nx/nx-source'` as the first entry of `conditionNames` so Jest resolves workspace packages to their source via the exports-map condition:

```js
const enhancedResolver = require('enhanced-resolve').create.sync({
  conditionNames: ['@nx/nx-source', 'require', 'node', 'default'],
  ...
});
```

Without this, unit tests that import `@nx/<name>` resolve to `dist/index.js`, which may not exist or may be stale.

**Per-package:** Inspect the `workspacePackages` allowlist and any `@nx/*/src/*` short-circuit branches in the same file. If your package isn't already listed, add it. If a short-circuit lets the old `@nx/<name>/src/...` import paths resolve from source regardless of the exports map, decide whether to keep that compatibility (eases migration of dependent specs) or remove it (forces all callers onto the new entry points). The short-circuit can mask exports-map bugs, so don't rely on passing specs as proof the migration is clean — see Step 16.

### 15. Update module-path patches

Patch files short-circuit Node's module resolver and tend to hardcode dist paths. Find them:

```bash
grep -rn "dist/packages/<name>" --include="*.js" --include="*.cjs" --include="*.mjs" .
```

Update each hit by dropping the leading `dist/` segment — `path.resolve(__dirname, '../../dist/packages/<name>')` becomes `path.resolve(__dirname, '../../packages/<name>')`. The dist folder is now nested inside the package, so the package root resolves via its own `main`/`exports`.

A single patch file may reference multiple packages (e.g. `examples/angular-rspack/patch-devkit-request-path.js` patches devkit _and_ `@nx/module-federation/angular`). Update only the entry for the package you're migrating; leave the rest until those packages are migrated too.

`nx prepush` will not exercise these patches if they're consumed by example apps or external integrations. Verify by running the consumer (e.g. building/serving the example app).

### 16. Rewrite call sites for `@nx/<name>/src/...` imports

Re-run the Step 2 grep, then update each match to import from a public or `internal.ts` entry point. The exports map is strict: `@nx/<name>/src/...` stops working at runtime once the migration is in place.

Locations to sweep — `e2e/`, `scripts/`, `tools/workspace-plugin/`, `astro-docs/`, `examples/`. In `tools/workspace-plugin/` watch out for generator template files (`*.template.ts`, files under `files/`) — strings inside templates that look like `from '@nx/<name>/src/...'` are emitted into generated user code and only matter if you also intend to change what the generator produces.

Two caveats:

- **e2e tests**: tiny utility imports (e.g. `@nx/devkit/src/utils/string-utils`) are common offenders. Prefer inlining a one-line helper over expanding the public API just to feed an e2e test.
- **`jest.mock`/`jest.spyOn`**: a spec that mocks `@nx/<name>/src/utils/foo` and one that mocks `@nx/<name>/internal` resolve to different module identities. Mocks may need to be retargeted, not just import paths. The resolver in `scripts/patched-jest-resolver.js` may keep the old subpath working in tests even though it fails at runtime — don't trust passing specs as proof the migration is clean.

### 17. Update e2e tests with hardcoded dist paths

Separate from imports: search e2e test bodies for hardcoded path strings referring to the old layout:

```bash
grep -rn "dist/packages/<name>" e2e/ --include="*.ts"
```

Replace each `dist/packages/<name>/...` with `packages/<name>/dist/...`. These are easy to miss because they're string literals, not imports.

A single e2e test file may enumerate many packages (e.g. `e2e/nx-build/src/nx-build.test.ts` checks build outputs for devkit, js, react, and others). Update only the entries for the package being migrated.

### 18. Verify

```bash
pnpm nx run-many -t test,build,lint -p <name>
pnpm nx affected -t build,test,lint
pnpm nx prepush
pnpm nx affected -t e2e-local
```

The affected-graph changes after migration can surface latent failures in dependent e2e tests. If a dependent e2e fails for reasons unrelated to your migration (pre-existing flake/bug elsewhere), fix it in a separate PR — the migration PR should only contain migration changes.

`nx prepush` does **not** cover:

- Module-path patches consumed by example apps (Step 15) — run the example.
- Empty TypeDoc API pages (Step 12) — build `astro-docs` and inspect the API page.
- Cross-package e2e regressions on macOS/Windows runners — surface only in CI.

Treat those three as manual checks before opening the PR.

### Summary of the pattern

The core idea is simple: instead of building to a shared `dist/packages/<name>/` at the workspace root, each package builds to its own `packages/<name>/dist/`. The `exports` map with `@nx/nx-source` condition lets workspace packages resolve to `.ts` source files during development, while external consumers get the built `.js` from `dist/`. This is like giving each package its own "output mailbox" instead of sharing one big mailbox.
