# Maintainer: YOU <your-email@example.com>
# Contributor: Phuditsaphat Srisuphan (upstream author)
# Source: https://github.com/psrisuphan/viby

pkgname=viby
pkgver=r667.e6b6a01
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
  'xdotool'
  'libayatana-appindicator'
  'alsa-lib'
)
makedepends=(
  'git'
  'nodejs'
  'npm'
  'cargo'
  'rust'
  'pkg-config'
  'openssl'
)
provides=('viby')
conflicts=('viby')
install="${pkgname}.install"

# Build from local checkout instead of re-cloning.
# Keeps the README flow (clone → cd → makepkg -si) lean.
source=()
b2sums=()

_origin="${PWD}"

pkgver() {
  cd "$_origin"
  ( set -o pipefail
    git describe --long --abbrev=7 2>/dev/null | sed 's/\([^-]*-g\)/r\1/;s/-/./g' ||
    printf "r%s.%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"
  )
}

prepare() {
  mkdir -p "$srcdir"
  ln -sfn "$_origin" "$srcdir/${pkgname}"
  cd "$srcdir/${pkgname}"
  npm ci
}

build() {
  cd "$srcdir/${pkgname}"
  # Strip LTO flags from CFLAGS — Rust uses lld which cannot read
  # GCC LTO objects produced by C dependencies (e.g. libsqlite3-sys).
  export CFLAGS="${CFLAGS//-flto=auto/}"
  export CFLAGS="${CFLAGS//-flto/}"
  npm run tauri -- build --no-bundle
}

package() {
  cd "$srcdir/${pkgname}"

  # Binary
  install -Dm755 "src-tauri/target/release/${pkgname}" \
    "${pkgdir}/usr/bin/${pkgname}"

  # Desktop file
  install -Dm644 "desktop/${pkgname}.desktop" \
    "${pkgdir}/usr/share/applications/${pkgname}.desktop"

  # Icons
  install -Dm644 "src-tauri/icons/32x32.png"   "${pkgdir}/usr/share/icons/hicolor/32x32/apps/${pkgname}.png"
  install -Dm644 "src-tauri/icons/64x64.png"   "${pkgdir}/usr/share/icons/hicolor/64x64/apps/${pkgname}.png"
  install -Dm644 "src-tauri/icons/128x128.png"  "${pkgdir}/usr/share/icons/hicolor/128x128/apps/${pkgname}.png"
  install -Dm644 "src-tauri/icons/128x128@2x.png" "${pkgdir}/usr/share/icons/hicolor/256x256/apps/${pkgname}.png"
  install -Dm644 "src-tauri/icons/icon.png"    "${pkgdir}/usr/share/icons/hicolor/512x512/apps/${pkgname}.png"

  # License
  install -Dm644 "LICENSE" \
    "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"

  # Target-reference curves (shipped files, also embedded in binary)
  install -dm755 "${pkgdir}/usr/share/${pkgname}/target-reference"
  install -m644 target-reference/*.txt \
    "${pkgdir}/usr/share/${pkgname}/target-reference/"
}
