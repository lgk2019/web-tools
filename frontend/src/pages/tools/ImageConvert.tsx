import { useState, useRef, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, downloadBlob, formatBytes } from '../../utils/image';

const tool = tools.find((t) => t.id === 'image-convert')!;

// 支持的目标输出格式
type OutputFormat =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/bmp';

interface FileItem {
  file: File;
  originalSize: number;
  originalFormat: string; // 原始格式短名：JPG / PNG / WebP / BMP ...
  thumbUrl: string; // 原图缩略图
  convertedBlob?: Blob;
  convertedSize?: number;
  previewUrl?: string; // 转换后预览
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
}

const MAX_FILES = 20;
const MAX_SIZE = 20 * 1024 * 1024; // 20MB

// 目标格式短名
const FORMAT_LABEL: Record<OutputFormat, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/bmp': 'BMP',
};

// 目标格式扩展名
const FORMAT_EXT: Record<OutputFormat, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

// 从 MIME 或文件名解析原始格式短名
function detectFormat(file: File): string {
  const mime = file.type.toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'JPG';
  if (mime === 'image/png') return 'PNG';
  if (mime === 'image/webp') return 'WebP';
  if (mime === 'image/bmp') return 'BMP';
  if (mime === 'image/gif') return 'GIF';
  if (mime === 'image/avif') return 'AVIF';
  if (mime === 'image/x-icon' || mime === 'image/vnd.microsoft.icon')
    return 'ICO';
  // 兜底解析扩展名
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'JPG',
    jpeg: 'JPG',
    png: 'PNG',
    webp: 'WebP',
    bmp: 'BMP',
    gif: 'GIF',
    avif: 'AVIF',
    ico: 'ICO',
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : 'IMG');
}

/**
 * 将 Canvas 编码为 BMP Blob（手动编码，24 位色，自下而上）
 */
function canvasToBmpBlob(canvas: HTMLCanvasElement): Blob {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data; // RGBA

  // 每行字节数（24bpp，向上对齐到 4 字节）
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);

  // BMP 文件头（14 字节）
  view.setUint8(0, 0x42); // 'B'
  view.setUint8(1, 0x4d); // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint32(6, 0, true); // 保留
  view.setUint32(10, 54, true); // 像素数据偏移

  // DIB 信息头（40 字节）
  view.setUint32(14, 40, true); // 头大小
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // 正数 = 自下而上
  view.setUint16(26, 1, true); // 颜色平面数
  view.setUint16(28, 24, true); // 每像素位数
  view.setUint32(30, 0, true); // 无压缩
  view.setUint32(34, pixelArraySize, true); // 像素数据大小
  view.setInt32(38, 2835, true); // 水平分辨率 ppm（约 72 DPI）
  view.setInt32(42, 2835, true); // 垂直分辨率 ppm
  view.setUint32(46, 0, true); // 调色板颜色数
  view.setUint32(50, 0, true); // 重要颜色数

  // 像素数据：自下而上、BGR 顺序、每行末尾填充至 4 字节
  let pos = 54;
  for (let y = height - 1; y >= 0; y--) {
    let rowPos = pos;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      view.setUint8(rowPos++, data[idx + 2]); // B
      view.setUint8(rowPos++, data[idx + 1]); // G
      view.setUint8(rowPos++, data[idx]); // R
    }
    // 填充字节在 ArrayBuffer 中默认为 0
    pos += rowSize;
  }

  return new Blob([buffer], { type: 'image/bmp' });
}

/**
 * 使用 Canvas 重绘图片，并导出为目标格式
 */
async function convertImage(
  file: File,
  format: OutputFormat,
  quality: number
): Promise<Blob> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;

  // JPG / BMP 不支持透明通道，统一填充白色背景
  if (format === 'image/jpeg' || format === 'image/bmp') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(img, 0, 0);

  // BMP 浏览器原生 toBlob 支持有限，手动编码
  if (format === 'image/bmp') {
    return canvasToBmpBlob(canvas);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('转换失败'))),
      format,
      quality / 100
    );
  });
}

