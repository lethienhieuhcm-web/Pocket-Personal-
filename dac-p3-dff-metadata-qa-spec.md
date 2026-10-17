# QA Spec — Metadata DFF (DIIN chunk)

**Nguồn spec:** Philips DSDIFF 1.5 (2004-04-27), section 3.7 / 3.7.3 / 3.7.4.
Không bịa — mọi field từ spec chính thức.

## 1. Cấu trúc (từ spec)

**DIIN (Edited Master Information Chunk):**
- `ckID` = `'DIIN'` (4 bytes)
- `ckDataSize` = double ulong (8 bytes, **BIG ENDIAN**)
- Chứa các sub-chunk: EMID, MARK, **DIAR** (Artist), **DITI** (Title)
- Optional, tối đa 1 lần trong Form DSD Chunk

**Artist Chunk ('DIAR') — §3.7.3:**
- `ckID` = `'DIAR'`
- `ckDataSize` = double ulong (8 bytes, BE)
- `count` = ulong (4 bytes, BE) — độ dài chuỗi
- `artistText[]` = ASCII (0x20–0x7E), pad 1 byte nếu lẻ (pad không tính trong count)
- Optional, tối đa 1 lần trong DIIN

**Title Chunk ('DITI') — §3.7.4:** giống hệt DIAR, ckID = `'DITI'`.

**Lưu ý:** DSDIFF là BIG ENDIAN toàn bộ (§2.2).

## 2. Trường hợp test

| # | Input | Kỳ vọng |
|---|-------|---------|
| 1 | File DFF có DIIN với DIAR="Artist Name", DITI="Track Title" | Đọc được đúng artist + title |
| 2 | File DFF không có DIIN | Trả về null, không crash |
| 3 | DIIN có DIAR nhưng không có DITI | Artist có, title null |
| 4 | DIIN rỗng (ckDataSize=0) | Trả về null, không crash |
| 5 | count=0 (chuỗi rỗng) | Field đó là chuỗi rỗng hoặc null |
| 6 | Chuỗi có độ dài lẻ (có pad byte) | Đọc đúng count bytes, bỏ pad |
| 7 | DIIN xuất hiện sau chunk DSD | Vẫn tìm thấy (quét toàn bộ header) |

## 3. Cách test (không có DAC thật)

- Tạo file DFF test bằng Python (cấu trúc FRM8 + PROP/SND + DIIN + DSD)
- Verify bằng Python: parse lại file test, so sánh với kết quả Kotlin
- Unit test trên CI: `DffMetadataReaderTest` (nếu viết dạng pure function)

## 4. Tích hợp

- `DffMetadataReader` object (pattern giống `DsfMetadataReader`)
- Trả về `DsdMetadata(title, artist, album=null)` — DFF spec không có album
- Gọi từ nơi `DsfMetadataReader` đang được gọi (đồng nhất)
