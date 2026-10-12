// lsp/servers.rs — code-editor-lsp FR-2: the static server table and how a
// (root, language) resolves to a program to spawn.
//
// Native roots look in `<root>/node_modules/.bin/` first (TypeScript ships per
// project), then the login-shell PATH via `process_util::resolve_program`. A
// root on a WSL UNC path resolves INSIDE the distro (FR-8): the project-local
// bin is checked through the UNC path, PATH through a `bash -lc 'command -v'`
// probe, and the server is launched through `wsl.exe -d <distro> --cd <dir>`.
// Resolutions are cached for `PROBE_TTL_MS` so installing a server and pressing
// Retry works without restarting the app.

use super::uri::UriMap;
use super::LspLanguage;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub(crate) const PROBE_TTL_MS: u64 = 30_000;

pub(crate) struct ServerSpec {
    pub display: &'static str,
    /// Tried in order; the first one found wins.
    pub programs: &'static [&'static str],
    pub args: &'static [&'static str],
    pub install_hint: &'static str,
}

pub(crate) fn spec(lang: LspLanguage) -> &'static ServerSpec {
    match lang {
        LspLanguage::Typescript => &ServerSpec {
            display: "typescript-language-server",
            programs: &["typescript-language-server"],
            args: &["--stdio"],
            install_hint: "npm i -g typescript-language-server typescript",
        },
        LspLanguage::Rust => &ServerSpec {
            display: "rust-analyzer",
            programs: &["rust-analyzer"],
            args: &[],
            install_hint: "rustup component add rust-analyzer",
        },
        LspLanguage::Python => &ServerSpec {
            display: "pyright-langserver",
            programs: &["pyright-langserver", "basedpyright-langserver"],
            args: &["--stdio"],
            install_hint: "npm i -g pyright",
        },
        LspLanguage::Go => &ServerSpec {
            display: "gopls",
            programs: &["gopls"],
            args: &[],
            install_hint: "go install golang.org/x/tools/gopls@latest",
        },
    }
}

/// Exactly what to spawn.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    /// `None` = leave the spawn's working directory alone (wsl.exe takes `--cd`).
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Resolution {
    /// Display name (`LspServerStatus.server`).
    pub server: String,
    /// The resolved program as the user would recognise it (tooltip).
    pub program: String,
    pub launch: Launch,
    pub uri_map: UriMap,
    pub init_options: Option<Value>,
    /// Known before the server answers: TypeScript's own version, `TypeScript 5.6.3`.
    pub version: Option<String>,
}

/// Production resolver.
pub(crate) fn resolve(root_dir: &str, lang: LspLanguage) -> Option<Resolution> {
    match crate::wsl::wsl_unc_to_linux(root_dir) {
        Some((distro, linux)) => resolve_wsl(root_dir, &distro, &linux, lang),
        None => resolve_native(root_dir, lang, |p| {
            crate::process_util::resolve_program(p).map(|x| x.to_string_lossy().into_owned())
        }),
    }
}

/// Native resolution with the PATH lookup injected (tests pass a closure).
pub(crate) fn resolve_native(
    root_dir: &str,
    lang: LspLanguage,
    on_path: impl Fn(&str) -> Option<String>,
) -> Option<Resolution> {
    let s = spec(lang);
    let root = Path::new(root_dir);
    let (name, program) = s.programs.iter().find_map(|p| {
        local_bin(root, p)
            .map(|b| b.to_string_lossy().into_owned())
            .or_else(|| on_path(p))
            .map(|found| (*p, found))
    })?;
    let ts = (lang == LspLanguage::Typescript).then(|| ts_extras(root));
    let tsserver = ts
        .as_ref()
        .and_then(|t| t.0.as_ref())
        .map(|p| p.to_string_lossy().into_owned());
    Some(Resolution {
        server: name.to_string(),
        program: program.clone(),
        launch: Launch {
            program,
            args: s.args.iter().map(|a| a.to_string()).collect(),
            cwd: Some(root_dir.to_string()),
            env: Vec::new(),
        },
        uri_map: UriMap::Native,
        init_options: tsserver.map(|p| json!({ "tsserver": { "path": p } })),
        version: ts.and_then(|t| t.1),
    })
}

