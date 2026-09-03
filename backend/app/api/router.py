"""API 路由聚合。

将各业务模块的子路由统一聚合到 api_router，统一挂载 /api/v1 前缀。
"""

from fastapi import APIRouter

from app.api.endpoints import image, pdf

api_router = APIRouter(prefix="/api/v1")

# 挂载各业务路由
api_router.include_router(image.router)
api_router.include_router(pdf.router)
