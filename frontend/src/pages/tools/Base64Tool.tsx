import { useMemo, useRef, useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { useToast } from '../../components/Toast';

const tool = tools.find((t) => t.id === 'base64')!;

type Mode = 'encode' | 'decode';

// 输入超过该字节数视为大文本，仅作提示，仍可正常处理
const LARGE_TEXT_BYTES = 512 * 1024;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

// Base64 解码示例文本（含中文与 emoji，校验代理对）
const EXAMPLE_TEXT = 'Hello World!\n中文在线工具箱 Online Toolbox\nemoji：😀 🎉';

// 标准 Base64 字母表
const B64_CHARS = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
);

function byteLengthOf(text: string): number {
  return utf8Encoder.encode(text).length;
}

function countLines(text: string): number {
  return text === '' ? 0 : text.split('\n').length;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// UTF-8 字符串 → Base64（分块拼接，避免展开参数过多）
function utf8ToBase64(str: string): string {
  const bytes = utf8Encoder.encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

// 转 URL 安全 Base64：+ → -，/ → _，去除 = 填充
function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 统一入口：编码（始终使用 UTF-8，字符集编解码一致）
function encodeBase64Text(text: string, urlSafe: boolean): string {
  const b64 = utf8ToBase64(text);
  return urlSafe ? toUrlSafe(b64) : b64;
}

// 校验并解码 Base64 → UTF-8 文本
function decodeBase64Text(raw: string, urlSafe: boolean): string {
  // 忽略空白（含换行/空格，兼容复制产生的断行）
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return '';

  // 标准模式下检测 URL 安全字符，给出明确引导
  if (!urlSafe && /[-_]/.test(compact)) {
    throw new Error('检测到“-”或“_”：这是 URL 安全 Base64 字符，请开启「URL 安全模式」后解码');
  }

  // URL 安全 → 标准字符，并自动补齐缺失的 = 填充
  let text = compact;
  if (urlSafe) text = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (text.length % 4)) % 4;
  if (pad === 3) {
    throw new Error('长度有误：有效字符数（不含空白）除以 4 余 1，不是合法的 Base64 内容');
  }
  const padded = pad > 0 ? text + '='.repeat(pad) : text;

  // 定位内容区（首个 = 之前）并校验填充
  let contentEnd = padded.length;
  for (let i = 0; i < padded.length; i++) {
    if (padded[i] === '=') {
      contentEnd = i;
      break;
    }
  }
  const padCount = padded.length - contentEnd;
  if (padCount > 2) {
    throw new Error('填充符“=”数量非法：应为 0–2 个且位于结尾');
  }
  for (let i = contentEnd; i < padded.length; i++) {
    if (padded[i] !== '=') {
      throw new Error('“=”只能出现在末尾，其后不能有其他字符');
    }
  }

  // 校验内容区字符
  if (contentEnd > 0) {
    for (let i = 0; i < contentEnd; i++) {
      const ch = padded[i];
      if (!B64_CHARS.has(ch)) {
        throw new Error(`包含非法字符“${ch}”：仅支持字母、数字、+、/（“=”仅作结尾填充）`);
      }
    }
  }

  let binary = '';
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Base64 内容无法解码，请检查字符与长度是否正确');
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(
      '解码结果不是有效的 UTF-8 文本：本工具统一按 UTF-8 编解码，请确认源数据为 UTF-8 编码'
    );
  }
}

