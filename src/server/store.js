// In-memory repository with immutable expression/input versions and jobs.
// Computing a job only writes the job record; it never replaces the editable
// current draft or any newer configuration.

import { randomUUID } from 'node:crypto';
import { analyzeModel, MAX_BUDGET } from '../core/analyzer.js';
import { DEFAULT_CONFIG } from '../core/samples.js';

function clone(value) {
  return structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

export class ProjectStore {
  constructor() {
    const initial = clone(DEFAULT_CONFIG);
    this.project = {
      id: 'default',
      name: '指标可信范围分析项目',
      draft: initial,
      currentExpressionVersionId: 'ev-1',
      currentInputVersionId: 'iv-1',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.expressionVersions = new Map();
    this.inputVersions = new Map();
    this.jobs = new Map();

    this.expressionVersions.set('ev-1', {
      id: 'ev-1',
      version: 1,
      expression: initial.expression,
      createdAt: this.project.createdAt,
      immutable: true,
    });
    this.inputVersions.set('iv-1', {
      id: 'iv-1',
      version: 1,
      sources: clone(initial.sources),
      inputs: clone(initial.inputs),
      createdAt: this.project.createdAt,
      immutable: true,
    });
  }

  bootstrap() {
    return {
      project: this.publicProject(),
      jobs: this.listJobs(),
    };
  }

  publicProject() {
    return {
      ...clone(this.project),
      expressionVersions: [...this.expressionVersions.values()].map((v) => ({
        id: v.id,
        version: v.version,
        expression: v.expression,
        createdAt: v.createdAt,
      })),
      inputVersions: [...this.inputVersions.values()].map((v) => ({
        id: v.id,
        version: v.version,
        createdAt: v.createdAt,
        sourceCount: v.sources.length,
        inputCount: v.inputs.length,
      })),
    };
  }

  saveDraft(config) {
    const next = {
      sources: Array.isArray(config.sources) ? clone(config.sources) : [],
      inputs: Array.isArray(config.inputs) ? clone(config.inputs || config.metrics) : [],
      expression: String(config.expression ?? ''),
    };

    const oldExpression = this.expressionVersions.get(this.project.currentExpressionVersionId);
    const oldInput = this.inputVersions.get(this.project.currentInputVersionId);
    const createdAt = nowIso();

    if (!oldExpression || oldExpression.expression !== next.expression) {
      const versionNumber = this.expressionVersions.size + 1;
      const id = `ev-${versionNumber}-${randomUUID().slice(0, 8)}`;
      this.expressionVersions.set(id, {
        id,
        version: versionNumber,
        expression: next.expression,
        createdAt,
        immutable: true,
      });
      this.project.currentExpressionVersionId = id;
    }

    const inputSignature = JSON.stringify({ sources: next.sources, inputs: next.inputs });
    const oldSignature = JSON.stringify({ sources: oldInput?.sources, inputs: oldInput?.inputs });
    if (!oldInput || inputSignature !== oldSignature) {
      const versionNumber = this.inputVersions.size + 1;
      const id = `iv-${versionNumber}-${randomUUID().slice(0, 8)}`;
      this.inputVersions.set(id, {
        id,
        version: versionNumber,
        sources: clone(next.sources),
        inputs: clone(next.inputs),
        createdAt,
        immutable: true,
      });
      this.project.currentInputVersionId = id;
    }

    this.project.draft = next;
    this.project.updatedAt = createdAt;
    return this.publicProject();
  }

  resolveVersions(payload = {}) {
    let expressionVersion;
    let inputVersion;

    if (payload.expressionVersionId) {
      expressionVersion = this.expressionVersions.get(payload.expressionVersionId);
      if (!expressionVersion) {
        const error = new Error(`未知表达式版本 ${payload.expressionVersionId}`);
        error.statusCode = 404;
        throw error;
      }
    }
    if (payload.inputVersionId) {
      inputVersion = this.inputVersions.get(payload.inputVersionId);
      if (!inputVersion) {
        const error = new Error(`未知输入版本 ${payload.inputVersionId}`);
        error.statusCode = 404;
        throw error;
      }
    }

    // Ad-hoc submitted configuration is snapshotted into the job but is never
    // written back to project.draft or current version pointers.
    const expression =
      typeof payload.expression === 'string'
        ? payload.expression
        : expressionVersion?.expression ?? this.project.draft.expression;
    const sources = payload.sources
      ? clone(payload.sources)
      : inputVersion?.sources ?? this.project.draft.sources;
    const inputs = payload.inputs || payload.metrics
      ? clone(payload.inputs || payload.metrics)
      : inputVersion?.inputs ?? this.project.draft.inputs;

    const stamp = randomUUID().slice(0, 8);
    const jobExpressionVersion = expressionVersion && expressionVersion.expression === expression
      ? expressionVersion
      : {
          id: `ev-job-${stamp}`,
          jobSnapshot: true,
          expression,
          createdAt: nowIso(),
          immutable: true,
        };
    const jobInputVersion = inputVersion &&
      JSON.stringify({ sources: inputVersion.sources, inputs: inputVersion.inputs }) ===
        JSON.stringify({ sources, inputs })
      ? inputVersion
      : {
          id: `iv-job-${stamp}`,
          jobSnapshot: true,
          sources,
          inputs,
          createdAt: nowIso(),
          immutable: true,
        };

    return { expressionVersion: jobExpressionVersion, inputVersion: jobInputVersion };
  }

  createJob(payload = {}) {
    const { expressionVersion, inputVersion } = this.resolveVersions(payload);
    const id = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const requestedBudget = Math.floor(
      Number(payload.budget ?? payload.maxLeaves ?? 64),
    );
    const normalizedBudget = Math.max(
      1,
      Math.min(
        MAX_BUDGET,
        Number.isFinite(requestedBudget) ? requestedBudget : 64,
      ),
    );
    const normalizedSampleCount = Math.max(
      0,
      Math.min(512, Math.floor(Number(payload.sampleCount ?? 96)) || 0),
    );
    const options = {
      budget: normalizedBudget,
      budgetLocked: payload.budgetLocked !== false,
      sampleCount: normalizedSampleCount,
      compare: payload.compare !== false,
    };

    const job = {
      id,
      schemaVersion: 'credible-range-job/v1',
      status: 'running',
      createdAt: nowIso(),
      expressionVersion: {
        id: expressionVersion.id,
        version: expressionVersion.version || null,
        expression: expressionVersion.expression,
        createdAt: expressionVersion.createdAt,
        immutable: true,
      },
      inputVersion: {
        id: inputVersion.id,
        version: inputVersion.version || null,
        sources: clone(inputVersion.sources),
        inputs: clone(inputVersion.inputs),
        createdAt: inputVersion.createdAt,
        immutable: true,
      },
      options,
      configSnapshot: {
        expression: expressionVersion.expression,
        sources: clone(inputVersion.sources),
        inputs: clone(inputVersion.inputs),
      },
      result: null,
      error: null,
    };

    this.jobs.set(id, job);

    try {
      job.result = analyzeModel(job.configSnapshot, options);
      job.status = 'completed';
    } catch (error) {
      job.status = 'blocked';
      job.error = error.toJSON ? error.toJSON() : {
        code: error.code || 'ANALYSIS_ERROR',
        message: error.message,
        details: error.details || {},
      };
    }

    job.completedAt = nowIso();
    return clone(job);
  }

  listJobs() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        budget: job.options.budget,
        budgetLocked: job.options.budgetLocked,
        expression: job.expressionVersion.expression,
        expressionVersionId: job.expressionVersion.id,
        inputVersionId: job.inputVersion.id,
        ordinary: job.result?.ordinary?.certified || null,
        correlated: job.result?.correlated?.certified || null,
        relativeReduction: job.result?.comparison?.relativeReduction ?? null,
        errorCode: job.error?.code || null,
        errorMessage: job.error?.message || null,
      }));
  }

  getJob(id) {
    const job = this.jobs.get(id);
    // Hand back a defensive snapshot so in-process callers cannot mutate the
    // frozen calculation record through the Map reference.
    return job ? clone(job) : null;
  }
}
