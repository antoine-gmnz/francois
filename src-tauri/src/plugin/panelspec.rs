//! FR-34..FR-44 — validation and normalization of everything a plugin returns.
//!
//! This module is the reason the webview can render plugin output without ever
//! trusting it. A handler returns arbitrary JSON; what leaves here is a typed
//! `PanelSpec`/`StatusItemSpec` whose every string is control-char-free and
//! length-bounded, whose tree is node- and depth-capped, and whose node types are
//! exactly the ten frozen ones (FR-35).
//!
//! Two deliberate asymmetries:
//!
//! * **A malformed NODE never fails the panel** (FR-35). It becomes the
//!   `⟨invalid node⟩` text placeholder and its siblings render normally. The Rust
//!   `PanelNode` enum cannot hold an unknown variant, so this substitution has to
//!   happen here — the frontend receives only well-typed nodes.
//! * **A malformed SPEC does fail** — a non-object, a missing `nodes` array, a
//!   missing `text` on a status item. Those are not "one bad row", they are a
//!   handler that did not return the shape it promised.
//!
//! `version` is passed through VERBATIM and is not checked here: FR-34 makes it
//! the compatibility gate, and the frontend renders `unsupported panel version`
//! for anything but `1`. Normalizing a v2 tree under v1 rules would be a lie.

use super::*;

/// FR-36's budget, threaded through the walk. Once `remaining` hits zero the tree
/// stops growing and `truncated` latches — the caller appends the notice ONCE, at
/// top level, rather than at every point the cap was felt.
struct Budget {
    remaining: usize,
    truncated: bool,
}

impl Budget {
    /// Consume one node's worth of budget. `false` ⇒ the cap is reached and the
    /// caller must stop emitting.
    fn take(&mut self) -> bool {
        if self.remaining == 0 {
            self.truncated = true;
            return false;
        }
        self.remaining -= 1;
        true
    }

    fn cut(&mut self) {
        self.truncated = true;
    }
}

/// FR-35: the placeholder a node degrades to. Dim, so a plugin cannot use a
/// deliberately-malformed node as a way to draw attention.
fn invalid_node() -> PanelNode {
    PanelNode::Text {
        value: PANEL_INVALID_NODE.to_string(),
        tone: Some(PanelTone::Dim),
        wrap: None,
    }
}

fn truncated_node() -> PanelNode {
    PanelNode::Text {
        value: PANEL_TRUNCATED_NOTICE.to_string(),
        tone: Some(PanelTone::Warn),
        wrap: None,
    }
}

// ---------- field readers ----------
//
// Each returns Option: `None` means "this node is invalid" and the caller
// degrades the whole node. A MISSING optional field and a WRONGLY-TYPED optional
// field are different — the first is fine, the second invalidates the node, which
// mirrors the frontend's `isOneOf`/`isStrOpt` guards exactly.

fn req_str(v: &Value, key: &str, max: usize) -> Option<String> {
    Some(clean_text(v.get(key)?.as_str()?, max, false))
}

fn opt_str(v: &Value, key: &str, max: usize) -> Option<Option<String>> {
    match v.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(raw) => Some(Some(clean_text(raw.as_str()?, max, false))),
    }
}

fn opt_bool(v: &Value, key: &str) -> Option<Option<bool>> {
    match v.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(raw) => Some(Some(raw.as_bool()?)),
    }
}

fn parse_tone(raw: &str) -> Option<PanelTone> {
    Some(match raw {
        "default" => PanelTone::Default,
        "dim" => PanelTone::Dim,
        "accent" => PanelTone::Accent,
        "success" => PanelTone::Success,
        "warn" => PanelTone::Warn,
        "error" => PanelTone::Error,
        _ => return None,
    })
}

fn opt_tone(v: &Value) -> Option<Option<PanelTone>> {
    match v.get("tone") {
        None | Some(Value::Null) => Some(None),
        Some(raw) => Some(Some(parse_tone(raw.as_str()?)?)),
    }
}

fn opt_gap(v: &Value) -> Option<Option<PanelGap>> {
    match v.get("gap") {
        None | Some(Value::Null) => Some(None),
        Some(raw) => Some(Some(match raw.as_str()? {
            "sm" => PanelGap::Sm,
            "md" => PanelGap::Md,
            _ => return None,
        })),
    }
}

