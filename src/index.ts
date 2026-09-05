import {
  Node,
  type SourceFile,
  SyntaxKind,
  type Symbol as MorphSymbol,
  ts,
  type Type,
} from 'ts-morph';
import { createProject } from './project.js';

export interface Snapshot {
  files: Record<string, string>;
}

export interface Measurements {
  sourceFiles: number;
  loc: number;
  functions: number;
  methods: number;
  classes: number;
  interfaces: number;
  typeAliases: number;
  enums: number;
  variables: number;
  exportedDeclarations: number;
  imports: number;
  conditionalBranches: number;
  callEdges: number;
  moduleDependencyEdges: number;
  symbolReferenceEdges: number;
  graphNodes: number;
  graphEdges: number;
  singleCallerFunctions: number;
  singleImplementationInterfaces: number;
  unreferencedExports: number;
}

export interface FunctionFact {
  id: string;
  name: string;
  file: string;
  line: number;
  fanIn: number;
  fanOut: number;
  stateful: boolean;
}

export interface ExportFact {
  id: string;
  name: string;
  file: string;
  line: number;
  referrers: string[];
}

export interface GuardFact {
  id: string;
  file: string;
  line: number;
  text: string;
  type: string;
}

export interface Analysis {
  measurements: Measurements;
  functions: FunctionFact[];
  exports: ExportFact[];
  guards: GuardFact[];
  graph: {
    nodes: string[];
    callEdges: string[];
    moduleDependencyEdges: string[];
    symbolReferenceEdges: string[];
  };
}

export interface ComplexityDelta {
  before: Measurements;
  after: Measurements;
  delta: Measurements;
  graphChangePercent: {
    nodes: number | null;
    edges: number | null;
  };
  newIntermediateConcepts: FunctionFact[];
  newUnreferencedExports: ExportFact[];
  newTestOnlyExports: ExportFact[];
  newUnreachableGuards: GuardFact[];
}

type Declaration = {
  id: string;
  name: string;
  file: string;
  node: Node;
  callable: boolean;
  measured: boolean;
};

// A change can only alter the declarations, branches and edges of the changed
// files and of the files that import them, directly or through re-exports.
// Every other file contributes the same measurements to both snapshots.
export function affectedFiles(snapshot: Snapshot, changed: Set<string>): Set<string> {
  const project = createProject(snapshot.files);
  const importers = new Map<string, Set<string>>();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isDeclarationFile()) continue;
    for (const { file } of moduleSpecifiers(sourceFile)) {
      if (!file) continue;
      const target = snapshotPath(file);
      importers.set(target, (importers.get(target) ?? new Set()).add(snapshotPath(sourceFile)));
    }
  }
  const affected = new Set<string>();
  const queue = [...changed];
  while (queue.length) {
    const path = queue.pop()!;
    if (affected.has(path)) continue;
    affected.add(path);
    queue.push(...(importers.get(path) ?? []));
  }
  return affected;
}

// Tests are exempt from the export and guard lists: a helper only tests share
// and a `?.` inside an assertion are not production surface.
export function isTestFile(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?tsx?$/.test(path);
}

