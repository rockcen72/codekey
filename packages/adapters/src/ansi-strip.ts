export class AnsiStripper {
  private readonly ANSI_PATTERN = /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

  strip(chunk: string): string {
    return chunk.replace(this.ANSI_PATTERN, '');
  }
}
