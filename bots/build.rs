use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let sealbot_dir = manifest_dir.join("vendor/SealBot");
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").expect("CARGO_CFG_TARGET_ARCH");

    if !sealbot_dir.join("current/engine/engine.h").exists() {
        panic!(
            "SealBot submodule is missing. Run: git submodule update --init --recursive bots/vendor/SealBot"
        );
    }

    println!("cargo:rerun-if-changed=src/sealbot_ffi.cpp");
    println!("cargo:rerun-if-changed=src/seal_vendor_bridge.js");
    println!("cargo:rerun-if-changed=vendor/SealBot/current");

    if target_arch == "wasm32" {
        build_wasm(&manifest_dir);
    } else {
        build_native(&manifest_dir);
    }
}

fn build_native(manifest_dir: &Path) {
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .opt_level(3)
        .warnings(false)
        .file(manifest_dir.join("src/sealbot_ffi.cpp"))
        .include(manifest_dir.join("vendor/SealBot/current"))
        .include(manifest_dir.join("vendor/SealBot/current/engine"));

    match env::var("CARGO_CFG_TARGET_OS").ok().as_deref() {
        Some("macos") | Some("ios") => {
            build.cpp_link_stdlib("c++");
        }
        Some("windows") => {
            build.cpp_link_stdlib(None::<&str>);
        }
        _ => {
            build.cpp_link_stdlib("stdc++");
        }
    }

    build.compile("sealbot_ffi");
}

fn build_wasm(manifest_dir: &Path) {
    let generated_dir = manifest_dir.join("generated");
    fs::create_dir_all(&generated_dir).expect("create bots/generated");
    let output_js = generated_dir.join("sealbot.js");

    let empp = env::var("EMPP").unwrap_or_else(|_| "em++".to_string());
    let status = Command::new(&empp)
        .current_dir(manifest_dir)
        .arg("src/sealbot_ffi.cpp")
        .arg("-Ivendor/SealBot/current")
        .arg("-Ivendor/SealBot/current/engine")
        .arg("-std=c++17")
        .arg("-O3")
        .arg("-fexceptions")
        .args(["-s", "ALLOW_MEMORY_GROWTH=1"])
        .args(["-s", "DISABLE_EXCEPTION_CATCHING=0"])
        .args(["-s", "ENVIRONMENT=web,worker"])
        .args(["-s", "STACK_SIZE=5242880"])
        .args(["-s", "INITIAL_MEMORY=134217728"])
        .args(["-s", "EXPORT_ES6=1"])
        .args(["-s", "FILESYSTEM=0"])
        .args(["-s", "MODULARIZE=1"])
        .args(["-s", "SINGLE_FILE=1"])
        .args(["-s", "WASM_ASYNC_COMPILATION=0"])
        .args([
            "-s",
            r#"EXPORTED_FUNCTIONS=["_malloc","_free","_sealbot_choose_move_flat","_sealbot_last_error"]"#,
        ])
        .args(["-s", r#"EXPORTED_RUNTIME_METHODS=["HEAP32","UTF8ToString"]"#])
        .arg("-o")
        .arg(&output_js)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run {empp} while building SealBot wasm bridge: {error}. Install Emscripten or set EMPP=/path/to/em++"
            )
        });

    if !status.success() {
        panic!(
            "{empp} failed while building bots/generated/sealbot.js. Web builds require a working Emscripten toolchain."
        );
    }
}
