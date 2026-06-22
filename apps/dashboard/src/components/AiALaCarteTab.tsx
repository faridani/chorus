import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api, type Project, type TerminalSessionInfo, type TerminalWorktree } from "../api.js";

export const AI_A_LA_CARTE_HELP =
  "**AI Shell** — a full terminal running on this machine, opened directly in the selected worktree of this project (like the Cockpit terminal). It's a real login shell with your full environment, so you can read and edit the checked-out branch, run builds, tests and services, use git, or launch any AI CLI yourself — entirely under your control and separate from the autonomous ticket pipeline. Switch the worktree to point the terminal at a different branch, or spin up a fresh scratch worktree.";

export function AiALaCarteTab({ project }: { project: Project }) {
  const [worktrees, setWorktrees] = useState<TerminalWorktree[]>([]);
  const [worktreeId, setWorktreeId] = useState("base");
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [status, setStatus] = useState("Starting terminal...");
  const [busy, setBusy] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const startGenRef = useRef(0);
  const resizeTimerRef = useRef<number | null>(null);

  function sendResize(): void {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN || !activeTokenRef.current) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  function scheduleResizeSend(): void {
    if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = window.setTimeout(() => {
      resizeTimerRef.current = null;
      sendResize();
    }, 80);
  }

  // Load this project's worktrees, then auto-start a shell in a valid one.
  // These are one effect (not two) so the session is created only AFTER the new
  // project's worktrees load: starting from a separate effect would use the
  // previous project's worktreeId on a project switch and the backend would
  // reject it with "unknown worktree". Teardown lives here too.
  useEffect(() => {
    let cancelled = false;
    api
      .terminalWorktrees(project.id)
      .then((rows) => {
        if (cancelled) return;
        setWorktrees(rows);
        const nextId = rows.some((wt) => wt.id === worktreeId) ? worktreeId : rows[0]?.id ?? "base";
        setWorktreeId(nextId);
        void startSession(nextId);
      })
      .catch((err) => !cancelled && setStatus(String(err)));
    return () => {
      cancelled = true;
      const token = activeTokenRef.current;
      activeTokenRef.current = null;
      // Invalidate any start still in flight so it stops the session it creates.
      startGenRef.current++;
      wsRef.current?.close();
      wsRef.current = null;
      if (token) void api.stopTerminalSession(project.id, token).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  // Build the xterm instance once. Refs (not the closure) carry the live
  // websocket/token, so this never needs to re-run on session changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10000,
      theme: {
        background: "#300a24",
        foreground: "#eeeeec",
        cursor: "#ffffff",
        selectionBackground: "#5e2750",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    // Cmd/Ctrl+C copies the selection (when there is one); otherwise it falls
    // through to the shell as a real interrupt. Paste works via the textarea.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        const selection = term.getSelection();
        if (selection) {
          void navigator.clipboard?.writeText(selection).catch(() => {});
          return false;
        }
      }
      return true;
    });
    try {
      fit.fit();
    } catch {
      /* host not measurable yet */
    }
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* terminal may be mid-dispose */
      }
    });
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const resizeSub = term.onResize(() => scheduleResizeSend());
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* terminal may be mid-dispose */
      }
    });
    ro.observe(host);
    termRef.current = term;
    fitRef.current = fit;
    return () => {
      cancelAnimationFrame(raf);
      if (resizeTimerRef.current !== null) window.clearTimeout(resizeTimerRef.current);
      dataSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  async function stopCurrent(): Promise<void> {
    const token = activeTokenRef.current;
    activeTokenRef.current = null;
    const ws = wsRef.current;
    wsRef.current = null;
    ws?.close();
    setSession(null);
    if (token) await api.stopTerminalSession(project.id, token).catch(() => {});
  }

  async function startSession(nextWorktreeId: string): Promise<void> {
    const gen = ++startGenRef.current;
    setBusy(true);
    await stopCurrent();
    if (startGenRef.current !== gen) return;
    const term = termRef.current;
    term?.reset();
    const worktree = worktrees.find((wt) => wt.id === nextWorktreeId);
    term?.writeln(`Starting shell in ${worktree?.label ?? nextWorktreeId}...`);
    try {
      const info = await api.createTerminalSession(project.id, {
        worktreeId: nextWorktreeId,
        backendId: null,
        cols: term?.cols ?? 80,
        rows: term?.rows ?? 24,
      });
      if (startGenRef.current !== gen) {
        // Superseded (e.g. StrictMode remount / rapid worktree switch): don't
        // leak the session we just created.
        void api.stopTerminalSession(project.id, info.sessionToken).catch(() => {});
        return;
      }
      activeTokenRef.current = info.sessionToken;
      setSession(info);
      connectWebSocket(info.sessionToken);
      setStatus("Connecting terminal...");
    } catch (err) {
      if (startGenRef.current !== gen) return;
      term?.writeln(`\r\n${String(err)}`);
      setStatus(String(err));
    } finally {
      if (startGenRef.current === gen) setBusy(false);
    }
  }

  function connectWebSocket(token: string): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("Connected.");
    ws.onerror = () => {
      if (activeTokenRef.current === token) setStatus("Terminal connection error.");
    };
    ws.onmessage = (ev) => {
      if (activeTokenRef.current !== token) return;
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          data?: string;
          error?: string;
          outcome?: string;
          code?: number | null;
          signal?: string | null;
        };
        if (msg.type === "data" && typeof msg.data === "string") {
          termRef.current?.write(msg.data);
        } else if (msg.type === "ready") {
          setStatus("Connected.");
          // Re-sync size in case the pane changed between create and spawn.
          sendResize();
        } else if (msg.type === "exit") {
          const reason = msg.outcome ?? msg.signal ?? msg.code ?? "closed";
          termRef.current?.writeln(`\r\n[session ended: ${reason}] — press Restart to start a new shell.`);
          setStatus(`Session ended: ${reason}`);
        } else if (msg.type === "error") {
          termRef.current?.writeln(`\r\n[terminal error] ${msg.error ?? "unknown error"}`);
          setStatus(msg.error ?? "Terminal error");
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (activeTokenRef.current !== token) return;
      activeTokenRef.current = null;
      wsRef.current = null;
      setSession(null);
      setStatus("Disconnected.");
    };
  }

  async function changeWorktree(next: string): Promise<void> {
    setWorktreeId(next);
    await startSession(next);
  }

  async function createScratchWorktree(): Promise<void> {
    setBusy(true);
    try {
      const wt = await api.createTerminalWorktree(project.id);
      setWorktrees((rows) => [...rows.filter((row) => row.id !== wt.id), wt]);
      await changeWorktree(wt.id);
      setStatus(`Created ${wt.branch}.`);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  const activeLabel = worktrees.find((wt) => wt.id === worktreeId)?.label ?? "Shell";

  return (
    <div className="ai-term">
      <div className="ai-term-toolbar">
        <label>
          <span>Worktree</span>
          <select value={worktreeId} onChange={(e) => void changeWorktree(e.target.value)} disabled={busy}>
            {worktrees.map((wt) => (
              <option key={wt.id} value={wt.id}>
                {wt.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ai-term-actions">
          <button disabled={busy} onClick={() => void startSession(worktreeId)}>
            Restart
          </button>
          <button disabled={busy} onClick={() => void createScratchWorktree()}>
            New worktree
          </button>
          <button className="danger" disabled={busy || !session} onClick={() => void stopCurrent()}>
            Stop
          </button>
        </div>
      </div>

      <div className="ai-term-window">
        <div className="ai-term-header">
          <span className="ai-term-dot close" />
          <span className="ai-term-dot min" />
          <span className="ai-term-dot max" />
          <span className="ai-term-title">{activeLabel}</span>
          <span className="ai-term-status">{status}</span>
        </div>
        <div ref={hostRef} className="ai-term-host" />
      </div>
    </div>
  );
}
