// Bounding analysis pipeline: classic intervals plus dependency-preserving
// affine enclosures and deterministic adaptive subdivision.

import { AnalysisError, DomainAnalysisError } from './errors.js';
import { compileModel, rootBox } from './model.js';
import { simplifyAst } from './simplify.js';
import { printAst } from './parser.js';
import {
  evaluateAffine,
  evaluateInterval,
  evaluatePoint,
} from './evaluator.js';
import { affineRange, sourceAffine } from './affine.js';
import {
  formatInterval,
  cleanInterval,
  width as intervalWidth,
  outwardHigh,
  outwardLow,
} from './intervals.js';

export const MAX_BUDGET = 2048;

export function buildAffineEnvironment(
  compiled,
  box,
  formulaAsts = compiled.formulaAsts,
  formulaLedgers = null,
  affineCtx = null,
) {
  const env = Object.create(null);
  for (const d of compiled.dimensions) {
    const chosen = box?.[d.key] || { lo: d.lo, hi: d.hi };
    // Lazy import avoided: sourceAffine is imported at module top below.
    env[d.symbol] = sourceAffine(d.key, { lo: chosen.lo, hi: chosen.hi });
  }
  for (const name of compiled.order) {
    if (formulaAsts[name]) {
      env[name] = evaluateAffine(
        formulaAsts[name],
        env,
        formulaLedgers?.[name] || null,
        affineCtx,
      );
    }
  }
  return env;
}

export function buildIntervalEnvironment(compiled, box, formulaAsts = compiled.formulaAsts) {
  const env = Object.create(null);
  for (const d of compiled.dimensions) {
    const chosen = box?.[d.key] || { lo: d.lo, hi: d.hi };
    env[d.symbol] = cleanInterval(chosen.lo, chosen.hi);
  }
  for (const name of compiled.order) {
    if (formulaAsts[name]) env[name] = evaluateInterval(formulaAsts[name], env);
  }
  return env;
}

export function buildPointEnvironment(compiled, values, formulaAsts = compiled.formulaAsts) {
  const env = Object.create(null);
  for (const d of compiled.dimensions) env[d.symbol] = values[d.key];
  for (const name of compiled.order) {
    if (formulaAsts[name]) env[name] = evaluatePoint(formulaAsts[name], env);
  }
  return env;
}

function buildSingletonIntervalEnvironment(
  compiled,
  values,
  formulaAsts = compiled.formulaAsts,
) {
  const env = Object.create(null);
  // Do not pass these coordinates through cleanInterval(): a singleton must
  // stay singleton. Every arithmetic/function node still applies outward
  // rounding as the expression is evaluated.
  for (const d of compiled.dimensions) {
    env[d.symbol] = { lo: values[d.key], hi: values[d.key] };
  }
  for (const name of compiled.order) {
    if (formulaAsts[name]) env[name] = evaluateInterval(formulaAsts[name], env);
  }
  return env;
}

function enrichLedger(ledger) {
  const byId = new Map(ledger.map((row) => [row.nodeId, row]));
  for (const row of ledger) {
    row.width = intervalWidth(row.interval);
    const childWidths = (row.children || [])
      .map((id) => byId.get(id)?.width)
      .filter((x) => typeof x === 'number' && Number.isFinite(x));
    row.maxChildWidth = childWidths.length ? Math.max(...childWidths) : null;
    row.widthGrowth = row.maxChildWidth === null ? 0 : row.width - row.maxChildWidth;
    row.amplificationRatio =
      row.maxChildWidth && row.maxChildWidth > 1e-12 * Math.max(1, row.width)
        ? row.width / row.maxChildWidth
        : null;
    if (row.affine) {
      row.affine.terms = Object.entries(row.affine.t || {}).map(([key, coefficient]) => ({
        key,
        coefficient,
      }));
      delete row.affine.t;
      row.affine.l1 =
        row.affine.terms.reduce((s, x) => s + Math.abs(x.coefficient), 0) +
        Math.abs(row.affine.c) +
        row.affine.e;
    }
  }

  const ranked = [...ledger].sort((a, b) => b.widthGrowth - a.widthGrowth);
  ranked.forEach((row, index) => {
    row.expansionRank = index + 1;
    row.isTopExpander = index === 0 && row.widthGrowth > 1e-10;
  });
  return ledger;
}

