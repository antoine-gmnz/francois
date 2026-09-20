use super::*;
use crate::ipc::ErrorCode;

// ---------------------------------------------------------- FR-4: active_branch

fn entry(id: &str, parent: Option<&str>, role: &str, text: &str) -> NativeEntry {
    NativeEntry {
        id: id.into(),
        parent_id: parent.map(String::from),
        role: role.into(),
        text: text.into(),
    }
}

#[test]
fn active_branch_walks_from_leaf_to_root_in_chronological_order() {
    let entries = vec![
        entry("e1", None, "user", "hi"),
        entry("e2", Some("e1"), "assistant", "hello"),
        entry("e3", Some("e2"), "user", "again"),
    ];
    let branch = active_branch(&entries, "e3").expect("a well-formed chain walks to its root");
    assert_eq!(
        branch.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["e1", "e2", "e3"]
    );
}

/// FR-4: "without showing abandoned branches as the current conversation".
#[test]
fn active_branch_excludes_a_sibling_branch_not_reachable_from_the_leaf() {
    let entries = vec![
        entry("e1", None, "user", "hi"),
        entry("e2a", Some("e1"), "assistant", "abandoned reply"),
        entry("e2b", Some("e1"), "assistant", "kept reply"),
        entry("e3", Some("e2b"), "user", "continue"),
    ];
    let branch = active_branch(&entries, "e3").expect("a well-formed chain walks to its root");
    let ids: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["e1", "e2b", "e3"]);
    assert!(!ids.contains(&"e2a"), "abandoned branch must not leak in");
}

/// FR-4: pre-compaction messages on the surviving ancestry are preserved
/// — a compaction entry is just another node in the chain.
#[test]
fn active_branch_preserves_pre_compaction_messages_still_on_the_ancestry() {
    let entries = vec![
        entry("e1", None, "user", "long history begins"),
        entry("e2", Some("e1"), "assistant", "long reply"),
        entry("summary", Some("e2"), "assistant", "[compacted summary]"),
        entry("e3", Some("summary"), "user", "continue after compaction"),
    ];
    let branch = active_branch(&entries, "e3").expect("a well-formed chain walks to its root");
    let ids: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, vec!["e1", "e2", "summary", "e3"]);
}

