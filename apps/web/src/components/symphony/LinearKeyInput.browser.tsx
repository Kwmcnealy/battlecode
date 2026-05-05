import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { LinearKeyInput } from "./LinearKeyInput.tsx";

describe("LinearKeyInput", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("calls onValidate with the key on blur", async () => {
    const onValidate = vi.fn().mockResolvedValue({ ok: true });
    const onValid = vi.fn();
    const screen = await render(<LinearKeyInput onValidate={onValidate} onValid={onValid} />);

    try {
      const input = screen.getByLabelText("Linear API key");
      await userEvent.type(input, "lin_api_abc");
      await userEvent.tab();

      expect(onValidate).toHaveBeenCalledWith("lin_api_abc");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the OAuth-token error when the key looks JWT-shaped", async () => {
    const onValidate = vi.fn().mockResolvedValue({
      ok: false,
      error:
        "This looks like an OAuth/JWT token. Symphony requires a personal API key (lin_api_*).",
    });
    const screen = await render(<LinearKeyInput onValidate={onValidate} onValid={() => {}} />);

    try {
      const input = screen.getByLabelText("Linear API key");
      await userEvent.type(input, "eyJhbGciOiJIUzI1NiJ9.payload.signature");
      await userEvent.tab();

      await expect.element(screen.getByText(/OAuth/)).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("calls onValid when the API confirms the key", async () => {
    const onValidate = vi.fn().mockResolvedValue({ ok: true });
    const onValid = vi.fn();
    const screen = await render(<LinearKeyInput onValidate={onValidate} onValid={onValid} />);

    try {
      const input = screen.getByLabelText("Linear API key");
      await userEvent.type(input, "lin_api_xxx");
      await userEvent.tab();

      await vi.waitFor(() => {
        expect(onValid).toHaveBeenCalledWith("lin_api_xxx");
      });
    } finally {
      await screen.unmount();
    }
  });
});
