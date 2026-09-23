//! FR-39..FR-41 — the run's gate (oldest pending approval), the finding labels
//! of a review round, and the actions the core offers with their EXACT argv
//! (so the UI's hint is what will run).

use super::cli::{argv, display};
use super::{ApprovalRequest, Finding, Gate, GateAction, Phase};

/// Gate kinds whose card shows the latest review round's findings (FR-39).
const REVIEW_KINDS: &[&str] = &[
    "ship",
    "review-leftovers",
    "contract-change",
    "loop-stalled",
];
/// Run-level gates: denying one stops the run (FR-41). Anything else —
/// including an unknown kind — denies non-destructively.
const RUN_LEVEL_KINDS: &[&str] = &[
    "ship",
    "review-leftovers",
    "contract-change",
    "loop-stalled",
    "budget",
    "spec-not-ready",
    "blocked-ack",
];

pub(crate) fn shows_findings(kind: &str) -> bool {
    REVIEW_KINDS.contains(&kind)
}

pub(crate) fn stops_run(kind: &str) -> bool {
    RUN_LEVEL_KINDS.contains(&kind)
}

/// FR-40: `blocking` when blocking; else `minor` for minor|major|critical, `nit` for info.
pub(crate) fn label_for(blocking: bool, severity: &str) -> &'static str {
    if blocking {
        "blocking"
    } else if severity == "info" {
        "nit"
    } else {
        "minor"
    }
}

fn severity_rank(s: &str) -> u8 {
    match s {
        "critical" => 0,
        "major" => 1,
        "minor" => 2,
        "info" => 3,
        _ => 4,
    }
}

/// FR-40 — relabel a round's findings and order them (blocking first, then
/// severity, then event order). `completed` = review.completed's
/// (`blockingItems`, `blocking`) once it arrived.
pub(crate) fn relabel(findings: &mut [Finding], completed: Option<(&[String], u64)>) {
    let use_items = match completed {
        Some((items, 0)) => Some(items.to_vec()),
        Some((items, _)) if findings.iter().any(|f| items.contains(&f.id)) => Some(items.to_vec()),
        _ => None, // before completion, or ids not matched → severity fallback
    };
    for f in findings.iter_mut() {
        f.blocking = match &use_items {
            Some(items) => items.contains(&f.id),
            None => matches!(f.severity.as_str(), "critical" | "major"),
        };
        f.label = label_for(f.blocking, &f.severity).to_string();
    }
    findings.sort_by_key(|f| (!f.blocking, severity_rank(&f.severity)));
}

/// FR-43 step 1: the first `options` entry matching `/\bfix\b/i`.
pub(crate) fn fix_option(options: Option<&[String]>) -> Option<&String> {
    let word = |c: char| c.is_alphanumeric() || c == '_';
    options?.iter().find(|o| {
        let lower = o.to_lowercase();
        lower.match_indices("fix").any(|(i, _)| {
            let before = lower[..i].chars().next_back();
            let after = lower[i + 3..].chars().next();
            !before.is_some_and(word) && !after.is_some_and(word)
        })
    })
}

/// FR-41 — the offered actions in display order approve · fix · deny.
pub(crate) fn actions(
    run_id: &str,
    req: &ApprovalRequest,
    has_findings: bool,
    has_fix_phase: bool,
) -> Vec<GateAction> {
    let apr = &req.approval_id;
    let line = |r: Result<Vec<String>, _>| r.map(|a| display(&a)).unwrap_or_default();
    let mut out = Vec::new();
    if req.allowed_decisions.iter().any(|d| d == "allow-once") {
        out.push(GateAction {
            id: "approve".into(),
            stops_run: false,
            cli: vec![line(argv::approve(run_id, apr, None))],
        });
    }
    if has_findings && has_fix_phase {
        let cli = match fix_option(req.options.as_deref()) {
            Some(opt) => vec![line(argv::approve(run_id, apr, Some(opt)))],
            None => vec![line(argv::deny(run_id, apr)), line(argv::fix(run_id))],
        };
        out.push(GateAction {
            id: "fix".into(),
            stops_run: false,
            cli,
        });
    }
    if req.allowed_decisions.iter().any(|d| d == "deny") {
        let stops = stops_run(&req.kind);
        let mut cli = vec![line(argv::deny(run_id, apr))];
        if stops {
            cli.push(line(argv::cancel(run_id)));
        }
        out.push(GateAction {
            id: "deny".into(),
            stops_run: stops,
            cli,
        });
    }
    out
}

