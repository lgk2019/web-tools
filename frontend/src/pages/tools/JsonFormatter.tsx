import { useRef, useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { useToast } from '../../components/Toast';

const tool = tools.find((t) => t.id === 'json-formatter')!;

// 校验状态类型
type Status = 'idle' | 'valid' | 'invalid';
// 美化缩进档位
type Indent = 2 | 4;

// 结构化后的 JSON 错误信息
interface JsonErrorInfo {
  zh: string; // 可读的中文错误描述
  detail: string; // 浏览器原始错误信息（可能为空）
  line: number | null;
  column: number | null;
  offset: number | null; // 输入中的绝对偏移，用于定位高亮
}

// 输入超过该字节数视为大文本，仅作提示，仍可正常处理
const LARGE_TEXT_BYTES = 512 * 1024;

// 示例 JSON 数据
const EXAMPLE_JSON = `{
  "name": "在线工具箱",
  "version": "1.2.0",
  "features": ["JSON 格式化", "Base64 编解码", "二维码生成"],
  "config": {
    "theme": "dark",
    "language": "zh-CN",
    "maxFileSize": 1048576
  },
  "author": {
    "name": "张三",
    "email": "zhangsan@example.com"
  },
  "active": true,
  "stars": 1024
}`;

const utf8Encoder = new TextEncoder();

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

// 统计 JSON 树中的节点总数（每个值计 1，含根节点）
function countNodes(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) stack.push(node[i]);
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) stack.push(record[key]);
    }
  }
  return count;
}

// 常见解析错误 → 可读中文文案（按优先级匹配）
const JSON_ERROR_RULES: Array<[RegExp, string]> = [
  [/unexpected end of json (?:input|data)/i, '内容不完整：JSON 意外结束（可能缺少右括号或结尾引号）'],
  [/unterminated string/i, '字符串未闭合：缺少结尾的双引号'],
  [/unterminated array/i, '数组未闭合：缺少右方括号 ]'],
  [/unterminated object/i, '对象未闭合：缺少右花括号 }'],
  [/expected property name or '\}'/i, '此处应为双引号包裹的键名，或删去多余的 }'],
  [/expected double-quoted property name/i, '对象键名必须使用双引号包裹'],
  [/expected ':' after property name/i, '键名后缺少冒号 :'],
  [/expected ',' or '\}' after property value/i, '属性值后缺少逗号 , 或右花括号 }'],
  [/expected ',' or '\]' after array element/i, '数组元素后缺少逗号 , 或右方括号 ]'],
  [/bad control character in string/i, '字符串中包含未转义的控制字符（应写成 \\n、\\t 等转义序列）'],
  [/bad escaped character/i, '字符串中包含非法转义（\\ 后需接合法的转义字符）'],
  [/unexpected non-whitespace character after json/i, 'JSON 数据后存在多余内容（应只包含一个完整的 JSON 值）'],
  [/invalid (?:number|numeric literal)/i, '数字格式非法'],
  [/unexpected (?:token|identifier|number|string|character)/i, '存在意外的字符或标记'],
];

function friendlyJsonError(raw: string): string {
  for (const [re, zh] of JSON_ERROR_RULES) {
    if (re.test(raw)) return zh;
  }
  return raw.trim() || 'JSON 内容格式有误';
}