function prefixLedger(rows, prefix, owner) {
  return rows.map((row) => ({
    ...row,
    owner: owner || prefix,
    nodeId: `${prefix}:${row.nodeId}`,
    children: (row.children || []).map((id) => `${prefix}:${id}`),
  }));
}

function runOrdinary(compiled) {
  const ledger = [];
  if (compiled.ordinaryPreflightError) {
    const error = compiled.ordinaryPreflightError;
    return {
      status: 'domain-blocked',
      method: 'ordinary-interval',
      error: error.toJSON ? error.toJSON() : { message: error.message, code: error.code },
      ledger,
    };
  }
  try {
    const env = Object.create(null);
    for (const source of compiled.config.sources) {
      env[source.id] = compiled.metricIntervals[source.id];
    }
    for (const name of compiled.order) {
      const input = compiled.config.inputs.find((x) => x.name === name);
      if (!compiled.formulaAsts[name]) {
        env[name] = compiled.metricIntervals[name];
        continue;
      }
      const formulaRows = [];
      env[name] = evaluateInterval(compiled.formulaAsts[name], env, formulaRows);
      ledger.push(...prefixLedger(formulaRows, `formula:${name}`, name));
    }

    const targetRows = [];
    const value = evaluateInterval(compiled.targetAst, env, targetRows);
    ledger.push(...prefixLedger(targetRows, 'target', '__target__'));
    enrichLedger(ledger);
    return {
      status: 'ok',
      method: 'ordinary-interval',
      certified: { lo: value.lo, hi: value.hi },
      width: intervalWidth(value),
      rootExpression: printAst(compiled.targetAst),
      ledger,
      subdivision: { adaptive: false, leaves: 1, evaluations: 1 },
    };
  } catch (error) {
    enrichLedger(ledger);
    if (error instanceof DomainAnalysisError || error.code?.startsWith('DOMAIN_')) {
      return {
        status: 'domain-blocked',
        method: 'ordinary-interval',
        error: error.toJSON ? error.toJSON() : { message: error.message, code: error.code },
        ledger,
      };
    }
    throw error;
  }
}

function evaluateCorrelatedBox(
  compiled,
  ast,
  box,
  ledger = null,
  formulaAsts = compiled.formulaAsts,
  formulaLedgers = null,
  ordinaryEnv = undefined,
) {
  let intervalEnv = ordinaryEnv;
  if (intervalEnv === undefined) {
    try {
      intervalEnv = buildIntervalEnvironment(compiled, box, formulaAsts);
    } catch {
      // Classic intervals can report a false domain conflict because they
      // discard dependency. The affine pass remains authoritative here; it
      // will throw if it cannot establish domain safety either.
      intervalEnv = null;
    }
  }
  const affineCtx = intervalEnv ? { intervalEnv } : {};
  const env = buildAffineEnvironment(compiled, box, formulaAsts, formulaLedgers, affineCtx);
  const affine = evaluateAffine(ast, env, ledger, affineCtx);
  const interval = affineRange(affine);
  return { affine, interval };
}

function pickSplitDimension(compiled, ast, leaf, formulaAsts) {
  const candidates = compiled.dimensions.filter((d) => {
    const iv = leaf.box[d.key];
    return iv && iv.lo < iv.hi;
  });
  if (candidates.length === 0) return null;

  let best = null;
  for (const dimension of candidates) {
    const iv = leaf.box[dimension.key];
    const mid = (iv.lo + iv.hi) / 2;
    const leftBox = { ...leaf.box, [dimension.key]: { lo: iv.lo, hi: mid } };
    const rightBox = { ...leaf.box, [dimension.key]: { lo: mid, hi: iv.hi } };
    let leftResult;
    let rightResult;
    try {
      leftResult = evaluateCorrelatedBox(compiled, ast, leftBox, null, formulaAsts);
      rightResult = evaluateCorrelatedBox(compiled, ast, rightBox, null, formulaAsts);
    } catch {
      // If a trial reaches a domain boundary, prioritize this dimension.
      return { dimension, at: mid, leftBox, rightBox, leftResult: null, rightResult: null, score: -1, trials: 2 };
    }
    const leftWidth = leftResult.interval.hi - leftResult.interval.lo;
    const rightWidth = rightResult.interval.hi - rightResult.interval.lo;
    const score = Math.max(leftWidth, rightWidth) + 1e-4 * Math.abs(leftWidth - rightWidth);
    if (!best || score < best.score) {
      best = { dimension, at: mid, leftBox, rightBox, leftResult, rightResult, score, trials: 2 };
    }
  }
  return best;
}

