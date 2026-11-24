import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeModel } from '../src/core/analyzer.js';
import { parseExpression, collectVariables } from '../src/core/parser.js';
import { simplifyAst } from '../src/core/simplify.js';
import { SAMPLES } from '../src/core/samples.js';

function sampleConfig(id) {
  return structuredClone(SAMPLES.find((s) => s.id === id).config);
}

test('parser handles arithmetic, functions and variables', () => {
  const ast = parseExpression('log(x) + 2*(y - 1)/x^2');
  assert.equal(ast.kind, 'binary');
  const vars = collectVariables(ast);
  assert.deepEqual(vars, ['x', 'y']);
});

test('ordinary interval mode deliberately widens x - x', () => {
  const result = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: -1, hi: 1 }], expression: 'x - x' },
    { budget: 1 },
  );
  assert.ok(result.ordinary.certified.lo < -1.9);
  assert.ok(result.ordinary.certified.hi > 1.9);
  assert.equal(result.correlated.certified.lo, 0);
  assert.equal(result.correlated.certified.hi, 0);
  assert.equal(result.comparison.exactDependencyCancellation, true);
});

test('common source dependency returns exact zero for y - 2*x', () => {
  const result = analyzeModel(sampleConfig('common-source-cancellation'), { budget: 8 });
  assert.equal(result.correlated.certified.lo, 0);
  assert.equal(result.correlated.certified.hi, 0);
  assert.ok(result.ordinary.certified.lo < -0.19);
  assert.ok(result.ordinary.certified.hi > 0.19);
  assert.ok(result.dependencyGraph.stats.nodeCount > 5);
  assert.ok(result.dependencyGraph.edges.some((e) => e.from === 'source:r'));
});

test('additive simplifier resolves parseable cancellation', () => {
  const simplified = simplifyAst(parseExpression('a + b - a'));
  assert.equal(simplified.expression, 'b');
  assert.ok(simplified.cancellations.some((c) => c.type === 'additive' && c.expression === 'a'));
});

test('multiplicative dependency sample a*b/a returns b range', () => {
  const result = analyzeModel(sampleConfig('mul-div-correlation'), { budget: 8 });
  assert.equal(result.expression.normalized, 'b');
  assert.ok(result.expression.cancellations.some((c) => c.type === 'multiplicative' && c.expression === 'a'));
  assert.ok(Math.abs(result.correlated.certified.lo - 3) < 1e-9);
  assert.ok(Math.abs(result.correlated.certified.hi - 6) < 1e-9);
  assert.ok(result.ordinary.certified.lo <= 1.5 + 1e-9);
  assert.ok(result.ordinary.certified.hi >= 12 - 1e-9);
});

test('x/x is exactly one only after zero-domain preflight passes', () => {
  const safe = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: 1, hi: 2 }], expression: 'x / x' },
    { budget: 1 },
  );
  assert.ok(safe.correlated.certified.lo <= 1);
  assert.ok(safe.correlated.certified.hi >= 1);
  assert.ok(safe.correlated.certified.hi - safe.correlated.certified.lo < 1e-14);

  assert.throws(
    () => analyzeModel(
      { sources: [], inputs: [{ name: 'x', lo: -1, hi: 1 }], expression: 'x / x' },
      { budget: 1 },
    ),
    (error) => error.code === 'DOMAIN_DIV_ZERO',
  );
});

test('divisor crossing zero is blocked before bounding', () => {
  assert.throws(
    () => analyzeModel(sampleConfig('divisor-zero-conflict'), { budget: 16 }),
    (error) => {
      assert.equal(error.code, 'DOMAIN_DIV_ZERO');
      assert.ok(error.details.divisor.lo <= 0);
      assert.ok(error.details.divisor.hi >= 0);
      return true;
    },
  );
});

test('illegal log domain is blocked before bounding', () => {
  assert.throws(
    () => analyzeModel(sampleConfig('log-domain-conflict'), { budget: 16 }),
    (error) => error.code === 'DOMAIN_LOG',
  );
});

