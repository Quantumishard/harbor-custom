import { gameVideoSearchUrl } from "./video-search";
import type { QuickGame } from "./quick-library";
import { launcherDispatchId } from "./launchers";

export type LibraryAction =
  | "play"
  | "favorite"
  | "pin"
  | "details"
  | "browse"
  | "properties"
  | "desktop"
  | "hide"
  | "uninstall"
  | "remove"
  | "gameplay"
  | "trailer"
  | "notes";
export type UninstallRoute = "steam" | "launcher" | "windows";

export function uninstallRoute(
  game: QuickGame,
  native: boolean,
  windows: boolean,
): UninstallRoute | null {
  if (!native) return null;
  if (game.source === "steam") return game.install.update !== "uninstalling" ? "steam" : null;
  if (game.source === "launcher") return game.install.state === "installed" ? "launcher" : null;
  if (windows && (game.source === "custom" || game.source === "shortcut")) return "windows";
  return null;
}

/** A catalog Steam alias never grants permission to manage a different local copy. */
export function managementCommand(game: QuickGame, action: "browse" | "properties" | "uninstall") {
  if (game.source === "steam")
    return { command: "games_manage_steam", args: { appId: game.install.appId, action } };
  if (game.source === "launcher" && action !== "properties")
    return {
      command: "games_manage_launcher",
      args: {
        id: launcherDispatchId(game.install),
        action: action === "uninstall" ? "client" : "browse",
      },
    };
  return null;
}

/** Reveal the observed executable/ROM, never parse or execute launch arguments. */
export function managementFile(game: QuickGame): string | null {
  const value =
    game.source === "custom"
      ? game.custom.config.executable
      : game.source === "retro"
        ? game.local.path
        : game.source === "shortcut"
          ? game.shortcut.executable.replace(/^"(.*)"$/, "$1")
          : "";
  return /^(?:[a-z]:[\\/]|\/)/i.test(value) && !/[\x00-\x1f]/.test(value) ? value : null;
}

export function canOpenGameFolder(game: QuickGame): boolean {
  if (game.source === "steam") return game.install.state !== "missing";
  if (game.source === "launcher") return game.install.state === "installed";
  return managementFile(game) !== null;
}

export async function openGameFolder(game: QuickGame): Promise<void> {
  if (!canOpenGameFolder(game)) throw Error("game_changed");
  const command = managementCommand(game, "browse");
  if (command) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(command.command, command.args);
    return;
  }
  const path = managementFile(game);
  if (!path) throw Error("game_changed");
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export function libraryMenuActions(
  game: QuickGame,
  native: boolean,
  windows: boolean,
): { main: LibraryAction[]; manage: LibraryAction[] } {
  const main: LibraryAction[] = [
    ...(native && game.ready ? ["play" as const] : []),
    "favorite",
    "pin",
    "details",
    ...(native && canOpenGameFolder(game) ? ["browse" as const] : []),
    "notes",
  ];
  if (gameVideoSearchUrl(game.name, "gameplay")) main.push("gameplay", "trailer");
  const manage: LibraryAction[] = [];
  if (game.source === "custom" || game.source === "shortcut" || (native && game.source === "steam"))
    manage.push("properties");
  if (native && windows && game.source === "custom" && game.ready) manage.push("desktop");
  manage.push("hide");
  if (uninstallRoute(game, native, windows)) manage.push("uninstall");
  if (game.source === "custom") manage.push("remove");
  return { main, manage };
}

export function menuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return {
    left: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    top: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}