function runCorrelated(compiled, normalized, maxLeaves, formulaAsts) {
  const ast = normalized.ast;
  const root = rootBox(compiled);
  const rootLedger = [];
  const rootFormulaLedgers = Object.create(null);
  for (const name of compiled.order) {
    if (formulaAsts[name]) rootFormulaLedgers[name] = [];
  }
  const rootResult = evaluateCorrelatedBox(
    compiled,
    ast,
    root,
    rootLedger,
    formulaAsts,
    rootFormulaLedgers,
  );
  const combinedLedger = [];
  for (const name of compiled.order) {
    if (rootFormulaLedgers[name]?.length) {
      combinedLedger.push(
        ...prefixLedger(rootFormulaLedgers[name], `formula:${name}`, name),
      );
    }
  }
  combinedLedger.push(...prefixLedger(rootLedger, 'target', '__target__'));
  enrichLedger(combinedLedger);

  let nextLeafNumber = 1;
  const rootLeaf = {
    id: `b${nextLeafNumber}`,
    depth: 0,
    box: root,
    interval: rootResult.interval,
    affine: rootResult.affine,
    width: intervalWidth(rootResult.interval),
  };
  nextLeafNumber += 1;

  let leaves = [rootLeaf];
  const splitEvents = [];
  let evaluations = 1;
  const stopTolerance = 1e-11;

  while (leaves.length < maxLeaves) {
    let selectedIndex = -1;
    let selected = null;
    for (let i = 0; i < leaves.length; i += 1) {
      if (!selected || leaves[i].width > selected.width) {
        selected = leaves[i];
        selectedIndex = i;
      }
    }
    if (!selected || selected.width <= stopTolerance * Math.max(1, Math.abs(selected.interval.lo), Math.abs(selected.interval.hi))) {
      break;
    }

    const split = pickSplitDimension(compiled, ast, selected, formulaAsts);
    if (!split || !split.dimension) break;
    evaluations += split.trials || 0;

    let leftResult = split.leftResult;
    let rightResult = split.rightResult;
    if (!leftResult || !rightResult) {
      leftResult = evaluateCorrelatedBox(compiled, ast, split.leftBox, null, formulaAsts);
      rightResult = evaluateCorrelatedBox(compiled, ast, split.rightBox, null, formulaAsts);
      evaluations += 2;
    }

    const leftInterval = leftResult.interval;
    const rightInterval = rightResult.interval;
    const leftAffine = leftResult.affine;
    const rightAffine = rightResult.affine;

    const leftLeaf = {
      id: `b${nextLeafNumber}`,
      parentId: selected.id,
      depth: selected.depth + 1,
      box: split.leftBox,
      interval: leftInterval,
      affine: leftAffine,
      width: intervalWidth(leftInterval),
      splitDimension: split.dimension.key,
    };
    nextLeafNumber += 1;
    const rightLeaf = {
      id: `b${nextLeafNumber}`,
      parentId: selected.id,
      depth: selected.depth + 1,
      box: split.rightBox,
      interval: rightInterval,
      affine: rightAffine,
      width: intervalWidth(rightInterval),
      splitDimension: split.dimension.key,
    };
    nextLeafNumber += 1;

    splitEvents.push({
      parentId: selected.id,
      dimensionKey: split.dimension.key,
      dimensionSymbol: split.dimension.symbol,
      at: split.at,
      childIds: [leftLeaf.id, rightLeaf.id],
      parentWidth: selected.width,
      childWidths: [leftLeaf.width, rightLeaf.width],
    });

    leaves = [...leaves.slice(0, selectedIndex), ...leaves.slice(selectedIndex + 1), leftLeaf, rightLeaf];
  }

  // Leaf intervals are already outward guarded. Min/max preserves that union
  // without adding a second guard that would obscure an exact [0,0] result.
  const lo = Math.min(...leaves.map((leaf) => leaf.interval.lo));
  const hi = Math.max(...leaves.map((leaf) => leaf.interval.hi));

  const serializableLeaves = leaves.map((leaf) => ({
    id: leaf.id,
    parentId: leaf.parentId || null,
    depth: leaf.depth,
    splitDimension: leaf.splitDimension || null,
    box: compiled.dimensions.map((d) => ({
      key: d.key,
      symbol: d.symbol,
      lo: leaf.box[d.key].lo,
      hi: leaf.box[d.key].hi,
    })),
    lo: leaf.interval.lo,
    hi: leaf.interval.hi,
    width: leaf.width,
  }));

  return {
    status: 'ok',
    method: 'affine-dependency-plus-adaptive-subdivision',
    certified: { lo, hi },
    rootCertified: rootResult.interval,
    width: hi - lo,
    rootWidth: rootResult.width,
    normalizedExpression: normalized.expression,
    cancellations: normalized.cancellations,
    ledger: combinedLedger,
    splitEvents,
    leaves: serializableLeaves,
    subdivision: {
      adaptive: true,
      budget: maxLeaves,
      leaves: leaves.length,
      splits: splitEvents.length,
      evaluations,
      stoppedEarly: leaves.length < maxLeaves,
      stopTolerance,
    },
  };
}

