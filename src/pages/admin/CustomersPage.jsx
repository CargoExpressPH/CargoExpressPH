import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getCustomers } from '../../lib/database';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import ResponsiveFilterControls from '../../components/ui/ResponsiveFilterControls';
import { ChevronRight, Eye, Search, Users, X } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';
import { formatMoney } from '../../utils/currencyInput';
import { formatPhDate } from '../../utils/datetime';
import { rowLinkProps } from '../../utils/rowLink';

const SEARCH_DEBOUNCE_MS = 350;

const STATUS_FILTERS = [
  { value: 'all', label: 'All customers' },
  { value: 'with_balance', label: 'With unpaid balance' },
  { value: 'pending', label: 'With pending booking' },
  { value: 'active', label: 'With active booking' },
  { value: 'no_bookings', label: 'No bookings yet' },
];

const STATUS_PRESENTATION = {
  with_balance: { label: 'With balance', className: 'badge-error' },
  pending: { label: 'Pending booking', className: 'badge-warning' },
  active: { label: 'Active booking', className: 'badge-success' },
  inactive: { label: 'No active booking', className: '' },
};

const customerName = (customer) => customer.name?.trim() || 'Unnamed customer';

const customerInitials = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'CU';
  return `${parts[0][0]}${parts.length > 1 ? parts[parts.length - 1][0] : ''}`.toUpperCase();
};

const customerLocation = (customer) =>
  customer.address_province?.trim()
  || customer.address_city?.trim()
  || 'Not provided';

const statusFor = (customer) =>
  STATUS_PRESENTATION[customer.directory_status] || STATUS_PRESENTATION.inactive;

const CustomerStatus = ({ customer }) => {
  const status = statusFor(customer);
  return (
    <span className={`badge customer-directory-status ${status.className}`.trim()}>
      {status.label}
    </span>
  );
};

const CustomerListSkeleton = () => (
  <div className="customer-directory-skeleton" role="status" aria-label="Loading customers">
    <span className="sr-only">Loading customers…</span>
    {Array.from({ length: 6 }, (_, index) => (
      <div className="customer-directory-skeleton-row" key={index} aria-hidden="true">
        <span className="customer-directory-skeleton-avatar" />
        <span className="customer-directory-skeleton-line customer-directory-skeleton-line--wide" />
        <span className="customer-directory-skeleton-line" />
        <span className="customer-directory-skeleton-line" />
        <span className="customer-directory-skeleton-line customer-directory-skeleton-line--short" />
      </div>
    ))}
  </div>
);

