import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import PhotoStorageTab from './PhotoStorageTab';
import EmailServiceTab from './EmailServiceTab';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';

/**
 * StorageMonitoringPage — Photo Storage and Email Service live behind a
 * single admin navigation entry, same tabbed shape as SalesReportsPage.
 *
 * The active tab lives in the URL (`?tab=email`), not in useState, so a
 * shared link or a browser back/forward step lands on the right tab.
 */
const SECTIONS = [
  { value: 'photos', label: 'Photo Storage' },
  { value: 'email', label: 'Email Service' },
];

const isSection = (value) => SECTIONS.some(s => s.value === value);

const StorageMonitoringPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const paramSection = searchParams.get('tab');
  const section = isSection(paramSection) ? paramSection : 'photos';

  const selectSection = useCallback((value) => {
    // replace: switching a tab is not a navigation step worth a Back press.
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="page-transition">
      <div className="admin-tab-bar" role="tablist" aria-label="Storage monitoring sections">
        {SECTIONS.map(s => (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={section === s.value}
            className={`admin-tab-btn ${section === s.value ? 'active' : ''}`}
            onClick={() => selectSection(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'photos' && (
        <ErrorBoundarySection key="photos" message="Photo storage monitoring failed to load.">
          <PhotoStorageTab />
        </ErrorBoundarySection>
      )}
      {section === 'email' && (
        <ErrorBoundarySection key="email" message="Email service monitoring failed to load.">
          <EmailServiceTab />
        </ErrorBoundarySection>
      )}
    </div>
  );
};

export default StorageMonitoringPage;
