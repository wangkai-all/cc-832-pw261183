import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/app.js';
import { ProjectStore } from '../src/server/store.js';
import { MAX_BUDGET } from '../src/core/analyzer.js';

async function startedServer() {
  const server = createServer({ store: new ProjectStore() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, base: `http://127.0.0.1:${port}` };
}

test('bootstrap exposes draft and parseable samples', async () => {
  const { server, base } = await startedServer();
  try {
    const res = await fetch(`${base}/api/bootstrap`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.project.draft.expression.includes('y'));
    assert.ok(body.samples.find((s) => s.id === 'mul-div-correlation'));
  } finally {
    server.close();
  }
});

test('job API stores complete result and export formats', async () => {
  const { server, base } = await startedServer();
  try {
    const payload = {
      sources: [],
      inputs: [{ name: 'x', lo: 0.95, hi: 1.05 }],
      expression: 'x - x',
      budget: 8,
      budgetLocked: true,
    };
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    const job = body.job;
    assert.equal(job.status, 'completed');
    assert.equal(job.result.correlated.certified.lo, 0);
    assert.equal(job.result.dependencyGraph.stats.nodeCount > 2, true);

    const getRes = await fetch(`${base}/api/jobs/${job.id}`);
    const got = (await getRes.json()).job;
    assert.equal(got.options.budgetLocked, true);
    assert.equal(got.result.schemaVersion, 'credible-range-job/v1');

    for (const [format, fragment] of [
      ['json', 'credible-range-job/v1'],
      ['ledger.csv', 'widthGrowth'],
      ['boxes.csv', 'leafId'],
      ['md', '指标可信范围分析任务'],
    ]) {
      const exportRes = await fetch(`${base}/api/jobs/${job.id}/export?format=${format}`);
      assert.equal(exportRes.status, 200);
      const text = await exportRes.text();
      assert.ok(text.includes(fragment), `${format} missing ${fragment}`);
    }
  } finally {
    server.close();
  }
});

test('blocked domain job is persisted with graph and no completed bound', async () => {
  const { server, base } = await startedServer();
  try {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: [],
        inputs: [{ name: 'x', lo: -0.2, hi: 1 }],
        expression: 'log(x)',
        budget: 8,
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.job.status, 'blocked');
    assert.equal(body.job.error.code, 'DOMAIN_LOG');
    assert.equal(body.job.result, null);

    const graphRes = await fetch(`${base}/api/jobs/${body.job.id}/dependency-graph`);
    const graphBody = await graphRes.json();
    assert.ok(graphBody.graph.nodes.some((n) => n.kind === 'output'));
  } finally {
    server.close();
  }
});

test('calculation snapshots are not overwritten by newer project config', async () => {
  const store = new ProjectStore();
  const oldJob = store.createJob({
    sources: [],
    inputs: [{ name: 'x', lo: 0, hi: 1 }],
    expression: 'x - x',
    budget: 4,
  });
  assert.equal(oldJob.result.correlated.certified.hi, 0);
  const oldExpressionVersion = oldJob.expressionVersion.id;
  const oldInputVersion = oldJob.inputVersion.id;

  store.saveDraft({
    sources: [],
    inputs: [{ name: 'x', lo: -10, hi: 10 }],
    expression: 'x + x',
  });

  const refetched = store.getJob(oldJob.id);
  assert.equal(refetched.expressionVersion.id, oldExpressionVersion);
  assert.equal(refetched.inputVersion.id, oldInputVersion);
  assert.equal(refetched.expressionVersion.expression, 'x - x');
  assert.deepEqual(refetched.inputVersion.inputs[0], { name: 'x', lo: 0, hi: 1 });
  assert.equal(refetched.result.correlated.certified.hi, 0);
  assert.equal(store.project.draft.expression, 'x + x');
  assert.notEqual(store.project.currentExpressionVersionId, oldExpressionVersion);
});

