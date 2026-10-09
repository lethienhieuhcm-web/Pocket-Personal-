# Kiến trúc Pocket Personal

> Tài liệu kỹ thuật nội bộ — cập nhật 2026-10-07

## 1. Tổng quan

**Pocket Personal** là bộ ứng dụng cá nhân chạy trên một domain duy nhất: `lethanhdong.one`

| App | URL | Mô tả |
|-----|-----|-------|
| Hub | `/hub` | Trang chính, danh sách app |
| English Lab | `/english/` | Học tiếng Anh: OCR, từ điển, TTS, AI tutor |
| Stocks | `/stocks/` | Chứng khoán Việt Nam (HOSE/HNX/UPCoM) |
| Voice | `/voice/` | Chuyển văn bản thành giọng nói |
| Chess | `/chess/` | Cờ vua (chơi với máy/người) |
| Music | `/music/` | Nghe nhạc + Google Drive |

## 2. Kiến trúc tổng thể

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Browser   │────▶│ Cloudflare Edge  │────▶│   Worker    │
│ (PWA, ES    │     │ (CDN + cache)    │     │ (API + SSR) │
│  modules)   │◀────│                  │◀────│             │
└─────────────┘     └──────────────────┘     └──────┬──────┘
                                                   │
                                          ┌────────┴────────┐
                                          │                 │
                                     ┌──────┴──────┐  ┌──────┴──────┐
                                     │  D1 (SQL)   │  │  R2 (files) │
                                     │  chính      │  │  fallback   │
                                     └─────────────┘  └─────────────┘
```

- **Không có server riêng.** Toàn bộ backend chạy trên Cloudflare Workers (serverless).
- **Không có build step phức tạp.** Frontend là HTML/CSS/JS thuần, ES modules load trực tiếp.

## 3. Frontend

### Cấu trúc thư mục
```
index.html          # English Lab (SPA)
hub.html            # Trang hub
stocks.html         # App chứng khoán
voice.html, chess.html, music.html
design-system.css   # Token màu --pp-*, dùng chung
js/
  core/             # Dùng chung
    dom.js          # $(), esc(), toast()
    state.js        # State toàn app
    api.js          # apiCall() — gọi API kèm auth header
    i18n.js         # 4 ngôn ngữ: VI/EN/中文/한국어
    router.js       # Chuyển tab
  features/         # Theo tính năng
    auth.js         # Đăng nhập/đăng ký
    dict.js         # Từ điển (5 nguồn)
    read.js         # Đọc bài
    scan.js         # OCR/chụp ảnh
    tts.js          # Phát âm
    bank.js         # Kho câu
    vocab.js        # Ôn từ (flashcard)
    audio.js, books.js, settings.js, ...
manifest.json + sw.js  # PWA mỗi app
```

### Quy tắc UI (RULES.md)
- Phone-first (Android + iPhone)
- Không popup/modal → inline hoặc chuyển trang
- Không emoji UI, icon SVG đơn sắc
- Màu duy nhất từ token `--pp-*`
- Mọi chuỗi UI đủ 4 ngôn ngữ ngay khi thêm

## 4. Backend (Cloudflare Worker)

### Cấu trúc
```
worker/src/
  index.js      # Router chính, định nghĩa routes
  auth.js       # Đăng nhập, session, phân quyền, gói cước
  billing.js    # Quota theo gói, đếm usage
  content.js    # TTS, từ điển, dịch
  ai.js         # Gemini AI (explain, quiz)
  vocab.js      # Ôn từ vựng
  stock.js      # API chứng khoán (25 endpoints)
  books.js      # Thư viện sách
  db.js         # Truy vấn D1
  drive.js      # Google Drive (music)
  utils.js      # Hàm chung
