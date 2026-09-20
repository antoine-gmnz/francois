//! session/adapter/pi/recovery/projection.rs — the PURE half of
//! pi-session-durability's FR-4/FR-5/FR-7 projection rebuild: Pi's native
//! entry tree (`NativeEntry`), the active-branch walk, stable-block-id
//! reconciliation, the delivery-unknown check, and the one decision
//! (`rebuild_projection`) `recovery.rs` takes before it touches disk.
//!
//! Nothing here takes an `AppHandle` or performs I/O, which is the point: the
//! whole "what should the transcript become" question is unit-tested directly
//! (`projection_tests.rs`), and its caller is left with nothing but the
//! sequencing. The caller's write is an ATOMIC, unconditional replacement of
//! the session's transcript, so this module answers `Err` — never an empty
//! rebuild — for anything it cannot prove.
//!
//! **A rebuild MERGES** (spec §Remediation, 2026-09-20 round 2, amending
//! FR-4/FR-5). Pi's entries are the authority for *messages* only: they carry
//! no execution rows, none of François's own notices, no `at`, and no
//! attachments. So the four rules this module implements are (1) a rebuilt
//! block starts from the block already on disk, (2) every local-only block is
//! re-anchored to the message it followed, (3) except when that anchor did
//! not survive, and (4) the delivery-unknown notice is appended at most once
//! per message. "Projection files are disposable derived state" (FR-2) still
//! holds for what can be re-derived from Pi; execution rows and notices
//! cannot be, so they are not disposable.
//!
//! **Provisional**, same honest caveat every other Pi wire assumption in this
//! adapter carries (see `wire.rs`'s doc): no real capture of `get_entries`
//! exists yet. `NativeEntry`'s shape is this module's best-effort mirror of
//! the audited session-format doc ("versioned JSONL tree, stable entry/parent
//! IDs"), reconciled against a real capture once one exists. Because those
//! names are unconfirmed, a payload that does not match is REFUSED rather
//! than read as "this conversation is empty now".

use crate::ipc::{AppError, ErrorCode};
use crate::session::{BlockKind, BufBlock};
use serde::Deserialize;
use std::collections::HashMap;

// ---------------------------------------------------------------- FR-4: native entries

/// PROVISIONAL — one node of Pi's native entry tree (specs/research/
/// pi-integration-audit.md: "versioned JSONL tree, stable entry/parent IDs").
/// Only the fields the projection rebuild reads; anything else in a real
/// `get_entries` response is ignored, not rejected.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub(super) struct NativeEntry {
    pub(super) id: String,
    #[serde(rename = "parentId", default)]
    pub(super) parent_id: Option<String>,
    /// "user" | "assistant" — anything else renders as assistant output
    /// (`kind_for_role`) rather than being guessed at.
    pub(super) role: String,
    #[serde(default)]
    pub(super) text: String,
}

/// The `get_entries` payload. `entries` carries NO `#[serde(default)]`,
/// deliberately: with one, `from_value` succeeded for ANY JSON object —
/// `{}` included, and every reply whose keys are spelled differently from
/// this provisional mirror — and the caller then "rebuilt" an empty
/// transcript over a real conversation. A reply with no `entries` array is
/// malformed, and the caller answers `RUNTIME_PROTOCOL_ERROR` for it.
#[derive(Deserialize)]
pub(super) struct GetEntriesData {
    pub(super) entries: Vec<NativeEntry>,
    #[serde(rename = "leafId", default)]
    pub(super) leaf_id: Option<String>,
}

fn corrupt(message: String) -> AppError {
    AppError::new(ErrorCode::RuntimeSessionCorrupt, message)
}

