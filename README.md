# 在线工具箱

一站式、纯前端优先、隐私安全的在线工具箱网站，聚合图片、PDF、二维码、文本等高频小工具，文件处理尽量在本地浏览器完成，无需反复切换站点，保障数据安全。

## 功能特性

- **图片处理**：图片压缩（JPG/PNG/WebP，支持批量）、图片裁剪、图片格式转换、图片去水印
- **PDF 工具**：PDF 编辑（合并/拆分/水印/旋转）、PDF 转图片（逐页导出 PNG/JPG）
- **二维码**：二维码生成（自定义颜色/Logo/容错等级，导出 PNG/SVG）、二维码识别（支持摄像头扫码）
- **文本工具**：JSON 格式化（校验/美化/压缩）、Base64 编解码
- 前端可完成的处理一律不上传服务器，处理完即销毁，隐私安全且完全免费

## 技术架构

| 模块 | 技术栈 | 说明 |
|------|--------|------|
| `frontend` | React 19 + Vite + Tailwind CSS + React Router | 单页应用，工具按分类模块化注册，新增工具只需在 `src/config/tools.ts` 登记 |
| `backend` | FastAPI + Uvicorn + Pillow/OpenCV/PyMuPDF | 提供图片去水印等需服务端能力的接口，统一前缀 `/api/v1` |

## 目录结构

```text
frontend/   前端应用（工具页面、组件、工具注册表）
backend/    FastAPI 后端服务（配置、路由、图片/PDF 处理服务）
docs/       需求文档（PRD）
```

## 快速开始

### 前端

```bash
cd frontend
npm install
npm run dev        # 开发模式，默认 http://localhost:5173
npm run build      # 构建产物
```

### 后端（可选，图片去水印等接口需要）

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

启动后可访问 `http://localhost:8000/docs` 查看接口文档，`/health` 提供健康检查。
