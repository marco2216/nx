# Rollout plan — `{workspaceRoot}/tsconfig.json` input fan-out

Self-contained execution doc for a fresh agent session.

## The bug

Several Nx executors and createNodes plugins call `isUsingTsSolutionSetup()` at task runtime. That function reads `{workspaceRoot}/tsconfig.json` (specifically the `extends`, `files`, `include` fields) to decide whether the workspace is in TS-solution mode. The boolean it returns gates real, output-affecting behavior: which command runs (`tsc --build` vs per-file `tsc -p`), which `syncGenerators` are wired up, where artifacts land (`videosFolder`/`screenshotsFolder` in cypress), whether typecheck runs before build (vite), whether `useTsconfigPaths` is on (rspack/webpack), etc.

The file is not declared as a task input anywhere. The native hasher's auto-added `TsConfiguration` instruction hashes `tsconfig.base.json` (preferred) or `tsconfig.json` (fallback) — and in TS-solution workspaces both files exist, so the auto-hasher hashes `tsconfig.base.json` and IGNORES `tsconfig.json`. Result: edits to `tsconfig.json` (the file the executor actually reads) don't change the task hash, so the cache returns stale results and builds run with the wrong configuration.

**Fix shape**: declare `{ json: '{workspaceRoot}/tsconfig.json', fields: ['extends', 'files', 'include'] }` as a task input on every affected target. Already done for `@nx/esbuild` in PR #35432; this doc rolls the same fix out to the other 9 packages.

## TL;DR

Step 0 below is mandatory before any package PR — it adds a shared constant + closes a gap PR #35432 left open. After Step 0, ten package PRs land in tier order. Each per-package section below specifies file:line landing zones from an audit; the agent shouldn't need to re-investigate.

## The exact input shape

```ts
{ json: '{workspaceRoot}/tsconfig.json', fields: ['extends', 'files', 'include'] }
```

Do NOT include `references` (every `nx g lib` would invalidate every cached build) or `compilerOptions` (unrelated tweaks would invalidate). Field-scoped JSON inputs are missing-file safe (verified `packages/nx/src/native/tasks/hashers/hash_json.rs:122-126`).

## Critical trap: "first generator wins"

`packages/devkit/src/generators/target-defaults-utils.ts:14`:

```ts
nxJson.targetDefaults[executorName] ??= { cache: true, dependsOn: [...], inputs: [...] };
```

The `??=` short-circuits if `targetDefaults[executorName]` already exists. **So whichever generator runs first establishes the targetDefaults for that executor — every subsequent call is a no-op.** Means: the rollout MUST update every call site for a given executor or the fix is racy.

Verified gaps in #35432 (which only updated `packages/esbuild/src/generators/configuration/configuration.ts`):

- `packages/node/src/generators/application/lib/create-project.ts:34` — scaffolds `@nx/esbuild:esbuild` without the input. Node app (bundler=esbuild) in a fresh workspace = no fix.

Same trap applies to `@nx/js:swc` and `@nx/js:tsc`, which are scaffolded by **5+ generators across 4 packages**.

## Audit results — every task-runtime tsconfig read in the rollout list

Audited every rollout package's executor + with-nx runtime helpers + createNodes for tsconfig reads. **Single takeaway: `TS_SOLUTION_SETUP_TSCONFIG_INPUT` covers every violation in every package. No additional inputs / fields needed.**

Reads that LOOK related but DON'T need new inputs (already covered):

