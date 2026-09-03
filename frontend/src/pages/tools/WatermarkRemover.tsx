import { useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, formatBytes, downloadBlob } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { LoadingOverlay, ButtonSpinner } from '../../components/Loading';

const tool = tools.find((t) => t.id === 'watermark-remover')!;

// 工具模式：矩形框选 / 涂抹标记 / 擦除修正
type ToolMode = 'rect' | 'paint' | 'erase';
// 修复算法
type Method = 'telea' | 'ns';

// 矩形区域（原始图片像素坐标）
interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 涂抹笔触（坐标与半径均为原始图片像素）
type StrokeKind = 'paint' | 'erase';
interface Stroke {
  kind: StrokeKind;
  points: { x: number; y: number }[];
  r: number; // 自然像素半径
}

// 统一操作历史：框选与涂抹共享同一条时间线，保证撤销顺序正确
type Action =
  | { id: number; kind: 'rect'; rect: Region }
  | { id: number; kind: 'stroke'; stroke: Stroke };

// 画布显示尺寸（canvas 内部像素 = 展示像素）
interface ViewSize {
  w: number;
  h: number;
}

// 上传限制：与后端 settings.MAX_UPLOAD_SIZE（50MB）保持一致
const MAX_FILE_SIZE = 50 * 1024 * 1024;
// 后端基于 OpenCV 解码/修复，支持常见栅格格式
const MIME_WHITELIST = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);
const EXT_WHITELIST = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp']);
// 编辑区展示最大高度
const MAX_VIEW_H = 480;
// 矩形区域最小边长（自然像素），防止误触产生无效区域
const MIN_REGION = 3;
// 请求超时（毫秒）
const REQUEST_TIMEOUT_MS = 90_000;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// 是否受支持的图片：优先 MIME，兜底按扩展名判断（兼容无 MIME 的文件）
function isSupportedImage(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (MIME_WHITELIST.has(mime)) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_WHITELIST.has(ext);
}

// 画布导出为 Blob
function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成图片失败'))), type);
  });
}

