import { useState, useRef, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { compressImage, formatBytes, downloadBlob } from '../../utils/image';

const tool = tools.find((t) => t.id === 'image-compress')!;

interface FileItem {
  file: File;
  originalSize: number;
  compressedBlob?: Blob;
  compressedSize?: number;
  previewUrl?: string;
  status: 'pending' | 'processing' | 'done' | 'error';
}

type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp';

export default function ImageCompress() {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [quality, setQuality] = useState(72);
  const [format, setFormat] = useState<OutputFormat>('image/jpeg');
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((fileList: FileList) => {
    const newFiles: FileItem[] = Array.from(fileList)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, 20)
      .map((file) => ({
        file,
        originalSize: file.size,
        status: 'pending' as const,
      }));
    setFiles((prev) => [...prev, ...newFiles].slice(0, 20));
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const compressOne = async (index: number) => {
    setFiles((prev) =>
      prev.map((f, i) => (i === index ? { ...f, status: 'processing' } : f))
    );
    try {
      const item = files[index];
      const blob = await compressImage(item.file, { quality, format });
      const url = URL.createObjectURL(blob);
      setFiles((prev) =>
        prev.map((f, i) =>
          i === index
            ? {
                ...f,
                compressedBlob: blob,
                compressedSize: blob.size,
                previewUrl: url,
                status: 'done',
              }
            : f
        )
      );
    } catch {
      setFiles((prev) =>
        prev.map((f, i) => (i === index ? { ...f, status: 'error' } : f))
      );
    }
  };

  const compressAll = async () => {
    for (let i = 0; i < files.length; i++) {
      if (files[i].status !== 'done') {
        await compressOne(i);
      }
    }
  };

  const downloadOne = (index: number) => {
    const item = files[index];
    if (!item.compressedBlob) return;
    const ext = format === 'image/jpeg' ? 'jpg' : format === 'image/png' ? 'png' : 'webp';
    const name = item.file.name.replace(/\.[^.]+$/, '') + '.' + ext;
    downloadBlob(item.compressedBlob, name);
  };

  const reset = () => {
    files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    setFiles([]);
  };

  const doneCount = files.filter((f) => f.status === 'done').length;
  const totalOriginal = files.reduce((sum, f) => sum + f.originalSize, 0);
  const totalCompressed = files.reduce((sum, f) => sum + (f.compressedSize ?? 0), 0);
  const savedPercent = totalOriginal > 0
    ? Math.round((1 - totalCompressed / totalOriginal) * 100)
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
              <div className="text-3xl mb-2">📤</div>
              <p className="font-medium text-sm">拖拽图片至此 或 点击选择</p>
              <p className="text-xs text-gray-400 mt-1">
                支持 JPG/PNG/WebP · 单文件 ≤ 20MB · 最多 20 张
              </p>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => e.target.files && addFiles(e.target.files)}
              />
            </div>
          </div>

          {/* 文件列表 */}
          {files.length > 0 && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {files.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2"
                >
                  <div className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
                    🖼️
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{item.file.name}</p>
                    <p className="text-xs text-gray-400">
                      {formatBytes(item.originalSize)}
                      {item.compressedSize && (
                        <span className="text-emerald-600 ml-1">
                          → {formatBytes(item.compressedSize)}
                        </span>
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

          {/* 压缩参数 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 压缩参数
            </label>

            <div>
              <div className="flex justify-between mb-1">
                <span className="text-sm">压缩质量</span>
                <span className="text-sm font-mono text-brand-600">{quality}%</span>
              </div>
              <input
                type="range"
                min="1"
                max="100"
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full accent-brand-600"
              />
            </div>

            <div>
              <span className="text-sm block mb-1.5">输出格式</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(['image/jpeg', 'image/png', 'image/webp'] as OutputFormat[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      format === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500'
                    }`}
                  >
                    {f === 'image/jpeg' ? 'JPG' : f === 'image/png' ? 'PNG' : 'WebP'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={compressAll}
              disabled={files.length === 0}
              className="btn-primary flex-1"
            >
              🗜️ 压缩全部（{files.length}）
            </button>
            <button onClick={reset} className="btn-ghost">
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
                  <p className="text-xs text-gray-400 mb-1">原始大小</p>
                  <p className="text-lg font-bold font-mono">
                    {formatBytes(totalOriginal)}
                  </p>
                </div>
                <div className="card p-3 text-center border-brand-500">
                  <p className="text-xs text-gray-400 mb-1">压缩后</p>
                  <p className="text-lg font-bold font-mono text-brand-600">
                    {formatBytes(totalCompressed)}
                  </p>
                </div>
                <div className="card p-3 text-center">
                  <p className="text-xs text-gray-400 mb-1">节省</p>
                  <p className="text-lg font-bold font-mono text-emerald-600">
                    {savedPercent}%
                  </p>
                </div>
              </div>

              {/* 预览图 */}
              <div className="space-y-3 max-h-80 overflow-y-auto">
                {files
                  .filter((f) => f.previewUrl)
                  .map((item, i) => (
                    <div key={i} className="card p-3">
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        className="w-full rounded-lg mb-2 max-h-40 object-contain bg-gray-50 dark:bg-gray-800"
                      />
                      <div className="flex justify-between text-xs">
                        <span className="truncate">{item.file.name}</span>
                        <span className="text-emerald-600 font-medium">
                          {Math.round(
                            (1 - (item.compressedSize ?? 0) / item.originalSize) * 100
                          )}
                          % ↓
                        </span>
                      </div>
                    </div>
                  ))}
              </div>

              {doneCount > 0 && (
                <button
                  onClick={() => files.forEach((_, i) => downloadOne(i))}
                  className="btn-primary w-full"
                >
                  ⬇️ 全部下载
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </ToolLayout>
  );
}
