# QA Spec — 7.7 Đổi DAC giữa chừng (USB hot-swap)

## Mục tiêu
Xử lý khi user rút/cắm DAC USB trong lúc app đang chạy.

## Test cases

### 1. Rút DAC đang phát
- **Input:** DAC đang phát nhạc, user rút cáp USB
- **Expect:** Nhạc dừng ngay, hiện thông báo "Đã ngắt kết nối DAC"

### 2. Cắm lại cùng DAC
- **Input:** Sau khi rút, cắm lại đúng DAC đó (cùng vid/pid)
- **Expect:** App tự động nối lại, user có thể phát tiếp không cần restart

### 3. Cắm DAC khác
- **Input:** Cắm DAC khác (vid/pid khác với DAC đang dùng)
- **Expect:** Hiện dialog "Đã cắm DAC khác — cần khởi động lại app để sử dụng"

### 4. Cắm DAC khi chưa có DAC nào
- **Input:** App đang chạy không có DAC, user cắm DAC mới
- **Expect:** App nhận DAC, sẵn sàng phát (không cần restart)

## Lưu ý
- Không có DAC thật để test hardware — verify bằng code review + compile
- Dùng vid/pid để định danh DAC (như Neutron)
