# gitdesk from its Linux release archive. The release workflow publishes a copy of this file with
# the version, file name and hash filled in, as gitdesk.nix beside the archive. Build that copy with:
#   nix-build -E 'with import <nixpkgs> {}; callPackage ./gitdesk.nix {}'
# or add `(pkgs.callPackage ./gitdesk.nix {})` to environment.systemPackages.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  makeDesktopItem,
  copyDesktopItems,
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  git,
  glib,
  gtk3,
  libdrm,
  libgbm,
  libGL,
  libnotify,
  libsecret,
  libxkbcommon,
  nspr,
  nss,
  pango,
  systemd,
  xorg,
}:

let
  version = "1.0.0";
  file = "gitdesk-1.0.0-linux-x64.tar.gz";
  hash = lib.fakeHash;
in
stdenv.mkDerivation {
  pname = "gitdesk";
  inherit version;

  src = fetchurl {
    url = "https://github.com/BotCoder254/gitdesk-releases/releases/download/v${version}/${file}";
    inherit hash;
  };

  # The archive may wrap its files in one folder named after the release.
  unpackPhase = ''
    runHook preUnpack
    mkdir source
    tar -xzf "$src" -C source
    if [ ! -e source/gitdesk ]; then mv source/*/* source/; fi
    runHook postUnpack
  '';
  sourceRoot = "source";

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
    copyDesktopItems
  ];

  # The libraries Electron's prebuilt binary links against (nixpkgs electron/binary/generic.nix).
  buildInputs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    libdrm
    libgbm
    libsecret
    libxkbcommon
    nspr
    nss
    pango
    xorg.libX11
    xorg.libXcomposite
    xorg.libXdamage
    xorg.libXext
    xorg.libXfixes
    xorg.libXrandr
    xorg.libxcb
    xorg.libxshmfence
  ];

  # Loaded with dlopen, so autoPatchelf can't see them.
  runtimeDependencies = [
    (lib.getLib systemd)
    libGL
    libnotify
  ];

  desktopItems = [
    (makeDesktopItem {
      name = "gitdesk";
      desktopName = "gitdesk";
      comment = "Desktop Git client";
      exec = "gitdesk %U";
      icon = "gitdesk";
      startupWMClass = "gitdesk";
      categories = [
        "Development"
        "RevisionControl"
      ];
    })
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/gitdesk $out/bin
    cp -r . $out/share/gitdesk
    install -Dm644 resources/icon.png $out/share/pixmaps/gitdesk.png
    # gitdesk drives the system's Git, so it ships with one on its PATH.
    makeWrapper $out/share/gitdesk/gitdesk $out/bin/gitdesk \
      --prefix PATH : ${lib.makeBinPath [ git ]} \
      --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations}}"
    runHook postInstall
  '';

  meta = {
    description = "Desktop Git client with local-first history";
    homepage = "https://github.com/BotCoder254/gitdesk-releases";
    license = lib.licenses.mit;
    mainProgram = "gitdesk";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
