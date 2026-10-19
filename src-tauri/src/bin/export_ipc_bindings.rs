use std::path::PathBuf;

fn main() {
    let output = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .expect("usage: export_ipc_bindings <output-path>");

    viby_lib::ipc_builder()
        .export(specta_typescript::Typescript::default(), output)
        .expect("failed to export TypeScript IPC bindings");
}