/// FR-8: sources nvm when present (a login shell alone does not), then execs
/// the positional args — never re-parsed by a shell.
pub(crate) const WSL_EXEC: &str = r#"nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm_sh" ] && . "$nvm_sh" >/dev/null 2>&1; exec "$@""#;
const WSL_WHICH: &str = r#"nvm_sh="${NVM_DIR:-$HOME/.nvm}/nvm.sh"; [ -s "$nvm_sh" ] && . "$nvm_sh" >/dev/null 2>&1; command -v "$1""#;

fn resolve_wsl(unc_root: &str, distro: &str, linux: &str, lang: LspLanguage) -> Option<Resolution> {
    let s = spec(lang);
    let root = Path::new(unc_root);
    let (name, program) = s.programs.iter().find_map(|p| {
        let local = root.join("node_modules").join(".bin").join(p);
        let found = if local.is_file() {
            Some(format!(
                "{}/node_modules/.bin/{p}",
                linux.trim_end_matches('/')
            ))
        } else {
            wsl_which(distro, linux, p)
        };
        found.map(|f| (*p, f))
    })?;
    let mut res = wsl_resolution(distro, linux, name, &program, s.args);
    if lang == LspLanguage::Typescript {
        let (tsserver, version) = ts_extras(root);
        if tsserver.is_some() {
            let p = format!(
                "{}/node_modules/typescript/lib/tsserver.js",
                linux.trim_end_matches('/')
            );
            res.init_options = Some(json!({ "tsserver": { "path": p } }));
        }
        res.version = version;
    }
    Some(res)
}

/// The pure half of the WSL plan.
pub(crate) fn wsl_resolution(
    distro: &str,
    linux: &str,
    name: &str,
    program: &str,
    args: &[&str],
) -> Resolution {
    let mut argv: Vec<String> = vec![
        "-d".into(),
        distro.into(),
        "--cd".into(),
        linux.into(),
        "--exec".into(),
        "bash".into(),
        "-lc".into(),
        WSL_EXEC.into(),
        "_".into(),
        program.into(),
    ];
    argv.extend(args.iter().map(|a| a.to_string()));
    Resolution {
        server: name.to_string(),
        program: program.to_string(),
        launch: Launch {
            program: "wsl.exe".into(),
            args: argv,
            cwd: None,
            env: Vec::new(),
        },
        uri_map: UriMap::Wsl {
            distro: distro.to_string(),
        },
        init_options: None,
        version: None,
    }
}

fn wsl_which(distro: &str, linux: &str, bin: &str) -> Option<String> {
    let run = crate::process_util::spawn("wsl.exe")
        .args(["-d", distro, "--cd", linux, "--exec", "bash", "-lc"])
        .args([WSL_WHICH, "_", bin])
        .run_bounded(std::time::Duration::from_secs(8), 64 * 1024);
    if run.timed_out || run.spawn_failed || !run.status.is_some_and(|s| s.success()) {
        return None;
    }
    String::from_utf8_lossy(&run.stdout)
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with('/'))
        .map(str::to_string)
}

/// `<root>/node_modules/.bin/<bin>` — `.cmd`/`.exe` on Windows, where npm writes shims.
fn local_bin(root: &Path, bin: &str) -> Option<PathBuf> {
    let dir = root.join("node_modules").join(".bin");
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        ["exe", "cmd"]
            .iter()
            .map(|e| dir.join(format!("{bin}.{e}")))
            .collect()
    } else {
        vec![dir.join(bin)]
    };
    candidates.into_iter().find(|c| c.is_file())
}

/// The project's own TypeScript: `tsserver.js` and `TypeScript <version>`.
fn ts_extras(root: &Path) -> (Option<PathBuf>, Option<String>) {
    let ts = root.join("node_modules").join("typescript");
    let tsserver = Some(ts.join("lib").join("tsserver.js")).filter(|p| p.is_file());
    let version = std::fs::read(ts.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string))
        .map(|v| format!("TypeScript {v}"));
    (tsserver, version)
}

/// FR-2: resolutions (successes AND misses) are reused for `PROBE_TTL_MS`.
#[derive(Default)]
pub(crate) struct ProbeCache {
    entries: HashMap<(String, LspLanguage), (u64, Option<Resolution>)>,
}

impl ProbeCache {
    pub(crate) fn get(
        &self,
        dir_key: &str,
        lang: LspLanguage,
        now: u64,
    ) -> Option<Option<Resolution>> {
        self.entries
            .get(&(dir_key.to_string(), lang))
            .filter(|(at, _)| now.saturating_sub(*at) < PROBE_TTL_MS)
            .map(|(_, r)| r.clone())
    }

