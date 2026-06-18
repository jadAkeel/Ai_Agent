---
name: test-and-verification
description: Create and run a verification plan for any change. Use when the user asks to verify this change, run tests, create a test plan, how do we know this works, add meaningful tests, or report what is verified versus unverified.
---

# Test and Verification

Verify behavior with evidence. Never claim success without proof.

## Workflow

1. Identify the existing test framework and commands from real files.
2. Choose focused checks close to the changed behavior.
3. Add minimal useful tests when the behavior change warrants coverage.
4. Run focused tests first, then broader lint, typecheck, test, or build commands when practical.
5. If automated tests are unavailable, provide manual verification steps.
6. Clearly separate verified behavior from unverified behavior.

## Output

Include:
- Test strategy
- Commands run
- Results
- What passed
- What failed
- What was not verified
- Recommended next verification
