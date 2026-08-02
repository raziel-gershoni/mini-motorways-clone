/**
 * AST-based determinism rules for `packages/sim/src` and `packages/shared/src`.
 *
 * Three mechanisms enforce this codebase's determinism boundary, each closing
 * a blind spot the others cannot:
 *
 *   - ESLint's built-in name-based rules (`no-restricted-globals`,
 *     `no-restricted-properties`, `no-restricted-syntax`, configured in
 *     `eslint.config.js`) catch bracket access (`Math['random']()`) and
 *     destructuring (`const { random } = Math`).
 *   - These AST rules catch what name-based matching structurally cannot:
 *     variable aliasing (`const m = Math; m.random()`), which defeats
 *     name-based rules because `Math` itself cannot be banned by name —
 *     `Math.imul` and `Math.min` are load-bearing in `rng.ts` — plus
 *     module-scope mutable state and Map/Set/object-key iteration, neither of
 *     which is expressible as a banned name or property at all.
 *   - The regex source scan (`packages/sim/test/determinism.test.ts`) catches
 *     float literals, `new Date`, bare `.sort()`, and bare
 *     `globalThis`/`window`/`self`/`document` references; it runs in CI with
 *     the rest of the suite, and — being a plain text scan rather than an
 *     ESLint rule — cannot be silenced by an inline `eslint-disable` comment.
 *
 * Kept under `tools/` rather than `packages/`: these are build-time lint
 * rules, not shipped sim code, and the determinism scan's own file roots
 * (`packages/sim/src`, `packages/shared/src`) must not grow to include them.
 */

const BANNED_GLOBAL_NAMES = new Set(['Math', 'Date', 'performance', 'globalThis', 'self', 'window', 'document'])

/** Every standard TypedArray constructor name, plus the non-typed collections. */
const MUTABLE_CONTAINER_CTOR_NAME =
  /^(?:(?:Int8|Uint8|Uint8Clamped|Int16|Uint16|Int32|Uint32|Float32|Float64|BigInt64|BigUint64)?Array|ArrayBuffer|SharedArrayBuffer|Map|Set|WeakMap|WeakSet)$/

/** True when `declaration` (a `VariableDeclaration`) sits directly at module scope. */
function isModuleScopeDeclaration(declaration) {
  const parent = declaration.parent
  if (!parent) return false
  if (parent.type === 'Program') return true
  return parent.type === 'ExportNamedDeclaration' && Boolean(parent.parent) && parent.parent.type === 'Program'
}

function isObjectFreezeCallee(callee) {
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Object' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'freeze'
  )
}

/**
 * True when `literalNode` (an `ArrayExpression` or `ObjectExpression`) is,
 * looking through `TSAsExpression` wrappers, itself a direct argument of an
 * `Object.freeze(...)` call. Looking through `TSAsExpression` is what makes
 * `Object.freeze([0, 1] as const)` acceptable while `[0, 1] as const` alone,
 * with no enclosing freeze, is not — `as const` is a type-level assertion
 * only and freezes nothing at runtime.
 */
function isDirectFreezeArgument(literalNode) {
  let current = literalNode
  while (current.parent && current.parent.type === 'TSAsExpression' && current.parent.expression === current) {
    current = current.parent
  }
  const parent = current.parent
  return Boolean(
    parent &&
      parent.type === 'CallExpression' &&
      isObjectFreezeCallee(parent.callee) &&
      parent.arguments.indexOf(current) !== -1,
  )
}

/**
 * Collects every `ArrayExpression`/`ObjectExpression` reachable from `node`,
 * without descending into nested function bodies. A literal created fresh
 * inside a function body on every call is not persistent module-scope state —
 * the same reasoning that already lets `let`/`var`/`new Uint8Array` live
 * inside a function body elsewhere in this rule.
 */
function collectLiterals(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectLiterals(node[i], out)
    return
  }
  if (typeof node.type !== 'string') return
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
    return
  }
  if (node.type === 'ArrayExpression' || node.type === 'ObjectExpression') {
    out.push(node)
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (value && typeof value === 'object') collectLiterals(value, out)
  }
}

const noModuleMutableState = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bans module-scope mutable state: let/var declarations, `new` TypedArray/ArrayBuffer/Map/Set/' +
        'WeakMap/WeakSet, and any array or object literal not itself frozen with Object.freeze — ' +
        'including every level of nesting, since Object.freeze is shallow.',
    },
    schema: [],
    messages: {
      letOrVar:
        'Module-scope `{{kind}}` declares mutable state shared across every state instance and surviving ' +
        'rollback. Move it into the state buffer, or into a function.',
      mutableContainer:
        'Module-scope `new {{ctor}}(...)` is reusable mutable state living outside the state buffer.',
      unfrozenLiteral:
        'Module-scope {{literal}} literal is mutable. Wrap it in `Object.freeze(...)` — and every nested ' +
        'array/object literal in it, individually, since Object.freeze does not recurse.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (!isModuleScopeDeclaration(node)) return

        if (node.kind === 'let' || node.kind === 'var') {
          context.report({ node, messageId: 'letOrVar', data: { kind: node.kind } })
          return
        }

        for (const declarator of node.declarations) {
          if (!declarator.init) continue
          const init = declarator.init

          if (init.type === 'NewExpression' && init.callee.type === 'Identifier' && MUTABLE_CONTAINER_CTOR_NAME.test(init.callee.name)) {
            context.report({ node: declarator, messageId: 'mutableContainer', data: { ctor: init.callee.name } })
            continue
          }

          const literals = []
          collectLiterals(init, literals)
          for (const literal of literals) {
            if (!isDirectFreezeArgument(literal)) {
              context.report({
                node: literal,
                messageId: 'unfrozenLiteral',
                data: { literal: literal.type === 'ArrayExpression' ? 'array' : 'object' },
              })
            }
          }
        }
      },
    }
  },
}

