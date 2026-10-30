import { Prisma } from '@prisma/client';

/**
 * The reach rule as SQL (spec story 49, ticket 33): a database join, not a list of ids.
 *
 * Reach is written once, as a Prisma `where` fragment (recordPeople.ts, compiled per person by `scopeWhereFor`). A
 * question Prisma cannot ask with that fragment, such as "which timeline events are on a record this person reaches"
 * (an event has no relation to its record), needs the same rule inside a raw SQL statement. Restating the rule by
 * hand would give two definitions to keep in step. Instead this module COMPILES the very fragment the lists use into
 * SQL, through the schema's own relation map (`Prisma.dmmf`): a relation filter becomes an EXISTS subquery joined on
 * the relation's keys, a column test becomes a comparison. So the SQL form cannot drift from the rule; it can only be
 * wrong if this compiler is, which permission-reach-sql-equivalence-db.test.ts checks over every scope level.
 *
 * It compiles exactly the operators reach uses (AND, a non-empty OR, column equality and null, `in`, `not: null`, to-one
 * `is`/`isNot: null`/nested object/`null`, to-many `some`) and THROWS on anything else (NOT, `none`, `every`, an empty OR,
 * other column operators), so a reach rule written with a new operator fails loudly instead of being half-applied.
 */

type Where = Record<string, unknown>;
type Field = Prisma.DMMF.Field;
type Model = Prisma.DMMF.Model;