- **Reads via `getRootTsConfigFileName` / `getRootTsConfigPath`** — covered by the native auto-added `TsConfiguration` instruction (`packages/nx/src/native/tasks/task_hasher.rs:460-511`), which picks the same file via the same priority. Examples found: `@nx/webpack/src/plugins/plugin.ts:156` (registers TS transpiler to load user `webpack.config.ts`); `@nx/rspack/src/plugins/utils/apply-base-config.ts:257`.
- **Reads of project-local `tsconfig.app.json` / `tsconfig.lib.json`** — covered by `default`/`production` (project file globs). Examples: `@nx/js` `determineModuleFormatFromTsConfig` (`tsc.impl.ts:139,179`); `@nx/rollup` with-nx `ts.readConfigFile` (`with-nx.ts:116-121`); `@nx/webpack` `nx-tsconfig-paths-webpack-plugin.ts:37-46`; `@nx/rspack` `nx-tsconfig-paths-rspack-plugin.ts:31-43`; `@nx/rspack` `TsCheckerRspackPlugin.typescript.configFile` (`apply-base-config.ts:304-306`).
- **`getNonBuildableLibs` (`@nx/rspack/src/plugins/utils/apply-base-config.ts:421`)** — reads `package.json`, NOT tsconfig. Lockfile-covered.
- **`walkTsconfigExtendsChain` in `@nx/vite/src/plugins/plugin.ts:799-840`** — used to compute a per-project hash passed to `calculateHashesForCreateNodes` for project-graph integrity. Result does NOT bake into inferred target command/options/syncGenerators. Out of scope for THIS rollout.

### Plan-time vs task-time nuance (don't get confused)

`isUsingTsSolutionSetup()` is called at TWO different layers across the rollout, with different consequences:

- **At plan time, in createNodes** (next/remix/rsbuild/react/vite/rollup): the boolean BAKES into `target.command` / `target.syncGenerators`, so the inferred target's hashable shape changes when the boolean flips. The input must be on the inferred target.
- **At plan time, in createNodes** (webpack/rspack): the boolean is threaded but does NOT bake into target shape. However, the input still belongs on the inferred target because the EXECUTOR the target invokes reads `isUsingTsSolutionSetup()` at task runtime (`webpack/.../normalize-options.ts:21`, `rspack/.../normalize-options.ts:21`, plus their with-nx helpers).
- **At task time, in executor / with-nx runtime helpers** (@nx/js swc.impl.ts, @nx/rollup normalize.ts + with-nx, @nx/vite build.impl.ts, @nx/cypress preset, @nx/webpack/rspack normalize-options + apply-base-config): the read happens during the executor invocation. The input must be on the target's executor-keyed `targetDefaults` (set by `addBuildTargetDefaults`).

Net: same constant, two delivery channels (createNodes inputs array and `addBuildTargetDefaults` extraInputs).

### Per-package read sites (audit-confirmed)

