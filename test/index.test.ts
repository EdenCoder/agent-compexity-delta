import assert from 'node:assert/strict';
import test from 'node:test';
import { affectedFiles, analyze, compare, type Snapshot } from '../src/index.js';

const snapshot = (code: string): Snapshot => ({ files: { 'fixture.ts': code } });
const delta = (before: string, after: string) =>
  compare(analyze(snapshot(before)), analyze(snapshot(after)));

test('adding one straightforward function', () => {
  const result = delta('', "export function greet() { return 'hello'; }");
  assert.equal(result.delta.functions, 1);
  assert.equal(result.delta.exportedDeclarations, 1);
});

test('replacing helpers with one direct path', () => {
  const result = delta(
    "function first() { return second(); }\nfunction second() { return 'ok'; }\nfirst();",
    "function direct() { return 'ok'; }\ndirect();",
  );
  assert.equal(result.delta.functions, -1);
  assert.equal(result.delta.callEdges, -1);
  assert.equal(result.delta.singleCallerFunctions, -1);
});

test('introducing a chain of single-caller helpers', () => {
  const result = delta(
    "function output() { return 'ok'; }\noutput();",
    "function prepare() { return normalize(); }\nfunction normalize() { return output(); }\nfunction output() { return 'ok'; }\nprepare();",
  );
  assert.deepEqual(
    result.newIntermediateConcepts.map(({ name }) => name),
    ['prepare', 'normalize'],
  );
});

test('adding a single-implementation interface', () => {
  const result = delta(
    '',
    "interface Store { read(): string }\nclass MemoryStore implements Store { read() { return 'ok'; } }",
  );
  assert.equal(result.delta.interfaces, 1);
  assert.equal(result.delta.classes, 1);
  assert.equal(result.delta.singleImplementationInterfaces, 1);
});

test('deleting branches and intermediary machinery', () => {
  const result = delta(
    "function choose(value: boolean) { if (value) return helper(); return 'no'; }\nfunction helper() { return 'yes'; }\nchoose(true);",
    "function choose() { return 'yes'; }\nchoose();",
  );
  assert.equal(result.delta.functions, -1);
  assert.equal(result.delta.conditionalBranches, -1);
  assert.equal(result.delta.callEdges, -1);
});

test('unchanged code produces a zero delta', () => {
  const code = 'export const answer = () => 42;';
  const result = delta(code, code);
  assert.ok(Object.values(result.delta).every((value) => value === 0));
  assert.deepEqual(result.newIntermediateConcepts, []);
});

test('calls in local initializers belong to their enclosing function', () => {
  const result = analyze(
    snapshot(`
    export function leaf() { return 1; }
    export function caller() { const a = leaf(); const b = leaf(); return [a, b]; }
    caller();
  `),
  );
  assert.equal(result.measurements.callEdges, 2);
  assert.equal(result.functions.find(({ name }) => name === 'leaf')?.fanIn, 1);
  assert.equal(result.functions.find(({ name }) => name === 'caller')?.fanOut, 1);
  assert.ok(result.graph.callEdges.every((edge) => !edge.includes(':variable:')));
});

test('immutable intermediate results remain candidates while mutations do not', () => {
  const result = delta(
    '',
    `
    function leaf() { return 1; }
    function wrapper() { const result = leaf(); return result; }
    function mutable() { let result = leaf(); result += 1; return result; }
    function property() { const result = { value: leaf() }; result.value = 2; return result; }
    wrapper(); mutable(); property();
  `,
  );
  assert.deepEqual(
    result.newIntermediateConcepts.map(({ name }) => name),
    ['wrapper'],
  );
});

test('anonymous callbacks and defaults count and own their calls', () => {
  const result = analyze(
    snapshot(`
    function leaf() { return 1; }
    export default function() {
      return [1, 2].map(x => leaf() + x).filter(function(x) { return leaf() > x; });
    }
  `),
  );
  assert.equal(result.measurements.functions, 4);
  assert.equal(result.functions.find(({ name }) => name === 'leaf')?.fanIn, 2);
  assert.equal(result.functions.find(({ name }) => name === 'default')?.fanOut, 0);
  assert.equal(result.measurements.unreferencedExports, 1);
});

