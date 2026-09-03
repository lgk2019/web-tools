import { useState, useRef, useEffect } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob, loadImage } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { LoadingOverlay } from '../../components/Loading';

const tool = tools.find((t) => t.id === 'qr-generator')!;

type ErrorLevel = 'L' | 'M' | 'Q' | 'H';
type ContentType = 'text' | 'url' | 'wifi' | 'email';

// Logo 文件大小上限（2MB）
const MAX_LOGO_SIZE = 2 * 1024 * 1024;

// 容错等级说明
const ERROR_LEVEL_HINT: Record<ErrorLevel, string> = {
  L: '约 7% 数据可损',
  M: '约 15% 数据可损',
  Q: '约 25% 数据可损',
  H: '约 30% 数据可损',
};

const CONTENT_LABEL: Record<ContentType, string> = {
  text: '文本',
  url: '链接',
  wifi: 'WiFi',
  email: '邮箱',
};

// 动态加载 qrcode（类型来自 @types/qrcode）
let qrModulePromise: Promise<typeof import('qrcode')> | null = null;
function loadQR(): Promise<typeof import('qrcode')> {
  if (!qrModulePromise) qrModulePromise = import('qrcode');
  return qrModulePromise;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hexToRGBA(hex: string): RGBA {
  let h = hex.replace('#', '').trim();
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length === 6) h += 'ff';
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0, a: 255 };
  return {
    r: (n >> 24) & 255,
    g: (n >> 16) & 255,
    b: (n >> 8) & 255,
    a: n & 255,
  };
}

