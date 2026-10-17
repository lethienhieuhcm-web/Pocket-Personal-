# QA Spec — UI Volume (DacSettingsActivity)

**Đối chiếu 3 app:**
- UAPP: có `USBMixerUnit` — hardware volume qua UAC Feature Unit
- Neutron: không đề cập volume USB
- HiBy: **khóa volume USB** để giữ bit-perfect

**Quyết định (Henrry Chốt):** cho phép hardware volume như UAPP, mặc định 100 (max, bit-perfect),
hiển thị badge "Hardware".

## 1. Hành vi

| # | Tình huống | Kỳ vọng |
|---|-----------|---------|
| 1 | DAC có Feature Unit, mở DacSettings | Hiện SeekBar 0–100, giá trị = volume đã lưu (mặc định 100) |
| 2 | Kéo SeekBar | Gọi `UsbVolumeController.setVolume()` ngay, lưu per-DAC |
| 3 | DAC không có Feature Unit | Ẩn SeekBar, hiện text "DAC này không hỗ trợ điều khiển âm lượng phần cứng" |
| 4 | Chưa cắm DAC | Volume section bị disable (như DSD method) |
| 5 | Volume = 100 | Badge "Hardware • Tối đa (bit-perfect)" |
| 6 | Volume < 100 | Badge "Hardware" |

## 2. Lưu trữ

- Key: `"${dacId}|||Volume"` (0–100, mặc định 100)
- Dùng `DacSettings` (SharedPreferences per-DAC đã có)

## 3. Không test được không có DAC thật

- Logic `UsbVolumeController` đã có unit test (`UsbVolumeControllerTest`)
- UI chỉ là SeekBar + gọi controller — verify bằng review code
- Test thật cần DAC có Feature Unit