// 是否为 Abort 相关的错误
function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export default function WatermarkRemover() {
  const { toast, success, warning, error: toastError } = useToast();

  // 文件与图片状态
  const [file, setFile] = useState<File | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [view, setView] = useState<ViewSize>({ w: 0, h: 0 });
  const [busy, setBusy] = useState(''); // 非空 = 处理中（LoadingOverlay 文案）
  const [dragOver, setDragOver] = useState(false);

  // 工具与参数
  const [mode, setMode] = useState<ToolMode>('rect');
  const [method, setMethod] = useState<Method>('telea');
  const [radius, setRadius] = useState(3);
  const [brushSize, setBrushSize] = useState(24); // 展示像素

  // 统一操作历史
  const [actions, setActions] = useState<Action[]>([]);
  const [draft, setDraft] = useState<Region | null>(null); // 框选进行中

  // 结果状态
  const [resultUrl, setResultUrl] = useState('');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const rectActions = actions.filter((a): a is Extract<Action, { kind: 'rect' }> => a.kind === 'rect');
  const strokeActions = actions.filter(
    (a): a is Extract<Action, { kind: 'stroke' }> => a.kind === 'stroke'
  );
  const hasPaint = strokeActions.some((a) => a.stroke.kind === 'paint');

  const natW = img?.naturalWidth ?? 0;
  const natH = img?.naturalHeight ?? 0;
  const isBusy = busy !== '';

  // DOM 引用
  const inputRef = useRef<HTMLInputElement>(null);
  const editorBoxRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  // 资源与请求生命周期
  const srcUrlRef = useRef('');
  const resultUrlRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const unmountedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const actionIdRef = useRef(0);
  const processingRef = useRef(false); // 同步防重复提交

  // 拖拽/涂抹过程
  const drawingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<Region | null>(null); // 与 draft state 同步，避免 up 时读到过期值
  const currentStrokeRef = useRef<Stroke | null>(null);

  // ===== ObjectURL 管理 =====

  /** 释放结果 URL 与状态 */
  const releaseResult = () => {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = '';
    }
    setResultUrl('');
    setResultBlob(null);
  };

  /** 释放输入 URL */
  const releaseSource = () => {
    if (srcUrlRef.current) {
      URL.revokeObjectURL(srcUrlRef.current);
      srcUrlRef.current = '';
    }
    setSrcUrl('');
  };

  // 组件卸载：取消进行中的请求并释放全部 ObjectURL
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      abortRef.current?.abort();
      if (srcUrlRef.current) URL.revokeObjectURL(srcUrlRef.current);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    };
  }, []);

  // ===== 画布显示尺寸：按容器宽度等比缩放（仅缩小不放大） =====
  useEffect(() => {
    const box = editorBoxRef.current;
    if (!img || !box || natW <= 0 || natH <= 0) return;
    const update = () => {
      const availW = Math.max(1, box.clientWidth - 8); // 预留 p-1 边距
      const s = Math.min(1, availW / natW, MAX_VIEW_H / natH);
      const w = Math.max(1, Math.round(natW * s));
      const h = Math.max(1, Math.round(natH * s));
      setView((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(box);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img]);

  // ===== 上传 =====
  const pickFile = async (f: File) => {
    if (isBusy) return;
    if (!isSupportedImage(f)) {
      toastError('暂不支持该格式，请上传 JPG / PNG / WebP / BMP 图片');
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      toastError('图片大小超出 50MB 限制');
      return;
    }
    const seq = ++loadSeqRef.current;
    setBusy('正在解析图片…');
    try {
      // 先等图片真正解码完成再替换界面，避免未解码就绘制
      const el = await loadImage(f);
      if (seq !== loadSeqRef.current || unmountedRef.current) return;
      // 替换成功后才释放旧资源，防止切换瞬间空白
      releaseSource();
      releaseResult();
      const url = URL.createObjectURL(f);
      srcUrlRef.current = url;
      setSrcUrl(url);
      setFile(f);
      setImg(el);
      setView({ w: 0, h: 0 });
      setActions([]);
      setDraft(null);
      drawingRef.current = false;
      dragStartRef.current = null;
      currentStrokeRef.current = null;
      setMode('rect');
      setErrorMsg('');
    } catch {
      if (seq === loadSeqRef.current && !unmountedRef.current) {
        toastError('图片解析失败，请更换图片后重试');
      }
    } finally {
      if (seq === loadSeqRef.current && !unmountedRef.current) setBusy('');
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
    e.target.value = ''; // 允许重复选择同一文件
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (isBusy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  };

  // ===== 坐标换算 =====
  /** 事件坐标 → 原图像素坐标（基于 getBoundingClientRect，兼容 CSS 缩放）并夹紧到图像范围 */
  const toNatural = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || natW <= 0 || natH <= 0) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: clamp(((e.clientX - rect.left) * natW) / rect.width, 0, natW),
      y: clamp(((e.clientY - rect.top) * natH) / rect.height, 0, natH),
    };
  };

  // 自然像素 → 画布像素
  const toViewPx = (nx: number, ny: number) => {
    const k = view.w > 0 && natW > 0 ? view.w / natW : 1;
    return { x: nx * k, y: ny * k };
  };

  // ===== 基础图层：原图 =====
  useEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas || !img || view.w <= 0 || view.h <= 0) return;
    canvas.width = view.w;
    canvas.height = view.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, view.w, view.h);
  }, [img, view.w, view.h]);

  // ===== 覆盖层重绘：框选区域 / 涂抹痕迹 =====
  const redrawOverlay = () => {
    // 笔刷拖拽过程中只做增量绘制，避免重放清空正在画的笔触
    if (mode !== 'rect' && drawingRef.current && currentStrokeRef.current) return;
    const canvas = overlayCanvasRef.current;
    if (!canvas || view.w <= 0 || view.h <= 0) return;
    canvas.width = view.w;
    canvas.height = view.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (mode === 'rect') {
      // 矩形框选
      const kx = natW > 0 ? view.w / natW : 1;
      const ky = natH > 0 ? view.h / natH : 1;
      const lineW = Math.max(1, view.w / 400);
      ctx.lineWidth = lineW;
      ctx.fillStyle = 'rgba(220,38,38,0.28)';
      ctx.strokeStyle = '#ef4444';
      const drawOne = (r: Region) => {
        const x = r.x * kx;
        const y = r.y * ky;
        const w = r.width * kx;
        const h = r.height * ky;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      };
      rectActions.forEach((a) => drawOne(a.rect));
      if (draft) drawOne(draft);
    } else {
      // 涂抹 / 擦除痕迹（按操作顺序重放）
      const k = natW > 0 ? view.w / natW : 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokeActions.forEach(({ stroke }) => {
        ctx.save();
        if (stroke.kind === 'erase') {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.fillStyle = '#000';
          ctx.strokeStyle = '#000';
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        }
        ctx.lineWidth = Math.max(1, stroke.r * k * 2);
        const pts = stroke.points;
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x * k, pts[0].y * k, Math.max(0.5, stroke.r * k), 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          pts.forEach((p, i) =>
            i === 0 ? ctx.moveTo(p.x * k, p.y * k) : ctx.lineTo(p.x * k, p.y * k)
          );
          ctx.stroke();
        }
        ctx.restore();
      });
    }
  };

  // 框选/涂抹状态变化时重绘覆盖层
  useEffect(() => {
    redrawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, actions, draft, view.w, view.h, natW, natH]);

  // 输入 URL 更新 ref
  useEffect(() => {
    srcUrlRef.current = srcUrl;
  }, [srcUrl]);
  useEffect(() => {
    resultUrlRef.current = resultUrl;
  }, [resultUrl]);

  // ===== 矩形框选交互 =====
  const commitRegion = (r: Region) => {
    // 转为整数并夹紧到图片范围，与后端 int 掩码口径一致
    const x0 = clamp(Math.round(r.x), 0, natW);
    const y0 = clamp(Math.round(r.y), 0, natH);
    const x1 = clamp(Math.round(r.x + r.width), x0, natW);
    const y1 = clamp(Math.round(r.y + r.height), y0, natH);
    if (x1 - x0 < MIN_REGION || y1 - y0 < MIN_REGION) return;
    const action: Action = {
      id: ++actionIdRef.current,
      kind: 'rect',
      rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
    };
    setActions((prev) => [...prev, action]);
  };

  // ===== 涂抹 / 擦除交互 =====
  /** 在覆盖层上增量绘制当前笔触的一段/一个点（不触发全量重绘） */
  const paintCurrentSegment = (last: { x: number; y: number } | null) => {
    const canvas = overlayCanvasRef.current;
    const stroke = currentStrokeRef.current;
    if (!canvas || !stroke || stroke.points.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const k = natW > 0 ? view.w / natW : 1;
    const cur = stroke.points[stroke.points.length - 1];
    const c = toViewPx(cur.x, cur.y);
    ctx.save();
    if (stroke.kind === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1, stroke.r * k * 2);
    if (!last) {
      // 单点：画一个圆点
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(0.5, stroke.r * k), 0, Math.PI * 2);
      ctx.fill();
    } else {
      const p = toViewPx(last.x, last.y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
    ctx.restore();
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (isBusy || !img || view.w <= 0) return;
    e.preventDefault();
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const p = toNatural(e);
    if (mode === 'rect') {
      dragStartRef.current = p;
      const r0 = { x: p.x, y: p.y, width: 0, height: 0 };
      draftRef.current = r0;
      setDraft(r0);
    } else {
      const k = natW > 0 ? view.w / natW : 1;
      currentStrokeRef.current = {
        kind: mode,
        points: [p],
        r: brushSize / k,
      };
      paintCurrentSegment(null);
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || isBusy) return;
    const p = toNatural(e);
    if (mode === 'rect') {
      const start = dragStartRef.current;
      if (!start) return;
      const next = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        width: Math.abs(p.x - start.x),
        height: Math.abs(p.y - start.y),
      };
      draftRef.current = next;
      setDraft(next);
      return;
    }
    const stroke = currentStrokeRef.current;
    if (!stroke) return;
    const last = stroke.points[stroke.points.length - 1];
    // 过滤过近的点，保持轨迹平滑
    if (Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return;
    stroke.points.push(p);
    paintCurrentSegment(last);
  };

  const onPointerUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    if (mode === 'rect') {
      const d = draftRef.current;
      if (d && d.width > 0 && d.height > 0) commitRegion(d);
      dragStartRef.current = null;
      draftRef.current = null;
      setDraft(null);
      return;
    }
    const stroke = currentStrokeRef.current;
    if (stroke && stroke.points.length > 0) {
      const action: Action = {
        id: ++actionIdRef.current,
        kind: 'stroke',
        stroke: { ...stroke, points: stroke.points.slice() },
      };
      setActions((prev) => [...prev, action]);
    }
    currentStrokeRef.current = null;
  };

  const onPointerCancel = () => {
    drawingRef.current = false;
    dragStartRef.current = null;
    draftRef.current = null;
    setDraft(null);
    currentStrokeRef.current = null;
    redrawOverlay(); // 清掉被取消的进行中笔触残留
  };

  // ===== 撤销 / 清除 =====
  const undo = () => {
    if (isBusy || actions.length === 0) return;
    setActions((prev) => prev.slice(0, -1));
  };

  const clearCurrent = () => {
    if (isBusy) return;
    if (mode === 'rect') {
      setActions((prev) => prev.filter((a) => a.kind !== 'rect'));
    } else {
      setActions((prev) => prev.filter((a) => a.kind !== 'stroke'));
    }
  };

  const removeRegion = (a: Extract<Action, { kind: 'rect' }>) => {
    if (isBusy) return;
    setActions((prev) => prev.filter((x) => x !== a));
  };

  // ===== 导出掩码（黑白图：黑底，白色=待修复区域） =====
  const buildMaskBlob = (): Promise<Blob> => {
    const canvas = document.createElement('canvas');
    canvas.width = natW;
    canvas.height = natH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return Promise.reject(new Error('无法创建画布'));
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeActions.forEach(({ stroke }) => {
      ctx.save();
      const color = stroke.kind === 'erase' ? '#000' : '#fff';
      ctx.fillStyle = color;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, stroke.r * 2);
      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, Math.max(0.5, stroke.r), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        pts.forEach((p, i) =>
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
        );
        ctx.stroke();
      }
      ctx.restore();
    });
    return canvasToBlob(canvas, 'image/png');
  };

  // ===== 调用后端去除水印 =====
  const process = async () => {
    if (isBusy || processingRef.current || !file || !img) return;
    const useRect = mode === 'rect';
    if (useRect && rectActions.length === 0) {
      setErrorMsg('请先框选水印区域');
      warning('请先在图片上框选水印区域');
      return;
    }
    if (!useRect && !hasPaint) {
      setErrorMsg('请先涂抹标记水印区域，可切换「擦除」修正');
      warning('请先涂抹标记水印区域');
      return;
    }
    processingRef.current = true;
    setErrorMsg('');
    releaseResult();
    setBusy('正在去除水印…');

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      if (useRect) {
        fd.append('regions', JSON.stringify(rectActions.map((a) => a.rect)));
      } else {
        const maskBlob = await buildMaskBlob();
        fd.append('mask', maskBlob, 'mask.png');
      }
      fd.append('method', method);
      fd.append('radius', String(radius));

      const res = await fetch('/api/v1/image/remove-watermark', {
        method: 'POST',
        body: fd,
        signal: controller.signal,
      });
      if (!res.ok) {
        let msg = `处理失败（HTTP ${res.status}）`;
        try {
          const data = await res.json();
          if (typeof data?.detail === 'string') msg = data.detail;
        } catch {
          /* 非 JSON 错误体则使用默认文案 */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (!blob || blob.size === 0) throw new Error('后端返回了空结果，请重试');
      if (unmountedRef.current) return;
      const url = URL.createObjectURL(blob);
      resultUrlRef.current = url;
      setResultUrl(url);
      setResultBlob(blob);
      success(`去水印完成，已生成 ${formatBytes(blob.size)} 的 PNG 图片`);
    } catch (e) {
      if (unmountedRef.current) return;
      if (isAbortError(e)) {
        // 组件卸载触发的取消不做提示
        if (controller.signal.reason === 'timeout') {
          setErrorMsg('处理超时，请缩小标记范围后重试');
          toastError('处理超时，请重试');
        }
        return;
      }
      const msg =
        e instanceof TypeError
          ? '网络请求失败，请确认后端服务已启动后重试'
          : e instanceof Error
            ? e.message
            : String(e);
      setErrorMsg(msg);
      toastError(msg);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      window.clearTimeout(timer);
      processingRef.current = false;
      if (!unmountedRef.current) setBusy('');
    }
  };

  // ===== 自动检测（后端暂未提供 AI 接口） =====
  const onAutoDetect = () => {
    toast('自动检测水印为进阶 AI 功能，后端尚未上线，请先手动框选或涂抹标记', 'info');
  };

  // ===== 下载 / 重置 =====
  const download = () => {
    if (!resultBlob || isBusy) return;
    const base = file?.name.replace(/\.[^.]+$/, '') || 'image';
    downloadBlob(resultBlob, `${base}_no_watermark.png`);
  };

  const reset = () => {
    if (isBusy) return;
    releaseSource();
    releaseResult();
    setFile(null);
    setImg(null);
    setView({ w: 0, h: 0 });
    setActions([]);
    setDraft(null);
    drawingRef.current = false;
    dragStartRef.current = null;
    currentStrokeRef.current = null;
    setErrorMsg('');
    setMode('rect');
  };

  const changeParam = (fn: () => void) => {
    if (isBusy) return;
    if (resultUrl) releaseResult();
    setErrorMsg('');
    fn();
  };

  const paintCount = strokeActions.filter((a) => a.stroke.kind === 'paint').length;
  const eraseCount = strokeActions.length - paintCount;
  const canProcess =
    !!file && !!img && !isBusy && (mode === 'rect' ? rectActions.length > 0 : hasPaint);
  const scalePct = natW > 0 && view.w > 0 ? Math.round((view.w / natW) * 100) : 100;

  const toolOptions: { value: ToolMode; label: string; icon: string }[] = [
    { value: 'rect', label: '框选', icon: '▭' },
    { value: 'paint', label: '涂抹', icon: '🖌' },
    { value: 'erase', label: '擦除', icon: '🧽' },
  ];

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：上传与编辑 */}
        <div className="relative space-y-4">
          {isBusy && <LoadingOverlay message={busy} />}

          {/* ① 上传区 */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 上传图片
            </label>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/bmp"
              className="hidden"
              onChange={onFileChange}
            />
            {!img ? (
              <div
                onDragOver={(e) => {
                  if (isBusy) return;
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => !isBusy && inputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                  isBusy
                    ? 'opacity-60 pointer-events-none border-gray-200 dark:border-gray-700'
                    : 'cursor-pointer ' +
                      (dragOver
                        ? 'dropzone-active border-brand-500'
                        : 'border-gray-300 dark:border-gray-700 hover:border-brand-400')
                }`}
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="text-sm font-medium">
                  拖拽图片至此 或 点击选择
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  支持 JPG / PNG / WebP / BMP · 单文件 ≤ 50MB
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-0 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                  <span className="text-xl shrink-0">🖼️</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{file?.name}</p>
                    <p className="text-xs text-gray-400">
                      {natW} × {natH} px · {formatBytes(file?.size ?? 0)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => !isBusy && inputRef.current?.click()}
                  disabled={isBusy}
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  🔄 重新选择
                </button>
              </div>
            )}
          </div>

          {/* ② 标记水印区域 */}
          {img && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-gray-500 uppercase">
                  ② 标记水印区域
                </label>
                <button
                  onClick={onAutoDetect}
                  disabled={isBusy}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-2.5 py-1 text-xs text-gray-500 dark:text-gray-400 hover:border-brand-400 hover:text-brand-600 transition-colors disabled:opacity-50"
                >
                  ✨ 自动检测
                  <span className="tag bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                    开发中
                  </span>
                </button>
              </div>

              {/* 工具切换 */}
              <div>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {toolOptions.map((opt) => (
                    <button
                      key={opt.value}
                      disabled={isBusy}
                      onClick={() => setMode(opt.value)}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                        mode === opt.value
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {opt.icon} {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-1.5">
                  {mode === 'rect' &&
                    (rectActions.length > 0
                      ? `已框选 ${rectActions.length} 个区域，可继续拖拽叠加`
                      : '在图片上拖拽框选水印区域，可叠加多个')}
                  {mode === 'paint' &&
                    (paintCount > 0
                      ? `已涂抹 ${paintCount} 笔，按住鼠标在图片上继续标记水印`
                      : '按住鼠标在图片上涂抹覆盖水印区域')}
                  {mode === 'erase' &&
                    (paintCount > 0
                      ? `已涂抹 ${paintCount} 笔、擦除 ${eraseCount} 笔，滑动可移除多余标记`
                      : '请先用「涂抹」标记水印，再切换「擦除」修正边缘')}
                </p>
              </div>

              {/* 编辑画布 */}
              <div
                ref={editorBoxRef}
                className="w-full rounded-xl bg-gray-50 dark:bg-gray-800 max-h-[520px] overflow-auto"
              >
                {view.w > 0 && (
                  <div className="w-max mx-auto p-1">
                    <div className="relative select-none" style={{ width: view.w, height: view.h }}>
                      <canvas
                        ref={baseCanvasRef}
                        width={view.w}
                        height={view.h}
                        className="block rounded-md"
                      />
                      <canvas
                        ref={overlayCanvasRef}
                        width={view.w}
                        height={view.h}
                        className="absolute left-0 top-0 block rounded-md"
                        style={{ cursor: 'crosshair', touchAction: 'none' }}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerCancel}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 显示缩放提示 */}
              {natW > 0 && (
                <p className="text-[11px] text-gray-400">
                  显示缩放 {Math.max(1, scalePct)}%
                  {scalePct < 100 && '（仅影响显示，处理按原图分辨率执行）'}
                </p>
              )}

              {/* 框选区域列表 */}
              {mode === 'rect' && rectActions.length > 0 && (
                <div className="space-y-1 max-h-28 overflow-y-auto">
                  {rectActions.map((a, i) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between rounded bg-gray-50 dark:bg-gray-800 px-2 py-1 text-xs"
                    >
                      <span className="font-mono text-gray-500">
                        区域{i + 1}: {a.rect.width}×{a.rect.height} px
                      </span>
                      <button
                        onClick={() => removeRegion(a)}
                        disabled={isBusy}
                        className="text-gray-400 hover:text-red-500 disabled:opacity-40"
                        aria-label={`删除区域 ${i + 1}`}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* 笔刷大小（涂抹 / 擦除） */}
              {mode !== 'rect' && (
                <div className="flex justify-between items-center">
                  <span className="text-xs text-gray-500">笔刷大小</span>
                  <div className="flex items-center gap-3 flex-1 ml-4">
                    <input
                      type="range"
                      min="6"
                      max="80"
                      value={brushSize}
                      disabled={isBusy}
                      onChange={(e) => changeParam(() => setBrushSize(Number(e.target.value)))}
                      className="w-full accent-brand-600 disabled:opacity-50"
                    />
                    <span className="text-xs font-mono text-brand-600 w-12 text-right shrink-0">
                      {brushSize}px
                    </span>
                  </div>
                </div>
              )}

              {/* 撤销 / 清除 */}
              <div className="flex gap-2">
                <button
                  onClick={undo}
                  disabled={isBusy || actions.length === 0}
                  className="btn-ghost flex-1 text-xs disabled:opacity-40"
                >
                  ↶ 撤销（{actions.length}）
                </button>
                <button
                  onClick={clearCurrent}
                  disabled={isBusy || (mode === 'rect' ? rectActions.length === 0 : strokeActions.length === 0)}
                  className="btn-ghost flex-1 text-xs disabled:opacity-40"
                >
                  {mode === 'rect' ? '清空框选' : '清除涂抹'}
                </button>
              </div>
            </div>
          )}

          {/* ③ 去水印参数 */}
          {img && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ③ 去水印参数
              </label>
              <div>
                <span className="text-sm block mb-1.5">修复算法</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {(
                    [
                      { value: 'telea' as Method, label: 'Telea（快速）' },
                      { value: 'ns' as Method, label: 'NS（细节更好）' },
                    ]
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      disabled={isBusy}
                      onClick={() => changeParam(() => setMethod(opt.value))}
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                        method === opt.value
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">修复半径</span>
                  <span className="text-sm font-mono text-brand-600">{radius}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  value={radius}
                  disabled={isBusy}
                  onChange={(e) => changeParam(() => setRadius(Number(e.target.value)))}
                  className="w-full accent-brand-600 disabled:opacity-50"
                />
                <p className="text-xs text-gray-400 mt-1">
                  半径越大修复越平滑，过大会引入模糊。
                </p>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          {img && (
            <div className="flex gap-2">
              <button
                onClick={process}
                disabled={!canProcess}
                className="btn-primary flex-1 disabled:opacity-50"
              >
                {busy === '正在去除水印…' ? (
                  <>
                    <ButtonSpinner />
                    正在去除水印…
                  </>
                ) : (
                  <>🪄 去除水印</>
                )}
              </button>
              <button onClick={reset} disabled={isBusy} className="btn-ghost disabled:opacity-50">
                重置
              </button>
            </div>
          )}
        </div>

        {/* 右侧：结果展示 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ④ 处理结果
          </label>

          {/* 错误提示 */}
          {errorMsg && (
            <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm px-3 py-2">
              <span className="shrink-0">⚠️</span>
              <span className="flex-1 break-all">{errorMsg}</span>
              {img && !isBusy && (
                <button
                  onClick={process}
                  className="shrink-0 text-xs underline hover:opacity-70"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {/* 加载中 */}
          {busy === '正在去除水印…' && (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[220px] flex flex-col items-center justify-center gap-3 text-gray-400">
              <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">正在去除水印，大图可能需要一些时间…</p>
            </div>
          )}

          {/* 结果对比 */}
          {!isBusy && resultUrl ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-gray-400 mb-1 text-center">原图</p>
                  <img
                    src={srcUrl}
                    alt="原图"
                    className="w-full rounded-lg max-h-64 object-contain bg-gray-50 dark:bg-gray-800"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-brand-600 mb-1 text-center">结果</p>
                  <img
                    src={resultUrl}
                    alt="去水印结果"
                    className="w-full rounded-lg max-h-64 object-contain bg-gray-50 dark:bg-gray-800"
                  />
                </div>
              </div>
              {resultBlob && (
                <p className="text-xs text-gray-400 text-center">
                  {natW} × {natH} px · PNG {formatBytes(resultBlob.size)}
                </p>
              )}
              <div className="flex gap-2">
                <button onClick={download} disabled={isBusy} className="btn-primary flex-1 disabled:opacity-50">
                  ⬇️ 下载 PNG
                </button>
                <button onClick={reset} disabled={isBusy} className="btn-ghost disabled:opacity-50">
                  重置
                </button>
              </div>
            </div>
          ) : (
            !isBusy &&
            !errorMsg && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[220px] flex items-center justify-center text-gray-400 text-sm px-6 text-center">
                {img
                  ? '框选或涂抹标记水印区域后，点击「去除水印」'
                  : '上传图片后将显示处理结果'}
              </div>
            )
          )}

          {/* 效果提示 */}
          <div className="rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-400 leading-relaxed space-y-1">
            <p>
              💡 基于后端 OpenCV Inpaint 修复，结果以 PNG 无损输出；请尽量完整覆盖水印区域。
            </p>
            <p>
              ⚠️ 自动检测（AI）与复杂背景修复仍在开发中，效果不理想时可尝试不同算法或半径。
            </p>
          </div>
        </div>
      </div>
    </ToolLayout>
  );
}
