import { scopeProjectRef } from "@t3tools/client-runtime";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { SidebarInset } from "../components/ui/sidebar";
import { SymphonyPanel } from "../components/symphony/SymphonyPanel";
import { selectProjectByRef, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";

function ProjectSymphonyRouteView() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const project = useStore((state) =>
    selectProjectByRef(state, scopeProjectRef(environmentId, projectId)),
  );

  if (!project) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <SymphonyPanel
        environmentId={environmentId}
        projectId={project.id}
        projectName={project.name}
        projectCwd={project.cwd}
        onOpenThread={(threadId) => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams({ environmentId, threadId }),
          });
        }}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/project/$projectId/symphony")({
  component: ProjectSymphonyRouteView,
});
