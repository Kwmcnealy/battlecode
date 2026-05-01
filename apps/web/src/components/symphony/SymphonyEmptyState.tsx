import { WorkflowIcon } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";

export function SymphonyEmptyState() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia>
          <WorkflowIcon className="size-6" />
        </EmptyMedia>
        <EmptyTitle>No issues queued</EmptyTitle>
        <EmptyDescription>
          Start or refresh Symphony after workflow and Linear setup are complete.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
