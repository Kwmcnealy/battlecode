import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { LinearStateMapper } from "./LinearStateMapper.tsx";

const states = [
  { id: "s1", name: "Backlog", type: "backlog", position: 0 },
  { id: "s2", name: "To Do", type: "unstarted", position: 1 },
  { id: "s3", name: "In Progress", type: "started", position: 2 },
  { id: "s4", name: "In Review", type: "started", position: 3 },
  { id: "s5", name: "Done", type: "completed", position: 4 },
  { id: "s6", name: "Canceled", type: "canceled", position: 5 },
];

describe("LinearStateMapper", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("calls onChange when the user toggles state checkboxes", async () => {
    const onChange = vi.fn();
    const screen = await render(<LinearStateMapper states={states} onChange={onChange} />);

    try {
      await userEvent.click(screen.getByLabelText("To Do (intake)"));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          intake: ["To Do"],
        }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("seeds defaults from Linear state types", async () => {
    const onChange = vi.fn();
    const screen = await render(<LinearStateMapper states={states} onChange={onChange} />);

    try {
      expect(screen.getByLabelText("To Do (intake)")).toBeChecked();
      expect(screen.getByLabelText("In Progress (active)")).toBeChecked();
      expect(screen.getByLabelText("In Review (review)")).toBeChecked();
      expect(screen.getByLabelText("Done (done)")).toBeChecked();
      expect(screen.getByLabelText("Canceled (canceled)")).toBeChecked();
      expect(screen.getByLabelText("Backlog (intake)")).not.toBeChecked();
    } finally {
      await screen.unmount();
    }
  });
});
