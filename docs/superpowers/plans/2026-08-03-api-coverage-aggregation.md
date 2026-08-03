# API Coverage Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make API coverage aggregate the existing unit and integration suites so PR #11 keeps the current global thresholds and can pass CI.

**Architecture:** A coverage-only Vitest root config composes the existing unit and integration configs as projects while inheriting the shared coverage policy. The fast CI unit job keeps running unit tests alone, and the service-backed integration job runs the aggregate coverage command and owns the report artifact.

**Tech Stack:** TypeScript, Vitest 4.1.10, V8 coverage, pnpm 10, GitHub Actions, PostgreSQL 17, Redis 7

## Global Constraints

- Keep coverage thresholds at 80% for lines, statements, and functions and 70% for branches.
- Do not add production-source coverage exclusions.
- Preserve the existing focused `test` and `test:integration` commands.
- Reuse `vitest.config.ts` and `vitest.integration.config.ts` as project sources of truth.
- Push normally without force and merge PR #11 only after checks for the exact pushed head SHA are green.
- Leave `.pnpm-store/` untracked and untouched.

---

### Task 1: Aggregate API Coverage

**Files:**

- Create: `booking-app/apps/api/vitest.coverage.config.ts`
- Modify: `booking-app/apps/api/package.json`

**Interfaces:**

- Consumes: `baseVitestConfig`, `./vitest.config.ts`, and `./vitest.integration.config.ts`
- Produces: package script `test:coverage`, which runs both named Vitest projects and emits one shared report in `booking-app/apps/api/coverage`

- [ ] **Step 1: Reproduce the failing unit-only coverage gate**

Run:

```bash
pnpm api test --coverage
```

Expected: all 540 unit tests pass, then coverage exits non-zero because global line, statement, function, and branch coverage remain below their existing thresholds.

- [ ] **Step 2: Add the coverage-only multi-project config**

Create `booking-app/apps/api/vitest.coverage.config.ts`:

```ts
import { baseVitestConfig } from '@shape-and-flow/booking-config/vitest';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      projects: ['./vitest.config.ts', './vitest.integration.config.ts'],
    },
  }),
);
```

- [ ] **Step 3: Expose the aggregate command**

Add this entry beside the existing test scripts in `booking-app/apps/api/package.json`:

```json
"test:coverage": "vitest run --config vitest.coverage.config.ts --coverage"
```

- [ ] **Step 4: Run the aggregate coverage gate**

With PostgreSQL and Redis test infrastructure running and migrations applied, run:

```bash
pnpm api test:coverage
```

Expected: the `unit` and `integration` projects both run, all tests pass, one combined V8 report is written, and every unchanged global threshold passes.

- [ ] **Step 5: Commit the aggregate configuration**

```bash
git add booking-app/apps/api/vitest.coverage.config.ts booking-app/apps/api/package.json
git commit -m "test(api): aggregate coverage suites"
```

### Task 2: Move Coverage Ownership to the Integration Job

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: API package scripts `test` and `test:coverage`
- Produces: a fast unit-only CI job and a service-backed aggregate coverage gate with an always-uploaded `coverage` artifact

- [ ] **Step 1: Keep the unit job isolated**

Replace the unit job's coverage command with:

```yaml
- name: Unit tests
  run: pnpm api test
```

Remove the coverage upload step from that job.

- [ ] **Step 2: Run aggregate coverage after migrations**

Replace the integration job's focused integration command with:

```yaml
- name: Unit and integration tests with coverage
  run: pnpm api test:coverage
```

- [ ] **Step 3: Upload the report from the service-backed job**

Add after the aggregate command:

```yaml
- uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  if: always()
  with:
    name: coverage
    path: booking-app/apps/api/coverage
    if-no-files-found: ignore
    retention-days: 7
```

- [ ] **Step 4: Validate the edited workflow and package files**

Run:

```bash
pnpm format
pnpm typecheck
pnpm knip
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the CI wiring**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: aggregate API coverage"
```

### Task 3: Verify, Publish, and Merge PR #11

**Files:**

- Verify only: `pnpm-lock.yaml`, changed files, GitHub PR #11

**Interfaces:**

- Consumes: the two implementation commits and the existing PR branch
- Produces: a normally pushed, green PR merged into `main`

- [ ] **Step 1: Run the complete local verification matrix**

Run each command and require exit 0:

```bash
CI=true pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm format
pnpm knip
pnpm test
pnpm test:integration
pnpm api test:coverage
```

- [ ] **Step 2: Review the final diff and scope**

Run:

```bash
git status --short
git diff main...HEAD --check
git diff main...HEAD --stat
```

Expected: only intentional tracked changes appear; `.pnpm-store/` remains untracked.

- [ ] **Step 3: Push without rewriting history**

```bash
git push origin chore/static-analysis-p1-p2
```

Record the exact remote head SHA after the push.

- [ ] **Step 4: Require green checks for the exact head SHA**

Inspect PR #11 checks and unresolved review threads. Continue only when GitHub Actions and CodeRabbit are successful for the recorded SHA and no new actionable CodeRabbit feedback remains.

- [ ] **Step 5: Merge PR #11 into `main`**

Merge through GitHub with the recorded head SHA as the expected head. Verify the PR is merged, its base is `main`, and the resulting commit is reachable from remote `main`.
