import { Type } from '@earendil-works/pi-ai';
import type { TSchema } from '@earendil-works/pi-ai';

type JsonSchema = Record<string, unknown>;

/**
 * Convert a (subset of) JSON Schema — the shape MCP tools advertise as
 * `inputSchema` — into a TypeBox schema that pi-ai can serialize back to the
 * provider. Covers object / array / string / number / integer / boolean / null /
 * enum / anyOf / oneOf / required / description. Unsupported vocabulary falls
 * back to `Type.Any()`, which keeps the tool usable rather than dropping it.
 */
export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  if (!schema || typeof schema !== 'object') return Type.Any();
  const s = schema as JsonSchema;

  const unionOf = (variants: TSchema[]): TSchema => {
    if (variants.length === 0) return Type.Any();
    if (variants.length === 1) return variants[0];
    return Type.Union(variants as unknown as [TSchema, TSchema, ...TSchema[]]);
  };

  if (Array.isArray(s.anyOf)) {
    return unionOf((s.anyOf as unknown[]).map((v) => jsonSchemaToTypeBox(v)));
  }
  if (Array.isArray(s.oneOf)) {
    return unionOf((s.oneOf as unknown[]).map((v) => jsonSchemaToTypeBox(v)));
  }
  if (Array.isArray(s.enum)) {
    return unionOf(
      (s.enum as unknown[]).map((v) =>
        v === null ? Type.Null() : Type.Literal(v as string | number | boolean),
      ),
    );
  }

  const desc = typeof s.description === 'string' ? { description: s.description } : {};

  switch (s.type) {
    case 'object': {
      const props: Record<string, TSchema> = {};
      const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
      const properties = (s.properties ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(properties)) {
        const t = jsonSchemaToTypeBox(v);
        props[k] = required.has(k) ? t : Type.Optional(t);
      }
      const options: Record<string, unknown> = { ...desc };
      options.additionalProperties = s.additionalProperties === false ? false : Type.Any();
      return Type.Object(props, options);
    }
    case 'array': {
      const items = s.items ? jsonSchemaToTypeBox(s.items) : Type.Any();
      return Type.Array(items, desc);
    }
    case 'string':
      return Type.String(desc);
    case 'number':
      return Type.Number(desc);
    case 'integer':
      return Type.Integer(desc);
    case 'boolean':
      return Type.Boolean(desc);
    case 'null':
      return Type.Null();
    default:
      return Type.Any();
  }
}
