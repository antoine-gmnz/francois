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
    // Codex only offers `request_user_input` in Plan collaboration mode unless
    // this (under-development, verified on 0.155.1) feature is on — without it
    // a Codex session could never ask a question the way Claude Code does.
    let native = vec![
        "app-server".into(),
        "--enable".into(),
        "default_mode_request_user_input".into(),
        // …which otherwise raises an "under-development features enabled"
        // warning on every thread (key named in that warning; verified live).
        "-c".into(),
        "suppress_unstable_features_warning=true".into(),
        // `update_plan` ships off on 0.155.1 (the model reports it
        // unavailable); it is the only source of `turn/plan/updated`, which
        // becomes the session's `TodoWrite` rows. Verified live.
        "-c".into(),
        "tools.update_plan.enabled=true".into(),
        "--listen".into(),
        "stdio://".into(),
    ];
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
#[cfg(test)]
mod tests {
    use super::*;

    /// Codex only offers `request_user_input` outside Plan mode behind this
    /// feature; without it a Codex session can never ask a question.
    const FEATURE: [&str; 2] = ["--enable", "default_mode_request_user_input"];

    /// ...and the "under-development features enabled" warning that feature
    /// would otherwise raise on every thread is silenced.
    const QUIET: [&str; 2] = ["-c", "suppress_unstable_features_warning=true"];

    /// Codex 0.155.1 ships `update_plan` off: without this the model reports
    /// "the `update_plan` tool is unavailable" and no `turn/plan/updated`
    /// ever arrives (verified live).
    const PLAN: [&str; 2] = ["-c", "tools.update_plan.enabled=true"];

    fn has_feature(args: &[String]) -> bool {
        [FEATURE, QUIET, PLAN]
            .iter()
            .all(|flag| args.windows(2).any(|pair| pair == flag))
    }

    #[test]
    fn the_native_app_server_enables_request_user_input() {
        let (_, args) = invocation(&super::super::integration_tests::context(1, None));
        assert_eq!(args[0], "app-server");
        assert!(has_feature(&args), "{args:?}");
        assert!(args.ends_with(&["--listen".into(), "stdio://".into()]));
    }

    #[test]
    fn the_wsl_app_server_enables_request_user_input_after_the_codex_program() {
        let mut ctx = super::super::integration_tests::context(1, None);
        ctx.runtime = "wsl".into();
        ctx.worktree_distro = Some("Ubuntu".into());
        ctx.cwd = "/home/me/repo".into();
        let (program, args) = invocation(&ctx);
        assert_eq!(program, "wsl.exe");
        let codex = args.iter().position(|a| a == "codex").unwrap();
        assert_eq!(args[codex + 1], "app-server");
        assert!(has_feature(&args[codex..]), "{args:?}");
    }
}
