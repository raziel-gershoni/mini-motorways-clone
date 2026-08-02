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
 *     module-scope mutable state (including `static` class fields and
 *     module-scope IIFEs, which read like ordinary function scope but are
 *     not) and Map/Set/object-key iteration, none of which is expressible
 *     as a banned name or property at all.
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

/**
 * True when `fn` (a function/arrow/function-declaration node) is the callee
 * of a `CallExpression` that is invoked immediately (an IIFE), where the
 * *result* of that call is bound directly to a variable declared at module
 * scope. Such a function body runs exactly once, at module load, and
 * whatever state it captures in a closure is exactly as persistent as an
 * ordinary module-scope `const` — it is the closure equivalent of a
 * module-scope mutable container, not an ordinary function whose locals are
 * fresh every call.
 */
function isModuleScopeIIFECallee(fn) {
  const call = fn.parent
  if (!call || call.type !== 'CallExpression' || call.callee !== fn) return false
  const declarator = call.parent
  return Boolean(
    declarator &&
      declarator.type === 'VariableDeclarator' &&
      declarator.init === call &&
      declarator.parent &&
      declarator.parent.type === 'VariableDeclaration' &&
      isEffectivelyModuleScope(declarator.parent),
  )
}

/**
 * True when `node` sits at module scope: its ancestor chain reaches
 * `Program` (through any wrapping `ExportNamedDeclaration`/
 * `ExportDefaultDeclaration`) without crossing a function boundary that
 * ISN'T the module-scope-IIFE shape `isModuleScopeIIFECallee` recognises.
 * Every other function boundary — a function that can run more than once,
 * or whose result is not bound at module scope — makes everything inside it
 * out of scope for these rules, because its locals are fresh per call.
 */
function isEffectivelyModuleScope(node) {
  let current = node.parent
  while (current) {
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression'
    ) {
      if (!isModuleScopeIIFECallee(current)) return false
    }
    current = current.parent
  }
  return true
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
 * Collects every value an IIFE hands back to its caller: for an arrow with
 * an implicit-return expression body (`() => expr`), that expression
 * itself; otherwise every `return <argument>` reachable without crossing
 * into a further nested function (a nested function's own `return`s belong
 * to its own, possibly-repeated, call — not to this IIFE's single call).
 */
function collectReturnedExpressions(fnNode, out) {
  if (fnNode.expression) {
    out.push(fnNode.body)
    return
  }
  collectReturnStatementArguments(fnNode.body, out)
}

function collectReturnStatementArguments(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectReturnStatementArguments(node[i], out)
    return
  }
  if (typeof node.type !== 'string') return
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
    return
  }
  if (node.type === 'ReturnStatement' && node.argument) {
    out.push(node.argument)
    return
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue
    const value = node[key]
    if (value && typeof value === 'object') collectReturnStatementArguments(value, out)
  }
}

/**
 * Collects every `ArrayExpression`/`ObjectExpression` reachable from `node`.
 *
 * Ordinary functions are not descended into: a literal built fresh inside a
 * function body on every call is not persistent module-scope state — the
 * same reasoning that already lets `let`/`var`/`new Uint8Array` live inside
 * a function body elsewhere in this rule.
 *
 * A module-scope IIFE (`isModuleScopeIIFECallee`) is the deliberate
 * exception: it runs exactly once, at module load, so what it hands back is
 * exactly as persistent as an ordinary module-scope const's initialiser.
 * Descent is restricted to its RETURN PATH only, not its whole body — a
 * literal built inside the IIFE but only ever passed to some other call and
 * never returned does not outlive that call, and is not module-scope state.
 * Flagging it would be a false positive of exactly the kind that gets a
 * rule disabled. (A container — `new Map()` etc. — returned bare from an
 * IIFE with no intermediate binding is a known residual NOT covered here:
 * it mirrors the pre-existing blind spot where a `new Map()` nested inside
 * an already-reported unfrozen object literal gets no separate report of
 * its own. Closing it is out of scope for this pass; the let/var and
 * literal forms below are what the reported hole demonstrated.)
 *
 * Do not "simplify" the function-boundary skip away for ordinary functions:
 * doing so would make every closure factory (`() => { let n = 0; return ()
 * => n++ }`, called many times, each with its own private counter) report
 * as if it were the one-shot module-scope IIFE case.
 */
