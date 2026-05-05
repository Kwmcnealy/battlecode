import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { LinearProjectPicker } from "./LinearProjectPicker.tsx";

describe("LinearProjectPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders a dropdown of projects grouped by team name", async () => {
    const projects = [
      { id: "p1", name: "Marketing site", slugId: "abc111", teamId: "t1", teamName: "Marketing" },
      { id: "p2", name: "Backend", slugId: "abc222", teamId: "t2", teamName: "Engineering" },
      { id: "p3", name: "Frontend", slugId: "abc333", teamId: "t2", teamName: "Engineering" },
    ];

    const onSelect = vi.fn();
    const screen = await render(<LinearProjectPicker projects={projects} onSelect={onSelect} />);

    try {
      await userEvent.click(screen.getByRole("combobox"));
      await userEvent.selectOptions(screen.getByRole("combobox"), "p2");

      expect(onSelect).toHaveBeenCalledWith({
        id: "p2",
        name: "Backend",
        slugId: "abc222",
        teamId: "t2",
        teamName: "Engineering",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disables the select when no projects are available", async () => {
    const onSelect = vi.fn();
    const screen = await render(<LinearProjectPicker projects={[]} onSelect={onSelect} />);

    try {
      expect(screen.getByRole("combobox")).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });
});
