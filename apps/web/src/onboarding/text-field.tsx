/** A labelled text input whose hint and error are associated through aria-describedby. */
export function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  disabled = false,
  autoComplete = "off",
  type = "text",
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly disabled?: boolean;
  readonly autoComplete?: string;
  readonly type?: "text" | "email" | "password";
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? undefined : hintId, error === undefined ? undefined : errorId]
    .filter((part) => part !== undefined)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {hint === undefined ? null : (
        <p id={hintId} className="hint">
          {hint}
        </p>
      )}
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        spellCheck={false}
        disabled={disabled}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={describedBy === "" ? undefined : describedBy}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {error === undefined ? null : (
        <p id={errorId} className="field-error">
          Error: {error}
        </p>
      )}
    </div>
  );
}
