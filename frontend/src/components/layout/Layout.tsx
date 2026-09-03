import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, type FormEvent } from 'react';
import { categories, searchTools } from '../../config/tools';

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [dark, setDark] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // 初始化：读取本地主题偏好或跟随系统
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = saved ? saved === 'dark' : prefersDark;
    setDark(isDark);
    document.documentElement.classList.toggle('dark', isDark);
  }, []);

  // 页面切换时滚动到顶部 & 关闭移动菜单
  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [location.pathname]);

  // 快捷键：Cmd/Ctrl+K 聚焦搜索，Esc 清空
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleDark = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const results = searchTools(query);
    if (results.length === 1) {
      navigate(results[0].path);
    } else {
      navigate(`/?q=${encodeURIComponent(query)}`);
    }
  };

  const isHome = location.pathname === '/';

  return (
    <div className="min-h-screen flex flex-col">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 border-b border-gray-200/80 dark:border-gray-800/80 bg-white/80 dark:bg-gray-950/80 backdrop-blur-lg">
        <div className="mx-auto max-w-7xl px-4 h-14 flex items-center gap-3">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 shrink-0 group">
            <span className="text-lg group-hover:scale-110 transition-transform">🧰</span>
            <span className="text-lg font-bold text-gradient hidden sm:inline">工具箱</span>
          </Link>

          {/* 搜索框 */}
          {!isHome && (
            <form onSubmit={onSearch} className="flex-1 max-w-xs relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索工具..."
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                className={`w-full rounded-full border bg-gray-50 dark:bg-gray-900 pl-9 pr-8 py-1.5 text-sm transition-all focus:outline-none focus:ring-2 focus:ring-brand-500/30 ${
                  searchFocused
                    ? 'border-brand-400 dark:border-brand-600 bg-white dark:bg-gray-800'
                    : 'border-gray-200 dark:border-gray-700'
                }`}
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs w-4 h-4 flex items-center justify-center rounded-full hover:bg-gray-200 dark:hover:bg-gray-700"
                >
                  ✕
                </button>
              )}
              {/* 快捷键提示 */}
              {!query && !searchFocused && (
                <kbd className="hidden md:flex absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 border border-gray-200 dark:border-gray-700 rounded px-1 py-0.5 font-mono">
                  ⌘K
                </kbd>
              )}
            </form>
          )}

          {/* 桌面端导航 */}
          <nav className="hidden md:flex items-center gap-0.5 ml-auto">
            {categories.map((cat) => (
              <Link
                key={cat.id}
                to={`/category/${cat.id}`}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
              >
                {cat.icon} {cat.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-1 ml-auto md:ml-2">
            {/* 主题切换 */}
            <button
              onClick={toggleDark}
              className="w-9 h-9 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-amber-500 dark:hover:text-amber-300 transition-colors"
              aria-label="切换主题"
            >
              <span className="text-base">{dark ? '☀️' : '🌙'}</span>
            </button>

            {/* 移动端菜单按钮 */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="md:hidden w-9 h-9 flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label="菜单"
            >
              {menuOpen ? '✕' : '☰'}
            </button>
          </div>
        </div>

        {/* 移动端展开菜单 */}
        {menuOpen && (
          <nav className="md:hidden border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 animate-fade-in">
            <div className="mx-auto max-w-7xl px-4 py-2 flex flex-col gap-0.5">
              {categories.map((cat) => (
                <Link
                  key={cat.id}
                  to={`/category/${cat.id}`}
                  className="px-3 py-2.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-brand-600 dark:hover:text-brand-400 transition-colors flex items-center gap-2"
                >
                  <span className="text-base">{cat.icon}</span>
                  {cat.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </header>

      <main className="flex-1 animate-fade-in" key={location.pathname}>
        {children}
      </main>

      {/* 底部 */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-6 text-center text-sm text-gray-400">
        <p>🧰 在线工具箱 · 文件本地处理 · 隐私安全 · 完全免费</p>
      </footer>
    </div>
  );
}
