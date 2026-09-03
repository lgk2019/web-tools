/**
 * PDF.js 封装模块。
 *
 * 为什么不用 `import * as pdfjsLib from 'pdfjs-dist'`？
 * ------------------------------------------------------------------
 * pdfjs-dist 在 v4/v5/v6 中依赖了 Stage 3 提案 Map.getOrInsertComputed，
 * 当前主流浏览器尚未原生支持，直接 import 会在运行时报错
 * `this[#methodPromises].getOrInsertComputed is not a function`。
 *
 * 此外 Vite 预构建缓存会把旧版本打包好的代码永久缓存，
 * 降级/换 build 后仍然可能执行到旧代码。
 *
 * 本方案：
 *  - 在 index.html 中通过 <script> 全局加载锁定的稳定老版本 pdf.js (v3.11.174)
 *    该版本不依赖任何新提案，兼容性最好；
 *  - workerSrc 也在 index.html 全局配置，主包与 worker 同版本同构建类型；
 *  - 本模块提供 Promise 形式的 getPdfjsLib()，确保 window 上 pdfjsLib 就绪后才返回，
 *    并对外部导出最小可用的类型声明。
 */

declare global {
  interface Window {
    // pdfjs-dist v3 的 webpack UMD 暴露在这个键上
    'pdfjs-dist/build/pdf'?: any;
  }
}

/** pdf.js 的类型映射（仅列出当前项目实际用到的成员，避免循环引用 npm 包） */
export interface PDFPageViewport {
  width: number;
  height: number;
  clone(params?: Partial<{ scale: number; rotation: number }>): PDFPageViewport;
}

export interface PDFRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface RenderParameters {
  canvasContext: CanvasRenderingContext2D;
  viewport: PDFPageViewport;
}

export interface PDFPageProxy {
  getViewport(params: { scale: number }): PDFPageViewport;
  render(params: RenderParameters): PDFRenderTask;
  getTextContent(): Promise<any>;
}

export interface PDFDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PDFPageProxy>;
  destroy(): Promise<void>;
}

export interface PDFDocumentLoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
  onProgress: ((evt: { loaded: number; total: number }) => void) | null;
}

export interface GetDocumentParameters {
  data?: Uint8Array | ArrayBuffer;
  url?: string;
  password?: string;
}

export interface PDFJSLib {
  getDocument(src: GetDocumentParameters | Uint8Array | string): PDFDocumentLoadingTask;
  GlobalWorkerOptions: {
    workerSrc: string;
    workerPort?: any;
  };
  // 版本校验（用于调试）
  version?: string;
}

let _lib: PDFJSLib | null = null;
let _readyPromise: Promise<PDFJSLib> | null = null;

/**
 * 获取 pdfjsLib 实例（单例 + 等待 CDN 脚本加载完成）。
 */
export function getPdfjsLib(): Promise<PDFJSLib> {
  if (_lib) return Promise.resolve(_lib);
  if (_readyPromise) return _readyPromise;

  _readyPromise = new Promise<PDFJSLib>((resolve, reject) => {
    const tryGet = (): boolean => {
      const mod = window['pdfjs-dist/build/pdf'] as unknown as PDFJSLib | undefined;
      if (mod && typeof mod.getDocument === 'function') {
        _lib = mod;
        resolve(mod);
        return true;
      }
      return false;
    };
    if (tryGet()) return;

    // 轮询等待 <script> 执行完成（最多 10s）
    const MAX_WAIT = 10000;
    const INTERVAL = 50;
    let elapsed = 0;
    const timer = window.setInterval(() => {
      elapsed += INTERVAL;
      if (tryGet()) {
        window.clearInterval(timer);
        return;
      }
      if (elapsed >= MAX_WAIT) {
        window.clearInterval(timer);
        reject(new Error('PDF.js 脚本加载超时，请检查网络后重试（需能访问 unpkg.com）'));
      }
    }, INTERVAL);
  });

  return _readyPromise;
}
