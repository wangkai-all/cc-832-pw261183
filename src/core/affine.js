// Affine forms preserve first-order dependency on shared source symbols.
// Nonlinear multiplication and monotone functions add a conservative residual
// radius; adaptive subdivision later shrinks that residual.

import { AnalysisError } from './errors.js';
import {
  absIv,
  addIv,
  assertDivisorDomain,
  assertLogDomain,
  assertSqrtDomain,
  cleanInterval,
  outwardHigh,
  outwardLow,
  roundingNoise,
} from './intervals.js';

export function constAffine(value) {
  return { c: value, t: Object.create(null), e: 0 };
}

export function residualAffine(iv) {
  const mid = (iv.lo + iv.hi) / 2;
  const radius = Math.max(iv.hi - mid, mid - iv.lo);
  return { c: mid, t: Object.create(null), e: Math.max(0, radius) };
}

export function affineFromInterval(iv) {
  const mid = (iv.lo + iv.hi) / 2;
  const radius = Math.max(iv.hi - mid, mid - iv.lo);
  const t = Object.create(null);
  // The coefficient itself is outward widened.
  t.__root__ = outwardHigh(radius);
  return { c: mid, t, e: 0 };
}

export function sourceAffine(key, iv) {
  const form = affineFromInterval(iv);
  const coeff = form.t.__root__;
  const t = Object.create(null);
  t[key] = coeff;
  return { c: form.c, t, e: form.e };
}

export function l1(a) {
  let sum = Math.abs(a.c) + a.e;
  for (const k of Object.keys(a.t)) sum += Math.abs(a.t[k]);
  return sum;
}

export function affineRange(a) {
  let radius = a.e;
  for (const k of Object.keys(a.t)) radius += Math.abs(a.t[k]);
  if (!Number.isFinite(a.c) || !Number.isFinite(radius)) {
    throw new AnalysisError('NUMERIC_OVERFLOW', '仿射包络数值溢出，请缩小输入区间或降低幂次');
  }
  // Do not return a raw singleton for radius zero: the affine constant may
  // have been formed by repeated multiplication while the point evaluator
  // uses a different Float64 operation order. cleanInterval supplies outward
  // ulp guards; its exact-zero special case preserves symbolic x-x => [0,0].
  return cleanInterval(a.c - radius, a.c + radius);
}

function withNoise(result, ..._magnitudes) {
  // Rounding reserve is added once when affineRange() materializes an
  // interval. Adding it to every intermediate residual would destroy exact
  // symbolic cancellations such as x - x.
  return result;
}

export function addAffine(a, b) {
  const t = Object.create(null);
  for (const k of new Set([...Object.keys(a.t), ...Object.keys(b.t)])) {
    t[k] = (a.t[k] || 0) + (b.t[k] || 0);
  }
  const c = a.c + b.c;
  const e = a.e + b.e;
  const result = { c, t, e };
  return withNoise(result, a.c, b.c, a.e, b.e, c, e);
}

export function subAffine(a, b) {
  const t = Object.create(null);
  for (const k of new Set([...Object.keys(a.t), ...Object.keys(b.t)])) {
    t[k] = (a.t[k] || 0) - (b.t[k] || 0);
  }
  const c = a.c - b.c;
  const e = a.e + b.e;
  const result = { c, t, e };
  return withNoise(result, a.c, b.c, a.e, b.e, c, e);
}

export function negAffine(a) {
  const t = Object.create(null);
  for (const k of Object.keys(a.t)) t[k] = -a.t[k];
  const result = { c: -a.c, t, e: a.e };
  return withNoise(result, a.c, l1(a));
}

export function scaleAffine(a, scalar) {
  const t = Object.create(null);
  for (const k of Object.keys(a.t)) t[k] = a.t[k] * scalar;
  const result = { c: a.c * scalar, t, e: a.e * Math.abs(scalar) };
  return withNoise(result, scalar, a.c, l1(a));
}

function isExactZeroAffine(a) {
  return a.c === 0 && a.e === 0 && Object.values(a.t).every((x) => x === 0);
}

function guardAffineUnderflow(result) {
  const allComponentsZero =
    result.c === 0 &&
    result.e === 0 &&
    Object.values(result.t).every((x) => x === 0);
  if (allComponentsZero) {
    // The operation was not an exact-zero form, so zero may be Float64
    // underflow rather than algebraic cancellation. One subnormal-scale
    // residual safely lifts the upper endpoint away from zero.
    result.e = 4 * Number.MIN_VALUE;
  }
  return result;
}

