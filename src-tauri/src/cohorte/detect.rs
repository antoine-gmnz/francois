//! FR-2..FR-7 — detection. Walk up from `startDir` for a `.cohorte/`
//! directory (the user's home only counts with `~/.cohorte/project.yaml`),
//! else ask git for the common dir so a linked worktree finds its main
//! checkout's `.cohorte/`; probe `cohorte --version` (cached per host dialect,
//! 5 min) and read `runtime` from `cohorte config get`. Results are cached
//! 30 s per startDir; a changed result emits `francois.detection.changed`.
//!
//! FR-1b: the ONLY filesystem access under `.cohorte/` in this whole module is
//! here, and it is `is_dir`/`is_file` (stat) of exactly three paths.

use super::catalogue::{CohorteEvent, DetectionChanged};
use super::cli::{self, argv, Kind};
use super::documents::{parse_config, runtime_id};
use super::{CliInfo, CohorteDetection, Inner, SUPPORTED_RANGE};
use crate::diff::GitHost;
use crate::ids::now_ms;
use crate::ipc::{AppError, ErrorCode};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const DETECT_TTL: Duration = Duration::from_secs(30);
const PROBE_TTL: Duration = Duration::from_secs(5 * 60);
const GIT_CAP: usize = 64 * 1024;

/// `startDir` trimmed of surrounding space and trailing separators (a bare
/// root such as `/` or `C:\` is kept).
pub(crate) fn normalise_dir(dir: &str) -> String {
    let t = dir.trim();
    let stripped = t.trim_end_matches(['/', '\\']);
    if stripped.is_empty() || stripped.ends_with(':') {
        t.to_string()
    } else {
        stripped.to_string()
    }
}

/// First whitespace token that parses as semver (a leading `v` allowed).
pub(crate) fn parse_version(stdout: &str) -> Option<String> {
    stdout.split_whitespace().find_map(|tok| {
        let t = tok.trim_start_matches('v');
        semver::Version::parse(t).ok().map(|_| t.to_string())
    })
}

/// FR-5: `>=3.0.0-dev.1 <4.0.0` with prerelease ordering.
pub(crate) fn compatible(version: &str) -> bool {
    let (Ok(v), Ok(min)) = (
        semver::Version::parse(version),
        semver::Version::parse("3.0.0-dev.1"),
    ) else {
        return false;
    };
    v >= min && v.major < 4
}

fn host_key(dir: &str) -> String {
    match GitHost::of(dir) {
        GitHost::Native => "native".into(),
        GitHost::Wsl(d) => format!("wsl:{}", d.to_lowercase()),
    }
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .to_lowercase()
            .trim_end_matches(['\\', '/'])
            == b.to_string_lossy()
                .to_lowercase()
                .trim_end_matches(['\\', '/'])
    } else {
        a == b
    }
}

/// A git path printed by the (possibly WSL) git, in the host dialect.
fn host_path(host: &GitHost, p: &str) -> String {
    match host {
        GitHost::Wsl(d) => {
            crate::wsl::linux_to_wsl_unc(Some(d), p).unwrap_or_else(|| p.to_string())
        }
        GitHost::Native if cfg!(windows) => p.replace('/', "\\"),
        GitHost::Native => p.to_string(),
    }
}

