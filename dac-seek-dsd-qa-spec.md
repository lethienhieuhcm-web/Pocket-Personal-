# QA Spec — Seek DSD (DSF/DFF)

Ngày: 2026-10-17 | Theo 8b: viết trước khi code

## Test gì
- `DsfExtractor`: seek tới vị trí thời gian bất kỳ
- `DffExtractor`: seek tới vị trí thời gian bất kỳ
- Duration tính đúng từ sampleCount/sampleFreq

## Expect
| Input | Expect |
|---|---|
| DSF DSD64 (2.8MHz), seek tới 50% | byte position ≈ giữa data chunk, block-aligned |
| DSF seek tới 0 | về đầu data chunk |
| DSF seek tới duration | về cuối (clamp) |
| DFF seek tới 50% | byte position ≈ giữa data |
| `isSeekable()` | true (thay vì Unseekable) |
| `getDurationUs()` | = sampleCount * 1_000_000 / sampleFreq |

## Cách test
1. Python replicate tính toán seek position
2. Unit test với file DSF/DFF mẫu (nếu có) hoặc mock
3. CI build pass

## Không test
- DAC thật (chưa có hardware)
- Độ chính xác sample-accurate (chấp nhận block-aligned cho v1)