    pub(crate) fn put(
        &mut self,
        dir_key: &str,
        lang: LspLanguage,
        now: u64,
        r: Option<Resolution>,
    ) {
        self.entries.insert((dir_key.to_string(), lang), (now, r));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::testutil::TempDir;

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"").unwrap();
    }

    fn local_bin_file(root: &Path, bin: &str) -> PathBuf {
        let name = if cfg!(windows) {
            format!("{bin}.cmd")
        } else {
            bin.to_string()
        };
        root.join("node_modules").join(".bin").join(name)
    }

    #[test]
    fn the_table_carries_names_args_and_hints() {
        assert_eq!(spec(LspLanguage::Typescript).args, &["--stdio"]);
        assert_eq!(
            spec(LspLanguage::Python).programs,
            &["pyright-langserver", "basedpyright-langserver"]
        );
        assert_eq!(
            spec(LspLanguage::Rust).install_hint,
            "rustup component add rust-analyzer"
        );
        assert_eq!(
            spec(LspLanguage::Go).install_hint,
            "go install golang.org/x/tools/gopls@latest"
        );
    }

    #[test]
    fn typescript_prefers_node_modules_bin_and_the_projects_tsserver() {
        let tmp = TempDir::new();
        let root = tmp.path();
        let bin = local_bin_file(root, "typescript-language-server");
        touch(&bin);
        let tsserver = root
            .join("node_modules")
            .join("typescript")
            .join("lib")
            .join("tsserver.js");
        touch(&tsserver);
        std::fs::write(
            root.join("node_modules/typescript/package.json"),
            br#"{"name":"typescript","version":"5.6.3"}"#,
        )
        .unwrap();
        let r = resolve_native(&root.to_string_lossy(), LspLanguage::Typescript, |_| {
            Some("/usr/bin/typescript-language-server".into())
        })
        .unwrap();
        assert_eq!(r.program, bin.to_string_lossy());
        assert_eq!(r.launch.args, vec!["--stdio"]);
        assert_eq!(r.version.as_deref(), Some("TypeScript 5.6.3"));
        assert_eq!(
            r.init_options.unwrap()["tsserver"]["path"],
            tsserver.to_string_lossy().as_ref()
        );
        assert_eq!(r.uri_map, UriMap::Native);
    }

    #[test]
    fn falls_back_to_path_without_a_project_typescript() {
        let tmp = TempDir::new();
        let r = resolve_native(
            &tmp.path().to_string_lossy(),
            LspLanguage::Typescript,
            |p| Some(format!("/g/{p}")),
        )
        .unwrap();
        assert_eq!(r.program, "/g/typescript-language-server");
        assert_eq!(r.init_options, None);
        assert_eq!(r.version, None);
    }

    #[test]
    fn python_tries_basedpyright_second_and_missing_is_none() {
        let r = resolve_native("/nowhere", LspLanguage::Python, |p| {
            (p == "basedpyright-langserver").then(|| format!("/g/{p}"))
        })
        .unwrap();
        assert_eq!(r.server, "basedpyright-langserver");
        assert!(resolve_native("/nowhere", LspLanguage::Go, |_| None).is_none());
    }

    #[test]
    fn wsl_plan_execs_through_a_login_shell_in_the_named_distro() {
        let r = wsl_resolution(
            "Ubuntu",
            "/home/u/api",
            "gopls",
            "/home/u/go/bin/gopls",
            &[],
        );
        assert_eq!(r.launch.program, "wsl.exe");
        assert_eq!(
            r.launch.args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/api",
                "--exec",
                "bash",
                "-lc",
                WSL_EXEC,
                "_",
                "/home/u/go/bin/gopls"
            ]
        );
        assert_eq!(
            r.uri_map,
            UriMap::Wsl {
                distro: "Ubuntu".into()
            }
        );
    }

    #[test]
    fn the_probe_cache_expires_after_the_ttl() {
        let mut c = ProbeCache::default();
        assert_eq!(c.get("d", LspLanguage::Go, 0), None);
        c.put("d", LspLanguage::Go, 1_000, None);
        assert_eq!(
            c.get("d", LspLanguage::Go, 1_000 + PROBE_TTL_MS - 1),
            Some(None)
        );
        assert_eq!(c.get("d", LspLanguage::Go, 1_000 + PROBE_TTL_MS), None);
        assert_eq!(c.get("d", LspLanguage::Rust, 1_000), None);
    }
}
