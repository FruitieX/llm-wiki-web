{
  description = "llm-wiki-web: a private reading and editing app for FruitieX/llm-wiki";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    eachSystem = nixpkgs.lib.genAttrs systems;
    forSystem = system: let
      pkgs = import nixpkgs { inherit system; };
      source = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type: !(builtins.elem (baseNameOf path) [ "node_modules" "target" "dist" ".git" "data" "test-results" "result" "backend" "docs" "deploy" ".github" "README.md" "AGENTS.md" "flake.nix" "flake.lock" ]);
      };
      frontend = pkgs.buildNpmPackage {
        pname = "llm-wiki-web-ui"; version = "0.1.0"; src = source;
        nodejs = pkgs.nodejs_26;
        # Read from package-lock.json, so dependency updates need no hash bump.
        npmDeps = pkgs.importNpmLock { npmRoot = ./.; };
        npmConfigHook = pkgs.importNpmLock.npmConfigHook;
        installPhase = ''mkdir -p $out/share/llm-wiki-web; cp -r dist/. $out/share/llm-wiki-web/'';
      };
      backend = pkgs.rustPlatform.buildRustPackage {
        pname = "llm-wiki-web"; version = "0.1.0";
        src = pkgs.lib.cleanSourceWith { src = ./backend; filter = path: type: !(builtins.elem (baseNameOf path) [ "target" ]); };
        cargoLock.lockFile = ./backend/Cargo.lock;
        # The tests drive real git repositories and the Node wiki checker.
        nativeCheckInputs = [ pkgs.git pkgs.nodejs-slim_26 pkgs.cacert ];
      };
    in { inherit pkgs source frontend backend; };
  in {
    packages = eachSystem (system: let build = forSystem system; inherit (build) pkgs frontend backend; in {
      inherit frontend backend;
      default = backend;
    } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
      container = pkgs.dockerTools.buildLayeredImage {
        name = "ghcr.io/fruitiex/llm-wiki-web"; tag = "main";
        # git + ssh sync the clone; Node runs the wiki's own tools/wiki_check.js.
        contents = [ backend frontend pkgs.git pkgs.openssh pkgs.nodejs-slim_26 pkgs.cacert pkgs.tzdata pkgs.coreutils pkgs.bash ];
        extraCommands = ''mkdir -p data tmp etc; chmod 1777 tmp; echo 'app:x:10001:10001::/tmp:/bin/false' > etc/passwd; echo 'app:x:10001:' > etc/group'';
        fakeRootCommands = ''chown 10001:10001 data'';
        config = {
          User = "10001:10001"; WorkingDir = "/";
          Entrypoint = [ "${backend}/bin/llm-wiki-web" ];
          Env = [
            "LLM_WIKI_BIND=0.0.0.0:8080" "LLM_WIKI_DATA_DIR=/data" "LLM_WIKI_STATIC_DIR=${frontend}/share/llm-wiki-web"
            "HOME=/tmp" "PATH=/bin" "LLM_WIKI_NODE=${pkgs.nodejs-slim_26}/bin/node" "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt" "TZDIR=${pkgs.tzdata}/share/zoneinfo"
          ];
          ExposedPorts."8080/tcp" = {}; Volumes."/data" = {};
        };
      };
    });
    devShells = eachSystem (system: let pkgs = (forSystem system).pkgs; in {
      default = pkgs.mkShell {
        packages = with pkgs; [ nodejs_26 cargo rustc rustfmt clippy gcc git openssh kustomize sops ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [ chromium ];
        shellHook = ''
          ${nixpkgs.lib.optionalString (nixpkgs.lib.hasSuffix "linux" system) "export PLAYWRIGHT_CHROMIUM_EXECUTABLE=${pkgs.chromium}/bin/chromium"}
        '';
      };
    });
  };
}
