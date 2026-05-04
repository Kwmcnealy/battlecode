import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";

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

  async function handleValidate() {
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
    <div className="flex flex-col gap-2">
      <label htmlFor="wizard-linear-api-key" className="text-sm font-medium">
        Linear API key
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="wizard-linear-api-key"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleValidate}
          placeholder="lin_api_..."
          disabled={validating}
          autoComplete="off"
        />
        <Button
          size="xs"
          disabled={validating || value.trim().length === 0}
          onClick={handleValidate}
        >
          {validating ? <Spinner className="size-3" /> : null}
          Validate
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
