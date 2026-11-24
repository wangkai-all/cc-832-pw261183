// Recursive-descent parser for the finite expression language.
//
// Grammar:
//   expr   := term (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := ('+' | '-') factor | power
//   power  := primary ('^' factor)?
//   primary:= number | name ['(' expr ')'] | '(' expr ')'
//
// Supported monotone real functions: exp, log/ln, sqrt. abs is also exposed as
// a conservative piecewise envelope.

import { ParseAnalysisError } from './errors.js';

const FUNCTIONS = new Set(['log', 'ln', 'exp', 'sqrt', 'abs']);

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const s = String(input ?? '');

  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const start = i;
    if (/[0-9.]/.test(ch)) {
      let seenDot = false;
      while (i < s.length && /[0-9.]/.test(s[i])) {
        if (s[i] === '.') {
          if (seenDot) {
            throw new ParseAnalysisError(`数字 ${s.slice(start, i + 1)} 含多个小数点`, {
              position: i,
            });
          }
          seenDot = true;
        }
        i += 1;
      }
      // Scientific notation, e.g. 1e-3.
      if (s[i] === 'e' || s[i] === 'E') {
        let j = i + 1;
        if (s[j] === '+' || s[j] === '-') j += 1;
        if (/[0-9]/.test(s[j] || '')) {
          i = j;
          while (i < s.length && /[0-9]/.test(s[i])) i += 1;
        }
      }
      const raw = s.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ParseAnalysisError(`无法解析数字 “${raw}”`, { position: start });
      }
      tokens.push({ type: 'number', value, raw, position: start });
      continue;
    }

    if (/[A-Za-z_一-龥]/.test(ch)) {
      i += 1;
      while (i < s.length && /[A-Za-z0-9_一-龥]/.test(s[i])) i += 1;
      const name = s.slice(start, i);
      tokens.push({ type: 'name', value: name, position: start });
      continue;
    }

    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, position: i });
      i += 1;
      continue;
    }

    throw new ParseAnalysisError(`无法识别的字符 “${ch}”`, { position: i });
  }

  tokens.push({ type: 'end', position: s.length });
  return tokens;
}

class Parser {
  constructor(input) {
    this.input = String(input ?? '');
    this.tokens = tokenize(this.input);
    this.index = 0;
    this.nodeCount = 0;
  }

  peek(offset = 0) {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)];
  }

  next() {
    const tok = this.tokens[this.index];
    this.index += 1;
    return tok;
  }

  expectPunct(value) {
    const tok = this.peek();
    if (tok.type !== 'punct' || tok.value !== value) {
      throw new ParseAnalysisError(`缺少 “${value}”`, {
        position: tok.position,
        found: tok.value,
      });
    }
    return this.next();
  }

  make(base) {
    this.nodeCount += 1;
    return { id: `n${this.nodeCount}`, ...base };
  }

  parse() {
    if (!this.input.trim()) {
      throw new ParseAnalysisError('表达式为空');
    }
    const node = this.parseExpr();
    const tok = this.peek();
    if (tok.type !== 'end') {
      throw new ParseAnalysisError(`表达式末尾存在无法解析的 “${tok.value}”`, {
        position: tok.position,
      });
    }
    return node;
  }

  parseExpr() {
    let left = this.parseTerm();
    while (this.peek().type === 'punct' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseTerm();
      left = this.make({ kind: 'binary', op, left, right });
    }
    return left;
  }

  parseTerm() {
    let left = this.parseFactor();
    while (this.peek().type === 'punct' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.next().value;
      const right = this.parseFactor();
      left = this.make({ kind: 'binary', op, left, right });
    }
    return left;
  }

  parseFactor() {
    const tok = this.peek();
    if (tok.type === 'punct' && (tok.value === '+' || tok.value === '-')) {
      this.next();
      const operand = this.parseFactor();
      if (tok.value === '+') return operand;
      return this.make({ kind: 'unary', op: '-', operand });
    }
    return this.parsePower();
  }

  parsePower() {
    const base = this.parsePrimary();
    const tok = this.peek();
    if (tok.type === 'punct' && tok.value === '^') {
      this.next();
      // Right associativity.
      const exponent = this.parseFactor();
      return this.make({ kind: 'binary', op: '^', left: base, right: exponent });
    }
    return base;
  }

  parsePrimary() {
    const tok = this.peek();

    if (tok.type === 'number') {
      this.next();
      return this.make({ kind: 'number', value: tok.value });
    }

    if (tok.type === 'name') {
      this.next();
      const next = this.peek();
      if (next.type === 'punct' && next.value === '(') {
        this.next();
        const args = [this.parseExpr()];
        while (this.peek().type === 'punct' && this.peek().value === ',') {
          this.next();
          args.push(this.parseExpr());
        }
        this.expectPunct(')');
        const name = tok.value === 'ln' ? 'log' : tok.value;
        if (!FUNCTIONS.has(name) && !FUNCTIONS.has(tok.value)) {
          throw new ParseAnalysisError(`不支持的函数 “${tok.value}”；可用：log, exp, sqrt, abs`, {
            position: tok.position,
          });
        }
        if (args.length !== 1) {
          throw new ParseAnalysisError(`函数 ${tok.value} 只接受 1 个参数`, {
            position: tok.position,
          });
        }
        return this.make({ kind: 'call', name, args });
      }
      return this.make({ kind: 'variable', name: tok.value });
    }

    if (tok.type === 'punct' && tok.value === '(') {
      this.next();
      const node = this.parseExpr();
      this.expectPunct(')');
      return node;
    }

    throw new ParseAnalysisError('应为数字、变量、函数或括号表达式', {
      position: tok.position,
      found: tok.value,
    });
  }
}

export function parseExpression(input) {
  return new Parser(input).parse();
}

export function isIdentifierName(name) {
  return /^[A-Za-z_一-龥][A-Za-z0-9_一-龥]*$/.test(name);
}

export function collectVariables(ast) {
  const vars = new Set();
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'variable') vars.add(node.name);
    if (node.operand) walk(node.operand);
    if (node.left) walk(node.left);
    if (node.right) walk(node.right);
    if (Array.isArray(node.args)) node.args.forEach(walk);
  }
  walk(ast);
  return [...vars].sort();
}

export function printAst(node, parentPrecedence = 0) {
  if (!node) return '';
  switch (node.kind) {
    case 'number': {
      return Number.isInteger(node.value) ? String(node.value) : String(node.value);
    }
    case 'variable':
      return node.name;
    case 'unary':
      return `-${maybeParen(node.operand, 3)}`;
    case 'call':
      return `${node.name}(${node.args.map((a) => printAst(a)).join(', ')})`;
    case 'binary': {
      const precedence = node.op === '+' || node.op === '-' ? 1 : node.op === '*' || node.op === '/' ? 2 : 3;
      const left = printAst(node.left, precedence);
      const right = printAst(node.right, precedence + (node.op === '^' ? 1 : 0));
      let text = `${left} ${node.op} ${right}`;
      if (precedence < parentPrecedence) text = `(${text})`;
      return text;
    }
    default:
      return '';
  }
}

function maybeParen(node, precedence) {
  const text = printAst(node, precedence);
  if (node.kind === 'binary' || node.kind === 'unary') return `(${text})`;
  return text;
}

export const SUPPORTED_FUNCTIONS = [...FUNCTIONS];