// `files` are measured; guards are inspected only in `changed`, because the
// compiler has to type-check every function that holds one, and a guard in an
// unchanged file cannot have been added by the change.
export function analyze(snapshot: Snapshot, files?: Set<string>, changed?: Set<string>): Analysis {
  const project = createProject(snapshot.files);
  const paths = new Map(
    project
      .getSourceFiles()
      .filter((file) => !file.isDeclarationFile())
      .map((file) => [file, snapshotPath(file)]),
  );

  const sourceFiles = [...paths.keys()].filter((file) => !files || files.has(paths.get(file)!));
  const declarations: Declaration[] = [];
  const declarationById = new Map<string, Declaration>();
  const nodeIds = new Map<Node, string>();
  const usedIds = new Map<string, number>();

  const register = (node: Node, measured: boolean): string | undefined => {
    const existing = nodeIds.get(node);
    if (existing) return existing;
    if (
      (Node.isVariableDeclaration(node) || Node.isPropertyAssignment(node)) &&
      isCallable(node.getInitializer())
    ) {
      return register(node.getInitializer()!, measured);
    }
    const kind = declarationKind(node);
    const name = declarationName(node);
    const file = paths.get(node.getSourceFile());
    if (!kind || !name || !file) return undefined;
    const baseId = `symbol:${file}:${kind}:${qualifiedName(node, name)}`;
    const occurrence = usedIds.get(baseId) ?? 0;
    usedIds.set(baseId, occurrence + 1);
    const id = occurrence === 0 ? baseId : `${baseId}:${occurrence + 1}`;
    const declaration = { id, name, file, node, callable: isCallable(node), measured };
    declarations.push(declaration);
    declarationById.set(id, declaration);
    nodeIds.set(node, id);
    if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      const parent = node.getParent();
      if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
        nodeIds.set(parent, id);
      }
    }
    return id;
  };

  for (const sourceFile of sourceFiles) {
    for (const node of sourceFile.getDescendants()) register(node, true);
  }

  // A declaration outside the measured files is registered when first
  // referenced so the edge into it counts; its own fan-in is not measured.
  const declarationIdForSymbol = (symbol: MorphSymbol | undefined) => {
    let resolved = symbol;
    const seen = new Set<MorphSymbol>();
    while (resolved?.isAlias() && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = resolved.getAliasedSymbol();
    }
    for (const declaration of resolved?.getDeclarations() ?? []) {
      const id = nodeIds.get(declaration) ?? register(declaration, false);
      if (id) return id;
    }
    return undefined;
  };
  const ownerId = (node: Node, call = false) => {
    for (const ancestor of node.getAncestors()) {
      const id = nodeIds.get(ancestor);
      if (id && (!call || isCallable(ancestor))) return id;
    }
    return `module:${paths.get(node.getSourceFile())!}`;
  };

  const moduleEdges = new Set<string>();
  const externalModules = new Set<string>();
  let imports = 0;
  let exportedDeclarations = 0;
  const exportedIds = new Set<string>();
  const exportFacts = new Map<string, ExportFact>();
  for (const sourceFile of sourceFiles) {
    const from = `module:${paths.get(sourceFile)!}`;
    imports += sourceFile.getImportDeclarations().length;
    for (const { specifier, file: targetFile } of moduleSpecifiers(sourceFile)) {
      const target = targetFile ? `module:${snapshotPath(targetFile)}` : `package:${specifier}`;
      moduleEdges.add(`${from} -> ${target}`);
      if (!targetFile || !paths.has(targetFile)) externalModules.add(target);
    }
    const exports = sourceFile.getExportSymbols();
    exportedDeclarations += exports.length;
    for (const symbol of exports) {
      const id = declarationIdForSymbol(symbol);
      if (!id) continue;
      exportedIds.add(id);
      const declaration = declarationById.get(id)!;
      if (!exportFacts.has(id) && !isTestFile(declaration.file)) {
        exportFacts.set(id, {
          id,
          name: symbol.getName(),
          file: declaration.file,
          line: declaration.node.getStartLineNumber(),
          referrers: [],
        });
      }
    }
  }

  const callEdges = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const signature = project.getTypeChecker().getResolvedSignature(call)?.getDeclaration();
      const target =
        (signature && nodeIds.get(signature)) ??
        declarationIdForSymbol(call.getExpression().getSymbol());
      if (target && declarationById.get(target)!.callable) {
        callEdges.add(`${ownerId(call, true)} -> ${target}`);
      }
    }
  }

  const referenceEdges = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const target = declarationIdForSymbol(identifier.getSymbol());
      if (!target || isDeclarationName(identifier, declarationById.get(target)?.node)) {
        continue;
      }
      const owner = ownerId(identifier);
      if (owner !== target) referenceEdges.add(`${owner} -> ${target}`);
    }
  }

  const callers = edgeCounts(callEdges, false);
  const callees = edgeCounts(callEdges, true);
  const functions = declarations
    .filter(({ callable, measured }) => callable && measured)
    .map(({ id, name, file, node }) => ({
      id,
      name,
      file,
      line: node.getStartLineNumber(),
      fanIn: callers.get(id) ?? 0,
      fanOut: callees.get(id) ?? 0,
      stateful: hasMutation(node),
    }));

  const implementations = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    if (!declaration.measured || !Node.isClassDeclaration(declaration.node)) continue;
    for (const heritage of declaration.node.getImplements()) {
      const interfaceId = declarationIdForSymbol(heritage.getExpression().getSymbol());
      const target = interfaceId ? declarationById.get(interfaceId) : undefined;
      if (!target?.measured || !Node.isInterfaceDeclaration(target.node)) continue;
      const classes = implementations.get(target.id) ?? new Set<string>();
      classes.add(declaration.id);
      implementations.set(target.id, classes);
    }
  }

  const externallyReferenced = new Set<string>();
  for (const edge of referenceEdges) {
    const [from, to] = splitEdge(edge);
    const referrer = declarationFile(from, declarationById);
    if (referrer === declarationFile(to, declarationById)) continue;
    externallyReferenced.add(to);
    exportFacts.get(to)?.referrers.push(referrer);
  }

  // A guard the compiler says cannot fire: the value's type excludes null and
  // undefined, or, for a truthiness test, is an object. A cast or an index
  // into a Record can make the type lie; then the type is the finding.
  const guards: GuardFact[] = [];
  const guardIds = new Map<string, number>();
  for (const sourceFile of sourceFiles) {
    const file = paths.get(sourceFile)!;
    if (isTestFile(file) || (changed && !changed.has(file))) continue;
    sourceFile.forEachDescendant((node) => {
      const guard = guardedValue(node);
      if (!guard) return;
      const type = guard.value.getType();
      if (guard.truthiness ? !isObjectType(type) : mayBeNullish(type)) return;
      const text = guard.node.getText().replace(/\s+/g, ' ');
      const baseId = `guard:${file}:${text}`;
      const occurrence = guardIds.get(baseId) ?? 0;
      guardIds.set(baseId, occurrence + 1);
      guards.push({
        id: occurrence === 0 ? baseId : `${baseId}:${occurrence + 1}`,
        file,
        line: guard.node.getStartLineNumber(),
        text,
        type: type.getText(),
      });
    });
  }

  const graphNodes = new Set([
    ...sourceFiles.map((file) => `module:${paths.get(file)!}`),
    ...externalModules,
    ...declarations.map(({ id }) => id),
  ]);
  const graphEdges = new Set([
    ...[...moduleEdges].map((edge) => `module:${edge}`),
    ...[...callEdges].map((edge) => `call:${edge}`),
    ...[...referenceEdges].map((edge) => `reference:${edge}`),
  ]);
  const branches = sourceFiles.reduce(
    (total, sourceFile) =>
      total +
      sourceFile
        .getDescendants()
        .filter(
          (node) =>
            Node.isIfStatement(node) ||
            Node.isConditionalExpression(node) ||
            Node.isCaseClause(node) ||
            Node.isDefaultClause(node) ||
            (Node.isBinaryExpression(node) &&
              [
                SyntaxKind.AmpersandAmpersandToken,
                SyntaxKind.BarBarToken,
                SyntaxKind.QuestionQuestionToken,
              ].includes(node.getOperatorToken().getKind())),
        ).length,
    0,
  );

  return {
    measurements: {
      sourceFiles: sourceFiles.length,
      loc: sourceFiles.reduce(
        (total, file) =>
          total +
          file
            .getFullText()
            .split(/\r?\n/)
            .filter((line) => line.trim()).length,
        0,
      ),
      functions: declarations.filter(
        ({ node, callable }) => callable && !Node.isMethodDeclaration(node),
      ).length,
      methods: declarations.filter(({ node }) => Node.isMethodDeclaration(node)).length,
      classes: declarations.filter(({ node }) => Node.isClassDeclaration(node)).length,
      interfaces: declarations.filter(({ node }) => Node.isInterfaceDeclaration(node)).length,
      typeAliases: declarations.filter(({ node }) => Node.isTypeAliasDeclaration(node)).length,
      enums: declarations.filter(({ node }) => Node.isEnumDeclaration(node)).length,
      variables: sourceFiles.reduce(
        (total, file) => total + file.getDescendantsOfKind(SyntaxKind.VariableDeclaration).length,
        0,
      ),
      exportedDeclarations,
      imports,
      conditionalBranches: branches,
      callEdges: callEdges.size,
      moduleDependencyEdges: moduleEdges.size,
      symbolReferenceEdges: referenceEdges.size,
      graphNodes: graphNodes.size,
      graphEdges: graphEdges.size,
      singleCallerFunctions: functions.filter(({ fanIn }) => fanIn === 1).length,
      singleImplementationInterfaces: [...implementations.values()].filter(
        (classes) => classes.size === 1,
      ).length,
      unreferencedExports: [...exportedIds].filter((id) => !externallyReferenced.has(id)).length,
    },
    functions,
    exports: [...exportFacts.values()].map((fact) => ({
      ...fact,
      referrers: [...new Set(fact.referrers)].sort(),
    })),
    guards,
    graph: {
      nodes: [...graphNodes].sort(),
      callEdges: [...callEdges].sort(),
      moduleDependencyEdges: [...moduleEdges].sort(),
      symbolReferenceEdges: [...referenceEdges].sort(),
    },
  };
}

