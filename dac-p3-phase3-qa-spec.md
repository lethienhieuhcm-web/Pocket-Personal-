# QA Spec — Phase 3: Quirks (7.6) — bản mới không Room

Ngày: 2026-10-17 | Spec: hardcode Kotlin object + SharedPreferences (sửa 2026-10-17)

## Test gì
- `DacQuirks` object: lookup quirks đồng bộ theo vendorId/productId
- Blocklist: vendor 1478, 4184, 1133 → bị chặn
- User override qua SharedPreferences: set/get/xóa
- Wildcard vendor (pid=0xFFFF) áp dụng cho mọi product

## Expect
| Input | Expect |
|---|---|
| `isBlocklisted(1478, 0x1234)` | true (UAPP blocklist) |
| `isBlocklisted(0x1234, 0x5678)` | false (không trong list) |
| `getQuirk(vid, pid, FORCE_1MS)` | trả quirk hoặc null |
| User set `FORCE_1MS=true` cho DAC | `getUserOverride()` trả true |
| User xóa override | về giá trị hardcode |

## Cách test
1. Unit test `DacQuirksTest` (không cần Context cho hardcode; dùng Robolectric hoặc mock cho prefs)
2. CI emulator-test

## Không test
- DAC thật (chưa có hardware)
