import { useEffect, useState } from "react";

import type { SymphonyLinearWorkflowState } from "@t3tools/contracts";

type SlotKey = "intake" | "active" | "review" | "done" | "canceled";
const SLOTS: readonly SlotKey[] = ["intake", "active", "review", "done", "canceled"] as const;

export interface LinearStateMapping {
  readonly intake: readonly string[];
  readonly active: readonly string[];
  readonly review: readonly string[];
  readonly done: readonly string[];
  readonly canceled: readonly string[];
}

export interface LinearStateMapperProps {
  readonly states: readonly SymphonyLinearWorkflowState[];
  readonly onChange: (mapping: LinearStateMapping) => void;
}

function defaultSlotForType(type: string): SlotKey | null {
  switch (type) {
    case "unstarted":
      return "intake";
    case "started":
      return "active";
    case "completed":
      return "done";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

export function LinearStateMapper(props: LinearStateMapperProps) {
  const [mapping, setMapping] = useState<Record<SlotKey, Set<string>>>(() => {
    const initial: Record<SlotKey, Set<string>> = {
      intake: new Set(),
      active: new Set(),
      review: new Set(),
      done: new Set(),
      canceled: new Set(),
    };
    for (const state of props.states) {
      const slot = defaultSlotForType(state.type);
      if (slot) initial[slot].add(state.name);
    }
    // promote one "started" state to "review" if Linear has an "In Review" by name
    const inReview = props.states.find((s) => s.name === "In Review");
    if (inReview) {
      initial.active.delete("In Review");
      initial.review.add("In Review");
    }
    return initial;
  });

  useEffect(() => {
    const out: LinearStateMapping = {
      intake: [...mapping.intake],
      active: [...mapping.active],
      review: [...mapping.review],
      done: [...mapping.done],
      canceled: [...mapping.canceled],
    };
    props.onChange(out);
  }, [mapping, props.onChange]);

  function toggle(slot: SlotKey, name: string) {
    setMapping((prev) => {
      const next = { ...prev, [slot]: new Set(prev[slot]) };
      if (next[slot].has(name)) next[slot].delete(name);
      else next[slot].add(name);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {props.states.map((state) => (
        <fieldset
          key={state.id}
          className="flex flex-col gap-2 rounded-md border border-input/40 px-3 py-2"
        >
          <legend className="text-sm font-medium">{state.name}</legend>
          <div className="flex flex-wrap gap-3">
            {SLOTS.map((slot) => {
              const labelText = `${state.name} (${slot})`;
              const inputId = `state-${state.id}-${slot}`;
              return (
                <span key={slot} className="inline-flex items-center gap-1.5 text-xs">
                  <input
                    id={inputId}
                    type="checkbox"
                    checked={mapping[slot].has(state.name)}
                    onChange={() => toggle(slot, state.name)}
                    className="size-3.5 cursor-pointer accent-primary"
                  />
                  <label htmlFor={inputId} className="cursor-pointer">
                    {labelText}
                  </label>
                </span>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
