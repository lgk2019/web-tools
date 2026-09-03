import { useState, useRef, useEffect } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob } from '../../utils/image';

const tool = tools.find((t) => t.id === 'qr-generator')!;

type ErrorLevel = 'L' | 'M' | 'Q' | 'H';
type ContentType = 'text' | 'url' | 'wifi' | 'email';

// 动态导入 qrcode 库（类型声明）
let QRCodeLib: any = null;

export default function QRGenerator() {
  const [contentType, setContentType] = useState<ContentType>('text');
  const [text, setText] = useState('https://github.com');
  const [size, setSize] = useState(320);
  const [margin, setMargin] = useState(4);
  const [fgColor, setFgColor] = useState('#1a1a1a');
  const [bgColor, setBgColor] = useState('#ffffff');
  const [errorLevel, setErrorLevel] = useState<ErrorLevel>('M');
  const [logoDataUrl, setLogoDataUrl] = useState('');
  const [svgString, setSvgString] = useState('');
  const [error, setError] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 生成二维码内容
  const buildContent = (): string => {
    if (contentType === 'wifi') {
      const match = text.match(/^(?:WIFI:)?S:([^;]*);T:(WPA|WEP|nopass);P:([^;]*);?$/i);
      if (match) return text;
      return `WIFI:S:${text};;`;
    }
    if (contentType === 'email') {
      return `mailto:${text}`;
    }
    return text;
  };

  // 生成二维码
  const generate = async () => {
    if (!text.trim()) {
      setError('请输入内容');
      setSvgString('');
      return;
    }
    setError('');

    try {
      // 动态加载 qrcode 库
      if (!QRCodeLib) {
        const mod = await import('qrcode');
        QRCodeLib = mod.default || mod;
      }

      const content = buildContent();
      const canvas = canvasRef.current!;

      await QRCodeLib.toCanvas(canvas, content, {
        width: size,
        margin,
        errorCorrectionLevel: errorLevel,
        color: { dark: fgColor, light: bgColor },
      });

      // 嵌入 Logo
      if (logoDataUrl) {
        const ctx = canvas.getContext('2d')!;
        const logoImg = new Image();
        logoImg.onload = () => {
          const logoSize = size * 0.22;
          const x = (canvas.width - logoSize) / 2;
          const y = (canvas.height - logoSize) / 2;
          // 白色底
          const pad = 8;
          ctx.fillStyle = bgColor;
          ctx.fillRect(x - pad, y - pad, logoSize + pad * 2, logoSize + pad * 2);
          ctx.drawImage(logoImg, x, y, logoSize, logoSize);
        };
        logoImg.src = logoDataUrl;
      }

      // 生成 SVG
      const svg = await QRCodeLib.toString(content, {
        type: 'svg',
        margin,
        errorCorrectionLevel: errorLevel,
        color: { dark: fgColor, light: bgColor },
      });
      setSvgString(svg);
    } catch (err: any) {
      setError(err?.message || '生成失败，内容可能过长');
      setSvgString('');
    }
  };

  // 自动生成
  useEffect(() => {
    const timer = setTimeout(() => generate(), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, size, margin, fgColor, bgColor, errorLevel, contentType, logoDataUrl]);

  // 下载 PNG
  const downloadPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, 'qrcode.png');
    });
  };

  // 下载 SVG
  const downloadSVG = () => {
    if (!svgString) return;
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    downloadBlob(blob, 'qrcode.svg');
  };

  // Logo 上传
  const onLogoUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  };

  const placeholders: Record<ContentType, string> = {
    text: '输入任意文本',
    url: 'https://example.com',
    wifi: 'WiFi 名称（无密码模式）或 WIFI:S:名称;T:WPA;P:密码;',
    email: 'user@example.com',
  };

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
                  className={`flex-1 py-1.5 rounded-md text-xs font-medium ${
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
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ② 输入内容
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholders[contentType]}
              rows={3}
              className="input resize-none"
            />
            {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
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
                <span className="text-sm">边距</span>
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

              <div>
                <span className="text-sm block mb-1.5">容错等级</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {(['L', 'M', 'Q', 'H'] as ErrorLevel[]).map((lv) => (
                    <button
                      key={lv}
                      onClick={() => setErrorLevel(lv)}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium ${
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
                    onChange={(e) => setBgColor(e.target.value)}
                    className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer"
                  />
                </div>
              </div>

              <div>
                <span className="text-sm block mb-1.5">Logo（居中嵌入）</span>
                {logoDataUrl ? (
                  <div className="flex items-center gap-2">
                    <img
                      src={logoDataUrl}
                      alt="logo"
                      className="w-9 h-9 rounded border border-gray-200 object-contain"
                    />
                    <button
                      onClick={() => setLogoDataUrl('')}
                      className="text-xs text-red-500 hover:underline"
                    >
                      移除 Logo
                    </button>
                  </div>
                ) : (
                  <label className="btn-ghost text-xs cursor-pointer">
                    📎 上传 Logo
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) =>
                        e.target.files?.[0] && onLogoUpload(e.target.files[0])
                      }
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
            <div className="rounded-lg overflow-hidden bg-white p-2 shadow-sm">
              <canvas ref={canvasRef} className="max-w-full"></canvas>
            </div>
            <div className="flex gap-2 w-full">
              <button onClick={downloadPNG} className="btn-primary flex-1">
                ⬇️ 下载 PNG
              </button>
              <button
                onClick={downloadSVG}
                disabled={!svgString}
                className="btn-ghost flex-1"
              >
                ⬇️ 下载 SVG
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400 text-center">
            提示：嵌入 Logo 时建议使用容错等级 H（30%），确保可扫描
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
