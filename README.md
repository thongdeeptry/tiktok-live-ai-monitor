# 🎵 TikTok Live AI Monitor

Giám sát live TikTok với bảng điều khiển web (theo thời gian thực), âm báo quà tặng và (giai đoạn 2) phản hồi AI.

> Đọc [PLANO.md](./PLANO.md) để xem kế hoạch đầy đủ của dự án.

## 🚀 Cài đặt nhanh

```bash
git clone https://github.com/sonyddr666/tiktok-live-ai-monitor
cd tiktok-live-ai-monitor
pip install -r requirements.txt
cp .env.example .env
python main.py
```

Mở `http://localhost:8000`, nhập `@username` của live và bấm **Kết nối**.

## 📦 Tính năng (v0.1 — chỉ giám sát)

- ✅ Kết nối live qua `@username`
- ✅ Giao diện web dark mode (theo thời gian thực)
- ✅ Chat trực tiếp kèm avatar
- ✅ Luồng quà có hiệu ứng
- ✅ Xếp hạng TOP 10 người tặng quà
- ✅ Đếm: người xem, quà, bình luận, follow, lượt thích
- ✅ **Âm báo khi có quà** (thêm file `web/static/sounds/gift.mp3`)
- ✅ Tự kết nối lại khi lỗi

## 🤖 Giai đoạn 2 — AI (đang phát triển)

Dự kiến dùng **Groq** (miễn phí): đặt `GROQ_API_KEY` và `AI_MODEL` trong `.env` (xem [PLANO.md](./PLANO.md)).

## 🎙 Trợ lý giọng nói miễn phí

- Nhấn **Bắt đầu nói** trên giao diện web để nói bằng mic.
- Trình duyệt chuyển giọng nói sang văn bản (STT), gửi lên Groq để tạo câu trả lời.
- Bot tự đọc lại câu trả lời bằng giọng hệ thống của trình duyệt (TTS).
- Khuyên dùng **Chrome/Edge** để nhận tiếng Việt ổn định hơn.

## 📂 Cấu trúc

```
monitor/collector.py    → bắt sự kiện WebSocket TikTok
web/server.py           → máy chủ FastAPI + WebSocket
web/static/index.html   → giao diện web
web/static/app.js       → JavaScript phía trình duyệt
config/settings.yaml    → toàn bộ cấu hình
PLANO.md                → kế hoạch chi tiết
```

## ⚠️ Cảnh báo

Dự án dùng `TikTokLive`, thư viện **không chính thức**. TikTok thay đổi có thể làm hỏng kết nối.
