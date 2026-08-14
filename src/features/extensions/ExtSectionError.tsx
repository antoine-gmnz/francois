// FR-49: the one error treatment every section shares — the cause on one line
// (with the declared minimum version when there is one), the resolved command
// underneath in monospace when the core sent it, the truncated stderr of a
// non-zero exit, and a `Retry`. Toned `error`, never the accent, and never
// confusable with a zero-row success (which renders the panel's empty copy).

import type { AppError } from '../../../contract/common';
import { Button } from '../../ui/Button';
import { RETRY_COPY, errorCommand, errorDetailText, errorHeadline } from './extensions';

export interface ExtSectionErrorProps {
  error: AppError;
  minVersionLabel: string | null;
  onRetry?: () => void;
}

export default function ExtSectionError({ error, minVersionLabel, onRetry }: ExtSectionErrorProps) {
  const command = errorCommand(error);
  const detail = errorDetailText(error);
  return (
    <div className="ext-error">
      <div className="ext-error__cause">{errorHeadline(error, minVersionLabel)}</div>
      {command && <div className="ext-error__command">{command}</div>}
      {detail && <div className="ext-error__detail">{detail}</div>}
      {onRetry && (
        <Button className="ext-error__retry" onClick={onRetry}>
          {RETRY_COPY}
        </Button>
      )}
    </div>
  );
}
