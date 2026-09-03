import { useState, useRef, useEffect, useCallback } from 'react';
import jsQR, { type QRCode } from 'jsqr';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage } from '../../utils/image';
import { useToast } from '../../components/Toast';
import { Spinner } from '../../components/Loading';

const tool = tools.find((t) => t.id === 'qr-reader')!;

type Tab = 'image' | 'camera';
type Source = 'image' | 'camera';

// 识别历史（跨图片来源去重合并）
interface ScanRecord {
  id: number;
  source: Source;
  text: string;
  time: string;
}

let scanSeq = 0;

// 图片解码画布最大边长：过大反而拖慢 jsQR，过小丢失细节
const MAX_IMAGE_EDGE = 1000;
// 摄像头取帧最大边长（逐帧识别，需控制开销）
const MAX_CAMERA_EDGE = 640;

const SOURCE_LABEL: Record<Source, string> = {
  image: '图片',
  camera: '摄像头',
};

function formatTime(d: Date): string {
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

// ---------------------------------------------------------------------------
// EXIF Orientation 解析（仅 JPEG 需要）。读取文件头部 64KB 即可覆盖 APP1 段。
// ---------------------------------------------------------------------------

function readTiffOrientation(view: DataView, start: number): number {
  if (start + 8 > view.byteLength) return 1;
  const order = view.getUint16(start, false);
  const little = order === 0x4949; // 'II'
  if (order !== 0x4949 && order !== 0x4d4d) return 1; // 'MM'
  if (view.getUint16(start + 2, little) !== 0x002a) return 1;
  const ifd0 = view.getUint32(start + 4, little);
  if (ifd0 < 8 || start + ifd0 + 2 > view.byteLength) return 1;
  const count = view.getUint16(start + ifd0, little);
  for (let i = 0; i < count; i++) {
    const entry = start + ifd0 + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    // Tag 0x0112 = Orientation，类型 SHORT，单值直接存在 value 字段
    if (view.getUint16(entry, little) === 0x0112) {
      const v = view.getUint16(entry + 8, little);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function readExifOrientation(view: DataView): number {
  const len = view.byteLength;
  if (len < 4 || view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= len) {
    if (view.getUint8(offset) !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = view.getUint8(offset + 1);
    // 无长度段的标记（填充 / SOI / RSTn）
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const dataStart = offset + 2;
    if (dataStart + 2 > len) break;
    const segLen = view.getUint16(dataStart, false);
    if (segLen < 2 || dataStart + segLen > len) break;
    // APP1：需要 'Exif\0\0' 前缀才按 TIFF 解析
    if (marker === 0xe1 && segLen >= 10) {
      const tiff = dataStart + 2;
      const isExif =
        view.getUint8(tiff) === 0x45 && // E
        view.getUint8(tiff + 1) === 0x78 && // x
        view.getUint8(tiff + 2) === 0x69 && // i
        view.getUint8(tiff + 3) === 0x66 && // f
        view.getUint8(tiff + 4) === 0x00 &&
        view.getUint8(tiff + 5) === 0x00;
      if (isExif) {
        const o = readTiffOrientation(view, tiff + 6);
        if (o !== 1) return o;
      }
    }
    offset = dataStart + segLen;
  }
  return 1;
}

function readJpegOrientation(file: File): Promise<number> {
  return new Promise((resolve) => {
    if (file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name)) {
      resolve(1);
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      resolve(readExifOrientation(new DataView(reader.result as ArrayBuffer)));
    reader.onerror = () => resolve(1);
    // 只读前 64KB，避免为大图加载完整文件
    reader.readAsArrayBuffer(file.slice(0, 64 * 1024));
  });
}

// ---------------------------------------------------------------------------
// 图片解码：优先以「不应用 EXIF」的原始像素解码（createImageBitmap），
// 再手动按 Orientation 摆正；不支持时回退 <img>（现代浏览器会自动摆正）。
// ---------------------------------------------------------------------------

interface DecodedFile {
  source: CanvasImageSource;
  width: number;
  height: number;
  orientation: number;
  close?: () => void;
}

async function decodeImageFile(file: File): Promise<DecodedFile> {
  const orientation = await readJpegOrientation(file);
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'none' });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      orientation,
      close: () => bitmap.close(),
    };
  } catch {
    // 不支持原始像素解码：交给 <img>（浏览器已按 EXIF 摆正），不再手动旋转
    const img = await loadImage(file);
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      orientation: 1,
    };
  }
}

