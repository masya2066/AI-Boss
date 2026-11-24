import ts from 'ts-parser';
import type { Declaration, FileFacts, ImportFact, PageFact, RouteFact, TableFact } from './types';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']);
const NEST_METHODS: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Patch: 'PATCH', Delete: 'DELETE', Options: 'OPTIONS', Head: 'HEAD', All: 'ALL' };
const TEST_FNS = new Set(['it', 'test', 'describe', 'suite', 'context']);
const TABLE_FNS = new Set(['pgTable', 'mysqlTable', 'sqliteTable', 'table']);
const QB_METHODS = new Set(['where', 'select', 'insert', 'update', 'delete', 'del', 'count', 'first', 'join', 'leftJoin', 'orderBy', 'pluck', 'increment', 'decrement', 'returning', 'whereIn', 'andWhere']);
const KNEX_TABLE_METHODS = new Set(['from', 'into', 'table', 'join', 'leftJoin', 'innerJoin', 'update']);
const SQL_TABLE_RX = /\b(?:from|join|into|update|table)\s+["`]?([a-z_][a-z0-9_]*)["`]?/gi;
const SQL_HINT_RX = /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set)\b/i;

function lit(n: ts.Node | undefined): string | undefined {
  if (!n) return undefined;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return undefined;
}

function lineOf(sf: ts.SourceFile, n: ts.Node) {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

function hasExport(n: ts.Node): boolean {
  const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined;
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function decoratorsOf(n: ts.Node): ts.Decorator[] {
  return (ts.canHaveDecorators(n) ? ts.getDecorators(n) : undefined)?.slice() ?? [];
}

function decoratorCall(d: ts.Decorator): { name: string; args: readonly ts.Expression[] } | undefined {
  const e = d.expression;
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return { name: e.expression.text, args: e.arguments };
  if (ts.isIdentifier(e)) return { name: e.text, args: [] };
  return undefined;
}

const joinPath = (a: string, b: string) => ('/' + [a, b].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

/** AST facts for a JS/TS file (no type checking: fast, works on broken code). */
export function parseTs(path: string, src: string, lang: 'ts' | 'js'): Omit<FileFacts, 'blob'> {
  const kind = /\.tsx$/.test(path) ? ts.ScriptKind.TSX : /\.jsx$/.test(path) ? ts.ScriptKind.JSX : lang === 'ts' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const imports: ImportFact[] = [];
  const declarations: Declaration[] = [];
  const routes: RouteFact[] = [];
  const pages: PageFact[] = [];
  const envVars = new Set<string>();
  const testTitles: string[] = [];
  const tables: TableFact[] = [];
  const tableRefs = new Set<string>();
  const urls = new Set<string>();
  const exportedLocal = new Set<string>();
  const identifiers = new Set<string>();

  const decl = (name: string, k: Declaration['kind'], n: ts.Node, exported: boolean) =>
    declarations.push({ name, kind: k, exported, startLine: lineOf(sf, n), endLine: sf.getLineAndCharacterOfPosition(n.getEnd()).line + 1 });

  // ---- top level: imports, exports, declarations --------------------------------
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = lit(st.moduleSpecifier);
      if (!spec) continue;
      const names: string[] = [];
      const c = st.importClause;
      if (!c) names.push('*');
      else {
        if (c.name) names.push('default');
        const nb = c.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) names.push('*');
        if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) names.push((e.propertyName ?? e.name).text);
      }
      imports.push({ spec, names, typeOnly: !!c?.isTypeOnly, reexport: false, line: lineOf(sf, st) });
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      const spec = lit(st.moduleSpecifier);
      const names: string[] = [];
      if (!st.exportClause) names.push('*');
      else if (ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) names.push((e.propertyName ?? e.name).text);
      else names.push('*');
      if (spec) imports.push({ spec, names, typeOnly: st.isTypeOnly, reexport: true, line: lineOf(sf, st) });
      else if (st.exportClause && ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) exportedLocal.add((e.propertyName ?? e.name).text);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      decl('default', 'variable', st, true);
      continue;
    }
    const exp = hasExport(st);
    const isDefault = !!(ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
    if (ts.isFunctionDeclaration(st)) decl(isDefault ? 'default' : (st.name?.text ?? 'default'), 'function', st, exp);
    else if (ts.isClassDeclaration(st)) {
      decl(isDefault ? 'default' : (st.name?.text ?? 'default'), 'class', st, exp);
      for (const m of st.members) if ((ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) && m.name && ts.isIdentifier(m.name)) decl(`${st.name?.text ?? 'default'}.${m.name.text}`, 'method', m, exp);
    } else if (ts.isInterfaceDeclaration(st)) decl(st.name.text, 'interface', st, exp);
    else if (ts.isTypeAliasDeclaration(st)) decl(st.name.text, 'type', st, exp);
    else if (ts.isEnumDeclaration(st)) decl(st.name.text, 'enum', st, exp);
    else if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decl(d.name.text, isConst ? 'const' : 'variable', st, exp);
        else for (const el of (d.name as ts.ObjectBindingPattern | ts.ArrayBindingPattern).elements) if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) decl(el.name.text, 'const', st, exp);
      }
    }
  }
  for (const d of declarations) if (exportedLocal.has(d.name)) d.exported = true;

  // ---- deep walk: routes, env, tests, tables, require/dynamic import --------------
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text.length > 2 && identifiers.size < 3000) identifiers.add(n.text);
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // require('x') / import('x')
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = lit(n.arguments[0]);
        if (spec) imports.push({ spec, names: ['*'], typeOnly: false, reexport: false, line: lineOf(sf, n) });
      }
      // app.get('/x', ...), router.post(...), fastify.delete(...)
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        const p = lit(n.arguments[0]);
        if (HTTP_METHODS.has(m) && p && p.startsWith('/') && n.arguments.length >= 2) routes.push({ method: m.toUpperCase(), path: p, line: lineOf(sf, n), framework: 'express-like' });
        // fastify.route({ method, url })
        if (m === 'route' && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
          let method = 'ANY';
          let url: string | undefined;
          for (const pr of n.arguments[0].properties) {
            if (!ts.isPropertyAssignment(pr) || !ts.isIdentifier(pr.name)) continue;
            if (pr.name.text === 'url' || pr.name.text === 'path') url = lit(pr.initializer);
            if (pr.name.text === 'method') method = lit(pr.initializer)?.toUpperCase() ?? (ts.isArrayLiteralExpression(pr.initializer) ? pr.initializer.elements.map((e) => lit(e)).join(',').toUpperCase() : method);
          }
          if (url) routes.push({ method, path: url, line: lineOf(sf, n), framework: 'fastify' });
        }
        // knex('t') / db.from('t') / .into('t')
        if (KNEX_TABLE_METHODS.has(m) && p && /^[a-z_][a-z0-9_]*$/i.test(p)) tableRefs.add(p.toLowerCase());
        // prisma.booking.findMany(...)  -> model "booking"
        const obj = callee.expression;
        if (ts.isPropertyAccessExpression(obj) && /^(prisma|db|tx|client|ctx\.prisma)$/i.test(obj.expression.getText(sf).replace(/^this\./, ''))) tableRefs.add(obj.name.text.toLowerCase());
      }
      if (ts.isIdentifier(callee)) {
        const fn = callee.text;
        if (TEST_FNS.has(fn)) {
          const t = lit(n.arguments[0]);
          if (t) testTitles.push(t);
        }
        if (TABLE_FNS.has(fn) && fn !== 'table') {
          const name = lit(n.arguments[0]);
          const cols = n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1]) ? n.arguments[1].properties.map((pr) => pr.name?.getText(sf) ?? '').filter(Boolean) : [];
          const parent = n.parent;
          const alias = ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
          if (name) tables.push({ name, alias, columns: cols, relations: [], source: 'drizzle', line: lineOf(sf, n) });
        }
        // knex('bookings') / db('bookings').where(...) — query-builder call on a table name
        const t0 = lit(n.arguments[0]);
        const chained = ts.isPropertyAccessExpression(n.parent) && QB_METHODS.has(n.parent.name.text);
        if (t0 && /^[a-z_][a-z0-9_]*$/.test(t0) && (fn === 'knex' || fn === 'sql' || chained)) tableRefs.add(t0);
        if (fn === 'fetch') {
          const u = lit(n.arguments[0]);
          if (u && /^https?:\/\//.test(u)) urls.add(new URL(u).host);
        }
      }
      // test.each / describe.only / it.skip
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && TEST_FNS.has(callee.expression.text)) {
        const t = lit(n.arguments[0]);
        if (t) testTitles.push(t);
      }
    }
    // process.env.X / process.env['X'] / import.meta.env.X
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const base = n.expression.getText(sf);
      if (base === 'process.env' || base === 'import.meta.env' || base === 'Deno.env') {
        const key = ts.isPropertyAccessExpression(n) ? n.name.text : lit(n.argumentExpression);
        if (key) envVars.add(key);
      }
    }
    // raw SQL in strings
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n)) && SQL_HINT_RX.test(n.text)) {
      for (const m of n.text.matchAll(SQL_TABLE_RX)) tableRefs.add(m[1]!.toLowerCase());
    }
    if (ts.isStringLiteral(n) && /^https?:\/\/[^\s/]+\.[a-z]{2,}/i.test(n.text) && !/localhost|127\.0\.0\.1|example\.(com|org)/.test(n.text)) {
      try {
        urls.add(new URL(n.text).host);
      } catch {
        /* not a URL */
      }
    }
    // NestJS controllers / TypeORM entities
    if (ts.isClassDeclaration(n)) {
      let base = '';
      for (const d of decoratorsOf(n)) {
        const c = decoratorCall(d);
        if (c?.name === 'Controller') base = lit(c.args[0]) ?? '';
        if (c?.name === 'Entity') tables.push({ name: lit(c.args[0]) ?? n.name?.text ?? 'entity', alias: n.name?.text, columns: n.members.filter((m) => ts.isPropertyDeclaration(m) && decoratorsOf(m).length > 0).map((m) => m.name!.getText(sf)), relations: [], source: 'typeorm', line: lineOf(sf, n) });
      }
      if (decoratorsOf(n).some((d) => decoratorCall(d)?.name === 'Controller')) {
        for (const m of n.members) {
          for (const d of decoratorsOf(m)) {
            const c = decoratorCall(d);
            if (c && NEST_METHODS[c.name]) routes.push({ method: NEST_METHODS[c.name]!, path: joinPath(base, lit(c.args[0]) ?? ''), line: lineOf(sf, m), framework: 'nestjs' });
          }
        }
      }
    }
    // <Route path="/x" .../>
    if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && n.tagName.getText(sf) === 'Route') {
      for (const a of n.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText(sf) === 'path' && a.initializer && ts.isStringLiteral(a.initializer)) pages.push({ path: a.initializer.text, framework: 'react-router' });
      }
    }
    // { path: '/x', element: ... }  (createBrowserRouter / vue-router)
    if (ts.isObjectLiteralExpression(n)) {
      const props = new Map(n.properties.filter(ts.isPropertyAssignment).filter((p) => ts.isIdentifier(p.name)).map((p) => [(p.name as ts.Identifier).text, p.initializer] as const));
      const p = lit(props.get('path'));
      if (p !== undefined && ['element', 'component', 'Component', 'loader', 'lazy', 'children'].some((k) => props.has(k))) pages.push({ path: p, framework: 'router-config' });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // ---- file-system routing (Next.js, Remix-ish) --------------------------------------
  const fsRoute = (seg: string) =>
    '/' +
    seg
      .split('/')
      .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'))
      .map((s) => s.replace(/^\[\[?\.\.\.(\w+)\]?\]$/, '*$1').replace(/^\[(\w+)\]$/, ':$1'))
      .join('/');
  const appRoute = path.match(/(?:^|\/)app\/(.*?)\/?route\.(t|j)sx?$/);
  if (appRoute) {
    for (const d of declarations) if (d.exported && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name)) routes.push({ method: d.name, path: fsRoute(appRoute[1]!), line: d.startLine, framework: 'next-app' });
  }
  const appPage = path.match(/(?:^|\/)app\/(.*?)\/?page\.(t|j)sx?$/);
  if (appPage) pages.push({ path: fsRoute(appPage[1]!), framework: 'next-app' });
  const pagesApi = path.match(/(?:^|\/)pages\/api\/(.*)\.(t|j)sx?$/);
  if (pagesApi) routes.push({ method: 'ANY', path: '/api' + fsRoute(pagesApi[1]!.replace(/\/?index$/, '')).replace(/^\/$/, ''), line: 1, framework: 'next-pages' });
  const pagesPage = path.match(/(?:^|\/)pages\/(?!api\/)(.*)\.(t|j)sx$/);
  if (pagesPage && !/(^|\/)_(app|document|error)$/.test(pagesPage[1]!)) pages.push({ path: fsRoute(pagesPage[1]!.replace(/\/?index$/, '')), framework: 'next-pages' });

  return {
    path,
    lang,
    imports,
    declarations,
    routes,
    pages,
    envVars: [...envVars].sort(),
    testTitles,
    tables,
    tableRefs: [...tableRefs].sort(),
    urls: [...urls].sort(),
    identifiers: [...identifiers].sort(),
  };
}
