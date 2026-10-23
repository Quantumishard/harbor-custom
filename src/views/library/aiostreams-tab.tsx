import { ChevronLeft, Folder, LoaderCircle, Play, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import aioLogo from "@/assets/addon-logos/aiostreams.png";
import {
  aioDesktopAvailable,
  beginAioBrowserLogin,
  cancelAioBrowserLogin,
  finishAioBrowserLogin,
  aioFiles,
  aioFileSelector,
  connectAio,
  currentAioConnection,
  restoreAioConnection,
  disconnectAio,
  listAio,
  playAio,
  type AioConnection,
  type AioEntry,
  type AioFile,
} from "@/lib/aiostreams-library";
import { useView } from "@/lib/view";
import { isWindowsDesktop } from "@/lib/platform";

const field = "rounded-xl bg-elevated px-4 py-3 text-ink outline-none";
const button = "rounded-full bg-elevated px-4 py-2 text-sm text-ink disabled:opacity-40";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const size = (value?: number) => (value ? `${(value / 1024 ** 3).toFixed(2)} GB` : "");
const INSTANCE_KEY = "harbor.aiostreams.instance-url.v1";

function savedInstance() {
  try {
    return localStorage.getItem(INSTANCE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberInstance(url: string) {
  try {
    localStorage.setItem(INSTANCE_KEY, url);
  } catch {
    /* The connection also works without saved preferences. */
  }
}

export function AiostreamsTab() {
  const { openPlayer } = useView();
  const [connection, setConnection] = useState<AioConnection | null>(currentAioConnection);
  const [baseUrl, setBaseUrl] = useState(savedInstance);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [remember, setRemember] = useState(isWindowsDesktop);
  const [restoringSession, setRestoringSession] = useState(
    () => aioDesktopAvailable() && !currentAioConnection(),
  );
  const [loginId, setLoginId] = useState<string | null>(null);
  const pendingLogin = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [order, setOrder] = useState("desc");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [entries, setEntries] = useState<AioEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<AioEntry | null>(null);
  const [files, setFiles] = useState<AioFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      if (pendingLogin.current) void cancelAioBrowserLogin(pendingLogin.current).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!aioDesktopAvailable() || currentAioConnection()) {
      setRestoringSession(false);
      return;
    }
    let cancelled = false;
    void restoreAioConnection()
      .then((next) => {
        if (!cancelled && next) {
          setConnection(next);
          setBaseUrl(next.baseUrl);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setRestoringSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setEntries([]);
    void listAio(connection, { offset, query: search, status, sort: "added", direction: order })
      .then((page) => {
        if (!cancelled) {
          setEntries(page.entries);
          setTotal(page.total);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, offset, search, status, order, revision]);

  const login = async (event: FormEvent) => {
    event.preventDefault();
    setConnecting(true);
    setError("");
    try {
      const next = await connectAio(baseUrl, username, password, remember);
      if (pendingLogin.current) {
        await cancelAioBrowserLogin(pendingLogin.current).catch(() => {});
        pendingLogin.current = null;
        setLoginId(null);
      }
      if (mounted.current) {
        setConnection(next);
        setOffset(0);
        setPassword("");
        rememberInstance(next.baseUrl);
      } else await disconnectAio(next);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) {
        setConnecting(false);
        setPassword("");
      }
    }
  };

  const browserLogin = async () => {
    setConnecting(true);
    setError("");
    try {
      if (pendingLogin.current) await cancelAioBrowserLogin(pendingLogin.current);
      const id = await beginAioBrowserLogin(baseUrl);
      if (!mounted.current) {
        await cancelAioBrowserLogin(id);
        return;
      }
      pendingLogin.current = id;
      setLoginId(id);
      rememberInstance(baseUrl.trim());
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  const finishLogin = async () => {
    if (!loginId) return;
    setConnecting(true);
    setError("");
    try {
      const next = await finishAioBrowserLogin(loginId, remember);
      pendingLogin.current = null;
      if (!mounted.current) {
        await disconnectAio(next);
        return;
      }
      setLoginId(null);
      setConnection(next);
      setOffset(0);
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setConnecting(false);
    }
  };

  const disconnect = async () => {
    generation.current++;
    setConnection(null);
    setSelected(null);
    setFiles([]);
    setEntries([]);
    setTotal(0);
    setOpening(false);
    setPlaying(null);
    setError("");
    try {
      await disconnectAio();
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    }
  };

  const browse = async (entry: AioEntry) => {
    if (!connection) return;
    const id = ++generation.current;
    setSelected(entry);
    setFiles([]);
    setOpening(true);
    setError("");
    setPlaying(null);
    try {
      const next = await aioFiles(connection, entry.nzbHash);
      if (id === generation.current && mounted.current) setFiles(next);
    } catch (cause) {
      if (id === generation.current && mounted.current) setError(message(cause));
    } finally {
      if (id === generation.current && mounted.current) setOpening(false);
    }
  };

  const play = async (file: AioFile) => {
    if (!connection || !selected) return;
    const id = ++generation.current;
    setPlaying(aioFileSelector(file));
    setError("");
    try {
      const stream = await playAio(connection, selected.nzbHash, file);
      if (id !== generation.current || !mounted.current) return;
      openPlayer({
        meta: {
          id: `aiostreams:${new URL(connection.baseUrl).host}:${selected.nzbHash}:${encodeURIComponent(aioFileSelector(file)!)}`,
          type: "movie",
          name: stream.filename || file.name || selected.name || "Usenet video",
        },
        url: stream.url,
        title: stream.filename || file.name || selected.name || "Usenet video",
        subtitle: `AIOStreams · ${selected.name || "Usenet library"}`,
        notWebReady: true,
        resume: true,
        suppressCloudSync: true,
      });
    } catch (cause) {
      if (id === generation.current && mounted.current) setError(message(cause));
    } finally {
      if (id === generation.current && mounted.current) setPlaying(null);
    }
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {selected && (
          <button
            type="button"
            aria-label="Back to AIOStreams library"
            className={button}
            onClick={() => {
              generation.current++;
              setSelected(null);
              setFiles([]);
              setOpening(false);
              setPlaying(null);
              setError("");
            }}
          >
            <ChevronLeft size={18} />
          </button>
        )}
        <img src={aioLogo} alt="" className="h-8 w-8 rounded-lg object-contain" />
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold text-ink">
          {selected?.name || "AIOStreams Usenet library"}
        </h2>
        {connection && (
          <>
            <button
              type="button"
              aria-label="Refresh AIOStreams library"
              disabled={loading || opening}
              className={button}
              onClick={() => (selected ? void browse(selected) : setRevision((v) => v + 1))}
            >
              <RefreshCw size={17} className={loading || opening ? "animate-spin" : ""} />
            </button>
            <button type="button" className={button} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-red-500/10 p-4 text-red-300">
          {error}
        </p>
      )}
      {connection?.warning && (
        <p role="alert" className="rounded-xl bg-amber-500/10 p-4 text-amber-200">
          {connection.warning}
        </p>
      )}
      {!aioDesktopAvailable() ? (
        <p className="text-ink-muted">
          Open Harbor’s desktop app to connect your AIOStreams dashboard.
        </p>
      ) : restoringSession ? (
        <p role="status" className="text-ink-muted">
          Reconnecting to your saved AIOStreams instance…
        </p>
      ) : !connection ? (
        <form
          onSubmit={(event) => void login(event)}
          className="flex max-w-xl flex-col gap-3 rounded-2xl bg-elevated/40 p-6"
        >
          <p className="text-sm text-ink-muted">
            Open the sign-in window, complete your hosting login and AIOStreams dashboard login,
            then return here to connect. Harbor can remember your session without saving your
            password.
          </p>
          <label className="flex flex-col gap-2 text-sm text-ink">
            Instance URL
            <input
              required
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-aiostreams.elfhosted.cafe/"
              autoComplete="url"
              className={field}
              disabled={connecting || loginId !== null}
            />
          </label>
          {isWindowsDesktop() && (
            <label className="flex items-center gap-3 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={remember}
                disabled={connecting}
                onChange={(event) => setRemember(event.target.checked)}
              />
              Remember sign-in on this Windows account
            </label>
          )}
          <button
            type="button"
            disabled={connecting || !baseUrl.trim()}
            onClick={() => void browserLogin()}
            className="rounded-full bg-ink px-5 py-3 text-canvas disabled:opacity-40"
          >
            {connecting ? "Connecting…" : loginId ? "Reopen sign-in window" : "Open sign-in window"}
          </button>
          {loginId && (
            <button
              type="button"
              disabled={connecting}
              onClick={() => void finishLogin()}
              className={button}
            >
              I’m signed in — connect library
            </button>
          )}
          {loginId && (
            <button
              type="button"
              disabled={connecting}
              className={button}
              onClick={() => {
                void cancelAioBrowserLogin(loginId).catch(() => {});
                pendingLogin.current = null;
                setLoginId(null);
              }}
            >
              Cancel sign-in
            </button>
          )}
          <details className="text-sm text-ink-muted">
            <summary>Direct login for instances without a hosting sign-in</summary>
            <label className="mt-3 flex flex-col gap-2 text-sm text-ink">
              Dashboard username
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                className={field}
                disabled={connecting}
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-ink">
              Dashboard password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                className={field}
                disabled={connecting}
              />
            </label>
            <button
              type="submit"
              disabled={connecting}
              className="mt-2 rounded-full bg-ink px-5 py-3 text-canvas disabled:opacity-40"
            >
              {connecting ? "Connecting…" : "Connect AIOStreams"}
            </button>
          </details>
        </form>
      ) : (
        <>
          {!selected && (
            <>
              <input
                type="search"
                aria-label="Search AIOStreams library"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search imported NZBs"
                className={field}
              />
              <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted">
                <label>
                  Status{" "}
                  <select
                    aria-label="Filter AIOStreams library by status"
                    value={status}
                    onChange={(e) => {
                      setStatus(e.target.value);
                      setOffset(0);
                    }}
                    className={field}
                  >
                    <option value="all">All statuses</option>
                    <option value="available">Available</option>
                    <option value="degraded">Degraded</option>
                    <option value="failed">Failed</option>
                    <option value="queued">Queued</option>
                    <option value="inspecting">Inspecting</option>
                  </select>
                </label>
                <label>
                  Date added{" "}
                  <select
                    aria-label="Sort AIOStreams library by date added"
                    value={order}
                    onChange={(e) => {
                      setOrder(e.target.value);
                      setOffset(0);
                    }}
                    className={field}
                  >
                    <option value="desc">Newest first</option>
                    <option value="asc">Oldest first</option>
                  </select>
                </label>
                <span>{total} imported releases</span>
              </div>
            </>
          )}
          {(selected ? opening : loading) && (
            <p role="status" className="flex items-center gap-2 text-ink-muted">
              <LoaderCircle size={18} className="animate-spin" />
              Loading AIOStreams…
            </p>
          )}
          {selected ? (
            <>
              {selected.status === "degraded" && (
                <p className="text-sm text-amber-300">
                  This release has missing segments. Playback may contain gaps or fail.
                </p>
              )}
              {!opening && !error && !files.length && (
                <p className="text-ink-muted">
                  No playable video files are available in this release.
                </p>
              )}
              {files.map((file) => (
                <button
                  type="button"
                  key={aioFileSelector(file)}
                  disabled={
                    playing !== null ||
                    !["available", "degraded", "streaming"].includes(selected.status)
                  }
                  onClick={() => void play(file)}
                  className="flex items-center gap-4 rounded-xl bg-elevated/40 px-4 py-3 text-left text-ink hover:bg-elevated disabled:opacity-40"
                >
                  {playing === aioFileSelector(file) ? (
                    <LoaderCircle size={20} className="shrink-0 animate-spin" />
                  ) : (
                    <Play size={20} className="shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 break-all">
                    {file.name || file.path || `File ${file.index}`}
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{size(file.size)}</span>
                </button>
              ))}
            </>
          ) : (
            <>
              {!loading && !error && !entries.length && (
                <p className="py-10 text-center text-ink-muted">
                  No imported NZBs match these filters.
                </p>
              )}
              {entries.map((entry) => (
                <button
                  type="button"
                  key={entry.nzbHash}
                  onClick={() => void browse(entry)}
                  className="flex items-center gap-4 rounded-xl bg-elevated/40 px-4 py-3 text-left text-ink hover:bg-elevated"
                >
                  <Folder size={20} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{entry.name || entry.nzbHash}</span>
                    <span className="text-xs text-ink-muted">
                      {entry.status} ·{" "}
                      {entry.addedAt ? new Date(entry.addedAt).toLocaleDateString() : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-muted">{size(entry.size)}</span>
                </button>
              ))}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={loading || offset === 0}
                  className={button}
                  onClick={() => setOffset((v) => Math.max(0, v - 50))}
                >
                  Previous
                </button>
                <span className="text-sm text-ink-muted">Page {Math.floor(offset / 50) + 1}</span>
                <button
                  type="button"
                  disabled={loading || offset + 50 >= total}
                  className={button}
                  onClick={() => setOffset((v) => v + 50)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
