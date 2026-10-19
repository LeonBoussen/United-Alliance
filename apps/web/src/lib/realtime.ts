import type { OverseerToUi, Topic, UiCommand, UiPayload, UiToOverseer } from "@alliance/protocol";
import { envelope } from "./envelope";
import { store } from "./store";
import { MockBackend } from "./mock";

export interface Realtime {
  readonly isMock: boolean;
  start(): void;
  send<T extends UiCommand>(type: T, payload: UiPayload<T>): void;
  /** Demo only: build zips are generated in the browser instead of downloaded. */
  buildZip?(buildId: string): { filename: string; data: Uint8Array } | undefined;
}

const ALL_TOPICS: Topic[] = ["events", "metrics", "fleet", "tasks"];

/** Live connection to the overseer's console channel (/ws/ui). */
class WsRealtime implements Realtime {
  readonly isMock = false;
  private ws?: WebSocket;
  private retry = 0;
  private queue: UiToOverseer[] = [];

  constructor(private readonly origin: string) {}

  start() {
    store.setConnection("connecting");
    const url = this.origin.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/ui";
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      store.setConnection("live");
      const { lastSeq } = store.getState();
      this.raw(envelope("subscribe", { topics: ALL_TOPICS, ...(lastSeq ? { sinceSeq: lastSeq } : {}) }));
      for (const msg of this.queue.splice(0)) this.raw(msg);
    };
    ws.onmessage = (e) => {
      try {
        store.apply(JSON.parse(String(e.data)) as OverseerToUi);
      } catch (err) {
        console.error("Bad message from overseer", err);
      }
    };
    ws.onclose = () => {
      store.setConnection("offline");
      const delay = Math.min(30_000, 500 * 2 ** this.retry++) * (0.75 + Math.random() * 0.5);
      setTimeout(() => this.start(), delay);
    };
  }

  send<T extends UiCommand>(type: T, payload: UiPayload<T>) {
    const msg = envelope(type, payload) as UiToOverseer;
    if (this.ws?.readyState === WebSocket.OPEN) this.raw(msg);
    else this.queue.push(msg);
  }

  private raw(msg: UiToOverseer) {
    this.ws?.send(JSON.stringify(msg));
  }
}

/** In-browser fake overseer so the console can be developed without a backend. */
class MockRealtime implements Realtime {
  readonly isMock = true;
  private backend = new MockBackend((msg) => store.apply(msg));

  buildZip(buildId: string) {
    return this.backend.buildZip(buildId);
  }

  start() {
    store.setConnection("mock");
    this.backend.start();
    this.send("subscribe", { topics: ALL_TOPICS });
  }

  send<T extends UiCommand>(type: T, payload: UiPayload<T>) {
    this.backend.handle(envelope(type, payload) as UiToOverseer);
  }
}

// VITE_MOCK=1 forces the mock backend, VITE_MOCK=0 forces a real overseer (same origin via
// the Vite proxy unless VITE_OVERSEER_URL is set). Unset: mock unless an overseer URL is given.
const origin = import.meta.env.VITE_OVERSEER_URL;
const mode = import.meta.env.VITE_MOCK;
const useMock = mode === "1" || (mode !== "0" && !origin);
export const realtime: Realtime = useMock ? new MockRealtime() : new WsRealtime(origin || window.location.origin);
