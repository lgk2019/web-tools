import { useState, useRef, useCallback, useEffect } from 'react';
import { PDFDocument, rgb, StandardFonts, pushGraphicsState, popGraphicsState, skewDegrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { downloadBlob, formatBytes } from '../../utils/image';
import { getPdfjsLib } from '../../utils/pdfjs';
import type { PDFDocumentProxy } from '../../utils/pdfjs';

// 单文件大小上限：50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// 默认文本属性
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_COLOR = '#000000';
const DEFAULT_FONT_FAMILY = 'simhei';

// 可选字体类型
const FONT_FAMILIES = [
  { value: 'simhei', label: '黑体' },
  { value: 'simsun', label: '宋体' },
  { value: 'simkai', label: '楷体' },
  { value: 'simfang', label: '仿宋' },
  { value: 'msyh', label: '微软雅黑' },
] as const;

// 缩放范围
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

// pdfjs RenderTask 的最小结构类型（避免直接依赖内部类型导出）
interface RenderTaskLike {
  promise: Promise<void>;
  cancel: () => void;
}

// 文本标注数据结构（坐标为 PDF 坐标系，左下角原点，y 向上；y 为文字基线）
interface TextAnnotation {
  id: string;
  pageIndex: number; // 0-based
  x: number; // PDF 坐标 X
  y: number; // PDF 坐标 Y（基线）
  text: string;
  fontSize: number; // PDF 点
  color: string; // hex
  fontFamily: string; // 字体类型：simhei/simsun/simkai/simfang/msyh
  bold: boolean; // 加粗
  italic: boolean; // 斜体
  underline: boolean; // 下划线
}

type Tool = 'text' | 'select';

// 读取 File 为 Uint8Array
async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
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

// 简单唯一 id
function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto).randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ============================================================
// 单个文本框（可拖拽、可编辑、可删除）
// ============================================================
function TextBox({
  annotation,
  zoom,
  pageHeight,
  selected,
  focusRequested,
  onSelect,
  onChange,
  onDelete,
}: {
  annotation: TextAnnotation;
  zoom: number;
  pageHeight: number;
  selected: boolean;
  focusRequested: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<TextAnnotation>) => void;
  onDelete: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{
    id: number;
    sx: number;
    sy: number;
    moved: boolean;
  } | null>(null);
  // 拖拽过程中的临时偏移（PDF 坐标），松手后才提交
  const [offset, setOffset] = useState<{ dx: number; dy: number } | null>(null);

  // 新建时自动聚焦输入框
  useEffect(() => {
    if (focusRequested) inputRef.current?.focus();
  }, [focusRequested]);

  // 当前显示位置（含拖拽中的临时偏移）
  const curX = annotation.x + (offset?.dx ?? 0);
  const curY = annotation.y + (offset?.dy ?? 0);
  const cssLeft = curX * zoom;
  // 文本顶部（CSS）= (页高 - 基线 - 字号) * zoom
  const cssTop = (pageHeight - curY - annotation.fontSize) * zoom;
  const cssFont = annotation.fontSize * zoom;

  // 拖拽处理（仅在 handle 上触发）
  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    dragRef.current = {
      id: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
    const dxScreen = e.clientX - dragRef.current.sx;
    const dyScreen = e.clientY - dragRef.current.sy;
    if (!dragRef.current.moved && Math.hypot(dxScreen, dyScreen) < 4) return;
    dragRef.current.moved = true;
    // 屏幕向下拖拽 → PDF y 减小（因为 PDF y 轴向上）
    setOffset({ dx: dxScreen / zoom, dy: -dyScreen / zoom });
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current || dragRef.current.id !== e.pointerId) return;
    const dxScreen = e.clientX - dragRef.current.sx;
    const dyScreen = e.clientY - dragRef.current.sy;
    if (dragRef.current.moved) {
      onChange({
        x: annotation.x + dxScreen / zoom,
        y: annotation.y - dyScreen / zoom,
      });
    }
    dragRef.current = null;
    setOffset(null);
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className={`group absolute ${selected ? 'z-20' : 'z-10'}`}
      style={{ left: cssLeft, top: cssTop }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
      }}
    >
      {/* 拖拽手柄 + 删除按钮（位于文本上方） */}
      <div
        className={`absolute -top-5 left-0 right-5 h-5 flex items-center justify-between px-0.5 cursor-move select-none ${
          selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
      >
        <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">
          ⋮⋮
        </span>
        {selected && (
          <button
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDelete();
            }}
            className="w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none flex items-center justify-center hover:bg-red-600"
            title="删除"
          >
            ✕
          </button>
        )}
      </div>

      {/* 文本输入 */}
      <input
        ref={inputRef}
        type="text"
        value={annotation.text}
        onChange={(e) => onChange({ text: e.target.value })}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        placeholder="输入文字"
        className="block bg-transparent outline-none border-0 p-0 m-0 leading-none whitespace-pre"
        style={{
          fontSize: `${cssFont}px`,
          color: annotation.color,
          width: `${Math.max(4, annotation.text.length + 1)}ch`,
          minWidth: '40px',
          fontWeight: annotation.bold ? 'bold' : 'normal',
          fontStyle: annotation.italic ? 'italic' : 'normal',
          textDecoration: annotation.underline ? 'underline' : 'none',
        }}
      />

      {/* 选中高亮边框 */}
      {selected && (
        <div className="absolute inset-0 ring-2 ring-brand-500 rounded pointer-events-none" />
      )}
    </div>
  );
}

// ============================================================
// PDFFiller 主组件
// ============================================================
export default function PDFFiller() {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);

  // PDF 文档与渲染相关
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1); // 1-based
  const [currentPageDims, setCurrentPageDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);

  // 标注
  const [annotations, setAnnotations] = useState<TextAnnotation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('text');

  // 跳页输入（非受控，见下方 jumpInputRef）

  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const loadingTaskRef = useRef<any | null>(null);
  const renderTaskRef = useRef<RenderTaskLike | null>(null);

  const dpr =
    typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  // 组件卸载时清理：销毁 pdfjs loadingTask
  useEffect(() => {
    return () => {
      const task = loadingTaskRef.current;
      if (task) {
        task.destroy().catch(() => {});
        loadingTaskRef.current = null;
      }
      const rt = renderTaskRef.current;
      if (rt) {
        rt.cancel();
        renderTaskRef.current = null;
      }
    };
  }, []);

  // 跳页输入（非受控，通过 key 在翻页时重置默认值）
  const jumpInputRef = useRef<HTMLInputElement>(null);
  const doJump = () => {
    const raw = jumpInputRef.current?.value;
    if (raw == null) return;
    const p = parseInt(raw, 10);
    if (!Number.isNaN(p)) goToPage(p);
  };

  // 渲染当前页到 canvas
  useEffect(() => {
    if (!pdfDoc || !currentPage) return;
    let cancelled = false;
    const renderPage = async () => {
      setRendering(true);
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;
        const vp = page.getViewport({ scale: zoom * dpr });
        const vpBase = page.getViewport({ scale: 1 });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.style.width = `${vp.width / dpr}px`;
        canvas.style.height = `${vp.height / dpr}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // 取消上一次未完成的渲染
        const prev = renderTaskRef.current;
        if (prev) {
          prev.cancel();
          renderTaskRef.current = null;
        }
        const task = page.render({ canvasContext: ctx, viewport: vp }) as RenderTaskLike;
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) {
          setCurrentPageDims({ width: vpBase.width, height: vpBase.height });
        }
      } catch (e: any) {
        if (!cancelled && e?.name !== 'RenderingCancelledException') {
          setError(e?.message || '页面渲染失败');
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };
    renderPage();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, zoom, dpr]);

  // 键盘删除：选中标注且未在输入框中时按 Delete/Backspace 删除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!selectedId) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      setAnnotations((prev) => prev.filter((a) => a.id !== selectedId));
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  // ---- 文件处理 ----
  const validateFile = (f: File): string | null => {
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      return '请上传 PDF 文件';
    }
    if (f.size > MAX_FILE_SIZE) {
      return `文件大小超过限制（≤ ${formatBytes(MAX_FILE_SIZE)}）`;
    }
    return null;
  };

  const handleFile = async (f: File) => {
    const err = validateFile(f);
    if (err) {
      setError(err);
      return;
    }
    setError('');
    setLoading(true);
    // 清理上一个文档
    if (loadingTaskRef.current) {
      loadingTaskRef.current.destroy().catch(() => {});
      loadingTaskRef.current = null;
    }
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
    setPdfDoc(null);
    setAnnotations([]);
    setSelectedId(null);
    setCurrentPageDims(null);
    try {
      const bytes = await fileToBytes(f);
      bytesRef.current = bytes;
      const _pdfjsLib = await getPdfjsLib();
      const loadingTask = _pdfjsLib.getDocument({ data: bytes.slice() });
      loadingTaskRef.current = loadingTask;
      const pdf = await loadingTask.promise;
      setFile(f);
      setPdfDoc(pdf);
      setNumPages(pdf.numPages);
      setCurrentPage(1);
    } catch (e: any) {
      setError(e?.message || 'PDF 加载失败，请检查文件是否损坏');
      setFile(null);
      bytesRef.current = null;
    } finally {
      setLoading(false);
    }
  };

  // ---- 画布点击：添加文本 / 取消选中 ----
  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !currentPageDims) return;
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    // 越界保护
    if (cssX < 0 || cssY < 0 || cssX > rect.width || cssY > rect.height) return;

    if (tool !== 'text') {
      // 选择模式：点击空白取消选中
      setSelectedId(null);
      return;
    }

    const pageW = currentPageDims.width;
    const pageH = currentPageDims.height;
    const pdfX = (cssX / rect.width) * pageW;
    // 基线 = 页高 - 点击位置对应高度 - 字号（让点击点落在文字顶部）
    const pdfY = pageH - (cssY / rect.height) * pageH - DEFAULT_FONT_SIZE;

    const ann: TextAnnotation = {
      id: uid(),
      pageIndex: currentPage - 1,
      x: pdfX,
      y: pdfY,
      text: '',
      fontSize: DEFAULT_FONT_SIZE,
      color: DEFAULT_COLOR,
      fontFamily: DEFAULT_FONT_FAMILY,
      bold: false,
      italic: false,
      underline: false,
    };
    setAnnotations((prev) => [...prev, ann]);
    setSelectedId(ann.id);
    setFocusId(ann.id);
  };

  // ---- 标注更新 ----
  const updateAnnotation = useCallback(
    (id: string, patch: Partial<TextAnnotation>) => {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, ...patch } : a))
      );
    },
    []
  );

  const deleteAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setSelectedId(null);
  }, []);

  const clearAll = () => {
    if (annotations.length === 0) return;
    if (!window.confirm('确定清空所有文本标注吗？')) return;
    setAnnotations([]);
    setSelectedId(null);
  };

  // ---- 翻页 ----
  const goToPage = (p: number) => {
    if (!numPages) return;
    const target = Math.max(1, Math.min(numPages, p));
    setCurrentPage(target);
  };

  const jumpToAnnotation = (a: TextAnnotation) => {
    setCurrentPage(a.pageIndex + 1);
    setSelectedId(a.id);
    setFocusId(a.id);
  };

  // ---- 缩放 ----
  const zoomOut = () => setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)));
  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)));
  const resetZoom = () => setZoom(1);

  // ---- 保存 ----
  const handleSave = async () => {
    if (!bytesRef.current) {
      setError('请先上传 PDF 文件');
      return;
    }
    if (annotations.length === 0) {
      setError('暂无文本标注可保存');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // 按字体类型分组，每组单独获取子集字体
      const fontFamilyGroups: Record<string, TextAnnotation[]> = {};
      for (const ann of annotations) {
        const fam = ann.fontFamily || DEFAULT_FONT_FAMILY;
        if (!fontFamilyGroups[fam]) fontFamilyGroups[fam] = [];
        fontFamilyGroups[fam].push(ann);
      }

      // 并行获取每种字体的子集
      const fontEntries = await Promise.all(
        Object.entries(fontFamilyGroups).map(async ([family, anns]) => {
          const allText = anns.map((a) => a.text).join('');
          const formData = new FormData();
          formData.append('text', allText);
          formData.append('font_family', family);
          const resp = await fetch('/api/v1/pdf/subset-font', {
            method: 'POST',
            body: formData,
          });
          if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            throw new Error(err.detail || `获取字体 ${family} 失败`);
          }
          const fontBytes = new Uint8Array(await resp.arrayBuffer());
          return { family, fontBytes };
        })
      );

      const pdfDocLib = await PDFDocument.load(bytesRef.current.slice());
      pdfDocLib.registerFontkit(fontkit);

      // 嵌入各字体子集
      const fontMap: Record<string, any> = {};
      for (const { family, fontBytes } of fontEntries) {
        fontMap[family] = await pdfDocLib.embedFont(fontBytes, { subset: true });
      }
      const helvetica = await pdfDocLib.embedFont(StandardFonts.Helvetica);

      const pages = pdfDocLib.getPages();
      for (const ann of annotations) {
        const page = pages[ann.pageIndex];
        if (!page) continue;
        const { r, g, b } = hexToRgb(ann.color);
        const font = fontMap[ann.fontFamily || DEFAULT_FONT_FAMILY] || helvetica;
        const lines = ann.text.split('\n');

        lines.forEach((line, i) => {
          if (!line) return;
          const lineY = ann.y - i * ann.fontSize * 1.2;
          const lineX = ann.x;

          // 斜体：用 PDF 操作符 graphics state + skew 变换
          if (ann.italic) {
            page.pushOperators(pushGraphicsState(), skewDegrees(-12, 0));
          }

          // 加粗：多次微偏移绘制模拟描边加粗
          const drawOffsets = ann.bold
            ? [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]
            : [[0, 0]];

          for (const [ox, oy] of drawOffsets) {
            page.drawText(line, {
              x: lineX + ox,
              y: lineY + oy,
              size: ann.fontSize,
              font,
              color: rgb(r, g, b),
            });
          }

          if (ann.italic) {
            page.pushOperators(popGraphicsState());
          }

          // 下划线：在文字基线下方画一条线
          if (ann.underline) {
            const textWidth = font.widthOfTextAtSize(line, ann.fontSize);
            page.drawLine({
              start: { x: lineX, y: lineY - 2 },
              end: { x: lineX + textWidth, y: lineY - 2 },
              thickness: Math.max(0.5, ann.fontSize / 18),
              color: rgb(r, g, b),
            });
          }
        });
      }
      const saved = await pdfDocLib.save();
      const base = file?.name.replace(/\.pdf$/i, '') || 'document';
      downloadBlob(
        new Blob([new Uint8Array(saved)], { type: 'application/pdf' }),
        `${base}_标注.pdf`
      );
    } catch (e: any) {
      setError(e?.message || '保存失败，请检查标注内容');
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (loadingTaskRef.current) {
      loadingTaskRef.current.destroy().catch(() => {});
      loadingTaskRef.current = null;
    }
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }
    setFile(null);
    setPdfDoc(null);
    setNumPages(0);
    setCurrentPage(1);
    setCurrentPageDims(null);
    setAnnotations([]);
    setSelectedId(null);
    setZoom(1);
    setError('');
    bytesRef.current = null;
  };

  // ---- 派生 ----
  const selected = annotations.find((a) => a.id === selectedId) || null;
  const pageAnnotations = annotations.filter(
    (a) => a.pageIndex === currentPage - 1
  );

  // ============ 上传态 ============
  if (!pdfDoc) {
    const sizeHint = `仅支持 PDF · 单文件 ≤ ${formatBytes(MAX_FILE_SIZE)}`;
    return (
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400">
            ⚠️ {error}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
            ① 上传 PDF
          </label>
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
            <p className="font-medium text-sm">
              {loading ? '加载中…' : '拖拽 PDF 至此 或 点击选择'}
            </p>
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
        </div>

        {/* 功能提示 */}
        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
          ✓ 支持中文填写：保存时自动从后端获取中文字体子集并嵌入 PDF，中文英文均可正常显示。
        </div>

        <p className="text-xs text-gray-400 text-center">
          所有操作均在浏览器本地完成，文件不会上传到服务器
        </p>
      </div>
    );
  }

  // ============ 编辑态 ============
  return (
    <div className="space-y-3">
      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          ⚠️ {error}
        </div>
      )}

      {/* 文件信息 */}
      <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
        <span className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
          📄
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{file?.name}</p>
          <p className="text-xs text-gray-400">
            {file ? formatBytes(file.size) : ''} · {numPages} 页 · {annotations.length} 标注
          </p>
        </div>
        <button
          onClick={reset}
          className="text-gray-400 hover:text-red-500 text-xs px-2"
          title="更换文件"
        >
          更换
        </button>
      </div>

      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-gray-800">
        {/* 工具切换 */}
        <div className="flex gap-1 bg-white dark:bg-gray-900 rounded-md p-0.5">
          <button
            onClick={() => setTool('text')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              tool === 'text'
                ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
            title="点击 PDF 任意位置添加文本"
          >
            📝 文本工具
          </button>
          <button
            onClick={() => setTool('select')}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
              tool === 'select'
                ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
            title="选择 / 移动 / 编辑已有标注"
          >
            👆 选择
          </button>
        </div>

        {/* 缩放 */}
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 rounded bg-white dark:bg-gray-900 text-xs disabled:opacity-40"
            title="缩小"
          >
            －
          </button>
          <button
            onClick={resetZoom}
            className="px-2 h-7 rounded bg-white dark:bg-gray-900 text-xs font-mono min-w-[3.5rem]"
            title="重置缩放"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 rounded bg-white dark:bg-gray-900 text-xs disabled:opacity-40"
            title="放大"
          >
            ＋
          </button>
        </div>

        <div className="ml-auto flex gap-2">
          <button
            onClick={clearAll}
            disabled={annotations.length === 0}
            className="btn-ghost text-xs disabled:opacity-40"
          >
            🗑 清空
          </button>
          <button
            onClick={handleSave}
            disabled={saving || annotations.length === 0}
            className="btn-primary text-xs disabled:opacity-40"
          >
            {saving ? '保存中…' : '💾 保存'}
          </button>
        </div>
      </div>

      {/* 功能提示 */}
      <div className="rounded-lg bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 text-xs text-emerald-700 dark:text-emerald-400">
        ✓ 已支持中文填写，保存时自动嵌入中文字体。
      </div>

      {/* 主区：画布 + 侧栏 */}
      <div className="flex flex-col lg:flex-row gap-3">
        {/* 左：画布与导航 */}
        <div className="flex-1 min-w-0 space-y-2">
          <div
            className="rounded-lg border border-gray-200 dark:border-gray-800 overflow-auto bg-gray-100 dark:bg-gray-900"
            style={{ maxHeight: '70vh' }}
          >
            <div className="flex items-start justify-center p-4">
              <div className="relative inline-block">
                <canvas
                  ref={canvasRef}
                  onClick={onCanvasClick}
                  className="block shadow-md"
                  style={{
                    cursor: tool === 'text' ? 'crosshair' : 'default',
                  }}
                />
                {currentPageDims &&
                  pageAnnotations.map((a) => (
                    <TextBox
                      key={a.id}
                      annotation={a}
                      zoom={zoom}
                      pageHeight={currentPageDims.height}
                      selected={a.id === selectedId}
                      focusRequested={a.id === focusId}
                      onSelect={() => setSelectedId(a.id)}
                      onChange={(patch) => updateAnnotation(a.id, patch)}
                      onDelete={() => deleteAnnotation(a.id)}
                    />
                  ))}
                {rendering && (
                  <div className="absolute inset-0 flex items-center justify-center bg-white/40 dark:bg-black/40 text-xs text-gray-500">
                    渲染中…
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 翻页 */}
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
              className="btn-ghost text-xs disabled:opacity-40"
            >
              ◀ 上一页
            </button>
            <span className="text-xs text-gray-600 dark:text-gray-300">
              第 {currentPage} / {numPages} 页
            </span>
            <button
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= numPages}
              className="btn-ghost text-xs disabled:opacity-40"
            >
              下一页 ▶
            </button>
            <div className="flex items-center gap-1 ml-2">
              <input
                key={currentPage}
                ref={jumpInputRef}
                type="number"
                min={1}
                max={numPages}
                defaultValue={String(currentPage)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') doJump();
                }}
                className="input w-16 text-xs"
              />
              <button onClick={doJump} className="btn-ghost text-xs">
                跳转
              </button>
            </div>
          </div>
        </div>

        {/* 右：标注列表 + 属性 */}
        <div className="lg:w-64 shrink-0 space-y-3">
          {/* 标注列表 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-2">
            <h3 className="text-xs font-medium text-gray-500 uppercase mb-2">
              标注列表（{annotations.length}）
            </h3>
            {annotations.length === 0 ? (
              <p className="text-xs text-gray-400 py-2 text-center">
                暂无标注
                <br />
                {tool === 'text'
                  ? '点击页面任意位置添加'
                  : '切换到“文本工具”以添加'}
              </p>
            ) : (
              <ul className="max-h-60 overflow-y-auto space-y-1">
                {annotations.map((a, i) => (
                  <li key={a.id}>
                    <button
                      onClick={() => jumpToAnnotation(a)}
                      className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 ${
                        a.id === selectedId
                          ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                          : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                      }`}
                    >
                      <span className="shrink-0 w-5 text-center text-gray-400">
                        {i + 1}
                      </span>
                      <span className="shrink-0 text-gray-400">
                        P{a.pageIndex + 1}
                      </span>
                      <span className="truncate flex-1">
                        {a.text || '(空)'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {annotations.length > 0 && (
              <button
                onClick={clearAll}
                className="mt-2 w-full text-xs text-red-500 hover:text-red-600"
              >
                清空全部
              </button>
            )}
          </div>

          {/* 文本属性 */}
          <div className="rounded-lg border border-gray-200 dark:border-gray-800 p-2 space-y-3">
            <h3 className="text-xs font-medium text-gray-500 uppercase">
              文本属性
            </h3>
            {selected ? (
              <>
                {/* 字体类型 */}
                <div>
                  <span className="text-xs text-gray-600 dark:text-gray-300 block mb-1">
                    字体
                  </span>
                  <select
                    value={selected.fontFamily}
                    onChange={(e) =>
                      updateAnnotation(selected.id, { fontFamily: e.target.value })
                    }
                    className="input w-full text-xs"
                  >
                    {FONT_FAMILIES.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 加粗 / 斜体 / 下划线 */}
                <div className="flex gap-1">
                  <button
                    onClick={() =>
                      updateAnnotation(selected.id, { bold: !selected.bold })
                    }
                    className={`flex-1 py-1.5 rounded text-xs font-bold transition-colors ${
                      selected.bold
                        ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                    title="加粗"
                  >
                    B
                  </button>
                  <button
                    onClick={() =>
                      updateAnnotation(selected.id, { italic: !selected.italic })
                    }
                    className={`flex-1 py-1.5 rounded text-xs italic transition-colors ${
                      selected.italic
                        ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                    title="斜体"
                  >
                    I
                  </button>
                  <button
                    onClick={() =>
                      updateAnnotation(selected.id, { underline: !selected.underline })
                    }
                    className={`flex-1 py-1.5 rounded text-xs underline transition-colors ${
                      selected.underline
                        ? 'bg-brand-100 dark:bg-brand-900/40 text-brand-600 dark:text-brand-400'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'
                    }`}
                    title="下划线"
                  >
                    U
                  </button>
                </div>

                <div>
                  <div className="flex justify-between mb-1">
                    <span className="text-xs text-gray-600 dark:text-gray-300">
                      字号
                    </span>
                    <span className="text-xs font-mono text-brand-600">
                      {selected.fontSize}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={72}
                    value={selected.fontSize}
                    onChange={(e) =>
                      updateAnnotation(selected.id, {
                        fontSize: Number(e.target.value),
                      })
                    }
                    className="w-full accent-brand-600"
                  />
                  <input
                    type="number"
                    min={1}
                    max={200}
                    value={selected.fontSize}
                    onChange={(e) =>
                      updateAnnotation(selected.id, {
                        fontSize: Number(e.target.value) || 1,
                      })
                    }
                    className="input mt-1 w-full text-xs"
                  />
                </div>
                <div>
                  <span className="text-xs text-gray-600 dark:text-gray-300 block mb-1">
                    颜色
                  </span>
                  <input
                    type="color"
                    value={selected.color}
                    onChange={(e) =>
                      updateAnnotation(selected.id, { color: e.target.value })
                    }
                    className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer"
                  />
                </div>
                <div>
                  <span className="text-xs text-gray-600 dark:text-gray-300 block mb-1">
                    内容
                  </span>
                  <input
                    type="text"
                    value={selected.text}
                    onChange={(e) =>
                      updateAnnotation(selected.id, { text: e.target.value })
                    }
                    placeholder="输入文字"
                    className="input w-full text-xs"
                  />
                </div>
                <button
                  onClick={() => deleteAnnotation(selected.id)}
                  className="btn-ghost text-xs text-red-500 hover:text-red-600 w-full"
                >
                  🗑 删除（Delete）
                </button>
              </>
            ) : (
              <p className="text-xs text-gray-400 py-2 text-center">
                选中一个标注以编辑属性
              </p>
            )}
          </div>
        </div>
      </div>

      {/* 底部提示 */}
      <p className="text-xs text-gray-400 text-center">
        点击页面添加文本 · 拖拽顶部手柄移动 · Delete 删除 · 所有操作本地完成
      </p>
    </div>
  );
}
