import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectId, SymphonySettings } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../../environmentApi";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { SymphonyProjectSelector } from "./SymphonyProjectSelector";
import { SymphonySettingsEmptyState } from "./SymphonySettingsEmptyState";
import { SettingsWizard, type SettingsWizardApi } from "./SettingsWizard";
import type { SymphonySettingsBusyAction } from "./symphonySettingsDisplay";
import { WorkflowSettingsSection } from "./WorkflowSettingsSection";

export function SymphonySettingsPanel() {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const [selectedProjectId, setSelectedProjectId] = useState<ProjectId | null>(
    () => projects[0]?.id ?? null,
  );
  const selectedProject = useMemo(
    () =>
      selectedProjectId
        ? (projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null)
        : (projects[0] ?? null),
    [projects, selectedProjectId],
  );
  const [settings, setSettings] = useState<SymphonySettings | null>(null);
  const [workflowPath, setWorkflowPath] = useState("");
  const [busyAction, setBusyAction] = useState<SymphonySettingsBusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedProjectId && projects[0]) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects, selectedProjectId]);

  const api = useMemo(
    () => (selectedProject ? ensureEnvironmentApi(selectedProject.environmentId) : null),
    [selectedProject],
  );

  const loadSettings = useCallback(async () => {
    if (!api || !selectedProject) return;
    setBusyAction("load");
    try {
      const next = await api.symphony.getSettings({ projectId: selectedProject.id });
      setSettings(next);
      setWorkflowPath(next.workflowPath);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load Symphony settings.");
    } finally {
      setBusyAction(null);
    }
  }, [api, selectedProject]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const runSettingsAction = useCallback(
    async (action: Exclude<SymphonySettingsBusyAction, "load">) => {
      if (!api || !selectedProject) return;
      setBusyAction(action);
      try {
        if (action === "save-workflow") {
          const next = await api.symphony.updateWorkflowPath({
            projectId: selectedProject.id,
            path: workflowPath.trim(),
          });
          setSettings(next);
          setWorkflowPath(next.workflowPath);
        } else if (action === "create-workflow") {
          const next = await api.symphony.createStarterWorkflow({ projectId: selectedProject.id });
          setSettings(next);
          setWorkflowPath(next.workflowPath);
        } else if (action === "validate-workflow") {
          const next = await api.symphony.validateWorkflow({ projectId: selectedProject.id });
          setSettings(next);
          setWorkflowPath(next.workflowPath);
        }
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony settings update failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, selectedProject, workflowPath],
  );

  const wizardApi = useMemo((): SettingsWizardApi | null => {
    if (!api || !selectedProject) return null;
    const projectId = selectedProject.id;
    return {
      validateKey: async (key) => {
        try {
          await api.symphony.fetchLinearProjects({ projectId, apiKey: key });
          return { ok: true };
        } catch (cause) {
          return { ok: false, error: cause instanceof Error ? cause.message : "Validation failed" };
        }
      },
      saveApiKey: async (key) => {
        const next = await api.symphony.setLinearApiKey({ projectId, key });
        setSettings(next);
      },
      fetchProjects: (key) => api.symphony.fetchLinearProjects({ projectId, apiKey: key }),
      fetchStates: (key, project) =>
        api.symphony.fetchLinearWorkflowStates({ projectId, apiKey: key, teamId: project.teamId }),
      applyConfiguration: (input) => api.symphony.applyConfiguration({ projectId, ...input }),
    };
  }, [api, selectedProject]);

  if (projects.length === 0 || !selectedProjectId || !selectedProject) {
    return <SymphonySettingsEmptyState />;
  }

  return (
    <SettingsPageContainer>
      <SymphonyProjectSelector
        projects={projects}
        selectedProjectId={selectedProject.id}
        onProjectChange={setSelectedProjectId}
      />

      {error ? (
        <div className="border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <WorkflowSettingsSection
        selectedProject={selectedProject}
        settings={settings}
        workflowPath={workflowPath}
        busyAction={busyAction}
        setWorkflowPath={setWorkflowPath}
        runSettingsAction={(action) => void runSettingsAction(action)}
      />

      {wizardApi ? <SettingsWizard api={wizardApi} /> : null}
    </SettingsPageContainer>
  );
}