fn opt_align(v: &Value) -> Option<Option<PanelAlign>> {
    match v.get("align") {
        None | Some(Value::Null) => Some(None),
        Some(raw) => Some(Some(match raw.as_str()? {
            "start" => PanelAlign::Start,
            "center" => PanelAlign::Center,
            "between" => PanelAlign::Between,
            _ => return None,
        })),
    }
}

/// FR-39: a FLAT map of primitives, bounded on every axis. A breach invalidates
/// the whole `action` node rather than being trimmed, because `args` must
/// round-trip VERBATIM into `PluginCommandContext.args` — silently dropping a key
/// or clipping a value would hand the command a payload the plugin never wrote.
fn opt_args(v: &Value) -> Option<Option<Map<String, Value>>> {
    let raw = match v.get("args") {
        None | Some(Value::Null) => return Some(None),
        Some(raw) => raw.as_object()?,
    };
    if raw.len() > PANEL_MAX_ARG_KEYS {
        return None;
    }
    let mut out = Map::new();
    for (k, val) in raw {
        if k.len() > PANEL_MAX_ARG_KEY_LEN {
            return None;
        }
        match val {
            Value::String(s) if s.len() > PANEL_MAX_ARG_VALUE_LEN => return None,
            // A non-finite number is not JSON anyway, but serde_json can hold one
            // via an f64 — and the frontend's Number.isFinite guard rejects it.
            Value::Number(n) if !n.is_f64() && !n.is_i64() && !n.is_u64() => return None,
            Value::String(_) | Value::Number(_) | Value::Bool(_) => {}
            _ => return None, // nested object or array (FR-39)
        }
        out.insert(k.clone(), val.clone());
    }
    Some(Some(out))
}

fn children_of(v: &Value, key: &str, depth: usize, budget: &mut Budget) -> Option<Vec<PanelNode>> {
    let raw = v.get(key)?.as_array()?;
    Some(convert_nodes(raw, depth, budget))
}

// ---------- the walk ----------

fn convert_nodes(raw: &[Value], depth: usize, budget: &mut Budget) -> Vec<PanelNode> {
    // A container whose children would exceed the depth cap keeps the container
    // and drops the subtree — the alternative (invalidating the ancestor) would
    // let one deep leaf erase a whole visible section.
    if depth > PANEL_MAX_DEPTH {
        if !raw.is_empty() {
            budget.cut();
        }
        return Vec::new();
    }
    let mut out = Vec::new();
    for node in raw {
        if !budget.take() {
            break;
        }
        out.push(convert_node(node, depth, budget));
    }
    out
}

fn convert_node(raw: &Value, depth: usize, budget: &mut Budget) -> PanelNode {
    convert_node_inner(raw, depth, budget).unwrap_or_else(invalid_node)
}

/// `None` anywhere in here means "unknown type, missing required field, or wrong
/// field type" — FR-35's three degradation triggers, in one place.
fn convert_node_inner(raw: &Value, depth: usize, budget: &mut Budget) -> Option<PanelNode> {
    let next = depth + 1;
    Some(match raw.get("type")?.as_str()? {
        "text" => PanelNode::Text {
            value: req_str(raw, "value", PANEL_MAX_TEXT)?,
            tone: opt_tone(raw)?,
            wrap: opt_bool(raw, "wrap")?,
        },
        "row" => PanelNode::Row {
            children: children_of(raw, "children", next, budget)?,
            gap: opt_gap(raw)?,
            align: opt_align(raw)?,
        },
        "stack" => PanelNode::Stack {
            children: children_of(raw, "children", next, budget)?,
            gap: opt_gap(raw)?,
        },
        "list" => PanelNode::List {
            items: children_of(raw, "items", next, budget)?,
            selectable: opt_bool(raw, "selectable")?,
            empty_text: opt_str(raw, "emptyText", PANEL_MAX_EMPTY_TEXT)?,
        },
        "badge" => PanelNode::Badge {
            value: req_str(raw, "value", PANEL_MAX_BADGE)?,
            tone: opt_tone(raw)?,
        },
        "keyhint" => PanelNode::Keyhint {
            value: req_str(raw, "value", PANEL_MAX_KEYHINT)?,
        },
        "divider" => PanelNode::Divider,
        "action" => PanelNode::Action {
            label: req_str(raw, "label", PANEL_MAX_ACTION_LABEL)?,
            command_id: req_str(raw, "commandId", PANEL_MAX_ACTION_LABEL)?,
            args: opt_args(raw)?,
            keyhint: opt_str(raw, "keyhint", PANEL_MAX_KEYHINT)?,
        },
        "progress" => PanelNode::Progress {
            // FR-36: clamped, never rejected — a plugin reporting 140% means 100%.
            percent: raw
                .get("percent")?
                .as_f64()
                .filter(|p| p.is_finite())?
                .clamp(0.0, 100.0),
            label: opt_str(raw, "label", PANEL_MAX_TEXT)?,
        },
        "spinner" => PanelNode::Spinner {
            label: opt_str(raw, "label", PANEL_MAX_TEXT)?,
        },
        _ => return None, // FR-35: an unknown type is not extensible in v1
    })
}

