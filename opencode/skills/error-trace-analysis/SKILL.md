---
name: error-trace-analysis
description: Use when analyzing stack traces, logs, exceptions, compiler errors, runtime errors, or CI failure output.
compatibility: opencode
---

# Error Trace Analysis

Parse and analyze stack traces, logs, exceptions, compiler errors, and CI failures.

## When to Use

- Stack traces and exceptions
- Compiler/type errors
- Runtime errors
- CI/CD pipeline failures
- Log-based diagnostics

## Analysis Workflow

1. **Parse the error from top to bottom** — start with the first meaningful failure.
2. **Identify primary error** — distinguish from cascading/secondary errors.
3. **Map error lines** to source files, functions, and classes.
4. **Classify the issue type**:
   - Configuration
   - Dependency
   - Type mismatch
   - Missing import
   - Environment
   - Runtime state
   - Logic error
5. **Do not stop at the final cascading error** — the root cause is usually earlier.

## Output

- **Primary error**: The first meaningful failure
- **Secondary/cascading errors**: Follow-on failures
- **Likely source file**: File and line number
- **Likely cause**: Root cause classification
- **Exact next inspection step**: What to look at next
