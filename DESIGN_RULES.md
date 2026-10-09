# POCKET PERSONAL — DESIGN RULES (BẮT BUỘC)

> Mọi trang mới PHẢI tuân thủ. Không tự ý đổi style.

## 1. File dùng chung
```html
<link rel="stylesheet" href="/design-system.css">
<body class="pp-body">
```

## 2. Màu sắc (KHÔNG tự chế màu mới)
- Nền: `var(--pp-bg)` / Chữ: `var(--pp-ink)`
- Màu chính DUY NHẤT: `var(--pp-accent)` (#10a37f xanh lá)
- Màu phụ: `var(--pp-mut)` (xám) cho text phụ

## 3. Icon (KHÔNG dùng emoji trong UI)
- Chỉ dùng SVG outline: `<svg class="pp-ic"><use href="#i-xxx"/></svg>`
- Kích thước: 20px (`.pp-ic`), 24px (`.pp-ic.lg`)
- Stroke: 2px, round caps

## 4. Layout chuẩn
```html
<header class="pp-header">
  <a class="pp-back" href="/hub">← Pocket Personal</a>
  <h1 class="pp-title">Tên trang</h1>
</header>
<main class="pp-main">
  <div class="pp-card">...</div>
</main>
```

## 5. Components có sẵn
- `.pp-btn` / `.pp-btn.primary` / `.pp-btn.danger` / `.pp-btn.block` / `.pp-btn.sm`
- `.pp-input`, `.pp-select`, `.pp-label`
- `.pp-card`
- `.pp-tabs` > `.pp-tab.active`
- `.pp-list` > `.pp-item`
- `.pp-empty` (trạng thái trống)
- `.pp-toast` (thông báo)

## 6. Dark mode
- Thêm class `pp-dark` vào `<body>`
- KHÔNG viết CSS dark riêng — dùng biến `var(--pp-*)`

## 7. Responsive (BẮT BUỘC test)
- Mobile < 640px: 1 cột, nút full width
- Tablet 640-1024px: padding lớn hơn
- Desktop > 1024px: dùng `.pp-grid-2` / `.pp-grid-3`
- Test trên: Chrome, Safari, Firefox + mobile Chrome/Safari

## 8. Cấm
- ❌ Emoji làm icon (🔑📌♟️🎵...)
- ❌ Màu custom ngoài palette
- ❌ Font khác system font
- ❌ Inline style cho màu sắc (dùng biến)
