// 工具分类
export type ToolCategory = 'image' | 'pdf' | 'qrcode' | 'text';

// 工具配置接口
export interface ToolConfig {
  id: string;
  name: string;
  category: ToolCategory;
  icon: string;
  description: string;
  path: string;
  backend?: boolean;
  tags: string[];
  popular?: boolean;
}

// 分类元数据
export interface CategoryMeta {
  id: ToolCategory;
  label: string;
  icon: string;
}

export const categories: CategoryMeta[] = [
  { id: 'image', label: '图片处理', icon: '🖼️' },
  { id: 'pdf', label: 'PDF 工具', icon: '📄' },
  { id: 'qrcode', label: '二维码', icon: '▦' },
  { id: 'text', label: '文本工具', icon: '📝' },
];

// 工具注册表
export const tools: ToolConfig[] = [
  {
    id: 'image-compress',
    name: '图片压缩',
    category: 'image',
    icon: '🗜️',
    description: '在线压缩 JPG/PNG/WebP 图片，支持批量处理',
    path: '/tool/image-compress',
    backend: false,
    tags: ['图片', '压缩', '批量', 'WebP'],
    popular: true,
  },
  {
    id: 'image-crop',
    name: '图片裁剪',
    category: 'image',
    icon: '✂️',
    description: '自由裁剪、预设比例、旋转翻转图片',
    path: '/tool/image-crop',
    backend: false,
    tags: ['图片', '裁剪', '旋转'],
    popular: true,
  },
  {
    id: 'qr-generator',
    name: '二维码生成器',
    category: 'qrcode',
    icon: '▦',
    description: '自定义颜色、Logo、容错等级，导出 PNG/SVG',
    path: '/tool/qr-generator',
    backend: false,
    tags: ['二维码', 'QR', '生成'],
    popular: true,
  },
  {
    id: 'watermark-remover',
    name: '图片去水印',
    category: 'image',
    icon: '⬚',
    description: '框选或涂抹去除图片水印区域',
    path: '/tool/watermark-remover',
    backend: true,
    tags: ['图片', '去水印', 'AI'],
  },
  {
    id: 'image-convert',
    name: '图片格式转换',
    category: 'image',
    icon: '🔄',
    description: 'JPG / PNG / WebP / BMP 互转',
    path: '/tool/image-convert',
    backend: false,
    tags: ['图片', '格式', '转换'],
  },
  {
    id: 'pdf-editor',
    name: 'PDF 编辑',
    category: 'pdf',
    icon: '📄',
    description: '合并、拆分、水印、旋转 PDF 页面',
    path: '/tool/pdf-editor',
    backend: false,
    tags: ['PDF', '合并', '拆分', '水印'],
    popular: true,
  },
  {
    id: 'json-formatter',
    name: 'JSON 格式化',
    category: 'text',
    icon: '{ }',
    description: '校验、美化、压缩 JSON 数据',
    path: '/tool/json-formatter',
    backend: false,
    tags: ['JSON', '格式化', '校验'],
  },
  {
    id: 'base64',
    name: 'Base64 编解码',
    category: 'text',
    icon: '🔐',
    description: '文本与 Base64 互转',
    path: '/tool/base64',
    backend: false,
    tags: ['Base64', '编码', '解码'],
  },
  {
    id: 'qr-reader',
    name: '二维码识别',
    category: 'qrcode',
    icon: '📷',
    description: '上传图片识别二维码内容，支持摄像头扫码',
    path: '/tool/qr-reader',
    backend: false,
    tags: ['二维码', 'QR', '识别', '扫码'],
  },
  {
    id: 'pdf-to-image',
    name: 'PDF 转图片',
    category: 'pdf',
    icon: '🖼️',
    description: 'PDF 每页转为 PNG/JPG 图片，支持批量导出',
    path: '/tool/pdf-to-image',
    backend: false,
    tags: ['PDF', '图片', '转换', 'PNG'],
  },
  {
    id: 'password-generator',
    name: '密码生成器',
    category: 'text',
    icon: '🔑',
    description: '生成安全随机密码，自定义长度与字符类型',
    path: '/tool/password-generator',
    backend: false,
    tags: ['密码', '随机', '安全', '生成'],
    popular: true,
  },
  {
    id: 'uuid-generator',
    name: 'UUID 生成器',
    category: 'text',
    icon: '🆔',
    description: '批量生成 UUID v4，支持多种格式',
    path: '/tool/uuid-generator',
    backend: false,
    tags: ['UUID', 'GUID', 'v4', '生成'],
  },
  {
    id: 'hash-generator',
    name: '哈希生成器',
    category: 'text',
    icon: '#️⃣',
    description: '计算 SHA-1/256/384/512 哈希值',
    path: '/tool/hash-generator',
    backend: false,
    tags: ['哈希', 'SHA', 'SHA-256', '摘要'],
  },
];

// 按分类获取工具
export function getToolsByCategory(category: ToolCategory): ToolConfig[] {
  return tools.filter((t) => t.category === category);
}

// 获取热门工具
export function getPopularTools(): ToolConfig[] {
  return tools.filter((t) => t.popular);
}

// 搜索工具
export function searchTools(query: string): ToolConfig[] {
  const q = query.toLowerCase().trim();
  if (!q) return tools;
  return tools.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}
