import jsonata from "jsonata";

export type JsonataExpression = ReturnType<typeof jsonata>;

const cache = new Map<string, JsonataExpression>();

export function compileExpr(src: string): JsonataExpression {
  let expr = cache.get(src);
  if (!expr) {
    expr = jsonata(src);
    cache.set(src, expr);
  }
  return expr;
}

export async function evalExpr<T = unknown>(src: string, context: unknown): Promise<T> {
  return (await compileExpr(src).evaluate(context)) as T;
}
