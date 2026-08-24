import { useEffect } from 'react';

const BASE_TITLE = 'CargoExpress PH';

/**
 * Sets the document title and OpenGraph/Twitter meta tags for the current page.
 * Restores the base title and previous meta tag values on unmount.
 * @param {string} pageTitle — e.g. "Dashboard", "Orders", "Book Shipment"
 * @param {string} [description] — Optional dynamic meta description
 */
const usePageTitle = (pageTitle, description) => {
  useEffect(() => {
    const fullTitle = pageTitle ? `${pageTitle} — ${BASE_TITLE}` : BASE_TITLE;
    document.title = fullTitle;

    // Upserts a meta tag and returns a function that restores its previous state
    const upsertMetaTag = (attrName, attrValue, content) => {
      let el = document.querySelector(`meta[${attrName}="${attrValue}"]`);
      const created = !el;
      const prevContent = el ? el.getAttribute('content') : null;
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attrName, attrValue);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
      return () => {
        if (created) {
          el.remove();
        } else if (prevContent !== null) {
          el.setAttribute('content', prevContent);
        }
      };
    };

    const restorers = [
      upsertMetaTag('property', 'og:title', fullTitle),
      upsertMetaTag('name', 'twitter:title', fullTitle),
    ];

    if (description) {
      restorers.push(
        upsertMetaTag('name', 'description', description),
        upsertMetaTag('property', 'og:description', description),
        upsertMetaTag('name', 'twitter:description', description),
      );
    }

    return () => {
      document.title = BASE_TITLE;
      restorers.forEach((restore) => restore());
    };
  }, [pageTitle, description]);
};

export default usePageTitle;
