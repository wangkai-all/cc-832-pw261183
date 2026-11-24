// Complete provenance/dependency graph. Edges point in data-flow direction:
// raw source / independent interval -> formula AST -> metric -> target AST -> job output.

import { printAst } from './parser.js';

export function buildDependencyGraph({ sources, inputs, targetAst, formulaAsts, references }) {
  const nodes = new Map();
  const edges = [];
  const edgeSet = new Set();

  function addNode(node) {
    if (!nodes.has(node.id)) nodes.set(node.id, { layer: 0, ...node });
    return node.id;
  }

  function addEdge(from, to, kind = 'data') {
    if (!from || !to || from === to) return;
    const key = `${from}->${to}:${kind}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ from, to, kind });
  }

  for (const source of sources) {
    addNode({
      id: `source:${source.id}`,
      kind: 'source',
      label: source.id,
      detail: source.name || source.id,
      interval: { lo: source.lo, hi: source.hi },
    });
  }

  for (const input of inputs) {
    addNode({
      id: `input:${input.name}`,
      kind: 'input',
      label: input.name,
      detail: input.formula ? `${input.name} = ${input.formula}` : '独立误差区间',
      interval: input.formula ? undefined : { lo: input.lo, hi: input.hi },
    });
    if (!input.formula) {
      const dimId = `dimension:input:${input.name}`;
      addNode({
        id: dimId,
        kind: 'uncertainty',
        label: `ε_${input.name}`,
        detail: '该字段独有的区间误差源',
        interval: { lo: input.lo, hi: input.hi },
      });
      addEdge(dimId, `input:${input.name}`, 'independent-interval');
    }
  }

  function addAstSubgraph(ast, prefix, ownerId, ownerName) {
    function visit(node, parentId) {
      if (!node) return;
      const id = `${prefix}:${node.id}`;
      let kind = 'ast';
      let label = '';
      if (node.kind === 'binary') {
        kind = 'operation';
        label = node.op === '^' ? '^' : node.op;
      } else if (node.kind === 'unary') {
        kind = 'operation';
        label = node.op;
      } else if (node.kind === 'call') {
        kind = 'function';
        label = node.name;
      } else if (node.kind === 'variable') {
        kind = 'occurrence';
        label = node.name;
      } else if (node.kind === 'number') {
        kind = 'constant';
        label = String(node.value);
      }

      addNode({
        id,
        kind,
        label,
        detail: printAst(node),
        owner: ownerName,
        astKind: node.kind,
      });

      if (parentId) addEdge(id, parentId, 'ast-child');

      if (node.kind === 'variable') {
        const refs = references?.[ownerName] || {};
        if (refs.sources?.has?.(node.name) || sources.some((s) => s.id === node.name)) {
          addEdge(`source:${node.name}`, id, 'source-reference');
        } else if (inputs.some((i) => i.name === node.name)) {
          addEdge(`input:${node.name}`, id, 'metric-reference');
        }
      }

      if (node.left) visit(node.left, id);
      if (node.right) visit(node.right, id);
      if (node.operand) visit(node.operand, id);
      if (Array.isArray(node.args)) node.args.forEach((arg) => visit(arg, id));
      return id;
    }

    const rootId = visit(ast, null);
    if (rootId && ownerId) addEdge(rootId, ownerId, 'formula-result');
    return rootId;
  }

  for (const input of inputs) {
    const ast = formulaAsts?.[input.name];
    if (ast) addAstSubgraph(ast, `formula:${input.name}`, `input:${input.name}`, input.name);
  }

  if (targetAst) {
    const rootId = addAstSubgraph(targetAst, 'target', null, '__target__');
    addNode({
      id: 'output:target',
      kind: 'output',
      label: '目标界',
      detail: printAst(targetAst),
    });
    if (rootId) addEdge(rootId, 'output:target', 'result');
  }

  // Longest-path layering for deterministic SVG/HTML layout.
  const byId = new Map([...nodes.entries()]);
  const outgoing = new Map();
  for (const e of edges) {
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from).push(e.to);
  }

  for (let pass = 0; pass < nodes.size + 2; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      const nextLayer = from.layer + 1;
      if (nextLayer > to.layer) {
        to.layer = nextLayer;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return {
    nodes: [...nodes.values()].map((n) => ({ ...n })),
    edges: edges.map((e) => ({ ...e })),
    stats: {
      nodeCount: nodes.size,
      edgeCount: edges.length,
      sourceCount: sources.length,
      inputCount: inputs.length,
    },
  };
}

export function findCycle(adjacency) {
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const stack = [];

  function dfs(node) {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency[node] || []) {
      const s = state.get(next) || 0;
      if (s === 1) {
        const start = stack.indexOf(next);
        return [...stack.slice(start), next];
      }
      if (s === 0) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, 2);
    return null;
  }

  for (const node of Object.keys(adjacency)) {
    if ((state.get(node) || 0) === 0) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}