/// FR-4: reconstruct the ACTIVE branch by walking `parentId` from `leaf_id`
/// back to the root, then return it in chronological (root → leaf) order.
/// An entry not on this ancestry — an abandoned branch, or one superseded by
/// compaction — is never returned, so it never renders as the current
/// conversation.
///
/// The walk PROVES its result: it succeeds only when it reaches a genuine
/// root (`parent_id: None`). An unknown leaf, a parent missing from
/// `entries`, and a cycle are each `RUNTIME_SESSION_CORRUPT` — never a
/// partial chain. The partial chain is the dangerous answer: the caller
/// replaces the durable transcript with exactly what it is handed, so
/// "the tail only" silently destroys the head of the conversation. Refusing
/// keeps the cached history readable instead, which is what §7's "corrupt
/// parent chains fail with readable cached history" asks for.
pub(super) fn active_branch(
    entries: &[NativeEntry],
    leaf_id: &str,
) -> Result<Vec<NativeEntry>, AppError> {
    let by_id: HashMap<&str, &NativeEntry> = entries.iter().map(|e| (e.id.as_str(), e)).collect();
    let Some(mut current) = by_id.get(leaf_id).copied() else {
        return Err(corrupt(format!(
            "Pi named entry {leaf_id} as this conversation's current position, but the history it sent does not contain that entry"
        )));
    };
    let mut chain = Vec::new();
    let mut seen = std::collections::HashSet::new();
    loop {
        if !seen.insert(current.id.as_str()) {
            return Err(corrupt(format!(
                "this conversation's history loops back on itself at entry {} and could not be rebuilt",
                current.id
            )));
        }
        chain.push(current.clone());
        let Some(parent_id) = current.parent_id.as_deref() else {
            break; // reached the root — the walk is complete, and provably so
        };
        let Some(parent) = by_id.get(parent_id).copied() else {
            return Err(corrupt(format!(
                "this conversation's history breaks at entry {}, whose parent {parent_id} is missing",
                current.id
            )));
        };
        current = parent;
    }
    chain.reverse();
    Ok(chain)
}

// ---------------------------------------------------------------- FR-5: block-id reconciliation

/// The block kind an entry's role renders as — the ONE mapping, shared by
/// `to_buf_block` (what is built) and `reconcile_block_ids` (which
/// provisional id may be reused), so an id can never be handed to an entry
/// that then renders as a different kind.
fn kind_for_role(role: &str) -> BlockKind {
    if role == "user" {
        BlockKind::User
    } else {
        BlockKind::Assistant
    }
}

/// One ancestry entry, resolved to the stable François block id it should
/// render as.
pub(super) struct RebuiltBlock {
    pub(super) block_id: String,
    pub(super) native_entry_id: String,
    pub(super) role: String,
    pub(super) text: String,
}

/// FR-5: "map native entry ID ... to stable François block IDs" + "reconcile
/// provisional live blocks with entries in ordered FIFO position, not text
/// deduplication".
///
/// `previous_by_native_id` covers every entry this projection has already
/// shown before — read back from the PERSISTED transcript's own
/// `nativeEntryId` tags, so an entry's block id survives every later rebuild
/// (this is what keeps a reopened transcript's React keys stable). Matched by
/// IDENTITY (the native id), never by comparing text — two entries with
/// byte-identical text but different ids stay two distinct rows.
///
/// `provisional_tail` is the ordered `(blockId, kind)` of blocks the LIVE
/// buffer still held as unsettled (streaming, never persisted) at reconnect
/// time — a turn interrupted mid-stream while the François app kept running.
/// Each leftover entry the rebuild has never seen before consumes the OLDEST
/// still-unmatched provisional id **of its own kind**, in order (FIFO): the
/// first new entry chronologically reconciles with the first still-open row
/// that renders the same way, and so on. Anything left over after that (a
/// genuinely new entry the live buffer never saw) mints a fresh id.
///
/// The kind constraint is not a nicety. The block is built from the ENTRY's
/// role and text, so letting an assistant entry claim a user block's id
/// overwrites the user's own message under its own id — and marks that id
/// consumed, which suppresses the delivery-unknown notice below. An
/// undelivered message would be destroyed while the UI implied it was sent.
///
/// Returns the rebuilt blocks AND the set of `provisional_tail` ids that were
/// actually consumed — the caller (`unconfirmed_user_block`) uses the
/// complement (never consumed) to find a submitted message this rebuild
/// still cannot confirm at all (FR-7 / this feature's readiness gap on
/// "delivery-unknown").
pub(super) fn reconcile_block_ids(
    ancestry: &[NativeEntry],
    previous_by_native_id: &HashMap<String, String>,
    provisional_tail: &[(String, BlockKind)],
) -> (Vec<RebuiltBlock>, std::collections::HashSet<String>) {
    let mut taken = vec![false; provisional_tail.len()];
    let mut consumed = std::collections::HashSet::new();
    let rebuilt = ancestry
        .iter()
        .map(|entry| {
            let block_id = previous_by_native_id
                .get(&entry.id)
                .cloned()
                .or_else(|| {
                    let kind = kind_for_role(&entry.role);
                    let slot = (0..provisional_tail.len())
                        .find(|i| !taken[*i] && provisional_tail[*i].1 == kind)?;
                    taken[slot] = true;
                    let id = provisional_tail[slot].0.clone();
                    consumed.insert(id.clone());
                    Some(id)
                })
                .unwrap_or_else(crate::ids::uuid);
            RebuiltBlock {
                block_id,
                native_entry_id: entry.id.clone(),
                role: entry.role.clone(),
                text: entry.text.clone(),
            }
        })
        .collect();
    (rebuilt, consumed)
}

