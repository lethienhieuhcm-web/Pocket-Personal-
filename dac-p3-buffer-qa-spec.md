# QA Spec — Buffer Config (7.4)

**Đối chiếu 3 app:**
- UAPP: DoubleBuffer lót đĩa theo block
- Neutron: phơi UI Hardware/Software Latency, Low Latency mode
- HiBy: không đề cập

**Spec:** patch `USB_AUDIO_NUM_URBS` (hardcode 80) thành parameter qua JNI.

## 1. Thay đổi native (C++)

| File | Thay đổi |
|------|----------|
| `usb-audio-output.h` | `UrbSlot ring[80]` → `UrbSlot *ring` + thêm `int numUrbs` |
| `usb-audio-output.cpp` | `allocRing`/`freeRing` dùng `ctx->numUrbs`; 5 chỗ `% USB_AUDIO_NUM_URBS` → `% ctx->numUrbs` |
| JNI bridge | Thêm `setUrbCount(int)` |

**Rủi ro:** thay đổi struct layout — phải đảm bảo mọi chỗ dùng `ring[]` đều qua `ctx->numUrbs`.

## 2. Thay đổi Kotlin

- `DacSettings`: thêm `getBufferMs`/`setBufferMs` (100/200/400, mặc định 200?)
- `DacSettingsActivity`: thêm RadioGroup chọn buffer
- Gọi JNI `setUrbCount` khi áp dụng (cần restart stream?)

## 3. Câu hỏi chưa rõ

- Đổi buffer có cần restart stream không? (Có — ring allocate lúc tạo stream)
- Giá trị mặc định: giữ 80 URBs (~80ms) hay đổi?

## 4. Test

- Không có DAC thật → chỉ verify compile + unit test logic chuyển đổi ms→URBs
- Test thật cần DAC