function halton(index, base) {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += fraction * (i % base);
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

function deterministicSamples(
  compiled,
  certified,
  count = 96,
  sampleAst = compiled.targetAst,
  formulaAsts = compiled.formulaAsts,
) {
  const valuesList = [];
  const dimensions = compiled.dimensions;

  function addSample(values) {
    for (const existing of valuesList) {
      if (dimensions.every((d) => existing[d.key] === values[d.key])) return;
    }
    valuesList.push(values);
  }

  // Midpoint.
  addSample(Object.fromEntries(dimensions.map((d) => [d.key, (d.lo + d.hi) / 2])));

  // All corners for low-dimensional boxes.
  if (dimensions.length > 0 && dimensions.length <= 4) {
    const cornerCount = 2 ** dimensions.length;
    for (let mask = 0; mask < cornerCount; mask += 1) {
      const values = {};
      dimensions.forEach((d, i) => {
        values[d.key] = (mask >> i) & 1 ? d.hi : d.lo;
      });
      addSample(values);
    }
  }

  // Halton deterministic quasi-random points. These are feasible observations,
  // never strict extremum bounds.
  const primes = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29];
  for (let i = 1; i <= count; i += 1) {
    const values = {};
    dimensions.forEach((d, dimIndex) => {
      const u = halton(i + dimIndex * 17, primes[dimIndex % primes.length]);
      values[d.key] = d.lo + u * (d.hi - d.lo);
    });
    addSample(values);
  }

  const points = [];
  for (const values of valuesList) {
    try {
      const env = buildPointEnvironment(compiled, values, formulaAsts);
      const output = evaluatePoint(sampleAst, env);
      if (Number.isFinite(output)) {
        // Guard the sampled point with singleton interval evaluation. Unlike a
        // fixed ulp allowance, this accumulates outward rounding through the
        // actual normalized operation chain. Also include the direct scalar in
        // case two equivalent evaluation orders differ by a final ulp.
        let envelope = { lo: output, hi: output };
        try {
          const singletonEnv = buildSingletonIntervalEnvironment(
            compiled,
            values,
            formulaAsts,
          );
          envelope = evaluateInterval(sampleAst, singletonEnv);
        } catch {
          // The direct point value is still displayable; use a conservative
          // fixed guard if singleton interval evaluation is unavailable.
          envelope = {
            lo: outwardLow(output, 64),
            hi: outwardHigh(output, 64),
          };
        }
        const outputLo = outwardLow(Math.min(output, envelope.lo), 8);
        const outputHi = outwardHigh(Math.max(output, envelope.hi), 8);
        points.push({ values: { ...values }, output, outputLo, outputHi });
      }
    } catch {
      // A sample that hits an endpoint domain is omitted; preflight uses outward intervals.
    }
  }

  if (!points.length) {
    return {
      pointsEvaluated: 0,
      observed: null,
      points: [],
      statement: '没有得到可行采样点；采样不参与严格界证明。',
    };
  }

  let lo = Infinity;
  let hi = -Infinity;
  let minimumUpper = Infinity;
  let maximumLower = -Infinity;
  for (const p of points) {
    lo = Math.min(lo, p.output);
    hi = Math.max(hi, p.output);
    minimumUpper = Math.min(minimumUpper, p.outputHi);
    maximumLower = Math.max(maximumLower, p.outputLo);
  }

  return {
    pointsEvaluated: points.length,
    method: 'midpoint/corners/Halton deterministic sequence; normalized AST; singleton-interval point enclosures',
    observed: {
      lo,
      hi,
      minimumUpper,
      maximumLower,
      text: formatInterval({ lo, hi }),
    },
    points: points.slice(0, 200),
    statement:
      '采样值只证明存在某个可行输出，不能作为最大值或严格上界；严格界来自区间/仿射包络与细分盒并集。',
  };
}

