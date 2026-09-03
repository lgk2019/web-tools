"""应用配置模块。

使用 pydantic-settings 管理应用配置，支持通过环境变量覆盖默认值。
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """应用配置类。

    所有配置项均可通过环境变量覆盖，例如：
        export APP_TITLE="Tools API"
        export TEMP_DIR="/tmp/tools"
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # 应用基础信息
    APP_NAME: str = "Tools API"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = False

    # 临时文件目录（处理完成后 5 分钟自动删除）
    TEMP_DIR: Path = Path("/tmp/tools")

    # 临时文件保留时长（秒），默认 300 秒 = 5 分钟
    TEMP_FILE_TTL: int = 300

    # 上传文件大小限制（字节），默认 50MB
    MAX_UPLOAD_SIZE: int = 50 * 1024 * 1024

    # CORS 跨域配置：允许 Vite 开发服务器等来源
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",  # Vite 默认开发端口
        "http://127.0.0.1:5173",
    ]
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOW_METHODS: list[str] = ["*"]
    CORS_ALLOW_HEADERS: list[str] = ["*"]

    def ensure_temp_dir(self) -> Path:
        """确保临时目录存在并返回其路径。"""
        temp_dir = self.TEMP_DIR
        temp_dir.mkdir(parents=True, exist_ok=True)
        return temp_dir


# 全局配置单例
settings = Settings()