function channelLuminance(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function colorLuminance(hex: string): number {
  const { r, g, b } = hexToRGBA(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

// WCAG 对比度（前景 / 背景）
function contrastRatio(fg: string, bg: string): number {
  const l1 = colorLuminance(fg);
  const l2 = colorLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

// 生成失败的错误转可读文案
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/too big|too long|overflow/i.test(raw)) {
    return '内容过长，无法在当前容错等级下生成，请缩短内容或提高容错等级';
  }
  if (/color|colour/i.test(raw)) {
    return '颜色值格式不正确，请重新选择颜色';
  }
  return '生成失败，请检查输入内容';
}

// 从输入内容提取安全的下载文件名片段
function sanitizeBaseName(raw: string): string {
  const s = raw
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 24);
  return s || 'qrcode';
}

// 将 Logo 以矢量方式嵌入 SVG（在模块坐标系中居中添加白色底板 + <image>）
function embedLogoInSvg(
  svg: string,
  dataUrl: string,
  units: number,
  ratio: number,
  padColor: string | null
): string {
  const size = units * ratio;
  const pos = (units - size) / 2;
  const pad = 2; // 两个模块的白色留白
  let extra = '';
  if (padColor) {
    extra += `<rect x="${pos - pad}" y="${pos - pad}" width="${size + pad * 2}" height="${
      size + pad * 2
    }" fill="${padColor}"/>`;
  }
  extra += `<image href="${dataUrl}" x="${pos}" y="${pos}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  return svg.replace('</svg>', extra + '</svg>');
}

export default function QRGenerator() {
  const [contentType, setContentType] = useState<ContentType>('text');
  const [text, setText] = useState('https://github.com');
  const [size, setSize] = useState(320);
  const [margin, setMargin] = useState(4);
  const [fgColor, setFgColor] = useState('#1a1a1a');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [bgTransparent, setBgTransparent] = useState(false);
  const [errorLevel, setErrorLevel] = useState<ErrorLevel>('M');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  // Logo 尺寸（占整幅的比例，10% ~ 30%）
  const [logoRatio, setLogoRatio] = useState(22);
  const [logoError, setLogoError] = useState('');
  const [svgString, setSvgString] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<'png' | 'svg' | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderSeqRef = useRef(0);

  const { success, error: toastError } = useToast();

  const hasLogo = logoDataUrl.length > 0;

  // 输入/参数变化后防抖自动重新生成。
  // 用序号丢弃过期结果，避免快速切换输入时旧异步结果覆盖新结果。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        const seq = ++renderSeqRef.current;
        if (!text.trim()) {
          // 空内容：清空预览并提示，同时取消任何进行中的旧生成
          setGenerating(false);
          setError('请输入内容');
          setSvgString('');
          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
          return;
        }

        setGenerating(true);
        setError('');
        const light = bgTransparent ? '#00000000' : bgColor;
        const pad = bgTransparent ? null : bgColor;
        const withLogo = logoDataUrl.length > 0;
        const content =
          contentType === 'wifi'
            ? /^(?:WIFI:)?S:([^;]*);T:(WPA|WEP|nopass);P:([^;]*);?$/i.test(text)
              ? text
              : `WIFI:S:${text};;`
            : contentType === 'email'
              ? `mailto:${text}`
              : text;

        try {
          const QR = await loadQR();

          let units = 0;
          if (withLogo) {
            // 先计算模块总量，Logo 按模块坐标系居中并留白
            const meta = QR.create(content, {
              errorCorrectionLevel: errorLevel,
            });
            units = meta.modules.size + margin * 2;
          }

          // 1) 先渲染到临时画布，全部完成后一次性提交，避免中间态/竞态
          const temp = document.createElement('canvas');
          await QR.toCanvas(temp, content, {
            width: size,
            margin,
            errorCorrectionLevel: errorLevel,
            color: { dark: fgColor, light },
          });

          if (withLogo && seq === renderSeqRef.current) {
            const logoImg = await loadImage(logoDataUrl);
            if (seq !== renderSeqRef.current) return;
            const ratio = logoRatio / 100;
            const pxPerUnit = units > 0 ? temp.width / units : 1;
            const logoPx = Math.max(8, Math.round(temp.width * ratio));
            const padPx = Math.max(1, Math.round(pxPerUnit * 2));
            const ctx = temp.getContext('2d')!;
            const x = (temp.width - logoPx) / 2;
            const y = (temp.height - logoPx) / 2;
            if (pad) {
              ctx.fillStyle = pad;
              ctx.fillRect(x - padPx, y - padPx, logoPx + padPx * 2, logoPx + padPx * 2);
            }
            ctx.drawImage(logoImg, x, y, logoPx, logoPx);
          }

          // 2) 生成 SVG（Logo 存在时以矢量元素嵌入）
          let svg = await QR.toString(content, {
            type: 'svg',
            width: size,
            margin,
            errorCorrectionLevel: errorLevel,
            color: { dark: fgColor, light },
          });
          if (withLogo && units > 0 && seq === renderSeqRef.current) {
            svg = embedLogoInSvg(svg, logoDataUrl, units, logoRatio / 100, pad);
          }

          if (seq !== renderSeqRef.current) return;

          // 3) 提交到预览画布
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.width = temp.width;
            canvas.height = temp.height;
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.drawImage(temp, 0, 0);
          }
          setSvgString(svg);
        } catch (err) {
          if (seq !== renderSeqRef.current) return;
          const msg = friendlyError(err);
          setError(msg);
          setSvgString('');
          const canvas = canvasRef.current;
          if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
          }
        } finally {
          if (seq === renderSeqRef.current) setGenerating(false);
        }
      })();
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    contentType,
    text,
    size,
    margin,
    fgColor,
    bgColor,
    bgTransparent,
    errorLevel,
    logoDataUrl,
    logoRatio,
  ]);

  // 前景/背景对比度提示
  const lowContrast = !bgTransparent && contrastRatio(fgColor, bgColor) < 2.5;

  const downloadBaseName = () => `qrcode-${sanitizeBaseName(text)}`;

  // 下载 PNG
  const downloadPNG = async () => {
    const canvas = canvasRef.current;
    if (!canvas || exporting) return;
    setExporting('png');
    try {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      );
      if (!blob) throw new Error('empty');
      downloadBlob(blob, `${downloadBaseName()}.png`);
      success('PNG 已开始下载');
    } catch {
      toastError('PNG 导出失败，请重试');
    } finally {
      setExporting(null);
    }
  };

  // 下载 SVG
  const downloadSVG = async () => {
    if (!svgString || exporting) return;
    setExporting('svg');
    try {
      const blob = new Blob([svgString], { type: 'image/svg+xml' });
      downloadBlob(blob, `${downloadBaseName()}.svg`);
      success('SVG 已开始下载');
    } catch {
      toastError('SVG 导出失败，请重试');
    } finally {
      setExporting(null);
    }
  };

  // Logo 上传：校验类型与大小，并确认可解码后才使用
  const onLogoFile = (file: File) => {
    setLogoError('');
    if (!file.type.startsWith('image/')) {
      const msg = 'Logo 仅支持图片文件（PNG/JPG/WebP 等）';
      setLogoError(msg);
      toastError(msg);
      return;
    }
    if (file.size > MAX_LOGO_SIZE) {
      const msg = 'Logo 图片过大，请选择 2MB 以内的图片';
      setLogoError(msg);
      toastError(msg);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      const msg = 'Logo 读取失败，请重试';
      setLogoError(msg);
      toastError(msg);
    };
    reader.onload = async () => {
      try {
        await loadImage(reader.result as string);
        setLogoDataUrl(reader.result as string);
        success('Logo 已添加');
      } catch {
        const msg = 'Logo 图片无法解码，请更换文件';
        setLogoError(msg);
        toastError(msg);
      }
    };
    reader.readAsDataURL(file);
  };

  const removeLogo = () => {
    setLogoDataUrl('');
    setLogoError('');
  };

  const placeholders: Record<ContentType, string> = {
    text: '输入任意文本',
    url: 'https://example.com',
    wifi: 'WiFi 名称（无密码模式）或 WIFI:S:名称;T:WPA;P:密码;',
    email: 'user@example.com',
  };

  const inputError = error;
  const busy = generating || exporting !== null;

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：配置 */}
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 内容类型
            </label>
            <div className="flex flex-wrap gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
              {(
                [
                  ['text', '文本'],
                  ['url', '链接'],
                  ['wifi', 'WiFi'],
                  ['email', '邮箱'],
                ] as [ContentType, string][]
              ).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setContentType(val)}
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    contentType === val
                      ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                      : 'text-gray-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-2">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ② 输入内容
              </label>
              <span className="text-[11px] text-gray-400">
                修改后约 300ms 自动更新
              </span>
            </div>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholders[contentType]}
              rows={3}
              className="input resize-none"
            />
            {inputError && (
              <p className="text-xs text-red-500 mt-1.5">⚠️ {inputError}</p>
            )}
            {contentType === 'wifi' && (
              <p className="text-xs text-gray-400 mt-1.5">
                输入纯名称将生成开放网络；也可粘贴完整的 WIFI:S:…;T:…;P:…; 格式。
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ③ 参数设置
            </label>

            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-sm">尺寸</span>
                <span className="text-sm font-mono text-brand-600">{size}px</span>
              </div>
              <input
                type="range"
                min="128"
                max="1024"
                step="32"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                className="w-full accent-brand-600"
              />

              <div className="flex justify-between items-center">
                <span className="text-sm">边距（静区）</span>
                <span className="text-sm font-mono text-brand-600">{margin}</span>
              </div>
              <input
                type="range"
                min="0"
                max="10"
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value))}
                className="w-full accent-brand-600"
              />
              <p className="text-xs text-gray-400 -mt-1">
                建议 2-4：过小的静区可能导致部分扫码器无法识别。
              </p>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm">容错等级</span>
                  <span className="text-xs text-gray-400">
                    {errorLevel} · {ERROR_LEVEL_HINT[errorLevel]}
                  </span>
                </div>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {(['L', 'M', 'Q', 'H'] as ErrorLevel[]).map((lv) => (
                    <button
                      key={lv}
                      onClick={() => setErrorLevel(lv)}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        errorLevel === lv
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500'
                      }`}
                    >
                      {lv}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="text-sm block mb-1.5">前景色</span>
                  <input
                    type="color"
                    value={fgColor}
                    onChange={(e) => setFgColor(e.target.value)}
                    className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer"
                  />
                </div>
                <div>
                  <span className="text-sm block mb-1.5">背景色</span>
                  <input
                    type="color"
                    value={bgColor}
                    disabled={bgTransparent}
                    onChange={(e) => setBgColor(e.target.value)}
                    className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer disabled:opacity-40"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={bgTransparent}
                  onChange={(e) => setBgTransparent(e.target.checked)}
                  className="accent-brand-600"
                />
                透明背景（导出 PNG/SVG 时去除白色底板）
              </label>
              {lowContrast && (
                <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded-lg px-3 py-2">
                  ⚠️ 前景色与背景色对比度较低，生成的二维码可能无法被扫描，建议使用深色前景 + 浅色背景。
                </p>
              )}
              {bgTransparent && (
                <p className="text-xs text-gray-400">
                  已选透明背景：使用时请确保实际承载面为浅色且与前景色有足够对比。
                </p>
              )}

              <div>
                <span className="text-sm block mb-1.5">Logo（居中嵌入）</span>
                {logoError && (
                  <p className="text-xs text-red-500 mb-2">⚠️ {logoError}</p>
                )}
                {hasLogo ? (
                  <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-3">
                    <div className="flex items-center gap-2">
                      <img
                        src={logoDataUrl}
                        alt="logo"
                        className="w-9 h-9 rounded border border-gray-200 object-contain bg-white"
                      />
                      <div className="flex-1 flex items-center justify-between">
                        <span className="text-xs text-gray-500">已添加</span>
                        <button
                          onClick={removeLogo}
                          className="text-xs text-red-500 hover:underline"
                        >
                          移除 Logo
                        </button>
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-500">Logo 尺寸</span>
                        <span className="text-xs font-mono text-brand-600">
                          {logoRatio}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min="10"
                        max="30"
                        step="1"
                        value={logoRatio}
                        onChange={(e) => setLogoRatio(Number(e.target.value))}
                        className="w-full accent-brand-600 mt-1"
                      />
                    </div>
                    <p className="text-[11px] text-gray-400">
                      {errorLevel === 'H'
                        ? '当前容错 H（30%），适合嵌入 Logo。'
                        : '建议将容错等级设为 H（30%），否则嵌入 Logo 后可能难以识别。'}
                      {bgTransparent && ' 透明背景下 Logo 无白色底板，识别率可能下降。'}
                    </p>
                  </div>
                ) : (
                  <label className="btn-ghost text-xs cursor-pointer">
                    📎 上传 Logo（PNG/JPG/WebP，≤ 2MB）
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = '';
                        if (f) onLogoFile(f);
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：预览 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ④ 预览
          </label>
          <div className="card p-6 flex flex-col items-center gap-4">
            <div className="relative rounded-xl overflow-hidden bg-white p-2 shadow-sm w-full max-w-sm flex items-center justify-center min-h-[160px]">
              <canvas ref={canvasRef} className="max-w-full h-auto rounded" />
              {generating && <LoadingOverlay message="正在生成…" />}
            </div>
            {inputError && (
              <p className="text-xs text-red-500 text-center">
                ⚠️ {inputError}，请修改参数后重试
              </p>
            )}
            <div className="flex gap-2 w-full">
              <button
                onClick={downloadPNG}
                disabled={busy || !!inputError || !svgString}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {exporting === 'png' ? '导出中…' : '⬇️ 下载 PNG'}
              </button>
              <button
                onClick={downloadSVG}
                disabled={busy || !!inputError || !svgString}
                className="btn-ghost flex-1"
              >
                {exporting === 'svg' ? '导出中…' : '⬇️ 下载 SVG'}
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400 text-center">
            文件将按内容自动命名（qrcode-{CONTENT_LABEL[contentType]}-内容.png / .svg）
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
