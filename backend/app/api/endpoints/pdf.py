"""PDF 处理接口。

提供 PDF 转 Word、PDF 压缩、中文字体子集化等接口。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.services.pdf_service import pdf_service

router = APIRouter(prefix="/pdf", tags=["PDF 处理"])


def success(data: Any = None, message: str = "success") -> dict[str, Any]:
    """统一成功响应格式。"""
    return {"code": 0, "message": message, "data": data}


@router.post(
    "/subset-font",
    summary="中文字体子集化",
    response_class=Response,
    responses={200: {"content": {"font/ttf": {}}}},
)
async def subset_font(
    text: str = Form(..., description="需要渲染的所有文本内容，后端将提取这些字符生成子集字体"),
    font_family: str = Form("simhei", description="字体名称：simhei(黑体)/simsun(宋体)/simkai(楷体)/simfang(仿宋)/msyh(微软雅黑)"),
) -> Response:
    """生成中文字体子集。

    接收需要渲染的文本内容，从系统中文字体（如黑体、宋体、楷体等）中
    提取仅包含所需字符的子集 TTF 文件，大幅减小字体体积（通常 < 100KB）。

    前端用该子集字体嵌入 PDF（pdf-lib embedFont），实现 PDF 中文填写。

    - 自动包含基础 ASCII 字符
    - 去除 hinting 进一步压缩
    - 返回 TTF 字体字节流
    - 支持多种中文字体选择
    """
    if not text.strip():
        raise HTTPException(status_code=400, detail="文本内容不能为空")

    try:
        font_bytes = await pdf_service.subset_font(text, font_family=font_family)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"子集化失败: {e}")

    return Response(content=font_bytes, media_type="font/ttf")


@router.post("/to-word", summary="PDF 转 Word")
async def to_word(
    file: UploadFile = File(..., description="待转换的 PDF 文件"),
) -> dict[str, Any]:
    """将 PDF 文件转换为 Word（.docx）。

    TODO: 使用 pdf2docx 完成转换。
    """
    _ = await pdf_service.save_temp_file(await file.read(), suffix=".pdf")
    return success(
        data={"file_id": "TODO", "url": "TODO"},
        message="TODO: PDF 转 Word 功能开发中",
    )


@router.post("/compress", summary="PDF 压缩")
async def compress(
    file: UploadFile = File(..., description="待压缩的 PDF 文件"),
    quality: int = Form(default=80, ge=1, le=100, description="压缩质量 1-100"),
) -> dict[str, Any]:
    """压缩 PDF 文件。

    TODO: 使用 PyMuPDF 重新采样图片。
    """
    _ = await pdf_service.save_temp_file(await file.read(), suffix=".pdf")
    return success(
        data={"file_id": "TODO", "url": "TODO", "quality": quality},
        message="TODO: PDF 压缩功能开发中",
    )
