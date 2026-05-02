import { WorkflowIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SettingsPageContainer } from "../settings/settingsLayout";

export function SymphonySettingsEmptyState() {
  return (
    <SettingsPageContainer>
      <div className="flex min-h-80 items-center justify-center border border-border/80 bg-card">
        <Empty>
          <EmptyHeader>
            <EmptyMedia>
              <WorkflowIcon className="size-6" />
            </EmptyMedia>
            <EmptyTitle>No active projects</EmptyTitle>
            <EmptyDescription>
              Open a project in Battle.Code before configuring Symphony.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </SettingsPageContainer>
  );
}
