# Workflow `p3-code` — Quy trình code DAC Pocket P3

## Bản chất
Workflow này **không chạy theo lịch** (không phải cron). Nó được **kích hoạt bằng
lệnh** của Henrry ("Chốt code P3"), vì auto-code theo giờ mà không review sẽ vi
phạm Chốt-gate — luật cao nhất đã Chốt.

Định nghĩa theo cách anh phân biệt:
- **Skill** (`p3-doc`, `8b`) = "làm THẾ NÀO" → workflow này tuân theo cả hai
- **Workflow** (`p3-code`) = "làm CÁI GÌ, KHI NÀO" → cái gì = 6 phase dưới đây,
  khi nào = khi anh ra lệnh từng phase

## Trigger
- `p3` → lệnh tổng: đọc workflow này + skill `p3-doc`, báo trạng thái P3 hiện tại
  (spec/code đang ở đâu, phase nào), rồi đợi lệnh cụ thể của Henrry.
- `Chốt code P3` → bắt đầu Phase 0
- `Chốt phase N` → bắt đầu phase tiếp theo
- Mỗi phase xong → báo cáo + đợi lệnh, KHÔNG tự sang phase mới

## 6 Phase (theo thứ tự ưu tiên mục 7 spec)

| Phase | Việc | Spec | Cửa ra |
|---|---|---|---|
| 0 | Setup: project Android, tích hợp decent-player, verify USB với DAC thật | Kiến trúc 10 điểm | DAC phát được file FLAC qua USB |
| 1 | DSD DoP app-level: custom DSF/DFF extractor, pack marker `0x05`/`0xFA` | 7.1 | Phát được DSD64 qua DoP |
| 2 | Hardware volume: UAC feature-unit `SET_CUR` qua control transfer | 7.5 | Chỉnh volume DAC từ app |
| 3 | Quirks table: Room table `vendorId:productId`, hạt giống từ blocklist UAPP | 7.6 | DAC kén tự nhận config |
| 4 | Buffer config: patch `USB_AUDIO_NUM_URBS` thành parameter JNI | 7.4 | User chỉnh 100/200/400ms |
| 5 | DSD Native v2: alt setting riêng trong driver | 7.2 | Chỉ làm khi v1 ổn định |

## Quy trình mỗi phase (tuân 8b)

```
Suy nghĩ → Trình hướng làm → [Henrry Chốt] → Code → Tự review (tối đa 3 round)
→ Test (QA spec trước) → Cập nhật 3 file doc → Báo cáo → Đợi lệnh phase tiếp
```

1. **Suy nghĩ:** đọc spec + `dac-p3-kien-truc.md` mục liên quan + source lib nếu cần
2. **Trình:** hướng làm ngắn gọn, file nào đổi, rủi ro gì
3. **Chốt:** chỉ code khi Henrry nói "Chốt"
4. **Code:** một việc một lúc, sửa gốc không vá tạm
5. **Tự review:** đọc lại diff như reviewer khó tính, tối đa 3 round
6. **Test:** viết QA spec trước (test gì, expect gì), test bằng thiết bị/DAC thật
   nếu có, không nhờ Henrry test
7. **Đồng bộ doc:** cập nhật 3 file theo skill `p3-doc` nếu có thay đổi kiến trúc
8. **Báo cáo:** gọn — xong gì, test sao, phase tiếp là gì

## Luật cứng
1. Chốt-gate là luật cao nhất — "Chưa code"/"Stop" = dừng ngay, revert sạch
2. TUYỆT ĐỐI KHÔNG BỊA — mọi giá trị từ lib/API verify bằng code thật
3. Không dồn phase — xong phase N, test pass, mới trình phase N+1
4. Mỗi phase xong phải cập nhật 3 file doc nếu kiến trúc thay đổi
5. Metadata v1 dùng MediaMetadataRetriever (lib không có TagLib) — đã Chốt

## Trạng thái hiện tại
- Spec: ĐÃ CHỐT (2026-10-16), mục 7 bổ sung (2026-10-17)
- Code: CHƯA BẮT ĐẦU — đợi lệnh "Chốt code P3"
