import { useState, useRef, useCallback } from 'react';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import ToolLayout from '../../components/ToolLayout';
import { tools } from '../../config/tools';
import { downloadBlob, formatBytes } from '../../utils/image';
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

// 拖拽上传区（自带 input 与拖拽态）
function DropZone({
  multiple = false,
  onFiles,
  hint,
}: {
  multiple?: boolean;
  onFiles: (files: FileList) => void;
  hint?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files) onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
            : 'border-gray-300 dark:border-gray-700 hover:border-brand-400'
        }`}
      >
        <div className="text-3xl mb-2">📤</div>
        <p className="font-medium text-sm">拖拽 PDF 至此 或 点击选择</p>
        {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        multiple={multiple}
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
}: {
  file: File;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2">
      <span className="w-9 h-9 rounded bg-brand-100 dark:bg-brand-900/40 flex items-center justify-center text-sm shrink-0">
        📄
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{file.name}</p>
        <p className="text-xs text-gray-400">{formatBytes(file.size)}</p>
      </div>
      <button
        onClick={onRemove}
        className="text-gray-400 hover:text-red-500 text-xs px-1"
        title="移除"
      >
        ✕
      </button>
    </div>
  );
}

// 解析页码范围 "1-3,5,7-9" → 0-based 索引数组
function parsePageRanges(input: string, maxPage: number): number[] {
  const result: number[] = [];
  const parts = input
    .split(',')
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
async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

export default function PDFEditor() {
  const [activeTab, setActiveTab] = useState<TabId>('merge');
  const [error, setError] = useState('');
  const [processing, setProcessing] = useState(false);

  // 合并
  const [mergeFiles, setMergeFiles] = useState<File[]>([]);
  // 拆分
  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [pageRanges, setPageRanges] = useState('');
  // 水印
  const [wmFile, setWmFile] = useState<File | null>(null);
  const [wmText, setWmText] = useState('机密');
  const [wmSize, setWmSize] = useState(50);
  const [wmOpacity, setWmOpacity] = useState(0.3);
  const [wmRotation, setWmRotation] = useState(45);
  const [wmColor, setWmColor] = useState('#888888');
  // 旋转
  const [rotFile, setRotFile] = useState<File | null>(null);
  const [rotAngle, setRotAngle] = useState<90 | 180 | 270>(90);

  // 校验单个 PDF 文件
  const validatePdf = (file: File): string | null => {
    if (
      file.type !== 'application/pdf' &&
      !file.name.toLowerCase().endsWith('.pdf')
    ) {
      return '请上传 PDF 文件';
    }
    if (file.size > MAX_FILE_SIZE) {
      return `文件大小超过限制（≤ ${formatBytes(MAX_FILE_SIZE)}）`;
    }
    return null;
  };

  // 切换 Tab，并清空当前文件与错误
  const switchTab = (id: TabId) => {
    if (id === activeTab) return;
    setActiveTab(id);
    setMergeFiles([]);
    setSplitFile(null);
    setWmFile(null);
    setRotFile(null);
    setPageRanges('');
    setError('');
  };

  // Tab 按钮类名
  const tabBtnClass = (id: TabId) =>
    `flex-1 py-2 rounded-md text-xs font-medium transition-colors ${
      activeTab === id
        ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
        : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
    }`;

  // 合并：添加多个文件
  const addMergeFiles = useCallback((fileList: FileList) => {
    setError('');
    const valid: File[] = [];
    for (const f of Array.from(fileList)) {
      if (
        f.type !== 'application/pdf' &&
        !f.name.toLowerCase().endsWith('.pdf')
      ) {
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        setError(`文件 ${f.name} 超过 ${formatBytes(MAX_FILE_SIZE)} 限制`);
        continue;
      }
      valid.push(f);
    }
    if (valid.length) setMergeFiles((prev) => [...prev, ...valid]);
  }, []);

  // 合并：上移/下移文件
  const moveMergeFile = (index: number, dir: -1 | 1) => {
    setMergeFiles((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  // 设置单个文件（拆分/水印/旋转通用）
  const setSingleFile = (file: File, setter: (f: File | null) => void) => {
    const err = validatePdf(file);
    if (err) {
      setError(err);
      setter(null);
      return;
    }
    setError('');
    setter(file);
  };

  // 下载 PDF
  const downloadPdf = (bytes: Uint8Array, filename: string) => {
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), filename);
  };

  // ===== Tab1: PDF 合并 =====
  const handleMerge = async () => {
    if (mergeFiles.length < 2) {
      setError('请至少上传 2 个 PDF 文件');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      const merged = await PDFDocument.create();
      for (const file of mergeFiles) {
        const bytes = await fileToBytes(file);
        const src = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      }
      const out = await merged.save();
      downloadPdf(out, '合并文档.pdf');
    } catch (e: any) {
      setError(e?.message || '合并失败，请检查文件是否损坏');
    } finally {
      setProcessing(false);
    }
  };

  // ===== Tab2: PDF 拆分 =====
  const handleSplit = async () => {
    if (!splitFile) {
      setError('请上传 PDF 文件');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      const bytes = await fileToBytes(splitFile);
      const src = await PDFDocument.load(bytes);
      const total = src.getPageCount();
      const indices = parsePageRanges(pageRanges, total);
      if (indices.length === 0) throw new Error('未提取到任何页面');
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, indices);
      pages.forEach((p) => out.addPage(p));
      const result = await out.save();
      downloadPdf(result, '提取页面.pdf');
    } catch (e: any) {
      setError(e?.message || '拆分失败');
    } finally {
      setProcessing(false);
    }
  };

  // ===== Tab3: 添加水印 =====
  const handleWatermark = async () => {
    if (!wmFile) {
      setError('请上传 PDF 文件');
      return;
    }
    if (!wmText.trim()) {
      setError('请输入水印文字');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      const bytes = await fileToBytes(wmFile);
      const doc = await PDFDocument.load(bytes);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const { r, g, b } = hexToRgb(wmColor);
      const pages = doc.getPages();
      for (const page of pages) {
        const { width, height } = page.getSize();
        const textWidth = font.widthOfTextAtSize(wmText, wmSize);
        page.drawText(wmText, {
          x: width / 2 - textWidth / 2,
          y: height / 2,
          size: wmSize,
          font,
          color: rgb(r, g, b),
          opacity: wmOpacity,
          rotate: degrees(wmRotation),
        });
      }
      const out = await doc.save();
      downloadPdf(out, '水印文档.pdf');
    } catch (e: any) {
      setError(e?.message || '添加水印失败');
    } finally {
      setProcessing(false);
    }
  };

  // ===== Tab4: 旋转页面 =====
  const handleRotate = async () => {
    if (!rotFile) {
      setError('请上传 PDF 文件');
      return;
    }
    setProcessing(true);
    setError('');
    try {
      const bytes = await fileToBytes(rotFile);
      const doc = await PDFDocument.load(bytes);
      const pages = doc.getPages();
      for (const page of pages) {
        const current = page.getRotation().angle;
        page.setRotation(degrees((current + rotAngle) % 360));
      }
      const out = await doc.save();
      downloadPdf(out, '旋转文档.pdf');
    } catch (e: any) {
      setError(e?.message || '旋转失败');
    } finally {
      setProcessing(false);
    }
  };

  const sizeHint = `仅支持 PDF · 单文件 ≤ ${formatBytes(MAX_FILE_SIZE)}`;

  return (
    <ToolLayout tool={tool}>
      <div className="space-y-6">
        {/* Tab 导航 */}
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => switchTab(t.id)}
              className={`flex-1 py-2 rounded-md text-xs font-medium transition-colors ${
                activeTab === t.id
                  ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <span className="mr-1">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>

        {/* 错误提示 */}
        {error && (
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
              />
            </div>

            {mergeFiles.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {mergeFiles.map((f, i) => (
                  <div
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-gray-800 p-2"
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
                        disabled={i === 0}
                        className="text-gray-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-gray-400 text-xs px-1"
                        title="上移"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => moveMergeFile(i, 1)}
                        disabled={i === mergeFiles.length - 1}
                        className="text-gray-400 hover:text-brand-600 disabled:opacity-30 disabled:hover:text-gray-400 text-xs px-1"
                        title="下移"
                      >
                        ↓
                      </button>
                      <button
                        onClick={() =>
                          setMergeFiles((prev) =>
                            prev.filter((_, idx) => idx !== i)
                          )
                        }
                        className="text-gray-400 hover:text-red-500 text-xs px-1"
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
                disabled={processing || mergeFiles.length < 2}
                className="btn-primary flex-1"
              >
                {processing
                  ? '处理中…'
                  : `🔗 合并（${mergeFiles.length} 个文件）`}
              </button>
              {mergeFiles.length > 0 && (
                <button onClick={() => setMergeFiles([])} className="btn-ghost">
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
                  if (f) setSingleFile(f, setSplitFile);
                }}
                hint={sizeHint}
              />
            </div>

            {splitFile && (
              <FileCard file={splitFile} onRemove={() => setSplitFile(null)} />
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase mb-2">
                ② 页码范围
              </label>
              <input
                type="text"
                value={pageRanges}
                onChange={(e) => setPageRanges(e.target.value)}
                placeholder="如 1-3,5,7-9"
                className="input"
              />
              <p className="text-xs text-gray-400 mt-1">
                使用逗号分隔多个范围，页码从 1 开始。例如 1-3,5,7-9 将提取第 1-3、5、7-9 页。
              </p>
            </div>

            <button
              onClick={handleSplit}
              disabled={processing || !splitFile}
              className="btn-primary w-full"
            >
              {processing ? '处理中…' : '✂️ 提取页面'}
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
                  if (f) setSingleFile(f, setWmFile);
                }}
                hint={sizeHint}
              />
            </div>

            {wmFile && (
              <FileCard file={wmFile} onRemove={() => setWmFile(null)} />
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
                  onChange={(e) => setWmText(e.target.value)}
                  placeholder="如 机密 / DRAFT"
                  className="input"
                />
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">字体大小</span>
                  <span className="text-sm font-mono text-brand-600">
                    {wmSize}
                  </span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="120"
                  value={wmSize}
                  onChange={(e) => setWmSize(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">透明度</span>
                  <span className="text-sm font-mono text-brand-600">
                    {wmOpacity.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={wmOpacity}
                  onChange={(e) => setWmOpacity(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              <div>
                <div className="flex justify-between mb-1">
                  <span className="text-sm">旋转角度</span>
                  <span className="text-sm font-mono text-brand-600">
                    {wmRotation}°
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="360"
                  value={wmRotation}
                  onChange={(e) => setWmRotation(Number(e.target.value))}
                  className="w-full accent-brand-600"
                />
              </div>

              <div>
                <span className="text-sm block mb-1.5">水印颜色</span>
                <input
                  type="color"
                  value={wmColor}
                  onChange={(e) => setWmColor(e.target.value)}
                  className="w-full h-9 rounded-lg border border-gray-300 dark:border-gray-700 cursor-pointer"
                />
              </div>
            </div>

            <button
              onClick={handleWatermark}
              disabled={processing || !wmFile}
              className="btn-primary w-full"
            >
              {processing ? '处理中…' : '💧 添加水印'}
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
                  if (f) setSingleFile(f, setRotFile);
                }}
                hint={sizeHint}
              />
            </div>

            {rotFile && (
              <FileCard file={rotFile} onRemove={() => setRotFile(null)} />
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
                      className={`flex-1 py-1.5 rounded-md text-xs font-medium ${
                        rotAngle === a
                          ? 'bg-white dark:bg-gray-900 text-brand-600 shadow-sm'
                          : 'text-gray-500'
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
              disabled={processing || !rotFile}
              className="btn-primary w-full"
            >
              {processing ? '处理中…' : '🔄 旋转页面'}
            </button>
          </div>
        )}

        {/* ===== Tab5: 填写编辑 ===== */}
        {activeTab === 'fill' && <PDFFiller />}

        {/* 底部提示 */}
        <p className="text-xs text-gray-400 text-center">
          所有操作均在浏览器本地完成，文件不会上传到服务器
        </p>
      </div>
    </ToolLayout>
  );
}
