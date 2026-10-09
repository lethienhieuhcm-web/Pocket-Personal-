# Checklist trước mỗi lần deploy (đọc trước khi chạy cf_deploy.py)

## Quy tắc cơ bản (8b)
- [ ] Mỗi lỗi sửa riêng lẻ, đã test từng cái?
- [ ] Không dùng regex replace hàng loạt mà chưa đọc từng chỗ?
- [ ] Không nhúng JS vào thuộc tính HTML (onclick="...")?
- [ ] Chạy `node --check` cho mọi file JS vừa sửa?
- [ ] Đọc lại đoạn HTML vừa sửa bằng mắt thường?
- [ ] Không tối ưu/refactor khi còn bug chưa xong?
- [ ] Sửa gốc, không vá tạm bằng inline script?
- [ ] UI mới đủ 4 ngôn ngữ (VI/EN/中文/한국어)?
- [ ] Không hardcode màu ngoài token `--pp-*`?
- [ ] Không popup/modal, không emoji UI?
- [ ] Không tiết lộ công nghệ/tên gói trong nội dung user?
- [ ] Deploy xong test live ngay đúng chức năng vừa sửa?

## Cache busting chuẩn big tech (thêm 2026-10-09)
- [ ] JS/CSS dùng filename hashing (`foo.a1b2c3.js`), không dùng `?v=`?
- [ ] HTML không còn `?v=` nào sót lại?
- [ ] Tất cả file hash trả HTTP 200 (không 404)?
- [ ] Import trong JS giữ đúng `./` prefix tương đối?
- [ ] Dependency cascade đúng (A import B, B đổi → A cũng đổi tên)?
- [ ] Banner "Có bản mới" hiện đúng 4 ngôn ngữ khi SW update?
- [ ] Banner không phải popup/modal, dùng inline div với token `--pp-*`?
- [ ] User bấm "Cập nhật" mới reload (không tự reload mất dữ liệu)?
- [ ] `asset-manifest.json` được sinh ra để debug mapping?

## Tham khảo big tech (ghi chú)
- Facebook/Google/Vercel dùng filename hashing + SW update prompt
- Không tự reload im lặng khi user đang nhập liệu
- Giữ N bản cũ cho rollback, xóa bản quá cũ
- Source map cho debug (chưa cần vì JS chưa minify)