/// DEFECT 5: this used to assert `branch.len() <= 2` over a TWO-entry
/// fixture — vacuously true however the walk behaved, so it could not fail.
/// A cycle is a corrupt parent chain, and that is what it now asserts (the
/// walk terminating is proven by the test returning at all).
#[test]
fn active_branch_reports_a_cycle_as_corrupt() {
    let entries = vec![
        entry("a", Some("b"), "user", "x"),
        entry("b", Some("a"), "assistant", "y"),
    ];
    let err = active_branch(&entries, "a").expect_err("a cycle must be refused");
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// An unknown leaf is a reply that cannot be placed — NOT an empty
/// conversation, which is what the old `is_empty()` answer made it look like
/// one layer up, where it became an empty transcript written over a real one.
#[test]
fn active_branch_on_an_unknown_leaf_is_corrupt() {
    let entries = vec![entry("e1", None, "user", "hi")];
    let err = active_branch(&entries, "nope").expect_err("an unknown leaf must be refused");
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// The other half of the proof `active_branch` now carries: a chain that
/// breaks mid-way is refused whole, never handed back as its tail. The tail
/// is what the caller would have persisted OVER the full history.
#[test]
fn active_branch_refuses_a_broken_chain_instead_of_returning_its_tail() {
    let entries = vec![
        entry("e2", Some("e1-evicted"), "assistant", "tail"),
        entry("e3", Some("e2"), "user", "later"),
    ];
    let err = active_branch(&entries, "e3").expect_err("a broken chain must be refused");
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
    assert!(
        err.message.contains("e1-evicted"),
        "the message must name the missing parent, got: {}",
        err.message
    );
}

// ---------------------------------------------------------- FR-5: reconcile_block_ids

#[test]
fn a_previously_seen_entry_keeps_its_stable_block_id_across_a_rebuild() {
    let entries = vec![entry("e1", None, "user", "hi")];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "stable-block-1".to_string());
    let (rebuilt, _) = reconcile_block_ids(&entries, &previous, &[]);
    assert_eq!(rebuilt[0].block_id, "stable-block-1");
}

/// FR-5: "Keep duplicate identical user messages as distinct entries" —
/// two entries with byte-identical text but different ids never merge.
#[test]
fn duplicate_identical_text_entries_get_distinct_fresh_block_ids() {
    let entries = vec![
        entry("e1", None, "user", "same text"),
        entry("e2", Some("e1"), "user", "same text"),
    ];
    let (rebuilt, _) = reconcile_block_ids(&entries, &HashMap::new(), &[]);
    assert_ne!(rebuilt[0].block_id, rebuilt[1].block_id);
    assert_eq!(rebuilt[0].text, rebuilt[1].text);
}

/// FR-5: FIFO reconciliation — a provisional (never-persisted) live block
/// left over from an interrupted turn reconciles with the FIRST new
/// entry the rebuild has never seen before, in order.
#[test]
fn leftover_new_entries_reconcile_with_provisional_blocks_in_fifo_order() {
    let entries = vec![
        entry("e1", None, "user", "first"),
        entry("e2", Some("e1"), "assistant", "second"),
        entry("e3", Some("e2"), "user", "third"),
    ];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "known-block".to_string());
    let provisional = vec![
        ("provisional-a".to_string(), BlockKind::Assistant),
        ("provisional-b".to_string(), BlockKind::User),
    ];
    let (rebuilt, consumed) = reconcile_block_ids(&entries, &previous, &provisional);
    assert_eq!(rebuilt[0].block_id, "known-block");
    assert_eq!(rebuilt[1].block_id, "provisional-a");
    assert_eq!(rebuilt[2].block_id, "provisional-b");
    assert!(consumed.contains("provisional-a"));
    assert!(consumed.contains("provisional-b"));
}

/// FR-5/FR-7, the data-loss case: François crashed after the composer
/// appended the user's block but before it was ever delivered, and Pi's tree
/// carries one assistant entry this app never persisted. Handing that
/// assistant entry the USER block's id would rewrite the user's own message
/// (the block is built from the ENTRY's text) under its own id, AND mark it
/// confirmed — so the delivery-unknown notice would never appear either. A
/// provisional id is only ever reused by an entry that renders the same kind.
#[test]
fn an_assistant_entry_never_takes_an_unrelated_user_blocks_provisional_id() {
    let entries = vec![entry("e1", None, "assistant", "a reply to something else")];
    let provisional = vec![("user-blk".to_string(), BlockKind::User)];
    let (rebuilt, consumed) = reconcile_block_ids(&entries, &HashMap::new(), &provisional);

    assert_ne!(
        rebuilt[0].block_id, "user-blk",
        "an assistant entry must mint a fresh id, never overwrite a user block"
    );
    assert!(
        !consumed.contains("user-blk"),
        "an unmatched provisional id must stay unconsumed"
    );
    let previous_user_blocks = vec![("user-blk".to_string(), "deploy to prod".to_string())];
    assert_eq!(
        unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional),
        Some(("user-blk".to_string(), "deploy to prod".to_string())),
        "the undelivered message must still be flagged delivery-unknown"
    );
}