const CustomersPage = () => {
  usePageTitle('Customers');
  const navigate = useNavigate();
  const [customers, setCustomers] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage] = useState(15);
  const debounceTimer = useRef(null);
  const requestSequence = useRef(0);


  const loadCustomers = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setError(null);
    setLoading(true);
    try {
      const { data, count } = await getCustomers({
        page: currentPage,
        perPage,
        search: debouncedSearch,
        statusFilter,
      });
      if (requestId !== requestSequence.current) return;
      setCustomers(data);
      setTotalCount(count);
    } catch (loadError) {
      if (requestId !== requestSequence.current) return;
      setError(loadError.message || 'Failed to load customers.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [currentPage, perPage, debouncedSearch, statusFilter]);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  const handleSearchChange = (event) => {
    const value = event.target.value;
    setSearch(value);
    setCurrentPage(1);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedSearch(value), SEARCH_DEBOUNCE_MS);
  };

  const handleStatusFilterChange = (nextStatus) => {
    setStatusFilter(nextStatus);
    setCurrentPage(1);
  };

  const clearFilters = () => {
    clearTimeout(debounceTimer.current);
    setSearch('');
    setDebouncedSearch('');
    setStatusFilter('all');
    setCurrentPage(1);
  };

  const hasSearchOrFilters = Boolean(debouncedSearch.trim())
    || statusFilter !== 'all';

  return (
    <div className="page-transition admin-customers-page">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Users size={24} color="var(--primary)" aria-hidden="true" />Customers</h1>
          <p className="admin-page-subtitle">Search, compare, and manage registered customer accounts.</p>
        </div>
        <div className="admin-page-meta">
          <span className="badge badge-info">{loading ? 'Loading' : `${totalCount} total`}</span>
        </div>
      </div>

      <div className="customer-directory-toolbar">
        <div className="search-box customer-directory-search" role="search">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            id="admin-customers-search"
            name="qcustomers"
            aria-label="Search customers by name, email, phone, city, or province"
            placeholder="Search name, email, phone, or location…"
            value={search}
            maxLength={100}
            onChange={handleSearchChange}
          />
        </div>

        <div className="customer-directory-filter-row">
          <ResponsiveFilterControls
            options={STATUS_FILTERS}
            value={statusFilter}
            onChange={handleStatusFilterChange}
            ariaLabel="Filter customers by booking state"
          />
          {(hasSearchOrFilters || search) && (
            <button type="button" className="btn btn-ghost btn-sm customer-filter-clear" onClick={clearFilters}>
              <X size={16} aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="card admin-section-card customer-directory-card">
          <CustomerListSkeleton />
        </div>
      ) : error ? (
        <div className="card admin-error-card">
          <h3>Unable to load customers</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={loadCustomers}>Retry</button>
        </div>
      ) : customers.length === 0 ? (
        <div className="card animate-fade-in">
          <EmptyState
            icon={Users}
            title={hasSearchOrFilters ? 'No matching customers' : 'No customers registered'}
            description={hasSearchOrFilters
              ? 'Try changing the search term or clearing a filter.'
              : 'Registered customer accounts will appear here.'}
            actionLabel={hasSearchOrFilters ? 'Clear filters' : undefined}
            onAction={hasSearchOrFilters ? clearFilters : undefined}
          />
        </div>
      ) : (
        <div className="card admin-section-card customer-directory-card animate-fade-in">
          <div className="customer-directory-desktop">
            <table className="data-table customer-directory-table">
              <caption className="sr-only">Registered customer accounts</caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Location</th>
                  <th scope="col" className="num">Bookings</th>
                  <th scope="col" className="num">Outstanding</th>
                  <th scope="col">Last booking</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="customer-directory-action-heading">Action</th>
                </tr>
              </thead>
              <tbody>
                {customers.map(customer => {
                  const name = customerName(customer);
                  const location = customerLocation(customer);
                  const balance = Number(customer.outstanding_balance || 0);
                  return (
                    <tr key={customer.id} {...rowLinkProps(navigate, `/admin/customers/${customer.id}`)}>
                      <td>
                        <div className="customer-directory-identity">
                          <span className="customer-directory-avatar" aria-hidden="true">{customerInitials(name)}</span>
                          <span className="customer-directory-identity-copy">
                            <Link to={`/admin/customers/${customer.id}`} className="customer-directory-name" title={name}>{name}</Link>
                          </span>
                        </div>
                      </td>
                      <td><span className="customer-directory-truncate" title={location}>{location}</span></td>
                      <td className="num customer-directory-number">{Number(customer.total_bookings || 0).toLocaleString('en-PH')}</td>
                      <td className="num customer-directory-balance">
                        {Number(customer.total_bookings || 0) === 0 ? <span className="text-tertiary">No balance</span> : balance > 0 ? formatMoney(balance) : <span className="customer-directory-paid">Fully paid</span>}
                      </td>
                      <td>{customer.last_booking_at ? formatPhDate(customer.last_booking_at) : <span className="text-tertiary">No bookings yet</span>}</td>
                      <td><CustomerStatus customer={customer} /></td>
                      <td className="customer-directory-action">
                        <Link className="customer-directory-view" to={`/admin/customers/${customer.id}`} aria-label={`View ${name}`}>
                          <Eye size={16} aria-hidden="true" /> View
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="customer-directory-mobile" role="list" aria-label="Registered customer accounts">
            {customers.map(customer => {
              const name = customerName(customer);
              const location = customerLocation(customer);
              const balance = Number(customer.outstanding_balance || 0);
              const bookings = Number(customer.total_bookings || 0);
              return (
                <Link
                  to={`/admin/customers/${customer.id}`}
                  className="customer-directory-mobile-card"
                  key={customer.id}
                  role="listitem"
                  aria-label={`View ${name}, ${bookings} ${bookings === 1 ? 'booking' : 'bookings'}`}
                >
                  <span className="customer-directory-avatar" aria-hidden="true">{customerInitials(name)}</span>
                  <span className="customer-directory-mobile-main">
                    <span className="customer-directory-mobile-topline">
                      <span className="customer-directory-name" title={name}>{name}</span>
                      <CustomerStatus customer={customer} />
                    </span>
                    <span className="customer-directory-mobile-contact">
                      <span>{customer.phone || 'Phone not provided'}</span>
                      <span aria-hidden="true">•</span>
                      <span title={location}>{location}</span>
                    </span>
                    <span className="customer-directory-mobile-summary">
                      <span><strong>{bookings.toLocaleString('en-PH')}</strong> {bookings === 1 ? 'booking' : 'bookings'}</span>
                      {balance > 0 && <span className="customer-directory-mobile-balance">Due {formatMoney(balance)}</span>}
                    </span>
                  </span>
                  <ChevronRight className="customer-directory-mobile-chevron" size={20} aria-hidden="true" />
                </Link>
              );
            })}
          </div>

          <div className="customer-directory-pagination">
            <Pagination
              totalItems={totalCount}
              currentPage={currentPage}
              itemsPerPage={perPage}
              onPageChange={setCurrentPage}
              onPerPageChange={(value) => { setPerPage(value); setCurrentPage(1); }}
            />
          </div>
        </div>
      )}

      <style>{`
        .customer-directory-toolbar {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 12px;
          margin-bottom: 16px;
        }
        .customer-directory-search { width: 100%; }
        .customer-directory-filter-row {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .customer-directory-filter-row .filter-chips { flex: 1 1 auto; min-width: 0; }
        .customer-filter-clear { flex: 0 0 auto; white-space: nowrap; }
        .customer-directory-card { overflow: hidden; }
        .customer-directory-table { table-layout: fixed; }
        .customer-directory-table th:nth-child(1) { width: 22%; }
        .customer-directory-table th:nth-child(2) { width: 12%; }
        .customer-directory-table th:nth-child(3) { width: 8%; }
        .customer-directory-table th:nth-child(4) { width: 13%; }
        .customer-directory-table th:nth-child(5) { width: 12%; }
        .customer-directory-table th:nth-child(6) { width: 13%; }
        .customer-directory-table th:nth-child(7) { width: 8%; }
        .customer-directory-table td { vertical-align: middle; padding-top: 12px; padding-bottom: 12px; }
        .customer-directory-identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .customer-directory-avatar {
          width: 38px;
          height: 38px;
          flex: 0 0 38px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: var(--primary-bg);
          border: 1px solid var(--primary-lighter);
          color: var(--primary-text);
          font-size: var(--text-12);
          font-weight: 700;
          letter-spacing: 0.02em;
        }
        .customer-directory-identity-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .customer-directory-name {
          display: block;
          min-width: 0;
          overflow: hidden;
          color: var(--text);
          font-size: var(--text-14);
          font-weight: 700;
          line-height: 1.35;
          text-decoration: none;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        a.customer-directory-name:hover { color: var(--primary-text); text-decoration: underline; text-underline-offset: 3px; }
        .customer-directory-truncate {
          display: block;
          min-width: 0;
          overflow: hidden;
          color: var(--text-tertiary);
          font-size: var(--text-12);
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .customer-directory-number,
        .customer-directory-balance { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .customer-directory-balance { font-weight: 700; }
        .customer-directory-paid { color: var(--success-dark); font-size: var(--text-12); font-weight: 700; }
        .customer-directory-status { max-width: 100%; white-space: nowrap; }
        .customer-directory-action-heading,
        .customer-directory-action { text-align: right !important; }
        .customer-directory-view {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          min-height: 36px;
          padding: 6px 8px;
          border-radius: var(--radius-sm);
          color: var(--primary-text);
          font-size: var(--text-12);
          font-weight: 700;
          text-decoration: none;
        }
        .customer-directory-view:hover { background: var(--primary-bg); }
        .customer-directory-view:focus-visible,
        .customer-directory-mobile-card:focus-visible,
        .customer-directory-name:focus-visible {
          outline: 3px solid var(--primary-glow);
          outline-offset: 2px;
        }
        .customer-directory-mobile { display: none; }
        .customer-directory-pagination .pagination-wrap { border-top-color: var(--border-light); }
        .customer-directory-skeleton { padding: 8px 16px; }
        .customer-directory-skeleton-row {
          display: grid;
          grid-template-columns: 40px 1.5fr repeat(3, 1fr);
          gap: 14px;
          align-items: center;
          min-height: 66px;
          border-bottom: 1px solid var(--border-light);
        }
        .customer-directory-skeleton-row:last-child { border-bottom: 0; }
        .customer-directory-skeleton-avatar,
        .customer-directory-skeleton-line {
          display: block;
          background: linear-gradient(90deg, var(--bg-secondary), var(--border-light), var(--bg-secondary));
          background-size: 200% 100%;
          animation: customer-directory-shimmer 1.4s ease-in-out infinite;
        }
        .customer-directory-skeleton-avatar { width: 38px; height: 38px; border-radius: 50%; }
        .customer-directory-skeleton-line { width: 72%; height: 10px; border-radius: var(--radius-full); }
        .customer-directory-skeleton-line--wide { width: 88%; height: 13px; }
        .customer-directory-skeleton-line--short { width: 48%; }
        @keyframes customer-directory-shimmer { to { background-position: -200% 0; } }

        @media (max-width: 1180px) {
          .customer-directory-table th,
          .customer-directory-table td { padding-left: 10px; padding-right: 10px; }
          .customer-directory-avatar { width: 34px; height: 34px; flex-basis: 34px; }
        }

        @media (max-width: 1000px) {
          .customer-directory-desktop { display: none; }
          .customer-directory-mobile { display: grid; gap: 10px; padding: 12px; }
          .customer-directory-mobile-card {
            display: grid;
            grid-template-columns: 42px minmax(0, 1fr) 20px;
            gap: 11px;
            align-items: center;
            min-width: 0;
            min-height: 96px;
            padding: 13px;
            border: 1px solid var(--border-light);
            border-radius: var(--radius-md);
            background: var(--surface);
            color: inherit;
            text-decoration: none;
            transition: var(--transition-fast);
          }
          .customer-directory-mobile-card:hover { border-color: var(--primary-lighter); background: var(--primary-bg); }
          .customer-directory-mobile-card .customer-directory-avatar { width: 42px; height: 42px; flex-basis: 42px; }
          .customer-directory-mobile-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
          .customer-directory-mobile-topline { display: flex; align-items: center; gap: 8px; min-width: 0; }
          .customer-directory-mobile-topline .customer-directory-name { flex: 1; font-size: var(--text-16); }
          .customer-directory-mobile-topline .badge { flex: 0 0 auto; font-size: var(--text-12); }
          .customer-directory-mobile-contact,
          .customer-directory-mobile-summary { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: var(--text-12); color: var(--text-secondary); }
          .customer-directory-mobile-contact span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .customer-directory-mobile-contact span:last-child { flex: 1; }
          .customer-directory-mobile-summary { padding-top: 2px; color: var(--text-tertiary); }
          .customer-directory-mobile-balance { color: var(--error); font-weight: 700; font-variant-numeric: tabular-nums; }
          .customer-directory-mobile-chevron { color: var(--text-tertiary); }
          .customer-directory-skeleton { display: grid; gap: 10px; padding: 12px; }
          .customer-directory-skeleton-row { grid-template-columns: 42px minmax(0, 1fr); min-height: 92px; padding: 13px; border: 1px solid var(--border-light); border-radius: var(--radius-md); }
          .customer-directory-skeleton-row .customer-directory-skeleton-line:not(.customer-directory-skeleton-line--wide) { display: none; }
        }

        @media (max-width: 680px) {
        }

        @media (max-width: 420px) {
          .customer-directory-mobile { padding: 8px; gap: 8px; }
          .customer-directory-mobile-card { grid-template-columns: 38px minmax(0, 1fr) 18px; gap: 9px; min-height: 92px; padding: 11px; }
          .customer-directory-mobile-card .customer-directory-avatar { width: 38px; height: 38px; flex-basis: 38px; }
          .customer-directory-mobile-topline { align-items: flex-start; }
          .customer-directory-mobile-topline .badge { max-width: 104px; overflow: hidden; text-overflow: ellipsis; }
          .customer-directory-mobile-contact { gap: 5px; }
        }
      `}</style>
    </div>
  );
};

export default CustomersPage;
