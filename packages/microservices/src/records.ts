/**
 * NestJS-compatible transport record builders for attaching broker-specific
 * headers, properties, QoS, or options alongside RPC payloads.
 */

export interface RmqRecordOptions {
  expiration?: string | number;
  userId?: string;
  CC?: string | string[];
  priority?: number;
  persistent?: boolean;
  deliveryMode?: boolean | number;
  mandatory?: boolean;
  BCC?: string | string[];
  contentType?: string;
  contentEncoding?: string;
  headers?: Record<string, unknown>;
  messageId?: string;
  timestamp?: number;
  type?: string;
  appId?: string;
}

export class RmqRecord<TData = any> {
  constructor(
    public readonly data: TData,
    public readonly options?: RmqRecordOptions,
  ) {}
}

export class RmqRecordBuilder<TData = any> {
  private options?: RmqRecordOptions;

  constructor(private data?: TData) {}

  setOptions(options: RmqRecordOptions): this {
    this.options = options;
    return this;
  }

  setData(data: TData): this {
    this.data = data;
    return this;
  }

  build(): RmqRecord<TData> {
    return new RmqRecord(this.data as TData, this.options);
  }
}

export class NatsRecord<TData = any, THeaders = Record<string, string>> {
  constructor(
    public readonly data: TData,
    public readonly headers?: THeaders,
  ) {}
}

export class NatsRecordBuilder<TData = any, THeaders = Record<string, string>> {
  private headers?: THeaders;

  constructor(private data?: TData) {}

  setHeaders(headers: THeaders): this {
    this.headers = headers;
    return this;
  }

  setData(data: TData): this {
    this.data = data;
    return this;
  }

  build(): NatsRecord<TData, THeaders> {
    return new NatsRecord(this.data as TData, this.headers);
  }
}

export interface MqttRecordOptions {
  qos?: 0 | 1 | 2;
  retain?: boolean;
  dup?: boolean;
  properties?: Record<string, unknown>;
}

export class MqttRecord<TData = any> {
  constructor(
    public readonly data: TData,
    public readonly options?: MqttRecordOptions,
  ) {}
}

export class MqttRecordBuilder<TData = any> {
  private options?: MqttRecordOptions;

  constructor(private data?: TData) {}

  setQoS(qos: 0 | 1 | 2): this {
    this.options = { ...this.options, qos };
    return this;
  }

  setDup(dup: boolean): this {
    this.options = { ...this.options, dup };
    return this;
  }

  setRetain(retain: boolean): this {
    this.options = { ...this.options, retain };
    return this;
  }

  setProperties(properties: Record<string, unknown>): this {
    this.options = { ...this.options, properties };
    return this;
  }

  setData(data: TData): this {
    this.data = data;
    return this;
  }

  build(): MqttRecord<TData> {
    return new MqttRecord(this.data as TData, this.options);
  }
}

export interface RedisRecordOptions {
  headers?: Record<string, string>;
}

export class RedisRecord<TData = any> {
  constructor(
    public readonly data: TData,
    public readonly options?: RedisRecordOptions,
  ) {}
}

export class RedisRecordBuilder<TData = any> {
  private options?: RedisRecordOptions;

  constructor(private data?: TData) {}

  setOptions(options: RedisRecordOptions): this {
    this.options = options;
    return this;
  }

  setData(data: TData): this {
    this.data = data;
    return this;
  }

  build(): RedisRecord<TData> {
    return new RedisRecord(this.data as TData, this.options);
  }
}
