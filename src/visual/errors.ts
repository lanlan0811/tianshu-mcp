export type VisualErrorKind = "blocked" | "failed" | "cancelled";

export class VisualError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly kind: VisualErrorKind = "blocked",
  ) {
    super(message);
    this.name = "VisualError";
  }
}

export function visualError(error: unknown): VisualError {
  if (error instanceof VisualError) return error;
  return new VisualError("VISUAL_INTERNAL", error instanceof Error ? error.message : String(error));
}
