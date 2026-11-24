// AST evaluators for three semantics:
// 1. classic dependency-blind interval arithmetic,
// 2. dependency-preserving affine forms,
// 3. ordinary point values for deterministic feasible samples.

import { AnalysisError } from './errors.js';
import { printAst } from './parser.js';
import {
  absIv,
  addIv,
  divIv,
  expIv,
  logIv,
  mulIv,
  negIv,
  sqrtIv,
  subIv,
  cleanInterval,
} from './intervals.js';
import {
  absAffine,
  addAffine,
  affineRange,
  divAffine,
  expAffine,
  logAffine,
  mulAffine,
  negAffine,
  powIntegerAffine,
  residualAffine,
  scaleAffine,
  sqrtAffine,
  subAffine,
} from './affine.js';

function record(ledger, node, extra) {
  if (!ledger) return;
  ledger.push({
    nodeId: node.id,
    kind: node.kind,
    op: node.op || null,
    name: node.name || null,
    expression: printAst(node),
    children: [
      node.left?.id,
      node.right?.id,
      node.operand?.id,
      ...(Array.isArray(node.args) ? node.args.map((arg) => arg?.id) : []),
    ].filter(Boolean),
    ...extra,
  });
}

function integerExponent(node) {
  if (node?.kind === 'unary' && node.op === '-') {
    return -integerExponent(node.operand);
  }
  if (node?.kind === 'unary' && node.op === '+') {
    return integerExponent(node.operand);
  }
  if (!node || node.kind !== 'number' || !Number.isInteger(node.value)) {
    throw new AnalysisError('UNSUPPORTED_POWER', '^ 只允许整数数字指数，例如 x^2 或 x^-2');
  }
  return node.value;
}

function powIntegerInterval(a, n) {
  if (n < 0) {
    // Reuse division domain handling via reciprocal interval.
    const one = cleanInterval(1, 1);
    return divIv(one, powIntegerInterval(a, -n));
  }
  if (n === 0) return cleanInterval(1, 1);
  let result = cleanInterval(1, 1);
  let base = a;
  let exponent = n;
  while (exponent > 0) {
    if (exponent & 1) result = mulIv(result, base);
    exponent >>= 1;
    if (exponent > 0) base = mulIv(base, base);
  }
  return result;
}

export function evaluateInterval(node, env, ledger = null) {
  let value;

  switch (node.kind) {
    case 'number':
      // Integer literals are exact point constants. Other decimal literals
      // receive the usual outward guard.
      value = Number.isInteger(node.value)
        ? { lo: node.value, hi: node.value }
        : cleanInterval(node.value, node.value);
      break;
    case 'variable': {
      value = env[node.name];
      if (!value) throw new AnalysisError('UNKNOWN_VARIABLE', `未知变量 ${node.name}`);
      break;
    }
    case 'unary': {
      const v = evaluateInterval(node.operand, env, ledger);
      value = node.op === '-' ? negIv(v) : v;
      break;
    }
    case 'binary': {
      if (node.op === '^') {
        const left = evaluateInterval(node.left, env, ledger);
        const exponent = integerExponent(node.right);
        value = powIntegerInterval(left, exponent);
        break;
      }
      const a = evaluateInterval(node.left, env, ledger);
      const b = evaluateInterval(node.right, env, ledger);
      if (node.op === '+') value = addIv(a, b);
      else if (node.op === '-') value = subIv(a, b);
      else if (node.op === '*') value = mulIv(a, b);
      else if (node.op === '/') value = divIv(a, b);
      else throw new AnalysisError('UNSUPPORTED_OPERATOR', `不支持运算符 ${node.op}`);
      break;
    }
    case 'call': {
      const a = evaluateInterval(node.args[0], env, ledger);
      if (node.name === 'exp') value = expIv(a);
      else if (node.name === 'log') value = logIv(a);
      else if (node.name === 'sqrt') value = sqrtIv(a);
      else if (node.name === 'abs') value = absIv(a);
      else throw new AnalysisError('UNSUPPORTED_FUNCTION', `不支持函数 ${node.name}`);
      break;
    }
    default:
      throw new AnalysisError('INVALID_AST', '无效表达式节点');
  }

  record(ledger, node, { interval: value });
  return value;
}

