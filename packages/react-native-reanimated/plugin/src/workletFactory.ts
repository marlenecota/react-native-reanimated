/* eslint-disable @typescript-eslint/no-var-requires */
import type { NodePath } from '@babel/core';
import { transformSync, traverse } from '@babel/core';
import generate from '@babel/generator';
import type {
  File as BabelFile,
  ExpressionStatement,
  FunctionExpression,
  Identifier,
  ReturnStatement,
  VariableDeclaration,
} from '@babel/types';
import {
  arrayExpression,
  assignmentExpression,
  blockStatement,
  cloneNode,
  expressionStatement,
  functionExpression,
  identifier,
  isBlockStatement,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMemberExpression,
  isObjectExpression,
  isObjectMethod,
  isObjectProperty,
  memberExpression,
  newExpression,
  numericLiteral,
  objectExpression,
  objectProperty,
  returnStatement,
  stringLiteral,
  toIdentifier,
  variableDeclaration,
  variableDeclarator,
} from '@babel/types';
import { strict as assert } from 'assert';
import { basename, relative } from 'path';
import { buildWorkletString } from './workletStringCode';
import { globals } from './globals';
import type { ReanimatedPluginPass, WorkletizableFunction } from './types';
import { isRelease } from './utils';

const REAL_VERSION = require('../../package.json').version;
const MOCK_VERSION = 'x.y.z';

const workletStringTransformPresets = [
  require.resolve('@babel/preset-typescript'),
];

const workletStringTransformPlugins = [
  require.resolve('@babel/plugin-transform-shorthand-properties'),
  require.resolve('@babel/plugin-transform-arrow-functions'),
  require.resolve('@babel/plugin-transform-optional-chaining'),
  require.resolve('@babel/plugin-transform-nullish-coalescing-operator'),
  [
    require.resolve('@babel/plugin-transform-template-literals'),
    { loose: true },
  ],
];