function buildProof(modeResult, observed) {
  if (modeResult.status !== 'ok') return null;
  const c = modeResult.certified;
  // Point evaluation is Float64-order dependent. Each sampled scalar therefore
  // carries a small outward enclosure; use those rigorous one-sided endpoints
  // for proof brackets instead of treating raw sample extrema as exact.
  const minimumUpper = observed?.minimumUpper ?? observed?.lo ?? null;
  const maximumLower = observed?.maximumLower ?? observed?.hi ?? null;
  const lowerSlack = minimumUpper === null ? null : minimumUpper - c.lo;
  const upperSlack = maximumLower === null ? null : c.hi - maximumLower;
  return {
    certifiedRange: { ...c, text: formatInterval(c) },
    observedRange: observed ? { ...observed, text: formatInterval(observed) } : null,
    minimumBracket: observed
      ? { provenLower: c.lo, observedUpper: minimumUpper }
      : null,
    maximumBracket: observed
      ? { observedLower: maximumLower, provenUpper: c.hi }
      : null,
    lowerCertificateGap: lowerSlack,
    upperCertificateGap: upperSlack,
    statement: observed
      ? `已证实所有可能值均落在 ${formatInterval(c)}。确定性采样的原始显示区间为 ${formatInterval(
          observed,
        )}，每个采样值另带 Float64 外向保护；真实最小值位于 [${formatNumber(
          c.lo,
        )}, ${formatNumber(minimumUpper)}]，真实最大值位于 [${formatNumber(
          maximumLower,
        )}, ${formatNumber(c.hi)}]。下界证书间隙 ${formatNumber(
          lowerSlack,
        )}、上界证书间隙 ${formatNumber(upperSlack)} 是尚存松弛的上界，采样本身不是严格界。`
      : `已证实所有可能值均落在 ${formatInterval(c)}；暂无采样 bracket。`,
  };
}

function formatNumber(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  return Number(x.toPrecision(8)).toString();
}

