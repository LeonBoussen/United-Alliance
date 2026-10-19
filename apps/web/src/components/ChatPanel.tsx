import { useEffect, useRef, useState, type ReactNode } from "react";
import { CornerDownRight, Lightbulb, SendHorizontal, X } from "lucide-react";
import type { Message } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { relativeTime, useNow } from "../lib/format";
import { Countdown } from "./Countdown";

const EMPTY: Message[] = [];

export interface ChatPanelProps {
  threadId: string;
  /** Called with the text and, when answering a question/escalation, its message id. */
  onSend: (content: string, answersMessageId?: string) => void;
  placeholder?: string;
  sendLabel?: ReactNode;
  /** Rendered above the composer (e.g. thought-window status). */
  banner?: ReactNode;
}

function isOpenQuestion(m: Message) {
  return (m.kind === "question" || m.kind === "escalation") && !m.resolved;
}

export function ChatPanel({ threadId, onSend, placeholder, sendLabel, banner }: ChatPanelProps) {
  const messages = useStore((s) => s.messages[threadId] ?? EMPTY);
  const agents = useStore((s) => s.agents);
  const [draft, setDraft] = useState("");
  const [answering, setAnswering] = useState<Message | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const now = useNow(15_000);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Drop the answer target once it's resolved (e.g. the overseer answered on timeout).
  useEffect(() => {
    if (answering && messages.find((m) => m.id === answering.id)?.resolved) setAnswering(null);
  }, [messages, answering]);

  const author = (m: Message) =>
    m.role === "operator" ? "You" : m.role === "overseer" ? "Overseer" : m.role === "helper" ? "Helper" : m.role === "system" ? "System" : (agents[m.authorId]?.name ?? m.authorId);

  const send = () => {
    const content = draft.trim();
    if (!content) return;
    onSend(content, answering?.id);
    setDraft("");
    setAnswering(null);
  };

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && <div className="empty">No messages yet.</div>}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg role-${m.role} kind-${m.kind ?? "chat"}${isOpenQuestion(m) ? " open" : ""}`}>
            {m.role !== "operator" && <span className={`avatar sm${m.role === "overseer" ? " overseer" : m.role === "helper" ? " helper" : ""}`}>{author(m).slice(0, 1)}</span>}
            <div className="chat-bubble-wrap">
              <div className="chat-meta">
                <b>{author(m)}</b>
                {m.kind === "thought" && <span className="tag tag-thought"><Lightbulb size={11} /> thought</span>}
                {m.kind === "reply" && <span className="tag">reply to you</span>}
                {m.kind === "question" && <span className="tag tag-question">question for you</span>}
                {m.kind === "escalation" && <span className="tag tag-question">needs your decision</span>}
                <span>{relativeTime(m.createdAt, now)}</span>
              </div>
              <div className="chat-bubble">
                {m.content}
                {m.partial && <span className="caret" aria-hidden />}
              </div>
              {(m.kind === "question" || m.kind === "escalation") && (
                <div className="chat-question-foot">
                  {m.resolved ? (
                    <span className="muted">Answered{m.answeredBy ? ` by ${m.answeredBy === "operator" ? "you" : "the Overseer"}` : ""}</span>
                  ) : (
                    <>
                      {m.answerDeadline && (
                        <span className="muted">
                          Overseer answers in <Countdown until={m.answerDeadline} />
                        </span>
                      )}
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          setAnswering(m);
                          inputRef.current?.focus();
                        }}
                      >
                        <CornerDownRight size={13} /> Answer
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {banner}
      {answering && (
        <div className="chat-answering">
          <CornerDownRight size={13} />
          <span>Answering {author(answering)}: “{answering.content.slice(0, 80)}{answering.content.length > 80 ? "…" : ""}”</span>
          <button className="icon-btn" aria-label="Cancel answer" onClick={() => setAnswering(null)}>
            <X size={13} />
          </button>
        </div>
      )}
      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={1}
          placeholder={placeholder ?? "Message…  (Enter to send, Shift+Enter for a new line)"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="submit" className="btn btn-primary" disabled={!draft.trim()} aria-label="Send">
          {sendLabel ?? <SendHorizontal size={16} />}
        </button>
      </form>
    </div>
  );
}
