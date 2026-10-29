import { Component, ErrorInfo, ReactNode } from 'react';
import * as Sentry from '@sentry/react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { isChunkLoadError, recoverFromChunkLoadError } from '@/lib/platform/chunkRecovery';
import { reloadPage } from '@/lib/platform/reloadPage';

interface Props { children: ReactNode }

/**
 * `chunk` is set only for a lazy chunk that failed to load (a deploy replaced it):
 * - 'pending'   the error was just caught; componentDidCatch has not decided yet,
 * - 'reloading' the page is reloading once to pick up the new build,
 * - 'prompt'    the reload already happened and did not help, so the user gets a Reload button.
 */
interface State {
  hasError: boolean;
  message?: string;
  chunk?: 'pending' | 'reloading' | 'prompt';
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message,
      chunk: isChunkLoadError(error) ? 'pending' : undefined,
    };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkLoadError(error)) {
      // Decided here, not in getDerivedStateFromError: that one is a render-phase method
      // React may call twice, and this decision writes the reload guard and reloads.
      const outcome = recoverFromChunkLoadError();
      this.setState({ chunk: outcome === 'reloading' ? 'reloading' : 'prompt' });
      // The first failure after a deploy is expected and fixed by the reload, so only a
      // failure the reload did not fix is reported.
      if (outcome === 'reloading') return;
    }
    // Report to Sentry (no-op when the SDK is disabled), preserving the React
    // component stack on the issue. Keep the console log for local debugging.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: info.componentStack } },
    });
    // eslint-disable-next-line no-console
    console.error('Top-level ErrorBoundary caught:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError && this.state.chunk) {
      if (this.state.chunk !== 'prompt') {
        // A reload is under way (or about to be decided): a quiet loading line, not an error.
        return (
          <div data-testid="chunk-reload-pending" className="flex items-center justify-center py-12">
            <p className="text-text-secondary">Loading the latest version...</p>
          </div>
        );
      }
      return (
        <div
          data-testid="chunk-reload-prompt"
          role="alert"
          className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center"
        >
          <Heading level={1} scale="lg">This page didn&apos;t load</Heading>
          <p className="max-w-sm text-text-secondary">
            ServWave may have just been updated, or the connection dropped. Reload to get the latest version.
          </p>
          <Button variant="solid" tone="brand" onClick={() => reloadPage()}>
            Reload
          </Button>
        </div>
      );
    }
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