export function compare(before: Analysis, after: Analysis): ComplexityDelta {
  const delta = { ...after.measurements };
  for (const key of Object.keys(delta) as (keyof Measurements)[]) {
    delta[key] -= before.measurements[key];
  }
  const previousFunctions = new Set(before.functions.map(({ id }) => id));
  const previousExports = new Set(before.exports.map(({ id }) => id));
  const previousGuards = new Set(before.guards.map(({ id }) => id));
  const newExports = after.exports.filter(({ id }) => !previousExports.has(id));
  return {
    before: before.measurements,
    after: after.measurements,
    delta,
    graphChangePercent: {
      nodes: percentChange(before.measurements.graphNodes, after.measurements.graphNodes),
      edges: percentChange(before.measurements.graphEdges, after.measurements.graphEdges),
    },
    newIntermediateConcepts: after.functions.filter(
      ({ id, fanIn, fanOut, stateful }) =>
        !previousFunctions.has(id) && fanIn === 1 && fanOut === 1 && !stateful,
    ),
    newUnreferencedExports: newExports.filter(({ referrers }) => referrers.length === 0),
    newTestOnlyExports: newExports.filter(
      ({ referrers }) => referrers.length > 0 && referrers.every(isTestFile),
    ),
    newUnreachableGuards: after.guards.filter(({ id }) => !previousGuards.has(id)),
  };
}

