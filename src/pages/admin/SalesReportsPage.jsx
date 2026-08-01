import { useState } from 'react';
import SalesPage from './SalesPage';
import ReportsPage from './ReportsPage';

/**
 * SalesReportsPage — Combined Sales & Reports page.
 * Both features live behind a single admin navigation entry.
 * Sales = all-time revenue/collection overview; Reports = period-based
 * operational analytics. The /admin/reports route opens this page with
 * the Reports section active (initialSection="reports").
 */
const SalesReportsPage = ({ initialSection }) => {
  const [section, setSection] = useState(initialSection === 'reports' ? 'reports' : 'sales');

  return (
    <div className="page-transition">
      <div className="sales-reports-switcher no-print" role="group" aria-label="Sales and reports views">
        <button
          type="button"
          className={`sales-reports-tab ${section === 'sales' ? 'active' : ''}`}
          aria-pressed={section === 'sales'}
          onClick={() => setSection('sales')}
        >
          Sales Overview
        </button>
        <button
          type="button"
          className={`sales-reports-tab ${section === 'reports' ? 'active' : ''}`}
          aria-pressed={section === 'reports'}
          onClick={() => setSection('reports')}
        >
          Reports &amp; Analytics
        </button>
      </div>
      {section === 'sales' ? <SalesPage /> : <ReportsPage />}
    </div>
  );
};

export default SalesReportsPage;
