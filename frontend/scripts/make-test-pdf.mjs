// 临时脚本：生成测试 PDF 文件
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const outPath = 'c:/Users/lgk2020/Documents/工作资料/Code/tools/frontend/test_files/test.pdf';
mkdirSync(dirname(outPath), { recursive: true });

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([595, 842]); // A4

page.drawText('PDF Filler Test Page', { x: 80, y: 750, size: 24, font, color: rgb(0,0,0) });
page.drawText('This is a test PDF for the filling editor.', { x: 80, y: 720, size: 14, font });
page.drawText('Click anywhere on this page to add a text annotation.', { x: 80, y: 700, size: 12, font, color: rgb(0.4,0.4,0.4) });
page.drawText('Then type Chinese text and click Save.', { x: 80, y: 680, size: 12, font, color: rgb(0.4,0.4,0.4) });
// 画一个方框作为参考区域
page.drawRectangle({ x: 80, y: 400, width: 435, height: 200, borderColor: rgb(0.8,0.8,0.8), borderWidth: 1 });

const bytes = await doc.save();
writeFileSync(outPath, bytes);
console.log('OK: test PDF created at', outPath, 'size:', bytes.length, 'bytes');
