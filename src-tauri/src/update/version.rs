//! FR-4 — `updateAvailable` is true iff `latest` is strictly greater than
//! `current`, compared as a numeric `major.minor.patch` triple. A version
//! carrying a pre-release suffix sorts below the same triple without one.
//!
//! Deliberately NOT a general semver implementation: nothing here orders two
//! pre-releases of the same triple against each other (`rc.2` vs `rc.10`), which
//! the release pipeline never publishes. What it does guarantee is that the
//! comparison is numeric — `0.10.0` is newer than `0.9.0` — and that a downgrade
//! is never offered.

/// A sortable key for a version string: the numeric triple plus a release rank
/// (0 = pre-release, 1 = release), so `0.16.0-beta.1` sorts below `0.16.0`.
/// `None` when the string is not `<u64>.<u64>.<u64>` with an optional
/// `-<pre>` and/or `+<build>` suffix.
fn version_key(v: &str) -> Option<(u64, u64, u64, u8)> {
    // Build metadata carries no ordering (semver §10) — drop it first, so a
    // `+sha` suffix does not make an identical version look different.
    let core = v.split('+').next().unwrap_or(v);
    let (core, rank) = match core.split_once('-') {
        Some((triple, pre)) if !pre.is_empty() => (triple, 0),
        Some(_) => return None, // a trailing '-' with nothing after it
        None => (core, 1),
    };

    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None; // more than a triple — not a version we know how to order
    }
    Some((major, minor, patch, rank))
}

/// FR-4: is `latest` strictly greater than `current`? `None` when either side is
/// unparseable — the caller turns that into a check failure (FR-6), NEVER into
/// `false`, which would silently hide a real update behind a formatting change.
pub fn is_newer(latest: &str, current: &str) -> Option<bool> {
    Some(version_key(latest)? > version_key(current)?)
}

#[cfg(test)]
mod tests {
    use super::super::*;

    #[test]
    fn a_higher_patch_is_newer() {
        assert_eq!(is_newer("0.15.9", "0.15.8"), Some(true));
    }

    #[test]
    fn the_same_version_is_not_newer() {
        assert_eq!(is_newer("0.15.8", "0.15.8"), Some(false));
    }

    // §7: a local dev build ahead of the registry must never be offered a downgrade.
    #[test]
    fn an_older_latest_is_never_newer() {
        assert_eq!(is_newer("0.15.7", "0.15.8"), Some(false));
        assert_eq!(is_newer("0.9.0", "0.10.0"), Some(false));
    }

    // The comparison is numeric, not lexical — "0.10.0" > "0.9.0".
    #[test]
    fn components_compare_numerically_not_lexically() {
        assert_eq!(is_newer("0.10.0", "0.9.0"), Some(true));
        assert_eq!(is_newer("1.0.0", "0.99.99"), Some(true));
        assert_eq!(is_newer("0.16.10", "0.16.9"), Some(true));
    }

    // FR-4: a pre-release sorts BELOW the same triple without one.
    #[test]
    fn a_prerelease_sorts_below_the_same_release_triple() {
        assert_eq!(is_newer("0.16.0-beta.1", "0.16.0"), Some(false));
        assert_eq!(is_newer("0.16.0", "0.16.0-beta.1"), Some(true));
        assert_eq!(is_newer("0.16.0-beta.1", "0.15.8"), Some(true));
    }

    #[test]
    fn build_metadata_is_ignored() {
        assert_eq!(is_newer("0.16.0+abc123", "0.16.0"), Some(false));
        assert_eq!(is_newer("0.16.1+abc123", "0.16.0"), Some(true));
    }

    // FR-4: an unparseable `latest` is a check failure (FR-6), never `false`.
    #[test]
    fn an_unparseable_version_is_none_not_false() {
        assert_eq!(is_newer("", "0.15.8"), None);
        assert_eq!(is_newer("latest", "0.15.8"), None);
        assert_eq!(is_newer("0.16", "0.15.8"), None);
        assert_eq!(is_newer("0.16.0.1", "0.15.8"), None);
        assert_eq!(is_newer("0.x.0", "0.15.8"), None);
        assert_eq!(is_newer("0.16.0", "nonsense"), None);
    }

    // The build actually running always parses — CARGO_PKG_VERSION is written by
    // release.yml's version job (FR-1).
    #[test]
    fn the_running_version_is_comparable() {
        assert_eq!(is_newer(current_version(), current_version()), Some(false));
    }
}
