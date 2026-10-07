import { Button, Icon } from '@autoflow/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Name of the area, shown in the message ("the step list"). */
  area: string;
  children: ReactNode;
  /** Changing this value resets the boundary (e.g. a different flow is opened). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a bug in one panel from blanking the whole window. The user's work is
 * autosaved, so "Try again" is safe.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.area}]`, error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full min-h-32 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="bug" size={24} className="text-danger" />
        <p className="font-semibold">Something went wrong in {this.props.area}.</p>
        <p className="max-w-md text-[13px] text-muted">
          Your work is saved. Try again, and if it keeps happening send this message to your administrator:
        </p>
        <code className="max-w-md truncate rounded bg-surface-2 px-2 py-1 text-xs text-danger">{this.state.error.message}</code>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    );
  }
}