| Package       | Task-runtime sites (executor / with-nx)                                                                               | Plan-time sites baking into inferred target                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@nx/js`      | `swc.impl.ts:31,52,104,141,162`                                                                                       | —                                                                                                                                                                        |
| `@nx/rollup`  | `executors/rollup/lib/normalize.ts:17`; `plugins/with-nx/normalize-options.ts:22`; `plugins/with-nx/with-nx.ts:221`   | `plugins/plugin.ts:62` → bakes into `syncGenerators` (line 212-214)                                                                                                      |
| `@nx/webpack` | `executors/webpack/lib/normalize-options.ts:21`; `plugins/nx-webpack-plugin/lib/apply-base-config.ts:265-266,292-294` | (boolean threaded but NOT baked — input still required for executor-runtime read)                                                                                        |
| `@nx/rspack`  | `executors/rspack/lib/normalize-options.ts:21`; `plugins/utils/apply-base-config.ts:260,270`                          | (boolean threaded but NOT baked — input still required for executor-runtime read)                                                                                        |
| `@nx/vite`    | `executors/build/build.impl.ts:94`; `plugins/nx-tsconfig-paths.plugin.ts:211`                                         | `plugins/plugin.ts:95` → build `syncGenerators` (~line 530), test target `command` (~line 448)                                                                           |
| `@nx/cypress` | `plugins/cypress-preset.ts:60-67` (loaded by executor at runtime)                                                     | `src/plugins/plugin.ts` does NOT call `isUsingTsSolutionSetup` directly, but `getOutputs()` returns paths derived from the preset → outputs correctness concern, see §10 |
| `@nx/next`    | —                                                                                                                     | `plugins/plugin.ts:68` → build/dev `syncGenerators`                                                                                                                      |
| `@nx/remix`   | —                                                                                                                     | `plugins/plugin.ts:78` → build/dev/start `syncGenerators` (lines 272/294/324); typecheck `command` (line 347)                                                            |
| `@nx/rsbuild` | —                                                                                                                     | `plugins/plugin.ts:59` → typecheck `command` (lines 233-235), typecheck `syncGenerators` (lines 255-256)                                                                 |
| `@nx/react`   | —                                                                                                                     | `router-plugin.ts:71` → build/dev/start `syncGenerators`; typecheck `command` (line 323)                                                                                 |

**No reads outside this table** were found in audit. Every read of `tsconfig.json` outside `isUsingTsSolutionSetup` either goes through `getRootTsConfigFileName` (auto-covered) or reads project-local files (`default`-covered).

If the executing agent finds a NEW tsconfig read while implementing a package PR (e.g., a recent commit added a `readJson(tree, 'tsconfig.json')` call somewhere new), STOP and reassess — this rollout's constant is calibrated to `extends`/`files`/`include` only, not new fields.

## Step 0 — Shared constant + close the esbuild gap (do this first, no other PR depends on this style decision but every PR uses the constant)

**Branch**: `fix/tsconfig-input-shared-constant`
**Conventional commit scope**: `js` (the constant lives in @nx/js)
**Commit subject**: `fix(js): export shared TS solution setup tsconfig input`

### Changes

1. `packages/devkit/src/generators/target-defaults-utils.ts` — export a constant near `addBuildTargetDefaults`:

   ```ts
   /**
    * Field-scoped input for the workspace-root `tsconfig.json` covering the
    * exact fields read by `isUsingTsSolutionSetup` (see
    * `packages/js/src/utils/typescript/ts-solution-setup.ts`). Declare on any
    * target whose executor / inferred command is gated on the result of that
    * call so cache hashes change when the relevant fields change.
    */
   export const TS_SOLUTION_SETUP_TSCONFIG_INPUT = {
     json: '{workspaceRoot}/tsconfig.json',
     fields: ['extends', 'files', 'include'],
   } as const;
   ```

2. `packages/js/src/utils/typescript/ts-solution-setup.ts` — export the constant here (it's already where `isUsingTsSolutionSetup` lives).
3. **Close PR #35432 gap**: update `packages/node/src/generators/application/lib/create-project.ts:34` to pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as `extraInputs` (the 4th arg added in #35432). Add a spec asserting the `@nx/esbuild:esbuild` targetDefault carries the input when scaffolded via node's app generator.
4. Replace the inline literal in `packages/esbuild/src/generators/configuration/configuration.ts:59` with `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` (style consistency; keeps the existing tests passing).

### Verification

```bash
nx run-many -t test -p devkit,esbuild,node
```

PR title: `fix(js): export shared TS solution setup tsconfig input`. PR body must mention "Closes the gap from #35432 where node-app esbuild scaffolds missed the input" and reference NXC-4310 + PR #35432.

---

## Prioritized rollout (after Step 0 lands)

Tiers ranked by **confidence × low complexity**. Each item is one PR. Branch names assume `fix/tsconfig-input-<package>`.

| #   | Package                                          | Tier | Generator?    | Plugin? | LOC est.           | Risk       |
| --- | ------------------------------------------------ | ---- | ------------- | ------- | ------------------ | ---------- |
| 1   | `@nx/next`                                       | T1   | —             | yes     | ~30                | low        |
| 2   | `@nx/remix`                                      | T1   | —             | yes     | ~40                | low        |
| 3   | `@nx/rsbuild`                                    | T1   | —             | yes     | ~40                | low        |
| 4   | `@nx/rollup`                                     | T1   | yes           | yes     | ~50                | low        |
| 5   | `@nx/webpack`                                    | T1   | yes           | yes     | ~50                | low        |
| 6   | `@nx/vite`                                       | T1   | yes           | yes     | ~70                | low-medium |
| 7   | `@nx/rspack`                                     | T2   | —             | yes     | ~40                | medium     |
| 8   | `@nx/js` (cross-cutting: js + node + web + nest) | T2   | yes (5 sites) | —       | ~120               | medium     |
| 9   | `@nx/react` (router-plugin)                      | T2   | —             | yes     | ~40                | medium     |
| 10  | `@nx/cypress`                                    | T3   | yes           | yes     | ~80 + outputs work | higher     |

T1 land first (mechanical, isolated). T2 land in parallel after one T1 has merged so reviewers see the established pattern. T3 last (design work on outputs correctness).

---

## Per-package execution

**For every PR below**, the work is one of three patterns:

- **Pattern G** (generator emitting executor target via `addBuildTargetDefaults`): pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as the 4th arg.
- **Pattern P** (createNodes plugin building inferred targets): import the constant, append it into the inferred target's `inputs` array. Append AFTER existing entries (`'default'`, `'^default'`, `'^production'` etc.) — order doesn't matter for hashing but consistency aids review.
- **Pattern PD** (per-target write that bypasses `addBuildTargetDefaults`): set `inputs` directly on the target object. Cypress is the only PD case in this rollout.

### 1. `@nx/next` (Pattern P only)

- File: `packages/next/src/plugins/plugin.ts`
- `isUsingTsSolutionSetup` is threaded through `buildNextTargets` (defined ~line 145). Bakes into build/dev `syncGenerators` (~lines 211, 227) per audit.
- Inputs assembled in helper `getInputs()` at lines 288–303.
- **Action**: in `getInputs()` (or wherever the build target's `inputs` array literal lives at line ~291), append `TS_SOLUTION_SETUP_TSCONFIG_INPUT`. `getInputs()` is invoked only on the build target — that's correct, since dev/start are continuous (un-cached) and don't carry an explicit `inputs` declaration.
- **Test**: a unit test under `packages/next/src/plugins/plugin.spec.ts` (or equivalent) asserting the inferred build target's `inputs` includes the constant. Cover both TS-solution and non-TS-solution branches.

Branch: `fix/tsconfig-input-next` — commit scope `next`.

### 2. `@nx/remix` (Pattern P only)

- File: `packages/remix/src/plugins/plugin.ts`
- Build target inputs at lines 257–262, typecheck inputs at lines 341–346.
- **Action**: append `TS_SOLUTION_SETUP_TSCONFIG_INPUT` to BOTH arrays.
- Audit confirms two distinct bake points: build/dev/start `syncGenerators` (lines 272/294/324) AND typecheck `command` switches between `tsc --build --emitDeclarationOnly` (solution mode) and per-file tsc (line 347–349). Each cached target needs the input independently. dev/start/serve-static have no `inputs` (continuous targets) — leave them alone.

Branch: `fix/tsconfig-input-remix` — scope `remix`.

### 3. `@nx/rsbuild` (Pattern P only)

- File: `packages/rsbuild/src/plugins/plugin.ts`
- Build inputs at lines 171–178, typecheck inputs at lines 227–232.
- **Action**: append constant to both arrays.
- Audit note: build target's `command` is hardcoded `rsbuild build` and does NOT vary on the boolean — but the build still runs the executor / inference baked decision indirectly via the typecheck dependency. Adding the input to both arrays is correct; do not over-think which target "needs" it. Typecheck specifically branches between `tsc --build --emitDeclarationOnly` (solution) and `tsc -p <tsConfig> --noEmit` (per-file) at lines 233–235.

Branch: `fix/tsconfig-input-rsbuild` — scope `rsbuild`.

### 4. `@nx/rollup` (Pattern G + P)

- Generator: `packages/rollup/src/generators/configuration/configuration.ts:218` — pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as 4th arg.
- Plugin: `packages/rollup/src/plugins/plugin.ts` — build target inputs in ternary at lines 189–194. Append constant to BOTH ternary branches.
- Note: with-nx runtime helpers (`packages/rollup/src/plugins/with-nx/normalize-options.ts`, `with-nx.ts`) are runtime code consumed by user `rollup.config.js`; they're covered by the executor target's `inputs` since the executor invokes them.

Branch: `fix/tsconfig-input-rollup` — scope `rollup`.

### 5. `@nx/webpack` (Pattern G + P)

- Generator: `packages/webpack/src/generators/configuration/configuration.ts:182` — pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as 4th arg.
- Plugin: `packages/webpack/src/plugins/plugin.ts` — build target inputs in ternary at lines 176–191. Append constant to BOTH ternary branches.
- Audit note: in webpack the plugin THREADS `isUsingTsSolutionSetup` but does NOT bake the boolean into the inferred target's command/options. The reason the input still belongs on the inferred target is the EXECUTOR's runtime read (`normalize-options.ts:21`) and the with-nx runtime read (`apply-base-config.ts:265-266,292-294`). Both run inside the cached task. Don't be surprised when you scan `plugin.ts` and see no command/syncGenerators branching on the boolean — that's expected.
- Note: `apply-base-config.ts` reads are runtime (user `webpack.config.js`), covered by the executor target's `inputs` (= the targetDefaults entry the generator sets, AND the inferred target's inputs from the plugin).

Branch: `fix/tsconfig-input-webpack` — scope `webpack`.

### 6. `@nx/vite` (Pattern G + P, more surface)

- Generator: `packages/vite/src/utils/generator-utils.ts:133` — pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as 4th arg to `addBuildTargetDefaults(tree, '@nx/vite:build')`. (Note: this generator only sets defaults for `@nx/vite:build`; the test executor is separate.)
- Plugin: `packages/vite/src/plugins/plugin.ts` — three input arrays:
  - build inputs at lines 506–513
  - typecheck inputs at lines 442–447
  - test inputs at lines 613–626
  - Append constant to ALL THREE.
- Audit note: vite plugin already uses `walkTsconfigExtendsChain` (lines 799–840) to compute a per-project hash passed to `calculateHashesForCreateNodes`. That walk is for project-graph integrity — it does NOT bake into inferred target command/options. **Do not** route the new input through that helper or extend it. It's a different concern (project tsconfig extends chain vs workspace-root tsconfig field-scoped); the rollout's constant is the only addition needed.
- Note: `packages/vite/plugins/nx-tsconfig-paths.plugin.ts:211` runs inside the executor as a vite plugin in user `vite.config.ts`. The runtime read is covered by declaring the input on the executor target (= what the generator/plugin entries above accomplish).

Branch: `fix/tsconfig-input-vite` — scope `vite`.

### 7. `@nx/rspack` (Pattern P only)

- File: `packages/rspack/src/plugins/plugin.ts`
- Build target inputs in ternary at lines 206–221 (production branch 208–214, default 215–221). Append constant to BOTH branches.
- No rspack generator calls `addBuildTargetDefaults` — manually written `@nx/rspack:rspack` targets in `project.json` won't be covered, but that's the "no migrations for existing projects" rule (see "What NOT to do" below).
- Audit note: same as webpack — the plugin threads `isUsingTsSolutionSetup` but does NOT bake the boolean into target shape. The input is needed because the EXECUTOR (`normalize-options.ts:21`) and with-nx helpers (`apply-base-config.ts:260,270`) read at task runtime. `getNonBuildableLibs` at `apply-base-config.ts:421` reads `package.json`, not tsconfig — out of scope.
- with-nx runtime files are covered by the executor target's input (= the inferred target's `inputs` array set by the plugin).

Branch: `fix/tsconfig-input-rspack` — scope `rspack`.

### 8. `@nx/js` cross-cutting (Pattern G, multiple sites — **most coordination**)

This PR is bigger because of the "first generator wins" trap. Every site that calls `addBuildTargetDefaults(tree, '@nx/js:swc' | '@nx/js:tsc')` MUST update simultaneously, otherwise a generator that doesn't pass `extraInputs` will set the targetDefault first in some workflows and lock out the fix.

Sites to update (all 4th arg `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]`):

- `packages/js/src/generators/setup-build/generator.ts:170` (`@nx/js:tsc`)
- `packages/js/src/generators/setup-build/generator.ts:188` (`@nx/js:swc`)
- `packages/js/src/generators/library/library.ts:289` (executor varies — passes through `getBuildExecutor()`. Pass the constant unconditionally; it's harmless for `@nx/rollup:rollup` / `@nx/vite:build` / `@nx/esbuild:esbuild` since those executors also gate on `isUsingTsSolutionSetup`)
- `packages/web/src/generators/application/application.ts:226` (`@nx/js:${options.compiler}`)
- `packages/node/src/generators/library/library.ts:219` (`@nx/js:${options.compiler}`)
- `packages/js/src/generators/convert-to-swc/convert-to-swc.ts` — grep for `addBuildTargetDefaults`; update if present
- `packages/nest/src/generators/library/lib/add-project.ts` — grep for `addBuildTargetDefaults`; update if present

**Verify before submitting**: `grep -rn "addBuildTargetDefaults" packages/ --include="*.ts" | grep -v ".spec.ts"` — every line returned should pass `[TS_SOLUTION_SETUP_TSCONFIG_INPUT]` as 4th arg, except calls for executors that are covered by their own package PR (`@nx/esbuild:esbuild`, `@nx/rollup:rollup`, `@nx/vite:build`, `@nx/webpack:webpack`, `@nx/angular:*`, `@nx/expo:*`, `@nx/next:build`).

Note: `@nx/angular` and `@nx/expo` `addBuildTargetDefaults` calls are out of scope. Verified: `grep -rn "isUsingTsSolutionSetup" packages/angular/src packages/expo/src` returns zero non-generator hits, i.e. those packages' executors and plugins don't make the runtime call we're declaring an input for. Their generators DO call it (to make scaffolding decisions), but that's plan-time only and doesn't need a task input. Leave their `addBuildTargetDefaults` calls untouched.

Branch: `fix/tsconfig-input-js-cross-cutting` — scope `js`. PR description must list every file touched and explicitly state the "first generator wins" rationale.

### 9. `@nx/react` router-plugin (Pattern P only)

- File: `packages/react/src/plugins/router-plugin.ts`
- `isUsingTsSolutionSetup` called at line 71, threaded through `buildReactRouterTargets` (line 148).
- Build inputs at lines 240–245, typecheck inputs at lines 317–322. Append constant to both.
- The line span 71–347 looks scary but the actual fix is two append-to-array changes plus tests.
- Audit confirms bake points: build/dev/start `syncGenerators` (lines 252/278/302) AND typecheck `command` (line 323–325) which switches between `tsc --build --emitDeclarationOnly` and per-file tsc with optional `tsconfig.app.json`. Each cached target needs the input.

Branch: `fix/tsconfig-input-react-router` — scope `react`.

### 10. `@nx/cypress` (Pattern P + PD + outputs correctness)

This is the trickiest PR. Three concerns:

**A. Plugin input fix** — `packages/cypress/src/plugins/plugin.ts`:

- `getInputs()` helper at lines 594–606 — append `TS_SOLUTION_SETUP_TSCONFIG_INPUT`.
- Inputs are referenced from lines 269, 328, 366, 435, 446 — single helper edit covers all.
- Audit note: unlike most other rollout plugins, the cypress plugin does NOT call `isUsingTsSolutionSetup` directly. The violation lives in the PRESET (`packages/cypress/plugins/cypress-preset.ts:60-67`), which the executor loads at task runtime (the preset is consumed by `cypress.config.ts` files in user projects). The input still goes on the inferred target's inputs because that's where the executor's task is hashed — same delivery channel, different reasoning.

**B. Legacy generator** — `packages/cypress/src/generators/configuration/configuration.ts:381-396`:

- When `hasPlugin === false`, the generator writes targets without `inputs`. This is the legacy executor-direct path. Either declare `inputs: ['default', '^default', TS_SOLUTION_SETUP_TSCONFIG_INPUT]` directly on the target, or call `addBuildTargetDefaults(tree, '@nx/cypress:cypress', 'e2e', [TS_SOLUTION_SETUP_TSCONFIG_INPUT])` to set executor-keyed defaults. Prefer the latter for consistency with other packages.

**C. Outputs correctness (cypress-special concern)**:

- `packages/cypress/plugins/cypress-preset.ts:60-67` toggles `videosFolder` and `screenshotsFolder` paths based on `isUsingTsSolutionSetup`. In TS-solution workspaces, artifacts land under `<projectRoot>/dist/cypress/...`; otherwise under `dist/cypress/<projectRoot>/...`.
- The plugin's `getOutputs()` helper (lines around 270, 327, 365, 436, 505) declares `outputs`. Verify the declared outputs glob covers BOTH path conventions. If not, the cache stores artifacts in the wrong tree on cache hit. Fix the outputs declaration to match the actual folder convention used at runtime (i.e. branch the outputs glob on `isUsingTsSolutionSetup`, since the helper already receives that boolean).
- Spec coverage: parameterize the existing plugin spec over both setup modes and assert `outputs` matches the runtime folder convention.

Branch: `fix/tsconfig-input-cypress` — scope `cypress`. PR description must call out the two distinct correctness fixes (inputs + outputs).

---

## Per-PR checklist (apply to every PR)

```
- [ ] Step 0 PR (#TBD) is merged or in this branch's chain
- [ ] Constant imported from '@nx/js' (plugin/runtime files) or
      '@nx/js/src/utils/typescript/ts-solution-setup' (generator files)
- [ ] All call sites for the affected executor in this package updated
      (run: grep -rn "addBuildTargetDefaults" packages/<pkg>/src --include="*.ts")
- [ ] Spec / unit test coverage:
      - generator: assert targetDefaults entry includes the constant
      - plugin:    assert inferred target's inputs array includes the constant
- [ ] No new migration files (out of scope — see "What NOT to do" below)
- [ ] Manual verification with sample workspace (recipe below)
- [ ] PR body fills .github/PULL_REQUEST_TEMPLATE.md
- [ ] Commit message uses conventional format with required scope
- [ ] PR description references NXC-4310 + esbuild PR #35432
```

## Branch + PR creation (uniform)

```bash
# From master, fresh:
git fetch origin master
git checkout -b fix/tsconfig-input-<package> origin/master

# Make changes per the per-package section above.
# Format every touched file:
npx prettier -- $(git diff --name-only HEAD) --write

# Test (project-scoped first, then affected):
nx run-many -t test,build,lint -p <package>
nx affected -t build,test,lint

# Stage, commit (single commit per PR; use conventional format):
git add <specific files>
git commit -m "$(cat <<'EOF'
fix(<scope>): declare tsconfig.json as input for <package> targets

The <package> executor / plugin calls isUsingTsSolutionSetup at task
runtime, which reads extends/files/include from the workspace root
tsconfig.json. Those fields were not declared as task inputs, so cache
hashes did not reflect changes to them and builds could hit stale
cache entries after tsconfig.json edits.

This declares a field-scoped tsconfig.json input on the affected
targets so hashes change when those fields change. references and
compilerOptions are intentionally excluded to avoid cache thrashing
on unrelated edits.

Mirrors the fix from PR #35432 (@nx/esbuild).
EOF
)"

