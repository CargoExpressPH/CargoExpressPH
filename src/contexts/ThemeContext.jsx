import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'cargoexpress_theme';
const TRANSITION_DURATION = 400;

const getSystemTheme = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const getStoredTheme = () => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null;
  }
};

const getInitialTheme = () => getStoredTheme() || getSystemTheme();

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState(getInitialTheme);
  const hasMounted = useRef(false);
  const transitionTimer = useRef(null);

  const applyTheme = useCallback((t, { animate = true } = {}) => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;

    if (transitionTimer.current) {
      clearTimeout(transitionTimer.current);
      transitionTimer.current = null;
    }

    if (!animate) {
      root.classList.remove('theme-transition');
      return;
    }

    root.classList.add('theme-transition');
    transitionTimer.current = setTimeout(() => {
      root.classList.remove('theme-transition');
      transitionTimer.current = null;
    }, TRANSITION_DURATION);
  }, []);

  useLayoutEffect(() => {
    applyTheme(theme, { animate: hasMounted.current });
    hasMounted.current = true;
  }, [theme, applyTheme]);

  useEffect(() => () => {
    if (transitionTimer.current) {
      clearTimeout(transitionTimer.current);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e) => {
      if (!getStoredTheme()) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
  }, []);

  const setThemeMode = useCallback((mode) => {
    if (mode !== 'dark' && mode !== 'light') return;
    setTheme(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
};
