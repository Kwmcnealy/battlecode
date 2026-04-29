import type { AuthSessionState } from "@t3tools/contracts";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PairingPendingSurface() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-0 bg-[url('/brand/battletcg/battle-tcg-banner.webp')] bg-cover bg-center opacity-18" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_92%,transparent)_0%,var(--background)_68%)]" />
      </div>

      <section className="relative w-full max-w-xl border border-border bg-card/90 p-6 shadow-[var(--glow-featured)] sm:p-8">
        <span className="pointer-events-none absolute -left-px -top-px size-3 border-l-2 border-t-2 border-primary" />
        <span className="pointer-events-none absolute -bottom-px -right-px size-3 border-b-2 border-r-2 border-info" />
        <p className="text-[11px] font-semibold tracking-[0.18em] text-primary uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[0.08em] uppercase sm:text-3xl">
          Pairing with this environment
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Validating the pairing link and preparing your session.
        </p>
      </section>
    </div>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      await submitCredential(credential);
    },
    [submitCredential, credential],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-0 bg-[url('/brand/battletcg/battle-tcg-banner.webp')] bg-cover bg-center opacity-18" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_92%,transparent)_0%,var(--background)_68%)]" />
      </div>

      <section className="relative w-full max-w-xl border border-border bg-card/90 p-6 shadow-[var(--glow-featured)] sm:p-8">
        <span className="pointer-events-none absolute -left-px -top-px size-3 border-l-2 border-t-2 border-primary" />
        <span className="pointer-events-none absolute -bottom-px -right-px size-3 border-b-2 border-r-2 border-info" />
        <p className="text-[11px] font-semibold tracking-[0.18em] text-primary uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[0.08em] uppercase sm:text-3xl">
          Pair with this environment
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {describeAuthGate(auth.bootstrapMethods)}
        </p>

        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label
              className="text-sm font-medium tracking-[0.08em] uppercase"
              htmlFor="pairing-token"
            >
              Pairing token
            </label>
            <Input
              id="pairing-token"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) => setCredential(event.currentTarget.value)}
              placeholder="Paste a one-time token or pairing secret"
              spellCheck={false}
              value={credential}
            />
          </div>

          {errorMessage ? (
            <div className="border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? "Pairing..." : "Continue"}
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => window.location.reload()}
              size="sm"
              variant="outline"
            >
              Reload app
            </Button>
          </div>
        </form>

        <div className="mt-6 border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          {describeSupportedMethods(auth.bootstrapMethods)}
        </div>
      </section>
    </div>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