test('named arrow functions and function expressions are counted once', () => {
  const result = analyze(
    snapshot(`
    const arrow = () => 1;
    const expression = function inner() { return arrow(); };
    expression();
  `),
  );
  assert.equal(result.measurements.functions, 2);
  assert.equal(result.measurements.variables, 2);
  assert.equal(result.measurements.callEdges, 2);
  assert.equal(result.functions.find(({ name }) => name === 'expression')?.fanOut, 1);
});

test('nested mutation belongs to the callback, not its creator', () => {
  const result = analyze(
    snapshot(`
    export function create() {
      let counter = 0;
      return () => ++counter;
    }
  `),
  );
  assert.equal(result.functions.find(({ name }) => name === 'create')?.stateful, false);
  assert.equal(result.functions.find(({ name }) => name === '<anonymous>')?.stateful, true);
});

test('barrel re-exports contribute dependency edges and resolve calls', () => {
  const result = analyze({
    files: {
      'leaf.ts': 'export function leaf() { return 1; }',
      'barrel.ts': "export { leaf } from './leaf'; export * from './leaf';",
      'entry.ts': "import { leaf } from './barrel'; export function run() { return leaf(); }",
    },
  });
  assert.equal(result.measurements.moduleDependencyEdges, 2);
  assert.ok(result.graph.moduleDependencyEdges.includes('module:barrel.ts -> module:leaf.ts'));
  assert.equal(result.functions.find(({ name }) => name === 'leaf')?.fanIn, 1);
});

test('each snapshot resolves aliases through its own extended configs', () => {
  const files = {
    'configs/base.json': JSON.stringify({
      compilerOptions: { moduleResolution: 'Bundler', module: 'ESNext' },
    }),
    'tsconfig.json': JSON.stringify({
      extends: './configs/base.json',
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
    }),
    'src/leaf.ts': 'export function leaf() { return 1; }',
    'src/other.ts': 'export function leaf() { return 2; }',
    'src/entry.ts': "import { leaf } from '@/leaf'; export function run() { return leaf(); }",
  };
  const before = analyze({ files });
  const after = analyze({
    files: {
      ...files,
      'tsconfig.json': JSON.stringify({
        extends: './configs/base.json',
        compilerOptions: { baseUrl: '.', paths: { '@/leaf': ['src/other.ts'] } },
      }),
    },
  });
  assert.ok(
    before.graph.callEdges.some((edge) => edge.endsWith('symbol:src/leaf.ts:function:leaf')),
  );
  assert.ok(
    after.graph.callEdges.some((edge) => edge.endsWith('symbol:src/other.ts:function:leaf')),
  );
  assert.equal(before.measurements.sourceFiles, 3);
  assert.equal(before.measurements.unreferencedExports, 2);
});

test('package configs and workspace export maps resolve to canonical source nodes', () => {
  const result = analyze({
    files: {
      'packages/config/package.json': '{"name":"@fixture/config"}',
      'packages/config/base.json':
        '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"}}',
      'packages/lib/package.json':
        '{"name":"@fixture/lib","exports":{"./*":{"types":"./src/*.ts"}}}',
      'packages/lib/src/leaf.ts': 'export function leaf() { return 1; }',
      'apps/a/tsconfig.json':
        '{"extends":"@fixture/config/base.json","compilerOptions":{"baseUrl":".","paths":{"@/*":["./src/*"]}}}',
      'apps/b/tsconfig.json':
        '{"extends":"@fixture/config/base.json","compilerOptions":{"baseUrl":".","paths":{"@/*":["./source/*"]}}}',
      'apps/a/src/local.ts': 'export const local = () => 1;',
      'apps/b/source/local.ts': 'export const local = () => 2;',
      'apps/a/src/entry.ts':
        "import { leaf } from '@fixture/lib/leaf'; import { local } from '@/local'; export function runA() { return leaf() + local(); }",
      'apps/b/source/entry.ts':
        "import { leaf } from '@fixture/lib/leaf'; import { local } from '@/local'; export function runB() { return leaf() + local(); }",
    },
  });
  assert.equal(result.measurements.sourceFiles, 5);
  assert.equal(result.measurements.callEdges, 4);
  assert.equal(result.functions.find(({ name }) => name === 'leaf')?.fanIn, 2);
  assert.equal(result.measurements.unreferencedExports, 2);
  assert.ok(
    result.graph.moduleDependencyEdges.includes(
      'module:apps/a/src/entry.ts -> module:packages/lib/src/leaf.ts',
    ),
  );
  assert.ok(
    result.graph.moduleDependencyEdges.includes(
      'module:apps/b/source/entry.ts -> module:apps/b/source/local.ts',
    ),
  );
  assert.ok(result.graph.nodes.every((id) => !id.includes('node_modules')));
});

