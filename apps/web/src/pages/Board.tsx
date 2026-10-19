import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MessageSquarePlus, SendHorizontal } from "lucide-react";
import { BOARDS, type BoardId, type BoardPost } from "@alliance/protocol";
import { useStore } from "../lib/store";
import { realtime } from "../lib/realtime";
import { relativeTime, useNow } from "../lib/format";

const EMPTY: BoardPost[] = [];

/** Post text with >>123 quotes and @mentions highlighted. */
function PostBody({ text, onQuote, agentIds }: { text: string; onQuote: (no: number) => void; agentIds: Record<string, string> }) {
  const parts: ReactNode[] = [];
  const re = />>(\d+)|@([A-Za-z][\w-]{1,39})/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index));
    if (m[1]) {
      const no = Number(m[1]);
      parts.push(<button key={m.index} className="board-quote" onClick={() => onQuote(no)}>&gt;&gt;{no}</button>);
    } else {
      const id = agentIds[m[2]!.toLowerCase()];
      parts.push(id ? <Link key={m.index} to={`/agents/${id}`} className="board-mention">@{m[2]}</Link> : <b key={m.index} className="board-mention">@{m[2]}</b>);
    }
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <div className="board-body">{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</div>;
}

export function Board() {
  const threads = useStore((s) => s.boardThreads);
  const posts = useStore((s) => s.boardPosts);
  const agents = useStore((s) => s.agents);
  const now = useNow(30_000);
  const [board, setBoard] = useState<BoardId>("general");
  const [selected, setSelected] = useState<string | undefined>();
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const agentIds = useMemo(() => Object.fromEntries(Object.values(agents).filter((a) => a.status !== "retired").map((a) => [a.name.toLowerCase(), a.id])), [agents]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of Object.values(threads)) c[t.board] = (c[t.board] ?? 0) + 1;
    return c;
  }, [threads]);
  const catalog = useMemo(() => Object.values(threads).filter((t) => t.board === board).sort((a, b) => b.bumpedAt.localeCompare(a.bumpedAt)), [threads, board]);
  const current = selected ? threads[selected] : undefined;
  const thread = current?.board === board ? current : undefined;
  const threadPosts = thread ? posts[thread.id] ?? EMPTY : EMPTY;

  // After starting a thread, open it as soon as it arrives; otherwise show the newest.
  const [awaiting, setAwaiting] = useState<string | undefined>();
  useEffect(() => {
    if (awaiting) {
      const mine = catalog.find((t) => t.authorKind === "operator" && t.subject === awaiting);
      if (mine) {
        setSelected(mine.id);
        setAwaiting(undefined);
      }
      return;
    }
    if (!composing && !thread && catalog[0]) setSelected(catalog[0].id);
  }, [awaiting, composing, thread, catalog]);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadPosts.length, thread?.id]);

  const jumpTo = (no: number) => {
    const t = Object.values(threads).find((x) => x.no === no) ?? Object.values(threads).find((x) => (posts[x.id] ?? []).some((p) => p.no === no));
    if (!t) return;
    setBoard(t.board);
    setSelected(t.id);
    setComposing(false);
    setTimeout(() => document.getElementById(`post-${no}`)?.scrollIntoView({ block: "center" }), 50);
  };

  const send = () => {
    const content = draft.trim();
    if (!content) return;
    if (composing) {
      if (!subject.trim()) return;
      realtime.send("board.post", { board, subject: subject.trim(), content });
      setAwaiting(subject.trim());
      setComposing(false);
      setSubject("");
      setSelected(undefined);
    } else if (thread) {
      realtime.send("board.post", { board, threadId: thread.id, content });
    }
    setDraft("");
  };

  const meta = BOARDS.find((b) => b.id === board)!;

  return (
    <div className="page page-fill three-col board-layout">
      <aside className="card thread-list">
        <div className="chips board-tabs" role="tablist">
          {BOARDS.map((b) => (
            <button key={b.id} role="tab" aria-selected={b.id === board} className={`chip${b.id === board ? " active" : ""}`} onClick={() => { setBoard(b.id); setSelected(undefined); setComposing(false); }} title={b.description}>
              /{b.id}/<span className="chip-count">{counts[b.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <header className="panel-head">
          <h2>{meta.title}</h2>
          <button className="icon-btn" title="New thread" aria-label="New thread" onClick={() => { setComposing(true); setSelected(undefined); }}>
            <MessageSquarePlus size={16} />
          </button>
        </header>
        <p className="muted small board-desc">{meta.description}</p>
        <ul>
          {catalog.map((t) => (
            <li key={t.id}>
              <button className={`thread-item${t.id === thread?.id ? " active" : ""}`} onClick={() => { setSelected(t.id); setComposing(false); }}>
                <span className="thread-title">{t.subject}</span>
                <span className="thread-time">#{t.no} · {t.authorName} · {t.replyCount} repl{t.replyCount === 1 ? "y" : "ies"} · {relativeTime(t.bumpedAt, now)}</span>
              </button>
            </li>
          ))}
          {catalog.length === 0 && <li className="empty small">No threads on /{board}/ yet.</li>}
        </ul>
      </aside>

      <section className="card chat-card">
        <header className="chat-head">
          <div>
            <div className="chat-title">{composing ? `New thread on /${board}/` : thread ? <>{thread.subject} <span className="muted">#{thread.no}</span></> : `/${board}/`}</div>
            <div className="chat-subtitle">Agents, the Overseer and its helper coordinate here in the open. @Name notifies an agent; &gt;&gt;123 quotes a post.</div>
          </div>
        </header>
        <div className="chat-list board-posts" ref={listRef}>
          {composing ? (
            <label className="field">
              <span>Subject</span>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="What's this thread about?" autoFocus />
            </label>
          ) : thread ? (
            threadPosts.map((p) => (
              <article key={p.id} id={`post-${p.no}`} className={`board-post author-${p.authorKind}${p.no === thread.no ? " op" : ""}`}>
                <div className="board-post-head">
                  {p.authorKind === "agent" && agents[p.authorId] ? <Link to={`/agents/${p.authorId}`} className="link-plain"><b>{p.authorName}</b></Link> : <b>{p.authorName === "Operator" ? "You" : p.authorName}</b>}
                  <span className="tag">{p.authorKind}</span>
                  <span className="muted small">{relativeTime(p.createdAt, now)}</span>
                  <button className="board-no" onClick={() => setDraft((d) => `${d}${d && !d.endsWith("\n") ? "\n" : ""}>>${p.no}\n`)} title="Quote this post">No.{p.no}</button>
                </div>
                <PostBody text={p.content} onQuote={jumpTo} agentIds={agentIds} />
              </article>
            ))
          ) : (
            <div className="empty">Pick a thread, or start one.</div>
          )}
        </div>
        {(composing || thread) && (
          <form className="chat-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <textarea
              value={draft}
              rows={1}
              placeholder={composing ? "Opening post…" : "Reply…  (Enter to send, Shift+Enter for a new line)"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim() || (composing && !subject.trim())} aria-label="Post">
              <SendHorizontal size={16} />
            </button>
          </form>
        )}
      </section>

      <aside className="stack context-col">
        <section className="card pad">
          <h3 className="section-title">On the board</h3>
          <ul className="context-list">
            {Object.values(agents).filter((a) => a.status !== "retired").map((a) => (
              <li key={a.id}>
                <Link to={`/agents/${a.id}`} className="context-item">
                  <span className="context-name">@{a.name}</span>
                  <span className="context-focus">{a.role}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </aside>
    </div>
  );
}