export function render(result: ComplexityDelta): string {
  const rows: [string, number][] = [
    ['LOC', result.delta.loc],
    ['Files', result.delta.sourceFiles],
    ['Functions', result.delta.functions],
    ['Methods', result.delta.methods],
    ['Classes', result.delta.classes],
    ['Interfaces', result.delta.interfaces],
    ['Type aliases', result.delta.typeAliases],
    ['Enums', result.delta.enums],
    ['Variables', result.delta.variables],
    ['Exports', result.delta.exportedDeclarations],
    ['Imports', result.delta.imports],
    ['Branches', result.delta.conditionalBranches],
    ['Call edges', result.delta.callEdges],
    ['Dependency edges', result.delta.moduleDependencyEdges],
    ['Reference edges', result.delta.symbolReferenceEdges],
    ['Single-caller functions', result.delta.singleCallerFunctions],
    ['Single-impl interfaces', result.delta.singleImplementationInterfaces],
    ['Unreferenced exports', result.delta.unreferencedExports],
  ];
  const output = ['COMPLEXITY DELTA', ''];
  for (const [label, value] of rows) {
    output.push(`${label.padEnd(27)} ${signed(value).padStart(7)}`);
  }
  output.push(
    '',
    `${'Graph nodes'.padEnd(27)} ${(result.graphChangePercent.nodes === null ? 'new' : `${signed(result.graphChangePercent.nodes)}%`).padStart(7)}`,
    `${'Graph edges'.padEnd(27)} ${(result.graphChangePercent.edges === null ? 'new' : `${signed(result.graphChangePercent.edges)}%`).padStart(7)}`,
  );
  const list = (title: string, rows: string[]) => {
    if (rows.length) output.push('', title, ...rows.map((row) => `  ${row}`));
  };
  list(
    'Suspicious intermediates:',
    result.newIntermediateConcepts.map(({ name, file, line }) => `${name} (${file}:${line})`),
  );
  list(
    'Exports nothing references:',
    result.newUnreferencedExports.map(({ name, file, line }) => `${name} (${file}:${line})`),
  );
  list(
    'Exports only tests reference:',
    result.newTestOnlyExports.map(
      ({ name, file, line, referrers }) => `${name} (${file}:${line}) <- ${referrers.join(', ')}`,
    ),
  );
  list(
    'Guards the types say cannot fire:',
    result.newUnreachableGuards.map(
      ({ text, file, line, type }) =>
        `${text.length > 80 ? `${text.slice(0, 77)}...` : text} (${file}:${line}): ${type}`,
    ),
  );
  return output.join('\n');
}

