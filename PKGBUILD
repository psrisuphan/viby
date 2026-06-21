# Maintainer: YOU <your-email@example.com>
# Contributor: Phuditsaphat Srisuphan (upstream author)

pkgname=viby
pkgver=0.1.0
pkgrel=5
pkgdesc="A modern, minimal, aesthetic local music player"
arch=('x86_64')
url="https://github.com/psrisuphan/viby"
license=('GPL-3.0-only')
depends=(
  'webkit2gtk-4.1'
  'gtk3'
  'libsoup3'
  'cairo'
  'gdk-pixbuf2'
  'glib2'
  'pango'
  'librsvg'
  'xdotool'
  'libayatana-appindicator'
  'alsa-lib'
)
makedepends=(
  'nodejs'
  'npm'
  'rust'
)
# Local-only PKGBUILD: build this checkout, including uncommitted changes.
# AUR/release packaging should use a source tarball instead.
source=()
b2sums=()

prepare() {
  cd "${startdir}"
  npm ci
}

build() {
  cd "${startdir}"
  # Strip LTO flags from CFLAGS — Rust uses lld which cannot read
  # GCC LTO objects produced by C dependencies (e.g. libsqlite3-sys).
  export CFLAGS="${CFLAGS//-flto=auto/}"
  export CFLAGS="${CFLAGS//-flto/}"
  # Skip bundling (AppImage/DEB/RPM) — package() handles Arch packaging
  npm run tauri build -- --no-bundle
}

package() {
  cd "${startdir}"

  # Binary
  install -Dm755 "src-tauri/target/release/viby" \
    "${pkgdir}/usr/bin/viby"

  # Desktop entries: visible launcher plus Wayland app-id aliases for KDE.
  install -Dm644 /dev/stdin "${pkgdir}/usr/share/applications/Viby.desktop" << EOF
[Desktop Entry]
Name=Viby
Comment=A modern, minimal, aesthetic local music player
Exec=/usr/bin/viby
Icon=viby
Type=Application
Categories=AudioVideo;Audio;Music;Player;
StartupNotify=true
StartupWMClass=com.viby.app
Terminal=false
EOF
  install -Dm644 "src-tauri/com.viby.app.desktop" \
    "${pkgdir}/usr/share/applications/com.viby.app.desktop"
  install -Dm644 "src-tauri/viby.desktop" \
    "${pkgdir}/usr/share/applications/viby.desktop"

  # Icons
  install -Dm644 "src-tauri/icons/32x32.png" \
    "${pkgdir}/usr/share/icons/hicolor/32x32/apps/viby.png"
  install -Dm644 "src-tauri/icons/128x128.png" \
    "${pkgdir}/usr/share/icons/hicolor/128x128/apps/viby.png"
  install -Dm644 "src-tauri/icons/128x128@2x.png" \
    "${pkgdir}/usr/share/icons/hicolor/256x256/apps/viby.png"
  install -Dm644 "src-tauri/icons/icon.png" \
    "${pkgdir}/usr/share/icons/hicolor/512x512/apps/viby.png"
  install -Dm644 "src-tauri/icons/32x32.png" \
    "${pkgdir}/usr/share/icons/hicolor/32x32/apps/com.viby.app.png"
  install -Dm644 "src-tauri/icons/128x128.png" \
    "${pkgdir}/usr/share/icons/hicolor/128x128/apps/com.viby.app.png"
  install -Dm644 "src-tauri/icons/128x128@2x.png" \
    "${pkgdir}/usr/share/icons/hicolor/256x256/apps/com.viby.app.png"
  install -Dm644 "src-tauri/icons/icon.png" \
    "${pkgdir}/usr/share/icons/hicolor/512x512/apps/com.viby.app.png"

  # License
  install -Dm644 "LICENSE" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"

  # Target-reference curves (shipped files, also embedded in binary)
  install -dm755 "${pkgdir}/usr/share/viby/target-reference"
  install -m644 target-reference/*.txt \
    "${pkgdir}/usr/share/viby/target-reference/"
}