/// FR-7 (this feature's readiness gap, "FR-7 delivery-unknown" — lead's
/// decision): the SAME projection rebuild that reconciles provisional blocks
/// against fresh entries also reveals the opposite case — a `message.user`
/// block the live buffer showed but this rebuild's ancestry never confirms
/// AT ALL (`provisional_tail`'s id was never consumed by
/// `reconcile_block_ids`). Never auto-resent; the caller keeps its existing
/// block verbatim and appends exactly one `notice` (never a new IPC shape).
/// Only the LAST such candidate matters — an intent queue's own delivery
/// state (beyond this one warning) belongs to pi-turn-controls (Pi 08).
pub(super) fn unconfirmed_user_block(
    previous_user_blocks: &[(String, String)], // (blockId, text), in buffer order
    consumed_provisional: &std::collections::HashSet<String>,
    provisional_tail: &[(String, BlockKind)],
) -> Option<(String, String)> {
    let unmatched: std::collections::HashSet<&str> = provisional_tail
        .iter()
        .map(|(id, _)| id.as_str())
        .filter(|id| !consumed_provisional.contains(*id))
        .collect();
    previous_user_blocks
        .iter()
        .rev()
        .find(|(block_id, _)| unmatched.contains(block_id.as_str()))
        .cloned()
}

/// The warning FR-7 appends beside a message whose delivery this rebuild
/// cannot confirm. A CONSTANT because rule 4's dedupe recognizes the notice
/// already on disk by it — a Retry must find that one rather than stack a
/// second identical warning under the same message.
const DELIVERY_UNKNOWN_NOTICE: &str =
    "Delivery of the last message is unknown — it was not re-sent.";

fn delivery_unknown_notice() -> BufBlock {
    BufBlock {
        text: DELIVERY_UNKNOWN_NOTICE.into(),
        tone: Some("warning".into()),
        ..BufBlock::new(&crate::ids::uuid(), BlockKind::Notice)
    }
}

/// Remediation rule 1: a rebuilt block whose id matches a block already on
/// disk STARTS from that block — it keeps its `at`, its attachments and every
/// other local field, and only `text`/`nativeEntryId` come from the entry.
/// Pi's entries carry none of those, so building fresh here re-stamped the
/// whole transcript with `now` on every rebuild and dropped the attachments
/// off a re-added user message.
fn to_buf_block(rb: &RebuiltBlock, previous: Option<&BufBlock>) -> BufBlock {
    let kind = kind_for_role(&rb.role);
    match previous {
        Some(prev) => BufBlock {
            text: rb.text.clone(),
            native_entry_id: Some(rb.native_entry_id.clone()),
            // The ENTRY's role decides what the block renders as, and a
            // rebuilt block is settled by definition — neither may be
            // inherited from whatever state the block was left in.
            kind,
            streaming: false,
            ..prev.clone()
        },
        None => BufBlock {
            text: rb.text.clone(),
            native_entry_id: Some(rb.native_entry_id.clone()),
            ..BufBlock::new(&rb.block_id, kind)
        },
    }
}

// ---------------------------------------------------------------- what the session already holds

/// Every view of the session's CURRENT transcript this rebuild reads, derived
/// from the ONE list it is handed (`previous`, in buffer order). It is one
/// list rather than the three parallel maps the caller used to build because
/// the merge below needs the blocks THEMSELVES — their `at`, their
/// attachments, and the order local-only rows sit in — not just
/// `(native id → block id)`.
struct PreviousProjection<'a> {
    /// FR-5: every entry this projection has already shown, by native id —
    /// what keeps an entry's block id stable across every later rebuild.
    by_native_id: HashMap<String, String>,
    /// The ordered `(blockId, kind)` of message blocks the live buffer still
    /// held with no `native_entry_id` — `reconcile_block_ids`' FIFO input.
    provisional_tail: Vec<(String, BlockKind)>,
    /// Every `User` block's `(blockId, text)`, in buffer order (FR-7).
    user_blocks: Vec<(String, String)>,
    /// Rule 1's input: the block already on disk under each id, so a rebuilt
    /// message can START from it instead of from a fresh one stamped `now`.
    by_id: HashMap<&'a str, &'a BufBlock>,
    /// Rules 2/3: every LOCAL-ONLY block (any kind Pi's entries cannot
    /// produce — Tool executions, notices, cards) grouped by the message
    /// block it FOLLOWS on disk. Relative order within a group is the order
    /// on disk, which is what the merge re-inserts.
    local_after: HashMap<&'a str, Vec<&'a BufBlock>>,
    /// Rule 2's tail case: local-only blocks that precede every message.
    head_local: Vec<&'a BufBlock>,
}