function snapshotPath(file: SourceFile): string {
  return file.getFilePath().slice('/repo/'.length);
}

function moduleSpecifiers(sourceFile: SourceFile) {
  return [...sourceFile.getImportDeclarations(), ...sourceFile.getExportDeclarations()]
    .filter((declaration) => declaration.getModuleSpecifier())
    .map((declaration) => ({
      specifier: declaration.getModuleSpecifierValue()!,
      file: declaration.getModuleSpecifierSourceFile(),
    }));
}

function declarationKind(node: Node): string | undefined {
  if (isCallable(node) && !Node.isMethodDeclaration(node)) return 'function';
  if (Node.isMethodDeclaration(node)) return 'method';
  if (Node.isClassDeclaration(node)) return 'class';
  if (Node.isInterfaceDeclaration(node)) return 'interface';
  if (Node.isTypeAliasDeclaration(node)) return 'type';
  if (Node.isEnumDeclaration(node)) return 'enum';
  if (Node.isVariableDeclaration(node) && !isCallable(node.getInitializer())) return 'variable';
}

function declarationName(node: Node): string | undefined {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent))
      return parent.getName();
    return Node.isFunctionExpression(node) ? (node.getName() ?? '<anonymous>') : '<anonymous>';
  }
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isVariableDeclaration(node)
  ) {
    return node.getName() ?? 'default';
  }
}

function qualifiedName(node: Node, name: string): string {
  const owners: string[] = [];
  for (const ancestor of node.getAncestors().reverse()) {
    const ownerName = declarationName(ancestor);
    if (ownerName && declarationKind(ancestor)) owners.push(ownerName);
  }
  return [...owners, name].join('.');
}

function isDeclarationName(identifier: Node, declaration: Node | undefined): boolean {
  if (!declaration || !('getNameNode' in declaration)) return false;
  return (declaration as Node & { getNameNode(): Node | undefined }).getNameNode() === identifier;
}

