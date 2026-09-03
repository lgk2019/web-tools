"""PDF 处理服务。

提供 PDF 格式转换、压缩、中文字体子集化等能力。
"""

from __future__ import annotations

import io
import logging
import os
import uuid
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

from app.core.config import settings

logger = logging.getLogger(__name__)

# 系统中文字体候选路径（按优先级），用于默认查找
_CJK_FONT_CANDIDATES = [
    # Windows
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    # Linux 常见路径
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
]

# 按字体名称映射的系统字体路径
_FONT_FAMILY_MAP: dict[str, list[str]] = {
    # 黑体
    "simhei": [
        r"C:\Windows\Fonts\simhei.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
    ],
    # 宋体
    "simsun": [
        r"C:\Windows\Fonts\simsun.ttc",
        "/usr/share/fonts/truetype/arphic/uming.ttc",
        "/System/Library/Fonts/Songti.ttc",
    ],
    # 楷体
    "simkai": [
        r"C:\Windows\Fonts\simkai.ttf",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        "/System/Library/Fonts/Kaiti.ttc",
    ],
    # 仿宋
    "simfang": [
        r"C:\Windows\Fonts\simfang.ttf",
        "/usr/share/fonts/truetype/arphic/ukai.ttc",
        "/System/Library/Fonts/STFangsong.ttf",
    ],
    # 微软雅黑
    "msyh": [
        r"C:\Windows\Fonts\msyh.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ],
}

# 缓存找到的字体路径
_cached_font_path: str | None = None
_cached_font_paths: dict[str, str] = {}


def _find_cjk_font() -> str:
    """查找系统中可用的中文字体路径（默认，向后兼容）。

    Returns:
        字体文件绝对路径。

    Raises:
        FileNotFoundError: 未找到任何中文字体。
    """
    global _cached_font_path
    if _cached_font_path:
        return _cached_font_path

    for candidate in _CJK_FONT_CANDIDATES:
        if os.path.exists(candidate):
            _cached_font_path = candidate
            logger.info("找到中文字体: %s", candidate)
            return candidate

    raise FileNotFoundError("未找到系统中文字体，请安装 Noto Sans CJK 或微软雅黑等字体")


def _find_font_by_family(family: str) -> str:
    """按字体名称查找系统字体路径。

    Args:
        family: 字体名称（simhei/simsun/simkai/simfang/msyh）

    Returns:
        字体文件绝对路径。

    Raises:
        FileNotFoundError: 未找到指定字体。
    """
    if family in _cached_font_paths:
        return _cached_font_paths[family]

    candidates = _FONT_FAMILY_MAP.get(family, [])
    for candidate in candidates:
        if os.path.exists(candidate):
            _cached_font_paths[family] = candidate
            logger.info("找到字体 %s: %s", family, candidate)
            return candidate

    # 回退到默认查找
    logger.warning("字体 %s 未找到，回退到默认中文字体", family)
    return _find_cjk_font()


class PDFService:
    """PDF 处理服务。

    封装与 PDF 相关的业务逻辑，包括格式转换、压缩与中文字体子集化。
    """

    async def subset_font(self, text: str, font_family: str = "simhei") -> bytes:
        """生成中文字体子集。

        根据传入的文本内容，使用 fonttools 从系统中文字体中提取
        仅包含所需字符的子集 TTF 文件，大幅减小字体体积。

        Args:
            text: 需要渲染的所有文本内容（去重后子集化）。
            font_family: 字体名称（simhei/simsun/simkai/simfang/msyh）。

        Returns:
            子集化后的 TTF 字体字节流。

        Raises:
            FileNotFoundError: 系统未安装中文字体。
            RuntimeError: 子集化过程失败。
        """
        font_path = _find_font_by_family(font_family)

        # 收集所需字符（去重 + 排序，确保稳定性）
        # 始终包含基础 ASCII 字符，避免英文字符缺失
        chars = set(text)
        chars.update(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
            " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
        )
        unicode_str = ",".join(f"U+{ord(c):04X}" for c in sorted(chars))

        logger.info("子集化字体: 字符数=%d, 源=%s", len(chars), font_path)

        try:
            # 用 fonttools subset 生成子集
            # --unicodes: 指定保留的 Unicode 码点
            # --layout-features='*': 保留所有 OpenType 特性
            # --no-hinting: 去除 hinting 减小体积
            # --output-format=ttf: 输出 TTF 格式
            args = [
                font_path,
                f"--unicodes={unicode_str}",
                "--layout-features='*'",
                "--no-hinting",
                "--output-file=/dev/null",  # 占位，实际用 stdout
                "--output-format=ttf",
            ]

            # 使用 subset 模块的 CLI 入口
            # 但更可靠的方式是直接用 API
            font = TTFont(font_path, fontNumber=0)

            # 用 Subsetter 子集化
            options = subset.Options()
            options.no_hinting = True
            options.layout_features = ["*"]
            options.name_IDs = ["*"]
            options.name_legacy = True
            options.name_languages = ["*"]
            options.glyph_names = True

            subsetter = subset.Subsetter(options=options)
            subsetter.populate(unicodes={ord(c) for c in chars})
            subsetter.subset(font)

            # 导出为 TTF 字节流
            buf = io.BytesIO()
            font.save(buf)
            font.close()
            result = buf.getvalue()

            logger.info("子集字体生成成功: %d bytes", len(result))
            return result

        except Exception as e:
            logger.error("子集化字体失败: %s", e)
            raise RuntimeError(f"字体子集化失败: {e}") from e

    async def to_word(self, file_bytes: bytes) -> bytes:
        """将 PDF 转换为 Word（.docx）。

        TODO: 使用 pdf2docx 完成转换。
        """
        logger.info("调用 to_word 占位实现，size=%d bytes", len(file_bytes))
        return file_bytes

    async def compress(self, file_bytes: bytes, *, quality: int = 80) -> bytes:
        """压缩 PDF 文件。

        TODO: 使用 PyMuPDF 重新采样图片。
        """
        logger.info("调用 compress 占位实现，quality=%d", quality)
        return file_bytes

    async def save_temp_file(self, file_bytes: bytes, *, suffix: str = ".pdf") -> Path:
        """将字节流保存到临时目录。

        处理完成后由调度层负责在 5 分钟内自动删除。
        """
        temp_dir = settings.ensure_temp_dir()
        target = temp_dir / f"{uuid.uuid4().hex}{suffix}"
        target.write_bytes(file_bytes)
        return target


pdf_service = PDFService()
