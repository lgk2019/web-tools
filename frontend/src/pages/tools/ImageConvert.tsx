import { useState, useRef, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, downloadBlob, formatBytes } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { ProgressBar, ButtonSpinner } from '../../components/Loading';
import JSZip from 'jszip';

const tool = tools.find((t) => t.id === 'image-convert')!;

// 支持的目标输出格式
type OutputFormat =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/bmp';

interface FileItem {
  key: string;
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

// 常见扩展名 → 格式短名（用于 MIME 缺失时兜底识别）
const FORMAT_EXT_MAP: Record<string, string> = {
  jpg: 'JPG',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  avif: 'AVIF',
  ico: 'ICO',
};

// 判断是否为图片文件（按 MIME 或扩展名兜底，兼容无 MIME 的文件）
function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(FORMAT_EXT_MAP, ext);
}

// 从 MIME 或文件名解析原始格式短名
function detectFormat(file: File): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'JPG',
    'image/jpg': 'JPG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/bmp': 'BMP',
    'image/gif': 'GIF',
    'image/avif': 'AVIF',
    'image/x-icon': 'ICO',
    'image/vnd.microsoft.icon': 'ICO',
  };
  const mime = file.type.toLowerCase();
  if (mimeMap[mime]) return mimeMap[mime];
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return FORMAT_EXT_MAP[ext] ?? (ext ? ext.toUpperCase() : 'IMG');
}

