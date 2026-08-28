import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Carries the correlation id through the whole request without threading it
 * as a parameter. Read by the logger and by the Problem Details filter.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string {
  return requestContext.getStore()?.requestId ?? 'no-request';
}
