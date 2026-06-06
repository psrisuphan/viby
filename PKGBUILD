# Maintainer: YOU <your-email@example.com>
# Contributor: Phuditsaphat Srisuphan (upstream author)

pkgname=viby
pkgver=0.1.0
pkgrel=1
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
  'libxdo'
  'libappindicator-gtk3'
  'alsa-lib'
)
makedepends=(
  'cargo-tauri'
  'nodejs'
  'npm'
)
# Clone from local checkout (fast, respects .gitignore)
source=("${pkgname}::git+file://${PWD}")
b2sums=('SKIP')

prepare() {
  cd "${srcdir}/${pkgname}"
  npm install
}

build() {
  cd "${srcdir}/${pkgname}"
  npm run tauri build
}

package() {
  cd "${srcdir}/${pkgname}"

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
}
