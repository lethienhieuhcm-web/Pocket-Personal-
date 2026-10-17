# DAC Pocket — Trạng Thái Công Việc (không mất khi restart)

**Cập nhật:** 15/10/2026 16:35 +07
**Spec cuối:** `~/workspace/user/files/DAC-Player-Unified-Spec-Final_3_0jsr.md`

---

## Tổng quan

| Phase | Trạng thái |
|---|---|
| 1 — Web | ✅ Xong (CSP live, browser test pass) |
| 2 — APK | ✅ Xong (R8, build, upload R2, trang /dac cập nhật) |
| 3 — iOS | ✅ Xong (MiniPlayer, CI SUCCESS) |
| 4 — Tích hợp | ✅ Xong (link DAC trong Music app) |
| 5 — Bảo mật+ | 📋 Chờ >1000 user |

---

## APK hiện tại (live)

- **URL tải:** https://lethanhdong.one/dac-player-debug.apk
- **Trang giới thiệu:** https://lethanhdong.one/dac
- **Size:** 12,176,132 bytes (11.6 MB)
- **SHA-256:** `19ca6b3125e2b899b7f817114abad5e380000ab13b849595bb31adcb4772622e`
- **Version:** 0.5.0 (versionCode 6)
- **Build từ:** CI run 38700284843 (R8 enabled)
- **Backup local:** `~/workspace/english-lab/hidden_files/apk-backup/dac-player-deploy-20261015.apk`
- **R2 key:** `english-lab-data/dac-player-debug.apk`

### Quy trình update APK mới (TỰ ĐỘNG 100% — verified 15/10/2026)
1. Push code Android → CI tự build
2. Workflow tự publish lên GitHub Release (tag `dac-apk-<run_number>`) ✅
3. Tải APK từ Release (public, không cần token): `https://github.com/lethienhieuhcm-web/Pocket-Personal-/releases/download/<tag>/app-deploy.apk`
4. Upload lên R2: `python3` với `_auth_request` từ `scripts/cf_deploy.py`
5. Cập nhật `dac.html` (size + SHA256) → deploy → push GitHub

**Release mới nhất:**
- APK: dac-apk-214 (15/10/2026) — https://github.com/lethienhieuhcm-web/Pocket-Personal-/releases/download/dac-apk-214/app-deploy.apk
- IPA: dac-ipa-52 (15/10/2026) — https://github.com/lethienhieuhcm-web/Pocket-Personal-/releases/download/dac-ipa-52/DACPlayer-unsigned.ipa

---

## iOS hiện tại

- **CI:** Run 38708952533 SUCCESS
- **MiniPlayer:** `dac-player-ios/DACPlayer/MiniPlayer.swift` (mới)
- **Lưu ý:** File Swift mới phải thêm vào `project.pbxproj` (4 chỗ)

---

## Web hiện tại

- **URL:** https://lethanhdong.one/dacplayer/
- **CSP:** đã bật (global trong `worker/src/index.js`)
- **Music link:** nút DAC trong `/music/` bottom nav

---

## Fix OAuth redirect (15/10/2026 18:45)
- Bug: OAuth callback hardcode về /english/, 3 web app bị nhảy sai chỗ
- Fix: state = token|return_path, validate chống open redirect
- Test: 4/4 PASS (dacplayer, default, evil.com blocked, music)
- Native apps không bị (dùng SDK trực tiếp)

## Redesign 80/20 — HOÀN TẤT 3 nền tảng (15/10/2026 20:35)
- Design tokens: dac-design-tokens.md
- Backend: /api/dac/library (flat list từ dac_index) — test PASS
- Web: tabs [Bài hát][Album][Nghệ sĩ][Thư mục], build 20261015131713 LIVE
- iOS: segmented control trong LibraryView + AlbumListView/ArtistListView, dùng /api/dac/library
- Android: TabLayout Material + listLibrary(), grouping theo album/artist
- Tất cả đã push GitHub main

## Redesign 80/20 — Web xong (15/10/2026 20:30)
- Design tokens: dac-design-tokens.md (màu, font, spacing, IA)
- Backend: /api/dac/library (flat list từ dac_index)
- Web: tabs [Bài hát][Album][Nghệ sĩ][Thư mục], mặc định Bài hát
- Deploy build 20261015131713, GitHub pushed
- Test: /api/dac/library PASS (3/3 tracks)

## Fix Drive connect flow (15/10/2026 18:55)
- Bug 2: frontend đợi ?drive_token= nhưng backend trả ?drive=ok → không nhận ra đã kết nối
- Fix: check /api/drive/status từ server, bỏ phụ thuộc token ở client
- Deploy build 20261015115251, GitHub SYNC (push timeout nhưng commit land)

## Vấn đề còn mở

1. **GitHub App thiếu quyền "Workflows"** (403 khi ghi `.github/workflows/`)
   - Nguyên nhân: App manifest của Meta không khai báo quyền này
   - Workaround: upload workflow qua browser (GitHub web)
   - Không block công việc chính

2. **Server-side Drive token** (theo spec ADR)
   - Đã Chốt trong spec, chưa implement
   - Cần làm khi bắt đầu vòng tiếp theo

---

## Links quan trọng

- Spec: `~/workspace/user/files/DAC-Player-Unified-Spec-Final_3_0jsr.md`
- Plan cũ: `~/workspace/your_files/dac-player-thong-nhat-final.md`
- Repo: `lethienhieuhcm-web/Pocket-Personal-` (branch main)
- Worker: `fancy-wood-2b3c`
- Live: https://lethanhdong.one

---

## Bài học (đã lưu vào AGENTS.md)

1. Không dùng `muse.write` cho file >50 dòng — dùng edit surgical
2. File Swift mới phải thêm vào `project.pbxproj` tay
3. File quan trọng để ở `~/workspace/`, không để `/tmp/` (mất khi restart)
4. `push_files` timeout nhưng commit vẫn land — verify bằng đọc lại remote
5. GitHub App không ghi được workflow (403) — dùng browser upload
