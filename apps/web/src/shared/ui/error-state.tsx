import { ApiError } from '../api/client';
import { Button } from './button';

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const detail = error instanceof ApiError ? error.problem.detail : 'Something went wrong';
  const traceId = error instanceof ApiError ? error.problem.traceId : null;

  return (
    <div
      role="alert"
      className="rounded-lg border border-red-300 bg-red-50 p-6 dark:border-red-800 dark:bg-red-950"
    >
      <p className="font-medium text-red-800 dark:text-red-200">{detail}</p>
      {traceId ? (
        <p className="mt-1 text-xs text-red-700 dark:text-red-300">Trace: {traceId}</p>
      ) : null}
      {onRetry ? (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
