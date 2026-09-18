// contract/pi-runtime-boundary.ts — canonical imports for the Pi runtime boundary.
// The vocabulary itself belongs in common.ts so all feature contracts share one
// runtime axis; this file deliberately defines no duplicate shapes.

export type {
  AgentRuntime,
  AppError,
  CapabilityState,
  ErrorCode,
  ProviderProtocol,
  RuntimeCapabilities,
  RuntimeCapability,
  RuntimeEventEnvelope,
  RuntimeEventPayload,
  RuntimeFailure,
  RuntimeModelRef,
  SessionEvent,
  SessionMeta,
} from './common';
