export const limits = {
  messageBytes: 64 * 1024,
  requestBytes: 128 * 1024,
  pollOptions: 8,
  pollQuestionBytes: 256,
  pollOptionBytes: 128,
  retainedMessages: 1000,
} as const;

export function validText(value: unknown, maxBytes: number) {
  return typeof value === "string" && value.trim().length > 0 && new TextEncoder().encode(value.trim()).length <= maxBytes;
}