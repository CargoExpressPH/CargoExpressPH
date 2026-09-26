import { useEffect, useRef } from 'react';
import { useLocation, useMatches } from 'react-router-dom';

/**
 * Real-user performance reporting with Vercel Speed Insights (free tier).
 *
 * Uses Vercel's documented plain-script setup instead of an npm package: a
 * small queue stub plus the same-origin script Vercel serves on every
 * deployment at /_vercel/speed-insights/script.js (allowed by the CSP's
 * script-src 'self'). Skipped in dev and on localhost, where that script
 * does not exist.
 */
const SCRIPT_SRC = '/_vercel/speed-insights/script.js';

/**
 * Query strings and hashes never leave the browser: tracking numbers,
 * unsubscribe tokens and password-reset tokens travel in them.
 */
const stripQueryAndHash = (event) => {
  try {
    const url = new URL(event.url);
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  } catch {
    return event;
  }
};

/**
 * Turns /customer/orders/8f1c… into /customer/orders/[id] so every order,
 * trip or customer page is grouped as one route in the dashboard.
 */
const toRoutePattern = (pathname, params) => {
  let route = pathname;
  for (const [key, value] of Object.entries(params || {})) {
    if (!value) continue;
    const label = key === '*' ? '[...rest]' : `[${key}]`;
    const encoded = value.split('/').map(encodeURIComponent).join('/');
    for (const candidate of new Set([value, encoded])) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      route = route.replace(new RegExp(`/${escaped}(?=/|$)`), `/${label}`);
    }
  }
  return route;
};

const isLocalHost = () => ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);

export default function PerformanceInsights() {
  const { pathname } = useLocation();
  const matches = useMatches();
  const route = toRoutePattern(pathname, matches[matches.length - 1]?.params);
  const routeRef = useRef(route);
  const scriptRef = useRef(null);
  routeRef.current = route;

  useEffect(() => {
    if (!import.meta.env.PROD || isLocalHost()) return;

    window.si = window.si || function si(...args) {
      (window.siq = window.siq || []).push(args);
    };
    window.si('beforeSend', stripQueryAndHash);

    let script = document.head.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = SCRIPT_SRC;
      script.defer = true;
      script.dataset.route = routeRef.current;
      document.head.appendChild(script);
    }
    scriptRef.current = script;
  }, []);

  useEffect(() => {
    if (scriptRef.current) scriptRef.current.dataset.route = route;
  }, [route]);

  return null;
}
