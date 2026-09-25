import { useEffect } from 'react';
import { PUBLIC_PAGES, SITE_ORIGIN } from '../seo/publicPages';

const BASE_TITLE = 'CargoExpress PH';

/**
 * Sets the document title and OpenGraph/Twitter meta tags for the current page.
 * Restores the previous title and meta tag values on unmount.
 * @param {string} pageTitle — e.g. "Dashboard", "Orders", "Book Shipment"
 * @param {string} [description] — Optional dynamic meta description
 */
const usePageTitle = (pageTitle, description) => {
  useEffect(() => {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    const publicPage = PUBLIC_PAGES[path];
    const fullTitle = publicPage?.title || (pageTitle ? `${pageTitle} — ${BASE_TITLE}` : BASE_TITLE);
    const previousTitle = document.title;
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
      upsertMetaTag('name', 'robots', publicPage ? 'index, follow' : 'noindex, nofollow'),
    ];

    const canonical = document.querySelector('link[rel="canonical"]');
    const previousCanonical = canonical?.getAttribute('href');
    if (publicPage) {
      const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
      if (canonical) canonical.setAttribute('href', url);
      restorers.push(upsertMetaTag('property', 'og:url', url));
    } else {
      canonical?.removeAttribute('href');
    }

    if (description || publicPage) {
      const pageDescription = description || publicPage.description;
      restorers.push(
        upsertMetaTag('name', 'description', pageDescription),
        upsertMetaTag('property', 'og:description', pageDescription),
        upsertMetaTag('name', 'twitter:description', pageDescription),
      );
    }

    return () => {
      document.title = previousTitle;
      if (canonical) {
        if (previousCanonical === null) canonical.removeAttribute('href');
        else canonical.setAttribute('href', previousCanonical);
      }
      restorers.forEach((restore) => restore());
    };
  }, [pageTitle, description]);
};

export default usePageTitle;
