/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OVERSEER_URL?: string;
  /** "1" = mock backend, "0" = real overseer; unset = mock unless VITE_OVERSEER_URL is set. */
  readonly VITE_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