// 单张图片的压缩率（正数=减小，负数=变大）
function itemPercent(item: FileItem): number {
  if (item.originalSize <= 0 || item.convertedSize == null) return 0;
  return Math.round((1 - item.convertedSize / item.originalSize) * 100);
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
  const [processing, setProcessing] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const { success, error: toastError, warning } = useToast();

  const makeKey = useCallback(
    (file: File) =>
      `${file.name}-${file.size}-${file.lastModified}-${++seqRef.current}`,
    []
  );

  const addFiles = useCallback(
    (fileList: FileList) => {
      if (processing) return;
      const all = Array.from(fileList);
      const incoming = all.filter(isImageFile);
      const skipped = all.length - incoming.length;

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

        if (skipped > 0) {
          warning(`已跳过 ${skipped} 个非图片文件`);
        }
        if (oversized > 0) {
          warning(`已跳过 ${oversized} 个超过 20MB 的文件`);
        }
        if (overflow > 0) {
          warning(`已达上限 ${MAX_FILES} 张，部分文件未加入`);
        }

        const newItems: FileItem[] = accepted.map((file) => ({
          key: makeKey(file),
          file,
          originalSize: file.size,
          originalFormat: detectFormat(file),
          thumbUrl: URL.createObjectURL(file),
          status: 'pending' as const,
        }));
        return [...prev, ...newItems];
      });
    },
    [processing, makeKey, warning]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!processing && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [processing, addFiles]
  );

  // 切换格式 / 质量时清空已转换结果，避免结果与新参数错配
  const clearResults = useCallback(() => {
    setLightboxKey(null);
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
      if (processing) return;
      if (f === format) return;
      setFormat(f);
      clearResults();
    },
    [processing, format, clearResults]
  );

  const changeQuality = useCallback(
    (q: number) => {
      if (processing) return;
      setQuality(q);
      clearResults();
    },
    [processing, clearResults]
  );

  const removeFile = (item: FileItem) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.key === item.key);
      if (target) {
        URL.revokeObjectURL(target.thumbUrl);
        if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
      }
      return prev.filter((f) => f.key !== item.key);
    });
  };

  // 转换单个文件（按 item.key 定位，避免索引错位）
  const convertOne = useCallback(
    async (item: FileItem): Promise<boolean> => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.key !== item.key) return f;
          // 先释放旧预览，防止重复转换时 objectURL 泄漏
          if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
          return {
            ...f,
            convertedBlob: undefined,
            convertedSize: undefined,
            previewUrl: undefined,
            status: 'processing' as const,
            error: undefined,
          };
        })
      );
      try {
        const blob = await convertImage(item.file, format, quality);
        const previewUrl = URL.createObjectURL(blob);
        setFiles((prev) =>
          prev.map((f) =>
            f.key === item.key
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
        return true;
      } catch {
        setFiles((prev) =>
          prev.map((f) =>
            f.key === item.key
              ? { ...f, status: 'error', error: '图片无法解析或转换失败' }
              : f
          )
        );
        return false;
      }
    },
    [format, quality]
  );

  // 依次转换指定文件（内部锁定进度，防止重复触发）
  const runConvert = useCallback(
    async (targetItems: FileItem[]) => {
      if (processing || targetItems.length === 0) return;
      setProcessing(true);
      setProgress({ done: 0, total: targetItems.length });
      let ok = 0;
      let fail = 0;
      for (const item of targetItems) {
        const succeed = await convertOne(item);
        if (succeed) ok++;
        else fail++;
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      setProcessing(false);
      setProgress({ done: 0, total: 0 });
      if (fail === 0) {
        success(`转换完成：共 ${ok} 张`);
      } else {
        warning(`转换完成：成功 ${ok} 张，失败 ${fail} 张，可点击重试`);
      }
    },
    [processing, convertOne, success, warning]
  );

  const convertAll = useCallback(() => {
    const targets = files.filter(
      (f) => f.status === 'pending' || f.status === 'error'
    );
    runConvert(targets);
  }, [files, runConvert]);

  const retryOne = useCallback(
    (item: FileItem) => {
      if (processing) return;
      runConvert([item]);
    },
    [processing, runConvert]
  );

  const downloadOne = (item: FileItem) => {
    if (!item?.convertedBlob) return;
    const base = item.file.name.replace(/\.[^.]+$/, '') || 'image';
    downloadBlob(item.convertedBlob, `${base}.${FORMAT_EXT[format]}`);
  };

  // 批量打包 ZIP 下载（避免浏览器拦截逐张下载）
  const downloadZip = useCallback(async () => {
    const doneItems = files.filter((f) => f.status === 'done' && f.convertedBlob);
    if (doneItems.length === 0 || zipping || processing) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder('转换图片');
      const usedNames = new Set<string>();
      for (const item of doneItems) {
        const base = item.file.name.replace(/\.[^.]+$/, '') || 'image';
        const ext = FORMAT_EXT[format];
        let name = `${base}.${ext}`;
        let n = 2;
        while (usedNames.has(name)) {
          name = `${base}(${n++}).${ext}`;
        }
        usedNames.add(name);
        folder!.file(name, item.convertedBlob!);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      downloadBlob(content, `图片转换-${stamp}.zip`);
      success(`已打包下载 ${doneItems.length} 张图片`);
    } catch {
      toastError('打包失败，请重试');
    } finally {
      setZipping(false);
    }
  }, [files, format, zipping, processing, success, toastError]);

  const reset = () => {
    if (processing) return;
    files.forEach((f) => {
      URL.revokeObjectURL(f.thumbUrl);
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setFiles([]);
    setLightboxKey(null);
    setProgress({ done: 0, total: 0 });
  };

  const doneItems = files.filter((f) => f.status === 'done');
  const pendingCount = files.filter(
    (f) => f.status === 'pending' || f.status === 'error'
  ).length;
  const doneCount = doneItems.length;
  const totalOriginal = doneItems.reduce((sum, f) => sum + f.originalSize, 0);
  const totalConverted = doneItems.reduce(
    (sum, f) => sum + (f.convertedSize ?? 0),
    0
  );
  const savedBytes = totalOriginal - totalConverted;
  const savedPercent =
    totalOriginal > 0
      ? Math.round((savedBytes / totalOriginal) * 100)
      : 0;

  // 仅 JPG / WebP 显示质量滑块
  const showQuality =
    format === 'image/jpeg' || format === 'image/webp';
  const progressPercent =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  // 放大预览对象
  const lightboxItem =
    lightboxKey != null
      ? files.find((f) => f.key === lightboxKey && f.previewUrl)
      : undefined;

  return (
    <ToolLayout tool={tool}>
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
                if (processing) return;
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => !processing && inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                processing
                  ? 'opacity-50 pointer-events-none border-gray-200 dark:border-gray-700'
                  : 'cursor-pointer ' +
                    (dragging
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                      : 'border-gray-300 dark:border-gray-700 hover:border-brand-400')
              }`}
            >
              <div className="text-3xl mb-2">📤</div>
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
              {files.map((item) => {
                const pct = itemPercent(item);
                return (
                  <div
                    key={item.key}
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
                      <p className="text-xs text-gray-400 flex items-center gap-1.5 flex-wrap">
                        <span className="tag bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0">
                          {item.originalFormat}
                        </span>
                        {item.status === 'pending' && (
                          <span>待转换 · {formatBytes(item.originalSize)}</span>
                        )}
                        {item.status === 'processing' && (
                          <span className="text-brand-600 flex items-center gap-1">
                            <span className="inline-block w-3 h-3 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                            转换中…
                          </span>
                        )}
                        {item.status === 'done' && (
                          <span>
                            {formatBytes(item.originalSize)}
                            <span className="text-emerald-600 mx-0.5">
                              → {formatBytes(item.convertedSize ?? 0)}
                            </span>
                            <span
                              className={
                                pct >= 0 ? 'text-emerald-600' : 'text-amber-600'
                              }
                            >
                              （{pct >= 0 ? `${pct}% ↓` : `${Math.abs(pct)}% ↑`}）
                            </span>
                          </span>
                        )}
                        {item.status === 'error' && (
                          <span className="text-red-500">{item.error}</span>
                        )}
                      </p>
                    </div>
                    {item.status === 'done' && (
                      <button
                        onClick={() => downloadOne(item)}
                        className="text-xs text-brand-600 hover:underline shrink-0"
                      >
                        下载
                      </button>
                    )}
                    {item.status === 'error' && (
                      <button
                        onClick={() => retryOne(item)}
                        className="text-xs text-brand-600 hover:underline shrink-0"
                      >
                        重试
                      </button>
                    )}
                    <button
                      onClick={() => removeFile(item)}
                      disabled={processing}
                      className="text-gray-400 hover:text-red-500 shrink-0 disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
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
                    disabled={processing}
                    onClick={() => changeFormat(f)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
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
                  disabled={processing}
                  onChange={(e) => changeQuality(Number(e.target.value))}
                  className="w-full accent-brand-600 disabled:opacity-50"
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
              disabled={
                files.length === 0 || pendingCount === 0 || processing
              }
              className="btn-primary flex-1 disabled:opacity-60"
            >
              {processing ? (
                <>
                  <ButtonSpinner />
                  处理中（{progress.done}/{progress.total}）
                </>
              ) : (
                <>🔄 转换全部（{pendingCount}）</>
              )}
            </button>
            <button
              onClick={reset}
              disabled={files.length === 0 || processing}
              className="btn-ghost disabled:opacity-60"
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
                  <p className="text-xs text-gray-400 mb-1">转换后大小</p>
                  <p className="text-lg font-bold font-mono">
                    {doneCount > 0 ? formatBytes(totalConverted) : '—'}
                  </p>
                  {doneCount > 0 && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {savedBytes >= 0
                        ? `节省 ${formatBytes(savedBytes)}`
                        : `增加 ${formatBytes(-savedBytes)}`}
                    </p>
                  )}
                </div>
                <div className="card p-3 text-center border-brand-500">
                  <p className="text-xs text-gray-400 mb-1">
                    {savedPercent >= 0 ? '节省' : '增加'}
                  </p>
                  <p
                    className={`text-lg font-bold font-mono ${
                      savedPercent >= 0 ? 'text-emerald-600' : 'text-amber-600'
                    }`}
                  >
                    {doneCount > 0 ? `${Math.abs(savedPercent)}%` : '—'}
                  </p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">完成</p>
                  <p className="text-lg font-bold font-mono text-brand-600">
                    {doneCount}
                    <span className="text-sm text-gray-400 font-normal">
                      /{files.length}
                    </span>
                  </p>
                </div>
              </div>

              {/* 处理进度 */}
              {processing && (
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-2">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>正在转换…</span>
                    <span className="font-mono text-brand-600">
                      {progress.done}/{progress.total}（{progressPercent}%）
                    </span>
                  </div>
                  <ProgressBar value={progressPercent} />
                </div>
              )}

              {/* 结果列表 */}
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {doneItems.map((item) => {
                  const pct = itemPercent(item);
                  const base =
                    item.file.name.replace(/\.[^.]+$/, '') || 'image';
                  return (
                    <div key={item.key} className="card p-3">
                      <button
                        type="button"
                        onClick={() => setLightboxKey(item.key)}
                        className="relative block w-full mb-2 group"
                        aria-label={`放大预览 ${item.file.name}`}
                      >
                        <img
                          src={item.previewUrl}
                          alt={item.file.name}
                          className="w-full rounded-lg max-h-40 object-contain bg-gray-50 dark:bg-gray-800"
                        />
                        <span className="absolute inset-0 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30 text-white text-xs font-medium">
                          🔍 点击放大预览
                        </span>
                      </button>
                      <div className="flex justify-between items-center text-xs gap-2">
                        <span className="truncate">
                          {base}.{FORMAT_EXT[format]}
                        </span>
                        <span
                          className={`font-medium shrink-0 ${
                            pct >= 0 ? 'text-emerald-600' : 'text-amber-600'
                          }`}
                        >
                          {pct >= 0
                            ? `${formatBytes(item.convertedSize ?? 0)}（${pct}% ↓）`
                            : `${formatBytes(item.convertedSize ?? 0)}（${Math.abs(pct)}% ↑）`}
                        </span>
                      </div>
                      <div className="mt-2 flex gap-3">
                        <button
                          onClick={() => downloadOne(item)}
                          className="text-xs text-brand-600 hover:underline"
                        >
                          ⬇ 下载
                        </button>
                        <button
                          onClick={() => setLightboxKey(item.key)}
                          className="text-xs text-gray-500 dark:text-gray-400 hover:text-brand-600"
                        >
                          🔍 放大
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* 全部打包下载 */}
              {doneCount > 0 && (
                <button
                  onClick={downloadZip}
                  disabled={zipping || processing}
                  className="btn-primary w-full disabled:opacity-60"
                >
                  {zipping ? (
                    <>
                      <ButtonSpinner />
                      正在打包…
                    </>
                  ) : (
                    <>📦 打包下载全部（{doneCount}）</>
                  )}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* 放大预览弹窗 */}
      {lightboxItem && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
          onClick={() => setLightboxKey(null)}
        >
          <div
            className="relative max-w-3xl w-full rounded-xl bg-white dark:bg-gray-900 shadow-card overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-gray-800">
              <span className="text-sm font-medium truncate">
                {lightboxItem.file.name.replace(/\.[^.]+$/, '')}.
                {FORMAT_EXT[format]}
              </span>
              <button
                onClick={() => setLightboxKey(null)}
                className="text-gray-400 hover:text-red-500 shrink-0"
                aria-label="关闭预览"
              >
                ✕
              </button>
            </div>
            <img
              src={lightboxItem.previewUrl}
              alt={lightboxItem.file.name}
              className="w-full max-h-[70vh] object-contain p-3 bg-gray-50 dark:bg-gray-800"
            />
            <div className="flex justify-between items-center px-4 py-3 border-t border-gray-100 dark:border-gray-800">
              <span className="text-xs text-gray-400">
                {lightboxItem.originalFormat} → {FORMAT_LABEL[format]} ·{' '}
                {formatBytes(lightboxItem.convertedSize ?? 0)}
              </span>
              <button
                onClick={() => downloadOne(lightboxItem)}
                className="btn-primary !py-1.5 !text-sm"
              >
                ⬇ 下载
              </button>
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
}