// ---------- entry points ----------

/// FR-34/FR-36. `Err` is a message for `PLUGIN_RUNTIME_ERROR`; it names what the
/// handler should have returned, because the plugin author is the only one who
/// can fix it.
pub(crate) fn validate_panel(raw: &Value) -> Result<PanelSpec, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "panel() must return an object or null".to_string())?;
    let version =
        obj.get("version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "panel() must return { version, nodes }".to_string())? as u32;
    let nodes_raw = obj
        .get("nodes")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "panel() must return { version, nodes }".to_string())?;

    let mut budget = Budget {
        remaining: PANEL_MAX_NODES,
        truncated: false,
    };
    let mut nodes = convert_nodes(nodes_raw, 0, &mut budget);
    if budget.truncated {
        // The notice sits OUTSIDE the budget on purpose: the user must always be
        // told the tree was cut, even when the cut is what freed the last slot.
        nodes.push(truncated_node());
    }
    Ok(PanelSpec {
        version,
        title: opt_str(raw, "title", PANEL_MAX_TITLE).unwrap_or(None),
        nodes,
    })
}

/// FR-42: the same rules, tighter bounds. `text` is required — a status item
/// without one is a malformed return, not an empty one (FR-43 covers clearing,
/// and that is spelled `null`).
pub(crate) fn validate_status(raw: &Value) -> Result<StatusItemSpec, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "statusBar() must return an object or null".to_string())?;
    let version =
        obj.get("version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "statusBar() must return { version, text }".to_string())? as u32;
    let text = req_str(raw, "text", STATUS_MAX_TEXT)
        .ok_or_else(|| "statusBar() must return { version, text }".to_string())?;
    Ok(StatusItemSpec {
        version,
        text,
        // A malformed OPTIONAL on a status item drops that optional rather than
        // failing the item — there are no siblings here to degrade against.
        tone: opt_tone(raw).unwrap_or(None),
        badge: opt_str(raw, "badge", STATUS_MAX_BADGE).unwrap_or(None),
        command_id: opt_str(raw, "commandId", PANEL_MAX_ACTION_LABEL).unwrap_or(None),
    })
}

