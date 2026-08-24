import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import SalesPage from './SalesPage';
import ReportsPage from './ReportsPage';
import UnsettledDeliveriesPage from './UnsettledDeliveriesPage';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';

/**
 * SalesReportsPage — Combined Sales & Reports page.
 * All three views live behind a single admin navigation entry.
 * Sales = all-time revenue/collection overview; Unsettled = shipments that
 * still owe money, row by row; Reports = period-based operational analytics.
 * The /admin/reports route opens this page with the Reports section active
 * (initialSection="reports").
 *
 * The active section lives in the URL (`?tab=unsettled`), not in useState.
 * Each child owns its own realtime subscription and refetches on a burst of
 * order changes; anything holding the section in component state is one
 * remount away from throwing the admin back to Sales Overview mid-triage.
 * The URL survives remounts, back/forward, and a shared link.
 */
const SECTIONS = [
  { value: 'sales', label: 'Sales Overview' },
  { value: 'unsettled', label: 'Unsettled Deliveries' },
  { value: 'reports', label: 'Reports & Analytics' },
];

const isSection = (value) => SECTIONS.some(s => s.value === value);

const SalesReportsPage = ({ initialSection }) => {
  const [searchParams, setSearchParams] = useSearchParams();

  const paramSection = searchParams.get('tab');
  const section = isSection(paramSection)
    ? paramSection
    : (isSection(initialSection) ? initialSection : 'sales');

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
      <div className="sales-reports-switcher no-print" role="group" aria-label="Sales and reports views">
        {SECTIONS.map(s => (
          <button
            key={s.value}
            type="button"
            className={`sales-reports-tab ${section === s.value ? 'active' : ''}`}
            aria-pressed={section === s.value}
            onClick={() => selectSection(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'sales' && (
        <ErrorBoundarySection key="sales" message="Sales overview failed to load.">
          <SalesPage />
        </ErrorBoundarySection>
      )}
      {section === 'unsettled' && (
        <ErrorBoundarySection key="unsettled" message="Unsettled deliveries report failed to load.">
          <UnsettledDeliveriesPage />
        </ErrorBoundarySection>
      )}
      {section === 'reports' && (
        <ErrorBoundarySection key="reports" message="Analytics report failed to load.">
          <ReportsPage />
        </ErrorBoundarySection>
      )}
    </div>
  );
};

export default SalesReportsPage;
