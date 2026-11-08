import { Component, ErrorInfo, ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';

interface Props { children: ReactNode }
interface State { hasError: boolean; message?: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    // Report to Sentry (no-op when the SDK is disabled), preserving the React
    // component stack on the issue. Keep the console log for local debugging.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
    });
    // eslint-disable-next-line no-console
    console.error('Top-level ErrorBoundary caught:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div data-testid="error-boundary-fallback" className="flex flex-col items-center justify-center py-16 gap-3">
          <Heading level={1} scale="lg">Something went wrong</Heading>
          <p className="text-text-secondary">This page hit an unexpected error. Try reloading.</p>
          {/* outline/neutral, default size: border-border and default px-4 py-2 match exactly.
              Disclosed deltas: outline/neutral adds a bg-surface-light fill and a
              hover:bg-background-light state (the raw had neither), and the radius corrects
              rounded-lg to Button's own rounded-button. */}
          <Button variant="outline" tone="neutral" onClick={() => window.location.assign('/')}>
            Go to dashboard
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