// 从解析错误中提取信息：中文文案 + 行列位置 + 绝对偏移
function analyzeJsonError(err: unknown, text: string): JsonErrorInfo {
  const detail = err instanceof Error ? err.message : String(err);
  let position: number | null = null;
  let line: number | null = null;
  let column: number | null = null;

  // Chrome / Edge / Node 风格：…at position N
  const posMatch = detail.match(/at position (\d+)/i);
  if (posMatch) {
    position = Math.min(Number(posMatch[1]), text.length);
  }

  // Firefox 风格：…at line L column C of the JSON data
  const lcMatch = detail.match(/line (\d+)(?:,|\s)+column (\d+)/i);
  if (lcMatch) {
    line = Number(lcMatch[1]);
    column = Number(lcMatch[2]);
  }

  // 由绝对偏移换算行列
  if (position !== null && line === null) {
    let ln = 1;
    let lineStart = 0;
    for (let i = 0; i < position; i++) {
      if (text[i] === '\n') {
        ln++;
        lineStart = i + 1;
      }
    }
    line = ln;
    column = position - lineStart + 1;
  }

  // 记录可用的绝对偏移，供“定位到错误”使用
  let offset = position;
  if (offset === null && line !== null && column !== null) {
    let off = 0;
    let current = 1;
    while (current < line && off < text.length) {
      if (text[off] === '\n') current++;
      off++;
    }
    offset = Math.min(text.length, off + Math.max(0, column - 1));
  }

  return {
    zh: friendlyJsonError(detail),
    detail,
    line,
    column: column !== null ? Math.max(1, column) : null,
    offset,
  };
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

export default function JsonFormatter() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorInfo, setErrorInfo] = useState<JsonErrorInfo | null>(null);
  const [indent, setIndent] = useState<Indent>(2);
  const [nodeCount, setNodeCount] = useState<number | null>(null);
  // 记录已复制的输出值；输出变化后自动视为未复制
  const [copiedValue, setCopiedValue] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const { success, error: toastError } = useToast();

  // 输入统计
  const inputCharCount = input.length;
  const inputLineCount = countLines(input);
  const inputBytes = byteLengthOf(input);
  const isLargeText = inputBytes >= LARGE_TEXT_BYTES;

  // 输出统计
  const outputLines: string[] = output === '' ? [] : output.split('\n');
  const outputBytes = byteLengthOf(output);
  const copied = copiedValue !== null && copiedValue === output;
  const isEmptyInput = input.trim() === '';

  // 重置校验/结果相关状态
  const resetResult = () => {
    setOutput('');
    setStatus('idle');
    setErrorInfo(null);
    setNodeCount(null);
    setCopiedValue(null);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
  };

  // 输入变更即清空过期结果，避免旧结果与当前输入错配
  const handleInputChange = (value: string) => {
    setInput(value);
    resetResult();
  };

  // 切换美化缩进：若已有结果则视为过期，需重新格式化
  const changeIndent = (next: Indent) => {
    if (next === indent) return;
    setIndent(next);
    if (output) resetResult();
  };

  // 定位输入框中的错误位置（文本选区高亮）
  const handleLocateError = () => {
    const info = errorInfo;
    const textarea = inputRef.current;
    if (!info || info.offset === null || !textarea) return;
    const pos = Math.min(info.offset, input.length);
    if (pos < 0) return;
    textarea.focus();
    let end = pos;
    while (
      end < input.length &&
      end - pos < 24 &&
      input[end] !== ' ' &&
      input[end] !== '\t' &&
      input[end] !== '\n' &&
      input[end] !== '\r' &&
      input[end] !== ',' &&
      input[end] !== ':' &&
      input[end] !== '[' &&
      input[end] !== ']' &&
      input[end] !== '{' &&
      input[end] !== '}'
    ) {
      end++;
    }
    end = Math.max(end, Math.min(input.length, pos + 1));
    textarea.setSelectionRange(pos, end);
  };

  // 执行需要解析 JSON 的操作；解析失败时展示错误并清空结果
  const runWithParsed = (fn: (parsed: unknown) => void) => {
    if (!input.trim()) {
      setStatus('invalid');
      setErrorInfo({
        zh: '请先输入 JSON 内容',
        detail: '',
        line: null,
        column: null,
        offset: null,
      });
      setOutput('');
      setNodeCount(null);
      return;
    }
    try {
      const parsed = JSON.parse(input);
      setStatus('valid');
      setNodeCount(countNodes(parsed));
      setErrorInfo(null);
      fn(parsed);
    } catch (err) {
      setStatus('invalid');
      setErrorInfo(analyzeJsonError(err, input));
      setOutput('');
      setNodeCount(null);
    }
  };

  // 格式化：按所选缩进（2/4 空格）美化
  const handleFormat = () =>
    runWithParsed((p) => setOutput(JSON.stringify(p, null, indent)));

  // 压缩：去除所有空白，输出紧凑 JSON
  const handleMinify = () => runWithParsed((p) => setOutput(JSON.stringify(p)));

  // 校验：仅检查 JSON 是否合法（不生成结果）
  const handleValidate = () => runWithParsed(() => {});

  // 转义：将 JSON 转为字符串字面量（转义引号等）
  const handleEscape = () =>
    runWithParsed((p) => setOutput(JSON.stringify(JSON.stringify(p))));

  // 清空输入与结果
  const handleClear = () => {
    setInput('');
    resetResult();
  };

  // 加载示例数据
  const handleLoadExample = () => {
    setInput(EXAMPLE_JSON);
    resetResult();
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
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：输入与操作 */}
        <div className="space-y-3 flex flex-col">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500 uppercase">
              ① 输入 JSON
            </label>
            <button
              onClick={handleLoadExample}
              className="text-xs text-brand-600 hover:underline"
            >
              📋 加载示例
            </button>
          </div>

          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={'在此粘贴或输入 JSON 内容，例如：\n{"name": "张三", "age": 25}'}
            rows={15}
            spellCheck={false}
            className={`input font-mono text-xs leading-relaxed resize-y ${
              status === 'invalid' && !isEmptyInput
                ? 'border-red-500 focus:border-red-500 focus:ring-red-500/30'
                : ''
            }`}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-400">
              字符数：<span className="font-mono">{inputCharCount}</span> · 行数：
              <span className="font-mono">{inputLineCount}</span> · 字节：
              <span className="font-mono">{inputBytes}</span>
            </p>
            {/* 美化缩进档位 */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-gray-400">美化缩进</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                {([2, 4] as Indent[]).map((val) => (
                  <button
                    key={val}
                    onClick={() => changeIndent(val)}
                    title={`格式化时使用 ${val} 空格缩进`}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                      indent === val
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {val} 空格
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isLargeText && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-1.5">
              ⚠️ 文本较大（约 {formatSize(inputBytes)}），处理在本地完成，可能需要片刻。
            </p>
          )}

          {/* 操作按钮 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <button onClick={handleFormat} className="btn-primary">
              ✨ 格式化
            </button>
            <button onClick={handleMinify} className="btn-ghost">
              📦 压缩
            </button>
            <button onClick={handleValidate} className="btn-ghost">
              ✅ 校验
            </button>
            <button onClick={handleEscape} className="btn-ghost">
              🔗 转义
            </button>
            <button onClick={handleLoadExample} className="btn-ghost">
              📋 示例
            </button>
            <button
              onClick={handleClear}
              className="btn border border-gray-200 dark:border-gray-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              🗑 清空
            </button>
          </div>
        </div>

        {/* 右侧：结果与统计 */}
        <div className="space-y-3 flex flex-col">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500 uppercase">
              ② 处理结果
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

          {/* 校验状态提示 */}
          {status === 'valid' && (
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900 px-3 py-2 text-sm text-green-700 dark:text-green-300 break-all">
              <span className="font-medium">✓ 有效 JSON</span>
              {nodeCount !== null && (
                <span>
                  {' '}
                  · 节点数 <span className="font-mono">{nodeCount}</span>
                </span>
              )}
              {output.length > 0 && (
                <span>
                  {' '}
                  · 输出 <span className="font-mono">{output.length}</span> 字符
                </span>
              )}
            </div>
          )}
          {status === 'invalid' && errorInfo && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-300 break-all">
              <p>
                <span className="font-medium">✗ {errorInfo.zh}</span>
                {errorInfo.line !== null && errorInfo.column !== null && (
                  <span className="font-mono">
                    （第 {errorInfo.line} 行，第 {errorInfo.column} 列）
                  </span>
                )}
              </p>
              {errorInfo.detail && errorInfo.detail !== errorInfo.zh && (
                <p className="mt-0.5 text-[11px] opacity-70 break-all">
                  原始信息：{errorInfo.detail}
                </p>
              )}
              {errorInfo.offset !== null && !isEmptyInput && (
                <button
                  onClick={handleLocateError}
                  className="mt-1.5 text-xs text-red-700 dark:text-red-300 underline underline-offset-2 hover:opacity-80"
                >
                  ↗ 在输入框中定位该错误
                </button>
              )}
            </div>
          )}

          {/* 结果展示（带行号） */}
          <div className="rounded-lg bg-gray-950 overflow-auto max-h-[460px] min-h-[300px] flex-1 flex flex-col">
            {outputLines.length > 0 ? (
              <div className="font-mono text-xs leading-relaxed py-2">
                {outputLines.map((line, i) => (
                  <div key={i} className="flex hover:bg-white/5 px-2">
                    <span className="w-10 shrink-0 text-right pr-3 text-gray-600 select-none tabular-nums">
                      {i + 1}
                    </span>
                    <span className="whitespace-pre text-gray-100 flex-1">
                      {line || ' '}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-600">
                处理结果将显示在这里
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400">
            字符数：<span className="font-mono">{output.length}</span> · 行数：
            <span className="font-mono">{outputLines.length}</span> · 字节：
            <span className="font-mono">{outputBytes}</span>
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
