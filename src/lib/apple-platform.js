const browserNavigator = () => (
  typeof window !== 'undefined' ? window.navigator : null
);

/** Detect iPhone/iPod and iPads that deliberately expose a macOS user agent. */
export const isAppleMobileDevice = () => {
  const nav = browserNavigator();
  if (!nav) return false;

  return /iphone|ipad|ipod/i.test(nav.userAgent)
    || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
};

export const isStandaloneWebApp = () => (
  typeof window !== 'undefined'
  && (window.navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true)
);

/** Safari/iOS 16.4+ is required; Safari's version survives frozen OS UAs. */
export const isAppleMobileWebPushVersion = () => {
  const nav = browserNavigator();
  if (!nav || !isAppleMobileDevice()) return false;

  const match = nav.userAgent.match(/OS (\d+)[_.](\d+)/i)
    || nav.userAgent.match(/Version\/(\d+)(?:\.(\d+))?/i);
  if (!match) return false;

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2] || '0', 10);
  return major > 16 || (major === 16 && minor >= 4);
};