/// A torn checkpoint (a malformed trailing persisted line) simply never
/// makes it into `previous_by_native_id` — the caller's loader already
/// skips unparsable lines (`parse_persisted_block`), so the entry it
/// belonged to is treated as never-seen and gets a fresh id here, with no
/// duplicate row and no special-cased "torn" branch needed.
#[test]
fn an_entry_missing_from_a_torn_previous_map_gets_a_fresh_id_not_a_duplicate() {
    let entries = vec![
        entry("e1", None, "user", "kept"),
        entry("e2", Some("e1"), "assistant", "torn tail, never recorded"),
    ];
    let mut previous = HashMap::new();
    previous.insert("e1".to_string(), "kept-block".to_string());
    let (rebuilt, _) = reconcile_block_ids(&entries, &previous, &[]);
    assert_eq!(rebuilt.len(), 2);
    assert_eq!(rebuilt[0].block_id, "kept-block");
    assert_ne!(rebuilt[1].block_id, "kept-block");
}

// ---------------------------------------------------------- FR-7: unconfirmed_user_block

#[test]
fn a_provisional_user_block_never_confirmed_by_any_new_entry_is_flagged() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "are you there?".to_string())];
    let consumed = std::collections::HashSet::new();
    let provisional = vec![("user-block-1".to_string(), BlockKind::User)];
    let (id, text) =
        unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).unwrap();
    assert_eq!(id, "user-block-1");
    assert_eq!(text, "are you there?");
}

#[test]
fn a_provisional_user_block_that_was_reconciled_is_not_flagged() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "hi".to_string())];
    let mut consumed = std::collections::HashSet::new();
    consumed.insert("user-block-1".to_string());
    let provisional = vec![("user-block-1".to_string(), BlockKind::User)];
    assert!(unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).is_none());
}

#[test]
fn no_provisional_blocks_at_all_flags_nothing() {
    let previous_user_blocks = vec![("user-block-1".to_string(), "hi".to_string())];
    assert!(unconfirmed_user_block(
        &previous_user_blocks,
        &std::collections::HashSet::new(),
        &[]
    )
    .is_none());
}

/// Only the LAST unconfirmed candidate is ever flagged — one notice, never a
/// growing list (the readiness gap explicitly defers the full intent-queue
/// contract to pi-turn-controls).
#[test]
fn only_the_last_unconfirmed_user_block_is_flagged() {
    let previous_user_blocks = vec![
        ("user-block-1".to_string(), "first".to_string()),
        ("user-block-2".to_string(), "second".to_string()),
    ];
    let consumed = std::collections::HashSet::new();
    let provisional = vec![
        ("user-block-1".to_string(), BlockKind::User),
        ("user-block-2".to_string(), BlockKind::User),
    ];
    let (id, text) =
        unconfirmed_user_block(&previous_user_blocks, &consumed, &provisional).unwrap();
    assert_eq!(id, "user-block-2");
    assert_eq!(text, "second");
}

// ---------------------------------------------------------- the rebuild decision

fn rebuilt_ids(rebuild: &Rebuild) -> Vec<String> {
    match rebuild {
        Rebuild::Merged { blocks, .. } => blocks
            .iter()
            .filter_map(|b| b.native_entry_id.clone())
            .collect(),
        Rebuild::KeepLocal { .. } => Vec::new(),
    }
}

fn rebuild(data: serde_json::Value) -> Result<Rebuild, AppError> {
    rebuild_with(data, &[])
}

/// The same, over a session that already holds `previous` blocks — the merge
/// input (spec round-2 remediation rules 1-4).
fn rebuild_with(data: serde_json::Value, previous: &[BufBlock]) -> Result<Rebuild, AppError> {
    let data: GetEntriesData = serde_json::from_value(data).expect("payload deserializes");
    rebuild_projection(data, previous)
}

/// A message block already on disk: `at` and `nativeEntryId` are the two
/// fields rule 1 is about, so every fixture states them.
fn message(block_id: &str, kind: BlockKind, text: &str, native: Option<&str>, at: u64) -> BufBlock {
    BufBlock {
        text: text.into(),
        at,
        native_entry_id: native.map(String::from),
        ..BufBlock::new(block_id, kind)
    }
}

