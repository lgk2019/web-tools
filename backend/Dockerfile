# 基础镜像：Python 3.11
FROM python:3.11-slim

# 设置工作目录
WORKDIR /app

# 设置环境变量，避免 Python 生成 .pyc 缓存与日志缓冲
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# 安装系统依赖（OpenCV 运行所需）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 先复制依赖文件，利用 Docker 缓存层
COPY requirements.txt .

RUN pip install -r requirements.txt

# 复制应用代码
COPY app/ ./app/

# 暴露服务端口
EXPOSE 8000

# 运行 FastAPI（生产环境可去掉 --reload，并配合多 worker）
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
