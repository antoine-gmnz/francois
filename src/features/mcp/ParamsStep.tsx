// AttachOverlay's second step: fill in the registry entry's params (or the
// custom-server name/transport/command/url), then submit.

import type { AppError } from '../../../contract/common';
import type { McpRegistryEntry } from '../../../contract/mcp-panel';
import type { CustomServerForm } from './mcp';

export function ParamsStep({
  selected,
  custom,
  onCustomChange,
  form,
  onFormChange,
  submitError,
  canSubmit,
  submitting,
  onSubmit,
}: {
  selected: McpRegistryEntry | 'custom';
  custom: CustomServerForm;
  onCustomChange: (next: CustomServerForm) => void;
  form: Record<string, string>;
  onFormChange: (next: Record<string, string>) => void;
  submitError: AppError | null;
  canSubmit: boolean;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="mcp-params-step">
      {selected === 'custom' ? (
        <CustomServerFields custom={custom} onChange={onCustomChange} />
      ) : (
        <TemplateParamFields entry={selected} form={form} onChange={onFormChange} />
      )}

      {submitError && <div className="form-error">{submitError.message}</div>}

      <button onClick={onSubmit} disabled={!canSubmit || submitting} className={canSubmit && !submitting ? 'mcp-submit-btn mcp-submit-btn--enabled' : 'mcp-submit-btn'}>
        {submitting ? 'attaching…' : 'Attach server'}
      </button>
    </div>
  );
}

function CustomServerFields({ custom, onChange }: { custom: CustomServerForm; onChange: (next: CustomServerForm) => void }) {
  return (
    <>
      <FormField label="NAME" required value={custom.name} onChange={(v) => onChange({ ...custom, name: v })} />
      <div>
        <div className="mcp-form-label">TRANSPORT</div>
        <div className="mcp-transport-pills">
          {(['stdio', 'http'] as const).map((t) => (
            <span key={t} onClick={() => onChange({ ...custom, transport: t })} className={custom.transport === t ? 'mcp-pill mcp-pill--selected' : 'mcp-pill'}>
              {t}
            </span>
          ))}
        </div>
      </div>
      {custom.transport === 'stdio' ? (
        <FormField label="COMMAND" required mono value={custom.command} onChange={(v) => onChange({ ...custom, command: v })} />
      ) : (
        <FormField label="URL" required mono value={custom.url} onChange={(v) => onChange({ ...custom, url: v })} />
      )}
    </>
  );
}

function TemplateParamFields({
  entry,
  form,
  onChange,
}: {
  entry: McpRegistryEntry;
  form: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  return (
    <>
      {entry.params.map((p) => (
        <FormField key={p.key} label={p.label} required={p.required} secret={p.secret} value={form[p.key] ?? ''} onChange={(v) => onChange({ ...form, [p.key]: v })} />
      ))}
    </>
  );
}

function FormField({
  label,
  value,
  onChange,
  required,
  secret,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  secret?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mcp-form-label">
        {label}
        {required && <span className="mcp-form-required"> *</span>}
      </div>
      <input
        type={secret ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={mono ? 'mcp-form-input mcp-form-input--mono' : 'mcp-form-input'}
      />
    </div>
  );
}