/// A local-only block — a kind Pi's entries cannot produce, which is exactly
/// what rules 2/3 are about.
fn local_only(block_id: &str, kind: BlockKind, text: &str, at: u64) -> BufBlock {
    BufBlock {
        text: text.into(),
        at,
        ..BufBlock::new(block_id, kind)
    }
}

fn merged(rebuild: &Rebuild) -> &[BufBlock] {
    match rebuild {
        Rebuild::Merged { blocks, .. } => blocks,
        Rebuild::KeepLocal { .. } => panic!("expected a merged rebuild"),
    }
}

/// The merged transcript by block id, in order — the whole shape rules 2/3
/// are about (`BlockKind` is deliberately not `Debug`, so the assertions read
/// off ids rather than kinds).
fn merged_ids(rebuild: &Rebuild) -> Vec<String> {
    merged(rebuild).iter().map(|b| b.block_id.clone()).collect()
}

/// `Rebuild` holds `BufBlock`s, which are deliberately not `Debug` — so
/// `unwrap_err` is unavailable and the refusal is unwrapped by hand.
fn refusal(result: Result<Rebuild, AppError>) -> AppError {
    match result {
        Ok(_) => panic!("this payload must be refused, never rebuilt over the transcript"),
        Err(e) => e,
    }
}

/// DEFECT 1b: `entries` carried `#[serde(default)]`, so `from_value`
/// succeeded for ANY JSON object — `{}` included, and every reply whose keys
/// are spelled differently from this provisional mirror. The caller then
/// "rebuilt" an empty transcript over a real one. A reply with no `entries`
/// array must fail to deserialize, so the caller answers
/// `RUNTIME_PROTOCOL_ERROR` for it instead.
#[test]
fn a_reply_with_no_entries_array_is_not_a_conversation() {
    assert!(serde_json::from_value::<GetEntriesData>(serde_json::json!({})).is_err());
    assert!(
        serde_json::from_value::<GetEntriesData>(serde_json::json!({ "nodes": [], "head": "e1" }))
            .is_err(),
        "a reply spelled with different keys must not read as an empty conversation"
    );
}

