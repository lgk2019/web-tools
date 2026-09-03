import { useState, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';

const tool = tools.find((t) => t.id === 'base64')!;

type Mode = 'encode' | 'decode';

// UTF-8 字符串 → Base64（正确处理中文）
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  // 分块拼接，避免大数组展开参数上限
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

// Base64 → UTF-8 字符串（正确处理中文）
function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// 转 URL 安全 Base64：+ → -，/ → _，去除 = 填充
function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 从 URL 安全 Base64 还原为标准 Base64
function fromUrlSafe(b64: string): string {
  let std = b64.replace(/-/g, '+').replace(/_/g, '/');
  // 补齐 4 字节对齐的 = 填充
  const pad = (4 - (std.length % 4)) % 4;
  std += '='.repeat(pad);
  return std;
}

// 校验是否为合法的标准 Base64 字符串
function isValidStandardBase64(str: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

export default function Base64Tool() {
  const [mode, setMode] = useState<Mode>('encode');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [urlSafe, setUrlSafe] = useState(false);
  const [supportUtf8, setSupportUtf8] = useState(true);
  const [copied, setCopied] = useState(false);

  // 执行编码
  const doEncode = useCallback(
    (raw: string, safe: boolean, utf8: boolean): string => {
      if (!raw) return '';
      if (utf8) {
        const b64 = utf8ToBase64(raw);
        return safe ? toUrlSafe(b64) : b64;
      }
      // 非 UTF-8 模式：直接 btoa（仅支持 Latin-1 范围）
      return safe ? toUrlSafe(btoa(raw)) : btoa(raw);
    },
    []
  );

  // 执行解码
  const doDecode = useCallback(
    (raw: string, safe: boolean, utf8: boolean): string => {
      const trimmed = raw.trim();
      if (!trimmed) return '';
      // 先还原为标准 Base64
      const std = safe ? fromUrlSafe(trimmed) : trimmed;
      if (!isValidStandardBase64(std)) {
        throw new Error('输入不是合法的 Base64 字符串');
      }
      if (utf8) {
        return base64ToUtf8(std);
      }
      return atob(std);
    },
    []
  );

  // 转换按钮：依据当前模式
  const handleConvert = () => {
    if (!input) {
      setError('请输入内容');
      setOutput('');
      return;
    }
    setError('');
    try {
      const result =
        mode === 'encode'
          ? doEncode(input, urlSafe, supportUtf8)
          : doDecode(input, urlSafe, supportUtf8);
      setOutput(result);
      setCopied(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '转换失败';
      setError(msg);
      setOutput('');
    }
  };

  // 交换：输出填入输入，模式反转，清空输出
  const handleSwap = () => {
    if (!output) {
      setError('没有可交换的结果');
      return;
    }
    setInput(output);
    setOutput('');
    setError('');
    setCopied(false);
    setMode((m) => (m === 'encode' ? 'decode' : 'encode'));
  };

  // 复制结果到剪贴板
  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
    } catch {
      setError('复制失败，请手动复制');
    }
  };

  // 清空所有内容
  const handleClear = () => {
    setInput('');
    setOutput('');
    setError('');
    setCopied(false);
  };

  // 模式切换时同步清空结果与错误
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setOutput('');
    setError('');
    setCopied(false);
  };

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-4">
        {/* 顶部：模式 Tab + 选项 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
            {(
              [
                ['encode', '编码'],
                ['decode', '解码'],
              ] as [Mode, string][]
            ).map(([val, label]) => (
              <button
                key={val}
                onClick={() => switchMode(val)}
                className={`px-6 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  mode === val
                    ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={urlSafe}
                onChange={(e) => setUrlSafe(e.target.checked)}
                className="accent-brand-600"
              />
              <span>URL 安全模式</span>
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={supportUtf8}
                onChange={(e) => setSupportUtf8(e.target.checked)}
                className="accent-brand-600"
              />
              <span>支持中文（UTF-8）</span>
            </label>
          </div>
        </div>

        {/* 左右分栏：输入 → 输出 */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* 输入区 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                {mode === 'encode' ? '输入明文' : '输入 Base64'}
              </label>
              <span className="text-xs text-gray-400">
                {input.length} 字符
              </span>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                mode === 'encode'
                  ? '在此输入需要编码的文本，支持中文'
                  : '在此粘贴需要解码的 Base64 字符串'
              }
              rows={10}
              className="input resize-y font-mono text-sm"
            />
          </div>

          {/* 输出区 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                {mode === 'encode' ? 'Base64 结果' : '解码结果'}
              </label>
              <span className="text-xs text-gray-400">
                {output.length} 字符
              </span>
            </div>
            <textarea
              value={output}
              readOnly
              placeholder="转换结果将显示在这里"
              rows={10}
              className="input resize-y font-mono text-sm bg-gray-50 dark:bg-gray-800/50"
            />
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            ⚠️ {error}
          </div>
        )}

        {/* 操作按钮栏 */}
        <div className="flex flex-wrap gap-2">
          <button onClick={handleConvert} className="btn-primary flex-1">
            {mode === 'encode' ? '🔐 编码' : '🔓 解码'}
          </button>
          <button
            onClick={handleSwap}
            disabled={!output}
            className="btn-ghost"
            title="将输出填入输入，并切换模式"
          >
            🔄 交换
          </button>
          <button
            onClick={handleCopy}
            disabled={!output}
            className="btn-ghost"
          >
            {copied ? '✓ 已复制' : '📋 复制'}
          </button>
          <button
            onClick={handleClear}
            disabled={!input && !output}
            className="btn-ghost"
          >
            🗑️ 清空
          </button>
        </div>

        {/* 提示 */}
        <p className="text-xs text-gray-400">
          提示：开启「URL 安全模式」会将 <code className="text-brand-600">+/=</code>{' '}
          替换为 <code className="text-brand-600">-_</code> 并去除填充；
          中文处理请保持「支持中文」开启。
        </p>
      </div>
    </ToolLayout>
  );
}
