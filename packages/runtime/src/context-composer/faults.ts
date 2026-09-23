import type { ContextCompositionFailureCode } from './types';

// Expected faults are typed at the adapter/composer boundary. Anything else is an unexpected
// implementation defect and must reach the redacted observer path.
export class ContextRecallFailClosedError extends Error {
  constructor() {
    super('context recall failed its safety boundary');
    this.name = 'ContextRecallFailClosedError';
  }
}

export class ContextRecallUnavailableError extends Error {
  constructor() {
    super('context recall source unavailable');
    this.name = 'ContextRecallUnavailableError';
  }
}

export class ContextSourceUnavailableError extends Error {
  constructor() {
    super('context source unavailable');
    this.name = 'ContextSourceUnavailableError';
  }
}

export class ContextSourceRejectedError extends Error {
  constructor(readonly failure: ContextCompositionFailureCode) {
    super('context source rejected');
    this.name = 'ContextSourceRejectedError';
  }
}

export class FailClosed extends Error {
  constructor(readonly code: ContextCompositionFailureCode) {
    super(code);
    this.name = 'FailClosed';
  }
}
