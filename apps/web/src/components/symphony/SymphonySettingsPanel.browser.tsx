import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "../../store";
import { SymphonySettingsPanel } from "./SymphonySettingsPanel";

describe("SymphonySettingsPanel", () => {
  beforeEach(() => {
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the empty settings state without an external-store render loop", async () => {
    const screen = await render(<SymphonySettingsPanel />);

    try {
      await expect.element(page.getByText("No active projects")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
