#!/usr/bin/env bash
#
# Render the Homebrew cask for the GeoInt desktop app.
#
# The macOS DMGs are signed with an Apple Developer ID certificate and notarized
# by Apple, so they install and launch without a quarantine workaround.
#
# GeoInt is now published in the official homebrew/homebrew-cask repository
# (Casks/g/geoint.rb), which is what users install via `brew install --cask
# geoint`. This script renders the cask for the self-hosted tap
# (opengeos/homebrew-geoint), which is kept as a fallback and updated by the
# release workflow. See scripts/render-official-cask.sh for the official cask.
#
# Usage:
#   VERSION=1.2.0 \
#   SHA256_ARM=<sha256 of GeoInt.Desktop_<version>_aarch64.dmg> \
#   SHA256_INTEL=<sha256 of GeoInt.Desktop_<version>_x64.dmg> \
#   scripts/render-homebrew-cask.sh > Casks/geoint.rb
#
# All three variables are required. The rendered cask is written to stdout.
set -euo pipefail

: "${VERSION:?Set VERSION to the release version, e.g. 1.2.0}"
: "${SHA256_ARM:?Set SHA256_ARM to the sha256 of the aarch64 DMG}"
: "${SHA256_INTEL:?Set SHA256_INTEL to the sha256 of the x64 DMG}"

# Validate formats so a truncated hash or stray metacharacter can't silently
# produce a malformed cask that only fails at `brew install` time.
[[ "$SHA256_ARM" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256_ARM is not a 64-char sha256 hex string" >&2; exit 1; }
[[ "$SHA256_INTEL" =~ ^[0-9a-f]{64}$ ]] || { echo "SHA256_INTEL is not a 64-char sha256 hex string" >&2; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || { echo "VERSION does not look like a semver string" >&2; exit 1; }

REPO="${REPO:-opengeos/GeoLibre}"

cat <<RUBY
cask "geoint" do
  version "${VERSION}"

  on_arm do
    sha256 "${SHA256_ARM}"

    url "https://github.com/${REPO}/releases/download/v#{version}/GeoInt.Desktop_#{version}_aarch64.dmg",
        verified: "github.com/${REPO}/"
  end
  on_intel do
    sha256 "${SHA256_INTEL}"

    url "https://github.com/${REPO}/releases/download/v#{version}/GeoInt.Desktop_#{version}_x64.dmg",
        verified: "github.com/${REPO}/"
  end

  name "GeoInt Desktop"
  desc "Lightweight, cloud-native GIS platform"
  homepage "https://geolibre.app/"

  app "GeoInt Desktop.app"

  zap trash: [
    "~/Library/Application Support/org.geoint.desktop",
    "~/Library/Caches/org.geoint.desktop",
    "~/Library/Preferences/org.geoint.desktop.plist",
    "~/Library/Saved Application State/org.geoint.desktop.savedState",
    "~/Library/WebKit/org.geoint.desktop",
  ]
end
RUBY