// 将（可能带 EXIF 方向的）图片画到目标画布并等比限制边长，返回画布 2d 上下文
function renderImageToCanvas(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  width: number,
  height: number,
  orientation: number,
  maxEdge: number
): CanvasRenderingContext2D {
  const rotated = orientation >= 5 && orientation <= 8;
  const targetW = rotated ? height : width;
  const targetH = rotated ? width : height;
  const scale = Math.min(1, maxEdge / Math.max(targetW, targetH));
  canvas.width = Math.max(1, Math.round(targetW * scale));
  canvas.height = Math.max(1, Math.round(targetH * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.save();
  ctx.scale(scale, scale);
  // 将存储像素映射到“摆正后”的画布坐标（1 为恒等，无需处理）
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, width, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, width, height);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, height);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, height, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, height, width);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, width);
      break;
  }
  ctx.drawImage(source, 0, 0, width, height);
  ctx.restore();
  return ctx;
}

// 剪贴板写入：优先 Clipboard API，失败回退 execCommand
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 降级到 execCommand
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function QRReader() {
  const [tab, setTab] = useState<Tab>('image');

  // 图片识别相关状态
  const [dragging, setDragging] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageResult, setImageResult] = useState<QRCode | null>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const decodingRef = useRef(false);

  // 摄像头相关状态
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraStarting, setCameraStarting] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraResult, setCameraResult] = useState<QRCode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  // 跨图片/摄像头的识别历史（按内容去重）
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const { success, error: toastError } = useToast();

  const flashCopied = (id: number) => {
    setCopiedId(id);
    if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopiedId(null), 1800);
  };

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // 记录识别结果（重复内容合并，不再重复入列）
  const pushRecord = useCallback((text: string, source: Source) => {
    setRecords((prev) => {
      if (prev.some((r) => r.text === text)) return prev;
      return [
        { id: ++scanSeq, source, text, time: formatTime(new Date()) },
        ...prev,
      ];
    });
  }, []);

  // 复制并给出按钮反馈；失败时 Toast 提示用户手动复制
  const copyText = useCallback(
    async (text: string, id: number) => {
      const ok = await writeClipboardText(text);
      if (ok) {
        flashCopied(id);
        success('已复制到剪贴板');
      } else {
        toastError('自动复制失败，请手动选择文本复制');
      }
    },
    [success, toastError]
  );

  // 在 canvas 上绘制识别到的二维码绿色边框
  const drawBorder = (
    ctx: CanvasRenderingContext2D,
    location: QRCode['location']
  ) => {
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(location.topLeftCorner.x, location.topLeftCorner.y);
    ctx.lineTo(location.topRightCorner.x, location.topRightCorner.y);
    ctx.lineTo(location.bottomRightCorner.x, location.bottomRightCorner.y);
    ctx.lineTo(location.bottomLeftCorner.x, location.bottomLeftCorner.y);
    ctx.closePath();
    ctx.stroke();
  };

  // 处理上传图片识别
  const handleImageFile = useCallback(
    async (file: File) => {
      if (decodingRef.current) return; // 防止上一次识别未结束时重复触发
      if (!file.type.startsWith('image/')) {
        setImageError('请选择图片文件（JPG/PNG/BMP 等）');
        setImageResult(null);
        return;
      }
      setImageError('');
      setImageResult(null);
      setImageLoading(true);
      decodingRef.current = true;
      try {
        const decoded = await decodeImageFile(file);
        const canvas = imageCanvasRef.current;
        if (!canvas) {
          decoded.close?.();
          return;
        }
        const ctx = renderImageToCanvas(
          canvas,
          decoded.source,
          decoded.width,
          decoded.height,
          decoded.orientation,
          MAX_IMAGE_EDGE
        );
        // createImageBitmap 解码的位图用完即释放，避免大图内存占用
        decoded.close?.();
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'attemptBoth',
        });

        if (code) {
          setImageResult(code);
          pushRecord(code.data, 'image');
          drawBorder(ctx, code.location);
        } else {
          setImageError('未检测到二维码，请确认图片包含清晰的二维码');
        }
      } catch {
        setImageError('图片解析失败，请换一张图片重试（不支持的文件可能已损坏）');
      } finally {
        decodingRef.current = false;
        setImageLoading(false);
      }
    },
    [pushRecord]
  );

  // 停止摄像头并释放资源
  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setCameraStarting(false);
  }, []);

  // 摄像头扫描循环：从 video 取帧并识别（缩小画布以控制逐帧开销）
  const scanLoop = useCallback(
    function scanLoop() {
      const video = videoRef.current;
      const canvas = scanCanvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw === 0 || vh === 0) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      const scale = Math.min(1, MAX_CAMERA_EDGE / Math.max(vw, vh));
      const cw = Math.max(1, Math.round(vw * scale));
      const ch = Math.max(1, Math.round(vh * scale));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.drawImage(video, 0, 0, cw, ch);
      const imageData = ctx.getImageData(0, 0, cw, ch);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'dontInvert',
      });
      if (code) {
        setCameraResult(code);
        pushRecord(code.data, 'camera');
        stopCamera();
        success('扫码成功');
        return;
      }
      rafRef.current = requestAnimationFrame(scanLoop);
    },
    [stopCamera, pushRecord, success]
  );

  // 启动摄像头
  const startCamera = useCallback(async () => {
    setCameraError('');
    setCameraResult(null);
    if (cameraStarting) return;
    setCameraStarting(true);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('当前浏览器不支持摄像头 API，请使用 HTTPS 或 localhost 访问');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        return;
      }
      video.srcObject = stream;
      await video.play();
      setCameraActive(true);
      rafRef.current = requestAnimationFrame(scanLoop);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') {
        setCameraError('摄像头权限被拒绝：请在浏览器地址栏/设置中允许访问摄像头后重试');
      } else if (name === 'NotFoundError') {
        setCameraError('未检测到摄像头设备，请连接摄像头后重试');
      } else if (name === 'NotReadableError') {
        setCameraError('摄像头被其他应用占用，请关闭占用程序后重试');
      } else {
        setCameraError((err as Error)?.message || '摄像头不可用，需 HTTPS 或 localhost 环境');
      }
    } finally {
      setCameraStarting(false);
    }
  }, [cameraStarting, scanLoop]);

  // 组件卸载时释放摄像头
  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  const dismissCameraError = () => setCameraError('');

  const clearHistory = () => {
    if (cameraActive) stopCamera();
    setRecords([]);
    setImageResult(null);
    setCameraResult(null);
    const canvas = imageCanvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  // 渲染单条识别结果详情
  const renderResult = (result: QRCode | null) => {
    if (!result) return null;
    const record = records.find((r) => r.text === result.data);
    const rid = record?.id ?? 0;
    const lineCount = result.data.split('\n').length;
    return (
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 uppercase">
            识别结果
          </span>
          <button
            onClick={() => copyText(result.data, rid)}
            className="text-xs text-brand-600 hover:underline shrink-0"
          >
            {copiedId === rid ? '✓ 已复制' : '📋 复制'}
          </button>
        </div>
        <textarea
          readOnly
          value={result.data}
          rows={Math.min(Math.max(lineCount, 2), 6)}
          className="input resize-none font-mono text-sm"
        />
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <span className="text-gray-500">二维码版本：</span>
            <span className="font-mono">{result.version}</span>
          </div>
          <div>
            <span className="text-gray-500">字节数：</span>
            <span className="font-mono">{result.binaryData.length}</span>
          </div>
          <div className="col-span-2">
            <span className="text-gray-500 block mb-1">四角坐标：</span>
            <div className="font-mono text-[11px] text-gray-400 space-y-0.5">
              <div>
                左上：({Math.round(result.location.topLeftCorner.x)},{' '}
                {Math.round(result.location.topLeftCorner.y)})
              </div>
              <div>
                右上：({Math.round(result.location.topRightCorner.x)},{' '}
                {Math.round(result.location.topRightCorner.y)})
              </div>
              <div>
                右下：({Math.round(result.location.bottomRightCorner.x)},{' '}
                {Math.round(result.location.bottomRightCorner.y)})
              </div>
              <div>
                左下：({Math.round(result.location.bottomLeftCorner.x)},{' '}
                {Math.round(result.location.bottomLeftCorner.y)})
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // 渲染识别历史（去重后）
  const renderHistory = () => {
    if (records.length === 0) return null;
    return (
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 uppercase">
            识别历史（{records.length} 条 · 内容已去重）
          </span>
          <button
            onClick={clearHistory}
            className="text-xs text-gray-400 hover:text-red-500"
          >
            清空
          </button>
        </div>
        <ul className="space-y-2 max-h-56 overflow-y-auto">
          {records.map((r) => (
            <li
              key={r.id}
              className="flex items-start gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 px-3 py-2"
            >
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-gray-400 flex items-center gap-1.5 mb-0.5">
                  <span className="tag bg-brand-50 text-brand-600 dark:bg-brand-900/30 dark:text-brand-300 px-1.5 py-0">
                    {SOURCE_LABEL[r.source]}
                  </span>
                  <span>{r.time}</span>
                </p>
                <p className="text-xs font-mono truncate" title={r.text}>
                  {r.text}
                </p>
              </div>
              <button
                onClick={() => copyText(r.text, r.id)}
                className="text-xs text-brand-600 hover:underline shrink-0"
              >
                {copiedId === r.id ? '✓' : '📋'}
              </button>
            </li>
          ))}
        </ul>
        <p className="text-[11px] text-gray-400">
          提示：若自动复制失败，可手动长按 / 框选文本复制。
        </p>
      </div>
    );
  };

  return (
    <ToolLayout tool={tool}>
      {/* Tab 切换 */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 mb-6 max-w-xs">
        {(
          [
            ['image', '🖼️ 图片识别'],
            ['camera', '📷 摄像头扫码'],
          ] as [Tab, string][]
        ).map(([val, label]) => (
          <button
            key={val}
            onClick={() => {
              // 离开摄像头 Tab 时停止摄像头，避免隐藏视频仍在占用硬件
              if (val === 'image' && cameraActive) stopCamera();
              setTab(val);
            }}
            className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === val
                ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                : 'text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'image' ? (
        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：上传 */}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ① 上传图片
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
                  if (e.dataTransfer.files?.[0])
                    handleImageFile(e.dataTransfer.files[0]);
                }}
                onClick={() => !imageLoading && fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                  dragging
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                    : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
                } ${imageLoading ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="font-medium text-sm">
                  {imageLoading ? '正在读取图片…' : '拖拽图片至此 或 点击选择'}
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  支持 JPG / PNG / BMP / GIF 等，大图将自动缩放后识别
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) handleImageFile(f);
                  }}
                />
              </div>
            </div>

            {imageError && (
              <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">
                ⚠️ {imageError}
              </p>
            )}
            {!imageLoading && !imageError && !imageResult && (
              <p className="text-xs text-gray-400">
                提示：识别结果与历史记录将显示在右侧预览区下方。
              </p>
            )}
          </div>

          {/* 右侧：Canvas 预览 + 结果 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 预览
            </label>
            <div className="card p-3 min-h-[200px] flex items-center justify-center bg-gray-50 dark:bg-gray-800/60 relative overflow-hidden">
              <canvas
                ref={imageCanvasRef}
                className="max-w-full rounded-lg shadow-sm bg-white"
              />
              {!imageLoading && !imageError && !imageResult && (
                <p className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">
                  上传图片后预览将显示于此
                </p>
              )}
              {imageLoading && (
                <p className="absolute inset-0 flex items-center justify-center gap-2 text-gray-400 text-sm pointer-events-none bg-white/50 dark:bg-gray-900/50">
                  <Spinner size={16} className="text-brand-600" />
                  识别中…
                </p>
              )}
            </div>
            <p className="text-xs text-gray-400 text-center">
              识别到二维码时将以绿色边框标注
            </p>
            {renderResult(imageResult)}
            {renderHistory()}
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：摄像头预览 + 控制 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              摄像头预览
            </label>
            <div
              className={`card p-3 min-h-[240px] flex items-center justify-center relative overflow-hidden transition-colors ${
                cameraActive
                  ? 'bg-gray-900 dark:bg-black'
                  : 'bg-gray-50 dark:bg-gray-800'
              }`}
            >
              <video
                ref={videoRef}
                playsInline
                muted
                className="max-w-full max-h-80 rounded-lg"
              />
              {/* 用于提取帧做识别的隐藏 canvas */}
              <canvas ref={scanCanvasRef} className="hidden" />

              {/* 扫描框（仅扫描中显示） */}
              {cameraActive && !cameraResult && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div className="relative w-44 h-44 sm:w-56 sm:h-56">
                    <span className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-brand-400 rounded-tl-lg" />
                    <span className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-brand-400 rounded-tr-lg" />
                    <span className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-brand-400 rounded-bl-lg" />
                    <span className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-brand-400 rounded-br-lg" />
                    <span className="absolute left-2 right-2 top-1/2 h-0.5 -translate-y-1/2 bg-brand-400/70 animate-pulse" />
                  </div>
                </div>
              )}

              {cameraActive && (
                <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/90 px-2.5 py-1 text-xs font-medium text-white">
                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  扫描中
                </span>
              )}

              {!cameraActive && !cameraError && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">
                  点击下方按钮开启摄像头
                </div>
              )}
            </div>

            <div className="flex gap-2">
              {cameraActive ? (
                <button onClick={stopCamera} className="btn-ghost flex-1">
                  ⏹️ 停止扫码
                </button>
              ) : (
                <button
                  onClick={startCamera}
                  disabled={cameraStarting}
                  className="btn-primary flex-1 disabled:opacity-60"
                >
                  {cameraStarting ? (
                    <>
                      <Spinner size={16} />
                      正在开启…
                    </>
                  ) : cameraResult ? (
                    '🔁 再次扫码'
                  ) : (
                    '▶️ 开启摄像头'
                  )}
                </button>
              )}
            </div>

            {cameraError && (
              <div className="flex items-start justify-between gap-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-sm text-red-500">
                <p>⚠️ {cameraError}</p>
                <button
                  onClick={dismissCameraError}
                  className="text-red-400 hover:text-red-600 shrink-0"
                  title="关闭提示"
                >
                  ✕
                </button>
              </div>
            )}
            <p className="text-xs text-gray-400">
              提示：摄像头功能需在 HTTPS 或 localhost 环境下使用；首次使用请在浏览器中允许摄像头权限。
            </p>
          </div>

          {/* 右侧：扫码结果 + 历史 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              扫码结果
            </label>
            {cameraActive && !cameraResult && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                <span className="inline-flex items-center gap-2">
                  <Spinner size={16} className="text-brand-600" />
                  正在扫描，请将二维码对准取景框…
                </span>
              </div>
            )}
            {!cameraActive && !cameraResult && !cameraError && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                {records.length > 0
                  ? '已识别到二维码：可点击「再次扫码」继续扫描'
                  : '开启摄像头后将自动扫描二维码'}
              </div>
            )}
            {cameraResult && renderResult(cameraResult)}
            {renderHistory()}
          </div>
        </div>
      )}
    </ToolLayout>
  );
}
