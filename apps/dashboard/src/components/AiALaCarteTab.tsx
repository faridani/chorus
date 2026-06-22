import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BackendInfo, type Project, type TerminalSessionInfo, type TerminalWorktree } from "../api.js";

export const AI_A_LA_CARTE_HELP =
  "**AI a la carte** — a hands-on terminal for this project. Pick any AI installed on this machine (Codex, Claude Code, Gemini, ...) and chat with it directly inside a worktree, or just run commands yourself. It's the AI *on the worktree*: it can read and edit the checked-out branch, run builds and tests, and start services from a chosen branch so you can try changes live. Use it to explore, debug, prototype, or pair with an agent in real time — separate from the autonomous ticket pipeline, with you in control of every command.";

type SessionMode = { backendId: string | null };

export function AiALaCarteTab({ project, backends }: { project: Project; backends: BackendInfo[] }) {
  const availableBackends = useMemo(() => backends.filter((b) => b.available), [backends]);
  const [worktrees, setWorktrees] = useState<TerminalWorktree[]>([]);
  const [worktreeId, setWorktreeId] = useState("base");
  const [backendId, setBackendId] = useState("");
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [status, setStatus] = useState("Loading worktrees...");
  const [busy, setBusy] = useState(false);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const modeRef = useRef<SessionMode | null>(null);

  useEffect(() => {
    if (!backendId || !availableBackends.some((b) => b.id === backendId)) {
      setBackendId(availableBackends[0]?.id ?? "");
    }
  }, [availableBackends, backendId]);

  useEffect(() => {
    let cancelled = false;
    setStatus("Loading worktrees...");
    api
      .terminalWorktrees(project.id)
      .then((rows) => {
        if (cancelled) return;
        setWorktrees(rows);
        setWorktreeId((current) => (rows.some((wt) => wt.id === current) ? current : rows[0]?.id ?? "base"));
        setStatus(rows.length ? "Ready." : "No worktrees available.");
      })
      .catch((err) => !cancelled && setStatus(String(err)));
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
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
    fit.fit();
    term.writeln("AI a la carte terminal ready.");
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
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
      dataSub.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      const token = activeTokenRef.current;
      activeTokenRef.current = null;
      wsRef.current?.close();
      if (token) void api.stopTerminalSession(project.id, token).catch(() => {});
    };
  }, [project.id]);

  async function stopCurrent(): Promise<void> {
    const token = activeTokenRef.current;
    activeTokenRef.current = null;
    modeRef.current = null;
    const ws = wsRef.current;
    wsRef.current = null;
    ws?.close();
    setSession(null);
    if (token) await api.stopTerminalSession(project.id, token).catch(() => {});
  }

  async function startSession(mode: SessionMode, nextWorktreeId = worktreeId): Promise<void> {
    setBusy(true);
    await stopCurrent();
    const term = termRef.current;
    const worktree = worktrees.find((wt) => wt.id === nextWorktreeId);
    term?.reset();
    term?.writeln(`Starting ${mode.backendId ? backendLabel(mode.backendId, availableBackends) : "shell"} in ${worktree?.label ?? nextWorktreeId}...`);
    try {
      const info = await api.createTerminalSession(project.id, {
        worktreeId: nextWorktreeId,
        backendId: mode.backendId,
      });
      const token = info.sessionToken;
      activeTokenRef.current = token;
      modeRef.current = mode;
      setSession(info);
      connectWebSocket(token);
      setStatus("Connecting terminal...");
    } catch (err) {
      term?.writeln(`\r\n${String(err)}`);
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  function connectWebSocket(token: string): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal/${encodeURIComponent(token)}`);
    wsRef.current = ws;
    ws.onopen = () => setStatus("Connected.");
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
        } else if (msg.type === "exit") {
          const reason = msg.outcome ?? msg.signal ?? msg.code ?? "closed";
          termRef.current?.writeln(`\r\n[session ended: ${reason}]`);
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
      modeRef.current = null;
      setStatus("Disconnected.");
    };
  }

  async function changeWorktree(next: string): Promise<void> {
    setWorktreeId(next);
    const mode = modeRef.current;
    if (mode) await startSession(mode, next);
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
        <label>
          <span>Intelligence</span>
          <select
            value={backendId}
            onChange={(e) => {
              const next = e.target.value;
              setBackendId(next);
              if (next && activeTokenRef.current) void startSession({ backendId: next });
            }}
            disabled={busy || availableBackends.length === 0}
          >
            {availableBackends.length === 0 && <option value="">No installed AI CLIs detected</option>}
            {availableBackends.map((backend) => (
              <option key={backend.id} value={backend.id}>
                {backend.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ai-term-actions">
          <button disabled={busy || worktrees.length === 0 || !backendId} onClick={() => void startSession({ backendId })}>
            Start AI
          </button>
          <button disabled={busy || worktrees.length === 0} onClick={() => void startSession({ backendId: null })}>
            Start shell
          </button>
          <button disabled={busy} onClick={() => void createScratchWorktree()}>
            New worktree
          </button>
          <button className="danger" disabled={!session && !activeTokenRef.current} onClick={() => void stopCurrent()}>
            Stop
          </button>
        </div>
      </div>

      <div className="ai-term-window">
        <div className="ai-term-header">
          <span className="ai-term-dot close" />
          <span className="ai-term-dot min" />
          <span className="ai-term-dot max" />
          <span className="ai-term-title">{session?.backendId ? backendLabel(session.backendId, availableBackends) : "Shell"}</span>
          <span className="ai-term-status">{status}</span>
        </div>
        <div ref={hostRef} className="ai-term-host" />
      </div>
    </div>
  );
}

function backendLabel(id: string, backends: BackendInfo[]): string {
  return backends.find((b) => b.id === id)?.label ?? id;
}
