/**
 * Build metadata injected by Vite.
 *
 * package.json is the single source of truth for the release version. Vercel's
 * Git SHA identifies the exact deployed source without turning the UI into a
 * second version registry that can silently fall out of sync.
 */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION;
export const APP_BUILD_ID = import.meta.env.VITE_APP_BUILD_ID || null;
