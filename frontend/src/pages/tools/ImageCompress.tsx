import { useState, useRef, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import {
  compressImage,
  formatBytes,
  downloadBlob,
  type CompressOptions,
} from '../../utils/image';
import { useToast } from '../../components/Toast';
import { ProgressBar, ButtonSpinner } from '../../components/Loading';
import JSZip from 'jszip';

const tool = tools.find((t) => t.id === 'image-compress')!;

type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp';
type ResizeMode = 'none' | 'percent' | 'width';

const FORMAT_LABEL: Record<OutputFormat, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
};

const FORMAT_EXT: Record<OutputFormat, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const FORMAT_EXT_MAP: Record<string, string> = {
  jpg: 'JPG',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
};

const MAX_FILES = 20;
const MAX_SIZE = 20 * 1024 * 1024; // 20MB

interface FileItem {
  key: string;
  file: File;
  originalSize: number;
  originalFormat: string;
  thumbUrl: string;
  compressedBlob?: Blob;
  compressedSize?: number;
  previewUrl?: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
}

// 判断是否为受支持的图片（按 MIME 或扩展名兜底，兼容无 MIME 的文件）
function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(FORMAT_EXT_MAP, ext);
}

// 解析原始格式短名
function detectFormat(file: File): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
  };
  const mime = file.type.toLowerCase();
  if (mimeMap[mime]) return mimeMap[mime];
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return FORMAT_EXT_MAP[ext] ?? '图片';
}

// 单张图片的压缩率（正数=减小，负数=变大）
function itemPercent(item: FileItem): number {
  if (item.originalSize <= 0 || item.compressedSize == null) return 0;
  return Math.round((1 - item.compressedSize / item.originalSize) * 100);
}

