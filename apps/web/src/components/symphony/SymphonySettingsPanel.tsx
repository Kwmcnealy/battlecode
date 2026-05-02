import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectId, SymphonySettings } from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";

import { ensureEnvironmentApi } from "../../environmentApi";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { LinearAuthSettings } from "./LinearAuthSettings";
import { SymphonyProjectSelector } from "./SymphonyProjectSelector";
import { SymphonySettingsEmptyState } from "./SymphonySettingsEmptyState";
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
  const [linearKey, setLinearKey] = useState("");
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

  const updateLinearStatus = useCallback((status: SymphonySettings["linearSecret"]) => {
    setSettings((current) =>
      current ? { ...current, linearSecret: status, updatedAt: new Date().toISOString() } : current,
    );
  }, []);

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
        } else if (action === "set-key") {
          updateLinearStatus(
            await api.symphony.setLinearApiKey({
              projectId: selectedProject.id,
              key: linearKey.trim(),
            }),
          );
          setLinearKey("");
        } else if (action === "test-key") {
          updateLinearStatus(
            await api.symphony.testLinearConnection({ projectId: selectedProject.id }),
          );
        } else if (action === "delete-key") {
          updateLinearStatus(
            await api.symphony.deleteLinearApiKey({ projectId: selectedProject.id }),
          );
          setLinearKey("");
        }
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony settings update failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, linearKey, selectedProject, updateLinearStatus, workflowPath],
  );

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

      <LinearAuthSettings
        linearStatus={settings?.linearSecret ?? null}
        linearKey={linearKey}
        busyAction={busyAction}
        setLinearKey={setLinearKey}
        runSettingsAction={(action) => void runSettingsAction(action)}
      />
    </SettingsPageContainer>
  );
}
