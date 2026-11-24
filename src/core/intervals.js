// Rigorous-ish interval primitives with outward rounding.
// The bounds returned by this module are intentionally widened by several
// adjacent Float64 units so ordinary correctly-rounded arithmetic and small
// libm errors do not turn a numerical rounding artifact into an under-bound.

import { AnalysisError, DomainAnalysisError } from './errors.js';

const f64Buffer = new ArrayBuffer(8);
const f64View = new Float64Array(f64Buffer);
const u64View = new BigUint64Array(f64Buffer);

export function nextUp(x) {
  if (Number.isNaN(x)) return x;
  if (x === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (x === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE;
  if (x === 0) return Number.MIN_VALUE;
  f64View[0] = x;
  let bits = u64View[0];
  if (x > 0) bits += 1n;
  else bits -= 1n;
  u64View[0] = bits;
  return f64View[0];
}

export function nextDown(x) {
  if (Number.isNaN(x)) return x;
  if (x === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
  if (x === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
  return -nextUp(-x);
}

const GUARD_ULPS = 4;

export function outwardLow(x, guard = GUARD_ULPS) {
  if (!Number.isFinite(x)) return x;
  // Exact zero is retained as a domain boundary; see cleanInterval().
  if (x === 0) return 0;
  let y = x;
  for (let i = 0; i < guard; i += 1) y = nextDown(y);
  return y;
}

export function outwardHigh(x, guard = GUARD_ULPS) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  let y = x;
  for (let i = 0; i < guard; i += 1) y = nextUp(y);
  return y;
}

/** Estimated conservative floating-point noise for a magnitude. */
export function roundingNoise(...magnitudes) {
  let m = 0;
  for (const x of magnitudes) m += Math.abs(x || 0);
  // A few EPSILON multiples cover operation, libm and bookkeeping rounding.
  return 16 * Number.EPSILON * m;
}

export function makeInterval(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new AnalysisError('INVALID_INTERVAL', '区间端点必须是有限数字', { lo, hi });
  }
  if (lo > hi) {
    throw new AnalysisError('INVALID_INTERVAL', '区间下界不能大于上界', { lo, hi });
  }
  return { lo, hi };
}

export function cleanInterval(lo, hi) {
  // Exact zero is a valid certified endpoint for identities such as x - x.
  if (lo === 0 && hi === 0) return { lo: 0, hi: 0 };
  return { lo: outwardLow(lo), hi: outwardHigh(hi) };
}

export function width(iv) {
  return iv.hi - iv.lo;
}

export function containsZero(iv) {
  return iv.lo <= 0 && iv.hi >= 0;
}

export function assertDivisorDomain(divisor, context = {}) {
  if (containsZero(divisor)) {
    throw new DomainAnalysisError(
      'DOMAIN_DIV_ZERO',
      `除数区间 [${formatNumber(divisor.lo)}, ${formatNumber(divisor.hi)}] 包含 0，已在求界前阻断`,
      { divisor, ...context },
    );
  }
}

export function assertLogDomain(arg, context = {}) {
  if (arg.lo <= 0) {
    throw new DomainAnalysisError(
      'DOMAIN_LOG',
      `log 的参数区间下界为 ${formatNumber(arg.lo)} ≤ 0；对数域要求整个区间严格大于 0，已阻断`,
      { argument: arg, ...context },
    );
  }
}

export function assertSqrtDomain(arg, context = {}) {
  if (arg.lo < 0) {
    throw new DomainAnalysisError(
      'DOMAIN_SQRT',
      `sqrt 的参数区间下界为 ${formatNumber(arg.lo)} < 0；实数平方根域要求非负，已阻断`,
      { argument: arg, ...context },
    );
  }
  return arg;
}

export function addIv(a, b) {
  return cleanInterval(a.lo + b.lo, a.hi + b.hi);
}

export function subIv(a, b) {
  return cleanInterval(a.lo - b.hi, a.hi - b.lo);
}

export function negIv(a) {
  return cleanInterval(-a.hi, -a.lo);
}

export function mulIv(a, b) {
  const products = [
    a.lo * b.lo,
    a.lo * b.hi,
    a.hi * b.lo,
    a.hi * b.hi,
  ];
  let result = cleanInterval(Math.min(...products), Math.max(...products));

  // Positive sub-Float64 products (e.g. 1e-200 * 1e-200) can underflow to
  // exact zero. Zero is then a valid lower bound but not a valid upper bound
  // for a positive product. Add one smallest-subnormal-scale enclosure while
  // preserving a provable fixed sign.
  if (result.lo === 0 && result.hi === 0) {
    const underflowRadius = 4 * Number.MIN_VALUE;
    const nonnegative =
      (a.lo >= 0 && b.lo >= 0) || (a.hi <= 0 && b.hi <= 0);
    const nonpositive =
      (a.lo >= 0 && b.hi <= 0) || (a.hi <= 0 && b.lo >= 0);
    if (nonnegative) {
      result = cleanInterval(0, underflowRadius);
    } else if (nonpositive) {
      result = cleanInterval(-underflowRadius, 0);
    } else {
      result = cleanInterval(-underflowRadius, underflowRadius);
    }
  }
  return result;
}

export function recipIv(a) {
  assertDivisorDomain(a, { operation: 'reciprocal' });
  // Endpoint order is valid only after zero is excluded.
  return cleanInterval(1 / a.hi, 1 / a.lo);
}

export function divIv(a, b) {
  assertDivisorDomain(b, { operation: '/' });
  return mulIv(a, recipIv(b));
}

export function absIv(a) {
  if (a.lo >= 0) return cleanInterval(a.lo, a.hi);
  if (a.hi <= 0) return cleanInterval(-a.hi, -a.lo);
  return cleanInterval(0, Math.max(-a.lo, a.hi));
}

export function expIv(a) {
  return cleanInterval(Math.exp(a.lo), Math.exp(a.hi));
}

export function logIv(a) {
  assertLogDomain(a);
  return cleanInterval(Math.log(a.lo), Math.log(a.hi));
}

export function sqrtIv(a) {
  const safe = assertSqrtDomain(a);
  return cleanInterval(Math.sqrt(Math.max(0, safe.lo)), Math.sqrt(safe.hi));
}

export function intervalContains(outer, inner) {
  return outer.lo <= inner.lo && outer.hi >= inner.hi;
}

export function formatNumber(x, digits = 6) {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (!Number.isFinite(x)) return x > 0 ? '+∞' : '-∞';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  const abs = Math.abs(x);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-5)) {
    return x.toExponential(3).replace('e+', 'e');
  }
  // Keep enough precision but avoid noisy long floats in the UI.
  const rounded = Number(x.toPrecision(digits + 2));
  return String(rounded);
}

export function formatInterval(iv, digits = 6) {
  return `[${formatNumber(iv.lo, digits)}, ${formatNumber(iv.hi, digits)}]`;
}
