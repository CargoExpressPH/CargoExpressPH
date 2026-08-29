import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getCustomers } from '../../lib/database';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import { ChevronRight, Search, Users } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

// Debounce delay in ms — avoids firing a DB query on every keystroke
const SEARCH_DEBOUNCE_MS = 350;

const CustomersPage = () => {
  usePageTitle('Customers');
  const [customers, setCustomers] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [search, setSearch]       = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage]         = useState(15);

  // Hold the latest debounced search term to send to the DB
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const debounceTimer = useRef(null);

  // Debounce: update debouncedSearch after user stops typing
  const handleSearchChange = (e) => {
    const val = e.target.value;
    setSearch(val);
    setCurrentPage(1);
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedSearch(val), SEARCH_DEBOUNCE_MS);
  };

  const loadCustomers = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { data, count } = await getCustomers({
        page: currentPage,
        perPage,
        search: debouncedSearch,
      });
      setCustomers(data);
      setTotalCount(count);
    } catch (e) {
      setError(e.message || 'Failed to load customers.');
    } finally {
      setLoading(false);
    }
  }, [currentPage, perPage, debouncedSearch]);

  useEffect(() => { loadCustomers(); }, [loadCustomers]);

  // Cleanup debounce on unmount
  useEffect(() => () => clearTimeout(debounceTimer.current), []);

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title"><Users size={24} color="var(--primary)" aria-hidden="true" />Customers</h1>
          <p className="admin-page-subtitle">Customer accounts, contact details, and booking history.</p>
        </div>
        <div className="admin-page-meta">
          <span className="badge badge-info">{totalCount} total</span>
        </div>
      </div>

      <div className="admin-toolbar">
        <div className="search-box" role="search">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input
            id="admin-customers-search"
            name="qcustomers"
            aria-label="Search customers"
            placeholder="Search by name, email, phone, or province…"
            value={search}
            onChange={handleSearchChange}
          />
        </div>
      </div>

      {loading ? (
        <div className="card animate-fade-in">
          <div className="table-container">
            <table className="data-table data-table--list">
              <caption className="sr-only">List of registered customers (loading)</caption>
              <thead><tr><th scope="col">Name</th></tr></thead>
              <tbody>
                {Array.from({ length: perPage }, (_, i) => <SkeletonTableRow key={i} cols={1} />)}
              </tbody>
            </table>
          </div>
        </div>
      ) : error ? (
        <div className="card admin-error-card">
          <h3>Error</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-primary mt-md" onClick={loadCustomers}>Retry</button>
        </div>
      ) : customers.length === 0 ? (
        <div className="card animate-fade-in">
          <EmptyState
            icon={Users}
            title="No customers found"
            description={debouncedSearch ? 'Try a different search term.' : 'No registered customers yet.'}
          />
        </div>
      ) : (
        <div className="card admin-section-card admin-table-card animate-fade-in">
          <div className="table-container">
            <table className="data-table data-table--list">
              <caption className="sr-only">List of registered customers</caption>
              <thead><tr><th scope="col">Name</th></tr></thead>
              <tbody>
                {/* One column, on every viewport. Email, Phone, Province and
                    Joined were removed: none of them is why an admin opens this
                    screen, which is to FIND a person and go to their record.
                    Each detail is one tap away on the customer's own page, and
                    keeping them here cost four columns that the mobile layout
                    then had to restack into a labelled card per row.

                    The link fills the cell rather than hugging the name, so the
                    whole row width is the target — a 44px-tall hit area instead
                    of the width of "Jo". */}
                {customers.map((c, i) => (
                  <tr key={c.id} className="stagger-item" style={{ animationDelay: `${i * 30}ms` }}>
                    <td data-label="Name">
                      <Link to={`/admin/customers/${c.id}`} className="customer-row-link">
                        <span className="fw-700 text-accent">{c.name}</span>
                        <ChevronRight size={16} aria-hidden="true" className="customer-row-chevron" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            totalItems={totalCount}
            currentPage={currentPage}
            itemsPerPage={perPage}
            onPageChange={setCurrentPage}
            onPerPageChange={(n) => { setPerPage(n); setCurrentPage(1); }}
          />
        </div>
      )}
    </div>
  );
};

export default CustomersPage;
