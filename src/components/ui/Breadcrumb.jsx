import { Link } from 'react-router-dom';
import { ChevronRight, Home } from 'lucide-react';

/**
 * Breadcrumb — Navigation trail
 *
 * @param {Array} items – [{ label, to? }] – last item has no `to` (current page)
 */
const Breadcrumb = ({ items = [] }) => {
  if (items.length === 0) return null;

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <ol className="breadcrumb-list">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          return (
            <li key={i} className="breadcrumb-item">
              {i > 0 && (
                <ChevronRight size={13} className="breadcrumb-sep" aria-hidden="true" />
              )}
              {isLast ? (
                <span className="breadcrumb-current" aria-current="page">
                  {i === 0 && <Home size={13} className="breadcrumb-home-icon" aria-hidden="true" />}
                  <span className="breadcrumb-text">{item.label}</span>
                </span>
              ) : (
                <Link to={item.to} className="breadcrumb-link">
                  {i === 0 && <Home size={13} className="breadcrumb-home-icon" aria-hidden="true" />}
                  <span className="breadcrumb-text">{item.label}</span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

export default Breadcrumb;