/// FR-81: validate a `tab()` return.
///
/// The URL goes through `net::check_url` — the SAME gate `francois.fetch` uses.
/// That is the whole security argument for this surface: a plugin can frame an
/// origin exactly when it could already have fetched it, so contributing a tab
/// widens no grant. Reimplementing a looser check here is how that would quietly
/// stop being true, so it deliberately calls the one function.
pub(crate) fn validate_tab(raw: &Value, allowlist: &[String]) -> Result<TabSpec, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "tab() must return an object or null".to_string())?;
    let version = obj
        .get("version")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "tab() must return { version, url } or { version, message }".to_string())?
        as u32;

    let url = opt_str(raw, "url", PANEL_MAX_TEXT).unwrap_or(None);
    let message = opt_str(raw, "message", PANEL_MAX_TEXT).unwrap_or(None);

    match (&url, &message) {
        (Some(_), Some(_)) => {
            // Ambiguous: framing the page and explaining why there is no page
            // are opposite outcomes, and guessing which one the author meant
            // would make the tab's behaviour depend on our tie-break.
            return Err("tab() must return url OR message, not both".into());
        }
        (None, None) => return Err("tab() must return either url or message".into()),
        _ => {}
    }

    let url = match url {
        Some(u) => {
            crate::plugin::net::check_url(&u, allowlist)?;
            Some(u)
        }
        None => None,
    };

    let action = match raw.get("action") {
        None | Some(Value::Null) => None,
        Some(a) => {
            let label = req_str(a, "label", PANEL_MAX_ACTION_LABEL);
            let command_id = req_str(a, "commandId", PANEL_MAX_ACTION_LABEL);
            match (label, command_id) {
                (Some(label), Some(command_id)) => Some(TabAction { label, command_id }),
                // A malformed action drops the action, never the whole tab —
                // same degradation rule the optionals on a status item follow.
                _ => None,
            }
        }
    };

    Ok(TabSpec {
        version,
        url,
        message,
        action,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn panel(nodes: Value) -> PanelSpec {
        validate_panel(&json!({ "version": 1, "nodes": nodes })).unwrap()
    }

    fn text_of(node: &PanelNode) -> &str {
        match node {
            PanelNode::Text { value, .. } => value,
            other => panic!("expected a text node, got {other:?}"),
        }
    }

    // ---------- FR-35: the ten types ----------

    #[test]
    fn all_ten_node_types_survive_validation() {
        let spec = panel(json!([
            { "type": "text", "value": "hi", "tone": "accent", "wrap": true },
            { "type": "row", "children": [{ "type": "divider" }], "gap": "md", "align": "between" },
            { "type": "stack", "children": [], "gap": "sm" },
            { "type": "list", "items": [], "selectable": true, "emptyText": "none" },
            { "type": "badge", "value": "ok", "tone": "success" },
            { "type": "keyhint", "value": "⏎" },
            { "type": "divider" },
            { "type": "action", "label": "open", "commandId": "open-run", "args": { "runId": "4821" } },
            { "type": "progress", "percent": 42 },
            { "type": "spinner", "label": "loading" }
        ]));
        assert_eq!(spec.nodes.len(), 10);
        assert!(spec.nodes.iter().all(|n| *n != invalid_node()));
    }

    #[test]
    fn an_unknown_type_or_a_bad_field_degrades_only_that_node() {
        // FR-35 / §7 #19: siblings render normally.
        let spec = panel(json!([
            { "type": "text", "value": "before" },
            { "type": "iframe", "src": "http://evil" },      // unknown type
            { "type": "text" },                               // missing required `value`
            { "type": "text", "value": 42 },                  // wrong field type
            { "type": "text", "value": "x", "tone": "pink" }, // tone outside the six
            { "type": "text", "value": "x", "wrap": "yes" },  // wrong optional type
            { "type": "badge" },
            { "type": "progress", "percent": "high" },
            "not an object",
            null,
            { "type": "text", "value": "after" }
        ]));
        assert_eq!(text_of(&spec.nodes[0]), "before");
        for i in 1..=8 {
            assert_eq!(spec.nodes[i], invalid_node(), "node {i} should degrade");
        }
        assert_eq!(spec.nodes[9], invalid_node());
        assert_eq!(text_of(&spec.nodes[10]), "after");
    }

    #[test]
    fn the_invalid_placeholder_is_dim_so_it_cannot_be_used_for_emphasis() {
        assert_eq!(
            invalid_node(),
            PanelNode::Text {
                value: PANEL_INVALID_NODE.into(),
                tone: Some(PanelTone::Dim),
                wrap: None
            }
        );
    }

    #[test]
    fn a_deep_grandchild_never_invalidates_its_ancestor() {
        let spec = panel(json!([
            { "type": "row", "children": [{ "type": "nope" }, { "type": "text", "value": "ok" }] }
        ]));
        match &spec.nodes[0] {
            PanelNode::Row { children, .. } => {
                assert_eq!(children[0], invalid_node());
                assert_eq!(text_of(&children[1]), "ok");
            }
            other => panic!("expected a row, got {other:?}"),
        }
    }

    // ---------- FR-36: normalization ----------

    #[test]
    fn every_string_field_is_truncated_to_its_own_cap() {
        let spec = validate_panel(&json!({
            "version": 1,
            "title": "T".repeat(200),
            "nodes": [
                { "type": "text", "value": "a".repeat(5000) },
                { "type": "badge", "value": "b".repeat(100) },
                { "type": "keyhint", "value": "k".repeat(50) },
                { "type": "action", "label": "l".repeat(200), "commandId": "c", "keyhint": "x".repeat(50) },
                { "type": "list", "items": [], "emptyText": "e".repeat(500) },
            ]
        }))
        .unwrap();
        assert_eq!(
            spec.title.as_deref().unwrap().chars().count(),
            PANEL_MAX_TITLE
        );
        assert_eq!(text_of(&spec.nodes[0]).chars().count(), PANEL_MAX_TEXT);
        match &spec.nodes[1] {
            PanelNode::Badge { value, .. } => assert_eq!(value.chars().count(), PANEL_MAX_BADGE),
            other => panic!("{other:?}"),
        }
        match &spec.nodes[2] {
            PanelNode::Keyhint { value } => assert_eq!(value.chars().count(), PANEL_MAX_KEYHINT),
            other => panic!("{other:?}"),
        }
        match &spec.nodes[3] {
            PanelNode::Action { label, keyhint, .. } => {
                assert_eq!(label.chars().count(), PANEL_MAX_ACTION_LABEL);
                assert_eq!(
                    keyhint.as_deref().unwrap().chars().count(),
                    PANEL_MAX_KEYHINT
                );
            }
            other => panic!("{other:?}"),
        }
        match &spec.nodes[4] {
            PanelNode::List { empty_text, .. } => {
                assert_eq!(
                    empty_text.as_deref().unwrap().chars().count(),
                    PANEL_MAX_EMPTY_TEXT
                )
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn control_characters_are_stripped_from_every_string() {
        // A plugin must not be able to smuggle ANSI escapes or newlines that would
        // break the pane's single-line layout.
        let spec = panel(json!([
            { "type": "text", "value": "a\u{1b}[31mred\nb\tc" },
            { "type": "badge", "value": "o\u{0}k" }
        ]));
        assert_eq!(text_of(&spec.nodes[0]), "a[31mredbc");
        match &spec.nodes[1] {
            PanelNode::Badge { value, .. } => assert_eq!(value, "ok"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn truncation_counts_characters_not_bytes() {
        let spec = panel(json!([{ "type": "keyhint", "value": "é".repeat(50) }]));
        match &spec.nodes[0] {
            PanelNode::Keyhint { value } => {
                assert_eq!(value.chars().count(), PANEL_MAX_KEYHINT);
                assert!(value.is_char_boundary(value.len()));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn progress_percent_is_clamped_not_rejected() {
        let spec = panel(json!([
            { "type": "progress", "percent": 140 },
            { "type": "progress", "percent": -20 },
            { "type": "progress", "percent": 42.5 }
        ]));
        let pct = |n: &PanelNode| match n {
            PanelNode::Progress { percent, .. } => *percent,
            other => panic!("{other:?}"),
        };
        assert_eq!(pct(&spec.nodes[0]), 100.0);
        assert_eq!(pct(&spec.nodes[1]), 0.0);
        assert_eq!(pct(&spec.nodes[2]), 42.5);
    }

    #[test]
    fn a_fifty_thousand_node_spec_is_truncated_with_one_warn_notice() {
        // §7 #20.
        let nodes: Vec<Value> = (0..50_000)
            .map(|i| json!({ "type": "text", "value": format!("n{i}") }))
            .collect();
        let spec = panel(Value::Array(nodes));
        assert_eq!(
            spec.nodes.len(),
            PANEL_MAX_NODES + 1,
            "the notice sits outside the cap"
        );
        assert_eq!(spec.nodes[PANEL_MAX_NODES], truncated_node());
        assert_eq!(
            spec.nodes
                .iter()
                .filter(|n| **n == truncated_node())
                .count(),
            1,
            "exactly one notice, however many times the cap was felt"
        );
    }

    #[test]
    fn a_spec_exactly_at_the_cap_is_not_marked_truncated() {
        let nodes: Vec<Value> = (0..PANEL_MAX_NODES)
            .map(|_| json!({ "type": "divider" }))
            .collect();
        let spec = panel(Value::Array(nodes));
        assert_eq!(spec.nodes.len(), PANEL_MAX_NODES);
        assert!(!spec.nodes.contains(&truncated_node()));
    }

    #[test]
    fn nesting_past_the_depth_cap_truncates_the_subtree_and_keeps_the_rest() {
        // A leaf 100 deep must not erase the sibling section next to it.
        let mut deep = json!({ "type": "text", "value": "bottom" });
        for _ in 0..100 {
            deep = json!({ "type": "stack", "children": [deep] });
        }
        let spec = panel(json!([deep, { "type": "text", "value": "sibling" }]));
        assert!(spec.nodes.contains(&truncated_node()));

        // walk down and confirm the tree stops at the cap rather than going on
        let mut depth = 0;
        let mut cursor = &spec.nodes[0];
        while let PanelNode::Stack { children, .. } = cursor {
            match children.first() {
                Some(next) => {
                    depth += 1;
                    cursor = next;
                }
                None => break,
            }
        }
        assert!(
            depth <= PANEL_MAX_DEPTH + 1,
            "stopped at the cap, got {depth}"
        );
        // the sibling survived the cut
        assert!(spec
            .nodes
            .iter()
            .any(|n| matches!(n, PanelNode::Text { value, .. } if value == "sibling")));
    }

    // ---------- FR-39: action args ----------

    #[test]
    fn action_args_accept_flat_primitives_verbatim() {
        let spec = panel(json!([{
            "type": "action", "label": "go", "commandId": "c",
            "args": { "runId": "4821", "n": 7, "ok": true }
        }]));
        match &spec.nodes[0] {
            PanelNode::Action { args, .. } => {
                let args = args.as_ref().unwrap();
                assert_eq!(args["runId"], json!("4821"));
                assert_eq!(args["n"], json!(7));
                assert_eq!(args["ok"], json!(true));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn action_args_breaching_any_bound_invalidate_the_node_rather_than_being_trimmed() {
        // Trimming would hand the command a payload the plugin never wrote, and
        // FR-39 says args round-trip VERBATIM.
        let too_many: Map<String, Value> = (0..PANEL_MAX_ARG_KEYS + 1)
            .map(|i| (format!("k{i}"), json!("v")))
            .collect();
        for bad in [
            json!({ "nested": { "a": 1 } }),
            json!({ "arr": [1, 2] }),
            json!({ "nul": null }),
            json!({ "k": "v".repeat(PANEL_MAX_ARG_VALUE_LEN + 1) }),
            json!({ "k".repeat(PANEL_MAX_ARG_KEY_LEN + 1): "v" }),
            Value::Object(too_many),
            json!([1, 2]),
        ] {
            let spec = panel(json!([
                { "type": "action", "label": "go", "commandId": "c", "args": bad }
            ]));
            assert_eq!(spec.nodes[0], invalid_node(), "should reject args: {bad}");
        }

        // ...and the boundary values are ACCEPTED
        let spec = panel(json!([{
            "type": "action", "label": "go", "commandId": "c",
            "args": { "k": "v".repeat(PANEL_MAX_ARG_VALUE_LEN) }
        }]));
        assert_ne!(spec.nodes[0], invalid_node());
    }

    // ---------- FR-34: the spec envelope ----------

    #[test]
    fn version_is_passed_through_verbatim_for_the_frontend_to_gate() {
        // FR-34: the core does not decide compatibility — it reports what was
        // returned so the frontend can render `unsupported panel version`.
        assert_eq!(panel(json!([])).version, 1);
        let v2 = validate_panel(&json!({ "version": 2, "nodes": [] })).unwrap();
        assert_eq!(v2.version, 2);
    }

    #[test]
    fn a_malformed_spec_envelope_fails_the_whole_render() {
        for bad in [
            json!("a string"),
            json!([]),
            json!(42),
            json!({ "nodes": [] }),                   // no version
            json!({ "version": 1 }),                  // no nodes
            json!({ "version": 1, "nodes": "text" }), // nodes not an array
            json!({ "version": "1", "nodes": [] }),   // version not a number
        ] {
            assert!(validate_panel(&bad).is_err(), "should fail: {bad}");
        }
    }

    #[test]
    fn a_malformed_title_is_dropped_rather_than_failing_the_panel() {
        let spec = validate_panel(&json!({ "version": 1, "title": 42, "nodes": [] })).unwrap();
        assert_eq!(spec.title, None);
    }

    // ---------- FR-42: status items ----------

    #[test]
    fn a_status_item_validates_under_its_own_tighter_bounds() {
        let item = validate_status(&json!({
            "version": 1,
            "text": "t".repeat(100),
            "tone": "warn",
            "badge": "b".repeat(50),
            "commandId": "open"
        }))
        .unwrap();
        assert_eq!(item.text.chars().count(), STATUS_MAX_TEXT);
        assert_eq!(item.badge.unwrap().chars().count(), STATUS_MAX_BADGE);
        assert_eq!(item.tone, Some(PanelTone::Warn));
        assert_eq!(item.command_id.as_deref(), Some("open"));
    }

    #[test]
    fn a_status_item_without_text_is_a_malformed_return_not_an_empty_one() {
        // FR-43 spells "clear this surface" as `null`, which never reaches here.
        for bad in [
            json!({ "version": 1 }),
            json!({ "version": 1, "text": 42 }),
            json!({ "text": "x" }),
            json!("nope"),
        ] {
            assert!(validate_status(&bad).is_err(), "should fail: {bad}");
        }
    }

    #[test]
    fn a_status_items_malformed_optionals_are_dropped_not_fatal() {
        let item =
            validate_status(&json!({ "version": 1, "text": "ok", "tone": "pink", "badge": 7 }))
                .unwrap();
        assert_eq!(item.text, "ok");
        assert_eq!(item.tone, None);
        assert_eq!(item.badge, None);
    }

    // ---------- FR-81: the tab surface ----------

    fn allow() -> Vec<String> {
        vec!["127.0.0.1".to_string()]
    }

    #[test]
    fn a_loopback_url_on_the_allowlist_validates() {
        let spec = validate_tab(&json!({ "version": 1, "url": "http://127.0.0.1:4317" }), &allow())
            .unwrap();
        assert_eq!(spec.url.as_deref(), Some("http://127.0.0.1:4317"));
        assert!(spec.message.is_none());
    }

    #[test]
    fn a_host_outside_the_plugins_allowlist_is_refused() {
        // The whole security argument for this surface: a plugin may FRAME an
        // origin exactly when it could already have FETCHED it. If this ever
        // passes, contributing a tab has silently widened a grant.
        let err = validate_tab(&json!({ "version": 1, "url": "https://evil.example/x" }), &allow())
            .unwrap_err();
        assert!(err.contains("allowlist"), "{err}");
    }

    #[test]
    fn a_non_loopback_http_url_is_refused_even_if_the_host_is_allowed() {
        // Inherited from check_url: http is loopback-only. Framing a page
        // fetched in clear text over a network is not something a manifest
        // entry should be able to opt into.
        let err = validate_tab(
            &json!({ "version": 1, "url": "http://example.com/" }),
            &vec!["example.com".to_string()],
        )
        .unwrap_err();
        assert!(err.contains("https"), "{err}");
    }

    #[test]
    fn data_and_blob_urls_are_refused_so_a_plugin_cannot_supply_the_document() {
        // The line between "names a page" and "renders markup in the webview".
        for url in [
            "data:text/html,<script>alert(1)</script>",
            "blob:http://127.0.0.1/abc",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ] {
            assert!(
                validate_tab(&json!({ "version": 1, "url": url }), &allow()).is_err(),
                "{url} must be refused"
            );
        }
    }

    #[test]
    fn a_message_needs_no_allowlist_and_may_carry_an_action() {
        let spec = validate_tab(
            &json!({ "version": 1, "message": "not running",
                     "action": { "label": "retry", "commandId": "refresh" } }),
            &[],
        )
        .unwrap();
        assert_eq!(spec.message.as_deref(), Some("not running"));
        assert!(spec.url.is_none());
        assert_eq!(spec.action.unwrap().command_id, "refresh");
    }

    #[test]
    fn url_and_message_together_are_refused_rather_than_tie_broken() {
        let err = validate_tab(
            &json!({ "version": 1, "url": "http://127.0.0.1:4317", "message": "down" }),
            &allow(),
        )
        .unwrap_err();
        assert!(err.contains("not both"), "{err}");
    }

    #[test]
    fn neither_url_nor_message_is_refused() {
        assert!(validate_tab(&json!({ "version": 1 }), &allow()).is_err());
    }

    #[test]
    fn a_malformed_action_drops_the_action_not_the_whole_tab() {
        let spec = validate_tab(
            &json!({ "version": 1, "message": "down", "action": { "label": "retry" } }),
            &[],
        )
        .unwrap();
        assert_eq!(spec.message.as_deref(), Some("down"));
        assert!(spec.action.is_none());
    }

    #[test]
    fn a_non_object_return_is_refused() {
        for raw in [json!("http://127.0.0.1"), json!(3), json!([])] {
            assert!(validate_tab(&raw, &allow()).is_err());
        }
    }
}
