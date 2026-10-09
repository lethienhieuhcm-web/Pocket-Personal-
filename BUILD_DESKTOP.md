# Build Desktop App English Lab (Tauri 2)

Project đã setup xong tại `~/workspace/english-lab/src-tauri/`:
- `tauri.conf.json` (appId: com.lethanhdong.englab, dùng `www/` làm frontend)
- `Cargo.toml`, `src/main.rs`, `build.rs`
- Icons từ `www/icon-*.png`

## Chuẩn bị (mỗi máy build 1 lần)

### macOS
```bash
# Cài Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Cài Tauri CLI
cargo install tauri-cli
```

### Windows
1. Cài Rust từ https://rustup.rs
2. Cài Visual Studio Build Tools (chọn "Desktop development with C++")
3. Cài WebView2 (có sẵn trên Win10/11)
4. `cargo install tauri-cli`

### Linux (Ubuntu/Debian)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf
cargo install tauri-cli
```

## Build

```bash
cd ~/workspace/english-lab
# Sync web files mới nhất vào www/
cp index.html manifest.json sw.js www/
cp -r js www/
# Build
cargo tauri build
```

Output:
- macOS: `src-tauri/target/release/bundle/dmg/English Lab_1.0.0_*.dmg`
- Windows: `src-tauri/target/release/bundle/msi/English Lab_1.0.0_*.msi`
- Linux: `src-tauri/target/release/bundle/deb/english-lab_1.0.0_*.deb`

## Dev mode (chạy thử)

```bash
cargo tauri dev
```

## Lưu ý
- Mỗi lần sửa web code: copy files vào `www/` rồi build lại
- Icon: thay files trong `src-tauri/icons/` rồi build lại
- Bundle identifier: `com.lethanhdong.englab` (giữ nguyên để nhất quán với mobile)
