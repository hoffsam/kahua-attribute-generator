declare module 'saxes' {
  interface SaxesOptions {
    xmlns?: boolean;
    position?: boolean;
  }

  interface SaxesAttribute {
    value?: string;
  }

  interface SaxesTag {
    name: string;
    attributes: Record<string, SaxesAttribute>;
  }

  export class SaxesParser {
    line: number;
    column: number;
    constructor(options?: SaxesOptions);
    on(event: 'opentag', cb: (tag: SaxesTag & { isSelfClosing?: boolean }) => void): void;
    on(event: 'closetag', cb: (name: string) => void): void;
    on(event: 'text', cb: (text: string) => void): void;
    on(event: 'error', cb: (error: unknown) => void): void;
    write(chunk: string): SaxesParser;
    close(): void;
    resume(): void;
  }
}
