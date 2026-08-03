# API Coverage Aggregation Design

## Goal

Keep the existing API coverage thresholds while making the report reflect the repository's
actual test architecture: isolated unit tests plus database- and Redis-backed integration tests.
PR #11 must pass CI without excluding production files or lowering the 80% line, statement, and
function thresholds or the 70% branch threshold.

## Context

The unit suite passes 540 tests, but CI currently runs it with coverage against every API source
file. Services and controllers that are intentionally exercised through the 808 integration tests
therefore appear uncovered, producing 28.55% line coverage and failing the global threshold.

Vitest 4 collects coverage once at the root of a multi-project run. Unit and integration projects
can retain their existing transforms, setup files, timeouts, and serial database behavior while
contributing to one shared V8 report.

## Considered Approaches

1. **One Vitest multi-project coverage run — selected.** Compose the existing unit and integration
   configurations under a small coverage-only root config. This preserves both suites as the
   source of truth and lets Vitest aggregate coverage natively.
2. **Blob reports plus `--merge-reports`.** This supports separate processes and CI jobs, but adds
   report directories, artifact transfer, and a merge phase without a current scaling need.
3. **Lower thresholds or narrow the included source set.** This would make CI green by weakening
   the gate and would stop measuring production code that is covered through integration tests.

## Design

Add `vitest.coverage.config.ts` to the API package. It inherits the shared root coverage settings
and declares the existing `vitest.config.ts` and `vitest.integration.config.ts` files as projects.
The root coverage settings override project-local coverage enablement, as required by Vitest's
multi-project coverage model; all other project behavior remains unchanged.

Add a `test:coverage` package script that runs the coverage config with coverage enabled. The
normal `test` and `test:integration` scripts remain available and unchanged for focused local use.

The CI unit job runs the unit suite without coverage for fast, isolated feedback. The integration
job already owns PostgreSQL, Redis, migrations, and serialized integration execution, so it runs
the combined coverage command and uploads the resulting report. This repeats the unit suite once
inside the coverage job, but keeps the job boundaries clear and avoids moving database services
into the fast unit job.

## Failure Behavior

Any unit failure, integration failure, unavailable test dependency, or aggregate threshold miss
fails the combined command. Coverage remains a required CI signal; no threshold is relaxed and no
production path is newly excluded. The report artifact is uploaded even when the coverage command
fails so the failing numbers remain inspectable.

## Verification

Use the current unit-only coverage command as the red reproduction: all tests pass but the global
threshold fails. After implementation, run the combined coverage command against local PostgreSQL
and Redis and confirm both projects execute and the existing thresholds pass. Then run frozen
install, build, lint, typecheck, format, Knip, the complete unit suite, and the complete integration
suite before pushing. Finally, record the pushed head SHA and require green GitHub Actions and
CodeRabbit checks for that exact SHA before merging PR #11 into `main`.
