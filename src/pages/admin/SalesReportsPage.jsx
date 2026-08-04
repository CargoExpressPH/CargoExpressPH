import { useState } from 'react';
import SalesPage from './SalesPage';
import ReportsPage from './ReportsPage';
import UnsettledDeliveriesPage from './UnsettledDeliveriesPage';
import ServiceReportsPage from './ServiceReportsPage';

/**
 * SalesReportsPage — Combined Sales & Reports page.
 * All four views live behind a single admin navigation entry.
 * Sales = all-time revenue/collection overview; Unsettled = shipments that
 * still owe money, row by row; Customer Service = queue health and response
 * times; Reports = period-based operational analytics.
 * The /admin/reports route opens this page with the Reports section active
 * (initialSection="reports").
 */
const SECTIONS = [
  { value: 'sales', label: 'Sales Overview' },
  { value: 'unsettled', label: 'Unsettled Deliveries' },
  { value: 'service', label: 'Customer Service' },
  { value: 'reports', label: 'Reports & Analytics' },
];

const SalesReportsPage = ({ initialSection }) => {
  const [section, setSection] = useState(
    SECTIONS.some(s => s.value === initialSection) ? initialSection : 'sales'
  );

  return (
    <div className="page-transition">
      <div className="sales-reports-switcher no-print" role="group" aria-label="Sales and reports views">
        {SECTIONS.map(s => (
          <button
            key={s.value}
            type="button"
            className={`sales-reports-tab ${section === s.value ? 'active' : ''}`}
            aria-pressed={section === s.value}
            onClick={() => setSection(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {section === 'sales' && <SalesPage />}
      {section === 'unsettled' && <UnsettledDeliveriesPage />}
      {section === 'service' && <ServiceReportsPage />}
      {section === 'reports' && <ReportsPage />}
    </div>
  );
};

export default SalesReportsPage;