export function makeWorkletFactory(
  fun: NodePath<WorkletizableFunction>,
  state: ReanimatedPluginPass
): FunctionExpression {
  // Returns a new FunctionExpression which is a workletized version of provided
  // FunctionDeclaration, FunctionExpression, ArrowFunctionExpression or ObjectMethod.

  removeWorkletDirective(fun);

  // We use copy because some of the plugins don't update bindings and
  // some even break them
  assert(
    state.file.opts.filename,
    '[Reanimated] `state.file.opts.filename` is undefined.'
  );

  const codeObject = generate(fun.node, {
    sourceMaps: true,
    sourceFileName: state.file.opts.filename,
  });

  // We need to add a newline at the end, because there could potentially be a
  // comment after the function that gets included here, and then the closing
  // bracket would become part of the comment thus resulting in an error, since
  // there is a missing closing bracket.
  codeObject.code =
    '(' + (fun.isObjectMethod() ? 'function ' : '') + codeObject.code + '\n)';

  const transformed = transformSync(codeObject.code, {
    filename: state.file.opts.filename,
    presets: workletStringTransformPresets,
    plugins: workletStringTransformPlugins,
    ast: true,
    babelrc: false,
    configFile: false,
    inputSourceMap: codeObject.map,
  });

  assert(transformed, '[Reanimated] `transformed` is undefined.');
  assert(transformed.ast, '[Reanimated] `transformed.ast` is undefined.');

  const variables = makeArrayFromCapturedBindings(transformed.ast, fun);

  const functionName = makeWorkletName(fun, state);
  const functionIdentifier = identifier(functionName);

  const clone = cloneNode(fun.node);
  const funExpression = isBlockStatement(clone.body)
    ? functionExpression(
        null,
        clone.params,
        clone.body,
        clone.generator,
        clone.async
      )
    : clone;

  let [funString, sourceMapString] = buildWorkletString(
    transformed.ast,
    state,
    variables,
    functionName,
    transformed.map
  );
  assert(funString, '[Reanimated] `funString` is undefined.');
  const workletHash = hash(funString);

  let lineOffset = 1;
  if (variables.length > 0) {
    // When worklet captures some variables, we append closure destructing at
    // the beginning of the function body. This effectively results in line
    // numbers shifting by the number of captured variables (size of the
    // closure) + 2 (for the opening and closing brackets of the destruct
    // statement)
    lineOffset -= variables.length + 2;
  }

  const pathForStringDefinitions = fun.parentPath.isProgram()
    ? fun
    : fun.findParent((path) => path.parentPath?.isProgram() ?? false);
  assert(
    pathForStringDefinitions,
    '[Reanimated] `pathForStringDefinitions` is null.'
  );
  assert(
    pathForStringDefinitions.parentPath,
    '[Reanimated] `pathForStringDefinitions.parentPath` is null.'
  );

  const initDataId =
    pathForStringDefinitions.parentPath.scope.generateUidIdentifier(
      `worklet_${workletHash}_init_data`
    );

  const initDataObjectExpression = objectExpression([
    objectProperty(identifier('code'), stringLiteral(funString)),
  ]);

  // When testing with jest I noticed that environment variables are set later
  // than some functions are evaluated. E.g. this cannot be above this function
  // because it would always evaluate to true.
  const shouldInjectLocation = !isRelease();
  if (shouldInjectLocation) {
    let location = state.file.opts.filename;
    if (state.opts.relativeSourceLocation) {
      location = relative(state.cwd, location);
      // It seems there is no designated option to use relative paths in generated sourceMap
      sourceMapString = sourceMapString?.replace(
        state.file.opts.filename,
        location
      );
    }

    initDataObjectExpression.properties.push(
      objectProperty(identifier('location'), stringLiteral(location))
    );
  }

  if (sourceMapString) {
    initDataObjectExpression.properties.push(
      objectProperty(identifier('sourceMap'), stringLiteral(sourceMapString))
    );
  }

  const shouldInjectVersion = !isRelease();
  if (shouldInjectVersion) {
    initDataObjectExpression.properties.push(
      objectProperty(
        identifier('version'),
        stringLiteral(shouldMockVersion() ? MOCK_VERSION : REAL_VERSION)
      )
    );
  }

  const shouldIncludeInitData = !state.opts.omitNativeOnlyData;
  if (shouldIncludeInitData) {
    pathForStringDefinitions.insertBefore(
      variableDeclaration('const', [
        variableDeclarator(initDataId, initDataObjectExpression),
      ])
    );
  }

  assert(
    !isFunctionDeclaration(funExpression),
    '[Reanimated] `funExpression` is a `FunctionDeclaration`.'
  );
  assert(
    !isObjectMethod(funExpression),
    '[Reanimated] `funExpression` is an `ObjectMethod`.'
  );

  const statements: Array<
    VariableDeclaration | ExpressionStatement | ReturnStatement
  > = [
    variableDeclaration('const', [
      variableDeclarator(functionIdentifier, funExpression),
    ]),
    expressionStatement(
      assignmentExpression(
        '=',
        memberExpression(functionIdentifier, identifier('__closure'), false),
        objectExpression(
          variables.map((variable) =>
            objectProperty(identifier(variable.name), variable, false, true)
          )
        )
      )
    ),
    expressionStatement(
      assignmentExpression(
        '=',
        memberExpression(
          functionIdentifier,
          identifier('__workletHash'),
          false
        ),
        numericLiteral(workletHash)
      )
    ),
  ];

  if (shouldIncludeInitData) {
    statements.push(
      expressionStatement(
        assignmentExpression(
          '=',
          memberExpression(functionIdentifier, identifier('__initData'), false),
          initDataId
        )
      )
    );
  }

  if (!isRelease()) {
    statements.unshift(
      variableDeclaration('const', [
        variableDeclarator(
          identifier('_e'),
          arrayExpression([
            newExpression(
              memberExpression(identifier('global'), identifier('Error')),
              []
            ),
            numericLiteral(lineOffset),
            numericLiteral(-27), // the placement of opening bracket after Exception in line that defined '_e' variable
          ])
        ),
      ])
    );
    statements.push(
      expressionStatement(
        assignmentExpression(
          '=',
          memberExpression(
            functionIdentifier,
            identifier('__stackDetails'),
            false
          ),
          identifier('_e')
        )
      )
    );
  }

  statements.push(returnStatement(functionIdentifier));

  const newFun = functionExpression(undefined, [], blockStatement(statements));

  return newFun;
}

