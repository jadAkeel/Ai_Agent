---
name: regression-analysis
description: Use when behavior used to work and now fails, or when a recent change may have introduced a bug.
compatibility: opencode
---

# Regression Analysis

Analyze regressions where previously working behavior now fails.

## When to Use

- A feature that was working is now broken
- A recent change may have introduced the bug
- Test that used to pass now fails
- Performance regression

## Analysis Workflow

1. **Inspect recent diffs** if available (git log, PR history).
2. **Identify changed files** related to the failing behavior.
3. **Compare expected behavior** before and after the change.
4. **Look for**:
   - Changed contracts (API signatures, return types)
   - Changed assumptions (nullability, defaults)
   - Removed validation
   - Configuration changes
   - Dependency updates
   - Test changes that reveal new constraints
5. **Do not blame a change without evidence** — verify the causal link.

## Output

- **Suspected regression source**: Commit/file/change
- **Evidence**: Diffs, logs, test output
- **Alternative causes**: Other possible explanations
- **Suggested minimal fix**: Smallest change to restore behavior
