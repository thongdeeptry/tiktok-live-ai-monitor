# 🎯 TikTok Live AI Monitor — Kế hoạch chi tiết

> Phiên bản: 1.0  
> Trạng thái: Đang phát triển

---

## 📋 Tổng quan

Hệ thống giám sát live TikTok theo thời gian thực, thu thập sự kiện (quà tặng, bình luận, người xem, lượt thích) và dùng AI ở chế độ **hội thoại** để phản hồi thông minh cho cả streamer và chat — có kiểm soát chi phí token.

---

## 🏗️ Kiến trúc dự án

```
tiktok-live-ai-monitor/
├── PLANO.md                   ← File này
├── monitor/
│   ├── collector.py           ← Bắt sự kiện TikTokLive (WebSocket)
│   ├── profile_fetcher.py     ← Lấy hồ sơ người dùng (tùy chọn)
│   └── event_buffer.py        ← Buffer sự kiện theo cửa sổ thời gian/số lượng
├── ai/
│   ├── ai_agent.py            ← Agent AI chế độ hội thoại
│   ├── prompt_builder.py      ← Ghép ngữ cảnh tối ưu (tránh lãng phí token)
│   └── turn_controller.py     ← Điều khiển khi gọi AI
├── web/
│   ├── server.py              ← Backend FastAPI + WebSocket
│   ├── static/
│   │   ├── index.html         ← Giao diện web
│   │   ├── app.js             ← JavaScript frontend + WebSocket
│   │   └── sounds/
│   │       └── gift.mp3       ← Âm thanh quà tặng
│   └── templates/
├── config/
│   └── settings.yaml          ← Toàn bộ cấu hình hệ thống
├── requirements.txt
└── main.py                    ← Điểm vào chương trình
```

---

## ⚙️ Giai đoạn 1 — Chỉ giám sát dữ liệu (KHÔNG AI)

> **Mục tiêu:** Kết nối bất kỳ live nào qua @username, hiển thị dữ liệu theo thời gian thực trên web và có âm thanh khi có quà.

### Sự kiện thu được
| Sự kiện | Dữ liệu thu |
|---------|-------------|
| `GiftEvent` | user, gift_name, coin_value, repeat_count, avatar_url |
| `CommentEvent` | user, nội dung, timestamp |
| `JoinEvent` | user, timestamp |
| `LikeEvent` | user, like_count |
| `FollowEvent` | user |
| `ShareEvent` | user |
| `RoomUserSeqEvent` | viewer_count |
| `LiveEndEvent` | — kết thúc giám sát |

### Bảng điều khiển web (giai đoạn 1)
- Ô nhập `@username` bất kỳ và nút kết nối
- Bảng **người xem theo thời gian thực**
- Luồng bình luận trực tiếp
- Luồng quà kèm tên và giá coin
- **Xếp hạng TOP 10 người tặng quà** cập nhật theo thời gian thực
- **Âm báo** khi có quà (file `.mp3` cục bộ)
- Tự động kết nối lại khi rớt mạng

---

## 🤖 Giai đoạn 2 — Tích hợp AI (chế độ hội thoại)

### Ý chính
AI hoạt động **hội thoại liên tục** — nhớ ngữ cảnh live và trả lời cho streamer lẫn chat. Dữ liệu được gom trước khi gửi AI để **giảm token**.

### Chế độ kích hoạt AI

Cấu hình trong `settings.yaml`:

```yaml
ai:
  trigger_mode: "turn"          # turn | message_threshold | gift | hybrid
  
  turn:
    interval_seconds: 60        # Mỗi 60s gom hết và gửi cho AI
    
  message_threshold:
    max_messages: 20            # Kích hoạt khi đủ 20 tin nhắn
    low_activity_threshold: 3   # Live ít người: có thể gửi sớm hơn
    
  gift:
    enabled: true               # Luôn gửi khi có quà
    lookup_profile: true        # true = tra hồ sơ người tặng
    profile_mode: "name_only"   # name_only | full_profile
```

#### Chế độ `turn` (theo lượt)
- Gom sự kiện trong buffer `X` giây
- Gom: quà nhận, bình luận quan trọng, follower mới, số người xem
- Gửi một prompt nén duy nhất cho AI
- AI trả về phân tích lượt + gợi ý tương tác cho streamer

#### Chế độ `message_threshold` (theo khối lượng)
- Theo dõi mức độ chat theo thời gian thực
- **Live đông:** gom nhiều tin hơn rồi mới gửi
- **Live vắng:** gửi nhanh hơn để giữ tương tác
- Tham số: `max_messages`, `low_activity_threshold` (tin/phút)

#### Chế độ `gift` (theo quà)
- Mỗi lần có quà → gửi phân tích
- **`name_only`:** AI chỉ nhận tên/username người tặng (ít chi phí)
- **`full_profile`:** hệ thống lấy hồ sơ công khai (followers, bio, avatar) trước khi gửi AI
- AI trả lời cá nhân hóa nhắc người tặng

#### Chế độ `hybrid`
- Kết hợp gift (luôn) + turn (dự phòng theo thời gian)

---

## 💰 Kiểm soát chi phí token

Đây là phần quan trọng nhất.

### Chiến lược (theo thiết kế)

#### 1. Nén ngữ cảnh
Thay vì gửi từng tin, `prompt_builder.py` nén buffer:

