FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

WORKDIR /app
COPY pyproject.toml README.md ./
COPY gateway ./gateway
RUN pip install --no-cache-dir .

# The database holds the keys, so it belongs on a volume rather than in the
# image layer — a rebuilt container must not come up with an empty key queue.
VOLUME ["/data"]
ENV DATABASE_URL=/data/gateway.db

EXPOSE 8080 50051
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"

CMD ["python", "-m", "gateway", "serve"]
