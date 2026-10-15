# DAC Player Design Tokens v1.0
# 80/20 Design System — Chốt 2026-10-15
# 80% chung cho Web/iOS/Android, 20% thích ứng theo nền tảng

## Colors (Dark — mặc định)
--dac-bg: #0d1117          # nền chính
--dac-surface: #161b22     # nền card/list
--dac-border: #21262d      # viền
--dac-border-soft: #30363d # viền input
--dac-text: #e6edf3        # chữ chính
--dac-text-dim: #8b949e    # chữ phụ
--dac-accent: #0d9d6c      # xanh lá — màu thương hiệu
--dac-accent-soft: #0d9d6c22  # accent mờ (badge bg)
--dac-error: #f87171       # đỏ lỗi
--dac-error-bg: #ef444422  # nền lỗi

## Colors (Light)
--dac-bg-light: #ffffff
--dac-surface-light: #f6f8fa
--dac-text-light: #1f2328
--dac-text-dim-light: #59636e

## Typography scale
--dac-fs-xs: 11px   # badge
--dac-fs-sm: 12px   # phụ, thời gian
--dac-fs-md: 13px   # breadcrumb
--dac-fs-base: 14px # list item phụ
--dac-fs-lg: 15px   # list item chính
--dac-fs-xl: 16px   # nút
--dac-fs-2xl: 18px  # tiêu đề
--dac-fs-3xl: 20px  # now playing title

## Spacing (4px base)
--dac-sp-1: 4px
--dac-sp-2: 8px
--dac-sp-3: 12px
--dac-sp-4: 16px
--dac-sp-5: 20px
--dac-sp-6: 24px

## Radius
--dac-r-sm: 6px   # badge
--dac-r-md: 8px   # nút, input (dùng --pp-r-md của design-system)
--dac-r-lg: 12px  # card, artwork

## Information Architecture (chung 3 nền tảng)
Tab order: [Bài hát] [Album] [Nghệ sĩ] [Thư mục]
- Mặc định: Bài hát (flat list tất cả nhạc)
- Thư mục: tab phụ cho power user
- Mini player: persistent sau khi phát
- Now Playing: full screen, giống nhau nhất có thể

## Platform adaptations (20%)
### iOS
- Large title, swipe-back gesture
- Tab bar dưới, SF Pro font
- Touch target 44pt

### Android  
- Material 3, top app bar
- Bottom navigation, ripple effect
- Touch target 48dp, Roboto font

### Web
- Responsive card layout
- Sticky header, hover states
