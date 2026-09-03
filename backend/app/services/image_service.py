"""图片处理服务。

提供图片去水印等图片处理能力，基于 OpenCV Inpaint 算法。
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.core.config import settings

logger = logging.getLogger(__name__)


class ImageService:
    """图片处理服务。

    封装与图片相关的业务逻辑，包括去水印等。
    """

    async def remove_watermark(
        self,
        file_bytes: bytes,
        regions: list[dict[str, int]] | None = None,
        mask_bytes: bytes | None = None,
        *,
        inpaint_radius: float = 3.0,
        method: str = "telea",
    ) -> bytes:
        """去除图片水印。

        支持两种模式：
        1. 矩形区域模式：传入 regions 列表，后端构建 mask
        2. 笔刷 mask 模式：前端涂抹生成 mask 图（黑白图，白色为水印区域）

        使用 OpenCV Inpaint 算法对指定区域进行图像修复。

        Args:
            file_bytes: 原始图片字节流。
            regions: 水印区域列表，每项为 {x, y, width, height} 矩形框。
            mask_bytes: 前端生成的 mask 图字节流（与原图同尺寸，白色为待修复区域）。
            inpaint_radius: Inpaint 算法的修复半径，默认 3.0。
            method: 修复算法，"telea"（快速行进法）或 "ns"（Navier-Stokes）。

        Returns:
            处理后的图片字节流（PNG 编码）。

        TODO:
            - 接入自动水印检测（基于颜色/纹理特征或预训练模型）。
            - 复杂背景下去除效果有限，需在前端给出明确提示。
        """
        logger.info(
            "调用 remove_watermark: regions=%s, mask=%s, method=%s",
            len(regions) if regions else 0,
            bool(mask_bytes),
            method,
        )

        # 1. 解码原始图片
        nparr = np.frombuffer(file_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("无法解码图片，请检查文件格式")

        h, w = image.shape[:2]

        # 2. 构建 mask
        if mask_bytes:
            # 笔刷 mask 模式：解码前端上传的 mask 图
            mask = self._decode_mask(mask_bytes, w, h)
        elif regions:
            # 矩形区域模式：根据 regions 绘制 mask
            mask = self._build_mask_from_regions(regions, w, h)
        else:
            raise ValueError("必须提供 regions 或 mask 参数")

        # 如果 mask 全黑（无待修复区域），原样返回
        if cv2.countNonZero(mask) == 0:
            logger.warning("mask 为空，无待修复区域")
            _, result_bytes = cv2.imencode(".png", image)
            return result_bytes.tobytes()

        # 3. 选择修复算法
        flag = cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS

        # 4. 执行 Inpaint 修复
        result = cv2.inpaint(image, mask, inpaintRadius=inpaint_radius, flags=flag)

        # 5. 编码为 PNG 返回
        _, result_bytes = cv2.imencode(".png", result)
        return result_bytes.tobytes()

    def _build_mask_from_regions(
        self, regions: list[dict[str, int]], w: int, h: int
    ) -> np.ndarray:
        """根据矩形区域列表构建 mask。

        Args:
            regions: 区域列表，每项含 x, y, width, height。
            w: 图片宽度。
            h: 图片高度。

        Returns:
            单通道 mask，水印区域为 255（白色），其余为 0（黑色）。
        """
        mask = np.zeros((h, w), dtype=np.uint8)
        for region in regions:
            x = max(0, int(region.get("x", 0)))
            y = max(0, int(region.get("y", 0)))
            rw = max(1, int(region.get("width", 0)))
            rh = max(1, int(region.get("height", 0)))
            # 限制在图片范围内
            x2 = min(w, x + rw)
            y2 = min(h, y + rh)
            mask[y:y2, x:x2] = 255
        return mask

    def _decode_mask(self, mask_bytes: bytes, w: int, h: int) -> np.ndarray:
        """解码前端上传的 mask 图并缩放至原图尺寸。

        前端生成的 mask 为黑白图：白色(255)表示水印区域。

        Args:
            mask_bytes: mask 图字节流。
            w: 原图宽度。
            h: 原图高度。

        Returns:
            单通道 mask（与原图同尺寸）。
        """
        nparr = np.frombuffer(mask_bytes, np.uint8)
        mask_img = cv2.imdecode(nparr, cv2.IMREAD_GRAYSCALE)
        if mask_img is None:
            raise ValueError("无法解码 mask 图")
        # 缩放至原图尺寸
        if mask_img.shape[:2] != (h, w):
            mask_img = cv2.resize(mask_img, (w, h), interpolation=cv2.INTER_NEAREST)
        # 二值化：非黑像素置为 255
        _, mask = cv2.threshold(mask_img, 128, 255, cv2.THRESH_BINARY)
        return mask

    async def save_temp_file(self, file_bytes: bytes, *, suffix: str = ".png") -> Path:
        """将字节流保存到临时目录。

        处理完成后由调度层负责在 5 分钟内自动删除。
        """
        temp_dir = settings.ensure_temp_dir()
        target = temp_dir / f"{uuid.uuid4().hex}{suffix}"
        target.write_bytes(file_bytes)
        return target


image_service = ImageService()
