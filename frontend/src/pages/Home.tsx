import { Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import {
  tools,
  categories,
  getPopularTools,
  searchTools,
  type ToolCategory,
} from '../config/tools';
import ToolCard from '../components/ToolCard';
import { EmptyState } from '../components/Loading';

export default function Home() {
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<ToolCategory | 'all'>('all');

  const popular = getPopularTools();

  const filtered = (() => {
    let list = query ? searchTools(query) : tools;
    if (activeCat !== 'all') {
      list = list.filter((t) => t.category === activeCat);
    }
    return list;
  })();

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
  };

  const localCount = tools.filter((t) => !t.backend).length;

  return (
    <div>
      {/* Hero 区 */}
      <section className="relative overflow-hidden border-b border-gray-200 dark:border-gray-800">
        {/* 渐变背景 + 网格 */}
        <div className="absolute inset-0 bg-gradient-to-br from-brand-50 via-white to-brand-50 dark:from-gray-900 dark:via-gray-950 dark:to-gray-900" />
        <div className="absolute inset-0 bg-grid opacity-60" />
        {/* 装饰光斑 */}
        <div className="absolute -top-20 -right-20 w-64 h-64 bg-brand-200/40 dark:bg-brand-900/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-brand-300/30 dark:bg-brand-800/20 rounded-full blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 py-14 text-center">
          {/* 徽章 */}
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-100 dark:bg-brand-900/40 px-3 py-1 text-xs font-medium text-brand-700 dark:text-brand-300 mb-4 animate-fade-in-up animate-fill-both">
            <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-pulse" />
            全部 {tools.length} 款工具 · {localCount} 款本地处理 · 永久免费
          </div>

          <h1 className="text-3xl sm:text-4xl font-bold mb-3 animate-fade-in-up animate-fill-both animate-delay-100">
            <span className="text-gradient">一站式在线工具箱</span>
          </h1>
          <p className="text-gray-600 dark:text-gray-300 mb-7 max-w-xl mx-auto animate-fade-in-up animate-fill-both animate-delay-200">
            图片压缩 · PDF 编辑 · 二维码生成 · 格式转换<br className="hidden sm:inline" />
            全部本地处理，安全免费
          </p>

          {/* 搜索 */}
          <form onSubmit={onSearch} className="max-w-md mx-auto animate-fade-in-up animate-fill-both animate-delay-300">
            <div className="relative group">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-brand-500 transition-colors">🔍</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入工具名称，如「图片压缩」"
                className="w-full rounded-full border border-gray-200 dark:border-gray-700 bg-white/90 dark:bg-gray-900/90 backdrop-blur pl-11 pr-4 py-3 text-sm shadow-card focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400 transition-all"
              />
            </div>
          </form>
        </div>
      </section>

      {/* 隐私提示 */}
      <div className="mx-auto max-w-7xl px-4 pt-6">
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300 animate-fade-in">
          <span className="text-base">🔒</span>
          <span>隐私优先：文件在浏览器本地处理，不上传服务器，用完即焚</span>
        </div>
      </div>

      {/* 热门工具 */}
      {!query && activeCat === 'all' && (
        <section className="mx-auto max-w-7xl px-4 py-8">
          <div className="flex items-center gap-2 mb-4">
            <h2 className="text-lg font-semibold">🔥 热门工具</h2>
            <span className="text-xs text-gray-400">{popular.length} 款</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {popular.map((tool, i) => (
              <div key={tool.id} className="animate-fade-in-up animate-fill-both animate-delay-100" style={{ animationDelay: `${i * 60}ms` }}>
                <ToolCard tool={tool} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 分类筛选 + 全部工具 */}
      <section className="mx-auto max-w-7xl px-4 pb-12">
        <div className="sticky top-14 z-30 -mx-4 px-4 py-3 bg-gray-50/90 dark:bg-gray-950/90 backdrop-blur-md flex items-center justify-between mb-4 border-b border-gray-200/60 dark:border-gray-800/60">
          <h2 className="text-lg font-semibold">
            {query ? `搜索结果（${filtered.length}）` : '全部工具'}
          </h2>
          <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
            <button
              onClick={() => setActiveCat('all')}
              className={`tag whitespace-nowrap transition-all ${
                activeCat === 'all'
                  ? 'bg-brand-600 text-white shadow-brand'
                  : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-brand-300'
              }`}
            >
              全部
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCat(cat.id)}
                className={`tag whitespace-nowrap transition-all ${
                  activeCat === cat.id
                    ? 'bg-brand-600 text-white shadow-brand'
                    : 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-brand-300'
                }`}
              >
                {cat.icon} {cat.label}
              </button>
            ))}
          </div>
        </div>

        {filtered.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filtered.map((tool, i) => (
              <div key={tool.id} className="animate-fade-in-up animate-fill-both" style={{ animationDelay: `${Math.min(i * 40, 400)}ms` }}>
                <ToolCard tool={tool} />
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="🔍"
            title="未找到匹配的工具"
            description={query ? `没有包含「${query}」的工具` : '请选择其他分类'}
            action={
              <Link to="/" className="btn-primary">
                返回首页
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
