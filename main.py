"""Điểm vào — chạy máy chủ web giám sát."""
import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()

# Tránh httpx lỗi khi SSL_CERT_FILE trỏ file không tồn tại (hay gặp trên Windows).
for _key in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
    _p = (os.environ.get(_key) or "").strip().strip('"').strip("'")
    if _p and not os.path.isfile(_p):
        os.environ.pop(_key, None)

if __name__ == "__main__":
    port = int(os.getenv("WEB_PORT", 8000))
    print(f"\n🎵 Giám sát TikTok Live")
    print(f"   Mở trình duyệt: http://localhost:{port}")
    print(f"   Nhập @username của live trên bảng điều khiển\n")
    uvicorn.run(
        "web.server:app",
        host="0.0.0.0",
        port=port,
        reload=False,
        log_level="warning"
    )
