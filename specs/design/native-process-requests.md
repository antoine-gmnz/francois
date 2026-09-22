# Native process request cards — reuse brief

Existing PermissionCard and QuestionCard remain the visual system. No new screen.

Permission cards show only allowedDecisions when supplied, using existing once labels and button styles. Native cancel uses the explicit label Cancel turn because live evidence shows it interrupts the turn; it is not a Deny once alias. Legacy absent field preserves existing controls. Empty offered set is read-only with existing unavailable hint. Never label native session approval as a persisted Claude Always rule.

Question cards keep existing question/header/options. id is an opaque answer key, not displayed. isOther:false with offered options removes Other; no options permits native freeform. isSecret:true uses a masked input and clears transient draft on successful submit/unmount; answered history displays [redacted]. blocking:false does not freeze composer/progress. Existing disabled/pending styles, focus order and accessible labels apply.

Retired Pi/history remain read-only regardless of optional fields. Native request resolution removes pending state; tool success/failure remains the separate transcript tool result.

