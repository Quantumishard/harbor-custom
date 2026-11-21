import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { useSettings } from "@/lib/settings";
import { Dropdown } from "@/components/dropdown";
import { useT } from "@/lib/i18n";
import { SettingRow, ROW_ACTION_PRIMARY, ROW_ACTION_DANGER } from "./kit";
import {
  MOONSHINE_LANGUAGES,
  isMoonshineLanguage,
  type MoonshineLanguage,
  type MoonshineModelStatus,
} from "@/lib/subtitles/autosync/moonshine-models";

const languageOptions = MOONSHINE_LANGUAGES.map(([value, label]) => ({ value, label }));

export function MoonshineModelRow() {
  const t = useT();
  const { settings, update } = useSettings();
  const selectedPreference = settings.subtitleMoonshineLanguage || "auto";
  const [manageLanguage, setManageLanguage] = useState<MoonshineLanguage>(
    isMoonshineLanguage(selectedPreference) ? selectedPreference : "en",
  );
  const [statusSnapshot, setStatusSnapshot] = useState<{
    language: MoonshineLanguage;
    revision: number;
    value: MoonshineModelStatus;
  } | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const [busy, setBusy] = useState<"runtime" | "download" | "remove" | null>(null);
  const [errorSnapshot, setErrorSnapshot] = useState<{
    language: MoonshineLanguage;
    message: string;
  } | null>(null);
  const status =
    statusSnapshot?.language === manageLanguage && statusSnapshot.revision === statusRevision
      ? statusSnapshot.value
      : null;
  const error = errorSnapshot?.language === manageLanguage ? errorSnapshot.message : null;

  useEffect(() => {
    if (isMoonshineLanguage(selectedPreference)) setManageLanguage(selectedPreference);
  }, [selectedPreference]);

  useEffect(() => {
    setErrorSnapshot(null);
  }, [manageLanguage]);

  useEffect(() => {
    let active = true;
    void invoke<MoonshineModelStatus>("moonshine_model_status", { language: manageLanguage })
      .then((result) => {
        if (active)
          setStatusSnapshot({
            language: manageLanguage,
            revision: statusRevision,
            value: result,
          });
      })
      .catch((reason) => {
        if (active) setErrorSnapshot({ language: manageLanguage, message: String(reason) });
      });
    return () => {
      active = false;
    };
  }, [manageLanguage, statusRevision]);

  async function perform(mode: "runtime" | "download" | "remove") {
    if (busy) return;
    const operationLanguage = manageLanguage;
    setBusy(mode);
    setErrorSnapshot(null);
    try {
      if (mode === "runtime") {
        await invoke("moonshine_runtime_install");
      } else {
        await invoke(mode === "download" ? "moonshine_model_download" : "moonshine_model_remove", {
          language: operationLanguage,
        });
      }
    } catch (cause) {
      setErrorSnapshot({ language: operationLanguage, message: String(cause) });
    } finally {
      setBusy(null);
      // Always re-query the currently managed language. An earlier operation
      // must not publish its previous language's installed state into this row.
      setStatusRevision((revision) => revision + 1);
    }
  }

  let modelStatus = t("Checking Moonshine…");
  if (status?.supported === false) {
    modelStatus = t(
      "The experimental runtime needs Python 3. Native runtime bundling is not yet available in this build.",
    );
  } else if (status?.runtimeInstalled) {
    modelStatus = status.installed
      ? t("Language model installed")
      : t("Language model not installed");
  } else if (status) {
    modelStatus = "";
  }

  return (
    <>
      <SettingRow
        label={t("Moonshine language")}
        desc={t(
          "Automatic uses the currently selected audio track. It never guesses from subtitles or downloads a model without approval. Override this if an audio track has incorrect language metadata.",
        )}
      >
        <Dropdown
          className="w-56 max-w-full"
          value={selectedPreference}
          onChange={(value) => update({ subtitleMoonshineLanguage: value })}
          disabled={busy !== null}
          ariaLabel={t("Moonshine language selection")}
          options={[{ value: "auto", label: t("Automatic (audio track)") }, ...languageOptions]}
        />
      </SettingRow>
      <SettingRow
        label={t("Manage Moonshine models")}
        desc={
          <span className="flex flex-col items-start gap-2">
            <span>
              {t(
                "Download only the languages you want. Models remain installed between playback sessions; switching languages does not trigger a download. Silero works without Moonshine models.",
              )}
            </span>
            <span
              role="status"
              hidden={!modelStatus}
              className={status?.installed ? "font-medium text-success" : undefined}
            >
              {modelStatus}
            </span>
            {error && (
              <span role="alert" className="text-danger">
                {t("Moonshine operation failed")}: {error}
              </span>
            )}
          </span>
        }
      >
        <Dropdown
          className="w-56 max-w-full"
          value={manageLanguage}
          onChange={(value) => {
            if (isMoonshineLanguage(value)) setManageLanguage(value);
          }}
          disabled={busy !== null}
          ariaLabel={t("Language model to manage")}
          options={languageOptions}
        />
        {status?.supported &&
          (!status.runtimeInstalled ? (
            <button
              type="button"
              disabled={busy !== null}
              aria-busy={busy === "runtime"}
              onClick={() => void perform("runtime")}
              className={ROW_ACTION_PRIMARY}
            >
              {busy === "runtime" ? t("Installing…") : t("Install Moonshine test runtime")}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              aria-busy={busy === "download" || busy === "remove"}
              onClick={() => void perform(status.installed ? "remove" : "download")}
              className={status.installed ? ROW_ACTION_DANGER : ROW_ACTION_PRIMARY}
            >
              {busy === "download"
                ? t("Downloading…")
                : busy === "remove"
                  ? t("Removing…")
                  : status.installed
                    ? t("Remove model")
                    : t("Download language model")}
            </button>
          ))}
      </SettingRow>
    </>
  );
}