```
# Kém (tốn token):
"Carlos: hi", "Carlos: vẫn ở đây", "Carlos: nhạc đi"

# Tốt (ít token):
"Carlos (3 tin): hi, vẫn ở đây, nhạc đi"
```

#### 2. Cửa sổ ngữ cảnh trượt
- AI chỉ giữ **N lượt** gần nhất
- Cấu hình: `ai.context_window_turns: 5`
- Lượt cũ bỏ khỏi ngữ cảnh

#### 3. Lọc sự kiện không cần thiết
- `JoinEvent` user không có lịch sử → bỏ
- Like lặp cùng user → gộp (`Carlos thích 47 lần`)
- Spam/lặp bình luận → lọc

#### 4. Hệ thống ưu tiên
```yaml
ai:
  priority_filter:
    gifts: always           # Quà LUÔN vào AI
    followers: always       # Follower mới LUÔN
    comments: if_relevant # Bình luận chỉ khi đạt tiêu chí
    joins: never            # Vào phòng KHÔNG gửi AI
    likes: aggregate_only   # Chỉ gửi tổng gộp
```

#### 5. Ngân sách theo giờ
```yaml
ai:
  token_budget:
    max_tokens_per_hour: 50000   # Giới hạn token/giờ
    alert_at_percent: 80         # Cảnh báo khi đạt 80%
    fallback_mode: "turn_only"   # Vượt ngân sách → chỉ chế độ turn, interval lớn hơn
```

---

## 👤 Module hồ sơ người dùng

### Khi bật
- Chỉ với sự kiện `gift`
- Chỉ khi `profile_mode: full_profile`
- Cache hồ sơ trong phiên → không gọi lặp

### Dữ liệu lấy về (ví dụ)
```python
profile = {
    "unique_id": "@carlos123",
    "nickname": "Carlos",
    "follower_count": 1520,
    "following_count": 340,
    "bio": "fan của streamer",
    "avatar_url": "...",
    "is_follower": True,
}
```

### Prompt tối thiểu (ví dụ)
```
[GIFT] @carlos123 (Carlos, 1.5k follower, đã follow bạn) gửi 5x "Rose" (5 coin mỗi cái)
```

---

## 🔁 Luồng đầy đủ của AI

```
TikTok Live
    │
    ▼
collector.py ──► event_buffer.py
                      │
               turn_controller.py
               (kiểm tra trigger_mode)
                      │
               profile_fetcher.py  ◄── (chỉ khi gift + full_profile)
                      │
               prompt_builder.py
               (nén + lọc)
                      │
               ai_agent.py  ◄──── giữ lịch sử hội thoại
                      │
               [Phản hồi AI]
                      │
            ┌─────────┴──────────┐
            ▼                    ▼
      Bảng điều khiển web    Console / nhật ký
   (hiển thị streamer)      (gỡ lỗi)
```

---

## 🛠️ Công nghệ

| Tầng | Công nghệ |
|------|-----------|
| Thu live | `TikTokLive` (Python, isaackogan) |
| Backend API | `FastAPI` + `uvicorn` |
| WebSocket | `FastAPI WebSocket` |
| Frontend | HTML + JavaScript thuần (không framework) |
| AI | Groq (Llama/Mixtral, miễn phí) / OpenAI / Gemini (cấu hình được) |
| Cấu hình | `PyYAML` |
| Cache hồ sơ | Dict trong RAM (theo phiên) |
| Âm thanh | HTML5 Audio API |

---

## 📦 Lộ trình phiên bản

### v0.1 — Chỉ web giám sát ✅ (hiện tại)
- [ ] Kết nối mọi live qua @username
- [ ] Bảng điều khiển theo thời gian thực
- [ ] Xếp hạng quà
- [ ] Âm thanh khi có quà
- [ ] Tự kết nối lại

### v0.2 — AI cơ bản
- [ ] Tích hợp model (Groq miễn phí — Llama/Mixtral — hoặc GPT/Gemini)
- [ ] Chế độ `turn` chạy được
- [ ] Prompt builder có nén
- [ ] Hiển thị câu trả lời trên bảng điều khiển

### v0.3 — Kiểm soát nâng cao
- [ ] `message_threshold` + nhận diện mức độ hoạt động
- [ ] `gift` + hồ sơ người dùng
- [ ] Ngân sách token + fallback
- [ ] Cài đặt qua UI (không sửa YAML)

### v0.4 — AI hội thoại
- [ ] AI trả lời trực tiếp streamer (chat)
- [ ] Cửa sổ ngữ cảnh trượt
- [ ] Xuất lịch sử phiên

---

## 🔐 Biến môi trường

```env
TIKTOK_USERNAME=@username_cua_ban
GROQ_API_KEY=gsk_...   # miễn phí tại https://console.groq.com
AI_MODEL=llama-3.3-70b-versatile
# Tùy chọn sau này: OPENAI_API_KEY=..., GEMINI_API_KEY=...
WEB_PORT=8000
```

---

## ⚠️ Lưu ý quan trọng

- `TikTokLive` là thư viện **không chính thức**, dựa reverse engineering
- Thường cần `SignAPI` (Euler Stream) — có giới hạn tần suất
- Hồ sơ user lấy qua scraping, không phải API chính thức TikTok
- Mỗi phiên live là một instance client mới
