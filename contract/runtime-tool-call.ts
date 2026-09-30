// Normalized tool lifecycle shared by native session adapters.
export interface RuntimeToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  inputText: string;
  outputText: string;
  /** true ⇒ `inputText` was cut at the 64 KiB preview bound (pi-transcript-events FR-4). */
  inputTruncated: boolean;
  /** true ⇒ `outputText` was cut at the 64 KiB preview bound (pi-transcript-events FR-4). */
  outputTruncated: boolean;
  startedAt?: number;
  completedAt?: number;
}
