import { Component, type ErrorInfo, type ReactNode } from 'react';

import { ErrorState } from '../shared/ui/error-state';

/** A failing seat map must not take the whole application down with it. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('route crashed', error, info.componentStack);
  }

  override render() {
    if (this.state.error) return <ErrorState error={this.state.error} />;
    return this.props.children;
  }
}
