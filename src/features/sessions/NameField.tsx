// NameField — NewSessionModal.tsx's former :366-377.

export interface NameFieldProps {
  name: string;
  onChange: (name: string) => void;
}

export function NameField({ name, onChange }: NameFieldProps): JSX.Element {
  return (
    <div>
      <label className="new-session-modal__label">NAME</label>
      <input
        className="new-session-modal__field"
        value={name}
        placeholder="session name"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
