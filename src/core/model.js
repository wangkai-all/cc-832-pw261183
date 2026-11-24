// Model normalization, validation and compilation into dependency/evaluation
// structures. This module never mutates its input configuration.

import { AnalysisError, DomainAnalysisError } from './errors.js';
import { isIdentifierName, parseExpression, collectVariables } from './parser.js';
import { cleanInterval } from './intervals.js';
import { evaluateInterval } from './evaluator.js';
import { buildDependencyGraph, findCycle } from './graph.js';

const RESERVED = new Set(['log', 'ln', 'exp', 'sqrt', 'abs']);

function toFiniteNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return Number.NaN;
}

export function normalizeModelConfig(raw = {}) {
  const sources = (raw.sources || []).map((s, index) => ({
    id: String(s.id ?? s.symbol ?? `s${index + 1}`).trim(),
    name: String(s.name ?? s.label ?? s.id ?? `来源 ${index + 1}`).trim(),
    lo: toFiniteNumber(s.lo ?? s.lower),
    hi: toFiniteNumber(s.hi ?? s.upper),
    unit: s.unit ? String(s.unit) : '',
  }));

  const inputs = (raw.inputs || raw.metrics || []).map((x, index) => {
    const formula = typeof x.formula === 'string' && x.formula.trim() ? x.formula.trim() : null;
    return {
      name: String(x.name ?? x.symbol ?? `x${index + 1}`).trim(),
      label: String(x.label ?? x.name ?? `指标 ${index + 1}`).trim(),
      formula,
      lo: formula ? null : toFiniteNumber(x.lo ?? x.lower),
      hi: formula ? null : toFiniteNumber(x.hi ?? x.upper),
      unit: x.unit ? String(x.unit) : '',
    };
  });

  return {
    sources,
    inputs,
    expression: String(raw.expression ?? raw.target ?? '').trim(),
  };
}

function validateNormalized(config) {
  const issues = [];
  const sourceIds = new Set();
  const inputNames = new Set();

  for (const s of config.sources) {
    if (!isIdentifierName(s.id)) issues.push(`共同来源符号 “${s.id}” 不是合法标识符`);
    if (RESERVED.has(s.id)) issues.push(`共同来源符号 “${s.id}” 与保留函数重名`);
    if (sourceIds.has(s.id)) issues.push(`共同来源符号 “${s.id}” 重复`);
    sourceIds.add(s.id);
    if (!Number.isFinite(s.lo) || !Number.isFinite(s.hi)) issues.push(`来源 ${s.id} 的上下界必须是数字`);
    else if (s.lo > s.hi) issues.push(`来源 ${s.id} 的下界不能大于上界`);
  }

  for (const x of config.inputs) {
    if (!isIdentifierName(x.name)) issues.push(`输入指标名 “${x.name}” 不是合法标识符`);
    if (RESERVED.has(x.name)) issues.push(`输入指标名 “${x.name}” 与保留函数重名`);
    if (inputNames.has(x.name)) issues.push(`输入指标名 “${x.name}” 重复`);
    if (sourceIds.has(x.name)) issues.push(`输入指标名 “${x.name}” 与共同来源重名`);
    inputNames.add(x.name);

    if (!x.formula) {
      if (!Number.isFinite(x.lo) || !Number.isFinite(x.hi)) {
        issues.push(`独立输入 ${x.name} 必须提供数字上下界，或填写来源表达式`);
      } else if (x.lo > x.hi) {
        issues.push(`输入 ${x.name} 的下界不能大于上界`);
      }
    }
  }

  if (!config.expression) issues.push('目标表达式不能为空');
  return issues;
}

function topoSortInputs(inputs, references) {
  const adjacency = {};
  for (const input of inputs) {
    adjacency[input.name] = [...(references[input.name]?.inputs || [])];
  }

  const cycle = findCycle(adjacency);
  if (cycle) {
    throw new AnalysisError('CYCLE', `检测到表达式循环：${cycle.join(' → ')}`, { cycle });
  }

  const visited = new Set();
  const order = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const dep of adjacency[name] || []) visit(dep);
    order.push(name);
  }
  for (const input of inputs) visit(input.name);
  return order;
}

