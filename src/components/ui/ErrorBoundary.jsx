import { Component } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', error, errorInfo);
    }
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary-fallback">
          <div className="error-boundary-icon">
            <AlertTriangle size={36} color="var(--error)" />
          </div>
          <h2>Something went wrong</h2>
          <p>
            An unexpected error occurred. You can try again or reload the page.
          </p>
          {import.meta.env.DEV && this.state.error && (
            <pre className="error-boundary-error">
              {this.state.error.message}
            </pre>
          )}
          <div className="error-boundary-actions">
            <button
              onClick={this.handleRetry}
              className="btn btn-outline inline-flex items-center gap-8"
            >
              Try Again
            </button>
            <button
              onClick={this.handleReload}
              className="btn btn-primary inline-flex items-center gap-8"
            >
              <RefreshCw size={16} />
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
