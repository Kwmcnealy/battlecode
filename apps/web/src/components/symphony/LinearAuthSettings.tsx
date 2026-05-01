import { CheckCircle2Icon, KeyRoundIcon, ShieldAlertIcon } from "lucide-react";
import type { SymphonySecretStatus } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { linearBadgeClassName, type SymphonySettingsBusyAction } from "./symphonySettingsDisplay";

export function LinearAuthSettings({
  linearStatus,
  linearKey,
  busyAction,
  setLinearKey,
  runSettingsAction,
}: {
  linearStatus: SymphonySecretStatus | null;
  linearKey: string;
  busyAction: SymphonySettingsBusyAction | null;
  setLinearKey: (key: string) => void;
  runSettingsAction: (action: Exclude<SymphonySettingsBusyAction, "load">) => void;
}) {
  const isBusy = busyAction !== null;

  return (
    <SettingsSection title="Linear Auth" icon={<KeyRoundIcon className="size-3.5" />}>
      <SettingsRow
        title="API key"
        description="Paste a Linear API key once. Battle.Code stores it server-side and only returns setup status."
        status={
          linearStatus ? (
            <span className="flex min-w-0 items-center gap-2">
              {linearStatus.configured ? (
                <CheckCircle2Icon className="size-3.5 text-success" />
              ) : (
                <ShieldAlertIcon className="size-3.5 text-warning" />
              )}
              <Badge
                variant="outline"
                className={cn("uppercase tracking-[0.06em]", linearBadgeClassName(linearStatus))}
              >
                {linearStatus.configured ? linearStatus.source : "missing"}
              </Badge>
              <span className="truncate">
                {linearStatus.lastError ?? "Secret value is never shown."}
              </span>
            </span>
          ) : (
            "Not loaded"
          )
        }
      >
        <div className="mt-3 flex flex-col gap-2 pb-4 sm:flex-row">
          <Input
            type="password"
            value={linearKey}
            placeholder="Linear API key"
            disabled={isBusy}
            autoComplete="off"
            onChange={(event) => setLinearKey(event.currentTarget.value)}
          />
          <Button
            size="xs"
            disabled={isBusy || linearKey.trim().length === 0}
            onClick={() => runSettingsAction("set-key")}
          >
            {busyAction === "set-key" ? <Spinner className="size-3" /> : null}
            {linearStatus?.configured ? "Rotate" : "Save"}
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Connection"
        description="Verify or remove the configured Linear credential without exposing the token to the browser."
        status={
          linearStatus?.lastTestedAt ? (
            <span>Last tested {new Date(linearStatus.lastTestedAt).toLocaleString()}</span>
          ) : (
            "Not tested yet"
          )
        }
        control={
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={isBusy || linearStatus?.configured !== true}
              onClick={() => runSettingsAction("test-key")}
            >
              {busyAction === "test-key" ? <Spinner className="size-3" /> : null}
              Test connection
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={isBusy || linearStatus?.configured !== true}
              onClick={() => runSettingsAction("delete-key")}
            >
              {busyAction === "delete-key" ? <Spinner className="size-3" /> : null}
              Delete key
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
