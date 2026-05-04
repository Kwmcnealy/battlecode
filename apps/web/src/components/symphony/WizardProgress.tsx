export interface WizardProgressProps {
  readonly steps: readonly string[];
  readonly currentIndex: number;
}

export function WizardProgress(props: WizardProgressProps) {
  return (
    <ol>
      {props.steps.map((step, idx) => (
        <li key={step} aria-current={idx === props.currentIndex ? "step" : undefined}>
          {step}
        </li>
      ))}
    </ol>
  );
}