export default function ImageConvert() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [format, setFormat] = useState<OutputFormat>('image/webp');
  const [quality, setQuality] = useState(90);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // 闪现提示
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 2500);
  }, []);

  const addFiles = useCallback(
    (fileList: FileList) => {
      const incoming = Array.from(fileList).filter((f) =>
        f.type.startsWith('image/')
      );

      let oversized = 0;
      const valid = incoming.filter((f) => {
        if (f.size > MAX_SIZE) {
          oversized++;
          return false;
        }
        return true;
      });

      setFiles((prev) => {
        const remaining = Math.max(0, MAX_FILES - prev.length);
        const accepted = valid.slice(0, remaining);
        const overflow = valid.length - accepted.length;

        if (oversized > 0) {
          showToast(`已跳过 ${oversized} 个超过 20MB 的文件`);
        }
        if (overflow > 0) {
          showToast(`已达上限 ${MAX_FILES} 张，部分文件未加入`);
        }

        const newItems: FileItem[] = accepted.map((file) => ({
          file,
          originalSize: file.size,
          originalFormat: detectFormat(file),
          thumbUrl: URL.createObjectURL(file),
          status: 'pending' as const,
        }));
        return [...prev, ...newItems];
      });
    },
    [showToast]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  // 切换格式 / 质量时清空已转换结果，避免结果与新参数错配
  const clearResults = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      return prev.map((f) => ({
        ...f,
        convertedBlob: undefined,
        convertedSize: undefined,
        previewUrl: undefined,
        status: 'pending' as const,
        error: undefined,
      }));
    });
  }, []);

  const changeFormat = useCallback(
    (f: OutputFormat) => {
      if (f === format) return;
      setFormat(f);
      clearResults();
    },
    [format, clearResults]
  );

  const changeQuality = useCallback(
    (q: number) => {
      setQuality(q);
      clearResults();
    },
    [clearResults]
  );

  const removeFile = (index: number) => {
    setFiles((prev) => {
      const target = prev[index];
      if (target) {
        URL.revokeObjectURL(target.thumbUrl);
        if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const convertOne = useCallback(
    async (index: number) => {
      // 先标记为处理中
      setFiles((prev) =>
        prev.map((f, i) => (i === index ? { ...f, status: 'processing' } : f))
      );
      const item = files[index];
      if (!item) return;
      try {
        const blob = await convertImage(item.file, format, quality);
        const previewUrl = URL.createObjectURL(blob);
        setFiles((prev) =>
          prev.map((f, i) =>
            i === index
              ? {
                  ...f,
                  convertedBlob: blob,
                  convertedSize: blob.size,
                  previewUrl,
                  status: 'done',
                  error: undefined,
                }
              : f
          )
        );
      } catch {
        setFiles((prev) =>
          prev.map((f, i) =>
            i === index
              ? { ...f, status: 'error', error: '转换失败' }
              : f
          )
        );
      }
    },
    [files, format, quality]
  );

  const convertAll = useCallback(async () => {
    for (let i = 0; i < files.length; i++) {
      if (files[i].status !== 'done') {
        await convertOne(i);
      }
    }
  }, [files, convertOne]);

  const downloadOne = (index: number) => {
    const item = files[index];
    if (!item?.convertedBlob) return;
    const name =
      item.file.name.replace(/\.[^.]+$/, '') + '.' + FORMAT_EXT[format];
    downloadBlob(item.convertedBlob, name);
  };

  const downloadAll = () => {
    files.forEach((_, i) => {
      if (files[i].status === 'done') downloadOne(i);
    });
  };

  const reset = () => {
    files.forEach((f) => {
      URL.revokeObjectURL(f.thumbUrl);
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setFiles([]);
  };

  const doneCount = files.filter((f) => f.status === 'done').length;
  const totalOriginal = files.reduce((sum, f) => sum + f.originalSize, 0);
  const totalConverted = files.reduce(
    (sum, f) => sum + (f.convertedSize ?? 0),
    0
  );
  const savedPercent =
    totalOriginal > 0
      ? Math.round((1 - totalConverted / totalOriginal) * 100)
      : 0;

  // 仅 JPG / WebP 显示质量滑块
  const showQuality =
    format === 'image/jpeg' || format === 'image/webp';

  return (
    <ToolLayout tool={tool}>
      {/* 全局提示 */}
      {toast && (
        <div className="mb-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {toast}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：上传与参数 */}
        <div className="space-y-4">
          {/* 上传区 */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 上传文件
            </label>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                dragging
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                  : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
              }`}
            >
              <div className="text-3xl mb-2">🔄</div>
              <p className="font-medium text-sm">拖拽图片至此 或 点击选择</p>
              <p className="text-xs text-gray-400 mt-1">
                支持 JPG / PNG / WebP / BMP · 单文件 ≤ 20MB · 最多 20 张
              </p>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = ''; // 允许重复选择同一文件
                }}
              />
            </div>
          </div>

          {/* 文件列表 */}
          {files.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {files.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2"
                >
                  <img
                    src={item.thumbUrl}
                    alt={item.file.name}
                    className="w-10 h-10 rounded object-cover bg-white dark:bg-gray-900 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">
                      {item.file.name}
                    </p>
                    <p className="text-xs text-gray-400 flex items-center gap-1.5">
                      <span className="tag bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0">
                        {item.originalFormat}
                      </span>
                      <span>{formatBytes(item.originalSize)}</span>
                      {item.convertedSize !== undefined && (
                        <span className="text-emerald-600">
                          → {formatBytes(item.convertedSize)}
                        </span>
                      )}
                      {item.status === 'processing' && (
                        <span className="text-brand-600">转换中…</span>
                      )}
                      {item.status === 'error' && (
                        <span className="text-red-500">{item.error}</span>
                      )}
                    </p>
                  </div>
                  {item.status === 'done' && (
                    <button
                      onClick={() => downloadOne(i)}
                      className="text-xs text-brand-600 hover:underline shrink-0"
                    >
                      下载
                    </button>
                  )}
                  <button
                    onClick={() => removeFile(i)}
                    className="text-gray-400 hover:text-red-500 shrink-0"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 转换参数 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 转换参数
            </label>

            {/* 目标格式 */}
            <div>
              <span className="text-sm block mb-1.5">目标格式</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(
                  [
                    'image/jpeg',
                    'image/png',
                    'image/webp',
                    'image/bmp',
                  ] as OutputFormat[]
                ).map((f) => (
                  <button
                    key={f}
                    onClick={() => changeFormat(f)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      format === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {FORMAT_LABEL[f]}
                  </button>
                ))}
              </div>
            </div>

            {/* 质量参数（仅 JPG / WebP） */}
            {showQuality && (
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">输出质量</span>
                  <span className="text-sm font-mono text-brand-600">
                    {quality}%
                  </span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={quality}
                  onChange={(e) => changeQuality(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
                <p className="text-xs text-gray-400 mt-1">
                  数值越高画质越好，文件也越大。
                </p>
              </div>
            )}

            {!showQuality && (
              <p className="text-xs text-gray-400">
                {FORMAT_LABEL[format]} 为无损格式，无需设置质量参数。
              </p>
            )}
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2">
            <button
              onClick={convertAll}
              disabled={files.length === 0}
              className="btn-primary flex-1"
            >
              🔄 转换全部（{files.length}）
            </button>
            <button
              onClick={reset}
              disabled={files.length === 0}
              className="btn-ghost"
            >
              重置
            </button>
          </div>
        </div>

        {/* 右侧：预览与结果 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ③ 转换结果
          </label>

          {files.length === 0 ? (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
              上传图片后将显示转换结果
            </div>
          ) : (
            <>
              {/* 统计卡片 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="card p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">原始大小</p>
                  <p className="text-lg font-bold font-mono">
                    {formatBytes(totalOriginal)}
                  </p>
                </div>
                <div className="card p-3 text-center border-brand-500">
                  <p className="text-xs text-gray-400 mb-1">转换后</p>
                  <p className="text-lg font-bold font-mono text-brand-600">
                    {formatBytes(totalConverted)}
                  </p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">
                    {savedPercent >= 0 ? '节省' : '增加'}
                  </p>
                  <p
                    className={`text-lg font-bold font-mono ${
                      savedPercent >= 0 ? 'text-emerald-600' : 'text-amber-600'
                    }`}
                  >
                    {Math.abs(savedPercent)}%
                  </p>
                </div>
              </div>

              {/* 结果列表 */}
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {files
                  .map((item, i) => ({ item, i }))
                  .filter(({ item }) => item.status === 'done')
                  .map(({ item, i }) => {
                    const pct =
                      item.originalSize > 0
                        ? Math.round(
                            (1 -
                              (item.convertedSize ?? 0) / item.originalSize) *
                              100
                          )
                        : 0;
                    return (
                      <div key={i} className="card p-3">
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="w-full rounded-lg mb-2 max-h-40 object-contain bg-gray-50 dark:bg-gray-800"
                        />
                        <div className="flex justify-between items-center text-xs gap-2">
                          <span className="truncate">
                            {item.file.name.replace(/\.[^.]+$/, '')}.
                            {FORMAT_EXT[format]}
                          </span>
                          <span
                            className={`font-medium shrink-0 ${
                              pct >= 0 ? 'text-emerald-600' : 'text-amber-600'
                            }`}
                          >
                            {pct >= 0 ? `${pct}% ↓` : `${Math.abs(pct)}% ↑`}
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* 全部下载 */}
              {doneCount > 0 && (
                <button onClick={downloadAll} className="btn-primary w-full">
                  ⬇️ 全部下载（{doneCount}）
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </ToolLayout>
  );
}
