//! FR-81..FR-86 — the framed main tab, the one surface that puts something in
//! the webview which Francois did not draw.
//!
//! Everything about it that the core decides lives here, and it is deliberately
//! small: a tab is **static manifest data**, validated once at install and once
//! at update. There is no `tab()` handler, no `'tab'` render surface and no
//! `Handler::Tab` — so a plugin cannot repoint its tab after the user consented
//! to a specific page, and a compromised backing service cannot move it either.
//!
//! What the rest of the boundary rests on, none of which is Rust:
//!
//! * the frame is opened without `allow-same-origin`, so the page is forced
//!   into an opaque origin (FR-83, `PLUGIN_TAB_SANDBOX` in the contract);
//! * `tauri.conf.json` carries a real CSP whose `frame-src` is `https:`
//!   (FR-84), as a backstop for a bug in the check below;
//! * no capability grants a `remote` origin, so Tauri's ACL refuses any IPC
//!   arriving from a framed document (FR-86 — see the tests at the bottom,
//!   which assert exactly that and nothing more).

use super::*;

/// FR-81/FR-82 — everything a framed main tab must satisfy, checked HERE in the
/// core at install and at update, before a consent card is drawn.
///
/// Three separate refusals, and each is load-bearing:
///
/// * **`webTab` must be granted.** Framing is not fetching. `network` says "this
///   plugin may read bytes from these hosts into its isolate"; `webTab` says
///   "this page runs its own code next to the app", and the consent card has a
///   line for each. A `contributes.tab` without the capability would put the
///   second grant behind the first one's wording.
/// * **`https:` only, loopback INCLUDED.** `francois.fetch` exempts
///   `http://127.0.0.1` (FR-31) because its response is inert text handed to the
///   isolate. A frame executes, and a plaintext local origin is exactly what any
///   other process on the machine can impersonate.
/// * **The host must already be in `capabilities.network.hosts`.** `webTab`
///   narrows that allowlist; it never widens it. So the origin framed is one the
///   user already read on the consent card.
pub(crate) fn validate_contribution(
    tab: &PluginTabContribution,
    caps: &PluginCapabilities,
) -> Result<(), String> {
    let title = tab.title.trim();
    if title.is_empty() || title.chars().count() > TAB_MAX_TITLE {
        return Err(format!(
            "contributes.tab.title must be 1–{TAB_MAX_TITLE} characters"
        ));
    }
    if tab.glyph.as_ref().is_some_and(|g| g.chars().count() > 2) {
        return Err("contributes.tab.glyph must be a single character".into());
    }
    if !caps.web_tab() {
        return Err(
            "contributes.tab requires capabilities.webTab — framing a page is not the same \
             grant as fetching it"
                .into(),
        );
    }
    let url = url::Url::parse(&tab.url).map_err(|_| {
        format!(
            "contributes.tab.url is not a url: {}",
            clean_text(&tab.url, 80, false)
        )
    })?;
    if url.scheme() != TAB_SCHEME {
        return Err(format!(
            "contributes.tab.url must be {TAB_SCHEME}:// — http is refused for a framed tab, \
             localhost included"
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "contributes.tab.url has no host".to_string())?;
    // The SAME matcher `francois.fetch` uses, deliberately: two host matchers is
    // one too many, and the looser one would become the real policy.
    if !net::host_allowed(host, caps.hosts()) {
        return Err(format!(
            "contributes.tab.url host \"{}\" is not in capabilities.network.hosts",
            clean_text(host, 64, false)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::testutil::*;

    fn valid(m: &PluginManifest) -> Result<(), String> {
        install::validate_manifest(m)
    }

    // ---------- FR-81/FR-82: what may be framed ----------

    #[test]
    fn a_contributed_tab_needs_the_web_tab_capability() {
        // FR-81: `network` grants a FETCH, whose result is inert bytes inside the
        // isolate. Framing executes. The consent card has a line for each, so the
        // manifest must ask for each.
        let mut m = manifest_with_tab("acme-ci", "https://dash.acme.dev/ci", "dash.acme.dev");
        assert!(valid(&m).is_ok());

        m.capabilities.web_tab = None;
        let err = valid(&m).unwrap_err();
        assert!(err.contains("capabilities.webTab"), "{err}");
    }

    #[test]
    fn a_tab_url_must_be_https_even_on_loopback() {
        // FR-82: `francois.fetch` exempts http://127.0.0.1 (FR-31); a FRAME does
        // not get that exemption, because a fetch returns bytes and a frame runs
        // them.
        for (url, host) in [
            ("http://127.0.0.1:4317/", "127.0.0.1"),
            ("http://localhost:4317/", "localhost"),
            ("http://dash.acme.dev/", "dash.acme.dev"),
        ] {
            let m = manifest_with_tab("acme-ci", url, host);
            let err = valid(&m).expect_err(&format!("{url} must be refused for a framed tab"));
            assert!(err.contains("https"), "{err}");
        }
        // …and the schemes that would let a plugin supply the DOCUMENT itself,
        // which is the line between "names a page" and "renders markup".
        for url in [
            "data:text/html,<script>x()</script>",
            "javascript:alert(1)",
            "blob:https://dash.acme.dev/x",
            "file:///etc/passwd",
            "not a url",
        ] {
            let m = manifest_with_tab("acme-ci", url, "dash.acme.dev");
            assert!(valid(&m).is_err(), "should refuse {url}");
        }
    }

    #[test]
    fn a_tab_host_must_be_inside_the_declared_network_allowlist() {
        // FR-82: webTab NARROWS network.hosts. A tab pointing somewhere the
        // consent card never listed is exactly the widening this prevents.
        let m = manifest_with_tab("acme-ci", "https://evil.example/x", "dash.acme.dev");
        let err = valid(&m).unwrap_err();
        assert!(err.contains("network.hosts"), "{err}");

        // the wildcard the allowlist declares applies here too — one matcher,
        // never two…
        let mut ok = manifest_with_tab("acme-ci", "https://ci.acme.dev/x", "*.acme.dev");
        assert!(valid(&ok).is_ok());
        // …so the userinfo bypass fails here exactly as it does for fetch.
        ok.contributes.tab.as_mut().unwrap().url = "https://ci.acme.dev@evil.example/".into();
        assert!(valid(&ok).is_err());
    }

    #[test]
    fn a_tab_title_is_bounded_to_the_width_of_the_tab_strip() {
        // FR-81/§8 · H31: TAB_MAX_TITLE chars. Refusing at install is louder
        // than silently truncating a name the author chose.
        let mut m = manifest_with_tab("acme-ci", "https://dash.acme.dev/", "dash.acme.dev");
        m.contributes.tab.as_mut().unwrap().title = "x".repeat(TAB_MAX_TITLE);
        assert!(valid(&m).is_ok());
        m.contributes.tab.as_mut().unwrap().title = "x".repeat(TAB_MAX_TITLE + 1);
        assert!(valid(&m).is_err());
        m.contributes.tab.as_mut().unwrap().title = "  ".into();
        assert!(valid(&m).is_err());
    }

    // ---------- FR-84/FR-86: the app configuration the frame sits in ----------
    //
    // These read `tauri.conf.json` and `capabilities/` from the crate root. They
    // are configuration assertions, and they say so: a webview's runtime
    // behaviour cannot be observed from `cargo test`, so nothing here pretends
    // to have loaded a page.

    fn config() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        serde_json::from_slice(&std::fs::read(path).expect("tauri.conf.json")).expect("valid JSON")
    }

    #[test]
    fn the_app_declares_a_real_csp_that_allows_only_https_frames() {
        // FR-84: `csp: null` is incompatible with this feature. The core's
        // per-plugin host check is the primary gate; this is the backstop for a
        // bug in it.
        let csp = config()["app"]["security"]["csp"]
            .as_str()
            .expect("FR-84: security.csp must be a string, not null")
            .to_string();
        assert!(csp.contains("default-src 'self'"), "{csp}");
        assert!(csp.contains("frame-src https:"), "{csp}");
        assert!(
            !csp.contains("frame-src *") && !csp.contains("frame-src http:"),
            "a frame must never be plaintext or unbounded: {csp}"
        );
        // The app's own needs, which a stricter-looking CSP would silently break:
        // the IPC channel every `invoke` rides on, and the webfont the whole UI
        // is set in. Both fail INVISIBLY (no error, wrong font / dead commands),
        // which is why they are pinned here rather than found at runtime.
        assert!(
            csp.contains("ipc:") && csp.contains("http://ipc.localhost"),
            "every invoke() would fail: {csp}"
        );
        assert!(csp.contains("https://fonts.googleapis.com"), "{csp}");
        assert!(csp.contains("https://fonts.gstatic.com"), "{csp}");
        // xterm.js injects its cell-metrics and theme rules as <style> elements
        // it builds at runtime; without this the SHELL tab renders unstyled.
        assert!(csp.contains("'unsafe-inline'"), "{csp}");
        // …but scripts get no such latitude.
        assert!(!csp.contains("'unsafe-eval'"), "{csp}");
        assert!(
            !csp.contains("script-src 'self' 'unsafe-inline'"),
            "inline script must stay refused: {csp}"
        );
    }

    #[test]
    fn no_capability_grants_a_remote_origin() {
        // FR-86, as far as `cargo test` can honestly reach.
        //
        // The claim "the framed page receives no Francois IPC" cannot be
        // asserted from here — it is a webview runtime property. What CAN be
        // asserted is the configuration that makes it true, and it is the
        // stronger of the two guarantees:
        //
        // Tauri resolves every IPC request's ACL against the ORIGIN in its
        // `Origin` header (tauri::webview::Webview::on_message). A request from
        // anything that is not the app's own origin resolves as `Origin::Remote`
        // and is refused unless a capability explicitly lists that origin under
        // `remote`. No capability here does — so even on a platform whose
        // webview injects init scripts into sub-frames (WebView2 does; wry 0.55
        // passes `for_main_frame_only` through only on macOS and GTK), a framed
        // page holding `__TAURI_INTERNALS__` still cannot invoke a command.
        //
        // FR-83's sandbox closes it a second time: without `allow-same-origin`
        // the frame's origin is opaque, so its `Origin` header is `null`, which
        // Tauri rejects while parsing the request.
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("capabilities/").flatten() {
            if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let v: Value = serde_json::from_slice(&std::fs::read(entry.path()).unwrap())
                .expect("valid capability JSON");
            assert!(
                v.get("remote").is_none(),
                "{:?} grants a remote origin — a framed plugin tab could then invoke commands",
                entry.path()
            );
            checked += 1;
        }
        assert!(checked > 0, "no capability files were checked");

        // `withGlobalTauri` would additionally expose the convenience
        // `window.__TAURI__` object. It is absent, so nothing but the app's own
        // bundle (which imports @tauri-apps/api) reaches the bridge by name.
        assert!(
            config()["app"].get("withGlobalTauri").is_none(),
            "FR-86: withGlobalTauri must stay off"
        );
    }
}