export function squareAffine(a) {
  if (isExactZeroAffine(a)) return constAffine(0);
  // Sound quadratic envelope for the SAME affine form. Write A = c + D with
  // |D| <= R = sum |t_k| + e. Then A^2 = c^2 + 2cD + D^2 and D^2 in [0, R^2].
  // Preserve the named 2c*t terms and center the quadratic remainder.
  const termRadius = Object.values(a.t).reduce((s, x) => s + Math.abs(x), 0);
  const residualRadius = a.e;
  const r = termRadius + residualRadius;
  const t = Object.create(null);
  for (const k of Object.keys(a.t)) t[k] = 2 * a.c * a.t[k];
  return guardAffineUnderflow({
    c: a.c * a.c + (r * r) / 2,
    t,
    e: 2 * Math.abs(a.c) * residualRadius + (r * r) / 2,
  });
}

export function mulAffine(a, b) {
  // An exact symbolic zero factor makes the whole product exactly zero.
  if (isExactZeroAffine(a) || isExactZeroAffine(b)) return constAffine(0);
  // A variable/metric evaluated twice returns the same form object. Squaring
  // that exact same form can retain nonnegativity that generic |δaδb| loses.
  if (a === b) return squareAffine(a);

  const radiusA = Object.values(a.t).reduce((s, x) => s + Math.abs(x), 0) + a.e;
  const radiusB = Object.values(b.t).reduce((s, x) => s + Math.abs(x), 0) + b.e;

  const t = Object.create(null);
  for (const k of new Set([...Object.keys(a.t), ...Object.keys(b.t)])) {
    t[k] = a.c * (b.t[k] || 0) + b.c * (a.t[k] || 0);
  }

  const c = a.c * b.c;
  // Sound coarse quadratic envelope: |δa δb| ≤ radiusA * radiusB.
  const e = Math.abs(a.c) * b.e + Math.abs(b.c) * a.e + radiusA * radiusB;
  const result = guardAffineUnderflow({ c, t, e });
  return withNoise(result, radiusA, radiusB, c, e, a.c, b.c);
}

function envelopeFromLine(a, alpha, beta, deviation) {
  const safeDeviation = Math.max(0, deviation) + roundingNoise(alpha, beta, deviation) * 4;
  const scaled = scaleAffine(a, alpha);
  const shifted = addAffine(scaled, constAffine(beta));
  shifted.e += safeDeviation;
  return shifted;
}

function narrowFunctionEnvelope(a, range, fn, center = a.c, safeRange = range) {
  // For a very narrow range, evaluating at the affine center and reserving the
  // larger endpoint-to-center distance is tighter and numerically safer than
  // forming a secant slope from nearly equal endpoints. The explicit guard also
  // covers libm rounding; affineRange() adds outward Float64 ulps.
  const c = fn(center);
  const fl = fn(safeRange.lo);
  const fh = fn(safeRange.hi);
  const endpointResidual = Math.max(Math.abs(fl - c), Math.abs(fh - c));
  const guard = 128 * Number.EPSILON *
    Math.max(1, Math.abs(c), Math.abs(fl), Math.abs(fh), Math.abs(range.lo), Math.abs(range.hi));
  return { c, t: Object.create(null), e: endpointResidual + guard };
}

export function recipAffine(a) {
  const range = affineRange(a);
  assertDivisorDomain(range, { operation: 'affine reciprocal' });

  if (range.hi < 0) {
    return negAffine(recipAffine(negAffine(a)));
  }

  const l = range.lo;
  const h = range.hi;
  if (!(l > 0)) {
    assertDivisorDomain(range, { operation: 'affine reciprocal' });
  }

  const alpha = -1 / (l * h);
  const chordBeta = 1 / l + 1 / h;
  const s = Math.sqrt(l * h);
  const deviation = chordBeta + alpha * s - 1 / s;
  const beta = chordBeta - Math.max(0, deviation) / 2;
  const guard = 32 * Number.EPSILON * (1 / l + 1 / h);
  return envelopeFromLine(a, alpha, beta, Math.max(0, deviation) / 2 + guard);
}

export function divAffine(a, b) {
  return mulAffine(a, recipAffine(b));
}

