import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent,
} from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, formatBytes, downloadBlob } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { LoadingOverlay, ButtonSpinner } from '../../components/Loading';

const tool = tools.find((t) => t.id === 'image-crop')!;

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type AspectRatio = 'free' | '1:1' | '4:3' | '16:9' | '9:16';
type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp';

const RATIOS: Record<AspectRatio, number | null> = {
  free: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

const RATIO_ORDER: AspectRatio[] = ['free', '1:1', '4:3', '16:9', '9:16'];
const RATIO_LABEL: Record<AspectRatio, string> = {
  free: '自由',
  '1:1': '1:1',
  '4:3': '4:3',
  '16:9': '16:9',
  '9:16': '9:16',
};

const FORMATS: OutputFormat[] = ['image/png', 'image/jpeg', 'image/webp'];
const FORMAT_LABEL: Record<OutputFormat, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
  'image/webp': 'WebP',
};
const FORMAT_EXT: Record<OutputFormat, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB，与压缩工具一致
const MAX_OUT_PIX = 36_000_000; // 导出画布像素上限（防超大图 OOM）
const MAX_OUT_DIM = 12_000; // 导出画布单边上限
const MAX_VIEW_H = 420; // 编辑区显示最大高度
const MIN_CROP = 2; // 裁剪区域最小边长（原图像素）

interface ResultInfo {
  url: string;
  blob: Blob;
  size: number;
  w: number;
  h: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// 是否可解析的图片（MIME 或扩展名兜底）
function isImageFile(f: File): boolean {
  if (f.type.startsWith('image/')) return true;
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

// 将裁剪框贴合目标比例：保持较长边不变，必要时等比收缩，再按中心夹紧到图片内
function fitRatioRect(
  rect: Rect,
  ratio: number | null,
  maxW: number,
  maxH: number
): Rect {
  if (!ratio || ratio <= 0) return rect;
  let { x, y, width, height } = rect;
  if (width / height > ratio) {
    width = height * ratio;
  } else {
    height = width / ratio;
  }
  const fit = Math.min(1, maxW / width, maxH / height);
  width *= fit;
  height *= fit;
  const cx = x + rect.width / 2;
  const cy = y + rect.height / 2;
  x = clamp(cx - width / 2, 0, Math.max(0, maxW - width));
  y = clamp(cy - height / 2, 0, Math.max(0, maxH - height));
  return { x, y, width, height };
}

// 从拖拽起点/终点构造裁剪框（起点固定为框的一角，支持任意方向拖拽）
function buildCropBox(
  startX: number,
  startY: number,
  curX: number,
  curY: number,
  ratio: number | null,
  maxW: number,
  maxH: number
): Rect {
  const dx = curX - startX;
  const dy = curY - startY;
  let width = Math.abs(dx);
  let height = Math.abs(dy);
  if (ratio && ratio > 0) {
    if (width / height > ratio) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
    const fit = Math.min(1, maxW / width, maxH / height);
    width *= fit;
    height *= fit;
  } else {
    width = Math.min(width, maxW);
    height = Math.min(height, maxH);
  }
  let x = dx < 0 ? startX - width : startX;
  let y = dy < 0 ? startY - height : startY;
  x = clamp(x, 0, Math.max(0, maxW - width));
  y = clamp(y, 0, Math.max(0, maxH - height));
  return { x, y, width, height };
}

// 计算导出用的整像素区域与最终输出尺寸
function computeOutput(
  crop: Rect,
  tW: number,
  tH: number,
  scale: number
): { x0: number; y0: number; w: number; h: number; outW: number; outH: number } {
  const x0 = clamp(Math.round(crop.x), 0, tW);
  const y0 = clamp(Math.round(crop.y), 0, tH);
  const x1 = clamp(Math.round(crop.x + crop.width), x0, tW);
  const y1 = clamp(Math.round(crop.y + crop.height), y0, tH);
  const w = x1 - x0;
  const h = y1 - y0;
  return {
    x0,
    y0,
    w,
    h,
    outW: Math.max(1, Math.round(w * scale)),
    outH: Math.max(1, Math.round(h * scale)),
  };
}

// 把（旋转/翻转后的）图片绘制到画布，等比缩放以铺满 outW×outH
// 效果顺序：原图先按 angle 旋转，再在视图轴向上镜像（所见即所得）
function paintTransformed(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  outW: number,
  outH: number,
  angle: number,
  flipH: boolean,
  flipV: boolean
) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  const rotated = angle % 180 !== 0;
  const tw = rotated ? nh : nw; // 旋转后的自然尺寸
  const th = rotated ? nw : nh;
  if (tw <= 0 || th <= 0) return;
  // 取较大比例，宁可轻微溢出也不留 1px 空隙
  const k = Math.max(outW / tw, outH / th);
  ctx.save();
  ctx.translate(outW / 2, outH / 2);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(img, (-nw * k) / 2, (-nh * k) / 2, nw * k, nh * k);
  ctx.restore();
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('导出失败'))),
      type,
      quality
    );
  });
}

