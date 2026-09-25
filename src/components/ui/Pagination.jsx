import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import CustomSelect from './CustomSelect';

const COMPACT_PAGINATION_QUERY = '(max-width: 480px)';

const getCompactPagination = () => (
  typeof window !== 'undefined'
  && window.matchMedia(COMPACT_PAGINATION_QUERY).matches
);

/**
 * Pagination — the one list footer used across the app.
 *
 *   Showing 1–15 of 42            [15 / page ▾]  ‹  1  2  3  ›
 *
 * Three siblings (summary, rows-per-page, page buttons) so the stylesheet can
 * lay them out as one row on wide screens and as two on phones (summary and
 * rows-per-page on top, page buttons centred beneath). Page buttons only
 * appear when there is more than one page.
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
  const [isCompact, setIsCompact] = useState(getCompactPagination);
  const totalPages = Math.max(1, Math.ceil(totalItems / itemsPerPage));
  const startItem = Math.min((currentPage - 1) * itemsPerPage + 1, totalItems);
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  useEffect(() => {
    const mediaQuery = window.matchMedia(COMPACT_PAGINATION_QUERY);
    const updateCompactPagination = () => setIsCompact(mediaQuery.matches);

    updateCompactPagination();
    mediaQuery.addEventListener?.('change', updateCompactPagination);

    return () => mediaQuery.removeEventListener?.('change', updateCompactPagination);
  }, []);

  if (totalItems <= 0) return null;

  // Build page numbers with ellipsis
  const getPageNumbers = () => {
    if (isCompact && totalPages > 3) {
      if (currentPage <= 2) return [1, 2, '...', totalPages];
      if (currentPage >= totalPages - 1) return [1, '...', totalPages - 1, totalPages];
      return [1, '...', currentPage, '...', totalPages];
    }

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

  // Per-page choices always include the current size, so a caller using a
  // size outside the defaults still shows its real value.
  const sizeOptions = perPageOptions.includes(itemsPerPage)
    ? perPageOptions
    : [...perPageOptions, itemsPerPage].sort((a, b) => a - b);

  return (
    <nav className="pagination-wrap" aria-label="Pagination">
      <p className="pagination-info" aria-live="polite">
        Showing <strong>{startItem}–{endItem}</strong> of <strong>{totalItems}</strong>
      </p>

      {onPerPageChange && (
        <div className="pagination-size">
          <CustomSelect
            className="pagination-per-page"
            value={itemsPerPage}
            onChange={(e) => onPerPageChange(Number(e.target.value))}
            aria-label="Items per page"
          >
            {sizeOptions.map(n => (
              <option key={n} value={n}>{n} / page</option>
            ))}
          </CustomSelect>
        </div>
      )}

      {totalPages > 1 && (
        <div className="pagination-controls">
          <button
            type="button"
            className="pagination-btn pagination-step"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>

          {getPageNumbers().map((page, i) =>
            page === '...' ? (
              <span key={`e${i}`} className="pagination-ellipsis" aria-hidden="true">…</span>
            ) : (
              <button
                type="button"
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
            type="button"
            className="pagination-btn pagination-step"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </nav>
  );
};

export default Pagination;
