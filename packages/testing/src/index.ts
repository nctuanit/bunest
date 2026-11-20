import "reflect-metadata";

export {
  ContextIdFactory,
  type ContextId,
  type InjectOptions,
  type InjectResponse,
  type MockFactory,
  type ModuleRefGetOptions,
} from "@bunest/core";
export { Test } from "./test";
export { TestingModuleBuilder } from "./testing-module.builder";
export { ScopedTestingModule, TestingModule } from "./testing-module";
export { CookieJar, TestAgent, TestClient, TestResponse } from "./test-client";
export {
  SupertestAgent,
  SupertestRequest,
  request,
  type AttachOptions,
  type SupertestExpectChecker,
  type SupertestFactory,
  type SupertestResponse,
  type SupertestTarget,
} from "./supertest-request";
export {
  parseSseJson,
  readSseEvents,
  type ReadSseEventsOptions,
  type SseEvent,
} from "./sse-helper";
export { createNodeHttpServer } from "./node-http-bridge";
export {
  TestingLogger,
  type TestingLoggerOptions,
} from "./loggers/testing-logger";
export {
  CapturingLogger,
  type CapturedLog,
  type CapturedLogEntry,
  type CapturedLogFilter,
  type CapturedLogMatcher,
  type CapturingLoggerFilterOptions,
  type CapturingLoggerOptions,
  type LogEntryMatcher,
} from "./loggers/capturing-logger";
export {
  ModuleMocker,
  createAutoMocker,
  createMockFn,
  type AutoMockerOptions,
  type MockCallResult,
  type MockFunction,
  type MockMetadata,
  type MockMetadataType,
} from "./mocker/module-mocker";
export {
  createMockCallHandler,
  createMockExecutionContext,
  createMockLogger,
  createMockProvider,
  createMockReflector,
  createMockRequest,
  createMockResponseContext,
  runWithMockRequestContext,
  type MockCallHandler,
  type MockExecutionContextOptions,
  type MockRequestOptions,
  type MockRpcContextOptions,
  type MockWsContextOptions,
} from "./fixtures";
export type {
  CreateTestingAppOptions,
  CreateTestingMicroserviceOptions,
  FetchCapable,
  OverrideBy,
  OverrideByEnhancer,
  OverrideByFactoryOptions,
  OverrideFactoryOptions,
  OverrideModule,
  QueryParamPrimitive,
  QueryParamValue,
  TestClientOptions,
  TestRequestOptions,
  TestRequestRedirect,
  TestingMicroserviceTarget,
  TestingModuleCompileOptions,
  TestingModuleOptions,
} from "./interfaces/testing.interface";
