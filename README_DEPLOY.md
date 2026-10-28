# Deploy chan SSI len Botkeep relay-2 (thu 28/10)

## File
- `ssi_relay2_deploy.zip`: `ssi_relay2.py` + goi `websockets/` dong goi kem.
  Giai nen ngay thu muc goc cua server (script + thu muc websockets
  nam canh nhau). Khong can pip install.

## Start command (panel relay-2)
```
sh -c 'set -a; . ./.env; set +a; exec python3 ssi_relay2.py'
```
(mau theo relay-4; `.env` do panel ghi tu muc Environment.)

## Environment (panel relay-2, muc Environment / .env)
Bat buoc:
- `SSI_PROXY_URL` — URL proxy HTTP CONNECT (proxyvip)
- `STOCK_PUBLISH_SECRET` — secret publish len Worker
Khuyen nghi (code co fallback tu trich bundle SSI cong khai,
nhung tu IP Botkeep chua chac lay duoc):
- `SSI_USER`
- `SSI_PW`

## Hanh vi
- Tu doi khung phien 08:50-15:05 T2-T6 (ICT); ngoai phien ngu.
- Noi SSI qua proxy, subscribe 42 ma B200 + pe + i/VNINDEX + i/VN30.
- Publish 60s/lan ve `https://lethanhdong.one/api/internal/stock-publish`
  voi SRC `ssi-relay2-20261028` (nhanh rieng, khong dung prefix bong SSI
  hay live).

## Kiem tra sau deploy (truoc 13:00)
Console phai co:
- `[ssi-relay2] vao phien ... proxy_present=True`
- `[ssi-shadow] bat dau ...` (log goc cua session_loop)
- `[ssi-shadow] publish ok msgs=...` moi 60s (sau khi noi duoc)
Neu thay `publish loi` hoac `CONNACK`/`403`: secret hoac proxy sai.

## Test da chay (VM, khong secret that)
`test_smoke.py`: PASS 7/7 — vendored websockets 17.3, config tu env,
build_payload dung SRC, publish ve stub, client MQTT/WS that voi
server stub (snapshot + raw line dung), supervisor window 5/5.
