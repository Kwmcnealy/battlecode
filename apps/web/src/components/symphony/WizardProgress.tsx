import { cn } from "../../lib/utils";

export interface WizardProgressProps {
  readonly steps: readonly string[];
  readonly currentIndex: number;
}

export function WizardProgress(props: WizardProgressProps) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.06em] text-muted-foreground">
      {props.steps.map((step, idx) => {
        const isCurrent = idx === props.currentIndex;
        const isComplete = idx < props.currentIndex;
        return (
          <li
            key={step}
            aria-current={isCurrent ? "step" : undefined}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1",
              isCurrent && "border-primary/60 bg-primary/10 text-primary",
              isComplete && "border-success/40 bg-success/10 text-success",
              !isCurrent && !isComplete && "border-input/40",
            )}
          >
            <span className="font-mono">{idx + 1}.</span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
