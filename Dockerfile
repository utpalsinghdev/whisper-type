FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY poc/requirements.txt poc/requirements.txt
RUN pip install --no-cache-dir "setuptools<70" -r poc/requirements.txt \
    && pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY backend/ backend/
COPY poc/ poc/

ENV PYTHONPATH=/app/backend:/app
ENV WT_MODEL=base.en.pt

EXPOSE 19527

RUN chmod +x poc/entrypoint.sh
ENTRYPOINT ["poc/entrypoint.sh"]
