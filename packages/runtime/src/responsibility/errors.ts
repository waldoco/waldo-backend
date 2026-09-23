abstract class ResponsibilityBoundaryError extends Error {
  protected constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export class ResponsibilityIngressRateLimitError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityIngressRateLimitError', 'responsibility ingress rate limited');
  }
}

export class ResponsibilityDigestConflictError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityDigestConflictError', 'responsibility capture digest conflict');
  }
}

export class ResponsibilityOwnerRootMismatchError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityOwnerRootMismatchError', 'owner authority root mismatch');
  }
}

export class ResponsibilityProjectionMissingError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityProjectionMissingError', 'responsibility projection snapshot missing');
  }
}

export class ResponsibilityAuthorityDeniedError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityAuthorityDeniedError', 'responsibility authority denied');
  }
}

export class ResponsibilityProjectionCursorError extends ResponsibilityBoundaryError {
  constructor(readonly code: 'snapshot_replaced' | 'cursor_ahead' | 'cursor_corrupt') {
    super('ResponsibilityProjectionCursorError', `responsibility projection cursor rejected: ${code}`);
  }
}

export class ResponsibilityPlanningConflictError extends ResponsibilityBoundaryError {
  constructor(message: string) {
    super('ResponsibilityPlanningConflictError', message);
  }
}

export class ResponsibilityJudgmentConflictError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityJudgmentConflictError', 'judgment authority conflict');
  }
}

export class ResponsibilityExecutionUnavailableError extends ResponsibilityBoundaryError {
  constructor() {
    super('ResponsibilityExecutionUnavailableError', 'execution environment unavailable');
  }
}

export function responsibilityBoundaryStatus(
  error: unknown,
): 401 | 404 | 409 | 429 | 503 | null {
  if (!(error instanceof Error)) return null;
  const statuses: Readonly<Record<string, 401 | 404 | 409 | 429 | 503>> = {
    ResponsibilityAuthorityDeniedError: 401,
    ResponsibilityOwnerRootMismatchError: 404,
    ResponsibilityProjectionMissingError: 404,
    ResponsibilityDigestConflictError: 409,
    ResponsibilityProjectionCursorError: 409,
    ResponsibilityPlanningConflictError: 409,
    ResponsibilityJudgmentConflictError: 409,
    ResponsibilityIngressRateLimitError: 429,
    ResponsibilityExecutionUnavailableError: 503,
  };
  return statuses[error.name] ?? null;
}
