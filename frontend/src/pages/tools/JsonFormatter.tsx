import { useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';

const tool = tools.find((t) => t.id === 'json-formatter')!;

// 校验状态类型
type Status = 'idle' | 'valid' | 'invalid';

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

// 从解析错误中提取信息，并尽可能定位行列位置
function getErrorDetail(error: unknown, text: string): string {
  const message = error instanceof Error ? error.message : String(error);

  // Chrome / Edge / Node 风格：message 中包含 "at position N"
  const posMatch = message.match(/at position (\d+)/);
  if (posMatch) {
    const pos = Math.min(Number(posMatch[1]), text.length);
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < pos; i++) {
      if (text[i] === '\n') {
        line++;
        lineStart = i + 1;
      }
    }
    const column = pos - lineStart + 1;
    return `${message}（约在第 ${line} 行，第 ${column} 列）`;
  }

  // Firefox 风格：message 中已包含 "at line X column Y"，直接展示
  return message;
}

export default function JsonFormatter() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);

  // 输入统计
  const inputCharCount = input.length;
  const inputLineCount = input === '' ? 0 : input.split('\n').length;

  // 输出按行拆分，用于行号渲染与统计
  const outputLines: string[] = output === '' ? [] : output.split('\n');

  // 输入变更时重置校验状态
  const handleInputChange = (value: string) => {
    setInput(value);
    setStatus('idle');
    setErrorMsg('');
  };

  // 执行需要解析 JSON 的操作；解析失败时展示错误并清空结果
  const runWithParsed = (fn: (parsed: unknown) => void) => {
    if (!input.trim()) {
      setStatus('invalid');
      setErrorMsg('请先输入 JSON 内容');
      setOutput('');
      return;
    }
    try {
      const parsed = JSON.parse(input);
      setStatus('valid');
      setErrorMsg('');
      fn(parsed);
    } catch (err) {
      setStatus('invalid');
      setErrorMsg(getErrorDetail(err, input));
      setOutput('');
    }
  };

  // 格式化：缩进 2 空格美化
  const handleFormat = () =>
    runWithParsed((p) => setOutput(JSON.stringify(p, null, 2)));

  // 压缩：去除所有空白，输出紧凑 JSON
  const handleMinify = () => runWithParsed((p) => setOutput(JSON.stringify(p)));

  // 校验：仅检查 JSON 是否合法
  const handleValidate = () => runWithParsed(() => {});

  // 转义：将 JSON 转为字符串字面量（转义引号等）
  const handleEscape = () =>
    runWithParsed((p) => setOutput(JSON.stringify(JSON.stringify(p))));

  // 清空输入与结果
  const handleClear = () => {
    setInput('');
    setOutput('');
    setStatus('idle');
    setErrorMsg('');
    setCopied(false);
  };

  // 加载示例数据
  const handleLoadExample = () => {
    setInput(EXAMPLE_JSON);
    setStatus('idle');
    setErrorMsg('');
  };

  // 复制结果到剪贴板
  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板 API 不可用时的降级方案
      const textarea = document.createElement('textarea');
      textarea.value = output;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={'在此粘贴或输入 JSON 内容，例如：\n{"name": "张三", "age": 25}'}
            rows={15}
            spellCheck={false}
            className="input font-mono text-xs leading-relaxed resize-y"
          />

          <p className="text-xs text-gray-400">
            字符数：<span className="font-mono">{inputCharCount}</span> · 行数：
            <span className="font-mono">{inputLineCount}</span>
          </p>

          {/* 操作按钮 */}
          <div className="grid grid-cols-3 gap-2">
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
            <button
              onClick={handleLoadExample}
              className="btn-ghost"
            >
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
            <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-900 px-3 py-2 text-sm text-green-700 dark:text-green-300">
              ✓ JSON 格式正确
            </div>
          )}
          {status === 'invalid' && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-600 dark:text-red-300 break-all">
              ✗ {errorMsg}
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
            <span className="font-mono">{outputLines.length}</span>
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
