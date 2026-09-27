import { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';

const ThemeContext = createContext(null);

const STORAGE_KEY = 'cargoexpress_theme';

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
  const transitionFrame = useRef(null);

  const applyTheme = useCallback((t, { animate = true } = {}) => {
    if (typeof document === 'undefined') return;

    const root = document.documentElement;
    if (transitionFrame.current !== null) {
      cancelAnimationFrame(transitionFrame.current);
      transitionFrame.current = null;
    }

    // Suppress each component's own color transition for the theme change.
    // Remove the class after one painted frame so normal hover effects resume.
    root.classList.toggle('theme-transition', animate);
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;
    if (animate) {
      transitionFrame.current = requestAnimationFrame(() => {
        transitionFrame.current = requestAnimationFrame(() => {
          root.classList.remove('theme-transition');
          transitionFrame.current = null;
        });
      });
    }
  }, []);

  useLayoutEffect(() => {
    applyTheme(theme, { animate: hasMounted.current });
    hasMounted.current = true;
  }, [theme, applyTheme]);

  useEffect(() => () => {
    if (transitionFrame.current !== null) {
      cancelAnimationFrame(transitionFrame.current);
      transitionFrame.current = null;
    }
    document.documentElement.classList.remove('theme-transition');
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
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* localStorage may be blocked in private mode */ }
      return next;
    });
  }, []);

  const setThemeMode = useCallback((mode) => {
    if (mode !== 'dark' && mode !== 'light') return;
    setTheme(mode);
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* localStorage may be blocked in private mode */ }
  }, []);

  const contextValue = useMemo(
    () => ({ theme, toggleTheme, setThemeMode }),
    [theme, toggleTheme, setThemeMode]
  );

  return (
    <ThemeContext.Provider value={contextValue}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
};
