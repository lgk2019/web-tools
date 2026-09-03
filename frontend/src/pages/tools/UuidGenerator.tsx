import { useEffect, useRef, useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { useToast } from '../../components/Toast';

const tool = tools.find((t) => t.id === 'uuid-generator')!;

type UuidFormat = 'standard' | 'uppercase' | 'braces' | 'no-hyphens';

const FORMAT_LABEL: Record<UuidFormat, string> = {
  standard: '标准 (小写)',
  uppercase: '大写',
  braces: '带花括号 {…}',
  'no-hyphens': '无连字符',
};

// 使用 crypto.getRandomValues 生成 UUID v4
function generateUuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // 设置 version (4) 和 variant (10xx)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

// 按选定格式输出
function formatUuid(uuid: string, format: UuidFormat): string {
  switch (format) {
    case 'uppercase':
      return uuid.toUpperCase();
    case 'braces':
      return `{${uuid}}`;
    case 'no-hyphens':
      return uuid.replace(/-/g, '');
    default:
      return uuid;
  }
}

// 复制到剪贴板
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  }
}

export default function UuidGenerator() {
  const [count, setCount] = useState(1);
  const [format, setFormat] = useState<UuidFormat>('standard');
  const [uuids, setUuids] = useState<string[]>([]);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const { success, error: toastError } = useToast();

  // 生成
  const generate = () => {
    const n = Math.min(500, Math.max(1, count));
    const list: string[] = [];
    for (let i = 0; i < n; i++) {
      list.push(formatUuid(generateUuidV4(), format));
    }
    setUuids(list);
    setCopiedValue(null);
  };

  // 初始生成
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 格式变化时重新格式化现有 UUID（保留原始随机性）
  // 由于 UUID 已格式化，重新格式化需要先还原为标准形式
  // 简化处理：格式变化时直接重新生成
  const handleFormatChange = (next: UuidFormat) => {
    if (next === format) return;
    setFormat(next);
    // 重新格式化现有列表
    setUuids((prev) => {
      if (prev.length === 0) return prev;
      // 还原为标准小写无花括号形式再按新格式输出
      return prev.map((u) => {
        let std = u.replace(/[{}]/g, '').toLowerCase();
        if (next !== 'no-hyphens' && !std.includes('-')) {
          // 从无连字符恢复
          if (std.length === 32) {
            std = `${std.slice(0, 8)}-${std.slice(8, 12)}-${std.slice(12, 16)}-${std.slice(16, 20)}-${std.slice(20)}`;
          }
        }
        return formatUuid(std, next);
      });
    });
  };

  const handleCopy = async (text: string) => {
    const ok = await copyText(text);
    if (ok) {
      setCopiedValue(text);
      success('已复制到剪贴板');
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedValue(null);
        copiedTimerRef.current = null;
      }, 2000);
    } else {
      toastError('复制失败：请手动选中后复制');
    }
  };

  const handleCopyAll = async () => {
    if (uuids.length === 0) return;
    await handleCopy(uuids.join('\n'));
  };

  const handleDownload = () => {
    if (uuids.length === 0) return;
    const blob = new Blob([uuids.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `uuids-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    success(`已下载 ${uuids.length} 条 UUID`);
  };

  const allText = uuids.join('\n');

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：参数 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ① 生成参数
            </label>

            {/* 数量 */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">生成数量</span>
                <span className="text-sm font-mono text-brand-600">{count}</span>
              </div>
              <input
                type="range"
                min="1"
                max="100"
                value={Math.min(100, count)}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full accent-brand-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>1</span>
                <span>100（可手动输入至 500）</span>
              </div>
              <input
                type="number"
                min="1"
                max="500"
                value={count}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isNaN(v) && v >= 1) setCount(Math.min(500, Math.round(v)));
                }}
                className="input mt-2 w-32"
              />
            </div>

            {/* 格式 */}
            <div>
              <span className="text-sm block mb-1.5">输出格式</span>
              <div className="flex flex-col gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(Object.keys(FORMAT_LABEL) as UuidFormat[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => handleFormatChange(f)}
                    className={`py-1.5 rounded-md text-xs font-medium transition-colors ${
                      format === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>
              <div className="mt-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800">
                <p className="text-xs text-gray-400 mb-0.5">示例</p>
                <code className="text-xs text-brand-600 font-mono">
                  {formatUuid('550e8400-e29b-41d4-a716-446655440000', format)}
                </code>
              </div>
            </div>

            {/* 生成按钮 */}
            <button onClick={generate} className="btn-primary w-full">
              🎲 生成 UUID
            </button>
          </div>

          {/* 右侧：结果 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                ② 生成结果
              </label>
              <div className="flex gap-2">
                <button
                  onClick={handleCopyAll}
                  disabled={uuids.length === 0}
                  className="text-xs text-brand-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                >
                  {copiedValue === allText ? '✓ 已复制全部' : '⧉ 复制全部'}
                </button>
                <button
                  onClick={handleDownload}
                  disabled={uuids.length === 0}
                  className="text-xs text-brand-600 hover:underline disabled:text-gray-400 disabled:no-underline"
                >
                  ⬇ 下载
                </button>
              </div>
            </div>

            {uuids.length === 0 ? (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                点击「生成 UUID」按钮
              </div>
            ) : (
              <>
                <div className="space-y-1 max-h-80 overflow-y-auto">
                  {uuids.map((uuid, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <span className="text-xs text-gray-400 font-mono shrink-0 w-8 text-right">
                        {i + 1}
                      </span>
                      <code className="flex-1 font-mono text-xs truncate text-gray-700 dark:text-gray-300" title={uuid}>
                        {uuid}
                      </code>
                      <button
                        onClick={() => handleCopy(uuid)}
                        className={`text-xs shrink-0 hover:underline ${
                          copiedValue === uuid ? 'text-green-600' : 'text-brand-600'
                        }`}
                      >
                        {copiedValue === uuid ? '✓' : '📋'}
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400">
                  共 {uuids.length} 条 · 使用 crypto.getRandomValues 生成（UUID v4）
                </p>
              </>
            )}
          </div>
        </div>

        {/* 提示 */}
        <div className="text-xs text-gray-400 space-y-1">
          <p>
            提示：UUID v4 的随机位使用 <span className="text-gray-600 dark:text-gray-300">crypto.getRandomValues</span> 生成，
            符合 RFC 4122 规范，version 固定为 4，variant 固定为 10xx。
          </p>
          <p>
            适用于数据库主键、分布式 ID、文件命名等场景；单次最多生成 500 条。
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
