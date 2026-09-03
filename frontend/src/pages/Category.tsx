import { useParams } from 'react-router-dom';
import { getToolsByCategory, categories } from '../config/tools';
import ToolCard from '../components/ToolCard';

export default function Category() {
  const { type } = useParams<{ type: string }>();
  const cat = categories.find((c) => c.id === type);

  if (!cat) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 text-center text-gray-400">
        分类不存在
      </div>
    );
  }

  const list = getToolsByCategory(cat.id);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-1">
        {cat.icon} {cat.label}
      </h1>
      <p className="text-gray-500 mb-6">共 {list.length} 个工具</p>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {list.map((tool) => (
          <ToolCard key={tool.id} tool={tool} />
        ))}
      </div>
    </div>
  );
}
