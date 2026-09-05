import { Node, SyntaxKind, type Symbol as MorphSymbol, ts } from 'ts-morph';
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

export interface Analysis {
  measurements: Measurements;
  functions: FunctionFact[];
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
}

type Declaration = {
  id: string;
  name: string;
  file: string;
  node: Node;
  callable: boolean;
};

export function analyze(snapshot: Snapshot): Analysis {
  const project = createProject(snapshot.files);
  const paths = new Map(
    project
      .getSourceFiles()
      .filter((file) => !file.isDeclarationFile())
      .map((file) => [file, file.getFilePath().slice('/repo/'.length)]),
  );

  const sourceFiles = [...paths.keys()];
  const declarations: Declaration[] = [];
  const nodeIds = new Map<Node, string>();
  const usedIds = new Map<string, number>();

  for (const sourceFile of sourceFiles) {
    const file = paths.get(sourceFile)!;
    for (const node of sourceFile.getDescendants()) {
      const kind = declarationKind(node);
      const name = declarationName(node);
      if (!kind || !name) continue;
      const baseId = `symbol:${file}:${kind}:${qualifiedName(node, name)}`;
      const occurrence = usedIds.get(baseId) ?? 0;
      usedIds.set(baseId, occurrence + 1);
      const id = occurrence === 0 ? baseId : `${baseId}:${occurrence + 1}`;
      const callable = isCallable(node);
      declarations.push({ id, name, file, node, callable });
      nodeIds.set(node, id);
      if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
        const parent = node.getParent();
        if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
          nodeIds.set(parent, id);
        }
      }
    }
  }

  const declarationById = new Map(declarations.map((item) => [item.id, item]));
  const declarationIdForSymbol = (symbol: MorphSymbol | undefined) => {
    let resolved = symbol;
    const seen = new Set<MorphSymbol>();
    while (resolved?.isAlias() && !seen.has(resolved)) {
      seen.add(resolved);
      resolved = resolved.getAliasedSymbol();
    }
    for (const declaration of resolved?.getDeclarations() ?? []) {
      const id = nodeIds.get(declaration);
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
  for (const sourceFile of sourceFiles) {
    const from = `module:${paths.get(sourceFile)!}`;
    imports += sourceFile.getImportDeclarations().length;
    for (const declaration of [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ]) {
      if (!declaration.getModuleSpecifier()) continue;
      const targetFile = declaration.getModuleSpecifierSourceFile();
      const target = targetFile
        ? `module:${paths.get(targetFile) ?? targetFile.getFilePath().slice('/repo/'.length)}`
        : `package:${declaration.getModuleSpecifierValue()}`;
      moduleEdges.add(`${from} -> ${target}`);
      if (!targetFile || !paths.has(targetFile)) externalModules.add(target);
    }
    const exports = sourceFile.getExportSymbols();
    exportedDeclarations += exports.length;
    for (const symbol of exports) {
      const id = declarationIdForSymbol(symbol);
      if (id) exportedIds.add(id);
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
    .filter(({ callable }) => callable)
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
    if (!Node.isClassDeclaration(declaration.node)) continue;
    for (const heritage of declaration.node.getImplements()) {
      const interfaceId = declarationIdForSymbol(heritage.getExpression().getSymbol());
      if (!interfaceId || !Node.isInterfaceDeclaration(declarationById.get(interfaceId)?.node)) {
        continue;
      }
      const classes = implementations.get(interfaceId) ?? new Set<string>();
      classes.add(declaration.id);
      implementations.set(interfaceId, classes);
    }
  }

  const externallyReferenced = new Set<string>();
  for (const edge of referenceEdges) {
    const [from, to] = splitEdge(edge);
    if (declarationFile(from, declarationById) !== declarationFile(to, declarationById)) {
      externallyReferenced.add(to);
    }
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
  if (result.newIntermediateConcepts.length) {
    output.push('', 'Suspicious intermediates:');
    for (const candidate of result.newIntermediateConcepts) {
      output.push(`  ${candidate.name} (${candidate.file}:${candidate.line})`);
    }
  }
  return output.join('\n');
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
