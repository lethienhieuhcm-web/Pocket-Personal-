# English Lab - Danh sách tính năng (backup 2026-10-08)

## Tabs chính
1. **Scan** (`js/features/scan.js`)
   - Chụp ảnh OCR hoặc paste text
   - Tạo bài đọc từ text
   - Lịch sử 10 bài scan gần nhất

2. **Read** (`js/features/read.js`)
   - Hiển thị câu theo dạng cards hoặc article
   - Bấm từ để tra từ điển (5 nguồn)
   - Bấm câu để nghe phát âm
   - Tạo quiz từ bài đọc (AI)
   - Nút AI giải thích từ theo ngữ cảnh

3. **Audio** (`js/features/audio.js`)
   - Thư viện MP3 đã tạo
   - Nghe lại không tốn credits
   - Xóa audio

4. **Books** (`js/features/books.js`)
   - Upload PDF
   - Xử lý qua cron (book_processor.py)
   - Thư viện sách chung (admin duyệt)

5. **Progress** (`js/features/bank.js`)
   - Sổ từ vựng (word bank)
   - Tìm kiếm, lọc theo level
   - Thống kê học tập

6. **Profile** (`js/features/auth.js` - renderProfile)
   - Thông tin tài khoản
   - Nút logout
   - Nâng cấp gói

7. **Settings** (`js/features/settings.js`)
   - Đổi ngôn ngữ (VI/EN/中文/한국어)
   - Dark/light mode
   - Cài đặt giọng đọc

## Tính năng phụ
- **Dictionary** (`js/features/dict.js`): popup tra từ, 5 nguồn
- **TTS** (`js/features/tts.js`): phát âm, tạo MP3
- **AI Tutor** (`worker/src/`): `/api/ai/explain`, `/api/ai/quiz`
- **Vocab Review** (`js/features/vocab.js`): flashcard (TẠM TẮT)
- **Auth** (`js/features/auth.js`): đăng nhập email, Google OAuth

## Backend API (giữ nguyên)
- `/api/auth/*`: login, logout, register, Google OAuth
- `/api/readings`: CRUD bài đọc
- `/api/ai/explain`, `/api/ai/quiz`: AI tutor
- `/api/vocab/*`: flashcard
- `/api/books/*`: sách
