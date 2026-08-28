/**
 * Base class for failures the client is allowed to see. The HTTP status and the
 * Problem Details `type` live on the error, not in the controller, so a new
 * failure mode cannot be introduced without deciding how it is reported.
 */
export abstract class DomainError extends Error {
  abstract readonly status: number;
  /** Slug appended to PUBLIC_ERROR_BASE_URL to form the Problem Details `type`. */
  abstract readonly typeSlug: string;
  abstract readonly title: string;

  constructor(detail: string) {
    super(detail);
    this.name = new.target.name;
  }
}

export class ResourceNotFoundError extends DomainError {
  readonly status = 404;
  readonly typeSlug = 'not-found';
  readonly title = 'Resource not found';

  constructor(resource: string, id: string) {
    super(`${resource} ${id} does not exist`);
  }
}

export class ValidationFailedError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'validation-failed';
  readonly title = 'Request validation failed';
}

export class InvalidCursorError extends DomainError {
  readonly status = 400;
  readonly typeSlug = 'invalid-cursor';
  readonly title = 'Invalid pagination cursor';

  constructor() {
    super('The supplied cursor is not a cursor this endpoint issued');
  }
}
