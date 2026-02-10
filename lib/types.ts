/**
 * Common type definitions for Disc
 */

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type Maybe<T> = T | null | undefined;

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface Span {
  start: Position;
  end: Position;
  source?: string;
}

export interface ASTNode {
  kind: string;
  span?: Span;
}