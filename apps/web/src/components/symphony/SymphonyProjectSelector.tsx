import { WorkflowIcon } from "lucide-react";
import type { ProjectId } from "@t3tools/contracts";

import type { Project } from "../../types";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";

export function SymphonyProjectSelector({
  projects,
  selectedProjectId,
  onProjectChange,
}: {
  projects: readonly Project[];
  selectedProjectId: ProjectId;
  onProjectChange: (projectId: ProjectId) => void;
}) {
  const selectedProject =
    projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  return (
    <SettingsSection title="Project" icon={<WorkflowIcon className="size-3.5" />}>
      <SettingsRow
        title="Symphony project"
        description="Symphony settings are scoped to the active project workspace and never shared globally."
        status={
          selectedProject ? (
            <span className="font-mono text-[11px]">{selectedProject.cwd}</span>
          ) : null
        }
        control={
          <Select
            value={selectedProjectId}
            onValueChange={(value) => onProjectChange(value as ProjectId)}
          >
            <SelectTrigger className="w-full sm:w-64" aria-label="Symphony project">
              <SelectValue>{selectedProject?.name ?? "Select project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {projects.map((project) => (
                <SelectItem
                  hideIndicator
                  key={`${project.environmentId}:${project.id}`}
                  value={project.id}
                >
                  {project.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