fn git_line(runner: &dyn cli::Runner, dir: &str, args: &[&str]) -> Option<String> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let out = runner.run("git", dir, &args, cli::GIT_TIMEOUT, GIT_CAP);
    (out.code == 0)
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// FR-2 steps 2–3: the Cohorte root for `start`, and how it was found.
fn find_root(
    runner: &dyn cli::Runner,
    start: &str,
    homes: &[PathBuf],
) -> Option<(PathBuf, &'static str)> {
    for a in Path::new(start).ancestors() {
        if !a.join(".cohorte").is_dir() {
            continue;
        }
        let is_home = homes.iter().any(|h| same_dir(h, a));
        if !is_home || a.join(".cohorte").join("project.yaml").is_file() {
            return Some((a.to_path_buf(), "walk-up"));
        }
    }
    let host = GitHost::of(start);
    let common = git_line(
        runner,
        start,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let main = common
        .strip_suffix("/.git")
        .or_else(|| common.strip_suffix("\\.git"))?;
    let main = PathBuf::from(host_path(&host, main));
    main.join(".cohorte")
        .is_dir()
        .then_some((main, "git-common-dir"))
}

/// FR-2/FR-3, uncached. `probe(dir)` answers the CLI question for that dir.
pub(crate) fn detect_uncached(
    runner: &dyn cli::Runner,
    homes: &[PathBuf],
    start_dir: &str,
    probe: &dyn Fn(&str) -> CliInfo,
) -> CohorteDetection {
    let start = normalise_dir(start_dir);
    let mut det = CohorteDetection {
        start_dir: start.clone(),
        state: "no-project".into(),
        root: None,
        dir: None,
        found_via: None,
        has_project_file: false,
        state_backend: None,
        root_branch: None,
        runtime: None,
        cli: CliInfo {
            installed: false,
            version: None,
            supported_range: SUPPORTED_RANGE.into(),
            compatible: false,
        },
        checked_at: now_ms(),
    };
    if start.is_empty() || !Path::new(&start).is_dir() {
        return det;
    }
    let Some((root, via)) = find_root(runner, &start, homes) else {
        det.state = "not-initialised".into();
        det.cli = probe(&start);
        return det;
    };
    let root_s = root.to_string_lossy().into_owned();
    let dot = root.join(".cohorte");
    det.dir = Some(dot.to_string_lossy().into_owned());
    det.found_via = Some(via.into());
    det.has_project_file = dot.join("project.yaml").is_file();
    det.state_backend = dot
        .join("state")
        .join("cohorte.db")
        .is_file()
        .then(|| "sqlite".to_string());
    det.root_branch =
        git_line(runner, &root_s, &["rev-parse", "--abbrev-ref", "HEAD"]).filter(|b| b != "HEAD");
    det.cli = probe(&root_s);
    det.state = if !det.cli.installed {
        "cli-missing"
    } else if !det.cli.compatible {
        "cli-incompatible"
    } else {
        "detected"
    }
    .into();
    if det.state == "detected" {
        let a = argv::config_get();
        let out = cli::run(
            runner,
            Kind::Read,
            &root_s,
            &a,
            cli::READ_TIMEOUT,
            cli::READ_CAP,
        );
        if out.code == 0 {
            det.runtime = parse_config(&out.stdout).as_ref().and_then(runtime_id);
        }
    }
    det.root = Some(root_s);
    det
}

/// FR-4: `cohorte --version` in `dir`.
pub(crate) fn probe_cli(runner: &dyn cli::Runner, dir: &str) -> CliInfo {
    let out = cli::run(
        runner,
        Kind::Read,
        dir,
        &argv::version(),
        cli::VERSION_TIMEOUT,
        cli::READ_CAP,
    );
    let version = (!out.spawn_failed && !out.timed_out && out.code == 0)
        .then(|| parse_version(&String::from_utf8_lossy(&out.stdout)))
        .flatten();
    CliInfo {
        installed: version.is_some(),
        compatible: version.as_deref().is_some_and(compatible),
        version,
        supported_range: SUPPORTED_RANGE.into(),
    }
}

/// FR-7's changed-edge: state, root, cli.version, hasProjectFile.
fn differs(a: &CohorteDetection, b: &CohorteDetection) -> bool {
    a.state != b.state
        || a.root != b.root
        || a.cli.version != b.cli.version
        || a.has_project_file != b.has_project_file
}

/// Detection codes (§5) for a detection that is not `detected`.
pub(crate) fn require_detected(det: &CohorteDetection) -> Result<String, AppError> {
    match det.state.as_str() {
        "detected" => Ok(det.root.clone().unwrap_or_default()),
        "cli-missing" => Err(cli::cli_missing()),
        "cli-incompatible" => Err(AppError::with_detail(
            ErrorCode::CohorteCliIncompatible,
            format!(
                "cohorte {} is not supported — Francois needs {SUPPORTED_RANGE}",
                det.cli.version.clone().unwrap_or_default()
            ),
            json!({ "version": det.cli.version, "supportedRange": SUPPORTED_RANGE }),
        )),
        _ => Err(AppError::with_detail(
            ErrorCode::CohorteNotDetected,
            "no .cohorte/ for that directory",
            json!({ "startDir": det.start_dir }),
        )),
    }
}

impl Inner {
    fn homes(&self, start: &str) -> Vec<PathBuf> {
        let mut homes: Vec<PathBuf> = self.home.iter().cloned().collect();
        if crate::wsl::is_wsl_unc_path(start) {
            if let Some(h) = crate::wsl::wsl_home_unc(start) {
                homes.push(PathBuf::from(h));
            }
        }
        homes
    }

    pub(crate) fn cli_info(&self, dir: &str, force: bool) -> CliInfo {
        let key = host_key(dir);
        if !force {
            if let Some((at, info)) = self.cli_probes.lock().unwrap().get(&key) {
                if at.elapsed() < PROBE_TTL {
                    return info.clone();
                }
            }
        }
        let info = probe_cli(self.runner.as_ref(), dir);
        self.cli_probes
            .lock()
            .unwrap()
            .insert(key, (Instant::now(), info.clone()));
        info
    }

    /// FR-7: cached 30 s per normalised startDir; emits the changed-edge.
    pub(crate) fn detect(&self, start_dir: &str, force: bool) -> CohorteDetection {
        let key = normalise_dir(start_dir);
        if !force {
            if let Some((at, det)) = self.detections.lock().unwrap().get(&key) {
                if at.elapsed() < DETECT_TTL {
                    return det.clone();
                }
            }
        }
        let homes = self.homes(&key);
        let det = detect_uncached(self.runner.as_ref(), &homes, &key, &|d| {
            self.cli_info(d, force)
        });
        self.detections
            .lock()
            .unwrap()
            .insert(key.clone(), (Instant::now(), det.clone()));
        let changed = {
            let mut last = self.emitted_detections.lock().unwrap();
            let changed = last.get(&key).is_none_or(|prev| differs(prev, &det));
            if changed {
                last.insert(key, det.clone());
            }
            changed
        };
        if changed {
            self.emit(&[CohorteEvent::DetectionChanged(DetectionChanged {
                detection: det.clone(),
            })]);
        }
        det
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{missing, out, FakeRunner};
    use std::fs;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tmp() -> Tmp {
        let p =
            std::env::temp_dir().join(format!("francois-cohorte-detect-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    fn homes() -> Vec<PathBuf> {
        dirs::home_dir().into_iter().collect()
    }
    fn cli(version: &str) -> FakeRunner {
        let r = FakeRunner::default();
        r.on("cohorte --version", out(0, &format!("{version}\n")));
        r.on(
            "cohorte config get",
            out(0, r#"{ "runtime": { "id": "pi" } }"#),
        );
        r
    }
    fn det(r: &FakeRunner, homes: &[PathBuf], start: &Path) -> CohorteDetection {
        detect_uncached(r, homes, &start.to_string_lossy(), &|d| probe_cli(r, d))
    }
    fn git(dir: &Path, args: &[&str]) {
        let ok = crate::process_util::spawn("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn walk_up_finds_cohorte_two_levels_up() {
        let t = tmp();
        let proj = t.0.join("proj");
        fs::create_dir_all(proj.join(".cohorte").join("state")).unwrap();
        fs::write(proj.join(".cohorte").join("project.yaml"), "id: p\n").unwrap();
        fs::write(proj.join(".cohorte").join("state").join("cohorte.db"), "").unwrap();
        let deep = proj.join("a").join("b");
        fs::create_dir_all(&deep).unwrap();
        let d = det(&cli("3.0.0-dev.8"), &homes(), &deep);
        assert_eq!(d.state, "detected");
        assert_eq!(d.root.as_deref(), Some(proj.to_string_lossy().as_ref()));
        assert_eq!(d.found_via.as_deref(), Some("walk-up"));
        assert!(d.has_project_file);
        assert_eq!(d.state_backend.as_deref(), Some("sqlite"));
        assert_eq!(d.runtime.as_deref(), Some("pi"));
        assert_eq!(d.cli.version.as_deref(), Some("3.0.0-dev.8"));
    }

    #[test]
    fn a_linked_worktree_resolves_the_main_checkout_via_git_common_dir() {
        let t = tmp();
        let main = t.0.join("main");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        fs::write(main.join("f"), "x").unwrap();
        git(&main, &["add", "f"]);
        git(&main, &["commit", "-q", "-m", "init"]);
        fs::create_dir_all(main.join(".cohorte")).unwrap();
        git(&main, &["worktree", "add", "-q", "../wt"]);
        let d = det(&cli("3.0.0-dev.8"), &homes(), &t.0.join("wt"));
        assert_eq!(d.found_via.as_deref(), Some("git-common-dir"));
        assert_eq!(
            fs::canonicalize(d.root.unwrap()).unwrap(),
            fs::canonicalize(&main).unwrap()
        );
        assert!(!d.has_project_file);
        assert_eq!(d.state_backend, None);
        assert!(d.root_branch.is_some());
    }

    #[test]
    fn a_home_cohorte_without_project_yaml_is_ignored() {
        let t = tmp();
        let home = t.0.join("home");
        fs::create_dir_all(home.join(".cohorte")).unwrap();
        let proj = home.join("proj");
        fs::create_dir_all(&proj).unwrap();
        let mut hs = homes();
        hs.push(home.clone());
        let d = det(&cli("3.0.0-dev.8"), &hs, &proj);
        assert_eq!(d.state, "not-initialised");
        assert!(d.cli.installed); // probed anyway (frame 28 needs it)
        fs::write(home.join(".cohorte").join("project.yaml"), "").unwrap();
        assert_eq!(det(&cli("3.0.0-dev.8"), &hs, &proj).state, "detected");
    }

    #[test]
    fn cli_state_precedence() {
        let t = tmp();
        fs::create_dir_all(t.0.join(".cohorte")).unwrap();
        let r = FakeRunner::default();
        r.on("cohorte --version", missing());
        assert_eq!(det(&r, &homes(), &t.0).state, "cli-missing");
        let d = det(&cli("2.4.0"), &homes(), &t.0);
        assert_eq!(d.state, "cli-incompatible");
        assert_eq!(d.cli.version.as_deref(), Some("2.4.0"));
        assert_eq!(
            require_detected(&d).unwrap_err().code,
            ErrorCode::CohorteCliIncompatible
        );
        assert_eq!(det(&cli("3.0.0-dev.8"), &homes(), &t.0).state, "detected");
        // a config-get failure never changes the state
        let r = FakeRunner::default();
        r.on("cohorte --version", out(0, "3.0.0-dev.8"));
        r.on("cohorte config get", out(1, ""));
        let d = det(&r, &homes(), &t.0);
        assert_eq!((d.state.as_str(), d.runtime.as_deref()), ("detected", None));
    }

    #[test]
    fn a_missing_start_dir_is_no_project() {
        let d = det(
            &cli("3.0.0-dev.8"),
            &homes(),
            Path::new("/definitely/not/here/x"),
        );
        assert_eq!(d.state, "no-project");
        assert_eq!(
            require_detected(&d).unwrap_err().code,
            ErrorCode::CohorteNotDetected
        );
    }

    #[test]
    fn versions_and_ranges() {
        assert_eq!(
            parse_version("cohorte 3.0.0-dev.8\n").as_deref(),
            Some("3.0.0-dev.8")
        );
        assert_eq!(parse_version("v3.4.1").as_deref(), Some("3.4.1"));
        assert_eq!(parse_version("nope"), None);
        assert!(compatible("3.0.0-dev.1"));
        assert!(compatible("3.0.0-dev.8"));
        assert!(compatible("3.4.1"));
        assert!(!compatible("3.0.0-alpha.1")); // alpha < dev
        assert!(!compatible("2.9.9"));
        assert!(!compatible("4.0.0"));
        assert!(!compatible("4.0.0-dev.1"));
    }

    #[test]
    fn normalise_dir_trims_trailing_separators() {
        assert_eq!(normalise_dir(" /a/b/ "), "/a/b");
        assert_eq!(normalise_dir("C:\\x\\"), "C:\\x");
        assert_eq!(normalise_dir("/"), "/");
        assert_eq!(normalise_dir("C:\\"), "C:\\");
    }

    #[test]
    fn detection_is_cached_and_emits_only_on_change() {
        use std::sync::{Arc, Mutex};
        let t = tmp();
        fs::create_dir_all(t.0.join(".cohorte")).unwrap();
        let runner = Arc::new(cli("3.0.0-dev.8"));
        let inner = Inner::with_runner(runner.clone(), dirs::home_dir());
        let seen = Arc::new(Mutex::new(0));
        let s2 = seen.clone();
        *inner.emitter.lock().unwrap() = Some(Arc::new(move |_| *s2.lock().unwrap() += 1));
        let dir = t.0.to_string_lossy().into_owned();
        assert_eq!(inner.detect(&dir, false).state, "detected");
        let probes = runner.count("cohorte --version");
        inner.detect(&dir, false);
        assert_eq!(runner.count("cohorte --version"), probes, "cached");
        inner.detect(&dir, true);
        assert_eq!(*seen.lock().unwrap(), 1, "unchanged result emits once");
    }
}
