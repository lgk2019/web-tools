// 图片压缩选项
interface CompressOptions {
  quality: number; // 1-100
  format: 'image/jpeg' | 'image/png' | 'image/webp';
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * 使用 Canvas 压缩图片
 */
export async function compressImage(
  file: File,
  options: CompressOptions
): Promise<Blob> {
  const { quality, format, maxWidth, maxHeight } = options;
  const img = await loadImage(file);

  let { width, height } = calculateSize(
    img.width,
    img.height,
    maxWidth,
    maxHeight
  );

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // 白色背景（JPG 不支持透明）
  if (format === 'image/jpeg') {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(img, 0, 0, width, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('压缩失败'));
      },
      format,
      quality / 100
    );
  });
}

/**
 * 加载图片文件为 HTMLImageElement
 */
export function loadImage(file: File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = typeof file === 'string' ? file : URL.createObjectURL(file);
    img.onload = () => {
      if (typeof file !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * 计算缩放后尺寸
 */
function calculateSize(
  w: number,
  h: number,
  maxW?: number,
  maxH?: number
): { width: number; height: number } {
  if (!maxW && !maxH) return { width: w, height: h };
  const ratio = w / h;
  let width = w;
  let height = h;
  if (maxW && width > maxW) {
    width = maxW;
    height = Math.round(maxW / ratio);
  }
  if (maxH && height > maxH) {
    height = maxH;
    width = Math.round(maxH * ratio);
  }
  return { width, height };
}

/**
 * 格式化文件大小
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i >= 2 ? 2 : 1)} ${sizes[i]}`;
}

/**
 * 下载 Blob
 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 裁剪图片
 */
export async function cropImage(
  file: File,
  crop: { x: number; y: number; width: number; height: number },
  outputScale = 1
): Promise<Blob> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = crop.width * outputScale;
  canvas.height = crop.height * outputScale;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('裁剪失败'));
    }, 'image/png');
  });
}
