"""FastAPI 应用主入口。

负责创建 FastAPI 实例、配置 CORS、挂载路由、提供健康检查端点。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import settings

# 日志配置
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理。

    启动时确保临时目录存在；关闭时做收尾。
    临时文件清理策略说明：
    - 每个上传文件处理完成后，由调用层通过 BackgroundTasks 调度延迟删除任务，
      在 settings.TEMP_FILE_TTL（默认 300 秒 = 5 分钟）后自动删除。
    - TODO: 后续可接入 APScheduler 周期性扫描临时目录，兜底清理残留文件。
    """
    settings.ensure_temp_dir()
    logger.info("临时目录就绪: %s", settings.TEMP_DIR)
    yield
    logger.info("应用关闭")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="一站式在线工具箱后端服务，提供图片、PDF 等文件处理能力。",
    lifespan=lifespan,
)

# CORS 跨域配置：允许 Vite 开发服务器（localhost:5173）等来源访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
    allow_methods=settings.CORS_ALLOW_METHODS,
    allow_headers=settings.CORS_ALLOW_HEADERS,
)

# 挂载业务路由（统一前缀 /api/v1）
app.include_router(api_router)


@app.get("/health", tags=["系统"], summary="健康检查")
async def health() -> dict[str, Any]:
    """健康检查端点，用于容器探针与负载均衡。"""
    return {
        "code": 0,
        "message": "success",
        "data": {"status": "healthy", "service": settings.APP_NAME, "version": settings.APP_VERSION},
    }


@app.get("/", tags=["系统"], summary="根路径")
async def root() -> dict[str, Any]:
    """根路径，返回服务基本信息。"""
    return {
        "code": 0,
        "message": "success",
        "data": {"service": settings.APP_NAME, "docs": "/docs"},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=settings.DEBUG)
