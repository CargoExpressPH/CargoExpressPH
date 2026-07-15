import { useEffect } from 'react';

const BASE_TITLE = 'CargoExpress PH';

/**
 * Sets the document title for the current page.
 * Automatically restores the base title on unmount.
 * @param {string} pageTitle — e.g. "Dashboard", "Orders", "Book Shipment"
 */
const usePageTitle = (pageTitle) => {
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} — ${BASE_TITLE}` : BASE_TITLE;
    return () => { document.title = BASE_TITLE; };
  }, [pageTitle]);
};

export default usePageTitle;
