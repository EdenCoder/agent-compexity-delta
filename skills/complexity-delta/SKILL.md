---
name: complexity-delta
description: Run a subtraction pass after a TypeScript implementation is behaviorally correct, using complexity delta evidence to find and collapse unnecessary conceptual machinery without changing product behavior.
---

# Complexity Delta Subtraction Pass

Use this only after correctness has been established. From the repository being changed, run the installed CLI (or its package-manager command):

```bash
complexity-delta HEAD
```

Use the task’s base revision instead of `HEAD` when the change spans commits. Keep that base fixed for the pass. `--json` returns raw measurements and candidates. The report covers the changed files and everything that imports them; review only changes within the task’s scope. Never stash, reset, or clean unrelated work to obtain a narrower report.

Inspect every material increase in declarations, branches, representations, and graph edges. Pay particular attention to the reported intermediate candidates, single-caller functions, single-implementation interfaces, unreferenced exports, wrappers, translation layers, duplicate derivations, compatibility paths, and defensive branches.

Treat the metrics as evidence, not rules. New complexity is justified when it represents intrinsic new product complexity. A new function or type is not itself a problem.

Collapse machinery that only mediates concepts the system already has. Prefer putting behavior on the object that owns the knowledge needed to perform it. Keep one concept in one representation with one implementation path.

Do not add features, robustness, tests, documentation, fallbacks, or abstractions during this pass. Preserve behavior. The pass should preserve or reduce complexity unless a concrete product reason explains an increase.

After simplifying, rerun `complexity-delta HEAD`. Report the material before/after changes and any remaining justified increases tersely.
