import { Link, Outlet } from 'react-router';

import { ThemeToggle } from '../shared/ui/theme-toggle';
import { RouteErrorBoundary } from './error-boundary';

export function Layout() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
        <Link to="/" className="text-lg font-semibold">
          Cinema
        </Link>
        <ThemeToggle />
      </header>
      <main>
        <RouteErrorBoundary>
          <Outlet />
        </RouteErrorBoundary>
      </main>
    </div>
  );
}