git push -u origin fix/tsconfig-input-<package>

gh pr create --title "fix(<scope>): declare tsconfig.json as input for <package> targets" --body "$(cat <<'EOF'
## Current Behavior

The `<package>` <executor|plugin> calls `isUsingTsSolutionSetup` at task runtime, which reads `extends`/`files`/`include` from the workspace-root `tsconfig.json`. Those fields are not declared as task inputs, so cache hashes do not reflect changes to them and builds can hit stale cache entries after `tsconfig.json` edits.

## Expected Behavior

Targets <emitted by the configuration generator | inferred by the createNodes plugin> include a field-scoped `{workspaceRoot}/tsconfig.json` input covering exactly the fields read by `isUsingTsSolutionSetup`, so hashes change when those fields change and remain unaffected by unrelated edits.

Mirrors the fix shape from PR #35432 (`@nx/esbuild`). Uses the shared `TS_SOLUTION_SETUP_TSCONFIG_INPUT` constant exported from `@nx/js` (introduced in #<step-0-PR>).

## Related Issue(s)

Part of the rollout tracked in NXC-4310 / following PR #35432.
EOF
)"
```

PR titles cap at 70 chars — they comfortably do. Conventional commit scopes (`scripts/commitizen.js`): `core`, `next`, `remix`, `rsbuild`, `rollup`, `webpack`, `vite`, `rspack`, `js`, `react`, `cypress`. Verify the scope before committing — `pnpm commit` will validate.

## Verification recipe (apply per package)

```bash
# Scaffold a fresh workspace (preset doesn't matter — we override):
mkdir -p tmp/claude/verify-<pkg> && cd tmp/claude/verify-<pkg>
npx create-nx-workspace@latest verify --preset=ts --no-interactive
cd verify

