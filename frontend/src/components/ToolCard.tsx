import { Link } from 'react-router-dom';
import type { ToolConfig } from '../config/tools';

export default function ToolCard({ tool }: { tool: ToolConfig }) {
  return (
    <Link
      to={tool.path}
      className="card card-hover p-4 flex flex-col gap-2 group relative overflow-hidden animate-fade-in-up animate-fill-both"
    >
      {/* 顶部标签 */}
      {tool.popular && (
        <span className="absolute top-3 right-3 tag bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200 z-10">
          热门
        </span>
      )}

      {/* 图标 */}
      <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 dark:from-brand-900/40 dark:to-brand-800/30 flex items-center justify-center text-xl group-hover:scale-110 group-hover:rotate-3 transition-all duration-300">
        {tool.icon}
      </div>

      <h3 className="font-semibold text-sm mt-1">{tool.name}</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-2 flex-1">
        {tool.description}
      </p>

      {/* 底部：标签 + 箭头 */}
      <div className="flex items-center justify-between mt-1">
        {tool.backend ? (
          <span className="tag bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            需后端
          </span>
        ) : (
          <span className="tag bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
            本地处理
          </span>
        )}
        <span className="text-brand-500 opacity-0 group-hover:opacity-100 group-hover:translate-x-0 -translate-x-1 transition-all duration-200">
          →
        </span>
      </div>
    </Link>
  );
}
