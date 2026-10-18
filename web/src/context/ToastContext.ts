import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastApi {
  toast: (message: string, tone?: ToastTone) => void;
}

export const ToastContext = createContext<ToastApi>({ toast: () => undefined });

export function useToast() {
  return useContext(ToastContext);
}