function collectLiterals(node, out) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectLiterals(node[i], out)
    return
  }
  if (typeof node.type !== 'string') return
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
    if (!isModuleScopeIIFECallee(node)) return
    const returned = []
    collectReturnedExpressions(node, returned)
    for (const expr of returned) collectLiterals(expr, out)
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
        'WeakMap/WeakSet, any array or object literal not itself frozen with Object.freeze (including ' +
        'every level of nesting, since Object.freeze is shallow), the same three shapes reached through a ' +
        '`static` class field, and a module-scope IIFE whose captured state persists for the life of the ' +
        'module — the last two are `let`/`new`/unfrozen-literal wearing a different hat, not new concepts.',
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
      staticMutableField:
        'Static field `{{name}}` is reassignable module-scope state — the class-field equivalent of a ' +
        '`let`. Mark it `readonly` if it truly does not change; a container or literal it holds still needs ' +
        'the same treatment as a module-scope const (new Map/Set/etc. and unfrozen literals are reported ' +
        'independently of readonly, since neither actually stops the VALUE from mutating).',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (!isEffectivelyModuleScope(node)) return

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

      // Instance fields are per-instance state, created fresh for every
      // `new` — out of scope for a rule about state that outlives any one
      // instance. Only `static` fields are module-scope state wearing a
      // different hat: `static instance = new Map()` is `mutableContainer`,
      // `static rows = [[1, 2]]` is `unfrozenLiteral`, and a plain `static n
      // = 0` (no `readonly`) is `letOrVar`'s equivalent — a reassignable
      // module-scope slot, regardless of what it currently holds.
      // Instance fields are per-instance state, created fresh for every
      // `new` — out of scope for a rule about state that outlives any one
      // instance. Only `static` fields are module-scope state wearing a
      // different hat: `static instance = new Map()` is `mutableContainer`,
      // `static rows = [[1, 2]]` is `unfrozenLiteral`, and a plain `static n
      // = 0` (no `readonly`) is `letOrVar`'s equivalent — a reassignable
      // module-scope slot, regardless of what it currently holds.
      PropertyDefinition(node) {
        if (!node.static) return
        if (!isEffectivelyModuleScope(node)) return

        const value = node.value
        const name = node.key.type === 'Identifier' ? node.key.name : '<computed>'

        if (value && value.type === 'NewExpression' && value.callee.type === 'Identifier' && MUTABLE_CONTAINER_CTOR_NAME.test(value.callee.name)) {
          context.report({ node, messageId: 'mutableContainer', data: { ctor: value.callee.name } })
          return
        }

        if (value) {
          const literals = []
          collectLiterals(value, literals)
          let reportedLiteral = false
          for (const literal of literals) {
            if (!isDirectFreezeArgument(literal)) {
              context.report({
                node: literal,
                messageId: 'unfrozenLiteral',
                data: { literal: literal.type === 'ArrayExpression' ? 'array' : 'object' },
              })
              reportedLiteral = true
            }
          }
          if (reportedLiteral) return
        }

        if (!node.readonly) {
          context.report({ node, messageId: 'staticMutableField', data: { name } })
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
        'because Math cannot be banned by name — Math.imul and Math.min are load-bearing in rng.ts. ' +
        'NOTE: Math and Date are the only two names here doing real work — performance/globalThis/self/' +
        'window/document are already unconditionally banned by the pre-existing `no-restricted-globals` ' +
        '(any reference, aliased or not), so this rule\'s coverage of those five is redundant, not additive.',
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

/** Constructors whose instances iterate in an order this rule cares about. Deliberately narrower than
 * `MUTABLE_CONTAINER_CTOR_NAME`: iterating a plain `Array`/typed array by index is not banned by spec
 * §4.1 — only Map/Set/WeakMap/WeakSet enumeration order is. */
const DIRECT_ITERATION_CTOR_NAMES = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])