/**
 * True when `id` (an `Identifier` matching a banned global name) sits in a
 * position that is not itself a value read of that global: a binding
 * introduced by a declaration, a non-computed property/member key, an import
 * or export specifier, or a label. Everything else is a value-position use.
 */
function isNonReferencePosition(id, parent) {
  if (!parent) return false
  switch (parent.type) {
    case 'MemberExpression':
      if (parent.object === id) return true // Math.imul — the one carve-out
      return parent.property === id && !parent.computed // foo.Math — a property name, not a global read
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return parent.key === id && !parent.computed
    case 'VariableDeclarator':
      return parent.id === id
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return parent.id === id || parent.params.indexOf(id) !== -1
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id === id
    case 'CatchClause':
      return parent.param === id
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return true
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return true
    default:
      return false
  }
}

const noAliasedGlobals = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bans referencing Math, Date, performance, globalThis, self, window or document as a value ' +
        '(assigning it, passing it, destructuring it) anywhere other than as the object of a member ' +
        'expression. Closes the `const m = Math; m.random()` hole that defeats every name-based rule, ' +
        'because Math cannot be banned by name — Math.imul and Math.min are load-bearing in rng.ts.',
    },
    schema: [],
    messages: {
      aliasedGlobal:
        '`{{name}}` was used as a value, not as `{{name}}.<member>`. Aliasing it (`const x = {{name}}`) ' +
        'evades every rule that bans a specific property of {{name}}.',
    },
  },
  create(context) {
    return {
      Identifier(node) {
        if (!BANNED_GLOBAL_NAMES.has(node.name)) return
        if (isNonReferencePosition(node, node.parent)) return
        context.report({ node, messageId: 'aliasedGlobal', data: { name: node.name } })
      },
    }
  },
}

const ITERATOR_METHOD_NAMES = new Set(['keys', 'values', 'entries'])

function staticPropertyName(memberExpr) {
  if (!memberExpr.computed) {
    return memberExpr.property.type === 'Identifier' ? memberExpr.property.name : null
  }
  return memberExpr.property.type === 'Literal' && typeof memberExpr.property.value === 'string'
    ? memberExpr.property.value
    : null
}

const noCollectionIteration = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bans Object.keys/values/entries/getOwnPropertyNames, any for...in, and any for...of over a ' +
        '.keys()/.values()/.entries() call — spec §4.1. Set/Map used only through has/add/get/set/delete ' +
        'are exempt and unaffected by this rule: membership is order-free, which is exactly what ' +
        'computeLayout\'s duplicate-name check (a `Set` used only via has/add) relies on. If this rule\'s ' +
        'guard file contains a `Set`, that is the exemption at work, not a gap in the rule.',
    },
    schema: [],
    messages: {
      noEnumeration: '`Object.{{method}}` enumerates key/value order. Order-dependent reads are banned by spec §4.1.',
      noForIn: '`for...in` enumerates keys in an order not guaranteed identical across engines. Use an explicit array or index loop.',
      noIteratorMethod:
        '`for...of` over `.{{method}}()` iterates enumeration order. Use has/add/get/set/delete, or an explicit array.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (
          node.callee.type === 'MemberExpression' &&
          !node.callee.computed &&
          node.callee.object.type === 'Identifier' &&
          node.callee.object.name === 'Object' &&
          node.callee.property.type === 'Identifier' &&
          ['keys', 'values', 'entries', 'getOwnPropertyNames'].includes(node.callee.property.name)
        ) {
          context.report({ node, messageId: 'noEnumeration', data: { method: node.callee.property.name } })
        }
      },
      ForInStatement(node) {
        context.report({ node, messageId: 'noForIn' })
      },
      ForOfStatement(node) {
        if (node.right.type !== 'CallExpression' || node.right.callee.type !== 'MemberExpression') return
        const method = staticPropertyName(node.right.callee)
        if (method && ITERATOR_METHOD_NAMES.has(method)) {
          context.report({ node, messageId: 'noIteratorMethod', data: { method } })
        }
      },
    }
  },
}

export default {
  rules: {
    'no-module-mutable-state': noModuleMutableState,
    'no-aliased-globals': noAliasedGlobals,
    'no-collection-iteration': noCollectionIteration,
  },
}
