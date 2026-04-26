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
- `packages/<name>/.eslintrc.json` (if exists)
- `packages/<name>/assets.json` (if exists)
- `packages/<name>/.npmignore` (if exists)
- `packages/<name>/.gitignore` (if exists)

Also read the reference implementations:

- `packages/devkit/tsconfig.lib.json`
- `packages/devkit/package.json`
- `packages/devkit/project.json`
- `packages/devkit/.npmignore`

Run `pnpm nx show target <name>:build-base` to see the inferred build target.
Run `pnpm nx show target <name>:build` to see the full build target.

### 2. Identify entry points

Look at the package's root `.ts` files and any existing `exports` field. Common entry points:

- `index.ts` (main)
- `testing.ts`
- `internal.ts`
- `internal-testing-utils.ts`
- `ngcli-adapter.ts`
- Any other `.ts` files at the package root that re-export from `src/`

Also check for `migrations.json` and `generators.json`/`executors.json` — these need exports entries too.

**You'll likely need to create or expand `internal.ts`.** Before writing the exports map, run:

```bash
grep -rn "from '@nx/<name>/src/" --include="*.ts" .
```

Each unique re-export target found here either needs to live behind an existing public entry point or needs to be added to a new `internal.ts`. Group these into `internal.ts` rather than expanding the main public API surface — `internal.ts` signals "supported within the workspace, not a public guarantee." See `packages/devkit/internal.ts` for the pattern.

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
  "exclude": ["node_modules", "dist", ...existing excludes, ".eslintrc.json"],
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

Add an entry for each subpath export (excluding `.`, `./package.json`, and `./migrations.json`).

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

Also update the `build` target's `dependsOn`: make sure `"^build"` is listed (so dependent packages build first) and `"build-base"` is listed (so this package's compilation happens before any post-processing like copy-readme).

### 7. Update `.eslintrc.json`

Add `"dist"` and `"*.d.ts"` to `ignorePatterns`:

```json
"ignorePatterns": ["!**/*", "node_modules", "dist", "*.d.ts"]
```

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

Two files in `astro-docs/src/plugins/utils/` need updates — both, not just the obvious one:

**`devkit-generation.ts`** (or the equivalent for your package): updates the entry-point lookup paths. Move `'dist'` from before `'packages', '<name>'` to after, so the path is `packages/<name>/dist/index.d.ts` instead of `dist/packages/<name>/index.d.ts`.

**`typedoc/typedoc.ts`** (devkit-only currently, but check if your package wires up TypeDoc):

- Change `buildDir` away from `join(workspaceRoot, 'dist', 'packages', '<name>')` — for devkit this became `join(tempDir, 'build')`.
- Update `compilerOptions.paths` to map workspace packages to local dists:
  ```
  'nx/*': ['packages/nx/dist/*', 'packages/nx/src/*'],
  '@nx/*': ['packages/*/dist/*', 'packages/*/src/*'],
  ```
- Add the package's `dist/**/*.d.ts` to `tsconfigObj.include` (use absolute paths since the tsconfig is written to a temp dir).
- Filter `'dist'` out of `tsconfigObj.exclude` so the dist `.d.ts` files aren't excluded.

Without the include + exclude tweak, TypeDoc picks up the source `.ts` but can't see the dist `.d.ts` entry points and produces empty API pages.

### 13. Update `scripts/nx-release.ts`

If the package has special release handling in `scripts/nx-release.ts` (like devkit's `hackFixForDevkitPeerDependencies`), update any paths from `./dist/packages/<name>/` to `./packages/<name>/`.

### 14. Update `scripts/patched-jest-resolver.js`

Add `'@nx/nx-source'` to the `conditionNames` array (first entry) so Jest resolves workspace packages to their source via the new exports map condition:

```js
const enhancedResolver = require('enhanced-resolve').create.sync({
  conditionNames: ['@nx/nx-source', 'require', 'node', 'default'],
  ...
});
```

Without this, unit tests that import `@nx/<name>` will resolve to `dist/index.js`, which may not exist or may be stale. **This is a one-time change for the workspace** — once it's in place for the first migrated package, you don't need to redo it for subsequent packages.

### 15. Update module-path patches

Search for hardcoded references to `dist/packages/<name>` in patch files (these short-circuit Node's module resolver):

```bash
grep -rn "dist/packages/<name>" --include="*.js" --include="*.cjs" --include="*.mjs" .
```

Notable spots:

- `examples/angular-rspack/patch-devkit-request-path.js` (and similar) — change `path.resolve(__dirname, '../../dist/packages/<name>')` to `path.resolve(__dirname, '../../packages/<name>')`. The dist folder is now nested inside the package, so the package root resolves correctly via its `main`/`exports`.
- Any `tools/patches/**` files.

### 16. Update imports across the workspace

Search for imports from `@nx/<name>/src/` across all other packages. These internal imports need to be updated:

- If the imported thing is re-exported through a public entry point (index.ts, internal.ts, etc.), update the import to use that entry point.
- If not, **add it to `internal.ts`** (creating that file if it doesn't exist) and update the import. The exports map is strict — `@nx/<name>/src/...` paths stop working entirely once the migration is in place, so anything previously imported via that path needs an entry-point home.

Use:

```bash
grep -rn "from '@nx/<name>/src/" --include="*.ts" .
```

Also check for imports in:

- `e2e/` tests — common offenders are tiny utility imports like `@nx/devkit/src/utils/string-utils`. For e2e tests, prefer inlining the utility (a one-line helper) over expanding the public API just to feed an e2e test.
- `scripts/`
- `tools/workspace-plugin/`
- `astro-docs/`
- `examples/`

### 17. Update e2e tests with hardcoded dist paths

Separate from imports: search e2e test bodies for hardcoded path strings referring to the old layout:

```bash
grep -rn "dist/packages/<name>" e2e/ --include="*.ts"
```

For example, `e2e/nx-build/src/nx-build.test.ts` verifies build output paths and had `'dist/packages/devkit/index.js'` hardcoded — needs to become `'packages/devkit/dist/index.js'`. These are easy to miss because they look like strings, not imports.

### 18. Verify

```bash
pnpm nx run-many -t test,build,lint -p <name>
pnpm nx affected -t build,test,lint
pnpm nx prepush
```

Also run e2e for affected projects — the migration changes the affected graph, which can surface latent failures in dependent e2e tests:

```bash
pnpm nx affected -t e2e-local
```

If a dependent e2e test fails for reasons unrelated to your migration (pre-existing flake/bug in another package), fix it in a separate PR rather than bundling it into the migration. The migration PR should only contain migration changes.

### Summary of the pattern

The core idea is simple: instead of building to a shared `dist/packages/<name>/` at the workspace root, each package builds to its own `packages/<name>/dist/`. The `exports` map with `@nx/nx-source` condition lets workspace packages resolve to `.ts` source files during development, while external consumers get the built `.js` from `dist/`. This is like giving each package its own "output mailbox" instead of sharing one big mailbox.
