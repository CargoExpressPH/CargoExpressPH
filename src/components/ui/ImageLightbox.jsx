import { useState, useEffect, useRef, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, ChevronLeft, ChevronRight } from 'lucide-react';
import FocusTrap from './FocusTrap';

/**
 * ImageLightbox — Full-screen image viewer with zoom, pan, pinch, and swipe.
 *
 * Usage:
 *   <ImageLightbox
 *     images={['/photo1.jpg', '/photo2.jpg']}
 *     initialIndex={0}
 *     onClose={() => setOpen(false)}
 *   />
 */
const ImageLightbox = ({ images = [], initialIndex = 0, onClose }) => {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef(0);
  const containerRef = useRef(null);

  const resetTransform = useCallback(() => {
    setScale(1);
    setRotation(0);
    setPosition({ x: 0, y: 0 });
  }, []);

  // Keyboard controls
  useEffect(() => {
    const handleKey = (e) => {
      switch (e.key) {
        case 'Escape': onClose(); break;
        case 'ArrowLeft': if (index > 0) { setIndex(i => i - 1); resetTransform(); } break;
        case 'ArrowRight': if (index < images.length - 1) { setIndex(i => i + 1); resetTransform(); } break;
        case '+':
        case '=': setScale(s => Math.min(s + 0.5, 5)); break;
        case '-': setScale(s => Math.max(s - 0.5, 0.5)); break;
        default: break;
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [index, images.length, onClose, resetTransform]);

  // Lock body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Mouse drag for pan
  const handleMouseDown = (e) => {
    if (scale <= 1) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };

  const handleMouseMove = (e) => {
    if (!isDragging) return;
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };

  const handleMouseUp = () => setIsDragging(false);

  // Touch: pinch-to-zoom + swipe
  const handleTouchStart = (e) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      lastTouchDist.current = dist;
    } else if (e.touches.length === 1 && scale > 1) {
      setIsDragging(true);
      dragStart.current = {
        x: e.touches[0].clientX - position.x,
        y: e.touches[0].clientY - position.y,
      };
    }
  };

  const handleTouchMove = (e) => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (lastTouchDist.current > 0) {
        const delta = dist / lastTouchDist.current;
        setScale(s => Math.min(Math.max(s * delta, 0.5), 5));
      }
      lastTouchDist.current = dist;
    } else if (isDragging && e.touches.length === 1) {
      setPosition({
        x: e.touches[0].clientX - dragStart.current.x,
        y: e.touches[0].clientY - dragStart.current.y,
      });
    }
  };

  const handleTouchEnd = (e) => {
    lastTouchDist.current = 0;
    setIsDragging(false);

    // Swipe detection when not zoomed
    if (scale <= 1 && e.changedTouches.length === 1) {
      const endX = e.changedTouches[0].clientX;
      const startX = dragStart.current.x + position.x;
      const diff = endX - startX;
      if (Math.abs(diff) > 60) {
        if (diff > 0 && index > 0) { setIndex(i => i - 1); resetTransform(); }
        if (diff < 0 && index < images.length - 1) { setIndex(i => i + 1); resetTransform(); }
      }
    }
  };

  // Double-tap / double-click to zoom
  const handleDoubleClick = () => {
    if (scale > 1) {
      resetTransform();
    } else {
      setScale(2.5);
    }
  };

  // Mouse wheel zoom
  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.3 : 0.3;
    setScale(s => Math.min(Math.max(s + delta, 0.5), 5));
  };

  const goTo = (dir) => {
    const next = index + dir;
    if (next >= 0 && next < images.length) {
      setIndex(next);
      resetTransform();
    }
  };

  if (!images.length) return null;

  return (
    <FocusTrap active>
    <div
      className="lightbox-overlay"
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-labelledby="image-lightbox-title"
      aria-describedby={images.length > 1 ? 'image-lightbox-counter' : undefined}
    >
      <h2 id="image-lightbox-title" className="sr-only">Image viewer</h2>
      {/* Top bar */}
      <div className="lightbox-toolbar">
        <span className="lightbox-counter" id="image-lightbox-counter" aria-live="polite">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ''}
        </span>
        <div className="lightbox-actions">
          <button onClick={() => setScale(s => Math.min(s + 0.5, 5))} title="Zoom in" aria-label="Zoom in image" type="button">
            <ZoomIn size={18} />
          </button>
          <button onClick={() => setScale(s => Math.max(s - 0.5, 0.5))} title="Zoom out" aria-label="Zoom out image" type="button">
            <ZoomOut size={18} />
          </button>
          <button onClick={() => setRotation(r => r + 90)} title="Rotate" aria-label="Rotate image" type="button">
            <RotateCw size={18} />
          </button>
          <button onClick={onClose} title="Close" aria-label="Close image viewer" type="button">
            <X size={20} />
          </button>
        </div>
      </div>

      {/* Navigation arrows */}
      {images.length > 1 && index > 0 && (
        <button className="lightbox-nav lightbox-prev" onClick={() => goTo(-1)} type="button" aria-label="Previous image">
          <ChevronLeft size={28} />
        </button>
      )}
      {images.length > 1 && index < images.length - 1 && (
        <button className="lightbox-nav lightbox-next" onClick={() => goTo(1)} type="button" aria-label="Next image">
          <ChevronRight size={28} />
        </button>
      )}

      {/* Image */}
      <div
        className="lightbox-image-container"
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in' }}
      >
        <img
          src={images[index]}
          alt={`Image ${index + 1} of ${images.length}`}
          className="lightbox-image"
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale}) rotate(${rotation}deg)`,
            transition: isDragging ? 'none' : 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          draggable={false}
        />
      </div>

      {/* Thumbnail strip */}
      {images.length > 1 && (
        <div className="lightbox-thumbnails">
          {images.map((src, i) => (
            <button
              key={i}
              className={`lightbox-thumb ${i === index ? 'active' : ''}`}
              onClick={() => { setIndex(i); resetTransform(); }}
              type="button"
              aria-label={`View image ${i + 1} of ${images.length}`}
              aria-current={i === index ? 'true' : undefined}
            >
              <img src={src} alt={`Thumbnail ${i + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
    </FocusTrap>
  );
};

export default ImageLightbox;
