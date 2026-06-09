/**
 * A small formatter for Gel (EdgeQL) queries.
 *
 * It re-flows a query from scratch: shape blocks (`{ ... }`) are expanded so
 * that each member sits on its own line, indented by `indentSize` spaces per
 * nesting level, while parenthesised/bracketed expressions stay inline.
 *
 *   select User { email, name };
 *
 * becomes
 *
 *   select User {
 *     email,
 *     name
 *   };
 */

/*** UTILITY ------------------------------------------ ***/

type TokenType =
  | "word"
  | "string"
  | "operator"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "comma"
  | "colon"
  | "semicolon";

interface Token {
  type: TokenType;
  value: string;
}

type Container = "brace" | "bracket" | "paren";

const PUNCTUATION: Record<string, TokenType> = {
  "(": "lparen",
  ")": "rparen",
  "[": "lbracket",
  "]": "rbracket",
  "{": "lbrace",
  "}": "rbrace",
  ",": "comma",
  ":": "colon",
  ";": "semicolon"
};

const CALL_PREFIX = new Set<TokenType | null>(["word", "string", "rparen", "rbracket"]);
const NO_SPACE_AFTER = new Set<TokenType | null>(["lparen", "lbracket"]);

/*** EXPORT ------------------------------------------- ***/

export function formatQuery(input: string, indentSize = 2): string {
  const stack: Container[] = [];
  const tokens = tokenize(input);
  const top = (): Container | undefined => stack[stack.length - 1];
  let atLineStart = true;
  let indent = 0;
  let out = "";
  let prev: TokenType | null = null;

  const trimLine = (): void => {
    out = out.replace(/[ \t]+$/, "");
  };

  const newline = (): void => {
    trimLine();
    out += "\n";
    atLineStart = true;
  };

  const indentIfNeeded = (): void => {
    if (atLineStart) {
      out += " ".repeat(indent * indentSize);
      atLineStart = false;
    }
  };

  const spaceBeforeValue = (): boolean => {
    if (prev === null || NO_SPACE_AFTER.has(prev))
      return false;

    if (prev === "colon" && (top() === "paren" || top() === "bracket"))
      return false;

    return true;
  };

  const writeValue = (value: string): void => {
    if (atLineStart)
      indentIfNeeded();
    else if (spaceBeforeValue())
      out += " ";

    out += value;
  };

  const writeOpen = (value: string, container: Container): void => {
    if (atLineStart)
      indentIfNeeded();
    else if (!CALL_PREFIX.has(prev) && !NO_SPACE_AFTER.has(prev))
      out += " ";

    out += value;
    stack.push(container);
  };

  const writeClose = (value: string): void => {
    trimLine();
    out += value;
    stack.pop();
    atLineStart = false;
  };

  for (const token of tokens) {
    switch (token.type) {
      case "operator":
      case "string":
      case "word": {
        writeValue(token.value);
        break;
      }

      case "colon": {
        trimLine();
        out += ":";

        break;
      }

      case "comma": {
        trimLine();
        out += ",";

        if (top() === "brace" || stack.length === 0)
          newline();

        break;
      }

      case "lbrace": {
        if (atLineStart)
          indentIfNeeded();
        else if (!NO_SPACE_AFTER.has(prev))
          out += " ";

        out += "{";
        stack.push("brace");
        indent++;
        newline();

        break;
      }

      case "lbracket": {
        writeOpen("[", "bracket");
        break;
      }

      case "lparen": {
        writeOpen("(", "paren");
        break;
      }

      case "rbrace": {
        stack.pop();
        indent = Math.max(0, indent - 1);
        newline();
        indentIfNeeded();
        out += "}";

        break;
      }

      case "rbracket": {
        writeClose("]");
        break;
      }

      case "rparen": {
        writeClose(")");
        break;
      }

      case "semicolon": {
        trimLine();
        out += ";";
        newline();

        break;
      }
    }

    prev = token.type;
  }

  return out.replace(/[ \t]+\n/g, "\n").trimEnd();
}

/*** HELPER ------------------------------------------- ***/

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const ch = input[i];

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    /*** Strings: preserve verbatim so commas/braces inside them are untouched. ***/
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let value = quote;
      let j = i + 1;

      while (j < n) {
        const c = input[j];

        if (c === "\\" && j + 1 < n) {
          value += c + input[j + 1];
          j += 2;

          continue;
        }

        value += c;
        j++;

        if (c === quote)
          break;
      }

      tokens.push({ type: "string", value });
      i = j;

      continue;
    }

    /*** `:=` assignment operator (computeds) is a single token. ***/
    if (ch === ":" && input[i + 1] === "=") {
      tokens.push({ type: "operator", value: ":=" });
      i += 2;

      continue;
    }

    const punctuation = PUNCTUATION[ch];

    if (punctuation) {
      tokens.push({ type: punctuation, value: ch });
      i++;

      continue;
    }

    /*** Everything else is an identifier/keyword/operator run. ***/
    let value = "";
    let j = i;

    while (j < n) {
      const c = input[j];

      if (isWhitespace(c) || PUNCTUATION[c] || c === "\"" || c === "'")
        break;

      value += c;
      j++;
    }

    tokens.push({ type: "word", value });
    i = j;
  }

  return tokens;
}
