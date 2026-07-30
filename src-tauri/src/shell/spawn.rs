// ---------- shell resolution (FR-6) ----------

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

pub(crate) fn resolve_shell() -> (String, Vec<String>, String) {
    if cfg!(target_os = "windows") {
        let exe = if on_path("pwsh.exe") {
            "pwsh.exe"
        } else {
            "powershell.exe"
        };
        (exe.to_string(), vec![], basename_no_ext(exe))
    } else {
        let candidate = std::env::var("SHELL")
            .ok()
            .filter(|s| std::path::Path::new(s).exists());
        let exe = candidate
            .or_else(|| some_if_exists("/bin/zsh"))
            .or_else(|| some_if_exists("/bin/bash"))
            .unwrap_or_else(|| "/bin/sh".to_string());
        let name = basename_no_ext(&exe);
        (exe, vec!["-il".to_string()], name)
    }
}

fn some_if_exists(p: &str) -> Option<String> {
    if std::path::Path::new(p).exists() {
        Some(p.to_string())
    } else {
        None
    }
}

fn basename_no_ext(p: &str) -> String {
    std::path::Path::new(p)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(p)
        .to_string()
}

// ---------- per-session spawn matrix (wsl-filesystem FR-10..12) ----------

/// (program, args, shellName, spawnCwd) for a session's shell under its runtime
/// (FR-11/FR-12 — the claude runtime, not the diff domain's FR-5). native: the
/// existing `resolve_shell()` (pwsh/PowerShell/zsh/bash per platform), spawned with
/// the session cwd verbatim — a WSL UNC cwd is legal here (pwsh supports a UNC
/// cwd); it's the user's explicit mismatch choice (spec story C), never blocked.
/// wsl: `wsl.exe [-d <distro>] --cd <dir>` (wsl_base_args — a WSL UNC cwd targets
/// the distro named in the path, not the machine's default) launching that
/// distro's default shell with NO process cwd set — `--cd` alone positions it,
/// and the raw cwd string (UNC or Linux) is meaningless as wsl.exe's own
/// Windows-side working directory. `shellName` is the cwd's distro when the path
/// names one, else the default distro (FR-3), else the literal "wsl" (spec §7).
pub(crate) fn shell_spawn_target(
    runtime: &str,
    cwd: &str,
) -> (String, Vec<String>, String, Option<String>) {
    if runtime == "wsl" {
        let args = crate::wsl::wsl_base_args(cwd);
        let shell_name = crate::wsl::wsl_distro_name(cwd).unwrap_or_else(|| "wsl".to_string());
        ("wsl.exe".to_string(), args, shell_name, None)
    } else {
        let (exe, args, shell_name) = resolve_shell();
        (exe, args, shell_name, Some(cwd.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_spawn_target_native_uses_resolve_shell_and_session_cwd() {
        // Regression pin (spec §9 last bullet): a native-runtime session's shell
        // spawn must stay byte-identical to the pre-wsl-filesystem resolve_shell()
        // output, now just spawned in the SESSION's cwd instead of always $HOME.
        let (exe, args, name) = resolve_shell();
        let (exe2, args2, name2, spawn_cwd) = shell_spawn_target("native", "D:\\infra");
        assert_eq!((exe2, args2, name2), (exe, args, name));
        assert_eq!(spawn_cwd, Some("D:\\infra".to_string()));
    }

    #[test]
    fn shell_spawn_target_wsl_targets_the_cwds_distro_and_sets_no_process_cwd() {
        // The distro comes from the UNC path itself (-d) — bare wsl.exe would hit
        // the machine's DEFAULT distro, wrong whenever the repo lives elsewhere
        // (docker-desktop-as-default being the canonical open-source-user case).
        let (exe, args, name, spawn_cwd) =
            shell_spawn_target("wsl", "\\\\wsl$\\Ubuntu\\home\\u\\api");
        assert_eq!(exe, "wsl.exe");
        assert_eq!(args, vec!["-d", "Ubuntu", "--cd", "/home/u/api"]);
        assert_eq!(name, "Ubuntu"); // FR-12: pure — from the path, no wsl.exe probe
        assert_eq!(spawn_cwd, None); // `--cd` alone positions it (FR-11)
    }

    #[test]
    fn shell_spawn_target_wsl_passes_drive_cwd_verbatim_for_wsl_exe_to_map() {
        let (exe, args, _name, spawn_cwd) = shell_spawn_target("wsl", "D:\\acme-api");
        assert_eq!(exe, "wsl.exe");
        assert_eq!(args, vec!["--cd", "D:\\acme-api"]); // wsl.exe maps this to /mnt/d/acme-api itself
        assert_eq!(spawn_cwd, None);
    }
}