function ordinaryFallback(node, ctx, error) {
  if (!ctx?.intervalEnv || !(error?.code?.startsWith?.('DOMAIN_') || error?.code === 'NUMERIC_OVERFLOW')) {
    throw error;
  }
  try {
    // Classic interval evaluation is dependency-blind but sound. It can prove a
    // domain is legal when a coarse affine residual temporarily crosses zero.
    return residualAffine(evaluateInterval(node, ctx.intervalEnv));
  } catch (ordinaryError) {
    if (ordinaryError?.code?.startsWith?.('DOMAIN_')) throw ordinaryError;
    throw error;
  }
}

export function evaluateAffine(node, env, ledger = null, ctx = {}) {
  let value;

  switch (node.kind) {
    case 'number': {
      // Treat parsed constants as exact; outward final range guards rounding.
      const { constAffine } = requireAffineConst();
      value = constAffine(node.value);
      break;
    }
    case 'variable': {
      value = env[node.name];
      if (!value) throw new AnalysisError('UNKNOWN_VARIABLE', `未知变量 ${node.name}`);
      break;
    }
    case 'unary': {
      const v = evaluateAffine(node.operand, env, ledger, ctx);
      value = node.op === '-' ? negAffine(v) : v;
      break;
    }
    case 'binary': {
      try {
        if (node.op === '^') {
          const left = evaluateAffine(node.left, env, ledger, ctx);
          const exponent = integerExponent(node.right);
          value = powIntegerAffine(left, exponent);
          break;
        }
        const a = evaluateAffine(node.left, env, ledger, ctx);
        const b = evaluateAffine(node.right, env, ledger, ctx);
        if (node.op === '+') value = addAffine(a, b);
        else if (node.op === '-') value = subAffine(a, b);
        else if (node.op === '*') value = mulAffine(a, b);
        else if (node.op === '/') value = divAffine(a, b);
        else throw new AnalysisError('UNSUPPORTED_OPERATOR', `不支持运算符 ${node.op}`);
      } catch (error) {
        value = ordinaryFallback(node, ctx, error);
      }
      break;
    }
    case 'call': {
      try {
        const a = evaluateAffine(node.args[0], env, ledger, ctx);
        if (node.name === 'exp') value = expAffine(a);
        else if (node.name === 'log') value = logAffine(a);
        else if (node.name === 'sqrt') value = sqrtAffine(a);
        else if (node.name === 'abs') value = absAffine(a);
        else throw new AnalysisError('UNSUPPORTED_FUNCTION', `不支持函数 ${node.name}`);
      } catch (error) {
        value = ordinaryFallback(node, ctx, error);
      }
      break;
    }
    default:
      throw new AnalysisError('INVALID_AST', '无效表达式节点');
  }

  if (ledger) {
    record(ledger, node, {
      interval: affineRange(value),
      affine: { c: value.c, t: { ...value.t }, e: value.e },
    });
  }
  return value;
}

// Avoid a circular-looking top-level import shape while remaining ESM-clean.
import { constAffine } from './affine.js';
function requireAffineConst() {
  return { constAffine };
}

export function evaluatePoint(node, env) {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'variable': {
      const value = env[node.name];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new AnalysisError('UNKNOWN_SAMPLE_VALUE', `变量 ${node.name} 缺少采样值`);
      }
      return value;
    }
    case 'unary': {
      const v = evaluatePoint(node.operand, env);
      return node.op === '-' ? -v : v;
    }
    case 'binary': {
      if (node.op === '^') {
        const exponent = integerExponent(node.right);
        const base = evaluatePoint(node.left, env);
        return base ** exponent;
      }
      const a = evaluatePoint(node.left, env);
      const b = evaluatePoint(node.right, env);
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (node.op === '/') return a / b;
      throw new AnalysisError('UNSUPPORTED_OPERATOR', `不支持运算符 ${node.op}`);
    }
    case 'call': {
      const a = evaluatePoint(node.args[0], env);
      if (node.name === 'log') return Math.log(a);
      if (node.name === 'exp') return Math.exp(a);
      if (node.name === 'sqrt') return Math.sqrt(a);
      if (node.name === 'abs') return Math.abs(a);
      throw new AnalysisError('UNSUPPORTED_FUNCTION', `不支持函数 ${node.name}`);
    }
    default:
      throw new AnalysisError('INVALID_AST', '无效表达式节点');
  }
}

export { scaleAffine };