export function analyzeModel(rawConfig, options = {}) {
  const compiled = compileModel(rawConfig);
  const requestedBudget = Math.floor(
    Number(options.budget ?? options.maxLeaves ?? 64),
  );
  const budget = Math.max(
    1,
    Math.min(MAX_BUDGET, Number.isFinite(requestedBudget) ? requestedBudget : 64),
  );
  const requestedSampleCount = Math.floor(Number(options.sampleCount ?? 96));
  const sampleCount = Math.max(
    0,
    Math.min(512, Number.isFinite(requestedSampleCount) ? requestedSampleCount : 96),
  );

  // Correlated preflight is the physically meaningful domain gate. It uses the
  // original AST so cancellation rewrites cannot erase a forbidden denominator.
  const preflightBox = rootBox(compiled);
  let preflightOrdinaryEnv = null;
  try {
    preflightOrdinaryEnv = buildIntervalEnvironment(
      compiled,
      preflightBox,
      compiled.formulaAsts,
    );
  } catch {
    // Classic intervals can fail on dependency cancellation. The affine pass on
    // the original AST remains the authoritative correlated domain preflight.
    preflightOrdinaryEnv = null;
  }
  try {
    evaluateCorrelatedBox(
      compiled,
      compiled.targetAst,
      preflightBox,
      null,
      compiled.formulaAsts,
      null,
      preflightOrdinaryEnv,
    );
  } catch (error) {
    error.details = {
      ...(error.details || {}),
      graph: compiled.graph,
      phase: 'target-domain-preflight',
    };
    throw error;
  }

  const normalized = simplifyAst(compiled.targetAst);
  const correlatedFormulaAsts = { ...compiled.formulaAsts };
  const formulaNormalizations = [];
  for (const name of compiled.order) {
    if (!compiled.formulaAsts[name]) continue;
    const formulaNormalized = simplifyAst(compiled.formulaAsts[name]);
    correlatedFormulaAsts[name] = formulaNormalized.ast;
    formulaNormalizations.push({
      name,
      original: compiled.config.inputs.find((x) => x.name === name)?.formula || '',
      normalized: formulaNormalized.expression,
      changed: formulaNormalized.changed,
      cancellations: formulaNormalized.cancellations,
    });
  }

  const ordinary = runOrdinary(compiled);
  const correlated = runCorrelated(compiled, normalized, budget, correlatedFormulaAsts);

  const samples = deterministicSamples(
    compiled,
    correlated.certified,
    sampleCount,
    normalized.ast,
    correlatedFormulaAsts,
  );
  ordinary.proof = buildProof(ordinary, samples.observed);
  correlated.proof = buildProof(correlated, samples.observed);

  let comparison = null;
  if (ordinary.status === 'ok' && correlated.status === 'ok') {
    const ordinaryWidth = ordinary.width;
    const correlatedWidth = correlated.width;
    const absoluteReduction = ordinaryWidth - correlatedWidth;
    const relativeReduction =
      ordinaryWidth > 1e-14 * Math.max(1, Math.abs(ordinary.certified.lo), Math.abs(ordinary.certified.hi))
        ? absoluteReduction / ordinaryWidth
        : 0;
    comparison = {
      ordinaryWidth,
      correlatedWidth,
      absoluteReduction,
      relativeReduction,
      widthRatio: ordinaryWidth === 0 ? 1 : correlatedWidth / ordinaryWidth,
      tighterMode: correlatedWidth < ordinaryWidth - 1e-12 ? 'correlated' : 'tie',
      exactDependencyCancellation:
        correlatedWidth <= 1e-10 * Math.max(1, Math.abs(correlated.certified.lo), Math.abs(correlated.certified.hi)),
    };
  }

  return {
    ok: true,
    schemaVersion: 'credible-range-job/v1',
    options: {
      budget,
      budgetLocked: options.budgetLocked !== false,
      sampleCount,
      modes: ['ordinary', 'correlated'],
    },
    expression: {
      original: compiled.config.expression,
      originalAst: compiled.targetAst,
      normalized: normalized.expression,
      normalizedAst: normalized.ast,
      changed: normalized.changed,
      cancellations: normalized.cancellations,
      formulas: formulaNormalizations,
    },
    inputSummary: compiled.config.inputs.map((x) => ({ ...x })),
    sourceSummary: compiled.config.sources.map((x) => ({ ...x })),
    dimensions: compiled.dimensions,
    metricIntervals: compiled.metricIntervals,
    dependencyGraph: compiled.graph,
    ordinary,
    correlated,
    samples,
    comparison,
  };
}
