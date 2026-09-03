"""图片处理接口。

提供图片去水印等图片相关接口。
支持矩形区域选区和笔刷涂抹两种去水印模式。
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from app.services.image_service import image_service

router = APIRouter(prefix="/image", tags=["图片处理"])


def success(data: Any = None, message: str = "success") -> dict[str, Any]:
    """统一成功响应格式。"""
    return {"code": 0, "message": message, "data": data}


@router.post(
    "/remove-watermark",
    summary="图片去水印",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}},
)
async def remove_watermark(
    file: UploadFile = File(..., description="待处理图片文件"),
    regions: str | None = Form(
        default=None,
        description='水印区域 JSON，形如 [{"x":0,"y":0,"width":100,"height":50}]',
    ),
    mask: UploadFile | None = File(
        default=None,
        description="笔刷涂抹生成的 mask 图（黑白图，白色为水印区域）",
    ),
    method: str = Form(default="telea", description="修复算法：telea 或 ns"),
    radius: float = Form(default=3.0, description="修复半径"),
) -> Response:
    """去除图片中的水印。

    支持两种模式（二选一）：
    - **矩形区域**：通过 regions 参数传入 JSON 格式的水印区域列表
    - **笔刷涂抹**：通过 mask 参数上传涂抹 mask 图

    后端基于 OpenCV Inpaint 算法进行图像修复，处理后直接返回 PNG 图片。
    临时文件处理完成后 5 分钟内自动删除，不存储用户数据。
    """
    # 读取原图
    file_bytes = await file.read()

    # 解析 regions
    parsed_regions = None
    if regions:
        try:
            parsed_regions = json.loads(regions)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="regions JSON 格式错误")

    # 读取 mask（如有）
    mask_bytes = None
    if mask:
        mask_bytes = await mask.read()

    # 校验：至少提供一种模式
    if not parsed_regions and not mask_bytes:
        raise HTTPException(
            status_code=400,
            detail="必须提供 regions 或 mask 参数",
        )

    # 校验算法
    if method not in ("telea", "ns"):
        raise HTTPException(status_code=400, detail="method 必须为 telea 或 ns")

    try:
        result_bytes = await image_service.remove_watermark(
            file_bytes,
            regions=parsed_regions,
            mask_bytes=mask_bytes,
            inpaint_radius=radius,
            method=method,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"处理失败: {e}")

    # 直接返回处理后图片
    return Response(content=result_bytes, media_type="image/png")
