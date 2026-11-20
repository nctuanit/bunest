export interface OnModuleInit {
  onModuleInit(): Promise<void> | void;
}

export interface OnApplicationBootstrap {
  onApplicationBootstrap(): Promise<void> | void;
}

export interface OnModuleDestroy {
  onModuleDestroy(): Promise<void> | void;
}

export interface BeforeApplicationShutdown {
  beforeApplicationShutdown(signal?: string): Promise<void> | void;
}

export interface OnApplicationShutdown {
  onApplicationShutdown(signal?: string): Promise<void> | void;
}

export interface OnRequestDestroy {
  onRequestDestroy(): Promise<void> | void;
}
