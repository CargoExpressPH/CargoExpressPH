import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { getCustomers, withTimeout } from '../../lib/database';
import { SkeletonTableRow } from '../../components/ui/SkeletonLoader';
import EmptyState from '../../components/ui/EmptyState';
import Pagination from '../../components/ui/Pagination';
import { Search, Users } from 'lucide-react';
import usePageTitle from '../../hooks/usePageTitle';

const CustomersPage = () => {
  usePageTitle('Customers');
  const [customers, setCustomers] = useState([]); 
  const [loading, setLoading] = useState(true); 
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [perPage, setPerPage] = useState(15);
  
  useEffect(() => { loadCustomers(); }, []);
  const loadCustomers = async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await withTimeout(getCustomers());
      setCustomers(data || []);
    } catch (e) {
      setError(e.message || 'Failed to load customers.');
    } finally {
      setLoading(false);
    }
  };
  const filtered = customers.filter(c => !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.email?.toLowerCase().includes(search.toLowerCase()));
  const totalFiltered = filtered.length;
  const paginated = filtered.slice((currentPage - 1) * perPage, currentPage * perPage);
  const handleSearchChange = (e) => { setSearch(e.target.value); setCurrentPage(1); };

  return (
    <div className="page-transition">
      <div className="admin-page-header">
        <div>
          <h1 className="admin-page-title">Customers</h1>
          <p className="admin-page-subtitle">Customer accounts, contact details, and booking history.</p>
        </div>
        <div className="admin-page-meta">
          <span className="badge badge-info">{filtered.length} shown</span>
          <span className="badge">{customers.length} total</span>
        </div>
      </div>
      <div className="admin-toolbar">
        <div className="search-box" role="search">
          <Search size={16} className="search-icon" aria-hidden="true" />
          <input aria-label="Search customers" placeholder="Search customers..." value={search} onChange={handleSearchChange} />
        </div>
      </div>
      {loading ? (
        <div className="card animate-fade-in">
          <div className="table-container">
            <table className="data-table">
              <caption className="sr-only">List of registered customers (loading)</caption>
              <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Province</th><th>Joined</th></tr></thead>
              <tbody>
                {Array.from({ length: 5 }, (_, i) => <SkeletonTableRow key={i} cols={5} />)}
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
      ) : (
        <div className="card admin-section-card admin-table-card animate-fade-in">
          <div className="table-container">
            <table className="data-table">
              <caption className="sr-only">List of registered customers</caption>
              <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Province</th><th>Joined</th></tr></thead>
              <tbody>
                {paginated.map((c, i) => (
                  <tr key={c.id} className="stagger-item" style={{ animationDelay: `${i * 30}ms` }}>
                    <td data-label="Name"><Link to={`/admin/customers/${c.id}`} className="fw-700 text-accent">{c.name}</Link></td>
                    <td data-label="Email" className="text-sm">{c.email}</td><td data-label="Phone" className="text-sm">{c.phone || '—'}</td>
                    <td data-label="Province" className="text-sm">{c.address_province || '—'}</td>
                    <td data-label="Joined" className="text-xs text-secondary">{new Date(c.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-0 b-0">
                      <EmptyState
                        icon={Users}
                        title="No customers found"
                        description="Try adjusting your search criteria."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            totalItems={totalFiltered}
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
