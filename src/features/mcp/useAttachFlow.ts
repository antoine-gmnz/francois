// AttachOverlay's state machine: registry fetch, registry/params step nav,
// keyboard handling, and submit. Extracted so AttachOverlay itself stays a
// thin JSX shell over RegistryStep / ParamsStep.

import { useEffect, useState } from 'react';
import type { AppError } from '../../../contract/common';
import type { McpRegistryEntry } from '../../../contract/mcp-panel';
import { mcpAttach, mcpRegistry } from '../../lib/api';
import { buildAttachRequest, canSubmitAttach, type CustomServerForm } from './mcp';

export function useAttachFlow(sessionId: string, existing: string[], onClose: () => void) {
  const [step, setStep] = useState<'registry' | 'params'>('registry');
  const [registry, setRegistry] = useState<McpRegistryEntry[] | null>(null);
  const [regError, setRegError] = useState<AppError | null>(null);
  const [selIndex, setSelIndex] = useState(0);
  const [selected, setSelected] = useState<McpRegistryEntry | 'custom' | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<CustomServerForm>({ name: '', transport: 'stdio', command: '', url: '' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<AppError | null>(null);

  useEffect(() => {
    void mcpRegistry().then((res) => {
      if (res.ok) setRegistry(res.data);
      else setRegError(res.error);
    });
  }, []);

  const rows: (McpRegistryEntry | 'custom')[] = [...(registry ?? []), 'custom'];

  const advance = (row: McpRegistryEntry | 'custom') => {
    setSelected(row);
    setForm({});
    setSubmitError(null);
    setStep('params');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (step === 'params') setStep('registry');
        else onClose();
      } else if (step === 'registry') {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelIndex((i) => Math.min(i + 1, rows.length - 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelIndex((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          advance(rows[selIndex]);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const submit = async () => {
    if (submitting || !selected) return;
    const result = buildAttachRequest(selected, custom, form, existing);
    if (!result.ok) {
      setSubmitError(result.error);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const res = await mcpAttach(sessionId, result.request);
    setSubmitting(false);
    if (res.ok) onClose();
    else setSubmitError(res.error);
  };

  const canSubmit = canSubmitAttach(selected, custom, form, existing);

  return {
    step,
    rows,
    regError,
    selIndex,
    setSelIndex,
    selected,
    advance,
    form,
    setForm,
    custom,
    setCustom,
    submitting,
    submitError,
    canSubmit,
    submit,
  };
}
