/** Thrown for structurally invalid PGS input. Always carries a byte offset. */
export class PgsParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte offset ${offset})`);
    this.name = "PgsParseError";
    this.offset = offset;
  }
}
