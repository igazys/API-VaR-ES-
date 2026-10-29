FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
EXPOSE 8000
# 0.0.0.0 is needed inside the container; publish the port on 127.0.0.1 only:
#   docker run -p 127.0.0.1:8000:8000 tail-risk
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
