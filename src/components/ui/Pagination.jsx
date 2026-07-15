import { ChevronLeft, ChevronRight } from 'lucide-react';
import CustomSelect from './CustomSelect';

/**
 * Pagination — Reusable pagination controls
 *
 * @param {number} totalItems     – Total items count
 * @param {number} currentPage    – Current 1-indexed page
 * @param {number} itemsPerPage   – Items per page
 * @param {function} onPageChange – (page) => void
 * @param {function} onPerPageChange – (perPage) => void (optional)
 * @param {number[]} perPageOptions – Options for items per page
 */
const Pagination = ({
  totalItems,
  currentPage,
  itemsPerPage,
  onPageChange,
  onPerPageChange,
  perPageOptions = [10, 15, 25, 50],
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const startItem = Math.min((currentPage - 1) * itemsPerPage + 1, totalItems);
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  if (totalItems <= 0) return null;

  // Build page numbers with ellipsis
  const getPageNumbers = () => {
    const pages = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (currentPage > 3) pages.push('...');

      const start = Math.max(2, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 1);
      for (let i = start; i <= end; i++) pages.push(i);

      if (currentPage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div className="pagination-wrap" role="navigation" aria-label="Pagination">
      {/* Info */}
      <div className="pagination-info">
        <span>
          Showing <strong>{startItem}–{endItem}</strong> of <strong>{totalItems}</strong>
        </span>
        {onPerPageChange && (
          <CustomSelect
            className="pagination-per-page"
            value={itemsPerPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            aria-label="Items per page"
          >
            {perPageOptions.map(n => (
              <option key={n} value={n}>{n} / page</option>
            ))}
          </CustomSelect>
        )}
      </div>

      {/* Controls */}
      {totalPages > 1 && (
        <div className="pagination-controls">
          <button
            className="pagination-btn"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>

          {getPageNumbers().map((page, i) =>
            page === '...' ? (
              <span key={`e${i}`} className="pagination-ellipsis">…</span>
            ) : (
              <button
                key={page}
                className={`pagination-btn pagination-num ${currentPage === page ? 'active' : ''}`}
                onClick={() => onPageChange(page)}
                aria-label={`Page ${page}`}
                aria-current={currentPage === page ? 'page' : undefined}
              >
                {page}
              </button>
            )
          )}

          <button
            className="pagination-btn"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
};

export default Pagination;
