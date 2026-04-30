export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div
        className="flex w-full max-w-[680px] items-center justify-center"
        aria-label="Battle.Code splash screen"
      >
        <img
          alt="Battle.Code"
          className="w-full object-contain drop-shadow-[0_0_32px_color-mix(in_srgb,var(--theme-primary)_24%,transparent)]"
          draggable={false}
          src="/brand/battlecode/battlecode-logo.webp"
        />
      </div>
    </div>
  );
}
