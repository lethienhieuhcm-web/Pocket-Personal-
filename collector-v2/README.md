# Bộ thu đủ mã — viết mới hoàn toàn (collector redesign)

Đặc tả Chốt 22:40 28/10 (12 câu): `~/workspace/goals/vietnam-stock-web-app/files/collector-redesign-draft-2026-10-28.md`.
Code này viết mới từ đặc tả; code thử InstaBox (`~/workspace/instabox-collector/collector.py`)
chỉ được ĐỌC để hiểu giao thức cổng — KHÔNG copy.

## Luật đứng

- Ổ local là nguồn sự thật trong phiên; R2/D1 là bản sao sau cửa kiểm.
- Trường thiếu ghi `MISSING`, không điền 0. Trường suy ra ghi cờ `derived`.
- Lỗi ồn ào (log + đếm + trạng thái), không nuốt im lặng.
- TUYỆT ĐỐI không ghi credential/secret vào code, file, log.
- Không đụng production. Mỗi giai đoạn chạy trên staging/shadow.

## Giai đoạn + cửa (§8.3 đặc tả)

- GĐ0 — harness + field map dữ liệu + test trên raw 28/10 (không nối cổng).
  Cửa: replay 111.900 dòng, T1 loại đúng 488 dòng cũ, 0 dòng 28/10 bị loại nhầm.
- GĐ1 — 1 cổng DNSE, shadow đủ phiên, chỉ ghi local + R2 staging.
  ĐÃ CODE 29/10: `collector/wal.py` (WAL JSONL fsync batch, trước queue),
  `collector/consumer.py` (guard + dedup + bucket 7 phần tử + preopen +
  checkpoint 30s), `collector/store.py` (SQLite session.db), `collector/wsclient.py`
  (WebSocket stdlib), `collector/gate.py` (vòng MQTT + backoff + watchdog +
  resubscribe), `collector/session.py` (runner + resume WAL tail).
  Test mock broker offline: `tests/test_gd1_loop.py` + `tests/mock_broker.py`.
  CHƯA LÀM: guard T0 (§4.1, cần lịch quyền + floor/ceiling board — điểm móc
  ở `Consumer.process`), chạy shadow đủ phiên thật (cửa GĐ1 §8.3).
- GĐ2 — + KBS + VNDirect + VPS, merge theo cổng-ưu-tiên.
- GĐ3 — + SSI (SSI Ở NGOÀI bộ thu mới theo Q1; chỉ khi host cho phép).
- GĐ4 — VCI foreign-only (Q7, sau GĐ2).
- GĐ5 — D1 staging đủ mã + đối chiếu toàn diện.
- GĐ6 — Chốt cutover riêng, không tự động.

## Chạy

```sh
python3 -m unittest discover -s tests -v
python3 -m collector.replay --raw-dir ~/workspace/instabox-collector/vm-pull \
  --date 2026-10-28 --out out/replay-20261028
# GĐ1 shadow (cần DNSE_MQTT_USER/DNSE_MQTT_PW trong môi trường, không ghi vào code):
python3 -m collector.session --symbols ACB,VCB --out-dir out/session-20261029 --minutes 5
```

Chỉ dùng stdlib Python 3.12. Không nối mạng, không secret.
