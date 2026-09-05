# Complexity Delta

Measure the conceptual machinery a TypeScript change adds or removes: declarations, branches, calls, dependencies, and symbol references. Compare a Git revision with the current working tree, including staged and untracked files.

Correctness is necessary but not sufficient. This tool surfaces structural evidence for a subtraction pass, including new functions with one caller, one callee, and no direct mutations. These are candidates for review, not verdicts. There is no weighted complexity score.

## Use

Requires Node.js 20 or newer and Git. Install from GitHub in the project you want to analyze:

```sh
npm install --save-dev git+ssh://git@github.com/EdenCoder/agent-compexity-delta.git
npx --no-install complexity-delta HEAD
npx --no-install complexity-delta HEAD --json
```

Run from that project's Git checkout. The base defaults to `HEAD`; pass another revision to review a change spanning multiple commits. JSON includes before/after/delta measurements and newly introduced intermediate candidates.

For a local clone:

```sh
pnpm install
pnpm test
pnpm typecheck
node dist/cli.js HEAD
```

The build produces a plain Node.js CLI. You can invoke its absolute path from another Git checkout without installing TypeScript or `tsx` in that checkout.

## Measurements

- Nonempty source lines (including comments), files, functions, methods, classes, interfaces, type aliases, enums, and variables.
- Exported names, import declarations, conditional branches, and distinct call, module dependency, and symbol reference edges.
- Function fan-in/fan-out, single-caller functions, explicitly single-implementation interfaces, and exports without cross-file references.
- Graph size changes and newly introduced intermediary candidates.

The analyzer uses each snapshot's configuration and package manifests for import resolution, including aliases, workspace packages, and conditional exports. Git access is read-only; it does not stash or modify the index or working tree.

## Agent skill

The portable subtraction-pass skill lives in [skills/complexity-delta/SKILL.md](skills/complexity-delta/SKILL.md). Install or link that directory into your agent's skill directory and require the skill in your project's `AGENTS.md` after behavioral correctness has been established.

The pass reviews measured increases, moves behavior to the objects that own the necessary knowledge, collapses unnecessary machinery, and reruns the measurements. It preserves behavior and adds no features or speculative abstractions.

## Boundaries

The graph is static. Calls through dynamic dispatch or external packages are not inferred. Callback bodies are counted and own their calls; callback invocation is not inferred from framework behavior. Mutation detection covers direct writes, not effects hidden inside callees.

Only TypeScript implementation files are measured. Declaration files and JSON configuration support resolution. Dependencies outside the snapshot are not loaded from the machine; a tsconfig that extends a base outside the snapshot keeps its own options. Git submodules are separate repositories and should be analyzed separately.

Interface implementation counts use explicit `implements` clauses. Export usage is measured within the snapshot, not among downstream consumers. Anonymous declarations use positional occurrence identities, so inserting or reordering them can change their identities. Path-inflation detection is not implemented.