export function expAffine(a) {
  const r = affineRange(a);
  if (!Number.isFinite(r.lo) || !Number.isFinite(r.hi)) {
    throw new AnalysisError('NUMERIC_OVERFLOW', 'exp 输入包络溢出');
  }
  const l = r.lo;
  const h = r.hi;
  if (h - l < 8 * Number.EPSILON * Math.max(1, Math.abs(l), Math.abs(h))) {
    return narrowFunctionEnvelope(a, r, Math.exp);
  }

  const fl = Math.exp(l);
  const fh = Math.exp(h);
  const alpha = (fh - fl) / (h - l);
  let x = Math.log(alpha);
  x = Math.min(h, Math.max(l, x));
  const fx = Math.exp(x);
  const chordBeta = fl - alpha * l;
  const deviation = alpha * x + chordBeta - fx; // exp is convex: chord above f.
  const beta = chordBeta - Math.max(0, deviation) / 2;
  const guard = 32 * Number.EPSILON * (fl + fh + Math.abs(deviation));
  return envelopeFromLine(a, alpha, beta, Math.max(0, deviation) / 2 + guard);
}

export function logAffine(a) {
  const r = affineRange(a);
  assertLogDomain(r, { operation: 'log' });
  const l = r.lo;
  const h = r.hi;
  if (h - l < 8 * Number.EPSILON * Math.max(1, Math.abs(l), Math.abs(h))) {
    return narrowFunctionEnvelope(a, r, Math.log);
  }

  const fl = Math.log(l);
  const fh = Math.log(h);
  const alpha = (fh - fl) / (h - l);
  let x = 1 / alpha;
  x = Math.min(h, Math.max(l, x));
  const fx = Math.log(x);
  const chordBeta = fl - alpha * l;
  const deviation = fx - (alpha * x + chordBeta); // log is concave: f above chord.
  const beta = chordBeta + Math.max(0, deviation) / 2;
  const guard = 32 * Number.EPSILON * (Math.abs(fl) + Math.abs(fh) + Math.abs(deviation) + 1);
  return envelopeFromLine(a, alpha, beta, Math.max(0, deviation) / 2 + guard);
}

export function sqrtAffine(a) {
  const rawRange = affineRange(a);
  const r = assertSqrtDomain(rawRange, { operation: 'sqrt' });
  const l = Math.max(0, r.lo);
  const h = r.hi;
  if (h - l < 8 * Number.EPSILON * Math.max(1, h)) {
    return narrowFunctionEnvelope(
      a,
      rawRange,
      Math.sqrt,
      Math.max(0, a.c),
      { lo: l, hi: h },
    );
  }

  const fl = Math.sqrt(l);
  const fh = Math.sqrt(h);
  const alpha = (fh - fl) / (h - l);
  let x = 1 / (4 * alpha * alpha);
  x = Math.min(h, Math.max(l, x));
  const fx = Math.sqrt(x);
  const chordBeta = fl - alpha * l;
  const deviation = fx - (alpha * x + chordBeta); // sqrt is concave.
  const beta = chordBeta + Math.max(0, deviation) / 2;
  const guard = 32 * Number.EPSILON * (fl + fh + Math.abs(deviation) + 1);
  return envelopeFromLine(a, alpha, beta, Math.max(0, deviation) / 2 + guard);
}

export function absAffine(a) {
  const r = affineRange(a);
  // On a fixed-sign enclosure, abs is exactly sign-preserving and retaining the
  // affine terms is tighter than replacing the form by a coarse interval.
  if (r.lo >= 0) return a;
  if (r.hi <= 0) return negAffine(a);

  // The enclosure crosses zero. Globally replace it by the sound absolute-value
  // interval [0, max(-lo, hi)], centered and converted to a residual radius.
  const absoluteRange = absIv(r);
  const mid = (absoluteRange.lo + absoluteRange.hi) / 2;
  const radius =
    (absoluteRange.hi - absoluteRange.lo) / 2 +
    roundingNoise(absoluteRange.lo, absoluteRange.hi);
  const t = Object.create(null);
  return { c: mid, t, e: radius };
}

export function powIntegerAffine(a, exponent) {
  if (!Number.isInteger(exponent)) {
    throw new AnalysisError('UNSUPPORTED_POWER', '^ 目前只支持整数指数');
  }
  if (Math.abs(exponent) > 64) {
    throw new AnalysisError('UNSUPPORTED_POWER', '整数指数绝对值不能超过 64');
  }
  if (exponent < 0) return recipAffine(powIntegerAffine(a, -exponent));
  if (exponent === 0) return constAffine(1);

  let result = constAffine(1);
  let base = a;
  let n = exponent;
  while (n > 0) {
    if (n & 1) result = mulAffine(result, base);
    n >>= 1;
    if (n > 0) base = mulAffine(base, base);
  }
  return result;
}

// Re-exported for callers that want one import for range formatting.
export { addIv, outwardLow, outwardHigh };
