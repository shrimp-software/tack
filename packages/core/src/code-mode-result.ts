/** The code-mode downstream-call result, shared by runtime callers and generated SDKs. */
export const CODE_MODE_RESULT_TS = `type CodeModeResult<T> =
  | { ok: true; data: T; responseId: string | null; dataShape: unknown; upstreamOutcome: "succeeded" }
  | { ok: false; error: { code?: string; message: string }; responseId?: string | null; upstreamOutcome?: "not_started" | "succeeded" | "failed" | "unknown" };
`;
export type CodeModeResult<T> =
  | {
      ok: true;
      data: T;
      responseId: string | null;
      /** Compact type-only skeleton of `data` — inspect it before writing
       *  `data.x.y` paths, especially across `Promise.all` batches. */
      dataShape: unknown;
      upstreamOutcome: "succeeded";
    }
  | {
      ok: false;
      error: { code?: string; message: string };
      responseId?: string | null;
      upstreamOutcome?: "not_started" | "succeeded" | "failed" | "unknown";
    };
