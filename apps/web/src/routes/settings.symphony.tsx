import { createFileRoute } from "@tanstack/react-router";

import { SymphonySettingsPanel } from "../components/symphony/SymphonySettingsPanel";

export const Route = createFileRoute("/settings/symphony")({
  component: SymphonySettingsPanel,
});
