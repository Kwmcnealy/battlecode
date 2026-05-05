import { CpuIcon, RefreshCwIcon, WorkflowIcon } from "lucide-react";
import type { SymphonySettings } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { Project } from "../../types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  defaultWorkflowPath,
  statusBadgeClassName,
  type SymphonySettingsBusyAction,
} from "./symphonySettingsDisplay";

export function WorkflowSettingsSection({
  selectedProject,
  settings,
  workflowPath,
  busyAction,
  setWorkflowPath,
  runSettingsAction,
}: {
  selectedProject: Project;
  settings: SymphonySettings | null;
  workflowPath: string;
  busyAction: SymphonySettingsBusyAction | null;
  setWorkflowPath: (path: string) => void;
  runSettingsAction: (action: Exclude<SymphonySettingsBusyAction, "load">) => void;
}) {
  const workflowStatus = settings?.workflowStatus ?? null;
  const isBusy = busyAction !== null;

  return (
    <SettingsSection title="Workflow" icon={<WorkflowIcon className="size-3.5" />}>
      <SettingsRow
        title="WORKFLOW.md path"
        description="Choose the project workflow file Symphony validates before polling Linear or starting work."
        status={
          workflowStatus ? (
            <span className="flex min-w-0 items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  "uppercase tracking-[0.06em]",
                  statusBadgeClassName(workflowStatus.status),
                )}
              >
                {workflowStatus.status}
              </Badge>
              <span className="truncate">{workflowStatus.message ?? settings?.workflowPath}</span>
            </span>
          ) : (
            "Not loaded"
          )
        }
      >
        <div className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row">
          <Input
            value={workflowPath}
            placeholder={defaultWorkflowPath(selectedProject)}
            disabled={isBusy}
            onChange={(event) => setWorkflowPath(event.currentTarget.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={isBusy}
            onClick={() => setWorkflowPath(defaultWorkflowPath(selectedProject))}
          >
            Default
          </Button>
          <Button
            size="xs"
            disabled={isBusy || workflowPath.trim().length === 0}
            onClick={() => runSettingsAction("save-workflow")}
          >
            {busyAction === "save-workflow" ? <Spinner className="size-3" /> : null}
            Save
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Validation"
        description="Create a starter workflow when needed, then validate the resolved file on the server."
        status={
          workflowStatus?.validatedAt ? (
            <span>Last validated {new Date(workflowStatus.validatedAt).toLocaleString()}</span>
          ) : (
            "Not validated yet"
          )
        }
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={isBusy}
              onClick={() => runSettingsAction("create-workflow")}
            >
              {busyAction === "create-workflow" ? <Spinner className="size-3" /> : null}
              Create starter
            </Button>
            <Button
              size="xs"
              disabled={isBusy}
              onClick={() => runSettingsAction("validate-workflow")}
            >
              {busyAction === "validate-workflow" ? (
                <Spinner className="size-3" />
              ) : (
                <RefreshCwIcon className="size-3" />
              )}
              Validate
            </Button>
          </>
        }
      />
      <SettingsRow
        title="Local Symphony runtime"
        description="Local issue runs use the dedicated Symphony policy, independent of the global chat default."
        status="GPT-5.5, high reasoning, full-access"
        control={<CpuIcon className="size-4 text-primary" aria-hidden />}
      />
    </SettingsSection>
  );
}
