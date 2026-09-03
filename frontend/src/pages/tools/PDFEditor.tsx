import { useRef, useState } from 'react';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import JSZip from 'jszip';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob, formatBytes } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { ButtonSpinner } from '../../components/Loading';
import PDFFiller from './PDFFiller';

const tool = tools.find((t) => t.id === 'pdf-editor')!;

type TabId = 'merge' | 'split' | 'watermark' | 'rotate' | 'fill';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'merge', label: 'PDF 合并', icon: '🔗' },
  { id: 'split', label: 'PDF 拆分', icon: '✂️' },
  { id: 'watermark', label: '添加水印', icon: '💧' },
  { id: 'rotate', label: '旋转页面', icon: '🔄' },
  { id: 'fill', label: '填写编辑', icon: '✏️' },
];

// 单文件大小上限：50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const isPdfLike = (f: File) =>
  f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');

// 合并列表内的重复判定：同名 + 同大小 + 同修改时间视为同一文件
const fileKey = (f: File) => `${f.name}-${f.size}-${f.lastModified}`;

// 归一化错误信息为字符串
const errMsg = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message ? e.message : fallback;

// 拖拽上传区（自带 input 与拖拽态；busy 时禁用）
function DropZone({
  multiple = false,
  onFiles,
  hint,
  busy = false,
}: {
  multiple?: boolean;
  onFiles: (files: FileList) => void;
  hint?: string;
  busy?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div
        onDragOver={(e) => {
          if (busy) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!busy && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFiles(e.dataTransfer.files);
          }
        }}
        onClick={() => {
          if (!busy) inputRef.current?.click();
        }}
        aria-disabled={busy}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
          busy
            ? 'opacity-50 pointer-events-none border-gray-200 dark:border-gray-700'
            : `cursor-pointer ${
                dragging
                  ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                  : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
              }`
        }`}
      >
        <div className="text-3xl mb-2">📤</div>
        <p className="font-medium text-sm">
          {busy ? '处理中，暂不可上传…' : '拖拽 PDF 至此 或 点击选择'}
        </p>
        {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple={multiple}
        disabled={busy}
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

// 已选单文件卡片
function FileCard({
  file,
  onRemove,
  disabled = false,
}: {
  file: File;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2 hover:bg-gray-100 dark:hover:bg-gray-700/70 transition-colors">
      <span className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
        📄
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{file.name}</p>
        <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
      </div>
      <button
        onClick={() => !disabled && onRemove()}
        disabled={disabled}
        className="p-2 -m-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 disabled:hover:text-gray-400 disabled:hover:bg-transparent text-xs shrink-0"
        title="移除"
      >
        ✕
      </button>
    </div>
  );
}

// 带即时校验的数字输入（值越界/NaN 时显示提示且不提交，失焦回退到最后合法值）
// 父级通过 key={value} 让滑块等外部修改触发重挂载，以同步草稿内容
function NumberField({
  value,
  min,
  max,
  step = 1,
  onChange,
  title,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  title: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState<string | null>(null);

  const tryCommit = (raw: string) => {
    setDraft(raw);
    if (raw.trim() === '') {
      setInvalid(null);
      return;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      setInvalid('请输入有效数字');
      return;
    }
    if (num < min || num > max) {
      setInvalid(`需在 ${min} ~ ${max} 之间`);
      return;
    }
    setInvalid(null);
    onChange(num);
  };

  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step}
        title={title}
        aria-label={title}
        onFocus={(e) => e.target.select()}
        onChange={(e) => tryCommit(e.target.value)}
        onBlur={() => {
          if (invalid || draft.trim() === '') setDraft(String(value));
          setInvalid(null);
        }}
        className="input w-20 text-xs py-1"
      />
      {invalid && (
        <span className="text-xs text-red-500 whitespace-nowrap">{invalid}</span>
      )}
    </span>
  );
}

// 解析页码范围 "1-3,5,7-9" → 0-based 索引数组（支持中文逗号/分号）
function parsePageRanges(input: string, maxPage: number): number[] {
  const result: number[] = [];
  const parts = input
    .split(/[,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('请输入页码范围');
  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > end) throw new Error(`范围无效: ${part}（起始大于结束）`);
      for (let i = start; i <= end; i++) {
        if (i < 1 || i > maxPage)
          throw new Error(`页码 ${i} 超出范围（1-${maxPage}）`);
        result.push(i - 1);
      }
    } else if (/^\d+$/.test(part)) {
      const page = parseInt(part, 10);
      if (page < 1 || page > maxPage)
        throw new Error(`页码 ${page} 超出范围（1-${maxPage}）`);
      result.push(page - 1);
    } else {
      throw new Error(`无法识别的页码: "${part}"`);
    }
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

type Hint = { tone: 'ok' | 'err' | 'info'; msg: string } | null;

// 拆分「指定页码范围」输入即时提示
function pageRangeHint(input: string, total: number | null): Hint {
  const t = input.trim();
  if (!t) return null;
  const parts = t.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { tone: 'err', msg: '页码范围不能为空' };
  const bad = parts.find((p) => !/^\d+(\s*-\s*\d+)?$/.test(p));
  if (bad) return { tone: 'err', msg: `无法识别的页码: "${bad}"` };
  if (total == null)
    return { tone: 'info', msg: '语法正确，选择文件后将校验页码范围' };
  try {
    const idx = parsePageRanges(t, total);
    return { tone: 'ok', msg: `将提取 ${idx.length} 页` };
  } catch (e) {
    return { tone: 'err', msg: e instanceof Error ? e.message : '页码范围无效' };
  }
}

// 拆分「每 N 页一份」输入即时提示
function everyNHint(raw: string, total: number | null): Hint {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return { tone: 'err', msg: '请输入数字' };
  if (!Number.isInteger(n) || n < 1)
    return { tone: 'err', msg: '需为 ≥ 1 的整数' };
  if (total == null) return { tone: 'info', msg: '选择文件后将显示拆分份数' };
  if (n >= total) {
    return { tone: 'info', msg: `共 ${total} 页，N ≥ 总页数，将整体导出为 1 个文件` };
  }
  const parts = Math.ceil(total / n);
  return { tone: 'ok', msg: `共 ${total} 页 → 拆分为 ${parts} 份，每份 ≤ ${n} 页` };
}

// hex 颜色 → pdf-lib rgb（0-1）
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const m = clean.match(/.{2}/g);
  if (!m || m.length < 3) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(m[0], 16) / 255,
    g: parseInt(m[1], 16) / 255,
    b: parseInt(m[2], 16) / 255,
  };
}

// 读取 File 为 Uint8Array
async function fileToBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

// 需要中文字体子集（标准字体无法编码的字符）
const needsCjkFont = (text: string) => /[^\x20-\x7E]/.test(text);

const FONT_FAMILY = 'simhei';

export default function PDFEditor() {
  const [activeTab, setActiveTab] = useState<TabId>('merge');
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);
  const processingRef = useRef(false);
  const { success, error: toastError, warning } = useToast();

  // 合并
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  // 拆分
  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [splitMode, setSplitMode] = useState<'range' | 'every'>('range');
  const [pageRanges, setPageRanges] = useState('');
  const [everyN, setEveryN] = useState('');
  const [splitTotal, setSplitTotal] = useState<number | null>(null);
  const splitMetaRef = useRef<{ bytes: Uint8Array<ArrayBuffer>; doc: PDFDocument } | null>(null);
  const splitMetaSeqRef = useRef(0);
  // 水印
  const [wmFile, setWmFile] = useState<File | null>(null);
  const [wmText, setWmText] = useState('机密');
  const [wmSize, setWmSize] = useState(50);
  const [wmOpacity, setWmOpacity] = useState(0.3);
  const [wmRotation, setWmRotation] = useState(45);
  const [wmColor, setWmColor] = useState('#888888');
  const [wmTile, setWmTile] = useState(false);
  const [wmDensity, setWmDensity] = useState(1);
  // 旋转
  const [rotFile, setRotFile] = useState<File | null>(null);
  const [rotAngle, setRotAngle] = useState<90 | 180 | 270>(90);

  // 校验单个 PDF 文件
  const validatePdf = (file: File): string | null => {
    if (!isPdfLike(file)) return '请上传 PDF 文件';
    if (file.size > MAX_FILE_SIZE)
      return `文件大小超过限制（≤ ${formatBytes(MAX_FILE_SIZE)}）`;
    return null;
  };

  // 处理锁：防止处理期间重复提交 / 并发操作
  const beginProcessing = (): boolean => {
    if (processingRef.current) return false;
    processingRef.current = true;
    setProcessing(true);
    setError('');
    return true;
  };
  const endProcessing = () => {
    processingRef.current = false;
    setProcessing(false);
  };

  // 切换 Tab（处理中锁定，避免状态被清空/并发）
  const switchTab = (id: TabId) => {
    if (id === activeTab || processingRef.current) return;
    splitMetaSeqRef.current += 1;
    splitMetaRef.current = null;
    setActiveTab(id);
    setMergeFiles([]);
    setSplitFile(null);
    setSplitTotal(null);
    setSplitMode('range');
    setWmFile(null);
    setRotFile(null);
    setPageRanges('');
    setEveryN('');
    setError('');
  };

  // ===== 合并：文件添加 =====
  const addMergeFiles = (fileList: FileList) => {
    if (processingRef.current) return;
    setError('');
    const incoming = Array.from(fileList);
    const existing = new Set(mergeFiles.map(fileKey));
    const next: File[] = [];
    let bad = 0;
    let dup = 0;
    const oversize: string[] = [];
    for (const f of incoming) {
      if (!isPdfLike(f)) {
        bad++;
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        oversize.push(f.name);
        continue;
      }
      if (existing.has(fileKey(f))) {
        dup++;
        continue;
      }
      existing.add(fileKey(f));
      next.push(f);
    }
    if (bad > 0) warning(`已忽略 ${bad} 个非 PDF 文件`);
    if (dup > 0) warning(`已跳过 ${dup} 个重复文件`);
    if (oversize.length > 0) {
      const msg =
        oversize.length === 1
          ? `文件 ${oversize[0]} 超过 ${formatBytes(MAX_FILE_SIZE)} 限制`
          : `${oversize.length} 个文件超过 ${formatBytes(MAX_FILE_SIZE)} 限制，已跳过`;
      toastError(msg);
      setError(msg);
    }
    if (next.length > 0) setMergeFiles((prev) => [...prev, ...next]);
  };

  const removeMergeFile = (index: number) => {
    if (processingRef.current) return;
    setMergeFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // 合并：上移/下移文件
  const moveMergeFile = (index: number, dir: -1 | 1) => {
    if (processingRef.current) return;
    setMergeFiles((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // 拆分：选择文件（后台解析页数用于即时校验）
  const pickSingleFile = (file: File, setter: (f: File | null) => void) => {
    if (processingRef.current) return;
    const err = validatePdf(file);
    if (err) {
      setError(err);
      toastError(err);
      setter(null);
      return;
    }
    setError('');
    setter(file);
  };

  const pickSplitFile = (f: File) => {
    if (processingRef.current) return;
    const err = validatePdf(f);
    if (err) {
      setSplitFile(null);
      setSplitTotal(null);
      splitMetaRef.current = null;
      setError(err);
      toastError(err);
      return;
    }
    splitMetaSeqRef.current += 1;
    splitMetaRef.current = null;
    setSplitTotal(null);
    setError('');
    setSplitFile(f);
    // 后台解析页数，便于「页码范围 / 每 N 页」即时校验
    void loadSplitMeta(f);
  };

  const loadSplitMeta = async (file: File) => {
    const seq = splitMetaSeqRef.current;
    try {
      const bytes = await fileToBytes(file);
      const doc = await PDFDocument.load(bytes);
      if (splitMetaSeqRef.current !== seq) return; // 期间已更换文件
      splitMetaRef.current = { bytes, doc };
      setSplitTotal(doc.getPageCount());
    } catch (e) {
      if (splitMetaSeqRef.current !== seq) return;
      splitMetaRef.current = null;
      const msg = errMsg(e, '该 PDF 无法解析，请检查文件是否损坏或加密');
      setError(msg);
      toastError(msg);
    }
  };

  // 确保拿到已解析的源文档（复用上传时缓存的解析结果）
  const ensureSplitDoc = async (file: File): Promise<PDFDocument> => {
    if (splitMetaRef.current) return splitMetaRef.current.doc;
    const bytes = await fileToBytes(file);
    const doc = await PDFDocument.load(bytes);
    splitMetaRef.current = { bytes, doc };
    setSplitTotal(doc.getPageCount());
    return doc;
  };

  // 获取用于绘制水印的字体（含中文时向后端子集接口获取字体）
  const getWatermarkFont = async (doc: PDFDocument, text: string) => {
    if (!needsCjkFont(text)) {
      return doc.embedFont(StandardFonts.Helvetica);
    }
    const formData = new FormData();
    formData.append('text', text);
    formData.append('font_family', FONT_FAMILY);
    const resp = await fetch('/api/v1/pdf/subset-font', {
      method: 'POST',
      body: formData,
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => null);
      throw new Error(
        (detail && (detail as { detail?: string }).detail) ||
          `中文字体子集获取失败（HTTP ${resp.status}）`
      );
    }
    const fontBytes = new Uint8Array(await resp.arrayBuffer());
    return doc.embedFont(fontBytes, { subset: true });
  };

  // ===== Tab1: PDF 合并 =====
  const handleMerge = async () => {
    if (!beginProcessing()) return;
    try {
      if (mergeFiles.length < 2) {
        throw new Error(`请至少上传 2 个 PDF 文件（当前 ${mergeFiles.length} 个）`);
      }
      const merged = await PDFDocument.create();
      let totalPages = 0;
      for (const file of mergeFiles) {
        try {
          const bytes = await fileToBytes(file);
          const src = await PDFDocument.load(bytes);
          const pages = await merged.copyPages(src, src.getPageIndices());
          totalPages += pages.length;
          pages.forEach((p) => merged.addPage(p));
        } catch {
          throw new Error(`无法解析「${file.name}」，请确认文件未损坏或加密`);
        }
      }
      const out = await merged.save();
      downloadPdf(out, '合并文档.pdf');
      success(`合并完成：${mergeFiles.length} 个文件，共 ${totalPages} 页`);
    } catch (e: unknown) {
      const msg = errMsg(e, '合并失败，请检查文件是否损坏');
      setError(msg);
      toastError(msg);
    } finally {
      endProcessing();
    }
  };

  // ===== Tab2: PDF 拆分 =====
  // 按指定页码范围提取 → 单个 PDF
  const handleSplitByRange = async () => {
    if (!beginProcessing()) return;
    try {
      if (!splitFile) throw new Error('请上传 PDF 文件');
      const doc = await ensureSplitDoc(splitFile);
      const total = doc.getPageCount();
      const indices = parsePageRanges(pageRanges, total);
      if (indices.length === 0) throw new Error('未提取到任何页面');
      const out = await PDFDocument.create();
      const pages = await out.copyPages(doc, indices);
      pages.forEach((p) => out.addPage(p));
      const result = await out.save();
      const base = splitFile.name.replace(/\.pdf$/i, '') || '拆分文档';
      downloadPdf(result, `${base}_提取.pdf`);
      success(`拆分完成：已提取 ${indices.length} 页`);
    } catch (e: unknown) {
      const msg = errMsg(e, '拆分失败，请检查文件是否损坏');
      setError(msg);
      toastError(msg);
    } finally {
      endProcessing();
    }
  };

  // 按每 N 页拆一份 → 打包 ZIP 下载（仅 1 份时直接下载）
  const handleSplitEveryN = async () => {
    if (!beginProcessing()) return;
    try {
      if (!splitFile) throw new Error('请上传 PDF 文件');
      const n = Number(everyN);
      if (!Number.isInteger(n) || n < 1) throw new Error('请输入每份页数（≥ 1 的整数）');
      const doc = await ensureSplitDoc(splitFile);
      const total = doc.getPageCount();
      const partsCount = Math.max(1, Math.ceil(total / n));
      const base = splitFile.name.replace(/\.pdf$/i, '') || '拆分文档';
      const nameOf = (s: number, e: number) =>
        s === e
          ? `${base}_第${s}页.pdf`
          : `${base}_第${s}-${e}页.pdf`;

      const outParts: { name: string; bytes: Uint8Array }[] = [];
      for (let i = 0; i < partsCount; i++) {
        const start = i * n;
        const end = Math.min(start + n, total);
        const idx: number[] = [];
        for (let p = start; p < end; p++) idx.push(p);
        const out = await PDFDocument.create();
        const pages = await out.copyPages(doc, idx);
        pages.forEach((p) => out.addPage(p));
        outParts.push({ name: nameOf(start + 1, end), bytes: await out.save() });
      }

      if (outParts.length === 1) {
        downloadPdf(outParts[0].bytes, outParts[0].name);
        success(`拆分完成：整体导出 1 个文件`);
      } else {
        const zip = new JSZip();
        outParts.forEach((p) => zip.file(p.name, p.bytes));
        const blob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(blob, `${base}_拆分(${outParts.length}份).zip`);
        success(`拆分完成：共 ${outParts.length} 个文件，已打包下载`);
      }
    } catch (e: unknown) {
      const msg = errMsg(e, '拆分失败，请检查文件是否损坏');
      setError(msg);
      toastError(msg);
    } finally {
      endProcessing();
    }
  };

  // ===== Tab3: 添加水印 =====
  const handleWatermark = async () => {
    if (!beginProcessing()) return;
    try {
      if (!wmFile) throw new Error('请上传 PDF 文件');
      const text = wmText.trim();
      if (!text) throw new Error('请输入水印文字');
      if (!Number.isFinite(wmSize) || wmSize < 10 || wmSize > 120)
        throw new Error('字号需在 10 ~ 120 之间');
      if (!Number.isFinite(wmOpacity) || wmOpacity <= 0 || wmOpacity > 1)
        throw new Error('透明度需大于 0 且不超过 1');
      if (!Number.isFinite(wmRotation) || wmRotation < 0 || wmRotation > 360)
        throw new Error('旋转角度需在 0 ~ 360 之间');
      if (!/^#[0-9a-fA-F]{6}$/.test(wmColor)) throw new Error('水印颜色无效');

      const bytes = await fileToBytes(wmFile);
      const doc = await PDFDocument.load(bytes);
      const font = await getWatermarkFont(doc, text);
      const { r, g, b } = hexToRgb(wmColor);
      const pages = doc.getPages();
      const color = rgb(r, g, b);
      const size = wmSize;
      const opacity = wmOpacity;
      const rot = degrees(wmRotation);

      for (const page of pages) {
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(text, size);
        if (!wmTile) {
          // 居中单处水印
          page.drawText(text, {
            x: width / 2 - textWidth / 2,
            y: height / 2,
            size,
            font,
            color,
            opacity,
            rotate: rot,
          });
        } else {
          // 整页平铺（按密度调节疏密，旋转以文字起点为轴）
          const spacingX = Math.max(textWidth + size * 2, size * 6) * wmDensity;
          const spacingY = Math.max(size * 3, 24) * wmDensity;
          let row = 0;
          for (let y = height + spacingY; y > -spacingY; y -= spacingY) {
            const offset = (row % 2) * (spacingX / 2);
            row += 1;
            for (let x = offset - textWidth - size; x < width + size; x += spacingX) {
              page.drawText(text, { x, y, size, font, color, opacity, rotate: rot });
            }
          }
        }
      }
      const out = await doc.save();
      downloadPdf(out, '水印文档.pdf');
      success(`水印添加完成：共处理 ${pages.length} 页`);
    } catch (e: unknown) {
      const msg = errMsg(e, '添加水印失败，请检查文件是否损坏');
      setError(msg);
      toastError(msg);
    } finally {
      endProcessing();
    }
  };

  // ===== Tab4: 旋转页面 =====
  const handleRotate = async () => {
    if (!beginProcessing()) return;
    try {
      if (!rotFile) throw new Error('请上传 PDF 文件');
      const bytes = await fileToBytes(rotFile);
      const doc = await PDFDocument.load(bytes);
      const pages = doc.getPages();
      for (const page of pages) {
        const current = page.getRotation().angle || 0;
        // 归一化到 [0, 360)，避免负角度取模与 360° 等无效值
        const next = (((current % 360) + rotAngle) % 360 + 360) % 360;
        page.setRotation(degrees(next));
      }
      const out = await doc.save();
      downloadPdf(out, '旋转文档.pdf');
      success(`旋转完成：共旋转 ${pages.length} 页`);
    } catch (e: unknown) {
      const msg = errMsg(e, '旋转失败，请检查文件是否损坏');
      setError(msg);
      toastError(msg);
    } finally {
      endProcessing();
    }
  };

  // 下载 PDF
  const downloadPdf = (bytes: Uint8Array, filename: string) => {
    // pdf-lib 返回的 Uint8Array 可能是 SharedArrayBuffer 视图，拷贝为 ArrayBuffer 供 Blob 使用
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    downloadBlob(new Blob([copy], { type: 'application/pdf' }), filename);
  };

  const sizeHint = `仅支持 PDF · 单文件 ≤ ${formatBytes(MAX_FILE_SIZE)}`;

  // 拆分输入即时校验提示
  const splitHint: Hint =
    splitMode === 'range' ? pageRangeHint(pageRanges, splitTotal) : everyNHint(everyN, splitTotal);
  const hintClass =
    splitHint?.tone === 'err'
      ? 'text-red-500'
      : splitHint?.tone === 'ok'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-gray-400';
  const splitPlaceholderText =
    splitMode === 'range'
      ? '使用逗号分隔多个范围，页码从 1 开始。例如 1-3,5,7-9'
      : '将文档按每 N 页拆分为多个独立 PDF 文件';

  const busy = processing;

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        {/* Tab 导航（处理中禁用切换） */}
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              disabled={busy}
              className={`flex-1 py-2 rounded-md text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                activeTab === t.id
                  ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              } ${busy ? 'opacity-60' : ''}`}
            >
              <span className="mr-1">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* 错误提示（填写 Tab 由 PDFFiller 内部管理，不混用） */}
        {activeTab !== 'fill' && error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            ⚠️ {error}
          </div>
        )}

        {/* ===== Tab1: 合并 ===== */}
        {activeTab === 'merge' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ① 上传多个 PDF
              </label>
              <DropZone
                multiple
                onFiles={addMergeFiles}
                hint={`${sizeHint} · 可选多个`}
                busy={busy}
              />
            </div>

            {mergeFiles.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {mergeFiles.map((f, i) => (
                  <div
                    key={fileKey(f)}
                    className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2 hover:bg-gray-100 dark:hover:bg-gray-700/70 transition-colors"
                  >
                    <span className="w-7 h-7 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-xs shrink-0">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{f.name}</p>
                      <p className="text-xs text-gray-400">
                        {formatBytes(f.size)}
                      </p>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <button
                        onClick={() => moveMergeFile(i, -1)}
                        disabled={busy || i === 0}
                        className="p-2 -m-1 rounded-md text-gray-400 hover:text-brand-600 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent text-xs"
                        title="上移"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveMergeFile(i, 1)}
                        disabled={busy || i === mergeFiles.length - 1}
                        className="p-2 -m-1 rounded-md text-gray-400 hover:text-brand-600 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent text-xs"
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() => removeMergeFile(i)}
                        disabled={busy}
                        className="p-2 -m-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:hover:text-gray-400 disabled:hover:bg-transparent text-xs"
                        title="移除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={handleMerge}
                disabled={busy || mergeFiles.length < 2}
                className="btn-primary flex-1 disabled:opacity-60"
              >
                {busy ? (
                  <>
                    <ButtonSpinner />
                    合并中…
                  </>
                ) : (
                  <>🔗 合并（{mergeFiles.length} 个文件）</>
                )}
              </button>
              {mergeFiles.length > 0 && (
                <button
                  onClick={() => {
                    if (!busy) setMergeFiles([]);
                  }}
                  disabled={busy}
                  className="btn-ghost disabled:opacity-60"
                >
                  清空
                </button>
              )}
            </div>
          </div>
        )}

        {/* ===== Tab2: 拆分 ===== */}
        {activeTab === 'split' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ① 上传 PDF
              </label>
              <DropZone
                onFiles={(files) => {
                  const f = files[0];
                  if (f) pickSplitFile(f);
                }}
                hint={sizeHint}
                busy={busy}
              />
            </div>

            {splitFile && (
              <FileCard
                file={splitFile}
                onRemove={() => {
                  splitMetaSeqRef.current += 1;
                  splitMetaRef.current = null;
                  setSplitFile(null);
                  setSplitTotal(null);
                  setError('');
                }}
                disabled={busy}
              />
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ② 拆分方式
              </label>
              <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                {(
                  [
                    { id: 'range' as const, label: '按页码范围' },
                    { id: 'every' as const, label: '每 N 页拆一份' },
                  ]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    disabled={busy}
                    onClick={() => {
                      setSplitMode(opt.id);
                      setError('');
                    }}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      splitMode === opt.id
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {splitMode === 'range' ? (
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                  ③ 页码范围
                </label>
                <input
                  type="text"
                  value={pageRanges}
                  disabled={busy}
                  onChange={(e) => {
                    setPageRanges(e.target.value);
                    setError('');
                  }}
                  placeholder="如 1-3,5,7-9"
                  className="input disabled:opacity-60"
                />
                <p className={`text-xs mt-1 ${hintClass}`}>
                  {splitHint?.msg ?? splitPlaceholderText}
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                  ③ 每份页数 N
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={everyN}
                  disabled={busy}
                  onChange={(e) => {
                    setEveryN(e.target.value);
                    setError('');
                  }}
                  placeholder="如 2"
                  className="input disabled:opacity-60"
                />
                <p className={`text-xs mt-1 ${hintClass}`}>
                  {splitHint?.msg ?? splitPlaceholderText}
                </p>
              </div>
            )}

            {splitMode === 'every' && everyN.trim() !== '' && splitHint?.tone === 'ok' && (
              <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-500">
                拆分结果将打包为 ZIP 下载（仅 1 份时直接下载单文件）。
              </div>
            )}

            <button
              onClick={splitMode === 'range' ? handleSplitByRange : handleSplitEveryN}
              disabled={
                busy ||
                !splitFile ||
                (splitMode === 'range' ? !pageRanges.trim() : !everyN.trim())
              }
              className="btn-primary w-full disabled:opacity-60"
            >
              {busy ? (
                <>
                  <ButtonSpinner />
                  处理中…
                </>
              ) : splitMode === 'range' ? (
                <>✂️ 提取页面并下载</>
              ) : (
                <>📦 按每 N 页拆分并下载</>
              )}
            </button>
          </div>
        )}

        {/* ===== Tab3: 水印 ===== */}
        {activeTab === 'watermark' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ① 上传 PDF
              </label>
              <DropZone
                onFiles={(files) => {
                  const f = files[0];
                  if (f) pickSingleFile(f, setWmFile);
                }}
                hint={sizeHint}
                busy={busy}
              />
            </div>

            {wmFile && (
              <FileCard file={wmFile} onRemove={() => setWmFile(null)} disabled={busy} />
            )}

            <div className="space-y-3">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ② 水印设置
              </label>

              <div>
                <span className="text-sm block mb-1.5">水印文字</span>
                <input
                  type="text"
                  value={wmText}
                  disabled={busy}
                  onChange={(e) => {
                    setWmText(e.target.value);
                    setError('');
                  }}
                  placeholder="如 机密 / DRAFT"
                  className="input disabled:opacity-60"
                />
                <p className="text-xs text-gray-400 mt-1">
                  含中文时自动获取中文字体子集；纯英文直接本地绘制。
                </p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">字体大小</span>
                  <NumberField
                    key={wmSize}
                    title="水印字号"
                    value={wmSize}
                    min={10}
                    max={120}
                    step={1}
                    onChange={(v) => {
                      setWmSize(v);
                      setError('');
                    }}
                  />
                </div>
                <input
                  type="range"
                  min="10"
                  max="120"
                  value={wmSize}
                  disabled={busy}
                  onChange={(e) => setWmSize(Number(e.target.value))}
                  className="w-full accent-brand-600 disabled:opacity-50"
                />
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">透明度</span>
                  <NumberField
                    key={wmOpacity}
                    title="水印透明度"
                    value={wmOpacity}
                    min={0.05}
                    max={1}
                    step={0.05}
                    onChange={(v) => {
                      setWmOpacity(v);
                      setError('');
                    }}
                  />
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={wmOpacity}
                  disabled={busy}
                  onChange={(e) => setWmOpacity(Number(e.target.value))}
                  className="w-full accent-brand-600 disabled:opacity-50"
                />
                <p className="text-xs text-gray-400 mt-1">
                  需大于 0（全透明等于不显示），最大 1。
                </p>
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">旋转角度</span>
                  <NumberField
                    key={wmRotation}
                    title="水印旋转角度"
                    value={wmRotation}
                    min={0}
                    max={360}
                    step={1}
                    onChange={(v) => {
                      setWmRotation(v);
                      setError('');
                    }}
                  />
                </div>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={wmRotation}
                  disabled={busy}
                  onChange={(e) => setWmRotation(Number(e.target.value))}
                  className="w-full accent-brand-600 disabled:opacity-50"
                />
              </div>

              <div>
                <span className="text-sm block mb-1.5">水印颜色</span>
                <input
                  type="color"
                  value={wmColor}
                  disabled={busy}
                  onChange={(e) => {
                    setWmColor(e.target.value);
                    setError('');
                  }}
                  className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer disabled:opacity-50"
                />
              </div>

              <div>
                <span className="text-sm block mb-1.5">排列方式</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  <button
                    onClick={() => {
                      setWmTile(false);
                      setError('');
                    }}
                    disabled={busy}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      !wmTile
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    居中单处
                  </button>
                  <button
                    onClick={() => {
                      setWmTile(true);
                      setError('');
                    }}
                    disabled={busy}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                      wmTile
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                  >
                    整页平铺
                  </button>
                </div>
              </div>

              {wmTile && (
                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-sm">平铺密度</span>
                    <span className="text-sm font-mono text-brand-600">
                      {Math.round(wmDensity * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="2.5"
                    step="0.1"
                    value={wmDensity}
                    disabled={busy}
                    onChange={(e) => setWmDensity(Number(e.target.value))}
                    className="w-full accent-brand-600 disabled:opacity-50"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    数值越大水印越稀疏（默认 100%）。
                  </p>
                </div>
              )}
            </div>

            <button
              onClick={handleWatermark}
              disabled={busy || !wmFile || !wmText.trim()}
              className="btn-primary w-full disabled:opacity-60"
            >
              {busy ? (
                <>
                  <ButtonSpinner />
                  添加中…
                </>
              ) : (
                <>💧 添加水印</>
              )}
            </button>
          </div>
        )}

        {/* ===== Tab4: 旋转 ===== */}
        {activeTab === 'rotate' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ① 上传 PDF
              </label>
              <DropZone
                onFiles={(files) => {
                  const f = files[0];
                  if (f) pickSingleFile(f, setRotFile);
                }}
                hint={sizeHint}
                busy={busy}
              />
            </div>

            {rotFile && (
              <FileCard file={rotFile} onRemove={() => setRotFile(null)} disabled={busy} />
            )}

            <div className="space-y-3">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ② 旋转设置
              </label>

              <div>
                <span className="text-sm block mb-1.5">旋转角度（顺时针）</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {([90, 180, 270] as const).map((a) => (
                    <button
                      key={a}
                      onClick={() => setRotAngle(a)}
                      disabled={busy}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                        rotAngle === a
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {a}°
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-500">
                应用范围：全部页面
              </div>
            </div>

            <button
              onClick={handleRotate}
              disabled={busy || !rotFile}
              className="btn-primary w-full disabled:opacity-60"
            >
              {busy ? (
                <>
                  <ButtonSpinner />
                  旋转中…
                </>
              ) : (
                <>🔄 旋转页面</>
              )}
            </button>
          </div>
        )}

        {/* ===== Tab5: 填写编辑（独立状态与错误管理） ===== */}
        {activeTab === 'fill' && <PDFFiller />}

        {/* 底部提示 */}
        <p className="text-xs text-gray-400 text-center">
          所有操作均在浏览器本地完成，文件不会上传到服务器
        </p>
      </div>
    </ToolLayout>
  );
}
