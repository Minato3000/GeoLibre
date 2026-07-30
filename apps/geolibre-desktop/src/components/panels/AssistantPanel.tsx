import { useAppStore } from "@geoint/core";
import type { MapController } from "@geoint/map";
import { Button, Textarea, cn } from "@geoint/ui";
import { AlertCircle, Eraser, Loader2, Send, Sparkles, Square, X } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { renderAssistantMarkdown } from "../../lib/assistant/markdown";
import { AssistantSession } from "../../lib/assistant/session";
// Paired with MapCanvas so it suspends pointer interaction while dragging.
import { PANEL_RESIZE_END_EVENT, PANEL_RESIZE_START_EVENT } from "../../lib/panel-resize";

const DEFAULT_PANEL_WIDTH = 360;
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 640;

/** One rendered line in the conversation transcript. */
interface Turn {
  /** Stable, monotonic id — used as the React key and to target updates. */
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
}

interface AssistantPanelProps {
  mapControllerRef: RefObject<MapController | null>;
}

/**
 * The natural-language assistant: a right-docked chat panel. Sending a
 * message exercises the full conversation flow (history, loading state,
 * error display) against a placeholder session that doesn't yet talk to a
 * real model backend — see `../../lib/assistant/session.ts`. Rendered only
 * while open.
 *
 * @param mapControllerRef - Live map controller, unused by the placeholder
 * session today but kept as a prop so a future tool-calling backend can use it.
 */