export function compileModel(rawConfig) {
  const config = normalizeModelConfig(rawConfig);
  const issues = validateNormalized(config);

  const sourceIds = new Set(config.sources.map((s) => s.id));
  const inputNames = new Set(config.inputs.map((x) => x.name));
  const formulaAsts = Object.create(null);
  const references = Object.create(null);
  let targetAst = null;

  if (config.expression) {
    try {
      targetAst = parseExpression(config.expression);
    } catch (error) {
      issues.push(error.message);
    }
  }

  for (const input of config.inputs) {
    if (!input.formula) continue;
    try {
      const ast = parseExpression(input.formula);
      formulaAsts[input.name] = ast;
      const vars = collectVariables(ast);
      references[input.name] = {
        all: vars,
        sources: new Set(vars.filter((v) => sourceIds.has(v))),
        inputs: vars.filter((v) => inputNames.has(v)),
        unknown: vars.filter((v) => !sourceIds.has(v) && !inputNames.has(v)),
      };
      if (references[input.name].unknown.length) {
        issues.push(`指标 ${input.name} 引用了未知符号：${references[input.name].unknown.join(', ')}`);
      }
    } catch (error) {
      issues.push(`指标 ${input.name}：${error.message}`);
    }
  }

  if (targetAst) {
    const vars = collectVariables(targetAst);
    const unknown = vars.filter((v) => !sourceIds.has(v) && !inputNames.has(v));
    if (unknown.length) issues.push(`目标表达式引用了未知输入或来源：${unknown.join(', ')}`);
    references.__target__ = {
      all: vars,
      sources: new Set(vars.filter((v) => sourceIds.has(v))),
      inputs: vars.filter((v) => inputNames.has(v)),
      unknown,
    };
  }

  if (issues.length) {
    throw new AnalysisError('INVALID_MODEL', '模型校验未通过，计算已阻断', { issues });
  }

  let order;
  try {
    order = topoSortInputs(config.inputs, references);
  } catch (error) {
    const graph = buildDependencyGraph({
      sources: config.sources,
      inputs: config.inputs,
      targetAst,
      formulaAsts,
      references,
    });
    error.details = { ...(error.details || {}), graph };
    throw error;
  }

  const graph = buildDependencyGraph({
    sources: config.sources,
    inputs: config.inputs,
    targetAst,
    formulaAsts,
    references,
  });

  // Classic interval ranges for every metric. Formula evaluation uses ordinary
  // interval arithmetic here, independently of the affine correlated solver.
  const intervalEnv = Object.create(null);
  const metricIntervals = Object.create(null);
  const metricIntervalErrors = Object.create(null);
  let ordinaryPreflightError = null;
  for (const s of config.sources) intervalEnv[s.id] = cleanInterval(s.lo, s.hi);

  for (const name of order) {
    const input = config.inputs.find((x) => x.name === name);
    if (!input.formula) {
      metricIntervals[name] = cleanInterval(input.lo, input.hi);
    } else if (!ordinaryPreflightError) {
      try {
        metricIntervals[name] = evaluateInterval(formulaAsts[name], intervalEnv);
      } catch (error) {
        error.details = { ...(error.details || {}), graph, phase: 'input-domain-preflight' };
        if (error instanceof DomainAnalysisError || error.code?.startsWith('DOMAIN_')) {
          // Classic interval arithmetic can conservatively reject a correlated
          // cancellation (e.g. x/(x-x+1)). Preserve that ordinary-mode failure,
          // but let the affine preflight decide whether the whole job blocks.
          ordinaryPreflightError = error;
          metricIntervalErrors[name] = error.toJSON ? error.toJSON() : {
            code: error.code,
            message: error.message,
            details: error.details,
          };
          metricIntervals[name] = null;
          break;
        }
        throw error;
      }
    }
    if (metricIntervals[name]) intervalEnv[name] = metricIntervals[name];
  }

  for (const s of config.sources) metricIntervals[s.id] = intervalEnv[s.id];

  const dimensions = [];
  for (const s of config.sources) {
    dimensions.push({
      key: `source:${s.id}`,
      symbol: s.id,
      kind: 'source',
      label: s.name || s.id,
      lo: s.lo,
      hi: s.hi,
    });
  }
  for (const input of config.inputs) {
    if (!input.formula) {
      dimensions.push({
        key: `input:${input.name}`,
        symbol: input.name,
        kind: 'independent-input',
        label: input.label || input.name,
        lo: input.lo,
        hi: input.hi,
      });
    }
  }

  return {
    config,
    targetAst,
    formulaAsts,
    references,
    order,
    graph,
    metricIntervals,
    metricIntervalErrors,
    ordinaryPreflightError,
    dimensions,
  };
}

export function rootBox(compiled) {
  const box = Object.create(null);
  for (const d of compiled.dimensions) box[d.key] = { lo: d.lo, hi: d.hi };
  return box;
}
