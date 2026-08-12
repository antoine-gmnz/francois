// The plan usage-limit notice — shown when a turn died on the account's usage
// (or rate) limit. The session is NOT dead: the core keeps it idle, so the
// composer stays live and the user can send again once the window resets. This
// banner is where that failure is stated; before it existed the message went to
// the composer placeholder of a session marked terminally errored, which read
// as "this session is over" and disabled the input for good.
//
// Dismissible; also cleared automatically by the next user turn (see
// conversation-blocks.ts's session event handlers).

import { usageLimitNoticeText } from './usage-limit';

export default function UsageLimitBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="limit-banner">
      <span className="limit-banner__text">{usageLimitNoticeText(message)}</span>
      <span onClick={onDismiss} className="limit-banner__dismiss" title="dismiss">
        ✕
      </span>
    </div>
  );
}
