# Maintainer: YOU <your-email@example.com>
# Contributor: Phuditsaphat Srisuphan (upstream author)

pkgname=viby
pkgver=0.1.0
pkgrel=3
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
  'libappindicator'
  'alsa-lib'
)
makedepends=(
  'cargo-tauri'
  'nodejs'
  'npm'
)
# Build from the local working tree so uncommitted source changes are included.
# Do not use git+file:// here: makepkg would clone committed HEAD only.
source=()
b2sums=()

prepare() {
  cd "${startdir}"
  npm install
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

  # Desktop entry
  install -Dm644 /dev/stdin "${pkgdir}/usr/share/applications/viby.desktop" << EOF
[Desktop Entry]
Name=Viby
Comment=A modern, minimal, aesthetic local music player
Exec=/usr/bin/viby
Icon=viby
Type=Application
Categories=Audio;Music;Player;
StartupNotify=true
Terminal=false
EOF

  # Icons
  install -Dm644 "src-tauri/icons/32x32.png" \
    "${pkgdir}/usr/share/icons/hicolor/32x32/apps/viby.png"
  install -Dm644 "src-tauri/icons/128x128.png" \
    "${pkgdir}/usr/share/icons/hicolor/128x128/apps/viby.png"
  install -Dm644 "src-tauri/icons/128x128@2x.png" \
    "${pkgdir}/usr/share/icons/hicolor/256x256/apps/viby.png"
  install -Dm644 "src-tauri/icons/icon.png" \
    "${pkgdir}/usr/share/icons/hicolor/scalable/apps/viby.png"

  # License
  install -Dm644 "LICENSE" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"

  # Target-reference curves (shipped files, also embedded in binary)
  install -dm755 "${pkgdir}/usr/share/viby/target-reference"
  install -m644 target-reference/*.txt \
    "${pkgdir}/usr/share/viby/target-reference/"
}
