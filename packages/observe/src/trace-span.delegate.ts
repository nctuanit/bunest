export class TraceSpanDelegate {
  private readonly _id: string;
  private readonly _name: string | undefined;
  private readonly _tags: Record<string, string | number | boolean>;

  get id(): string {
    return this._id;
  }

  get name(): string | undefined {
    return this._name;
  }

  constructor(
    _id: string,
    _name: string | undefined,
    _tags: Record<string, string | number | boolean>,
  ) {
    this._id = _id;
    this._name = _name;
    this._tags = _tags;
  }

  setTag(
    key: string,
    value: string | number | boolean,
  ): TraceSpanDelegate {
    this._tags[key] = value;
    return this;
  }

  addTags(
    tags: Record<string, string | number | boolean>,
  ): TraceSpanDelegate {
    Object.assign(this._tags, tags);
    return this;
  }
}