worker.js       # File build (esbuild từ worker/src/)
```

### Build & Deploy
```bash
./worker/build.sh     # esbuild → worker.js
python3 ~/workspace/skills/cloudflare/bin/cf_deploy.py
```
- Deploy tự động thêm `?v=<timestamp>` vào URL JS/CSS để phá cache trình duyệt.

### Routes chính
| Method | Path | Mô tả |
|--------|------|-------|
| POST | `/api/auth/login`, `/register` | Đăng nhập/đăng ký |
| GET | `/api/auth/sessions` | Quản lý thiết bị |
| POST | `/api/dict` | Tra từ điển |
| POST | `/api/tts` | Chuyển văn bản → MP3 |
| POST | `/api/ai/explain` | AI giải thích từ theo ngữ cảnh |
| POST | `/api/ai/quiz` | AI tạo quiz từ bài đọc |
| GET/POST | `/api/vocab/*` | Ôn từ vựng |
| GET | `/api/stock/*` | 25 API chứng khoán |

## 5. Database (Cloudflare D1)

SQLite serverless. Database: `pocket-personal`

### Bảng chính
| Bảng | Dùng cho |
|------|----------|
| `users` | Tài khoản, gói cước, mã hoá |
| `sessions` | Session đăng nhập (giới hạn theo gói) |
| `usage_daily` | Đếm quota hàng ngày (dict, tts_chars, ai_calls...) |
| `english_scans` | Lịch sử bài scan |
| `ai_cache` | Cache kết quả AI (tránh gọi trùng) |
| `vocab_reviews` | Lịch ôn từ (spaced repetition) |

### R2 (object storage)
- Bucket `english-lab-auth`: fallback session + file MP3, ảnh
- Kế hoạch cắt R2 fallback sau 1 tuần soak (từ 2026-10-07)

## 6. Xác thực & Bảo mật

- **Đăng nhập:** email/password (bcrypt) + Google OAuth
- **Session:** token ngẫu nhiên, lưu D1, hết hạn 7 ngày
- **Giới hạn thiết bị:** free/hocsinh 1, sinhvien 2, dilam 3, nhadautu 5
- **Mã hoá:** sentence bank mã hoá AES-256 per-user (quên mật khẩu = mất data)
- **Rate limit:** login 10/phút, register 5/giờ, send-code 3/giờ
- **Admin duy nhất:** email set cứng trong code

## 7. Gói cước (5 tier)

| Gói | Giá | App mở |
|-----|-----|--------|
| free | 0đ | chess, music, english |
| hocsinh | 29k | + english nâng cao |
| sinhvien | 49k | + voice |
| dilam | 99k | + stocks cơ bản |
| nhadautu | 149k | + stocks đầy đủ |

Quota AI: free 10 → nhadautu 200 lượt/ngày.

## 8. Tích hợp bên thứ ba

| Dịch vụ | Dùng cho | Ghi chú |
|---------|----------|---------|
| **Gemini** (`gemini-3.8-flash`) | AI giải thích, tạo quiz | Key trong Worker secret `GEMINI_API_KEY` |
| **ElevenLabs** | TTS giọng cao cấp | Fallback về engine free nếu hết quota |
| **Google OAuth** | Đăng nhập | Đã Production, domain xác minh |
| **Cloudflare Email Routing** | Email `lethanhdong.one` | Forward về Gmail |

### Kiến trúc AI
```
Frontend → POST /api/ai/explain → Worker:
  1. Kiểm tra login + quota
  2. Kiểm tra cache (ai_cache)
  3. Gọi Gemini API
  4. Lưu cache + trừ quota
  5. Trả kết quả
```

## 9. Monitoring & Backup

| Việc | Lịch | Công cụ |
|------|------|---------|
| Health check | 15 phút | Cron `pp-health-check` → Telegram nếu lỗi |
| Backup D1 | 03:00 hàng ngày | `d1_backup.py`, giữ 7 bản local |

## 10. Quy trình phát triển (RULES.md)

1. Suy nghĩ → liệt kê → chờ **"Chốt"**
2. Làm từng phase, một lỗi một lần
3. `node --check` sau mỗi file JS
4. Không regex hàng loạt, không JS trong thuộc tính HTML
5. Deploy → test live ngay → mới được báo xong