function staticPropertyName(memberExpr) {
  if (!memberExpr.computed) {
    return memberExpr.property.type === 'Identifier' ? memberExpr.property.name : null
  }
  return memberExpr.property.type === 'Literal' && typeof memberExpr.property.value === 'string'
    ? memberExpr.property.value
    : null
}

/**
 * Resolves `name` to an in-scope variable starting from `scope`, walking
 * outward the same way JS variable resolution does.
 */
function resolveVariable(scope, name) {
  let current = scope
  while (current) {
    const variable = current.variables.find((v) => v.name === name)
    if (variable) return variable
    current = current.upper
  }
  return null
}

/**
 * True when `variable` has at least one declaration whose initialiser is
 * `new Map/Set/WeakMap/WeakSet(...)`. Conservative in the direction that
 * matters for a rule that must not become noisy: it only matches a binding
 * this rule can actually see initialised to a banned collection type in the
 * same file — see the residual documented on `noCollectionIteration` below.
 */
function isKnownDirectIterationBannedCollection(variable) {
  return variable.defs.some((def) => {
    const init = def.node && def.node.type === 'VariableDeclarator' ? def.node.init : null
    return Boolean(
      init &&
        init.type === 'NewExpression' &&
        init.callee.type === 'Identifier' &&
        DIRECT_ITERATION_CTOR_NAMES.has(init.callee.name),
    )
  })
}

const noCollectionIteration = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Bans Object.keys/values/entries/getOwnPropertyNames, any for...in, any for...of over a ' +
        '.keys()/.values()/.entries() call, and any for...of directly over a variable known (from its own ' +
        'declaration in the same file) to be `new Map/Set/WeakMap/WeakSet(...)` — spec §4.1. Set/Map used ' +
        'only through has/add/get/set/delete are exempt and unaffected by this rule: membership is ' +
        'order-free, which is exactly what computeLayout\'s duplicate-name check (a `Set` used only via ' +
        'has/add) relies on. If this rule\'s guard file contains a `Set`, that is the exemption at work, ' +
        'not a gap in the rule. RESIDUAL: a binding this rule cannot trace to a same-file `new Map/Set(...)` ' +
        '— a function parameter, a value returned from another module, a variable reassigned after its ' +
        'initial declaration — still slips through `for...of` undetected. Closing that needs type ' +
        'information this rule does not have; over-reporting on every for...of (treating every unproven ' +
        'identifier as guilty) was rejected deliberately, since a rule that flags ordinary array iteration ' +
        'gets disabled within a week, which is worse than this known gap.',
    },
    schema: [],
    messages: {
      noEnumeration: '`Object.{{method}}` enumerates key/value order. Order-dependent reads are banned by spec §4.1.',
      noForIn: '`for...in` enumerates keys in an order not guaranteed identical across engines. Use an explicit array or index loop.',
      noIteratorMethod:
        '`for...of` over `.{{method}}()` iterates enumeration order. Use has/add/get/set/delete, or an explicit array.',
      noDirectCollectionIteration:
        '`for...of` directly over `{{ctor}}` `{{name}}` iterates enumeration order. Use has/add/get/set/delete, or copy to an array first.',
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
        if (node.right.type === 'CallExpression' && node.right.callee.type === 'MemberExpression') {
          const method = staticPropertyName(node.right.callee)
          if (method && ITERATOR_METHOD_NAMES.has(method)) {
            context.report({ node, messageId: 'noIteratorMethod', data: { method } })
            return
          }
        }

        if (node.right.type === 'Identifier') {
          const scope = context.sourceCode.getScope(node)
          const variable = resolveVariable(scope, node.right.name)
          if (variable && isKnownDirectIterationBannedCollection(variable)) {
            const def = variable.defs.find(
              (d) => d.node && d.node.type === 'VariableDeclarator' && d.node.init && d.node.init.type === 'NewExpression',
            )
            context.report({
              node,
              messageId: 'noDirectCollectionIteration',
              data: { ctor: def.node.init.callee.name, name: node.right.name },
            })
          }
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