test('metric formula cycles are blocked and include cycle path', () => {
  assert.throws(
    () => analyzeModel(sampleConfig('cycle-conflict'), { budget: 16 }),
    (error) => {
      assert.equal(error.code, 'CYCLE');
      assert.deepEqual(error.details.cycle, ['a', 'b', 'a']);
      assert.ok(error.details.graph);
      return true;
    },
  );
});

test('self-referential metric formula is also blocked as a cycle', () => {
  assert.throws(
    () => analyzeModel({
      sources: [],
      inputs: [{ name: 'a', formula: 'a + 1' }],
      expression: 'a',
    }),
    (error) => error.code === 'CYCLE' && error.details.cycle.includes('a'),
  );
});

test('absolute value envelope preserves positive range for negative input range', () => {
  const result = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: 0.25, hi: 0.25 }], expression: 'abs(log(x))' },
    { budget: 1, sampleCount: 0 },
  );
  assert.ok(result.correlated.certified.lo > 1.3);
  assert.ok(result.correlated.certified.hi >= Math.log(4));
});

test('ordinary interval false domain positives can be rescued by dependency form', () => {
  const result = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: -1, hi: 1 }], expression: 'sqrt(x*x)' },
    { budget: 32, sampleCount: 0 },
  );
  assert.equal(result.ordinary.status, 'domain-blocked');
  assert.ok(result.correlated.certified.lo <= 0);
  assert.ok(result.correlated.certified.hi >= 1);
});

test('substantive negative sqrt domain is blocked before bounding', () => {
  assert.throws(
    () => analyzeModel(
      { sources: [], inputs: [{ name: 'x', lo: -1e-10, hi: 1 }], expression: 'sqrt(x)' },
      { budget: 1 },
    ),
    (error) => error.code === 'DOMAIN_SQRT',
  );
});

test('sample proof brackets use ulp-guarded one-sided endpoints', () => {
  const result = analyzeModel(
    {
      sources: [
        { id: 'r', name: 'r', lo: 0.4, hi: 2.2 },
        { id: 's', name: 's', lo: 0.3, hi: 1.8 },
      ],
      inputs: [],
      expression: '(r * (s / (s * r)))',
    },
    { budget: 8, sampleCount: 64 },
  );

  assert.equal(result.expression.normalized, '1');
  assert.ok(result.correlated.certified.lo <= 1);
  assert.ok(result.correlated.certified.hi >= 1);
  assert.ok(result.correlated.certified.hi - result.correlated.certified.lo < 1e-14);
  assert.ok(result.samples.observed.minimumUpper >= 1);
  assert.ok(result.samples.observed.maximumLower <= 1);
  assert.ok(result.correlated.proof.lowerCertificateGap >= 0);
  assert.ok(result.correlated.proof.upperCertificateGap >= 0);
  for (const point of result.samples.points) {
    assert.ok(point.outputLo <= point.output);
    assert.ok(point.outputHi >= point.output);
  }
});

test('negative integer powers parse and retain reciprocal range', () => {
  const result = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: 1, hi: 2 }], expression: 'x^-2' },
    { budget: 16, sampleCount: 0 },
  );
  assert.ok(result.correlated.certified.lo <= 0.25);
  assert.ok(result.correlated.certified.hi >= 1);
  assert.ok(result.correlated.certified.lo > 0.2);
  assert.ok(result.correlated.certified.hi < 1.05);
});

test('zero-radius affine constants still guard Float64 evaluation order', () => {
  const result = analyzeModel(
    { sources: [], inputs: [], expression: '0.7^4' },
    { budget: 1, sampleCount: 4 },
  );
  const value = result.samples.points[0].output;
  assert.ok(value > 0.2400999999999999 && value < 0.2401000000000001);
  assert.ok(result.correlated.certified.lo <= value);
  assert.ok(result.correlated.certified.hi >= value);
});

test('underflowed positive products retain a positive certified upper guard', () => {
  const result = analyzeModel(
    {
      sources: [],
      inputs: [
        { name: 'x', lo: 1e-200, hi: 1e-200 },
        { name: 'y', lo: 1e-200, hi: 1e-200 },
      ],
      expression: 'x*y',
    },
    { budget: 1, sampleCount: 1 },
  );
  assert.ok(result.correlated.certified.hi > 0);
  assert.ok(result.correlated.certified.lo <= 0);
  assert.ok(result.samples.points[0].outputHi > 0);
  assert.ok(result.correlated.proof.lowerCertificateGap >= 0);
  assert.ok(result.correlated.proof.upperCertificateGap >= 0);
});

