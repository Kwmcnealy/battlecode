import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SettingsWizard } from "./SettingsWizard.tsx";

const noopApi = {
  validateKey: vi.fn().mockResolvedValue({ ok: true }),
  fetchProjects: vi
    .fn()
    .mockResolvedValue([
      { id: "p1", name: "BattleTCG", slugId: "abc111", teamId: "t1", teamName: "Eng" },
    ]),
  fetchStates: vi.fn().mockResolvedValue([
    { id: "s1", name: "To Do", type: "unstarted", position: 0 },
    { id: "s2", name: "In Progress", type: "started", position: 1 },
    { id: "s3", name: "In Review", type: "started", position: 2 },
    { id: "s4", name: "Done", type: "completed", position: 3 },
    { id: "s5", name: "Canceled", type: "canceled", position: 4 },
  ]),
  applyConfiguration: vi.fn().mockResolvedValue({ ok: true, reloaded: true }),
};

describe("SettingsWizard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("walks through key → project → states → save", async () => {
    const screen = await render(<SettingsWizard api={noopApi} />);

    try {
      // Step 1: paste key
      const key = screen.getByLabelText("Linear API key");
      await userEvent.type(key, "lin_api_xxx");
      await userEvent.tab();

      // Step 2: pick project
      await vi.waitFor(() => screen.getByLabelText("Linear project"));
      await userEvent.selectOptions(screen.getByLabelText("Linear project"), "p1");

      // Step 3: state mapper appears with defaults
      await vi.waitFor(() => screen.getByLabelText("To Do (intake)"));

      // Step 4: save
      await userEvent.click(screen.getByText("Save configuration"));

      await vi.waitFor(() => {
        expect(noopApi.applyConfiguration).toHaveBeenCalledWith(
          expect.objectContaining({
            trackerProjectSlugId: "abc111",
            states: expect.objectContaining({
              intake: ["To Do"],
              active: ["In Progress"],
              review: ["In Review"],
              done: ["Done"],
              canceled: ["Canceled"],
            }),
          }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });
});
