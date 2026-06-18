---
name: test-failure-diagnosis
description: Use when tests fail or validation commands produce errors.
compatibility: opencode
---

# Test Failure Diagnosis

Diagnose test failures and validation command errors.

## When to Use

- Unit/integration/e2e test failures
- Build validation failures
- Lint or typecheck errors
- CI test stage failures

## Diagnosis Workflow

1. **Identify exact command run** and its output.
2. **Identify failing test names** — not just count.
3. **Separate test setup failures** from product logic failures.
4. **Inspect**:
   - Test file and fixture setup
   - Implementation code under test
   - Test environment configuration
   - Dependency versions
5. **Determine which layer is wrong**:
   - Test itself (bad assertion, wrong fixture)
   - Implementation (logic bug)
   - Test environment (missing service, wrong config)
   - Dependency (API change, version mismatch)

## Rules

- Do **not** mark tests as passed unless actually run.
- If tests cannot run, report the exact command and reason.

## Output

- **Command**: The exact command run
- **Failure summary**: What failed
- **Failing tests**: Test names
- **Likely cause**: Root cause with evidence
- **Recommended fix**: Minimal change to fix
- **Rerun command**: Command to verify the fix
