// useDirectoryPicker — NewSessionModal.tsx's former :188-206 (applyCwd +
// browse + picker state). Shared by Browse and direct typing: keeps the
// derived name and the FR-16 runtime auto-suggest in sync with the path. The
// suggest follows the path in BOTH directions (wsl for a WSL UNC path, back
// to native otherwise) but only while the user hasn't explicitly clicked a
// runtime chip this modal-open.

import { useState } from 'react';
import type { AppError, ClaudeRuntime } from '../../../contract/common';
import { isWslUncPath } from '../../../contract/wsl-filesystem';
import { sessionPickDirectory } from '../../lib/api';
import { IS_WINDOWS } from '../../lib/platform';
import { basename } from './new-session-form';

export interface UseDirectoryPickerParams {
  nameTouched: boolean;
  runtimeTouched: boolean;
  setCwd: (cwd: string) => void;
  setName: (name: string) => void;
  setRuntime: (runtime: ClaudeRuntime) => void;
}

export interface UseDirectoryPickerResult {
  picking: boolean;
  pickerError: AppError | null;
  applyCwd: (path: string) => void;
  browse: () => Promise<void>;
}

export function useDirectoryPicker({
  nameTouched,
  runtimeTouched,
  setCwd,
  setName,
  setRuntime,
}: UseDirectoryPickerParams): UseDirectoryPickerResult {
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<AppError | null>(null);

  const applyCwd = (path: string) => {
    setCwd(path);
    if (!nameTouched) setName(basename(path));
    if (IS_WINDOWS && !runtimeTouched) setRuntime(isWslUncPath(path) ? 'wsl' : 'native');
  };

  const browse = async () => {
    if (picking) return;
    setPicking(true);
    setPickerError(null);
    const res = await sessionPickDirectory();
    setPicking(false);
    if (!res.ok) {
      setPickerError(res.error);
      return;
    }
    if (res.data === null) return; // cancelled
    applyCwd(res.data.path);
  };

  return { picking, pickerError, applyCwd, browse };
}
