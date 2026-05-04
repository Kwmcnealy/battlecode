import { useState } from "react";

export interface LinearKeyValidationResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface LinearKeyInputProps {
  readonly onValidate: (key: string) => Promise<LinearKeyValidationResult>;
  readonly onValid: (key: string) => void;
}

export function LinearKeyInput(props: LinearKeyInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  async function handleBlur() {
    if (value.trim().length === 0) {
      setError(null);
      return;
    }
    setValidating(true);
    setError(null);
    const result = await props.onValidate(value);
    setValidating(false);
    if (result.ok) {
      props.onValid(value);
    } else {
      setError(result.error ?? "Linear rejected the key");
    }
  }

  return (
    <div>
      <label htmlFor="linear-api-key">Linear API key</label>
      <input
        id="linear-api-key"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        placeholder="lin_api_..."
        disabled={validating}
      />
      {validating ? <p>Validating...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
