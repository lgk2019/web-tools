import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

// Toast 类型
type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// 类型样式映射
const TYPE_STYLES: Record<ToastType, { icon: string; bg: string; border: string; text: string }> = {
  success: { icon: '✓', bg: 'bg-emerald-50 dark:bg-emerald-900/30', border: 'border-emerald-200 dark:border-emerald-800', text: 'text-emerald-700 dark:text-emerald-300' },
  error: { icon: '✕', bg: 'bg-red-50 dark:bg-red-900/30', border: 'border-red-200 dark:border-red-800', text: 'text-red-700 dark:text-red-300' },
  warning: { icon: '!', bg: 'bg-amber-50 dark:bg-amber-900/30', border: 'border-amber-200 dark:border-amber-800', text: 'text-amber-700 dark:text-amber-300' },
  info: { icon: 'i', bg: 'bg-brand-50 dark:bg-brand-900/30', border: 'border-brand-200 dark:border-brand-800', text: 'text-brand-700 dark:text-brand-300' },
};

// 图标圆圈
const TYPE_ICON_BG: Record<ToastType, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-brand-500',
};

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, type, message }]);
    // 3 秒后自动移除
    setTimeout(() => remove(id), 3000);
  }, [remove]);

  const value: ToastContextValue = {
    toast,
    success: (m) => toast(m, 'success'),
    error: (m) => toast(m, 'error'),
    warning: (m) => toast(m, 'warning'),
    info: (m) => toast(m, 'info'),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Toast 容器 */}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => {
          const style = TYPE_STYLES[t.type];
          return (
            <div
              key={t.id}
              className={`animate-toast-in flex items-center gap-2.5 rounded-xl border ${style.bg} ${style.border} ${style.text} px-4 py-3 shadow-card backdrop-blur-md min-w-[240px] max-w-sm pointer-events-auto cursor-pointer`}
              onClick={() => remove(t.id)}
            >
              <span className={`shrink-0 w-5 h-5 rounded-full ${TYPE_ICON_BG[t.type]} text-white text-xs font-bold flex items-center justify-center`}>
                {style.icon}
              </span>
              <span className="text-sm font-medium break-all">{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

// Hook
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
