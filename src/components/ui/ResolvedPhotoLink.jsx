import { useEffect, useState } from 'react';
import { resolvePhotoUrl } from '../../lib/storage';
import { isUnavailablePhotoUrl } from '../../lib/photoReference';

const ResolvedPhotoLink = ({ photo, className = '', children, unavailableLabel = 'Receipt unavailable' }) => {
  const [state, setState] = useState({ status: 'loading', url: '' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', url: '' });

    resolvePhotoUrl(photo)
      .then((url) => {
        if (cancelled) return;
        setState(isUnavailablePhotoUrl(url)
          ? { status: 'error', url: '' }
          : { status: 'ready', url });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', url: '' });
      });

    return () => { cancelled = true; };
  }, [photo]);

  if (!photo) return null;
  if (state.status === 'loading') {
    return <span className={className} aria-live="polite">Loading receipt…</span>;
  }
  if (state.status === 'error') {
    return <span className={className} role="status">{unavailableLabel}</span>;
  }
  return (
    <a href={state.url} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  );
};

export default ResolvedPhotoLink;
