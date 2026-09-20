import { Suspense } from 'react';
import PerTripSalesPage from './PerTripSalesPage';
import ErrorBoundarySection from '../../components/ui/ErrorBoundarySection';
import PageLoader from '../../components/ui/PageLoader';

/**
 * SalesReportsPage
 * Now renders the Per Trip sales report directly as the Reports & Analytics page.
 */
const SalesReportsPage = () => {
  return (
    <div className="page-transition">
      <ErrorBoundarySection key="per-trip" message="The trip report could not be loaded.">
        <Suspense fallback={<PageLoader />}>
          <PerTripSalesPage />
        </Suspense>
      </ErrorBoundarySection>
    </div>
  );
};

export default SalesReportsPage;