export default function ImageCrop() {
  const { success, error: toastError, warning } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [srcUrl, setSrcUrl] = useState('');
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ w: 0, h: 0 });
  const [angle, setAngle] = useState(0); // 0/90/180/270，顺时针
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [ratio, setRatio] = useState<AspectRatio>('free');
  const [crop, setCrop] = useState<Rect | null>(null); // 单位：变换后的原图像素
  const [format, setFormat] = useState<OutputFormat>('image/png');
  const [quality, setQuality] = useState(92);
  const [result, setResult] = useState<ResultInfo | null>(null);
  const [busy, setBusy] = useState(''); // 非空 = 处理中（提示文案）
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; on: boolean } | null>(null);

  const isBusy = busy !== '';
  const rotated = angle % 180 !== 0;
  const tW = rotated ? nat.h : nat.w; // 变换后的原图宽（像素）
  const tH = rotated ? nat.w : nat.h;
  const outScale =
    tW > 0 && tH > 0
      ? Math.min(
          1,
          Math.sqrt(MAX_OUT_PIX / (tW * tH)),
          MAX_OUT_DIM / tW,
          MAX_OUT_DIM / tH
        )
      : 1;
  const resultUrl = result?.url ?? '';
  const showQuality = format === 'image/jpeg' || format === 'image/webp';

  // 组件卸载时释放对象 URL（均在替换时通过 effect 清理，此处兜底）
  useEffect(() => {
    return () => {
      if (srcUrl) URL.revokeObjectURL(srcUrl);
    };
  }, [srcUrl]);
  useEffect(() => {
    return () => {
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [resultUrl]);

  // 依据容器宽度决定编辑区显示尺寸（仅缩小不放大，保持比例）
  useEffect(() => {
    const el = boxRef.current;
    if (!img || !el || tW <= 0 || tH <= 0) return;
    const update = () => {
      const availW = Math.max(1, el.clientWidth);
      const s = Math.min(1, availW / tW, MAX_VIEW_H / tH);
      const vw = Math.max(1, Math.round(tW * s));
      const vh = Math.max(1, Math.round(vw * (tH / tW)));
      setView((prev) => (prev.w === vw && prev.h === vh ? prev : { w: vw, h: vh }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img, tW, tH]);

  // 把当前旋转/翻转状态的图片绘制到编辑画布
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!img || !canvas || view.w < 1 || view.h < 1) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, view.w, view.h);
    paintTransformed(ctx, img, view.w, view.h, angle, flipH, flipV);
  }, [img, view.w, view.h, angle, flipH, flipV]);

  const fullCrop = (tw: number, th: number): Rect =>
    fitRatioRect({ x: 0, y: 0, width: tw, height: th }, RATIOS[ratio], tw, th);

  const discardResult = () => setResult(null);

  const pickFile = async (f: File) => {
    if (isBusy) return;
    if (!isImageFile(f)) {
      toastError('请选择 JPG / PNG / WebP 等图片文件');
      return;
    }
    if (f.size > MAX_FILE_SIZE) {
      toastError('图片大小超出 20MB 限制');
      return;
    }
    setBusy('正在解析图片…');
    const url = URL.createObjectURL(f);
    try {
      const el = await loadImage(url);
      setFile(f);
      setSrcUrl(url);
      setImg(el);
      setNat({ w: el.naturalWidth, h: el.naturalHeight });
      setAngle(0);
      setFlipH(false);
      setFlipV(false);
      setCrop(fullCrop(el.naturalWidth, el.naturalHeight));
      setResult(null);
    } catch {
      URL.revokeObjectURL(url);
      toastError('图片解析失败，请更换图片后重试');
    } finally {
      setBusy('');
    }
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
    e.target.value = ''; // 允许重复选择同一文件
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  };

  const reselect = () => {
    if (isBusy) return;
    inputRef.current?.click();
  };

  const handleReset = () => {
    if (isBusy) return;
    setFile(null);
    setSrcUrl('');
    setImg(null);
    setNat({ w: 0, h: 0 });
    setView({ w: 0, h: 0 });
    setAngle(0);
    setFlipH(false);
    setFlipV(false);
    setCrop(null);
    setResult(null);
    setDragOver(false);
  };

  const handleRatioChange = (r: AspectRatio) => {
    if (isBusy || !img || r === ratio) return;
    setRatio(r);
    // 切换比例后按新比例校正已框选的区域
    setCrop((prev) =>
      prev ? fitRatioRect(prev, RATIOS[r], tW, tH) : prev
    );
    discardResult();
  };

  const rotateImage = (step: 1 | -1) => {
    if (isBusy || !img) return;
    const next = (((angle + step * 90) % 360) + 360) % 360;
    const isRot = next % 180 !== 0;
    const tw = isRot ? nat.h : nat.w;
    const th = isRot ? nat.w : nat.h;
    setAngle(next);
    setCrop(fullCrop(tw, th)); // 旋转后画布几何变化，重置为当前比例下的整图框选
    discardResult();
  };

  const flipImage = (axis: 'h' | 'v') => {
    if (isBusy || !img) return;
    if (axis === 'h') setFlipH((v) => !v);
    else setFlipV((v) => !v);
    discardResult();
  };

  const handleFormatChange = (f: OutputFormat) => {
    if (isBusy || f === format) return;
    setFormat(f);
    discardResult();
  };

  const pointerToNatural = (e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: ((e.clientX - rect.left) * tW) / rect.width,
      y: ((e.clientY - rect.top) * tH) / rect.height,
    };
  };

  const handlePointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (isBusy || !img || view.w < 1) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ...pointerToNatural(e), on: false };
  };

  const handlePointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || isBusy || !img || view.w < 1) return;
    const p = pointerToNatural(e);
    if (!drag.on) {
      // 移动超过约 3px 才算拖拽，避免误点清空已选框选
      const thr = (3 * tW) / view.w;
      if (Math.abs(p.x - drag.x) < thr && Math.abs(p.y - drag.y) < thr) return;
      drag.on = true;
    }
    setCrop(buildCropBox(drag.x, drag.y, p.x, p.y, RATIOS[ratio], tW, tH));
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const doCrop = async () => {
    if (isBusy || !img || !file || !crop) return;
    const out = computeOutput(crop, tW, tH, outScale);
    if (out.w < MIN_CROP || out.h < MIN_CROP) {
      warning('裁剪区域过小，请重新框选');
      return;
    }
    setBusy('正在裁剪…');
    try {
      // 中间画布：先把旋转/翻转后的完整图片按导出倍率画出
      const full = document.createElement('canvas');
      full.width = Math.max(1, Math.round(tW * outScale));
      full.height = Math.max(1, Math.round(tH * outScale));
      const fctx = full.getContext('2d');
      if (!fctx) throw new Error('无法创建画布');
      paintTransformed(fctx, img, full.width, full.height, angle, flipH, flipV);

      // 输出画布：从中间画布截取裁剪区域
      const canvas = document.createElement('canvas');
      canvas.width = out.outW;
      canvas.height = out.outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('无法创建画布');
      if (format === 'image/jpeg') {
        // JPG 不支持透明，用白色打底
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, out.outW, out.outH);
      }
      ctx.drawImage(
        full,
        out.x0 * outScale,
        out.y0 * outScale,
        out.w * outScale,
        out.h * outScale,
        0,
        0,
        out.outW,
        out.outH
      );
      const blob = await canvasToBlob(canvas, format, quality / 100);
      const url = URL.createObjectURL(blob);
      setResult({ url, blob, size: blob.size, w: out.outW, h: out.outH });
      success(`裁剪完成，已生成 ${out.outW}×${out.outH} 的${FORMAT_LABEL[format]}图片`);
    } catch {
      toastError('图片处理失败，请重试');
    } finally {
      setBusy('');
    }
  };

  const download = () => {
    if (!result || isBusy) return;
    const base = file?.name.replace(/\.[^.]+$/, '') || 'image';
    downloadBlob(result.blob, `${base}_cropped.${FORMAT_EXT[format]}`);
  };

  // 裁剪信息（预览用，与导出口径一致）
  const cropInfo = crop && img && tW > 0 ? computeOutput(crop, tW, tH, outScale) : null;
  const hasCrop =
    !!cropInfo && cropInfo.w >= MIN_CROP && cropInfo.h >= MIN_CROP;

  // 覆盖层坐标换算（裁剪框单位为变换后原图像素 → 视图像素）
  const kx = view.w > 0 ? tW / view.w : 1;
  const ky = view.h > 0 ? tH / view.h : 1;
  const rawBox = crop
    ? {
        x: crop.x / kx,
        y: crop.y / ky,
        width: crop.width / kx,
        height: crop.height / ky,
      }
    : null;
  const box =
    img && rawBox && view.w > 0
      ? {
          x: clamp(rawBox.x, 0, view.w),
          y: clamp(rawBox.y, 0, view.h),
          width: clamp(rawBox.width, 0, view.w - clamp(rawBox.x, 0, view.w)),
          height: clamp(rawBox.height, 0, view.h - clamp(rawBox.y, 0, view.h)),
        }
      : null;
  const showBox = !!box && box.width >= 0.5 && box.height >= 0.5;

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：上传、编辑与参数 */}
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
              accept="image/*"
              className="hidden"
              onChange={onInputChange}
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
                    ? 'opacity-50 pointer-events-none border-gray-200 dark:border-gray-700'
                    : 'cursor-pointer ' +
                      (dragOver
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                        : 'border-gray-300 dark:border-gray-700 hover:border-brand-400')
                }`}
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="text-sm font-medium">
                  拖拽图片至此 或 点击选择
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  支持 JPG / PNG / WebP / GIF 等 · 单文件 ≤ 20MB
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-1 min-w-0 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                  <span className="text-xl shrink-0">🖼️</span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      {file?.name}
                    </p>
                    <p className="text-xs text-gray-400">
                      {nat.w} × {nat.h} px · {formatBytes(file?.size ?? 0)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={reselect}
                  disabled={isBusy}
                  className="btn-ghost text-xs disabled:opacity-50"
                >
                  🔄 重新选择
                </button>
              </div>
            )}
          </div>

          {/* ② 编辑区 */}
          {img && nat.w > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ② 裁剪调整
              </label>
              <div
                ref={boxRef}
                className="w-full rounded-xl overflow-hidden bg-grid bg-gray-100 dark:bg-gray-800/70"
              >
                <div
                  className="relative mx-auto"
                  style={{ width: view.w, height: view.h }}
                >
                  <canvas
                    ref={canvasRef}
                    width={view.w}
                    height={view.h}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    className="block select-none"
                    style={{ cursor: 'crosshair', touchAction: 'none' }}
                  />
                  {showBox && box && (
                    <>
                      {/* 裁剪框 */}
                      <div
                        className="absolute border-2 border-brand-500 rounded-sm pointer-events-none"
                        style={{
                          left: box.x,
                          top: box.y,
                          width: box.width,
                          height: box.height,
                        }}
                      >
                        {/* 三分网格线 */}
                        <div
                          className="absolute inset-y-0 w-px bg-white/60 pointer-events-none"
                          style={{ left: '33.3333%' }}
                        />
                        <div
                          className="absolute inset-y-0 w-px bg-white/60 pointer-events-none"
                          style={{ left: '66.6666%' }}
                        />
                        <div
                          className="absolute inset-x-0 h-px bg-white/60 pointer-events-none"
                          style={{ top: '33.3333%' }}
                        />
                        <div
                          className="absolute inset-x-0 h-px bg-white/60 pointer-events-none"
                          style={{ top: '66.6666%' }}
                        />
                      </div>
                      {/* 框外遮罩 */}
                      <div
                        className="absolute bg-black/40 pointer-events-none"
                        style={{ left: 0, top: 0, width: '100%', height: box.y }}
                      />
                      <div
                        className="absolute bg-black/40 pointer-events-none"
                        style={{
                          left: 0,
                          top: box.y + box.height,
                          width: '100%',
                          bottom: 0,
                        }}
                      />
                      <div
                        className="absolute bg-black/40 pointer-events-none"
                        style={{
                          left: 0,
                          top: box.y,
                          width: box.x,
                          height: box.height,
                        }}
                      />
                      <div
                        className="absolute bg-black/40 pointer-events-none"
                        style={{
                          left: box.x + box.width,
                          top: box.y,
                          right: 0,
                          height: box.height,
                        }}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* 尺寸 / 缩放信息 */}
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-gray-500">
                <span>
                  原图 {nat.w} × {nat.h} px
                </span>
                {view.w > 0 && tW > 0 && (
                  <span>
                    显示缩放{' '}
                    {Math.max(1, Math.round((view.w / tW) * 100))}%
                  </span>
                )}
              </div>
              {cropInfo && hasCrop && (
                <p className="text-xs text-gray-500 mt-1">
                  裁剪区域 {cropInfo.w} × {cropInfo.h} px
                  <span className="mx-1 text-gray-300 dark:text-gray-600">→</span>
                  输出 {cropInfo.outW} × {cropInfo.outH} px
                  {outScale < 1 && (
                    <span className="text-amber-600">
                      {' '}
                      （原图过大，已按上限等比缩放）
                    </span>
                  )}
                </p>
              )}
              <p className="text-[11px] text-gray-400 mt-1">
                在图片上拖拽可重新框选裁剪区域
              </p>
            </div>
          )}

          {/* ③ 参数 */}
          {img && nat.w > 0 && (
            <div className="space-y-4">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ③ 调整参数
              </label>

              {/* 裁剪比例 */}
              <div>
                <span className="text-sm block mb-1.5">裁剪比例</span>
                <div className="grid grid-cols-5 gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {RATIO_ORDER.map((r) => (
                    <button
                      key={r}
                      disabled={isBusy}
                      onClick={() => handleRatioChange(r)}
                      className={`py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50 ${
                        ratio === r
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                    >
                      {RATIO_LABEL[r]}
                    </button>
                  ))}
                </div>
              </div>

              {/* 旋转 / 翻转 */}
              <div>
                <span className="text-sm block mb-1.5">旋转与翻转</span>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <button
                    disabled={isBusy}
                    onClick={() => rotateImage(-1)}
                    className="px-2 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                  >
                    ⟲ 左旋 90°
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => rotateImage(1)}
                    className="px-2 py-1.5 rounded-lg text-xs font-medium border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
                  >
                    ⟳ 右旋 90°
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => flipImage('h')}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                      flipH
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-600'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    ⇋ 水平翻转
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => flipImage('v')}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                      flipV
                        ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20 text-brand-600'
                        : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                  >
                    ⇵ 垂直翻转
                  </button>
                </div>
              </div>

              {/* 输出格式 */}
              <div>
                <span className="text-sm block mb-1.5">输出格式</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  {FORMATS.map((f) => (
                    <button
                      key={f}
                      disabled={isBusy}
                      onClick={() => handleFormatChange(f)}
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
                {!showQuality && (
                  <p className="text-xs text-gray-400 mt-1.5">
                    PNG 为无损格式，不应用质量参数。
                  </p>
                )}
              </div>

              {/* 质量（仅 JPG / WebP） */}
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
                    min="10"
                    max="100"
                    value={quality}
                    disabled={isBusy}
                    onChange={(e) => {
                      setQuality(Number(e.target.value));
                      discardResult();
                    }}
                    className="w-full accent-brand-600 disabled:opacity-50"
                  />
                </div>
              )}
            </div>
          )}

          {/* 操作按钮 */}
          {img && nat.w > 0 && (
            <div className="flex gap-2 pt-1">
              <button
                onClick={doCrop}
                disabled={isBusy || !hasCrop}
                className="btn-primary flex-1 disabled:opacity-60"
              >
                {busy === '正在裁剪…' ? (
                  <>
                    <ButtonSpinner />
                    正在裁剪…
                  </>
                ) : (
                  <>✂️ 裁剪</>
                )}
              </button>
              <button
                onClick={handleReset}
                disabled={isBusy}
                className="btn-ghost disabled:opacity-60"
              >
                重置
              </button>
            </div>
          )}
        </div>

        {/* 右侧：预览与结果 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ④ 预览结果
          </label>
          {!result ? (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm px-6 text-center">
              {img
                ? '调整裁剪框与参数后，点击「裁剪」生成结果'
                : '上传图片后即可进行裁剪'}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="card p-3">
                <img
                  src={result.url}
                  alt="裁剪结果"
                  className="w-full rounded-lg max-h-60 object-contain bg-gray-50 dark:bg-gray-800"
                />
                <div className="flex justify-between items-center text-xs text-gray-500 mt-2">
                  <span>
                    {result.w} × {result.h} px · {formatBytes(result.size)}
                  </span>
                  <span className="tag bg-brand-50 text-brand-600 dark:bg-brand-900/30 dark:text-brand-400">
                    {FORMAT_LABEL[format]}
                  </span>
                </div>
              </div>
              <button
                onClick={download}
                disabled={isBusy}
                className="btn-primary w-full disabled:opacity-60"
              >
                ⬇️ 下载 {FORMAT_LABEL[format]}
              </button>
            </div>
          )}
        </div>
      </div>
    </ToolLayout>
  );
}