const MODELS = new Map<string, Model>(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

const modelOf = (name: string): Model => {
  const m = MODELS.get(name);
  if (!m) throw new Error(`reachSql: unknown model ${name}`);
  return m;
};

/** Identifiers come from the schema, never from input; quoting keeps reserved words and case intact. */
const ident = (name: string) => Prisma.raw(`"${name.replace(/"/g, '""')}"`);
const tableOf = (m: Model) => ident(m.dbName ?? m.name);
const columnOf = (f: Field) => ident((f as Field & { dbName?: string | null }).dbName ?? f.name);
const col = (alias: string, f: Field) => Prisma.sql`${Prisma.raw(alias)}.${columnOf(f)}`;

const TRUE = Prisma.sql`TRUE`;
const FALSE = Prisma.sql`FALSE`;

const unsupported = (where: string): never => {
  throw new Error(`reachSql: ${where} is not supported; add it here (and to the equivalence test) before using it in a reach rule`);
};

/** A parameter cast to the column's type, so a uuid column is compared as a uuid and keeps its index. */
function valueFor(f: Field, v: unknown): Prisma.Sql {
  const native = (f as Field & { nativeType?: [string, unknown[]] | null }).nativeType;
  if (native?.[0] === 'Uuid') return Prisma.sql`${v}::uuid`;
  if (f.kind === 'enum') return Prisma.sql`${v}::${ident(f.type)}`;
  if (f.kind === 'scalar' && ['String', 'Boolean', 'Int'].includes(f.type)) return Prisma.sql`${v}`;
  return unsupported(`a comparison on ${f.type} column ${f.name}`);
}

function scalarSql(alias: string, f: Field, cond: unknown): Prisma.Sql {
  if (f.isList) return unsupported(`list column ${f.name}`);
  if (cond === null) return Prisma.sql`${col(alias, f)} IS NULL`;
  if (typeof cond !== 'object') return Prisma.sql`${col(alias, f)} = ${valueFor(f, cond)}`;
  const parts: Prisma.Sql[] = [];
  for (const [op, v] of Object.entries(cond as Where)) {
    if (op === 'equals') parts.push(scalarSql(alias, f, v));
    else if (op === 'in') {
      if (!Array.isArray(v)) unsupported(`a non-array "in" on ${f.name}`);
      const values = v as unknown[];
      parts.push(values.length === 0 ? FALSE : Prisma.sql`${col(alias, f)} IN (${Prisma.join(values.map((x) => valueFor(f, x)))})`);
    } else if (op === 'not' && v === null) parts.push(Prisma.sql`${col(alias, f)} IS NOT NULL`);
    else unsupported(`operator "${op}" on ${f.name}`);
  }
  return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
}

let aliasCounter = 0;
const nextAlias = () => `r${++aliasCounter}`;

/** The join between a row of `from` (aliased) and the related table, as a condition on the related alias. */
function joinSql(from: Model, fromAlias: string, f: Field, toAlias: string): Prisma.Sql {
  const to = modelOf(f.type);
  const pairs: [Field, Field, 'here' | 'there'][] = [];
  if (f.relationFromFields?.length) {
    // The foreign key sits on this side: related.<to> = this.<from>.
    f.relationFromFields.forEach((fk, i) => {
      pairs.push([from.fields.find((x) => x.name === fk)!, to.fields.find((x) => x.name === f.relationToFields![i])!, 'here']);
    });
  } else {
    // The foreign key sits on the related side: find the matching field there.
    const back = to.fields.find((x) => x.relationName === f.relationName && x.kind === 'object' && x !== f && x.relationFromFields?.length);
    if (!back) return unsupported(`relation ${from.name}.${f.name} (no foreign key on either side)`);
    back.relationFromFields!.forEach((fk, i) => {
      pairs.push([from.fields.find((x) => x.name === back.relationToFields![i])!, to.fields.find((x) => x.name === fk)!, 'there']);
    });
  }
  return Prisma.join(pairs.map(([here, there]) => Prisma.sql`${col(toAlias, there)} = ${col(fromAlias, here)}`), ' AND ');
}

function exists(from: Model, alias: string, f: Field, inner: Where | null): Prisma.Sql {
  const to = modelOf(f.type);
  const a = nextAlias();
  const cond = inner === null ? TRUE : whereSql(to, inner, a);
  return Prisma.sql`EXISTS (SELECT 1 FROM ${tableOf(to)} ${Prisma.raw(a)} WHERE ${joinSql(from, alias, f, a)} AND (${cond}))`;
}

function relationSql(from: Model, alias: string, f: Field, cond: unknown): Prisma.Sql {
  if (f.isList) {
    if (cond === null || typeof cond !== 'object') return unsupported(`to-many ${f.name} = ${String(cond)}`);
    const parts: Prisma.Sql[] = [];
    for (const [op, v] of Object.entries(cond as Where)) {
      if (op === 'some') parts.push(exists(from, alias, f, v as Where));
      else unsupported(`to-many operator "${op}" on ${f.name}`);
    }
    return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
  }
  // To-one.
  if (cond === null) return Prisma.sql`NOT ${exists(from, alias, f, null)}`;
  if (typeof cond !== 'object') return unsupported(`to-one ${f.name} = ${String(cond)}`);
  const keys = Object.keys(cond as Where);
  if (keys.some((k) => k === 'is' || k === 'isNot')) {
    const parts: Prisma.Sql[] = [];
    for (const [op, v] of Object.entries(cond as Where)) {
      if (op === 'is') parts.push(v === null ? Prisma.sql`NOT ${exists(from, alias, f, null)}` : exists(from, alias, f, v as Where));
      else if (op === 'isNot' && v === null) parts.push(exists(from, alias, f, null));
      else unsupported(`to-one operator "${op}" on ${f.name}`);
    }
    return Prisma.join(parts, ' AND ');
  }
  // A bare object is `is`.
  return exists(from, alias, f, cond as Where);
}

/** The SQL condition a Prisma `where` on `modelName` puts on the row aliased `alias`. */
export function whereSql(model: Model | string, where: Where, alias: string): Prisma.Sql {
  const m = typeof model === 'string' ? modelOf(model) : model;
  const parts: Prisma.Sql[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === 'AND') {
      const list = (Array.isArray(value) ? value : [value]) as Where[];
      parts.push(list.length ? Prisma.sql`(${Prisma.join(list.map((w) => whereSql(m, w, alias)), ' AND ')})` : TRUE);
    } else if (key === 'OR') {
      const list = value as Where[];
      if (!Array.isArray(list) || list.length === 0) unsupported('an OR that is not a non-empty list');
      parts.push(Prisma.sql`(${Prisma.join(list.map((w) => whereSql(m, w, alias)), ' OR ')})`);
    } else {
      const f = m.fields.find((x) => x.name === key);
      if (!f) return unsupported(`field ${m.name}.${key}`);
      parts.push(f.kind === 'object' ? relationSql(m, alias, f, value) : scalarSql(alias, f, value));
    }
  }
  return parts.length ? Prisma.join(parts, ' AND ') : TRUE;
}

/** The table a model is stored in, for a statement that joins against it. */
export const tableSql = (modelName: string) => tableOf(modelOf(modelName));
