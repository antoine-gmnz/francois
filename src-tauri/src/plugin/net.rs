//! FR-31 — the core-proxied, allowlisted `francois.fetch`.
//!
//! The plugin never opens a socket. It hands the core a URL and an init object;
//! the core decides whether that URL is reachable, performs the request itself,
//! and hands back a plain `{ status, ok, headers, text }`.
//!
//! Three properties do the actual security work, and each is easy to lose:
//!
//! * **The allowlist is matched on the PARSED host**, never on the raw string. A
//!   handwritten matcher gets bypassed by `https://api.github.com@evil.dev/`,
//!   where the "host" a naive `contains`/`starts_with` sees is the userinfo. The
//!   `url` crate resolves that to `evil.dev` and the check fails, as it must.
//! * **Redirects are not followed** (FR-31 / §7 #17). A 3xx comes back verbatim,
//!   so an allowlisted host cannot launder a request to an unlisted one.
//! * **No ambient authority** — a fresh agent per request, no cookie jar, no
//!   credential store, no proxy auth. A plugin sends exactly the headers it set.
//!
//! An HTTP-level failure (404, 500) is NOT an error here: it resolves as a
//! response with `ok: false`, exactly like the web `fetch` a plugin author
//! expects. Only a transport failure or a policy refusal rejects.

use super::*;

use std::io::Read as _;
use url::{Host, Url};

/// FR-31: the six methods. Anything else — `TRACE`, `CONNECT`, a lowercase verb
/// with a smuggled newline — rejects.
const METHODS: [&str; 6] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/// FR-31: the only hosts reachable over plain `http`. Everything else is https.
/// These are matched EXACTLY (post-parse), never by suffix — `localhost.evil.dev`
/// is not local.
const LOOPBACK_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

#[derive(Debug)]
pub(crate) struct FetchRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

pub(crate) struct FetchResponse {
    pub status: u16,
    pub ok: bool,
    pub headers: Map<String, Value>,
    pub text: String,
}

impl FetchResponse {
    pub(crate) fn to_value(&self) -> Value {
        serde_json::json!({
            "status": self.status,
            "ok": self.ok,
            "headers": self.headers,
            "text": self.text,
        })
    }
}

// ---------- FR-31: the allowlist ----------

/// Normalize a host for comparison: lowercase, trailing dot stripped (FR-13's
/// rule, applied on both sides so `acme.dev.` and `acme.dev` are one host).
fn norm_host(raw: &str) -> String {
    raw.trim_end_matches('.').to_ascii_lowercase()
}

/// FR-31. Exact host, or ONE leading wildcard label:
/// `*.acme.dev` matches `a.acme.dev` **and** the apex `acme.dev`, but not
/// `x.y.acme.dev` — a single label, never a suffix match. That last distinction
/// is the whole point: a suffix matcher would also accept `evil-acme.dev`.
pub(crate) fn host_allowed(host: &str, allowlist: &[String]) -> bool {
    let host = norm_host(host);
    if host.is_empty() {
        return false;
    }
    allowlist.iter().any(|raw| {
        let pattern = norm_host(raw);
        match pattern.strip_prefix("*.") {
            None => pattern == host,
            Some(apex) => {
                if apex.is_empty() {
                    return false; // a bare `*.` is not a wildcard for everything
                }
                if host == apex {
                    return true; // the apex itself
                }
                match host.strip_suffix(apex) {
                    // exactly one label in front: "a." — a dot with no further dots
                    Some(prefix) => {
                        prefix.ends_with('.')
                            && prefix[..prefix.len() - 1].split('.').count() == 1
                            && prefix.len() > 1
                    }
                    None => false,
                }
            }
        }
    })
}

/// The host as the allowlist should see it. An IPv6 literal is bracketed so it
/// matches the `[::1]` spelling a manifest would carry.
fn host_string(url: &Url) -> Option<String> {
    match url.host()? {
        Host::Domain(d) => Some(d.to_string()),
        Host::Ipv4(a) => Some(a.to_string()),
        Host::Ipv6(a) => Some(format!("[{a}]")),
    }
}

/// FR-31's URL policy. Returns the parsed host on success so the caller does not
/// re-derive it (and cannot re-derive it differently).
pub(crate) fn check_url(raw: &str, allowlist: &[String]) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| format!("invalid url: {}", clip(raw)))?;
    let host = host_string(&url).ok_or_else(|| format!("invalid url: {}", clip(raw)))?;

    match url.scheme() {
        "https" => {}
        // http is permitted ONLY for a loopback host, matched exactly (FR-31).
        "http" if LOOPBACK_HOSTS.contains(&norm_host(&host).as_str()) => {}
        "http" => {
            return Err(format!(
                "http is only allowed for localhost — use https for \"{}\"",
                clip(&host)
            ))
        }
        other => return Err(format!("unsupported url scheme \"{}\"", clip(other))),
    }

    if !host_allowed(&host, allowlist) {
        // §7 #16: the message names the host so the plugin author can fix the
        // manifest, and the core also logs it to the ring buffer.
        return Err(format!(
            "host \"{}\" is not in this plugin's allowlist",
            clip(&host)
        ));
    }
    Ok(host)
}

