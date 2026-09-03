import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
      <p className="text-6xl mb-4">🤷</p>
      <h1 className="text-2xl font-bold mb-2">页面未找到</h1>
      <p className="text-gray-500 mb-6">你访问的页面不存在或已被移除</p>
      <Link to="/" className="btn-primary">
        返回首页
      </Link>
    </div>
  );
}
