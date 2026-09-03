import { useState, useRef, useCallback, useEffect } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob, formatBytes } from '../../utils/image';
import { getPdfjsLib } from '../../utils/pdfjs';
import type { PDFDocumentProxy } from '../../utils/pdfjs';

const tool = tools.find((t) => t.id === 'pdf-to-image')!;

// 单文件大小上限：50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

type OutputFormat = 'png' | 'jpg';
type Scale = 1 | 2 | 3;

interface PageResult {
  url: string; // 预览用的 object URL
  blob: Blob; // 原始数据，用于下载
  pageNum: number;
  width: number;
  height: number;
}

// 读取 File 为 Uint8Array
async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

// canvas → blob（按格式选择 MIME 与质量）
function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: OutputFormat
): Promise<Blob> {
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('图片导出失败'));
      },
      mime,
      format === 'jpg' ? 0.92 : undefined
    );
  });
}

export default function PDFToImage() {
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<OutputFormat>('png');
  const [scale, setScale] = useState<Scale>(2);
  const [pages, setPages] = useState<PageResult[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [downloadingAll, setDownloadingAll] = useState(false);
  const [dragging, setDragging] = useState(false);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const cancelledRef = useRef(false);
  const pagesRef = useRef<PageResult[]>([]);

  // 同步最新 pages，便于卸载时清理
  useEffect(() => {
    pagesRef.current = pages;
  }, [pages]);

  // 组件卸载时撤销所有 object URL
  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, []);

  // 撤销现有预览并清空列表
  const clearPages = useCallback(() => {
    setPages((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
  }, []);

  // 校验文件
  const validateFile = (f: File): string | null => {
    if (
      f.type !== 'application/pdf' &&
      !f.name.toLowerCase().endsWith('.pdf')
    ) {
      return '请上传 PDF 文件';
    }
    if (f.size > MAX_FILE_SIZE) {
      return `文件大小超过限制（≤ ${formatBytes(MAX_FILE_SIZE)}）`;
    }
    return null;
  };

  // 选择文件
  const handleFile = async (f: File) => {
    const err = validateFile(f);
    if (err) {
      setError(err);
      return;
    }
    setError('');
    clearPages();
    setFile(f);
    try {
      const bytes = await fileToBytes(f);
      bytesRef.current = bytes;
    } catch {
      setError('读取文件失败');
      setFile(null);
      bytesRef.current = null;
    }
  };

  // 开始转换
  const handleConvert = async () => {
    if (!bytesRef.current) {
      setError('请先上传 PDF 文件');
      return;
    }
    setProcessing(true);
    setError('');
    clearPages();
    cancelledRef.current = false;

    try {
      const pdfjsLib = await getPdfjsLib();
      // 每次转换都从副本重新加载，避免 pdfjs transfer 原数组
      const loadingTask = pdfjsLib.getDocument({
        data: bytesRef.current.slice(),
      });
      const pdf = await loadingTask.promise;
      docRef.current = pdf;
      const total = pdf.numPages;
      setProgress({ current: 0, total });

      const results: PageResult[] = [];
      for (let i = 1; i <= total; i++) {
        if (cancelledRef.current) break;
        setProgress({ current: i, total });

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d')!;

        // JPG 不支持透明，先填充白底
        if (format === 'jpg') {
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // v4 使用 canvasContext 参数
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await canvasToBlob(canvas, format);
        results.push({
          url: URL.createObjectURL(blob),
          blob,
          pageNum: i,
          width: canvas.width,
          height: canvas.height,
        });
        setPages([...results]);
      }

      try {
        await loadingTask.destroy();
      } catch {
        // 忽略销毁错误
      }
    } catch (e: any) {
      if (!cancelledRef.current) {
        setError(e?.message || 'PDF 转换失败，请检查文件是否损坏');
      }
    } finally {
      setProcessing(false);
      setProgress(null);
    }
  };

  // 单页下载
  const handleDownloadOne = (p: PageResult) => {
    const ext = format === 'png' ? 'png' : 'jpg';
    const base = file?.name.replace(/\.pdf$/i, '') || 'page';
    downloadBlob(p.blob, `${base}_${p.pageNum}.${ext}`);
  };

  // 全部下载（逐个，带间隔避免浏览器拦截）
  const handleDownloadAll = async () => {
    if (pages.length === 0) return;
    setDownloadingAll(true);
    const ext = format === 'png' ? 'png' : 'jpg';
    const base = file?.name.replace(/\.pdf$/i, '') || 'page';
    for (let i = 0; i < pages.length; i++) {
      downloadBlob(pages[i].blob, `${base}_${pages[i].pageNum}.${ext}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    setDownloadingAll(false);
  };

  // 重置
  const handleReset = () => {
    clearPages();
    setFile(null);
    bytesRef.current = null;
    setError('');
    setProgress(null);
    setProcessing(false);
    setDownloadingAll(false);
  };

  const sizeHint = `仅支持 PDF · 单文件 ≤ ${formatBytes(MAX_FILE_SIZE)}`;
  const hasResults = pages.length > 0;

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        {/* 错误提示 */}
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            ⚠️ {error}
          </div>
        )}

        {/* 上传区 + 参数设置（左右分栏） */}
        <div className="grid md:grid-cols-2 gap-4">
          {/* 上传区 */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 上传 PDF
            </label>
            {file ? (
              <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
                <span className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
                  📄
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{file.name}</p>
                  <p className="text-xs text-gray-400">
                    {formatBytes(file.size)}
                  </p>
                </div>
                <button
                  onClick={handleReset}
                  className="text-gray-400 hover:text-red-500 text-xs px-1"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ) : (
              <>
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) handleFile(f);
                  }}
                  onClick={() => inputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                    dragging
                      ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                      : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
                  }`}
                >
                  <div className="text-3xl mb-2">📤</div>
                  <p className="font-medium text-sm">拖拽 PDF 至此 或 点击选择</p>
                  <p className="text-xs text-gray-400 mt-1">{sizeHint}</p>
                </div>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    e.target.value = '';
                  }}
                />
              </>
            )}
          </div>

          {/* 参数设置 */}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ② 输出格式
              </label>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(['png', 'jpg'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      format === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {format === 'png'
                  ? '无损压缩，支持透明背景'
                  : '有损压缩，体积更小（白底）'}
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ③ 缩放比例
              </label>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {([1, 2, 3] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScale(s)}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      scale === s
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">
                倍数越大越清晰，同时体积与耗时也增加。1x 为正常 DPI。
              </p>
            </div>
          </div>
        </div>

        {/* 转换按钮 */}
        <div className="flex gap-2">
          <button
            onClick={handleConvert}
            disabled={processing || !file}
            className="btn-primary flex-1"
          >
            {processing
              ? `转换中…${progress ? ` ${progress.current}/${progress.total}` : ''}`
              : '🖼️ 开始转换'}
          </button>
          {hasResults && (
            <button
              onClick={handleDownloadAll}
              disabled={downloadingAll || processing}
              className="btn-ghost"
            >
              {downloadingAll ? '下载中…' : `⬇️ 全部下载（${pages.length}）`}
            </button>
          )}
        </div>

        {/* 进度条 */}
        {processing && progress && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-500">
              <span>正在转换 {progress.current}/{progress.total} 页</span>
              <span>
                {Math.round((progress.current / progress.total) * 100)}%
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-600 transition-all"
                style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                }}
              />
            </div>
          </div>
        )}

        {/* 结果区：缩略图网格 */}
        {hasResults && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium">
                转换结果（{pages.length} 页）
              </h3>
              <span className="text-xs text-gray-400">
                格式 {format.toUpperCase()} · {scale}x
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {pages.map((p) => (
                <div
                  key={p.pageNum}
                  className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden bg-gray-50 dark:bg-gray-800"
                >
                  {/* 缩略图 */}
                  <div className="aspect-[3/4] flex items-center justify-center overflow-hidden bg-gray-100 dark:bg-gray-900">
                    <img
                      src={p.url}
                      alt={`第 ${p.pageNum} 页`}
                      className="max-w-full max-h-full object-contain"
                    />
                  </div>
                  {/* 页码 + 下载 */}
                  <div className="flex items-center justify-between px-2 py-1.5">
                    <span className="text-xs text-gray-500">
                      第 {p.pageNum} 页
                    </span>
                    <button
                      onClick={() => handleDownloadOne(p)}
                      className="text-xs text-brand-600 hover:text-brand-700 font-medium"
                      title="下载本页"
                    >
                      ⬇️ 下载
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部提示 */}
        <p className="text-xs text-gray-400 text-center">
          所有操作均在浏览器本地完成，文件不会上传到服务器
        </p>
      </div>
    </ToolLayout>
  );
}
