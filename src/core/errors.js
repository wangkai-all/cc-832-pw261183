// Typed errors shared by the parser, dependency graph, domain checks and API.

export class AnalysisError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

export class ParseAnalysisError extends AnalysisError {
  constructor(message, details = {}) {
    super('PARSE_ERROR', message, details);
    this.name = 'ParseAnalysisError';
  }
}

export class DomainAnalysisError extends AnalysisError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'DomainAnalysisError';
  }
}

export class CycleAnalysisError extends AnalysisError {
  constructor(message, details = {}) {
    super('CYCLE', message, details);
    this.name = 'CycleAnalysisError';
  }
}

export function ensureFiniteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AnalysisError('INVALID_NUMBER', `${label} 必须是有限数字`, { value });
  }
}
