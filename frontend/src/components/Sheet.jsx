import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { haptic } from '../api.js';

/**
 * Bottom sheet — the primary surface for confirmations and detail views.
 * Slides up over a scrim; closes on scrim tap. Escape key also closes.
 */
export default function Sheet({ open, onClose, children, closeLabel = 'Close' }) {
  const scrollRef = useRef(null);
  const closeRef = useRef(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') onCloseRef.current?.();
    };
    document.documentElement.classList.add('sheet-open');
    window.addEventListener('keydown', onKey);
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      closeRef.current?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey);
      document.documentElement.classList.remove('sheet-open');
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const close = () => {
    haptic.light();
    onClose?.();
  };

  return createPortal(
    <div className="sheet-layer">
      <div className="sheet-scrim" onClick={close} />
      <div className="sheet">
        <div className="sheet-inner" role="dialog" aria-modal="true">
          <div className="sheet-chrome">
            <div className="sheet-handle" />
            <button
              ref={closeRef}
              className="sheet-close"
              type="button"
              aria-label={closeLabel}
              onClick={close}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          <div ref={scrollRef} className="sheet-scroll">
            {children}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
