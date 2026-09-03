import { useState, useRef, useCallback, useEffect } from 'react';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage, cropImage, downloadBlob, formatBytes } from '../../utils/image';

const tool = tools.find((t) => t.id === 'image-crop')!;

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

type AspectRatio = 'free' | '1:1' | '4:3' | '16:9' | '9:16';

const RATIOS: Record<AspectRatio, number | null> = {
  free: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
};

export default function ImageCrop() {
  const [file, setFile] = useState<File | null>(null);
  const [imgUrl, setImgUrl] = useState('');
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const [displaySize, setDisplaySize] = useState({ w: 0, h: 0 });
  const [ratio, setRatio] = useState<AspectRatio>('free');
  const [crop, setCrop] = useState<Crop | null>(null);
  const [resultUrl, setResultUrl] = useState('');
  const [resultSize, setResultSize] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 加载图片
  const onSelect = async (f: File) => {
    setFile(f);
    const url = URL.createObjectURL(f);
    setImgUrl(url);
    setResultUrl('');
    setCrop(null);
    const img = await loadImage(f);
    setImgSize({ w: img.width, h: img.height });
  };

  // 图片加载后获取显示尺寸
  const onImgLoad = () => {
    if (imgRef.current) {
      setDisplaySize({
        w: imgRef.current.clientWidth,
        h: imgRef.current.clientHeight,
      });
    }
  };

  // 计算裁剪框（保持比例）
  const calcCrop = (
    startX: number,
    startY: number,
    endX: number,
    endY: number
  ): Crop => {
    let x = Math.min(startX, endX);
    let y = Math.min(startY, endY);
    let width = Math.abs(endX - startX);
    let height = Math.abs(endY - startY);

    const r = RATIOS[ratio];
    if (r) {
      if (width / height > r) {
        width = height * r;
      } else {
        height = width / r;
      }
    }

    // 限制在图片范围内
    width = Math.min(width, displaySize.w - x);
    height = Math.min(height, displaySize.h - y);
    x = Math.max(0, Math.min(x, displaySize.w - width));
    y = Math.max(0, Math.min(y, displaySize.h - height));

    return { x, y, width, height };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragging(true);
    setDragStart({ x, y });
    setCrop({ x, y, width: 0, height: 0 });
  };

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging || !imgRef.current) return;
      const rect = imgRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setCrop(calcCrop(dragStart.x, dragStart.y, x, y));
    },
    [dragging, dragStart, ratio, displaySize]
  );

  const onMouseUp = () => setDragging(false);

  // 缩放比例：显示尺寸 → 原始尺寸
  const getScale = () => {
    if (imgSize.w === 0 || displaySize.w === 0) return 1;
    return imgSize.w / displaySize.w;
  };

  // 执行裁剪
  const doCrop = async () => {
    if (!file || !crop || crop.width < 5 || crop.height < 5) return;
    const scale = getScale();
    const realCrop = {
      x: crop.x * scale,
      y: crop.y * scale,
      width: crop.width * scale,
      height: crop.height * scale,
    };
    const blob = await cropImage(file, realCrop);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    const url = URL.createObjectURL(blob);
    setResultUrl(url);
    setResultSize(blob.size);
  };

  const download = () => {
    if (!resultUrl) return;
    const a = document.createElement('a');
    a.href = resultUrl;
    const name = file?.name.replace(/\.[^.]+$/, '') ?? 'image';
    a.download = `${name}_cropped.png`;
    a.click();
  };

  const reset = () => {
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(null);
    setImgUrl('');
    setResultUrl('');
    setCrop(null);
  };

  useEffect(() => {
    return () => {
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
  }, [imgUrl, resultUrl]);

  return (
    <ToolLayout tool={tool}>
      <div className="grid md:grid-cols-2 gap-6">
        {/* 左侧：上传与裁剪 */}
        <div className="space-y-4">
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
                  if (f?.type.startsWith('image/')) onSelect(f);
                }}
                onClick={() => document.getElementById('crop-input')?.click()}
                className="border-2 border-dashed border-gray-300 dark:border-gray-700 rounded-xl p-8 text-center cursor-pointer hover:border-brand-400"
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="text-sm font-medium">拖拽或点击上传图片</p>
                <input
                  id="crop-input"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && onSelect(e.target.files[0])}
                />
              </div>
            ) : (
              <div
                ref={containerRef}
                className="relative inline-block select-none"
              >
                <img
                  ref={imgRef}
                  src={imgUrl}
                  alt="待裁剪"
                  onLoad={onImgLoad}
                  className="max-w-full max-h-[320px] rounded-lg block"
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                  style={{ cursor: 'crosshair' }}
                  draggable={false}
                />
                {/* 裁剪框 */}
                {crop && crop.width > 0 && crop.height > 0 && (
                  <div
                    className="absolute border-2 border-brand-500 bg-brand-500/20 pointer-events-none"
                    style={{
                      left: crop.x,
                      top: crop.y,
                      width: crop.width,
                      height: crop.height,
                    }}
                  >
                    {/* 网格线 */}
                    <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <div
                          key={i}
                          className="border-r border-b border-white/30"
                        />
                      ))}
                    </div>
                  </div>
                )}
                {/* 遮罩 */}
                {crop && crop.width > 0 && crop.height > 0 && (
                  <>
                    <div
                      className="absolute bg-black/40 pointer-events-none"
                      style={{ left: 0, top: 0, width: '100%', height: crop.y }}
                    />
                    <div
                      className="absolute bg-black/40 pointer-events-none"
                      style={{
                        left: 0,
                        top: crop.y + crop.height,
                        width: '100%',
                        bottom: 0,
                      }}
                    />
                    <div
                      className="absolute bg-black/40 pointer-events-none"
                      style={{
                        left: 0,
                        top: crop.y,
                        width: crop.x,
                        height: crop.height,
                      }}
                    />
                    <div
                      className="absolute bg-black/40 pointer-events-none"
                      style={{
                        left: crop.x + crop.width,
                        top: crop.y,
                        right: 0,
                        height: crop.height,
                      }}
                    />
                  </>
                )}
              </div>
            )}
          </div>

          {/* 裁剪比例 */}
          {imgUrl && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ② 裁剪比例
              </label>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(RATIOS) as AspectRatio[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => setRatio(r)}
                    className={`tag ${
                      ratio === r
                        ? 'bg-brand-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {r === 'free' ? '自由' : r}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 裁剪信息 */}
          {crop && crop.width > 5 && (
            <div className="text-xs text-gray-500">
              裁剪区域: {Math.round(crop.width * getScale())} ×{' '}
              {Math.round(crop.height * getScale())} px
            </div>
          )}

          {imgUrl && (
            <div className="flex gap-2">
              <button
                onClick={doCrop}
                disabled={!crop || crop.width < 5}
                className="btn-primary flex-1"
              >
                ✂️ 裁剪
              </button>
              <button onClick={reset} className="btn-ghost">
                重置
              </button>
            </div>
          )}
        </div>

        {/* 右侧：预览 */}
        <div className="space-y-4">
          <label className="block text-xs font-medium text-gray-500 uppercase">
            ③ 预览结果
          </label>
          {!resultUrl ? (
            <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
              框选区域并点击裁剪
            </div>
          ) : (
            <div className="space-y-3">
              <div className="card p-3">
                <img
                  src={resultUrl}
                  alt="裁剪结果"
                  className="w-full rounded-lg max-h-60 object-contain bg-gray-50 dark:bg-gray-800"
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>大小: {formatBytes(resultSize)}</span>
              </div>
              <button onClick={download} className="btn-primary w-full">
                ⬇️ 下载 PNG
              </button>
            </div>
          )}
        </div>
      </div>
    </ToolLayout>
  );
}
