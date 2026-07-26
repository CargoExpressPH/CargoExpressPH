import { useState, useRef, useCallback, useEffect } from 'react';
import { Loader } from 'lucide-react';

/**
 * Native-feeling Mobile Pull-to-Refresh Component
 * Wraps mobile pages/containers and triggers async data refetching on pull-down gesture.
 */
const PullToRefresh = ({ onRefresh, children, disabled = false, className = '' }) => {
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startYRef = useRef(0);
  const currentYRef = useRef(0);
  const isDraggingRef = useRef(false);
  const containerRef = useRef(null);

  const THRESHOLD = 64; // Distance in px to trigger refresh
  const MAX_PULL = 100; // Hard max pull distance limit

  const handleTouchStart = useCallback((e) => {
    if (disabled || refreshing) return;
    
    // Only allow pull-to-refresh if container is scrolled to top
    const scrollTop = window.scrollY || document.documentElement.scrollTop || (containerRef.current ? containerRef.current.scrollTop : 0);
    if (scrollTop > 5) return;

    startYRef.current = e.touches[0].clientY;
    currentYRef.current = e.touches[0].clientY;
    isDraggingRef.current = true;
  }, [disabled, refreshing]);

  const handleTouchMove = useCallback((e) => {
    if (!isDraggingRef.current || disabled || refreshing) return;

    const currentY = e.touches[0].clientY;
    const diffY = currentY - startYRef.current;

    const scrollTop = window.scrollY || document.documentElement.scrollTop || (containerRef.current ? containerRef.current.scrollTop : 0);

    if (diffY > 0 && scrollTop <= 5) {
      // Apply rubberband resistance factor (0.45)
      const calculatedPull = Math.min(MAX_PULL, diffY * 0.45);
      setPullDistance(calculatedPull);

      // Prevent native overscroll browser behavior while pulling
      if (e.cancelable && calculatedPull > 10) {
        e.preventDefault();
      }
    } else {
      setPullDistance(0);
    }
  }, [disabled, refreshing]);

  const handleTouchEnd = useCallback(async () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    if (pullDistance >= THRESHOLD && onRefresh && !refreshing) {
      setRefreshing(true);
      setPullDistance(THRESHOLD); // Hold indicator at threshold while fetching

      try {
        await onRefresh();
      } catch {
        // Silently catch errors so UI resets smoothly
      } finally {
        setRefreshing(false);
        setPullDistance(0);
      }
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, onRefresh, refreshing]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Passive false listener required to enable e.preventDefault() on touchmove
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  const progressRatio = Math.min(1, pullDistance / THRESHOLD);

  return (
    <div ref={containerRef} className={`pull-to-refresh-container ${className}`} style={{ position: 'relative' }}>
      {/* Pull Indicator Banner */}
      <div
        className="pull-to-refresh-indicator"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: `${pullDistance}px`,
          overflow: 'hidden',
          pointerEvents: 'none',
          zIndex: 90,
          transition: isDraggingRef.current ? 'none' : 'height 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
        aria-hidden="true"
      >
        <div
          style={{
            transform: `scale(${0.6 + progressRatio * 0.4}) rotate(${progressRatio * 180}deg)`,
            opacity: Math.max(0.2, progressRatio),
            transition: isDraggingRef.current ? 'none' : 'transform 0.3s ease, opacity 0.3s ease',
            background: 'var(--surface-raised, #ffffff)',
            borderRadius: '50%',
            padding: '8px',
            boxShadow: 'var(--shadow-md, 0 8px 20px rgba(0,0,0,0.12))',
            border: '1px solid var(--border-light, #e2e8f0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Loader
            size={20}
            style={{
              color: 'var(--primary, #16A34A)',
              animation: refreshing ? 'spin 0.8s linear infinite' : 'none',
            }}
          />
        </div>
      </div>

      {/* Main Content */}
      <div
        className="pull-to-refresh-content"
        style={{
          transform: `translateY(${pullDistance}px)`,
          transition: isDraggingRef.current ? 'none' : 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
      >
        {children}
      </div>
    </div>
  );
};

export default PullToRefresh;
