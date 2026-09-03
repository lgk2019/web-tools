// 端到端验证：多字体 + 加粗 + 斜体 + 下划线
import { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, skewDegrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { readFileSync, writeFileSync } from 'fs';

const API_BASE = 'http://localhost:8000/api/v1';
const TEST_PDF = 'c:/Users/lgk2020/Documents/工作资料/Code/tools/frontend/test_files/test.pdf';
const OUTPUT_PDF = 'c:/Users/lgk2020/Documents/工作资料/Code/tools/frontend/test_files/test_styled.pdf';

console.log('=== PDF 字体样式端到端验证 ===\n');

const pdfBytes = readFileSync(TEST_PDF);
console.log(`[1] 读取测试 PDF: ${pdfBytes.length} bytes`);

// 模拟标注：不同字体 + 样式组合
const annotations = [
  { text: '黑体普通', fontFamily: 'simhei', bold: false, italic: false, underline: false, x: 80, y: 600, size: 18, color: rgb(0,0,0) },
  { text: '黑体加粗', fontFamily: 'simhei', bold: true,  italic: false, underline: false, x: 80, y: 570, size: 18, color: rgb(0,0,0) },
  { text: '宋体斜体', fontFamily: 'simsun', bold: false, italic: true,  underline: false, x: 80, y: 540, size: 18, color: rgb(0,0,0) },
  { text: '楷体下划线', fontFamily: 'simkai', bold: false, italic: false, underline: true,  x: 80, y: 510, size: 18, color: rgb(0,0,0) },
  { text: '雅黑加粗斜体', fontFamily: 'msyh', bold: true,  italic: true,  underline: false, x: 80, y: 480, size: 18, color: rgb(0,0,1) },
  { text: '仿宋全部样式', fontFamily: 'simfang', bold: true, italic: true, underline: true, x: 80, y: 450, size: 18, color: rgb(1,0,0) },
  { text: 'Hello World 123', fontFamily: 'simhei', bold: false, italic: false, underline: false, x: 80, y: 420, size: 14, color: rgb(0,0,0) },
];

// 按字体分组获取子集
const groups = {};
for (const ann of annotations) {
  if (!groups[ann.fontFamily]) groups[ann.fontFamily] = [];
  groups[ann.fontFamily].push(ann.text);
}
console.log(`[2] 字体分组: ${Object.keys(groups).join(', ')}`);

console.log('[3] 并行获取字体子集...');
const fontEntries = await Promise.all(
  Object.entries(groups).map(async ([family, texts]) => {
    const formData = new FormData();
    formData.append('text', texts.join(''));
    formData.append('font_family', family);
    const resp = await fetch(`${API_BASE}/pdf/subset-font`, { method: 'POST', body: formData });
    console.log(`  ${family}: ${resp.status} ${resp.statusText}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    console.log(`  ${family}: ${buf.length} bytes`);
    return { family, buf };
  })
);

console.log('[4] pdf-lib 嵌入字体并绘制...');
const doc = await PDFDocument.load(pdfBytes);
doc.registerFontkit(fontkit);
const fontMap = {};
for (const { family, buf } of fontEntries) {
  fontMap[family] = await doc.embedFont(buf, { subset: true });
}
const helv = await doc.embedFont(StandardFonts.Helvetica);
const pages = doc.getPages();
const page = pages[0];
const { height: ph } = page.getSize();

for (const ann of annotations) {
  const font = fontMap[ann.fontFamily] || helv;
  const lineY = ph - ann.y;
  const lineX = ann.x;

  if (ann.italic) {
    page.pushOperators(pushGraphicsState(), skewDegrees(-12, 0));
  }

  const offsets = ann.bold
    ? [[0,0],[0.4,0],[-0.4,0],[0,0.4],[0,-0.4]]
    : [[0,0]];

  for (const [ox, oy] of offsets) {
    page.drawText(ann.text, {
      x: lineX + ox, y: lineY + oy,
      size: ann.size, font, color: ann.color,
    });
  }

  if (ann.italic) page.pushOperators(popGraphicsState());

  if (ann.underline) {
    const w = font.widthOfTextAtSize(ann.text, ann.size);
    page.drawLine({
      start: { x: lineX, y: lineY - 2 },
      end: { x: lineX + w, y: lineY - 2 },
      thickness: Math.max(0.5, ann.size / 18),
      color: ann.color,
    });
  }
  console.log(`  ✓ "${ann.text}" [${ann.fontFamily}] bold=${ann.bold} italic=${ann.italic} underline=${ann.underline}`);
}

console.log('[5] 保存 PDF...');
const saved = await doc.save();
writeFileSync(OUTPUT_PDF, saved);
console.log(`  ✓ ${OUTPUT_PDF} (${saved.length} bytes)`);
console.log('\n=== 验证通过 ===');