function edgeCounts(edges: Set<string>, outgoing: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const [from, to] = splitEdge(edge);
    const key = outgoing ? from : to;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function splitEdge(edge: string): [string, string] {
  const separator = edge.indexOf(' -> ');
  return [edge.slice(0, separator), edge.slice(separator + 4)];
}

function declarationFile(id: string, declarations: Map<string, Declaration>): string {
  return declarations.get(id)?.file ?? id.replace(/^module:/, '');
}

const NULL_COMPARISONS = [
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
];

// The value a guard protects, and whether the guard tests truthiness (`!x`,
// `x && y`, `if (x)`) or only null and undefined (`x?.`, `x ?? y`, `x == null`).
function guardedValue(node: Node): { value: Node; truthiness: boolean; node: Node } | undefined {
  if (
    (Node.isPropertyAccessExpression(node) ||
      Node.isElementAccessExpression(node) ||
      Node.isCallExpression(node)) &&
    node.hasQuestionDotToken()
  ) {
    return { value: node.getExpression(), truthiness: false, node };
  }
  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    if (operator === SyntaxKind.QuestionQuestionToken) {
      return { value: node.getLeft(), truthiness: false, node };
    }
    if (operator === SyntaxKind.AmpersandAmpersandToken || operator === SyntaxKind.BarBarToken) {
      return { value: node.getLeft(), truthiness: true, node };
    }
    if (NULL_COMPARISONS.includes(operator)) {
      const value = isNullish(node.getRight())
        ? node.getLeft()
        : isNullish(node.getLeft())
          ? node.getRight()
          : undefined;
      return value && { value, truthiness: false, node };
    }
  }
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken) {
    return { value: node.getOperand(), truthiness: true, node };
  }
  if (Node.isIfStatement(node) || Node.isConditionalExpression(node)) {
    const condition = Node.isIfStatement(node) ? node.getExpression() : node.getCondition();
    if (
      Node.isIdentifier(condition) ||
      Node.isPropertyAccessExpression(condition) ||
      Node.isElementAccessExpression(condition)
    ) {
      return { value: condition, truthiness: true, node: condition };
    }
  }
  return undefined;
}

function isNullish(node: Node): boolean {
  return (
    node.getKind() === SyntaxKind.NullKeyword ||
    (Node.isIdentifier(node) && node.getText() === 'undefined')
  );
}

function mayBeNullish(type: Type): boolean {
  if (type.isUnion()) return type.getUnionTypes().some(mayBeNullish);
  return (
    type.isAny() ||
    type.isUnknown() ||
    type.isNull() ||
    type.isUndefined() ||
    type.isTypeParameter() ||
    (type.getFlags() & ts.TypeFlags.Void) !== 0
  );
}

function isObjectType(type: Type): boolean {
  if (type.isUnion()) return type.getUnionTypes().every(isObjectType);
  if (type.isIntersection()) return type.getIntersectionTypes().every(isObjectType);
  return type.isObject();
}

function isCallable(node: Node | undefined): boolean {
  return (
    !!node &&
    (Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node))
  );
}

function hasMutation(node: Node): boolean {
  let mutation = false;
  node.forEachDescendant((descendant, traversal) => {
    if (isCallable(descendant)) return traversal.skip();
    if (
      Node.isDeleteExpression(descendant) ||
      ((Node.isPrefixUnaryExpression(descendant) || Node.isPostfixUnaryExpression(descendant)) &&
        [SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken].includes(
          descendant.getOperatorToken(),
        )) ||
      (Node.isBinaryExpression(descendant) &&
        descendant.getOperatorToken().getKind() >= ts.SyntaxKind.FirstAssignment &&
        descendant.getOperatorToken().getKind() <= ts.SyntaxKind.LastAssignment)
    ) {
      mutation = true;
      traversal.stop();
    }
  });
  return mutation;
}

function percentChange(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : null;
  return Math.round(((after - before) / before) * 1000) / 10;
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}
