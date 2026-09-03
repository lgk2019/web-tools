import { useState, useRef, useEffect, useCallback } from 'react';
import jsQR, { type QRCode } from 'jsqr';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { loadImage } from '../../utils/image';

const tool = tools.find((t) => t.id === 'qr-reader')!;

type Tab = 'image' | 'camera';

export default function QRReader() {
  const [tab, setTab] = useState<Tab>('image');

  // 图片识别相关状态
  const [dragging, setDragging] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageResult, setImageResult] = useState<QRCode | null>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 摄像头相关状态
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraResult, setCameraResult] = useState<QRCode | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 用于从 video 中提取帧做识别的隐藏 canvas
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);

  // 复制状态（仅当前可见 Tab 的结果区使用）
  const [copied, setCopied] = useState(false);

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

  // 复制识别结果到剪贴板
  const copyResult = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略剪贴板异常
    }
  };

  // 处理上传图片识别
  const handleImageFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setImageError('请选择图片文件（JPG/PNG/BMP 等）');
      return;
    }
    setImageError('');
    setImageResult(null);
    setImageLoading(true);

    try {
      const img = await loadImage(file);
      const canvas = imageCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      // 限制最大尺寸以提高识别性能，避免大图卡顿
      const maxSize = 1000;
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);

      const imageData = ctx.getImageData(0, 0, width, height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: 'attemptBoth',
      });

      if (code) {
        setImageResult(code);
        // 在 canvas 上绘制绿色边框
        drawBorder(ctx, code.location);
      } else {
        setImageError('未检测到二维码');
      }
    } catch {
      setImageError('图片解析失败，请重试');
    } finally {
      setImageLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 停止摄像头并释放资源
  const stopCamera = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      // 必须 stop 所有 track，释放摄像头硬件
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
  }, []);

  // 摄像头扫描循环：定时从 video 提取帧并识别
  const scanLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    // 视频未就绪则继续等待下一帧
    if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: 'dontInvert',
    });
    if (code) {
      // 识别成功：绘制边框、显示结果并停止摄像头
      drawBorder(ctx, code.location);
      setCameraResult(code);
      stopCamera();
      return;
    }
    rafRef.current = requestAnimationFrame(scanLoop);
  }, [stopCamera]);

  // 启动摄像头
  // 注意：getUserMedia 仅在 HTTPS 或 localhost 环境下可用，否则会抛错
  const startCamera = useCallback(async () => {
    setCameraError('');
    setCameraResult(null);
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraError('当前浏览器不支持摄像头 API，请使用 HTTPS 或 localhost 访问');
        return;
      }
      // 优先使用后置摄像头
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play();
      setCameraActive(true);
      rafRef.current = requestAnimationFrame(scanLoop);
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError') {
        setCameraError('摄像头权限被拒绝，请在浏览器设置中允许使用摄像头');
      } else if (name === 'NotFoundError') {
        setCameraError('未检测到摄像头设备');
      } else {
        setCameraError(
          (err as Error)?.message || '摄像头不可用，需 HTTPS 或 localhost 环境'
        );
      }
    }
  }, [scanLoop]);

  // 组件卸载时必须清理摄像头流，避免硬件占用
  useEffect(() => {
    return () => stopCamera();
  }, [stopCamera]);

  // 渲染识别结果区
  const renderResult = (result: QRCode | null) => {
    if (!result) return null;
    const lineCount = result.data.split('\n').length;
    return (
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500 uppercase">
            识别结果
          </span>
          <button
            onClick={() => copyResult(result.data)}
            className="text-xs text-brand-600 hover:underline"
          >
            {copied ? '✓ 已复制' : '📋 复制'}
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
            onClick={() => setTab(val)}
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
          {/* 左侧：上传 + 结果 */}
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
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                  dragging
                    ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                    : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
                }`}
              >
                <div className="text-3xl mb-2">📤</div>
                <p className="font-medium text-sm">拖拽图片至此 或 点击选择</p>
                <p className="text-xs text-gray-400 mt-1">
                  支持 JPG / PNG / BMP / GIF 等
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) =>
                    e.target.files?.[0] && handleImageFile(e.target.files[0])
                  }
                />
              </div>
            </div>

            {imageLoading && (
              <p className="text-sm text-gray-500 flex items-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin"></span>
                正在识别...
              </p>
            )}
            {imageError && (
              <p className="text-sm text-red-500">⚠️ {imageError}</p>
            )}
            {renderResult(imageResult)}
          </div>

          {/* 右侧：Canvas 预览 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              ② 预览
            </label>
            <div className="card p-3 min-h-[200px] flex items-center justify-center">
              <canvas
                ref={imageCanvasRef}
                className="max-w-full rounded-lg"
              />
            </div>
            <p className="text-xs text-gray-400 text-center">
              识别到二维码时将以绿色边框标注
            </p>
          </div>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {/* 左侧：摄像头预览 + 控制 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              摄像头预览
            </label>
            <div className="card p-3 min-h-[240px] flex items-center justify-center bg-gray-50 dark:bg-gray-800 relative overflow-hidden">
              <video
                ref={videoRef}
                playsInline
                muted
                className="max-w-full max-h-80 rounded-lg"
              />
              {/* 用于提取帧做识别的隐藏 canvas */}
              <canvas ref={scanCanvasRef} className="hidden" />
              {!cameraActive && (
                <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">
                  点击下方按钮开启摄像头
                </div>
              )}
            </div>
            <div className="flex gap-2">
              {!cameraActive ? (
                <button onClick={startCamera} className="btn-primary flex-1">
                  ▶️ 开启摄像头
                </button>
              ) : (
                <button onClick={stopCamera} className="btn-ghost flex-1">
                  ⏹️ 停止扫码
                </button>
              )}
            </div>
            {cameraError && (
              <p className="text-sm text-red-500">⚠️ {cameraError}</p>
            )}
            {/* 提示：摄像头需 HTTPS 或 localhost 环境 */}
            <p className="text-xs text-gray-400">
              提示：摄像头功能需在 HTTPS 或 localhost 环境下使用
            </p>
          </div>

          {/* 右侧：扫码结果 */}
          <div className="space-y-4">
            <label className="block text-xs font-medium text-gray-500 uppercase">
              扫码结果
            </label>
            {cameraActive && !cameraResult && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                <span className="inline-flex items-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-brand-600 border-t-transparent rounded-full animate-spin"></span>
                  正在扫描...
                </span>
              </div>
            )}
            {!cameraActive && !cameraResult && !cameraError && (
              <div className="rounded-xl bg-gray-50 dark:bg-gray-800 min-h-[200px] flex items-center justify-center text-gray-400 text-sm">
                开启摄像头后将自动扫描二维码
              </div>
            )}
            {renderResult(cameraResult)}
          </div>
        </div>
      )}
    </ToolLayout>
  );
}
