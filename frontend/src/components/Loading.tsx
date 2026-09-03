// 加载旋转图标
export function Spinner({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin-fast ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        strokeOpacity="0.25"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// 全屏加载遮罩
export function LoadingOverlay({ message = '处理中...' }: { message?: string }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white/70 dark:bg-gray-900/70 backdrop-blur-sm rounded-xl animate-fade-in">
      <Spinner size={32} className="text-brand-600" />
      <p className="text-sm text-gray-500 dark:text-gray-400">{message}</p>
    </div>
  );
}

// 按钮内加载状态
export function ButtonSpinner() {
  return <Spinner size={16} className="text-current" />;
}

// 骨架屏：矩形
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}

// 骨架屏：工具卡片
export function ToolCardSkeleton() {
  return (
    <div className="card p-4 flex flex-col gap-2">
      <Skeleton className="w-11 h-11 rounded-lg" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-4/5" />
    </div>
  );
}

// 空状态
export function EmptyState({
  icon = '📭',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center animate-fade-in">
      <p className="text-5xl mb-3 opacity-60">{icon}</p>
      <h3 className="text-base font-medium text-gray-600 dark:text-gray-300">{title}</h3>
      {description && (
        <p className="text-sm text-gray-400 mt-1 max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// 进度条
export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="w-full h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-brand-500 to-brand-600 rounded-full transition-all duration-300 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}