test('classic false domain in a metric formula does not kill correlated mode', () => {
  const result = analyzeModel(
    {
      sources: [],
      inputs: [
        { name: 'x', lo: -1, hi: 1 },
        { name: 'm', formula: 'sqrt(x*x)' },
      ],
      expression: 'm',
    },
    { budget: 4, sampleCount: 0 },
  );
  assert.equal(result.ordinary.status, 'domain-blocked');
  assert.equal(result.correlated.status, 'ok');
  assert.ok(result.correlated.certified.lo <= 0);
  assert.ok(result.correlated.certified.hi >= 1);
});

test('adaptive subdivision tightens nonlinear conservative envelope', () => {
  const lowBudget = analyzeModel(sampleConfig('nonlinear-subdivision'), { budget: 2 });
  const highBudget = analyzeModel(sampleConfig('nonlinear-subdivision'), { budget: 128 });

  assert.equal(lowBudget.correlated.subdivision.budget, 2);
  assert.ok(highBudget.correlated.subdivision.leaves >= 64);
  assert.ok(highBudget.correlated.width < lowBudget.correlated.width);
  assert.ok(highBudget.correlated.certified.lo <= -0.25);
  assert.ok(highBudget.correlated.certified.hi >= 0);
  assert.ok(highBudget.correlated.certified.lo > -0.255);
});

test('every deterministic sample lies inside certified bounds', () => {
  const expressions = [
    'x*x - x',
    'x*x*x - 2*x + 1',
    'exp(-x) + exp(x)',
    'log(x) * x + sqrt(x)',
    '(x + y) * (x - y) - x*x + y*y',
  ];
  const configs = [
    { sources: [], inputs: [{ name: 'x', lo: 0, hi: 1 }] },
    { sources: [], inputs: [{ name: 'x', lo: -1, hi: 1 }] },
    { sources: [], inputs: [{ name: 'x', lo: 1, hi: 2 }] },
    { sources: [], inputs: [{ name: 'x', lo: 0.5, hi: 2 }] },
    { sources: [], inputs: [{ name: 'x', lo: 1, hi: 3 }, { name: 'y', lo: 2, hi: 4 }] },
  ];

  expressions.forEach((expression, i) => {
    const result = analyzeModel({ ...configs[i], expression }, { budget: 64, sampleCount: 128 });
    for (const point of result.samples.points) {
      assert.ok(
        point.output >= result.correlated.certified.lo,
        `${expression}: sample ${point.output} below ${result.correlated.certified.lo}`,
      );
      assert.ok(
        point.output <= result.correlated.certified.hi,
        `${expression}: sample ${point.output} above ${result.correlated.certified.hi}`,
      );
    }
    assert.ok(result.samples.statement.includes('不能作为最大值') || result.samples.statement.includes('不是严格界'));
    assert.ok(result.correlated.proof.statement.includes('已证实'));
    assert.ok(result.correlated.proof.statement.includes('松弛'));
    assert.ok(result.correlated.proof.lowerCertificateGap >= 0);
    assert.ok(result.correlated.proof.upperCertificateGap >= 0);
    assert.ok(
      result.correlated.proof.minimumBracket.observedUpper >=
        result.correlated.proof.minimumBracket.provenLower,
    );
    assert.ok(
      result.correlated.proof.maximumBracket.observedLower <=
        result.correlated.proof.maximumBracket.provenUpper,
    );
  });
});

test('operation ledger identifies an expanding operation', () => {
  const result = analyzeModel(
    { sources: [], inputs: [{ name: 'x', lo: 1, hi: 2 }], expression: '10*x + x' },
    { budget: 1 },
  );
  assert.ok(result.ordinary.ledger.length >= 4);
  const top = result.ordinary.ledger.find((row) => row.isTopExpander);
  assert.ok(top);
  assert.ok(top.widthGrowth > 0);
});
