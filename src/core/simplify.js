// Small, conservative algebraic cancellation layer.
// Affine forms already make x - x exact, but explicit factor cancellation also
// resolves x / x and a*b/a into their dependency-preserving reduced forms.
// Domain checks are intentionally performed on the ORIGINAL ast before this.

import { printAst } from './parser.js';

export function structuralKey(node) {
  return printAst(node);
}

function num(value) {
  return { kind: 'number', value };
}

function bin(op, left, right) {
  return { kind: 'binary', op, left, right };
}

function unaryMinus(operand) {
  if (operand.kind === 'number') return num(-operand.value);
  if (operand.kind === 'unary' && operand.op === '-') return operand.operand;
  return { kind: 'unary', op: '-', operand };
}

export function assignIds(ast, prefix = 's') {
  let i = 0;
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    i += 1;
    node.id = `${prefix}${i}`;
    if (node.operand) walk(node.operand);
    if (node.left) walk(node.left);
    if (node.right) walk(node.right);
    if (Array.isArray(node.args)) node.args.forEach(walk);
  }
  walk(ast);
  return ast;
}

export function simplifyAst(inputAst) {
  const cancellations = [];
  let ast = { ...inputAst };

  if (inputAst.kind === 'binary') {
    const leftResult = simplifyAst(inputAst.left);
    const rightResult = simplifyAst(inputAst.right);
    cancellations.push(...leftResult.cancellations, ...rightResult.cancellations);
    ast = { ...inputAst, left: leftResult.ast, right: rightResult.ast };
  } else if (inputAst.kind === 'unary') {
    const operandResult = simplifyAst(inputAst.operand);
    cancellations.push(...operandResult.cancellations);
    ast = { ...inputAst, operand: operandResult.ast };
  } else if (inputAst.kind === 'call') {
    ast = { ...inputAst, args: inputAst.args.map((arg) => {
      const result = simplifyAst(arg);
      cancellations.push(...result.cancellations);
      return result.ast;
    }) };
  }

  if (ast.kind === 'binary' && (ast.op === '+' || ast.op === '-')) {
    const result = simplifyAdditive(ast);
    ast = result.ast;
    cancellations.push(...result.cancellations);
  } else if (ast.kind === 'binary' && (ast.op === '*' || ast.op === '/')) {
    const result = simplifyMultiplicative(ast);
    ast = result.ast;
    cancellations.push(...result.cancellations);
  }

  ast = identityRules(ast);

  // Re-run identity cleanup a few times; flattening has already happened in
  // child calls and this pass only removes newly exposed literal identities.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = JSON.stringify(ast);
    ast = cleanupIdentities(ast);
    if (JSON.stringify(ast) === before) break;
  }

  assignIds(ast, 'r');
  return {
    ast,
    changed: printAst(inputAst) !== printAst(ast) || cancellations.length > 0,
    cancellations: dedupeCancellations(cancellations),
    expression: printAst(ast),
  };
}

function cleanupIdentities(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.kind === 'binary') {
    return identityRules({
      ...node,
      left: cleanupIdentities(node.left),
      right: cleanupIdentities(node.right),
    });
  }
  if (node.kind === 'unary') return { ...node, operand: cleanupIdentities(node.operand) };
  if (node.kind === 'call') return { ...node, args: node.args.map(cleanupIdentities) };
  return node;
}

function dedupeCancellations(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}:${item.expression}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function collectAdditive(node, sign, state) {
  if (node.kind === 'number') {
    state.constant += sign * node.value;
    return;
  }
  if (node.kind === 'unary' && node.op === '-') {
    collectAdditive(node.operand, -sign, state);
    return;
  }
  if (node.kind === 'binary' && (node.op === '+' || node.op === '-')) {
    collectAdditive(node.left, sign, state);
    collectAdditive(node.right, node.op === '+' ? sign : -sign, state);
    return;
  }
  const key = structuralKey(node);
  const entry = state.terms.get(key) || { coefficient: 0, node };
  entry.coefficient += sign;
  entry.node = node;
  state.terms.set(key, entry);
}