impl<'a> PreviousProjection<'a> {
    fn of(previous: &'a [BufBlock]) -> PreviousProjection<'a> {
        let mut by_native_id = HashMap::new();
        let mut provisional_tail = Vec::new();
        let mut user_blocks = Vec::new();
        let mut by_id = HashMap::new();
        let mut local_after: HashMap<&str, Vec<&BufBlock>> = HashMap::new();
        let mut head_local = Vec::new();
        let mut anchor: Option<&str> = None;
        for b in previous {
            by_id.insert(b.block_id.as_str(), b);
            // Only the two kinds an entry can produce take part in FR-5's id
            // reconciliation at all — everything else is local-only, and is
            // anchored to the last message seen before it.
            if !matches!(b.kind, BlockKind::User | BlockKind::Assistant) {
                match anchor {
                    Some(id) => local_after.entry(id).or_default().push(b),
                    None => head_local.push(b),
                }
                continue;
            }
            match &b.native_entry_id {
                Some(native_id) => {
                    by_native_id.insert(native_id.clone(), b.block_id.clone());
                }
                None => provisional_tail.push((b.block_id.clone(), b.kind)),
            }
            if b.kind == BlockKind::User {
                user_blocks.push((b.block_id.clone(), b.text.clone()));
            }
            anchor = Some(b.block_id.as_str());
        }
        PreviousProjection {
            by_native_id,
            provisional_tail,
            user_blocks,
            by_id,
            local_after,
            head_local,
        }
    }

    /// Rules 2/3: the local-only blocks that followed `anchor`, cloned in
    /// their on-disk order. Empty for an anchor that did NOT survive the
    /// rebuild — which is rule 3's whole content: a local-only block whose
    /// message belonged to an abandoned branch goes with it.
    fn local_after(&self, anchor: &str) -> Vec<BufBlock> {
        self.local_after
            .get(anchor)
            .map(|blocks| blocks.iter().map(|b| (*b).clone()).collect())
            .unwrap_or_default()
    }

    /// Rule 4's dedupe. Notices SURVIVE a rebuild now (rule 2), so a Retry
    /// must find the one it already appended under this message rather than
    /// stack a second identical warning under it.
    fn has_delivery_notice(&self, anchor: &str) -> bool {
        self.local_after.get(anchor).is_some_and(|blocks| {
            blocks
                .iter()
                .any(|b| b.kind == BlockKind::Notice && b.text == DELIVERY_UNKNOWN_NOTICE)
        })
    }
}

// ---------------------------------------------------------------- the rebuild decision

/// What a `get_entries` reply means for the durable transcript. Two outcomes
/// only, and the difference matters more than anything else in this module:
/// `Merged` is destructive (the caller overwrites the transcript file with
/// exactly these blocks), so it must only ever be reached from a PROVEN
/// ancestry.
///
/// It is `Merged`, not `Replace`: the blocks are Pi's entries MERGED with
/// what only François holds (spec round-2 remediation). Pi's entries are the
/// authority for *messages* only — they carry no execution rows and none of
/// François's own notices — so a rebuild that replaced the file with the
/// ancestry alone deleted every Tool and Notice block the session ever had.
pub(super) enum Rebuild {
    Merged {
        blocks: Vec<BufBlock>,
        /// The rebuilt ancestry's own leaf, for `PiResumeRecord`.
        last_entry_id: Option<String>,
        leaf_id: Option<String>,
    },
    /// A legitimately empty conversation: Pi holds no entries and this
    /// session has never shown one either. There is nothing to rebuild, so
    /// the local transcript and buffer are left exactly as they are —
    /// `append` is the ONE non-destructive addition remediation rule 4 allows
    /// here: the delivery-unknown notice for a session whose FIRST message
    /// never reached Pi. `None` when there is no such message, or when its
    /// notice is already on disk.
    KeepLocal { append: Option<BufBlock> },
}

/// FR-4/FR-5/FR-7's whole decision, with no `AppHandle` and no I/O: given a
/// `get_entries` payload and what the session already holds, either the
/// blocks the transcript should become, or "keep what is on disk".
///
/// Every failure is an `Err`, never an empty `Merged`: the caller's
/// `replace_transcript` is atomic and unconditional, so handing it "no
/// blocks" for a payload this module could not prove would wipe a real
/// conversation — the exact data loss this function exists to make
/// impossible.
///
/// The blocks it answers with are a MERGE, not Pi's entries alone (spec
/// round-2 remediation, rules 1-4): Pi is the authority for messages, and
/// everything only François holds — each block's own `at` and attachments,
/// every Tool execution row, every notice — is carried across from the
/// transcript on disk.
pub(super) fn rebuild_projection(
    data: GetEntriesData,
    previous: &[BufBlock],
) -> Result<Rebuild, AppError> {
    let previous = PreviousProjection::of(previous);
    let ancestry = match data.leaf_id.as_deref() {
        Some(leaf) => active_branch(&data.entries, leaf)?,
        // No current position. That is only benign when there is genuinely
        // nothing to lose: no entries on Pi's side AND no block this session
        // has ever rebuilt from Pi's tree. Anything else is a reply this
        // build cannot place, and the cached history is worth more than it.
        None if data.entries.is_empty() && previous.by_native_id.is_empty() => {
            // Rule 4: a session whose FIRST message never reached Pi used to
            // get no warning at all, because this path returns before the
            // delivery-unknown check below. It cannot be closed by answering
            // `Merged` here instead — live-streamed history that has never
            // been through a rebuild carries no native ids either, so that
            // would wipe a real conversation to add one notice. The notice is
            // APPENDED instead: nothing else on disk is touched, and the same
            // dedupe keeps a Retry from adding a second one.
            let append = unconfirmed_user_block(
                &previous.user_blocks,
                &std::collections::HashSet::new(),
                &previous.provisional_tail,
            )
            .filter(|(block_id, _)| !previous.has_delivery_notice(block_id))
            .map(|_| delivery_unknown_notice());
            return Ok(Rebuild::KeepLocal { append });
        }
        None => {
            return Err(corrupt(
                "Pi did not report which entry this conversation is currently on, so its history could not be rebuilt".into(),
            ))
        }
    };

    let (rebuilt, consumed_provisional) = reconcile_block_ids(
        &ancestry,
        &previous.by_native_id,
        &previous.provisional_tail,
    );
    // Rules 1-3: the ancestry in order, each message starting from the block
    // already on disk, with every local-only row re-inserted right after the
    // message it followed. A local-only row whose anchor is NOT in the
    // ancestry is simply never emitted — it belonged to an abandoned branch,
    // which FR-4 already keeps out of the current conversation.
    let mut blocks: Vec<BufBlock> = previous.head_local.iter().map(|b| (*b).clone()).collect();
    for rb in &rebuilt {
        blocks.push(to_buf_block(
            rb,
            previous.by_id.get(rb.block_id.as_str()).copied(),
        ));
        blocks.extend(previous.local_after(&rb.block_id));
    }
    // FR-7 (readiness gap "FR-7 delivery-unknown"): a submitted message this
    // rebuild still cannot confirm is kept verbatim, never re-sent, with one
    // warning notice — never silently dropped.
    if let Some((block_id, _)) = unconfirmed_user_block(
        &previous.user_blocks,
        &consumed_provisional,
        &previous.provisional_tail,
    ) {
        if let Some(block) = previous.by_id.get(block_id.as_str()) {
            // Rule 1 again: the block ALREADY ON DISK, verbatim — its `at`
            // and its attachments are local fields no entry can supply, and
            // rebuilding it from text alone dropped both.
            blocks.push((*block).clone());
            blocks.extend(previous.local_after(&block_id));
            if !previous.has_delivery_notice(&block_id) {
                blocks.push(delivery_unknown_notice());
            }
        }
    }

    Ok(Rebuild::Merged {
        blocks,
        last_entry_id: ancestry.last().map(|e| e.id.clone()),
        leaf_id: data.leaf_id,
    })
}

#[cfg(test)]
#[path = "projection_tests.rs"]
mod tests;
