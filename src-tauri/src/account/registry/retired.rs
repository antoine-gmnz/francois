//! Retired Pi rows (pi-retirement-data-compatibility): the raw persisted copy
//! each one is written back from, so a load/save round-trip never loses a
//! field this build no longer understands.

use super::*;

pub(super) fn retained_registry_doc(inner: &AccountInner) -> Value {
    let mut doc = registry_doc(&inner.records, &inner.default_account_id);
    if let Some(rows) = doc["accounts"].as_array_mut() {
        for row in rows {
            if let Some(raw) = row
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| inner.retired_records.get(id))
            {
                *row = raw.clone();
            }
        }
    }
    if let Some(rows) = doc["accounts"].as_array_mut() {
        let ids: std::collections::HashSet<String> = rows
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str).map(String::from))
            .collect();
        rows.extend(
            inner
                .retired_records
                .iter()
                .filter(|(id, _)| !ids.contains(*id))
                .map(|(_, raw)| raw.clone()),
        );
    }
    doc
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    use crate::account::testutil::*;
    #[test]
    fn retired_pi_mutations_are_rejected_without_changing_rows() {
        let mut inner = inner_fixture(&["retired"], "retired");
        inner.records[0].kind = AccountKind::Pi;
        let before = registry_doc(&inner.records, &inner.default_account_id);
        assert_eq!(
            apply_rename(&mut inner, "retired", "changed".into())
                .unwrap_err()
                .code,
            ErrorCode::RuntimeUnsupported
        );
        assert_eq!(
            apply_set_default(&mut inner, "retired").unwrap_err().code,
            ErrorCode::RuntimeUnsupported
        );
        assert_eq!(
            registry_doc(&inner.records, &inner.default_account_id),
            before
        );
    }

    /// A retired Pi row is removable — otherwise one saved as the default
    /// strands every new session on RUNTIME_UNSUPPORTED with no way out. The
    /// raw copy goes too, or the next write would put the row straight back.
    #[test]
    fn a_retired_pi_row_is_removed_with_its_raw_copy_and_the_default_flag() {
        let mut inner = inner_fixture(&["keep", "retired"], "retired");
        inner.records[1].kind = AccountKind::Pi;
        inner.retired_records.insert(
            "retired".into(),
            serde_json::json!({"id":"retired","label":"Saved","kind":"pi","configDir":"/pi/home","createdAt":1}),
        );

        let removed = apply_remove(&mut inner, "retired").unwrap();

        assert_eq!(removed.kind, AccountKind::Pi);
        assert_eq!(inner.default_account_id, DEFAULT_ACCOUNT_ID);
        let doc = retained_registry_doc(&inner);
        let ids: Vec<_> = doc["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["keep"]);
        assert_eq!(doc["defaultAccountId"], DEFAULT_ACCOUNT_ID);
    }
}

#[cfg(test)]
mod retired_data_tests {
    use super::*;
    use crate::account::testutil::*;
    use serde_json::json;
    #[test]
    fn retired_account_extensions_and_malformed_settings_survive_other_mutations() {
        let raw = json!({"id":"retired","label":"Saved","kind":"pi","configDir":"/must/not/read","createdAt":1,"pi":{"runtime":42,"secretExtension":{"keep":true}},"future":[1,2]});
        let input = json!({"version":1,"defaultAccountId":"retired","accounts":[raw.clone()]});
        let (records, default_id) = parse_registry(&serde_json::to_vec(&input).unwrap());
        assert_eq!(records.len(), 1);
        let mut inner = inner_fixture(&[], "default");
        inner.default_account_id = resolve_default(&records, default_id.as_deref());
        inner.records = records;
        inner.retired_records.insert("retired".into(), raw.clone());
        inner.records.push(record_fixture("other", "Other"));
        apply_rename(&mut inner, "other", "Renamed".into()).unwrap();
        let doc = retained_registry_doc(&inner);
        assert_eq!(doc["defaultAccountId"], "retired");
        assert_eq!(doc["accounts"][0], raw);
        assert_eq!(
            ensure_account_available(&inner, &inner.default_account_id)
                .unwrap_err()
                .code,
            ErrorCode::RuntimeUnsupported
        );
        assert!(ensure_account_available(&inner, "other").is_ok());
        assert_eq!(
            ensure_account_available(&inner, "missing")
                .unwrap_err()
                .code,
            ErrorCode::AccountNotFound
        );
    }
}
