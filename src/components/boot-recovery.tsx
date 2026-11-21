import { useEffect } from "react";
import { subscribeSecretsReady } from "@/lib/secret-store";
import { startupMarkOnce } from "@/lib/startup-trace";

/**
 * Critical startup recovery. Account-dependent providers are deliberately not
 * mounted until the secret store announces itself.
 */
export function BootRecovery({
  onContinue,
  onSplashReady,
}: {
  onContinue: () => void;
  onSplashReady: () => void;
}) {
  useEffect(() => {
    onSplashReady();
  }, [onSplashReady]);

  useEffect(
    () =>
      subscribeSecretsReady(() => {
        startupMarkOnce("boot.secrets.recovered");
        onContinue();
      }),
    [onContinue],
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-6 text-white">
      <div
        role="alert"
        className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl"
      >
        <h1 className="text-lg font-semibold">Harbor could not finish starting</h1>
        <p className="mt-2 text-sm leading-6 text-white/70">
          Your account data is still loading. Retry in a moment.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
        >
          Retry
        </button>
        <p className="mt-4 text-xs text-white/40">If this keeps happening, restart Harbor.</p>
      </div>
    </div>
  );
}
