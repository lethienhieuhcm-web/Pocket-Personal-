# Fixture raw phiên thử 28/10/2026

Dữ liệu thô của phiên thử InstaBox 28/10 (14:34–15:05), dùng làm cửa GĐ0:
replay 111.900 dòng qua guard, T1 loại đúng 488 dòng cũ, T2 quarantine 391.

- **Nguồn duy nhất còn lại:** R2 `english-lab-data`, prefix
  `instabox-live/20261028/` (9 file, upload 28/10 16:42 ICT). Bản local
  trong `~/workspace/instabox-collector/vm-pull/` đã bị ghi đè bằng dữ
  liệu phiên 29/10 — không dùng nữa, không khôi phục từ đó được.
- **Khôi phục:** `python3 fixtures/restore_from_r2.py --out-dir fixtures/raw-20261028`
  (kiểm chứng: tổng đúng 111.900 dòng, đúng số byte từng file trong MANIFEST.json).
- **Không commit file `*.jsonl` lên git** (20MB) — chỉ commit MANIFEST.json,
  README này và script khôi phục. Test đọc qua `COLLECTOR_RAW_DIR` hoặc
  mặc định tới đúng thư mục này.
