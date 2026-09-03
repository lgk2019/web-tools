import { useState, useRef, useEffect } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob, formatBytes } from '../../utils/image';
import { getPdfjsLib } from '../../utils/pdfjs';
import type {
  PDFDocumentProxy,
  PDFDocumentLoadingTask,
  PDFPageProxy,
} from '../../utils/pdfjs';
import { useToast } from '../../components/Toast';
import { ProgressBar, ButtonSpinner } from '../../components/Loading';
import JSZip from 'jszip';

const tool = tools.find((t) => t.id === 'pdf-to-image')!;

// 单文件大小上限（与需求文档一致）
const MAX_FILE_SIZE = 50 * 1024 * 1024;
// 上传后最多渲染缩略图的页数（超出部分仅显示页码占位，不影响转换）
const MAX_THUMB_PAGES = 40;
// 缩略图目标最大边
const THUMB_MAX_SIDE = 120;
// 浏览器 canvas 安全上限，避免超大页面导出失败/黑图
const MAX_CANVAS_SIDE = 16384;
const MAX_CANVAS_AREA = 268435456; // 16384 × 16384
const JPG_QUALITY = 0.92;

type OutputFormat = 'png' | 'jpg';
type PageRangeMode = 'all' | 'custom';
type ItemStatus = 'pending' | 'processing' | 'done' | 'error';
type BusyKind = 'parsing' | 'converting' | null;

interface PageItem {
  id: string; // 稳定唯一 key（页面可删除，不能用页码做 key）
  pageNum: number; // PDF 中的原始页码（1 起）
  thumbUrl?: string; // 上传后解析生成的低清缩略图
  status: ItemStatus;
  error?: string;
  blob?: Blob; // 完整尺寸结果（下载/ZIP 用）
  url?: string; // 完整尺寸预览 object URL
  width?: number;
  height?: number;
  size?: number;
}

const FORMAT_META: Record<OutputFormat, { ext: string; mime: string; desc: string }> = {
  png: { ext: 'png', mime: 'image/png', desc: '无损压缩，支持透明背景' },
  jpg: { ext: 'jpg', mime: 'image/jpeg', desc: '有损压缩，体积更小（白底）' },
};

const SCALE_OPTIONS = [1, 1.5, 2];

/**
 * 解析“1-3,5、2,4-6”式页码范围。
 * 语法错误返回 null；超出 totalPages 的部分自动忽略。
 */
function parsePageRange(text: string, totalPages: number): number[] | null {
  const s = text.trim();
  if (!s) return null;
  const segs = s.split(',');
  const nums = new Set<number>();
  for (const raw of segs) {
    const seg = raw.trim();
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(seg);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from) return null;
    for (let p = from; p <= to && p <= totalPages; p++) nums.add(p);
  }
  return [...nums].sort((a, b) => a - b);
}

// canvas → blob
function canvasToBlob(canvas: HTMLCanvasElement, format: OutputFormat): Promise<Blob> {
  const meta = FORMAT_META[format];
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('图片导出失败'))),
      meta.mime,
      format === 'jpg' ? JPG_QUALITY : undefined
    );
  });
}

/**
 * 渲染单页到指定倍率的 Blob（JPG 先填白底）。
 * 渲染前校验画布尺寸上限，超限抛出可读错误。
 */
