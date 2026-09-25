export const SITE_ORIGIN = 'https://www.cargoexpress-ph.online';

// The social preview image declared in index.html. 1200×630 is the size
// Facebook/Messenger, X and LinkedIn all crop to without letterboxing.
export const SOCIAL_IMAGE = {
  url: `${SITE_ORIGIN}/images/og-image.jpg`,
  width: 1200,
  height: 630,
};

// These URLs have public content and are included in the sitemap. The build
// uses the same data to write HTML that crawlers can read before React loads.
// Keep titles within ~60 characters and descriptions within ~160 so search
// results show them whole; seo-contract-test.mjs enforces both.
export const PUBLIC_PAGES = {
  '/': {
    title: 'CargoExpress PH — Manila to Bohol Cargo Booking & Tracking',
    description: 'Book door-to-door cargo between Manila and Bohol, check trip schedules, and track your shipment online with CargoExpress PH.',
    heading: 'Door-to-door cargo between Manila and Bohol',
    summary: 'Check upcoming Manila–Bohol trips, book a cargo pickup, and follow your shipment with its tracking number.',
  },
  '/about': {
    title: 'About CargoExpress PH — Manila & Bohol Cargo Service',
    description: 'Learn about CargoExpress PH, a door-to-door cargo service between Manila and Bohol: coverage areas, trip schedules, and contact details.',
    heading: 'About CargoExpress PH',
    summary: 'Door-to-door cargo forwarding between Manila and Bohol. See our coverage areas, trip schedules, customer feedback, and contact details.',
  },
  '/track': {
    title: 'Track Your Cargo Shipment — CargoExpress PH',
    description: 'Enter your CargoExpress PH tracking number to check the latest status of your cargo shipment between Manila and Bohol.',
    heading: 'Track your shipment',
    summary: 'Use the tracking number for your booking to check the latest status of your Manila–Bohol cargo.',
  },
  '/schedules': {
    title: 'Manila–Bohol Trip Schedules — CargoExpress PH',
    description: 'See upcoming CargoExpress PH trip schedules between Manila and Bohol and check available routes before booking your cargo.',
    heading: 'Manila–Bohol trip schedules',
    summary: 'Review upcoming trips and routes between Manila and Bohol before arranging a cargo booking.',
  },
  '/faq': {
    title: 'Cargo Shipping Help & Guidelines — CargoExpress PH',
    description: 'CargoExpress PH guidelines for booking, pickup, restricted items, tracking, and delivery of cargo between Manila and Bohol.',
    heading: 'Help and shipping guidelines',
    summary: 'Find guidance for preparing cargo, booking, pickup, restricted items, tracking, and delivery.',
  },
  '/terms': {
    title: 'Terms of Service — CargoExpress PH',
    description: 'Read the CargoExpress PH terms for accounts, cargo bookings, payments, and use of the service.',
    heading: 'Terms of Service',
    summary: 'Read the terms that apply to CargoExpress PH accounts, bookings, payments, and services.',
  },
  '/privacy': {
    title: 'Privacy Policy — CargoExpress PH',
    description: 'Read how CargoExpress PH handles personal information for accounts, bookings, tracking, and support.',
    heading: 'Privacy Policy',
    summary: 'Learn how CargoExpress PH handles personal information for bookings and related services.',
  },
};

// Written into every public page as JSON-LD. Only facts that don't change
// from the admin Company Information screen belong here — phone numbers and
// addresses are editable in the database, so a copy baked in at build time
// would go stale the first time an admin changes them.
export function structuredDataFor(path, page) {
  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  const organization = {
    '@type': 'Organization',
    '@id': `${SITE_ORIGIN}/#organization`,
    name: 'CargoExpress PH',
    alternateName: 'Cargo Express PH',
    url: `${SITE_ORIGIN}/`,
    logo: { '@type': 'ImageObject', url: `${SITE_ORIGIN}/images/logo.png`, width: 2000, height: 2000 },
    description: PUBLIC_PAGES['/'].description,
    areaServed: [
      { '@type': 'Place', name: 'Metro Manila, Philippines' },
      { '@type': 'Place', name: 'Bohol, Philippines' },
    ],
  };
  const website = {
    '@type': 'WebSite',
    '@id': `${SITE_ORIGIN}/#website`,
    name: 'CargoExpress PH',
    alternateName: 'Cargo Express PH',
    url: `${SITE_ORIGIN}/`,
    description: PUBLIC_PAGES['/'].description,
    inLanguage: 'en-PH',
    publisher: { '@id': organization['@id'] },
  };
  const graph = path === '/'
    ? [organization, website]
    : [{
      '@type': 'WebPage',
      '@id': `${url}#webpage`,
      name: page.title,
      url,
      description: page.description,
      inLanguage: 'en-PH',
      isPartOf: { '@id': website['@id'] },
      publisher: { '@id': organization['@id'] },
    }];
  return { '@context': 'https://schema.org', '@graph': graph };
}
