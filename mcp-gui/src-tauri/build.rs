fn main() {
    // 把「更新公钥是否已配置」注入编译期常量：CI 在 tauri build 之前替换
    // tauri.conf.json 的 pubkey 占位符，这里据此决定运行时是否提示「自动更新未启用」。
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let configured = std::fs::read_to_string("tauri.conf.json")
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|conf| {
            conf.get("plugins")
                .and_then(|p| p.get("updater"))
                .and_then(|u| u.get("pubkey"))
                .and_then(|k| k.as_str())
                .map(str::to_string)
        })
        .map(|key| !key.is_empty() && !key.contains("__UPDATER_PUBKEY__"))
        .unwrap_or(false);
    println!("cargo:rustc-env=TIANSHU_UPDATER_CONFIGURED={configured}");

    tauri_build::build()
}
