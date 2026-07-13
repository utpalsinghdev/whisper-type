fn main() {
    // Ensure frontend changes under ../src always invalidate the release embed.
    println!("cargo:rerun-if-changed=../src");
    tauri_build::build()
}