function removeWorkletDirective(fun: NodePath<WorkletizableFunction>): void {
  fun.traverse({
    DirectiveLiteral(path) {
      if (path.node.value === 'worklet' && path.getFunctionParent() === fun) {
        path.parentPath.remove();
      }
    },
  });
}

function shouldMockVersion(): boolean {
  // We don't want to pollute tests with current version number so we mock it
  // for all tests (except one)
  return process.env.REANIMATED_JEST_SHOULD_MOCK_VERSION === '1';
}

function hash(str: string): number {
  let i = str.length;
  let hash1 = 5381;
  let hash2 = 52711;

  while (i--) {
    const char = str.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash1 = (hash1 * 33) ^ char;
    // eslint-disable-next-line no-bitwise
    hash2 = (hash2 * 33) ^ char;
  }

  // eslint-disable-next-line no-bitwise
  return (hash1 >>> 0) * 4096 + (hash2 >>> 0);
}

function makeWorkletName(
  fun: NodePath<WorkletizableFunction>,
  state: ReanimatedPluginPass
): string {
  let source = 'unknownFile';

  if (state.file.opts.filename) {
    const filepath = state.file.opts.filename;
    source = basename(filepath);

    // Get the library name from the path.
    const splitFilepath = filepath.split('/');
    const nodeModulesIndex = splitFilepath.indexOf('node_modules');
    if (nodeModulesIndex !== -1) {
      const libraryName = splitFilepath[nodeModulesIndex + 1];
      source = `${libraryName}_${source}`;
    }
  }

  const suffix = `${source}${state.workletNumber++}`;
  if (isObjectMethod(fun.node) && isIdentifier(fun.node.key)) {
    return toIdentifier(`${fun.node.key.name}_${suffix}`);
  }
  if (isFunctionDeclaration(fun.node) && isIdentifier(fun.node.id)) {
    return toIdentifier(`${fun.node.id.name}_${suffix}`);
  }
  if (isFunctionExpression(fun.node) && isIdentifier(fun.node.id)) {
    return toIdentifier(`${fun.node.id.name}_${suffix}`);
  }

  // Fallback for ArrowFunctionExpression and unnamed FunctionExpression.
  return toIdentifier(suffix);
}

function makeArrayFromCapturedBindings(
  ast: BabelFile,
  fun: NodePath<WorkletizableFunction>
): Identifier[] {
  const closure = new Map<string, Identifier>();
  const isLocationAssignedMap = new Map<string, boolean>();

  // this traversal looks for variables to capture
  traverse(ast, {
    Identifier(path) {
      // we only capture variables that were declared outside of the scope
      if (!path.isReferencedIdentifier()) {
        return;
      }
      const name = path.node.name;
      // if the function is named and was added to globals we don't want to add it to closure
      // hence we check if identifier has that name
      if (globals.has(name)) {
        return;
      }
      if (
        'id' in fun.node &&
        fun.node.id &&
        fun.node.id.name === name // we don't want to capture function's own name
      ) {
        return;
      }

      const parentNode = path.parent;

      if (
        isMemberExpression(parentNode) &&
        parentNode.property === path.node &&
        !parentNode.computed
      ) {
        return;
      }

      if (
        isObjectProperty(parentNode) &&
        isObjectExpression(path.parentPath.parent) &&
        path.node !== parentNode.value
      ) {
        return;
      }

      let currentScope = path.scope;

      while (currentScope != null) {
        if (currentScope.bindings[name] != null) {
          return;
        }
        currentScope = currentScope.parent;
      }
      closure.set(name, path.node);
      isLocationAssignedMap.set(name, false);
    },
  });

  /*
  For reasons I don't exactly understand, the above traversal will cause the whole 
  bundle to crash if we traversed original node instead of generated
  AST. This is why we need to traverse it again, but this time we set
  location for each identifier that was captured to their original counterpart, since
  AST has its location set relative as if it was a separate file.
  */
  fun.traverse({
    Identifier(path) {
      // So it won't refer to something like:
      // const obj = {unexistingVariable: 1};
      if (!path.isReferencedIdentifier()) {
        return;
      }
      const node = closure.get(path.node.name);
      if (!node || isLocationAssignedMap.get(path.node.name)) {
        return;
      }
      node.loc = path.node.loc;
      isLocationAssignedMap.set(path.node.name, true);
    },
  });

  return Array.from(closure.values());
}
