// Shared client-side app origin, used anywhere a deep link back into the app
// needs to be built (e.g. QR code payloads). Same fallback AuthContext.jsx
// uses for its own redirect URLs, so behavior stays identical whether or not
// VITE_APP_URL is set for the current environment.
export const getAppUrl = () => import.meta.env.VITE_APP_URL || 'https://cargoexpress-ph.vercel.app';
