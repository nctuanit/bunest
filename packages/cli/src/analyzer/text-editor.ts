interface Chunk {
  start: number;
  end: number;
  original: string;
  content: string;
  intro: string;
  outro: string;
  edited: boolean;
  previous: Chunk | null;
  next: Chunk | null;
}

export interface TextEditorOverwriteOptions {
  readonly contentOnly?: boolean;
}

/**
 * Zero-dependency surgical text editor with exact chunk-splitting semantics
 * (drop-in replacement for `magic-string` used by Bunest codemods, delombok,
 * and Quick Fixes).
 */
export class TextEditor {
  readonly original: string;
  private intro = "";
  private outro = "";
  private firstChunk: Chunk | null = null;
  private lastChunk: Chunk | null = null;
  private lastSearchedChunk: Chunk | null = null;
  private readonly byStart = new Map<number, Chunk>();
  private readonly byEnd = new Map<number, Chunk>();

  constructor(source: string) {
    this.original = source;
    if (source.length > 0) {
      const chunk: Chunk = {
        start: 0,
        end: source.length,
        original: source,
        content: source,
        intro: "",
        outro: "",
        edited: false,
        previous: null,
        next: null,
      };
      this.firstChunk = chunk;
      this.lastChunk = chunk;
      this.lastSearchedChunk = chunk;
      this.byStart.set(0, chunk);
      this.byEnd.set(source.length, chunk);
    }
  }

  private resolveIndex(index: number): number {
    const len = this.original.length;
    const resolved = index < 0 ? len + index : index;
    if (resolved < 0 || resolved > len) {
      throw new RangeError(
        `Index ${index} is out of bounds for string of length ${len}`,
      );
    }
    return resolved;
  }

  private splitAt(index: number): void {
    if (!this.firstChunk || index <= 0 || index >= this.original.length) {
      return;
    }
    if (this.byStart.has(index) || this.byEnd.has(index)) {
      return;
    }

    let chunk = this.lastSearchedChunk ?? this.firstChunk;
    const searchForward = index > chunk.start;
    while (chunk) {
      if (chunk.start < index && index < chunk.end) {
        if (chunk.edited) {
          throw new Error("Cannot split a chunk that has already been edited");
        }
        const splitOffset = index - chunk.start;
        const leftOrig = chunk.original.slice(0, splitOffset);
        const rightOrig = chunk.original.slice(splitOffset);

        const rightChunk: Chunk = {
          start: index,
          end: chunk.end,
          original: rightOrig,
          content: rightOrig,
          intro: "",
          outro: chunk.outro,
          edited: false,
          previous: chunk,
          next: chunk.next,
        };

        if (chunk.next) {
          chunk.next.previous = rightChunk;
        } else {
          this.lastChunk = rightChunk;
        }

        chunk.end = index;
        chunk.original = leftOrig;
        chunk.content = leftOrig;
        chunk.outro = "";
        chunk.next = rightChunk;

        this.byEnd.set(index, chunk);
        this.byStart.set(index, rightChunk);
        this.byEnd.set(rightChunk.end, rightChunk);
        this.lastSearchedChunk = rightChunk;
        return;
      }
      const next = searchForward ? chunk.next : chunk.previous;
      if (!next) break;
      chunk = next;
    }
  }

  prepend(content: string): this {
    this.intro = content + this.intro;
    return this;
  }

  append(content: string): this {
    this.outro += content;
    return this;
  }

  appendLeft(index: number, content: string): this {
    const idx = this.resolveIndex(index);
    this.splitAt(idx);
    const chunk = this.byEnd.get(idx);
    if (chunk) {
      chunk.outro += content;
    } else {
      this.intro += content;
    }
    return this;
  }

  prependLeft(index: number, content: string): this {
    const idx = this.resolveIndex(index);
    this.splitAt(idx);
    const chunk = this.byEnd.get(idx);
    if (chunk) {
      chunk.outro = content + chunk.outro;
    } else {
      this.intro = content + this.intro;
    }
    return this;
  }

  appendRight(index: number, content: string): this {
    const idx = this.resolveIndex(index);
    this.splitAt(idx);
    const chunk = this.byStart.get(idx);
    if (chunk) {
      chunk.intro += content;
    } else {
      this.outro += content;
    }
    return this;
  }

  prependRight(index: number, content: string): this {
    const idx = this.resolveIndex(index);
    this.splitAt(idx);
    const chunk = this.byStart.get(idx);
    if (chunk) {
      chunk.intro = content + chunk.intro;
    } else {
      this.outro = content + this.outro;
    }
    return this;
  }

  overwrite(
    start: number,
    end: number,
    content: string,
    options?: TextEditorOverwriteOptions,
  ): this {
    const s = this.resolveIndex(start);
    const e = this.resolveIndex(end);
    if (s === e) {
      throw new Error(
        "Cannot overwrite a zero-length range – use appendLeft or prependRight instead",
      );
    }
    if (s > e) {
      throw new Error("end must be greater than start");
    }

    this.splitAt(s);
    this.splitAt(e);

    const first = this.byStart.get(s);
    if (!first) {
      throw new Error(`No chunk found at start offset ${s}`);
    }

    const contentOnly = options?.contentOnly === true;
    if (!contentOnly) {
      first.intro = "";
      first.outro = "";
    }
    first.content = content;
    first.edited = true;
    this.lastSearchedChunk = first;

    let current = first.next;
    while (current && current.start < e) {
      if (!contentOnly) {
        current.intro = "";
        current.outro = "";
      }
      current.content = "";
      current.edited = true;
      current = current.next;
    }

    return this;
  }

  remove(start: number, end: number): this {
    const s = this.resolveIndex(start);
    const e = this.resolveIndex(end);
    if (s === e) return this;
    if (s > e) {
      throw new Error("end must be greater than start");
    }

    this.splitAt(s);
    this.splitAt(e);

    let current: Chunk | null | undefined = this.byStart.get(s);
    if (current) {
      this.lastSearchedChunk = current;
    }
    while (current && current.start < e) {
      current.intro = "";
      current.content = "";
      current.outro = "";
      current.edited = true;
      current = current.next;
    }

    return this;
  }

  hasChanged(): boolean {
    return this.toString() !== this.original;
  }

  isEmpty(): boolean {
    return this.toString().trim().length === 0;
  }

  toString(): string {
    let out = this.intro;
    for (let chunk = this.firstChunk; chunk !== null; chunk = chunk.next) {
      out += chunk.intro + chunk.content + chunk.outro;
    }
    return out + this.outro;
  }
}