const program = {
  'leaf.ts': 'export function leaf() { return 1; }',
  'mid.ts': "import { leaf } from './leaf'; export function mid() { return leaf(); }",
  'barrel.ts': "export * from './mid';",
  'top.ts': "import { mid } from './barrel'; export function top() { return mid(); }",
  'other.ts': "import { leaf } from './leaf'; export function other() { return leaf(); }",
};

test('affected files are the changed files and their importers, not their dependencies', () => {
  const affected = affectedFiles({ files: program }, new Set(['mid.ts']));
  assert.deepEqual([...affected].sort(), ['barrel.ts', 'mid.ts', 'top.ts']);
});

test('measuring a subset still resolves calls into the rest of the program', () => {
  const result = analyze({ files: program }, new Set(['barrel.ts', 'mid.ts', 'top.ts']));
  assert.equal(result.measurements.sourceFiles, 3);
  assert.ok(
    result.graph.callEdges.includes(
      'symbol:mid.ts:function:mid -> symbol:leaf.ts:function:leaf',
    ),
  );
  assert.equal(result.functions.find(({ name }) => name === 'mid')?.fanIn, 1);
  assert.equal(result.functions.some(({ name }) => name === 'leaf'), false);
});

test('a subset delta matches the whole-program delta', () => {
  const before = { files: program };
  const after = {
    files: {
      ...program,
      'mid.ts':
        "import { leaf } from './leaf'; function wrap() { return leaf(); } export function mid() { return wrap(); }",
    },
  };
  const changed = new Set(['mid.ts']);
  const files = new Set([...affectedFiles(before, changed), ...affectedFiles(after, changed)]);
  const subset = compare(analyze(before, files), analyze(after, files));
  const whole = compare(analyze(before), analyze(after));
  assert.deepEqual(subset.delta, whole.delta);
  assert.deepEqual(
    subset.newIntermediateConcepts.map(({ name }) => name),
    ['wrap'],
  );
  assert.equal(subset.before.sourceFiles, 3);
});

test('a config extending a base outside the snapshot keeps its own options', () => {
  const result = analyze({
    files: {
      'tsconfig.json': JSON.stringify({
        extends: 'framework/tsconfig.base',
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/leaf.ts': 'export function leaf() { return 1; }',
      'src/entry.ts': "import { leaf } from '@/leaf'; export function run() { return leaf(); }",
    },
  });
  assert.equal(result.measurements.callEdges, 1);
  assert.ok(
    result.graph.moduleDependencyEdges.includes('module:src/entry.ts -> module:src/leaf.ts'),
  );
});

test('NodeNext selects package import and require conditions', () => {
  const result = analyze({
    files: {
      'tsconfig.json': '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      'package.json': '{"type":"module"}',
      'lib/package.json':
        '{"name":"conditional","exports":{".":{"import":"./esm.ts","require":"./cjs.ts"}}}',
      'lib/esm.ts': 'export function leaf() { return 1; }',
      'lib/cjs.ts': 'export function leaf() { return 2; }',
      'esm.ts': "import { leaf } from 'conditional'; export const run = () => leaf();",
      'cjs.cts': "import { leaf } from 'conditional'; export const run = () => leaf();",
    },
  });
  assert.ok(result.graph.moduleDependencyEdges.includes('module:esm.ts -> module:lib/esm.ts'));
  assert.ok(result.graph.moduleDependencyEdges.includes('module:cjs.cts -> module:lib/cjs.ts'));
});
