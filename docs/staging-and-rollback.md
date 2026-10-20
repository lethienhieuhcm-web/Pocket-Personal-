# Staging + quy trình deploy (stockui Đợt C)

Môi trường:

| Môi trường | Worker | D1 | R2 | URL |
|---|---|---|---|---|
| **Staging** | `fancy-wood-2b3c-staging` | `english-lab-staging` (uuid `79d8f828…`) | chung R2 production (chỉ đọc dữ liệu thị trường) | https://staging.lethanhdong.one |
| **Production** | `fancy-wood-2b3c` | `english-lab` (uuid `e856db4d…`) | R2 production | https://lethanhdong.one |

Deploy bằng `scripts/cf_deploy.py` (mặc định = production, không đổi gì cũ):

```bash
# staging
CF_DEPLOY_SRC="$WT" CF_WORKER_NAME=fancy-wood-2b3c-staging \
  CF_D1_ID=79d8f828-cd52-418a-9f45-d5eb6556ebc8 \
  CF_VERIFY_HOST=staging.lethanhdong.one CF_PURGE=0 CF_DRIFT=0 \
  python3 scripts/cf_deploy.py
# production (như cũ)
python3 scripts/cf_deploy.py
```

Lưu ý staging:

- D1 tách hẳn → session/dữ liệu user test không lẫn production (đã verify: production 0/0/0).
- Secret `STOCK_PUBLISH_SECRET` đã đặt trên worker staging (giống production).
- workers.dev của staging bật (nhưng dùng domain riêng cho sạch).
- Cache purge **không** chạy ở staging (cùng zone production — purge sẽ quét cả production).
- D1 staging: copy schema đầy đủ từ production (51 object), `rule_alerts` có đủ.

## Quy trình từ nay (bắt buộc)

1. Code → push GitHub.
2. Deploy **staging**, test theo 8b.2: API E2E + browser từng tab (session test tạm trong D1 staging).
3. Henrry duyệt trên staging.
4. Deploy **production** (build mới, verify X-Build-Id live).
5. Nếu production lỗi: chạy `scripts/rollback.sh <commit-trước-đó>` (mặc định production;
   thêm `--staging` để rollback staging). Script deploy ref cũ từ worktree tạm,
   không động working tree hiện tại. Schema D1 là additive-only nên rollback code
   không cần rollback schema (bảng mới chỉ bị bỏ qua).

Rollback ghi vào D1? Không — session/test data của staging là dùng 1 lần,
production không bao giờ bị test bằng ref cũ (rollback chỉ deploy code).
