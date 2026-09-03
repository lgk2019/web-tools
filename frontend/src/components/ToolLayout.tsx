import { Link } from 'react-router-dom';
import type { ToolConfig } from '../config/tools';
import { categories } from '../config/tools';

export default function ToolLayout({
  tool,
  children,
}: {
  tool: ToolConfig;
  children: React.ReactNode;
}) {
  const cat = categories.find((c) => c.id === tool.category);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 animate-fade-in">
      {/* 面包屑 */}
      <nav className="text-sm text-gray-400 mb-4 flex items-center flex-wrap">
        <Link to="/" className="hover:text-brand-600 transition-colors">
          工具箱
        </Link>
        <span className="mx-2 opacity-60">/</span>
        {cat && (
          <>
            <Link to={`/category/${cat.id}`} className="hover:text-brand-600 transition-colors">
              {cat.label}
            </Link>
            <span className="mx-2 opacity-60">/</span>
          </>
        )}
        <span className="text-brand-600 font-medium">{tool.name}</span>
      </nav>

      {/* 标题区 */}
      <div className="flex items-start gap-3 mb-6">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-900/40 dark:to-brand-800/30 flex items-center justify-center text-2xl shrink-0 shadow-soft">
          {tool.icon}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold flex items-center gap-2 flex-wrap">
            {tool.name}
            {tool.backend ? (
              <span className="tag bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                需后端
              </span>
            ) : (
              <span className="tag bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
                本地处理
              </span>
            )}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {tool.description}
          </p>
        </div>
        <Link
          to="/"
          className="btn-ghost shrink-0"
        >
          ← 返回
        </Link>
      </div>

      {/* 工作台 */}
      <div className="card p-6">{children}</div>
    </div>
  );
}