/// DEFECT 1c: a leaf Pi named but did not send is a truncated/mismatched
/// reply, not an empty conversation.
#[test]
fn a_leaf_that_is_not_among_the_entries_is_corrupt() {
    let err = refusal(rebuild(serde_json::json!({
        "entries": [{ "id": "e1", "role": "user", "text": "hi" }],
        "leafId": "e-missing",
    })));
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// DEFECT 1c, the worst of the four: the walk used to stop silently at a
/// break and hand back only the TAIL — which the caller then persisted OVER
/// the full history. The head was gone for good. §7: "corrupt parent chains
/// fail with readable cached history".
#[test]
fn a_dangling_parent_mid_chain_is_corrupt_not_a_truncated_tail() {
    let err = refusal(rebuild(serde_json::json!({
        "entries": [
            { "id": "e2", "parentId": "e1-evicted", "role": "assistant", "text": "tail" },
            { "id": "e3", "parentId": "e2", "role": "user", "text": "later" },
        ],
        "leafId": "e3",
    })));
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// DEFECT 1c + DEFECT 5: the old test asserted `branch.len() <= 2` over a
/// two-entry fixture, which is true whatever the code does. A cycle is a
/// corrupt parent chain — say exactly that.
#[test]
fn a_cycle_in_the_parent_chain_is_corrupt() {
    let err = refusal(rebuild(serde_json::json!({
        "entries": [
            { "id": "a", "parentId": "b", "role": "user", "text": "x" },
            { "id": "b", "parentId": "a", "role": "assistant", "text": "y" },
        ],
        "leafId": "a",
    })));
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// DEFECT 1: a null leaf alongside real entries is a reply this build cannot
/// place — never "the conversation is empty now".
#[test]
fn a_null_leaf_with_entries_is_corrupt_not_an_empty_rebuild() {
    let err = refusal(rebuild(serde_json::json!({
        "entries": [{ "id": "e1", "role": "user", "text": "hi" }],
        "leafId": null,
    })));
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// DEFECT 1: ... and so is a null leaf when this session has blocks it
/// already rebuilt from Pi's own tree. Losing those is the data loss.
#[test]
fn a_null_leaf_is_corrupt_when_the_session_already_shows_native_entries() {
    let previous = [message("block-1", BlockKind::User, "hi", Some("e1"), 10)];
    let err = refusal(rebuild_with(
        serde_json::json!({ "entries": [], "leafId": null }),
        &previous,
    ));
    assert_eq!(err.code, ErrorCode::RuntimeSessionCorrupt);
}

/// DEFECT 1d: the one benign null leaf — no entries on Pi's side, no
/// native-linked block on ours. Nothing to rebuild, so the local transcript
/// is kept rather than replaced with nothing.
#[test]
fn an_empty_conversation_keeps_the_local_transcript() {
    let rebuilt = rebuild(serde_json::json!({ "entries": [], "leafId": null })).unwrap();
    assert!(
        matches!(rebuilt, Rebuild::KeepLocal { append: None }),
        "an empty conversation must never replace the transcript"
    );
}

/// The positive control: a well-formed tree still rebuilds, root → leaf.
#[test]
fn a_well_formed_tree_rebuilds_in_root_to_leaf_order() {
    let rebuilt = rebuild(serde_json::json!({
        "entries": [
            { "id": "e3", "parentId": "e2", "role": "user", "text": "again" },
            { "id": "e1", "role": "user", "text": "hi" },
            { "id": "e2", "parentId": "e1", "role": "assistant", "text": "hello" },
        ],
        "leafId": "e3",
    }))
    .unwrap();
    assert_eq!(rebuilt_ids(&rebuilt), vec!["e1", "e2", "e3"]);
    let Rebuild::Merged {
        last_entry_id,
        leaf_id,
        ..
    } = &rebuilt
    else {
        panic!("a well-formed tree rebuilds");
    };
    assert_eq!(last_entry_id.as_deref(), Some("e3"));
    assert_eq!(leaf_id.as_deref(), Some("e3"));
}

// ------------------------------------------- round-2 remediation: a rebuild MERGES

/// The two-message ancestry every merge test below rebuilds against.
fn two_message_entries() -> serde_json::Value {
    serde_json::json!({
        "entries": [
            { "id": "e1", "role": "user", "text": "run the tests" },
            { "id": "e2", "parentId": "e1", "role": "assistant", "text": "done" },
        ],
        "leafId": "e2",
    })
}

/// Rule 2, the finding itself: a SUCCESSFUL rebuild used to delete every Tool
/// (`execution`) block from disk — Pi's entries carry no execution rows, so
/// replacing the transcript with the ancestry alone destroyed them. A Tool
/// block between its two messages survives, in place.
#[test]
fn a_tool_block_between_two_messages_survives_the_rebuild_in_place() {
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        local_only("tool-1", BlockKind::Tool, "npm test", 20),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    assert_eq!(merged_ids(&rebuilt), vec!["b1", "tool-1", "b2"]);
}

/// Rule 2 for the OTHER kind Pi cannot produce: François's own notices.
#[test]
fn a_notice_block_survives_the_rebuild() {
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        local_only("notice-1", BlockKind::Notice, "context compacted", 20),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    assert_eq!(merged_ids(&rebuilt), vec!["b1", "notice-1", "b2"]);
}

/// Rule 3: a local-only block anchored to a message that did NOT survive the
/// rebuild goes with it — it belonged to an abandoned branch, which FR-4
/// already keeps out of the current conversation.
#[test]
fn a_local_only_block_anchored_to_an_abandoned_message_is_dropped() {
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        // `e9` is not on the ancestry the entries below describe — this pair
        // is what a retried turn leaves behind.
        message(
            "abandoned",
            BlockKind::Assistant,
            "wrong branch",
            Some("e9"),
            20,
        ),
        local_only("tool-abandoned", BlockKind::Tool, "npm run wrong", 21),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    // Neither the abandoned message NOR the row that hung off it — and the
    // rebuild does not "rescue" the orphan by re-attaching it somewhere else.
    assert_eq!(merged_ids(&rebuilt), vec!["b1", "b2"]);
}

/// Rule 2's head case: a local-only block that precedes every message has no
/// anchor to survive, and stays at the head rather than being dropped.
#[test]
fn a_local_only_block_before_any_message_stays_at_the_head() {
    let previous = [
        local_only("notice-0", BlockKind::Notice, "resumed this session", 5),
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    assert_eq!(merged_ids(&rebuilt), vec!["notice-0", "b1", "b2"]);
}

/// Rule 2's "relative order preserved": several local-only rows behind ONE
/// anchor come back in the order they sat in on disk.
#[test]
fn several_local_only_blocks_behind_one_anchor_keep_their_relative_order() {
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        local_only("tool-1", BlockKind::Tool, "npm test", 20),
        local_only("notice-1", BlockKind::Notice, "context compacted", 21),
        local_only("tool-2", BlockKind::Tool, "npm run lint", 22),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    assert_eq!(
        merged_ids(&rebuilt),
        vec!["b1", "tool-1", "notice-1", "tool-2", "b2"]
    );
}

/// Rule 1: a rebuild must not re-stamp history with "now". The block already
/// on disk is the STARTING point — only `text`/`nativeEntryId` come from the
/// entry, so `at` (and everything else local) is carried across.
#[test]
fn a_rebuilt_block_keeps_the_at_it_already_had_on_disk() {
    let previous = [
        message(
            "b1",
            BlockKind::User,
            "stale text",
            Some("e1"),
            1_700_000_000_000,
        ),
        message(
            "b2",
            BlockKind::Assistant,
            "stale text",
            Some("e2"),
            1_700_000_001_000,
        ),
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    let blocks = merged(&rebuilt);
    assert_eq!(blocks[0].at, 1_700_000_000_000);
    assert_eq!(blocks[1].at, 1_700_000_001_000);
    // ...and the ENTRY is still the authority for the text.
    assert_eq!(blocks[0].text, "run the tests");
    assert_eq!(blocks[1].text, "done");
}

/// Rule 1's other half: the re-added unconfirmed user block used to be
/// rebuilt from its text alone, which dropped its `attachments` — a user
/// message whose images vanished the moment a reconnect could not confirm it.
#[test]
fn the_re_added_unconfirmed_user_block_keeps_its_attachments_and_at() {
    let attachments = serde_json::json!([{ "path": ".francois/attachments/a1/shot.png" }]);
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
        BufBlock {
            attachments: Some(attachments.clone()),
            ..message("unsent", BlockKind::User, "look at this", None, 40)
        },
    ];
    let rebuilt = rebuild_with(two_message_entries(), &previous).unwrap();
    let blocks = merged(&rebuilt);
    let unsent = blocks
        .iter()
        .find(|b| b.block_id == "unsent")
        .expect("the unconfirmed message is kept, never dropped");
    assert_eq!(unsent.attachments.as_ref(), Some(&attachments));
    assert_eq!(unsent.at, 40);
    assert_eq!(unsent.text, "look at this");
}

/// Rule 4: the delivery-unknown notice SURVIVES a rebuild now (rule 2), so a
/// second reconnect must find the existing one rather than stack another
/// under the same message.
#[test]
fn the_delivery_unknown_notice_is_appended_at_most_once_per_message() {
    let previous = [
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
        message("unsent", BlockKind::User, "look at this", None, 40),
    ];
    let first = rebuild_with(two_message_entries(), &previous).unwrap();
    let after_first: Vec<BufBlock> = merged(&first).to_vec();
    assert_eq!(
        notice_count(&after_first),
        1,
        "the first rebuild appends exactly one delivery-unknown notice"
    );

    let second = rebuild_with(two_message_entries(), &after_first).unwrap();
    assert_eq!(
        notice_count(merged(&second)),
        1,
        "a Retry must find the notice already on disk, never add a second"
    );
}

fn notice_count(blocks: &[BufBlock]) -> usize {
    blocks
        .iter()
        .filter(|b| {
            b.kind == BlockKind::Notice && b.text.starts_with("Delivery of the last message")
        })
        .count()
}

/// The property that proves the merge is a projection and not an accumulator:
/// rebuilding the SAME state twice produces the same transcript, byte for
/// byte. Nothing is re-stamped, nothing is duplicated, nothing is minted
/// twice — which is what makes a Retry safe to press repeatedly.
#[test]
fn a_second_rebuild_of_the_same_state_is_byte_identical() {
    let previous = [
        local_only("notice-0", BlockKind::Notice, "resumed this session", 5),
        message("b1", BlockKind::User, "run the tests", Some("e1"), 10),
        local_only("tool-1", BlockKind::Tool, "npm test", 20),
        message("b2", BlockKind::Assistant, "done", Some("e2"), 30),
        message("unsent", BlockKind::User, "look at this", None, 40),
    ];
    let first = rebuild_with(two_message_entries(), &previous).unwrap();
    let after_first: Vec<BufBlock> = merged(&first).to_vec();
    let second = rebuild_with(two_message_entries(), &after_first).unwrap();

    assert_eq!(persisted(&after_first), persisted(merged(&second)));
}

/// The on-disk bytes a block list becomes — the only representation that can
/// answer "byte-identical", since `BufBlock` is not `Debug`.
fn persisted(blocks: &[BufBlock]) -> String {
    blocks
        .iter()
        .map(|b| crate::session::persistence::persisted_block_json(b).to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Item 3 / rule 4: a session whose FIRST message never reached Pi keeps its
/// user block AND gets the warning — appended, never written over the
/// transcript this path exists to preserve.
#[test]
fn a_keep_local_session_with_an_unconfirmed_first_message_appends_the_notice() {
    let previous = [message(
        "unsent",
        BlockKind::User,
        "are you there?",
        None,
        40,
    )];
    let rebuilt = rebuild_with(
        serde_json::json!({ "entries": [], "leafId": null }),
        &previous,
    )
    .unwrap();
    let Rebuild::KeepLocal { append } = rebuilt else {
        panic!("an empty conversation must never replace the transcript");
    };
    let notice = append.expect("the unconfirmed first message is warned about");
    assert!(notice.kind == BlockKind::Notice);
    assert_eq!(notice.tone.as_deref(), Some("warning"));
}

/// ...and the same dedupe: a Retry on the keep-local path finds the notice it
/// appended last time rather than adding another.
#[test]
fn a_keep_local_retry_does_not_append_a_second_notice() {
    let previous = [
        message("unsent", BlockKind::User, "are you there?", None, 40),
        BufBlock {
            tone: Some("warning".into()),
            ..local_only(
                "notice-1",
                BlockKind::Notice,
                "Delivery of the last message is unknown — it was not re-sent.",
                41,
            )
        },
    ];
    let rebuilt = rebuild_with(
        serde_json::json!({ "entries": [], "leafId": null }),
        &previous,
    )
    .unwrap();
    let Rebuild::KeepLocal { append } = rebuilt else {
        panic!("an empty conversation must never replace the transcript");
    };
    assert!(
        append.is_none(),
        "a Retry must find the notice already on disk"
    );
}

/// The control for the two above: a keep-local session with NOTHING
/// unconfirmed gets no notice — an empty session that reconnects cleanly must
/// not grow a warning out of nowhere.
#[test]
fn a_keep_local_session_with_no_message_at_all_appends_nothing() {
    let rebuilt = rebuild(serde_json::json!({ "entries": [], "leafId": null })).unwrap();
    assert!(matches!(rebuilt, Rebuild::KeepLocal { append: None }));
}