function reconstructAdditive(constant, terms) {
  const parts = [];
  if (constant !== 0) parts.push(num(constant));

  for (const [key, entry] of terms) {
    const c = entry.coefficient;
    if (c === 0) continue;
    const absC = Math.abs(c);
    let term = entry.node;
    if (absC !== 1) term = bin('*', num(absC), term);
    if (c < 0) term = unaryMinus(term);
    parts.push(term);
  }

  if (parts.length === 0) return num(0);
  let result = parts[0];
  for (let i = 1; i < parts.length; i += 1) result = bin('+', result, parts[i]);
  return result;
}

function simplifyAdditive(node) {
  const state = { constant: 0, terms: new Map(), cancellations: [] };
  collectAdditive(node, 1, state);

  for (const [key, entry] of state.terms) {
    if (entry.coefficient === 0) {
      state.cancellations.push({ type: 'additive', expression: key });
      state.terms.delete(key);
    }
  }

  // -0 is display noise.
  if (Object.is(state.constant, -0)) state.constant = 0;
  return {
    ast: reconstructAdditive(state.constant, state.terms),
    cancellations: state.cancellations,
  };
}

function collectMultiplicative(node, exponent, state) {
  if (node.kind === 'unary' && node.op === '-') {
    state.sign *= -1;
    collectMultiplicative(node.operand, exponent, state);
    return;
  }
  if (node.kind === 'binary' && (node.op === '*' || node.op === '/')) {
    collectMultiplicative(node.left, exponent, state);
    collectMultiplicative(node.right, node.op === '*' ? exponent : -exponent, state);
    return;
  }

  const key = structuralKey(node);
  const entry = state.factors.get(key) || { exponent: 0, node };
  entry.exponent += exponent;
  entry.node = node;
  state.factors.set(key, entry);
}

function productOfFactors(factors) {
  if (factors.length === 0) return num(1);
  let result = factors[0];
  for (let i = 1; i < factors.length; i += 1) result = bin('*', result, factors[i]);
  return result;
}

function repeatFactor(node, count) {
  const copies = [];
  for (let i = 0; i < count; i += 1) copies.push(node);
  return productOfFactors(copies);
}

function simplifyMultiplicative(node) {
  const state = { sign: 1, factors: new Map(), cancellations: [] };
  collectMultiplicative(node, 1, state);

  for (const [key, entry] of state.factors) {
    if (entry.exponent === 0) {
      state.cancellations.push({ type: 'multiplicative', expression: key });
      state.factors.delete(key);
    }
  }

  const numerator = [];
  const denominator = [];
  for (const entry of state.factors.values()) {
    if (entry.exponent > 0) numerator.push(repeatFactor(entry.node, entry.exponent));
    if (entry.exponent < 0) denominator.push(repeatFactor(entry.node, -entry.exponent));
  }

  let result = productOfFactors(numerator);
  if (denominator.length > 0) {
    result = bin('/', result, productOfFactors(denominator));
  }
  if (state.sign < 0) result = unaryMinus(result);
  return { ast: result, cancellations: state.cancellations };
}

function identityRules(node) {
  if (node.kind !== 'binary') return node;
  const { op, left, right } = node;

  if (op === '*') {
    if (left.kind === 'number' && left.value === 0) return num(0);
    if (right.kind === 'number' && right.value === 0) return num(0);
    if (left.kind === 'number' && left.value === 1) return right;
    if (right.kind === 'number' && right.value === 1) return left;
  }
  if (op === '/') {
    if (left.kind === 'number' && left.value === 0) return num(0);
    if (right.kind === 'number' && right.value === 1) return left;
  }
  if (op === '+' || op === '-') {
    if (right.kind === 'number' && right.value === 0) return left;
    if (op === '+' && left.kind === 'number' && left.value === 0) return right;
  }
  return node;
}
