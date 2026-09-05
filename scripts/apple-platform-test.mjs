import assert from 'node:assert/strict';
import {
  isAppleMobileDevice,
  isAppleMobileWebPushVersion,
  isStandaloneWebApp,
} from '../src/lib/apple-platform.js';

const setBrowser = ({ userAgent, platform, maxTouchPoints = 0, standalone = false }) => {
  globalThis.window = {
    navigator: { userAgent, platform, maxTouchPoints, standalone },
    matchMedia: () => ({ matches: standalone }),
  };
};

delete globalThis.window;
assert.equal(isAppleMobileDevice(), false);

setBrowser({
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) Version/16.4 Mobile Safari/604.1',
  platform: 'iPhone',
});
assert.equal(isAppleMobileDevice(), true);
assert.equal(isAppleMobileWebPushVersion(), true);
assert.equal(isStandaloneWebApp(), false);

setBrowser({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 5,
  standalone: true,
});
assert.equal(isAppleMobileDevice(), true, 'desktop-UA iPad must be recognized');
assert.equal(isAppleMobileWebPushVersion(), true);
assert.equal(isStandaloneWebApp(), true);

setBrowser({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15',
  platform: 'MacIntel',
});
assert.equal(isAppleMobileDevice(), false, 'macOS Safari must stay a desktop');

setBrowser({
  userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_3 like Mac OS X) Version/16.3 Mobile Safari/604.1',
  platform: 'iPad',
});
assert.equal(isAppleMobileWebPushVersion(), false);

delete globalThis.window;
console.log('Apple platform checks passed.');