// 复制到剪贴板：Clipboard API 优先，失败降级 execCommand
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 继续走降级方案 */
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export default function Base64Tool() {
  const [mode, setMode] = useState<Mode>('encode');
  const [input, setInput] = useState('');
  const [urlSafe, setUrlSafe] = useState(false);
  // 记录已复制的输出值；输出变化后自动视为未复制
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const { success, error: toastError } = useToast();

  // 输入变化即处理：根据模式自动编/解码
  const result = useMemo(() => {
    if (!input) return { output: '', error: '' };
    try {
      if (mode === 'encode') {
        return { output: encodeBase64Text(input, urlSafe), error: '' };
      }
      return { output: decodeBase64Text(input, urlSafe), error: '' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : '处理失败，请检查输入';
      return { output: '', error: msg };
    }
  }, [input, mode, urlSafe]);

  const output = result.output;
  const error = result.error;
  const copied = copiedValue !== null && copiedValue === output;

  // 输入统计
  const inputCharCount = input.length;
  const inputLineCount = countLines(input);
  const inputBytes = byteLengthOf(input);
  const outputBytes = byteLengthOf(output);
  const isLargeText = inputBytes >= LARGE_TEXT_BYTES;

  const isEncode = mode === 'encode';

  // 模式切换：保留输入、立即按新模式重新处理
  const switchMode = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
  };

  // 插入示例（解码模式的示例即为编码模式的输出，天然可演示双向互转）
  const handleExample = () => {
    setInput(isEncode ? EXAMPLE_TEXT : encodeBase64Text(EXAMPLE_TEXT, false));
  };

  // 清空输入与结果
  const handleClear = () => {
    setInput('');
  };

  // 交换：输出填入输入并反转模式（实现“解码结果再编码”闭环）
  const handleSwap = () => {
    if (!output) return;
    setInput(output);
    setMode((m) => (m === 'encode' ? 'decode' : 'encode'));
  };

  // 复制结果到剪贴板
  const handleCopy = async () => {
    if (!output) return;
    const ok = await copyText(output);
    if (ok) {
      setCopiedValue(output);
      success('已复制到剪贴板');
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedValue(null);
        copiedTimerRef.current = null;
      }, 2000);
    } else {
      toastError('复制失败：请手动选中结果文本后复制（Ctrl/Cmd + C）');
    }
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
            <span className="text-xs text-gray-400 hidden sm:inline">
              输入后自动转换，无需点击按钮
            </span>
          </div>
        </div>

        {/* 左右分栏：输入 → 输出（移动端自动上下堆叠） */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* 输入区 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                {isEncode ? '① 输入明文' : '① 输入 Base64'}
              </label>
              <button
                onClick={handleExample}
                className="text-xs text-brand-600 hover:underline"
              >
                ✎ 插入示例
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                isEncode
                  ? '在此输入需要编码的文本，支持中文与 emoji'
                  : '在此粘贴需要解码的 Base64 字符串（自动忽略换行）'
              }
              rows={12}
              spellCheck={false}
              className="input resize-y font-mono text-xs leading-relaxed"
            />
            <p className="text-xs text-gray-400">
              字符数：<span className="font-mono">{inputCharCount}</span> · 行数：
              <span className="font-mono">{inputLineCount}</span> · 字节：
              <span className="font-mono">{inputBytes}</span>
            </p>
            {isLargeText && (
              <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-1.5">
                ⚠️ 文本较大（约 {formatSize(inputBytes)}），转换在本地完成，可能需要片刻。
              </p>
            )}
          </div>

          {/* 输出区 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                {isEncode ? '② Base64 结果' : '② 解码结果'}
              </label>
              <button
                onClick={handleCopy}
                disabled={!output}
                className={`text-xs hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed ${
                  copied ? 'text-green-600' : 'text-brand-600'
                }`}
              >
                {copied ? '✓ 已复制' : '⧉ 复制结果'}
              </button>
            </div>
            <textarea
              value={output}
              readOnly
              placeholder={
                isEncode
                  ? '编码结果将自动显示在这里'
                  : '解码结果将自动显示在这里'
              }
              rows={12}
              spellCheck={false}
              className="input resize-y font-mono text-xs leading-relaxed bg-gray-50 dark:bg-gray-800/50"
            />
            <p className="text-xs text-gray-400">
              字符数：<span className="font-mono">{output.length}</span> · 字节：
              <span className="font-mono">{outputBytes}</span>
              {isEncode && output && (
                <>
                  {' '}
                  · 体积约为原文的
                  <span className="font-mono">
                    {inputBytes > 0
                      ? `${((outputBytes / inputBytes) * 100).toFixed(0)}%`
                      : '—'}
                  </span>
                </>
              )}
            </p>
            {/* 成功提示 */}
            {!error && output && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                ✓ {isEncode ? '编码成功' : '解码成功'}（UTF-8），可复制或点击「交换」反向操作
              </p>
            )}
          </div>
        </div>

        {/* 错误提示条 */}
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-300 break-all">
            ⚠️ {error}
          </div>
        )}

        {/* 操作按钮栏 */}
        <div className="flex flex-wrap gap-2">
          <button onClick={handleCopy} disabled={!output} className="btn-primary flex-1">
            {copied ? '✓ 已复制' : `📋 复制${isEncode ? ' Base64' : ' 结果'}`}
          </button>
          <button
            onClick={handleSwap}
            disabled={!output}
            className="btn-ghost"
            title="将输出填入输入，并切换模式"
          >
            🔄 交换
          </button>
          <button onClick={handleExample} className="btn-ghost">
            ✎ 示例
          </button>
          <button
            onClick={handleClear}
            disabled={!input && !output}
            className="btn border border-gray-200 dark:border-gray-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            🗑️ 清空
          </button>
        </div>

        {/* 提示 */}
        <div className="text-xs text-gray-400 space-y-1">
          <p>
            提示：本工具始终按 <span className="text-gray-600 dark:text-gray-300">UTF-8</span>{' '}
            编解码文本，中文与 emoji（含代理对）均可正确互转；输入空白字符会被自动忽略，
            缺失的 <code className="text-brand-600">=</code> 填充会自动补齐。
          </p>
          <p>
            开启「URL 安全模式」会将 <code className="text-brand-600">+/=</code>{' '}
            替换为 <code className="text-brand-600">-_</code> 并去除填充，适用于 URL 参数等场景。
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