async function renderPage(
  page: PDFPageProxy,
  scale: number,
  format: OutputFormat
): Promise<{ blob: Blob; width: number; height: number }> {
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  if (
    width > MAX_CANVAS_SIDE ||
    height > MAX_CANVAS_SIDE ||
    width * height > MAX_CANVAS_AREA
  ) {
    throw new Error('页面尺寸过大，请降低倍率后重试');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布');
  // JPG 不支持透明，先铺白色背景
  if (format === 'jpg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }
  await page.render({ canvasContext: ctx, viewport }).promise;
  const blob = await canvasToBlob(canvas, format);
  return { blob, width, height };
}

// 将 pdfjs 异常转成用户可读的中文信息
function describePdfError(e: unknown): string {
  const err = (e ?? {}) as { name?: string; message?: string };
  const name = err.name ?? '';
  if (name === 'PasswordException') {
    return '该 PDF 已加密（需要密码），暂不支持加密文档';
  }
  if (name === 'InvalidPDFException') {
    return '无法解析该 PDF，文件可能已损坏或不是有效的 PDF';
  }
  if (name === 'MissingPDFException') {
    return '未能读取到 PDF 内容，请重试';
  }
  if (name === 'PDFJS_VERSION_MISMATCH' || name === 'UnknownErrorException') {
    return 'PDF 渲染引擎异常，请重试';
  }
  return err.message || 'PDF 处理失败，请重试';
}

// 撤销单个页面项占用的 object URL
function revokeItemUrls(item: PageItem) {
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  if (item.url) URL.revokeObjectURL(item.url);
}

// 读取 File 为 Uint8Array
async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export default function PDFToImage() {
  const [file, setFile] = useState<File | null>(null);
  const [totalPages, setTotalPages] = useState(0);
  const [items, setItems] = useState<PageItem[]>([]);
  const [format, setFormat] = useState<OutputFormat>('png');
  const [scale, setScale] = useState(1);
  const [rangeMode, setRangeMode] = useState<PageRangeMode>('all');
  const [rangeText, setRangeText] = useState('');
  const [busy, setBusy] = useState<BusyKind>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [zipping, setZipping] = useState(false);
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const fileIdRef = useRef('');
  const genRef = useRef(0); // 代际令牌：切换文件/重置/卸载后使旧异步流程失效
  const busyRef = useRef(false); // 同步锁，防止快速连点重复进入处理流程
  const itemsRef = useRef<PageItem[]>([]);

  const { success, error: toastError, warning } = useToast();

  // 供卸载清理时使用的最新列表
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // 卸载时：使异步流程失效 + 撤销所有 URL + 销毁 PDF 文档
  useEffect(() => {
    const gen = genRef;
    const list = itemsRef;
    const docRefBox = docRef;
    return () => {
      gen.current++;
      list.current.forEach(revokeItemUrls);
      const doc = docRefBox.current;
      docRefBox.current = null;
      if (doc) void doc.destroy().catch(() => undefined);
    };
  }, []);

  const locked = busy !== null || zipping;

  // 重置内部状态（不校验忙碌状态，调用方负责）
  const resetState = () => {
    genRef.current++;
    busyRef.current = false;
    setItems((prev) => {
      prev.forEach(revokeItemUrls);
      return [];
    });
    const doc = docRef.current;
    docRef.current = null;
    if (doc) void doc.destroy().catch(() => undefined);
    bytesRef.current = null;
    fileIdRef.current = '';
    setTotalPages(0);
    setProgress(null);
    setBusy(null);
    setError('');
  };

  // 校验上传文件
  const validateFile = (f: File): string | null => {
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      return '请上传 PDF 文件';
    }
    if (f.size > MAX_FILE_SIZE) {
      return `文件大小超过限制（≤ ${formatBytes(MAX_FILE_SIZE)}）`;
    }
    return null;
  };

  // 解析 PDF：读取页数并渲染前若干页缩略图
  const parsePdf = async () => {
    if (busyRef.current) return;
    const src = bytesRef.current;
    if (!src) return;
    busyRef.current = true;
    const t = ++genRef.current;
    setBusy('parsing');
    setError('');
    setTotalPages(0);
    setProgress(null);
    let loadingTask: PDFDocumentLoadingTask | null = null;
    try {
      const lib = await getPdfjsLib();
      if (t !== genRef.current) return;
      // 传入副本，避免 pdfjs 将 bytesRef 底层数组 transfer 走
      loadingTask = lib.getDocument({ data: src.slice() });
      const doc = await loadingTask.promise;
      if (t !== genRef.current) {
        void doc.destroy().catch(() => undefined);
        return;
      }
      docRef.current = doc;
      const total = doc.numPages;
      setTotalPages(total);
      const fileId = fileIdRef.current;
      const rows: PageItem[] = [];
      for (let n = 1; n <= total; n++) {
        rows.push({ id: `${fileId}-${n}`, pageNum: n, status: 'pending' });
      }
      setItems(rows);

      // 渐进渲染缩略图（限制数量，避免超大文档卡死）
      const thumbCount = Math.min(total, MAX_THUMB_PAGES);
      for (let i = 0; i < thumbCount; i++) {
        if (t !== genRef.current) return;
        const page = await doc.getPage(i + 1);
        const vp = page.getViewport({ scale: 1 });
        const thumbScale = Math.min(1, THUMB_MAX_SIDE / Math.max(vp.width, vp.height));
        const { blob } = await renderPage(page, thumbScale, 'png');
        if (t !== genRef.current) return;
        const thumbUrl = URL.createObjectURL(blob);
        setItems((prev) =>
          prev.map((it) => (it.id === `${fileId}-${i + 1}` ? { ...it, thumbUrl } : it))
        );
      }
      success(`已解析 PDF，共 ${total} 页`);
    } catch (e) {
      if (t !== genRef.current) return;
      const msg = describePdfError(e);
      setError(msg);
      toastError(msg);
    } finally {
      if (loadingTask && !docRef.current) {
        // 解析失败时释放任务资源
        void loadingTask.destroy().catch(() => undefined);
      }
      if (t === genRef.current) {
        busyRef.current = false;
        setBusy(null);
      }
    }
  };

  // 选择 / 拖拽文件
  const handleFile = async (f: File) => {
    if (busyRef.current || zipping) return;
    const err = validateFile(f);
    if (err) {
      setError(err);
      toastError(err);
      return;
    }
    resetState();
    setFile(f);
    fileIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const gen = genRef.current;
    try {
      const bytes = await fileToBytes(f);
      if (gen !== genRef.current) return; // 读取期间用户已重置/移除
      bytesRef.current = bytes;
    } catch {
      setFile(null);
      setError('读取文件失败');
      toastError('读取文件失败');
      return;
    }
    await parsePdf();
  };

  // 顺序转换目标页面（可单独重试某个失败页）
  const runConvert = async (targets: PageItem[]) => {
    if (busyRef.current || zipping) return;
    if (targets.length === 0) return;
    busyRef.current = true;
    const t = ++genRef.current;
    setBusy('converting');
    setError('');
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    let fail = 0;
    let fatal = false;
    try {
      let doc = docRef.current;
      if (!doc) {
        const src = bytesRef.current;
        if (!src) throw new Error('请先上传 PDF 文件');
        const lib = await getPdfjsLib();
        const loadingTask = lib.getDocument({ data: src.slice() });
        const loaded = await loadingTask.promise;
        if (t !== genRef.current) {
          void loaded.destroy().catch(() => undefined);
          return;
        }
        docRef.current = loaded;
        doc = loaded;
      }
      for (const item of targets) {
        if (t !== genRef.current) return;
        setItems((prev) =>
          prev.map((it) =>
            it.id === item.id ? { ...it, status: 'processing', error: undefined } : it
          )
        );
        try {
          const page = await doc.getPage(item.pageNum);
          const result = await renderPage(page, scale, format);
          if (t !== genRef.current) return;
          const url = URL.createObjectURL(result.blob);
          setItems((prev) =>
            prev.map((it) =>
              it.id === item.id
                ? {
                    ...it,
                    status: 'done',
                    blob: result.blob,
                    url,
                    width: result.width,
                    height: result.height,
                    size: result.blob.size,
                    error: undefined,
                  }
                : it
            )
          );
          ok++;
        } catch (e) {
          if (t !== genRef.current) return;
          const msg = describePdfError(e);
          setItems((prev) =>
            prev.map((it) => (it.id === item.id ? { ...it, status: 'error', error: msg } : it))
          );
          fail++;
        }
        if (t !== genRef.current) return;
        setProgress((p) => (p ? { done: p.done + 1, total: p.total } : null));
      }
    } catch (e) {
      if (t !== genRef.current) return;
      fatal = true;
      const msg = describePdfError(e);
      setError(msg);
      toastError(msg);
    } finally {
      if (t === genRef.current) {
        busyRef.current = false;
        setBusy(null);
        setProgress(null);
      }
    }
    if (t === genRef.current && !fatal) {
      if (fail === 0) {
        success(`转换完成：共 ${ok} 页`);
      } else if (ok > 0) {
        warning(`转换完成：成功 ${ok} 页，失败 ${fail} 页，可在列表中重试`);
      } else {
        toastError(`转换失败：${fail} 页，可在列表中重试`);
      }
    }
  };

  // 开始转换
  const handleConvert = () => {
    if (busyRef.current || zipping || !file) return;
    let targets: PageItem[];
    if (rangeMode === 'custom') {
      const nums = parsePageRange(rangeText, totalPages);
      if (!nums || nums.length === 0) {
        setError('页码范围无效，请检查格式（如 1-3,5、2,4-6）');
        return;
      }
      targets = items.filter(
        (it) => (it.status === 'pending' || it.status === 'error') && nums.includes(it.pageNum)
      );
      if (targets.length === 0) {
        setError('所选页码范围没有待转换的页面');
        return;
      }
    } else {
      targets = items.filter((it) => it.status === 'pending' || it.status === 'error');
      if (targets.length === 0) {
        setError('没有待转换的页面');
        return;
      }
    }
    void runConvert(targets);
  };

  // 移除单个页面项（撤销 URL）
  const removeItem = (item: PageItem) => {
    if (busyRef.current || zipping) return;
    setItems((prev) => {
      const target = prev.find((it) => it.id === item.id);
      if (target) revokeItemUrls(target);
      return prev.filter((it) => it.id !== item.id);
    });
  };

  // 参数变更会使已有结果失效（结果与参数错配），回到待转换状态
  const invalidateResults = () => {
    if (busyRef.current || zipping) return;
    setItems((prev) =>
      prev.map((it) => {
        if (it.status !== 'done' && it.status !== 'error') return it;
        if (it.url) URL.revokeObjectURL(it.url);
        return {
          ...it,
          status: 'pending',
          blob: undefined,
          url: undefined,
          width: undefined,
          height: undefined,
          size: undefined,
          error: undefined,
        };
      })
    );
  };

  const changeFormat = (f: OutputFormat) => {
    if (busyRef.current || zipping || f === format) return;
    setFormat(f);
    invalidateResults();
  };

  const changeScale = (s: number) => {
    if (busyRef.current || zipping || s === scale) return;
    setScale(s);
    invalidateResults();
  };

  // 移除整个文件并复位
  const handleReset = () => {
    if (busyRef.current || zipping) return;
    resetState();
    setFile(null);
    setRangeMode('all');
    setRangeText('');
  };

  // 单页下载
  const downloadOne = (item: PageItem) => {
    if (!item.blob) return;
    downloadBlob(item.blob, pageFileName(item.pageNum));
  };

  // ZIP 打包全部成功页
  const downloadZip = async () => {
    const doneItems = items.filter((it) => it.status === 'done' && it.blob);
    if (doneItems.length === 0 || busyRef.current || zipping) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder(pdfBase);
      const usedNames = new Set<string>();
      for (const it of doneItems) {
        let name = pageFileName(it.pageNum);
        let n = 2;
        while (usedNames.has(name)) {
          name = `${pdfBase}-第${it.pageNum}页(${n++}).${FORMAT_META[format].ext}`;
        }
        usedNames.add(name);
        folder!.file(name, it.blob!);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      downloadBlob(content, `${pdfBase}-图片-${stamp}.zip`);
      success(`已打包下载 ${doneItems.length} 张图片`);
    } catch {
      toastError('打包失败，请重试');
    } finally {
      setZipping(false);
    }
  };

  const pdfBase = file ? file.name.replace(/\.pdf$/i, '') || 'PDF' : '';
  const ext = FORMAT_META[format].ext;
  const pageFileName = (n: number) => `${pdfBase}-第${n}页.${ext}`;

  // 结果/统计派生数据
  const doneItems = items.filter((it) => it.status === 'done');
  const errorItems = items.filter((it) => it.status === 'error');
  const doneSize = doneItems.reduce((sum, it) => sum + (it.size ?? 0), 0);
  const pendingCount = items.filter((it) => it.status === 'pending').length;
  const customNums =
    rangeMode === 'custom' && rangeText.trim() !== '' ? parsePageRange(rangeText, totalPages) : null;
  const customEmpty = rangeMode === 'custom' && rangeText.trim() !== '' && customNums !== null && customNums.length === 0;
  const customInvalid = rangeMode === 'custom' && rangeText.trim() !== '' && customNums === null;
  const selectable = items.filter((it) => it.status === 'pending' || it.status === 'error');
  const convertable =
    rangeMode === 'all'
      ? selectable.length
      : customNums
        ? selectable.filter((it) => customNums.includes(it.pageNum)).length
        : 0;
  const customReady = rangeMode === 'custom' && rangeText.trim() !== '' && customNums !== null && customNums.length > 0;
  const canConvert =
    !!file &&
    items.length > 0 &&
    !locked &&
    (rangeMode === 'all' || customReady) &&
    convertable > 0;
  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  const sizeHint = `仅支持 PDF · 单文件 ≤ ${formatBytes(MAX_FILE_SIZE)}`;

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* ===== 左列：上传 + 页面列表 + 参数 ===== */}
        <div className="space-y-4">
          {/* 错误横幅 */}
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
              <span className="flex-1">⚠️ {error}</span>
              {file && items.length === 0 && busy === null && (
                <button
                  onClick={() => void parsePdf()}
                  className="shrink-0 text-red-500 hover:underline font-medium"
                >
                  重试解析
                </button>
              )}
            </div>
          )}

          {/* ① 上传 PDF */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 上传 PDF
            </label>
            {file ? (
              <div>
                <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
                  <span className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
                    📄
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{file.name}</p>
                    <p className="text-xs text-gray-400">
                      {formatBytes(file.size)}
                      {totalPages > 0 && ` · 共 ${totalPages} 页`}
                    </p>
                  </div>
                  <button
                    onClick={handleReset}
                    disabled={locked}
                    className="text-gray-400 hover:text-red-500 text-xs px-1 disabled:opacity-40"
                    title="移除文件"
                  >
                    ✕
                  </button>
                </div>
                {busy === 'parsing' && (
                  <p className="flex items-center gap-1.5 text-xs text-brand-600 mt-2">
                    <ButtonSpinner />
                    正在解析页面并生成缩略图…
                  </p>
                )}
              </div>
            ) : (
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
                  if (f) void handleFile(f);
                }}
                onClick={() => inputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                  dragging
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                    : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
                }`}
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="font-medium text-sm">拖拽 PDF 至此 或 点击选择</p>
                <p className="text-xs text-gray-400 mt-1">{sizeHint}</p>
                <input
                  ref={inputRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
            )}
          </div>

          {/* 页面列表 */}
          {items.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">
                  页面列表
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    （共 {totalPages} 页）
                  </span>
                </span>
                <button
                  onClick={handleReset}
                  disabled={locked}
                  className="text-xs text-gray-400 hover:text-red-500 disabled:opacity-40"
                >
                  移除全部
                </button>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto pr-0.5">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2"
                  >
                    {item.url || item.thumbUrl ? (
                      <img
                        src={item.url ?? item.thumbUrl}
                        alt={`第 ${item.pageNum} 页`}
                        className="w-10 h-10 rounded object-cover bg-white dark:bg-gray-900 shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[10px] text-gray-500 dark:text-gray-300 shrink-0">
                        P{item.pageNum}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{pageFileName(item.pageNum)}</p>
                      {item.status === 'pending' && (
                        <p className="text-xs text-gray-400">待转换</p>
                      )}
                      {item.status === 'processing' && (
                        <p className="text-xs text-brand-600 flex items-center gap-1">
                          <span className="inline-block w-3 h-3 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
                          渲染中…
                        </p>
                      )}
                      {item.status === 'done' && (
                        <p className="text-xs text-gray-400">
                          {formatBytes(item.size ?? 0)}
                          <span className="text-gray-500 mx-1">·</span>
                          {item.width}×{item.height}
                        </p>
                      )}
                      {item.status === 'error' && (
                        <p className="text-xs text-red-500 truncate" title={item.error}>
                          {item.error}
                        </p>
                      )}
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
                        onClick={() => void runConvert([item])}
                        disabled={locked}
                        className="text-xs text-brand-600 hover:underline shrink-0 disabled:opacity-50"
                      >
                        重试
                      </button>
                    )}
                    <button
                      onClick={() => removeItem(item)}
                      disabled={locked}
                      className="text-gray-400 hover:text-red-500 shrink-0 disabled:opacity-40"
                      title="移除本页"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {totalPages > MAX_THUMB_PAGES && (
                <p className="text-[10px] text-gray-400 mt-1.5">
                  页面较多，仅前 {MAX_THUMB_PAGES} 页显示缩略图，不影响转换。
                </p>
              )}
            </div>
          )}

          {/* ② 转换参数 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 转换参数
            </label>

            {/* 输出格式 */}
            <div>
              <span className="text-sm block mb-1.5">输出格式</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(['png', 'jpg'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => changeFormat(f)}
                    disabled={locked}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      format === f
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-1">{FORMAT_META[format].desc}</p>
            </div>

            {/* 缩放倍率 / DPI */}
            <div>
              <span className="text-sm block mb-1.5">缩放倍率</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {SCALE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => changeScale(s)}
                    disabled={locked}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
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
                1x 对应 72 DPI，倍率越高越清晰，体积与耗时也越大。
              </p>
            </div>

            {/* 页码范围 */}
            <div>
              <span className="text-sm block mb-1.5">页码范围</span>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 mb-2">
                {(
                  [
                    { mode: 'all' as PageRangeMode, label: '全部' },
                    { mode: 'custom' as PageRangeMode, label: '自定义' },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.mode}
                    onClick={() => {
                      if (busyRef.current || zipping) return;
                      setRangeMode(opt.mode);
                    }}
                    disabled={locked}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      rangeMode === opt.mode
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {rangeMode === 'custom' && (
                <>
                  <input
                    type="text"
                    value={rangeText}
                    disabled={locked}
                    onChange={(e) => setRangeText(e.target.value)}
                    placeholder="如 1-3,5、2,4-6"
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500/50 disabled:opacity-50"
                  />
                  {customInvalid && (
                    <p className="text-xs text-red-500 mt-1.5">
                      格式有误：支持单个页码或用 - 表示区间，逗号分隔（如 1-3,5）
                    </p>
                  )}
                  {customEmpty && (
                    <p className="text-xs text-amber-600 mt-1.5">
                      未匹配到有效页码（文档共 {totalPages} 页）
                    </p>
                  )}
                  {customNums && customNums.length > 0 && (
                    <p className="text-xs text-emerald-600 mt-1.5">
                      已选择 {customNums.length} 页
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-2">
            <button
              onClick={handleConvert}
              disabled={!canConvert}
              className="btn-primary flex-1 disabled:opacity-60"
            >
              {busy === 'converting' && progress ? (
                <>
                  <ButtonSpinner />
                  转换中…（{progress.done}/{progress.total}）
                </>
              ) : busy === 'parsing' ? (
                <>
                  <ButtonSpinner />
                  解析中…
                </>
              ) : (
                <>🖼️ 开始转换{convertable > 0 ? `（${convertable} 页）` : ''}</>
              )}
            </button>
            <button
              onClick={handleReset}
              disabled={!file || locked}
              className="btn-ghost disabled:opacity-60"
            >
              重置
            </button>
          </div>
        </div>

        {/* ===== 右列：统计 + 进度 + 结果预览 ===== */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ③ 结果统计
          </label>

          {!file ? (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
              上传 PDF 后将在此显示统计与转换结果
            </div>
          ) : (
            <>
              {/* 统计卡片 */}
              {totalPages > 0 ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="card p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">总页数</p>
                    <p className="text-lg font-bold font-mono">{totalPages}</p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      已移除 {Math.max(0, totalPages - items.length)} 页
                    </p>
                  </div>
                  <div className="card p-3 text-center border-brand-500">
                    <p className="text-xs text-gray-400 mb-1">已转换</p>
                    <p className="text-lg font-bold font-mono text-brand-600">
                      {doneItems.length}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {errorItems.length > 0
                        ? `失败 ${errorItems.length} 页`
                        : pendingCount > 0
                          ? `待转换 ${pendingCount} 页`
                          : '全部完成'}
                    </p>
                  </div>
                  <div className="card p-3 text-center">
                    <p className="text-xs text-gray-400 mb-1">输出大小</p>
                    <p className="text-lg font-bold font-mono">
                      {doneItems.length > 0 ? formatBytes(doneSize) : '—'}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      {format.toUpperCase()} · {scale}x
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[120px] flex items-center justify-center text-gray-400 text-sm">
                  {busy === 'parsing' ? '正在解析页面…' : '暂未获得页面信息'}
                </div>
              )}

              {/* 转换进度 */}
              {busy === 'converting' && progress && (
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-3 space-y-2">
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>正在转换页面…</span>
                    <span className="font-mono text-brand-600">
                      {progress.done}/{progress.total}（{progressPercent}%）
                    </span>
                  </div>
                  <ProgressBar value={progressPercent} />
                </div>
              )}

              {/* 结果预览 */}
              {doneItems.length > 0 && (
                <>
                  <div className="space-y-3 max-h-80 overflow-y-auto pr-0.5">
                    {doneItems.map((item) => (
                      <div key={item.id} className="card p-3">
                        <img
                          src={item.url}
                          alt={`第 ${item.pageNum} 页`}
                          className="w-full rounded-lg mb-2 max-h-40 object-contain bg-gray-50 dark:bg-gray-800"
                        />
                        <div className="flex justify-between items-center text-xs gap-2">
                          <span className="truncate">{pageFileName(item.pageNum)}</span>
                          <span className="text-gray-500 font-medium shrink-0">
                            {formatBytes(item.size ?? 0)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={() => void downloadZip()}
                    disabled={locked}
                    className="btn-primary w-full disabled:opacity-60"
                  >
                    {zipping ? (
                      <>
                        <ButtonSpinner />
                        正在打包…
                      </>
                    ) : (
                      <>📦 打包下载全部（{doneItems.length}）</>
                    )}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* 底部提示 */}
      <p className="text-xs text-gray-400 text-center mt-6">
        PDF 在浏览器本地解析与转换，不上传服务器；转换引擎需联网加载一次（unpkg.com）。
      </p>
    </ToolLayout>
  );
}
