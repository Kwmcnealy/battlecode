import { useState } from "react";

import type { SymphonyLinearProject, SymphonyLinearWorkflowState } from "@t3tools/contracts";

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

  async function handleValidKey(key: string) {
    setApiKey(key);
    const fetched = await props.api.fetchProjects(key);
    setProjects(fetched);
    setStep(1);
  }

  async function handleSelectProject(p: SymphonyLinearProject) {
    setProject(p);
    if (apiKey) {
      const fetched = await props.api.fetchStates(apiKey, p);
      setStates(fetched);
    }
    setStep(2);
  }

  async function handleSave() {
    if (!project || !mapping || !apiKey) return;
    try {
      // Persist the API key to the OS secret store first so polling can use it.
      await props.api.saveApiKey(apiKey);
    } catch (cause) {
      setSaved({
        ok: false,
        error: cause instanceof Error ? cause.message : "Failed to save Linear API key.",
      });
      return;
    }
    const result = await props.api.applyConfiguration({
      trackerProjectSlugId: project.slugId,
      trackerProjectName: project.name,
      trackerTeamId: project.teamId,
      states: mapping,
      validation: ["bun fmt", "bun lint", "bun typecheck", "bun run test"],
      prBaseBranch: "development",
    });
    setSaved(result);
  }

  return (
    <div>
      <WizardProgress steps={["API key", "Project", "States", "Save"]} currentIndex={step} />
      {step === 0 ? (
        <LinearKeyInput onValidate={(k) => props.api.validateKey(k)} onValid={handleValidKey} />
      ) : null}
      {step === 1 ? (
        <LinearProjectPicker projects={projects} onSelect={handleSelectProject} />
      ) : null}
      {step === 2 ? (
        <>
          <LinearStateMapper states={states} onChange={setMapping} />
          <button type="button" onClick={handleSave}>
            Save configuration
          </button>
        </>
      ) : null}
      {saved && saved.ok ? <p>Configuration saved.</p> : null}
      {saved && !saved.ok ? <p role="alert">{saved.error}</p> : null}
    </div>
  );
}
