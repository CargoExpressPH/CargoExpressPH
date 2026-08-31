import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getCustomers } from '../../lib/database';
import { CenteredSpinner } from '../../components/ui/Loader';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import { ChevronRight, Search, Users, User } from 'lucide-react';
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
        <CenteredSpinner />
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
        <div className="animate-fade-in">
          <div className="customers-grid">
            {customers.map((c, i) => (
              <Link to={`/admin/customers/${c.id}`} key={c.id} className="customer-card stagger-item" style={{ animationDelay: `${i * 20}ms` }}>
                <div className="customer-avatar">
                  <User size={20} strokeWidth={2.5} />
                </div>
                <div className="customer-info">
                  <div className="customer-name">{c.name}</div>
                  <div className="customer-meta">
                    {c.email || c.phone || 'No contact info'}
                    {c.address_province && <span className="customer-prov"> • {c.address_province}</span>}
                  </div>
                </div>
                <div className="customer-arrow">
                  <ChevronRight size={18} strokeWidth={2.5} />
                </div>
              </Link>
            ))}
          </div>

          <div className="card" style={{ padding: '4px 16px', background: 'transparent', border: 'none', boxShadow: 'none' }}>
            <Pagination
              totalItems={totalCount}
              currentPage={currentPage}
              itemsPerPage={perPage}
              onPageChange={setCurrentPage}
              onPerPageChange={(n) => { setPerPage(n); setCurrentPage(1); }}
            />
          </div>
          
          <style>{`
            .customers-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
              gap: 12px;
              margin-bottom: 24px;
            }
            .customer-card {
              display: flex;
              align-items: center;
              padding: 16px;
              background: var(--bg-primary);
              border-radius: var(--radius-md);
              border: 1px solid var(--border);
              text-decoration: none;
              transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
              box-shadow: 0 1px 3px rgba(0,0,0,0.02);
            }
            .customer-card:hover {
              transform: translateY(-2px);
              box-shadow: 0 4px 12px rgba(0,0,0,0.05);
              border-color: rgba(var(--primary-rgb), 0.3);
            }
            .customer-avatar {
              width: 44px;
              height: 44px;
              border-radius: 50%;
              background: rgba(var(--primary-rgb), 0.1);
              color: var(--primary);
              display: flex;
              align-items: center;
              justify-content: center;
              margin-right: 14px;
              flex-shrink: 0;
            }
            .customer-info {
              flex: 1;
              min-width: 0; 
            }
            .customer-name {
              font-weight: 700;
              color: var(--text-primary);
              font-size: 0.9375rem;
              margin-bottom: 3px;
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .customer-meta {
              font-size: 0.8125rem;
              color: var(--text-tertiary);
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }
            .customer-prov {
              opacity: 0.8;
            }
            .customer-arrow {
              color: var(--text-muted);
              margin-left: 12px;
              opacity: 0.5;
              transition: all 0.2s ease;
            }
            .customer-card:hover .customer-arrow {
              opacity: 1;
              color: var(--primary);
              transform: translateX(4px);
            }
          `}</style>
        </div>
      )}
    </div>
  );
};

export default CustomersPage;