/// Keep a rejection message from becoming a 10 MB string a hostile plugin pushed
/// into the log ring.
fn clip(s: &str) -> String {
    clean_text(s, 120, false)
}

/// FR-31/FR-33: validate the host call's arguments. Everything a plugin controls
/// is checked here, before any socket exists.
pub(crate) fn build_request(
    raw_url: &str,
    init: &Value,
    allowlist: &[String],
) -> Result<FetchRequest, String> {
    check_url(raw_url, allowlist)?;

    let method = match init.get("method") {
        None | Some(Value::Null) => "GET".to_string(),
        Some(v) => {
            let m = v
                .as_str()
                .ok_or_else(|| "method must be a string".to_string())?
                .to_ascii_uppercase();
            if !METHODS.contains(&m.as_str()) {
                return Err(format!("method \"{}\" is not allowed", clip(&m)));
            }
            m
        }
    };

    let mut headers = Vec::new();
    match init.get("headers") {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (name, value) in map {
                let value = value
                    .as_str()
                    .ok_or_else(|| format!("header \"{}\" must be a string", clip(name)))?;
                // FR-31: `Host` is the one header a plugin may not set — it would
                // let an allowlisted connection address a different vhost.
                if name.eq_ignore_ascii_case("host") {
                    return Err("the Host header cannot be set".into());
                }
                // Header injection: a CR/LF in either half would split the request.
                if !is_header_name(name) || value.bytes().any(|b| b == b'\r' || b == b'\n') {
                    return Err(format!("invalid header \"{}\"", clip(name)));
                }
                headers.push((name.clone(), value.to_string()));
            }
        }
        Some(_) => return Err("headers must be an object".into()),
    }

    let body = match init.get("body") {
        None | Some(Value::Null) => None,
        Some(v) => {
            let b = v
                .as_str()
                .ok_or_else(|| "body must be a string".to_string())?;
            if b.len() > FETCH_MAX_REQUEST_BYTES {
                return Err("request body exceeds 1 MB".into());
            }
            Some(b.to_string())
        }
    };

    Ok(FetchRequest {
        url: raw_url.to_string(),
        method,
        headers,
        body,
    })
}

/// RFC 7230 token, which is what a header name is. Rejects spaces, colons and
/// control characters — the pieces a request-splitting payload needs.
fn is_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

// ---------- the call itself ----------

