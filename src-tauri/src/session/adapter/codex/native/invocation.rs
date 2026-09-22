//! Host/distro routing reuses the application's existing WSL path vocabulary.
use crate::ipc::{AppError, ErrorCode};
use crate::session::application::TurnContext;
use std::process::Stdio;
use std::sync::Arc;

fn failure() -> AppError {
    AppError::new(
        ErrorCode::RuntimeUnavailable,
        "Codex could not resolve the selected WSL working directory",
    )
}
pub(super) fn distro(ctx: &TurnContext) -> Option<String> {
    ctx.worktree_distro
        .clone()
        .or_else(|| crate::wsl::wsl_unc_to_linux(&ctx.cwd).map(|(d, _)| d))
}
pub(super) fn invocation(ctx: &TurnContext) -> (String, Vec<String>) {
    let native = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
    if ctx.runtime != "wsl" {
        return (crate::process_util::codex_program(), native);
    }
    let mut args = if let Some(distro) = distro(ctx) {
        let cwd = crate::wsl::wsl_unc_to_linux(&ctx.cwd)
            .map(|(_, path)| path)
            .unwrap_or_else(|| ctx.cwd.clone());
        vec!["-d".into(), distro, "--cd".into(), cwd]
    } else {
        crate::wsl::wsl_base_args(&ctx.cwd)
    };
    args.extend(["--".into(), "codex".into()]);
    args.extend(native);
    ("wsl.exe".into(), args)
}
pub(super) fn native_path(ctx: &TurnContext, path: &str) -> Result<String, AppError> {
    if ctx.runtime != "wsl" {
        return Ok(path.into());
    }
    if let Some((path_distro, linux)) = crate::wsl::wsl_unc_to_linux(path) {
        if distro(ctx).is_some_and(|selected| !selected.eq_ignore_ascii_case(&path_distro)) {
            return Err(failure());
        }
        return Ok(linux);
    }
    if path.starts_with('/') && !path.starts_with("//") {
        return Ok(path.into());
    }
    let mut args = vec![];
    if let Some(distro) = distro(ctx) {
        args.extend(["-d".into(), distro]);
    }
    args.extend([
        "--".into(),
        "wslpath".into(),
        "-a".into(),
        "-u".into(),
        path.into(),
    ]);
    let owner = Arc::new(
        crate::process_util::spawn("wsl.exe")
            .args(args)
            .stdout(Stdio::piped())
            .start_owned()
            .map_err(|_| failure())?,
    );
    let mut frames = owner.take_frames().ok_or_else(failure)?;
    let result = frames
        .read_handshake()?
        .filter(|path| path.starts_with('/'))
        .ok_or_else(failure)?;
    if !owner.close().map_err(|_| failure())?.success() {
        return Err(failure());
    }
    Ok(result.trim_end().into())
}