/// FR-39 — `pending` = every pending approval whose request is known, with
/// its `requestedAt`; `review_findings` = the latest round's findings when
/// that round started after the previous resolution (else `None`).
pub(crate) fn build(
    run_id: &str,
    mut pending: Vec<(&ApprovalRequest, u64)>,
    phases: &[Phase],
    review_findings: Option<&[Finding]>,
) -> Option<Gate> {
    pending.sort_by_key(|(_, at)| *at);
    let (req, requested_at) = *pending.first()?;
    let findings: Vec<Finding> = match review_findings {
        Some(f) if shows_findings(&req.kind) => f.to_vec(),
        _ => Vec::new(),
    };
    let phase_index = req.phase.as_ref().and_then(|p| {
        phases
            .iter()
            .position(|ph| ph.state == p.state)
            .map(|i| i as u64 + 1)
    });
    let has_fix = phases.iter().any(|p| p.state == "FIX");
    Some(Gate {
        run_id: run_id.to_string(),
        request: req.clone(),
        requested_at,
        phase_index,
        phase_count: phases.len() as u64,
        actions: actions(run_id, req, !findings.is_empty(), has_fix),
        findings,
        more_pending: pending.len() as u64 - 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cohorte::testutil::{finding, phase, request};

    #[test]
    fn labels_come_from_blocking_items_when_they_match() {
        let mut fs = vec![
            finding("fnd_a", "minor"),
            finding("fnd_b", "critical"),
            finding("fnd_c", "info"),
        ];
        relabel(&mut fs, Some((&["fnd_a".to_string()], 1)));
        assert_eq!(fs[0].id, "fnd_a");
        assert_eq!(fs[0].label, "blocking");
        assert_eq!(fs[1].label, "minor"); // critical, but Cohorte did not count it
        assert_eq!(fs[2].label, "nit");
    }

    #[test]
    fn without_review_completed_critical_and_major_are_blocking() {
        let mut fs = vec![
            finding("fnd_a", "info"),
            finding("fnd_b", "major"),
            finding("fnd_c", "critical"),
        ];
        relabel(&mut fs, None);
        let got: Vec<_> = fs
            .iter()
            .map(|f| (f.id.as_str(), f.label.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("fnd_c", "blocking"),
                ("fnd_b", "blocking"),
                ("fnd_a", "nit")
            ]
        );
        // blocking > 0 but ids not matched → the same fallback
        let mut fs = vec![finding("fnd_b", "major")];
        relabel(&mut fs, Some((&[], 2)));
        assert!(fs[0].blocking);
    }

    #[test]
    fn fix_options_match_on_a_word_boundary() {
        let opts = vec!["ship".to_string(), "send to fix".to_string()];
        assert_eq!(
            fix_option(Some(&opts)).map(String::as_str),
            Some("send to fix")
        );
        let opts = vec!["prefix it".to_string(), "Fix!".to_string()];
        assert_eq!(fix_option(Some(&opts)).map(String::as_str), Some("Fix!"));
        assert!(fix_option(Some(&["fixture".to_string()])).is_none());
        assert!(fix_option(None).is_none());
    }

    #[test]
    fn actions_carry_the_exact_cli() {
        let req = request("apr_1", "ship", None);
        let a = actions("run_a", &req, true, true);
        let ids: Vec<_> = a.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["approve", "fix", "deny"]);
        assert_eq!(a[0].cli, vec!["cohorte approve run_a apr_1"]);
        assert_eq!(
            a[1].cli,
            vec!["cohorte deny run_a apr_1", "cohorte fix run_a"]
        );
        assert!(a[2].stops_run);
        assert_eq!(
            a[2].cli,
            vec!["cohorte deny run_a apr_1", "cohorte cancel run_a"]
        );
    }

    #[test]
    fn unknown_kinds_deny_without_stopping_and_no_findings_means_no_fix() {
        let req = request("apr_1", "brand-new-kind", None);
        let a = actions("run_a", &req, false, true);
        let ids: Vec<_> = a.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["approve", "deny"]);
        assert!(!a[1].stops_run);
        assert!(!stops_run("tool"));
    }

    #[test]
    fn a_fix_option_turns_send_to_fix_into_one_approve() {
        let req = request(
            "apr_1",
            "review-leftovers",
            Some(vec!["ship", "send to fix"]),
        );
        let a = actions("run_a", &req, true, true);
        assert_eq!(a[1].cli, vec!["cohorte approve run_a apr_1 'send to fix'"]);
    }

    #[test]
    fn the_gate_is_the_oldest_pending_approval() {
        let a = request("apr_a", "tool", None);
        let b = request("apr_b", "ship", None);
        let phases = vec![phase("BUILD"), phase("REVIEW"), phase("FIX"), phase("SHIP")];
        let fs = vec![finding("fnd_1", "major")];
        let g = build("run_a", vec![(&b, 20), (&a, 10)], &phases, Some(&fs)).unwrap();
        assert_eq!(g.request.approval_id, "apr_a");
        assert_eq!(g.more_pending, 1);
        assert!(g.findings.is_empty()); // a tool gate shows no findings
        assert_eq!(g.phase_count, 4);
        let g = build("run_a", vec![(&b, 20)], &phases, Some(&fs)).unwrap();
        assert_eq!(g.findings.len(), 1);
        assert_eq!(g.phase_index, Some(4)); // request.phase = SHIP
        assert!(build("run_a", vec![], &phases, None).is_none());
    }
}