/// Perform an already-validated request. Blocking: this runs on the isolate's own
/// worker thread, never on the Tauri command thread (FR-22).
pub(crate) fn perform(req: &FetchRequest) -> Result<FetchResponse, String> {
    let agent = ureq::AgentBuilder::new()
        // FR-31 / §7 #17: a 3xx is DATA, not a hop to take.
        .redirects(0)
        .timeout(std::time::Duration::from_millis(FETCH_TIMEOUT_MS))
        .build();

    let mut call = agent.request(&req.method, &req.url);
    for (name, value) in &req.headers {
        call = call.set(name, value);
    }
    let sent = match &req.body {
        Some(b) => call.send_string(b),
        None => call.call(),
    };

    // A 4xx/5xx is a RESPONSE the plugin should see, not a rejection — ureq
    // models those as errors, so both arms funnel into the same reader.
    let resp = match sent {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(ureq::Error::Transport(t)) => {
            return Err(match t.kind() {
                ureq::ErrorKind::Io => "request timed out or the connection failed".into(),
                _ => format!("request failed: {}", clip(&t.to_string())),
            })
        }
    };

    let status = resp.status();
    let mut headers = Map::new();
    for name in resp.headers_names() {
        if let Some(v) = resp.header(&name) {
            // FR-31: lowercased names, so a plugin can index them predictably.
            headers.insert(name.to_ascii_lowercase(), Value::String(v.to_string()));
        }
    }

    // Read one byte PAST the cap so "exactly 5 MB" passes and "5 MB + 1" is
    // detected rather than silently truncated (FR-31: a truncated response
    // rejects — a plugin must never parse half a document as if it were whole).
    let mut buf = Vec::new();
    resp.into_reader()
        .take(FETCH_MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "the response could not be read".to_string())?;
    if buf.len() > FETCH_MAX_RESPONSE_BYTES {
        return Err("response exceeds 5 MB".into());
    }

    Ok(FetchResponse {
        status,
        ok: (200..300).contains(&status),
        headers,
        // FR-31: UTF-8 lossy — a binary body becomes replacement characters
        // rather than failing, because v1 has no binary body type.
        text: String::from_utf8_lossy(&buf).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn list(hosts: &[&str]) -> Vec<String> {
        hosts.iter().map(|h| (*h).to_string()).collect()
    }

    // ---------- FR-31: allowlist matching ----------

    #[test]
    fn an_exact_host_matches_case_insensitively_and_nothing_else() {
        let allow = list(&["api.github.com"]);
        for host in ["api.github.com", "API.GitHub.com", "api.github.com."] {
            assert!(host_allowed(host, &allow), "should allow {host}");
        }
        for host in [
            "github.com",          // the apex is not the host
            "evil.api.github.com", // a subdomain of it is not it
            "api.github.com.evil.dev",
            "xapi.github.com",
            "",
        ] {
            assert!(!host_allowed(host, &allow), "should refuse {host}");
        }
    }

    #[test]
    fn a_wildcard_matches_one_label_and_the_apex_but_never_two_labels() {
        // FR-31, verbatim: `*.acme.dev` matches `a.acme.dev` AND `acme.dev`,
        // but not `x.y.acme.dev`.
        let allow = list(&["*.acme.dev"]);
        for host in ["a.acme.dev", "acme.dev", "ACME.dev", "www.acme.dev"] {
            assert!(host_allowed(host, &allow), "should allow {host}");
        }
        for host in [
            "x.y.acme.dev",  // two labels
            "evil-acme.dev", // the suffix-match bug this guards against
            "acme.dev.evil.com",
            "dev",
        ] {
            assert!(!host_allowed(host, &allow), "should refuse {host}");
        }
    }

    #[test]
    fn a_bare_wildcard_is_never_a_wildcard_for_everything() {
        assert!(!host_allowed("anything.dev", &list(&["*."])));
        assert!(!host_allowed("anything.dev", &list(&["*"])));
        assert!(!host_allowed("anything.dev", &[]));
    }

    // ---------- FR-31: URL policy ----------

    #[test]
    fn https_is_required_except_for_exact_loopback_hosts() {
        assert!(check_url("https://api.github.com/x", &list(&["api.github.com"])).is_ok());

        for (url, host) in [
            ("http://localhost:4317/api", "localhost"),
            ("http://127.0.0.1:4317/api", "127.0.0.1"),
            ("http://[::1]:4317/api", "[::1]"),
        ] {
            assert!(check_url(url, &list(&[host])).is_ok(), "should allow {url}");
        }

        // plain http to a non-loopback host, even an allowlisted one
        let e = check_url("http://api.github.com/x", &list(&["api.github.com"])).unwrap_err();
        assert!(e.contains("only allowed for localhost"), "{e}");

        // a host that merely LOOKS local is not local
        assert!(check_url("http://localhost.evil.dev/", &list(&["*.evil.dev"])).is_err());
        assert!(check_url("http://127.0.0.1.evil.dev/", &list(&["*.evil.dev"])).is_err());
    }

    #[test]
    fn non_http_schemes_are_refused() {
        for url in [
            "file:///etc/passwd",
            "ftp://acme.dev/x",
            "data:text/plain,hi",
            "javascript:alert(1)",
            "not a url",
            "",
        ] {
            assert!(
                check_url(url, &list(&["acme.dev"])).is_err(),
                "should refuse {url}"
            );
        }
    }

    #[test]
    fn userinfo_cannot_smuggle_an_allowlisted_host_past_the_check() {
        // The bypass a hand-rolled matcher falls to: everything before `@` is
        // userinfo, so the real host here is evil.dev.
        let allow = list(&["api.github.com"]);
        for url in [
            "https://api.github.com@evil.dev/x",
            "https://api.github.com:pass@evil.dev/x",
            "https://evil.dev/?x=api.github.com",
            "https://evil.dev/api.github.com",
        ] {
            let e = check_url(url, &allow).unwrap_err();
            assert!(e.contains("not in this plugin's allowlist"), "{url} → {e}");
        }
        // ...and userinfo in front of an ALLOWED host is still that host
        assert!(check_url("https://user@api.github.com/x", &allow).is_ok());
    }

    #[test]
    fn a_port_does_not_change_which_host_is_matched() {
        // Worth stating: FR-31 matches on the HOST only, so the allowlist does not
        // constrain the port. `127.0.0.1` therefore grants every loopback service.
        let allow = list(&["127.0.0.1"]);
        assert!(check_url("http://127.0.0.1:4317/api/fleet", &allow).is_ok());
        assert!(check_url("http://127.0.0.1:9999/other", &allow).is_ok());
    }

    #[test]
    fn the_refusal_message_names_the_host_and_stays_short() {
        let e = check_url("https://evil.dev/x", &list(&["acme.dev"])).unwrap_err();
        assert!(e.contains("evil.dev") && e.contains("allowlist"), "{e}");
        // a hostile plugin cannot push a huge string into the log ring this way
        let long = format!("https://{}.dev/", "a".repeat(5000));
        assert!(check_url(&long, &[]).unwrap_err().len() < 300);
    }

    // ---------- FR-31/FR-33: init validation ----------

    #[test]
    fn the_six_methods_are_accepted_and_normalized_and_the_rest_refused() {
        let allow = list(&["acme.dev"]);
        for m in ["get", "POST", "Put", "patch", "DELETE", "head"] {
            let req = build_request("https://acme.dev/", &json!({ "method": m }), &allow).unwrap();
            assert_eq!(req.method, m.to_ascii_uppercase());
        }
        for m in ["TRACE", "CONNECT", "OPTIONS", "GET\r\nX: y", ""] {
            assert!(
                build_request("https://acme.dev/", &json!({ "method": m }), &allow).is_err(),
                "should refuse method {m:?}"
            );
        }
        // absent ⇒ GET
        assert_eq!(
            build_request("https://acme.dev/", &json!({}), &allow)
                .unwrap()
                .method,
            "GET"
        );
    }

    #[test]
    fn the_host_header_is_rejected_and_every_other_header_passes_through() {
        let allow = list(&["acme.dev"]);
        for name in ["Host", "host", "HOST"] {
            let e = build_request(
                "https://acme.dev/",
                &json!({ "headers": { name: "evil.dev" } }),
                &allow,
            )
            .unwrap_err();
            assert!(e.contains("Host header"), "{e}");
        }
        let req = build_request(
            "https://acme.dev/",
            &json!({ "headers": { "Authorization": "Bearer x", "X-Custom": "1" } }),
            &allow,
        )
        .unwrap();
        assert_eq!(req.headers.len(), 2);
        assert!(req
            .headers
            .iter()
            .any(|(n, v)| n == "Authorization" && v == "Bearer x"));
    }

    #[test]
    fn header_injection_through_a_name_or_a_value_is_refused() {
        let allow = list(&["acme.dev"]);
        for headers in [
            json!({ "X-A\r\nX-B": "v" }),
            json!({ "X-A": "v\r\nX-B: w" }),
            json!({ "X A": "v" }),
            json!({ "X:A": "v" }),
            json!({ "": "v" }),
            json!({ "X-A": 42 }),
        ] {
            assert!(
                build_request("https://acme.dev/", &json!({ "headers": headers }), &allow).is_err(),
                "should refuse {headers}"
            );
        }
        assert!(build_request("https://acme.dev/", &json!({ "headers": [] }), &allow).is_err());
    }

    #[test]
    fn a_body_is_bounded_at_one_megabyte() {
        let allow = list(&["acme.dev"]);
        let at = "x".repeat(FETCH_MAX_REQUEST_BYTES);
        assert!(build_request("https://acme.dev/", &json!({ "body": at }), &allow).is_ok());
        let over = "x".repeat(FETCH_MAX_REQUEST_BYTES + 1);
        assert!(build_request("https://acme.dev/", &json!({ "body": over }), &allow).is_err());
        assert!(build_request("https://acme.dev/", &json!({ "body": 42 }), &allow).is_err());
        assert_eq!(
            build_request("https://acme.dev/", &json!({}), &allow)
                .unwrap()
                .body,
            None
        );
    }

    #[test]
    fn a_disallowed_url_is_refused_before_any_init_parsing() {
        // Order matters: the policy refusal must not be maskable by also passing a
        // bad method, or a plugin could probe which check fired.
        let e = build_request(
            "https://evil.dev/",
            &json!({ "method": "TRACE" }),
            &list(&["acme.dev"]),
        )
        .unwrap_err();
        assert!(e.contains("allowlist"), "{e}");
    }

    #[test]
    fn the_response_shape_matches_the_contract() {
        let mut headers = Map::new();
        headers.insert(
            "content-type".into(),
            Value::String("application/json".into()),
        );
        let v = FetchResponse {
            status: 404,
            ok: false,
            headers,
            text: "{}".into(),
        }
        .to_value();
        assert_eq!(v["status"], 404);
        assert_eq!(v["ok"], false);
        assert_eq!(v["headers"]["content-type"], "application/json");
        assert_eq!(v["text"], "{}");
    }
}
