import { useMemo, useRef, useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { useToast } from '../../components/Toast';

const tool = tools.find((t) => t.id === 'hash-generator')!;

type HashAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

const ALGORITHMS: HashAlgorithm[] = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'];

const ALGO_BITS: Record<HashAlgorithm, number> = {
  'SHA-1': 160,
  'SHA-256': 256,
  'SHA-384': 384,
  'SHA-512': 512,
};

const EXAMPLE_TEXT = 'Hello, World!\n在线工具箱 Online Toolbox';

const utf8Encoder = new TextEncoder();

function byteLengthOf(text: string): number {
  return utf8Encoder.encode(text).length;
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

// 字节转十六进制
function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 大写十六进制
function bytesToHexUpper(bytes: ArrayBuffer): string {
  return bytesToHex(bytes).toUpperCase();
}

// Base64
function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(arr.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
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

type OutputFormat = 'lower' | 'upper' | 'base64';

const FORMAT_LABEL: Record<OutputFormat, string> = {
  lower: '小写 HEX',
  upper: '大写 HEX',
  base64: 'Base64',
};

export default function HashGenerator() {
  const [input, setInput] = useState('');
  const [algorithms, setAlgorithms] = useState<Set<HashAlgorithm>>(
    new Set(['SHA-256'])
  );
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('lower');
  const [results, setResults] = useState<Record<HashAlgorithm, string>>({
    'SHA-1': '',
    'SHA-256': '',
    'SHA-384': '',
    'SHA-512': '',
  });
  const [computing, setComputing] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const { success, error: toastError } = useToast();

  const inputBytes = byteLengthOf(input);
  const inputLines = countLines(input);
  const hasInput = input.trim().length > 0;
  const selectedAlgos = ALGORITHMS.filter((a) => algorithms.has(a));

  // 实时计算哈希
  const compute = useMemo(() => {
    return async () => {
      if (!hasInput) {
        setResults({
          'SHA-1': '',
          'SHA-256': '',
          'SHA-384': '',
          'SHA-512': '',
        });
        return;
      }
      setComputing(true);
      try {
        const data = utf8Encoder.encode(input);
        const newResults = { ...results };
        for (const algo of ALGORITHMS) {
          if (algorithms.has(algo)) {
            const hashBuffer = await crypto.subtle.digest(algo, data);
            let formatted: string;
            if (outputFormat === 'lower') formatted = bytesToHex(hashBuffer);
            else if (outputFormat === 'upper') formatted = bytesToHexUpper(hashBuffer);
            else formatted = bytesToBase64(hashBuffer);
            newResults[algo] = formatted;
          } else {
            newResults[algo] = '';
          }
        }
        setResults(newResults);
      } catch (err) {
        toastError(err instanceof Error ? err.message : '计算失败');
      } finally {
        setComputing(false);
      }
    };
  }, [input, algorithms, outputFormat]);

  // 输入或选项变化时重新计算
  const computeRef = useRef(compute);
  computeRef.current = compute;

  useMemo(() => {
    if (hasInput) {
      // 防抖：延迟计算避免大文本每次按键都算
      const timer = setTimeout(() => computeRef.current(), 200);
      return () => clearTimeout(timer);
    } else {
      computeRef.current();
    }
  }, [input, algorithms, outputFormat, hasInput]);

  const toggleAlgorithm = (algo: HashAlgorithm) => {
    setAlgorithms((prev) => {
      const next = new Set(prev);
      if (next.has(algo)) {
        if (next.size > 1) next.delete(algo);
      } else {
        next.add(algo);
      }
      return next;
    });
  };

  const handleCopy = async (text: string, label: string) => {
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      setCopiedValue(text);
      success(`${label} 已复制`);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedValue(null);
        copiedTimerRef.current = null;
      }, 2000);
    } else {
      toastError('复制失败：请手动选中后复制');
    }
  };

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：输入与参数 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                ① 输入文本
              </label>
              <button
                onClick={() => setInput(EXAMPLE_TEXT)}
                className="text-xs text-brand-600 hover:underline"
              >
                ✎ 插入示例
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="在此输入需要计算哈希的文本…"
              rows={10}
              spellCheck={false}
              className="input resize-y font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-gray-400">
              字符数：<span className="font-mono">{input.length}</span> · 行数：
              <span className="font-mono">{inputLines}</span> · 字节：
              <span className="font-mono">{inputBytes}</span>
            </p>

            {/* 算法选择 */}
            <div>
              <span className="text-sm block mb-1.5">哈希算法</span>
              <div className="flex flex-wrap gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {ALGORITHMS.map((algo) => (
                  <button
                    key={algo}
                    onClick={() => toggleAlgorithm(algo)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      algorithms.has(algo)
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {algo}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                可同时选择多种算法进行对比。至少保留一种。
              </p>
            </div>

            {/* 输出格式 */}
            <div>
              <span className="text-sm block mb-1.5">输出格式</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(Object.keys(FORMAT_LABEL) as OutputFormat[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setOutputFormat(f)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      outputFormat === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 右侧：结果 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                ② 哈希结果
              </label>
              {computing && (
                <span className="text-xs text-brand-600 flex items-center gap-1">
                  <span className="inline-block w-3 h-3 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                  计算中…
                </span>
              )}
            </div>

            {!hasInput ? (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                输入文本后将自动计算哈希值
              </div>
            ) : (
              <div className="space-y-3">
                {selectedAlgos.map((algo) => {
                  const value = results[algo];
                  const copied = copiedValue === value;
                  return (
                    <div key={algo} className="card p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{algo}</span>
                          <span className="tag bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 px-1.5 py-0">
                            {ALGO_BITS[algo]} bits
                          </span>
                        </div>
                        <button
                          onClick={() => handleCopy(value, algo)}
                          disabled={!value}
                          className={`text-xs hover:underline disabled:text-gray-400 disabled:no-underline ${
                            copied ? 'text-green-600' : 'text-brand-600'
                          }`}
                        >
                          {copied ? '✓ 已复制' : '⧉ 复制'}
                        </button>
                      </div>
                      <p className="font-mono text-xs break-all text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-2.5 min-h-[2.5rem]">
                        {value || '—'}
                      </p>
                      {value && outputFormat !== 'base64' && (
                        <p className="text-xs text-gray-400">
                          长度 {value.length} 字符（{ALGO_BITS[algo] / 4} 位十六进制）
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 清空与操作 */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setInput('')}
                disabled={!input}
                className="btn border border-gray-200 dark:border-gray-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40"
              >
                🗑️ 清空
              </button>
              <button
                onClick={() => setInput(EXAMPLE_TEXT)}
                className="btn-ghost"
              >
                ✎ 示例
              </button>
            </div>
          </div>
        </div>

        {/* 提示 */}
        <div className="text-xs text-gray-400 space-y-1">
          <p>
            提示：使用浏览器原生 <span className="text-gray-600 dark:text-gray-300">Web Crypto API (crypto.subtle.digest)</span> 计算，
            支持输入后自动实时计算（200ms 防抖），全部在本地完成。
          </p>
          <p>
            SHA-1 已不推荐用于安全场景，请优先使用 SHA-256 及以上。文本始终按 UTF-8 编码后计算。
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
