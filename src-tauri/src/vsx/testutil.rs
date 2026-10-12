// vsx/testutil.rs — shared fixtures: a canned-response `Fetch`, a registry
// pointed at it, and in-memory .vsix builders. No test touches the network.

use super::{Fetch, FetchError, Registry};
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zip::write::SimpleFileOptions;

pub(crate) const BASE: &str = "http://vsx.test";

#[derive(Clone, Default)]
pub(crate) struct FakeFetch {
    routes: Arc<Mutex<HashMap<String, Result<Vec<u8>, u16>>>>,
    pub hits: Arc<Mutex<Vec<String>>>,
}

impl FakeFetch {
    pub fn bytes(&self, url: &str, body: Vec<u8>) {
        self.routes.lock().unwrap().insert(url.into(), Ok(body));
    }
    pub fn json(&self, url: &str, v: serde_json::Value) {
        self.bytes(url, serde_json::to_vec(&v).unwrap());
    }
    pub fn status(&self, url: &str, code: u16) {
        self.routes.lock().unwrap().insert(url.into(), Err(code));
    }
    pub fn hit_count(&self, url: &str) -> usize {
        self.hits
            .lock()
            .unwrap()
            .iter()
            .filter(|u| *u == url)
            .count()
    }
}

impl Fetch for FakeFetch {
    fn get(&self, url: &str, _timeout: Duration) -> Result<Box<dyn Read + Send>, FetchError> {
        self.hits.lock().unwrap().push(url.to_string());
        match self.routes.lock().unwrap().get(url) {
            Some(Ok(b)) => Ok(Box::new(Cursor::new(b.clone()))),
            Some(Err(code)) => Err(FetchError::Status(*code)),
            None => Err(FetchError::Transport(format!("no route for {url}"))),
        }
    }
}

pub(crate) fn registry(fake: &FakeFetch) -> Registry {
    Registry {
        base: BASE.to_string(),
        fetch: Arc::new(fake.clone()),
    }
}

/// A zip of `(name, bytes)` entries, deflated.
pub(crate) fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(bytes).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// A zip with one symlink entry `link_name → target` plus regular entries.
pub(crate) fn zip_with_symlink(
    entries: &[(&str, &[u8])],
    link_name: &str,
    target: &str,
) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    for (name, bytes) in entries {
        w.start_file(*name, opts).unwrap();
        w.write_all(bytes).unwrap();
    }
    w.add_symlink(link_name, target, opts).unwrap();
    w.finish().unwrap().into_inner()
}

/// A declarative TOML-ish package.json with every contribution kind.
pub(crate) fn toml_manifest(version: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "toml",
        "publisher": "acme",
        "displayName": "TOML",
        "description": "TOML support",
        "version": version,
        "icon": "images/icon.png",
        "contributes": {
            "languages": [{
                "id": "toml",
                "aliases": ["TOML", "toml"],
                "extensions": [".toml"],
                "filenames": ["Cargo.lock"],
                "configuration": "./language-configuration.json"
            }],
            "grammars": [
                { "language": "toml", "scopeName": "source.toml", "path": "./syntaxes/toml.tmLanguage.json" },
                { "scopeName": "markdown.toml.codeblock", "path": "./syntaxes/md.tmLanguage", "injectTo": ["text.html.markdown"], "embeddedLanguages": { "meta.embedded.block.toml": "toml" } }
            ],
            "snippets": [{ "language": "toml", "path": "./snippets/toml.json" }]
        }
    })
}

pub(crate) const GRAMMAR_JSON: &[u8] = br#"{ "scopeName": "source.toml", "patterns": [] }"#;
pub(crate) const GRAMMAR_PLIST: &[u8] =
    b"<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>scopeName</key><string>markdown.toml.codeblock</string></dict></plist>";

/// The full declarative .vsix for `toml_manifest`, plus noise that must NOT be kept.
pub(crate) fn toml_vsix(version: &str) -> Vec<u8> {
    let manifest = serde_json::to_vec(&toml_manifest(version)).unwrap();
    zip_of(&[
        ("extension.vsixmanifest", b"<xml/>"),
        ("[Content_Types].xml", b"<xml/>"),
        ("extension/package.json", &manifest),
        (
            "extension/language-configuration.json",
            b"{ // c\n \"comments\": { \"lineComment\": \"#\" } }",
        ),
        ("extension/syntaxes/toml.tmLanguage.json", GRAMMAR_JSON),
        ("extension/syntaxes/md.tmLanguage", GRAMMAR_PLIST),
        (
            "extension/snippets/toml.json",
            b"{ \"table\": { \"prefix\": \"[\", \"body\": \"[$1]\" } }",
        ),
        ("extension/images/icon.png", b"\x89PNG\r\n\x1a\nicon"),
        ("extension/README.md", b"# readme"),
        ("extension/out/extension.js", b"require('child_process')"),
    ])
}
