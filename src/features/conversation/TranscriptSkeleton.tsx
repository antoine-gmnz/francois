// session-switch-loader FR-1/FR-4/FR-5/FR-6 (design turn 18a "TRANSCRIPT
// LOADING"). Pure and stateless — no props, fixed markup — because it draws
// exactly two turns, always: an older one (faded) and a latest one (full
// opacity), never scaled to the session's real turn count (FR-4's stated
// cost). The latest turn is the richer of the two — assistant prose plus a
// tool rail — because a cold switch lands mid-reply as often as not, and that
// is the shape this rhythm is standing in for.
//
// Every bar is a STATIC fill (FR-6): no `@keyframes` touches `.conv-skel-*`
// anywhere (grep-checked by spec §9's acceptance criterion) — the only motion
// in the loading state is the hairline (`.conv-hydrating-bar` in
// ConversationView) and the composer's own caret blink. Geometry lives in
// conversation.css under the `conv-skel*` block; this file is DOM assembly
// only, mirroring how Turn.tsx relates to conversation.css's `.turn` rules.
//
// aria-hidden: this stack states nothing real — it is decorative structure
// standing in for content that has not arrived yet.
export default function TranscriptSkeleton() {
  return (
    <div className="conv-skel-stack" aria-hidden="true">
      <div className="conv-skel-turn conv-skel-turn--older">
        <span className="conv-skel-gutter conv-skel-gutter--user">›</span>
        <div className="conv-skel-col">
          <div className="conv-skel-head">
            <span className="conv-skel-bar conv-skel-head-bar--user-a" />
            <span className="conv-skel-rule" />
            <span className="conv-skel-bar conv-skel-head-bar--user-b" />
          </div>
          <div className="conv-skel-body">
            <span className="conv-skel-bar conv-skel-line conv-skel-line--older-user" />
          </div>
        </div>
      </div>

      <div className="conv-skel-turn conv-skel-turn--latest">
        <span className="conv-skel-gutter conv-skel-gutter--assistant">⏺</span>
        <div className="conv-skel-col">
          <div className="conv-skel-head">
            <span className="conv-skel-bar conv-skel-head-bar--asst-a" />
            <span className="conv-skel-bar conv-skel-head-bar--asst-extra" />
            <span className="conv-skel-rule" />
            <span className="conv-skel-bar conv-skel-head-bar--asst-b" />
          </div>
          <div className="conv-skel-body">
            <span className="conv-skel-bar conv-skel-line conv-skel-line--latest-1" />
            <span className="conv-skel-bar conv-skel-line conv-skel-line--latest-2" />
            <span className="conv-skel-bar conv-skel-line conv-skel-line--latest-3" />
          </div>
          <div className="conv-skel-rail">
            <div className="conv-skel-rail__row">
              <span className="conv-skel-rail__square" />
              <span className="conv-skel-rail__bar" />
              <span className="conv-skel-rail__name conv-skel-rail__name--1" />
              <span className="conv-skel-rail__tail" />
            </div>
            <div className="conv-skel-rail__row">
              <span className="conv-skel-rail__square" />
              <span className="conv-skel-rail__bar" />
              <span className="conv-skel-rail__name conv-skel-rail__name--2" />
              <span className="conv-skel-rail__tail" />
            </div>
            <div className="conv-skel-rail__row">
              <span className="conv-skel-rail__square" />
              <span className="conv-skel-rail__bar" />
              <span className="conv-skel-rail__name conv-skel-rail__name--3" />
              <span className="conv-skel-rail__tail" />
            </div>
          </div>
          <div className="conv-skel-body">
            <span className="conv-skel-bar conv-skel-line conv-skel-line--tail-1" />
            <span className="conv-skel-bar conv-skel-line conv-skel-line--tail-2" />
          </div>
        </div>
      </div>
    </div>
  );
}
