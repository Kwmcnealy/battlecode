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
    <div>
      {props.states.map((state) => (
        <fieldset key={state.id}>
          <legend>{state.name}</legend>
          {SLOTS.map((slot) => {
            const labelText = `${state.name} (${slot})`;
            const inputId = `state-${state.id}-${slot}`;
            return (
              <span key={slot}>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={mapping[slot].has(state.name)}
                  onChange={() => toggle(slot, state.name)}
                />
                <label htmlFor={inputId}>{labelText}</label>
              </span>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