# Add the package's plugin / scaffold a target using the package's generator.

# Sanity hashing test:
nx <task> <project>                       # populate cache
nx <task> <project>                       # cache hit (sanity)

# Should INVALIDATE: bump `include` in workspace tsconfig.json
jq '.include = ["src/**/*"]' tsconfig.json | sponge tsconfig.json
nx <task> <project>                       # MUST be cache miss

# Should NOT invalidate: bump compilerOptions.target
jq '.compilerOptions.target = "es2020"' tsconfig.json | sponge tsconfig.json
nx <task> <project>                       # MUST be cache hit
```

If the second test fails (cache miss on `compilerOptions` change), the constant is over-broad — abort, do NOT add `compilerOptions` to the fields. If the first test fails (cache hit on `include` change), the input wasn't wired into the right target — re-check the plugin/generator.

## What NOT to do

- No migrations for existing projects.
- Don't touch `isUsingTsSolutionSetup` itself.
- Don't add `references` or `compilerOptions` to the constant — explicitly ruled out.
- Don't add `pnpm-workspace.yaml` / root `package.json` workspaces fields — separate latent issue, not this rollout.
- Don't unify `TS_SOLUTION_SETUP_TSCONFIG_INPUT` with `collectExternalTsconfigInputs` (`packages/playwright/src/plugins/plugin.ts:648`) — different concern (project extends chain vs root field-scoped).

## Open coordination questions for the executing agent

- After Step 0 lands, decide whether to open T1 PRs (next/remix/rsbuild/rollup/webpack/vite) all at once or in two waves. They're independent. Recommend: open all six in one push, stagger merges.
- T2 / T3 await one merged T1 so reviewers see the established review pattern. Don't open T2 until at least one T1 is approved.
- If `pnpm commit` rejects the scope (e.g. for the cross-cutting JS PR that touches multiple packages), use the `js` scope and call out the cross-package nature in the body.