export function AssistantPanel({ mapControllerRef: _mapControllerRef }: AssistantPanelProps) {
  const { t } = useTranslation();
  const setAssistantOpen = useAppStore((s) => s.setAssistantOpen);

  const sectionRef = useRef<HTMLElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Session-local prompt history. `null` means the user is editing a fresh
  // draft; otherwise it is the recalled entry's index.
  const promptHistoryRef = useRef<string[]>([]);
  const promptHistoryIndexRef = useRef<number | null>(null);
  const promptDraftRef = useRef("");
  // Guards a synchronous double-submit before `running` re-renders.
  const runningRef = useRef(false);
  // Generation that was stopped (0 = none), so a stopped run's rejection isn't
  // shown as an error even after a newer send has started.
  const cancelledGenerationRef = useRef(0);
  // Monotonic id source for transcript turns (stable React keys + update target).
  const turnIdRef = useRef(0);
  // Identifies the current send so a stopped run's cleanup can't reset the
  // running state of a newer send started right after Stop.
  const sendGenerationRef = useRef(0);
  // Tears down an in-flight drag's window listeners if the panel unmounts
  // mid-drag (e.g. the user closes it while dragging).
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);

  // One session per mounted panel; conversation history lives inside it.
  const sessionRef = useRef<AssistantSession | null>(null);
  sessionRef.current ??= new AssistantSession();
  const session = sessionRef.current;

  // Tear down any in-flight run on unmount.
  useEffect(() => () => session.cancel(), [session]);

  // On unmount mid-drag, tear down the drag's window listeners.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // Keep the latest turn in view.
  useEffect(() => {
    if (turns.length === 0) return;
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || runningRef.current) return;
    const history = promptHistoryRef.current;
    if (history.at(-1) !== prompt) history.push(prompt);
    promptHistoryIndexRef.current = null;
    promptDraftRef.current = "";
    runningRef.current = true;
    const myGeneration = (sendGenerationRef.current += 1);
    setRunning(true);
    setInput("");
    // Turns are tracked by stable id (not array index), so updaters stay pure —
    // safe under React Strict Mode / concurrent re-invocation — and a stale
    // generator from a stopped/cleared run can no longer corrupt a new one.
    const userId = (turnIdRef.current += 1);
    const assistantId = (turnIdRef.current += 1);
    setTurns((prev) => [
      ...prev,
      { id: userId, role: "user", text: prompt },
      { id: assistantId, role: "assistant", text: "" },
    ]);

    try {
      for await (const event of session.stream(prompt)) {
        setTurns((prev) =>
          prev.map((turn) =>
            turn.id === assistantId ? { ...turn, text: turn.text + event.text } : turn,
          ),
        );
      }
    } catch (error) {
      // A user-initiated stop rejects the stream; that isn't an error to show.
      // Compare against myGeneration so a newer send can't unmask this older
      // run's cancellation as a failure.
      if (cancelledGenerationRef.current !== myGeneration) {
        const message = error instanceof Error ? error.message : String(error);
        const errorId = (turnIdRef.current += 1);
        setTurns((prev) => [...prev, { id: errorId, role: "error", text: message }]);
      }
    } finally {
      // Drop the assistant turn if it never produced text (e.g. an errored run).
      setTurns((prev) =>
        prev.filter(
          (turn) => !(turn.id === assistantId && turn.role === "assistant" && !turn.text),
        ),
      );
      // Only clear the running state if no newer send has superseded this one
      // (e.g. the user stopped and immediately sent again).
      if (sendGenerationRef.current === myGeneration) {
        runningRef.current = false;
        setRunning(false);
      }
    }
  };

  const stop = () => {
    cancelledGenerationRef.current = sendGenerationRef.current;
    session.cancel();
    runningRef.current = false;
    setRunning(false);
  };

  // Clear the transcript and the session's conversation history (so the next
  // message starts fresh), stopping any in-flight run first.
  const clearConversation = () => {
    stop();
    setTurns([]);
    session.reset();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
      return;
    }

    if (
      (event.key !== "ArrowUp" && event.key !== "ArrowDown") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }

    const history = promptHistoryRef.current;
    if (history.length === 0) return;

    // The arrows still move the caret inside a draft: recall only from a
    // collapsed caret at the very start (Up) or very end (Down). A textarea
    // soft-wraps long text into several visual lines with no newline of its
    // own, so counting newlines would recall while the caret is still inside
    // the draft; the absolute edges are the only unambiguous test.
    const { selectionStart, selectionEnd, value } = event.currentTarget;
    if (selectionStart !== selectionEnd) return;
    if (event.key === "ArrowUp" && selectionStart !== 0) return;
    if (event.key === "ArrowDown" && selectionEnd !== value.length) return;

    const currentIndex = promptHistoryIndexRef.current;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (currentIndex === null) {
        promptDraftRef.current = input;
        promptHistoryIndexRef.current = history.length - 1;
      } else {
        promptHistoryIndexRef.current = Math.max(0, currentIndex - 1);
      }
      setInput(history[promptHistoryIndexRef.current]);
      return;
    }

    if (currentIndex === null) return;
    event.preventDefault();
    if (currentIndex < history.length - 1) {
      promptHistoryIndexRef.current = currentIndex + 1;
      setInput(history[currentIndex + 1]);
    } else {
      promptHistoryIndexRef.current = null;
      setInput(promptDraftRef.current);
    }
  };

  // Drag the left edge to resize the panel width (the panel docks on the
  // right, so dragging left widens it). Mirrors the Python Console's former
  // height-resize: writes are throttled to one DOM mutation per frame and
  // committed to state on mouseup, and the panel-resize events let MapCanvas
  // pause pointer handling.
  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width;
    let nextWidth = startWidth;
    let frame: number | null = null;
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.dispatchEvent(new Event(PANEL_RESIZE_START_EVENT));

    const onMove = (moveEvent: MouseEvent) => {
      const available = Math.max(MIN_PANEL_WIDTH, window.innerWidth - 300);
      const maxWidth = Math.min(MAX_PANEL_WIDTH, available);
      nextWidth = Math.min(
        maxWidth,
        Math.max(MIN_PANEL_WIDTH, startWidth + startX - moveEvent.clientX),
      );
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (sectionRef.current) {
          sectionRef.current.style.width = `${nextWidth}px`;
        }
      });
    };

    const finish = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", finish);
      resizeCleanupRef.current = null;
      if (frame !== null) window.cancelAnimationFrame(frame);
      setWidth(nextWidth);
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", finish);
    resizeCleanupRef.current = finish;
  };

  return (
    <section
      ref={sectionRef}
      aria-label={t("assistant.title")}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-s bg-card"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("assistant.resize")}
        className="absolute -start-1 top-0 bottom-0 z-20 w-2 cursor-col-resize select-none border-s border-transparent hover:border-primary"
        onMouseDown={startResize}
      />
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">{t("assistant.title")}</span>
        {running ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("assistant.thinking")}
          </span>
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("assistant.clear")}
            onClick={clearConversation}
          >
            <Eraser className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t("assistant.close")}
            onClick={() => setAssistantOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div
        ref={outputRef}
        className="flex-1 space-y-2 overflow-auto px-3 py-2 text-sm leading-relaxed"
      >
        {turns.length === 0 ? (
          <p className="text-muted-foreground">{t("assistant.intro")}</p>
        ) : (
          turns.map((turn) => {
            if (turn.role === "error") {
              return (
                <p key={turn.id} className="flex items-start gap-1.5 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{turn.text}</span>
                </p>
              );
            }
            if (turn.role === "user") {
              return (
                <div key={turn.id} className="whitespace-pre-wrap font-medium text-foreground">
                  {`❯ ${turn.text}`}
                </div>
              );
            }
            // Assistant replies are markdown — render (and sanitize) them.
            return (
              <div
                key={turn.id}
                className={cn(
                  "text-foreground",
                  "[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-5",
                  "[&_ol]:my-1 [&_ol]:list-decimal [&_ol]:ps-5",
                  "[&_a]:text-primary [&_a]:underline",
                  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
                  "[&_pre]:my-1 [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-2",
                  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                )}
                dangerouslySetInnerHTML={{
                  __html: renderAssistantMarkdown(turn.text),
                }}
              />
            );
          })
        )}
      </div>

      <div className="flex items-end gap-2 border-t px-3 py-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (promptHistoryIndexRef.current === null) {
              promptDraftRef.current = event.target.value;
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={t("assistant.placeholder")}
          spellCheck
          rows={2}
          className="min-h-[2.5rem] flex-1 resize-none text-sm"
        />
        {running ? (
          <Button size="sm" variant="outline" onClick={stop} title={t("assistant.stop")}>
            <Square className="me-1 h-4 w-4" />
            {t("assistant.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={!input.trim()}
            title={t("assistant.sendHint")}
          >
            <Send className="me-1 h-4 w-4" />
            {t("assistant.send")}
          </Button>
        )}
      </div>
    </section>
  );
}