export default function ImageCompress() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [quality, setQuality] = useState(72);
  const [format, setFormat] = useState<OutputFormat>('image/jpeg');
  const [resizeMode, setResizeMode] = useState<ResizeMode>('none');
  const [percent, setPercent] = useState(100);
  const [widthPx, setWidthPx] = useState(1920);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [zipping, setZipping] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const { success, error: toastError, warning } = useToast();

  const makeKey = (file: File) =>
    `${file.name}-${file.size}-${file.lastModified}-${++seqRef.current}`;

  // 根据当前参数生成压缩配置
  const buildOptions = useCallback((): CompressOptions => {
    const options: CompressOptions = { quality, format };
    if (resizeMode === 'percent') {
      options.scale = percent / 100;
    } else if (resizeMode === 'width' && widthPx > 0) {
      options.maxWidth = Math.round(widthPx);
    }
    return options;
  }, [quality, format, resizeMode, percent, widthPx]);

  const addFiles = useCallback(
    (fileList: FileList) => {
      if (processing) return;
      const incoming = Array.from(fileList).filter(isImageFile);

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
    [processing, warning]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (!processing && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [processing, addFiles]
  );

  // 参数变更后清空旧结果，避免结果与新参数错配
  const clearResults = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      return prev.map((f) => ({
        ...f,
        compressedBlob: undefined,
        compressedSize: undefined,
        previewUrl: undefined,
        status: 'pending' as const,
        error: undefined,
      }));
    });
  }, []);

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

  // 压缩单个文件（按 item.key 定位，避免索引错位）
  const compressItem = useCallback(
    async (item: FileItem, options: CompressOptions): Promise<boolean> => {
      setFiles((prev) =>
        prev.map((f) =>
          f.key === item.key
            ? { ...f, status: 'processing', error: undefined }
            : f
        )
      );
      try {
        const blob = await compressImage(item.file, options);
        const previewUrl = URL.createObjectURL(blob);
        setFiles((prev) =>
          prev.map((f) =>
            f.key === item.key
              ? {
                  ...f,
                  compressedBlob: blob,
                  compressedSize: blob.size,
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
              ? {
                  ...f,
                  status: 'error',
                  error: '图片无法解析或压缩失败',
                }
              : f
          )
        );
        return false;
      }
    },
    []
  );

  // 依次压缩指定文件（内部锁定进度，防止重复触发）
  const runCompress = useCallback(
    async (targetItems: FileItem[]) => {
      if (processing || targetItems.length === 0) return;
      const options = buildOptions();
      setProcessing(true);
      setProgress({ done: 0, total: targetItems.length });
      let ok = 0;
      let fail = 0;
      for (const item of targetItems) {
        const succeed = await compressItem(item, options);
        if (succeed) ok++;
        else fail++;
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      setProcessing(false);
      setProgress({ done: 0, total: 0 });
      if (fail === 0) {
        success(`压缩完成：共 ${ok} 张`);
      } else {
        warning(`压缩完成：成功 ${ok} 张，失败 ${fail} 张，可点击重试`);
      }
    },
    [processing, buildOptions, compressItem, success, warning]
  );

  const compressAll = useCallback(() => {
    const targets = files.filter(
      (f) => f.status === 'pending' || f.status === 'error'
    );
    runCompress(targets);
  }, [files, runCompress]);

  const retryOne = useCallback(
    (item: FileItem) => {
      if (processing) return;
      runCompress([item]);
    },
    [processing, runCompress]
  );

  const downloadOne = (index: number) => {
    const item = files[index];
    if (!item?.compressedBlob) return;
    const base = item.file.name.replace(/\.[^.]+$/, '') || 'image';
    downloadBlob(item.compressedBlob, `${base}.${FORMAT_EXT[format]}`);
  };

  // 批量打包 ZIP 下载
  const downloadZip = async () => {
    const doneItems = files.filter((f) => f.status === 'done' && f.compressedBlob);
    if (doneItems.length === 0 || zipping || processing) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder('压缩图片');
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
        folder!.file(name, item.compressedBlob!);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      downloadBlob(content, `压缩图片-${stamp}.zip`);
      success(`已打包下载 ${doneItems.length} 张图片`);
    } catch {
      toastError('打包失败，请重试');
    } finally {
      setZipping(false);
    }
  };

  const reset = () => {
    if (processing) return;
    files.forEach((f) => {
      URL.revokeObjectURL(f.thumbUrl);
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
    });
    setFiles([]);
    setProgress({ done: 0, total: 0 });
  };

  const doneItems = files.filter((f) => f.status === 'done');
  const pendingCount = files.filter(
    (f) => f.status === 'pending' || f.status === 'error'
  ).length;
  const doneCount = doneItems.length;
  const totalOriginal = doneItems.reduce((sum, f) => sum + f.originalSize, 0);
  const totalCompressed = doneItems.reduce(
    (sum, f) => sum + (f.compressedSize ?? 0),
    0
  );
  const savedPercent =
    totalOriginal > 0
      ? Math.round((1 - totalCompressed / totalOriginal) * 100)
      : 0;
  const totalSaved = totalOriginal - totalCompressed;

  // 质量滑块仅对 JPG / WebP 生效
  const showQuality = format === 'image/jpeg' || format === 'image/webp';
  const progressPercent =
    progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

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
                支持 JPG / PNG / WebP / GIF · 单文件 ≤ 20MB · 最多 20 张
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
              {files.map((item, i) => {
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
                          <span>待压缩 · {formatBytes(item.originalSize)}</span>
                        )}
                        {item.status === 'processing' && (
                          <span className="text-brand-600 flex items-center gap-1">
                            <span className="inline-block w-3 h-3 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                            压缩中…
                          </span>
                        )}
                        {item.status === 'done' && (
                          <span>
                            {formatBytes(item.originalSize)}
                            <span className="text-emerald-600 mx-0.5">
                              → {formatBytes(item.compressedSize ?? 0)}
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
                        onClick={() => downloadOne(i)}
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
                      onClick={() => removeFile(i)}
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

          {/* 压缩参数 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 压缩参数
            </label>

            {/* 输出格式 */}
            <div>
              <span className="text-sm block mb-1.5">输出格式</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(['image/jpeg', 'image/png', 'image/webp'] as OutputFormat[]).map(
                  (f) => (
                    <button
                      key={f}
                      disabled={processing}
                      onClick={() => {
                        setFormat(f);
                        clearResults();
                      }}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                        format === f
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {FORMAT_LABEL[f]}
                    </button>
                  )
                )}
              </div>
              {!showQuality && (
                <p className="text-xs text-gray-400 mt-1.5">
                  PNG 为无损格式，不应用质量参数。
                </p>
              )}
            </div>

            {/* 质量参数（仅 JPG / WebP） */}
            {showQuality && (
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">压缩质量</span>
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
                  onChange={(e) => {
                    setQuality(Number(e.target.value));
                    clearResults();
                  }}
                  className="w-full accent-brand-600 disabled:opacity-50"
                />
                <p className="text-xs text-gray-400 mt-1">
                  数值越高画质越好、文件越大；建议从 70-80 起步。
                </p>
              </div>
            )}

            {/* 输出尺寸 */}
            <div>
              <span className="text-sm block mb-1.5">输出尺寸</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(
                  [
                    { mode: 'none' as ResizeMode, label: '原尺寸' },
                    { mode: 'percent' as ResizeMode, label: '按比例' },
                    { mode: 'width' as ResizeMode, label: '按像素宽' },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.mode}
                    disabled={processing}
                    onClick={() => {
                      setResizeMode(opt.mode);
                      clearResults();
                    }}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      resizeMode === opt.mode
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              {resizeMode === 'percent' && (
                <div className="mt-2.5">
                  <div className="flex justify-between mb-1">
                    <span className="text-xs text-gray-500">缩放比例</span>
                    <span className="text-xs font-mono text-brand-600">
                      {percent}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="100"
                    step="5"
                    value={percent}
                    disabled={processing}
                    onChange={(e) => {
                      setPercent(Number(e.target.value));
                      clearResults();
                    }}
                    className="w-full accent-brand-600 disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    等比例缩放，100% 表示不缩小。
                  </p>
                </div>
              )}

              {resizeMode === 'width' && (
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-xs text-gray-500">最大宽度</span>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={widthPx}
                    disabled={processing}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (!Number.isNaN(v) && v >= 0) {
                        setWidthPx(Math.min(10000, Math.round(v)));
                        clearResults();
                      }
                    }}
                    className="w-28 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 disabled:opacity-50"
                  />
                  <span className="text-xs text-gray-500">px，高度等比</span>
                </div>
              )}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2">
            <button
              onClick={compressAll}
              disabled={files.length === 0 || pendingCount === 0 || processing}
              className="btn-primary flex-1 disabled:opacity-60"
            >
              {processing ? (
                <>
                  <ButtonSpinner />
                  处理中（{progress.done}/{progress.total}）
                </>
              ) : (
                <>🗜️ 压缩全部（{pendingCount}）</>
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
            ③ 预览结果
          </label>

          {files.length === 0 ? (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
              上传图片后将显示压缩结果
            </div>
          ) : (
            <>
              {/* 统计卡片 */}
              <div className="grid grid-cols-3 gap-3">
                <div className="card p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">已压缩大小</p>
                  <p className="text-lg font-bold font-mono">
                    {doneCount > 0 ? formatBytes(totalCompressed) : '—'}
                  </p>
                  {doneCount > 0 && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      节省 {formatBytes(totalSaved)}
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
                    <span>正在压缩…</span>
                    <span className="font-mono text-brand-600">
                      {progress.done}/{progress.total}（{progressPercent}%）
                    </span>
                  </div>
                  <ProgressBar value={progressPercent} />
                </div>
              )}

              {/* 预览图 */}
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {doneItems.map((item) => {
                  const pct = itemPercent(item);
                  const base = item.file.name.replace(/\.[^.]+$/, '') || 'image';
                  return (
                    <div key={item.key} className="card p-3">
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="w-full rounded-lg mb-2 max-h-40 object-contain bg-gray-50 dark:bg-gray-800"
                      />
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
                            ? `${formatBytes(item.compressedSize ?? 0)}（${pct}% ↓）`
                            : `${formatBytes(item.compressedSize ?? 0)}（${Math.abs(pct)}% ↑）`}
                        </span>
                      </div>
                      {pct < 0 && (
                        <p className="text-[10px] text-amber-600 mt-1">
                          结果比原图更大，可降低质量或选择 WebP 格式。
                        </p>
                      )}
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
    </ToolLayout>
  );
}
