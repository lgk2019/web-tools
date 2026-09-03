import { useState, useRef, useEffect, useCallback } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, downloadBlob } from '../../utils/image';

const tool = tools.find((t) => t.id === 'watermark-remover')!;

// 去水印模式
type Mode = 'rect' | 'brush';
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
interface Stroke {
  points: { x: number; y: number }[];
  r: number;
}

// 工作画布尺寸信息
interface ImageInfo {
  w: number; // 画布内部宽度（可能缩放）
  h: number; // 画布内部高度
  natW: number; // 原图宽度
  natH: number; // 原图高度
  s: number; // 画布缩放比例 = w / natW（<=1）
}

// 画布最大边长，避免超大图卡顿
const MAX_CANVAS = 2000;

export default function WatermarkRemover() {
  const [mode, setMode] = useState<Mode>('rect');
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState('');
  const [imageEl, setImageEl] = useState<HTMLImageElement | null>(null);
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);

  // 通用参数
  const [method, setMethod] = useState<Method>('telea');
  const [radius, setRadius] = useState(3);

  // 矩形选区状态
  const [regions, setRegions] = useState<Region[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [start, setStart] = useState({ x: 0, y: 0 });
  const [curRect, setCurRect] = useState<Region | null>(null);

  // 笔刷涂抹状态
  const [brushSize, setBrushSize] = useState(20);
  const [strokeCount, setStrokeCount] = useState(0);
  const strokesRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);

  // 结果状态
  const [processing, setProcessing] = useState(false);
  const [resultUrl, setResultUrl] = useState('');
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [error, setError] = useState('');

  // 画布引用
  const rectCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushBaseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 上传图片
  const onSelect = useCallback(
    async (f: File) => {
      if (!f.type.startsWith('image/')) return;
      // 清理旧资源
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      if (resultUrl) {
        URL.revokeObjectURL(resultUrl);
        setResultUrl('');
      }
      setResultBlob(null);
      setError('');
      setRegions([]);
      setCurRect(null);
      strokesRef.current = [];
      currentRef.current = null;
      setStrokeCount(0);
      setFile(f);
      const url = URL.createObjectURL(f);
      setImgUrl(url);
      try {
        const img = await loadImage(f);
        const m = Math.max(img.naturalWidth, img.naturalHeight);
        const s = m > MAX_CANVAS ? MAX_CANVAS / m : 1;
        setImageEl(img);
        setImageInfo({
          w: Math.round(img.naturalWidth * s),
          h: Math.round(img.naturalHeight * s),
          natW: img.naturalWidth,
          natH: img.naturalHeight,
          s,
        });
      } catch {
        setError('图片加载失败');
      }
    },
    [imgUrl, resultUrl]
  );

  // 将鼠标坐标转换为原图像素坐标
  const getNatPos = (e: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    if (!imageInfo || rect.width === 0) return { x: 0, y: 0 };
    const dispToNatX = imageInfo.natW / rect.width;
    const dispToNatY = imageInfo.natH / rect.height;
    return {
      x: (e.clientX - rect.left) * dispToNatX,
      y: (e.clientY - rect.top) * dispToNatY,
    };
  };

  // ===== 矩形选区绘制 =====
  const drawRect = useCallback(() => {
    const canvas = rectCanvasRef.current;
    if (!canvas || !imageEl || !imageInfo) return;
    canvas.width = imageInfo.w;
    canvas.height = imageInfo.h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imageEl, 0, 0, canvas.width, canvas.height);
    const s = imageInfo.s;
    const lineW = Math.max(1, canvas.width / 400);
    ctx.lineWidth = lineW;
    ctx.fillStyle = 'rgba(220,38,38,0.28)';
    ctx.strokeStyle = '#dc2626';
    const drawOne = (r: Region) => {
      ctx.fillRect(r.x * s, r.y * s, r.width * s, r.height * s);
      ctx.strokeRect(r.x * s, r.y * s, r.width * s, r.height * s);
    };
    regions.forEach(drawOne);
    if (curRect) drawOne(curRect);
  }, [imageEl, imageInfo, regions, curRect]);

  useEffect(() => {
    if (mode === 'rect') drawRect();
  }, [mode, drawRect]);

  const onRectDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = rectCanvasRef.current;
    if (!canvas || !imageInfo) return;
    canvas.setPointerCapture(e.pointerId);
    const p = getNatPos(e, canvas);
    setDrawing(true);
    setStart(p);
    setCurRect({ x: p.x, y: p.y, width: 0, height: 0 });
  };

  const onRectMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !rectCanvasRef.current) return;
    const p = getNatPos(e, rectCanvasRef.current);
    setCurRect({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    });
  };

  const onRectUp = () => {
    if (!drawing) return;
    setDrawing(false);
    if (curRect && curRect.width > 3 && curRect.height > 3) {
      setRegions((prev) => [...prev, { ...curRect }]);
    }
    setCurRect(null);
  };

  // ===== 笔刷涂抹绘制 =====
  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    if (!canvas || !imageInfo) return;
    canvas.width = imageInfo.w;
    canvas.height = imageInfo.h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const s = imageInfo.s;
    const all = currentRef.current
      ? [...strokesRef.current, currentRef.current]
      : strokesRef.current;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    all.forEach((stroke) => {
      const pts = stroke.points;
      if (pts.length === 0) return;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x * s, pts[0].y * s, stroke.r * s, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.lineWidth = stroke.r * s * 2;
      ctx.beginPath();
      pts.forEach((p, i) =>
        i === 0 ? ctx.moveTo(p.x * s, p.y * s) : ctx.lineTo(p.x * s, p.y * s)
      );
      ctx.stroke();
    });
  }, [imageInfo]);

  // 笔刷底层图片
  useEffect(() => {
    if (mode !== 'brush') return;
    const c = brushBaseRef.current;
    if (!c || !imageEl || !imageInfo) return;
    c.width = imageInfo.w;
    c.height = imageInfo.h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(imageEl, 0, 0, c.width, c.height);
    drawOverlay();
  }, [mode, imageEl, imageInfo, drawOverlay]);

  useEffect(() => {
    if (mode === 'brush') drawOverlay();
  }, [mode, strokeCount, brushSize, drawOverlay]);

  const onBrushDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = overlayRef.current;
    if (!canvas || !imageInfo) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const r_nat = brushSize * (imageInfo.natW / rect.width);
    const pos = getNatPos(e, canvas);
    currentRef.current = { points: [pos], r: r_nat };
    setDrawing(true);
    drawOverlay();
  };

  const onBrushMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing || !currentRef.current || !overlayRef.current) return;
    const pos = getNatPos(e, overlayRef.current);
    currentRef.current.points.push(pos);
    drawOverlay();
  };

  const onBrushUp = () => {
    if (!drawing) return;
    setDrawing(false);
    if (currentRef.current && currentRef.current.points.length > 0) {
      strokesRef.current.push(currentRef.current);
      setStrokeCount(strokesRef.current.length);
    }
    currentRef.current = null;
  };

  const undoStroke = () => {
    strokesRef.current.pop();
    setStrokeCount(strokesRef.current.length);
    drawOverlay();
  };

  const clearStrokes = () => {
    strokesRef.current = [];
    currentRef.current = null;
    setStrokeCount(0);
    drawOverlay();
  };

  // 导出黑白掩码图（黑底白涂抹，原始分辨率）
  const exportMask = (): Promise<Blob | null> => {
    return new Promise((resolve, reject) => {
      if (!imageInfo) return resolve(null);
      if (strokesRef.current.length === 0) return resolve(null);
      const c = document.createElement('canvas');
      c.width = imageInfo.natW;
      c.height = imageInfo.natH;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#fff';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokesRef.current.forEach((stroke) => {
        const pts = stroke.points;
        if (pts.length === 0) return;
        if (pts.length === 1) {
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, stroke.r, 0, Math.PI * 2);
          ctx.fill();
          return;
        }
        ctx.lineWidth = stroke.r * 2;
        ctx.beginPath();
        pts.forEach((p, i) =>
          i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
        );
        ctx.stroke();
      });
      c.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('生成掩码失败'))),
        'image/png'
      );
    });
  };

  // 调用后端去除水印
  const removeWatermark = async () => {
    if (!file) return;
    if (mode === 'rect' && regions.length === 0) {
      setError('请先框选水印区域');
      return;
    }
    setProcessing(true);
    setError('');
    if (resultUrl) {
      URL.revokeObjectURL(resultUrl);
      setResultUrl('');
    }
    setResultBlob(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (mode === 'rect') {
        fd.append('regions', JSON.stringify(regions));
      } else {
        const maskBlob = await exportMask();
        if (!maskBlob) {
          setError('请先涂抹水印区域');
          setProcessing(false);
          return;
        }
        fd.append('mask', maskBlob, 'mask.png');
      }
      fd.append('method', method);
      fd.append('radius', String(radius));

      const res = await fetch('/api/v1/image/remove-watermark', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        let msg = '处理失败';
        try {
          const err = await res.json();
          msg = err.detail || msg;
        } catch {
          /* 忽略非 JSON 错误 */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setResultBlob(blob);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProcessing(false);
    }
  };

  const download = () => {
    if (!resultBlob) return;
    const name = file?.name.replace(/\.[^.]+$/, '') ?? 'image';
    downloadBlob(resultBlob, `${name}_no_watermark.png`);
  };

  const reset = () => {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(null);
    setImgUrl('');
    setImageEl(null);
    setImageInfo(null);
    setRegions([]);
    setCurRect(null);
    strokesRef.current = [];
    currentRef.current = null;
    setStrokeCount(0);
    setResultUrl('');
    setResultBlob(null);
    setError('');
  };

  // 组件卸载时清理 ObjectURL
  useEffect(() => {
    return () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [imgUrl, resultUrl]);

  const canProcess =
    !!file && !processing && (mode === 'rect' ? regions.length > 0 : strokeCount > 0);

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：上传与编辑 */}
        <div className="space-y-4">
          {/* 上传区 */}
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
              ① 上传图片
            </label>
            {!imgUrl ? (
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const f = e.dataTransfer.files[0];
                  if (f) onSelect(f);
                }}
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-brand-400 transition-colors"
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="text-sm font-medium">拖拽或点击上传图片</p>
                <p className="text-xs text-gray-400 mt-1">支持 JPG / PNG / WebP</p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onSelect(e.target.files[0])}
                />
              </div>
            ) : (
              <>
                {/* 模式切换 */}
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 mb-3">
                  <button
                    onClick={() => setMode('rect')}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      mode === 'rect'
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500'
                    }`}
                  >
                    ▭ 矩形选区
                  </button>
                  <button
                    onClick={() => setMode('brush')}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      mode === 'brush'
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500'
                    }`}
                  >
                    ✎ 笔刷涂抹
                  </button>
                </div>

                {/* 画布区 */}
                <div className="rounded-lg bg-gray-50 dark:bg-gray-800 p-2 flex items-center justify-center overflow-auto">
                  {mode === 'rect' ? (
                    <div className="relative inline-block select-none">
                      <canvas
                        ref={rectCanvasRef}
                        className="block max-w-full max-h-[380px] w-auto h-auto rounded-lg"
                        style={{ cursor: 'crosshair', touchAction: 'none' }}
                        onPointerDown={onRectDown}
                        onPointerMove={onRectMove}
                        onPointerUp={onRectUp}
                        onPointerCancel={onRectUp}
                        onPointerLeave={onRectUp}
                      />
                    </div>
                  ) : (
                    <div className="relative inline-block select-none">
                      <canvas
                        ref={brushBaseRef}
                        className="block max-w-full max-h-[380px] w-auto h-auto rounded-lg"
                      />
                      <canvas
                        ref={overlayRef}
                        className="absolute top-0 left-0 max-w-full max-h-[380px] w-auto h-auto rounded-lg"
                        style={{ cursor: 'crosshair', touchAction: 'none' }}
                        onPointerDown={onBrushDown}
                        onPointerMove={onBrushMove}
                        onPointerUp={onBrushUp}
                        onPointerCancel={onBrushUp}
                        onPointerLeave={onBrushUp}
                      />
                    </div>
                  )}
                </div>

                {/* 矩形选区列表 */}
                {mode === 'rect' && (
                  <div className="mt-3">
                    {regions.length > 0 ? (
                      <>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs text-gray-500">
                            已选区域（{regions.length}）
                          </span>
                          <button
                            onClick={() => setRegions([])}
                            className="text-xs text-gray-400 hover:text-red-500"
                          >
                            清空
                          </button>
                        </div>
                        <div className="space-y-1 max-h-32 overflow-y-auto">
                          {regions.map((r, i) => (
                            <div
                              key={i}
                              className="flex items-center justify-between rounded bg-gray-50 dark:bg-gray-800 px-2 py-1 text-xs"
                            >
                              <span className="font-mono text-gray-500">
                                区域{i + 1}: {Math.round(r.width)}×{Math.round(r.height)} px
                              </span>
                              <button
                                onClick={() =>
                                  setRegions((prev) => prev.filter((_, idx) => idx !== i))
                                }
                                className="text-gray-400 hover:text-red-500"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-gray-400">在图片上拖拽框选水印区域，可叠加多个</p>
                    )}
                  </div>
                )}

                {/* 笔刷控件 */}
                {mode === 'brush' && (
                  <div className="mt-3 space-y-2">
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-xs text-gray-500">笔刷大小</span>
                        <span className="text-xs font-mono text-brand-600">{brushSize}px</span>
                      </div>
                      <input
                        type="range"
                        min="5"
                        max="50"
                        value={brushSize}
                        onChange={(e) => setBrushSize(Number(e.target.value))}
                        className="w-full accent-brand-600"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={undoStroke}
                        disabled={strokeCount === 0}
                        className="btn-ghost flex-1 text-xs disabled:opacity-40"
                      >
                        ↶ 撤销（{strokeCount}）
                      </button>
                      <button
                        onClick={clearStrokes}
                        disabled={strokeCount === 0}
                        className="btn-ghost flex-1 text-xs disabled:opacity-40"
                      >
                        清除涂抹
                      </button>
                    </div>
                    <p className="text-xs text-gray-400">
                      在图片上按住鼠标涂抹水印区域（白色覆盖）
                    </p>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 通用参数 */}
          {imgUrl && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-gray-500 uppercase">
                ② 去水印参数
              </label>
              <div>
                <span className="text-sm block mb-1.5">修复算法</span>
                <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                  <button
                    onClick={() => setMethod('telea')}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      method === 'telea'
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500'
                    }`}
                  >
                    Telea（快速）
                  </button>
                  <button
                    onClick={() => setMethod('ns')}
                    className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      method === 'ns'
                        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                        : 'text-gray-500'
                    }`}
                  >
                    NS（细节更好）
                  </button>
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
                  onChange={(e) => setRadius(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          {imgUrl && (
            <div className="flex gap-2">
              <button
                onClick={removeWatermark}
                disabled={!canProcess}
                className="btn-primary flex-1 disabled:opacity-40"
              >
                {processing ? '⏳ 处理中…' : '🪄 去除水印'}
              </button>
              <button onClick={reset} className="btn-ghost">
                重置
              </button>
            </div>
          )}
        </div>

        {/* 右侧：结果展示 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ③ 处理结果
          </label>

          {/* 错误提示 */}
          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm px-3 py-2">
              ⚠️ {error}
            </div>
          )}

          {/* 加载中 */}
          {processing && (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex flex-col items-center justify-center text-gray-400">
              <div className="w-8 h-8 border-2 border-brand-600 border-t-transparent rounded-full animate-spin mb-2" />
              <p className="text-sm">正在去除水印…</p>
            </div>
          )}

          {/* 结果对比 */}
          {!processing && resultUrl ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-gray-400 mb-1 text-center">原图</p>
                  <img
                    src={imgUrl}
                    alt="原图"
                    className="w-full rounded-lg max-h-60 object-contain bg-gray-50 dark:bg-gray-800"
                  />
                </div>
                <div>
                  <p className="text-xs text-brand-600 mb-1 text-center">结果</p>
                  <img
                    src={resultUrl}
                    alt="去水印结果"
                    className="w-full rounded-lg max-h-60 object-contain bg-gray-50 dark:bg-gray-800"
                  />
                </div>
              </div>
              <button onClick={download} className="btn-primary w-full">
                ⬇️ 下载 PNG
              </button>
            </div>
          ) : (
            !processing &&
            !error && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                {file ? '框选或涂抹水印区域后点击「去除水印」' : '上传图片后将显示处理结果'}
              </div>
            )
          )}

          {/* 效果提示 */}
          <p className="text-xs text-gray-400 leading-relaxed">
            💡 复杂背景下去除效果有限，建议涂抹完整覆盖水印区域；NS 算法对细节恢复更好但速度较慢。
          </p>
        </div>
      </div>
    </ToolLayout>
  );
}
