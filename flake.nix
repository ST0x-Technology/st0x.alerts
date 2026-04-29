{
  description = "Flake for development workflows.";

  inputs = {
    rainix.url = "github:rainprotocol/rainix";
    flake-utils.url = "github:numtide/flake-utils";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, flake-utils, rainix, nixpkgs }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Tenderly CLI — not yet in nixpkgs, fetched from GitHub releases.
        # If the sha256 is wrong, nix will print the correct hash in the error;
        # replace the placeholder below with that value.
        tenderly-cli =
          let
            version = "1.6.9";
            srcs = {
              "aarch64-darwin" = {
                url = "https://github.com/Tenderly/tenderly-cli/releases/download/v${version}/tenderly_${version}_Darwin_arm64.tar.gz";
                sha256 = "sha256-bgsKydqiQpGr6o/TlY3BWzitDtRDCF+cxaQzkPrQTA0=";
              };
              "x86_64-darwin" = {
                url = "https://github.com/Tenderly/tenderly-cli/releases/download/v${version}/tenderly_${version}_Darwin_amd64.tar.gz";
                sha256 = pkgs.lib.fakeHash;
              };
              "x86_64-linux" = {
                url = "https://github.com/Tenderly/tenderly-cli/releases/download/v${version}/tenderly_${version}_Linux_amd64.tar.gz";
                sha256 = "sha256-PY8BsL3lUHw0EdyPXuOu8ZfEAkerT/EoJ7ahKFv9b+E=";
              };
            };
            src = srcs.${system} or (throw "tenderly-cli: unsupported system ${system}");
          in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "tenderly-cli";
            inherit version;
            src = pkgs.fetchurl { inherit (src) url sha256; };
            # The tarball unpacks a single `tenderly` binary at the root
            sourceRoot = ".";
            nativeBuildInputs = [ pkgs.gnutar ];
            unpackPhase = ''
              tar -xf $src
            '';
            installPhase = ''
              mkdir -p $out/bin
              install -m755 tenderly $out/bin/tenderly
            '';
          };
      in
      {
        packages = rainix.packages.${system};
        devShells = rainix.devShells.${system} // {
          default = pkgs.mkShell {
            inputsFrom = [ rainix.devShells.${system}.default ];
            packages = [ tenderly-cli ];
          };
        };
      }
    );

}
