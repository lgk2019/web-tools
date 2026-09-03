import { useCallback, useEffect, useRef, useState } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { useToast } from '../../components/Toast';

const tool = tools.find((t) => t.id === 'password-generator')!;

// 字符集定义
const CHARSETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  numbers: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}|;:,.<>?/~',
};

// 易混淆字符（视觉上难以区分）
const AMBIGUOUS = new Set('Il1O0o');

interface PasswordOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  numbers: boolean;
  symbols: boolean;
  excludeAmbiguous: boolean;
}

const DEFAULT_OPTIONS: PasswordOptions = {
  length: 16,
  lower: true,
  upper: true,
  numbers: true,
  symbols: false,
  excludeAmbiguous: true,
};

// 使用 crypto.getRandomValues 生成安全随机数
function secureRandomInt(max: number): number {
  const array = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / max) * max;
  let value: number;
  do {
    crypto.getRandomValues(array);
    value = array[0];
  } while (value >= limit);
  return value % max;
}

// 生成单个密码
function generatePassword(opts: PasswordOptions): string {
  let pool = '';
  const required: string[] = [];

  if (opts.lower) {
    let chars = CHARSETS.lower;
    if (opts.excludeAmbiguous) chars = [...chars].filter((c) => !AMBIGUOUS.has(c)).join('');
    pool += chars;
    required.push(chars[secureRandomInt(chars.length)]);
  }
  if (opts.upper) {
    let chars = CHARSETS.upper;
    if (opts.excludeAmbiguous) chars = [...chars].filter((c) => !AMBIGUOUS.has(c)).join('');
    pool += chars;
    required.push(chars[secureRandomInt(chars.length)]);
  }
  if (opts.numbers) {
    let chars = CHARSETS.numbers;
    if (opts.excludeAmbiguous) chars = [...chars].filter((c) => !AMBIGUOUS.has(c)).join('');
    pool += chars;
    required.push(chars[secureRandomInt(chars.length)]);
  }
  if (opts.symbols) {
    const chars = CHARSETS.symbols;
    pool += chars;
    required.push(chars[secureRandomInt(chars.length)]);
  }

  if (!pool) return '';

  const chars: string[] = [...required];
  for (let i = required.length; i < opts.length; i++) {
    chars.push(pool[secureRandomInt(pool.length)]);
  }

  // Fisher–Yates 洗牌
  for (let i = chars.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.slice(0, opts.length).join('');
}

// 密码强度评估
function evaluateStrength(password: string): {
  score: number; // 0-4
  label: string;
  color: string;
  percent: number;
} {
  if (!password) return { score: 0, label: '—', color: 'text-gray-400', percent: 0 };

  let charsetSize = 0;
  if (/[a-z]/.test(password)) charsetSize += 26;
  if (/[A-Z]/.test(password)) charsetSize += 26;
  if (/[0-9]/.test(password)) charsetSize += 10;
  if (/[^a-zA-Z0-9]/.test(password)) charsetSize += 26;

  const entropy = (password.length * Math.log2(charsetSize || 1));

  if (entropy < 40) return { score: 1, label: '弱', color: 'text-red-500', percent: 25 };
  if (entropy < 60) return { score: 2, label: '中等', color: 'text-amber-500', percent: 50 };
  if (entropy < 80) return { score: 3, label: '强', color: 'text-emerald-500', percent: 75 };
  return { score: 4, label: '极强', color: 'text-emerald-600', percent: 100 };
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

const STRENGTH_BAR_COLORS = ['bg-gray-300', 'bg-red-500', 'bg-amber-500', 'bg-emerald-500', 'bg-emerald-600'];

export default function PasswordGenerator() {
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_OPTIONS);
  const [password, setPassword] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const { success, error: toastError } = useToast();

  const atLeastOneSelected = options.lower || options.upper || options.numbers || options.symbols;

  // 生成密码
  const generate = useCallback(() => {
    if (!atLeastOneSelected) {
      toastError('请至少选择一种字符类型');
      return;
    }
    const pwd = generatePassword(options);
    setPassword(pwd);
    setHistory((prev) => [pwd, ...prev].slice(0, 20));
  }, [options, atLeastOneSelected, toastError]);

  // 初始化生成一次
  useEffect(() => {
    generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateOption = <K extends keyof PasswordOptions>(key: K, value: PasswordOptions[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }));
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

  const strength = evaluateStrength(password);
  const copied = copiedValue !== null && copiedValue === password;

  const charTypeOptions: { key: keyof PasswordOptions; label: string; sample: string }[] = [
    { key: 'lower', label: '小写字母 (a-z)', sample: 'abc' },
    { key: 'upper', label: '大写字母 (A-Z)', sample: 'ABC' },
    { key: 'numbers', label: '数字 (0-9)', sample: '123' },
    { key: 'symbols', label: '特殊符号', sample: '!@#' },
  ];

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        {/* 密码展示区 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-500 uppercase">生成结果</label>
            <button
              onClick={() => handleCopy(password)}
              disabled={!password}
              className={`text-xs hover:underline disabled:text-gray-400 disabled:no-underline ${
                copied ? 'text-green-600' : 'text-brand-600'
              }`}
            >
              {copied ? '✓ 已复制' : '⧉ 复制'}
            </button>
          </div>
          <div className="flex items-stretch gap-2">
            <input
              type="text"
              value={password}
              readOnly
              className="input flex-1 font-mono text-base tracking-wider"
              placeholder="点击下方按钮生成密码"
            />
            <button
              onClick={generate}
              className="btn-primary shrink-0"
            >
              🎲 生成
            </button>
          </div>

          {/* 强度指示 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">密码强度</span>
              <span className={`font-medium ${strength.color}`}>{strength.label}</span>
            </div>
            <div className="flex gap-1">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded-full transition-colors ${
                    i < strength.score ? STRENGTH_BAR_COLORS[strength.score] : 'bg-gray-200 dark:bg-gray-800'
                  }`}
                />
              ))}
            </div>
            {password && (
              <p className="text-xs text-gray-400">
                长度 {password.length} 字符 · 熵约 {Math.round(password.length * Math.log2(
                  (options.lower ? 26 : 0) + (options.upper ? 26 : 0) +
                  (options.numbers ? 10 : 0) + (options.symbols ? 26 : 0) || 1
                ))} bits
              </p>
            )}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：参数设置 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ① 参数设置
            </label>

            {/* 长度 */}
            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">密码长度</span>
                <span className="text-sm font-mono text-brand-600">{options.length}</span>
              </div>
              <input
                type="range"
                min="4"
                max="64"
                value={options.length}
                onChange={(e) => updateOption('length', Number(e.target.value))}
                className="w-full accent-brand-600"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-0.5">
                <span>4</span>
                <span>64</span>
              </div>
            </div>

            {/* 字符类型 */}
            <div className="space-y-2">
              <span className="text-sm">字符类型</span>
              {charTypeOptions.map((opt) => (
                <label
                  key={opt.key}
                  className="flex items-center gap-2 cursor-pointer rounded-lg px-3 py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={options[opt.key] as boolean}
                    onChange={(e) => updateOption(opt.key, e.target.checked)}
                    className="accent-brand-600"
                  />
                  <span className="text-sm flex-1">{opt.label}</span>
                  <span className="font-mono text-xs text-gray-400">{opt.sample}</span>
                </label>
              ))}
            </div>

            {/* 排除易混淆字符 */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={options.excludeAmbiguous}
                onChange={(e) => updateOption('excludeAmbiguous', e.target.checked)}
                className="accent-brand-600"
              />
              <span className="text-sm">排除易混淆字符 (I l 1 O 0 o)</span>
            </label>

            {!atLeastOneSelected && (
              <p className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                ⚠️ 请至少选择一种字符类型
              </p>
            )}
          </div>

          {/* 右侧：历史记录 */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500 uppercase">
                ② 历史记录
              </label>
              {history.length > 0 && (
                <button
                  onClick={() => setHistory([])}
                  className="text-xs text-gray-400 hover:text-red-500"
                >
                  清空
                </button>
              )}
            </div>
            {history.length === 0 ? (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[120px] flex items-center justify-center text-gray-400 text-sm">
                生成的密码将显示在此
              </div>
            ) : (
              <ul className="space-y-1.5 max-h-80 overflow-y-auto">
                {history.map((pwd, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2"
                  >
                    <span className="text-xs text-gray-400 font-mono shrink-0">#{i + 1}</span>
                    <span className="flex-1 font-mono text-xs truncate" title={pwd}>
                      {pwd}
                    </span>
                    <button
                      onClick={() => handleCopy(pwd)}
                      className={`text-xs shrink-0 hover:underline ${
                        copiedValue === pwd ? 'text-green-600' : 'text-brand-600'
                      }`}
                    >
                      {copiedValue === pwd ? '✓' : '📋'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-gray-400">
              最多保留最近 20 条记录，刷新页面后清空。
            </p>
          </div>
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-wrap gap-2">
          <button onClick={generate} disabled={!atLeastOneSelected} className="btn-primary flex-1 disabled:opacity-60">
            🎲 重新生成
          </button>
          <button
            onClick={() => handleCopy(password)}
            disabled={!password}
            className="btn-ghost disabled:opacity-40"
          >
            {copied ? '✓ 已复制' : '📋 复制密码'}
          </button>
          <button
            onClick={() => {
              setOptions(DEFAULT_OPTIONS);
              setPassword('');
              setHistory([]);
            }}
            className="btn border border-gray-200 dark:border-gray-700 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            🗑️ 重置
          </button>
        </div>

        {/* 提示 */}
        <div className="text-xs text-gray-400 space-y-1">
          <p>
            提示：使用 <span className="text-gray-600 dark:text-gray-300">crypto.getRandomValues</span> 生成密码学安全的随机数，
            不依赖 Math.random()，适用于敏感场景。
          </p>
          <p>
            建议密码长度 ≥ 16 位并混合多种字符类型；特殊符号可显著提升强度但可能影响兼容性。
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
