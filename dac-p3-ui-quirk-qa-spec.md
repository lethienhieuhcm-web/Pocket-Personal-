# QA Spec — UI Quirk Override (DacSettingsActivity)

**Đối chiếu 3 app:**
- UAPP: hardcode trong `lh4.c()` — user không sửa được
- Neutron: `USBForce1MsPacket` — setting user bật/tắt
- HiBy: `UsbSpeedSettingActivity` — user chọn bus speed

**Quyết định:** cho user override qua UI (như Neutron/HiBy), lưu SharedPreferences.

## 1. Các loại quirk

| Quirk | Kiểu | Giá trị |
|-------|------|---------|
| BLOCKLIST | Bật/tắt | 1 = chặn, 0/không set = cho phép |
| FORCE_1MS_PACKET | Bật/tắt | 1 = ép, 0/không set = tự động |
| BUS_SPEED | Chọn 1 trong 3 | 0=Auto, 1=Full-speed, 2=High-speed |
| FORCE_SAMPLE_RATE | Nhập số | VD 44100, 48000, 96000 (trống = tự động) |
| DISABLE_DSD | Bật/tắt | 1 = tắt DSD, 0/không set = cho phép |

## 2. Hành vi UI

| # | Tình huống | Kỳ vọng |
|---|-----------|---------|
| 1 | Mở DacSettings, DAC có quirk hardcode | Hiện giá trị hardcode + badge "Mặc định" |
| 2 | User bật override | Lưu vào SharedPreferences, badge đổi "Tùy chỉnh" |
| 3 | User tắt override (về mặc định) | Xóa khỏi SharedPreferences, về giá trị hardcode |
| 4 | DAC không có quirk nào | Hiện tất cả ở trạng thái mặc định |
| 5 | Chưa cắm DAC | Quirk section bị disable |

## 3. Vị trí

Thêm section "Tương thích DAC" trong DacSettingsActivity (dưới volume).