test('ad-hoc job POST does not save draft; explicit PUT creates current version', async () => {
  const { server, base } = await startedServer();
  try {
    const beforeRes = await fetch(`${base}/api/project`);
    const before = (await beforeRes.json()).project;

    const jobRes = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: [],
        inputs: [{ name: 'x', lo: 0, hi: 1 }],
        expression: 'x - x',
        budget: 1,
      }),
    });
    assert.equal(jobRes.status, 201);

    const afterJobRes = await fetch(`${base}/api/project`);
    const afterJob = (await afterJobRes.json()).project;
    assert.equal(afterJob.currentExpressionVersionId, before.currentExpressionVersionId);
    assert.equal(afterJob.currentInputVersionId, before.currentInputVersionId);
    assert.equal(afterJob.draft.expression, before.draft.expression);

    const putRes = await fetch(`${base}/api/project`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sources: [],
        inputs: [{ name: 'x', lo: 2, hi: 5 }],
        expression: '2 * x',
      }),
    });
    assert.equal(putRes.status, 200);
    const saved = (await putRes.json()).project;
    assert.equal(saved.draft.expression, '2 * x');
    assert.notEqual(saved.currentExpressionVersionId, before.currentExpressionVersionId);
    assert.notEqual(saved.currentInputVersionId, before.currentInputVersionId);

    const fetchedRes = await fetch(`${base}/api/project`);
    const fetched = (await fetchedRes.json()).project;
    assert.equal(fetched.draft.expression, '2 * x');
    assert.equal(fetched.currentExpressionVersionId, saved.currentExpressionVersionId);
  } finally {
    server.close();
  }
});

test('job budget and sample count are clamped into frozen safe limits', () => {
  const store = new ProjectStore();
  const job = store.createJob({
    sources: [],
    inputs: [{ name: 'x', lo: 1, hi: 2 }],
    expression: 'x',
    budget: 999999,
    sampleCount: 999999,
  });

  assert.equal(job.options.budget, MAX_BUDGET);
  assert.equal(MAX_BUDGET, 2048);
  assert.equal(job.options.sampleCount, 512);
  assert.equal(job.status, 'completed');
});

test('explicit zero budget is normalized to the minimum one leaf', () => {
  const store = new ProjectStore();
  const job = store.createJob({
    sources: [],
    inputs: [{ name: 'x', lo: 1, hi: 2 }],
    expression: 'x',
    budget: 0,
  });

  assert.equal(job.options.budget, 1);
});

test('saved versions, returned jobs, and fetched jobs are defensively isolated', () => {
  const store = new ProjectStore();
  const payload = {
    sources: [{ id: 's1', name: 's', lo: 1, hi: 2 }],
    inputs: [{ name: 'x', source: 's1', lo: 1, hi: 2 }],
    expression: 'x',
  };
  store.saveDraft(payload);
  const created = store.createJob({ ...structuredClone(payload), budget: 3 });

  payload.sources[0].lo = -999;
  payload.inputs[0].hi = 999;

  const inputVersion = store.inputVersions.get(store.project.currentInputVersionId);
  assert.equal(inputVersion.sources[0].lo, 1);
  assert.equal(inputVersion.inputs[0].hi, 2);

  assert.equal(created.options.budget, 3);
  created.options.budget = 999;
  created.configSnapshot.inputs[0].hi = -1;

  const firstFetch = store.getJob(created.id);
  assert.equal(firstFetch.options.budget, 3);
  assert.equal(firstFetch.configSnapshot.inputs[0].hi, 2);

  firstFetch.options.budget = 123;
  const originalCertifiedHi = firstFetch.result.correlated.certified.hi;
  firstFetch.result.correlated.certified.hi = 0;

  const secondFetch = store.getJob(created.id);
  assert.equal(secondFetch.options.budget, 3);
  assert.equal(secondFetch.result.correlated.certified.hi, originalCertifiedHi);
  assert.notEqual(firstFetch, secondFetch);
});

test('malformed JSON requests return a stable 400 error', async () => {
  const { server, base } = await startedServer();
  try {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_JSON');
  } finally {
    server.close();
  }
});
