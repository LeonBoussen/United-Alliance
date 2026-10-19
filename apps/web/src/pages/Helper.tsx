import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";
import { ChatPanel } from "../components/ChatPanel";
import { NeedsYou } from "../components/NeedsYou";

/**
 * The Overseer's helper (DESIGN §5d): you tell it how to handle things; when the
 * Overseer is stuck it asks the helper first, and the helper only asks you what your
 * guidance doesn't cover.
 */
export function Helper() {
  const threads = useStore((s) => s.threads);
  const guidance = useStore((s) => s.guidance);
  const [draft, setDraft] = useState("");
  const now = useNow();

  const thread = useMemo(() => Object.values(threads).find((t) => t.kind === "operator_helper"), [threads]);
  const items = useMemo(() => Object.values(guidance).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [guidance]);

  return (
    <div className="page page-fill three-col helper-layout">
      <section className="card chat-card">
        <header className="chat-head">
          <span className="avatar helper">H</span>
          <div>
            <div className="chat-title">Helper</div>
            <div className="chat-subtitle">
              Speaks for you when you're away. The Overseer asks it first when stuck; it asks you only what your guidance doesn't cover.
            </div>
          </div>
        </header>
        {thread ? (
          <ChatPanel
            threadId={thread.id}
            placeholder="Tell the helper how to handle things, or what to tell the Overseer…"
            onSend={(content, answersMessageId) => realtime.send("message.send", { threadId: thread.id, content, ...(answersMessageId ? { answersMessageId } : {}) })}
          />
        ) : (
          <div className="empty">Connecting to the helper…</div>
        )}
      </section>

      <aside className="stack context-col">
        <NeedsYou />
        <section className="card pad">
          <h3 className="section-title">Your guidance {items.length > 0 && <span className="chip-count">{items.length}</span>}</h3>
          <p className="muted small">Standing instructions the helper follows when it answers for you. It also saves what you tell it in the chat.</p>
          <ul className="guidance-list">
            {items.map((g) => (
              <li key={g.id}>
                <span>{g.content}</span>
                <span className="muted small">{relativeTime(g.createdAt, now)}</span>
                <button className="icon-btn" aria-label="Remove guidance" title="Remove" onClick={() => realtime.send("guidance.remove", { id: g.id })}>
                  <X size={13} />
                </button>
              </li>
            ))}
            {items.length === 0 && <li className="empty small">None yet. Example: “Never spend more than 500k tokens on one task without asking me.”</li>}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) realtime.send("guidance.add", { content: draft.trim() });
              setDraft("");
            }}
          >
            <input className="input" placeholder="Add an instruction…" value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button className="btn" disabled={!draft.trim()} aria-label="Add guidance"><Plus size={14} /></button>
          </form>
        </section>
      </aside>
    </div>
  );
}
