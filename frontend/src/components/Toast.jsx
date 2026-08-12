import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { haptic } from '../api.js';
import { CheckCircleIcon, AlertIcon, InfoIcon } from './icons.jsx';

/**
 * Toast system — transient, non-blocking feedback at the top of the screen.
 * Pairs with haptics: success → success buzz, error → error buzz.
 */

const ToastContext = createContext(null);

const TOAST_ICON = { success: CheckCircleIcon, error: AlertIcon, info: InfoIcon };
const TOAST_MS = 3400;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind, message) => {
    const id = ++idRef.current;
    setToasts((list) => [...list.slice(-2), { id, kind, message }]);
    if (kind === 'success') haptic.success();
    else if (kind === 'error') haptic.error();
    else haptic.light();
    setTimeout(() => dismiss(id), TOAST_MS);
  }, [dismiss]);

  const toast = useMemo(() => ({
    success: (message) => push('success', message),
    error: (message) => push('error', message),
    info: (message) => push('info', message),
  }), [push]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-wrap">
        {toasts.map(({ id, kind, message }) => {
          const Icon = TOAST_ICON[kind] || InfoIcon;
          return (
            <div key={id} className={`toast ${kind}`}>
              <Icon />
              <span>{message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
