import { useState } from "react";
import { SparklesIcon } from "lucide-react";

import type { SymphonyLinearProject, SymphonyLinearWorkflowState } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { SettingsSection } from "../settings/settingsLayout";
import { LinearKeyInput } from "./LinearKeyInput.tsx";
import { LinearProjectPicker } from "./LinearProjectPicker.tsx";
import { LinearStateMapper, type LinearStateMapping } from "./LinearStateMapper.tsx";
import { WizardProgress } from "./WizardProgress.tsx";

export interface SettingsWizardApi {
  readonly validateKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  readonly saveApiKey: (key: string) => Promise<void>;
  readonly fetchProjects: (key: string) => Promise<readonly SymphonyLinearProject[]>;
  readonly fetchStates: (
    key: string,
    project: SymphonyLinearProject,
  ) => Promise<readonly SymphonyLinearWorkflowState[]>;
  readonly applyConfiguration: (input: {
    readonly trackerProjectSlugId: string;
    readonly trackerProjectName: string;
    readonly trackerTeamId: string;
    readonly states: LinearStateMapping;
    readonly validation: readonly string[];
    readonly prBaseBranch: string;
  }) => Promise<{ ok: true; reloaded: boolean } | { ok: false; error: string }>;
}

export interface SettingsWizardProps {
  readonly api: SettingsWizardApi;
}

export function SettingsWizard(props: SettingsWizardProps) {
  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly SymphonyLinearProject[]>([]);
  const [project, setProject] = useState<SymphonyLinearProject | null>(null);
  const [states, setStates] = useState<readonly SymphonyLinearWorkflowState[]>([]);
  const [mapping, setMapping] = useState<LinearStateMapping | null>(null);
  const [saved, setSaved] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleValidKey(key: string) {
    setApiKey(key);
    setBusy(true);
    try {
      const fetched = await props.api.fetchProjects(key);
      setProjects(fetched);
      setStep(1);
    } finally {
      setBusy(false);
    }
  }

  async function handleSelectProject(p: SymphonyLinearProject) {
    setProject(p);
    if (apiKey) {
      setBusy(true);
      try {
        const fetched = await props.api.fetchStates(apiKey, p);
        setStates(fetched);
      } finally {
        setBusy(false);
      }
    }
    setStep(2);
  }

  async function handleSave() {
    if (!project || !mapping || !apiKey) return;
    setBusy(true);
    try {
      // Persist the API key to the OS secret store first so polling can use it.
      await props.api.saveApiKey(apiKey);
    } catch (cause) {
      setSaved({
        ok: false,
        error: cause instanceof Error ? cause.message : "Failed to save Linear API key.",
      });
      setBusy(false);
      return;
    }
    try {
      const result = await props.api.applyConfiguration({
        trackerProjectSlugId: project.slugId,
        trackerProjectName: project.name,
        trackerTeamId: project.teamId,
        states: mapping,
        validation: ["bun fmt", "bun lint", "bun typecheck", "bun run test"],
        prBaseBranch: "development",
      });
      setSaved(result);
      if (result.ok) {
        setStep(3);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection title="Setup Wizard" icon={<SparklesIcon className="size-3.5" />}>
      <div className="flex flex-col gap-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Pick your Linear project and map its workflow states to Symphony lifecycle slots. The
          wizard writes <code>WORKFLOW.md</code> for you so configuration is correct by
          construction.
        </p>

        <WizardProgress steps={["API key", "Project", "States", "Save"]} currentIndex={step} />

        <div className="flex flex-col gap-3">
          {step === 0 ? (
            <LinearKeyInput onValidate={(k) => props.api.validateKey(k)} onValid={handleValidKey} />
          ) : null}
          {step === 1 ? (
            <LinearProjectPicker projects={projects} onSelect={handleSelectProject} />
          ) : null}
          {step === 2 ? (
            <>
              <LinearStateMapper states={states} onChange={setMapping} />
              <div>
                <Button
                  size="xs"
                  type="button"
                  onClick={handleSave}
                  disabled={busy || !project || !mapping || !apiKey}
                >
                  Save configuration
                </Button>
              </div>
            </>
          ) : null}
          {step === 3 && saved && saved.ok ? (
            <p className="text-sm text-success">
              Configuration saved. <code>WORKFLOW.md</code> updated and Symphony reloaded.
            </p>
          ) : null}
          {saved && !saved.ok ? (
            <p role="alert" className="text-sm text-destructive">
              {saved.error}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
